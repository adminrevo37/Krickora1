import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Better Auth tables (user, session, account, verification) are managed
  // automatically by the @convex-dev/better-auth component.

  // ============================================================================
  // ANALYTICS (replaces Railway tracker)
  // ============================================================================
  analytics: defineTable({
    type: v.string(), // 'pageview' | 'event' | 'session_start' | 'session_end'
    name: v.optional(v.string()), // event name e.g. 'booking_created', 'sign_in'
    url: v.optional(v.string()),
    referrer: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    userId: v.optional(v.string()),
    metadata: v.optional(v.string()), // JSON-stringified extra data
    userAgent: v.optional(v.string()),
    timestamp: v.number(), // Unix ms
  })
    .index("by_type", ["type"])
    .index("by_timestamp", ["timestamp"])
    .index("by_sessionId", ["sessionId"])
    .index("by_userId", ["userId"])
    .index("by_type_timestamp", ["type", "timestamp"]),

  // Application tables
  customers: defineTable({
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    role: v.string(), // 'customer' | 'coach' | 'admin' | 'user' (default: 'user' for new signups)
    assignedCoachIds: v.optional(v.array(v.string())),
    creditBalance: v.optional(v.number()),
    color: v.optional(v.string()),
    coachTier: v.optional(v.string()), // 'L1' | 'L2' | 'Bowling'
    bookingEmailsEnabled: v.optional(v.boolean()),
    emailPrefs: v.optional(
      v.array(
        v.object({
          slug: v.string(),
          enabled: v.boolean(),
        })
      )
    ),
    createdAt: v.string(),
  })
    .index("by_email", ["email"])
    .index("by_role", ["role"]),

  bookings: defineTable({
    laneId: v.string(),
    variantId: v.optional(v.string()),
    date: v.string(), // YYYY-MM-DD
    startHour: v.number(), // e.g. 9, 9.5, 14.25
    duration: v.number(), // in minutes
    customerName: v.string(),
    customerEmail: v.string(),
    customerPhone: v.optional(v.string()),
    userId: v.optional(v.string()),
    status: v.string(), // 'confirmed' | 'pending' | 'cancelled' | 'tentative'
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
    googleCalendarEventId: v.optional(v.string()),
    // Per-lane calendar event IDs (for multi-calendar sync)
    googleCalendarEventIds: v.optional(
      v.array(
        v.object({
          laneId: v.string(),
          calendarId: v.string(),
          eventId: v.string(),
        })
      )
    ),
    // Smart lock sync tracking
    lockSyncStatus: v.optional(v.string()), // 'pending' | 'synced' | 'failed' | 'removed'
    lockCodeId: v.optional(v.string()), // Reference to lockCodes table entry
    reminderSent: v.optional(v.boolean()), // Whether 6-hour reminder email was sent
    // Payment tracking
    paymentEmailSent: v.optional(v.boolean()), // Dedup guard — prevents duplicate payment confirmation emails
    stripePaymentIntentId: v.optional(v.string()), // Needed to issue partial refunds
    priceInCents: v.optional(v.number()), // Stored price at booking time (used for edit diff calculation)
    // Pending booking edit (set when a top-up payment is required)
    pendingEdit: v.optional(v.object({
      newDuration: v.number(),
      newAdditionalLaneIds: v.optional(v.array(v.string())),
      newPriceInCents: v.number(),
      priceDifference: v.number(), // positive = top-up required, negative = refund
    })),
    modificationHistory: v.optional(
      v.array(
        v.object({
          modifiedAt: v.string(),
          modifiedByUserId: v.optional(v.string()),
          modifiedByName: v.optional(v.string()),
          changes: v.array(
            v.object({
              field: v.string(),
              oldValue: v.optional(v.string()),
              newValue: v.optional(v.string()),
            })
          ),
        })
      )
    ),
  })
    .index("by_date", ["date"])
    .index("by_laneId_date", ["laneId", "date"])
    .index("by_userId", ["userId"])
    .index("by_customerEmail", ["customerEmail"])
    .index("by_status", ["status"]),

  waitlist: defineTable({
    userId: v.string(),
    userName: v.string(),
    userEmail: v.string(),
    laneId: v.string(),
    date: v.string(), // YYYY-MM-DD
    hour: v.number(),
    notified: v.boolean(),
  })
    .index("by_userId", ["userId"])
    .index("by_slot", ["laneId", "date", "hour"])
    .index("by_laneId_date", ["laneId", "date"]),

  waitlistNotifications: defineTable({
    userId: v.string(),
    userEmail: v.string(),
    userName: v.string(),
    laneId: v.string(),
    laneName: v.string(),
    date: v.string(),
    hour: v.number(),
    sentAt: v.string(),
    bookingUrl: v.string(),
    dismissed: v.boolean(),
  }).index("by_userId", ["userId"]),

  coachInvites: defineTable({
    token: v.string(),
    name: v.string(),
    email: v.string(),
    phone: v.string(),
    createdBy: v.string(),
    createdAt: v.string(),
    usedAt: v.optional(v.string()),
    used: v.boolean(),
  })
    .index("by_token", ["token"])
    .index("by_email", ["email"]),

  stripePayments: defineTable({
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
  })
    .index("by_stripeSessionId", ["stripeSessionId"])
    .index("by_customerEmail", ["customerEmail"])
    .index("by_status", ["status"])
    .index("by_date", ["date"]),

  // Site-wide settings (singleton - only one document)
  siteSettings: defineTable({
    key: v.string(), // always "global"
    customerPricePerHour: v.number(),
    customerPrice90Min: v.number(),
    trumanPricePerHour: v.number(),
    trumanPrice90Min: v.number(),
    coachPerHour: v.number(),
    coachPer30Min: v.optional(v.number()),
    cancellationHoursBefore: v.number(),
    openingHour: v.number(),
    closingHour: v.number(),
    minBookingNoticeMinutes: v.number(),
    coachBookingWindowDays: v.number(),
    customerOpenDay: v.string(),
    customerOpenHour: v.number(),
    l1CoachOpenDay: v.optional(v.string()),
    l1CoachOpenHour: v.optional(v.number()),
    l2CoachOpenDay: v.optional(v.string()),
    l2CoachOpenHour: v.optional(v.number()),
    registrationLocked: v.optional(v.boolean()),
    // Advanced booking rule overrides
    coachRescheduleFreezeHours: v.optional(v.number()),  // default 24 — coach can't self-reschedule within N hours
    extensionNoticeMinutes: v.optional(v.number()),       // default 20 — must extend >N min before start
    customerMaxDurationMinutes: v.optional(v.number()),   // default 120
    coachMaxDurationMinutes: v.optional(v.number()),      // default 600
    minAthleteDurationMinutes: v.optional(v.number()),    // default 15
    // Cancellation rules (separated by user type)
    customerCancellationHours: v.optional(v.number()),   // default 2 — customers cannot cancel within N hours
    coachLateCancellationHours: v.optional(v.number()),  // default 24 — coach charged if they cancel within N hours
  }).index("by_key", ["key"]),

  // Discount codes
  discountCodes: defineTable({
    code: v.string(),           // lowercase unique code e.g. "julian"
    discount: v.number(),       // 0–100 percent off
    label: v.string(),          // display label e.g. "100% Off — Complimentary"
    bypassStripe: v.boolean(),  // if true, skip payment entirely
    active: v.boolean(),
    expiresAt: v.optional(v.string()),    // YYYY-MM-DD or undefined
    usageLimit: v.optional(v.number()),   // max total uses, undefined = unlimited
    usedCount: v.number(),
    createdAt: v.string(),
    createdBy: v.optional(v.string()),
  })
    .index("by_code", ["code"])
    .index("by_active", ["active"]),

  // Google Calendar OAuth tokens (singleton - one per admin)
  googleCalendarTokens: defineTable({
    key: v.string(), // always "default"
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(), // timestamp in ms
    calendarId: v.string(), // the calendar to sync to
    connectedEmail: v.string(), // Google account email
    connectedAt: v.string(),
  }).index("by_key", ["key"]),

  // Facility closures (dates when booking is disabled)
  closures: defineTable({
    date: v.string(), // YYYY-MM-DD
    reason: v.optional(v.string()),
    createdAt: v.string(),
    createdBy: v.optional(v.string()),
  }).index("by_date", ["date"]),

  // Lane service/repair blocks — prevent bookings on specific lane at specific times
  laneBlocks: defineTable({
    laneId: v.string(), // 'bm1', 'bm2', etc. or 'all'
    date: v.string(), // YYYY-MM-DD
    startHour: v.number(), // e.g. 9, 9.5
    duration: v.number(), // in minutes
    reason: v.optional(v.string()),
    createdAt: v.string(),
    createdBy: v.optional(v.string()),
  })
    .index("by_date", ["date"])
    .index("by_laneId_date", ["laneId", "date"]),

  // Per-lane Google Calendar mappings
  laneCalendarMappings: defineTable({
    laneId: v.string(), // e.g. 'bm1', 'bm2', 'ru1'
    calendarId: v.string(), // Google Calendar ID
    calendarName: v.string(), // Display name for UI
  }).index("by_laneId", ["laneId"]),

  // ============================================================================
  // SMART LOCK TABLES
  // ============================================================================

  // Lock access codes synced to physical hardware
  lockCodes: defineTable({
    bookingId: v.string(), // Reference to booking
    accessCode: v.string(), // The 6-digit code
    deviceIds: v.array(v.string()), // Seam device IDs the code was pushed to
    seamAccessCodeIds: v.array(v.string()), // Seam access_code IDs for cleanup
    status: v.string(), // 'active' | 'expired' | 'removed' | 'failed'
    startsAt: v.string(), // ISO datetime — when code becomes active
    endsAt: v.string(), // ISO datetime — when code expires
    customerName: v.string(),
    customerEmail: v.string(),
    laneId: v.string(),
    createdAt: v.string(),
    lastSyncAt: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_bookingId", ["bookingId"])
    .index("by_status", ["status"])
    .index("by_accessCode", ["accessCode"]),

  // Mapping of lanes to physical lock devices
  lockDeviceMappings: defineTable({
    laneId: v.string(), // e.g. 'bm1', 'bm2', 'ru1'
    deviceId: v.string(), // Seam device ID
    deviceName: v.string(), // Display name (e.g. "Front Door", "BM1 Door")
    lockBrand: v.string(), // 'schlage' | 'yale' | 'august' | 'other'
  }).index("by_laneId", ["laneId"]),

  // Coach payments tracking
  payments: defineTable({
    coachId: v.string(),
    amount: v.number(),
    dateReceived: v.string(),
    note: v.optional(v.string()),
    method: v.optional(v.string()),
    description: v.optional(v.string()),
    createdAt: v.string(),
    createdBy: v.string(),
  })
    .index("by_coachId", ["coachId"])
    .index("by_dateReceived", ["dateReceived"]),

  // Smart lock provider settings (singleton)
  lockSettings: defineTable({
    key: v.string(), // always "global"
    provider: v.string(), // 'seam' (extensible for future providers)
    enabled: v.boolean(),
    codeLeadTimeMinutes: v.number(), // How many minutes before booking the code activates
    codeTrailTimeMinutes: v.number(), // How many minutes after booking the code stays active
    defaultDeviceIds: v.array(v.string()), // Fallback devices if no lane mapping exists (e.g. main entrance)
  }).index("by_key", ["key"]),
});
