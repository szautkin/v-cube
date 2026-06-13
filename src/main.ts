// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { CubeModel } from './data/cubeModel';
import {
  DEFAULT_EXPORT_STYLE,
  FONT_FAMILIES,
  captionPalette,
  composePlate,
  composePng,
  drawAnnotationBar,
  renderToPixels,
  savePng,
  type ExportAnnotation,
  type ExportStyle,
  type PlateInfo,
} from './export';
import { FileSource, fetchSource, type DataSource } from './fits/source';
import { formatSky, formatSpectral, pixelToSky } from './fits/wcs';
import {
  COLORMAP_NAMES,
  STRETCHES,
  colormapCss,
  colormapStops,
  colormapTexture,
  stretchJs,
  type Stretch,
} from './render/colormaps';
import { SliceView } from './render/sliceView';
import { VolumeView } from './render/volumeView';
import { SpectrumPlot } from './ui/spectrum';
import { TfEditor } from './ui/tfEditor';
import { initTooltips } from './ui/tooltip';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/* ---------- renderer (discrete GPU, please) ---------- */

const canvas = $<HTMLCanvasElement>('gl');
const renderer = new THREE.WebGLRenderer({
  canvas,
  powerPreference: 'high-performance',
  antialias: false,
  alpha: false,
  stencil: false,
});
renderer.setClearColor(0x010204, 1);
const gl = renderer.getContext() as WebGL2RenderingContext;
const MAX_3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
const GPU_NAME = dbgExt ? String(gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL)) : 'WebGL2';
const FULL_DPR = Math.min(window.devicePixelRatio || 1, 2);

/* ---------- state ---------- */

interface AppState {
  cube: CubeModel | null;
  mode: 'slice' | 'volume';
  channel: number;
  colormap: string;
  stretch: Stretch;
  winLo: number;
  winHi: number;
  playing: boolean;
  pinned: { x: number; y: number } | null;
}
const state: AppState = {
  cube: null,
  mode: 'slice',
  channel: 0,
  colormap: 'inferno',
  stretch: 'asinh',
  winLo: 0,
  winHi: 1,
  playing: false,
  pinned: null,
};

const cmapTextures = new Map<string, THREE.DataTexture>();
const cmapTex = (name: string): THREE.DataTexture => {
  let t = cmapTextures.get(name);
  if (!t) {
    t = colormapTexture(name);
    cmapTextures.set(name, t);
  }
  return t;
};

const sliceView = new SliceView(canvas, cmapTex(state.colormap));
const volumeView = new VolumeView(canvas, cmapTex(state.colormap));

// Axis captions overlay — DOM-rendered text projected over the volume box
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
canvas.parentElement!.appendChild(labelRenderer.domElement);
const spectrumPlot = new SpectrumPlot($<HTMLCanvasElement>('spectrum'));
const tfEditor = new TfEditor($<HTMLCanvasElement>('tfCanvas'));

let dirty = true;
let interacting = false;
let idleTimer = 0;
let currentPlane: Float32Array | null = null;
let currentPlaneChannel = 0; // channel the displayed plane belongs to (may trail state.channel while streaming)
let planeRequest = 0;
let renderCount = 0;
let loadInFlight = false;

const markDirty = (): void => {
  dirty = true;
};

/* ---------- toasts ---------- */

