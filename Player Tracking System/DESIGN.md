# Revo Player Tracking — Design & Feasibility

Indoor athlete tracking for **40 × 20 m floorball courts**. DIY, low-cost,
portable, multi-tenant (≈500 teams self-serve). This document is the
engineering scope; the working prototype in this folder is the visual front end.

> **Status:** Phase 0 — feasibility + UI prototype with simulated data.
> Hardware not yet built. Decisions marked **⚠️ TO CONFIRM** are open.

---

## 1. Product vision & confirmed scope

| Decision | Choice (from scoping) |
|---|---|
| Deliverable now | Design + feasibility + visual analysis UI (shareable URL). No Home Assistant integration. |
| Install model | **Portable kit** Revo staff carry to each venue and set up per match. |
| Players tracked | One wearable **per player**, squads **7+ per team**, design headroom to **~30 tags**. |
| Data timing | **Post-game review first**, live dashboard later. |
| Tracking tech | **UWB** (accuracy first), but DIY/cheap so we can iterate fast. |
| Tenancy | 500 teams. A team logs in, registers its wearable **serial numbers**, sees its own stats. Minimal Revo admin. |

**The core experience:** accurate dots moving on a to-scale court, plus heatmaps
and speed/distance/sprint metrics — per player, per session, shareable by link.

---

## 2. Technology choice — why UWB (and why not the others)

The original brief said "LiDAR... or RFID." Neither fits a *per-player, accurate,
portable, cheap* tracker. Here's the honest comparison:

| Tech | Accuracy | Per-player ID | Portable/cheap | Verdict |
|---|---|---|---|---|
| **Passive RFID** | Gate-only (presence) | Yes | Cheap | ❌ Can't give continuous position — only "passed a reader". No dots. |
| **BLE / iBeacon RSSI** | 1–3 m, jumpy | Yes | Very cheap | ❌ Too coarse; speed/sprint metrics unreliable. |
| **BLE AoA (5.1)** | 0.5–1 m | Yes | Medium | ⚠️ Better, but antenna arrays are fiddly to DIY and calibrate per venue. |
| **UWB (DW3000)** | **0.1–0.3 m** | Yes | **Cheap DIY now** | ✅ **Chosen.** Precise, per-tag, robust to RF noise, ~$15–30/node. |
| **LiDAR (2D scanners)** | 0.05 m | **No** (anonymous blobs) | Pricey, occlusion-prone | ❌ Can't tell players apart; players occlude each other; ID re-assignment is hard. |
| **Camera + CV** | 0.1–0.5 m | Re-ID only | Cheap cams, heavy compute | ❌ Per-player ID needs jersey OCR/Re-ID; lighting/occlusion fragile; privacy. No wearable to sell. |
| **GPS/GNSS** | — | — | — | ❌ Indoor: no signal. |

**Why UWB wins here:** it's the only option that is simultaneously (a) accurate
enough for real speed/heatmaps, (b) gives each player a unique ID via a cheap
worn tag (the thing we sell), and (c) buildable today from ~$20 dev boards. The
"wearable with a serial number" the team registers **is the UWB tag.**

---

## 3. How UWB positioning works (the math)

Each **tag** (worn by a player) exchanges radio packets with fixed **anchors**
placed around the court. Distance per anchor comes from time-of-flight; position
comes from combining several distances.

Two ranging schemes:

- **TWR (Two-Way Ranging)** — tag ↔ each anchor does a back-and-forth; distance =
  time-of-flight × c. Simple, no clock sync between anchors. Cost: more airtime
  per fix → caps tag count / update rate. **Recommended for the pilot.**
- **TDoA (Time Difference of Arrival)** — tag broadcasts one blink; anchors
  (clock-synced) compare arrival times. Scales to *many* tags at high rate.
  Needs anchor time sync (wired or wireless). **Target for scale (30 tags @ high Hz).**

**Multilateration:** with ≥3 anchor distances (4+ for robustness and to resolve
height) we solve for (x, y) by least-squares trilateration. We constrain z to
≈chest height (tag worn on a vest/wrist) to keep it a 2-D solve.

**Update-rate budget (TWR, pilot):** a DW3000 TWR exchange ≈ 2–3 ms. 4 anchors ×
~2.5 ms ≈ 10 ms per tag per fix. To get **10 Hz per tag** we have 100 ms/tag of
budget → comfortably ~10 tags on a single round-robin channel. For **30 tags**
either (a) drop to ~3–4 Hz (fine for floorball heatmaps/speed after smoothing),
(b) split tags across 2–3 UWB channels/anchor sets, or (c) move to **TDoA**.
**Plan: pilot at ~10 tags/10 Hz with TWR; scale via TDoA.** ⚠️ TO CONFIRM with
on-court RF testing.

