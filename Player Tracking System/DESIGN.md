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
| Venues | Single court *and* **multi-court** halls (see §5); tracking scoped by a **booking-driven schedule** (see §6). |

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
**Plan: pilot at ~10 tags/10 Hz with TWR; scale via TDoA.** The airtime budget is
also why we only ever range the tags that are *scheduled to play right now* — see
§6. ⚠️ TO CONFIRM with on-court RF testing.

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
   serials in the app — see §8).
4. Hit record. Tear down in reverse.

**Per-venue calibration** is the main portable-kit risk: anchor positions differ
every time, so the geometry must be re-established each setup. Anchor-to-anchor
auto-ranging + a known court size makes this automatic. ⚠️ TO CONFIRM accuracy of
auto-survey vs. manual tape measurement.

---

## 5. Multi-court venues

Many halls run **two courts**. The model: anchors define **one coordinate frame
for the whole building**, and we **calibrate each court's corners once** within
that frame. Every computed position then carries which court it's on and its
court-local (x, y). The calibration is the easy part — physical coverage is what
needs care.

### 5.1 The hall footprint decides feasibility
Two 40×20 courts lay out two ways, and the geometry differs sharply:

- **Side-by-side (~40 × 40 m)** — diagonal ~57 m. Near the edge of reliable
  indoor UWB once bodies are in the path. Workable, but **4 building corners
  alone give weak geometry / long blocked paths for the far court.**
- **End-to-end (~80 × 20 m)** — diagonal ~82 m. **Too long for 4 corner anchors;**
  a far-end tag won't be heard cleanly. This layout *needs* anchors partway down
  the hall regardless.

**Fix either way:** don't rely on just 4 building corners — **add anchors along
the middle** (dividing line / mid-walls) so *each court* is surrounded by nearby
anchors instead of hanging off distant corners.

### 5.2 Two placement options

```
 Option A — one shared mesh            Option B — two isolated sets (recommended
 ●─────────●─────────●                              for two simultaneously-active courts)
 │ Court A │ Court B │                 ●───────●     ●───────●
 ●─────────●─────────●                 │ Crt A │     │ Crt B │   ← separate UWB
 ~6 anchors, one frame,                ●───────●     ●───────●     channels
 all tags share airtime                ~8 anchors; each court fully
 (needs scheduling §6 / TDoA           surrounded, no cross-court
 to stay high-rate)                    congestion or body-blocking
```

- **Option A — shared building mesh (~6 anchors):** one calibration, fewer parts.
  But both courts' tags **share airtime** (per-tag rate drops with more tags) and
  bodies on Court A can block Court B's signals. Made viable by **only tracking
  the tags scheduled to be playing (§6)** and/or moving to TDoA.
- **Option B — two anchor sets, one per court, on separate UWB channels
  (~8 anchors):** each court is its own well-surrounded, isolated system — no
  congestion, no cross-blocking, scales cleanly. **Preferred when both courts can
  be active at once.** Both sets can still live under **one calibration frame** so
  the UI shows the whole building.

### 5.3 Calibrate once, mark the courts
At setup (or once permanently for a fixed install) staff mark each court's four
corners — walk a tag to each corner and tap, or enter offsets. The system stores,
per court, an origin + rotation in the building frame. From then on every fix maps
to `{ courtId, xLocal, yLocal }` automatically. Re-calibration is only needed if
anchors move.

### 5.4 Fixed install beats portable for regular 2-court venues
Building-corner anchors imply a **permanent install**. If Revo uses a 2-court
venue often, mounting anchors high on the walls **once** removes per-match setup
entirely and you calibrate court positions a single time — best accuracy, zero
match-day faff. The portable kit stays the model for one-off venues.

### 5.5 How it appears in the data
The canonical frame format (§9) extends cleanly: `meta` gains a `building` name
and a `courts[]` list (`id`, `name`, origin + rotation), and a session can either
be **per-court** (one file per court — simplest) or **building-wide** with each
player/frame tagging its `court`. Single-court files need no `courts[]` and stay
exactly as today.

### 5.6 Cost delta
Covering two courts vs one is **+2 to +4 anchors (~£70–140)** (6 shared / 8
isolated); tags still scale with players. See §7.

---

## 6. Session scheduling & tag activation

