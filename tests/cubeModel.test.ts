// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three';
// @ts-expect-error — plain ESM fixture shared with the playwright harness
import { gradientCube, gradientValue } from '../scripts/lib/fitsFixture.mjs';
import { CubeModel, computeStats } from '../src/data/cubeModel';
import { BufferSource } from '../src/fits/source';

describe('computeStats', () => {
  it('percentiles and NaN fraction on a known array', () => {
    const data = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) data[i] = i;
    data[0] = NaN;
    const s = computeStats(data);
    expect(s.nanFrac).toBeCloseTo(0.001, 4);
    expect(s.min).toBe(1);
    expect(s.max).toBe(999);
    expect(s.median).toBeCloseTo(500, -1);
    expect(s.lo).toBeLessThan(s.hi);
  });
});

describe('CubeModel ingest truth (the normalization contract)', () => {
  it('gradient cube: exact CPU values, half-float volume within tolerance, NaN → 0 sentinel', async () => {
    const cube = await CubeModel.open(new BufferSource('fixture.fits', gradientCube().buffer as ArrayBuffer));
    await cube.ingest(() => {}, 2048);

    expect([cube.nx, cube.ny, cube.nz]).toEqual([16, 16, 8]);
    expect(cube.isStreamed).toBe(false);

    // Exact value paths (what slice mode and the probe display)
    expect(cube.valueAt(7, 5, 3)).toBe(gradientValue(7, 5, 3));
    const spec = cube.spectrum(3, 2)!;
    for (let z = 0; z < 8; z++) expect(spec[z]).toBe(gradientValue(3, 2, z));
    const plane = await cube.plane(6);
    expect(plane[9 * 16 + 4]).toBe(gradientValue(4, 9, 6));

    // Volume path (what the raymarcher samples): v_tex = eps + norm·(1−eps)
    const v = cube.volume!;
    const stats = cube.stats!;
    expect([v.nx, v.ny, v.nz, v.binXY, v.binZ]).toEqual([16, 16, 8, 1, 1]);
    const eps = 1 / 2048;
    const check = (x: number, y: number, z: number): void => {
      const raw = gradientValue(x, y, z);
      const t = Math.min(Math.max((raw - stats.lo) / (stats.hi - stats.lo), 0), 1);
      const got = DataUtils.fromHalfFloat(v.data[z * 256 + y * 16 + x]);
      expect(Math.abs(got - (eps + t * (1 - eps)))).toBeLessThan(1e-3);
    };
    check(7, 5, 3);
    check(15, 15, 7);
    check(1, 0, 0);

    // The fixture's NaN spaxel must be the invalid sentinel in the texture
    expect(v.data[3 * 256 + 0]).toBe(0);
  });

  it('rejects a 2D image with a helpful error', async () => {
    const { makeFitsCube } = await import('../scripts/lib/fitsFixture.mjs');
    const flat = makeFitsCube({ nx: 8, ny: 8, nz: 1, value: () => 1 });
    await expect(CubeModel.open(new BufferSource('flat.fits', flat.buffer as ArrayBuffer))).rejects.toThrow(/2D image/);
  });
});
