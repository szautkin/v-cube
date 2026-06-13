// SPDX-License-Identifier: AGPL-3.0-or-later
/** Probe spectrum strip — flux vs channel for the pinned voxel, HUD-styled. */
export class SpectrumPlot {
  private ctx: CanvasRenderingContext2D;
  private data: Float32Array | null = null;
  private channel = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setSpectrum(data: Float32Array | null): void {
    this.data = data;
    this.draw();
  }

  setChannel(c: number): void {
    this.channel = c;
    this.draw();
  }

  private draw(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth * dpr;
    const h = this.canvas.clientHeight * dpr;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const g = this.ctx;
    g.clearRect(0, 0, w, h);

    if (!this.data || this.data.length < 2) {
      g.fillStyle = 'rgba(107,138,156,0.6)';
      g.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
      g.textAlign = 'center';
      g.fillText(this.data === null ? 'NO PROBE' : 'NO SIGNAL', w / 2, h / 2);
      return;
    }

    let lo = Infinity;
    let hi = -Infinity;
    for (const v of this.data) {
      if (v !== v) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!(hi > lo)) return;
    const pad = 4 * dpr;
    const sy = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
    const sx = (i: number) => (i / (this.data!.length - 1)) * w;

    // zero line
    if (lo < 0 && hi > 0) {
      g.strokeStyle = 'rgba(107,138,156,0.25)';
      g.beginPath();
      g.moveTo(0, sy(0));
      g.lineTo(w, sy(0));
      g.stroke();
    }

    // trace with glow
    g.lineWidth = 1 * dpr;
    g.strokeStyle = '#56c8ff';
    g.shadowColor = 'rgba(86,200,255,0.6)';
    g.shadowBlur = 4 * dpr;
    g.beginPath();
    let started = false;
    for (let i = 0; i < this.data.length; i++) {
      const v = this.data[i];
      if (v !== v) {
        started = false;
        continue;
      }
      if (!started) {
        g.moveTo(sx(i), sy(v));
        started = true;
      } else g.lineTo(sx(i), sy(v));
    }
    g.stroke();
    g.shadowBlur = 0;

    // current channel cursor
    g.strokeStyle = '#ffb454';
    g.beginPath();
    g.moveTo(sx(this.channel), 0);
    g.lineTo(sx(this.channel), h);
    g.stroke();
  }
}