On a shared mesh (Option A) — or any busy venue — you don't want to track *every*
tag in the building. A team that arrives early, the other court between bookings,
or a stray tag in a kitbag should create **no tracking load**. The mechanism is a
**schedule that drives an active-tag allowlist**, but one distinction decides
whether it saves real work:

> **Filtering data ≠ saving airtime.** Dropping un-listed serials in software
> cleans the data and stops Court B leaking into Court A — but if those tags are
> still transmitting, they still consume radio airtime and drag down everyone's
> update rate. To actually reduce workload, the schedule must control the **radio**,
> not just the database.

Whether you can control the radio depends on the ranging mode:

- **TWR (pilot) — scheduling works perfectly.** A coordinator hands out time
  slots (TDMA) and only ranges tags on its active list. An un-scheduled tag is
  **never polled → ~zero airtime.** Early arrivals create no load; they're simply
  not on the schedule yet.
- **TDoA (scale) — needs more.** Tags blink autonomously, so a stray tag transmits
  regardless of any server list (you can discard its data, but it still eats air).
  Control it with **scheduled/downlink blink** (tags told when to broadcast) or by
  having **tags sleep until activated**.

### 6.1 Session lifecycle
1. Tags sit **dormant** — powered off, or a ~0.1 Hz heartbeat just to report
   presence + battery — until their session starts.
2. At session start the gateway **promotes only that team's serials to full rate**
   (TWR slots / scheduled blink) and binds them to the **right court's frame** (§5).
3. Anything else in the building — early arrivals, the idle court, lost tags — is
   **not scheduled → not tracked.**
4. Session ends → those serials drop back to dormant.

### 6.2 Sleep-until-check-in (belt and braces)
Have tags **wake only on check-in** (a button press, NFC tap, or a gateway wake
command). This eliminates early-arrival load **even in TDoA**, and saves tag
battery between matches.

### 6.3 The booking system *is* the schedule (Krickora integration)
Krickora already knows **who's booked which court, when** — and the multi-tenant
model (§8) already has **each team's registered serials**. So the booking schedule
can **directly generate the active-tag allowlist**: team → court → time → serials,
all from data Revo already holds. No extra match-day admin:

```
Krickora booking  ─┐
 (team, court, time)│→  active-tag allowlist  →  gateway schedules only those
team serial roster ─┘   (per court, per slot)     tags, on the correct court frame
```

This also closes the loop on the whole product: the **booking creates the
session**, the **serial registration creates the roster**, and the **gateway only
works as hard as the current bookings require.**

### 6.4 Waking tags & control channels (BLE retained)
The allowlist is **purely server-side** — the gateway derives "track these serials"
from the fixture, so **no tag radio is needed to *decide* what to track.** What the
tag radios do is **wake** and **carry control**:

- **Wake — motion first.** A sleeping tag's radios are off, so it can't be woken by
  radio. The **accelerometer** wakes it the instant it's handled/moved; it then
  announces its serial and the gateway matches it against the server allowlist
  (track, or send back to sleep). This needs no wake-radio and saves the most power.
- **Control/identity — UWB and/or BLE.** UWB is two-way, so start/stop/rate can ride
  on UWB. **BLE is retained** as the convenience channel for **check-in, the dormant
  presence/battery heartbeat, OTA firmware updates, and bench diagnostics.** It's
  already integrated in the DWM3001C (nRF52833) → no extra parts, negligible power.

**Decision:** server fixture = source of truth; motion-wake = primary wake;
UWB = in-play control; **BLE kept** for check-in/heartbeat/OTA/diagnostics.

⚠️ TO CONFIRM: live booking feed vs a pre-match export; buffer time around slots
(warm-up before the booked start); handling unscheduled/walk-in games.

---

## 7. DIY hardware, tag design & cost

