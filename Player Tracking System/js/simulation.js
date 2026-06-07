/*
 * simulation.js — synthetic floorball match generator.
 *
 * WHY THIS EXISTS: there's no hardware yet, so this stands in for the real
 * UWB feed. It emits the SAME frame shape the real pipeline will
 * ({ t, ball, players:[{id,x,y}] }), so swapping in live data later is a
 * drop-in change (see README "Data format"). Movement uses simple steering
 * (home-zone + ball attraction + wander) which produces realistic clustering,
 * sprints and heatmaps without scripting every play.
 */

const TEAM_COLORS = { A: '#3b82f6', B: '#f97316' };

const NAME_POOL = [
  'Lind', 'Berg', 'Holm', 'Sand', 'Kallio', 'Niemi', 'Virtanen', 'Korhonen',
  'Eriksson', 'Karlsson', 'Nyman', 'Aalto', 'Laine', 'Mäki', 'Heikkilä', 'Lehto',
  'Saari', 'Koski', 'Rinne', 'Salo', 'Hill', 'Frost', 'Vega', 'Cole',
];

// Role layout for the team attacking toward +x. (x,y in metres, GK first.)
const ROLE_LAYOUT = [
  { role: 'GK',  x: 4,  y: 10, bias: 0.05, maxSpeed: 3.5 },
  { role: 'DEF', x: 12, y: 6,  bias: 0.45, maxSpeed: 6.0 },
  { role: 'DEF', x: 12, y: 14, bias: 0.45, maxSpeed: 6.0 },
  { role: 'CEN', x: 20, y: 10, bias: 0.78, maxSpeed: 6.6 },
  { role: 'FWD', x: 28, y: 6,  bias: 0.85, maxSpeed: 6.9 },
  { role: 'FWD', x: 28, y: 14, bias: 0.85, maxSpeed: 6.9 },
];

function makeSerial(i) {
  // Stable, human-readable-ish wearable serials (matches the "register a serial" flow).
  const n = (0xA1B2 + i * 2654435761) >>> 0;
  return 'RV-' + n.toString(16).toUpperCase().slice(0, 6).padStart(6, '0');
}

