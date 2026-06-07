/**
 * Equipment / facility fault reports (SPEC_ADMIN_AND_SETTINGS #5).
 *
 * Any signed-in user can submit an issue (lane + details + optional photo).
 * Reports land in the admin inbox; the admin triages them (resolve / dismiss /
 * note) and decides separately whether to create a laneBlock — faults never
 * auto-block a lane.
 */
import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";
import { enforceRateLimit } from "./lib/rateLimit";

// M3 (SEC audit 2026-06-03) limits.
const MAX_DETAILS_LEN = 2000; // chars — a fault note, not an essay
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

// Photo upload — returns a short-lived URL the client POSTs the file to.
// Any signed-in user may upload (the report mutation validates the rest).
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Sign in to attach a photo.");
    // M3: throttle upload-URL minting — each grants a writable storage slot.
    await enforceRateLimit(
      ctx,
      { action: "fault-upload-url", identifier: identity.subject, max: 10, windowMs: 60_000 },
      "Too many uploads — please wait a minute and try again."
    );
    return await ctx.storage.generateUploadUrl();
  },
});

export const submitFaultReport = mutation({
  args: {
    laneId: v.optional(v.string()),
    category: v.optional(v.string()),
    details: v.string(),
    photoStorageId: v.optional(v.id("_storage")),
    bookingId: v.optional(v.string()), // §6 — set when reported from a booking
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    // M3: a fault report lands in the admin inbox and can carry an uploaded
    // photo — require sign-in (matches the documented "any signed-in user"
    // intent) so anonymous scripts can't flood it, and rate-limit per caller.
    if (!identity) throw new ConvexError("Please sign in to report a fault.");
    await enforceRateLimit(
      ctx,
      { action: "fault-submit", identifier: identity.subject, max: 5, windowMs: 60_000 },
      "Too many reports — please wait a minute and try again."
    );

    const details = args.details.trim();
    if (!details) throw new ConvexError("Please describe the issue.");
    if (details.length > MAX_DETAILS_LEN) {
      throw new ConvexError(`Please keep the description under ${MAX_DETAILS_LEN} characters.`);
    }

    // M3: validate any attached photo is actually an image within the size cap
    // before it's referenced from a report (the upload URL accepts any bytes).
    if (args.photoStorageId) {
      const meta = await ctx.db.system.get(args.photoStorageId);
      if (!meta) throw new ConvexError("Attached photo not found — please re-upload.");
      if (meta.size > MAX_PHOTO_BYTES) {
        throw new ConvexError("Photo is too large (max 10 MB).");
      }
      if (!meta.contentType || !meta.contentType.startsWith("image/")) {
        throw new ConvexError("Attachment must be an image.");
      }
    }

    let reportedByName: string | undefined;
    let reportedByMobile: string | undefined;
    const reportedByEmail = identity?.email?.toLowerCase().trim();
    if (reportedByEmail) {
      const customer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", reportedByEmail))
        .first();
      reportedByName = customer?.name ?? (identity?.name as string | undefined);
      reportedByMobile = customer?.phone?.trim() || undefined;
    }

    // §6 — if reported from a specific booking, pull its session info for the admin.
    let sessionInfo = "";
    if (args.bookingId) {
      let booking: any = null;
      try {
        booking = await ctx.db.get(args.bookingId as any);
      } catch {
        booking = null; // not a valid booking id — skip session enrichment
      }
      if (booking) {
        const b = booking as any;
        const lane = b.laneNameSnapshot ?? b.laneId ?? "";
        const hr = Math.floor(b.startHour);
        const mn = Math.round((b.startHour - hr) * 60);
        const t = `${((hr % 12) || 12)}:${String(mn).padStart(2, "0")}${hr >= 12 ? "pm" : "am"}`;
        sessionInfo = `${lane} ${b.date} ${t}`.trim();
      }
    }

    const reportId = await ctx.db.insert("faultReports", {
      laneId: args.laneId,
      category: args.category,
      details,
      photoStorageId: args.photoStorageId,
      bookingId: args.bookingId,
      reportedByEmail,
      reportedByName,
      status: "open",
      createdAt: new Date().toISOString(),
    });

    // SPEC_MOBILE_BOOKING_UPDATES §6 — admin push carries who (+ mobile), the
    // session it relates to, and a note excerpt for quick triage.
    const who = `${reportedByName ?? "Someone"}${reportedByMobile ? ` (${reportedByMobile})` : " (no mobile on file)"}`;
    const where = sessionInfo || args.laneId || "general";
    await ctx.scheduler.runAfter(0, internal.push.sendAdminPush, {
      title: "🛠️ New issue reported",
      body: `${who} · ${where}: ${details.slice(0, 100)}`,
      url: "/rev-ops-7k2p",
      tag: `fault-${reportId.toString()}`,
    });

    // SPEC fault-report (2026-06): also EMAIL the full report + a link to the photo
    // to the ops inbox. Push alone was unreliable (VAPID/device-subscription gated,
    // best-effort) — the email is the durable backstop. Fixed address, internal ops
    // alert (not prefs-gated); best-effort via the scheduler.
    const photoUrl = args.photoStorageId
      ? await ctx.storage.getUrl(args.photoStorageId)
      : null;
    const a = new Date(Date.now() + 8 * 3600000); // AWST wall-clock
    const hh = a.getUTCHours();
    const t12 = `${(hh % 12) || 12}:${String(a.getUTCMinutes()).padStart(2, "0")}${hh >= 12 ? "pm" : "am"}`;
    const createdAtLabel = `${a.getUTCDate()}/${a.getUTCMonth() + 1}/${a.getUTCFullYear()} ${t12} AWST`;
    await ctx.scheduler.runAfter(0, internal.emails.sendFaultReportEmail, {
      to: "admin@revolutionsports.com.au",
      reporterName: reportedByName ?? "Someone",
      reporterEmail: reportedByEmail ?? "",
      reporterMobile: reportedByMobile ?? "",
      laneId: args.laneId ?? "",
      category: args.category ?? "",
      sessionInfo,
      where,
      details,
      photoUrl: photoUrl ?? "",
      createdAtLabel,
    });

    return reportId;
  },
});