function toast(msg: string, kind: 'info' | 'warn' | 'error' = 'info', ms = 5000): void {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? '' : kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ---------- loading ---------- */

async function loadSource(source: DataSource): Promise<void> {
  if (loadInFlight) {
    toast('A cube is already loading — wait for the link to settle', 'warn');
    return;
  }
  loadInFlight = true;
  const progressWrap = $('progressWrap');
  const progressFill = $('progressFill');
  const progressLabel = $('progressLabel');
  try {
    progressWrap.hidden = false;
    $('standby').style.display = 'none';
    const cube = await CubeModel.open(source);
    await cube.ingest(
      (p) => {
        progressLabel.textContent = p.stage;
        progressFill.style.width = `${Math.round(p.frac * 100)}%`;
      },
      MAX_3D,
      256e6,
    );
    state.cube = cube;
    state.channel = Math.floor(cube.nz / 2);
    state.pinned = null;
    state.winLo = 0;
    state.winHi = 1;
    spectrumPlot.setSpectrum(null);
    // Clear stale probe readouts from the previous cube
    for (const id of ['prRa', 'prDec', 'prSpec', 'prFlux', 'prPx']) $(id).textContent = '—';
    $('spectrumHint').textContent = 'click image to pin probe';

    const stats = cube.stats!;
    sliceView.setCubeDims(cube.nx, cube.ny);
    sliceView.setRange(stats.lo, stats.hi);
    volumeView.setVolume(cube.volume!);

    // Default transfer function: transparent up to the median (noise floor /
    // continuum), so line cubes glow as emission instead of a solid noise block.
    const medNorm = Math.min(Math.max((stats.median - stats.lo) / (stats.hi - stats.lo), 0), 0.85);
    const floor = stretchJs(medNorm, STRETCHES.indexOf(state.stretch));
    const tfDefault: Array<[number, number]> = [
      [0, 0],
      [Math.min(floor + 0.03, 0.9), 0],
      [Math.min(floor + 0.3, 0.96), 0.3],
      [1, 0.9],
    ];
    tfEditor.setPoints(tfDefault);
    volumeView.setTransferFunction(tfDefault);

    // HUD info
    $('objName').textContent = cube.object || cube.name;
    $('instrName').textContent = [cube.telescope, cube.instrument, cube.name].filter(Boolean).join(' · ');
    $('ciDims').textContent = `${cube.nx} × ${cube.ny} × ${cube.nz}`;
    $('ciUnit').textContent = cube.bunit || '—';
    $('ciRange').textContent = `${stats.lo.toPrecision(3)} … ${stats.hi.toPrecision(3)}`;
    $('ciNan').textContent = `${(stats.nanFrac * 100).toFixed(1)}%`;
    $('ciMem').textContent = cube.isStreamed ? 'STREAMED' : 'RESIDENT';
    const v = cube.volume!;
    $('texInfo').textContent = `TEX3D ${v.nx}×${v.ny}×${v.nz} · ${(v.data.byteLength / 1e6) | 0} MB`;
    if (cube.isStreamed)
      toast('Large cube: slices stream from disk at native res; spectrum probe disabled', 'warn', 7000);
    if (stats.nanFrac > 0.3) toast(`${Math.round(stats.nanFrac * 100)}% blank voxels (NaN) — masked in render`, 'info');

    volumeView.setAxisCaptions(axisCaptions(cube));
    await setChannel(state.channel, true);
    buildScrubProfile();
    applyWindow();
    sliceView.fit();
    markDirty();
  } catch (err) {
    // Only fall back to standby when no previous cube is still on screen
    $('standby').style.display = state.cube ? 'none' : '';
    toast(err instanceof Error ? err.message : String(err), 'error', 9000);
  } finally {
    loadInFlight = false;
    progressWrap.hidden = true;
  }
}

interface AxisInfo {
  xName: string;
  x0: string;
  x1: string;
  yName: string;
  y0: string;
  y1: string;
  zName: string;
  z0: string;
  z1: string;
}

/** Axis names + endpoint values from the cube's WCS (pixel fallback). */
function computeAxisInfo(cube: CubeModel): AxisInfo {
  const cel = cube.wcs!.celestial;
  const spec = cube.wcs!.spectral;
  const info: AxisInfo = {
    xName: 'X',
    x0: '0',
    x1: String(cube.nx - 1),
    yName: 'Y',
    y0: '0',
    y1: String(cube.ny - 1),
    zName: formatSpectral(spec, 0).axisLabel,
    z0: formatSpectral(spec, 0).primary,
    z1: formatSpectral(spec, cube.nz - 1).primary,
  };
  const o = pixelToSky(cel, 0, 0);
  const ex = pixelToSky(cel, cube.nx - 1, 0);
  const ey = pixelToSky(cel, 0, cube.ny - 1);
  if (o && ex && ey) {
    const f0 = formatSky(cel, o[0], o[1]);
    info.xName = f0.lonLabel;
    info.yName = f0.latLabel;
    info.x0 = f0.lon;
    info.x1 = formatSky(cel, ex[0], ex[1]).lon;
    info.y0 = f0.lat;
    info.y1 = formatSky(cel, ey[0], ey[1]).lat;
  }
  return info;
}

function axisCaptions(cube: CubeModel): Array<{ text: string; pos: [number, number, number]; cls: string }> {
  const a = computeAxisInfo(cube);
  const E = 0.6; // just outside the ±0.5 box faces
  return [
    { text: a.xName, pos: [0, -E, E], cls: 'axis-cap' },
    { text: a.x0, pos: [-0.5, -E, E], cls: 'axis-tick' },
    { text: a.x1, pos: [0.5, -E, E], cls: 'axis-tick' },
    { text: a.yName, pos: [-E, 0, E], cls: 'axis-cap' },
    { text: a.y0, pos: [-E, -0.5, E], cls: 'axis-tick' },
    { text: a.y1, pos: [-E, 0.5, E], cls: 'axis-tick' },
    { text: a.zName, pos: [E, -E, 0], cls: 'axis-cap' },
    { text: a.z0, pos: [E, -E, -0.5], cls: 'axis-tick' },
    { text: a.z1, pos: [E, -E, 0.5], cls: 'axis-tick' },
  ];
}

/* ---------- channel / scrubber ---------- */

async function setChannel(z: number, force = false): Promise<void> {
  const cube = state.cube;
  if (!cube) return;
  z = Math.max(0, Math.min(cube.nz - 1, Math.round(z)));
  if (z === state.channel && !force) return;
  state.channel = z;
  const token = ++planeRequest;
  const plane = await cube.plane(z);
  if (token !== planeRequest) return; // superseded while streaming
  currentPlane = plane;
  currentPlaneChannel = z;
  sliceView.setPlane(plane);
  volumeView.setSliceChannel(cube.nz > 1 ? z / (cube.nz - 1) : 0.5);
  spectrumPlot.setChannel(z);

  const fr = formatSpectral(cube.wcs!.spectral, z);
  $('chanReadout').textContent = `CH ${String(z + 1).padStart(String(cube.nz).length, '0')}/${cube.nz}`;
  $('specReadout').textContent = fr.secondary ? `${fr.primary} · ${fr.secondary}` : fr.primary;
  $('axisLabel').textContent = fr.axisLabel;
  $('scrubFill').style.width = `${(z / Math.max(cube.nz - 1, 1)) * 100}%`;
  $('scrubHandle').style.left = `${(z / Math.max(cube.nz - 1, 1)) * 100}%`;
  markDirty();
}

function bindScrubber(): void {
  const track = $('scrubTrack');
  let down = false;
  const toChannel = (e: PointerEvent): void => {
    const r = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    void setChannel(Math.round(f * ((state.cube?.nz ?? 1) - 1)));
  };
  track.addEventListener('pointerdown', (e) => {
    down = true;
    track.setPointerCapture(e.pointerId);
    toChannel(e);
  });
  track.addEventListener('pointermove', (e) => down && toChannel(e));
  track.addEventListener('pointerup', () => (down = false));
  track.addEventListener('pointercancel', () => (down = false));
}

/** Mean-flux-per-channel waveform behind the scrubber (RAM cubes only). */
function buildScrubProfile(): void {
  const cube = state.cube;
  const cv = $<HTMLCanvasElement>('scrubProfile');
  const g = cv.getContext('2d')!;
  const w = (cv.width = cv.clientWidth * 2);
  const h = (cv.height = cv.clientHeight * 2);
  g.clearRect(0, 0, w, h);
  if (!cube || cube.isStreamed) return;
  const prof = new Float32Array(cube.nz);
  const stride = Math.max(1, Math.floor((cube.nx * cube.ny) / 400));
  for (let z = 0; z < cube.nz; z++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < cube.nx * cube.ny; i += stride) {
      const v = cube.valueAt(i % cube.nx, (i / cube.nx) | 0, z);
      if (v === v) {
        s += v;
        n++;
      }
    }
    prof[z] = n ? s / n : 0;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of prof) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return;
  g.strokeStyle = 'rgba(86,200,255,0.9)';
  g.lineWidth = 1.5;
  g.beginPath();
  for (let z = 0; z < cube.nz; z++) {
    const x = (z / (cube.nz - 1)) * w;
    const y = h - 2 - ((prof[z] - lo) / (hi - lo)) * (h - 4);
    if (z === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

/* ---------- probe / readout ---------- */

function updateProbe(px: number, py: number, clientX: number, clientY: number, inside: boolean): void {
  const chip = $('readoutChip');
  const cube = state.cube;
  if (!cube || !inside || state.mode !== 'slice') {
    chip.hidden = true;
    return;
  }
  // Read out against the plane actually on screen — while a streamed plane is
  // in flight, state.channel may already be ahead of the displayed image.
  const raw = currentPlane ? currentPlane[py * cube.nx + px] : NaN;
  const cel = cube.wcs!.celestial;
  const sky = pixelToSky(cel, px, py);
  const fr = formatSpectral(cube.wcs!.spectral, currentPlaneChannel);
  const flux = raw === raw ? `${raw.toPrecision(5)} ${cube.bunit}` : 'NaN';
  const fmt = sky ? formatSky(cel, sky[0], sky[1]) : null;

  $('prLonLabel').textContent = fmt?.lonLabel ?? 'RA';
  $('prLatLabel').textContent = fmt?.latLabel ?? 'DEC';
  $('prRa').textContent = fmt?.lon ?? '—';
  $('prDec').textContent = fmt?.lat ?? '—';
  $('prSpec').textContent = fr.primary;
  $('prFlux').textContent = flux;
  $('prPx').textContent = `${px}, ${py}, ${currentPlaneChannel}`;

  chip.hidden = false;
  chip.textContent = fmt
    ? `${fmt.lonLabel === 'RA' ? 'α' : 'ℓ'} ${fmt.lon}  ${fmt.latLabel === 'DEC' ? 'δ' : 'b'} ${fmt.lat}\n${fr.primary}${fr.secondary ? '  ' + fr.secondary : ''}\n${flux}`
    : `px ${px},${py}\n${fr.primary}\n${flux}`;
  const vw = window.innerWidth;
  chip.style.left = `${Math.min(clientX + 18, vw - 240)}px`;
  chip.style.top = `${clientY + 18}px`;
}

sliceView.onPointer = (info) => updateProbe(info.px, info.py, info.clientX, info.clientY, info.inside);
sliceView.onClickVoxel = (px, py) => {
  const cube = state.cube;
  if (!cube) return;
  state.pinned = { x: px, y: py };
  const spec = cube.spectrum(px, py);
  spectrumPlot.setSpectrum(spec);
  $('spectrumHint').textContent = `px ${px},${py}`;
  if (!spec) toast('Spectrum probe needs a RAM-resident cube', 'warn');
};
volumeView.onPickChannel = (ch) => {
  void setChannel(ch);
  setMode('slice');
  toast(`Locked brightest feature → CH ${Math.round(ch) + 1}`, 'info', 2500);
};
volumeView.onInteract = () => {
  if (autoOrbiting) {
    // camera change came from the idle orbit itself — keep full-quality rendering
    markDirty();
    return;
  }
  interacting = true;
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    interacting = false;
    markDirty(); // one full-quality refinement pass
  }, 220);
  markDirty();
};

/* ---------- idle auto-orbit ---------- */

const ORBIT_KEY = 'cadcCubeIdleOrbit';
const idleOrbit: { enabled: boolean; delaySec: number } = {
  enabled: true,
  delaySec: 120,
  ...((): Partial<{ enabled: boolean; delaySec: number }> => {
    try {
      return JSON.parse(localStorage.getItem(ORBIT_KEY) ?? '{}') as Partial<{ enabled: boolean; delaySec: number }>;
    } catch {
      return {};
    }
  })(),
};
let lastActivity = performance.now();
let autoOrbiting = false;

function stopAutoOrbit(): void {
  if (!autoOrbiting) return;
  autoOrbiting = false;
  volumeView.controls.autoRotate = false;
  // flush rotation inertia — without this the cube coasts on damping and
  // briefly fights the user's own drag
  volumeView.controls.enableDamping = false;
  volumeView.controls.update();
  volumeView.controls.enableDamping = true;
  markDirty();
}

function noteActivity(): void {
  lastActivity = performance.now();
  stopAutoOrbit();
}

function bindIdleOrbit(): void {
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const) {
    window.addEventListener(ev, noteActivity, { passive: true, capture: true });
  }
  const save = (): void => localStorage.setItem(ORBIT_KEY, JSON.stringify(idleOrbit));
  const cb = $<HTMLInputElement>('autoOrbit');
  const slider = $<HTMLInputElement>('orbitDelay');
  cb.checked = idleOrbit.enabled;
  slider.value = String(idleOrbit.delaySec);
  const readout = (): void => {
    $('orbitDelayReadout').textContent = `${(idleOrbit.delaySec / 60).toFixed(1)} min`;
  };
  readout();
  cb.onchange = () => {
    idleOrbit.enabled = cb.checked;
    if (!idleOrbit.enabled) stopAutoOrbit();
    save();
  };
  slider.oninput = () => {
    idleOrbit.delaySec = Number(slider.value);
    readout();
    save();
  };
}

