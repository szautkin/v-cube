// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CubeModel — owns one loaded cube: header info, NaN-aware statistics,
 * channel-plane access (full-RAM for small cubes, LRU streamed for big),
 * and the downsampled volume array for the 3D texture.
 *
 * Normalization contract (shared by both render modes): raw values are
 * mapped linearly onto [0,1] over [stats.lo, stats.hi] (robust percentiles);
 * window + stretch are applied in-shader on that normalized value, so slice
 * and volume always agree.
 */
import { DataUtils } from 'three';
import { findCubeHdus, parseFits, readPlane, cardString, type FitsFile, type Hdu } from '../fits/parser';
import { buildWcs, type Wcs } from '../fits/wcs';
import type { DataSource } from '../fits/source';

export interface CubeStats {
  lo: number; // p0.1 — texture/normalization floor
  hi: number; // p99.9 — ceiling
  min: number;
  max: number;
  median: number;
  nanFrac: number;
}

export interface VolumeData {
  data: Uint16Array; // half-float bits, 0 ⇒ invalid/NaN sentinel
  nx: number;
  ny: number;
  nz: number;
  binXY: number;
  binZ: number;
}

export interface IngestProgress {
  stage: string;
  frac: number;
}

const FULL_RAM_LIMIT = 320e6; // bytes of float32 — JWST/JCMT cubes sit far under this
const PLANE_CACHE_MAX = 12; // LRU planes for streamed cubes (SITELLE plane ≈ 17 MB)

export class CubeModel {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  stats: CubeStats | null = null;
  wcs: Wcs | null = null;
  volume: VolumeData | null = null;
  bunit: string;
  object: string;
  telescope: string;
  instrument: string;

  private full: Float32Array | null = null; // entire cube when small enough
  private cache = new Map<number, Float32Array>(); // LRU plane cache otherwise

  private constructor(
    public readonly file: FitsFile,
    public readonly hdu: Hdu,
  ) {
    [this.nx, this.ny, this.nz] = hdu.dims;
    const primary = file.hdus[0].cards;
    this.bunit = cardString(hdu.cards, 'BUNIT') || cardString(primary, 'BUNIT');
    this.object = cardString(hdu.cards, 'OBJECT') || cardString(primary, 'OBJECT', '—');
    this.telescope = cardString(hdu.cards, 'TELESCOP') || cardString(primary, 'TELESCOP', '');
    this.instrument = cardString(hdu.cards, 'INSTRUME') || cardString(primary, 'INSTRUME', '');
  }

  get name(): string {
    return this.file.source.name;
  }

  get isStreamed(): boolean {
    return this.full === null;
  }

  static async open(source: DataSource): Promise<CubeModel> {
    const file = await parseFits(source);
    const cubes = findCubeHdus(file);
    if (cubes.length === 0) {
      const best = file.hdus.find((h) => h.dims.filter((d) => d > 1).length === 2);
      throw new Error(
        best
          ? `No cube found — ${source.name} is a 2D image (${best.dims.join('×')})`
          : `No 3D image HDU found in ${source.name}`,
      );
    }
    // Prefer SCI over ERR/DQ/WMAP/VARIANCE when several cube HDUs exist.
    const sci = cubes.find((h) => /^(SCI|PRIMARY|DATA)/i.test(h.extname)) ?? cubes[0];
    return new CubeModel(file, sci);
  }

  async ingest(onProgress: (p: IngestProgress) => void, max3d: number, byteBudget = 256e6): Promise<void> {
    this.wcs = await buildWcs(this.file, this.hdu);
    const totalBytes = this.nx * this.ny * this.nz * 4;

    if (totalBytes <= FULL_RAM_LIMIT) {
      onProgress({ stage: 'ACQUIRING DATA', frac: 0 });
      this.full = new Float32Array(this.nx * this.ny * this.nz);
      const chunk = Math.max(1, Math.floor(this.nz / 50));
      for (let z = 0; z < this.nz; z += chunk) {
        const n = Math.min(chunk, this.nz - z);
        for (let k = 0; k < n; k++) {
          const plane = await readPlane(this.file, this.hdu, z + k);
          this.full.set(plane, (z + k) * this.nx * this.ny);
        }
        onProgress({ stage: 'ACQUIRING DATA', frac: (z + n) / this.nz });
        await yieldFrame();
      }
      onProgress({ stage: 'COMPUTING STATISTICS', frac: 0 });
      this.stats = computeStats(this.full);
    } else {
      // Streamed cube: sample planes for statistics, never hold it all.
      onProgress({ stage: 'SAMPLING STATISTICS', frac: 0 });
      const samplePlanes = 24;
      const samples: Float32Array[] = [];
      for (let i = 0; i < samplePlanes; i++) {
        const z = Math.floor((i / (samplePlanes - 1)) * (this.nz - 1));
        samples.push(await readPlane(this.file, this.hdu, z));
        onProgress({ stage: 'SAMPLING STATISTICS', frac: (i + 1) / samplePlanes });
        await yieldFrame();
      }
      this.stats = computeStats(concatSample(samples, 8_000_000));
    }
    await this.buildVolume(onProgress, max3d, byteBudget);
  }

  /** Exact raw value at voxel (0-based), from RAM or the plane cache. */
  valueAt(x: number, y: number, z: number, plane?: Float32Array): number {
    if (x < 0 || y < 0 || x >= this.nx || y >= this.ny) return NaN;
    if (this.full) return this.full[z * this.nx * this.ny + y * this.nx + x];
    const p = plane ?? this.cache.get(z);
    return p ? p[y * this.nx + x] : NaN;
  }

