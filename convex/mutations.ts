import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin } from "./lib/adminGuard";

// ============================================================================
// BOOKING MUTATIONS
// ============================================================================

// Create a new booking
export const createBooking = mutation({
  args: {
    laneId: v.string(),
    variantId: v.optional(v.string()),
    date: v.string(),
    startHour: v.number(),
    duration: v.number(),
    customerName: v.string(),
    customerEmail: v.string(),
    customerPhone: v.optional(v.string()),
    userId: v.optional(v.string()),
    status: v.string(),
    stripeSessionId: v.optional(v.string()),
    isCoachBooking: v.optional(v.boolean()),
    coachPrice: v.optional(v.number()),
    additionalLaneIds: v.optional(v.array(v.string())),
    athleteSlots: v.optional(
      v.array(
        v.object({
          athleteName: v.string(),
          startHour: v.number(),
          durationMinutes: v.number(),
          accessCode: v.optional(v.string()),
          codeGeneratedAt: v.optional(v.string()),
        })
      )
    ),
    creditApplied: v.optional(v.number()),
    accessCode: v.optional(v.string()),
    discountCode: v.optional(v.string()),
    tentativeSourceId: v.optional(v.string()),
    tentativeForDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const siteSettings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const CLOSING_HOUR = siteSettings?.closingHour ?? 21;
    const endHour = args.startHour + args.duration / 60;
    if (endHour > CLOSING_HOUR) {
      throw new Error("Booking extends past closing time.");
    }
    if (args.duration < 60) {
      throw new Error("Minimum booking duration is 1 hour.");
    }
    // dedupe marker

    // Reject bookings on closed dates
    const closure = await ctx.db
      .query("closures")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .first();
    if (closure) {
      throw new Error(`Facility is closed on this date${closure.reason ? `: ${closure.reason}` : "."}`);
    }

    // Check for conflicts on all lanes
    const allLaneIds = [args.laneId, ...(args.additionalLaneIds ?? [])];
    for (const lid of allLaneIds) {
      const laneBookings = await ctx.db
        .query("bookings")
        .withIndex("by_laneId_date", (q: any) =>
          q.eq("laneId", lid).eq("date", args.date)
        )
        .collect();

      const hasConflict = laneBookings.some((b) => {
        if (b.status === "cancelled") return false;
        const bEnd = b.startHour + b.duration / 60;
        return args.startHour < bEnd && endHour > b.startHour;
      });

      if (hasConflict) {
        throw new Error(
          "This slot is no longer available. Please choose another time."
        );
      }

      // Check against lane service/repair blocks
      const laneBlocks = await ctx.db
        .query("laneBlocks")
        .withIndex("by_laneId_date", (q: any) =>
          q.eq("laneId", lid).eq("date", args.date)
        )
        .collect();
      const hasBlockConflict = laneBlocks.some((b) => {
        const bEnd = b.startHour + b.duration / 60;
        return args.startHour < bEnd && endHour > b.startHour;
      });
      if (hasBlockConflict) {
        throw new Error("This lane is blocked for service/repair during this time.");
      }
    }

    // For coach bookings, all assigned athletes share the coach's access code
    const normalizedAthleteSlots = args.athleteSlots && args.isCoachBooking && args.accessCode
      ? args.athleteSlots.map((s) => ({
          ...s,
          accessCode: args.accessCode,
          codeGeneratedAt: s.codeGeneratedAt ?? new Date().toISOString(),
        }))
      : args.athleteSlots;

    const id = await ctx.db.insert("bookings", {
      laneId: args.laneId,
      variantId: args.variantId,
      date: args.date,
      startHour: args.startHour,
      duration: args.duration,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      customerPhone: args.customerPhone,
      userId: args.userId,
      status: args.status,
      stripeSessionId: args.stripeSessionId,
      isCoachBooking: args.isCoachBooking,
      coachPrice: args.coachPrice,
      additionalLaneIds: args.additionalLaneIds,
      athleteSlots: normalizedAthleteSlots,
      creditApplied: args.creditApplied,
      accessCode: args.accessCode,
      discountCode: args.discountCode,
      tentativeSourceId: args.tentativeSourceId,
      tentativeForDate: args.tentativeForDate,
    });

    // Send booking confirmation email for confirmed bookings
    if (args.status === "confirmed" && args.customerEmail) {
      const laneNameMap: Record<string, string> = {
        bm1: "Bowling Machine Lane 1",
        bm2: "Bowling Machine Lane 2",
        ru1: "Run-Up Lane 1",
        ru2: "Run-Up Lane 2",
      };
      const laneName = laneNameMap[args.laneId] ?? args.laneId.toUpperCase();
      const formattedDate = new Date(args.date + "T00:00:00").toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
      const fmtHour = (h: number) => {
        const hr = Math.floor(h);
        const min = Math.round((h - hr) * 60);
        const period = hr >= 12 ? "PM" : "AM";
        const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
        return `${display}:${min.toString().padStart(2, "0")} ${period}`;
      };
      const endHour = args.startHour + args.duration / 60;
      const timeSlot = `${fmtHour(args.startHour)} - ${fmtHour(endHour)}`;
      const durationStr = args.duration === 60 ? "1 hour" : args.duration === 90 ? "1.5 hours" : args.duration === 120 ? "2 hours" : `${args.duration} minutes`;
      const amount = args.coachPrice != null
        ? `$${args.coachPrice.toFixed(2)}`
        : args.creditApplied != null
          ? `$${args.creditApplied.toFixed(2)} (credit applied)`
          : "Paid";
      await ctx.scheduler.runAfter(0, internal.emails.sendBookingConfirmation, {
        to: args.customerEmail,
        customerName: args.customerName,
        laneName,
        date: formattedDate,
        timeSlot,
        duration: durationStr,
        amount,
        accessCode: args.accessCode ?? "N/A",
      });
    }

    // Send athlete allocation emails for coach bookings with initial athlete slots
    if (args.isCoachBooking && normalizedAthleteSlots && normalizedAthleteSlots.length > 0 && (args.status === "confirmed" || args.status === "tentative")) {
      const laneNameMap: Record<string, string> = {
        bm1: "Bowling Machine Lane 1",
        bm2: "Bowling Machine Lane 2",
        ru1: "Run-Up Lane 1",
        ru2: "Run-Up Lane 2",
      };
      const laneName = laneNameMap[args.laneId] ?? args.laneId.toUpperCase();
      const formattedDate = new Date(args.date + "T00:00:00").toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
      const fmtHour = (h: number) => {
        const hr = Math.floor(h);
        const min = Math.round((h - hr) * 60);
        const period = hr >= 12 ? "PM" : "AM";
        const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
        return `${display}:${min.toString().padStart(2, "0")} ${period}`;
      };
      for (const slot of normalizedAthleteSlots) {
        const athlete = await ctx.db
          .query("customers")
          .filter((q: any) => q.eq(q.field("name"), slot.athleteName))
          .first();
        if (!athlete?.email) continue;
        const slotEnd = slot.startHour + slot.durationMinutes / 60;
        await ctx.scheduler.runAfter(0, internal.emails.sendAthleteAllocation, {
          to: athlete.email,
          athleteName: slot.athleteName,
          coachName: args.customerName,
          laneName,
          date: formattedDate,
          timeSlot: `${fmtHour(slot.startHour)} - ${fmtHour(slotEnd)}`,
          duration: slot.durationMinutes === 60 ? "1 hour" : `${slot.durationMinutes} minutes`,
          accessCode: slot.accessCode ?? args.accessCode ?? "N/A",
        });
      }
    }

    // Trigger Google Calendar sync for confirmed/tentative bookings
    if (args.status === "confirmed" || args.status === "tentative") {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.createCalendarEvent, {
        bookingId: id.toString(),
        laneId: args.laneId,
        variantId: args.variantId,
        date: args.date,
        startHour: args.startHour,
        duration: args.duration,
        customerName: args.customerName,
        customerEmail: args.customerEmail,
        customerPhone: args.customerPhone,
        status: args.status,
        isCoachBooking: args.isCoachBooking,
        accessCode: args.accessCode,
        additionalLaneIds: args.additionalLaneIds,
        athleteSlots: args.athleteSlots,
      });
    }

    return id;
  },
});

