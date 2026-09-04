import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, getAuthUserSafe, resolveIsAdmin } from "./lib/adminGuard";
import { Id } from "./_generated/dataModel";

// ============================================================================
// GOOGLE CALENDAR TOKEN MUTATIONS (internal - used by googleCalendar.ts)
// ============================================================================

export const saveTokens = internalMutation({
  args: {
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(),
    calendarId: v.string(),
    connectedEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert("googleCalendarTokens", {
      key: "default",
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      expiresAt: args.expiresAt,
      calendarId: args.calendarId,
      connectedEmail: args.connectedEmail,
      connectedAt: new Date().toISOString(),
    });
  },
});

export const getTokens = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
  },
});

export const updateAccessToken = internalMutation({
  args: {
    accessToken: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        accessToken: args.accessToken,
        expiresAt: args.expiresAt,
      });
    }
  },
});

export const deleteTokens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const setCalendarId = internalMutation({
  args: { calendarId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        calendarId: args.calendarId,
      });
    }
  },
});

export const setBookingCalendarEventId = internalMutation({
  args: {
    bookingId: v.string(),
    googleCalendarEventId: v.string(),
  },
  handler: async (ctx, args) => {
    // INT-1 (audit 2026-06): bookingId is always a stringified bookings _id, so a
    // direct get replaces the full-table scan this ran on every calendar create/sync.
    const target = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (target) {
      await ctx.db.patch(target._id, {
        googleCalendarEventId: args.googleCalendarEventId,
      });
    }
  },
});

