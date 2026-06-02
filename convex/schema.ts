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
    coachTier: v.optional(v.string()), // 'L1' | 'L2'
    defaultSessionDuration: v.optional(v.number()), // coach default athlete slot duration in minutes
    athleteCapacity: v.optional(v.number()), // coach max athletes per session (1-4); drives auto-populate
    bookingEmailsEnabled: v.optional(v.boolean()),
    emailPrefs: v.optional(
      v.array(
        v.object({
          slug: v.string(),
          enabled: v.boolean(),
        })
      )
    ),
    // Soft-delete / anonymisation (SEC decision #6). When set, the account is
    // deactivated; booking + payment history is retained but PII is anonymised.
    deactivatedAt: v.optional(v.string()),
    anonymizedAt: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("by_email", ["email"])
    .index("by_role", ["role"]),

  // Child-athlete entities (SPEC_PARENT_ATHLETE_MODEL). Separates the ACCOUNT
  // holder (customers — parent/guardian or adult who logs in, pays, receives
  // emails) from the ATHLETE (the trainee a coach sees). One account → many
  // athletes. assignedCoachIds lives HERE now (per-athlete), not on customers.
  athletes: defineTable({
    accountCustomerId: v.id("customers"), // owning account (parent/adult)
    name: v.string(), // the kid's (or adult's) name — what coaches see
    assignedCoachIds: v.optional(v.array(v.string())), // coach _id(s) for THIS athlete
    isSelf: v.optional(v.boolean()), // true = the account holder training themselves
    dob: v.optional(v.string()), // reserved, unused for now — enables future age groups w/o migration
    notes: v.optional(v.string()), // optional coach/parent notes
    createdAt: v.string(),
  }).index("by_account", ["accountCustomerId"]),

  // Account-credit movement log (SPEC_PAYMENTS_AND_CREDIT #1). Every change to
  // customers.creditBalance appends one row — the user-facing credit history.
  // delta > 0 = credit issued (cancellation, modify decrease, admin grant),
  // delta < 0 = credit redeemed at checkout.
  creditLedger: defineTable({
    customerId: v.id("customers"),
    delta: v.number(), // dollars; signed
    balanceAfter: v.number(), // resulting creditBalance, for clean history display
    reason: v.string(), // 'cancellation' | 'modify_decrease' | 'admin_grant' | 'redeemed' | 'admin_adjust' | 'account_deleted'
    bookingId: v.optional(v.string()),
    note: v.optional(v.string()),
    at: v.string(), // ISO timestamp
  })
    .index("by_customerId", ["customerId"])
    .index("by_bookingId", ["bookingId"]),

  // Temporary slot holds — ONE unified mechanism (SPEC_PAYMENTS_AND_CREDIT #3,
  // shared with SPEC_WAITLIST_OFFER_REDESIGN). 'checkout' = a pending_payment
  // booking awaiting Stripe; 'waitlist' = a first-refusal offer hold (waitlist
  // build populates these). Expired holds are swept by the releaseExpiredHolds
  // cron + the Stripe checkout.session.expired webhook.
  slotHolds: defineTable({
    laneId: v.string(),
    additionalLaneIds: v.optional(v.array(v.string())),
    date: v.string(), // YYYY-MM-DD
    startHour: v.number(),
    duration: v.number(), // minutes
    holdType: v.string(), // 'checkout' | 'waitlist'
    bookingId: v.optional(v.string()), // checkout holds → the pending_payment booking
    userId: v.optional(v.string()),
    userEmail: v.optional(v.string()),
    expiresAt: v.number(), // Unix ms
    createdAt: v.string(),
  })
    .index("by_laneId_date", ["laneId", "date"])
    .index("by_bookingId", ["bookingId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Audit log for role / permission / tier changes (SEC decision #3).
  roleAuditLog: defineTable({
    targetEmail: v.string(),
    field: v.string(), // 'role' | 'coachTier' | 'deactivated' | ...
    oldValue: v.optional(v.string()),
    newValue: v.optional(v.string()),
    changedByEmail: v.string(),
    changedAt: v.string(),
  })
    .index("by_targetEmail", ["targetEmail"])
    .index("by_changedAt", ["changedAt"]),

  // Allocation change history (SPEC_COACH_ALLOCATION_AND_PLANNER Part 2).
  // One row per allocation change on a coach booking — who, when, what changed.
  // before/after are athleteSlots snapshots. Kept forever (low volume).
  allocationAuditLog: defineTable({
    bookingId: v.string(),
    at: v.string(), // ISO timestamp
    actorUserId: v.optional(v.string()),
    actorName: v.optional(v.string()),
    action: v.string(), // 'allocate' | 'reallocate' | 'remove' | 'cancel' | 'reschedule'
    before: v.optional(v.array(v.any())),
    after: v.optional(v.array(v.any())),
  }).index("by_booking", ["bookingId"]),

  // Rate-limit buckets (SEC decision #5 fallback — used when the official
  // @convex-dev/rate-limiter component cannot be installed on Shipper's locked
  // Convex). key = `${action}:${identifier}` (identifier = userId or email).
  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(), // Unix ms — start of the current fixed window
    count: v.number(),
  }).index("by_key", ["key"]),

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
          // athleteId = source of truth (id("athletes")). athleteName is
          // denormalised for history/display if the athlete is renamed/removed
          // (SPEC_PARENT_ATHLETE_MODEL decision #6). Legacy slots have no
          // athleteId — recipient resolution falls back to the name match.
          athleteId: v.optional(v.id("athletes")),
          athleteName: v.string(),
          startHour: v.number(),
          durationMinutes: v.number(),
          accessCode: v.optional(v.string()),
          codeGeneratedAt: v.optional(v.string()),
        })
      )
    ),
    creditApplied: v.optional(v.number()),
    // SPEC_ADD_A_MATE: friends (other Krickora ACCOUNTS) added to this booking
    // for shared front-door access. customerId = the mate's customers._id.
    // Customer bookings only (never set on coach bookings — those use
    // athleteSlots). Mates reuse the owner's single accessCode (one front door).
    mates: v.optional(
      v.array(
        v.object({
          customerId: v.id("customers"),
          addedAt: v.string(),
        })
      )
    ),
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
    // Coach billing: when a coach late-cancels (within coachLateCancellationHours)
    // the slot is charged in full and kept on the coach statement even though the
    // booking is cancelled (SPEC_PAYMENTS_AND_CREDIT #4).
    coachLateCancelCharged: v.optional(v.boolean()),
    // Payment tracking
    paymentStatus: v.optional(v.string()), // 'paid' | 'pending' | 'failed'
    paymentEmailSent: v.optional(v.boolean()), // Dedup guard — prevents duplicate payment confirmation emails
    stripePaymentIntentId: v.optional(v.string()), // Needed to issue partial refunds
    // Admin in-app void/refund (SPEC_ADMIN_MANUAL_POWERS #4). In-app only — no
    // real Stripe money moves yet. `refunded` flags the charge as reversed;
    // mode/amount captured in modificationHistory + creditLedger (reason "refund").
    refunded: v.optional(v.boolean()),
    refundedAt: v.optional(v.string()),
    priceInCents: v.optional(v.number()), // Stored price at booking time (used for edit diff calculation)
    // Admin notes (e.g. "Winter Program", "Trial Session")
    notes: v.optional(v.string()),
    // Pending booking edit (set when a top-up payment is required).
    // SPEC_MODIFY_BOOKING_UPGRADE: this now captures the FULL change-set for a
    // unified modify (date/time/lane/variant + code), not just duration. The
    // extra fields are optional so legacy duration-only edits still validate.
    // Applied by the Stripe webhook (confirmBookingPayment) once the top-up is paid.
    pendingEdit: v.optional(v.object({
      newDuration: v.number(),
      newAdditionalLaneIds: v.optional(v.array(v.string())),
      newPriceInCents: v.number(),
      priceDifference: v.number(), // positive = top-up required, negative = refund
      // Unified modify additions (SPEC_MODIFY_BOOKING_UPGRADE) — all optional.
      newDate: v.optional(v.string()),
      newStartHour: v.optional(v.number()),
      newLaneId: v.optional(v.string()),
      newVariantId: v.optional(v.string()),
      newAccessCode: v.optional(v.string()),     // present → regenerate the door code on apply
      creditApplied: v.optional(v.number()),     // account credit to redeem on confirm (partial-cover top-up)
      actorUserId: v.optional(v.string()),       // who initiated (for the allocation audit log)
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

  // SPEC_ADD_A_MATE: persistent saved-mates list (the "friendships" book). One
  // row per (owner → mate) pair the owner has added to a booking at least once,
  // so the Add-a-Mate search can suggest them again. Directional: owner saves
  // mate. No accept/decline. Removing a saved mate deletes the row(s).
  friendships: defineTable({
    ownerId: v.id("customers"),
    mateId: v.id("customers"),
    savedAt: v.string(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_mate", ["ownerId", "mateId"]),

  // SPEC_ADD_A_MATE: SMS invite tokens for mates who don't have a Krickora
  // account yet. The owner generates one; the sms: deep link carries the token;
  // /join consumes it. status: 'pending' | 'joined' | 'invalidated'. Invalidated
  // when the owner removes the invite or cancels the booking; expiry re-anchors
  // to the new start on reschedule (SPEC_MODIFY_BOOKING_UPGRADE / applyBookingChange).
  bookingInvites: defineTable({
    token: v.string(),
    bookingId: v.id("bookings"),
    invitedByCustomerId: v.id("customers"),
    invitedPhone: v.optional(v.string()),
    status: v.string(), // 'pending' | 'joined' | 'invalidated'
    expiresAt: v.number(), // Unix ms — booking start time
    createdAt: v.string(),
    joinedByCustomerId: v.optional(v.id("customers")),
    joinedAt: v.optional(v.string()),
  })
    .index("by_token", ["token"])
    .index("by_bookingId", ["bookingId"]),

  waitlist: defineTable({
    userId: v.string(),
    userName: v.string(),
    userEmail: v.string(),
    laneId: v.string(),
    date: v.string(), // YYYY-MM-DD
    hour: v.number(),
    notified: v.boolean(),
    // SPEC_WAITLIST_OFFER_REDESIGN: sequential first-refusal lifecycle.
    // 'waiting' (default, also covers legacy rows with no status) | 'offered'
    // (currently holds an exclusive offer until offerExpiresAt) | 'booked'
    // (this user booked the slot) | 'expired' (offer lapsed / slot was filled).
    // Optional so existing rows need no migration — read as (status ?? 'waiting').
    status: v.optional(v.string()),
    offerExpiresAt: v.optional(v.string()), // ISO; set while status='offered'
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
    // Invite discriminator (SPEC_PARENT_ATHLETE_MODEL). Absent/'coach' = the
    // original admin→coach registration invite. 'athlete' = a coach inviting a
    // parent whose account doesn't exist yet; on registration the named child
    // athlete is auto-created under the new account and the coach assigned.
    kind: v.optional(v.string()), // 'coach' | 'athlete'
    childName: v.optional(v.string()), // for kind='athlete' — the child to create
    coachId: v.optional(v.string()), // for kind='athlete' — coach to auto-assign
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
    // Per-day operating hours (single source of truth — was previously
    // localStorage-only, so the backend + other devices couldn't see it).
    // openingHour/closingHour above remain the global fallback.
    dailyHours: v.optional(
      v.array(
        v.object({
          day: v.string(), // 'monday' .. 'sunday'
          open: v.number(),
          close: v.number(),
          closed: v.boolean(),
        })
      )
    ),
    minBookingNoticeMinutes: v.number(),
    coachBookingWindowDays: v.number(),
    customerOpenDay: v.string(),
    customerOpenHour: v.number(),
    l1CoachOpenDay: v.optional(v.string()),
    l1CoachOpenHour: v.optional(v.number()),
    l2CoachOpenDay: v.optional(v.string()),
    l2CoachOpenHour: v.optional(v.number()),
    // Max lanes a customer may book in one booking (SPEC_BOOKING_WINDOW #4).
    // Coaches/admin are exempt. Default 3.
    customerMaxLanesPerBooking: v.optional(v.number()),
    registrationLocked: v.optional(v.boolean()),
    // Advanced booking rule overrides
    coachRescheduleFreezeHours: v.optional(v.number()),  // default 24 — coach can't self-reschedule within N hours
    extensionNoticeMinutes: v.optional(v.number()),       // default 20 — must extend >N min before start
    customerMaxDurationMinutes: v.optional(v.number()),   // default 120
    coachMaxDurationMinutes: v.optional(v.number()),      // default 600
    minAthleteDurationMinutes: v.optional(v.number()),    // default 15
    // Modify-booking move-earlier carve-out (SPEC_MODIFY_BOOKING_UPGRADE). Inside
    // the customer cancellation window a customer may still pull the start EARLIER
    // by at most this many hours (and never inside minBookingNoticeMinutes). Default 1.
    modifyMoveEarlierMaxHours: v.optional(v.number()),
    // Cancellation rules (separated by user type)
    customerCancellationHours: v.optional(v.number()),   // default 2 — customers cannot cancel within N hours
    coachLateCancellationHours: v.optional(v.number()),  // default 24 — coach charged if they cancel within N hours
    // Admin second-factor gate (SPEC_SECURITY_HARDENING #2 — re-enter own password)
    adminGateEnabled: v.optional(v.boolean()),           // default false — do NOT enable until /admin prompt is deployed
    adminUnlockMinutes: v.optional(v.number()),          // default 45 — how long an admin unlock lasts
    // Abandoned-checkout backstop (SPEC_PAYMENTS_AND_CREDIT #3). A pending_payment
    // booking's slot is released this many minutes after creation if unpaid.
    abandonedCheckoutMinutes: v.optional(v.number()),    // default 10
    // Waitlist first-refusal offer hold (SPEC_WAITLIST_OFFER_REDESIGN #3). How
    // long a freed slot is reserved exclusively for the next waitlisted member
    // before the offer rolls to the person behind them. Default 15.
    waitlistOfferHoldMinutes: v.optional(v.number()),    // default 15
    // SPEC_ADD_A_MATE "Misc Settings". Max mates a customer may add to one
    // booking (the owner is NOT counted). Default 3 → 4 people total per net.
    maxMatesPerBooking: v.optional(v.number()),          // default 3
  }).index("by_key", ["key"]),

  // Admin unlock sessions (SPEC_SECURITY_HARDENING #2). One row per admin email;
  // present + unexpired = that admin re-entered their password recently.
  adminUnlocks: defineTable({
    email: v.string(),
    expiresAt: v.number(), // Unix ms
  }).index("by_email", ["email"]),

  // Discount codes
  discountCodes: defineTable({
    code: v.string(),           // lowercase unique code e.g. "julian"
    discount: v.number(),       // 0–100 percent off (used when discountType = 'percent')
    // Discount type (SPEC_ADMIN_AND_SETTINGS #3). Absent = 'percent' (backward compat).
    discountType: v.optional(v.string()), // 'percent' | 'fixed' | 'free'
    amountOff: v.optional(v.number()),     // dollars off, used when discountType = 'fixed'
    label: v.string(),          // display label e.g. "100% Off — Complimentary"
    bypassStripe: v.optional(v.boolean()),  // if true, skip payment entirely (set for 'free')
    active: v.boolean(),
    expiresAt: v.optional(v.string()),      // YYYY-MM-DD or undefined
    usageLimit: v.optional(v.number()),     // max total uses, undefined = unlimited
    perCustomerLimit: v.optional(v.number()), // max uses per customer, undefined = unlimited
    usedCount: v.optional(v.number()),      // optional for backward compat — defaults to 0 in UI
    createdAt: v.string(),
    createdBy: v.optional(v.string()),
  })
    .index("by_code", ["code"])
    .index("by_active", ["active"]),

  // Per-redemption log for discount codes — enables per-customer limit
  // enforcement + an accurate total count (SPEC_ADMIN_AND_SETTINGS #3).
  // One row per confirmed booking that used a code (idempotent by bookingId).
  discountRedemptions: defineTable({
    code: v.string(),
    customerEmail: v.string(),
    bookingId: v.string(),
    at: v.string(),
  })
    .index("by_code", ["code"])
    .index("by_code_email", ["code", "customerEmail"])
    .index("by_bookingId", ["bookingId"]),

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

  // Equipment / facility fault reports (SPEC_ADMIN_AND_SETTINGS #5). Customers
  // and coaches "submit an issue"; reports land in the admin inbox with the lane
  // + details (+ optional photo). Admin decides whether to create a laneBlock —
  // NOT auto-blocked.
  faultReports: defineTable({
    laneId: v.optional(v.string()),   // affected lane, or undefined for general
    category: v.optional(v.string()), // 'equipment' | 'facility' | 'other'
    details: v.string(),
    photoStorageId: v.optional(v.id("_storage")), // optional uploaded photo
    reportedByEmail: v.optional(v.string()),
    reportedByName: v.optional(v.string()),
    status: v.string(),               // 'open' | 'resolved' | 'dismissed'
    adminNote: v.optional(v.string()),
    resolvedByEmail: v.optional(v.string()),
    resolvedAt: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"]),

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
