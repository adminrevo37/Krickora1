/*
 * analytics.js — derives performance metrics + heatmaps from position frames.
 *
 * Fed one frame at a time (streaming, so it works for both live and replay).
 * Keeps per-player cumulative stats and a per-player dwell-time heat grid.
 */

const HEAT_CELL = 0.5; // metres per heat-grid cell

// Speed thresholds in m/s for movement zones / sprint detection.
const ZONES = [
  { key: 'walk', max: 2.0 },   // < 7.2 km/h
  { key: 'jog', max: 3.5 },    // < 12.6 km/h
  { key: 'run', max: 5.0 },    // < 18 km/h
  { key: 'sprint', max: Infinity },
];
const SPRINT_MS = 5.0;       // 18 km/h — rising edge counts as a sprint
const MOVE_EPS = 0.04;       // m/frame floor to reject positional jitter from drift

class Analytics {
  constructor(players) {
    this.gw = Math.ceil(COURT.length / HEAT_CELL);
    this.gh = Math.ceil(COURT.width / HEAT_CELL);
    this.players = players;
    this.byId = {};
    for (const p of players) {
      this.byId[p.id] = {
        id: p.id,
        last: null,           // {x,y,t}
        dist: 0,              // metres
        topSpeed: 0,          // m/s
        speed: 0,             // smoothed m/s (current)
        movingTime: 0,        // s spent above walk floor (for avg)
        movingDist: 0,        // m while moving (for avg speed)
        sprints: 0,
        wasSprinting: false,
        zoneTime: { walk: 0, jog: 0, run: 0, sprint: 0 },
        heat: new Float32Array(this.gw * this.gh),
      };
    }
    this.maxHeat = 1e-6; // running max cell value across all players (for scaling)
  }

  reset() {
    for (const id in this.byId) {
      const s = this.byId[id];
      s.last = null; s.dist = 0; s.topSpeed = 0; s.speed = 0;
      s.movingTime = 0; s.movingDist = 0; s.sprints = 0; s.wasSprinting = false;
      s.zoneTime = { walk: 0, jog: 0, run: 0, sprint: 0 };
      s.heat.fill(0);
    }
    this.maxHeat = 1e-6;
  }

  cellIndex(x, y) {
    let gx = Math.floor(x / HEAT_CELL);
    let gy = Math.floor(y / HEAT_CELL);
    gx = Math.min(this.gw - 1, Math.max(0, gx));
    gy = Math.min(this.gh - 1, Math.max(0, gy));
    return gy * this.gw + gx;
  }

  // frame: { t (s), players: [{id, x, y}] }
  ingest(frame) {
    for (const fp of frame.players) {
      const s = this.byId[fp.id];
      if (!s) continue;
      if (s.last) {
        const dt = Math.max(1e-3, frame.t - s.last.t);
        const dx = fp.x - s.last.x, dy = fp.y - s.last.y;
        const step = Math.hypot(dx, dy);
        const rawSpeed = step / dt;
        // smooth speed a touch to mimic a real tracker's filtered output
        s.speed = s.speed * 0.6 + rawSpeed * 0.4;

        if (step > MOVE_EPS) {
          s.dist += step;
          s.movingTime += dt;
          s.movingDist += step;
        }
        if (s.speed > s.topSpeed) s.topSpeed = s.speed;

        // zone time
        const zone = ZONES.find(z => s.speed < z.max).key;
        s.zoneTime[zone] += dt;

        // sprint rising-edge
        const sprinting = s.speed >= SPRINT_MS;
        if (sprinting && !s.wasSprinting) s.sprints++;
        s.wasSprinting = sprinting;

        // heat dwell (weighted by dt so sim-speed independent)
        const ci = this.cellIndex(fp.x, fp.y);
        s.heat[ci] += dt;
        if (s.heat[ci] > this.maxHeat) this.maxHeat = s.heat[ci];
      }
      s.last = { x: fp.x, y: fp.y, t: frame.t };
    }
  }

  stat(id) { return this.byId[id]; }

  // Combined heat grid for a set of player ids (Float32Array).
  combinedHeat(ids) {
    const out = new Float32Array(this.gw * this.gh);
    let max = 1e-6;
    for (const id of ids) {
      const h = this.byId[id]?.heat;
      if (!h) continue;
      for (let i = 0; i < out.length; i++) {
        out[i] += h[i];
        if (out[i] > max) max = out[i];
      }
    }
    return { grid: out, max, gw: this.gw, gh: this.gh };
  }
}

// km/h helper
const KMH = ms => ms * 3.6;

window.Analytics = Analytics;
window.KMH = KMH;
window.HEAT_CELL = HEAT_CELL;
