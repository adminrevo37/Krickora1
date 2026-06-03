import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { getCallerContext } from "./lib/adminGuard";
import { enforceRateLimit } from "./lib/rateLimit";
import { defaultLaneName } from "./lib/lanes";

// ============================================================================
// SPEC_ADD_A_MATE — friends added to a customer booking for shared front-door
// access. A mate is an ACCOUNT (the Krickora login holder), not a child athlete.
// Customer bookings only; coach bookings use athleteSlots instead. Mates reuse
// the owner's single accessCode (one front door, no per-mate codes).
// ============================================================================

// SPEC_RECONFIGURABLE_LANES: mate emails read the booking's lane-name snapshot
// (date-resolved at booking time), falling back to the default name for legacy rows.
const laneNm = (b: { laneId: string; laneNameSnapshot?: string | null }) =>
  b.laneNameSnapshot || defaultLaneName(b.laneId);

const fmtTime = (h: number) => {
  const w = Math.floor(h);
  const m = Math.round((h - w) * 60);
  const p = w >= 12 ? "PM" : "AM";
  const dh = w > 12 ? w - 12 : w === 0 ? 12 : w;
  return `${dh}:${m.toString().padStart(2, "0")} ${p}`;
};

const fmtDur = (d: number) =>
  d === 60 ? "1 hour" : d === 90 ? "1.5 hours" : d === 30 ? "30 minutes" : `${d} min`;

// Privacy-preserving display name: "Ben Williams" -> "Ben W." (first name +
// last initial). Prevents identity harvesting in search results + mate lists.
export function shortName(fullName: string): string {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Someone";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

// Digits-only, last 9 (drops country code / leading-zero differences) so
// "04xx xxx xxx" and "+61 4xx xxx xxx" match the same stored number.
function normalizePhone(p?: string): string {
  const digits = (p || "").replace(/\D/g, "");
  return digits.length > 9 ? digits.slice(-9) : digits;
}

// Booking start as a Date (AWST wall-clock components → server Date for delta).
function bookingStartMs(date: string, startHour: number): number {
  const [y, mo, d] = date.split("-").map(Number);
  const whole = Math.floor(startHour);
  const mins = Math.round((startHour - whole) * 60);
  return new Date(y, mo - 1, d, whole, mins, 0).getTime();
}

function awstNowMs(): number {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Australia/Perth" })).getTime();
}

async function getCallerCustomer(ctx: any): Promise<any | null> {
  const caller = await getCallerContext(ctx);
  if (!caller.identity || !caller.email) return null;
  return await ctx.db
    .query("customers")
    .withIndex("by_email", (q: any) => q.eq("email", caller.email))
    .first();
}

// Does this booking belong to customer C? Bookings join to accounts by email
// (the reliable key — booking.userId is the auth subject, not customers._id).
function bookingOwnedBy(booking: any, customer: any): boolean {
  return (
    !!customer?.email &&
    booking.customerEmail?.toLowerCase() === customer.email.toLowerCase()
  );
}

function isMateOnBooking(booking: any, customerId: string): boolean {
  return (booking.mates ?? []).some((m: any) => m.customerId === customerId);
}

// ============================================================================
// QUERIES
// ============================================================================

// Search the customer directory by mobile number for the Add-a-Mate flow.
// Returns ONLY a minimal projection (id + short name) — never full PII — so the
// owner can confirm a match without harvesting identities. Auth required.
// A-1/S-1: this is a MUTATION (not a query) purely so it can rate-limit — the
// table limiter writes a counter. The add-a-mate UI calls it on demand (form
// submit), so a mutation is a drop-in. Without a throttle a logged-in user could
// script-probe arbitrary mobile numbers to learn which have accounts (the result
// leaks a short name + the customer _id usable as mateCustomerId).
export const searchCustomerByMobile = mutation({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerCustomer(ctx);
    if (!caller) return null;
    // 20 lookups per rolling minute per caller — ample for the real flow, but
    // stops scripted enumeration of the directory.
    await enforceRateLimit(
      ctx,
      { action: "mate-search", identifier: caller._id, max: 20, windowMs: 60_000 },
      "Too many searches — please wait a minute and try again."
    );
    const target = normalizePhone(args.phone);
    if (target.length < 8) return null; // too short to be a real mobile
    // Small directory at this facility — scan + match on normalised suffix.
    const all = await ctx.db.query("customers").collect();
    const match = all.find(
      (c: any) => c.phone && normalizePhone(c.phone) === target
    );
    if (!match) return null;
    if (match._id === caller._id) return { _id: match._id, displayName: shortName(match.name), isSelf: true };
    return { _id: match._id, displayName: shortName(match.name) };
  },
});

