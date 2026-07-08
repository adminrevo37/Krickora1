// SPEC_CLUB_TEAM_BOOKINGS_2026-07 — client-side PDF export for a club/team.
// Builds the club's upcoming session schedule (dates/times/lane/door code, optional
// prices + paid status) then APPENDS the hosted 3-page facility-access guide into one
// downloadable PDF. Pure browser (pdf-lib) — no server round-trip, no external hosts.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

export interface ClubSession {
  date: string // YYYY-MM-DD
  startHour: number
  duration: number
  laneLabel: string
  accessCode: string
  priceInCents: number
  paymentStatus: string
}

const A4 = { w: 595.28, h: 841.89 }
const MARGIN = 40
const RED = rgb(0.85, 0.12, 0.12)
const INK = rgb(0.1, 0.1, 0.12)
const GREY = rgb(0.45, 0.45, 0.5)
const LINE = rgb(0.8, 0.8, 0.82)
const AMBER = rgb(0.72, 0.45, 0.02)

function fmtTime(hour: number): string {
  const whole = Math.floor(hour)
  const mins = Math.round((hour - whole) * 60)
  const period = whole >= 12 ? 'PM' : 'AM'
  const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole
  return mins > 0 ? `${display}:${String(mins).padStart(2, '0')} ${period}` : `${display} ${period}`
}
function fmtRange(startHour: number, duration: number): string {
  const end = startHour + duration / 60
  // Keep the period on the end only when both share it, else show both.
  return `${fmtTime(startHour).replace(/ (AM|PM)$/, (m, p) => (Math.floor(startHour) < 12) === (Math.floor(end) < 12) ? '' : ` ${p}`)}–${fmtTime(end)}`
}
function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
function trunc(font: PDFFont, text: string, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1)
  return t + '…'
}

export async function exportClubSchedulePdf(opts: {
  clubName: string
  sessions: ClubSession[]
  includePrices: boolean
  generatedDate?: Date
}): Promise<void> {
  const { clubName, sessions, includePrices } = opts
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const genLabel = (opts.generatedDate ?? new Date()).toLocaleDateString('en-AU', {
    day: 'numeric', month: 'long', year: 'numeric',
  })

  // Column layout (x positions in pt). Two shapes: with / without prices.
  const cols = includePrices
    ? { date: 40, time: 140, lane: 235, laneW: 150, door: 392, price: 470, priceRight: 505, status: 512 }
    : { date: 40, time: 165, lane: 285, laneW: 215, door: 505, price: 0, priceRight: 0, status: 0 }

  let page!: PDFPage
  let y = 0
  const ROW_H = 20

  const newPage = (withHeader: boolean) => {
    page = doc.addPage([A4.w, A4.h])
    y = A4.h - MARGIN
    if (withHeader) {
      page.drawText('CRICKET REVOLUTION', { x: MARGIN, y, size: 9, font: bold, color: RED })
      y -= 22
      page.drawText(`${clubName} — Session Schedule`, { x: MARGIN, y, size: 18, font: bold, color: INK })
      y -= 18
      page.drawText(`Generated ${genLabel}${includePrices ? '' : ' · upcoming sessions'}`, { x: MARGIN, y, size: 9, font, color: GREY })
      y -= 24
      // Door-code / auto-door note box
      page.drawRectangle({ x: MARGIN, y: y - 26, width: A4.w - 2 * MARGIN, height: 32, color: rgb(0.96, 0.97, 1) })
      page.drawText('Entry: the roller door opens automatically ~15 min before each session and closes ~5 min after it starts.', { x: MARGIN + 8, y: y - 6, size: 8.5, font, color: INK })
      page.drawText('If you arrive outside that window, enter the door code on the keypad then press #.', { x: MARGIN + 8, y: y - 18, size: 8.5, font, color: INK })
      y -= 44
    }
    // Column header row
    page.drawText('Date', { x: cols.date, y, size: 8.5, font: bold, color: GREY })
    page.drawText('Time', { x: cols.time, y, size: 8.5, font: bold, color: GREY })
    page.drawText('Lane(s)', { x: cols.lane, y, size: 8.5, font: bold, color: GREY })
    page.drawText('Door', { x: cols.door, y, size: 8.5, font: bold, color: GREY })
    if (includePrices) {
      page.drawText('Price', { x: cols.price, y, size: 8.5, font: bold, color: GREY })
      page.drawText('Status', { x: cols.status, y, size: 8.5, font: bold, color: GREY })
    }
    y -= 6
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 0.75, color: LINE })
    y -= 14
  }

  newPage(true)

  if (sessions.length === 0) {
    page.drawText('No upcoming sessions.', { x: MARGIN, y, size: 11, font, color: GREY })
    y -= ROW_H
  }

  let total = 0
  let outstanding = 0
  for (const s of sessions) {
    if (y < MARGIN + 40) newPage(false)
    total += s.priceInCents
    const unpaid = s.paymentStatus === 'unpaid'
    if (unpaid) outstanding += s.priceInCents
    page.drawText(fmtDate(s.date), { x: cols.date, y, size: 9.5, font, color: INK })
    page.drawText(fmtRange(s.startHour, s.duration), { x: cols.time, y, size: 9.5, font, color: INK })
    page.drawText(trunc(font, s.laneLabel, 9.5, cols.laneW), { x: cols.lane, y, size: 9.5, font, color: INK })
    page.drawText(s.accessCode, { x: cols.door, y, size: 9.5, font: bold, color: INK })
    if (includePrices) {
      const p = money(s.priceInCents)
      page.drawText(p, { x: cols.priceRight - font.widthOfTextAtSize(p, 9.5), y, size: 9.5, font, color: INK })
      page.drawText(unpaid ? 'Unpaid' : 'Paid', { x: cols.status, y, size: 9, font: bold, color: unpaid ? AMBER : rgb(0.1, 0.55, 0.25) })
    }
    y -= ROW_H
  }

  // Totals (prices mode)
  if (includePrices && sessions.length > 0) {
    if (y < MARGIN + 50) newPage(false)
    y -= 4
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 0.75, color: LINE })
    y -= 16
    const totalLabel = `Total: ${money(total)}`
    page.drawText(totalLabel, { x: A4.w - MARGIN - bold.widthOfTextAtSize(totalLabel, 11), y, size: 11, font: bold, color: INK })
    y -= 16
    if (outstanding > 0) {
      const outLabel = `Outstanding (unpaid): ${money(outstanding)}`
      page.drawText(outLabel, { x: A4.w - MARGIN - bold.widthOfTextAtSize(outLabel, 11), y, size: 11, font: bold, color: AMBER })
      y -= 16
    }
  }

  // Footer on the last schedule page
  page.drawText('Cricket Revolution · 78 Jones St, Stirling WA · Facility access guide follows.', {
    x: MARGIN, y: MARGIN - 12, size: 8, font, color: GREY,
  })

  // ── Append the hosted 3-page facility-access guide ────────────────────────
  try {
    const res = await fetch('/facility-access.pdf', { cache: 'no-store' })
    if (res.ok) {
      const bytes = await res.arrayBuffer()
      const facility = await PDFDocument.load(bytes)
      const pages = await doc.copyPages(facility, facility.getPageIndices())
      pages.forEach((p) => doc.addPage(p))
    } else {
      console.error('facility-access.pdf fetch failed', res.status)
    }
  } catch (e) {
    console.error('Could not append facility guide', e)
  }

  const out = await doc.save()
  // Uint8Array → Blob download. Slice to a fresh ArrayBuffer for strict Blob typings.
  const blob = new Blob([out.slice().buffer], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${clubName.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}-sessions.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