/* ---------- mode & display controls ---------- */

function setMode(mode: 'slice' | 'volume'): void {
  state.mode = mode;
  if (mode !== 'volume') stopAutoOrbit();
  sliceView.enabled = mode === 'slice';
  volumeView.enabled = mode === 'volume';
  volumeView.controls.enabled = mode === 'volume';
  document.querySelectorAll<HTMLButtonElement>('#modeSwitch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  $('volPanel').style.opacity = mode === 'volume' ? '1' : '0.45';
  canvas.style.cursor = mode === 'slice' ? 'crosshair' : 'grab';
  labelRenderer.domElement.style.display = mode === 'volume' ? '' : 'none';
  $('readoutChip').hidden = true;
  markDirty();
}

function applyWindow(): void {
  sliceView.setWindow(state.winLo, state.winHi);
  volumeView.setWindow(state.winLo, state.winHi);
  const s = state.cube?.stats;
  if (s) {
    const raw = (t: number) => (s.lo + t * (s.hi - s.lo)).toPrecision(3);
    $('winReadout').textContent = `${raw(state.winLo)} … ${raw(state.winHi)}`;
  }
  markDirty();
}

function buildDisplayControls(): void {
  const cmapRow = $('cmapRow');
  for (const name of COLORMAP_NAMES) {
    const sw = document.createElement('div');
    sw.className = `swatch${name === state.colormap ? ' active' : ''}`;
    sw.style.background = colormapCss(name);
    sw.dataset.tip = `${name} colormap`;
    sw.onclick = () => {
      state.colormap = name;
      cmapRow.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      sw.classList.add('active');
      sliceView.setColormap(cmapTex(name));
      volumeView.setColormap(cmapTex(name));
      tfEditor.setGradientStops(colormapStops(name));
      markDirty();
    };
    cmapRow.appendChild(sw);
  }
  tfEditor.setGradientStops(colormapStops(state.colormap));

  const stretchTips: Record<Stretch, string> = {
    asinh: 'Astronomy default — lifts faint extended emission, compresses bright peaks',
    log: 'High dynamic range — bright cores and faint envelopes at once',
    sqrt: 'Gentle lift, between linear and log',
    linear: 'No stretch — raw linear scaling; faint structure will hide',
  };
  const stretchRow = $('stretchRow');
  STRETCHES.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = `hud-btn small${s === state.stretch ? ' active' : ''}`;
    btn.textContent = s.toUpperCase();
    btn.dataset.tip = stretchTips[s];
    btn.onclick = () => {
      state.stretch = s;
      stretchRow.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      btn.classList.add('active');
      sliceView.setStretch(i);
      volumeView.setStretch(i);
      markDirty();
    };
    stretchRow.appendChild(btn);
  });

  const winLo = $<HTMLInputElement>('winLo');
  const winHi = $<HTMLInputElement>('winHi');
  const onWin = (): void => {
    const lo = Number(winLo.value) / 1000;
    let hi = Number(winHi.value) / 1000;
    if (hi - lo < 0.01) hi = lo + 0.01;
    state.winLo = lo;
    state.winHi = hi;
    applyWindow();
  };
  winLo.oninput = onWin;
  winHi.oninput = onWin;

  $<HTMLInputElement>('density').oninput = (e) => {
    const d = Number((e.target as HTMLInputElement).value) / 100;
    $('densReadout').textContent = d.toFixed(2);
    volumeView.setDensity(d);
    markDirty();
  };
  $<HTMLInputElement>('zscale').oninput = (e) => {
    const z = Number((e.target as HTMLInputElement).value) / 100;
    $('zscaleReadout').textContent = z.toFixed(2);
    volumeView.setSpectralScale(z);
    markDirty();
  };
  $<HTMLInputElement>('steps').oninput = (e) => {
    const n = Number((e.target as HTMLInputElement).value);
    $('stepsReadout').textContent = String(n);
    volumeView.setBaseSteps(n);
    markDirty();
  };
  $<HTMLInputElement>('showPlane').onchange = (e) => {
    volumeView.setSlicePlaneVisible((e.target as HTMLInputElement).checked);
    markDirty();
  };
  $('volComposite').onclick = () => {
    volumeView.setMip(false);
    $('volComposite').classList.add('active');
    $('volMip').classList.remove('active');
    markDirty();
  };
  $('volMip').onclick = () => {
    volumeView.setMip(true);
    $('volMip').classList.add('active');
    $('volComposite').classList.remove('active');
    markDirty();
  };
  tfEditor.onChange = (pts) => {
    volumeView.setTransferFunction(pts);
    markDirty();
  };

  document.querySelectorAll<HTMLButtonElement>('#modeSwitch button').forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode as 'slice' | 'volume');
  });

  $('helpChip').onclick = () => {
    const p = $('helpPanel');
    p.hidden = !p.hidden;
  };
  $('exportPng2').onclick = () => void exportView(2);
  $('exportPng4').onclick = () => void exportView(4);
}

