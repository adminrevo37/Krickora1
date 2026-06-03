// ============================================================================
// SHARED LANE RESOLVER — SPEC_RECONFIGURABLE_LANES (server copy)
// ============================================================================
// A lane's config for a day is a list of time SEGMENTS, each
// {startHour, endHour, mode, variants}. The default layout lives in the `lanes`
// table; per-date changes live in `laneOverrides`. Everything that turns a
// laneId + (date, hour) into a name / icon / variant / price resolves through
// here, replacing the ~6 duplicated LANE_NAMES maps + the /truman/ substring hack.
//
// PURE module (no Convex imports) so it can be reused by mutations, queries,
// emails, googleCalendar + analytics. A byte-for-byte mirror lives at
// src/lib/lanes.ts for the client (the two build roots can't share a module —
// keep them in sync, same as priceDefaults).

import { PRICE_DEFAULTS } from "./priceDefaults";

export type LaneMode = "BM" | "RU";

export interface Segment {
  startHour: number; // inclusive (e.g. 7)
  endHour: number; // exclusive (e.g. 12); segments tile the open day, no gaps/overlaps
  mode: LaneMode;
  variants: string[]; // BM → subset of ["standard","truman"] (≥1); RU → ["run-up"]
}

export interface LaneRow {
  laneId: string; // STABLE: "bm1".."ru2" — the GCal/booking/HA contract id
  bayNumber: number; // GLOBAL 1..5, fixed per physical bay
  order: number; // column order in the matrix
  segments: Segment[]; // default daily config; typically one all-day segment
}

export interface LaneOverrideRow {
  laneId: string;
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // inclusive
  segments: Segment[];
}

// Canonical variant ids.
export const VARIANT_STANDARD = "standard";
export const VARIANT_TRUMAN = "truman";
export const VARIANT_RUNUP = "run-up";

// Default open/close used when siteSettings has no value (mirror of the 7–21
// fallback elsewhere). Segments only gate WHICH variant/mode applies at an hour;
// actual bookable hours are still governed by dailyHours / closures.
export const DEFAULT_OPEN_HOUR = 7;
export const DEFAULT_CLOSE_HOUR = 21;

// Current physical layout → global bay numbers (locked decision #1). Run-ups
// relabel RU 1/RU 2 → RU 4/RU 5 on cutover (the one visible change).
export const DEFAULT_LANE_META: Array<{
  laneId: string;
  bayNumber: number;
  order: number;
  mode: LaneMode;
  variants: string[];
}> = [
  { laneId: "bm1", bayNumber: 1, order: 0, mode: "BM", variants: [VARIANT_STANDARD] },
  { laneId: "bm2", bayNumber: 2, order: 1, mode: "BM", variants: [VARIANT_STANDARD] },
  { laneId: "bm3", bayNumber: 3, order: 2, mode: "BM", variants: [VARIANT_STANDARD, VARIANT_TRUMAN] },
  { laneId: "ru1", bayNumber: 4, order: 3, mode: "RU", variants: [VARIANT_RUNUP] },
  { laneId: "ru2", bayNumber: 5, order: 4, mode: "RU", variants: [VARIANT_RUNUP] },
];

/** Build the 5 default lane rows with one all-day segment each. */
export function defaultLaneRows(
  openHour: number = DEFAULT_OPEN_HOUR,
  closeHour: number = DEFAULT_CLOSE_HOUR
): LaneRow[] {
  return DEFAULT_LANE_META.map((m) => ({
    laneId: m.laneId,
    bayNumber: m.bayNumber,
    order: m.order,
    segments: [{ startHour: openHour, endHour: closeHour, mode: m.mode, variants: m.variants }],
  }));
}

/** True when the date falls within an override's inclusive range. */
export function overrideCoversDate(o: { startDate: string; endDate: string }, date: string): boolean {
  return date >= o.startDate && date <= o.endDate;
}

/** The segment list governing a (lane, date): the active override's segments, else the default. */
export function resolveDaySegments(
  laneRow: LaneRow,
  overridesForLane: LaneOverrideRow[],
  date: string
): { segments: Segment[]; isOverride: boolean } {
  const ov = overridesForLane.find((o) => o.laneId === laneRow.laneId && overrideCoversDate(o, date));
  if (ov && ov.segments.length > 0) return { segments: ov.segments, isOverride: true };
  return { segments: laneRow.segments, isOverride: false };
}

/** The segment covering a given hour (falls back to first/last if out of range). */
export function resolveSegment(segments: Segment[], hour: number): Segment {
  for (const s of segments) {
    if (hour >= s.startHour && hour < s.endHour) return s;
  }
  // hour before first / after last → nearest edge segment
  if (segments.length && hour < segments[0].startHour) return segments[0];
  return segments[segments.length - 1] ?? { startHour: DEFAULT_OPEN_HOUR, endHour: DEFAULT_CLOSE_HOUR, mode: "BM", variants: [VARIANT_STANDARD] };
}

/**
 * The segment governing a booking [start, start+duration), plus whether the
 * booking would cross a segment boundary (which is disallowed — §2.14).
 */