---

## 4. Portable kit — physical design

Because staff carry and set up the kit per venue, **fast deploy + calibration is a
hard requirement.**

```
        20 m
   A1───────────A2        A1..A4 = UWB anchors on 2.5–3 m stands,
    │   court    │          one near each corner, ~1 m outside the
40 m│  40 x 20   │          playing area, clear line-of-sight inward.
    │            │        GW    = gateway (laptop/Raspberry Pi) collects
   A4───────────A3                anchor data, computes positions, records.
              [GW]
```

- **4 anchors** (corner placement gives best geometric dilution of precision).
  Optionally a 5th/6th mid-sideline anchor for a 40 m-long hall to cut NLOS.
- **Stands:** lighting/speaker tripods (2.5–3 m) so anchors clear players' bodies
  → fewer non-line-of-sight (NLOS) errors.
- **Power:** USB power banks per anchor (battery, no mains hunting). ~8 h each.
- **Comms:** anchors → gateway over Wi-Fi (ESP32 onboard) or a small mesh.
- **Transport:** one flightcase: 4–6 anchors, stands, power banks, tag charging
  caddy, gateway, a tape measure / laser for placement.

**Setup workflow (target < 10 min):**
1. Place 4 stands at corners; power on.
2. **Calibrate court frame:** anchors self-range to each other to learn their
   relative geometry; staff enter the court length/width (fixed 40×20) and tap
   "which corner is A1." A guided wizard in the gateway app confirms the fix.
3. Hand out tags; tap each player's tag to their name (or the team pre-assigned
   serials in the app — see §6).
4. Hit record. Tear down in reverse.

**Per-venue calibration** is the main portable-kit risk: anchor positions differ
every time, so the geometry must be re-established each setup. Anchor-to-anchor
auto-ranging + a known court size makes this automatic. ⚠️ TO CONFIRM accuracy of
auto-survey vs. manual tape measurement.

---

## 5. DIY hardware & cost (indicative)

Parts only, GBP-ish ballpark — for **fast iteration**, not final retail.

**Anchor (×4–6):**
| Item | ~Cost |
|---|---|
| ESP32 + DW3000 UWB module (e.g. Makerfabs ESP32 UWB DW3000 / Qorvo DWM3000EVB) | £18–28 |
| USB power bank | £8–12 |
| Enclosure + tripod mount | £6 |
| **Per anchor** | **~£35** → 4 anchors ≈ **£140**, 6 ≈ £210 |

**Tag / wearable (×30):**
| Item | ~Cost |
|---|---|
| ESP32 + DW3000 (same module, tag firmware) | £18–28 |
| LiPo + charge circuit | £4 |
| Wrist/vest enclosure | £4 |
| **Per tag (parts)** | **~£26–36** |

> A purpose-built tag (bare DW3000 + small MCU, no ESP32) drops to **~£8–12** at
> volume — the path to a sellable wearable. Pilot with dev boards first.

**Gateway:** Raspberry Pi 4/5 (£60–80) or any laptop. Runs the position solver +
recorder + (later) uploads to cloud.

**Tripods:** £15–25 each (lighting stands).

**Indicative pilot kit (4 anchors + 12 tags + Pi + stands): ≈ £550–700 parts.**
Cheap enough to build 2–3 kits and iterate. ⚠️ TO CONFIRM final BOM after a
bench test of one anchor + one tag.

---

## 6. Multi-tenant model (500 teams, minimal Revo admin)

Goal: teams onboard themselves; Revo staff just run the kit on match day.

**Entities:**
- **Team** (the tenant): login, roster, branding.
- **Wearable**: a physical tag with an immutable **serial** (printed on the
  device, e.g. `RV-00A1B2`). Teams **register serials they own** under their
  account, then **assign a serial → a player name** in their roster. This is the
  whole "recognise/mark players" step — done once by the team, not by Revo.
- **Player**: name + assigned wearable serial (+ optional number/role).
- **Session**: one recorded match at a venue → frames + computed stats, owned by
  the team(s) that played.

**Match-day flow with zero per-player admin for Revo:**
1. Teams have already assigned serials → players in-app.
2. Staff set up the kit, start a session, select which teams are playing.
3. Tags broadcast their serial; the system maps serial → player → team
   automatically. **No manual labelling on the day.**
4. After the match, each team sees only its session via login.