/* ---------- export ---------- */

const STYLE_KEY = 'cadcCubeExportStyle';
const exportStyle: ExportStyle = {
  ...DEFAULT_EXPORT_STYLE,
  ...((): Partial<ExportStyle> => {
    try {
      return JSON.parse(localStorage.getItem(STYLE_KEY) ?? '{}') as Partial<ExportStyle>;
    } catch {
      return {};
    }
  })(),
};

/** Mirror the export style onto the live captions and box edges — WYSIWYG with the figure. */
function applyLiveCaptionStyle(): void {
  const p = captionPalette(exportStyle, false); // live canvas is dark, like an opaque export
  const el = labelRenderer.domElement.style;
  el.setProperty('--cap-family', FONT_FAMILIES[exportStyle.family]);
  el.setProperty('--cap-weight', exportStyle.weight);
  el.setProperty('--cap-scale', String(exportStyle.scale));
  el.setProperty('--cap-accent', p.accent);
  el.setProperty('--cap-dim', p.dim);
  el.setProperty('--cap-glow', p.glow ? '0 0 9px rgba(86,200,255,0.55)' : 'none');
  volumeView.setEdgeStyle(exportStyle.color === 'auto' ? null : exportStyle.color, exportStyle.edgeWidth);
  markDirty();
}

