// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Serhii Zautkin and v-cube contributors
import * as THREE from 'three';

/** Matplotlib-derived anchor stops, interpolated to 256-entry LUT textures. */
const STOPS: Record<string, string[]> = {
  viridis: [
    '#440154',
    '#482878',
    '#3e4989',
    '#31688e',
    '#26828e',
    '#1f9e89',
    '#35b779',
    '#6ece58',
    '#b5de2b',
    '#fde725',
  ],
  inferno: [
    '#000004',
    '#1b0c41',
    '#4a0c6b',
    '#781c6d',
    '#a52c60',
    '#cf4446',
    '#ed6925',
    '#fb9b06',
    '#f7d13d',
    '#fcffa4',
  ],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  plasma: [
    '#0d0887',
    '#46039f',
    '#7201a8',
    '#9c179e',
    '#bd3786',
    '#d8576b',
    '#ed7953',
    '#fb9f3a',
    '#fdca26',
    '#f0f921',
  ],
  gray: ['#000000', '#ffffff'],
};

export const COLORMAP_NAMES = Object.keys(STOPS);

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

export function colormapBytes(name: string, n = 256): Uint8Array {
  const stops = (STOPS[name] ?? STOPS.viridis).map(hex);
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (stops.length - 1);
    const a = Math.min(stops.length - 2, Math.floor(t));
    const f = t - a;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(stops[a][c] * (1 - f) + stops[a + 1][c] * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function colormapTexture(name: string): THREE.DataTexture {
  const tex = new THREE.DataTexture(colormapBytes(name), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // Deliberately NOT SRGBColorSpace: our shaders write sampled values straight
  // to the (sRGB-interpreted) canvas, so the stored sRGB LUT bytes must pass
  // through untouched. Tagging sRGB makes the GPU linearize on sample and the
  // rendered colors come out darker than the true colormap (caught by
  // scripts/verify-visuals.mjs).
  tex.needsUpdate = true;
  return tex;
}

export function colormapCss(name: string): string {
  return `linear-gradient(to right, ${(STOPS[name] ?? STOPS.viridis).join(',')})`;
}

export function colormapStops(name: string): string[] {
  return STOPS[name] ?? STOPS.viridis;
}

/** Stretch ids shared between both shaders and the UI. */
export const STRETCHES = ['asinh', 'log', 'sqrt', 'linear'] as const;
export type Stretch = (typeof STRETCHES)[number];

// GLSL ES 3.0 has no asinh; the helper is declared before use.
export const STRETCH_GLSL = /* glsl */ `
float asinhf(float x) { return log(x + sqrt(x * x + 1.0)); }
float applyStretch(float v, int mode) {
  v = clamp(v, 0.0, 1.0);
  if (mode == 0) return asinhf(v * 10.0) / 2.998; // asinh(10)
  if (mode == 1) return log2(1.0 + v * 255.0) / 8.0;
  if (mode == 2) return sqrt(v);
  return v;
}
`;

/** CPU mirror of applyStretch above — keep the two in lockstep. */
export function stretchJs(v: number, mode: number): number {
  v = Math.min(Math.max(v, 0), 1);
  if (mode === 0) return Math.asinh(v * 10) / 2.998;
  if (mode === 1) return Math.log2(1 + v * 255) / 8;
  if (mode === 2) return Math.sqrt(v);
  return v;
}