export const setBookingLaneCalendarEventIds = internalMutation({
  args: {
    bookingId: v.string(),
    eventEntries: v.array(
      v.object({
        laneId: v.string(),
        calendarId: v.string(),
        eventId: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    // INT-1 (audit 2026-06): direct get instead of a full-table scan.
    const target = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (target) {
      const existing = target.googleCalendarEventIds ?? [];
      const merged = [...existing];
      for (const entry of args.eventEntries) {
        const idx = merged.findIndex(e => e.laneId === entry.laneId);
        if (idx >= 0) merged[idx] = entry;
        else merged.push(entry);
      }
      await ctx.db.patch(target._id, {
        googleCalendarEventIds: merged,
      });
    }
  },
});

// SPEC_CALENDAR_SYNC_RELIABILITY_2026-06 — set the booking's calendar sync flag
// (visibility for the reconcile cron / admin). createCalendarEvent calls this after
// its per-lane write loop: 'synced' if the primary event landed, 'failed' otherwise.
export const setBookingCalendarSyncStatus = internalMutation({
  args: { bookingId: v.string(), status: v.string() },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (target) await ctx.db.patch(target._id, { calendarSyncStatus: args.status });
  },
});

// SPEC_CALENDAR_SYNC_RELIABILITY_2026-06 — confirmed bookings in [fromDate, toDate]
// that carry a stored door code, with the fields the reconcile action needs to
// detect a MISSING event (no ids) or re-push a STALE code (compare against GCal).
// Read via the by_date index — never a full scan. athleteSlots are pre-stripped to
// exactly createCalendarEvent's validator shape (raw slots carry athleteId/suburb
// which fail its arg validation — BUGM-4).
export const getReconcileCandidates = internalQuery({
  args: { fromDate: v.string(), toDate: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.gte("date", args.fromDate).lte("date", args.toDate))
      .collect();
    return rows
      .filter((b: any) => b.status === "confirmed" && b.accessCode)
      .map((b: any) => ({
        bookingId: b._id.toString(),
        laneId: b.laneId,
        variantId: b.variantId,
        date: b.date,
        startHour: b.startHour,
        duration: b.duration,
        customerName: b.customerName ?? "Customer",
        customerEmail: b.customerEmail ?? "",
        customerPhone: b.customerPhone,
        isCoachBooking: b.isCoachBooking === true,
        accessCode: b.accessCode as string,
        additionalLaneIds: b.additionalLaneIds,
        laneNameSnapshot: b.laneNameSnapshot,
        variantLabelSnapshot: b.variantLabelSnapshot,
        googleCalendarEventId: b.googleCalendarEventId ?? null,
        googleCalendarEventIds: b.googleCalendarEventIds ?? [],
        // Audit metadata (SPEC_CALENDAR_SYNC_RELIABILITY audit tool): flag what admin
        // touched so the report can answer "are admin-made / admin-modified bookings
        // correctly synced?".
        createdByAdmin: b.createdByAdmin === true,
        modifiedCount: (b.modificationHistory?.length ?? 0),
        calendarSyncStatus: b.calendarSyncStatus ?? null,
        athleteSlots: (b.athleteSlots as any[] | undefined)?.map((s: any) => ({
          athleteName: s.athleteName,
          startHour: s.startHour,
          durationMinutes: s.durationMinutes,
        })),
      }));
  },
});

// SPEC_TEAM_BOOKING_AUTODOOR_2026-07: resolve the EFFECTIVE auto-door flag for a
// booking = booking.autoDoor OR the owning customer's autoDoorDefault. Called by
// createCalendarEvent (always) + updateCalendarEvent (when a bookingId is passed) so
// every event-write path stamps the `🚪 AUTO-DOOR` token consistently — a per-booking
// tick (e.g. Paolo Sat) AND a team-account default (e.g. Balcatta CC) both resolve
// here, so the token is never dropped on a re-sync. Best-effort: returns false if the
// booking/customer can't be found (a missing token just means normal door-code access).
export const getBookingAutoDoor = internalQuery({
  args: { bookingId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    let booking: any = null;
    try {
      booking = await ctx.db.get(args.bookingId as Id<"bookings">);
    } catch {
      return false; // malformed id
    }
    if (!booking) return false;
    if (booking.autoDoor === true) return true;
    const email = (booking.customerEmail as string | undefined)?.toLowerCase().trim();
    if (!email) return false;
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    return customer?.autoDoorDefault === true;
  },
});

// ============================================================================
// C3 (BACKEND review 2026-09-05) — ORPHANED CALENDAR EVENTS
// ============================================================================
// A calendar event that should have been deleted and was not = a live door code
// on an unstaffed building. These rows are the durable record of that: keyed on
// the EVENT (not the booking, which may be hard-deleted in the same mutation),
// retried by the sweep, and pushed to admins until resolved.

/**
 * Dedupe gate for admin alerts. Returns true when the caller should alert, i.e.
 * this key has never fired or last fired longer than `minIntervalMs` ago; stamps
 * the log as a side effect. Unlike the laneDemandMonitor pattern (alert once,
 * ever) this deliberately RE-FIRES on an interval: the 2026-09-01 HA incident was
 * a one-shot alert that was missed at 2pm and went silent for 18 hours while a
 * door sat open. An unresolved door-code orphan must keep asking.
 */
export const claimAdminAlert = internalMutation({
  args: { key: v.string(), minIntervalMs: v.number() },
  handler: async (ctx, args): Promise<boolean> => {
    const now = Date.now();
    const existing = await ctx.db
      .query("adminAlertLog")
      .withIndex("by_key", (q: any) => q.eq("key", args.key))
      .first();
    if (existing) {
      if (now - existing.at < args.minIntervalMs) return false;
      await ctx.db.patch(existing._id, { at: now });
      return true;
    }
    await ctx.db.insert("adminAlertLog", { key: args.key, at: now });
    return true;
  },
});

/** Record (or re-open) an orphaned calendar event. Idempotent per (calendar, event). */
export const recordCalendarOrphan = internalMutation({
  args: {
    calendarId: v.string(),
    eventId: v.string(),
    reason: v.string(),
    bookingId: v.optional(v.string()),
    date: v.optional(v.string()),
    startHour: v.optional(v.number()),
    laneName: v.optional(v.string()),
    customerName: v.optional(v.string()),
    accessCode: v.optional(v.string()),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.eventId) return null; // nothing identifiable to delete
    const now = Date.now();
    const existing = await ctx.db
      .query("calendarOrphanEvents")
      .withIndex("by_event", (q: any) =>
        q.eq("calendarId", args.calendarId).eq("eventId", args.eventId)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "open",
        reason: args.reason,
        lastAttemptAt: now,
        ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
      });
      return existing._id;
    }
    return await ctx.db.insert("calendarOrphanEvents", {
      calendarId: args.calendarId,
      eventId: args.eventId,
      reason: args.reason,
      status: "open",
      attempts: 0,
      firstSeenAt: now,
      lastAttemptAt: now,
      ...(args.bookingId !== undefined ? { bookingId: args.bookingId } : {}),
      ...(args.date !== undefined ? { date: args.date } : {}),
      ...(args.startHour !== undefined ? { startHour: args.startHour } : {}),
      ...(args.laneName !== undefined ? { laneName: args.laneName } : {}),
      ...(args.customerName !== undefined ? { customerName: args.customerName } : {}),
      ...(args.accessCode !== undefined ? { accessCode: args.accessCode } : {}),
      ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
    });
  },
});

export const getOpenCalendarOrphansInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("calendarOrphanEvents")
      .withIndex("by_status", (q: any) => q.eq("status", "open"))
      .take(args.limit ?? 100);
    return rows.map((r: any) => ({
      id: r._id.toString(),
      calendarId: r.calendarId,
      eventId: r.eventId,
      bookingId: r.bookingId ?? null,
      date: r.date ?? null,
      startHour: r.startHour ?? null,
      laneName: r.laneName ?? null,
      customerName: r.customerName ?? null,
      accessCode: r.accessCode ?? null,
      reason: r.reason,
      attempts: r.attempts ?? 0,
      firstSeenAt: r.firstSeenAt,
      lastError: r.lastError ?? null,
    }));
  },
});

export const finishCalendarOrphanAttempt = internalMutation({
  args: {
    id: v.string(),
    resolved: v.boolean(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row: any = await ctx.db.get(args.id as Id<"calendarOrphanEvents">);
    if (!row) return;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      attempts: (row.attempts ?? 0) + 1,
      lastAttemptAt: now,
      status: args.resolved ? "resolved" : "open",
      ...(args.resolved ? { resolvedAt: now } : {}),
      ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
    });
  },
});

/**
 * Retroactive detector for the pre-fix population: bookings in the window that are
 * NO LONGER LIVE but still carry stored calendar event ids. The daily reconcile
 * cannot see these — `getReconcileCandidates` filters `status === "confirmed"`, and
 * a cancelled booking is by definition not confirmed, so nothing has ever looked at
 * them. Whether the event actually survives is then checked against Google (several
 * cancel paths legitimately leave the ids behind after a SUCCESSFUL delete).
 */
export const getCancelledBookingsWithCalendarEvents = internalQuery({
  args: { fromDate: v.string(), toDate: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.gte("date", args.fromDate).lte("date", args.toDate))
      .collect();
    return rows
      .filter(
        (b: any) =>
          (b.status === "cancelled" || b.status === "no_show") &&
          (!!b.googleCalendarEventId || (b.googleCalendarEventIds?.length ?? 0) > 0)
      )
      .map((b: any) => ({
        bookingId: b._id.toString(),
        date: b.date,
        startHour: b.startHour,
        laneId: b.laneId,
        laneName: b.laneNameSnapshot ?? b.laneId,
        customerName: b.customerName ?? "Customer",
        accessCode: b.accessCode ?? null,
        googleCalendarEventId: b.googleCalendarEventId ?? null,
        googleCalendarEventIds: b.googleCalendarEventIds ?? [],
      }));
  },
});

/** Clear the stored event ids once a cancelled booking's events are confirmed gone. */
export const clearBookingCalendarEventIds = internalMutation({
  args: { bookingId: v.string() },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.bookingId as Id<"bookings">);
    if (target) {
      await ctx.db.patch(target._id, {
        googleCalendarEventId: undefined,
        googleCalendarEventIds: undefined,
      });
    }
  },
});

