import sys
from unittest import mock

# The system 'cryptography' package panics (broken rust binding); fpdf imports it
# eagerly via its encryption module. We don't encrypt, so stub any cryptography import.
class CryptoStub:
    def find_module(self, name, path=None):
        if name == "cryptography" or name.startswith("cryptography."):
            return self
        return None
    def load_module(self, name):
        if name in sys.modules:
            return sys.modules[name]
        m = mock.MagicMock(); m.__name__ = name; m.__path__ = []
        sys.modules[name] = m
        return m
sys.meta_path.insert(0, CryptoStub())

from fpdf import FPDF
from html import escape

GREEN = "#0b3d2e"

def code_block(text):
    rows = "<br>".join(escape(line) if line else "&nbsp;" for line in text.split("\n"))
    return f'<p><font face="courier" size="8">{rows}</font></p>'

def callout(label, body, color="#c47f00"):
    return f'<p><font color="{color}"><b>{label}</b></font> {body}</p>'

H = []
def w(x): H.append(x)

w(f'<h1><font color="{GREEN}">Krickora &mdash; Self-Service Keypad Entry</font></h1>')
w('<p><b>DIY Build Plan &amp; Specification</b> &nbsp;|&nbsp; Rev 0.1 (draft) &nbsp;|&nbsp; '
  '2026-06-05 &nbsp;|&nbsp; Jaycar (AU) sourcing</p>')
w(callout("Read first &mdash; assumptions.",
  "No written hardware spec existed in the repo, so this plan is reconstructed from the booking / "
  "access-code software (access-code.ts, Convex + Google Calendar + Stripe) and our design discussion. "
  "Items still to be decided are marked [DECISION]. Confirm flagged items before ordering or installing. "
  "Prices are indicative AUD only &mdash; verify current Jaycar pricing/stock."))

w(f'<h2><font color="{GREEN}">1. Intent &amp; scope</font></h2>')
w('<p>Customers book and pay online, the system issues a numeric door code bound to that booking, the '
  'customer enters the code at a keypad at the facility entry, the door releases and their booked bay '
  '(e.g. bay 4) powers up for the booking window. This plan covers the physical keypad entry controller, '
  'its wiring, firmware, the backend validation endpoint it relies on, and the reliability/safety '
  'engineering to keep it running long-term.</p>')

w(f'<h2><font color="{GREEN}">2. Architecture &mdash; dumb edge, smart core</font></h2>')
w('<p>The design goal is maximum uptime. Keep the device at the door as simple and stateless as possible, '
  'and put the decision logic on the well-powered, UPS-backed server.</p>')
w('<ul>'
  '<li><b>Edge (at the door): ESP32 + ESPHome.</b> Scans the keypad, drives the door relay, shows status. '
  'No OS, no SD card, boots in under 1s, recovers instantly from power loss. Native Home Assistant integration.</li>'
  '<li><b>Core (server): Home Assistant.</b> Holds booking state, validates the code against the active '
  'booking window, decides open/deny, logs every attempt, triggers the bay (lights/power/door).</li>'
  '<li><b>Source of truth: Convex backend.</b> HA validates against a hardened /door/validate endpoint and '
  'keeps a local offline cache of today\'s valid codes so entry still works if the internet drops.</li>'
  '</ul>')
w(callout("Why not a Raspberry Pi at the door?",
  "For a single-purpose door controller a Pi is usually LESS reliable, not more: a full Linux OS on an SD "
  "card is the #1 field-failure mode (corruption on power loss) &mdash; exactly the failure that locks "
  "customers out. A Pi is right only if the door device itself must do heavy local compute (touchscreen, "
  "camera/ANPR, large offline DB). If a Pi is required, harden it: boot from SSD/eMMC (not SD), read-only "
  "root filesystem (overlayfs), hardware watchdog, and UPS with clean shutdown.", color="#0b7d4f"))

w(f'<h2><font color="{GREEN}">3. Bill of materials (Jaycar AU)</font></h2>')
w('<p><font size="9">Confirmed cat. numbers from Jaycar. Items marked &ldquo;confirm&rdquo; are common '
  'Jaycar lines &mdash; verify the exact cat. no. online/in-store.</font></p>')
