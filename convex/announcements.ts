// SPEC_INAPP_BANNERS — admin-managed, dismissable in-app banners / pop-ups shown
// when a targeted user NEXT opens the app. Purely in-app: NO push, NO email
// (that's the OUTBOUND broadcast feature — see convex/broadcast.ts). This is the
// PASSIVE counterpart: "tell them next time they're here."
//
// Audience targeting shares the booking-calendar logic with
// broadcast.resolveBroadcastAudience, but is evaluated PER VIEWER at display time
// (does THIS caller have a confirmed booking in the banner's range?) rather than
// resolving the whole audience up front.
//
// IMPORTANT: the viewer query never reads the clock. Convex queries must be
// deterministic, so Date.now() is unavailable in a query. startAt/endAt window
// filtering therefore happens CLIENT-SIDE in AnnouncementHost (same pattern the
// admin second-factor gate uses — the server returns expiresAt, the client
// decides). The query returns active + audience-matched + (logged-in) not-yet-
// dismissed banners with their window bounds attached.

import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireAdmin, getCallerContext } from "./lib/adminGuard";

const DISPLAY_TYPES = new Set(["banner", "modal"]);
const STYLES = new Set(["info", "notice", "promo"]);
const AUDIENCE_MODES = new Set(["all", "roles", "bookingRange"]);

type ViewerAnnouncement = {
  _id: string;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaTarget?: string;
  displayType: string;
  style: string;
  dismissible: boolean;
  priority: number;
  startAt?: number;
  endAt?: number;
};

// ── Viewer query — active banners this caller should see ──────────────────────
export const listActiveAnnouncementsForViewer = query({
  args: {},
  handler: async (ctx): Promise<ViewerAnnouncement[]> => {
    const active = await ctx.db
      .query("announcements")
      .withIndex("by_active", (q: any) => q.eq("active", true))
      .collect();
    if (active.length === 0) return [];

    // getCallerContext never throws — safe to call on every (incl. logged-out) load.
    const { identity, email } = await getCallerContext(ctx);
    const loggedIn = !!identity && !!email;

    // Caller's customer record (role + _id) — for role + bookingRange matching.
    let me: any = null;
    if (loggedIn) {
      me = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", email))
        .first();
    }
    const myRole: string =
      me?.role === "coach" ? "coach" : me?.role === "admin" ? "admin" : "customer"; // legacy 'user' → customer
    const myId: string | null = (me?._id as unknown as string) ?? null;

    // Dismissed set (logged-in only — logged-out dismissals live in localStorage).
    const dismissed = new Set<string>();
    if (loggedIn) {
      const rows = await ctx.db
        .query("announcementDismissals")
        .withIndex("by_user", (q: any) => q.eq("userId", email))
        .collect();
      for (const r of rows) dismissed.add(r.announcementId as unknown as string);
    }

    // bookingRange matching — the recipient TYPES this viewer qualifies as within a
    // given date range. Scanned once per distinct range (cached). Mirrors
    // broadcast.resolveBroadcastAudience, evaluated for the caller only.
    const rangeCache = new Map<string, Set<string>>();
    const matchedTypesForRange = async (start: string, end: string): Promise<Set<string>> => {
      const key = `${start}|${end}`;
      const cached = rangeCache.get(key);
      if (cached) return cached;
      const types = new Set<string>();
      if (loggedIn && myId) {
        const bookings = await ctx.db
          .query("bookings")
          .withIndex("by_date", (q: any) => q.gte("date", start).lte("date", end))
          .collect();
        const athleteCache = new Map<string, any>();
        for (const b of bookings) {
          if (b.status !== "confirmed") continue;
          const isMine = (b.customerEmail || "").toLowerCase().trim() === email;
          if ((b as any).isCoachBooking) {
            if (isMine) types.add("coach");
          } else {
            if (isMine) types.add("customer");
            if (Array.isArray((b as any).mates)) {
              for (const m of (b as any).mates) {
                if ((m.customerId as unknown as string) === myId) types.add("customer");
              }
            }
          }
          if (Array.isArray((b as any).athleteSlots)) {
            for (const slot of (b as any).athleteSlots) {
              const aid = slot.athleteId as unknown as string | undefined;
              if (!aid) continue;
              let athlete = athleteCache.get(aid);
              if (athlete === undefined) {
                athlete = await ctx.db.get(aid as any);
                athleteCache.set(aid, athlete);
              }
              if (athlete && (athlete.accountCustomerId as unknown as string) === myId) {
                types.add("athlete");
              }
            }
          }
        }
      }
      rangeCache.set(key, types);
      return types;
    };

    const out: ViewerAnnouncement[] = [];
    for (const a of active) {
      if (dismissed.has(a._id as unknown as string)) continue;

      let matches = false;
      if (a.audienceMode === "all") {
        matches = loggedIn || a.includeLoggedOut === true;
      } else if (a.audienceMode === "roles") {
        matches = loggedIn && (a.audienceRoles ?? []).includes(myRole);
      } else if (a.audienceMode === "bookingRange") {
        if (loggedIn && a.rangeStart && a.rangeEnd) {
          const types = await matchedTypesForRange(a.rangeStart, a.rangeEnd);
          if (types.size > 0) {
            const sub = a.audienceRoles ?? [];
            matches = sub.length === 0 ? true : sub.some((t: string) => types.has(t));
          }
        }
      }
      if (!matches) continue;

      out.push({
        _id: a._id as unknown as string,
        title: a.title,
        body: a.body,
        ctaLabel: a.ctaLabel,
        ctaTarget: a.ctaTarget,
        displayType: a.displayType,
        style: a.style,
        dismissible: a.dismissible,
        priority: a.priority,
        startAt: a.startAt,
        endAt: a.endAt,
      });
    }
    out.sort((x, y) => y.priority - x.priority); // highest priority first
    return out;
  },
});

