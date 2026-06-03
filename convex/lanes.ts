// ============================================================================
// RECONFIGURABLE LANES — queries, seed migration + server resolver
// (SPEC_RECONFIGURABLE_LANES). The pure helpers live in ./lib/lanes.ts.
// ============================================================================
import { query, mutation, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireAdminUnlocked } from "./lib/adminGuard";
import {
  type LaneRow,
  type LaneOverrideRow,
  type Segment,
  defaultLaneRows,
  resolveDaySegments,
  resolveSegment,
  segmentForBooking,
  laneName,
  variantLabel,
  buildLaneWarning,
  DEFAULT_OPEN_HOUR,
  DEFAULT_CLOSE_HOUR,
  DEFAULT_LANE_META,
} from "./lib/lanes";

const segmentValidator = v.object({
  startHour: v.number(),
  endHour: v.number(),
  mode: v.string(),
  variants: v.array(v.string()),
});

// ----------------------------------------------------------------------------
// Internal read helpers (no auth — lane layout is public booking config, no PII)
// ----------------------------------------------------------------------------

async function getDefaultHours(ctx: any): Promise<{ open: number; close: number }> {
  const settings = await ctx.db
    .query("siteSettings")
    .withIndex("by_key", (q: any) => q.eq("key", "global"))
    .first();
  return {
    open: settings?.openingHour ?? DEFAULT_OPEN_HOUR,
    close: settings?.closingHour ?? DEFAULT_CLOSE_HOUR,
  };
}

/** All lane rows, seeded or not — falls back to defaults so reads never break. */
async function loadLaneRows(ctx: any): Promise<LaneRow[]> {
  const stored = await ctx.db.query("lanes").collect();
  if (stored.length > 0) {
    return [...stored]
      .map((r: any) => ({
        laneId: r.laneId,
        bayNumber: r.bayNumber,
        order: r.order,
        segments: r.segments as Segment[],
      }))
      .sort((a, b) => a.order - b.order);
  }
  const { open, close } = await getDefaultHours(ctx);
  return defaultLaneRows(open, close);
}

/** Default segments for one lane (ignores overrides) — used to derive the warning. */
async function getDefaultSegmentsForLane(ctx: any, laneId: string): Promise<Segment[]> {
  const rows = await loadLaneRows(ctx);
  const row = rows.find((r) => r.laneId === laneId);
  return row?.segments ?? [];
}

/** Overrides whose [startDate,endDate] range covers `date`. */
async function loadOverridesForDate(ctx: any, date: string): Promise<LaneOverrideRow[]> {
  // Index by_startDate gives startDate <= date; filter endDate >= date in memory
  // (override volume is tiny — sparse, only non-standard dates).
  const all = await ctx.db.query("laneOverrides").collect();
  return all
    .filter((o: any) => date >= o.startDate && date <= o.endDate)
    .map((o: any) => ({
      laneId: o.laneId,
      startDate: o.startDate,
      endDate: o.endDate,
      segments: o.segments as Segment[],
    }));
}

/**
 * Resolve the snapshot (lane name + variant label) for a booking at its
 * (date, startHour). Used by createBooking / modifyBooking to denormalise so
 * emails stay correct after layout changes. Returns the resolved segment too.
 */
export async function resolveLaneSnapshot(
  ctx: any,
  laneId: string,
  variantId: string | null | undefined,
  date: string,
  startHour: number
): Promise<{
  laneNameSnapshot: string;
  variantLabelSnapshot: string;
  segment: Segment;
  isOverride: boolean;
}> {
  const rows = await loadLaneRows(ctx);
  const row =
    rows.find((r) => r.laneId === laneId) ??
    ({
      laneId,
      bayNumber: DEFAULT_LANE_META.find((m) => m.laneId === laneId)?.bayNumber ?? 0,
      order: 99,
      segments: defaultLaneRows().find((r) => r.laneId === laneId)?.segments ?? [],
    } as LaneRow);
  const overrides = await loadOverridesForDate(ctx, date);
  const { segments, isOverride } = resolveDaySegments(row, overrides, date);
  const segment = resolveSegment(segments, startHour);
  const soloStandard = segment.variants.length === 1;
  return {
    laneNameSnapshot: laneName(segment.mode, row.bayNumber),
    variantLabelSnapshot: variantLabel(variantId, soloStandard),
    segment,
    isOverride,
  };
}