function previewAnnotation(): ExportAnnotation {
  const cube = state.cube;
  if (cube) return baseAnnotation(cube, exportNames(cube).objName);
  return {
    title: 'M101 · CFHT · SITELLE',
    subtitle: 'CH 117/219 · 14987.250 cm⁻¹',
    colormap: state.colormap,
    stretchName: state.stretch,
    bunit: 'K',
    windowRaw: [0.00293, 0.58],
    captions: [],
  };
}

function drawStylePreview(): void {
  const cv = $<HTMLCanvasElement>('stylePreview');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth * dpr;
  if (w === 0) return;
  cv.width = w;
  cv.height = cv.clientHeight * dpr;
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, cv.width, cv.height);
  // derive u so the bar exactly fills the preview strip at any text scale
  const u = cv.height / (34 * exportStyle.scale);
  drawAnnotationBar(g, w, 0, u, previewAnnotation(), exportStyle);
}

function bindStyleModal(): void {
  const modal = $('styleModal');
  const open = (): void => {
    modal.hidden = false;
    syncStyleControls();
    requestAnimationFrame(drawStylePreview);
  };
  const close = (): void => {
    modal.hidden = true;
  };
  $('styleBtn').onclick = open;
  $('styleClose').onclick = close;
  $('styleReset').onclick = () => {
    Object.assign(exportStyle, DEFAULT_EXPORT_STYLE);
    syncStyleControls();
    saved();
  };
  modal.addEventListener('pointerdown', (e) => {
    if (e.target === modal) close();
  });

  const saved = (): void => {
    localStorage.setItem(STYLE_KEY, JSON.stringify(exportStyle));
    drawStylePreview();
    applyLiveCaptionStyle();
  };

  const bindPick = (id: string, apply: (v: string) => void): void => {
    $(id)
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => {
        b.onclick = () => {
          apply(b.dataset.v!);
          syncStyleControls();
          saved();
        };
      });
  };
  bindPick('styleTheme', (v) => (exportStyle.theme = v as ExportStyle['theme']));
  bindPick('styleFamily', (v) => (exportStyle.family = v as ExportStyle['family']));
  bindPick('styleWeight', (v) => (exportStyle.weight = v as ExportStyle['weight']));

  $<HTMLInputElement>('styleScale').oninput = (e) => {
    exportStyle.scale = Number((e.target as HTMLInputElement).value) / 100;
    $('styleScaleReadout').textContent = `${exportStyle.scale.toFixed(2)}×`;
    saved();
  };
  $<HTMLInputElement>('styleEdge').oninput = (e) => {
    exportStyle.edgeWidth = Number((e.target as HTMLInputElement).value) / 100;
    $('styleEdgeReadout').textContent = `${exportStyle.edgeWidth.toFixed(1)} px`;
    saved();
  };
  $('styleColor')
    .querySelectorAll<HTMLElement>('.color-swatch')
    .forEach((sw) => {
      sw.onclick = () => {
        exportStyle.color = sw.dataset.v!;
        syncStyleControls();
        saved();
      };
    });
}

function syncStyleControls(): void {
  const mark = (id: string, v: string): void => {
    $(id)
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => b.classList.toggle('active', b.dataset.v === v));
  };
  mark('styleTheme', exportStyle.theme);
  mark('styleFamily', exportStyle.family);
  mark('styleWeight', exportStyle.weight);
  $<HTMLInputElement>('styleScale').value = String(Math.round(exportStyle.scale * 100));
  $('styleScaleReadout').textContent = `${exportStyle.scale.toFixed(2)}×`;
  $<HTMLInputElement>('styleEdge').value = String(Math.round(exportStyle.edgeWidth * 100));
  $('styleEdgeReadout').textContent = `${exportStyle.edgeWidth.toFixed(1)} px`;
  $('styleColor')
    .querySelectorAll<HTMLElement>('.color-swatch')
    .forEach((sw) => {
      sw.classList.toggle('active', sw.dataset.v === exportStyle.color);
    });
}