bom = [
 ("1","Duinotech ESP32 Main Board (WiFi/BT)","XC3800","1 (+1 spare)","~$30","Edge controller. Keep a pre-flashed spare for instant swap."),
 ("2","12-Key Numeric Keypad (3x4 matrix)","SP0770","1","~$8","0-9, *, #. 7-wire matrix."),
 ("3","4-Channel 5V Relay Module","XC4441","1","~$15","Over-spec: 1 ch strike, spare ch for roller-door/bay. Opto-isolated, 10A."),
 ("4","Electric Door Strike 12VDC, Fail-Secure (narrow)","LA5077","1","~$40","[DECISION] Locked on power loss. See sec.10 egress. Fail-safe alt: LA5079/LA5081."),
 ("5","Non-Contact IR Exit Switch (Request-to-Exit)","LA5187","1","~$30","Touchless egress. Or reuse existing green exit button."),
 ("6","12V regulated PSU (>=2A)","confirm","1","~$30","Powers strike + ESP32 (via buck). Size for strike inrush."),
 ("7","DC-DC Buck Converter (12V to 5V)","XC4514","1","~$10","Feeds ESP32 5V from 12V rail. Or a quality USB supply."),
 ("8","Flyback diode 1N4004 (strike coil)","ZR1004","1","~$1","Across strike coil, protects relay/electronics. Essential."),
 ("9","IP-rated project enclosure","confirm (HB-series)","1","~$20","Houses ESP32 + relay + buck. Keypad on door face."),
 ("10","Wire, ferrules, screw terminals, standoffs","assorted","-","~$20","Use screw terminals (not breadboard) for a permanent install."),
]
widths = [5,27,14,11,9,34]
hdr = ["#","Item","Jaycar Cat.","Qty","AUD","Notes"]
tbl = '<table border="1" width="100%"><thead><tr>'
for wd,h in zip(widths,hdr):
    tbl += f'<th width="{wd}%" bgcolor="#e7f0ec">{h}</th>'
tbl += '</tr></thead><tbody>'
for r in bom:
    tbl += '<tr>' + "".join(f'<td>{escape(c)}</td>' for c in r) + '</tr>'
tbl += '</tbody></table>'
w(tbl)
w('<p><font size="9"><b>Optional over-spec add-ons:</b> small UPS / 12V battery + charger for the door '
  'controller so entry survives a mains blip; buzzer + RGB status LED; door-position reed switch for '
  'held-open / forced-door detection.</font></p>')

w(f'<h2><font color="{GREEN}">4. Wiring &mdash; keypad &amp; relay to ESP32</font></h2>')
w('<p>The SP0770 3x4 keypad uses 7 lines (4 rows + 3 columns). Suggested ESP32 GPIO map (avoids '
  'strapping/boot pins):</p>')
pins = [("Row 1","GPIO 13","Col 1","GPIO 26"),("Row 2","GPIO 12","Col 2","GPIO 25"),
        ("Row 3","GPIO 14","Col 3","GPIO 33"),("Row 4","GPIO 27","Relay IN1 (strike)","GPIO 32"),
        ("Status LED","GPIO 4","Buzzer","GPIO 2"),("Exit switch (REX) in","GPIO 35 (input-only)","Spare relay IN2 (roller)","GPIO 19")]
pt = '<table border="1" width="100%"><thead><tr>'
for h in ["Signal","GPIO","Signal","GPIO"]:
    pt += f'<th width="25%" bgcolor="#e7f0ec">{h}</th>'
pt += '</tr></thead><tbody>'
for r in pins:
    pt += '<tr>' + "".join(f'<td>{escape(c)}</td>' for c in r) + '</tr>'
pt += '</tbody></table>'
w(pt)
w('<p><b>Power/strike path:</b> 12V PSU &rarr; relay common/NO contacts &rarr; door strike &rarr; back to '
  'PSU, with the 1N4004 flyback diode across the strike coil (cathode/band to +12V). 12V PSU &rarr; XC4514 '
  'buck &rarr; 5V &rarr; ESP32. Common ground between ESP32, relay board and buck.</p>')
w(callout("Mains / 12V isolation:",
  "the relay CONTACTS switch the 12V strike circuit; the relay COIL side is opto-isolated from the ESP32. "
  "Keep the 12V door circuit physically separated from logic wiring. Do not switch mains with this board."))

w(f'<h2><font color="{GREEN}">5. ESPHome firmware (edge)</font></h2>')
w('<p>Representative ESPHome config &mdash; scans the keypad, collects a code, hands it to Home Assistant, '
  'and exposes the strike as something HA can pulse:</p>')