// ── Dismiss (logged-in) — server-side so it sticks across the user's devices ──
export const dismissAnnouncement = mutation({
  args: { announcementId: v.id("announcements") },
  handler: async (ctx, args) => {
    const { email } = await getCallerContext(ctx);
    if (!email) throw new ConvexError("Please sign in to dismiss.");
    const existing = await ctx.db
      .query("announcementDismissals")
      .withIndex("by_user_announcement", (q: any) =>
        q.eq("userId", email).eq("announcementId", args.announcementId)
      )
      .first();
    if (existing) return { ok: true };
    await ctx.db.insert("announcementDismissals", {
      announcementId: args.announcementId,
      userId: email,
      dismissedAt: Date.now(),
    });
    return { ok: true };
  },
});

// ── Admin authoring ──────────────────────────────────────────────────────────
const announcementFields = {
  title: v.string(),
  body: v.string(),
  ctaLabel: v.optional(v.string()),
  ctaTarget: v.optional(v.string()),
  displayType: v.string(),
  style: v.string(),
  audienceMode: v.string(),
  includeLoggedOut: v.optional(v.boolean()),
  audienceRoles: v.optional(v.array(v.string())),
  rangeStart: v.optional(v.string()),
  rangeEnd: v.optional(v.string()),
  startAt: v.optional(v.number()),
  endAt: v.optional(v.number()),
  dismissible: v.optional(v.boolean()),
  priority: v.optional(v.number()),
  active: v.optional(v.boolean()),
};

function validate(args: any) {
  const title = (args.title ?? "").trim();
  const body = (args.body ?? "").trim();
  if (!title || !body) throw new ConvexError("A title and message are required.");
  if (!DISPLAY_TYPES.has(args.displayType)) throw new ConvexError("Invalid display type.");
  if (!STYLES.has(args.style)) throw new ConvexError("Invalid style.");
  if (!AUDIENCE_MODES.has(args.audienceMode)) throw new ConvexError("Invalid audience.");
  if (args.audienceMode === "roles" && (args.audienceRoles ?? []).length === 0) {
    throw new ConvexError("Pick at least one role for a role-targeted banner.");
  }
  if (args.audienceMode === "bookingRange") {
    const s = (args.rangeStart ?? "").trim();
    const e = (args.rangeEnd ?? "").trim();
    if (!s || !e || s > e) throw new ConvexError("Pick a valid booking date range.");
  }
  if (args.startAt != null && args.endAt != null && args.startAt > args.endAt) {
    throw new ConvexError("The active window's start is after its end.");
  }
  return { title, body };
}