/** Off-screen render of the active view at scale× — shared by quick export and plate. */
function renderFrame(
  scale: number,
  transparent: boolean,
): {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  w: number;
  h: number;
  scale: number;
  captions: ExportAnnotation['captions'];
} {
  const rect = canvas.getBoundingClientRect();
  // Browsers cap canvas dimensions (~16k); clamp the effective scale on huge viewports
  const maxDim = 16000;
  const fit = Math.min(1, maxDim / (Math.max(rect.width, rect.height) * scale));
  if (fit < 1) toast(`Export scale clamped to ${(scale * fit).toFixed(1)}× — canvas size limit`, 'warn');
  scale *= fit;
  const w = Math.round(rect.width * scale);
  const h = Math.round(rect.height * scale);
  let pixels: Uint8ClampedArray<ArrayBuffer>;
  let captions: ExportAnnotation['captions'] = [];
  if (state.mode === 'volume') {
    volumeView.setQuality(1.5); // export gets more ray-march steps than interactive
    pixels = renderToPixels(renderer, volumeView.scene, volumeView.camera, w, h, transparent);
    volumeView.setQuality(1);
    captions = volumeView.captionScreenPositions(rect.width, rect.height);
  } else {
    pixels = renderToPixels(renderer, sliceView.scene, sliceView.camera, w, h, transparent);
  }
  return { pixels, w, h, scale, captions };
}

function exportNames(cube: CubeModel): { objName: string; safe: string } {
  // OBJECT can be absent (placeholder '—'); fall back to the file stem
  const objName = cube.object && cube.object !== '—' ? cube.object : cube.name.replace(/\.(fits?|fts)$/i, '');
  const safe = objName.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'cube';
  return { objName, safe };
}

function baseAnnotation(cube: CubeModel, objName: string): ExportAnnotation {
  const stats = cube.stats!;
  const fr = formatSpectral(cube.wcs!.spectral, currentPlaneChannel);
  return {
    title: [objName, cube.telescope, cube.instrument].filter(Boolean).join(' · '),
    subtitle:
      state.mode === 'slice'
        ? `CH ${currentPlaneChannel + 1}/${cube.nz} · ${fr.primary}${fr.secondary ? ' · ' + fr.secondary : ''}`
        : `VOLUME · ${fr.axisLabel} · ${cube.nx}×${cube.ny}×${cube.nz}`,
    colormap: state.colormap,
    stretchName: state.stretch,
    bunit: cube.bunit,
    windowRaw: [stats.lo + state.winLo * (stats.hi - stats.lo), stats.lo + state.winHi * (stats.hi - stats.lo)],
    captions: [],
  };
}

async function exportView(scale: number): Promise<void> {
  const cube = state.cube;
  if (!cube) {
    toast('No cube loaded — nothing to export', 'warn');
    return;
  }
  const annotate = $<HTMLInputElement>('exportAnnotate').checked;
  const transparent = $<HTMLInputElement>('exportTransparent').checked;
  try {
    const { pixels, w, h, scale: eff, captions } = renderFrame(scale, transparent);
    const { objName, safe } = exportNames(cube);
    const ann: ExportAnnotation | null = annotate ? { ...baseAnnotation(cube, objName), captions } : null;
    const composed = composePng(pixels, w, h, eff, ann, exportStyle, transparent);
    const suffix = state.mode === 'slice' ? `ch${currentPlaneChannel + 1}` : 'volume';
    await savePng(composed, `${safe}_${suffix}_${scale}x.png`);
    toast(`Exported ${composed.width}×${composed.height} PNG`, 'info', 3500);
    markDirty(); // restore interactive render state
  } catch (err) {
    toast(`Export failed: ${err instanceof Error ? err.message : err}`, 'error');
  }
}

/* ---------- figure plate (preview → PNG / print) ---------- */

function composePlateNow(scale: number): { canvas: HTMLCanvasElement; name: string } | null {
  const cube = state.cube;
  if (!cube) {
    toast('No cube loaded — nothing to compose', 'warn');
    return null;
  }
  const { pixels, w, h, scale: eff, captions } = renderFrame(scale, false);
  const { objName, safe } = exportNames(cube);
  const stats = cube.stats!;
  const a = computeAxisInfo(cube);
  const info: PlateInfo = {
    ...baseAnnotation(cube, objName),
    captions,
    filename: cube.name,
    dateStr: new Date().toISOString().slice(0, 10),
    dims: `${cube.nx} × ${cube.ny} × ${cube.nz}`,
    facts: `NAN ${(stats.nanFrac * 100).toFixed(1)}% · ${cube.isStreamed ? 'STREAMED' : 'RESIDENT'}`,
    axes: [
      `${a.xName} ${a.x0} … ${a.x1}`,
      `${a.yName} ${a.y0} … ${a.y1}`,
      `${a.zName.split(' ')[0]} ${a.z0} … ${a.z1}`,
    ],
  };
  const composed = composePlate(pixels, w, h, eff, info, exportStyle);
  markDirty();
  return { canvas: composed, name: `${safe}_plate_${scale}x.png` };
}