**Why serials (not pairing on the day):** pre-registered serials mean recognition
is automatic and self-serve. A tag can be re-issued by editing the team's
serial→player map. Lost tag → deactivate serial in-app.

⚠️ TO CONFIRM: do teams **own** their tags (buy the wearable) or **rent** a Revo
pool per match? Owning fits the "sell them a wearable" line; renting lowers team
cost but adds Revo logistics. Either way the serial model works.

---

## 7. Data pipeline & format

```
Tags ──UWB──> Anchors ──Wi-Fi──> Gateway ──solve──> frames ──┐
                                  (record locally first)       │
                              post-game upload ──> Cloud DB ───┴─> Web UI (this app)
                                                   (Convex, per-team)     ↑ shareable URL
```

- **Post-game (now):** gateway records the whole match to a JSON file, uploads
  after. Simplest, robust, matches the chosen MVP. The web UI **replays** it.
- **Live (later):** gateway streams frames over WebSocket to the same UI; the UI
  already has a "live" mode (built against the simulator) ready for this.

**Canonical frame format** — the simulator, the sample file, and the future real
pipeline all emit this exact shape, so the UI never changes:

```jsonc
{
  "meta":  { "venue": "Stirling Sports Hall", "teamA": "Falcons", "teamB": "Rovers", "hz": 20 },
  "court": { "length": 40, "width": 20 },
  "roster": [
    { "id": "A1", "team": "A", "teamName": "Falcons",
      "number": 1, "name": "Lind", "role": "GK", "serial": "RV-00A1B2", "color": "#3b82f6" }
  ],
  "frames": [
    { "t": 0.05, "ball": { "x": 20.0, "y": 10.0 },
      "players": [ { "id": "A1", "x": 4.0, "y": 10.0 } ] }
  ]
}
```

- Coordinates in **metres**, origin bottom-left, x∈[0,40], y∈[0,20].
- `t` seconds from session start. `ball` optional (UWB ball tag is a stretch goal).
- A real tag's `serial` is the join key to the team's roster; `id` is the
  per-session short handle.

The position **solver** (gateway side) is the only new code for real data: take
per-anchor ranges → trilaterate → smooth (e.g. a small Kalman/α-β filter to tame
the 10–30 cm jitter) → emit a `players` entry per tag. Everything downstream
(analytics, heatmaps, UI) is done and proven against the simulator.

---

## 8. Accuracy expectations & error sources

- **Expected:** 10–30 cm with good 4-anchor line-of-sight; speed reliable after
  light filtering; heatmaps and distance excellent.
- **NLOS (player bodies blocking the tag↔anchor path)** is the main error — adds
  positive bias to range. Mitigations: high anchor mounts (stands), 5–6 anchors
  so the solver can reject the worst range, and DW3000's diagnostic flags to
  down-weight NLOS measurements.
- **Multipath** in a hall with hard walls: UWB's wide bandwidth resolves the
  first (direct) path well; filtering handles the rest.
- **Geometry (GDOP):** corner anchors over a 40×20 rectangle give good geometry;
  a long 40 m axis benefits from mid-side anchors.
- **Tag placement:** upper back/vest is more reliable than wrist (wrist is often
  shadowed by the body). ⚠️ TO CONFIRM wrist vs vest in testing.

---

## 9. Roadmap

- **Phase 0 — Prototype (this folder).** Court UI, simulated match, heatmaps,
  speed/distance/sprints, load/replay/export, shareable via Vercel. ✅
- **Phase 1 — One physical kit, one court.** Build 4 anchors + a few tags;
  gateway solver emits the frame format; record a real session; load it into
  *this* UI unchanged. Validate accuracy vs tape-measured spots.
- **Phase 2 — Multi-tenant SaaS.** Team logins, serial→player registration,
  per-team session storage (Convex), post-game review online. Onboard pilot teams.
- **Phase 3 — Live + scale.** WebSocket live mode (UI-ready), TDoA for 30 tags,
  ball tracking, advanced analytics (zones, work-rate, team shape).

---

## 10. Open decisions (⚠️ TO CONFIRM)

1. **Budget ceiling** per kit and **retail price** of a wearable (drives tag BOM:
   dev board vs custom).
2. **Tag ownership:** teams buy vs Revo rents a pool.
3. **Update rate / tag count** target → TWR pilot vs TDoA timeline.
4. **Venue constraints:** ceiling height & mounting (stands vs rigging), hall RF.
5. **Wrist vs vest** tag placement.
6. **Live latency** expectations if/when live is prioritised.
7. **Ball tracking** in/out of scope (extra tag, harder dynamics).