// The caller's saved-mates list, ordered by shared-session count (desc). Each
// entry: { customerId, displayName, sharedCount }. Used by the Add-a-Mate
// search ("Ben W. (x4)") and the profile "My Mates" section.
export const listSavedMates = query({
  args: {},
  handler: async (ctx) => {
    const caller = await getCallerCustomer(ctx);
    if (!caller) return [];
    const friendships = await ctx.db
      .query("friendships")
      .withIndex("by_owner", (q: any) => q.eq("ownerId", caller._id))
      .collect();
    if (friendships.length === 0) return [];

    // One booking scan; compute shared-session counts for all mates at once.
    const allBookings = await ctx.db
      .query("bookings")
      .filter((q: any) => q.neq(q.field("status"), "cancelled"))
      .collect();

    const mateCache = new Map<string, any>();
    const results: any[] = [];
    for (const f of friendships) {
      let mate = mateCache.get(f.mateId);
      if (mate === undefined) {
        mate = await ctx.db.get(f.mateId);
        mateCache.set(f.mateId, mate);
      }
      if (!mate) continue;
      const sharedCount = countSharedSessions(allBookings, caller, mate);
      results.push({
        customerId: mate._id,
        displayName: shortName(mate.name),
        sharedCount,
        savedAt: f.savedAt,
      });
    }
    results.sort((a, b) => b.sharedCount - a.sharedCount || (a.displayName < b.displayName ? -1 : 1));
    return results;
  },
});

// Count sessions where two accounts were at the facility together:
//   (a) one was owner, the other a mate on the same booking, OR
//   (b) they SEPARATELY booked overlapping times on the same date.
// Ignores who paid — pure "how often have you been there at the same time".
function countSharedSessions(bookings: any[], a: any, b: any): number {
  let count = 0;
  const aOwned: any[] = [];
  const bOwned: any[] = [];
  for (const bk of bookings) {
    const aOwns = bookingOwnedBy(bk, a);
    const bOwns = bookingOwnedBy(bk, b);
    const aMate = isMateOnBooking(bk, a._id);
    const bMate = isMateOnBooking(bk, b._id);
    // (a) same booking, both present (as owner or mate)
    if ((aOwns || aMate) && (bOwns || bMate)) {
      count++;
      continue;
    }
    if (aOwns) aOwned.push(bk);
    if (bOwns) bOwned.push(bk);
  }
  // (b) separate bookings, same date, overlapping window
  for (const ba of aOwned) {
    const aStart = ba.startHour;
    const aEnd = ba.startHour + ba.duration / 60;
    for (const bb of bOwned) {
      if (bb.date !== ba.date) continue;
      const bStart = bb.startHour;
      const bEnd = bb.startHour + bb.duration / 60;
      if (aStart < bEnd && bStart < aEnd) count++;
    }
  }
  return count;
}

// Mates on a booking, for the OWNER (or admin) — used by the Add-a-Mate page to
// show who's already added. Returns [] for anyone else.
export const listBookingMates = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const caller = await getCallerContext(ctx);
    if (!caller.identity) return [];
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return [];
    const callerCustomer = await getCallerCustomer(ctx);
    const isOwner = callerCustomer && bookingOwnedBy(booking, callerCustomer);
    if (!isOwner && !caller.isAdmin) return [];
    const out: any[] = [];
    for (const m of booking.mates ?? []) {
      const c = await ctx.db.get(m.customerId);
      if (c) out.push({ customerId: m.customerId, displayName: shortName(c.name), addedAt: m.addedAt });
    }
    return out;
  },
});