// Admin inbox — newest first, with resolved photo URLs.
export const listFaultReports = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    let reports = await ctx.db.query("faultReports").withIndex("by_createdAt").order("desc").collect();
    if (args.status) reports = reports.filter((r) => r.status === args.status);
    return await Promise.all(
      reports.map(async (r) => ({
        ...r,
        photoUrl: r.photoStorageId ? await ctx.storage.getUrl(r.photoStorageId) : null,
      }))
    );
  },
});

// Badge count of open reports for the admin sidebar.
export const countOpenFaultReports = query({
  args: {},
  handler: async (ctx) => {
    const caller = await ctx.auth.getUserIdentity();
    if (!caller) return 0;
    const email = caller.email?.toLowerCase().trim() ?? "";
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (customer?.role !== "admin") return 0;
    const open = await ctx.db
      .query("faultReports")
      .withIndex("by_status", (q: any) => q.eq("status", "open"))
      .collect();
    return open.length;
  },
});

export const updateFaultReportStatus = mutation({
  args: {
    id: v.id("faultReports"),
    status: v.string(), // 'open' | 'resolved' | 'dismissed'
    adminNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const patch: Record<string, any> = { status: args.status };
    if (args.adminNote !== undefined) patch.adminNote = args.adminNote;
    if (args.status === "resolved" || args.status === "dismissed") {
      patch.resolvedAt = new Date().toISOString();
      patch.resolvedByEmail = (admin as any)?.email ?? undefined;
    } else {
      patch.resolvedAt = undefined;
      patch.resolvedByEmail = undefined;
    }
    await ctx.db.patch(args.id, patch);
    return args.id;
  },
});