Costs are **indicative AUD, parts-level**, for the **module-route** (assemble
finished modules, don't manufacture PCBs) — chosen so we never commit to a big
production run. See §7.2 for why and §7.5 for the volume path.

### 7.1 Anchor (×4–8 depending on courts)
| Item | ~AUD |
|---|---|
| UWB module (ESP32+DW3000, e.g. Makerfabs; or a DWM3001C for tag/anchor parity) | 35–55 |
| USB power bank (~8 h) | 18–25 |
| Enclosure + tripod mount | 10 |
| **Per anchor** | **~AUD 70** |

Anchor counts: **1 court = 4** (5–6 with mid-side); **2 courts = ~6 shared
(Option A)** or **~8 isolated (Option B)** — see §5. Tripods (lighting stands)
~AUD 30–50 each.

### 7.2 Tag / wearable — built on the Qorvo DWM3001C

The DWM3001C is a **finished, pre-certified module** that already contains almost
the entire tag, so the "build" is light assembly around it — order the quantity
you need, scale with demand.

```
 ┌──────────────────────── Wearable tag ─────────────────────────┐
 │  DWM3001C module (≈AUD 55):                                    │
 │   • DW3110 UWB radio + planar antenna → ranges to anchors      │
 │   • nRF52833 (BLE 5) → app, scheduling, check-in, OTA, NFC     │
 │   • LIS2DH accelerometer → motion-wake + impact/step metrics   │
 │   • PMIC + 38.4 MHz crystal                                    │
 │  + LiPo 400–500 mAh   + 3.3 V buck-boost                       │
 │  + USB-C or contact-pad charger    + status LED(s)             │
 │  + button (check-in)   + NFC coil (tap-to-assign)              │
 │  + laser-marked serial + QR (e.g. RV-00A1B2)                   │
 └────────────────────────────────────────────────────────────────┘
```

**Why this module:** the onboard nRF52833 hosts *all* of the tag's brains —
the UWB ranging app, BLE (config / check-in / OTA), the accelerometer read, and
even **NFC** (built-in peripheral; just add a coil). So a tag is the module + a
battery + a tiny carrier board + an enclosure. No RF design, no antenna tuning.

**Firmware states** (ties directly to scheduling, §6):
```
 DEEP SLEEP ──motion/button──▶ DORMANT ──check-in / gateway wake──▶ ACTIVE
  (~1–5 µA,    (in kitbag)     (BLE 0.1 Hz   (NFC tap, button, or   (UWB ranging
   System OFF)                  heartbeat:    BLE wake of the         at scheduled
       ▲                        presence +    booked serials)         TWR/TDoA rate)
       └──── still > N min ◀──── battery)  ◀──── session end ───────────────┘
  (CHARGING whenever docked)
```

- **Dumb-by-design:** positions are solved at the **gateway/anchors** (§9), so the
  tag only *ranges* — no onboard logging, no GPS-vest-style storage. That keeps it
  cheap, low-power, and simple. (Onboard IMU logging for richer metrics is a v2
  option.)
- **Identity:** the tag advertises its **serial** over BLE + in the UWB payload →
  the gateway matches it against the **server-derived allowlist** (the fixture,
  §6.4) → player/team (§8). Serial + QR on the case; **NFC tap** assigns/checks-in
  a tag in the team app.
- **Wake:** **accelerometer motion-wake** is primary (§6.4); button/NFC/BLE also
  available.
- **Ranging:** TWR for the pilot (responds to the coordinator's scheduled poll);
  scheduled-blink TDoA later for scale (§3).
- **BLE — retained** (confirmed): check-in, dormant presence/battery heartbeat,
  and **OTA firmware updates** (nRF BLE DFU). Free on the module, negligible power.

**Power budget** (a tag is dormant/asleep except during booked play):
| State | Avg current | Runtime on 500 mAh |
|---|---|---|
| ACTIVE — 10 Hz TWR | ~15–25 mA | **~20–30 h tracking** |
| DORMANT — BLE 0.1 Hz heartbeat | <0.1 mA | weeks |
| DEEP SLEEP | ~1–5 µA | months |

A match is ~1–2 h, so one charge covers **many matches**. Battery is not a
constraint once scheduling/sleep (§6) is in place — that's a selling point.

**Form factor:** **vest pod on the upper back is primary** (least body-shadowing
of the UWB antenna → best accuracy, per §10); a **wrist band** is the convenient
option but is shadowed more. Mount the planar antenna facing outward; target
IP55+ for sweat (contact-pad charging suits a sealed case better than USB-C).

**Per-tag BOM (~100 qty, AUD):**
| Item | ~AUD |
|---|---|
| DWM3001C module | 55 |
| Carrier PCB + charger IC + buck-boost + passives | 8–12 |
| LiPo 400–500 mAh | 4–6 |
| Button + LED(s) + NFC coil | 2–3 |
| Enclosure + strap/clip | 8–15 |
| Small-batch assembly + test | 10–20 |
| **Assembled tag** | **~AUD 90–110** |

The only PCB is a **trivial 2-layer carrier** (module castellations + battery +
charger + button) — JLCPCB/contract SMT in tens, no factory commitment.

### 7.3 Gateway
Raspberry Pi 4/5 (~AUD 120–160) or any laptop. Runs the position solver +
recorder + the schedule/allowlist (§6) + (later) cloud upload.

### 7.4 Indicative kits (AUD, module-route, small qty)
| Kit | Contents | ~Total |
|---|---|---|
| Pilot (1 court) | 4 anchors + 12 tags + Pi + 4 stands | **~AUD 1,700–2,000** |
| Full squad (1 court) | 6 anchors + 30 tags + Pi + 6 stands + case | **~AUD 3,800–4,200** |
| 2 courts shared (A) | 6 anchors + 30 tags + Pi + stands | **~AUD 3,900–4,300** |
| 2 courts isolated (B) | 8 anchors + 30 tags + Pi + stands | **~AUD 4,100–4,500** |

**Tags dominate** (30 × ~AUD 100 = ~AUD 3,000). Two levers: (a) **teams buy their
own tags** (spreads cost, fits the "sell a wearable" model, §8); (b) the **volume
path** below.

A **multi-bay charging caddy** (pogo-pin dock, charges 10–30 tags between
sessions) is part of the portable kit.

### 7.5 Volume path & compliance
- **Cost at volume:** replacing the module with a **custom PCB** (bare DW3110 +
  small MCU, own antenna) drops a tag to **~AUD 30–45**, taking 30 tags from
  ~AUD 3,000 to **~AUD 900–1,350**. Worth it only once volumes justify the design
  + tooling + a *second* certification.
- **Australian compliance to *sell*:** UWB is licence-exempt to *operate* (ACMA
  LIPD class licence), but selling a wireless device needs the **RCM mark** (EMC
  to **AS/NZS 4268** + signed SDoC), and a foreign maker needs an **Australian
  importer/representative**. The pre-certified DWM3001C eases EMC but the
  *finished* tag still needs its own RCM sign-off. Budget a one-off cert cost.

⚠️ TO CONFIRM final BOM after a bench test of one anchor + one tag.

### 7.6 Bench pilot — test build (Makerfabs ESP32 UWB DW3000)

For **testing** we deliberately use a different board than the production tag
(§7.2): the **Makerfabs ESP32 UWB DW3000**. Why: the **ESP32 gives Wi-Fi on both
anchor and tag**, so we validate the **wireless anchor→Pi link from day one** (no
USB backhaul to outgrow); it's the **same DW3000 radio** as production; and it has
the richest community firmware (Makerfabs Arduino libraries). Same board for both
roles keeps tag↔anchor interoperable.

> ⚠️ Buy the **DW3000** board — not the DW1000 "Pro with Display" (radio
> generations don't mix). A confirmed-DW3000 OLED variant is nice-to-have for live
> distance read-outs while testing.

**1 anchor =** ESP32 UWB DW3000 + USB power (wall adapter or power bank) + tripod
+ clamp. **No data cable** — Wi-Fi is the backhaul. The anchor is **not
battery-critical** (it's stationary); a power bank just makes it portable.

**Backhaul:** each anchor joins a **dedicated AP** (a travel router on court — *not*
the venue Wi-Fi), ranges the tags over UWB, and **publishes distances to the Pi
over MQTT** (Mosquitto on the Pi). The Pi trilaterates → frame format (§9) → UI.

**10-tag bench BOM (AUD, indicative):**
| Item | Qty | ~Unit | ~Total |
|---|---|---|---|
| ESP32 UWB DW3000 — **tags** | 10 | $65 | $650 |
| ESP32 UWB DW3000 — **anchors** | 4–6 | $65 | $260–390 |
| USB power bank 10,000 mAh — anchors (20 h+) | 4–6 | $30 | $120–180 |
| USB power bank ~5,000 mAh (or LiPo) — tags, testing | 10 | $15 | $150 |
| Raspberry Pi 5 + PSU + SD (gateway + MQTT broker) | 1 | $160 | $160 |
| Dedicated Wi-Fi travel router / AP | 1 | $70 | $70 |
| Tripod stand + clamp (anchors) | 4–6 | $50 | $200–300 |
| USB-C cables | ~16 | $5 | $80 |
| Enclosures (assorted) | — | — | $60 |
| **Total** | | | **~AUD 1,750–2,100** |

**Why 10 tags is a meaningful test:** at the TWR airtime budget (~10 ms/tag/fix
with 4 anchors), **10 tags ≈ the single-channel ceiling at 10 Hz** (§3). So this
build directly proves the capacity limit and *why* scheduling (§6), per-court
channels (§5 Option B), or TDoA are needed beyond ~10 tags.

**Anchor battery sizing (20 h target):** an active ESP32+DW3000 anchor (Wi-Fi +
UWB) draws ~**150–250 mA @ 5 V** (≈1–1.25 W) — *measure yours with an inline USB
power meter to confirm*. Sizing rule:
`bank_mAh(@3.7V) ≈ (I_mA × 5/3.7 × hours) / 0.85`. At 200 mA → ~6,400 mAh, so a
standard **10,000 mAh power bank gives 20 h+ with margin** (often ~30 h). Use
**20,000 mAh** for a comfortable full day; a 5,000 mAh bank only lasts ~12–15 h.

### 7.7 Is the ESP32 powerful enough? (range, Wi-Fi, multi-court, high load)
- **Wi-Fi power/range:** ESP32 2.4 GHz, ~+20 dBm, PCB antenna → ~30–50 m+ in an
  open hall (line-of-sight). Fine across a 40×20 court with a central AP; for an
  ~80 m hall, centre the AP or pick a board with an external Wi-Fi antenna.
- **Wi-Fi is *not* the bottleneck at scale.** Range messages are tiny; even many
  anchors × high rate × multiple courts is trivial data volume. The real ceiling
  is **UWB airtime/capacity**, which is independent of the MCU — solved by
  **scheduling (§6), per-court anchor sets/channels (§5 Option B), and TDoA (§3)**,
  not by a faster anchor CPU.
- **So "a more powerful anchor" isn't what scaling needs — architecture is.** Two
  upgrades *are* worth it for a busy permanent multi-court venue:
  1. **Big-hall UWB reach:** the **ESP32 UWB Pro (high-power, ~120 m)** variant /
     external UWB antenna improves the tag↔anchor link budget.
  2. **Fixed-install backhaul + TDoA sync:** **wired/PoE anchors** (e.g.
     ESP32-POE / Ethernet) give rock-solid data and easier anchor time-sync for
     TDoA — better than Wi-Fi for a permanent high-load rig.
- **Verdict:** the ESP32 UWB DW3000 is **suitable for testing, the single-court
  pilot, and the 10-tag capacity test**, and stays usable for multi-court **if
  architected** (dedicated AP + scheduling + Option B). Plan the high-power-UWB
  and/or PoE-anchor upgrades for a permanent high-load venue — don't buy them now.

---

## 8. Multi-tenant model (500 teams, minimal Revo admin)

Goal: teams onboard themselves; Revo staff just run the kit on match day.

**Entities:**
- **Team** (the tenant): login, roster, branding.
- **Wearable**: a physical tag with an immutable **serial** (printed on the
  device, e.g. `RV-00A1B2`). Teams **register serials they own** under their
  account, then **assign a serial → a player name** in their roster. This is the
  whole "recognise/mark players" step — done once by the team, not by Revo.
- **Player**: name + assigned wearable serial (+ optional number/role).
- **Session**: one recorded match at a venue/court → frames + computed stats,
  owned by the team(s) that played. Created from a **booking** (§6).

**Match-day flow with zero per-player admin for Revo:**
1. Teams have already assigned serials → players in-app.
2. The **booking schedule** activates the right serials on the right court (§6).
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

## 9. Data pipeline & format

```
Tags ──UWB──> Anchors ──Wi-Fi──> Gateway ──solve──> frames ──┐
                  ▲               (schedule §6 + record)       │
   booking-driven │                                            │
   allowlist (§6)─┘           post-game upload ──> Cloud DB ───┴─> Web UI (this app)
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

**Multi-court extension (§5.5):** for a whole-building recording, `meta` adds
`building` + `courts[]` (`id`, `name`, origin, rotation) and frames/players may
carry a `court` field; per-court files keep the single-court shape above. Backward
compatible — single-court files are unchanged.

The position **solver** (gateway side) is the only new code for real data: take
per-anchor ranges → trilaterate → smooth (e.g. a small Kalman/α-β filter to tame
the 10–30 cm jitter) → emit a `players` entry per tag. Everything downstream
(analytics, heatmaps, UI) is done and proven against the simulator.

---

## 10. Accuracy expectations & error sources

- **Expected:** 10–30 cm with good 4-anchor line-of-sight; speed reliable after
  light filtering; heatmaps and distance excellent.
- **NLOS (player bodies blocking the tag↔anchor path)** is the main error — adds
  positive bias to range. Mitigations: high anchor mounts (stands), 5–6 anchors
  so the solver can reject the worst range, and DW3000's diagnostic flags to
  down-weight NLOS measurements.
- **Multipath** in a hall with hard walls: UWB's wide bandwidth resolves the
  first (direct) path well; filtering handles the rest.
- **Geometry (GDOP):** corner anchors over a 40×20 rectangle give good geometry;
  a long 40 m axis benefits from mid-side anchors. On a multi-court mesh, the far
  court suffers most — hence mid-hall anchors / isolated sets (§5).
- **Tag placement:** upper back/vest is more reliable than wrist (wrist is often
  shadowed by the body). ⚠️ TO CONFIRM wrist vs vest in testing.

---

## 11. Roadmap

- **Phase 0 — Prototype (this folder).** Court UI, simulated match, heatmaps,
  speed/distance/sprints, load/replay/export, shareable via Vercel. ✅
- **Phase 1 — Bench pilot, one court (10 tags).** Build with **Makerfabs ESP32
  UWB DW3000** (§7.6) so the **Wi-Fi anchor→Pi link (MQTT) is tested from day
  one**. Stand up 4 anchors + scale to **10 tags**; gateway solver (TWR)
  trilaterates → the frame format; load into *this* UI unchanged. Validate
  accuracy vs tape-measured spots, the 10-tag capacity ceiling, and anchor
  battery life. *(Production tag = the DWM3001C module route, §7.2.)*
- **Phase 2 — Multi-tenant SaaS + scheduling.** Team logins, serial→player
  registration, per-team session storage (Convex), post-game review online.
  **Booking-driven active-tag allowlist (§6)** and per-court calibration (§5).
- **Phase 3 — Live + scale.** WebSocket live mode (UI-ready), TDoA for 30 tags,
  multi-court isolated sets, ball tracking, advanced analytics (zones, work-rate,
  team shape).

---

## 12. Open decisions (⚠️ TO CONFIRM)

1. **Budget ceiling** per kit and **retail price** of a wearable (drives tag BOM:
   dev board vs custom).
2. **Tag ownership:** teams buy vs Revo rents a pool.
3. **Update rate / tag count** target → TWR pilot vs TDoA timeline.
4. **Venue constraints:** ceiling height & mounting (stands vs rigging), hall RF.
5. **Multi-court layout** per venue (side-by-side vs end-to-end) and **Option A vs
   B** (shared mesh vs isolated sets); fixed install vs portable for regulars.
6. **Scheduling source:** live Krickora booking feed vs pre-match export; warm-up
   buffers; walk-in/unscheduled games.
7. **Tag form factor & charging:** vest pod vs wrist (§7.2); USB-C vs sealed
   contact-pad charging; caddy bay count.
8. **Selling in Australia:** RCM/EMC certification path + Australian importer
   (§7.5).
9. **Anchor backhaul at scale:** Wi-Fi (pilot) vs **wired/PoE** for a permanent
   multi-court install; measure real anchor current draw to finalise battery (§7.6).
10. **Big-hall UWB reach:** standard vs **ESP32 UWB Pro high-power (~120 m)** /
    external antenna for large or multi-court venues (§7.7).
11. **Live latency** expectations if/when live is prioritised.
12. **Ball tracking** in/out of scope (extra tag, harder dynamics).
