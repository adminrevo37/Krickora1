/*
 * app.js — UI controller: render loop, playback/scrub, view modes,
 * roster + stats panels, load/export. Ties court + simulation + analytics.
 */

const SIM_HZ = 20;
const STEP = 1 / SIM_HZ;          // fixed sim timestep (s)
const MAX_FRAMES = 18000;         // ~15 min recording cap at 20 Hz
const TRAIL_SECONDS = 4;
const TRAIL_FRAMES = Math.round(TRAIL_SECONDS * SIM_HZ);

const App = {
  players: [],
  source: null,        // SimulationSource, or null when replaying a loaded file
  analytics: null,
  history: [],         // recorded frames
  meta: { venue: 'Portable Kit · Demo Court', teamA: 'Falcons', teamB: 'Rovers' },

  // playback state
  playing: true,
  isLive: true,        // follow newest frame (sim only)
  currentIndex: 0,
  playT: 0,            // seconds, for loaded-file replay
  simSpeed: 1,
  acc: 0,
  lastNow: 0,

  // view state
  viewMode: 'dots',
  focusId: null,
  hidden: new Set(),
  teamFilter: 'all',
  showBall: true,
  showNumbers: true,
  sort: { key: 'dist', dir: -1 },

  init() {
    this.canvas = document.getElementById('court');
    this.renderer = new CourtRenderer(this.canvas);
    this.heatCanvas = document.createElement('canvas');

    this.startSimulation();
    this.cacheEls();
    this.bindUI();
    this.buildTeamSelect();
    this.buildRoster();

    new ResizeObserver(() => this.renderer.resize()).observe(this.canvas.parentElement);
    this.lastNow = performance.now();
    requestAnimationFrame(this.loop.bind(this));
  },

  startSimulation() {
    this.players = buildRoster(this.meta.teamA, this.meta.teamB);
    this.source = new SimulationSource(this.players);
    this.analytics = new Analytics(this.players);
    this.history = [];
    this.currentIndex = 0;
    this.isLive = true; this.playing = true;
    // Seed a few seconds so the first view isn't empty.
    for (let i = 0; i < SIM_HZ * 2; i++) this.pushFrame(this.source.step(STEP));
  },

  pushFrame(frame) {
    this.analytics.ingest(frame);
    this.history.push(frame);
    if (this.history.length > MAX_FRAMES) {
      this.history.shift();
      if (!this.isLive && this.currentIndex > 0) this.currentIndex--;
    }
    if (this.isLive) this.currentIndex = this.history.length - 1;
  },

  cacheEls() {
    this.el = {
      source: document.getElementById('sourceChip'),
      venue: document.getElementById('venueChip'),
      clock: document.getElementById('clockChip'),
      roster: document.getElementById('roster'),
      statsBody: document.querySelector('#statsTable tbody'),
      focusCards: document.getElementById('focusCards'),
      scrub: document.getElementById('scrub'),
      timeLabel: document.getElementById('timeLabel'),
      playBtn: document.getElementById('playBtn'),
      liveBtn: document.getElementById('liveBtn'),
      teamSelect: document.getElementById('teamSelect'),
      status: document.getElementById('statusText'),
    };
    this.el.venue.textContent = 'Venue: ' + this.meta.venue;
  },

  bindUI() {
    document.getElementById('viewModes').addEventListener('click', e => {
      const b = e.target.closest('.seg-btn'); if (!b) return;
      this.viewMode = b.dataset.mode;
      document.querySelectorAll('#viewModes .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    });
    document.getElementById('showBall').addEventListener('change', e => this.showBall = e.target.checked);
    document.getElementById('showNumbers').addEventListener('change', e => this.showNumbers = e.target.checked);
    document.getElementById('simSpeed').addEventListener('change', e => this.simSpeed = parseFloat(e.target.value));

    this.el.playBtn.addEventListener('click', () => {
      this.playing = !this.playing;
      this.el.playBtn.textContent = this.playing ? '⏸' : '▶';
    });
    this.el.liveBtn.addEventListener('click', () => this.goLive());
    this.el.scrub.addEventListener('input', e => {
      this.isLive = false;
      this.currentIndex = parseInt(e.target.value, 10);
      if (this.history[this.currentIndex]) this.playT = this.history[this.currentIndex].t;
      this.updateLiveBtn();
    });
    this.el.teamSelect.addEventListener('change', e => {
      this.teamFilter = e.target.value;
      this.focusId = null;
      this.buildRoster();
    });

    document.querySelectorAll('#statsTable th').forEach((th, i) => {
      const keys = [null, null, 'dist', 'top', 'avg', 'sprints'];
      if (!keys[i]) return;
      th.addEventListener('click', () => {
        const k = keys[i];
        this.sort.dir = this.sort.key === k ? -this.sort.dir : -1;
        this.sort.key = k;
      });
    });

    // Click on court to focus nearest player.
    this.canvas.addEventListener('click', e => this.pickPlayer(e));

    // Load / export
    const file = document.getElementById('loadFile');
    document.getElementById('loadBtn').addEventListener('click', () => file.click());
    file.addEventListener('change', e => this.loadFile(e.target.files[0]));
    document.getElementById('exportBtn').addEventListener('click', () => this.exportSession());
  },

  buildTeamSelect() {
    const teams = [...new Set(this.players.map(p => p.team))];
    const names = { A: this.meta.teamA, B: this.meta.teamB };
    this.el.teamSelect.innerHTML =
      `<option value="all">All players</option>` +
      teams.map(t => `<option value="${t}">${names[t] || 'Team ' + t}</option>`).join('');
    this.el.teamSelect.value = this.teamFilter;
  },

  visiblePlayers() {
    return this.players.filter(p =>
      (this.teamFilter === 'all' || p.team === this.teamFilter) && !this.hidden.has(p.id));
  },

  heatTargets() {
    return this.focusId ? [this.focusId] : this.visiblePlayers().map(p => p.id);
  },

  goLive() {
    if (!this.source) return; // no live for loaded files
    this.isLive = true;
    this.playing = true;
    this.el.playBtn.textContent = '⏸';
    this.currentIndex = this.history.length - 1;
    this.updateLiveBtn();
  },

  updateLiveBtn() {
    this.el.liveBtn.classList.toggle('active', this.isLive && !!this.source);
    this.el.liveBtn.style.display = this.source ? '' : 'none';
  },

  /* ------------------------- main loop ------------------------- */
  loop(now) {
    const dtReal = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;

    if (this.playing) {
      if (this.source) {
        // Live simulation: advance fixed steps scaled by sim speed.
        this.acc += dtReal * this.simSpeed;
        let guard = 0;
        while (this.acc >= STEP && guard++ < 240) {
          this.pushFrame(this.source.step(STEP));
          this.acc -= STEP;
        }
      } else if (this.history.length) {
        // Loaded replay: advance the playhead through recorded frame times.
        this.playT += dtReal * this.simSpeed;
        const end = this.history[this.history.length - 1].t;
        if (this.playT >= end) { this.playT = end; this.playing = false; this.el.playBtn.textContent = '▶'; }
        this.currentIndex = this.indexForTime(this.playT);
      }
    }

    this.draw();
    this.syncTransport();
    this.throttledPanels(now);
    requestAnimationFrame(this.loop.bind(this));
  },

  indexForTime(t) {
    // Linear scan from current position (frames are time-ordered, small steps).
    let i = Math.min(this.currentIndex, this.history.length - 1);
    if (this.history[i].t > t) i = 0;
    while (i < this.history.length - 1 && this.history[i + 1].t <= t) i++;
    return i;
  },

  frame() { return this.history[this.currentIndex] || null; },

  /* ------------------------- drawing ------------------------- */
  draw() {
    const r = this.renderer;
    r.clear();
    r.drawCourt();
    const f = this.frame();
    if (!f) return;

    if (this.viewMode === 'heatmap') this.drawHeatmap();
    if (this.viewMode === 'trails') this.drawTrails();

    // Ball
    if (this.showBall && f.ball && this.viewMode !== 'heatmap') {
      const ctx = r.ctx;
      ctx.beginPath();
      ctx.fillStyle = '#fde047';
      ctx.arc(r.mx(f.ball.x), r.my(f.ball.y), Math.max(3, r.ms(0.18)), 0, Math.PI * 2);
      ctx.fill();
    }

    // Players
    const dim = this.viewMode === 'heatmap';
    const posById = {};
    for (const fp of f.players) posById[fp.id] = fp;
    for (const p of this.players) {
      if (this.teamFilter !== 'all' && p.team !== this.teamFilter) continue;
      if (this.hidden.has(p.id)) continue;
      const fp = posById[p.id]; if (!fp) continue;
      this.drawPlayer(p, fp, dim);
    }
  },

  drawPlayer(p, fp, dim) {
    const r = this.renderer, ctx = r.ctx;
    const x = r.mx(fp.x), y = r.my(fp.y);
    const focused = this.focusId === p.id;
    const rad = Math.max(5, r.ms(0.42));
    const alpha = dim && !focused ? 0.35 : 1;

    ctx.globalAlpha = alpha;
    if (focused) {
      ctx.beginPath();
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2.5;
      ctx.arc(x, y, rad + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.fillStyle = p.color;
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();

    if (this.showNumbers && rad >= 7) {
      ctx.fillStyle = '#06101f';
      ctx.font = `700 ${Math.round(rad * 1.1)}px ui-sans-serif, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.number), x, y + 0.5);
    }
    ctx.globalAlpha = 1;
  },

  drawTrails() {
    const r = this.renderer, ctx = r.ctx;
    const ids = new Set(this.heatTargets());
    const start = Math.max(0, this.currentIndex - TRAIL_FRAMES);
    const colorById = {};
    for (const p of this.players) colorById[p.id] = p.color;

    for (const id of ids) {
      ctx.beginPath();
      let started = false;
      for (let i = start; i <= this.currentIndex; i++) {
        const fp = this.history[i].players.find(q => q.id === id);
        if (!fp) continue;
        const x = r.mx(fp.x), y = r.my(fp.y);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = colorById[id] || '#9ad';
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  },

  drawHeatmap() {
    const r = this.renderer;
    const { grid, max, gw, gh } = this.analytics.combinedHeat(this.heatTargets());
    if (max <= 0) return;
    this.heatCanvas.width = gw; this.heatCanvas.height = gh;
    const hctx = this.heatCanvas.getContext('2d');
    const img = hctx.createImageData(gw, gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const v = grid[gy * gw + gx] / max;       // 0..1
        const [cr, cg, cb, ca] = heatColor(v);
        // flip vertically: grid gy=0 is court bottom (y=0)
        const di = ((gh - 1 - gy) * gw + gx) * 4;
        img.data[di] = cr; img.data[di + 1] = cg; img.data[di + 2] = cb; img.data[di + 3] = ca;
      }
    }
    hctx.putImageData(img, 0, 0);
    const ctx = r.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.82;
    ctx.drawImage(this.heatCanvas, r.mx(0), r.my(COURT.width), r.ms(COURT.length), r.ms(COURT.width));
    ctx.restore();
  },

  pickPlayer(e) {
    const rect = this.canvas.getBoundingClientRect();
    const m = this.renderer.toMetres(e.clientX - rect.left, e.clientY - rect.top);
    const f = this.frame(); if (!f) return;
    let best = null, bestD = Infinity;
    for (const fp of f.players) {
      const p = this.players.find(q => q.id === fp.id);
      if (!p || (this.teamFilter !== 'all' && p.team !== this.teamFilter) || this.hidden.has(p.id)) continue;
      const d = Math.hypot(fp.x - m.x, fp.y - m.y);
      if (d < bestD) { bestD = d; best = fp.id; }
    }
    if (best && bestD < 1.5) this.setFocus(this.focusId === best ? null : best);
  },

  setFocus(id) {
    this.focusId = id;
    this.buildRoster();
  },

  /* ------------------------- panels ------------------------- */
  buildRoster() {
    const el = this.el.roster;
    el.innerHTML = '';
    const teams = this.teamFilter === 'all' ? ['A', 'B'] : [this.teamFilter];
    const names = { A: this.meta.teamA, B: this.meta.teamB };
    for (const t of teams) {
      const label = document.createElement('div');
      label.className = 'roster-team-label';
      label.textContent = names[t] || 'Team ' + t;
      el.appendChild(label);
      for (const p of this.players.filter(q => q.team === t)) {
        const row = document.createElement('div');
        row.className = 'roster-row' + (this.focusId === p.id ? ' focused' : '') +
          (this.hidden.has(p.id) ? ' hidden-player' : '');
        row.innerHTML =
          `<span class="num" style="background:${p.color}">${p.number}</span>` +
          `<span class="pname">${p.name}</span>` +
          `<span class="prole">${p.role}</span>` +
          `<span class="eye">${this.hidden.has(p.id) ? '🚫' : '👁'}</span>`;
        row.querySelector('.eye').addEventListener('click', ev => {
          ev.stopPropagation();
          if (this.hidden.has(p.id)) this.hidden.delete(p.id); else this.hidden.add(p.id);
          this.buildRoster();
        });
        row.addEventListener('click', () => this.setFocus(this.focusId === p.id ? null : p.id));
        el.appendChild(row);
      }
    }
    this.buildTeamSelect();
    this.updateLiveBtn();
  },

  throttledPanels(now) {
    if (now - (this._lastPanel || 0) < 200) return;
    this._lastPanel = now;
    this.renderStatsTable();
    this.renderFocusCards();
  },

  rosterForFilter() {
    return this.players.filter(p => this.teamFilter === 'all' || p.team === this.teamFilter);
  },

  renderStatsTable() {
    const rows = this.rosterForFilter().map(p => {
      const s = this.analytics.stat(p.id);
      const avg = s.movingTime > 0 ? s.movingDist / s.movingTime : 0;
      return { p, dist: s.dist, top: KMH(s.topSpeed), avg: KMH(avg), sprints: s.sprints };
    });
    const { key, dir } = this.sort;
    rows.sort((a, b) => (a[key] - b[key]) * dir);

    this.el.statsBody.innerHTML = rows.map(({ p, dist, top, avg, sprints }) =>
      `<tr data-id="${p.id}" class="${this.focusId === p.id ? 'focused' : ''}">
        <td><span class="tag" style="background:${p.color}">${p.number}</span></td>
        <td>${p.name}</td>
        <td class="num-cell">${dist.toFixed(0)}</td>
        <td class="num-cell">${top.toFixed(1)}</td>
        <td class="num-cell">${avg.toFixed(1)}</td>
        <td class="num-cell">${sprints}</td>
      </tr>`).join('');
    this.el.statsBody.querySelectorAll('tr').forEach(tr =>
      tr.addEventListener('click', () => this.setFocus(this.focusId === tr.dataset.id ? null : tr.dataset.id)));
  },

  renderFocusCards() {
    const el = this.el.focusCards;
    if (!this.focusId) {
      el.innerHTML = '<div class="muted">Select a player (click a dot, roster, or table row) to see live detail.</div>';
      return;
    }
    const p = this.players.find(q => q.id === this.focusId);
    const s = this.analytics.stat(p.id);
    const avg = s.movingTime > 0 ? s.movingDist / s.movingTime : 0;
    const card = (k, v, u) => `<div class="stat-card"><div class="k">${k}</div><div class="v">${v}</div><div class="u">${u}</div></div>`;
    el.innerHTML =
      `<div class="focus-head"><span class="num" style="background:${p.color}">${p.number}</span>
        <strong>${p.name}</strong> <span class="muted">· ${p.role} · ${p.serial}</span></div>` +
      card('Speed now', KMH(s.speed).toFixed(1), 'km/h') +
      card('Top speed', KMH(s.topSpeed).toFixed(1), 'km/h') +
      card('Distance', s.dist.toFixed(0), 'metres') +
      card('Avg (moving)', KMH(avg).toFixed(1), 'km/h') +
      card('Sprints', s.sprints, '>18 km/h') +
      card('Sprint time', s.zoneTime.sprint.toFixed(0), 'seconds');
  },

  syncTransport() {
    const f = this.frame();
    const t = f ? f.t : 0;
    const end = this.history.length ? this.history[this.history.length - 1].t : 0;
    this.el.clock.textContent = fmt(t);
    this.el.timeLabel.textContent = `${fmt(t)} / ${fmt(end)}`;
    this.el.scrub.max = Math.max(0, this.history.length - 1);
    if (document.activeElement !== this.el.scrub) this.el.scrub.value = this.currentIndex;
  },

  /* ------------------------- load / export ------------------------- */
  exportSession() {
    const data = {
      meta: { ...this.meta, recordedAt: new Date().toISOString(), hz: SIM_HZ },
      court: { length: COURT.length, width: COURT.width },
      roster: this.players.map(p => ({
        id: p.id, team: p.team, teamName: p.teamName, number: p.number,
        name: p.name, role: p.role, serial: p.serial, color: p.color,
      })),
      frames: this.history,
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `revo-session-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.el.status.textContent = `Exported ${this.history.length} frames.`;
  },

  async loadFile(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.frames) || !Array.isArray(data.roster)) {
        throw new Error('JSON must have "roster" and "frames" arrays.');
      }
      this.source = null; // stop simulation, switch to replay
      this.meta = { ...this.meta, ...(data.meta || {}) };
      if (data.meta?.teamA) this.meta.teamA = data.meta.teamA;
      this.players = data.roster.map(p => ({
        ...p,
        color: p.color || (p.team === 'B' ? TEAM_COLORS.B : TEAM_COLORS.A),
      }));
      this.analytics = new Analytics(this.players);
      this.history = data.frames;
      for (const fr of this.history) this.analytics.ingest(fr);
      this.currentIndex = 0; this.playT = this.history[0]?.t || 0;
      this.isLive = false; this.playing = true; this.focusId = null;
      this.el.playBtn.textContent = '⏸';
      this.el.source.textContent = 'Source: Loaded file';
      this.el.venue.textContent = 'Venue: ' + (this.meta.venue || '—');
      this.hidden.clear();
      this.buildRoster();
      this.el.status.textContent = `Loaded ${this.history.length} frames from ${file.name}.`;
    } catch (err) {
      this.el.status.textContent = 'Load failed: ' + err.message;
    }
  },
};

/* ---- helpers ---- */
function fmt(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Heat color ramp: 0 -> transparent blue, 1 -> opaque red.
function heatColor(v) {
  if (v <= 0) return [0, 0, 0, 0];
  v = Math.pow(v, 0.6); // gamma so low-dwell areas still show
  const stops = [
    [0.0, [30, 64, 175, 0]],
    [0.25, [34, 197, 235, 140]],
    [0.5, [34, 197, 94, 190]],
    [0.75, [250, 204, 21, 220]],
    [1.0, [239, 68, 68, 240]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const f = (v - t0) / (t1 - t0 || 1);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
    }
  }
  return stops[stops.length - 1][1];
}

window.addEventListener('DOMContentLoaded', () => App.init());