// Update a booking (partial update) — ADMIN ONLY
export const updateBooking = mutation({
  args: {
    id: v.id("bookings"),
    laneId: v.optional(v.string()),
    variantId: v.optional(v.string()),
    date: v.optional(v.string()),
    startHour: v.optional(v.number()),
    duration: v.optional(v.number()),
    customerName: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerPhone: v.optional(v.string()),
    userId: v.optional(v.string()),
    status: v.optional(v.string()),
    stripeSessionId: v.optional(v.string()),
    isCoachBooking: v.optional(v.boolean()),
    coachPrice: v.optional(v.number()),
    additionalLaneIds: v.optional(v.array(v.string())),
    athleteSlots: v.optional(
      v.array(
        v.object({
          athleteName: v.string(),
          startHour: v.number(),
          durationMinutes: v.number(),
          accessCode: v.optional(v.string()),
          codeGeneratedAt: v.optional(v.string()),
        })
      )
    ),
    creditApplied: v.optional(v.number()),
    cancelledAt: v.optional(v.string()),
    cancelledByUserId: v.optional(v.string()),
    refilledMinutes: v.optional(v.number()),
    originalCoachId: v.optional(v.string()),
    tentativeSourceId: v.optional(v.string()),
    tentativeForDate: v.optional(v.string()),
    accessCode: v.optional(v.string()),
    discountCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const adminUser = await requireAdmin(ctx);
    const { id, ...updates } = args;
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    // Build modification history entry by comparing old vs new
    const existing = await ctx.db.get(id);
    if (existing) {
      const TRACKED_FIELDS = [
        "laneId",
        "date",
        "startHour",
        "duration",
        "customerName",
        "customerEmail",
        "customerPhone",
        "status",
        "coachPrice",
        "creditApplied",
        "discountCode",
        "variantId",
      ];
      const changes: Array<{ field: string; oldValue?: string; newValue?: string }> = [];
      for (const field of TRACKED_FIELDS) {
        if (field in cleanUpdates) {
          const oldVal = (existing as any)[field];
          const newVal = (cleanUpdates as any)[field];
          if (oldVal !== newVal) {
            changes.push({
              field,
              oldValue: oldVal === undefined || oldVal === null ? undefined : String(oldVal),
              newValue: newVal === undefined || newVal === null ? undefined : String(newVal),
            });
          }
        }
      }
      if (changes.length > 0) {
        const prevHistory = (existing as any).modificationHistory ?? [];
        (cleanUpdates as any).modificationHistory = [
          ...prevHistory,
          {
            modifiedAt: new Date().toISOString(),
            modifiedByUserId: (adminUser as any)?._id?.toString?.() ?? (adminUser as any)?.id ?? undefined,
            modifiedByName: (adminUser as any)?.name ?? (adminUser as any)?.email ?? "Admin",
            changes,
          },
        ];
      }
    }

    // For coach bookings, ensure athlete slots share the coach's access code
    const mergedExisting: any = existing ?? {};
    const isCoach = (cleanUpdates as any).isCoachBooking ?? mergedExisting.isCoachBooking;
    const effectiveCode = (cleanUpdates as any).accessCode ?? mergedExisting.accessCode;
    const effectiveSlots = (cleanUpdates as any).athleteSlots ?? mergedExisting.athleteSlots;
    if (isCoach && effectiveCode && Array.isArray(effectiveSlots)) {
      (cleanUpdates as any).athleteSlots = effectiveSlots.map((s: any) => ({
        ...s,
        accessCode: effectiveCode,
        codeGeneratedAt: s.codeGeneratedAt ?? new Date().toISOString(),
      }));
    }

    await ctx.db.patch(id, cleanUpdates);
    return id;
  },
});

// Cancel a booking
export const cancelBooking = mutation({
  args: {
    id: v.id("bookings"),
    cancelledByUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.id);
    if (!booking) throw new Error("Booking not found.");
    if (booking.status === "cancelled")
      throw new Error("Already cancelled.");

    // Auth guard: only booking owner or admin can cancel
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required to cancel a booking.");
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const isOwner =
      (booking.userId != null && booking.userId === identity.subject) ||
      booking.customerEmail.toLowerCase() === callerEmail;
    if (!isOwner) {
      const callerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
        .first();
      if (callerCustomer?.role !== "admin") {
        throw new Error("You can only cancel your own bookings.");
      }
    }

    await ctx.db.patch(args.id, {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancelledByUserId: args.cancelledByUserId,
    });

    // Sync cancellation to Google Calendar
    if (booking.googleCalendarEventId) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
        googleCalendarEventId: booking.googleCalendarEventId,
        laneCalendarEventIds: booking.googleCalendarEventIds,
      });
    }

    // Send cancellation confirmation email
    if (booking.customerEmail) {
      const LANE_NAMES: Record<string, string> = { bm1: "Bowling Machine 1", bm2: "Bowling Machine 2", bm3: "Bowling Machine 3", ru1: "9m Run Up 1", ru2: "9m Run Up 2" };
      const whole = Math.floor(booking.startHour);
      const mins = Math.round((booking.startHour - whole) * 60);
      const period = whole >= 12 ? "PM" : "AM";
      const displayHour = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
      const timeSlot = `${displayHour}:${mins.toString().padStart(2, "0")} ${period}`;
      const durationLabel = booking.duration === 60 ? "1 hour" : booking.duration === 90 ? "1.5 hours" : booking.duration === 30 ? "30 minutes" : `${booking.duration} min`;

      await ctx.scheduler.runAfter(0, internal.emails.sendBookingCancellation, {
        to: booking.customerEmail,
        customerName: booking.customerName || "Valued Customer",
        laneName: LANE_NAMES[booking.laneId] ?? booking.laneId,
        date: booking.date,
        timeSlot,
        duration: durationLabel,
      });
    }

    return args.id;
  },
});

