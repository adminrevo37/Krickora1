// ============================================================================
// SHARED LANE RESOLVER — SPEC_RECONFIGURABLE_LANES (client copy)
// ============================================================================
// Byte-for-byte mirror of the PURE helpers in convex/lib/lanes.ts (the two build
// roots can't share a module — keep them in sync, same as priceDefaults), PLUS a
// client config store (localStorage-backed singleton, hydrated from the Convex
// listLanes / listLaneOverrides queries by the useLaneConfig hook — mirrors
// settings-store). Synchronous resolver functions read the store so the many
// existing call sites need no prop-drilling.

import { PRICE_DEFAULTS } from './priceDefaults'

export type LaneMode = 'BM' | 'RU'

export interface Segment {
  startHour: number
  endHour: number
  mode: LaneMode
  variants: string[]
}

export interface LaneRow {
  laneId: string
  bayNumber: number
  order: number
  segments: Segment[]
}

export interface LaneOverrideRow {
  laneId: string
  startDate: string
  endDate: string
  segments: Segment[]
}

export const VARIANT_STANDARD = 'standard'
export const VARIANT_TRUMAN = 'truman'
export const VARIANT_RUNUP = 'run-up'

export const DEFAULT_OPEN_HOUR = 7
export const DEFAULT_CLOSE_HOUR = 21

export const DEFAULT_LANE_META: Array<{
  laneId: string
  bayNumber: number
  order: number
  mode: LaneMode
  variants: string[]
}> = [
  { laneId: 'bm1', bayNumber: 1, order: 0, mode: 'BM', variants: [VARIANT_STANDARD] },
  { laneId: 'bm2', bayNumber: 2, order: 1, mode: 'BM', variants: [VARIANT_STANDARD] },
  { laneId: 'bm3', bayNumber: 3, order: 2, mode: 'BM', variants: [VARIANT_STANDARD, VARIANT_TRUMAN] },
  { laneId: 'ru1', bayNumber: 4, order: 3, mode: 'RU', variants: [VARIANT_RUNUP] },
  { laneId: 'ru2', bayNumber: 5, order: 4, mode: 'RU', variants: [VARIANT_RUNUP] },
]

export function defaultLaneRows(openHour = DEFAULT_OPEN_HOUR, closeHour = DEFAULT_CLOSE_HOUR): LaneRow[] {
  return DEFAULT_LANE_META.map((m) => ({
    laneId: m.laneId,
    bayNumber: m.bayNumber,
    order: m.order,
    segments: [{ startHour: openHour, endHour: closeHour, mode: m.mode, variants: m.variants }],
  }))
}

export function overrideCoversDate(o: { startDate: string; endDate: string }, date: string): boolean {
  return date >= o.startDate && date <= o.endDate
}

export function resolveDaySegments(
  laneRow: LaneRow,
  overridesForLane: LaneOverrideRow[],
  date: string
): { segments: Segment[]; isOverride: boolean } {
  const ov = overridesForLane.find((o) => o.laneId === laneRow.laneId && overrideCoversDate(o, date))
  if (ov && ov.segments.length > 0) return { segments: ov.segments, isOverride: true }
  return { segments: laneRow.segments, isOverride: false }
}

export function resolveSegment(segments: Segment[], hour: number): Segment {
  for (const s of segments) {
    if (hour >= s.startHour && hour < s.endHour) return s
  }
  if (segments.length && hour < segments[0].startHour) return segments[0]
  return (
    segments[segments.length - 1] ?? {
      startHour: DEFAULT_OPEN_HOUR,
      endHour: DEFAULT_CLOSE_HOUR,
      mode: 'BM' as LaneMode,
      variants: [VARIANT_STANDARD],
    }
  )
}

export function segmentForBooking(
  segments: Segment[],
  startHour: number,
  durationMinutes: number
): { segment: Segment; crosses: boolean } {
  const endHour = startHour + durationMinutes / 60
  const segment = resolveSegment(segments, startHour)
  const crosses = endHour > segment.endHour + 1e-9
  return { segment, crosses }
}

export function laneIcon(mode: LaneMode): string {
  return mode === 'BM' ? '🏏' : '🏃‍♂️'
}

export function laneName(mode: LaneMode, bayNumber: number): string {
  return `${mode} ${bayNumber}`
}

export function laneHeaderName(bayNumber: number, segments: Segment[]): string {
  const modes = new Set(segments.map((s) => s.mode))
  if (modes.size === 1) return laneName([...modes][0], bayNumber)
  return `Lane ${bayNumber}`
}

export function normalizeVariant(variantId: string | null | undefined): string | null {
  if (!variantId) return null
  if (/truman/i.test(variantId)) return VARIANT_TRUMAN
  if (/run-?up/i.test(variantId)) return VARIANT_RUNUP
  if (/standard/i.test(variantId)) return VARIANT_STANDARD
  return variantId
}

export function variantLabel(variantId: string | null | undefined, soloStandard = false): string {
  const v = normalizeVariant(variantId)
  if (v === VARIANT_TRUMAN) return 'Truman'
  if (v === VARIANT_RUNUP) return '9m Run Up'
  if (v === VARIANT_STANDARD) return soloStandard ? 'Machine' : 'Std'
  return variantId ?? ''
}