w(code_block(
"""esphome:
  name: door-keypad-entry
esp32:
  board: esp32dev
wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password   # static IP recommended
api:                                 # native encrypted HA link
  encryption:
    key: !secret api_key
logger:
ota:

matrix_keypad:
  id: kpad
  rows: { pins: [13, 12, 14, 27] }
  columns: { pins: [26, 25, 33] }
  keys: "123456789*0#"

key_collector:
  - id: code_entry
    source_id: kpad
    min_length: 4
    max_length: 6
    end_key: "#"
    clear_key: "*"
    on_result:
      - homeassistant.event:
          event: esphome.door_code_entered
          data: { code: !lambda 'return x;' }

switch:
  - platform: gpio
    pin: 32
    id: door_strike
    name: "Door Strike"

button:
  - platform: template
    name: "Release Door"
    on_press:
      - switch.turn_on: door_strike
      - delay: 4s
      - switch.turn_off: door_strike"""))
w('<p><font size="9">Validation happens on HA/Convex, not on the ESP32 &mdash; the door device never holds '
  'booking logic, so it cannot be reverse-engineered for codes and stays trivially simple.</font></p>')

w(f'<h2><font color="{GREEN}">6. Home Assistant logic (core)</font></h2>')
w('<ol>'
  '<li>HA listens for esphome.door_code_entered.</li>'
  '<li>HA calls Convex /door/validate with the code (and device auth). On network failure, HA falls back to '
  'its local cache of today\'s valid codes.</li>'
  '<li>If valid and within the booking window, HA presses Release Door on the ESP32 and powers up the '
  'booked bay (reusing the calendar-driven bay automations).</li>'
  '<li>Every attempt (allow/deny) is logged with timestamp and code masked.</li>'
  '</ol>')

w(f'<h2><font color="{GREEN}">7. Backend &mdash; /door/validate endpoint (Convex)</font></h2>')
w('<p>This endpoint does not exist yet (http.ts has only health/auth/Stripe). It must be added:</p>')
w(code_block(
"""POST /door/validate
Headers: X-Door-Token: <shared secret per device>
Body:    { "code": "4821" }

-> 200 { "allow": true,  "bay": "bay_4", "bookingId": "..." }
-> 200 { "allow": false, "reason": "no_active_booking" }
-> 429 { "allow": false, "reason": "rate_limited" }

Server checks:
  - booking exists with this code
  - now within [start - preGrace, end + postGrace]
  - booking is paid and not cancelled
  - device token valid
  - rate-limit / lockout counters OK"""))

w(f'<h2><font color="{GREEN}">8. Backend defects to fix first (security &amp; reliability)</font></h2>')
w(callout("WARNING &mdash; a keypad is only as trustworthy as what it validates against.",
  "access-code.ts currently has issues that make it unsafe to drive a physical door as-is:", color="#b00020"))
w('<ul>'
  '<li><b>Codes live in an in-memory Set (activeCodes).</b> Resets on every redeploy and is not shared '
  'across serverless instances &mdash; invalidateAccessCode() and the 24h setTimeout cleanup will not '
  'reliably work. Fix: store the code on the booking row in the Convex DB, indexed, validated server-side '
  'against the booking time window.</li>'
  '<li><b>4-digit codes = 9,000 combinations</b> &mdash; brute-forceable for physical entry. Fix: enforce '
  'rate-limiting + lockout (e.g. 5 tries then 60s cooldown), keep codes valid only during the booking '
  'window + grace, and consider 6-digit for new bookings.</li>'
  '<li><b>No time-binding at validation.</b> A code must never open the door outside its booking window '
  '&mdash; enforce server-side.</li>'
  '<li><b>Log &amp; alert</b> on repeated failures (possible tampering).</li>'
  '</ul>')
w('<p><font color="#b00020">These are prerequisites, not polish &mdash; schedule them before go-live.</font></p>')

w(f'<h2><font color="{GREEN}">9. Offline / fail-safe behaviour [DECISION]</font></h2>')
w('<ul>'
  '<li><b>Internet down:</b> HA validates against its local cache of today\'s codes; entry still works. '
  'Cache refreshes from Convex every few minutes.</li>'
  '<li><b>HA down:</b> decide whether the door fails locked (secure) or has an attendant override. A small '
  '12V battery keeps ESP32 + strike alive through brief outages.</li>'
  '<li><b>Power-on behaviour:</b> on restore, ESP32 boots in under 1s; relay defaults de-energised (door '
  'locked for a fail-secure strike).</li>'
  '</ul>')

w(f'<h2><font color="{GREEN}">10. Egress &amp; fire-safety compliance &mdash; must confirm</font></h2>')
w(callout("LIFE SAFETY.",
  "A powered entry on an occupied facility carries building-code obligations (NCC/BCA, AS 1428, fire "
  "egress). People inside must ALWAYS be able to exit regardless of power or network state.", color="#b00020"))
