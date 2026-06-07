// SPEC_ANALYTICS_BUILD_2026-06 — shared UI primitives for the admin analytics
// dashboard tabs: date-range picker, CSV export, KPI card, section card, and
// small formatting helpers. Kept dependency-light (recharts is only pulled in by
// the tabs that chart).

import { type ReactNode } from 'react'
import { useQuery } from 'convex/react'

export type DateRange = { from: string; to: string }

export const todayKey = (): string => {
  // AWST "today" (UTC+8) as YYYY-MM-DD, independent of the viewer's clock zone.
  const d = new Date(Date.now() + 8 * 3600000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export const daysAgoKey = (n: number): string => {
  const d = new Date(Date.now() + 8 * 3600000 - n * 86400000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function fmtMoney(n: number | undefined | null): string {
  const v = n ?? 0
  return `$${v.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

export function fmtPct(n: number | undefined | null): string {
  return `${Math.round(n ?? 0)}%`
}

export function fmtMins(n: number | undefined | null): string {
  const v = n ?? 0
  if (v < 1) return `${Math.round(v * 60)}s`
  if (v < 60) return `${v.toFixed(v < 10 ? 1 : 0)} min`
  const h = Math.floor(v / 60)
  const m = Math.round(v % 60)
  return `${h}h${m > 0 ? ` ${m}m` : ''}`
}

// CSV download from a matrix of string cells (first row = header).
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows
    .map((cols) =>
      cols
        .map((c) => {
          const s = String(c ?? '')
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(','),
    )
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const preset = (days: number) => onChange({ from: daysAgoKey(days), to: todayKey() })
  return (
    <div className="flex items-end gap-2 flex-wrap">
      <label className="text-xs text-gray-500">
        From
        <input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })}
          className="block mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm" />
      </label>
      <label className="text-xs text-gray-500">
        To
        <input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })}
          className="block mt-0.5 px-2 py-1.5 border border-gray-200 rounded-lg text-sm" />
      </label>
      <div className="flex gap-1">
        {[7, 30, 90, 365].map((d) => (
          <button key={d} onClick={() => preset(d)}
            className="px-2 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
            {d === 365 ? '1y' : `${d}d`}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Global analytics range + comparison model (2026-06).
// 8 trailing-window presets; sub-day (1h/4h) only offered on event-time panels
// (hidden + clamped to "Day" on date-based panels). Comparison = the same preset
// repeated N consecutive times (e.g. 3m ×4 = the last 12 months as 4 quarters),
// overlaid on time-series charts and shown as KPI deltas; tables show the latest.
// ─────────────────────────────────────────────────────────────────────────────
export type Preset = '1h' | '4h' | 'day' | '7day' | 'month' | '3m' | '6m' | '12m'

export const PRESET_LABEL: Record<Preset, string> = {
  '1h': '1h', '4h': '4h', day: 'Day', '7day': '7 Day', month: 'Month', '3m': '3m', '6m': '6m', '12m': '12m',
}
export const PRESET_MS: Record<Preset, number> = {
  '1h': 3_600_000,
  '4h': 14_400_000,
  day: 86_400_000,
  '7day': 604_800_000,
  month: 2_592_000_000, // 30d
  '3m': 7_776_000_000, // 90d
  '6m': 15_552_000_000, // 180d
  '12m': 31_536_000_000, // 365d
}
export const SUBDAY_PRESETS: Preset[] = ['1h', '4h']
export const DAY_PRESETS: Preset[] = ['day', '7day', 'month', '3m', '6m', '12m']
const isSubDay = (p: Preset) => p === '1h' || p === '4h'

export type AnalyticsRange = {
  preset: Preset
  from: string // YYYY-MM-DD (AWST) — primary window, for date-string queries
  to: string
  fromMs: number // exact ms bounds — for sub-day / event-time queries
  toMs: number
  compare: boolean
  compareCount: number // N periods to overlay (2..6) when compare is on
}

export type Period = { label: string; from: string; to: string; fromMs: number; toMs: number }

// Distinct colours for overlaid comparison series (index 0 = most recent).
export const PERIOD_COLORS = ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#14b8a6']

const keyFromMs = (ms: number): string => {
  const d = new Date(ms + 8 * 3600000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

const labelFromMs = (ms: number): string => {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const d = new Date(ms + 8 * 3600000)
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]}`
}

/** Build a range for a preset, anchored to `nowMs` (captured once, on selection). */
export function rangeFromPreset(preset: Preset, nowMs: number, compare = false, compareCount = 2): AnalyticsRange {
  const toMs = nowMs
  const fromMs = nowMs - PRESET_MS[preset]
  return { preset, fromMs, toMs, from: keyFromMs(fromMs), to: keyFromMs(toMs), compare, compareCount }
}

export const defaultAnalyticsRange = (nowMs: number): AnalyticsRange => rangeFromPreset('3m', nowMs)

/** Clamp sub-day presets to "Day" on date-based panels (pure — keeps toMs stable
 *  so query args don't churn across renders). */
export function clampRange(r: AnalyticsRange, allowSubDay: boolean): AnalyticsRange {
  if (allowSubDay || !isSubDay(r.preset)) return r
  const fromMs = r.toMs - PRESET_MS.day
  return { ...r, preset: 'day', fromMs, from: keyFromMs(fromMs) }
}

/** The window(s) a tab should query: [primary] normally, or N consecutive windows
 *  (most-recent first) in comparison mode. */
export function periodsOf(r: AnalyticsRange): Period[] {
  const len = PRESET_MS[r.preset]
  const n = r.compare ? Math.max(2, Math.min(6, r.compareCount)) : 1
  const out: Period[] = []
  for (let i = 0; i < n; i++) {
    const toMs = r.toMs - i * len
    const fromMs = toMs - len
    out.push({
      label: i === 0 ? 'Current' : `${labelFromMs(fromMs)}`,
      from: keyFromMs(fromMs),
      to: keyFromMs(toMs),
      fromMs,
      toMs,
    })
  }
  return out
}

/**
 * Fire a Convex query once per comparison period. A FIXED number of useQuery slots
 * (6) is used so the rules of hooks are never violated; unused slots are skipped.
 * Returns results aligned to `periods` (index 0 = current period). In non-comparison
 * mode `periods` has length 1, so only slot 0 runs. Use as:
 *   const periods = periodsOf(range)
 *   const results = usePeriodResults(api.x.y, periods, (p) => ({ from: p.from, to: p.to }))
 */
export function usePeriodResults<T = any>(
  queryRef: any,
  periods: Period[],
  argsFor: (p: Period) => any,
): (T | undefined)[] {
  const a = (i: number) => (periods[i] ? argsFor(periods[i]) : 'skip')
  const r0 = useQuery(queryRef, a(0))
  const r1 = useQuery(queryRef, a(1))
  const r2 = useQuery(queryRef, a(2))
  const r3 = useQuery(queryRef, a(3))
  const r4 = useQuery(queryRef, a(4))
  const r5 = useQuery(queryRef, a(5))
  return [r0, r1, r2, r3, r4, r5].slice(0, Math.max(1, periods.length)) as (T | undefined)[]
}

export function AnalyticsRangePicker({
  value, onChange, allowSubDay = true, nowMs,
}: {
  value: AnalyticsRange; onChange: (r: AnalyticsRange) => void; allowSubDay?: boolean; nowMs?: number
}) {
  const presets = allowSubDay ? [...SUBDAY_PRESETS, ...DAY_PRESETS] : DAY_PRESETS
  const setPreset = (p: Preset) => onChange(rangeFromPreset(p, nowMs ?? Date.now(), value.compare, value.compareCount))
  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      <div className="flex gap-1 flex-wrap">
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => setPreset(p)}
            className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
              value.preset === p ? 'bg-gray-900 text-white border-gray-900' : 'text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {PRESET_LABEL[p]}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 pl-2 border-l border-gray-200">
        <button
          onClick={() => onChange({ ...value, compare: !value.compare })}
          title="Overlay several consecutive periods of the selected window"
          className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
            value.compare ? 'bg-violet-600 text-white border-violet-600' : 'text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          ⊕ Compare
        </button>
        {value.compare && (
          <select
            value={value.compareCount}
            onChange={(e) => onChange({ ...value, compareCount: Number(e.target.value) })}
            className="px-1.5 py-1.5 text-xs border border-gray-200 rounded-lg bg-white"
          >
            {[2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>×{n}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

/** KPI card with a delta vs a comparison value (used in comparison mode). */
export function DeltaKpi({
  icon, label, value, prev, format, tone,
}: {
  icon?: string; label: string; value: number; prev?: number
  format: (n: number) => string; tone?: 'emerald' | 'blue' | 'amber' | 'violet' | 'red'
}) {
  const hasPrev = prev !== undefined && prev !== null
  const delta = hasPrev ? value - (prev as number) : 0
  const pct = hasPrev && (prev as number) !== 0 ? (delta / Math.abs(prev as number)) * 100 : null
  const up = delta > 0
  const flat = delta === 0
  const toneBg = tone ? {
    emerald: 'bg-emerald-50', blue: 'bg-blue-50', amber: 'bg-amber-50', violet: 'bg-violet-50', red: 'bg-red-50',
  }[tone] : 'bg-white'
  return (
    <div className={`${toneBg} rounded-2xl border border-gray-200 shadow-sm p-5`}>
      {icon && <div className="text-xl mb-2">{icon}</div>}
      <div className="text-2xl font-bold leading-none text-gray-900">{format(value)}</div>
      <div className="text-xs text-gray-500 mt-1.5 font-medium">{label}</div>
      {hasPrev && (
        <div className={`text-xs mt-1 font-semibold ${flat ? 'text-gray-400' : up ? 'text-emerald-600' : 'text-red-500'}`}>
          {flat ? '±0' : `${up ? '▲' : '▼'} ${format(Math.abs(delta))}`}
          {pct !== null && !flat ? ` (${up ? '+' : '−'}${Math.abs(Math.round(pct))}%)` : ''}
          <span className="text-gray-400 font-normal"> vs prev</span>
        </div>
      )}
    </div>
  )
}

export function KpiCard({
  icon, label, value, sub, valueColor = 'text-gray-900', tone,
}: {
  icon?: string; label: string; value: string; sub?: string; valueColor?: string
  tone?: 'emerald' | 'blue' | 'amber' | 'violet' | 'red'
}) {
  const toneBg = tone ? {
    emerald: 'bg-emerald-50', blue: 'bg-blue-50', amber: 'bg-amber-50', violet: 'bg-violet-50', red: 'bg-red-50',
  }[tone] : 'bg-white'
  return (
    <div className={`${toneBg} rounded-2xl border border-gray-200 shadow-sm p-5`}>
      {icon && <div className="text-xl mb-2">{icon}</div>}
      <div className={`text-2xl font-bold leading-none ${valueColor}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-1.5 font-medium">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  )
}

export function Section({ title, subtitle, action, children }: {
  title: string; subtitle?: string; action?: ReactNode; children: ReactNode
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-gray-800">{title}</h3>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="p-8 text-center text-sm text-gray-400">{label}</div>
}

export function Empty({ label = 'No data for this range yet.' }: { label?: string }) {
  return <div className="p-8 text-center text-sm text-gray-400 italic">{label}</div>
}

// A compact horizontal bar for distribution rows (label · bar · value).
export function BarRow({ label, value, max, suffix, color = 'bg-emerald-500' }: {
  label: string; value: number; max: number; suffix?: string; color?: string
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-32 shrink-0 truncate text-gray-600">{label}</div>
      <div className="flex-1 h-3 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-20 text-right font-medium text-gray-800 tabular-nums">{value}{suffix ?? ''}</div>
    </div>
  )
}