export function variantColorKey(variantId: string | null | undefined): 'blue' | 'purple' | 'amber' {
  const v = normalizeVariant(variantId)
  if (v === VARIANT_TRUMAN) return 'purple'
  if (v === VARIANT_RUNUP) return 'amber'
  return 'blue'
}

export interface VariantRateSettings {
  customerPricePerHour?: number | null
  trumanPricePerHour?: number | null
}

export function variantRatePerHour(
  variantId: string | null | undefined,
  settings: VariantRateSettings | null | undefined
): number {
  const base = settings?.customerPricePerHour ?? PRICE_DEFAULTS.customerPerHour
  if (normalizeVariant(variantId) === VARIANT_TRUMAN) {
    return settings?.trumanPricePerHour ?? base
  }
  return base
}

export function buildLaneWarning(
  resolved: { mode: LaneMode; variants: string[] },
  def: { mode: LaneMode; variants: string[] }
): string | null {
  const same =
    resolved.mode === def.mode &&
    resolved.variants.length === def.variants.length &&
    resolved.variants.every((v) => def.variants.includes(v))
  if (same) return null
  const describe = (mode: LaneMode, variants: string[]) =>
    mode === 'RU'
      ? '9m Run-Up'
      : variants.map((v) => variantLabel(v, variants.length === 1)).join(' / ') + ' Bowling Machine'
  return `⚠️ WARNING: Set up as a ${describe(resolved.mode, resolved.variants)} today — not its usual ${describe(
    def.mode,
    def.variants
  )}. Please check before booking.`
}

// ============================================================================
// CLIENT CONFIG STORE — hydrated from Convex by useLaneConfig (mirror of settings-store)
// ============================================================================

export interface LaneConfig {
  lanes: LaneRow[]
  overrides: LaneOverrideRow[]
}

type LaneConfigListener = (cfg: LaneConfig) => void

class LaneConfigStore {
  private cfg: LaneConfig
  private listeners: Set<LaneConfigListener> = new Set()

  constructor() {
    let lanes = defaultLaneRows()
    let overrides: LaneOverrideRow[] = []
    try {
      const saved = localStorage.getItem('rst_lane_config')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed?.lanes) && parsed.lanes.length) lanes = parsed.lanes
        if (Array.isArray(parsed?.overrides)) overrides = parsed.overrides
      }
    } catch {}
    this.cfg = { lanes, overrides }
  }

  get(): LaneConfig {
    return { lanes: this.cfg.lanes, overrides: this.cfg.overrides }
  }

  set(cfg: Partial<LaneConfig>): void {
    this.cfg = {
      lanes: cfg.lanes && cfg.lanes.length ? cfg.lanes : this.cfg.lanes,
      overrides: cfg.overrides ?? this.cfg.overrides,
    }
    try {
      localStorage.setItem('rst_lane_config', JSON.stringify(this.cfg))
    } catch {}
    this.notify()
  }

  subscribe(listener: LaneConfigListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    const snap = this.get()
    this.listeners.forEach((fn) => fn(snap))
  }
}

let instance: LaneConfigStore | null = null
export function getLaneConfigStore(): LaneConfigStore {
  if (!instance) instance = new LaneConfigStore()
  return instance
}

// ---- Store-backed synchronous resolvers (read current config) --------------

function laneRowById(laneId: string): LaneRow {
  const { lanes } = getLaneConfigStore().get()
  return (
    lanes.find((l) => l.laneId === laneId) ??
    defaultLaneRows().find((l) => l.laneId === laneId) ?? {
      laneId,
      bayNumber: DEFAULT_LANE_META.find((m) => m.laneId === laneId)?.bayNumber ?? 0,
      order: 99,
      segments: [],
    }
  )
}

/** Ordered lane rows (the column list). */
export function getLaneRows(): LaneRow[] {
  return [...getLaneConfigStore().get().lanes].sort((a, b) => a.order - b.order)
}

/** Day segments for a lane on a date (override-aware). */
export function getDaySegments(laneId: string, date: string): { segments: Segment[]; isOverride: boolean } {
  const row = laneRowById(laneId)
  const overrides = getLaneConfigStore().get().overrides.filter((o) => o.laneId === laneId)
  return resolveDaySegments(row, overrides, date)
}

/** Resolve the segment governing a (lane, date, hour). */
export function resolveLaneAt(
  laneId: string,
  date: string,
  hour: number
): { mode: LaneMode; name: string; icon: string; variants: string[]; segment: Segment; bayNumber: number } {
  const row = laneRowById(laneId)
  const { segments } = getDaySegments(laneId, date)
  const segment = resolveSegment(segments, hour)
  return {
    mode: segment.mode,
    name: laneName(segment.mode, row.bayNumber),
    icon: laneIcon(segment.mode),
    variants: segment.variants,
    segment,
    bayNumber: row.bayNumber,
  }
}

/** The auto warning for a (lane, date, hour) if it differs from the lane's default. */
export function getLaneWarning(laneId: string, date: string, hour: number): string | null {
  const row = laneRowById(laneId)
  const { segments } = getDaySegments(laneId, date)
  const seg = resolveSegment(segments, hour)
  const def = resolveSegment(row.segments, hour)
  return buildLaneWarning({ mode: seg.mode, variants: seg.variants }, { mode: def.mode, variants: def.variants })
}
