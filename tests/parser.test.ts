// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM fixture shared with the playwright harness
import { gradientCube, gradientValue, makeFitsCube } from '../scripts/lib/fitsFixture.mjs';
import { decodePixels, findCubeHdus, parseFits, readPlane, cardString, type Hdu } from '../src/fits/parser';
import { BufferSource } from '../src/fits/source';

const src = (buf: Uint8Array) => new BufferSource('fixture.fits', buf.buffer as ArrayBuffer);

describe('FITS parser', () => {
  it('parses the synthetic cube header', async () => {
    const file = await parseFits(src(gradientCube()));
    expect(file.hdus).toHaveLength(1);
    const h = file.hdus[0];
    expect(h.bitpix).toBe(-32);
    expect(h.dims).toEqual([16, 16, 8]);
    expect(cardString(h.cards, 'OBJECT')).toBe('FIXTURE');
    expect(findCubeHdus(file)).toHaveLength(1);
  });

  it('reads planes with exact big-endian values and preserved NaN', async () => {
    const file = await parseFits(src(gradientCube()));
    const plane = await readPlane(file, file.hdus[0], 3);
    expect(plane[5 * 16 + 7]).toBe(gradientValue(7, 5, 3)); // 7 + 80 + 768
    expect(plane[15 * 16 + 15]).toBe(gradientValue(15, 15, 3));
    expect(Number.isNaN(plane[0])).toBe(true); // fixture plants NaN at (0,0,z)
  });

  it('applies BSCALE/BZERO and maps BLANK to NaN for integer data', () => {
    const hdu = { bitpix: 16, bscale: 2, bzero: 100, blank: -32768 } as Hdu;
    const raw = new DataView(new ArrayBuffer(6));
    raw.setInt16(0, 10, false);
    raw.setInt16(2, -32768, false); // BLANK
    raw.setInt16(4, -5, false);
    const out = decodePixels(hdu, raw.buffer, 3);
    expect(out[0]).toBe(120); // 10·2 + 100
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBe(90);
  });

  it('FITS standard: BSCALE applies to float data too', () => {
    const hdu = { bitpix: -32, bscale: 2, bzero: 1, blank: null } as Hdu;
    const raw = new DataView(new ArrayBuffer(4));
    raw.setFloat32(0, 1.5, false);
    expect(decodePixels(hdu, raw.buffer, 1)[0]).toBe(4); // 1.5·2 + 1
  });

  it('rejects non-FITS bytes', async () => {
    const junk = new Uint8Array(2880).fill(0x41);
    await expect(parseFits(src(junk))).rejects.toThrow(/Truncated FITS header|SIMPLE/);
  });

  it('parses quoted string cards via extraCards', async () => {
    const buf = makeFitsCube({
      nx: 4,
      ny: 4,
      nz: 2,
      value: () => 1,
      extraCards: ["TELESCOP= 'DRAO-15 '           / fixture scope".padEnd(80)],
    });
    const file = await parseFits(src(buf));
    expect(cardString(file.hdus[0].cards, 'TELESCOP')).toBe('DRAO-15');
  });
});
