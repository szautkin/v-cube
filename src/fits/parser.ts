// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal FITS reader covering this project's corpus: multi-HDU image
 * extensions (BITPIX 8/16/32/-32/-64, BSCALE/BZERO/BLANK), big-endian
 * decode, per-plane streaming reads, and a single-row binary-table reader
 * for JWST WAVE-TAB wavelength lookup tables.
 */
import type { DataSource } from './source';

const BLOCK = 2880;
const CARD = 80;

export type Cards = Map<string, string>;

export interface Hdu {
  index: number;
  extname: string;
  bitpix: number;
  dims: number[]; // NAXIS1..n order (x fastest)
  cards: Cards;
  headerOffset: number;
  dataOffset: number;
  dataBytes: number;
  bscale: number;
  bzero: number;
  blank: number | null;
}

export interface FitsFile {
  source: DataSource;
  hdus: Hdu[];
}

export function cardNumber(cards: Cards, key: string, fallback?: number): number {
  const v = cards.get(key);
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`Missing FITS card ${key}`);
    return fallback;
  }
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Card ${key}=${v} is not numeric`);
  return n;
}

export function cardString(cards: Cards, key: string, fallback = ''): string {
  return cards.get(key) ?? fallback;
}

function parseHeaderBlock(block: Uint8Array, cards: Cards): boolean {
  for (let i = 0; i < BLOCK; i += CARD) {
    let card = '';
    for (let j = 0; j < CARD; j++) card += String.fromCharCode(block[i + j]);
    if (card.startsWith('END') && card.slice(3).trim() === '') return true;
    const key = card.slice(0, 8).trim();
    if (!key || key === 'COMMENT' || key === 'HISTORY') continue;
    if (card[8] !== '=') continue;
    let raw = card.slice(10);
    // String values are quoted; '' escapes a quote. Otherwise strip trailing comment.
    if (raw.trimStart().startsWith("'")) {
      const s = raw.indexOf("'");
      let out = '';
      let k = s + 1;
      while (k < raw.length) {
        if (raw[k] === "'") {
          if (raw[k + 1] === "'") {
            out += "'";
            k += 2;
            continue;
          }
          break;
        }
        out += raw[k++];
      }
      cards.set(key, out.trimEnd());
    } else {
      const slash = raw.indexOf('/');
      if (slash >= 0) raw = raw.slice(0, slash);
      cards.set(key, raw.trim());
    }
  }
  return false;
}

export async function parseFits(source: DataSource, maxHdus = 32): Promise<FitsFile> {
  const hdus: Hdu[] = [];
  let offset = 0;
  for (let index = 0; index < maxHdus && offset + BLOCK <= source.size; index++) {
    const headerOffset = offset;
    const cards: Cards = new Map();
    let ended = false;
    while (!ended) {
      if (offset + BLOCK > source.size) throw new Error(`Truncated FITS header in HDU ${index}`);
      const block = new Uint8Array(await source.read(offset, BLOCK));
      offset += BLOCK;
      ended = parseHeaderBlock(block, cards);
    }
    if (index === 0 && cards.get('SIMPLE') === undefined && cards.get('XTENSION') === undefined) {
      throw new Error('Not a FITS file (no SIMPLE card)');
    }
    const bitpix = cardNumber(cards, 'BITPIX', 8);
    const naxis = cardNumber(cards, 'NAXIS', 0);
    const dims: number[] = [];
    let nelem = naxis > 0 ? 1 : 0;
    for (let i = 1; i <= naxis; i++) {
      const d = cardNumber(cards, `NAXIS${i}`, 1);
      dims.push(d);
      nelem *= d;
    }
    const pcount = cardNumber(cards, 'PCOUNT', 0);
    const gcount = cardNumber(cards, 'GCOUNT', 1);
    const dataBytes = (Math.abs(bitpix) / 8) * gcount * (nelem + pcount);
    hdus.push({
      index,
      extname: cardString(cards, 'EXTNAME', index === 0 ? 'PRIMARY' : `HDU${index}`),
      bitpix,
      dims,
      cards,
      headerOffset,
      dataOffset: offset,
      dataBytes,
      bscale: cardNumber(cards, 'BSCALE', 1),
      bzero: cardNumber(cards, 'BZERO', 0),
      blank: cards.has('BLANK') ? cardNumber(cards, 'BLANK') : null,
    });
    offset += Math.ceil(dataBytes / BLOCK) * BLOCK;
  }
  return { source, hdus };
}

/** Decode raw big-endian FITS pixels to Float32, applying BSCALE/BZERO/BLANK. */
export function decodePixels(hdu: Hdu, raw: ArrayBuffer, count: number): Float32Array {
  const dv = new DataView(raw);
  const out = new Float32Array(count);
  const { bscale, bzero, blank } = hdu;
  const scaled = bscale !== 1 || bzero !== 0;
  switch (hdu.bitpix) {
    case -32:
      for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, false);
      break;
    case -64:
      for (let i = 0; i < count; i++) out[i] = dv.getFloat64(i * 8, false);
      break;
    case 16:
      for (let i = 0; i < count; i++) {
        const v = dv.getInt16(i * 2, false);
        out[i] = blank !== null && v === blank ? NaN : v;
      }
      break;
    case 32:
      for (let i = 0; i < count; i++) {
        const v = dv.getInt32(i * 4, false);
        out[i] = blank !== null && v === blank ? NaN : v;
      }
      break;
    case 8:
      for (let i = 0; i < count; i++) out[i] = dv.getUint8(i);
      break;
    default:
      throw new Error(`Unsupported BITPIX ${hdu.bitpix}`);
  }
  if (scaled) {
    for (let i = 0; i < count; i++) out[i] = out[i] * bscale + bzero;
  }
  return out;
}

/** Read one spatial plane (channel) of a ≥3D image HDU as Float32. */
export async function readPlane(file: FitsFile, hdu: Hdu, channel: number): Promise<Float32Array> {
  const [nx, ny] = hdu.dims;
  const planeElems = nx * ny;
  const bytesPer = Math.abs(hdu.bitpix) / 8;
  const offset = hdu.dataOffset + channel * planeElems * bytesPer;
  const raw = await file.source.read(offset, planeElems * bytesPer);
  return decodePixels(hdu, raw, planeElems);
}

/** Image HDUs with ≥3 real axes (cube candidates). Degenerate 4th axes of size 1 are fine. */
export function findCubeHdus(file: FitsFile): Hdu[] {
  return file.hdus.filter((h) => {
    if (h.cards.get('XTENSION')?.startsWith('BINTABLE') || h.cards.get('XTENSION')?.startsWith('TABLE')) return false;
    const real = h.dims.filter((d) => d > 1);
    return h.dims.length >= 3 && real.length >= 3 && h.dims[0] > 1 && h.dims[1] > 1 && h.dims[2] > 1;
  });
}

/**
 * Read a single-row BINTABLE column of floats/doubles — enough for JWST
 * WAVE-TAB tables (EXTNAME=WCS-TABLE, one 'wavelength' array column).
 */
export async function readBintableColumn(file: FitsFile, hdu: Hdu, column: string): Promise<Float64Array | null> {
  if (!cardString(hdu.cards, 'XTENSION').startsWith('BINTABLE')) return null;
  const tfields = cardNumber(hdu.cards, 'TFIELDS', 0);
  const rowBytes = hdu.dims[0] ?? 0;
  const nrows = hdu.dims[1] ?? 0;
  if (nrows < 1) return null;
  let colOffset = 0;
  for (let i = 1; i <= tfields; i++) {
    const tform = cardString(hdu.cards, `TFORM${i}`).trim();
    const m = /^(\d*)([LXBIJKAEDCMPQ])/.exec(tform);
    if (!m) return null;
    const repeat = m[1] ? parseInt(m[1], 10) : 1;
    const code = m[2];
    const sizes: Record<string, number> = {
      L: 1,
      X: 0.125,
      B: 1,
      I: 2,
      J: 4,
      K: 8,
      A: 1,
      E: 4,
      D: 8,
      C: 8,
      M: 16,
      P: 8,
      Q: 16,
    };
    const width = Math.ceil(repeat * (sizes[code] ?? 1));
    const ttype = cardString(hdu.cards, `TTYPE${i}`).trim().toLowerCase();
    if (ttype === column.toLowerCase()) {
      if (code !== 'E' && code !== 'D') return null;
      const raw = await file.source.read(hdu.dataOffset + colOffset, width);
      const dv = new DataView(raw);
      const out = new Float64Array(repeat);
      for (let k = 0; k < repeat; k++) {
        out[k] = code === 'E' ? dv.getFloat32(k * 4, false) : dv.getFloat64(k * 8, false);
      }
      return out;
    }
    colOffset += width;
    if (colOffset > rowBytes) return null;
  }
  return null;
}
