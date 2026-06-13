// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Serhii Zautkin and v-cube contributors
/**
 * Just enough WCS for trustworthy readouts on this corpus:
 *  - celestial: TAN (gnomonic) via CD / PC*CDELT / CDELT matrix (SIP ignored)
 *  - spectral: linear CRVAL/CDELT, or WAVE-TAB lookup (JWST MIRI),
 *    with FREQ→radio-velocity (RESTFRQ) and WAVN(cm⁻¹)→nm conversions
 */
import { cardNumber, cardString, readBintableColumn, type Cards, type FitsFile, type Hdu } from './parser';

const D2R = Math.PI / 180;
const C_KMS = 299792.458;

export interface SpectralInfo {
  ctype: string; // FREQ, WAVE, WAVE-TAB, WAVN, VRAD...
  cunit: string;
  restfrq: number | null;
  table: Float64Array | null; // per-channel values when tabular
  crval: number;
  crpix: number;
  cdelt: number;
}

export interface CelestialInfo {
  valid: boolean;
  projection: 'tan' | 'car';
  frame: 'equatorial' | 'galactic';
  crval1: number;
  crval2: number;
  crpix1: number;
  crpix2: number;
  cd: [number, number, number, number]; // [cd11, cd12, cd21, cd22] in deg/px
}

export interface Wcs {
  spectral: SpectralInfo;
  celestial: CelestialInfo;
}

function celestialFrom(cards: Cards): CelestialInfo {
  const ctype1 = cardString(cards, 'CTYPE1');
  const valid = /^RA-/.test(ctype1) || ctype1.startsWith('GLON');
  const projection = ctype1.includes('-CAR') ? 'car' : 'tan';
  const frame = ctype1.startsWith('GLON') ? 'galactic' : 'equatorial';
  const cdelt1 = cardNumber(cards, 'CDELT1', 1);
  const cdelt2 = cardNumber(cards, 'CDELT2', 1);
  let cd11 = cardNumber(cards, 'CD1_1', NaN);
  let cd12 = cardNumber(cards, 'CD1_2', 0);
  let cd21 = cardNumber(cards, 'CD2_1', 0);
  let cd22 = cardNumber(cards, 'CD2_2', NaN);
  if (Number.isNaN(cd11) || Number.isNaN(cd22)) {
    const pc11 = cardNumber(cards, 'PC1_1', 1);
    const pc12 = cardNumber(cards, 'PC1_2', 0);
    const pc21 = cardNumber(cards, 'PC2_1', 0);
    const pc22 = cardNumber(cards, 'PC2_2', 1);
    cd11 = pc11 * cdelt1;
    cd12 = pc12 * cdelt1;
    cd21 = pc21 * cdelt2;
    cd22 = pc22 * cdelt2;
  }
  return {
    valid,
    projection,
    frame,
    crval1: cardNumber(cards, 'CRVAL1', 0),
    crval2: cardNumber(cards, 'CRVAL2', 0),
    crpix1: cardNumber(cards, 'CRPIX1', 1),
    crpix2: cardNumber(cards, 'CRPIX2', 1),
    cd: [cd11, cd12, cd21, cd22],
  };
}

export async function buildWcs(file: FitsFile, hdu: Hdu): Promise<Wcs> {
  const cards = hdu.cards;
  const ctype3 = cardString(cards, 'CTYPE3').trim();
  let table: Float64Array | null = null;
  if (ctype3.includes('-TAB')) {
    const tableExt = cardString(cards, 'PS3_0', 'WCS-TABLE');
    const colName = cardString(cards, 'PS3_1', 'wavelength');
    const ext = file.hdus.find((h) => h.extname === tableExt);
    if (ext) table = await readBintableColumn(file, ext, colName);
  }
  return {
    spectral: {
      ctype: ctype3,
      cunit: cardString(cards, 'CUNIT3').trim(),
      restfrq: cards.has('RESTFRQ')
        ? cardNumber(cards, 'RESTFRQ')
        : cards.has('RESTFREQ')
          ? cardNumber(cards, 'RESTFREQ')
          : null,
      table,
      crval: cardNumber(cards, 'CRVAL3', 0),
      crpix: cardNumber(cards, 'CRPIX3', 1),
      cdelt: cardNumber(cards, 'CDELT3', cardNumber(cards, 'CD3_3', 1)),
    },
    celestial: celestialFrom(cards),
  };
}

/** Channel index (0-based) → physical spectral coordinate in native units. */
export function spectralValue(s: SpectralInfo, channel: number): number {
  if (s.table && s.table.length > 0) {
    const i = Math.min(s.table.length - 1, Math.max(0, Math.round(channel)));
    return s.table[i];
  }
  return s.crval + (channel + 1 - s.crpix) * s.cdelt;
}

export interface SpectralReadout {
  primary: string; // e.g. "230.5380 GHz" / "5.3402 µm"
  secondary: string | null; // e.g. "-12.4 km/s" / "λ 657.3 nm"
  axisLabel: string; // for the scrubber, e.g. "FREQ GHz"
}

