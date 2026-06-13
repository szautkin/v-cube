// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Serhii Zautkin and v-cube contributors
/**
 * Publication export — renders the active view off-screen at an integer
 * multiple of the viewport (full quality, fixed jitter), then composes a
 * figure-ready PNG: the frame plus an annotation bar with target, spectral
 * coordinate, and a labeled colorbar. Volume axis captions are burned in
 * from their projected positions (they are DOM overlays, not canvas pixels).
 *
 * Typography/theme is configurable per-export (ExportStyle): curated themes
 * with family/weight/size/accent overrides. The live HUD is intentionally
 * not configurable — only figures are.
 */
import * as THREE from 'three';
import { colormapStops } from './render/colormaps';

export interface ExportAnnotation {
  title: string; // "M101 · SITELLE"
  subtitle: string; // "CH 117/219 · 14987.2 cm⁻¹" or volume axis summary
  colormap: string;
  stretchName: string;
  bunit: string;
  windowRaw: [number, number];
  captions: Array<{ text: string; cls: string; x: number; y: number }>; // in base-CSS px
}

export interface ExportStyle {
  theme: 'cockpit' | 'journal';
  family: 'mono' | 'sans' | 'serif';
  scale: number; // 0.75–1.5 text scale
  weight: '400' | '500' | '700';
  color: 'auto' | string; // accent override for title/captions/box edges
  edgeWidth: number; // volume box & slice-plane edge thickness, px
}

export const DEFAULT_EXPORT_STYLE: ExportStyle = {
  theme: 'cockpit',
  family: 'mono',
  scale: 1,
  weight: '500',
  color: 'auto',
  edgeWidth: 1,
};

export const FONT_FAMILIES: Record<ExportStyle['family'], string> = {
  mono: `ui-monospace, 'SF Mono', Menlo, monospace`,
  sans: `'Helvetica Neue', Helvetica, Arial, sans-serif`,
  serif: `Georgia, 'Times New Roman', serif`,
};

interface Palette {
  bg: string;
  text: string;
  dim: string;
  accent: string;
  line: string;
  glow: boolean;
}

const COCKPIT: Palette = {
  bg: '#04070c',
  text: '#d7f0ff',
  dim: '#6b8a9c',
  accent: '#56c8ff',
  line: 'rgba(86,200,255,0.28)',
  glow: true,
};
const JOURNAL: Palette = {
  bg: '#ffffff',
  text: '#14181c',
  dim: '#5a646c',
  accent: '#14181c',
  line: 'rgba(20,24,28,0.45)',
  glow: false,
};

function barPalette(style: ExportStyle): Palette {
  const p = { ...(style.theme === 'journal' ? JOURNAL : COCKPIT) };
  if (style.color !== 'auto') p.accent = style.color;
  return p;
}

/** Captions sit on the rendered frame (dark) — go dark only on white paper. */
export function captionPalette(style: ExportStyle, transparentBg: boolean): Palette {
  const p = { ...(style.theme === 'journal' && transparentBg ? JOURNAL : COCKPIT) };
  if (style.color !== 'auto') p.accent = style.color;
  return p;
}

export function renderToPixels(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  w: number,
  h: number,
  transparent = false,
): Uint8ClampedArray<ArrayBuffer> {
  const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false });
  const prev = renderer.getRenderTarget();
  const prevColor = new THREE.Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  const buf = new ArrayBuffer(w * h * 4);
  const raw = new Uint8Array(buf);
  try {
    if (transparent) renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, raw);
  } finally {
    // restore GL state even if the render throws (OOM, context loss)
    renderer.setRenderTarget(prev);
    if (transparent) renderer.setClearColor(prevColor, prevAlpha);
    rt.dispose();
  }
  if (transparent) {
    // The framebuffer holds premultiplied color; PNG wants straight RGBA.
    for (let i = 0; i < raw.length; i += 4) {
      const a = raw[i + 3];
      if (a > 0 && a < 255) {
        const k = 255 / a;
        raw[i] = Math.min(255, raw[i] * k);
        raw[i + 1] = Math.min(255, raw[i + 1] * k);
        raw[i + 2] = Math.min(255, raw[i + 2] * k);
      }
    }
  }
  // GL reads bottom-up; flip rows in place (one temp row, no second frame buffer)
  const row = w * 4;
  const tmp = new Uint8Array(row);
  for (let y = 0; y < h >> 1; y++) {
    const top = raw.subarray(y * row, (y + 1) * row);
    const bot = raw.subarray((h - 1 - y) * row, (h - y) * row);
    tmp.set(top);
    top.set(bot);
    bot.set(tmp);
  }
  return new Uint8ClampedArray(buf);
}

export function barHeight(u: number, style: ExportStyle): number {
  return Math.round(34 * u * style.scale);
}