/**
 * Admin-visible list of unresolved orphans (door codes that may still be live).
 * Non-throwing, returns [] for non-admins so any subscriber renders safely.
 */
export const listOpenCalendarOrphans = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthUserSafe(ctx);
    if (!(await resolveIsAdmin(ctx, (user as any)?.email))) return [];
    const rows = await ctx.db
      .query("calendarOrphanEvents")
      .withIndex("by_status", (q: any) => q.eq("status", "open"))
      .take(100);
    return rows.map((r: any) => ({
      _id: r._id,
      calendarId: r.calendarId,
      eventId: r.eventId,
      bookingId: r.bookingId ?? null,
      date: r.date ?? null,
      startHour: r.startHour ?? null,
      laneName: r.laneName ?? null,
      customerName: r.customerName ?? null,
      accessCode: r.accessCode ?? null,
      reason: r.reason,
      attempts: r.attempts ?? 0,
      firstSeenAt: r.firstSeenAt,
      lastAttemptAt: r.lastAttemptAt,
      lastError: r.lastError ?? null,
    }));
  },
});

// ============================================================================
// LANE CALENDAR MAPPING MUTATIONS — ADMIN ONLY
// ============================================================================

export const setLaneCalendarMapping = mutation({
  args: {
    laneId: v.string(),
    calendarId: v.string(),
    calendarName: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("laneCalendarMappings")
      .withIndex("by_laneId", (q: any) => q.eq("laneId", args.laneId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        calendarId: args.calendarId,
        calendarName: args.calendarName,
      });
      return existing._id;
    }
    return await ctx.db.insert("laneCalendarMappings", {
      laneId: args.laneId,
      calendarId: args.calendarId,
      calendarName: args.calendarName,
    });
  },
});

export const removeLaneCalendarMapping = mutation({
  args: { laneId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("laneCalendarMappings")
      .withIndex("by_laneId", (q: any) => q.eq("laneId", args.laneId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

// Admin-only (audit 2026-06-10 security #7): leaks every lane's Google Calendar
// ID. Non-throwing (returns [] for non-admins) so it's safe to subscribe from any
// context; only the admin calendar-settings page needs the data.
export const listLaneCalendarMappings = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthUserSafe(ctx);
    if (!(await resolveIsAdmin(ctx, (user as any)?.email))) return [];
    return await ctx.db.query("laneCalendarMappings").collect();
  },
});

// Internal version for actions
export const getLaneCalendarMappingsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("laneCalendarMappings").collect();
  },
});

// Get all active (non-cancelled) bookings for bulk sync
export const getAllActiveBookings = internalQuery({
  args: {},
  handler: async (ctx) => {
    // INT-7 (audit 2026-06): read only confirmed rows via by_status instead of
    // scanning the entire table (incl. every cancelled/past row) then JS-filtering.
    return await ctx.db
      .query("bookings")
      .withIndex("by_status", (q: any) => q.eq("status", "confirmed"))
      .collect();
  },
});

// ============================================================================
// PUBLIC QUERIES
// ============================================================================

// Admin-only (audit 2026-06-10 security #7): exposes the connected Google account
// email + calendar ID. Non-throwing — returns the disconnected shape for
// non-admins so any subscriber renders safely; only the admin settings page uses it.
export const isConnected = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthUserSafe(ctx);
    if (!(await resolveIsAdmin(ctx, (user as any)?.email))) {
      return { connected: false, email: null, calendarId: null, connectedAt: null };
    }
    const tokens = await ctx.db
      .query("googleCalendarTokens")
      .withIndex("by_key", (q: any) => q.eq("key", "default"))
      .first();
    if (!tokens) return { connected: false, email: null, calendarId: null, connectedAt: null };
    return {
      connected: true,
      email: tokens.connectedEmail,
      calendarId: tokens.calendarId,
      connectedAt: tokens.connectedAt,
    };
  },
});