/**
 * Validate a booking's lane/variant/duration against the resolved config:
 *  - the chosen variant must be offered by the resolved segment at (date, startHour)
 *  - the booking [start, start+duration) must NOT cross a segment boundary (§2.14)
 * Throws ConvexError on violation; returns the governing segment + snapshot otherwise.
 * `skipVariantCheck` (coach/admin paths that don't pick a customer variant) only
 * skips the variant-offered check, never the segment-crossing check.
 */
export async function validateAndSnapshotLane(
  ctx: any,
  args: {
    laneId: string;
    variantId?: string | null;
    date: string;
    startHour: number;
    durationMinutes: number;
    skipVariantCheck?: boolean;
  }
): Promise<{ laneNameSnapshot: string; variantLabelSnapshot: string; segment: Segment }> {
  const rows = await loadLaneRows(ctx);
  const row = rows.find((r) => r.laneId === args.laneId);
  const bayNumber = row?.bayNumber ?? DEFAULT_LANE_META.find((m) => m.laneId === args.laneId)?.bayNumber ?? 0;
  const overrides = await loadOverridesForDate(ctx, args.date);
  const segments = row
    ? resolveDaySegments(row, overrides, args.date).segments
    : defaultLaneRows().find((r) => r.laneId === args.laneId)?.segments ?? [];

  const { segment, crosses } = segmentForBooking(segments, args.startHour, args.durationMinutes);
  if (crosses) {
    throw new ConvexError(
      "This booking would span a lane setup change. Please pick a shorter duration or a different start time."
    );
  }
  // Variant must be offered by the segment (normalise to canonical key for the check).
  if (!args.skipVariantCheck && args.variantId) {
    const normalize = (id: string) =>
      /truman/i.test(id) ? "truman" : /run-?up/i.test(id) ? "run-up" : /standard/i.test(id) ? "standard" : id;
    const chosen = normalize(args.variantId);
    const offered = segment.variants.map(normalize);
    if (!offered.includes(chosen)) {
      throw new ConvexError("That lane setup isn't available at the selected time. Please refresh and try again.");
    }
  }
  const soloStandard = segment.variants.length === 1;
  return {
    laneNameSnapshot: laneName(segment.mode, bayNumber),
    variantLabelSnapshot: variantLabel(args.variantId, soloStandard),
    segment,
  };
}

// ----------------------------------------------------------------------------
// Public queries (lane layout is public booking config)
// ----------------------------------------------------------------------------

export const listLanes = query({
  args: {},
  handler: async (ctx) => {
    return await loadLaneRows(ctx);
  },
});

export const listLaneOverrides = query({
  args: { startDate: v.string(), endDate: v.string() },
  handler: async (ctx, args) => {
    // Overrides intersecting [startDate, endDate].
    const all = await ctx.db.query("laneOverrides").collect();
    return all
      .filter((o: any) => o.startDate <= args.endDate && o.endDate >= args.startDate)
      .map((o: any) => ({
        _id: o._id,
        laneId: o.laneId,
        startDate: o.startDate,
        endDate: o.endDate,
        segments: o.segments,
      }));
  },
});

/**
 * Resolved layout for a single date — every lane's day segments + the auto
 * warning (when it differs from default). Powers the override badge/strip + the
 * customer popup warning. Public (no PII).
 */
export const getLaneLayoutForDate = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    const rows = await loadLaneRows(ctx);
    const overrides = await loadOverridesForDate(ctx, args.date);
    return rows.map((row) => {
      const { segments, isOverride } = resolveDaySegments(row, overrides, args.date);
      // Warning per segment vs the lane default at that segment's start hour.
      const warnings = segments
        .map((seg) => {
          const def = resolveSegment(row.segments, seg.startHour);
          return buildLaneWarning(
            { mode: seg.mode, variants: seg.variants },
            { mode: def.mode, variants: def.variants }
          );
        })
        .filter((w): w is string => !!w);
      return {
        laneId: row.laneId,
        bayNumber: row.bayNumber,
        order: row.order,
        segments,
        isOverride,
        warning: warnings[0] ?? null,
      };
    });
  },
});

// ----------------------------------------------------------------------------
// Admin mutations — default layout (Lanes page) + per-date overrides
// ----------------------------------------------------------------------------

