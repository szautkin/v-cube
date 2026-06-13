// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Serhii Zautkin and v-cube contributors
/**
 * Volume mode — front-to-back raymarching of the half-float 3D texture with
 * early ray termination, jittered starts (kills banding), composite and MIP
 * modes, and a transfer-function texture. Spectral axis scale is a free
 * parameter: spatial and spectral units are not commensurate, so the box
 * aspect is spatial-true and the user stretches the spectral axis.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { STRETCH_GLSL } from './colormaps';
import type { VolumeData } from '../data/cubeModel';

const VERT = /* glsl */ `
out vec3 vOrigin;
out vec3 vDirection;
void main() {
  vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  vDirection = position - vOrigin;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec3 vOrigin;
in vec3 vDirection;
out vec4 outColor;
uniform sampler3D uData;
uniform sampler2D uCmap;
uniform sampler2D uTF;
uniform float uSteps;
uniform float uDensity;
uniform vec2 uWindow;
uniform int uStretch;
uniform int uMip;
uniform float uJitter;
${STRETCH_GLSL}

vec2 hitBox(vec3 orig, vec3 dir) {
  const vec3 boxMin = vec3(-0.5);
  const vec3 boxMax = vec3(0.5);
  vec3 inv = 1.0 / dir;
  vec3 t0 = (boxMin - orig) * inv;
  vec3 t1 = (boxMax - orig) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 dir = normalize(vDirection);
  vec2 bounds = hitBox(vOrigin, dir);
  bounds.x = max(bounds.x, 0.0);
  if (bounds.x >= bounds.y) discard;

  float span = bounds.y - bounds.x;
  float dt = 1.7320508 / uSteps; // unit-cube diagonal / steps
  float t = bounds.x + dt * (hash(gl_FragCoord.xy + uJitter) - 0.5 + 0.5);

  vec3 acc = vec3(0.0);
  float alpha = 0.0;
  float mip = 0.0;

  for (int i = 0; i < 1024; i++) {
    if (t > bounds.y || alpha > 0.98) break;
    if (float(i) >= uSteps * 1.7320508) break;
    vec3 p = vOrigin + dir * t + 0.5;
    float r = texture(uData, p).r;
    if (r > 0.0) {
      float v = (r - uWindow.x) / max(uWindow.y - uWindow.x, 1.0e-6);
      float s = applyStretch(v, uStretch);
      if (uMip == 1) {
        mip = max(mip, s);
      } else {
        vec4 tf = texture(uTF, vec2(s, 0.5));
        float a = clamp(tf.a * uDensity * dt * 60.0, 0.0, 1.0);
        vec3 c = texture(uCmap, vec2(s, 0.5)).rgb;
        acc += (1.0 - alpha) * a * c;
        alpha += (1.0 - alpha) * a;
      }
    }
    t += dt;
  }

  if (uMip == 1) {
    if (mip <= 0.003) discard;
    outColor = vec4(texture(uCmap, vec2(mip, 0.5)).rgb, smoothstep(0.0, 0.25, mip));
    return;
  }
  if (alpha <= 0.003) discard;
  outColor = vec4(acc, alpha);
}
`;