// Normalise the writable fields into a single record (shared by create/update).
function buildDoc(args: any, title: string, body: string) {
  return {
    title,
    body,
    ctaLabel: args.ctaLabel?.trim() || undefined,
    ctaTarget: args.ctaTarget?.trim() || undefined,
    displayType: args.displayType,
    style: args.style,
    audienceMode: args.audienceMode,
    includeLoggedOut:
      args.audienceMode === "all" ? args.includeLoggedOut === true : undefined,
    audienceRoles:
      args.audienceMode === "roles" || args.audienceMode === "bookingRange"
        ? args.audienceRoles ?? []
        : undefined,
    rangeStart: args.audienceMode === "bookingRange" ? args.rangeStart?.trim() : undefined,
    rangeEnd: args.audienceMode === "bookingRange" ? args.rangeEnd?.trim() : undefined,
    startAt: args.startAt ?? undefined,
    endAt: args.endAt ?? undefined,
    dismissible: args.dismissible ?? true,
    priority: args.priority ?? 0,
    active: args.active ?? true,
  };
}

export const createAnnouncement = mutation({
  args: announcementFields,
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const { title, body } = validate(args);
    const id = await ctx.db.insert("announcements", {
      createdBy: ((admin as any)._id as string) ?? (admin as any).email ?? "",
      createdByName: (admin as any).name ?? undefined,
      createdAt: Date.now(),
      ...buildDoc(args, title, body),
    });
    return { id };
  },
});

export const updateAnnouncement = mutation({
  args: {
    id: v.id("announcements"),
    resetDismissals: v.optional(v.boolean()), // "show again to everyone" on save
    ...announcementFields,
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("Announcement not found.");
    const { title, body } = validate(args);
    await ctx.db.patch(args.id, buildDoc(args, title, body));
    if (args.resetDismissals) {
      const rows = await ctx.db
        .query("announcementDismissals")
        .withIndex("by_announcement", (q: any) => q.eq("announcementId", args.id))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    return { ok: true };
  },
});

export const setAnnouncementActive = mutation({
  args: { id: v.id("announcements"), active: v.boolean() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("Announcement not found.");
    await ctx.db.patch(args.id, { active: args.active });
    return { ok: true };
  },
});

export const deleteAnnouncement = mutation({
  args: { id: v.id("announcements") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) return { ok: true };
    // Clean up the per-user dismissal rows so they don't orphan.
    const rows = await ctx.db
      .query("announcementDismissals")
      .withIndex("by_announcement", (q: any) => q.eq("announcementId", args.id))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    await ctx.db.delete(args.id);
    return { ok: true };
  },
});

export const duplicateAnnouncement = mutation({
  args: { id: v.id("announcements") },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const src = await ctx.db.get(args.id);
    if (!src) throw new ConvexError("Announcement not found.");
    const { _id, _creationTime, createdBy, createdByName, createdAt, title, active, ...rest } =
      src as any;
    const id = await ctx.db.insert("announcements", {
      ...rest,
      title: `Copy of ${title}`,
      active: false, // duplicates start inactive so they don't show until reviewed
      createdBy: ((admin as any)._id as string) ?? (admin as any).email ?? "",
      createdByName: (admin as any).name ?? undefined,
      createdAt: Date.now(),
    });
    return { id };
  },
});

// Admin list — every announcement + how many users have dismissed it.
export const listAnnouncementsAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const all = await ctx.db.query("announcements").collect();
    all.sort((a, b) => b.createdAt - a.createdAt);
    const withCounts: any[] = [];
    for (const a of all) {
      const dismissals = await ctx.db
        .query("announcementDismissals")
        .withIndex("by_announcement", (q: any) => q.eq("announcementId", a._id))
        .collect();
      withCounts.push({ ...a, dismissCount: dismissals.length });
    }
    return withCounts;
  },
});
