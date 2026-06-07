/**
 * Live admin booking feed (2026-06).
 *
 * An append-only log of booking lifecycle events (created / modified / cancelled)
 * for the admin "Live Feed" analytics tab. This is the ONLY place the self-service
 * modify before→after diff is persisted — the bookings table has no updatedAt and
 * no scalar change history for the customer/coach modify path, so a dedicated
 * event table is required (see the 2026-06 analytics understanding pass).
 *
 * Events are emitted from the booking mutations via `recordBookingEvent`:
 *   - createBooking / repeatCoachBooking  → 'created'
 *   - applyBookingChange (modify choke point, covers self-service + Stripe top-up) → 'modified'
 *   - cancelBooking                       → 'cancelled'
 * The feed reads newest-first via the by_at index and is reactive (useQuery).
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./lib/adminGuard";

export type BookingSnap = {
  date: string;
  startHour: number;
  duration: number;
  lane: string;
  variant?: string;
};

/**
 * Append a booking lifecycle event. Best-effort: feed logging must never throw out
 * of (and roll back) a real booking mutation, so failures are swallowed + logged.
 */
export async function recordBookingEvent(
  ctx: any,
  args: {
    type: "created" | "modified" | "cancelled";
    bookingId: string;
    customerName: string;
    actorName?: string;
    isCoachBooking?: boolean;
    before?: BookingSnap;
    after?: BookingSnap;
  }
): Promise<void> {
  try {
    await ctx.db.insert("bookingEvents", {
      at: Date.now(),
      type: args.type,
      bookingId: args.bookingId,
      customerName: args.customerName || "Unknown",
      ...(args.actorName ? { actorName: args.actorName } : {}),
      ...(args.isCoachBooking !== undefined ? { isCoachBooking: args.isCoachBooking } : {}),
      ...(args.before ? { before: args.before } : {}),
      ...(args.after ? { after: args.after } : {}),
    });
  } catch (e) {
    console.error("recordBookingEvent failed:", e);
  }
}

/**
 * Admin live feed — newest events first. Reactive via useQuery; the client renders
 * the date + exact time, customer name, and (for modifications) old vs new inline.
 */
export const getRecentBookingEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    return await ctx.db
      .query("bookingEvents")
      .withIndex("by_at")
      .order("desc")
      .take(limit);
  },
});