  /** Channel plane for slice rendering (cached for streamed cubes). */
  async plane(z: number): Promise<Float32Array> {
    if (this.full) {
      return this.full.subarray(z * this.nx * this.ny, (z + 1) * this.nx * this.ny);
    }
    const hit = this.cache.get(z);
    if (hit) {
      this.cache.delete(z);
      this.cache.set(z, hit); // refresh LRU position
      return hit;
    }
    const plane = await readPlane(this.file, this.hdu, z);
    this.cache.set(z, plane);
    if (this.cache.size > PLANE_CACHE_MAX) {
      const oldest = this.cache.keys().next().value as number;
      this.cache.delete(oldest);
    }
    return plane;
  }

  /** Spectrum through (x,y) — RAM cubes only (streamed would mean a full file scan). */
  spectrum(x: number, y: number): Float32Array | null {
    if (!this.full) return null;
    const out = new Float32Array(this.nz);
    const stride = this.nx * this.ny;
    for (let z = 0; z < this.nz; z++) out[z] = this.full[z * stride + y * this.nx + x];
    return out;
  }

  /**
   * Build the volume-mode array: spectral binning to fit MAX_3D_TEXTURE_SIZE,
   * spatial binning to fit the byte budget, NaN-aware mean, half-float
   * quantization over [lo, hi] with 0 reserved as the invalid sentinel.
   */
  private async buildVolume(onProgress: (p: IngestProgress) => void, max3d: number, byteBudget: number): Promise<void> {
    const stats = this.stats!;
    const binZ = Math.ceil(this.nz / Math.min(max3d, 2048));
    let binXY = Math.max(Math.ceil(this.nx / max3d), Math.ceil(this.ny / max3d), 1);
    const nzOut = Math.ceil(this.nz / binZ);
    while (Math.ceil(this.nx / binXY) * Math.ceil(this.ny / binXY) * nzOut * 2 > byteBudget) binXY++;
    const nx = Math.ceil(this.nx / binXY);
    const ny = Math.ceil(this.ny / binXY);
    const nz = nzOut;

    const data = new Uint16Array(nx * ny * nz);
    const sum = new Float32Array(nx * ny);
    const cnt = new Uint16Array(nx * ny);
    const range = stats.hi - stats.lo || 1;
    const eps = 1 / 2048; // keep valid values away from the 0 sentinel
    // Hoist the per-voxel divisions out of the inner loop
    const xo = new Int32Array(this.nx);
    for (let x = 0; x < this.nx; x++) xo[x] = (x / binXY) | 0;

    for (let zo = 0; zo < nz; zo++) {
      sum.fill(0);
      cnt.fill(0);
      const z0 = zo * binZ;
      const z1 = Math.min(z0 + binZ, this.nz);
      for (let z = z0; z < z1; z++) {
        const plane = await this.plane(z);
        for (let y = 0; y < this.ny; y++) {
          const rowIn = y * this.nx;
          const rowOut = ((y / binXY) | 0) * nx;
          for (let x = 0; x < this.nx; x++) {
            const v = plane[rowIn + x];
            if (v === v) {
              const idx = rowOut + xo[x];
              sum[idx] += v;
              cnt[idx]++;
            }
          }
        }
      }
      const slab = zo * nx * ny;
      for (let i = 0; i < nx * ny; i++) {
        if (cnt[i] === 0) continue; // stays 0 = invalid
        let t = (sum[i] / cnt[i] - stats.lo) / range;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        data[slab + i] = DataUtils.toHalfFloat(eps + t * (1 - eps));
      }
      if (zo % 8 === 0 || zo === nz - 1) {
        onProgress({ stage: 'BUILDING VOLUME', frac: (zo + 1) / nz });
        await yieldFrame();
      }
    }
    this.volume = { data, nx, ny, nz, binXY, binZ };
  }
}

function yieldFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function concatSample(planes: Float32Array[], maxElems: number): Float32Array {
  const total = planes.reduce((a, p) => a + p.length, 0);
  const stride = Math.max(1, Math.ceil(total / maxElems));
  const out = new Float32Array(Math.ceil(total / stride));
  let j = 0;
  let i = 0;
  for (const p of planes) {
    for (let k = i % stride === 0 ? 0 : stride - (i % stride); k < p.length; k += stride) out[j++] = p[k];
    i += p.length;
  }
  return out.subarray(0, j) as Float32Array;
}

export function computeStats(data: Float32Array): CubeStats {
  const maxSample = 4_000_000;
  const stride = Math.max(1, Math.floor(data.length / maxSample));
  const buf = new Float32Array(Math.ceil(data.length / stride));
  let n = 0;
  let nan = 0;
  let seen = 0;
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    seen++;
    if (v === v) buf[n++] = v;
    else nan++;
  }
  if (n === 0) {
    return { lo: 0, hi: 1, min: 0, max: 1, median: 0, nanFrac: 1 };
  }
  const finite = buf.subarray(0, n);
  finite.sort(); // typed-array sort is numeric by default — no comparator boxing
  const q = (f: number) => finite[Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))];
  let lo = q(0.001);
  let hi = q(0.999);
  if (hi <= lo) {
    lo = finite[0];
    hi = finite[n - 1];
  }
  if (hi <= lo) hi = lo + (Math.abs(lo) || 1); // constant cube — keep every downstream range finite
  return { lo, hi, min: finite[0], max: finite[n - 1], median: q(0.5), nanFrac: nan / seen };
}
