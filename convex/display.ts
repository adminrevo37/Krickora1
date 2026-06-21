// ============================================================================
// PUBLIC TV LANE-STATUS DISPLAY  (facility "which lane is mine?" board)
// ----------------------------------------------------------------------------
// A read-only, UNAUTHENTICATED board for a TV inside the building: today's
// bookings per lane (who's on now + who's next) with customer names so arriving
// people know which lane is theirs.
//
// SECURITY: guarded by a 25-char secret token carried IN THE URL
// (/display/<token>). The token is checked HERE, server-side, before any booking
// data is returned — so the data endpoint is protected too, not just the page.
// DISPLAY_TOKEN lives only in this server module; it is NEVER shipped in the
// client bundle. Rotate it by changing the constant + redeploying.
// Built 2026-06-16 — see cricket/lane-display/CLAUDE.md.
// ============================================================================
import { query } from "./_generated/server";
import { v } from "convex/values";
import {
  defaultLaneRows,
  resolveDaySegments,
  laneHeaderName,
  overrideCoversDate,
  DEFAULT_OPEN_HOUR,
  DEFAULT_CLOSE_HOUR,
  type LaneRow,
  type LaneOverrideRow,
  type Segment,
} from "./lib/lanes";

// Whoever holds the full /display/<token> URL can view the board. 25 random
// chars => unguessable; effectively the password. Change here + redeploy to rotate.
const DISPLAY_TOKEN = "1jjmuCmarm6juZXsU2mY9BJti";

// Privacy: the board is a public TV screen, so it shows only first name + last
// initial (e.g. "Dean H.") for BOTH customers AND coaches. The full surname is
// truncated HERE, server-side, so it never reaches the public client/network.
// NB the board intentionally carries NO athlete/allocation info — coach bookings
// show only the coach's short name + "Coaching", never any child/athlete detail.
function shortName(full: unknown): string {
  const s = String(full ?? "").trim();
  if (!s) return "Booked";
  const parts = s.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${parts[0]} ${lastInitial}.`;
}

/** Lane layout rows for the board (seeded `lanes` table, else defaults). */
async function loadLaneRowsForDisplay(ctx: any): Promise<LaneRow[]> {
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
  const settings = await ctx.db
    .query("siteSettings")
    .withIndex("by_key", (q: any) => q.eq("key", "global"))
    .first();
  return defaultLaneRows(
    settings?.openingHour ?? DEFAULT_OPEN_HOUR,
    settings?.closingHour ?? DEFAULT_CLOSE_HOUR
  );
}

/**
 * Today's per-lane booking board for the TV display. `date` is supplied by the
 * client (Perth/AWST YYYY-MM-DD) so the board rolls over correctly at midnight.
 * Returns { ok:false } for a wrong/absent token (page shows an "invalid link"
 * message, never booking data). Confirmed bookings only.
 */
export const getLaneDisplay = query({
  args: { token: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    if (args.token !== DISPLAY_TOKEN) {
      return { ok: false as const };
    }
    const date = args.date;

    const rows = await loadLaneRowsForDisplay(ctx);
    const allOverrides = await ctx.db.query("laneOverrides").collect();
    const overrides: LaneOverrideRow[] = allOverrides
      .filter((o: any) => overrideCoversDate(o, date))
      .map((o: any) => ({
        laneId: o.laneId,
        startDate: o.startDate,
        endDate: o.endDate,
        segments: o.segments as Segment[],
      }));

    // Single indexed read of the day's bookings; show confirmed only.
    const dayBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", date))
      .collect();
    const active = dayBookings.filter((b: any) => b.status === "confirmed");

    const lanes = rows.map((row) => {
      const { segments } = resolveDaySegments(row, overrides, date);
      const name = laneHeaderName(row.bayNumber, segments);
      const bookings = active
        .filter(
          (b: any) =>
            b.laneId === row.laneId ||
            (b.additionalLaneIds ?? []).includes(row.laneId)
        )
        .map((b: any) => ({
          name: shortName(b.customerName),
          startHour: b.startHour as number,
          endHour: (b.startHour as number) + (b.duration as number) / 60,
          isCoach: b.isCoachBooking === true,
        }))
        .sort((a, b) => a.startHour - b.startHour);
      return {
        laneId: row.laneId,
        bayNumber: row.bayNumber,
        order: row.order,
        name,
        mode: segments[0]?.mode ?? "BM",
        bookings,
      };
    });

    return { ok: true as const, date, lanes };
  },
});