function printCanvas(cv: HTMLCanvasElement): void {
  const url = cv.toDataURL('image/png');
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(
    `<html><head><style>@page{size:landscape;margin:8mm}html,body{margin:0}img{width:100%}</style></head>` +
      `<body><img src="${url}" onload="setTimeout(()=>{window.focus();window.print()},60)"></body></html>`,
  );
  doc.close();
  setTimeout(() => frame.remove(), 60000); // give the print dialog time
}

function bindPlateModal(): void {
  const modal = $('plateModal');
  const close = (): void => {
    modal.hidden = true;
  };
  $('plateBtn').onclick = () => {
    const r = composePlateNow(1); // preview at screen resolution — fast and exact
    if (!r) return;
    modal.hidden = false;
    const cv = $<HTMLCanvasElement>('plateCanvas');
    cv.width = r.canvas.width;
    cv.height = r.canvas.height;
    cv.getContext('2d')!.drawImage(r.canvas, 0, 0);
  };
  $('plateClose').onclick = close;
  modal.addEventListener('pointerdown', (e) => {
    if (e.target === modal) close();
  });
  const exportPlate = async (scale: number): Promise<void> => {
    const r = composePlateNow(scale);
    if (!r) return;
    await savePng(r.canvas, r.name);
    toast(`Exported plate ${r.canvas.width}×${r.canvas.height}`, 'info', 3500);
  };
  $('platePng2').onclick = () => void exportPlate(2);
  $('platePng4').onclick = () => void exportPlate(4);
  $('platePrint').onclick = () => {
    const r = composePlateNow(2);
    if (r) printCanvas(r.canvas);
  };
}

/* ---------- samples & file input ---------- */

interface SampleFeed {
  label: string;
  sz: string;
  url: string;
  tip?: string;
}

/**
 * Sample feeds are deployment config, not code: an optional samples.json next
 * to index.html. The dev server serves the repo-root one (pointing into
 * data_cubes); production builds ship without it, so the section disappears
 * unless the host provides its own.
 */
async function buildSampleList(): Promise<void> {
  let samples: SampleFeed[] = [];
  try {
    const res = await fetch('./samples.json');
    const ct = res.headers.get('content-type') ?? '';
    if (res.ok && !ct.includes('text/html')) {
      const parsed: unknown = await res.json();
      if (Array.isArray(parsed)) samples = parsed.filter((s: SampleFeed) => s?.label && s?.url);
    }
  } catch {
    /* no samples.json — section stays hidden */
  }
  if (samples.length === 0) return;
  $('samplesLabel').hidden = false;
  const ul = $('samples');
  for (const s of samples) {
    // textContent, not innerHTML — samples.json is host-provided config and
    // must not be able to inject markup into the app
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `▸ ${s.label}`;
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = s.sz ?? '';
    li.append(name, sz);
    if (s.tip) li.dataset.tip = s.tip;
    // Sample feeds only exist where the host serves data_cubes (dev box); probe
    // and grey out elsewhere so a deployed instance degrades visibly, not silently.
    // SPA hosts answer unknown paths with index.html + 200, so a status check is
    // not enough — confirm the response is actually FITS bytes.
    fetch(encodeURI(s.url), { headers: { Range: 'bytes=0-79' } })
      .then(async (r) => {
        const ct = r.headers.get('content-type') ?? '';
        let ok = r.ok && !ct.includes('text/html');
        if (ok && r.status === 206) {
          const head = new TextDecoder().decode((await r.arrayBuffer()).slice(0, 6));
          ok = head === 'SIMPLE';
        } else {
          void r.body?.cancel();
        }
        if (!ok) throw new Error();
      })
      .catch(() => {
        li.classList.add('unavailable');
        li.dataset.tip = 'Sample feed not served by this host — use DROP / BROWSE instead';
      });
    li.onclick = async () => {
      if (li.classList.contains('unavailable')) return;
      li.classList.add('loading');
      try {
        const src = await fetchSource(encodeURI(s.url), (f) => {
          $('progressWrap').hidden = false;
          $('progressLabel').textContent = 'DOWNLINK';
          $('progressFill').style.width = `${Math.round(f * 100)}%`;
        });
        await loadSource(src);
      } catch (err) {
        toast(`Sample feed failed: ${err instanceof Error ? err.message : err}`, 'error');
      } finally {
        li.classList.remove('loading');
      }
    };
    ul.appendChild(li);
  }
}

function bindFileInput(): void {
  const input = $<HTMLInputElement>('fileInput');
  $('dropzone').onclick = () => input.click();
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void loadSource(new FileSource(f));
    input.value = '';
  };
  const dz = $('dropzone');
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('armed');
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) dz.classList.remove('armed');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('armed');
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadSource(new FileSource(f));
  });
}

/* ---------- keyboard ---------- */

function bindKeys(): void {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // modals close from anywhere, including focused inputs/sliders
      $('guide').hidden = true;
      $('styleModal').hidden = true;
      $('plateModal').hidden = true;
      return;
    }
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowRight':
        void setChannel(state.channel + step);
        break;
      case 'ArrowLeft':
        void setChannel(state.channel - step);
        break;
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'v':
      case 'V':
        setMode(state.mode === 'slice' ? 'volume' : 'slice');
        break;
      case 'r':
      case 'R':
        if (state.mode === 'slice') sliceView.fit();
        else {
          volumeView.camera.position.set(1.6, 1.1, 1.9);
          volumeView.controls.target.set(0, 0, 0);
        }
        markDirty();
        break;
      case 'g':
      case 'G':
      case '?':
        toggleGuide();
        break;
    }
  });
}