export class VolumeView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Both views share one canvas; only the active mode may consume input. */
  enabled = false;
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private box: LineSegments2;
  private boxMat: LineMaterial;
  private planeEdgeMat: LineMaterial;
  private slicePlane: THREE.Mesh;
  private texture: THREE.Data3DTexture | null = null;
  private tfTexture: THREE.DataTexture;
  private captions: CSS2DObject[] = [];
  private volume: VolumeData | null = null;
  private spectralScale = 1.5;
  private baseSteps = 384;
  onInteract: (() => void) | null = null;
  onPickChannel: ((channel: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, cmap: THREE.Texture) {
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
    this.camera.position.set(1.6, 1.1, 1.9);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 8;
    this.controls.addEventListener('change', () => this.onInteract?.());

    this.tfTexture = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tfTexture.minFilter = THREE.LinearFilter;
    this.tfTexture.magFilter = THREE.LinearFilter;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide, // render back faces so we can fly close/inside
      uniforms: {
        uData: { value: null },
        uCmap: { value: cmap },
        uTF: { value: this.tfTexture },
        uSteps: { value: this.baseSteps },
        uDensity: { value: 1.0 },
        uWindow: { value: new THREE.Vector2(0, 1) },
        uStretch: { value: 0 },
        uMip: { value: 0 },
        uJitter: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.scene.add(this.mesh);

    // Fat-line materials: WebGL ignores lineWidth on basic lines, so edge
    // thickness control needs screen-space line quads (LineSegments2).
    this.boxMat = new LineMaterial({ color: 0x2a6f8f, linewidth: 1, transparent: true, opacity: 0.55 });
    this.box = new LineSegments2(
      new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))),
      this.boxMat,
    );
    this.mesh.add(this.box);

    this.slicePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x56c8ff,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.planeEdgeMat = new LineMaterial({ color: 0x56c8ff, linewidth: 1, transparent: true, opacity: 0.7 });
    const planeEdges = new LineSegments2(
      new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1))),
      this.planeEdgeMat,
    );
    this.slicePlane.add(planeEdges);
    this.mesh.add(this.slicePlane);

    this.bindPick(canvas);
  }

  /**
   * Axis captions as CSS2D labels — real DOM text, so they render at native
   * font quality and inherit the cockpit typography. Positions are in unit-box
   * coordinates (±0.5 faces) and inherit the mesh's aspect scaling.
   */
  setAxisCaptions(items: Array<{ text: string; pos: [number, number, number]; cls: string }>): void {
    for (const c of this.captions) {
      c.element.remove();
      this.mesh.remove(c);
    }
    this.captions = [];
    for (const it of items) {
      const el = document.createElement('div');
      el.className = it.cls;
      el.textContent = it.text;
      const obj = new CSS2DObject(el);
      obj.position.set(it.pos[0], it.pos[1], it.pos[2]);
      this.mesh.add(obj);
      this.captions.push(obj);
    }
  }

  /** Caption positions projected to CSS pixels for export burn-in. */
  captionScreenPositions(width: number, height: number): Array<{ text: string; cls: string; x: number; y: number }> {
    this.mesh.updateWorldMatrix(true, false);
    const v = new THREE.Vector3();
    const out: Array<{ text: string; cls: string; x: number; y: number }> = [];
    for (const c of this.captions) {
      v.copy(c.position).applyMatrix4(this.mesh.matrixWorld).project(this.camera);
      if (v.z > 1) continue; // behind the camera
      out.push({
        text: c.element.textContent ?? '',
        cls: c.element.className,
        x: (v.x * 0.5 + 0.5) * width,
        y: (-v.y * 0.5 + 0.5) * height,
      });
    }
    return out;
  }

  setVolume(volume: VolumeData): void {
    this.volume = volume;
    this.texture?.dispose();
    const tex = new THREE.Data3DTexture(volume.data, volume.nx, volume.ny, volume.nz);
    tex.format = THREE.RedFormat;
    tex.type = THREE.HalfFloatType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.texture = tex;
    this.material.uniforms.uData.value = tex;
    this.applyAspect();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  setSpectralScale(s: number): void {
    this.spectralScale = s;
    this.applyAspect();
  }

  private applyAspect(): void {
    if (!this.volume) return;
    const { nx, ny } = this.volume;
    const m = Math.max(nx, ny);
    this.mesh.scale.set(nx / m, ny / m, this.spectralScale);
  }

  setSliceChannel(frac: number): void {
    this.slicePlane.position.z = frac - 0.5;
  }

  setSlicePlaneVisible(v: boolean): void {
    this.slicePlane.visible = v;
  }

  setWindow(lo: number, hi: number): void {
    (this.material.uniforms.uWindow.value as THREE.Vector2).set(lo, hi);
  }

  setStretch(i: number): void {
    this.material.uniforms.uStretch.value = i;
  }

  setColormap(tex: THREE.Texture): void {
    this.material.uniforms.uCmap.value = tex;
  }

  setDensity(d: number): void {
    this.material.uniforms.uDensity.value = d;
  }

  setMip(on: boolean): void {
    this.material.uniforms.uMip.value = on ? 1 : 0;
  }

  setBaseSteps(n: number): void {
    this.baseSteps = n;
  }

  /** quality ∈ (0,1]; interaction drops it, idle restores 1. */
  setQuality(q: number): void {
    this.material.uniforms.uSteps.value = Math.max(48, Math.round(this.baseSteps * q));
  }

  advanceJitter(): void {
    this.material.uniforms.uJitter.value = (this.material.uniforms.uJitter.value + 17.13) % 1024;
  }

  /** Opacity curve points [(x ∈ [0,1], a ∈ [0,1]), ...] → 256-entry TF texture. */
  setTransferFunction(points: Array<[number, number]>): void {
    const data = this.tfTexture.image.data as Uint8Array;
    const pts = [...points].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let a = pts[0][1];
      if (x >= pts[pts.length - 1][0]) a = pts[pts.length - 1][1];
      else {
        for (let k = 0; k < pts.length - 1; k++) {
          if (x >= pts[k][0] && x < pts[k + 1][0]) {
            const f = (x - pts[k][0]) / Math.max(pts[k + 1][0] - pts[k][0], 1e-6);
            a = pts[k][1] * (1 - f) + pts[k + 1][1] * f;
            break;
          }
        }
      }
      data[i * 4 + 3] = Math.round(a * 255);
    }
    this.tfTexture.needsUpdate = true;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** LineMaterial needs the viewport size (CSS px) to rasterize px-true widths. */
  setResolution(w: number, h: number): void {
    this.boxMat.resolution.set(w, h);
    this.planeEdgeMat.resolution.set(w, h);
  }

  /** Edge styling — accent override (null = classic cockpit colors) + width in px. */
  setEdgeStyle(accent: string | null, width: number): void {
    this.boxMat.color.set(accent ?? '#2a6f8f');
    this.planeEdgeMat.color.set(accent ?? '#56c8ff');
    this.boxMat.linewidth = width;
    this.planeEdgeMat.linewidth = width;
  }

  update(): void {
    this.controls.update();
  }

  /** Click → march the CPU copy of the volume along the view ray, jump to the brightest channel. */
  private bindPick(canvas: HTMLCanvasElement): void {
    let downX = 0;
    let downY = 0;
    canvas.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.enabled || Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4 || !this.volume) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const inv = this.mesh.matrixWorld.clone().invert();
      const o = ray.ray.origin.clone().applyMatrix4(inv);
      const d = ray.ray.direction.clone().transformDirection(inv).normalize();
      const t = rayBox(o, d);
      if (!t) return;
      const { nx, ny, nz, data } = this.volume;
      let best = 0;
      let bestZ = -1;
      const steps = 512;
      for (let i = 0; i <= steps; i++) {
        const tt = t[0] + ((t[1] - t[0]) * i) / steps;
        const px = Math.floor((o.x + d.x * tt + 0.5) * nx);
        const py = Math.floor((o.y + d.y * tt + 0.5) * ny);
        const pz = Math.floor((o.z + d.z * tt + 0.5) * nz);
        if (px < 0 || py < 0 || pz < 0 || px >= nx || py >= ny || pz >= nz) continue;
        const v = data[pz * nx * ny + py * nx + px];
        if (v > best) {
          best = v;
          bestZ = pz;
        }
      }
      if (bestZ >= 0) this.onPickChannel?.(Math.min((bestZ + 0.5) * this.volume.binZ, Number.MAX_SAFE_INTEGER));
    });
  }
}

function rayBox(o: THREE.Vector3, d: THREE.Vector3): [number, number] | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const ax of ['x', 'y', 'z'] as const) {
    const inv = 1 / d[ax];
    let t0 = (-0.5 - o[ax]) * inv;
    let t1 = (0.5 - o[ax]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
  }
  if (tmax < Math.max(tmin, 0)) return null;
  return [Math.max(tmin, 0), tmax];
}
