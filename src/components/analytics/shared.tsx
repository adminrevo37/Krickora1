// SPEC_ANALYTICS_BUILD_2026-06 — shared UI primitives for the admin analytics
// dashboard tabs: date-range picker, CSV export, KPI card, section card, and
// small formatting helpers. Kept dependency-light (recharts is only pulled in by
// the tabs that chart).

import { type ReactNode } from 'react'

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