w('<ul>'
  '<li><b>Fail-secure vs fail-safe</b> is a safety decision, not just security &mdash; confirm against local '
  'code. Fail-safe strikes (LA5079/LA5081) unlock on power loss; fail-secure (LA5077) stays locked.</li>'
  '<li>Provide free mechanical egress (handle/push-bar) and/or a fail-safe exit path independent of the '
  'electronics. The IR exit switch / green exit button supports request-to-exit but must not be the only '
  'way out.</li>'
  '<li>Have a licensed installer / building surveyor sign off before commissioning.</li>'
  '</ul>')

w(f'<h2><font color="{GREEN}">11. Power &amp; UPS</font></h2>')
w('<p>Tie the door controller into the facility UPS plan. The 12V door rail can run from the UPS-backed '
  'supply (or its own small 12V battery + charger) so a mains blip never locks the door. The HA server '
  'should be on the UPS with BIOS &ldquo;restore on AC power loss = On&rdquo; so the core recovers '
  'automatically after an outage.</p>')

w(f'<h2><font color="{GREEN}">12. Installation steps</font></h2>')
w('<ol>'
  '<li>Bench-build: wire keypad + relay + buck to ESP32 in the enclosure; flash ESPHome; confirm it appears in HA.</li>'
  '<li>Bench-test the full chain (code &rarr; HA &rarr; validate &rarr; relay pulse) before touching the door.</li>'
  '<li>Fit the strike to the door jamb; wire the 12V strike circuit with flyback diode; verify '
  'fail-secure/fail-safe behaviour matches the egress decision.</li>'
  '<li>Mount keypad on the door face, controller enclosure inside, exit switch on the egress side.</li>'
  '<li>Set ESP32 to a static IP; lock down the device token; enable HA logging.</li>'
  '<li>Deploy backend /door/validate + DB code storage + rate-limiting (sec.7-8).</li>'
  '<li>Installer/surveyor egress sign-off, then go live.</li>'
  '</ol>')

w(f'<h2><font color="{GREEN}">13. Commissioning test checklist</font></h2>')
tests = [("Valid code, within booking window","Door releases ~4s; bay powers up; entry logged"),
 ("Valid code, outside booking window","Denied; logged"),
 ("Wrong code x5","Lockout/cooldown triggers; alert raised"),
 ("Internet pulled","Valid code still works via local cache"),
 ("Mains pulled to controller","Strike behaves per egress decision; ESP32 recovers on restore"),
 ("Exit switch / mechanical egress","Always opens from inside, powered or not"),
 ("Cancelled booking code","Denied immediately after cancellation propagates")]
tt = '<table border="1" width="100%"><thead><tr>'
tt += '<th width="42%" bgcolor="#e7f0ec">Test</th>'
tt += '<th width="58%" bgcolor="#e7f0ec">Expected</th></tr></thead><tbody>'
for a,b in tests:
    tt += f'<tr><td>{escape(a)}</td><td>{escape(b)}</td></tr>'
tt += '</tbody></table>'
w(tt)

w(f'<h2><font color="{GREEN}">14. Open decisions before ordering</font></h2>')
w('<ol>'
  '<li>[DECISION] Door hardware: electric strike on a personnel door (this plan) vs triggering the existing '
  'roller-door operator &mdash; or both (spare relay channel reserved).</li>'
  '<li>[DECISION] Single shared entry vs a keypad per bay.</li>'
  '<li>[DECISION] Fail-secure vs fail-safe (driven by sec.10 egress/compliance).</li>'
  '<li>[DECISION] Full offline operation vs brief ride-through only.</li>'
  '<li>[DECISION] Reuse existing green exit button vs new IR exit switch (LA5187).</li>'
  '</ol>')
w('<p><font size="8" color="#555">Krickora keypad entry build plan &mdash; draft for review. Verify all '
  'Jaycar cat. numbers, pricing and stock, and obtain licensed installer / building-surveyor sign-off on '
  'egress and fire compliance before installation. Indicative pricing only.</font></p>')

pdf = FPDF(format="A4")
pdf.set_auto_page_break(auto=True, margin=15)
pdf.set_margins(15, 15, 15)
pdf.add_page()
pdf.set_font("Helvetica", size=10)
content = "".join(H)
for a, b in [("&mdash;", "-"), ("&ndash;", "-"), ("&rarr;", "->"),
             ("&ldquo;", '"'), ("&rdquo;", '"'), ("&lsquo;", "'"),
             ("&rsquo;", "'"), ("&hellip;", "...")]:
    content = content.replace(a, b)
# safety net: drop any remaining non-latin-1 chars (core font limitation)
content = content.encode("latin-1", "replace").decode("latin-1")
pdf.write_html(content)
out = "/home/user/Krickora1/keypad-build-plan.pdf"
pdf.output(out)
print("WROTE", out)