// Bookings the caller is a MATE on (not the owner) — the read-only "shared with
// you" list for My Bookings. Carries the door code + owner/other-mate display
// names; never pricing or other PII. Only upcoming (not cancelled).
export const listMateBookings = query({
  args: {},
  handler: async (ctx) => {
    const caller = await getCallerCustomer(ctx);
    if (!caller) return [];
    const bookings = await ctx.db
      .query("bookings")
      .filter((q: any) => q.neq(q.field("status"), "cancelled"))
      .collect();
    const mine = bookings.filter((b: any) => isMateOnBooking(b, caller._id));
    const out: any[] = [];
    for (const b of mine) {
      // Owner display name (from the account that owns the booking).
      const ownerCustomer = b.customerEmail
        ? await ctx.db
            .query("customers")
            .withIndex("by_email", (q: any) => q.eq("email", b.customerEmail.toLowerCase()))
            .first()
        : null;
      const otherMates: string[] = [];
      for (const m of b.mates ?? []) {
        if (m.customerId === caller._id) continue;
        const c = await ctx.db.get(m.customerId);
        if (c) otherMates.push(shortName(c.name));
      }
      out.push({
        id: b._id,
        laneId: b.laneId,
        variantId: b.variantId,
        date: b.date,
        startHour: b.startHour,
        duration: b.duration,
        status: b.status,
        accessCode: b.accessCode,
        ownerName: shortName(ownerCustomer?.name ?? b.customerName ?? "Someone"),
        otherMates,
      });
    }
    return out;
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

// Shared guard: load the booking + assert the caller may manage its mates
// (owner-by-email or admin), and that mates are valid for this booking.
async function authorizeMateManagement(ctx: any, bookingId: string) {
  const caller = await getCallerContext(ctx);
  if (!caller.identity) throw new ConvexError("Authentication required.");
  const booking = await ctx.db.get(bookingId);
  if (!booking) throw new ConvexError("Booking not found.");
  if (booking.isCoachBooking) {
    throw new ConvexError("Mates can't be added to coaching sessions.");
  }
  const callerCustomer = await getCallerCustomer(ctx);
  const isOwner = callerCustomer && bookingOwnedBy(booking, callerCustomer);
  if (!isOwner && !caller.isAdmin) {
    throw new ConvexError("You can only manage mates on your own bookings.");
  }
  return { booking, callerCustomer, isAdmin: caller.isAdmin };
}

// Add a mate (existing account) to a booking. Owner/admin only. Enforces the
// cap, blocks coach bookings, dedupes, and forbids adding before the session
// ends but not the owner themselves. Saves the friendship + sends M1.
export const addMateToBooking = mutation({
  args: {
    bookingId: v.id("bookings"),
    mateCustomerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    const { booking, callerCustomer } = await authorizeMateManagement(ctx, args.bookingId);
    if (booking.status === "cancelled") throw new ConvexError("This booking has been cancelled.");
    if (bookingStartMs(booking.date, booking.startHour) <= awstNowMs()) {
      throw new ConvexError("This session has already started — mates can't be added.");
    }

    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const maxMates = settings?.maxMatesPerBooking ?? 3;

    const mate = await ctx.db.get(args.mateCustomerId);
    if (!mate) throw new ConvexError("That account no longer exists.");

    // The owner (by email) can't add themselves as a mate.
    if (mate.email && booking.customerEmail?.toLowerCase() === mate.email.toLowerCase()) {
      throw new ConvexError("You're already on this booking.");
    }
    const current = booking.mates ?? [];
    if (current.some((m: any) => m.customerId === args.mateCustomerId)) {
      throw new ConvexError("That mate is already on this booking.");
    }
    if (current.length >= maxMates) {
      throw new ConvexError(`You can add at most ${maxMates} mate${maxMates !== 1 ? "s" : ""} to a booking.`);
    }

    await ctx.db.patch(args.bookingId, {
      mates: [...current, { customerId: args.mateCustomerId, addedAt: new Date().toISOString() }],
    });

    // Persist the friendship for future suggestions (owner is the booking
    // owner's account, which may differ from caller when an admin adds).
    const ownerCustomer = booking.customerEmail
      ? await ctx.db
          .query("customers")
          .withIndex("by_email", (q: any) => q.eq("email", booking.customerEmail.toLowerCase()))
          .first()
      : callerCustomer;
    if (ownerCustomer) await upsertFriendship(ctx, ownerCustomer._id, args.mateCustomerId);

    // M1 — tell the mate (with the door code + instructions).
    if (mate.email) {
      await ctx.scheduler.runAfter(0, internal.emails.sendMateAdded, {
        to: mate.email,
        ownerName: shortName(ownerCustomer?.name ?? booking.customerName ?? "A friend"),
        laneName: laneNm(booking),
        date: booking.date,
        timeSlot: fmtTime(booking.startHour),
        duration: fmtDur(booking.duration),
        accessCode: booking.accessCode ?? "",
      });
    }
    return { success: true };
  },
});

// Remove a mate from a booking. Owner/admin only. Sends M2 to the removed mate.
export const removeMateFromBooking = mutation({
  args: {
    bookingId: v.id("bookings"),
    mateCustomerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    const { booking } = await authorizeMateManagement(ctx, args.bookingId);
    // A-3: a cancelled booking already notified its mates (M4 on cancel); don't
    // re-remove / re-email here.
    if (booking.status === "cancelled") throw new ConvexError("This booking has been cancelled.");
    const current = booking.mates ?? [];
    if (!current.some((m: any) => m.customerId === args.mateCustomerId)) {
      throw new ConvexError("That mate isn't on this booking.");
    }
    await ctx.db.patch(args.bookingId, {
      mates: current.filter((m: any) => m.customerId !== args.mateCustomerId),
    });

    const mate = await ctx.db.get(args.mateCustomerId);
    const ownerCustomer = booking.customerEmail
      ? await ctx.db
          .query("customers")
          .withIndex("by_email", (q: any) => q.eq("email", booking.customerEmail.toLowerCase()))
          .first()
      : null;
    // A-3: only send the "you were removed" email for an upcoming session — a
    // finished/in-progress session has nothing to notify about.
    const notStarted = bookingStartMs(booking.date, booking.startHour) > awstNowMs();
    if (mate?.email && notStarted) {
      await ctx.scheduler.runAfter(0, internal.emails.sendMateRemoved, {
        to: mate.email,
        ownerName: shortName(ownerCustomer?.name ?? booking.customerName ?? "The booking owner"),
        laneName: laneNm(booking),
        date: booking.date,
        timeSlot: fmtTime(booking.startHour),
      });
    }
    return { success: true };
  },
});

// A mate removes THEMSELVES from a booking. Sends M3 to the owner.
export const leaveBooking = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const caller = await getCallerCustomer(ctx);
    if (!caller) throw new ConvexError("Authentication required.");
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new ConvexError("Booking not found.");
    // A-3: don't leave/notify on a cancelled booking (mates already notified on cancel).
    if (booking.status === "cancelled") throw new ConvexError("This booking has been cancelled.");
    const current = booking.mates ?? [];
    if (!current.some((m: any) => m.customerId === caller._id)) {
      throw new ConvexError("You're not on this booking.");
    }
    await ctx.db.patch(args.bookingId, {
      mates: current.filter((m: any) => m.customerId !== caller._id),
    });
    // A-3: only notify the owner for an upcoming session.
    const notStarted = bookingStartMs(booking.date, booking.startHour) > awstNowMs();
    if (booking.customerEmail && notStarted) {
      await ctx.scheduler.runAfter(0, internal.emails.sendMateLeft, {
        to: booking.customerEmail,
        mateName: shortName(caller.name ?? "A mate"),
        laneName: laneNm(booking),
        date: booking.date,
        timeSlot: fmtTime(booking.startHour),
      });
    }
    return { success: true };
  },
});

