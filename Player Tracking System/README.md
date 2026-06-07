# Player Tracking System

DIY athlete tracking + analysis for **40 × 20 m floorball courts** — accurate
moving dots, heatmaps, and speed/distance/sprint stats, shareable by URL.

This folder contains two things:

1. **A working visual prototype** (this app) — runs today on **simulated** match
   data, with a documented data format so real **UWB** tracking drops straight in.
2. **[`DESIGN.md`](./DESIGN.md)** — the engineering & feasibility plan: why UWB
   (not RFID/LiDAR), the portable kit, DIY hardware + costs, the 500-team
   multi-tenant model, and the roadmap.

> Built for fast iteration: no build step, no dependencies. Open it and go.

---

## Run it

**Option A — open directly:** double-click `index.html`. (Loading the bundled
sample file may be blocked by the browser on `file://`; use Option B if so. The
live simulation works either way.)

**Option B — serve locally (recommended):**

```bash
cd "Player Tracking System"
python3 -m http.server 8080
# open http://localhost:8080
```

**Shareable URL for teams (Vercel):** this app is plain static files. Deploy this
folder as a static site (Vercel/Netlify/GitHub Pages) with the folder as the root
directory and no build command. That gives the link to send to teams to review.

---

## What you can do

- **Watch the match** — dots move in real time on a to-scale floorball court
  (two teams of 6 + ball), driven by the built-in simulator.
- **Views:** `Dots`, `Trails` (recent path), `Heatmap` (dwell time, per player or
  whole team).
- **Focus a player** — click a dot, a roster row, or a table row → live detail
  cards (speed now, top speed, distance, avg, sprints) + isolated trail/heatmap.
- **Roster** — hide/show players, filter by team (the "team login" view).
- **Performance table** — distance, top/avg speed, sprint count; click a column
  to sort.
- **Playback** — pause, scrub the timeline, change speed (0.5–4×), or jump back to
  `LIVE`.
- **Load / Export** — load a recorded session JSON (try `data/sample-session.json`),
  or export the current session to share/replay.

---

## Plugging in real data

The simulator emits the **same JSON the real UWB pipeline will** — so going live
means swapping the data source, not rewriting the UI. Format
([full spec in DESIGN.md §9](./DESIGN.md#9-data-pipeline--format)):

```jsonc
{
  "meta":  { "venue": "...", "teamA": "Falcons", "teamB": "Rovers", "hz": 20 },
  "court": { "length": 40, "width": 20 },
  "roster": [ { "id": "A1", "team": "A", "number": 1, "name": "Lind",
               "role": "GK", "serial": "RV-00A1B2", "color": "#3b82f6" } ],
  "frames": [ { "t": 0.05, "ball": { "x": 20, "y": 10 },
               "players": [ { "id": "A1", "x": 4, "y": 10 } ] } ]
}
```

- Metres, origin bottom-left (x∈[0,40], y∈[0,20]); `t` = seconds from start.
- `serial` is the wearable tag's printed serial — the join key for the team's
  roster. The gateway's position solver produces the `players` array from UWB
  ranges (see DESIGN.md §3, §9). Multi-court venues and booking-driven tracking
  are covered in DESIGN.md §5–§6.

Regenerate the sample (any length in seconds):

```bash
node scripts/generate-sample.mjs 120
```

---

## Files

| Path | What |
|---|---|
| `index.html` | App shell |
| `css/styles.css` | Styling |
| `js/court.js` | Court geometry + canvas renderer (metre↔pixel transforms) |
| `js/simulation.js` | Synthetic match generator (stand-in for the real UWB feed) |
| `js/analytics.js` | Speed / distance / sprints + per-player heat grids |
| `js/app.js` | UI controller: render loop, playback, panels, load/export |
| `scripts/generate-sample.mjs` | Node generator for `data/sample-session.json` |
| `data/sample-session.json` | Example recorded session (loadable) |
| `DESIGN.md` | Feasibility + hardware + multi-tenant + roadmap |

---

## Status & limitations (prototype)

- Data is **simulated** — movement is plausible, not a real match.
- Stats/heatmaps are **whole-session cumulative**; scrubbing repositions the dots
  but doesn't rewind the accumulated stats (documented simplification).
- Recording is capped at ~15 min in-browser (memory).
- Court markings approximate IFF rules — for orientation, not officiating.

Next step is **Phase 1** in DESIGN.md: build one anchor + one tag, prove the
position solver emits this format, and load a real session into this UI unchanged.
