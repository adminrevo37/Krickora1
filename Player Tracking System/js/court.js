/*
 * court.js — Floorball court geometry + canvas renderer.
 *
 * Coordinate system (metres):
 *   origin (0,0) = bottom-left corner of the playing area.
 *   x axis = length 0..40 (left goal -> right goal)
 *   y axis = width  0..20
 * Markings approximate IFF rules (40x20m rink). They are for visual
 * orientation, not officiating.
 */

const COURT = Object.freeze({
  length: 40,        // metres (x)
  width: 20,         // metres (y)
  goalLineInset: 3.5,// goal cage distance from short end
  goalWidth: 1.6,    // cage mouth (y)
  goalDepth: 1.15,   // cage depth (x)
  creaseW: 1.0,      // goal crease depth (x)
  creaseH: 2.5,      // goal crease (y)
  areaW: 4.0,        // goal area depth (x)
  areaH: 5.0,        // goal area (y)
  cornerR: 1.5,      // rounded rink corners
});

class CourtRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = 28;            // px padding around the court inside the canvas
    this.scale = 1;           // px per metre
    this.ox = 0; this.oy = 0; // canvas px of court origin (metre 0,0)
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.resize();
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.cssW = cssW; this.cssH = cssH;

    const availW = cssW - this.pad * 2;
    const availH = cssH - this.pad * 2;
    this.scale = Math.min(availW / COURT.length, availH / COURT.width);
    const courtPxW = COURT.length * this.scale;
    const courtPxH = COURT.width * this.scale;
    this.ox = (cssW - courtPxW) / 2;
    // y flipped: metre y=0 (bottom) maps to larger canvas y
    this.oy = (cssH - courtPxH) / 2;
  }

  // metre -> canvas px (y flipped so 0 is at the bottom)
  mx(x) { return this.ox + x * this.scale; }
  my(y) { return this.oy + (COURT.width - y) * this.scale; }
  ms(m) { return m * this.scale; }

  // canvas css px -> metre (for click/scrub interactions)
  toMetres(px, py) {
    return {
      x: (px - this.ox) / this.scale,
      y: COURT.width - (py - this.oy) / this.scale,
    };
  }

  clear() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
  }

  drawCourt() {
    const ctx = this.ctx;
    const { length: L, width: W } = COURT;

    // Surface
    ctx.fillStyle = '#0e2a3f';
    this._roundRect(this.mx(0), this.my(W), this.ms(L), this.ms(W), this.ms(COURT.cornerR));
    ctx.fill();

    ctx.lineWidth = Math.max(1.5, this.ms(0.08));
    ctx.strokeStyle = 'rgba(220,235,255,0.75)';
    ctx.lineJoin = 'round';

    // Boundary (rounded)
    this._roundRect(this.mx(0), this.my(W), this.ms(L), this.ms(W), this.ms(COURT.cornerR));
    ctx.stroke();

    // Centre line
    ctx.beginPath();
    ctx.moveTo(this.mx(L / 2), this.my(0));
    ctx.lineTo(this.mx(L / 2), this.my(W));
    ctx.stroke();

    // Centre spot
    this._spot(L / 2, W / 2, 0.18);

    // Both ends
    this._drawEnd(false); // left
    this._drawEnd(true);  // right

    // Free-hit / corner dots (approx 1.5m off boards)
    const d = 1.5;
    [[d, d], [d, W - d], [L - d, d], [L - d, W - d]].forEach(([x, y]) => this._spot(x, y, 0.12));
  }

  _drawEnd(right) {
    const { length: L, width: W } = COURT;
    const cy = W / 2;
    const gl = right ? L - COURT.goalLineInset : COURT.goalLineInset;
    const dir = right ? -1 : 1; // toward centre

    // Goal area (large box)
    this._boxFromLine(gl, dir, COURT.areaW, COURT.areaH, cy, 'rgba(120,200,255,0.06)');
    // Goal crease (small box)
    this._boxFromLine(gl, dir, COURT.creaseW, COURT.creaseH, cy, 'rgba(120,200,255,0.10)');

    // Goal cage (behind the line, toward the end)
    const ctx = this.ctx;
    const cageBackX = gl - dir * COURT.goalDepth;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(1.5, this.ms(0.06));
    ctx.beginPath();
    ctx.moveTo(this.mx(gl), this.my(cy - COURT.goalWidth / 2));
    ctx.lineTo(this.mx(cageBackX), this.my(cy - COURT.goalWidth / 2));
    ctx.lineTo(this.mx(cageBackX), this.my(cy + COURT.goalWidth / 2));
    ctx.lineTo(this.mx(gl), this.my(cy + COURT.goalWidth / 2));
    ctx.stroke();
    ctx.restore();
  }

  _boxFromLine(lineX, dir, depth, height, cy, fill) {
    const ctx = this.ctx;
    const x0 = lineX;
    const x1 = lineX + dir * depth;
    const y0 = cy - height / 2;
    const y1 = cy + height / 2;
    const left = Math.min(this.mx(x0), this.mx(x1));
    const top = this.my(y1);
    ctx.fillStyle = fill;
    ctx.fillRect(left, top, Math.abs(this.mx(x1) - this.mx(x0)), this.ms(height));
    ctx.strokeStyle = 'rgba(220,235,255,0.55)';
    ctx.lineWidth = Math.max(1, this.ms(0.05));
    ctx.strokeRect(left, top, Math.abs(this.mx(x1) - this.mx(x0)), this.ms(height));
  }

  _spot(x, y, r) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(220,235,255,0.75)';
    ctx.beginPath();
    ctx.arc(this.mx(x), this.my(y), Math.max(1.5, this.ms(r)), 0, Math.PI * 2);
    ctx.fill();
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

window.COURT = COURT;
window.CourtRenderer = CourtRenderer;