export function formatSpectral(s: SpectralInfo, channel: number): SpectralReadout {
  const v = spectralValue(s, channel);
  const t = s.ctype.toUpperCase();
  if (t.startsWith('FREQ')) {
    const hz = s.cunit === 'GHz' ? v * 1e9 : s.cunit === 'MHz' ? v * 1e6 : v;
    const vel = s.restfrq ? C_KMS * (1 - hz / s.restfrq) : null;
    return {
      primary: `${(hz / 1e9).toFixed(5)} GHz`,
      secondary: vel !== null ? `${vel.toFixed(2)} km/s` : null,
      axisLabel: s.restfrq ? 'VELOCITY km/s' : 'FREQ GHz',
    };
  }
  if (t.startsWith('WAVN')) {
    // wavenumber, SITELLE: cm⁻¹ → nm
    const nm = v !== 0 ? 1e7 / v : 0;
    return { primary: `${v.toFixed(3)} cm⁻¹`, secondary: `λ ${nm.toFixed(2)} nm`, axisLabel: 'WAVENUMBER cm⁻¹' };
  }
  if (t.startsWith('WAVE')) {
    const um =
      s.cunit === 'm' ? v * 1e6 : s.cunit.toLowerCase() === 'angstrom' ? v * 1e-4 : s.cunit === 'nm' ? v * 1e-3 : v;
    return { primary: `${um.toFixed(4)} µm`, secondary: null, axisLabel: 'WAVELENGTH µm' };
  }
  if (t.startsWith('VRAD') || t.startsWith('VELO') || t.startsWith('VOPT')) {
    // FITS default spectral velocity unit is m/s; only an explicit km unit is already km/s.
    // (AIPS-style headers abbreviate metres-per-second as 'M', e.g. DRAO survey cubes.)
    const u = s.cunit.trim().toLowerCase();
    const kms = u.startsWith('km') ? v : v / 1000;
    return { primary: `${kms.toFixed(2)} km/s`, secondary: null, axisLabel: 'VELOCITY km/s' };
  }
  if (t.startsWith('FDEP') || t.startsWith('FARADAY')) {
    // Faraday depth from RM synthesis — rad/m²
    return {
      primary: `${v >= 0 ? '+' : ''}${v.toFixed(2)} rad/m²`,
      secondary: null,
      axisLabel: 'FARADAY DEPTH rad/m²',
    };
  }
  return { primary: v.toPrecision(6), secondary: null, axisLabel: s.ctype || 'CHANNEL' };
}

/** Pixel (0-based) → [lon, lat] degrees. TAN via inverse gnomonic; CAR is linear. */
export function pixelToSky(c: CelestialInfo, px: number, py: number): [number, number] | null {
  if (!c.valid) return null;
  const dx = px + 1 - c.crpix1;
  const dy = py + 1 - c.crpix2;
  if (c.projection === 'car') {
    // Plate carrée with the reference on the equator: world = crval + intermediate.
    let lon = c.crval1 + c.cd[0] * dx + c.cd[1] * dy;
    const lat = c.crval2 + c.cd[2] * dx + c.cd[3] * dy;
    lon = ((lon % 360) + 360) % 360;
    return [lon, lat];
  }
  const xi = (c.cd[0] * dx + c.cd[1] * dy) * D2R;
  const eta = (c.cd[2] * dx + c.cd[3] * dy) * D2R;
  const ra0 = c.crval1 * D2R;
  const dec0 = c.crval2 * D2R;
  const den = Math.cos(dec0) - eta * Math.sin(dec0);
  const alpha = ra0 + Math.atan2(xi, den);
  const delta = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(xi, den));
  let ra = alpha / D2R;
  if (ra < 0) ra += 360;
  if (ra >= 360) ra -= 360;
  return [ra, delta / D2R];
}

export function formatRa(deg: number): string {
  const h = deg / 15;
  const hh = Math.floor(h);
  const m = (h - hh) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
}

export function formatDec(deg: number): string {
  const sign = deg < 0 ? '−' : '+';
  const a = Math.abs(deg);
  const dd = Math.floor(a);
  const m = (a - dd) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${sign}${String(dd).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`;
}

export interface SkyReadout {
  lonLabel: string; // 'RA' | 'GLON'
  latLabel: string;
  lon: string;
  lat: string;
}

/** Frame-aware formatting: equatorial → sexagesimal, galactic → decimal ℓ/b. */
export function formatSky(c: CelestialInfo, lon: number, lat: number): SkyReadout {
  if (c.frame === 'galactic') {
    return {
      lonLabel: 'GLON',
      latLabel: 'GLAT',
      lon: `${lon.toFixed(3)}°`,
      lat: `${lat >= 0 ? '+' : '−'}${Math.abs(lat).toFixed(3)}°`,
    };
  }
  return { lonLabel: 'RA', latLabel: 'DEC', lon: formatRa(lon), lat: formatDec(lat) };
}