// Remove a saved mate from the caller's friendships list (does NOT touch any
// existing bookings). Used by swipe-to-delete in "My Mates".
export const removeSavedMate = mutation({
  args: { mateCustomerId: v.id("customers") },
  handler: async (ctx, args) => {
    const caller = await getCallerCustomer(ctx);
    if (!caller) throw new ConvexError("Authentication required.");
    const rows = await ctx.db
      .query("friendships")
      .withIndex("by_owner_mate", (q: any) =>
        q.eq("ownerId", caller._id).eq("mateId", args.mateCustomerId)
      )
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return { success: true };
  },
});

async function upsertFriendship(ctx: any, ownerId: string, mateId: string): Promise<void> {
  const existing = await ctx.db
    .query("friendships")
    .withIndex("by_owner_mate", (q: any) => q.eq("ownerId", ownerId).eq("mateId", mateId))
    .first();
  if (existing) return;
  await ctx.db.insert("friendships", {
    ownerId,
    mateId,
    savedAt: new Date().toISOString(),
  });
}

// ============================================================================
// SMS INVITE (mate has no Krickora account yet)
// ============================================================================

// Owner generates an invite token for an unregistered mate. Returns the token +
// a ready /join link. ZERO server SMS cost — the client opens the native
// Messages app via an sms: deep link. Expires at the booking start.
export const createBookingInvite = mutation({
  args: {
    bookingId: v.id("bookings"),
    invitedPhone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { callerCustomer, booking } = await authorizeMateManagement(ctx, args.bookingId);
    if (booking.status === "cancelled") throw new ConvexError("This booking has been cancelled.");
    // A-4: this token grants door-code access via /join, so it must be unguessable.
    // Use the Web Crypto CSPRNG (available in the Convex runtime) — 24 bytes = 192
    // bits of entropy — instead of the old Math.random()+Date.now() (low-entropy,
    // predictable).
    const tokenBytes = new Uint8Array(24);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await ctx.db.insert("bookingInvites", {
      token,
      bookingId: args.bookingId,
      invitedByCustomerId: callerCustomer._id,
      invitedPhone: args.invitedPhone?.trim() || undefined,
      status: "pending",
      expiresAt: bookingStartMs(booking.date, booking.startHour),
      createdAt: new Date().toISOString(),
    });
    return { token, link: `https://krickora.com/join?token=${token}` };
  },
});