// Delete a booking — ADMIN ONLY
export const deleteBooking = mutation({
  args: { id: v.id("bookings") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// Confirm a tentative booking — ADMIN ONLY
export const confirmTentativeBooking = mutation({
  args: { id: v.id("bookings") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const booking = await ctx.db.get(args.id);
    if (!booking || booking.status !== "tentative") return null;

    // Calculate coach price based on duration
    const halfHours = booking.duration / 30;
    const coachPrice = halfHours * 15;

    await ctx.db.patch(args.id, {
      status: "confirmed",
      coachPrice,
    });

    // Sync confirmation to Google Calendar
    await ctx.scheduler.runAfter(0, internal.googleCalendar.createCalendarEvent, {
      bookingId: args.id.toString(),
      laneId: booking.laneId,
      variantId: booking.variantId,
      date: booking.date,
      startHour: booking.startHour,
      duration: booking.duration,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      status: "confirmed",
      isCoachBooking: booking.isCoachBooking,
      accessCode: booking.accessCode,
      additionalLaneIds: booking.additionalLaneIds,
      athleteSlots: booking.athleteSlots,
    });

    return args.id;
  },
});

// Create tentative booking for next week based on source booking — ADMIN ONLY
export const createTentativeNextWeek = mutation({
  args: {
    sourceBookingId: v.id("bookings"),
    adjustedStartHour: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await ctx.db.get(args.sourceBookingId);
    if (!source || !source.isCoachBooking) return null;

    const tentativeSettings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const CLOSING_HOUR = tentativeSettings?.closingHour ?? 21;
    const [year, month, day] = source.date.split("-").map(Number);
    const sourceDate = new Date(year, month - 1, day);
    const nextWeekDate = new Date(sourceDate);
    nextWeekDate.setDate(nextWeekDate.getDate() + 7);
    const y = nextWeekDate.getFullYear();
    const m = String(nextWeekDate.getMonth() + 1).padStart(2, "0");
    const d = String(nextWeekDate.getDate()).padStart(2, "0");
    const nextWeekKey = `${y}-${m}-${d}`;

    const startHour = args.adjustedStartHour ?? source.startHour;
    const endHour = startHour + source.duration / 60;
    if (endHour > CLOSING_HOUR) return null;

    // Check for conflicts
    const allLaneIds = [source.laneId, ...(source.additionalLaneIds ?? [])];
    for (const lid of allLaneIds) {
      const laneBookings = await ctx.db
        .query("bookings")
        .withIndex("by_laneId_date", (q: any) =>
          q.eq("laneId", lid).eq("date", nextWeekKey)
        )
        .collect();

      const hasConflict = laneBookings.some((b) => {
        if (b.status === "cancelled") return false;
        const bEnd = b.startHour + b.duration / 60;
        return startHour < bEnd && endHour > b.startHour;
      });
      if (hasConflict) return null;
    }

    const id = await ctx.db.insert("bookings", {
      laneId: source.laneId,
      variantId: source.variantId,
      date: nextWeekKey,
      startHour,
      duration: source.duration,
      customerName: source.customerName,
      customerEmail: source.customerEmail,
      customerPhone: source.customerPhone,
      userId: source.userId,
      status: "tentative",
      isCoachBooking: true,
      coachPrice: source.coachPrice,
      additionalLaneIds: source.additionalLaneIds,
      athleteSlots: source.athleteSlots
        ? source.athleteSlots.map((s) => ({
            ...s,
            startHour: s.startHour - source.startHour + startHour,
          }))
        : undefined,
      tentativeSourceId: args.sourceBookingId,
      tentativeForDate: nextWeekKey,
    });

    return id;
  },
});

// Edit coach booking duration (with cancellation terms enforcement)
export const editBookingDuration = mutation({
  args: {
    id: v.id("bookings"),
    newDuration: v.number(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.id);
    if (!booking) throw new Error("Booking not found.");
    if (booking.status === "cancelled") throw new Error("Cannot edit a cancelled booking.");
    if (booking.userId !== args.userId && booking.customerEmail !== args.userId) throw new Error("You can only edit your own bookings.");

    const editDurSettings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const CLOSING_HOUR = editDurSettings?.closingHour ?? 21;
    const newEndHour = booking.startHour + args.newDuration / 60;
    if (newEndHour > CLOSING_HOUR) {
      throw new Error("New duration extends past closing time.");
    }
    if (args.newDuration < 30) {
      throw new Error("Minimum booking duration is 30 minutes.");
    }

    const isShortening = args.newDuration < booking.duration;
    const isExtending = args.newDuration > booking.duration;

    // Compute minutes until booking start (AWST)
    const [year, month, day] = booking.date.split("-").map(Number);
    const whole = Math.floor(booking.startHour);
    const mins = Math.round((booking.startHour - whole) * 60);
    const bookingStart = new Date(year, month - 1, day, whole, mins, 0);
    const now = new Date();
    const awstStr = now.toLocaleString("en-US", { timeZone: "Australia/Perth" });
    const awstNow = new Date(awstStr);
    const minutesUntil = (bookingStart.getTime() - awstNow.getTime()) / (1000 * 60);

    // Extending: allowed within 2-hour window before start, but must be >20 min before start
    if (isExtending) {
      if (minutesUntil <= 20) {
        throw new Error("Extensions must be made more than 20 minutes before the booking starts.");
      }
    }

    // If shortening, apply cancellation terms from site settings
    if (isShortening) {
      const cancellationHours = editDurSettings?.cancellationHoursBefore ?? 2;
      const hoursUntil = minutesUntil / 60;
      if (hoursUntil < cancellationHours) {
        throw new Error(
          `Bookings can only be shortened at least ${cancellationHours} hour${cancellationHours !== 1 ? "s" : ""} before the session starts. You are charged for the original duration.`
        );
      }
    }

    // If extending, check for conflicts
    if (args.newDuration > booking.duration) {
      const allLaneIds = [booking.laneId, ...(booking.additionalLaneIds ?? [])];
      for (const lid of allLaneIds) {
        const laneBookings = await ctx.db
          .query("bookings")
          .withIndex("by_laneId_date", (q: any) =>
            q.eq("laneId", lid).eq("date", booking.date)
          )
          .collect();

        const hasConflict = laneBookings.some((b) => {
          if (b._id === args.id || b.status === "cancelled") return false;
          const bEnd = b.startHour + b.duration / 60;
          return booking.startHour < bEnd && newEndHour > b.startHour;
        });

        if (hasConflict) {
          throw new Error(
            "Cannot extend — another booking conflicts with the new duration."
          );
        }
      }
    }

    // Recalculate coach price based on new duration
    const halfHours = args.newDuration / 30;
    const newCoachPrice = halfHours * 15;

    await ctx.db.patch(args.id, {
      duration: args.newDuration,
      coachPrice: newCoachPrice,
    });

    return args.id;
  },
});

// ============================================================================
// RESCHEDULE BOOKING MUTATION
// ============================================================================

export const rescheduleBooking = mutation({
  args: {
    id: v.id("bookings"),
    newDate: v.string(),
    newStartHour: v.number(),
    newDuration: v.number(),
    newLaneId: v.optional(v.string()),
    newVariantId: v.optional(v.string()),
    newAdditionalLaneIds: v.optional(v.array(v.string())),
    userId: v.string(),
    newAccessCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.id);
    if (!booking) throw new Error("Booking not found.");
    if (booking.status === "cancelled") throw new Error("Cannot reschedule a cancelled booking.");
    if (booking.status === "tentative") throw new Error("Confirm the tentative booking first, then reschedule.");

    // Verify ownership — user must own the booking or be admin
    const isOwner = booking.userId === args.userId || booking.customerEmail.toLowerCase() === args.userId.toLowerCase();
    if (!isOwner) {
      // Check if the user is an admin
      const adminCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", args.userId.toLowerCase()))
        .first();
      const isAdminById = await ctx.db
        .query("customers")
        .collect()
        .then(all => all.find(c => c._id.toString() === args.userId && c.role === "admin"));
      const isAdmin = adminCustomer?.role === "admin" || !!isAdminById;
      if (!isAdmin) {
        throw new Error("You can only reschedule your own bookings.");
      }
    }

    // Enforce cancellation policy — must be at least N hours before original booking
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const cancellationHours = settings?.cancellationHoursBefore ?? 2;

    const [oYear, oMonth, oDay] = booking.date.split("-").map(Number);
    const oWhole = Math.floor(booking.startHour);
    const oMins = Math.round((booking.startHour - oWhole) * 60);
    const originalStart = new Date(oYear, oMonth - 1, oDay, oWhole, oMins, 0);
    const now = new Date();
    const awstStr = now.toLocaleString("en-US", { timeZone: "Australia/Perth" });
    const awstNow = new Date(awstStr);
    const hoursUntilOriginal = (originalStart.getTime() - awstNow.getTime()) / (1000 * 60 * 60);

    if (hoursUntilOriginal < cancellationHours) {
      throw new Error(
        `Bookings can only be rescheduled at least ${cancellationHours} hour${cancellationHours !== 1 ? "s" : ""} before the session starts.`
      );
    }

    // Coaches cannot reschedule within 24 hours of booking start
    if (booking.isCoachBooking && hoursUntilOriginal < 24) {
      // Allow admins to override
      const requestingUser = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", args.userId.toLowerCase()))
        .first();
      const allCustomers = await ctx.db.query("customers").collect();
      const userById = allCustomers.find(c => c._id.toString() === args.userId);
      const isAdmin = requestingUser?.role === "admin" || userById?.role === "admin";
      if (!isAdmin) {
        throw new Error(
          "Coach bookings cannot be rescheduled within 24 hours of the session start time."
        );
      }
    }

    // Validate new time
    const CLOSING_HOUR = settings?.closingHour ?? 21;
    const OPENING_HOUR = settings?.openingHour ?? 7;
    const newEndHour = args.newStartHour + args.newDuration / 60;

    if (args.newStartHour < OPENING_HOUR) {
      throw new Error(`Bookings cannot start before ${OPENING_HOUR}:00.`);
    }
    if (newEndHour > CLOSING_HOUR) {
      throw new Error("New booking extends past closing time.");
    }
    if (args.newDuration < 30) {
      throw new Error("Minimum booking duration is 30 minutes.");
    }

    // Validate new booking is in the future
    const [nYear, nMonth, nDay] = args.newDate.split("-").map(Number);
    const nWhole = Math.floor(args.newStartHour);
    const nMins = Math.round((args.newStartHour - nWhole) * 60);
    const newStart = new Date(nYear, nMonth - 1, nDay, nWhole, nMins, 0);
    const newStartAwstStr = newStart.toLocaleString("en-US", { timeZone: "Australia/Perth" });
    const minNotice = settings?.minBookingNoticeMinutes ?? 10;
    const minutesUntilNew = (new Date(newStartAwstStr).getTime() - awstNow.getTime()) / (1000 * 60);
    if (minutesUntilNew < minNotice) {
      throw new Error(`New booking must be at least ${minNotice} minutes in the future.`);
    }

    // Check for conflicts at the new slot (excluding the current booking)
    const newLaneId = args.newLaneId ?? booking.laneId;
    const allNewLaneIds = [newLaneId, ...(args.newAdditionalLaneIds ?? [])];

    for (const lid of allNewLaneIds) {
      const laneBookings = await ctx.db
        .query("bookings")
        .withIndex("by_laneId_date", (q: any) =>
          q.eq("laneId", lid).eq("date", args.newDate)
        )
        .collect();

      const hasConflict = laneBookings.some((b) => {
        if (b._id === args.id || b.status === "cancelled") return false;
        const bEnd = b.startHour + b.duration / 60;
        return args.newStartHour < bEnd && newEndHour > b.startHour;
      });

      if (hasConflict) {
        throw new Error(
          "The new time slot is not available. Please choose another time."
        );
      }
    }

    // Calculate new price
    const isCoach = booking.isCoachBooking;
    let newCoachPrice = booking.coachPrice;
    if (isCoach) {
      const halfHours = args.newDuration / 30;
      newCoachPrice = halfHours * 15;
    }

    // Adjust athlete slots if start time changed
    let adjustedAthleteSlots = booking.athleteSlots;
    if (booking.athleteSlots && booking.athleteSlots.length > 0) {
      const timeDiff = args.newStartHour - booking.startHour;
      adjustedAthleteSlots = booking.athleteSlots.map((slot) => ({
        ...slot,
        startHour: slot.startHour + timeDiff,
      }));
      const newBookingEnd = args.newStartHour + args.newDuration / 60;
      for (const slot of adjustedAthleteSlots) {
        const slotEnd = slot.startHour + slot.durationMinutes / 60;
        if (slot.startHour < args.newStartHour || slotEnd > newBookingEnd) {
          adjustedAthleteSlots = undefined;
          break;
        }
      }
    }

    // Apply the reschedule
    await ctx.db.patch(args.id, {
      date: args.newDate,
      startHour: args.newStartHour,
      duration: args.newDuration,
      laneId: newLaneId,
      variantId: args.newVariantId ?? booking.variantId,
      additionalLaneIds: args.newAdditionalLaneIds ?? booking.additionalLaneIds,
      coachPrice: newCoachPrice,
      athleteSlots: adjustedAthleteSlots,
      accessCode: args.newAccessCode ?? booking.accessCode,
      googleCalendarEventId: undefined,
      googleCalendarEventIds: undefined,
      lockSyncStatus: args.newAccessCode ? "pending" : booking.lockSyncStatus,
    });

    // Delete old calendar events and create new ones
    if (booking.googleCalendarEventId) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.deleteCalendarEvent, {
        googleCalendarEventId: booking.googleCalendarEventId,
        laneCalendarEventIds: booking.googleCalendarEventIds,
      });
    }
    await ctx.scheduler.runAfter(500, internal.googleCalendar.createCalendarEvent, {
      bookingId: args.id.toString(),
      laneId: newLaneId,
      variantId: args.newVariantId ?? booking.variantId,
      date: args.newDate,
      startHour: args.newStartHour,
      duration: args.newDuration,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      status: booking.status,
      isCoachBooking: booking.isCoachBooking,
      accessCode: args.newAccessCode ?? booking.accessCode,
      additionalLaneIds: args.newAdditionalLaneIds ?? booking.additionalLaneIds,
      athleteSlots: adjustedAthleteSlots,
    });

    // Send reschedule confirmation email
    if (booking.customerEmail) {
      const LANE_NAMES: Record<string, string> = { bm1: "Bowling Machine 1", bm2: "Bowling Machine 2", bm3: "Bowling Machine 3", ru1: "9m Run Up 1", ru2: "9m Run Up 2" };
      const fmtTime = (h: number) => {
        const w = Math.floor(h);
        const m = Math.round((h - w) * 60);
        const p = w >= 12 ? "PM" : "AM";
        const dh = w > 12 ? w - 12 : w === 0 ? 12 : w;
        return `${dh}:${m.toString().padStart(2, "0")} ${p}`;
      };
      const fmtDur = (d: number) => d === 60 ? "1 hour" : d === 90 ? "1.5 hours" : d === 30 ? "30 minutes" : `${d} min`;

      await ctx.scheduler.runAfter(0, internal.emails.sendBookingRescheduled, {
        to: booking.customerEmail,
        customerName: booking.customerName || "Valued Customer",
        oldLaneName: LANE_NAMES[booking.laneId] ?? booking.laneId,
        oldDate: booking.date,
        oldTimeSlot: fmtTime(booking.startHour),
        newLaneName: LANE_NAMES[newLaneId] ?? newLaneId,
        newDate: args.newDate,
        newTimeSlot: fmtTime(args.newStartHour),
        newDuration: fmtDur(args.newDuration),
        accessCode: args.newAccessCode ?? booking.accessCode ?? "",
      });
    }

    // Reset reminder flag so the new time gets a fresh reminder
    await ctx.db.patch(args.id, { reminderSent: false });

    return args.id;
  },
});

