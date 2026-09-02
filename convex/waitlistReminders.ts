// SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part C2 — the "still waiting?" reminder.
//
// Someone who joined a queue a week ago and has heard nothing is either still
// keen (nothing to do) or has moved on (and is holding a queue place that makes
// the auto alt-time engine offer slots to a dead entry). One weekly push + email
// per PERSON listing every live entry with its queue position, deep-linked to
// the calendar day so they can leave from the green band (U15 sheet).
//
// Eligible entry: waiting · session still ahead · joined at least N days ago ·
// not reminded in the last N days. N = waitlistStillWaitingReminderDays (2).
// Runs DAILY (crons.ts). Entries the reaper has expired never qualify.
//
// ⚠️ Why 2 days and daily, not the spec's "weekly": MEASURED on prod 2026-09-02
// across all 131 waitlist rows — 75% join within 24h of the session, median
// 6.8h, only 9% more than 2 days ahead. The booking horizon is ~a week, so a
// weekly 7-day threshold reached ZERO people. This is a low-volume safety net,
// not a workhorse; the reaper + the auto alt-offer engine do the real work.
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { fmtAwstDateLabel } from "./lib/dates";

const ALL_SENTINELS = ["*", "*bm", "*ru"];
const DEFAULT_DAYS = 2;
const MAX_USERS_PER_RUN = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const statusOf = (e: any): string => e.status ?? "waiting";
const poolLabel = (laneId: string) => (laneId === "*bm" ? "BM" : laneId === "*ru" ? "RU" : "any");

function fmtHour12(h: number): string {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  const period = hr >= 12 ? "PM" : "AM";
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${display}:${min.toString().padStart(2, "0")} ${period}`;
}

/** Read-only planner: who would be reminded right now, and about what. */
export async function planStillWaitingReminders(ctx: any) {
  {
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    if ((settings as any)?.waitlistStillWaitingReminderEnabled === false) return { disabled: true as const, users: [] as any[], liveEntries: 0, now: Date.now() };
    const days = Number((settings as any)?.waitlistStillWaitingReminderDays ?? DEFAULT_DAYS);
    const now = Date.now();
    const awst = new Date(now + 8 * 60 * 60 * 1000);
    const today = awst.toISOString().slice(0, 10);
    const nowHourFrac = awst.getUTCHours() + awst.getUTCMinutes() / 60;
    const cutoff = now - Math.max(1, days) * DAY_MS;

    // All live entries for sessions from today forward, every pool.
    const live: any[] = [];
    for (const sentinel of ALL_SENTINELS) {
      const rows = await ctx.db
        .query("waitlist")
        .withIndex("by_laneId_date", (q: any) => q.eq("laneId", sentinel).gte("date", today))
        .collect();
      for (const e of rows) {
        const st = statusOf(e);
        if (st !== "waiting" && st !== "offered") continue;
        if (e.date === today && e.hour <= nowHourFrac) continue; // session already started
        live.push(e);
      }
    }

    // Queue position = FIFO among live entries sharing the slot; a pool's queue is
    // its sentinel rows + legacy '*' rows (same rule as computeDayPoolPositions).
    const queueOf = (e: any) =>
      live
        .filter((o) => o.date === e.date && o.hour === e.hour && (o.laneId === e.laneId || o.laneId === "*" || e.laneId === "*"))
        .sort((a, b) => a._creationTime - b._creationTime);
    const positionOf = (e: any) => {
      const q = queueOf(e);
      const i = q.findIndex((o) => o._id === e._id);
      return i === -1 ? 1 : i + 1;
    };

    // Eligible = waiting, old enough, not recently reminded. Grouped per person.
    const byUser = new Map<string, any[]>();
    for (const e of live) {
      if (statusOf(e) !== "waiting") continue;
      if (e._creationTime > cutoff) continue;
      if (typeof e.lastStillWaitingReminderAt === "number" && e.lastStillWaitingReminderAt > cutoff) continue;
      const key = String(e.userEmail ?? "").toLowerCase().trim() || e.userId;
      const arr = byUser.get(key) ?? [];
      arr.push(e);
      byUser.set(key, arr);
    }

    const users: Array<{ entries: any[]; items: any[]; url: string; headline: string; more: string }> = [];
    for (const [, entries] of byUser) {
      entries.sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
      const first = entries[0];
      const items = entries.map((e) => ({
        date: e.date,
        dateLabel: fmtAwstDateLabel(e.date),
        time: `${fmtHour12(e.hour)} – ${fmtHour12(e.hour + 1)}`,
        pool: poolLabel(e.laneId),
        position: positionOf(e),
      }));
      const url = `/?wlDay=${first.date}`;
      const headline = `${items[0].dateLabel.split(",")[0]} ${fmtHour12(first.hour)}${items[0].pool !== "any" ? ` (${items[0].pool})` : ""}`;
      const more = items.length > 1 ? ` and ${items.length - 1} more` : "";
      users.push({ entries, items, url, headline, more });
    }
    return { disabled: false as const, users, liveEntries: live.length, now };
  }
}

export const sendStillWaitingReminders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const plan = await planStillWaitingReminders(ctx);
    if (plan.disabled) return { sent: 0, reason: "disabled" };
    const now = plan.now;
    let sent = 0;
    for (const { entries, items, url, headline, more } of plan.users) {
      if (sent >= MAX_USERS_PER_RUN) break;
      const first = entries[0];

      await ctx.scheduler.runAfter(0, internal.push.sendPushInternal, {
        email: first.userEmail,
        category: "waitlist-offers",
        title: "Still waiting? 🏏",
        body: `You're #${items[0].position} in the queue for ${headline}${more}. Still keen? Nothing to do. No longer needed? Tap to leave the queue so it goes to someone else.`,
        url,
        tag: `wl-still-${first.date}`,
      });
      await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistStillWaiting, {
        to: first.userEmail,
        customerName: first.userName,
        items,
        manageUrl: `https://cricketrevolution.com.au${url}`,
      });
      for (const e of entries) await ctx.db.patch(e._id, { lastStillWaitingReminderAt: now });
      sent++;
    }
    return { sent, eligibleUsers: plan.users.length, liveEntries: plan.liveEntries };
  },
});
