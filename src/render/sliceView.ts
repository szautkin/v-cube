// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Slice mode — one native-resolution channel plane on an orthographic quad.
 * The texture is R32F + NEAREST so every screen pixel is a true voxel value;
 * window/stretch/colormap run in-shader, so changing them is free. NaNs are
 * scrubbed to a large negative sentinel and rendered as the void color.
 */
import * as THREE from 'three';
import { STRETCH_GLSL } from './colormaps';

const NAN_SENTINEL = -1e30;

const VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uData;
uniform sampler2D uCmap;
uniform vec2 uRange;   // raw lo/hi of shared normalization
uniform vec2 uWindow;  // window within [0,1] normalized space
uniform int uStretch;
${STRETCH_GLSL}
void main() {
  float raw = texture(uData, vUv).r;
  if (raw < -1.0e29) { outColor = vec4(0.016, 0.027, 0.038, 1.0); return; } // NaN void
  float t = (raw - uRange.x) / (uRange.y - uRange.x);
  t = (t - uWindow.x) / max(uWindow.y - uWindow.x, 1.0e-6);
  float s = applyStretch(t, uStretch);
  outColor = vec4(texture(uCmap, vec2(s, 0.5)).rgb, 1.0);
}
`;

export interface SlicePointerInfo {
  px: number; // 0-based voxel x
  py: number;
  inside: boolean;
  clientX: number;
  clientY: number;
}

export class SliceView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  /** Both views share one canvas; only the active mode may consume input. */
  enabled = true;
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private texture: THREE.DataTexture | null = null;
  private scrubBuf: Float32Array | null = null; // reused across channel changes — scrubbing is the hot path
  private nx = 1;
  private ny = 1;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  onPointer: ((info: SlicePointerInfo) => void) | null = null;
  onClickVoxel: ((px: number, py: number) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    cmap: THREE.Texture,
  ) {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uData: { value: null },
        uCmap: { value: cmap },
        uRange: { value: new THREE.Vector2(0, 1) },
        uWindow: { value: new THREE.Vector2(0, 1) },
        uStretch: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.scene.add(this.mesh);
    this.bindInput();
  }

  setRange(lo: number, hi: number): void {
    (this.material.uniforms.uRange.value as THREE.Vector2).set(lo, hi);
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

  setCubeDims(nx: number, ny: number): void {
    this.nx = nx;
    this.ny = ny;
    this.mesh.scale.set(nx, ny, 1);
    this.fit();
  }

  /** Upload one channel plane, scrubbing NaN to the sentinel. */
  setPlane(plane: Float32Array): void {
    if (!this.scrubBuf || this.scrubBuf.length !== plane.length) {
      this.scrubBuf = new Float32Array(plane.length);
    }
    const scrubbed = this.scrubBuf;
    for (let i = 0; i < plane.length; i++) {
      const v = plane[i];
      scrubbed[i] = v === v ? v : NAN_SENTINEL;
    }
    if (this.texture && this.texture.image.width === this.nx && this.texture.image.height === this.ny) {
      (this.texture.image.data as Float32Array).set(scrubbed);
      this.texture.needsUpdate = true;
    } else {
      this.texture?.dispose();
      // The texture keeps its own copy so the scrub buffer stays reusable.
      this.texture = new THREE.DataTexture(scrubbed.slice(), this.nx, this.ny, THREE.RedFormat, THREE.FloatType);
      this.texture.minFilter = THREE.NearestFilter;
      this.texture.magFilter = THREE.NearestFilter;
      this.texture.needsUpdate = true;
      this.material.uniforms.uData.value = this.texture;
    }
  }

  fit(): void {
    const rect = this.canvas.getBoundingClientRect();
    const aspect = rect.width / Math.max(rect.height, 1);
    // zoom is the half-WIDTH; the whole image fits when it covers both the
    // data half-width and the data half-height scaled by the view aspect.
    this.zoom = Math.max(this.nx / 2, (this.ny / 2) * aspect) * 1.06;
    this.panX = 0;
    this.panY = 0;
    this.updateCamera();
  }

  resize(): void {
    this.updateCamera();
  }

  private updateCamera(): void {
    const rect = this.canvas.getBoundingClientRect();
    const aspect = rect.width / Math.max(rect.height, 1);
    this.camera.left = this.panX - this.zoom;
    this.camera.right = this.panX + this.zoom;
    this.camera.top = this.panY + this.zoom / aspect;
    this.camera.bottom = this.panY - this.zoom / aspect;
    this.camera.updateProjectionMatrix();
  }

  private clientToVoxel(e: PointerEvent | WheelEvent): {
    x: number;
    y: number;
    px: number;
    py: number;
    inside: boolean;
  } {
    const rect = this.canvas.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const x = this.camera.left + fx * (this.camera.right - this.camera.left);
    const y = this.camera.top + fy * (this.camera.bottom - this.camera.top);
    const px = Math.floor(x + this.nx / 2);
    const py = Math.floor(y + this.ny / 2);
    return { x, y, px, py, inside: px >= 0 && py >= 0 && px < this.nx && py < this.ny };
  }

  private bindInput(): void {
    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!this.enabled) return;
      dragging = false;
      if (moved < 4) {
        const v = this.clientToVoxel(e);
        if (v.inside) this.onClickVoxel?.(v.px, v.py);
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.enabled) return;
      if (dragging) {
        const rect = this.canvas.getBoundingClientRect();
        const dx = ((e.clientX - lastX) / rect.width) * (this.camera.right - this.camera.left);
        const dy = ((e.clientY - lastY) / rect.height) * (this.camera.top - this.camera.bottom);
        moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
        this.panX -= dx;
        this.panY += dy;
        lastX = e.clientX;
        lastY = e.clientY;
        this.updateCamera();
      }
      const v = this.clientToVoxel(e);
      this.onPointer?.({ px: v.px, py: v.py, inside: v.inside, clientX: e.clientX, clientY: e.clientY });
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.onPointer?.({ px: -1, py: -1, inside: false, clientX: 0, clientY: 0 });
    });
    this.canvas.addEventListener('pointercancel', () => {
      dragging = false;
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        const before = this.clientToVoxel(e);
        const factor = Math.exp(e.deltaY * 0.0015);
        this.zoom = Math.min(Math.max(this.zoom * factor, 2), Math.max(this.nx, this.ny) * 4);
        this.updateCamera();
        const after = this.clientToVoxel(e);
        this.panX += before.x - after.x;
        this.panY += before.y - after.y;
        this.updateCamera();
      },
      { passive: false },
    );
    this.canvas.addEventListener('dblclick', () => this.enabled && this.fit());
  }
}