// ============================================================================
// COACH ATHLETE ALLOCATION MUTATIONS
// ============================================================================

// Generate a unique 6-digit access code (server-side)
function generateServerAccessCode(existingCodes: Set<string>): string {
  let code: string;
  let attempts = 0;
  do {
    const num = 100000 + Math.floor(Math.random() * 900000);
    code = num.toString();
    attempts++;
  } while (existingCodes.has(code) && attempts < 100);
  existingCodes.add(code);
  return code;
}

// Update athlete slots on an existing booking (coach only)
export const updateBookingAthleteSlots = mutation({
  args: {
    id: v.id("bookings"),
    athleteSlots: v.array(
      v.object({
        athleteName: v.string(),
        startHour: v.number(),
        durationMinutes: v.number(),
        accessCode: v.optional(v.string()),
        codeGeneratedAt: v.optional(v.string()),
      })
    ),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.id);
    if (!booking) throw new Error("Booking not found.");
    if (!booking.isCoachBooking) throw new Error("Only coach bookings can have athlete allocations.");
    if (booking.status === "cancelled") throw new Error("Cannot edit a cancelled booking.");
    // Allow edit if: user is the booking owner, OR user is the coach (by email match), OR user is an admin
    if (booking.userId !== args.userId) {
      const requester = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", args.userId))
        .first();
      const requesterById: any = requester ?? (await ctx.db.get(args.userId as any).catch(() => null));
      const isAdmin = requesterById?.role === "admin";
      const isAssignedCoach =
        requesterById?.role === "coach" &&
        (requesterById?.email === booking.customerEmail ||
          requesterById?.name === booking.customerName);
      if (!isAdmin && !isAssignedCoach) {
        throw new Error("You can only edit your own bookings.");
      }
    }

    // Validate athlete slots fit within booking window
    const bookingEnd = booking.startHour + booking.duration / 60;
    for (const slot of args.athleteSlots) {
      const slotEnd = slot.startHour + slot.durationMinutes / 60;
      if (slot.startHour < booking.startHour || slotEnd > bookingEnd + 0.001) {
        throw new Error(`Athlete "${slot.athleteName}" session falls outside the booking window.`);
      }
      if (slot.durationMinutes < 15) {
        throw new Error(`Minimum athlete session is 15 minutes.`);
      }
    }

    // Build a map of previous athlete allocations for change detection
    const prevSlots = booking.athleteSlots ?? [];
    const prevMap = new Map<string, { startHour: number; durationMinutes: number; accessCode?: string }>();
    for (const ps of prevSlots) {
      prevMap.set(ps.athleteName, { startHour: ps.startHour, durationMinutes: ps.durationMinutes, accessCode: ps.accessCode });
    }

    // All athletes share the coach's booking access code
    const now = new Date().toISOString();
    const sharedCode = booking.accessCode;
    const finalSlots = args.athleteSlots.map((slot) => {
      const prev = prevMap.get(slot.athleteName);
      return {
        athleteName: slot.athleteName,
        startHour: slot.startHour,
        durationMinutes: slot.durationMinutes,
        accessCode: sharedCode,
        codeGeneratedAt: prev?.accessCode === sharedCode ? (slot.codeGeneratedAt ?? now) : now,
      };
    });

    await ctx.db.patch(args.id, {
      athleteSlots: finalSlots,
    });

    // Send allocation emails to newly-added or changed athletes
    const laneNameMap: Record<string, string> = {
      bm1: "Bowling Machine Lane 1",
      bm2: "Bowling Machine Lane 2",
      ru1: "Run-Up Lane 1",
      ru2: "Run-Up Lane 2",
    };
    const laneName = laneNameMap[booking.laneId] ?? booking.laneId.toUpperCase();
    const formattedDate = new Date(booking.date + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    const fmtHour = (h: number) => {
      const hr = Math.floor(h);
      const min = Math.round((h - hr) * 60);
      const period = hr >= 12 ? "PM" : "AM";
      const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
      return `${display}:${min.toString().padStart(2, "0")} ${period}`;
    };
    for (const slot of finalSlots) {
      const prev = prevMap.get(slot.athleteName);
      const changed = !prev || prev.startHour !== slot.startHour || prev.durationMinutes !== slot.durationMinutes;
      if (!changed) continue;
      const athlete = await ctx.db
        .query("customers")
        .filter((q: any) => q.eq(q.field("name"), slot.athleteName))
        .first();
      if (!athlete?.email) continue;
      const slotEnd = slot.startHour + slot.durationMinutes / 60;
      await ctx.scheduler.runAfter(0, internal.emails.sendAthleteAllocation, {
        to: athlete.email,
        athleteName: slot.athleteName,
        coachName: booking.customerName,
        laneName,
        date: formattedDate,
        timeSlot: `${fmtHour(slot.startHour)} - ${fmtHour(slotEnd)}`,
        duration: slot.durationMinutes === 60 ? "1 hour" : `${slot.durationMinutes} minutes`,
        accessCode: slot.accessCode ?? booking.accessCode ?? "N/A",
      });
    }

    // Trigger Google Calendar update if calendar event exists
    if (booking.googleCalendarEventId) {
      await ctx.scheduler.runAfter(0, internal.googleCalendar.updateCalendarEvent, {
        googleCalendarEventId: booking.googleCalendarEventId,
        laneId: booking.laneId,
        variantId: booking.variantId,
        date: booking.date,
        startHour: booking.startHour,
        duration: booking.duration,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone,
        status: booking.status,
        isCoachBooking: booking.isCoachBooking,
        accessCode: booking.accessCode,
        additionalLaneIds: booking.additionalLaneIds,
        athleteSlots: finalSlots,
        laneCalendarEventIds: booking.googleCalendarEventIds,
      });
    }

    return args.id;
  },
});

