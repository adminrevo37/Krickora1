// MACHINE-DEMAND MONITOR — Inspector's decision on lane conversion (2026-09-03):
// "admin must always declare ahead. Have a background monitor for admin: if 2 or
// more people are on a waitlist for a machine for a specific time and there is a
// run-up lane unbooked, send a push notification to admin with the day and time."
// Customers see nothing; conversion itself stays an admin lane override. The
// 12-month review uses the existing waitlist demand analytics.
//
// Event-driven: runs after every waitlist join (self or admin-on-behalf) for the
// BM pool. One alert per (date, hour) — adminAlertLog dedupes.
import { internal } from "./_generated/api";
import { resolveDayLanes, resolveLanesAtHour } from "./lanes";
import { loadDayAvailability, freeLaneIdsAt, type DayLane } from "./waitlistOffers";
import { fmtAwstDateLabel } from "./lib/dates";

const DEFAULT_MIN_WAITERS = 2;

function fmtHour12(h: number): string {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  const period = hr >= 12 ? "pm" : "am";
  const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return min ? `${display}:${String(min).padStart(2, "0")}${period}` : `${display}${period}`;
}

export async function maybeAlertMachineDemand(ctx: any, date: string, hour: number, dryRun = false): Promise<boolean | { waiters: number; minWaiters: number; freeRu: string[]; alreadyAlerted: boolean }> {
  const settings = await ctx.db
    .query("siteSettings")
    .withIndex("by_key", (q: any) => q.eq("key", "global"))
    .first();
  const minWaiters = Math.max(1, Number((settings as any)?.machineDemandAlertMinWaiters ?? DEFAULT_MIN_WAITERS));

  // Live BM waiters at this exact slot (pool sentinel + legacy any-lane rows).
  const rows: any[] = [];
  for (const sentinel of ["*bm", "*"]) {
    rows.push(
      ...(await ctx.db
        .query("waitlist")
        .withIndex("by_slot", (q: any) => q.eq("laneId", sentinel).eq("date", date).eq("hour", hour))
        .collect())
    );
  }
  const waiters = new Set(
    rows
      .filter((e) => { const s = e.status ?? "waiting"; return s === "waiting" || s === "offered"; })
      .map((e) => String(e.userEmail ?? e.userId).toLowerCase())
  );
  if (waiters.size < minWaiters && !dryRun) return false;

  // A run-up lane must be genuinely free for the full hour.
  const [day, dayLanes, lanesAt] = await Promise.all([
    loadDayAvailability(ctx, date),
    resolveDayLanes(ctx, date),
    resolveLanesAtHour(ctx, date, hour),
  ]);
  const freeRu = freeLaneIdsAt(day, dayLanes as DayLane[], hour, "ru");
  const key = `convert-bm-${date}-${hour}`;
  const already = await ctx.db.query("adminAlertLog").withIndex("by_key", (q: any) => q.eq("key", key)).first();
  if (dryRun) return { waiters: waiters.size, minWaiters, freeRu, alreadyAlerted: !!already };
  if (freeRu.length === 0) return false;
  if (already) return false;
  await ctx.db.insert("adminAlertLog", { key, at: Date.now() });

  const ruNames = freeRu.map((id) => lanesAt.find((l) => l.laneId === id)?.name ?? id).join(", ");
  await ctx.scheduler.runAfter(0, internal.push.sendAdminPush, {
    title: "Machine demand — convert a run-up?",
    body: `${waiters.size} people are waitlisted for a bowling machine on ${fmtAwstDateLabel(date)} at ${fmtHour12(hour)}, and ${ruNames} ${freeRu.length === 1 ? "is" : "are"} unbooked then. Set a lane override if you want to convert.`,
    url: "/rev-ops-7k2p",
    tag: key,
  });
  return true;
}
