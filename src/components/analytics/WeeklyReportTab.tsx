// SPEC_WEEKLY_REPORT_2026-06 — printable weekly operations report.
//   A: each coach's sessions / hours / $ billed for the week (coachPrice).
//   B: customer cash revenue per day (Mon–Sun), by session day.
//   C: itemised account-credit + discount usage, with weekly totals.
// "Print / Save as PDF" uses the browser print dialog; a print stylesheet shows
// only the report (#weekly-report-print) on the page.
import { useMemo, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'

// ── Local date helpers (Perth admin → browser-local date is AWST) ──────────
function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + n)
  return ymd(dt)
}
// Monday of the week containing `dateStr`.
function mondayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const dow = dt.getDay() // 0=Sun
  const diffToMon = dow === 0 ? -6 : 1 - dow
  dt.setDate(dt.getDate() + diffToMon)
  return ymd(dt)
}
// The most recently COMPLETED Mon–Sun week (the previous full week).
function lastCompletedMonday(): string {
  return addDays(mondayOf(ymd(new Date())), -7)
}

const money = (n: number | undefined) => `$${(n ?? 0).toFixed(2)}`
// Account balance: > 0 = coach owes (amber), < 0 = coach in credit (green).
function balanceCell(n: number | undefined) {
  const v = n ?? 0
  if (v > 0) return <span className="text-amber-700 font-semibold">{money(v)}</span>
  if (v < 0) return <span className="text-emerald-700">{money(v)} cr</span>
  return <span className="text-gray-400">$0.00</span>
}
function prettyDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}
function fmtHour(h: number): string {
  const whole = Math.floor(h)
  const mins = Math.round((h - whole) * 60)
  const period = whole >= 12 ? 'pm' : 'am'
  const disp = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole
  return mins > 0 ? `${disp}:${String(mins).padStart(2, '0')}${period}` : `${disp}${period}`
}