export function segmentForBooking(
  segments: Segment[],
  startHour: number,
  durationMinutes: number
): { segment: Segment; crosses: boolean } {
  const endHour = startHour + durationMinutes / 60;
  const segment = resolveSegment(segments, startHour);
  // Crosses if the booking's end runs past the start-segment's end boundary
  // (use a tiny epsilon so a booking ending exactly at endHour does NOT count).
  const crosses = endHour > segment.endHour + 1e-9;
  return { segment, crosses };
}

export function laneIcon(mode: LaneMode): string {
  return mode === "BM" ? "🏏" : "🏃‍♂️";
}

/**
 * The DEFAULT display name for a lane id ("BM 1".."RU 5"), from the seeded layout
 * meta — ignores per-date overrides. Used as the email/calendar/analytics fallback
 * when a booking has no laneNameSnapshot (legacy rows) and as the single source
 * that replaces the ~6 duplicated LANE_NAMES maps.
 */
export function defaultLaneName(laneId: string): string {
  const m = DEFAULT_LANE_META.find((x) => x.laneId === laneId);
  return m ? `${m.mode} ${m.bayNumber}` : laneId.toUpperCase();
}

/** Snapshot-preferring display name for a booking doc (emails read this). */
export function laneNameForBooking(b: { laneId: string; laneNameSnapshot?: string | null }): string {
  return b.laneNameSnapshot || defaultLaneName(b.laneId);
}

export function laneName(mode: LaneMode, bayNumber: number): string {
  return `${mode} ${bayNumber}`;
}

/** Header name for a day: real "BM/RU {n}" if the mode is constant, else "Lane {n}". */
export function laneHeaderName(bayNumber: number, segments: Segment[]): string {
  const modes = new Set(segments.map((s) => s.mode));
  if (modes.size === 1) return laneName([...modes][0], bayNumber);
  return `Lane ${bayNumber}`;
}

/** Normalise a stored/legacy variantId to a canonical variant key. */
export function normalizeVariant(variantId: string | null | undefined): string | null {
  if (!variantId) return null;
  if (/truman/i.test(variantId)) return VARIANT_TRUMAN;
  if (/run-?up/i.test(variantId)) return VARIANT_RUNUP;
  if (/standard/i.test(variantId)) return VARIANT_STANDARD;
  return variantId;
}

/**
 * Display label for a variant. `soloStandard` = a Standard variant shown as the
 * ONLY BM variant in its segment → "Machine"; alongside Truman → "Std".
 */
export function variantLabel(variantId: string | null | undefined, soloStandard = false): string {
  const v = normalizeVariant(variantId);
  if (v === VARIANT_TRUMAN) return "Truman";
  if (v === VARIANT_RUNUP) return "9m Run Up";
  if (v === VARIANT_STANDARD) return soloStandard ? "Machine" : "Std";
  return variantId ?? "";
}

/** Colour key for chips/bands: standard→blue, truman→purple, run-up→amber. */
export function variantColorKey(variantId: string | null | undefined): "blue" | "purple" | "amber" {
  const v = normalizeVariant(variantId);
  if (v === VARIANT_TRUMAN) return "purple";
  if (v === VARIANT_RUNUP) return "amber";
  return "blue";
}

export interface VariantRateSettings {
  customerPricePerHour?: number | null;
  trumanPricePerHour?: number | null;
}

/** Per-hour customer rate for a variant (explicit map — replaces the /truman/ hack). */
export function variantRatePerHour(
  variantId: string | null | undefined,
  settings: VariantRateSettings | null | undefined
): number {
  const base = settings?.customerPricePerHour ?? PRICE_DEFAULTS.customerPerHour;
  if (normalizeVariant(variantId) === VARIANT_TRUMAN) {
    return settings?.trumanPricePerHour ?? base;
  }
  return base;
}

/**
 * Fixed auto-warning (§2.9) shown in red to ALL bookers when a date's resolved
 * config for a lane differs from its default at the booking's hour. No admin
 * free-text. `resolvedMode/resolvedVariants` = what's set for the date;
 * `defaultMode/defaultVariants` = the lane's default at that hour.
 */
export function buildLaneWarning(
  resolved: { mode: LaneMode; variants: string[] },
  def: { mode: LaneMode; variants: string[] }
): string | null {
  const same =
    resolved.mode === def.mode &&
    resolved.variants.length === def.variants.length &&
    resolved.variants.every((v) => def.variants.includes(v));
  if (same) return null;
  const fullVariant = (v: string) => (normalizeVariant(v) === VARIANT_TRUMAN ? "Truman" : "Standard");
  const describe = (mode: LaneMode, variants: string[]) =>
    mode === "RU" ? "9m Run-Up" : variants.map(fullVariant).join(" / ") + " Bowling Machine";
  return `⚠️ WARNING: Set up as a ${describe(resolved.mode, resolved.variants)} today — not its usual ${describe(
    def.mode,
    def.variants
  )}. Please check before booking.`;
}