function toggleGuide(): void {
  const g = $('guide');
  g.hidden = !g.hidden;
}

function bindGuide(): void {
  $('guideBtn').onclick = toggleGuide;
  $('guideClose').onclick = toggleGuide;
  $('guide').addEventListener('pointerdown', (e) => {
    if (e.target === $('guide')) toggleGuide(); // backdrop click closes
  });
}

function togglePlay(): void {
  state.playing = !state.playing;
  $('playBtn').textContent = state.playing ? '❚❚' : '▶';
  $('playBtn').classList.toggle('active', state.playing);
}

/* ---------- resize / render loop ---------- */

function resize(): void {
  const rect = canvas.parentElement!.getBoundingClientRect();
  renderer.setPixelRatio(FULL_DPR);
  renderer.setSize(rect.width, rect.height, false);
  labelRenderer.setSize(rect.width, rect.height);
  sliceView.resize();
  volumeView.resize(rect.width / Math.max(rect.height, 1));
  volumeView.setResolution(rect.width, rect.height);
  markDirty();
}

let lastPlayTick = 0;
let lastOrbitRender = 0;
let lowRes = false;

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (state.playing && state.cube && now - lastPlayTick > 33) {
    lastPlayTick = now;
    const next = state.channel + 1 >= state.cube.nz ? 0 : state.channel + 1;
    void setChannel(next);
  }
  // engage the idle orbit after the configured quiet period
  if (
    idleOrbit.enabled &&
    !autoOrbiting &&
    state.cube &&
    state.mode === 'volume' &&
    !document.hidden &&
    now - lastActivity > idleOrbit.delaySec * 1000
  ) {
    autoOrbiting = true;
    volumeView.controls.autoRotate = true;
    // rotation advances per controls.update(); at the 30 fps orbit cadence
    // speed 1.0 ≈ one revolution every 2 minutes
    volumeView.controls.autoRotateSpeed = 1.0;
  }

  // Ambient orbit: full quality, fixed jitter, ~30 fps — crisp and cool-running.
  // controls.update() only on orbit frames so the rotation rate stays tied to
  // the render cadence instead of the display refresh rate.
  if (autoOrbiting) {
    if (now - lastOrbitRender >= 33) {
      lastOrbitRender = now;
      volumeView.update();
      dirty = true;
    }
  } else if (state.mode === 'volume') {
    volumeView.update(); // user-drag damping
  }

  if (!dirty && !interacting) return;
  dirty = false;

  if (state.mode === 'volume') {
    const wantLow = interacting;
    if (wantLow !== lowRes) {
      lowRes = wantLow;
      renderer.setPixelRatio(lowRes ? FULL_DPR * 0.55 : FULL_DPR);
    }
    volumeView.setQuality(interacting ? 0.4 : 1);
    // advancing jitter only helps when frames accumulate; during the orbit it
    // just animates the grain into a shimmer — keep it fixed there
    if (!autoOrbiting) volumeView.advanceJitter();
    renderer.render(volumeView.scene, volumeView.camera);
    labelRenderer.render(volumeView.scene, volumeView.camera);
  } else {
    if (lowRes) {
      lowRes = false;
      renderer.setPixelRatio(FULL_DPR);
    }
    renderer.render(sliceView.scene, sliceView.camera);
  }
  renderCount++;
}

setInterval(() => {
  $('fpsInfo').textContent = renderCount === 0 ? 'STBY' : `${renderCount} FPS`;
  renderCount = 0;
}, 1000);

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  toast('RENDERER LINK LOST — reload to re-establish', 'error', 60000);
});

/* ---------- boot sequence ---------- */

async function boot(): Promise<void> {
  const lines = $('bootLines');
  const shortGpu = GPU_NAME.replace(/ANGLE \(|\)|, .* Direct3D.*|Apple |AMD |Intel\(R\) /g, '').slice(0, 44);
  const rows = [
    ['V·CUBE NAVIGATION', ''],
    ['RENDER ENGINE', 'ONLINE'],
    [`GPU · ${shortGpu}`, 'LINKED'],
    [`TEX3D CEILING · ${MAX_3D}`, 'OK'],
    ['FITS PIPELINE', 'READY'],
    ['AWAITING TARGET', '...'],
  ];
  for (let i = 0; i < rows.length; i++) {
    const div = document.createElement('div');
    div.className = i === 0 ? 'title' : '';
    div.innerHTML = `${rows[i][0]}<span class="ok">${rows[i][1]}</span>`;
    lines.appendChild(div);
    await new Promise((r) => setTimeout(r, i === 0 ? 160 : 90));
  }
  await new Promise((r) => setTimeout(r, 280));
  $('boot').classList.add('done');
}

/* ---------- init ---------- */

$('gpuInfo').textContent =
  GPU_NAME.includes('Radeon') || GPU_NAME.includes('NVIDIA') || GPU_NAME.includes('Apple')
    ? 'GPU DISCRETE'
    : 'GPU INTEGRATED';
$('gpuInfo').dataset.tip = `WebGL renderer: ${GPU_NAME}`;
$('texInfo').textContent = `TEX3D ≤${MAX_3D}`;
$('playBtn').onclick = togglePlay;

initTooltips();
buildDisplayControls();
void buildSampleList();
bindFileInput();
bindScrubber();
bindKeys();
bindGuide();
bindStyleModal();
bindPlateModal();
bindIdleOrbit();
applyLiveCaptionStyle();
setMode('slice');
new ResizeObserver(resize).observe(canvas.parentElement!);
resize();
requestAnimationFrame(frame);
void boot();