// Inspect an invite token (used by /join before sign-in to show context, and to
// route dead tokens to plain sign-up). Public — returns only non-sensitive
// status + a teaser of the booking. Never leaks PII.
export const getBookingInvite = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("bookingInvites")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first();
    if (!invite) return { status: "invalid" };
    if (invite.status === "joined") return { status: "joined" };
    if (invite.status === "invalidated") return { status: "invalid" };
    if (invite.expiresAt <= awstNowMs()) return { status: "expired" };
    const booking = await ctx.db.get(invite.bookingId);
    if (!booking || booking.status === "cancelled") return { status: "invalid" };
    const owner = booking.customerEmail
      ? await ctx.db
          .query("customers")
          .withIndex("by_email", (q: any) => q.eq("email", booking.customerEmail.toLowerCase()))
          .first()
      : null;
    return {
      status: "pending",
      ownerName: shortName(owner?.name ?? booking.customerName ?? "A friend"),
      laneName: laneNm(booking),
      date: booking.date,
      timeSlot: fmtTime(booking.startHour),
      duration: fmtDur(booking.duration),
    };
  },
});

// Consume an invite token after the invitee has an account + is signed in.
// Validates status/expiry/cap and adds the caller as a mate (sends M1). Returns
// a status the /join page acts on. Dead tokens return a non-throwing status so
// the page can still convert the user to an account.
export const acceptBookingInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const caller = await getCallerCustomer(ctx);
    if (!caller) throw new ConvexError("Sign in to join this booking.");
    const invite = await ctx.db
      .query("bookingInvites")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first();
    if (!invite || invite.status === "invalidated") return { status: "invalid" };
    if (invite.status === "joined") return { status: "joined" };
    if (invite.expiresAt <= awstNowMs()) return { status: "expired" };

    const booking = await ctx.db.get(invite.bookingId);
    if (!booking || booking.status === "cancelled") return { status: "invalid" };
    if (bookingStartMs(booking.date, booking.startHour) <= awstNowMs()) return { status: "expired" };

    // Owner can't join their own booking as a mate.
    if (caller.email && booking.customerEmail?.toLowerCase() === caller.email.toLowerCase()) {
      await ctx.db.patch(invite._id, { status: "joined", joinedByCustomerId: caller._id, joinedAt: new Date().toISOString() });
      return { status: "own_booking" };
    }
    const current = booking.mates ?? [];
    if (current.some((m: any) => m.customerId === caller._id)) {
      await ctx.db.patch(invite._id, { status: "joined", joinedByCustomerId: caller._id, joinedAt: new Date().toISOString() });
      return { status: "already_mate" };
    }
    const settings = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q: any) => q.eq("key", "global"))
      .first();
    const maxMates = settings?.maxMatesPerBooking ?? 3;
    if (current.length >= maxMates) return { status: "full" };

    await ctx.db.patch(invite.bookingId, {
      mates: [...current, { customerId: caller._id, addedAt: new Date().toISOString() }],
    });
    await ctx.db.patch(invite._id, {
      status: "joined",
      joinedByCustomerId: caller._id,
      joinedAt: new Date().toISOString(),
    });

    const ownerCustomer = booking.customerEmail
      ? await ctx.db
          .query("customers")
          .withIndex("by_email", (q: any) => q.eq("email", booking.customerEmail.toLowerCase()))
          .first()
      : null;
    if (ownerCustomer) await upsertFriendship(ctx, ownerCustomer._id, caller._id);

    if (caller.email) {
      await ctx.scheduler.runAfter(0, internal.emails.sendMateAdded, {
        to: caller.email,
        ownerName: shortName(ownerCustomer?.name ?? booking.customerName ?? "A friend"),
        laneName: laneNm(booking),
        date: booking.date,
        timeSlot: fmtTime(booking.startHour),
        duration: fmtDur(booking.duration),
        accessCode: booking.accessCode ?? "",
      });
    }
    return { status: "joined", bookingId: invite.bookingId };
  },
});

