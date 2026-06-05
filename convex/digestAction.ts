// SPEC_PUSH_NOTIFICATIONS_V2 §6.2 — hourly admin digest.
// A cron (crons.ts "admin-hourly-digest", on the hour) calls sendAdminHourlyDigest,
// which reads the PREVIOUS clock hour's activity and pushes every admin a single
// counts summary — but only during AWST venue operating hours, and never when all
// three counts are zero (no empty pings). Replaces the old per-booking admin push.

import { internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const HOUR_MS = 60 * 60 * 1000;
const AWST_OFFSET_MS = 8 * HOUR_MS; // AWST = UTC+8, whole-hour offset
const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

// Count the previous full hour's new accounts / bookings / coach-adds, plus an
// operating-hours gate. Returns { skip: true } outside operating hours.
export const getAdminHourlyDigestData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const end = Math.floor(now / HOUR_MS) * HOUR_MS; // top of the current UTC hour
    const start = end - HOUR_MS; // top of the previous hour

    // The hour being reported, in AWST wall-clock.
    const awst = new Date(start + AWST_OFFSET_MS);
    const awstHour = awst.getUTCHours();
    const awstDay = awst.getUTCDay();

    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    let open = settings?.openingHour ?? 9;
    let close = settings?.closingHour ?? 21;
    const dh = (settings?.dailyHours ?? []).find((d: any) => d.day === DAY_NAMES[awstDay]);
    if (dh) {
      if (dh.closed) return { skip: true as const };
      open = dh.open;
      close = dh.close;
    }
    if (!(awstHour >= open && awstHour < close)) return { skip: true as const };

    // New accounts (customers.createdAt is an ISO string).
    const customers = await ctx.db.query("customers").collect();
    const newAccounts = customers.filter((c: any) => {
      const t = Date.parse(c.createdAt ?? "");
      return Number.isFinite(t) && t >= start && t < end;
    }).length;

    // New bookings (createdAt ms; legacy rows have none → naturally excluded).
    const newBookings = (
      await ctx.db
        .query("bookings")
        .withIndex("by_createdAt", (q: any) => q.gte("createdAt", start).lt("createdAt", end))
        .collect()
    ).length;

    // Customers who added ≥1 coach (distinct accounts among the hour's events).
    const events = await ctx.db
      .query("coachLinkEvents")
      .withIndex("by_at", (q: any) => q.gte("at", start).lt("at", end))
      .collect();
    const addedCoach = new Set(events.map((e: any) => e.accountId.toString())).size;

    return { skip: false as const, newAccounts, newBookings, addedCoach };
  },
});

export const sendAdminHourlyDigest = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sent: boolean; reason?: string }> => {
    const d = await ctx.runQuery(internal.digestAction.getAdminHourlyDigestData, {});
    if (d.skip) return { sent: false, reason: "outside operating hours" };
    if (d.newAccounts === 0 && d.newBookings === 0 && d.addedCoach === 0) {
      return { sent: false, reason: "all-zero" };
    }
    const parts: string[] = [];
    if (d.newBookings) parts.push(`${d.newBookings} new booking${d.newBookings !== 1 ? "s" : ""}`);
    if (d.newAccounts) parts.push(`${d.newAccounts} new account${d.newAccounts !== 1 ? "s" : ""}`);
    if (d.addedCoach) parts.push(`${d.addedCoach} added a coach`);
    await ctx.runAction(internal.push.sendAdminPush, {
      title: "📊 Last hour",
      body: `${parts.join(" · ")}.`,
      url: "/admin",
      tag: "admin-digest",
    });
    return { sent: true };
  },
});