// ============================================================================
// CUSTOMER MUTATIONS — ADMIN ONLY
// ============================================================================

// Create or update a customer (upsert by email) — ADMIN ONLY
export const upsertCustomer = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    role: v.optional(v.string()),
    creditBalance: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        phone: args.phone,
        ...(args.role ? { role: args.role } : {}),
      });
      return existing._id;
    } else {
      const id = await ctx.db.insert("customers", {
        name: args.name.trim(),
        email: normalizedEmail,
        phone: args.phone?.trim() || undefined,
        role: args.role || "customer",
        creditBalance: args.creditBalance ?? 0,
        createdAt: new Date().toISOString(),
      });
      return id;
    }
  },
});

// Update customer profile — ADMIN ONLY
export const updateCustomer = mutation({
  args: {
    id: v.id("customers"),
    name: v.optional(v.string()),
    phone: v.optional(v.string()),
    role: v.optional(v.string()),
    assignedCoachIds: v.optional(v.array(v.string())),
    creditBalance: v.optional(v.number()),
    color: v.optional(v.string()),
    coachTier: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Allow self-update of own color without admin requirement
    const onlyColorUpdate = Object.keys(args).every((k) => k === "id" || k === "color" || args[k as keyof typeof args] === undefined);
    if (!onlyColorUpdate) await requireAdmin(ctx);
    const { id, ...updates } = args;
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );
    await ctx.db.patch(id, cleanUpdates);
    return id;
  },
});