function buildRoster(teamAName = 'Falcons', teamBName = 'Rovers') {
  const players = [];
  let nameI = 0;
  const teams = [
    { team: 'A', name: teamAName, attackRight: true },
    { team: 'B', name: teamBName, attackRight: false },
  ];
  let idx = 0;
  for (const t of teams) {
    ROLE_LAYOUT.forEach((slot, i) => {
      const homeX = t.attackRight ? slot.x : COURT.length - slot.x;
      players.push({
        id: `${t.team}${i + 1}`,
        team: t.team,
        teamName: t.name,
        number: i === 0 ? 1 : i + 4, // GK #1, others #5..
        name: NAME_POOL[(nameI++) % NAME_POOL.length],
        role: slot.role,
        color: TEAM_COLORS[t.team],
        serial: makeSerial(idx++),
        // sim-internal:
        homeX, homeY: slot.y,
        bias: slot.bias,
        maxSpeed: slot.maxSpeed,
        x: homeX, y: slot.y, vx: 0, vy: 0,
        wPhase: Math.random() * Math.PI * 2,
        wFreq: 0.3 + Math.random() * 0.5,
        attackRight: t.attackRight,
      });
    });
  }
  return players;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

class SimulationSource {
  constructor(players) {
    this.players = players;
    this.t = 0;
    // ball
    this.ball = { x: COURT.length / 2, y: COURT.width / 2, tx: COURT.length / 2, ty: COURT.width / 2 };
    this.ballSpeed = 9;       // m/s while travelling
    this.ballRepick = 0;      // s until next ball target
  }

  reset() {
    this.t = 0;
    for (const p of this.players) {
      p.x = p.homeX; p.y = p.homeY; p.vx = 0; p.vy = 0;
    }
    this.ball.x = COURT.length / 2; this.ball.y = COURT.width / 2;
    this.ball.tx = this.ball.x; this.ball.ty = this.ball.y;
    this.ballRepick = 0;
  }

  _stepBall(dt) {
    this.ballRepick -= dt;
    if (this.ballRepick <= 0) {
      // New ball target: mostly mid/attacking thirds, sometimes a shot at a goal.
      const shot = Math.random() < 0.18;
      if (shot) {
        this.ball.tx = Math.random() < 0.5 ? COURT.goalLineInset : COURT.length - COURT.goalLineInset;
        this.ball.ty = COURT.width / 2 + (Math.random() - 0.5) * 4;
        this.ballRepick = 0.6 + Math.random() * 0.6;
      } else {
        this.ball.tx = 4 + Math.random() * (COURT.length - 8);
        this.ball.ty = 2 + Math.random() * (COURT.width - 4);
        this.ballRepick = 0.8 + Math.random() * 1.6;
      }
    }
    const dx = this.ball.tx - this.ball.x, dy = this.ball.ty - this.ball.y;
    const d = Math.hypot(dx, dy) || 1;
    const step = Math.min(d, this.ballSpeed * dt);
    this.ball.x = clamp(this.ball.x + (dx / d) * step, 0.3, COURT.length - 0.3);
    this.ball.y = clamp(this.ball.y + (dy / d) * step, 0.3, COURT.width - 0.3);
  }

  _stepPlayer(p, dt) {
    if (p.role === 'GK') {
      // Hug the goal line, slide on y to track the ball.
      const targetY = clamp(COURT.width / 2 + (this.ball.y - COURT.width / 2) * 0.6, 8, 12);
      const targetX = p.homeX + (this.ball.x - p.homeX) * 0.02;
      this._accelTo(p, targetX, targetY, dt, p.maxSpeed);
      return;
    }
    // Wander offset (slowly varying) so players don't track the ball robotically.
    const wob = Math.sin(this.t * p.wFreq + p.wPhase);
    const wob2 = Math.cos(this.t * (p.wFreq * 0.7) + p.wPhase * 1.3);
    const wanderX = wob * 3.0;
    const wanderY = wob2 * 3.0;

    // Blend home zone and ball, plus an attacking shift toward the ball's half.
    const tx = p.homeX * (1 - p.bias) + this.ball.x * p.bias + wanderX;
    const ty = p.homeY * (1 - p.bias) + this.ball.y * p.bias + wanderY;
    this._accelTo(p, tx, ty, dt, p.maxSpeed);
  }

  _accelTo(p, tx, ty, dt, maxSpeed) {
    const maxAccel = 9; // m/s^2
    const dx = tx - p.x, dy = ty - p.y;
    const dist = Math.hypot(dx, dy) || 1e-6;
    // Desired speed eases off as we approach the target (avoids jitter).
    const desiredSpeed = maxSpeed * clamp(dist / 3, 0, 1);
    const dvx = (dx / dist) * desiredSpeed - p.vx;
    const dvy = (dy / dist) * desiredSpeed - p.vy;
    const dvm = Math.hypot(dvx, dvy) || 1e-6;
    const accel = Math.min(dvm, maxAccel * dt);
    p.vx += (dvx / dvm) * accel;
    p.vy += (dvy / dvm) * accel;
    // clamp speed
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > maxSpeed) { p.vx = (p.vx / sp) * maxSpeed; p.vy = (p.vy / sp) * maxSpeed; }
    p.x = clamp(p.x + p.vx * dt, 0.3, COURT.length - 0.3);
    p.y = clamp(p.y + p.vy * dt, 0.3, COURT.width - 0.3);
  }

  // Advance the world by dt seconds and emit a frame.
  step(dt) {
    this.t += dt;
    this._stepBall(dt);
    for (const p of this.players) this._stepPlayer(p, dt);
    return {
      t: this.t,
      ball: { x: this.ball.x, y: this.ball.y },
      players: this.players.map(p => ({ id: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3) })),
    };
  }
}

window.buildRoster = buildRoster;
window.SimulationSource = SimulationSource;
window.TEAM_COLORS = TEAM_COLORS;
