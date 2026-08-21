// SPEC_COACH_LEDGER_UNIFICATION_2026-08 Phase 5 — the two named balances.
//
// One component for both statement views (the admin's CoachStatementTable and the
// coach's own /statements page) so the wording cannot differ between them. The figures
// come from `computeCoachBalancePair`, i.e. two calls to the one balance function.
//
// Why two figures at all: the system was already computing both — the admin badge
// answering "what is owed now", the weekly report answering "what will be owed on
// Sunday" — and presenting them as if they were the same number. They are two
// legitimate questions. Naming them is the fix.
import type { CoachLedger } from '../lib/statementLedger'

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`

/** "Sun 24 Aug" from a YYYY-MM-DD key. */
function shortDate(key: string): string {
  if (!key) return ''
  const d = new Date(`${key}T00:00:00`)
  if (Number.isNaN(d.getTime())) return key
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
}

export default function CoachBalancePanel({ ledger }: { ledger: CoachLedger }) {
  const owing = ledger.balance > 0.005
  const tone = owing
    ? { box: 'bg-amber-50 border-amber-200', figure: 'text-amber-700', muted: 'text-amber-700/70' }
    : { box: 'bg-emerald-50 border-emerald-200', figure: 'text-emerald-700', muted: 'text-emerald-700/70' }

  const label = ledger.balance < -0.005 ? 'Balance today (in credit)' : 'Balance today'
  const rest = ledger.restOfWeek

  return (
    <div className={`border rounded-xl p-5 col-span-2 ${tone.box}`}>
      <div className="text-xs uppercase font-semibold text-gray-600 mb-1">{label}</div>
      <div className={`text-3xl font-bold ${tone.figure}`}>{money(ledger.balance)}</div>
      <div className="text-xs text-gray-500 mt-1">
        Includes today's sessions, even if they haven't started yet.
      </div>
      <div className="text-xs text-gray-500 mt-1">
        {money(ledger.totalBooked)}
        {ledger.totalAdjust !== 0 && (
          <> {ledger.totalAdjust >= 0 ? '+' : '−'} {money(Math.abs(ledger.totalAdjust))} adj</>
        )}{' '}
        booked − {money(ledger.totalPaid)} paid
      </div>

      {/* Rule 4: on Sunday the two figures are necessarily the same, so don't print
          the same number twice — say why they've merged instead. */}
      {ledger.isWeekEnd ? (
        <div className="mt-3 pt-3 border-t border-black/10 text-xs text-gray-600">
          It's the last day of the week, so the end-of-week balance is the same figure.
        </div>
      ) : (
        <div className="mt-3 pt-3 border-t border-black/10">
          <div className="text-xs uppercase font-semibold text-gray-500">
            Balance end of week{ledger.weekEndKey ? ` (to ${shortDate(ledger.weekEndKey)})` : ''}
          </div>
          <div className={`text-lg font-semibold ${tone.muted}`}>{money(ledger.balanceEndOfWeek)}</div>
          <div className="text-xs text-gray-500 mt-0.5 space-y-0.5">
            {/* Say what the difference is actually made of. A negative delta has more
                than one possible cause, so naming only the commonest one (the weekly
                cap credit) would be a confidently wrong explanation the rest of the
                time. */}
            {rest.booked > 0.005 && (
              <div>
                {money(rest.booked)} still to come — the rest of this week's booked sessions. Not
                owed yet.
              </div>
            )}
            {rest.adjust < -0.005 && (
              <div>
                {money(Math.abs(rest.adjust))} of credit is dated before the week closes (a weekly
                billing cap credit lands on the last day of the week).
              </div>
            )}
            {rest.adjust > 0.005 && <div>{money(rest.adjust)} of adjustments dated later this week.</div>}
            {rest.paid > 0.005 && <div>{money(rest.paid)} of payments dated later this week.</div>}
            {Math.abs(ledger.balanceDelta) <= 0.005 &&
              rest.booked <= 0.005 &&
              Math.abs(rest.adjust) <= 0.005 &&
              rest.paid <= 0.005 && <div>Nothing further booked this week.</div>}
          </div>
        </div>
      )}
    </div>
  )
}