// Update customer by email — ADMIN ONLY
export const updateCustomerByEmail = mutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    phone: v.optional(v.string()),
    role: v.optional(v.string()),
    coachTier: v.optional(v.string()),
    assignedCoachIds: v.optional(v.array(v.string())),
    creditBalance: v.optional(v.number()),
    color: v.optional(v.string()),
    bookingEmailsEnabled: v.optional(v.boolean()),
    emailPrefs: v.optional(v.array(v.object({ slug: v.string(), enabled: v.boolean() }))),
  },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.toLowerCase().trim();
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();

    if (existing) {
      const { email, ...updates } = args;
      const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([_, v]) => v !== undefined)
      );
      await ctx.db.patch(existing._id, cleanUpdates);
      return existing._id;
    } else {
      const id = await ctx.db.insert("customers", {
        name: args.name?.trim() || normalizedEmail.split("@")[0],
        email: normalizedEmail,
        phone: args.phone?.trim() || undefined,
        role: args.role || "customer",
        assignedCoachIds: args.assignedCoachIds ?? [],
        creditBalance: args.creditBalance ?? 0,
        createdAt: new Date().toISOString(),
      });
      return id;
    }
  },
});

// Delete a customer — ADMIN ONLY
export const deleteCustomer = mutation({
  args: { id: v.id("customers") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// ============================================================================
// COACH INVITE MUTATIONS — ADMIN ONLY
// ============================================================================

// Create a coach invite — ADMIN ONLY
export const createCoachInvite = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    email: v.string(),
    phone: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();

    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (existingCustomer) {
      throw new Error("An account with this email already exists.");
    }

    const existingInvite = await ctx.db
      .query("coachInvites")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (existingInvite && !existingInvite.used) {
      throw new Error("An unused invite already exists for this email.");
    }

    const id = await ctx.db.insert("coachInvites", {
      token: args.token,
      name: args.name.trim(),
      email: normalizedEmail,
      phone: args.phone.trim(),
      createdBy: args.createdBy,
      createdAt: new Date().toISOString(),
      used: false,
    });
    return id;
  },
});

// Manually create a coach (no invite flow) — ADMIN ONLY
export const createCoach = mutation({
  args: {
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.string(),
    phone: v.optional(v.string()),
    coachTier: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();
    const fullName = (args.name && args.name.trim())
      || [args.firstName?.trim(), args.lastName?.trim()].filter(Boolean).join(" ").trim();
    if (!normalizedEmail || !fullName) {
      throw new Error("First name, last name, and email are required.");
    }

    const existing = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (existing) {
      if (existing.role === "coach") {
        throw new Error("This user is already a coach.");
      }
      await ctx.db.patch(existing._id, {
        role: "coach",
        name: fullName || existing.name,
        phone: args.phone?.trim() || existing.phone,
        coachTier: args.coachTier || existing.coachTier,
        color: args.color || existing.color,
      });
      return existing._id;
    }

    const id = await ctx.db.insert("customers", {
      name: fullName,
      email: normalizedEmail,
      phone: args.phone?.trim(),
      role: "coach",
      coachTier: args.coachTier,
      color: args.color,
      createdAt: new Date().toISOString(),
    });
    return id;
  },
});