export default function WeeklyReportTab() {
  const [weekStart, setWeekStart] = useState<string>(() => lastCompletedMonday())
  const report = useQuery(api.analyticsAdmin.getWeeklyReport, { weekStart })

  const isCurrentOrFuture = useMemo(() => weekStart >= mondayOf(ymd(new Date())), [weekStart])

  return (
    <div className="space-y-4">
      {/* ── Controls (not printed) ──────────────────────────────────────── */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWeekStart((w) => addDays(w, -7))}
            className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-sm font-semibold"
          >‹ Prev week</button>
          <div className="text-sm font-semibold text-gray-700 min-w-[230px] text-center">
            {prettyDate(weekStart)} – {prettyDate(addDays(weekStart, 6))}
          </div>
          <button
            onClick={() => setWeekStart((w) => addDays(w, 7))}
            disabled={isCurrentOrFuture}
            className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
          >Next week ›</button>
          <button
            onClick={() => setWeekStart(lastCompletedMonday())}
            className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-sm font-semibold"
          >Last full week</button>
        </div>
        <button
          onClick={() => window.print()}
          className="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800"
        >🖨️ Print / Save as PDF</button>
      </div>

      {/* Print stylesheet — show ONLY the report on the page when printing. */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #weekly-report-print, #weekly-report-print * { visibility: visible !important; }
          #weekly-report-print { position: absolute; left: 0; top: 0; width: 100%; padding: 0; margin: 0; }
          .no-print { display: none !important; }
          .wr-avoid-break { break-inside: avoid; }
          @page { margin: 14mm; size: A4; }
        }
      `}</style>

      {report === undefined && <div className="p-12 text-center text-sm text-gray-400">Loading…</div>}
      {report === null && <div className="p-12 text-center text-sm text-gray-400">Admin only.</div>}

      {report && (
        <div id="weekly-report-print" className="bg-white text-gray-900 text-[13px] leading-snug">
          {/* Header */}
          <div className="mb-5 flex items-end justify-between border-b-2 border-gray-900 pb-3">
            <div>
              <div className="text-xl font-extrabold tracking-tight">Cricket Revolution — Weekly Report</div>
              <div className="text-gray-600">
                {prettyDate(report.weekStart)} – {prettyDate(report.weekEnd)} (Mon–Sun)
              </div>
            </div>
            <div className="text-right text-[11px] text-gray-500">
              Generated {new Date().toLocaleString('en-AU')}
            </div>
          </div>

          {/* Summary band */}
          <div className="grid grid-cols-4 gap-3 mb-6 wr-avoid-break">
            {[
              { label: 'Coach billings', value: money(report.coachTotal.chargesThisWeek), sub: `${report.coachTotal.sessions} sessions · ${report.coachTotal.hours} hrs` },
              { label: 'Customer cash', value: money(report.customerTotal.cash), sub: `${report.customerTotal.sessions} sessions` },
              { label: 'Account credit used', value: money(report.customerTotal.creditUsed), sub: `${report.creditItems.length} session(s)` },
              { label: 'Discounts given', value: money(report.customerTotal.discountGiven), sub: `${report.discountItems.length} session(s)` },
            ].map((c) => (
              <div key={c.label} className="rounded-xl border border-gray-200 p-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-500">{c.label}</div>
                <div className="text-lg font-extrabold">{c.value}</div>
                <div className="text-[11px] text-gray-500">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* A — Coaches */}
          <Section title="A · Coach bookings & account balances this week">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left border-b border-gray-300">
                  <Th>Coach</Th><Th right>Sessions</Th><Th right>Hours</Th>
                  <Th right>Opening bal</Th><Th right>Charges (wk)</Th><Th right>Payments (wk)</Th><Th right>Closing bal</Th>
                </tr>
              </thead>
              <tbody>
                {report.coaches.length === 0 && (
                  <tr><td colSpan={7} className="py-3 text-gray-400 text-center">No coach activity this week.</td></tr>
                )}
                {report.coaches.map((c) => (
                  <tr key={c.email || c.name} className="border-b border-gray-100">
                    <Td>{c.name}</Td>
                    <Td right>{c.sessions}</Td>
                    <Td right>{c.hours}</Td>
                    <Td right>{balanceCell(c.openingBalance)}</Td>
                    <Td right>{c.chargesThisWeek !== 0 ? money(c.chargesThisWeek) : '—'}</Td>
                    <Td right>{c.paymentsThisWeek > 0 ? money(c.paymentsThisWeek) : '—'}</Td>
                    <Td right>{balanceCell(c.closingBalance)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-900 font-bold">
                  <Td>Total</Td>
                  <Td right>{report.coachTotal.sessions}</Td>
                  <Td right>{report.coachTotal.hours}</Td>
                  <Td right>{balanceCell(report.coachTotal.openingBalance)}</Td>
                  <Td right>{money(report.coachTotal.chargesThisWeek)}</Td>
                  <Td right>{money(report.coachTotal.paymentsThisWeek)}</Td>
                  <Td right>{balanceCell(report.coachTotal.closingBalance)}</Td>
                </tr>
              </tfoot>
            </table>
            <div className="text-[11px] text-gray-500 mt-1">
              Each row reads as a mini-statement: <strong>Opening bal + Charges (wk) − Payments (wk) = Closing bal</strong>. Opening bal = carried-forward balance as at Monday (a credit shows green, e.g. “$12.50 cr”). Charges (wk) = the coach's sessions dated in THIS Mon–Sun week — including any late-cancellation charges (a late-cancelled coach session is still billed) and any statement adjustment dated this week. A session (incl. a multi-lane block) shows in the week it falls on, so earlier sessions sit in the opening balance and future ones aren't charged until they occur. Owing shown in amber.
            </div>
          </Section>

          {/* B — Daily customer revenue */}
          <Section title="B · Customer revenue by day">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left border-b border-gray-300">
                  <Th>Day</Th><Th right>Sessions</Th><Th right>Cash collected</Th><Th right>Credit used</Th><Th right>Discounts</Th>
                </tr>
              </thead>
              <tbody>
                {report.days.map((d) => (
                  <tr key={d.date} className="border-b border-gray-100">
                    <Td>{d.dayName} <span className="text-gray-400">· {prettyDate(d.date)}</span></Td>
                    <Td right>{d.sessions}</Td>
                    <Td right>{money(d.cash)}</Td>
                    <Td right>{d.creditUsed > 0 ? money(d.creditUsed) : '—'}</Td>
                    <Td right>{d.discountGiven > 0 ? money(d.discountGiven) : '—'}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-900 font-bold">
                  <Td>Total</Td>
                  <Td right>{report.customerTotal.sessions}</Td>
                  <Td right>{money(report.customerTotal.cash)}</Td>
                  <Td right>{money(report.customerTotal.creditUsed)}</Td>
                  <Td right>{money(report.customerTotal.discountGiven)}</Td>
                </tr>
              </tfoot>
            </table>
            <div className="text-[11px] text-gray-500 mt-1">
              Cash = actual money collected (Stripe net of credit/discount); offline-paid admin bookings included. Credit/discounts are shown separately, not as cash.
            </div>
          </Section>

          {/* C — Credits & discounts itemised */}
          <Section title="C · Credits & discounts used">
            {report.creditItems.length === 0 && report.discountItems.length === 0 ? (
              <div className="py-2 text-gray-400">No account credit or discount codes were used this week.</div>
            ) : (
              <div className="space-y-4">
                {report.creditItems.length > 0 && (
                  <div className="wr-avoid-break">
                    <div className="font-semibold mb-1">Account credit applied</div>
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="text-left border-b border-gray-300">
                          <Th>Date</Th><Th>Customer</Th><Th>Session</Th><Th right>Credit</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.creditItems.map((it, i) => (
                          <tr key={i} className="border-b border-gray-100">
                            <Td>{prettyDate(it.date)}</Td>
                            <Td>{it.customerName}</Td>
                            <Td>{it.lane} · {fmtHour(it.startHour)}</Td>
                            <Td right>{money(it.amount)}</Td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-gray-900 font-bold">
                          <Td>Total credit used</Td><Td></Td><Td></Td>
                          <Td right>{money(report.customerTotal.creditUsed)}</Td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
                {report.discountItems.length > 0 && (
                  <div className="wr-avoid-break">
                    <div className="font-semibold mb-1">Discount codes</div>
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="text-left border-b border-gray-300">
                          <Th>Date</Th><Th>Customer</Th><Th>Code</Th><Th>Session</Th><Th right>Discount</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.discountItems.map((it, i) => (
                          <tr key={i} className="border-b border-gray-100">
                            <Td>{prettyDate(it.date)}</Td>
                            <Td>{it.customerName}</Td>
                            <Td><span className="font-mono uppercase">{it.code}</span></Td>
                            <Td>{it.lane} · {fmtHour(it.startHour)}</Td>
                            <Td right>{money(it.amount)}</Td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-gray-900 font-bold">
                          <Td>Total discounts given</Td><Td></Td><Td></Td><Td></Td>
                          <Td right>{money(report.customerTotal.discountGiven)}</Td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 wr-avoid-break">
      <div className="text-sm font-extrabold uppercase tracking-wide text-gray-800 mb-2 bg-gray-100 px-2 py-1 rounded">{title}</div>
      {children}
    </div>
  )
}
function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`py-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 ${right ? 'text-right' : 'text-left'}`}>{children}</th>
}
function Td({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <td className={`py-1.5 px-1 ${right ? 'text-right tabular-nums' : 'text-left'}`}>{children}</td>
}