export const updateLaneDefault = mutation({
  args: {
    laneId: v.string(),
    bayNumber: v.optional(v.number()),
    order: v.optional(v.number()),
    segments: v.array(segmentValidator),
  },
  handler: async (ctx, args) => {
    await requireAdminUnlocked(ctx);
    validateSegments(args.segments);
    const meta = DEFAULT_LANE_META.find((m) => m.laneId === args.laneId);
    if (!meta) throw new ConvexError("Unknown lane.");
    const existing = await ctx.db
      .query("lanes")
      .withIndex("by_laneId", (q: any) => q.eq("laneId", args.laneId))
      .first();
    const row = {
      laneId: args.laneId,
      bayNumber: args.bayNumber ?? existing?.bayNumber ?? meta.bayNumber,
      order: args.order ?? existing?.order ?? meta.order,
      segments: args.segments,
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("lanes", row);
    }
    return true;
  },
});

export const upsertLaneOverride = mutation({
  args: {
    laneId: v.string(),
    startDate: v.string(),
    endDate: v.string(),
    segments: v.array(segmentValidator),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdminUnlocked(ctx);
    validateSegments(args.segments);
    if (args.endDate < args.startDate) throw new ConvexError("End date is before start date.");
    // Replace any existing override(s) for this lane that overlap the range, then insert.
    const all = await ctx.db
      .query("laneOverrides")
      .withIndex("by_laneId", (q: any) => q.eq("laneId", args.laneId))
      .collect();
    for (const o of all) {
      if (o.startDate <= args.endDate && o.endDate >= args.startDate) {
        await ctx.db.delete(o._id);
      }
    }
    await ctx.db.insert("laneOverrides", {
      laneId: args.laneId,
      startDate: args.startDate,
      endDate: args.endDate,
      segments: args.segments,
      createdBy: (admin as any)?.email ?? undefined,
      createdAt: new Date().toISOString(),
    });
    return true;
  },
});

export const deleteLaneOverride = mutation({
  args: { id: v.id("laneOverrides") },
  handler: async (ctx, args) => {
    await requireAdminUnlocked(ctx);
    await ctx.db.delete(args.id);
    return true;
  },
});

/** Count active (non-cancelled) bookings on a date for a set of lanes — the
 *  "warn admin if bookings already exist" check for the override modal. */
export const countBookingsOnDate = query({
  args: { date: v.string(), laneIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const dayBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .collect();
    const set = new Set(args.laneIds);
    return dayBookings.filter(
      (b: any) =>
        b.status !== "cancelled" &&
        (set.has(b.laneId) || (b.additionalLaneIds ?? []).some((l: string) => set.has(l)))
    ).length;
  },
});

function validateSegments(
  segments: Array<{ startHour: number; endHour: number; mode: string; variants: string[] }>
): void {
  if (!segments.length) throw new ConvexError("A lane needs at least one segment.");
  const sorted = [...segments].sort((a, b) => a.startHour - b.startHour);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.endHour <= s.startHour) throw new ConvexError("Each segment must end after it starts.");
    if (s.mode !== "BM" && s.mode !== "RU") throw new ConvexError("Mode must be BM or RU.");
    if (s.mode === "BM") {
      const ok = s.variants.length >= 1 && s.variants.every((x) => x === "standard" || x === "truman");
      if (!ok) throw new ConvexError("A bowling-machine segment needs Standard and/or Truman.");
    } else {
      if (!(s.variants.length === 1 && s.variants[0] === "run-up"))
        throw new ConvexError("A run-up segment must offer only 9m Run Up.");
    }
    if (i > 0 && sorted[i].startHour < sorted[i - 1].endHour)
      throw new ConvexError("Segments must not overlap.");
  }
}

// ----------------------------------------------------------------------------
// Idempotent seed — current layout (RU 1/2 relabel to bay 4/5 is the one visible change)
// ----------------------------------------------------------------------------
export const migrateSeedLanes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { open, close } = await getDefaultHours(ctx);
    const rows = defaultLaneRows(open, close);
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const existing = await ctx.db
        .query("lanes")
        .withIndex("by_laneId", (q: any) => q.eq("laneId", row.laneId))
        .first();
      if (existing) {
        skipped++;
        continue;
      }
      await ctx.db.insert("lanes", row);
      inserted++;
    }
    return { inserted, skipped, total: rows.length };
  },
});