// Delete a coach invite — ADMIN ONLY
export const deleteCoachInvite = mutation({
  args: { id: v.id("coachInvites") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return { success: true };
  },
});

// Mark a coach invite as used (user-facing — no admin gate)
export const useCoachInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("coachInvites")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first();
    if (!invite || invite.used) return null;

    await ctx.db.patch(invite._id, {
      used: true,
      usedAt: new Date().toISOString(),
    });
    return invite;
  },
});

// ============================================================================
// STRIPE PAYMENT MUTATIONS
// ============================================================================

// Create a new stripePayment (user-facing — triggered by checkout flow)
export const createStripePayment = mutation({
  args: {
    bookingId: v.string(),
    stripeSessionId: v.string(),
    customerEmail: v.string(),
    customerName: v.string(),
    amount: v.number(),
    currency: v.string(),
    status: v.string(),
    laneName: v.string(),
    date: v.string(),
    description: v.string(),
    accessCode: v.optional(v.string()),
    timeSlot: v.optional(v.string()),
    duration: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("stripePayments", {
      bookingId: args.bookingId,
      stripeSessionId: args.stripeSessionId,
      customerEmail: args.customerEmail,
      customerName: args.customerName,
      amount: args.amount,
      currency: args.currency,
      status: args.status,
      laneName: args.laneName,
      date: args.date,
      description: args.description,
    });

    // Also ensure the customer exists in the customers table
    const normalizedEmail = args.customerEmail.toLowerCase().trim();
    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (!existingCustomer) {
      await ctx.db.insert("customers", {
        name: args.customerName || "Customer",
        email: normalizedEmail,
        role: "customer",
        creditBalance: 0,
        createdAt: new Date().toISOString(),
      });
    }

    // Note: confirmation email is sent by createBooking — do not duplicate here.

    return id;
  },
});

// Send booking confirmation email (callable from client for non-Stripe bookings)
export const sendBookingEmail = mutation({
  args: {
    customerEmail: v.string(),
    customerName: v.string(),
    laneName: v.string(),
    date: v.string(),
    timeSlot: v.string(),
    duration: v.string(),
    amount: v.string(),
    accessCode: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      0,
      internal.emails.sendBookingConfirmation,
      {
        to: args.customerEmail,
        customerName: args.customerName,
        laneName: args.laneName,
        date: args.date,
        timeSlot: args.timeSlot,
        duration: args.duration,
        amount: args.amount,
        accessCode: args.accessCode,
      }
    );
    return { success: true };
  },
});

// Update a stripePayment — ADMIN ONLY
export const updateStripePayment = mutation({
  args: {
    id: v.id("stripePayments"),
    bookingId: v.optional(v.string()),
    stripeSessionId: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
    amount: v.optional(v.number()),
    currency: v.optional(v.string()),
    status: v.optional(v.string()),
    laneName: v.optional(v.string()),
    date: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { id, ...updates } = args;
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );
    await ctx.db.patch(args.id, cleanUpdates);
    return args.id;
  },
});

