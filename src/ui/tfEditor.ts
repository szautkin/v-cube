// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Transfer-function editor — draggable opacity control points over the
 * active colormap gradient. Drag to move, double-click to add/remove.
 */
export class TfEditor {
  private ctx: CanvasRenderingContext2D;
  private points: Array<[number, number]> = [
    [0, 0],
    [0.18, 0.02],
    [0.55, 0.35],
    [1, 0.9],
  ];
  private dragPoint: [number, number] | null = null;
  private stops: string[] = ['#000', '#fff'];
  onChange: ((points: Array<[number, number]>) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.bind();
  }

  getPoints(): Array<[number, number]> {
    return this.points.map((p) => [...p] as [number, number]);
  }

  setPoints(points: Array<[number, number]>): void {
    this.points = points.map((p) => [...p] as [number, number]).sort((a, b) => a[0] - b[0]);
    this.draw();
  }

  setGradientStops(stops: string[]): void {
    this.stops = stops;
    this.draw();
  }

  private toLocal(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)),
    ];
  }

  private nearest(x: number, y: number): number {
    let best = -1;
    let bestD = 0.06;
    this.points.forEach(([px, py], i) => {
      const d = Math.hypot(px - x, (py - y) * 0.6);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  private bind(): void {
    // The dragged point is tracked by reference, not index — sorting the
    // points array during a drag must not transfer the drag to another point.
    this.canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = this.toLocal(e);
      const i = this.nearest(x, y);
      if (i >= 0) {
        this.dragPoint = this.points[i];
      } else {
        this.dragPoint = [x, y];
        this.points.push(this.dragPoint);
        this.points.sort((a, b) => a[0] - b[0]);
      }
      this.canvas.setPointerCapture(e.pointerId);
      this.emit();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const p = this.dragPoint;
      if (!p) return;
      const [x, y] = this.toLocal(e);
      const isEdge = p === this.points[0] || p === this.points[this.points.length - 1];
      if (!isEdge) p[0] = x;
      p[1] = y;
      this.points.sort((a, b) => a[0] - b[0]);
      this.emit();
    });
    const up = () => (this.dragPoint = null);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('dblclick', (e) => {
      const [x, y] = this.toLocal(e);
      const i = this.nearest(x, y);
      if (i > 0 && i < this.points.length - 1) {
        this.points.splice(i, 1);
        this.emit();
      }
    });
  }

  private emit(): void {
    this.draw();
    this.onChange?.(this.getPoints());
  }

  draw(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth * dpr;
    const h = this.canvas.clientHeight * dpr;
    if (w === 0) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const g = this.ctx;
    g.clearRect(0, 0, w, h);

    // colormap strip backdrop
    const grad = g.createLinearGradient(0, 0, w, 0);
    this.stops.forEach((c, i) => grad.addColorStop(i / Math.max(this.stops.length - 1, 1), c));
    g.globalAlpha = 0.35;
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;

    // opacity curve
    g.strokeStyle = '#ffb454';
    g.lineWidth = 1.5 * dpr;
    g.shadowColor = 'rgba(255,180,84,0.5)';
    g.shadowBlur = 4 * dpr;
    g.beginPath();
    this.points.forEach(([x, y], i) => {
      const cx = x * w;
      const cy = (1 - y) * h;
      if (i === 0) g.moveTo(cx, cy);
      else g.lineTo(cx, cy);
    });
    g.stroke();
    g.shadowBlur = 0;

    for (const [x, y] of this.points) {
      g.fillStyle = '#ffb454';
      g.beginPath();
      g.arc(x * w, (1 - y) * h, 3.5 * dpr, 0, Math.PI * 2);
      g.fill();
    }
  }
}