/** Draw the annotation bar at vertical offset `top`. Shared with the live modal preview. */
export function drawAnnotationBar(
  g: CanvasRenderingContext2D,
  w: number,
  top: number,
  u: number,
  ann: ExportAnnotation,
  style: ExportStyle,
): void {
  const p = barPalette(style);
  const fam = FONT_FAMILIES[style.family];
  const fu = u * style.scale;
  const bar = barHeight(u, style);

  g.fillStyle = p.bg;
  g.fillRect(0, top, w, bar);
  g.strokeStyle = p.line;
  g.lineWidth = Math.max(1, u * 0.5);
  g.beginPath();
  g.moveTo(0, top + g.lineWidth / 2);
  g.lineTo(w, top + g.lineWidth / 2);
  g.stroke();

  const cy = top + bar / 2;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = `${style.weight} ${Math.round(11 * fu)}px ${fam}`;
  g.fillStyle = style.color === 'auto' ? p.text : p.accent;
  g.fillText(ann.title, 12 * fu, cy - 7 * fu);
  g.font = `${Math.round(9.5 * fu)}px ${fam}`;
  g.fillStyle = p.dim;
  g.fillText(ann.subtitle, 12 * fu, cy + 8 * fu);

  drawColorbar(g, w - 12 * fu, cy, fu, ann, p, fam);
}

/** Colorbar anchored at its right edge, vertically centered on cy. */
function drawColorbar(
  g: CanvasRenderingContext2D,
  rightX: number,
  cy: number,
  fu: number,
  ann: ExportAnnotation,
  p: Palette,
  fam: string,
): void {
  const cbW = 150 * fu;
  const cbH = 8 * fu;
  const cbX = rightX - cbW;
  const cbY = cy - cbH;
  const grad = g.createLinearGradient(cbX, 0, cbX + cbW, 0);
  const stops = colormapStops(ann.colormap);
  stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
  g.fillStyle = grad;
  g.fillRect(cbX, cbY, cbW, cbH);
  g.strokeStyle = p.line;
  g.strokeRect(cbX, cbY, cbW, cbH);
  g.font = `${Math.round(8.5 * fu)}px ${fam}`;
  g.fillStyle = p.dim;
  g.textAlign = 'left';
  g.fillText(ann.windowRaw[0].toPrecision(3), cbX, cbY + cbH + 9 * fu);
  g.textAlign = 'right';
  g.fillText(`${ann.windowRaw[1].toPrecision(3)} ${ann.bunit}`, cbX + cbW, cbY + cbH + 9 * fu);
  g.fillText(`${ann.stretchName.toUpperCase()} STRETCH`, cbX + cbW, cbY - 5 * fu);
}

export function composePng(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  scale: number,
  ann: ExportAnnotation | null,
  style: ExportStyle,
  transparentBg: boolean,
): HTMLCanvasElement {
  const u = scale;
  const bar = ann ? barHeight(u, style) : 0;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h + bar;
  const g = out.getContext('2d')!;
  g.putImageData(new ImageData(pixels, w, h), 0, 0);

  if (!ann) return out;
  drawCaptions(g, ann.captions, 0, 0, w, h, u, style, transparentBg);
  drawAnnotationBar(g, w, h, u, ann, style);
  return out;
}

/**
 * Burn projected axis captions into a frame at offset (ox, oy), clamped to the
 * frame with half-text padding. Shared by the quick export and the plate.
 */
