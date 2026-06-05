import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Lane ID to display name mapping (matches src/lib/booking-data.ts)
const LANE_NAMES: Record<string, string> = {
  bm1: "Bowling Machine 1",
  bm2: "Bowling Machine 2",
  bm3: "Bowling Machine 3",
  ru1: "9m Run Up 1",
  ru2: "9m Run Up 2",
};

export function getLaneName(laneId: string): string {
  return LANE_NAMES[laneId] ?? laneId;
}

export function formatHourToTime(hour: number): string {
  const whole = Math.floor(hour);
  const mins = Math.round((hour - whole) * 60);
  const period = whole >= 12 ? "PM" : "AM";
  const displayHour = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
  return `${displayHour}:${mins.toString().padStart(2, "0")} ${period}`;
}

export function formatDuration(minutes: number): string {
  if (minutes === 60) return "1 hour";
  if (minutes === 90) return "1.5 hours";
  if (minutes === 30) return "30 minutes";
  const hrs = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (remainMins === 0) return `${hrs} hour${hrs !== 1 ? "s" : ""}`;
  return `${hrs}h ${remainMins}m`;
}

// Get all confirmed bookings happening within the next ~6 hours that haven't been reminded
export const getBookingsNeedingReminder = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Get current time in AWST (UTC+8)
    const now = new Date();
    const awstOffset = 8 * 60 * 60 * 1000;
    const awstNow = new Date(now.getTime() + awstOffset + now.getTimezoneOffset() * 60 * 1000);

    const todayStr = `${awstNow.getFullYear()}-${String(awstNow.getMonth() + 1).padStart(2, "0")}-${String(awstNow.getDate()).padStart(2, "0")}`;
    
    // Also check tomorrow in case it's late evening and bookings are early morning
    const tomorrow = new Date(awstNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

    const todayBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", todayStr))
      .collect();

    const tomorrowBookings = await ctx.db
      .query("bookings")
      .withIndex("by_date", (q: any) => q.eq("date", tomorrowStr))
      .collect();

    const allBookings = [...todayBookings, ...tomorrowBookings];

    const currentHourAWST = awstNow.getHours() + awstNow.getMinutes() / 60;

    const needsReminder = allBookings.filter((b) => {
      // Only confirmed bookings
      if (b.status !== "confirmed") return false;
      // Skip if already reminded
      if (b.reminderSent) return false;
      // Must have a customer email
      if (!b.customerEmail) return false;

      // Calculate hours until booking
      const [bYear, bMonth, bDay] = b.date.split("-").map(Number);
      const bookingDate = new Date(bYear, bMonth - 1, bDay);
      const awstDate = new Date(awstNow.getFullYear(), awstNow.getMonth(), awstNow.getDate());
      
      // Days difference
      const daysDiff = (bookingDate.getTime() - awstDate.getTime()) / (1000 * 60 * 60 * 24);
      
      let hoursUntil: number;
      if (daysDiff === 0) {
        // Same day
        hoursUntil = b.startHour - currentHourAWST;
      } else if (daysDiff === 1) {
        // Tomorrow
        hoursUntil = (24 - currentHourAWST) + b.startHour;
      } else {
        return false; // Too far away
      }

      // SPEC_PUSH_NOTIFICATIONS_V2 §3.1 — fire ~22 min before the booking. The
      // cron runs every 5 min (§3.2), so a tight 18–24 min window (0.30–0.40 h)
      // is hit reliably exactly once; the reminderSent guard prevents repeats.
      return hoursUntil >= 0.3 && hoursUntil <= 0.4;
    });

    return needsReminder.map((b) => ({
      id: b._id,
      customerEmail: b.customerEmail,
      customerName: b.customerName,
      laneId: b.laneId,
      laneName: getLaneName(b.laneId),
      date: b.date,
      startHour: b.startHour,
      duration: b.duration,
      timeSlot: formatHourToTime(b.startHour),
      durationLabel: formatDuration(b.duration),
      accessCode: b.accessCode ?? "",
    }));
  },
});

// Mark a booking as reminder sent
export const markReminderSent = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.bookingId, { reminderSent: true });
  },
});
