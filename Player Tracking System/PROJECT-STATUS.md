# Player Tracking System — Project Status & Decision Log

Living handoff doc. **Read this first** to resume work. Detail lives in
[`DESIGN.md`](./DESIGN.md); how-to-run in [`README.md`](./README.md).

> Last updated: 2026-06-07 (added testing-hardware decisions D16–D19 + 10-tag bench plan).

---

## 1. What this is
DIY indoor **athlete tracking for floorball** (regulation **40 × 20 m** courts) —
accurate moving dots, heatmaps, speed/distance/sprint stats. A **multi-tenant
product** for **~500 teams**: Revo runs the tracking kit, each team logs in,
registers its **wearable serials**, and reviews its own stats via a shareable URL.

- **Repo:** `adminrevo37/Krickora1`
- **Branch:** `claude/diy-lidar-athlete-tracking-ikFYl`
- **Folder:** `Player Tracking System/`
- **No PR opened** (per instruction). Pushed to the branch only.

---

## 2. Current state (what exists)
- ✅ **`DESIGN.md`** — full feasibility/engineering plan (12 sections): tech
  choice, UWB math, portable kit, multi-court, scheduling, hardware + tag build +
  AUD costs, multi-tenant, data pipeline + format, accuracy, roadmap, open
  decisions.
- ✅ **Working web prototype** — to-scale court, simulated live match, dots /
  trails / heatmaps, speed/distance/sprint stats, focus a player, playback scrub,
  load/export. Runs with **no build step / no deps**.
  - `index.html`, `css/styles.css`, `js/{court,analytics,simulation,app}.js`
  - `scripts/generate-sample.mjs` → `data/sample-session.json`
- ✅ Verified headless (realistic numbers; coords stay in court; sample loads).
- ⛔ **Not built yet:** any real hardware; anchor/gateway/position-solver code;
  multi-court UI; a deployed shareable URL; team login / serial registration.

---

