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
    email: v.optional(v.string()), // server-derived actor email (authed only) — powers the admin activity feed
    metadata: v.optional(v.string()), // JSON-stringified extra data
    userAgent: v.optional(v.string()),
    timestamp: v.number(), // Unix ms
  })
    .index("by_type", ["type"])
    .index("by_timestamp", ["timestamp"])
    .index("by_sessionId", ["sessionId"])
    .index("by_userId", ["userId"])
    .index("by_type_timestamp", ["type", "timestamp"])
    // SPEC_ANALYTICS_BUILD_2026-06 C2.5 — funnel reconstruction reads the
    // booking-flow step events (type='event', name in the funnel-step set) by
    // name within a time window, so the named-event range read is indexed.
    .index("by_name_timestamp", ["name", "timestamp"]),

  // C3 (SPEC_CODE_REVIEW_IMPROVEMENTS_2026-08) — tiny first-seen rollup (one row
  // per visitor identity = auth subject or sessionId), written on the identity's
  // FIRST tracked event. Lets getUsageAnalytics compute all-time new-vs-returning
  // without collecting the whole `analytics` table, and keeps the metric all-time
  // even though `analytics` rows are pruned at 90d (the retention.ts caveat).
  firstSeenByIdentity: defineTable({
    identity: v.string(),
    firstTimestamp: v.number(), // Unix ms of the identity's first event
    // 2026-08-18 — last activity, maintained by trackEvent but THROTTLED to at
    // most one write per identity per hour so the hot path stays cheap. Lets
    // WAU/MAU be counted from this tiny table via by_lastTimestamp instead of
    // scanning raw analytics (which broke the Usage tab entirely). Optional so
    // the field is additive — rows predating it simply read as undefined until
    // that identity is next active, and the backfill seeds them.
    lastTimestamp: v.optional(v.number()),
  })
    .index("by_identity", ["identity"])
    .index("by_lastTimestamp", ["lastTimestamp"]),

  // ============================================================================
  // 2026-08-18 — daily usage roll-up (the durable fix for the Usage tab).
  // ============================================================================
  // One row per AWST calendar date, written by the nightly usage-rollup cron
  // (and a one-off backfill). getUsageAnalytics reads <=90 of these rows instead
  // of up to ~140,000 raw analytics rows, which is what made the tab Server
  // Error at every range.
  //
  // Built by a CRON, deliberately not incrementally in trackEvent: a per-day
  // counter row updated on every pageview would serialise writes on one hot
  // document. The cron reads a single day at a time, which is safely bounded.
  //
  // Map-shaped fields are stored as JSON strings (same convention as
  // analytics.metadata) so the schema stays simple and additive.
  usageDaily: defineTable({
    date: v.string(), // YYYY-MM-DD (AWST calendar day covered)
    events: v.number(), // total analytics rows that day (diagnostic)
    pageviews: v.number(),
    sessions: v.number(), // distinct sessionIds seen that day
    activeIdentities: v.number(), // distinct identities active that day
    newIdentities: v.number(), // identities whose FIRST-EVER event was that day
    sessionSecondsTotal: v.number(), // summed span of sessions with >=2 events
    sessionsMeasured: v.number(), // how many sessions that covers
    sessionMedianSec: v.number(), // median span that day (medians can't be summed)
    device: v.string(), // JSON: { mobile: n, desktop: n, ... }
    os: v.string(), // JSON
    browser: v.string(), // JSON
    topPages: v.string(), // JSON: { "/path": n } — capped to the top 40 paths
    createdAt: v.number(),
  }).index("by_date", ["date"]),

  // ============================================================================
  // SPEC_ANALYTICS_BUILD_2026-06 C2.2 — persisted end-of-day revenue/usage roll-up.
  // ============================================================================
  // One immutable row per AWST calendar date, written by the daily-revenue-snapshot
  // cron (and a one-off backfill). Lets the dashboard read cheap, stable trend
  // history instead of re-scanning every booking on each load, and preserves the
  // figures even if historical bookings are later edited. Upserted by `date`
  // (idempotent re-runs overwrite the same row). Additive — no migration.
  revenueSnapshots: defineTable({
    date: v.string(), // YYYY-MM-DD (AWST calendar day the figures cover)
    custRevenue: v.number(), // dollars — confirmed customer (lane-hire) revenue
    coachCharges: v.number(), // dollars — coach session charges accrued
    bookings: v.number(), // confirmed bookings count (customer + coach)
    customerBookings: v.number(),
    coachBookings: v.number(),
    hours: v.number(), // total booked hours
    occupancyPct: v.number(), // booked hours ÷ open lane-hours capacity × 100
    createdAt: v.number(), // ms when the snapshot row was written
  }).index("by_date", ["date"]),

  // SPEC_ANALYTICS_BUILD_2026-06 C2.4 — push notification event log. One row per
  // lifecycle event so the dashboard can compute sends-by-category, delivery rate,
  // CTR and per-platform splits without instrumenting the (node) sender's return
  // values. `sent`/`failed`/`pruned` are written server-side in the send action;
  // `delivered`/`clicked` arrive from the service worker via the /push/beacon HTTP
  // action. email is stored only for server-side rows (never from the public
  // beacon). Additive — no migration.
  // NOTIFICATIONS INBOX (Inspector, 2026-09-03) — every customer/coach push is
  // also stored here (whether or not a device received it), so the full message
  // can be re-read in the app. A push TAP opens the message in the inbox, except
  // time-sensitive categories (waitlist offers, extend offers) which still jump
  // straight to their action. Admin-ops pushes are NOT stored (Activity feed
  // covers them). Pruned after 7 days (Inspector's call).
  notifications: defineTable({
    email: v.string(), // lowercased recipient
    title: v.string(),
    body: v.string(),
    category: v.string(),
    url: v.optional(v.string()), // the action the push carried (body tap target before this feature)
    actions: v.optional(v.array(v.object({ title: v.string(), url: v.optional(v.string()) }))),
    tag: v.optional(v.string()),
    sentAt: v.number(), // ms
    readAt: v.optional(v.number()),
  })
    .index("by_email_sentAt", ["email", "sentAt"])
    .index("by_sentAt", ["sentAt"]),

  // MACHINE-DEMAND MONITOR (Inspector decision, 2026-09-03): dedupe log for the
  // "N waitlisted for a machine at <day time> and a run-up lane is free —
  // convert?" admin push. One alert per (date, hour).
  adminAlertLog: defineTable({
    key: v.string(),
    at: v.number(),
  }).index("by_key", ["key"]),

  pushEvents: defineTable({
    at: v.number(), // ms
    type: v.string(), // 'sent' | 'failed' | 'pruned' | 'delivered' | 'clicked'
    category: v.optional(v.string()), // push category key (e.g. 'session-reminders')
    platform: v.optional(v.string()), // 'ios' | 'fcm' | 'firefox' | 'windows' | 'other'
    email: v.optional(v.string()), // recipient (server-side rows only; never from beacon)
    tag: v.optional(v.string()),
  }).index("by_at", ["at"]),

  // SERVER-ACTIVITY FEED (2026-06) — email lifecycle events from the Resend webhook
  // (/resend/webhook): sent -> delivered -> opened -> clicked, plus bounced /
  // complained / delivery_delayed. One row per webhook event. Lets the admin
  // activity feed show email delivery in real time without instrumenting any send
  // site. Inert until RESEND_WEBHOOK_SECRET is set + the webhook is configured in
  // Resend. Additive — no migration.
  emailEvents: defineTable({
    at: v.number(), // ms (event time)
    type: v.string(), // 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained' | 'delivery_delayed'
    to: v.optional(v.string()), // recipient email
    subject: v.optional(v.string()),
    emailId: v.optional(v.string()), // Resend email id — correlates one email's lifecycle
  }).index("by_at", ["at"]),

  // DOOR-KEYPAD ENTRY LOG (SPEC_DOOR_ENTRY_LOG_WEBHOOK) — raw keypad entry events
  // pushed by HA via the signed /ha/entry webhook. No PII (v1): the door code is a
  // keyed HMAC hash (codeHash), never the raw code. bookingId is filled in the later
  // attribution phase (§7). Additive — no migration.
  entryEvents: defineTable({
    at: v.number(), // server receive time (ms)
    ts: v.number(), // device unix seconds
    bay: v.string(), // "" for invalid
    codeHash: v.string(), // HMAC hex; "" if none
    result: v.string(), // "valid" | "invalid" | "unknown"
    source: v.string(), // "keypad"
    bookingId: v.optional(v.id("bookings")), // attribution phase
  }).index("by_at", ["at"]),

  // BOWLING-MACHINE USAGE AUDIT (SPEC_MACHINE_USAGE_AUDIT_KRICKORA_2026-06, Phase 2)
  // — each booking's ACTUAL machine-use minutes vs booked duration, pushed by HA at
  // booking end via the signed /ha/usage webhook. HA computes usedMinutes from the
  // lane plug power ("in use" = any non-zero draw). Matched to a bookings row by
  // lane + date + customer/email at insert time (bookingId set only on a confident
  // match; matchStatus flags ambiguous/unmatched for admin review). Additive — no
  // migration. Usage only ever arrives for the 3 BM lanes (run-ups have no machine).
  machineUsage: defineTable({
    at: v.number(), // server receive time (ms)
    ts: v.number(), // device unix seconds (0 if absent)
    lane: v.number(), // physical BM lane 1..3
    laneId: v.string(), // resolved stable id "bm1".."bm3" ("" if unmappable)
    date: v.string(), // resolved AWST booking day YYYY-MM-DD (range queries)
    startHour: v.optional(v.number()), // resolved booking start hour (display/debug)
    customer: v.string(),
    email: v.optional(v.string()),
    bookedMinutes: v.number(),
    usedMinutes: v.number(),
    utilPct: v.number(), // usedMinutes / bookedMinutes * 100
    startISO: v.string(), // booking start from the GCal event
    bookingId: v.optional(v.id("bookings")), // set only on a confident match
    matchStatus: v.string(), // 'matched' | 'ambiguous' | 'unmatched'
  })
    .index("by_at", ["at"])
    .index("by_date", ["date"])
    .index("by_email", ["email"])
    .index("by_bookingId", ["bookingId"]),

  // Application tables
  customers: defineTable({
    name: v.string(), // DERIVED display string = "firstName lastName" (SPEC_NAME_SPLIT)
    // SPEC_NAME_SPLIT: source fields for surname sort + formal addressing.
    // Optional → no forced migration; `name` stays authoritative for all reads.
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    // SPEC_PROFILE_POSTCODE_SUBURB: required location fields (WA only). Optional in
    // the schema → no forced migration; enforced at signup + the login hard-block gate.
    // postcode = 4 digits (6xxx); suburb = a locality of that postcode.
    postcode: v.optional(v.string()),
    suburb: v.optional(v.string()),
    email: v.string(),
    phone: v.optional(v.string()),
    // Email deliverability flag (2026-06) — set true by the Resend webhook
    // (/resend/webhook) when an email to this address bounces/complains; auto-cleared
    // when a later email to it delivers. Surfaces a "Bounced" badge in admin →
    // Customers so a mistyped address (e.g. iinet.au vs iinet.net.au) is caught fast.
    emailBounced: v.optional(v.boolean()),
    emailBounceAt: v.optional(v.number()),
    emailBounceType: v.optional(v.string()), // 'bounced' | 'complained'
    // SPEC_SIGNUP_UPDATES_2026-06 G5 — "How did you hear about us?" captured at
    // signup (required there). referralSource = the chosen option; when it is
    // "Other", the free text the customer typed is stored in referralSourceOther.
    // Optional in schema → no forced migration (legacy accounts have neither).
    referralSource: v.optional(v.string()),
    referralSourceOther: v.optional(v.string()),
    role: v.string(), // 'customer' | 'coach' | 'admin' | 'user' | 'club' (default: 'user' for new signups). 'club' = a no-login team/club booking subject (SPEC_CLUB_TEAM_BOOKINGS_2026-07).
    assignedCoachIds: v.optional(v.array(v.string())),
    creditBalance: v.optional(v.number()),
    color: v.optional(v.string()),
    coachTier: v.optional(v.string()), // 'L1' | 'L2'
    defaultSessionDuration: v.optional(v.number()), // coach default athlete slot duration in minutes
    athleteCapacity: v.optional(v.number()), // coach max athletes per session (1-5); drives auto-populate
    // Weekly billing cap (2026-07): the MOST this coach is charged per Mon–Sun week
    // of coach sessions (dollars). When a week's booked charges exceed it, a system
    // statement-adjustment line ("Weekly billing cap") credits the excess so the
    // week nets to the cap. Reconciled on coach booking create/cancel + a nightly
    // cron (convex/billingCaps.ts). Absent/undefined = no cap.
    weeklyBillingCap: v.optional(v.number()),
    // Coach allocation mode (2026-06): UNticked/absent (default) = coach runs athletes
    // SEQUENTIALLY → auto-advance the next slot's start + smart-order the athlete picker
    // by recent history. ticked (true) = coaches multiple at once → independent slots.
    coachesSimultaneously: v.optional(v.boolean()),
    // 2026-06: hide this coach from the PUBLIC coach list (signup form + the My
    // Athletes "add coaches" picker) while keeping the account fully functional for
    // bookings/allocation. Used for the owner account (Noddy) and any coach that
    // shouldn't be publicly selectable. Admin-toggled on the coach edit form.
    hideFromPublicCoachList: v.optional(v.boolean()),
    // SPEC_COACH_FLEXIBLE_WINDOW_2026-07: admin grants THIS coach a shorter
    // modify/cancel restriction — they can modify or cancel (no late-cancel charge)
    // right up to `coachFlexibleWindowHours` (default 3h) before the session, instead
    // of the standard coach window (coachRescheduleFreezeHours / coachLateCancellationHours,
    // default 24h). Per-coach opt-in; absent/false = the standard window. Additive.
    flexibleBookingWindow: v.optional(v.boolean()),
    // SPEC_EARLY_ACCESS_2026-08: admin-only, unadvertised special access to the
    // 6:30am pre-open slot — a manual per-account grant, independent of role or
    // coach tier (works for a coach OR a customer). Previously this slot was an
    // automatic perk of coach tier L1; that implicit grant is gone and every
    // account (including tier-L1 coaches) now needs this flag explicitly.
    // Absent/false = no early access, same as the pre-open floor for everyone else.
    earlyAccess630: v.optional(v.boolean()),
    // BOOKING LOCK (Inspector, 2026-09-03) — admin suspends this account from
    // making or changing bookings (customer OR coach). Enforced server-side on
    // every self-service path: create, split, extend, modify, waitlist join.
    // Cancelling stays allowed. Admin manual bookings on their behalf are NOT
    // blocked (an explicit admin act). The reason is admin-only; the customer
    // sees a generic "contact us" message.
    bookingLocked: v.optional(v.boolean()),
    bookingLockReason: v.optional(v.string()),
    bookingLockedAt: v.optional(v.number()),
    bookingLockedBy: v.optional(v.string()),
    bookingEmailsEnabled: v.optional(v.boolean()),
    // Bug 7: master email switch. Strict === false silences ALL preference-gated
    // emails (regular notifications + the weekly summary); legacy/absent = ON. Does
    // NOT affect mandatory transactional/athlete/mate emails or admin broadcasts.
    emailNotificationsEnabled: v.optional(v.boolean()),
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
    // SPEC_MERGE_DUPLICATE_ACCOUNTS: set on the LOSER row when it is merged into
    // another account. The row is soft-deleted (deactivatedAt set, email
    // tombstoned, credit zeroed) and all its references are repointed to the
    // survivor; this marker records which account it folded into (audit + the
    // never-delete rule). Survivor rows never carry it.
    mergedIntoCustomerId: v.optional(v.id("customers")),
    // FACILITY_ACCESS_PUSH (2026-06): true once the one-time "how to find us" push
    // has been sent ~1 h before this customer's FIRST-ever session — guards against
    // re-sending on later bookings. Additive/optional → no migration.
    facilityAccessPushSent: v.optional(v.boolean()),
    // SPEC_TEAM_BOOKING_AUTODOOR_2026-07: team-account default — when true, EVERY
    // booking for this customer auto-tags for the HA roller-door auto-open (without
    // ticking each booking). Effective per-booking flag = booking.autoDoor OR this.
    // Set true for team accounts (e.g. Balcatta CC). Additive/optional → no migration.
    autoDoorDefault: v.optional(v.boolean()),
    createdAt: v.string(),
  })
    .index("by_email", ["email"])
    .index("by_role", ["role"])
    .index("by_createdAt", ["createdAt"]), // E9: hourly-digest new-account range (ISO sorts chronologically)

  // Child-athlete entities (SPEC_PARENT_ATHLETE_MODEL). Separates the ACCOUNT
  // holder (customers — parent/guardian or adult who logs in, pays, receives
  // emails) from the ATHLETE (the trainee a coach sees). One account → many
  // athletes. assignedCoachIds lives HERE now (per-athlete), not on customers.
  athletes: defineTable({
    accountCustomerId: v.id("customers"), // owning account (parent/adult)
    name: v.string(), // DERIVED display string = "firstName lastName" — what coaches see
    // SPEC_SIGNUP_UPDATES_2026-06 G3 — athletes get first/last source fields,
    // mirroring the customer Name-Split pattern. `name` stays the authoritative
    // derived read so every existing roster/allocation/email read is untouched.
    // Optional → no forced migration (migrateAthleteNames backfills these).
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    assignedCoachIds: v.optional(v.array(v.string())), // coach _id(s) for THIS athlete
    isSelf: v.optional(v.boolean()), // true = the account holder training themselves
    dob: v.optional(v.string()), // reserved, unused for now — enables future age groups w/o migration
    notes: v.optional(v.string()), // optional coach/parent notes
    createdAt: v.string(),
  }).index("by_account", ["accountCustomerId"]),

  // SPEC_PUSH_NOTIFICATIONS_V2 §6.2 — one row each time a CUSTOMER/parent links a
  // coach to one of their athletes (signup or My Athletes). Powers the hourly
  // admin digest's "customers who added a coach" count without a per-link
  // timestamp on the athletes row. Additive, no migration.
  coachLinkEvents: defineTable({
    accountId: v.id("customers"), // the account/parent that added a coach
    at: v.number(), // ms
  }).index("by_at", ["at"]),

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
    // 'waitlist-alt' (SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part B) = an AUTOMATIC
    // exclusive alternative-time offer hold. Distinct from 'waitlist' so the
    // exact-hour engine's pool-wide hold cleanup never deletes it; treated as a
    // waitlist-class hold by the conflict checker (offeree passes their own,
    // coaches/admin bypass).
    holdType: v.string(), // 'checkout' | 'waitlist' | 'waitlist-alt'
    bookingId: v.optional(v.string()), // checkout holds → the pending_payment booking
    userId: v.optional(v.string()),
    userEmail: v.optional(v.string()),
    expiresAt: v.number(), // Unix ms
    createdAt: v.string(),
  })
    .index("by_laneId_date", ["laneId", "date"])
    .index("by_bookingId", ["bookingId"])
    // BUGM-1 (audit 2026-06): conflict checks must see a multi-lane hold via ANY of
    // its lanes (additionalLaneIds), which by_laneId_date (primary lane only) can't
    // do. by_date reads the whole day once, then the handler tests every hold's full
    // lane set. Additive index — no migration.
    .index("by_date", ["date"])
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
  })
    .index("by_key", ["key"])
    // SEC-3 (audit 2026-06): rows are abandoned once their window lapses (one per
    // action:identifier; SEC-1 XFF spoofing can balloon distinct keys). The hourly
    // retention cron range-deletes stale buckets via this index. Additive.
    .index("by_window", ["windowStart"]),

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
    status: v.string(), // 'confirmed' | 'pending' | 'pending_payment' | 'cancelled'
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
          // SPEC_ANALYTICS_ATHLETE_CATCHMENT: snapshot of the athlete's home
          // postcode/suburb (= their parent/account holder's), resolved at
          // allocation time and written server-side. Powers the "Athletes coached
          // by suburb" report without a live join, preserving history if a family
          // moves. Absent on legacy/unresolvable slots → bucketed as "Unknown".
          athletePostcode: v.optional(v.string()),
          athleteSuburb: v.optional(v.string()),
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
    // 2026-09-03 (Inspector) — WHY an admin cancelled on someone's behalf. A third
    // of coach cancellations are admin-made; without this the analytics can't tell
    // a phoned-in coach request from an admin-initiated cancel. Required in the
    // admin modal; absent on self-cancels and legacy rows.
    //   'coach_requested' | 'customer_requested' | 'no_show' | 'facility' | 'error' | 'other'
    cancelReason: v.optional(v.string()),
    cancelNote: v.optional(v.string()),
    refilledMinutes: v.optional(v.number()),
    originalCoachId: v.optional(v.string()),
    accessCode: v.optional(v.string()),
    discountCode: v.optional(v.string()),
    // SPEC_PROFILE_POSTCODE_SUBURB Addendum A: snapshot of the booker's postcode/suburb
    // at booking time (NOT a live join — preserves catchment history if a customer moves).
    // Set for customer + admin-manual bookings; left blank on coach own-bookings.
    bookingPostcode: v.optional(v.string()),
    bookingSuburb: v.optional(v.string()),
    googleCalendarEventId: v.optional(v.string()),
    // SPEC_CALENDAR_SYNC_RELIABILITY_2026-06 — visibility flag set by
    // createCalendarEvent: 'synced' when the primary lane event was created,
    // 'failed' when the Google write silently failed (the class behind the
    // 2026-06-23 missing-event lockouts). Additive/optional → no migration; the
    // daily reconcile cron + the backfill target failed/missing rows. Absent on
    // legacy rows (never marks them failed).
    calendarSyncStatus: v.optional(v.string()), // 'synced' | 'failed'
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
    paymentStatus: v.optional(v.string()), // 'paid' | 'pending' | 'failed' | 'unpaid' | 'waived' | 'refunded'. 'unpaid' = confirmed offline/club booking awaiting offline payment (admin marks paid on receipt) — SPEC_CLUB_TEAM_BOOKINGS.
    paymentEmailSent: v.optional(v.boolean()), // Dedup guard — prevents duplicate payment confirmation emails
    stripePaymentIntentId: v.optional(v.string()), // Needed to issue partial refunds
    // Admin in-app void/refund (SPEC_ADMIN_MANUAL_POWERS #4). In-app only — no
    // real Stripe money moves yet. `refunded` flags the charge as reversed;
    // mode/amount captured in modificationHistory + creditLedger (reason "refund").
    refunded: v.optional(v.boolean()),
    refundedAt: v.optional(v.string()),
    // SPEC_STATEMENTS_EDITING — admin "removed" this coach booking's charge from the
    // statement. Reversible: the booking + its data are kept; the charge just drops
    // off the coach statement (treated as $0 in the ledger). Set via
    // mutations.adminSetBookingStatementExcluded. Absent = charged normally.
    statementExcluded: v.optional(v.boolean()),
    // Set by the Stripe webhook when a payment confirms for an already-cancelled
    // booking (audit 2026-06-10 money-hole #1 backstop). The customer was charged
    // but has no live booking → admin must refund. Surfaced via an admin alert.
    needsRefund: v.optional(v.boolean()),
    priceInCents: v.optional(v.number()), // Stored price at booking time (used for edit diff calculation)
    // SPEC_RECONFIGURABLE_LANES: denormalised snapshot of the date-resolved lane
    // name + variant label, set at create + re-set at modify (resolved at the
    // booking's (date, startHour)). Emails read these so they stay correct even
    // after a layout change or a modify across a date boundary. laneId/variantId
    // stay as the stable keys; calendars resolve live by date+hour.
    laneNameSnapshot: v.optional(v.string()), // e.g. "BM 1"
    variantLabelSnapshot: v.optional(v.string()), // e.g. "Truman" / "Machine" / "9m Run Up"
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
    // SPEC_SCHEDULE_DAY_VIEW §2.13: a coach booking created BY an admin (from the
    // manual-booking modal with "Managed by admin" ticked, default ON) is
    // view+allocate-only for the coach — Modify/Cancel/Repeat are hidden in the UI
    // AND server-rejected for non-admin callers. Allocation is never blocked.
    // Additive/optional → no migration; only marks bookings made from this deploy on.
    createdByAdmin: v.optional(v.boolean()),
    // SPEC_PUSH_NOTIFICATIONS_V2 §6.2 — creation timestamp in ms, for the hourly
    // admin digest's "new bookings last hour" count. Additive/optional → legacy
    // bookings have none and are simply not counted by the digest.
    createdAt: v.optional(v.number()),
    // SPEC_TEAM_BOOKING_AUTODOOR_2026-07: per-booking "auto-open the roller door"
    // flag. When the EFFECTIVE flag (this OR the customer's autoDoorDefault) is set,
    // the calendar event description carries the `🚪 AUTO-DOOR` token that HA matches
    // to auto-open/hold/close the roller door for a team booking. Admin-set only.
    // Additive/optional → no migration; absent = normal (door-code-only) access.
    autoDoor: v.optional(v.boolean()),
    // SPEC_CLUB_TEAM_BOOKINGS_2026-07: true when the booking subject is a club/team
    // (a no-login customers row, role "club"). Club bookings always use door code 2026
    // + auto-door, send no emails, and show the FULL club name on the TV board (no
    // "First L." truncation). Additive/optional → no migration.
    isClubBooking: v.optional(v.boolean()),
    // SPEC_CLUB_TEAM_BOOKINGS_2026-07: shared id for all rows created together in one
    // multi-date/recurring batch (a "block"). Lets an admin action (e.g. mark
    // paid/unpaid) apply to the whole block at once. Additive/optional → no migration;
    // legacy/single bookings may have none (treated as a group of one).
    bookingGroupId: v.optional(v.string()),
    // SPEC_COACH_SPLIT_LANE_BOOKING_2026-08: set on LEG 2 of a split-lane coach
    // session, pointing at leg 1 (the "carrier" — holds the full coachPrice, the
    // shared door code and the athlete allocation; leg 2 is $0 + statementExcluded).
    // Cancel/repeat act on the pair; the reminder cron skips leg-2 rows. Additive/
    // optional → no migration; absent = a normal standalone booking.
    splitParentId: v.optional(v.id("bookings")),
    // SPEC_CUSTOMER_INSESSION_EXTEND_2026-08: set on an in-session EXTENSION row,
    // pointing at the booking it extends (the extension is a normal paid customer
    // booking for the extra window — own laneId set, own priceInCents — sharing the
    // parent's door code). MyBookings merges the pair for display; the reminder
    // cron skips extension rows. Additive/optional → no migration.
    extensionOfId: v.optional(v.id("bookings")),
    // SPEC_CUSTOMER_INSESSION_EXTEND_2026-08: true once the one-time T-10 "extend
    // your session?" push was sent for this booking (only sent when an extension
    // is actually available at send time). Additive/optional → no migration.
    extendOfferPushSent: v.optional(v.boolean()),
  })
    .index("by_date", ["date"])
    .index("by_laneId_date", ["laneId", "date"])
    .index("by_userId", ["userId"])
    .index("by_customerEmail", ["customerEmail"])
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"])
    .index("by_bookingGroupId", ["bookingGroupId"])
    .index("by_splitParentId", ["splitParentId"])
    .index("by_extensionOfId", ["extensionOfId"]),

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
    // SPEC_ANALYTICS_BUILD_2026-06 — ms timestamp the current offer was made, set
    // alongside status='offered'. Lets the response analytics measure how long a
    // member took to accept/decline (or that they never acted). Additive/optional.
    offeredAt: v.optional(v.number()),
    // OFFERED-SLOT SNAPSHOT (2026-09-05) — WHICH lane/start/length the live offer
    // is for. Before these existed the offered lane lived ONLY on the protecting
    // `slotHolds` row, and the only query returning holds is the admin-gated
    // queries.listWaitlistAdmin — so the offeree's own client could not tell them
    // what they had been offered. A client that guesses a free lane from public
    // data books the WRONG lane whenever the pool has more than one free lane:
    // consumeWaitlistHoldForBooking matches the hold by the BOOKED lane, so the
    // real hold is never consumed, the entry is never marked 'booked', and the
    // orphaned hold fences that lane until it expires while the roll-on re-offers
    // it to someone else.
    //
    // Written ONLY at the moment status becomes 'offered' (advanceWaitlistOffer
    // step 5) and CLEARED on every path that ends that offer — see
    // CLEAR_OFFERED_SLOT in waitlist.ts. They are a snapshot of ONE offer
    // instance, so a reader must gate on
    //   status === 'offered' && offerExpiresAt > now
    // exactly as it already must for offerExpiresAt itself; outside that gate the
    // values are meaningless even when present.
    //
    //   offeredLaneId     the REAL lane id the hold sits on (never a sentinel)
    //   offeredLaneName   display name resolved from live lane config at offer
    //                     time ("BM 2" / "RU 4") — snapshot, so a client never
    //                     re-derives it from a stale local lane map
    //   offeredStartHour  the SNAPPED start, which can differ from `hour` on a
    //                     custom-start grid (e.g. entry hour 10, offered 10.5)
    //   offeredMinutes    the offered length; 60, or the member's longer
    //                     durationMinutes preference where the lane could host it
    offeredLaneId: v.optional(v.string()),
    offeredLaneName: v.optional(v.string()),
    offeredStartHour: v.optional(v.number()),
    offeredMinutes: v.optional(v.number()),
    // SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part B — automatic alternative-time
    // offers. All additive/optional.
    //   altTimeOptIn: false = "only tell me about the exact hour I asked for"
    //     (absent → true, the D4 default-ON checkbox at join).
    //   lastAltOfferAt: ms of the most recent auto alt-offer sent to this entry
    //     (R6 — at most one per entry per AWST day).
    //   altOfferDeclined: they pressed Pass on an auto alt-offer → never again
    //     for this entry (R6).
    altTimeOptIn: v.optional(v.boolean()),
    lastAltOfferAt: v.optional(v.number()),
    altOfferDeclined: v.optional(v.boolean()),
    // Part C2 — ms of the last weekly "still waiting?" reminder sent for this entry.
    lastStillWaitingReminderAt: v.optional(v.number()),
    // Part C3 — preferred session length in minutes (absent = 60). The exact-hour
    // engine offers this much if the freed lane can host it from the offered
    // start, else falls back to 60 — a 2h gap used to be offered as 1h and the
    // rest went unsold.
    durationMinutes: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_slot", ["laneId", "date", "hour"])
    .index("by_laneId_date", ["laneId", "date"])
    // Part A3 — retention prune by date (lexicographic == chronological).
    .index("by_date", ["date"]),

  // SPEC_WAITLIST_ALT_TIME_OFFER_2026-08 — an admin offering a queue a DIFFERENT
  // time from the one they're waiting on (e.g. a 9am cancellation offered to the
  // 8am queue). This is deliberately NOT the exclusive first-refusal engine in
  // `waitlist`: with several recipients it is an open RACE — first to book wins,
  // no hold — which is why the notification says so. A SINGLE recipient does get
  // the usual exclusive slotHold (Inspector's call, 2026-08-14).
  //
  // Offers are pool-level ("a BM lane at 9am"), never a pinned lane, so the link
  // survives the originally-freed lane being taken while another in the pool is
  // still free. Liveness is computed, not stored: an offer is live while
  // status==='live' AND the session start has not passed AND a lane in the pool is
  // still actually free — so a public customer booking the slot kills it with no
  // write-path coupling.
  waitlistOffers: defineTable({
    pool: v.string(), // 'bm' | 'ru'
    date: v.string(), // YYYY-MM-DD of the OFFERED slot
    hour: v.number(), // offered start hour
    sourceHour: v.number(), // the hour the queue was waiting on (for the copy)
    recipients: v.array(
      v.object({
        userId: v.string(),
        userEmail: v.string(),
        userName: v.string(),
        waitlistEntryId: v.optional(v.string()), // their original queue row
      })
    ),
    exclusive: v.boolean(), // true = single recipient, slot held for them
    // 'expired' / 'declined' are AUTO exclusive offers only (timer lapsed / Pass).
    status: v.string(), // 'live' | 'booked' | 'cancelled' | 'expired' | 'declined'
    token: v.string(), // random; the deep link is /?offer=<token>
    bookedByEmail: v.optional(v.string()),
    bookedBookingId: v.optional(v.string()),
    createdAt: v.number(),
    createdByEmail: v.string(),
    // SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part B — automatic offers. Absent on
    // every admin-created row (read as 'admin').
    //   source: 'admin' | 'auto'
    //   expiresAt: ms the exclusive auto hold lapses (sequential mode only)
    //   freedHour: the whole hour whose free-up triggered this offer — the
    //     sequential chain re-runs the pass for it on expiry/decline
    //   laneId: the lane the exclusive auto hold sits on
    source: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    freedHour: v.optional(v.number()),
    laneId: v.optional(v.string()),
  })
    .index("by_token", ["token"])
    .index("by_slot", ["date", "hour"])
    .index("by_status", ["status"]),

  // SPEC_ANALYTICS_BUILD_2026-06 — waitlist offer lifecycle log (one row per offer
  // outcome). 'offered' is written when the exclusive offer is made; 'accepted'
  // (the offeree booked the held slot), 'declined' (pressed Pass/Deny) and
  // 'expired' (the hold lapsed with no button press) each carry latencyMs = the
  // time from the offer to the action. Powers "median time-to-accept/reject" and
  // "% who never press a button". Additive — no migration.
  waitlistOfferEvents: defineTable({
    at: v.number(), // ms
    action: v.string(), // 'offered' | 'accepted' | 'declined' | 'expired'
    email: v.optional(v.string()),
    laneId: v.optional(v.string()),
    date: v.optional(v.string()),
    hour: v.optional(v.number()),
    latencyMs: v.optional(v.number()), // response actions only (time since offer)
  }).index("by_at", ["at"]),

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
    // Stripe-hosted receipt URL (the charge's receipt_url), captured at checkout so
    // the customer Payments screen can link to the real receipt. Optional/additive.
    receiptUrl: v.optional(v.string()),
  })
    .index("by_stripeSessionId", ["stripeSessionId"])
    .index("by_customerEmail", ["customerEmail"])
    .index("by_status", ["status"])
    // MON-2 (audit 2026-06): recordStripePaymentInternal's per-booking idempotency
    // check ran as a full-table .filter() on every payment confirm. Additive index.
    .index("by_bookingId", ["bookingId"])
    .index("by_date", ["date"]),

  // SPEC_PAYMENT_LINK_TRACKING_2026-07 — admin-sent Stripe payment links (top-up +
  // manual payment requests). Previously a link only became visible when PAID (the
  // webhook wrote a stripePayments row) — sent-but-unpaid links were invisible, so
  // a part-paid booking looked underbilled. NB createPaymentLink uses Stripe's
  // NATIVE Payment Links product (plink_…), which spawns a NEW Checkout Session
  // per open — so the stable join key is the payment-link id, and the paying
  // session id is only known (and stored) once checkout.session.completed arrives.
  paymentLinks: defineTable({
    bookingId: v.optional(v.string()),
    stripePaymentLinkId: v.string(), // plink_… (join key to the webhook via session.payment_link)
    stripeSessionId: v.optional(v.string()), // cs_… of the PAYING session, set on completed
    purpose: v.string(), // 'topup' | 'manual'
    amountCents: v.number(),
    currency: v.string(), // 'AUD'
    status: v.string(), // 'pending' | 'paid' | 'cancelled'
    customerName: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    sentToEmail: v.optional(v.string()), // set when emailToCustomer was ticked
    url: v.string(),
    description: v.string(),
    createdBy: v.string(), // admin email (server-derived)
    createdAt: v.number(), // ms
    paidAt: v.optional(v.number()), // ms
    cancelledAt: v.optional(v.number()), // ms
    manualPaid: v.optional(v.boolean()), // paid offline via admin "mark paid"
    receiptUrl: v.optional(v.string()),
  })
    .index("by_link", ["stripePaymentLinkId"])
    .index("by_booking", ["bookingId"])
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"]),

  // Site-wide settings (singleton - only one document)
  siteSettings: defineTable({
    key: v.string(), // always "global"
    customerPricePerHour: v.number(),
    // DEPRECATED (C1): per-hour pricing is canonical (1.5hr = 1.5×hourly). Kept optional
    // so existing docs still validate; unset by migrateRemove90MinPricing, then droppable.
    customerPrice90Min: v.optional(v.number()),
    trumanPricePerHour: v.number(),
    trumanPrice90Min: v.optional(v.number()),
    // SPEC_30MIN_GAP_FILL — explicit 30-min gap-fill price (dollars). Optional; the
    // PRICE_DEFAULTS fallback ($20 std/run-up, $25 Truman) applies when unset.
    thirtyMinPrice: v.optional(v.number()),
    trumanThirtyMinPrice: v.optional(v.number()),
    coachPerHour: v.number(),
    coachPer30Min: v.optional(v.number()), // DEPRECATED (C2) — coach price is per-hour only
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
    // Hours before the weekly release to START showing the "next week opens" live
    // countdown banner. When time-to-release exceeds this, the banner is hidden.
    releaseCountdownHours: v.optional(v.number()),
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
    // SPEC_COACH_FLEXIBLE_WINDOW_2026-07: the shorter window (hours) used for coaches
    // flagged flexibleBookingWindow — they may modify/cancel (no charge) up to this many
    // hours before the session, instead of the 24h defaults. default 3.
    coachFlexibleWindowHours: v.optional(v.number()),
    // Admin second-factor gate (SPEC_SECURITY_HARDENING #2 — re-enter own password)
    adminGateEnabled: v.optional(v.boolean()),           // default false — do NOT enable until /admin prompt is deployed
    adminUnlockMinutes: v.optional(v.number()),          // default 45 — how long an admin unlock lasts
    // Abandoned-checkout backstop (SPEC_PAYMENTS_AND_CREDIT #3). A pending_payment
    // booking's slot is released this many minutes after creation if unpaid.
    abandonedCheckoutMinutes: v.optional(v.number()),    // default 10
    // SPEC_CHECKOUT_ABANDONMENT — minutes after a Stripe session is created before
    // an unpaid booking is auto-cancelled AND its session expired (default 10).
    abandonedCheckoutQuickMinutes: v.optional(v.number()),
    // Waitlist first-refusal offer hold (SPEC_WAITLIST_OFFER_REDESIGN #3). How
    // long a freed slot is reserved exclusively for the next waitlisted member
    // before the offer rolls to the person behind them. Default 15.
    waitlistOfferHoldMinutes: v.optional(v.number()),    // default 15
    // SPEC_WAITLIST_AUTO_ALT_TIME_2026-08 Part B — automatic alternative-time
    // offers to nearby-hour waiters when a slot frees and its own queue is empty.
    //   enabled: kill switch (default true)
    //   windowHours: ±N hours around the waiter's hour (default 2)
    //   broadcastWithinHours: if the freed session starts within N hours, tell
    //     EVERY eligible waiter at once (no hold, race) instead of one at a time
    //     with a 15-min hold (default 5 — Inspector 2026-09-02)
    waitlistAutoAltOffersEnabled: v.optional(v.boolean()),
    waitlistAltTimeWindowHours: v.optional(v.number()),
    waitlistAltTimeBroadcastWithinHours: v.optional(v.number()),
    // Part C2 — weekly "you're still #N for Thu 7pm — stay or leave?" reminder.
    //   enabled: kill switch (default true)
    //   days: minimum age of an entry, and minimum gap between reminders (default 2 —
    //     measured 2026-09-02: 75% of joins are <24h before the session; 7 never fires)
    waitlistStillWaitingReminderEnabled: v.optional(v.boolean()),
    waitlistStillWaitingReminderDays: v.optional(v.number()),
    // Part C4 — max LIVE waitlist places one account may hold (default 10).
    waitlistMaxEntriesPerAccount: v.optional(v.number()),
    // MACHINE-DEMAND MONITOR (2026-09-03) — push the admins when this many people
    // are waitlisted for a bowling machine at one time while a run-up lane is
    // unbooked. Conversion stays declare-ahead (admin override); customers see
    // nothing. Default 2 (Inspector).
    machineDemandAlertMinWaiters: v.optional(v.number()),
    // SPEC_ADD_A_MATE "Misc Settings". Max mates a customer may add to one
    // booking (the owner is NOT counted). Default 2 → 3 people total per net
    // (matches the facility "max 3 people per lane" safety rule).
    maxMatesPerBooking: v.optional(v.number()),          // default 2
    // SPEC_PWA_PUSH_NOTIFICATIONS §5.7 global kill-switch. When false, sendPush
    // short-circuits — all push disabled instantly without a deploy (email
    // unaffected). Default true.
    pushEnabledGlobal: v.optional(v.boolean()),
    // 2026-09-03 (Inspector) — INFORMATIONAL notifications (waitlist offers, the
    // still-waiting check-in, session reminders) go by push only when the
    // recipient is reachable by push; the email is sent only when they are not.
    // Emails that are a durable record (confirmations with door codes, receipts,
    // cancellations, verification) always send. Default true. Reverses the
    // 2026-08-14 "both channels every time" ruling on Inspector's call.
    emailSkipWhenPushReachable: v.optional(v.boolean()),
    // SPEC_MOBILE_APP_GATE_2026-06 (built 2026-09-03). Gate-at-action wall that
    // nudges MOBILE WEB users to install the PWA → log in → enable push, at the
    // two high-intent moments only (Book/Confirm, My Bookings while logged out).
    // Ships with mobileGateEnabled FALSE — flip on in a separate action.
    mobileGateEnabled: v.optional(v.boolean()),           // default false
    mobileGateScope: v.optional(v.string()),              // 'booking-action' | 'blanket' | 'off'
    mobileGateAndroidHardWall: v.optional(v.boolean()),   // default false (Android push works in mobile web)
    mobileGatePushSnoozeDays: v.optional(v.number()),     // default 14
    mobileGateExemptCoachesFromPush: v.optional(v.boolean()), // default true
    // EML-3 (audit 2026-06) — where equipment/facility fault reports are emailed.
    // Absent → falls back to the hardcoded ops inbox. Additive.
    faultReportEmail: v.optional(v.string()),
  }).index("by_key", ["key"]),

  // ============================================================================
  // WEB PUSH (SPEC_PWA_PUSH_NOTIFICATIONS) — additive, no migration.
  // ============================================================================
  // One row per subscribed device. Keyed by email (the stable per-person login
  // identity, available at every notification send-site; §6 alt confirmed at
  // build — admin/coach/customer are all one auth user, so email is the natural
  // join key here). userId (auth subject) stored too for completeness.
  pushSubscriptions: defineTable({
    email: v.string(), // lowercased account email
    userId: v.optional(v.string()), // Better Auth subject at subscribe time
    endpoint: v.string(), // unique per device/browser
    p256dh: v.string(),
    auth: v.string(),
    deviceLabel: v.string(), // e.g. "iPhone · Safari"
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_endpoint", ["endpoint"]),

  // Per-person push category preferences. categories is a sparse map
  // categoryKey -> boolean; an ABSENT key defaults ON for the relevant role.
  // categories is a sparse map categoryKey -> boolean. Uses v.record (not v.object)
  // because the category keys contain hyphens, which object-validator identifiers
  // disallow. An ABSENT key defaults ON for the relevant role.
  pushPreferences: defineTable({
    email: v.string(),
    categories: v.record(v.string(), v.boolean()),
    // SPEC_ADMIN_BROADCAST §5 — broadcast opt-outs (affect BOTH push + email).
    // Absent = opted in (true). receiveAnnouncements mutes ANNOUNCEMENT-tier
    // broadcasts (urgent ignores it); receiveMarketing opts out of PROMOTIONAL
    // broadcasts (set false by the email unsubscribe link).
    receiveAnnouncements: v.optional(v.boolean()),
    receiveMarketing: v.optional(v.boolean()),
    // SPEC_PUSH_NOTIFICATIONS_V2 §4 — once-only guard. Set true the first time this
    // account enables push, after auto-disabling the superseded email slugs. Absent
    // = the one-time auto-off has not run yet. Never auto-flips a second time.
    pushEmailDefaultsApplied: v.optional(v.boolean()),
  }).index("by_email", ["email"]),

  // SPEC_ADMIN_BROADCAST §5 — sent broadcasts (audit + history list). One row per
  // send; counts updated as the scheduler fans out. Additive, no migration.
  broadcasts: defineTable({
    createdBy: v.string(),       // admin userId / email
    createdByName: v.optional(v.string()),
    createdAt: v.number(),       // Unix ms
    title: v.string(),
    body: v.string(),
    link: v.optional(v.string()),
    broadcastType: v.string(),   // 'announcement' | 'urgent'
    isPromotional: v.boolean(),
    scope: v.string(),           // 'day'|'week'|'month'|'all'|'range'
    scopeStart: v.optional(v.string()),  // YYYY-MM-DD (period/range scopes)
    scopeEnd: v.optional(v.string()),
    recipientTypes: v.array(v.string()), // ['customer','coach','athlete']
    alsoEmailAll: v.boolean(),
    recipientCount: v.number(),
    pushCount: v.number(),
    emailCount: v.number(),
    status: v.string(),          // 'sending' | 'sent' | 'failed'
  }).index("by_createdAt", ["createdAt"]),

  // SPEC_INAPP_BANNERS — admin-managed, dismissable in-app banners / pop-ups shown
  // when a targeted user NEXT opens the app (no push, no email — purely in-app).
  // Complements the OUTBOUND broadcasts table above. Additive, no migration.
  announcements: defineTable({
    createdBy: v.string(),       // admin userId / email
    createdByName: v.optional(v.string()),
    createdAt: v.number(),       // Unix ms
    title: v.string(),
    body: v.string(),
    ctaLabel: v.optional(v.string()),
    ctaTarget: v.optional(v.string()),   // internal route (/bookings) or external URL
    displayType: v.string(),     // 'banner' | 'modal'
    style: v.string(),           // 'info' | 'notice' | 'promo'
    audienceMode: v.string(),    // 'all' | 'roles' | 'bookingRange'
    // For audienceMode='all': when true the banner ALSO shows to logged-out viewers
    // (public landing notices; dismissal then falls back to localStorage). §3/§8 #1.
    includeLoggedOut: v.optional(v.boolean()),
    // For 'roles' (which roles see it) OR a sub-filter on 'bookingRange'
    // (narrows "accounts with a booking in range" by role). Subset of
    // ['customer','coach','admin'] (bookingRange uses customer/coach/athlete).
    audienceRoles: v.optional(v.array(v.string())),
    rangeStart: v.optional(v.string()), // YYYY-MM-DD (bookingRange)
    rangeEnd: v.optional(v.string()),
    startAt: v.optional(v.number()),    // Unix ms — auto show from (client-evaluated)
    endAt: v.optional(v.number()),      // Unix ms — auto hide after (client-evaluated)
    dismissible: v.boolean(),           // default true
    priority: v.number(),               // default 0; higher shows first
    active: v.boolean(),                // default true; admin master toggle
  }).index("by_active", ["active"]),

  // SPEC_INAPP_BANNERS — per-user, server-side dismissals (consistent across a
  // user's devices). userId = the caller's lowercased email (the stable identity
  // used across this app). Logged-out dismissals use localStorage instead (§3).
  announcementDismissals: defineTable({
    announcementId: v.id("announcements"),
    userId: v.string(),          // lowercased email
    dismissedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_announcement", ["announcementId"])
    .index("by_user_announcement", ["userId", "announcementId"]),

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
  // RECONFIGURABLE LANES (SPEC_RECONFIGURABLE_LANES)
  // ============================================================================
  // Default lane layout — one row per physical lane (bm1..ru2). A day's config
  // is a list of time SEGMENTS (usually one all-day segment). laneId is STABLE
  // (the GCal/booking/HA contract); bayNumber is the GLOBAL 1..5 display number.
  // Derived per segment (NOT stored): name = `${mode} ${bayNumber}`;
  // icon = mode==="BM" ? 🏏 : 🏃‍♂️. Seeded by migrateSeedLanes (additive →
  // listLanes falls back to defaults when unseeded, so this is non-breaking).
  lanes: defineTable({
    laneId: v.string(), // STABLE: "bm1".."ru2"
    bayNumber: v.number(), // GLOBAL 1..5
    order: v.number(), // column order in the matrix
    segments: v.array(
      v.object({
        startHour: v.number(),
        endHour: v.number(),
        mode: v.string(), // "BM" | "RU"
        variants: v.array(v.string()), // BM → subset of ["standard","truman"]; RU → ["run-up"]
        // SPEC_LANE_SEGMENT_BOOKING_TIMES (2026-08) — additive.
        bookable: v.optional(v.boolean()),
        startCadenceMinutes: v.optional(v.number()),
        explicitStartHours: v.optional(v.array(v.number())),
      })
    ),
  }).index("by_laneId", ["laneId"]),

  // Per-date overrides — sparse, only for date ranges that differ from default.
  // segments replace the default day's segments for [startDate, endDate]. No
  // warningNote field — the warning is auto-derived (fixed wording) whenever a
  // resolved segment differs from the lane's default at that hour (§2.9).
  laneOverrides: defineTable({
    laneId: v.string(),
    startDate: v.string(), // "YYYY-MM-DD"
    endDate: v.string(), // inclusive; == startDate for a single day
    segments: v.array(
      v.object({
        startHour: v.number(),
        endHour: v.number(),
        mode: v.string(),
        variants: v.array(v.string()),
        // SPEC_LANE_SEGMENT_BOOKING_TIMES (2026-08) — additive.
        bookable: v.optional(v.boolean()),
        startCadenceMinutes: v.optional(v.number()),
        explicitStartHours: v.optional(v.array(v.number())),
      })
    ),
    createdBy: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("by_laneId", ["laneId"])
    .index("by_startDate", ["startDate"])
    // LEAK-6 (audit 2026-06): the public TV board collects this whole table every
    // poll. The daily retention cron range-deletes fully-past overrides (endDate <
    // today) via this index to keep it tiny. Additive.
    .index("by_endDate", ["endDate"]),

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
    // SPEC_MOBILE_BOOKING_UPDATES §6 — when reported from a specific booking on My
    // Bookings, the booking it relates to (for admin tracking). Additive/optional.
    bookingId: v.optional(v.string()),
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

  // Live admin feed of booking lifecycle events (created/modified/cancelled).
  // Append-only; read newest-first via by_at. Captures the modify before/after diff
  // that no other table records for the self-service path (2026-06 live feed).
  bookingEvents: defineTable({
    at: v.number(),
    type: v.string(), // 'created' | 'modified' | 'cancelled'
    bookingId: v.string(),
    customerName: v.string(),
    actorName: v.optional(v.string()),
    isCoachBooking: v.optional(v.boolean()),
    before: v.optional(
      v.object({
        date: v.string(),
        startHour: v.number(),
        duration: v.number(),
        lane: v.string(),
        variant: v.optional(v.string()),
      })
    ),
    after: v.optional(
      v.object({
        date: v.string(),
        startHour: v.number(),
        duration: v.number(),
        lane: v.string(),
        variant: v.optional(v.string()),
      })
    ),
  }).index("by_at", ["at"]),

  // Carpet-wear reset markers (2026-06): an admin records the date a lane's carpet
  // was replaced; cumulative lane-wear analytics counts booked hours only from the
  // latest reset forward. History retained (one row per reset).
  laneWearResets: defineTable({
    laneId: v.string(),
    resetDate: v.string(), // YYYY-MM-DD — wear accumulates from this date
    note: v.optional(v.string()),
    createdAt: v.string(),
    createdByEmail: v.optional(v.string()),
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

  // SPEC_STATEMENTS_EDITING (A/D): manual statement lines an admin adds to a
  // coach OR customer statement. delta is signed dollars: + = a charge/amount
  // owed on the statement, − = a credit/discount on the statement. A zero-delta
  // line is a pure note (D). Coach statements fold these into the running
  // balance; customer statements (transaction-history only) show them as
  // informational entries (no owed-balance concept — Inspector decision 2026-06-02).
  statementAdjustments: defineTable({
    subjectType: v.string(), // 'coach' | 'customer'
    subjectId: v.id("customers"), // the coach or customer the line belongs to
    delta: v.number(), // signed dollars (0 = note)
    label: v.string(), // shown in the ledger
    note: v.optional(v.string()),
    date: v.string(), // YYYY-MM-DD — drives ledger position
    createdBy: v.string(),
    createdAt: v.string(),
    updatedAt: v.optional(v.string()),
  }).index("by_subject", ["subjectType", "subjectId"]),

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