// Delete a stripePayment — ADMIN ONLY
export const deleteStripePayment = mutation({
  args: { id: v.id("stripePayments") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// ============================================================================
// WAITLIST MUTATIONS
// ============================================================================

// Add entries to waitlist (user-facing)
export const addToWaitlist = mutation({
  args: {
    entries: v.array(
      v.object({
        userId: v.string(),
        userName: v.string(),
        userEmail: v.string(),
        laneId: v.string(),
        date: v.string(),
        hour: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    // Use authenticated identity email when available (verified sender)
    const identity = await ctx.auth.getUserIdentity();
    const authedEmail = identity?.email ?? null;
    const authedName = (identity as any)?.name ?? null;

    const ids: string[] = [];
    const insertedEntries: typeof args.entries = [];
    for (const entry of args.entries) {
      const existing = await ctx.db
        .query("waitlist")
        .withIndex("by_slot", (q: any) =>
          q.eq("laneId", entry.laneId).eq("date", entry.date).eq("hour", entry.hour)
        )
        .collect();
      const isDuplicate = existing.some((e) => e.userId === entry.userId);
      if (isDuplicate) continue;

      const id = await ctx.db.insert("waitlist", {
        userId: entry.userId,
        userName: entry.userName,
        userEmail: authedEmail ?? entry.userEmail,
        laneId: entry.laneId,
        date: entry.date,
        hour: entry.hour,
        notified: false,
      });
      ids.push(id);
      insertedEntries.push(entry);
    }
    // Send waitlist confirmation email (replicates booking-confirmation pattern)
    if (ids.length > 0 && insertedEntries.length > 0) {
      const first = insertedEntries[0];
      await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistConfirmation, {
        to: authedEmail ?? first.userEmail,
        customerName: authedName ?? first.userName,
        slots: insertedEntries.map((e) => ({ date: e.date, hour: e.hour })),
      });
    }
    return ids;
  },
});

// Remove a waitlist entry (user-facing)
export const removeFromWaitlist = mutation({
  args: { id: v.id("waitlist") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required.");
    const entry = await ctx.db.get(args.id);
    if (!entry) throw new Error("Waitlist entry not found.");
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const isOwner =
      entry.userId === identity.subject ||
      entry.userEmail.toLowerCase() === callerEmail;
    if (!isOwner) {
      const callerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
        .first();
      if (callerCustomer?.role !== "admin") {
        throw new Error("You can only remove your own waitlist entries.");
      }
    }
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// Notify waitlisted users when a slot opens up — ADMIN ONLY
export const notifyWaitlistedUsers = mutation({
  args: {
    laneId: v.string(),
    laneName: v.string(),
    date: v.string(),
    hours: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const notificationIds: string[] = [];

    for (const hour of args.hours) {
      const waitlisted = await ctx.db
        .query("waitlist")
        .withIndex("by_slot", (q: any) =>
          q.eq("laneId", args.laneId).eq("date", args.date).eq("hour", hour)
        )
        .collect();

      const otherCount = Math.max(0, waitlisted.length - 1);
      for (const entry of waitlisted) {
        const bookingUrl = `/?book=${args.laneId}&date=${args.date}&hour=${hour}`;
        const notifId = await ctx.db.insert("waitlistNotifications", {
          userId: entry.userId,
          userEmail: entry.userEmail,
          userName: entry.userName,
          laneId: args.laneId,
          laneName: args.laneName,
          date: args.date,
          hour,
          sentAt: new Date().toISOString(),
          bookingUrl,
          dismissed: false,
        });
        notificationIds.push(notifId);

        // Email every waitlisted user (first-come-first-served)
        const fmtHour = (h: number) => {
          const hr = Math.floor(h);
          const min = Math.round((h - hr) * 60);
          const period = hr >= 12 ? "PM" : "AM";
          const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
          return `${display}:${min.toString().padStart(2, "0")} ${period}`;
        };
        const formattedDate = new Date(args.date + "T00:00:00").toLocaleDateString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        });
        await ctx.scheduler.runAfter(0, internal.emails.sendWaitlistVacancy, {
          to: entry.userEmail,
          customerName: entry.userName,
          laneName: args.laneName,
          date: formattedDate,
          timeSlot: `${fmtHour(hour)} - ${fmtHour(hour + 1)}`,
          bookingUrl: `https://krickora.com${bookingUrl}`,
          otherWaitlistCount: String(otherCount),
        });

        await ctx.db.delete(entry._id);
      }
    }

    return notificationIds;
  },
});

// Dismiss a waitlist notification (user-facing)
export const dismissWaitlistNotification = mutation({
  args: { id: v.id("waitlistNotifications") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { dismissed: true });
    return args.id;
  },
});

// ============================================================================
// SITE SETTINGS MUTATIONS — ADMIN ONLY
// ============================================================================

// Update site settings — ADMIN ONLY
export const updateSiteSettings = mutation({
  args: {
    customerPricePerHour: v.optional(v.number()),
    customerPrice90Min: v.optional(v.number()),
    trumanPricePerHour: v.optional(v.number()),
    trumanPrice90Min: v.optional(v.number()),
    coachPer30Min: v.optional(v.number()),
    coachPerHour: v.optional(v.number()),
    cancellationHoursBefore: v.optional(v.number()),
    openingHour: v.optional(v.number()),
    closingHour: v.optional(v.number()),
    minBookingNoticeMinutes: v.optional(v.number()),
    coachBookingWindowDays: v.optional(v.number()),
    customerOpenDay: v.optional(v.string()),
    customerOpenHour: v.optional(v.number()),
    l1CoachOpenDay: v.optional(v.string()),
    l1CoachOpenHour: v.optional(v.number()),
    l2CoachOpenDay: v.optional(v.string()),
    l2CoachOpenHour: v.optional(v.number()),
    registrationLocked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();

    const defaults = {
      customerPricePerHour: 40,
      customerPrice90Min: 55,
      trumanPricePerHour: 50,
      trumanPrice90Min: 70,
      coachPer30Min: 15,
      coachPerHour: 25,
      cancellationHoursBefore: 2,
      openingHour: 7,
      closingHour: 21,
      minBookingNoticeMinutes: 10,
      coachBookingWindowDays: 7,
      customerOpenDay: "sunday",
      customerOpenHour: 19,
    };

    if (existing) {
      const cleanUpdates = Object.fromEntries(
        Object.entries(args).filter(([_, v]) => v !== undefined)
      );
      await ctx.db.patch(existing._id, cleanUpdates);
      return existing._id;
    } else {
      const merged = { ...defaults, ...Object.fromEntries(
        Object.entries(args).filter(([_, v]) => v !== undefined)
      ) };
      const id = await ctx.db.insert("siteSettings", {
        key: "global",
        ...merged,
      });
      return id;
    }
  },
});

// ============================================================================
// PAYMENT MUTATIONS — ADMIN ONLY
// ============================================================================

export const createPayment = mutation({
  args: {
    coachId: v.string(),
    amount: v.number(),
    dateReceived: v.string(),
    note: v.optional(v.string()),
    method: v.optional(v.string()),
    description: v.optional(v.string()),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const id = await ctx.db.insert("payments", {
      coachId: args.coachId,
      amount: args.amount,
      dateReceived: args.dateReceived,
      note: args.note ?? args.description,
      method: args.method,
      description: args.description,
      createdAt: new Date().toISOString(),
      createdBy: args.createdBy,
    } as any);
    return id;
  },
});

export const deletePayment = mutation({
  args: { id: v.id("payments") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// ============================================================================
// CUSTOMER CREDIT MUTATIONS — ADMIN ONLY
// ============================================================================

export const addCustomerCredit = mutation({
  args: { email: v.string(), amount: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();
    let customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (!customer) {
      const newId = await ctx.db.insert("customers", {
        name: normalizedEmail.split("@")[0],
        email: normalizedEmail,
        role: "customer",
        creditBalance: args.amount,
        createdAt: new Date().toISOString(),
      });
      return newId;
    }
    await ctx.db.patch(customer._id, {
      creditBalance: (customer.creditBalance ?? 0) + args.amount,
    });
    return customer._id;
  },
});

export const useCustomerCredit = mutation({
  args: { email: v.string(), amount: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required.");
    const callerEmail = identity.email?.toLowerCase().trim() ?? "";
    const targetEmail = args.email.toLowerCase().trim();
    if (callerEmail !== targetEmail) {
      const callerCustomer = await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", callerEmail))
        .first();
      if (callerCustomer?.role !== "admin") {
        throw new Error("You can only use your own credits.");
      }
    }
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", args.email.toLowerCase().trim()))
      .first();
    if (!customer) return 0;
    const available = customer.creditBalance ?? 0;
    const used = Math.min(available, args.amount);
    await ctx.db.patch(customer._id, {
      creditBalance: available - used,
    });
    return used;
  },
});

// Reset site settings to defaults — ADMIN ONLY
export const resetSiteSettings = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();

    const defaults = {
      key: "global" as const,
      customerPricePerHour: 40,
      customerPrice90Min: 55,
      trumanPricePerHour: 50,
      trumanPrice90Min: 70,
      coachPer30Min: 15,
      coachPerHour: 25,
      cancellationHoursBefore: 2,
      openingHour: 7,
      closingHour: 21,
      minBookingNoticeMinutes: 10,
      coachBookingWindowDays: 7,
      customerOpenDay: "sunday",
      customerOpenHour: 19,
    };

    if (existing) {
      await ctx.db.patch(existing._id, defaults);
      return existing._id;
    } else {
      return await ctx.db.insert("siteSettings", defaults);
    }
  },
});

// ============================================================================
// ADMIN UPGRADE MUTATION — ADMIN ONLY
// ============================================================================

export const upgradeToAdmin = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const normalizedEmail = args.email.toLowerCase().trim();
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_email", (q: any) => q.eq("email", normalizedEmail))
      .first();
    if (customer) {
      await ctx.db.patch(customer._id, { role: "admin" });
      return customer._id;
    }
    return await ctx.db.insert("customers", {
      name: "Admin",
      email: normalizedEmail,
      role: "admin",
      createdAt: new Date().toISOString(),
    });
  },
});