// ============================================================================
// HELPERS CALLED FROM mutations.ts (cancelBooking / applyBookingChange)
// ============================================================================

// M4 — booking cancelled (by owner OR admin): tell every mate. Also invalidate
// any pending SMS invites for the booking.
export async function notifyMatesOnCancel(ctx: any, booking: any): Promise<void> {
  await invalidateInvitesForBooking(ctx, booking._id);
  const mates = booking.mates ?? [];
  if (mates.length === 0) return;
  const owner = booking.customerEmail
    ? await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", booking.customerEmail.toLowerCase()))
        .first()
    : null;
  const ownerName = shortName(owner?.name ?? booking.customerName ?? "The booking owner");
  for (const m of mates) {
    const c = await ctx.db.get(m.customerId);
    if (!c?.email) continue;
    await ctx.scheduler.runAfter(0, internal.emails.sendMateCancelled, {
      to: c.email,
      ownerName,
      laneName: laneNm(booking),
      date: booking.date,
      timeSlot: fmtTime(booking.startHour),
    });
  }
}

// M5 — booking modified: tell every mate the NEW details. Also re-anchor pending
// invite expiry to the new start. `change` mirrors applyBookingChange's arg.
export async function notifyMatesOnModify(
  ctx: any,
  booking: any,
  change: {
    newDate: string;
    newStartHour: number;
    newDuration: number;
    newLaneId: string;
    newAccessCode?: string;
  }
): Promise<void> {
  await reanchorInvitesForBooking(
    ctx,
    booking._id,
    bookingStartMs(change.newDate, change.newStartHour)
  );
  const mates = booking.mates ?? [];
  if (mates.length === 0) return;
  const owner = booking.customerEmail
    ? await ctx.db
        .query("customers")
        .withIndex("by_email", (q: any) => q.eq("email", booking.customerEmail.toLowerCase()))
        .first()
    : null;
  const ownerName = shortName(owner?.name ?? booking.customerName ?? "The booking owner");
  for (const m of mates) {
    const c = await ctx.db.get(m.customerId);
    if (!c?.email) continue;
    await ctx.scheduler.runAfter(0, internal.emails.sendMateModified, {
      to: c.email,
      ownerName,
      newLaneName: defaultLaneName(change.newLaneId),
      newDate: change.newDate,
      newTimeSlot: fmtTime(change.newStartHour),
      newDuration: fmtDur(change.newDuration),
      accessCode: change.newAccessCode ?? booking.accessCode ?? "",
    });
  }
}

export async function invalidateInvitesForBooking(ctx: any, bookingId: string): Promise<void> {
  const invites = await ctx.db
    .query("bookingInvites")
    .withIndex("by_bookingId", (q: any) => q.eq("bookingId", bookingId))
    .collect();
  for (const inv of invites) {
    if (inv.status === "pending") await ctx.db.patch(inv._id, { status: "invalidated" });
  }
}

export async function reanchorInvitesForBooking(ctx: any, bookingId: string, newExpiresAt: number): Promise<void> {
  const invites = await ctx.db
    .query("bookingInvites")
    .withIndex("by_bookingId", (q: any) => q.eq("bookingId", bookingId))
    .collect();
  for (const inv of invites) {
    if (inv.status === "pending") await ctx.db.patch(inv._id, { expiresAt: newExpiresAt });
  }
}
