// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  formatDec,
  formatRa,
  formatSky,
  formatSpectral,
  pixelToSky,
  spectralValue,
  type CelestialInfo,
  type SpectralInfo,
} from '../src/fits/wcs';

const tan: CelestialInfo = {
  valid: true,
  projection: 'tan',
  frame: 'equatorial',
  crval1: 180,
  crval2: 0,
  crpix1: 8.5,
  crpix2: 8.5,
  cd: [-1, 0, 0, 1],
};

// The DRAGONS all-sky grid — verified against plate-carrée math by hand
const car: CelestialInfo = {
  valid: true,
  projection: 'car',
  frame: 'galactic',
  crval1: 0,
  crval2: 0,
  crpix1: 360.5,
  crpix2: 180.5,
  cd: [-0.5, 0, 0, 0.5],
};

describe('celestial WCS', () => {
  it('TAN reference pixel maps exactly to CRVAL', () => {
    const sky = pixelToSky(tan, 7.5, 7.5)!; // 0-based 7.5 → FITS pixel 8.5 = CRPIX
    expect(sky[0]).toBeCloseTo(180, 10);
    expect(sky[1]).toBeCloseTo(0, 10);
  });

  it('TAN 1° offset deprojects gnomonically', () => {
    const sky = pixelToSky(tan, 8.5, 7.5)!; // dx = +1 px → ξ = −1°
    expect(sky[0]).toBeCloseTo(179.0000987, 4);
    expect(sky[1]).toBeCloseTo(0, 6);
  });

  it('CAR is linear — DRAGONS probe voxel (686, 303) → ℓ 196.750°, b +61.750°', () => {
    const sky = pixelToSky(car, 686, 303)!;
    expect(sky[0]).toBeCloseTo(196.75, 10);
    expect(sky[1]).toBeCloseTo(61.75, 10);
  });

  it('CAR wraps longitude into [0, 360)', () => {
    const sky = pixelToSky(car, 360, 180)!; // dx = +0.5 px → ℓ = −0.25 → 359.75
    expect(sky[0]).toBeCloseTo(359.75, 10);
  });

  it('formats frames distinctly: sexagesimal vs decimal degrees', () => {
    expect(formatSky(tan, 283.8863, 2.3175).lon).toBe('18:55:32.71');
    expect(formatSky(tan, 283.8863, 2.3175).lonLabel).toBe('RA');
    const g = formatSky(car, 196.75, 61.75);
    expect(g.lonLabel).toBe('GLON');
    expect(g.lon).toBe('196.750°');
    expect(g.lat).toBe('+61.750°');
  });

  it('sexagesimal formatting', () => {
    expect(formatRa(180)).toBe('12:00:00.00');
    expect(formatDec(-24.795806)).toBe('−24:47:44.9');
  });
});

describe('spectral WCS', () => {
  const freq: SpectralInfo = {
    ctype: 'FREQ',
    cunit: 'Hz',
    restfrq: 1.001e9,
    table: null,
    crval: 1e9,
    crpix: 1,
    cdelt: 1e6,
  };

  it('FREQ formats GHz with radio velocity from RESTFRQ', () => {
    const r = formatSpectral(freq, 0);
    expect(r.primary).toBe('1.00000 GHz');
    expect(r.secondary).toBe('299.49 km/s'); // c·(1 − f/f₀)
  });

  it('linear axis: channel k → CRVAL + k·CDELT (CRPIX=1)', () => {
    expect(spectralValue(freq, 10)).toBeCloseTo(1.01e9, 0); // 1 GHz + 10 × 1 MHz
  });

  it('FDEP formats signed rad/m² (Faraday depth)', () => {
    const fdep: SpectralInfo = {
      ctype: 'FDEP',
      cunit: 'rad/m^2',
      restfrq: null,
      table: null,
      crval: 0,
      crpix: 401,
      cdelt: 0.5,
    };
    expect(formatSpectral(fdep, 400).primary).toBe('+0.00 rad/m²');
    expect(formatSpectral(fdep, 410).primary).toBe('+5.00 rad/m²');
    expect(formatSpectral(fdep, 0).primary).toBe('−200.00 rad/m²'.replace('−', '-'));
  });

  it('VELO axis treats m/s (incl. AIPS-style CUNIT="M") as the default and shows km/s', () => {
    const base = { ctype: 'VELO-LSR', restfrq: null, table: null, crval: 25743.84, crpix: 1, cdelt: 1 };
    // DRAO survey: CUNIT3='M' (metres/second) — must divide by 1000
    expect(formatSpectral({ ...base, cunit: 'M' }, 0).primary).toBe('25.74 km/s');
    // empty unit → FITS default of m/s
    expect(formatSpectral({ ...base, cunit: '' }, 0).primary).toBe('25.74 km/s');
    // explicit km/s is already km/s
    expect(formatSpectral({ ...base, cunit: 'km/s', crval: 25.74 }, 0).primary).toBe('25.74 km/s');
  });

  it('WAVN converts wavenumber to nm', () => {
    const wavn: SpectralInfo = {
      ctype: 'WAVN',
      cunit: 'cm-1',
      restfrq: null,
      table: null,
      crval: 15000,
      crpix: 1,
      cdelt: 10,
    };
    expect(formatSpectral(wavn, 0).secondary).toBe('λ 666.67 nm');
  });

  it('tabular axis clamps fractional channels at the table end', () => {
    const tab: SpectralInfo = {
      ctype: 'WAVE-TAB',
      cunit: 'um',
      restfrq: null,
      table: new Float64Array([1, 2, 3]),
      crval: 0,
      crpix: 1,
      cdelt: 1,
    };
    expect(spectralValue(tab, 5.7)).toBe(3);
    expect(spectralValue(tab, -2)).toBe(1);
    expect(spectralValue(tab, 1.4)).toBe(2);
  });
});