function drawCaptions(
  g: CanvasRenderingContext2D,
  captions: ExportAnnotation['captions'],
  ox: number,
  oy: number,
  w: number,
  h: number,
  u: number,
  style: ExportStyle,
  transparentBg: boolean,
): void {
  const cp = captionPalette(style, transparentBg);
  const fam = FONT_FAMILIES[style.family];
  const fu = u * style.scale;
  for (const c of captions) {
    const isCap = c.cls.includes('axis-cap');
    g.font = `${isCap ? style.weight + ' ' : ''}${Math.round(10 * fu)}px ${fam}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (cp.glow && isCap) {
      // subtle halo — canvas shadows are far denser than CSS text-shadow,
      // so anything heavier merges short words into solid pills at 4×
      g.shadowColor = 'rgba(86,200,255,0.35)';
      g.shadowBlur = 2.5 * fu;
    }
    g.fillStyle = isCap ? cp.accent : cp.dim;
    const halfW = g.measureText(c.text).width / 2;
    const x = Math.min(Math.max(ox + c.x * u, ox + halfW + 4 * fu), ox + w - halfW - 4 * fu);
    const y = Math.min(Math.max(oy + c.y * u, oy + 7 * fu), oy + h - 7 * fu);
    g.fillText(c.text, x, y);
    g.shadowBlur = 0;
  }
}

/* ---------- figure plate — the full cockpit-framed composition ---------- */

export interface PlateInfo extends ExportAnnotation {
  filename: string;
  dateStr: string;
  dims: string;
  facts: string; // "NAN 34.5% · STREAMED"
  axes: string[]; // ["GLON 179.750° … 180.250°", ...]
}

function brackets(g: CanvasRenderingContext2D, W: number, H: number, u: number, color: string): void {
  const arm = 24 * u;
  const inset = 8 * u;
  g.strokeStyle = color;
  g.lineWidth = Math.max(1, u);
  for (const [cx, cy, dx, dy] of [
    [inset, inset, 1, 1],
    [W - inset, inset, -1, 1],
    [inset, H - inset, 1, -1],
    [W - inset, H - inset, -1, -1],
  ] as Array<[number, number, number, number]>) {
    g.beginPath();
    g.moveTo(cx + arm * dx, cy);
    g.lineTo(cx, cy);
    g.lineTo(cx, cy + arm * dy);
    g.stroke();
  }
}

export function composePlate(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  scale: number,
  info: PlateInfo,
  style: ExportStyle,
): HTMLCanvasElement {
  const u = scale;
  const fu = u * style.scale;
  const p = barPalette(style);
  const fam = FONT_FAMILIES[style.family];
  const pad = 26 * u;
  const headerH = 38 * fu;
  const legendH = 74 * fu;
  const W = w + 2 * pad;
  const H = pad + headerH + h + 12 * u + legendH + pad;

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const g = out.getContext('2d')!;
  g.fillStyle = p.bg;
  g.fillRect(0, 0, W, H);
  brackets(g, W, H, u, p.glow ? 'rgba(86,200,255,0.75)' : p.line);

  const setSpacing = (em: number): void => {
    try {
      (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${em * fu * 10}px`;
    } catch {
      /* older engines: no letter-spacing on canvas */
    }
  };

  // header: brand left, filename · date right
  const hy = pad + headerH / 2 - 4 * fu;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  setSpacing(0.2);
  g.font = `${style.weight} ${Math.round(12 * fu)}px ${fam}`;
  g.fillStyle = p.glow ? '#56c8ff' : p.text;
  if (p.glow) {
    g.shadowColor = 'rgba(86,200,255,0.4)';
    g.shadowBlur = 3 * fu;
  }
  g.fillText('◈ V·CUBE NAV', pad, hy);
  g.shadowBlur = 0;
  setSpacing(0.04);
  g.textAlign = 'right';
  g.font = `${Math.round(9 * fu)}px ${fam}`;
  g.fillStyle = p.dim;
  g.fillText(`${info.filename} · ${info.dateStr}`, W - pad, hy);
  setSpacing(0);
  g.strokeStyle = p.line;
  g.lineWidth = Math.max(1, u * 0.5);
  g.beginPath();
  g.moveTo(pad, pad + headerH - 6 * fu);
  g.lineTo(W - pad, pad + headerH - 6 * fu);
  g.stroke();

  // the frame
  const ix = pad;
  const iy = pad + headerH;
  g.putImageData(new ImageData(pixels, w, h), ix, iy);
  g.strokeStyle = p.line;
  g.strokeRect(ix + 0.5, iy + 0.5, w - 1, h - 1);

  // burned-in volume captions, offset into the frame and clamped to it
  drawCaptions(g, info.captions, ix, iy, w, h, u, style, false);
  g.textBaseline = 'middle';

  // legend block
  const ly = iy + h + 12 * u;
  g.textAlign = 'left';
  g.font = `${style.weight} ${Math.round(12 * fu)}px ${fam}`;
  g.fillStyle = style.color === 'auto' ? p.text : p.accent;
  g.fillText(info.title, pad, ly + 12 * fu);
  g.font = `${Math.round(9.5 * fu)}px ${fam}`;
  g.fillStyle = p.dim;
  g.fillText(info.subtitle, pad, ly + 28 * fu);
  g.fillText(`${info.dims} · ${info.facts}`, pad, ly + 42 * fu);

  // axis ranges column (center)
  const axX = pad + Math.max(w * 0.46, 300 * fu);
  g.font = `${Math.round(9.5 * fu)}px ${fam}`;
  info.axes.forEach((line, i) => {
    const sp = line.indexOf(' ');
    g.fillStyle = p.glow ? '#56c8ff' : p.text;
    g.fillText(line.slice(0, sp), axX, ly + (12 + i * 15) * fu);
    g.fillStyle = p.dim;
    g.fillText(line.slice(sp + 1), axX + 64 * fu, ly + (12 + i * 15) * fu);
  });

  drawColorbar(g, W - pad, ly + 24 * fu, fu, info, p, fam);
  return out;
}

export function savePng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PNG encode failed'));
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      resolve();
    }, 'image/png');
  });
}