## 3. Decision log (what's settled)
| # | Decision | Choice |
|---|---|---|
| D1 | Sport / court | **Floorball, 40 × 20 m** |
| D2 | Deliverable this phase | Design + feasibility + **visual analysis UI** (shareable URL). **No** Home Assistant integration. |
| D3 | Where it lives | `Krickora1` repo, `Player Tracking System/` folder |
| D4 | Install model | **Portable kit** staff carry per venue (per-venue calibration required) |
| D5 | Players / tags | One wearable **per player**; squads **7+/team**; design headroom **~30 tags** |
| D6 | Data timing | **Post-game review first**, live later (UI already has a live mode) |
| D7 | Tracking tech | **UWB** (~10–30 cm). RFID (gate-only), LiDAR (no per-player ID), BLE-RSSI (too coarse) rejected |
| D8 | Tenancy | Teams **self-register serials → players**; minimal Revo admin |
| D9 | Multi-court | One **building coordinate frame** + **per-court calibration**. **Option A** shared mesh (~6 anchors) vs **Option B** isolated per-court sets (~8 anchors, separate UWB channels) — **lean B** when both courts active at once |
| D10 | Scheduling | **Booking-driven active-tag allowlist** — Krickora fixture (team/court/time) + linked serials *is* the schedule. Allowlist is **server-side** |
| D11 | Build vs buy | **DWM3001C module route** — assemble finished modules (no factory run). Consumer tags (AirTag/SmartTag) unusable; commercial (Catapult/Pozyx) locked + expensive |
| D12 | Tag battery | **Small LiPo (120–500 mAh)** — **not a coin cell** (can't supply UWB current pulses). Charger IC + 3.3 V buck-boost + protection; contact-pad charging for sealed case |
| D13 | Tag radios | **UWB** (positioning + in-play control) + **BLE — RETAINED** (check-in/heartbeat/OTA/diagnostics) + **NFC** (tap-to-assign). **Accelerometer motion-wake** is primary |
| D14 | Tag form factor | **Vest pod (upper back)** primary for accuracy; wrist optional |
| D15 | Ranging mode | **TWR** for pilot (~10 tags @ 10 Hz); **TDoA** for scale (30 tags) |
| D16 | **Testing hardware** | **Makerfabs ESP32 UWB DW3000** for both anchor + tag (DW3000 + **Wi-Fi**), so the **wireless anchor→Pi link (MQTT) is tested from day one**. ⚠️ Buy DW3000, *not* the DW1000 "Pro with Display". Production tag stays the DWM3001C module route (D11). `DESIGN.md §7.6` |
| D17 | **Bench backhaul** | Anchors → **dedicated AP (travel router on court)** → **MQTT (Mosquitto on Pi)** → trilaterate → frame format. *Not* the venue Wi-Fi |
| D18 | **Anchor power** | Anchor is **not battery-critical** (stationary). Draw ~150–250 mA @5 V → **10,000 mAh power bank = 20 h+**; 20,000 mAh for a full day. Measure actual draw to confirm |
| D19 | **ESP32 at scale** | ESP32 Wi-Fi is **fine for pilot + multi-court** (range payloads tiny; Wi-Fi not the bottleneck). Scaling limit = **UWB capacity** → fix via scheduling/Option B/TDoA, not a faster anchor. For big/permanent multi-court venues consider **high-power UWB (ESP32 UWB Pro ~120 m)** + **wired/PoE anchors**. `DESIGN.md §7.7` |

---

## 4. Indicative costs (AUD, module-route, small qty)
- **Anchor** ~$70 · **Assembled tag** ~$90–110 · **Gateway (Pi)** ~$120–160 · **Tripod** ~$30–50
- **Pilot kit (1 court):** ~$1,700–2,000 · **Full squad (1 court):** ~$3,800–4,200
- **2 courts:** ~$3,900–4,500 (A shared / B isolated)
- **Tags dominate** (30 × ~$100 = ~$3,000). Levers: teams **buy** their own tags; or **custom PCB at volume** → ~$30–45/tag.
- Full BOM + tables in `DESIGN.md §7`.

---

## 5. Open decisions (⚠️ need Revo input) — see `DESIGN.md §12`
1. **Budget ceiling** per kit + **wearable retail price** (drives dev-board vs custom-PCB tag).
2. **Tag ownership:** teams **buy** vs Revo **rents** a pool.
3. **Update rate / tag count** target → TWR-pilot vs TDoA timeline.
4. **Venue constraints:** ceiling height / mounting, hall RF.
5. **Multi-court per venue:** side-by-side (~40×40) vs end-to-end (~80×20); **Option A vs B**; fixed install vs portable for regular venues.
6. **Scheduling source:** live Krickora feed vs pre-match export; warm-up buffers; walk-in games.
7. **Tag form factor & charging:** vest vs wrist; USB-C vs sealed contact-pad; caddy bay count.
8. **Selling in Australia:** **RCM/EMC** cert (AS/NZS 4268 + SDoC) + Australian importer. (UWB is licence-exempt to *operate*.)
9. **Live latency** expectations (if/when live prioritised).
10. **Ball tracking** in/out of scope.

---

## 6. Next steps (offered, not started)
- **Phase 1 — 10-tag bench pilot (planned, see `DESIGN.md §7.6`):** order the
  **Makerfabs ESP32 UWB DW3000** boards (4–6 anchors + 10 tags), a Raspberry Pi,
  and a dedicated AP. Build order: **1 anchor + 1 tag** → ranging works → **4
  anchors + 1 tag** → trilateration/positioning → **scale to 10 tags** → capacity
  + anchor battery test. Backhaul over **Wi-Fi/MQTT** from the start. BOM ≈ AUD
  1,750–2,100.
- **Gateway position solver** — the only real code to replace the simulator:
  anchor ranges (MQTT) → trilateration → smoothing → the canonical frame JSON
  (§9). Anchors run Makerfabs DW3000 TWR firmware + a small Wi-Fi/MQTT publisher.
- **Anchor + gateway deep-dive** in `DESIGN.md` (mirror the tag deep-dive).
- **Multi-court UI** in the prototype: court switcher + per-court calibration view.
- **Shareable deploy URL:** decide standalone Vercel/Netlify project **vs** fold
  into the Krickora1 app. ⚠️ The *existing* Krickora1 Vercel build serves only the
  React app (`dist/`), so it **won't auto-serve this folder** — needs a deliberate
  deploy choice.
- **Optional doc add-ons offered:** plain-English "How the tag works + RF safety"
  note; "Tag power & charging" schematic notes (part numbers + contact-pad caddy).

---

## 7. Key facts worth not re-deriving
- **Why UWB:** only tech that is accurate (~10–30 cm) **and** per-player-ID via a
  cheap worn tag **and** DIY-buildable now.
- **Anchors:** near each corner, **~2.5–3 m high, ~1 m outside the boards**, wide
  spread (good GDOP). 40 m axis / multi-court benefits from **mid-hall anchors**.
- **Tag is an active radio** transmitting **UWB (~6.5–8 GHz, ~0.5 mW total — far
  less than a phone)** + BLE. Non-ionizing, well under safety limits, licence-exempt.
- **Coin cell won't work** for UWB (high-ESR → brownout under ~100 mA pulses).
- **Frame format** (simulator = real pipeline, so real data is drop-in): metres,
  origin bottom-left; `{meta, court, roster[serial→player], frames[{t, ball, players[{id,x,y}]}]}`.
  Multi-court extends `meta` with `building` + `courts[]`. See `DESIGN.md §9`.
