"use node";

import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdminAction } from "./lib/adminGuard";
import { defaultLaneName, variantLabel } from "./lib/lanes";
import { fmtAwstDateLabel } from "./lib/dates";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

function getGoogleCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Convex environment variables.");
  }
  return { clientId, clientSecret };
}

// ============================================================================
// TOKEN MANAGEMENT
// ============================================================================

export const exchangeAuthCode = action({
  args: {
    code: v.string(),
    redirectUri: v.string(),
    calendarId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminAction(ctx); // H2: admin-only (was unauthenticated)
    const { clientId, clientSecret } = getGoogleCredentials();

    const body = new URLSearchParams({
      code: args.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: args.redirectUri,
      grant_type: "authorization_code",
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Token exchange failed:", response.status, errText);
      let detail = "Failed to exchange authorization code.";
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error === "redirect_uri_mismatch") {
          detail = "Redirect URI mismatch. Make sure the redirect URI in Google Cloud Console exactly matches: " + args.redirectUri;
        } else if (errJson.error === "invalid_grant") {
          detail = "Authorization code expired or already used. Please try connecting again.";
        } else {
          detail = errJson.error_description || errJson.error || detail;
        }
      } catch {}
      throw new Error(detail);
    }

    const data = await response.json();

    if (!data.access_token) {
      throw new Error("No access token received from Google. Please try again.");
    }

    // Get user info
    let email = "unknown";
    try {
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (userInfoRes.ok) {
        const userInfo = await userInfoRes.json();
        email = userInfo.email || "unknown";
      }
    } catch {}

    await ctx.runMutation(internal.googleCalendarMutations.saveTokens, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || "",
      expiresAt: Date.now() + ((data.expires_in || 3600) * 1000),
      calendarId: args.calendarId || "primary",
      connectedEmail: email,
    });

    return { success: true, email, calendarId: args.calendarId || "primary" };
  },
});

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
  const { clientId, clientSecret } = getGoogleCredentials();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!response.ok) {
    const err = await response.text();
    console.error("Token refresh failed:", err);
    throw new Error("Failed to refresh Google access token. Please reconnect Google Calendar.");
  }
  const data = await response.json();
  return { accessToken: data.access_token, expiresAt: Date.now() + ((data.expires_in || 3600) * 1000) };
}

/**
 * H2 (BACKEND review 2026-09-05) — a Google Calendar disconnection was SILENT and
 * SELF-CONCEALING: every write no-ops on a null token, and the daily reconcile that
 * exists to detect missing events is gated on the SAME token, so it returned an
 * all-zero "nothing wrong" result while nothing at all was syncing. Door codes reach
 * the keypad only via Calendar, so the first symptom would have been a full evening
 * of customers standing outside a locked, unstaffed building.
 *
 * Alerting from the one function every caller funnels through covers every path at
 * once. Deduped to one push per 6h, and deliberately never throws — a failure to
 * alert must not become a failure to sync.
 */
async function alertCalendarDisconnected(ctx: any, detail: string): Promise<void> {
  try {
    const claimed: boolean = await ctx.runMutation(
      internal.googleCalendarMutations.claimAdminAlert,
      { key: "gcal-disconnected", minIntervalMs: 6 * 60 * 60 * 1000 }
    );
    console.error(`[calendar] GOOGLE CALENDAR NOT CONNECTED — ${detail}`);
    if (!claimed) return;
    await ctx.scheduler.runAfter(0, internal.push.sendAdminPush, {
      title: "🔴 Google Calendar disconnected",
      body: `Door codes are NOT reaching the keypad (${detail}). Bookings are still being taken, but no calendar events are being written or removed — customers will arrive at a locked building. Reconnect Google Calendar.`,
      url: "/rev-ops-7k2p",
      tag: "gcal-disconnected",
    });
  } catch (e) {
    console.error("Failed to raise the calendar-disconnected alert:", e);
  }
}

async function getValidToken(ctx: any): Promise<{ accessToken: string; calendarId: string } | null> {
  const tokens = await ctx.runQuery(internal.googleCalendarMutations.getTokens, {});
  if (!tokens) {
    await alertCalendarDisconnected(ctx, "no Google account is connected");
    return null;
  }
  if (tokens.expiresAt < Date.now() + 5 * 60 * 1000) {
    if (!tokens.refreshToken) {
      await alertCalendarDisconnected(ctx, "the stored token has expired and there is no refresh token");
      return null;
    }
    try {
      const refreshed = await refreshAccessToken(tokens.refreshToken);
      await ctx.runMutation(internal.googleCalendarMutations.updateAccessToken, {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
      });
      return { accessToken: refreshed.accessToken, calendarId: tokens.calendarId };
    } catch (e) {
      console.error("Failed to refresh token:", e);
      await alertCalendarDisconnected(
        ctx,
        `the refresh token was rejected by Google${tokens.connectedEmail ? ` for ${tokens.connectedEmail}` : ""}`
      );
      return null;
    }
  }
  return { accessToken: tokens.accessToken, calendarId: tokens.calendarId };
}

// ============================================================================
// CALENDAR EVENT OPERATIONS
// ============================================================================

function formatTime(hour: number): string {
  const whole = Math.floor(hour);
  const mins = Math.round((hour - whole) * 60);
  const period = whole >= 12 ? "PM" : "AM";
  const display = whole > 12 ? whole - 12 : whole === 0 ? 12 : whole;
  return mins > 0 ? `${display}:${mins.toString().padStart(2, "0")} ${period}` : `${display}:00 ${period}`;
}

function buildEventBody(booking: {
  laneId: string;
  laneName: string;
  variantName?: string;
  date: string;
  startHour: number;
  duration: number;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  status: string;
  isCoachBooking?: boolean;
  accessCode?: string;
  additionalLanes?: string[];
  athleteSlots?: Array<{ athleteName: string; startHour: number; durationMinutes: number }>;
  // SPEC_TEAM_BOOKING_AUTODOOR_2026-07: when set, emit the `🚪 AUTO-DOOR` token line
  // HA matches to auto-open/hold/close the roller door for a team booking.
  autoDoor?: boolean;
}) {
  const endHour = booking.startHour + booking.duration / 60;
  const startTime = formatTime(booking.startHour);
  const endTime = formatTime(endHour);
  const startWhole = Math.floor(booking.startHour);
  const startMins = Math.round((booking.startHour - startWhole) * 60);
  const endWhole = Math.floor(endHour);
  const endMins = Math.round((endHour - endWhole) * 60);
  const startDateTime = `${booking.date}T${String(startWhole).padStart(2, "0")}:${String(startMins).padStart(2, "0")}:00`;
  const endDateTime = `${booking.date}T${String(endWhole).padStart(2, "0")}:${String(endMins).padStart(2, "0")}:00`;

  const variantLabel = booking.variantName ? ` (${booking.variantName})` : "";
  const additionalLabel = booking.additionalLanes && booking.additionalLanes.length > 0
    ? ` + ${booking.additionalLanes.join(", ")}` : "";
  const typeLabel = booking.isCoachBooking ? "🏏 Coach Session" : "🎯 Net Session";
  const statusEmoji = booking.status === "confirmed" ? "✅" : booking.status === "cancelled" ? "❌" : "📋";
  const summary = `${statusEmoji} ${booking.customerName} - ${booking.laneName}${variantLabel}${additionalLabel}`;

  let description = `${typeLabel}\n`;
  // SPEC_TEAM_BOOKING_AUTODOOR_2026-07: HA matches the exact case-sensitive substring
  // `AUTO-DOOR` anywhere in the description. Keep the token verbatim.
  if (booking.autoDoor) description += `🚪 AUTO-DOOR\n`;
  description += `\n`;
  description += `📍 Lane: ${booking.laneName}${variantLabel}${additionalLabel}\n`;
  description += `👤 Customer: ${booking.customerName}\n`;
  description += `📧 Email: ${booking.customerEmail}\n`;
  if (booking.customerPhone) description += `📱 Phone: ${booking.customerPhone}\n`;
  description += `⏰ Time: ${startTime} - ${endTime}\n`;
  description += `⏱️ Duration: ${booking.duration >= 60 ? `${Math.floor(booking.duration / 60)}hr${booking.duration % 60 > 0 ? ` ${booking.duration % 60}min` : ""}` : `${booking.duration}min`}\n`;
  description += `📊 Status: ${booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}\n`;
  // A1 (SECURITY 2026-08): never write the door code onto a cancelled/no_show
  // event (defence-in-depth — the cancel path deletes the event, but any other
  // caller that builds a body for a non-confirmed booking must not leak the PIN).
  if (booking.accessCode && booking.status !== "cancelled" && booking.status !== "no_show")
    description += `\n🔑 DOOR CODE: ${booking.accessCode}\n`;
  if (booking.athleteSlots && booking.athleteSlots.length > 0) {
    description += `\n👥 Athletes:\n`;
    for (const slot of booking.athleteSlots) {
      description += `  • ${slot.athleteName}: ${formatTime(slot.startHour)} - ${formatTime(slot.startHour + slot.durationMinutes / 60)} (${slot.durationMinutes}min)\n`;
    }
  }

  let colorId: string;
  switch (booking.status) {
    case "confirmed": colorId = "10"; break;
    case "cancelled": colorId = "11"; break;
    default: colorId = "7"; break;
  }

  return {
    summary, description,
    start: { dateTime: startDateTime, timeZone: "Australia/Perth" },
    end: { dateTime: endDateTime, timeZone: "Australia/Perth" },
    colorId,
    status: (booking.status === "cancelled" || booking.status === "no_show") ? "cancelled" : "confirmed",
  };
}

/**
 * Create Google Calendar events for a booking — one per lane with per-lane calendar mapping
 */
export const createCalendarEvent = internalAction({
  args: {
    bookingId: v.string(),
    laneId: v.string(),
    variantId: v.optional(v.string()),
    date: v.string(),
    startHour: v.number(),
    duration: v.number(),
    customerName: v.string(),
    customerEmail: v.string(),
    customerPhone: v.optional(v.string()),
    status: v.string(),
    isCoachBooking: v.optional(v.boolean()),
    accessCode: v.optional(v.string()),
    additionalLaneIds: v.optional(v.array(v.string())),
    // SPEC_RECONFIGURABLE_LANES: date-resolved snapshot from the booking — used
    // for the event title; routing stays keyed on the stable laneId (§7a).
    laneNameSnapshot: v.optional(v.string()),
    variantLabelSnapshot: v.optional(v.string()),
    athleteSlots: v.optional(
      v.array(v.object({ athleteName: v.string(), startHour: v.number(), durationMinutes: v.number() }))
    ),
  },
  handler: async (ctx, args) => {
    const tokenInfo = await getValidToken(ctx);
    if (!tokenInfo) {
      console.warn("Google Calendar not connected — skipping event creation");
      return null;
    }

    // Get per-lane calendar mappings
    const laneMappings = await ctx.runQuery(internal.googleCalendarMutations.getLaneCalendarMappingsInternal, {});
    const mappingByLane: Record<string, string> = {};
    for (const m of laneMappings) {
      mappingByLane[m.laneId] = m.calendarId;
    }

    const allLaneIds = [args.laneId, ...(args.additionalLaneIds ?? [])];
    const laneName = args.laneNameSnapshot || defaultLaneName(args.laneId);
    const variantName = args.variantLabelSnapshot || (args.variantId ? variantLabel(args.variantId) : undefined);
    const additionalLanes = args.additionalLaneIds?.map(id => defaultLaneName(id));

    // SPEC_TEAM_BOOKING_AUTODOOR_2026-07: resolve the effective flag from the booking
    // row (+ its customer's default) so EVERY create path stamps the token without
    // each caller threading it. Single-row multi-lane → all lane events share this.
    const autoDoor: boolean = await ctx.runQuery(
      internal.googleCalendarMutations.getBookingAutoDoor,
      { bookingId: args.bookingId }
    );

    const eventBody = buildEventBody({
      laneId: args.laneId, laneName, variantName, date: args.date,
      startHour: args.startHour, duration: args.duration,
      customerName: args.customerName, customerEmail: args.customerEmail,
      customerPhone: args.customerPhone, status: args.status,
      isCoachBooking: args.isCoachBooking, accessCode: args.accessCode,
      additionalLanes, athleteSlots: args.athleteSlots, autoDoor,
    });

    const eventEntries: Array<{ laneId: string; calendarId: string; eventId: string }> = [];
    let primaryEventId: string | null = null;

    // Create an event in each lane's calendar (or fallback to default)
    for (const lid of allLaneIds) {
      const calId = mappingByLane[lid] || tokenInfo.calendarId;
      const lName = lid === args.laneId ? laneName : defaultLaneName(lid);

      // Customize summary per lane
      const laneEventBody = {
        ...eventBody,
        summary: eventBody.summary.replace(laneName, lName),
      };
      // For the primary lane, keep original summary
      if (lid === args.laneId) {
        laneEventBody.summary = eventBody.summary;
      }

      try {
        const response = await fetch(
          `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tokenInfo.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(laneEventBody),
          }
        );

        if (response.ok) {
          const event = await response.json();
          eventEntries.push({ laneId: lid, calendarId: calId, eventId: event.id });
          if (lid === args.laneId) primaryEventId = event.id;
          console.log(`Created calendar event ${event.id} for lane ${lid} in calendar ${calId}`);
        } else {
          const err = await response.text();
          console.error(`Failed to create calendar event for lane ${lid}:`, err);
        }
      } catch (e) {
        console.error(`Error creating calendar event for lane ${lid}:`, e);
      }
    }

    // Save event IDs to booking
    if (primaryEventId) {
      await ctx.runMutation(internal.googleCalendarMutations.setBookingCalendarEventId, {
        bookingId: args.bookingId,
        googleCalendarEventId: primaryEventId,
      });
    }
    if (eventEntries.length > 0) {
      await ctx.runMutation(internal.googleCalendarMutations.setBookingLaneCalendarEventIds, {
        bookingId: args.bookingId,
        eventEntries,
      });
    }

    // SPEC_CALENDAR_SYNC_RELIABILITY_2026-06 (fix #3) — flag the outcome so a
    // silently-failed Google write becomes VISIBLE instead of leaving the booking
    // with a stored door code but no event (the 2026-06-23 lockout class). 'synced'
    // only when the PRIMARY lane event landed (that's the door-code lane HA reads);
    // 'failed' otherwise → the daily reconcile cron re-creates it next run.
    await ctx.runMutation(internal.googleCalendarMutations.setBookingCalendarSyncStatus, {
      bookingId: args.bookingId,
      status: primaryEventId ? "synced" : "failed",
    });

    return primaryEventId;
  },
});

/**
 * Update Google Calendar events when booking changes — updates all per-lane events
 */
export const updateCalendarEvent = internalAction({
  args: {
    googleCalendarEventId: v.string(),
    laneId: v.string(),
    variantId: v.optional(v.string()),
    date: v.string(),
    startHour: v.number(),
    duration: v.number(),
    customerName: v.string(),
    customerEmail: v.string(),
    customerPhone: v.optional(v.string()),
    status: v.string(),
    isCoachBooking: v.optional(v.boolean()),
    accessCode: v.optional(v.string()),
    additionalLaneIds: v.optional(v.array(v.string())),
    athleteSlots: v.optional(
      v.array(v.object({ athleteName: v.string(), startHour: v.number(), durationMinutes: v.number() }))
    ),
    // Per-lane event IDs for updating all calendars
    laneCalendarEventIds: v.optional(
      v.array(v.object({ laneId: v.string(), calendarId: v.string(), eventId: v.string() }))
    ),
    laneNameSnapshot: v.optional(v.string()),
    variantLabelSnapshot: v.optional(v.string()),
    // SPEC_TEAM_BOOKING_AUTODOOR_2026-07: pass the booking id so a re-sync (modify /
    // door-code edit / lane-set-unchanged update / reconcile stale-code) re-resolves
    // + PRESERVES the `🚪 AUTO-DOOR` token instead of silently dropping it.
    bookingId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tokenInfo = await getValidToken(ctx);
    if (!tokenInfo) {
      console.warn("Google Calendar not connected — skipping event update");
      return null;
    }

    const laneName = args.laneNameSnapshot || defaultLaneName(args.laneId);
    const variantName = args.variantLabelSnapshot || (args.variantId ? variantLabel(args.variantId) : undefined);
    const additionalLanes = args.additionalLaneIds?.map(id => defaultLaneName(id));

    // SPEC_TEAM_BOOKING_AUTODOOR_2026-07: preserve the token across re-syncs.
    const autoDoor: boolean = args.bookingId
      ? await ctx.runQuery(internal.googleCalendarMutations.getBookingAutoDoor, { bookingId: args.bookingId })
      : false;

    const eventBody = buildEventBody({
      laneId: args.laneId, laneName, variantName, date: args.date,
      startHour: args.startHour, duration: args.duration,
      customerName: args.customerName, customerEmail: args.customerEmail,
      customerPhone: args.customerPhone, status: args.status,
      isCoachBooking: args.isCoachBooking, accessCode: args.accessCode,
      additionalLanes, athleteSlots: args.athleteSlots, autoDoor,
    });

    // D1 (SPEC_CODE_REVIEW_IMPROVEMENTS_2026-08): a failed PUT must become
    // VISIBLE — set calendarSyncStatus="failed" so the daily reconcile re-pushes
    // this booking even when the door code still matches (e.g. a duration-only
    // extend whose PUT failed → HA would otherwise keep the old window forever).
    let anyFailed = false;

    // Update per-lane events if available — customise the summary per lane so a
    // secondary lane's event shows ITS lane name (mirrors createCalendarEvent).
    if (args.laneCalendarEventIds && args.laneCalendarEventIds.length > 0) {
      for (const entry of args.laneCalendarEventIds) {
        const lName = entry.laneId === args.laneId ? laneName : defaultLaneName(entry.laneId);
        const perLaneBody = entry.laneId === args.laneId
          ? eventBody
          : { ...eventBody, summary: eventBody.summary.replace(laneName, lName) };
        try {
          // INT-4 (audit 2026-06): check response.ok — a silently-failed PUT was
          // the same class of bug as the 2026-06-23 missing-event incident (HA
          // would keep loading stale lane/time/door-code data after a modify).
          const res = await fetch(
            `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(entry.calendarId)}/events/${encodeURIComponent(entry.eventId)}`,
            {
              method: "PUT",
              headers: { Authorization: `Bearer ${tokenInfo.accessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify(perLaneBody),
            }
          );
          if (!res.ok) {
            anyFailed = true;
            console.error(
              `Calendar update PUT failed (${res.status}) for event ${entry.eventId} in calendar ${entry.calendarId}:`,
              await res.text().catch(() => "")
            );
          }
        } catch (e) {
          anyFailed = true;
          console.error(`Failed to update event ${entry.eventId} in calendar ${entry.calendarId}:`, e);
        }
      }
    } else {
      // Fallback: update single event in default calendar
      try {
        const res = await fetch(
          `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(tokenInfo.calendarId)}/events/${encodeURIComponent(args.googleCalendarEventId)}`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${tokenInfo.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(eventBody),
          }
        );
        if (!res.ok) {
          anyFailed = true;
          console.error(
            `Calendar update PUT (fallback) failed (${res.status}) for event ${args.googleCalendarEventId}:`,
            await res.text().catch(() => "")
          );
        }
      } catch (e) {
        anyFailed = true;
        console.error(`Calendar update PUT (fallback) errored for event ${args.googleCalendarEventId}:`, e);
      }
    }

    // D1: record the outcome when we know the booking (6 update call sites +
    // the reconcile pass bookingId). 'synced' clears a previous failed flag.
    if (args.bookingId) {
      await ctx.runMutation(internal.googleCalendarMutations.setBookingCalendarSyncStatus, {
        bookingId: args.bookingId,
        status: anyFailed ? "failed" : "synced",
      });
    }

    return args.googleCalendarEventId;
  },
});

export const deleteCalendarEvent = internalAction({
  args: {
    googleCalendarEventId: v.string(),
    laneCalendarEventIds: v.optional(
      v.array(v.object({ laneId: v.string(), calendarId: v.string(), eventId: v.string() }))
    ),
    // D1: when supplied, a failed DELETE flags the booking calendarSyncStatus
    // "failed" (a live event left behind after a cancel is an access risk —
    // at minimum make it visible/auditable).
    bookingId: v.optional(v.string()),
    // C3 (BACKEND review 2026-09-05): session context captured AT SCHEDULE TIME.
    // Three call sites hard-delete the booking row in the same mutation, so by the
    // time this action runs there may be nothing left to read — without this an
    // alert could not name the lane, the time or the door code still live on the
    // keypad. Built by lib/calendarDelete.ts `calendarDeleteArgs()`.
    snapshot: v.optional(
      v.object({
        date: v.optional(v.string()),
        startHour: v.optional(v.number()),
        laneName: v.optional(v.string()),
        customerName: v.optional(v.string()),
        accessCode: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    // C3: record every event this action FAILED to remove — keyed on the event, in
    // its own table, so the record survives the booking being cancelled or
    // hard-deleted. `sweepCalendarOrphans` retries these and alerts the admins.
    const orphan = async (calendarId: string, eventId: string, reason: string, lastError?: string) => {
      if (!eventId) return;
      try {
        await ctx.runMutation(internal.googleCalendarMutations.recordCalendarOrphan, {
          calendarId,
          eventId,
          reason,
          ...(args.bookingId !== undefined ? { bookingId: args.bookingId } : {}),
          ...(args.snapshot?.date !== undefined ? { date: args.snapshot.date } : {}),
          ...(args.snapshot?.startHour !== undefined ? { startHour: args.snapshot.startHour } : {}),
          ...(args.snapshot?.laneName !== undefined ? { laneName: args.snapshot.laneName } : {}),
          ...(args.snapshot?.customerName !== undefined ? { customerName: args.snapshot.customerName } : {}),
          ...(args.snapshot?.accessCode !== undefined ? { accessCode: args.snapshot.accessCode } : {}),
          ...(lastError !== undefined ? { lastError: lastError.slice(0, 500) } : {}),
        });
      } catch (e) {
        // Never let bookkeeping break the teardown, but make it loud.
        console.error(`[calendar] FAILED TO RECORD ORPHAN EVENT ${eventId} in ${calendarId}:`, e);
      }
    };

    const tokenInfo = await getValidToken(ctx);
    if (!tokenInfo) {
      // C3: the calendar being disconnected does NOT mean there is nothing to
      // delete — it means the delete definitely did not happen and the event (with
      // its door code) is still live. Previously this returned silently.
      const tokens: any = await ctx.runQuery(internal.googleCalendarMutations.getTokens, {});
      const fallbackCalId = tokens?.calendarId ?? "primary";
      if (args.laneCalendarEventIds && args.laneCalendarEventIds.length > 0) {
        for (const entry of args.laneCalendarEventIds) {
          await orphan(entry.calendarId, entry.eventId, "not-connected");
        }
      } else {
        await orphan(fallbackCalId, args.googleCalendarEventId, "not-connected");
      }
      if (args.bookingId) {
        await ctx.runMutation(internal.googleCalendarMutations.setBookingCalendarSyncStatus, {
          bookingId: args.bookingId,
          status: "failed",
        });
      }
      await ctx.scheduler.runAfter(60_000, internal.googleCalendar.sweepCalendarOrphans, {});
      return null;
    }

    // INT-4 (audit 2026-06): treat 404/410 as success (event already gone); log
    // anything else instead of swallowing it (was an empty catch{}).
    const deleteOk = (status: number) => (status >= 200 && status < 300) || status === 404 || status === 410;
    let anyFailed = false;

    // Delete per-lane events if available
    if (args.laneCalendarEventIds && args.laneCalendarEventIds.length > 0) {
      for (const entry of args.laneCalendarEventIds) {
        try {
          const res = await fetch(
            `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(entry.calendarId)}/events/${encodeURIComponent(entry.eventId)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${tokenInfo.accessToken}` } }
          );
          if (!deleteOk(res.status)) {
            anyFailed = true;
            const body = await res.text().catch(() => "");
            console.error(
              `Calendar delete failed (${res.status}) for event ${entry.eventId} in calendar ${entry.calendarId}:`,
              body
            );
            await orphan(entry.calendarId, entry.eventId, "delete-failed", `HTTP ${res.status} ${body}`);
          }
        } catch (e) {
          anyFailed = true;
          console.error(`Error deleting event ${entry.eventId} in calendar ${entry.calendarId}:`, e);
          await orphan(entry.calendarId, entry.eventId, "delete-failed", String(e));
        }
      }
    } else {
      // Fallback: delete from default calendar
      try {
        const res = await fetch(
          `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(tokenInfo.calendarId)}/events/${encodeURIComponent(args.googleCalendarEventId)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${tokenInfo.accessToken}` } }
        );
        if (!deleteOk(res.status)) {
          anyFailed = true;
          const body = await res.text().catch(() => "");
          console.error(
            `Calendar delete (fallback) failed (${res.status}) for event ${args.googleCalendarEventId}:`,
            body
          );
          await orphan(tokenInfo.calendarId, args.googleCalendarEventId, "delete-failed", `HTTP ${res.status} ${body}`);
        }
      } catch (e) {
        anyFailed = true;
        console.error(`Error deleting event ${args.googleCalendarEventId} (fallback):`, e);
        await orphan(tokenInfo.calendarId, args.googleCalendarEventId, "delete-failed", String(e));
      }
    }
    if (anyFailed) {
      if (args.bookingId) {
        await ctx.runMutation(internal.googleCalendarMutations.setBookingCalendarSyncStatus, {
          bookingId: args.bookingId,
          status: "failed",
        });
      }
      // Retry shortly — a transient Google 5xx is the common case and usually
      // clears within seconds. The 15-min cron is the backstop, and the admin
      // alert comes from the sweep so a self-healing blip stays quiet.
      await ctx.scheduler.runAfter(60_000, internal.googleCalendar.sweepCalendarOrphans, {});
    }
    return true;
  },
});

/**
 * C3 — retry every calendar event we failed to delete, and alert the admins about
 * anything still standing. Runs 60s after any failed delete and every 15 min from
 * cron. Cheap when clean: one indexed read that is normally empty.
 *
 * An open row means a live Google Calendar event for a session that no longer
 * exists — HA will load its door code and power the lane. That is why this alerts
 * REPEATEDLY (every 6h per event) rather than once.
 */
export const sweepCalendarOrphans = internalAction({
  args: {},
  handler: async (ctx): Promise<{ open: number; resolved: number; stillOpen: number }> => {
    const rows: Array<{
      id: string; calendarId: string; eventId: string; bookingId: string | null;
      date: string | null; startHour: number | null; laneName: string | null;
      customerName: string | null; accessCode: string | null; reason: string;
      attempts: number; firstSeenAt: number; lastError: string | null;
    }> = await ctx.runQuery(internal.googleCalendarMutations.getOpenCalendarOrphansInternal, { limit: 100 });
    if (rows.length === 0) return { open: 0, resolved: 0, stillOpen: 0 };

    const tokenInfo = await getValidToken(ctx); // also raises the disconnected alert
    if (!tokenInfo) {
      console.error(
        `[calendar] ${rows.length} orphaned calendar event(s) cannot be removed — Google Calendar is disconnected`
      );
      return { open: rows.length, resolved: 0, stillOpen: rows.length };
    }

    const deleteOk = (s: number) => (s >= 200 && s < 300) || s === 404 || s === 410;
    let resolved = 0;
    const stillOpen: typeof rows = [];

    for (const row of rows) {
      let ok = false;
      let err: string | undefined;
      try {
        const res = await fetch(
          `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(row.calendarId)}/events/${encodeURIComponent(row.eventId)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${tokenInfo.accessToken}` } }
        );
        ok = deleteOk(res.status);
        if (!ok) err = `HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500);
      } catch (e) {
        err = String(e).slice(0, 500);
      }
      await ctx.runMutation(internal.googleCalendarMutations.finishCalendarOrphanAttempt, {
        id: row.id,
        resolved: ok,
        ...(err !== undefined ? { lastError: err } : {}),
      });
      if (ok) resolved++;
      else stillOpen.push(row);
    }

    for (const row of stillOpen) {
      const claimed: boolean = await ctx.runMutation(
        internal.googleCalendarMutations.claimAdminAlert,
        { key: `cal-orphan-${row.eventId}`, minIntervalMs: 6 * 60 * 60 * 1000 }
      );
      console.error(
        `[calendar] ORPHANED EVENT still live: ${row.eventId} in ${row.calendarId} (booking ${row.bookingId ?? "deleted"}, ${row.date ?? "?"} ${row.laneName ?? "?"}, ${row.attempts + 1} attempts): ${row.lastError ?? ""}`
      );
      if (!claimed) continue;
      const when = row.date
        ? `${fmtAwstDateLabel(row.date)}${row.startHour != null ? ` ${formatTime(row.startHour)}` : ""}`
        : "an unknown date";
      await ctx.scheduler.runAfter(0, internal.push.sendAdminPush, {
        title: "🚪 Door code may still be live",
        body: `A cancelled session's calendar event could not be removed: ${row.laneName ?? "lane ?"}, ${when}${row.customerName ? `, ${row.customerName}` : ""}${row.accessCode ? ` (code ${row.accessCode})` : ""}. HA will still open the door for it — delete the event in Google Calendar.`,
        url: "/rev-ops-7k2p",
        tag: `cal-orphan-${row.eventId}`,
      });
    }

    return { open: rows.length, resolved, stillOpen: stillOpen.length };
  },
});

export const disconnectCalendar = action({
  args: {},
  handler: async (ctx) => {
    await requireAdminAction(ctx); // H2: admin-only (was unauthenticated)
    await ctx.runMutation(internal.googleCalendarMutations.deleteTokens, {});
    return { success: true };
  },
});

export const getConnectionStatus = action({
  args: {},
  handler: async (ctx): Promise<{ connected: boolean; email?: string; calendarId?: string; connectedAt?: number }> => {
    await requireAdminAction(ctx); // H2: admin-only (was unauthenticated)
    const tokens: any = await ctx.runQuery(internal.googleCalendarMutations.getTokens, {});
    if (!tokens) return { connected: false };
    return {
      connected: true,
      email: tokens.connectedEmail,
      calendarId: tokens.calendarId,
      connectedAt: tokens.connectedAt,
    };
  },
});

export const updateCalendarId = action({
  args: { calendarId: v.string() },
  handler: async (ctx, args) => {
    await requireAdminAction(ctx); // H2: admin-only (was unauthenticated)
    await ctx.runMutation(internal.googleCalendarMutations.setCalendarId, { calendarId: args.calendarId });
    return { success: true };
  },
});

export const listCalendars = action({
  args: {},
  handler: async (ctx) => {
    await requireAdminAction(ctx); // H2: admin-only (was unauthenticated)
    const tokenInfo = await getValidToken(ctx);
    if (!tokenInfo) throw new Error("Google Calendar not connected");
    const response = await fetch(`${GOOGLE_CALENDAR_API}/users/me/calendarList`, {
      headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
    });
    if (!response.ok) throw new Error("Failed to list calendars");
    const data = await response.json();
    return (data.items || []).map((cal: any) => ({
      id: cal.id,
      summary: cal.summary,
      primary: cal.primary || false,
      backgroundColor: cal.backgroundColor,
    }));
  },
});

/**
 * Bulk sync all confirmed bookings to Google Calendar
 */
export const bulkSyncBookings = action({
  args: {},
  handler: async (ctx): Promise<{ synced: number; skipped: number; failed: number }> => {
    await requireAdminAction(ctx); // H2: admin-only (was unauthenticated)
    const tokenInfo = await getValidToken(ctx);
    if (!tokenInfo) throw new Error("Google Calendar not connected");

    const laneMappings = await ctx.runQuery(internal.googleCalendarMutations.getLaneCalendarMappingsInternal, {});
    const mappingByLane: Record<string, string> = {};
    for (const m of laneMappings) {
      mappingByLane[m.laneId] = m.calendarId;
    }

    // Get all active bookings
    const allBookings: any[] = await ctx.runQuery(internal.googleCalendarMutations.getAllActiveBookings, {});
    let synced = 0;
    let skipped = 0;
    let failed = 0;

    for (const booking of allBookings) {
      // Skip if already has calendar events
      if (booking.googleCalendarEventId || (booking.googleCalendarEventIds && booking.googleCalendarEventIds.length > 0)) {
        skipped++;
        continue;
      }

      const allLaneIds = [booking.laneId, ...(booking.additionalLaneIds ?? [])];
      const laneName = booking.laneNameSnapshot || defaultLaneName(booking.laneId);
      const variantName = booking.variantLabelSnapshot || (booking.variantId ? variantLabel(booking.variantId) : undefined);
      const additionalLanes = booking.additionalLaneIds?.map((id: string) => defaultLaneName(id));

      const eventBody = buildEventBody({
        laneId: booking.laneId, laneName, variantName, date: booking.date,
        startHour: booking.startHour, duration: booking.duration,
        customerName: booking.customerName, customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone, status: booking.status,
        isCoachBooking: booking.isCoachBooking, accessCode: booking.accessCode,
        additionalLanes, athleteSlots: booking.athleteSlots,
        // SPEC_TEAM_BOOKING_AUTODOOR_2026-07: this admin-only bulk path is dormant
        // ("never run" per the migration notes) — carry the per-booking flag; team
        // defaults resolve on the normal create/update paths.
        autoDoor: booking.autoDoor === true,
      });

      const eventEntries: Array<{ laneId: string; calendarId: string; eventId: string }> = [];
      let primaryEventId: string | null = null;

      for (const lid of allLaneIds) {
        const calId = mappingByLane[lid] || tokenInfo.calendarId;
        try {
          const response = await fetch(
            `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${tokenInfo.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(eventBody),
            }
          );
          if (response.ok) {
            const event = await response.json();
            eventEntries.push({ laneId: lid, calendarId: calId, eventId: event.id });
            if (lid === booking.laneId) primaryEventId = event.id;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }

      if (primaryEventId) {
        await ctx.runMutation(internal.googleCalendarMutations.setBookingCalendarEventId, {
          bookingId: booking._id.toString(),
          googleCalendarEventId: primaryEventId,
        });
      }
      if (eventEntries.length > 0) {
        await ctx.runMutation(internal.googleCalendarMutations.setBookingLaneCalendarEventIds, {
          bookingId: booking._id.toString(),
          eventEntries,
        });
        synced++;
      }
    }

    return { synced, skipped, failed };
  },
});

// ============================================================================
// CALENDAR SYNC RECONCILIATION (SPEC_CALENDAR_SYNC_RELIABILITY_2026-06 fix #2)
// ============================================================================
// The booking's stored accessCode is written transactionally (always lands), but
// the Google Calendar write is a fire-and-forget scheduled action whose failures
// were caught-and-logged — so a transient Google error left a booking with a door
// code but NO event (HA never loads the code → lockout), or a failed modify left a
// STALE code on the event. This daily reconcile is the structural self-heal:
//   • no event  → createCalendarEvent (re-create on the lane calendar);
//   • code drift → updateCalendarEvent (re-push the DB code, the source of truth).
// The DB accessCode is authoritative; GCal is reconciled to it.

const DOOR_CODE_RE = /DOOR CODE:\s*([0-9 ]+)/i;

// D1 (SPEC_CODE_REVIEW_IMPROVEMENTS_2026-08): GET a Google event's full sync
// state — door code AND start/end — distinguishing a MISSING event (404/410 or
// Google-side cancelled, previously mis-counted as in-sync) from an UNREADABLE
// one (transient error → leave untouched, as before).
type EventState =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "ok"; code: string | null; startMs: number | null; endMs: number | null };

async function fetchEventState(
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<EventState> {
  try {
    const res = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (res.status === 404 || res.status === 410) return { state: "missing" };
    if (!res.ok) return { state: "unreadable" }; // can't read → leave untouched
    const ev = await res.json();
    if (ev.status === "cancelled") return { state: "missing" };
    const m = DOOR_CODE_RE.exec(ev.description ?? "");
    return {
      state: "ok",
      code: m ? m[1].replace(/\s+/g, "") : null,
      startMs: ev.start?.dateTime ? Date.parse(ev.start.dateTime) : null,
      endMs: ev.end?.dateTime ? Date.parse(ev.end.dateTime) : null,
    };
  } catch {
    return { state: "unreadable" };
  }
}

interface ReconcileResult {
  scanned: number;
  inSync: number;
  missing: number;
  staleCode: number;
  // D1 additions — new divergence classes the reconcile now detects:
  drift: number; // event start/duration disagrees with the booking
  missingSecondary: number; // a secondary-lane event is gone / never created
  failedSync: number; // calendarSyncStatus==="failed" (a PUT failed) with no other symptom
  repaired: number;
  capped: boolean;
  adminCreatedScanned: number;
  adminModifiedScanned: number;
  divergent: Array<{ bookingId: string; date: string; startHour: number; laneId: string; coach: string; isCoachBooking: boolean; createdByAdmin: boolean; modifiedCount: number; storedCode: string; gcalCode: string | null; issue: "no-event" | "stale-code" | "drift" | "missing-secondary" | "failed-sync" }>;
}

// Shared core for the cron + any future admin tool. dryRun=true reports without
// touching Google. Bound by the by_date index window; capped to a safety limit so a
// runaway scan can't fire thousands of Google writes.
async function runCalendarReconcile(
  ctx: any,
  opts: { fromDate: string; toDate: string; dryRun: boolean; limit?: number }
): Promise<ReconcileResult> {
  const empty: ReconcileResult = { scanned: 0, inSync: 0, missing: 0, staleCode: 0, drift: 0, missingSecondary: 0, failedSync: 0, repaired: 0, capped: false, adminCreatedScanned: 0, adminModifiedScanned: 0, divergent: [] };
  const tokenInfo = await getValidToken(ctx);
  if (!tokenInfo) {
    console.warn("Calendar reconcile: Google not connected — skipping");
    return empty;
  }
  const candidates: any[] = await ctx.runQuery(
    internal.googleCalendarMutations.getReconcileCandidates,
    { fromDate: opts.fromDate, toDate: opts.toDate }
  );
  const limit = opts.limit ?? 250;
  const capped = candidates.length > limit;
  const work = capped ? candidates.slice(0, limit) : candidates;

  let inSync = 0, missing = 0, staleCode = 0, repaired = 0;
  let drift = 0, missingSecondary = 0, failedSync = 0;
  let adminCreatedScanned = 0, adminModifiedScanned = 0;
  const divergent: ReconcileResult["divergent"] = [];
  const meta = (b: any) => ({
    startHour: b.startHour, isCoachBooking: b.isCoachBooking,
    createdByAdmin: b.createdByAdmin === true, modifiedCount: b.modifiedCount ?? 0,
  });

  // Full re-create for a booking whose event set is wrong/gone: tear down any
  // SURVIVING events first so recreation can never leave orphan duplicates on a
  // lane calendar (the historical duplicate-event → wrong-door-code class),
  // then create the whole set fresh (also rewrites the stored ids + sync flag).
  const recreate = async (b: any, entries: any[]) => {
    if (entries.length > 0 || b.googleCalendarEventId) {
      // C3 (2026-09-05): pass the id + snapshot. If this teardown fails, the
      // create below still runs, so the stale event survives ALONGSIDE the new one
      // — two events, two door codes, on the same lane. That is now recorded as an
      // orphan and retried instead of being logged and forgotten.
      await ctx.runAction(internal.googleCalendar.deleteCalendarEvent, {
        googleCalendarEventId: b.googleCalendarEventId ?? entries[0]?.eventId ?? "",
        laneCalendarEventIds: entries,
        bookingId: b.bookingId,
        snapshot: {
          ...(b.date != null ? { date: b.date } : {}),
          ...(b.startHour != null ? { startHour: b.startHour } : {}),
          ...(b.laneNameSnapshot != null ? { laneName: b.laneNameSnapshot } : {}),
          ...(b.customerName != null ? { customerName: b.customerName } : {}),
          ...(b.accessCode != null ? { accessCode: b.accessCode } : {}),
        },
      });
    }
    await ctx.runAction(internal.googleCalendar.createCalendarEvent, {
      bookingId: b.bookingId,
      laneId: b.laneId,
      variantId: b.variantId,
      date: b.date,
      startHour: b.startHour,
      duration: b.duration,
      customerName: b.customerName,
      customerEmail: b.customerEmail,
      customerPhone: b.customerPhone,
      status: "confirmed",
      isCoachBooking: b.isCoachBooking,
      accessCode: b.accessCode,
      additionalLaneIds: b.additionalLaneIds,
      laneNameSnapshot: b.laneNameSnapshot,
      variantLabelSnapshot: b.variantLabelSnapshot,
      athleteSlots: b.athleteSlots,
    });
  };

  for (const b of work) {
    if (b.createdByAdmin === true) adminCreatedScanned++;
    if ((b.modifiedCount ?? 0) > 0) adminModifiedScanned++;
    const hasEvent = !!b.googleCalendarEventId || (b.googleCalendarEventIds?.length ?? 0) > 0;

    if (!hasEvent) {
      missing++;
      divergent.push({ bookingId: b.bookingId, date: b.date, laneId: b.laneId, coach: b.customerName, storedCode: b.accessCode, gcalCode: null, issue: "no-event", ...meta(b) });
      if (!opts.dryRun) {
        await recreate(b, []);
        repaired++;
      }
      continue;
    }

    // Event exists — read the PRIMARY lane event's full state (the event HA
    // reads for this booking). A failed lane mapping falls back to the primary id.
    const entries = b.googleCalendarEventIds ?? [];
    const primary = entries.find((e: any) => e.laneId === b.laneId) ?? entries[0];
    const primaryCalId = primary ? primary.calendarId : tokenInfo.calendarId;
    const primaryEventId = primary ? primary.eventId : b.googleCalendarEventId;
    const st = await fetchEventState(tokenInfo.accessToken, primaryCalId, primaryEventId);

    if (st.state === "missing") {
      // D1: a deleted/404 primary event used to be counted IN-SYNC forever.
      missing++;
      divergent.push({ bookingId: b.bookingId, date: b.date, laneId: b.laneId, coach: b.customerName, storedCode: b.accessCode, gcalCode: null, issue: "no-event", ...meta(b) });
      if (!opts.dryRun) {
        await recreate(b, entries);
        repaired++;
      }
      continue;
    }
    if (st.state === "unreadable") {
      // Transient read failure → leave untouched this run (same as before).
      inSync++;
      continue;
    }

    // D1: secondary-lane presence — a multi-lane booking whose secondary event
    // failed to create (fewer stored entries than lanes) or was later deleted.
    const expectedLaneCount = 1 + (b.additionalLaneIds?.length ?? 0);
    let secondaryGone = entries.length > 0 && entries.length < expectedLaneCount;
    if (!secondaryGone) {
      for (const entry of entries) {
        if (primary && entry.eventId === primary.eventId) continue;
        const s2 = await fetchEventState(tokenInfo.accessToken, entry.calendarId, entry.eventId);
        if (s2.state === "missing") { secondaryGone = true; break; }
      }
    }

    // D1: start/duration drift — e.g. an extend whose PUT failed with the door
    // code unchanged; HA would power the machine / hold the code for the wrong
    // window. 60s tolerance.
    const sh = Math.floor(b.startHour);
    const sm = Math.round((b.startHour - sh) * 60);
    const expectedStartMs = Date.parse(
      `${b.date}T${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}:00+08:00`
    );
    const expectedEndMs = expectedStartMs + b.duration * 60_000;
    const hasDrift =
      st.startMs != null && st.endMs != null &&
      (Math.abs(st.startMs - expectedStartMs) > 60_000 || Math.abs(st.endMs - expectedEndMs) > 60_000);

    const staleCodeNow = st.code != null && st.code !== b.accessCode;
    // D1: act on a recorded failed PUT even when everything readable matches
    // (the failure may concern fields we don't compare — names, athletes).
    const failedFlag = b.calendarSyncStatus === "failed";

    if (staleCodeNow || hasDrift || secondaryGone || failedFlag) {
      const issue = staleCodeNow ? "stale-code" : hasDrift ? "drift" : secondaryGone ? "missing-secondary" : "failed-sync";
      if (staleCodeNow) staleCode++;
      else if (hasDrift) drift++;
      else if (secondaryGone) missingSecondary++;
      else failedSync++;
      divergent.push({ bookingId: b.bookingId, date: b.date, laneId: b.laneId, coach: b.customerName, storedCode: b.accessCode, gcalCode: st.code, issue, ...meta(b) });
      if (!opts.dryRun) {
        if (secondaryGone) {
          // A PUT can't create the missing lane event — rebuild the whole set.
          await recreate(b, entries);
        } else {
          await ctx.runAction(internal.googleCalendar.updateCalendarEvent, {
            googleCalendarEventId: b.googleCalendarEventId ?? primary?.eventId ?? "",
            laneId: b.laneId,
            variantId: b.variantId,
            date: b.date,
            startHour: b.startHour,
            duration: b.duration,
            customerName: b.customerName,
            customerEmail: b.customerEmail,
            customerPhone: b.customerPhone,
            status: "confirmed",
            isCoachBooking: b.isCoachBooking,
            accessCode: b.accessCode,
            additionalLaneIds: b.additionalLaneIds,
            athleteSlots: b.athleteSlots,
            laneCalendarEventIds: entries,
            laneNameSnapshot: b.laneNameSnapshot,
            variantLabelSnapshot: b.variantLabelSnapshot,
            bookingId: b.bookingId, // preserve AUTO-DOOR token + records sync outcome
          });
        }
        repaired++;
      }
    } else {
      inSync++;
    }
  }

  if (capped) console.warn(`Calendar reconcile: capped at ${limit} of ${candidates.length} candidates`);
  return { scanned: work.length, inSync, missing, staleCode, drift, missingSecondary, failedSync, repaired, capped, adminCreatedScanned, adminModifiedScanned, divergent };
}

// SPEC_CALENDAR_SYNC_RELIABILITY_2026-06 (fix #4) — admin-gated READ-ONLY audit of
// booking → Google Calendar door-code correctness across a window. `requireAdminAction`
// works from the authenticated admin app (unlike a CLI deploy key, which has no user
// identity). dryRun defaults TRUE (report only); pass dryRun:false to also repair
// (re-create missing events + re-push stale codes). Answers "are all bookings — incl.
// admin-created / admin-modified ones — correctly synced to the calendar HA reads?".
export const auditCalendarDoorCodeDrift = action({
  args: { days: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ReconcileResult> => {
    await requireAdminAction(ctx);
    const awstDay = (off: number) =>
      new Date(Date.now() + 8 * 3600 * 1000 + off * 86400000).toISOString().slice(0, 10);
    const days = Math.max(1, Math.min(args.days ?? 60, 400));
    return await runCalendarReconcile(ctx, {
      fromDate: awstDay(-1),
      toDate: awstDay(days),
      dryRun: args.dryRun !== false, // default true (report only)
      limit: 1000,
    });
  },
});

/**
 * C3 (BACKEND review 2026-09-05) — THE OTHER HALF OF THE HOLE.
 *
 * `getReconcileCandidates` filters `status === "confirmed"`, and a cancelled
 * booking is by definition not confirmed — so a calendar event left behind by a
 * failed cancel-delete was never looked at again by anything. From now on the
 * orphan table catches those, but that only covers deletes attempted AFTER this
 * ships; anything already stranded on a lane calendar is invisible to it.
 *
 * This pass closes both: it reads bookings in the window that are cancelled /
 * no-show but still carry stored event ids, and asks GOOGLE whether the event is
 * still there. Existence is the test, not the stored ids — several cancel paths
 * legitimately leave the ids behind after a successful delete, so the ids alone
 * prove nothing either way. Anything genuinely still live is deleted (and, if that
 * delete fails, recorded as an orphan + alerted by the sweep).
 *
 * Hard-deleted bookings leave no row at all and are therefore NOT visible here —
 * only the orphan table can cover those, which is exactly why it exists.
 */
export const reconcileCancelledCalendarEvents = internalAction({
  args: { fromDate: v.optional(v.string()), toDate: v.optional(v.string()) },
  handler: async (
    ctx,
    args
  ): Promise<{ scanned: number; liveEvents: number; cleared: number; failed: number }> => {
    const awstDay = (off: number) =>
      new Date(Date.now() + 8 * 3600 * 1000 + off * 86400000).toISOString().slice(0, 10);
    const fromDate = args.fromDate ?? awstDay(-1);
    const toDate = args.toDate ?? awstDay(14);

    const tokenInfo = await getValidToken(ctx);
    if (!tokenInfo) return { scanned: 0, liveEvents: 0, cleared: 0, failed: 0 };

    const all: any[] = await ctx.runQuery(
      internal.googleCalendarMutations.getCancelledBookingsWithCalendarEvents,
      { fromDate, toDate }
    );
    // Safety cap: this pass makes 1-3 Google GETs per booking. The first run after
    // deploy has the largest backlog (every cancelled booking that kept its ids);
    // it clears the ids as it goes, so later runs shrink to almost nothing.
    const LIMIT = 200;
    const rows = all.slice(0, LIMIT);
    if (all.length > LIMIT) {
      console.warn(`Calendar cancelled-pass: capped at ${LIMIT} of ${all.length} candidates`);
    }

    let liveEvents = 0, cleared = 0, failed = 0;

    for (const b of rows) {
      const entries: Array<{ laneId: string; calendarId: string; eventId: string }> =
        (b.googleCalendarEventIds?.length ?? 0) > 0
          ? b.googleCalendarEventIds
          : b.googleCalendarEventId
            ? [{ laneId: b.laneId ?? "", calendarId: tokenInfo.calendarId, eventId: b.googleCalendarEventId }]
            : [];
      if (entries.length === 0) continue;

      let anyLive = false;
      let anyUnreadable = false;
      for (const e of entries) {
        const st = await fetchEventState(tokenInfo.accessToken, e.calendarId, e.eventId);
        if (st.state === "ok") anyLive = true;
        else if (st.state === "unreadable") anyUnreadable = true;
      }

      if (anyLive) {
        liveEvents++;
        console.error(
          `[calendar] LIVE EVENT FOR A CANCELLED BOOKING ${b.bookingId} (${b.date} ${b.laneName}) — deleting; the door code was still reachable`
        );
        // Reuse the normal delete path so a failure lands in the orphan table.
        await ctx.runAction(internal.googleCalendar.deleteCalendarEvent, {
          googleCalendarEventId: b.googleCalendarEventId ?? entries[0].eventId,
          laneCalendarEventIds: entries,
          bookingId: b.bookingId,
          snapshot: {
            ...(b.date != null ? { date: b.date } : {}),
            ...(b.startHour != null ? { startHour: b.startHour } : {}),
            ...(b.laneName != null ? { laneName: b.laneName } : {}),
            ...(b.customerName != null ? { customerName: b.customerName } : {}),
            ...(b.accessCode != null ? { accessCode: b.accessCode } : {}),
          },
        });
        // Verify rather than assume — the delete is the thing that has been failing.
        let allGone = true;
        for (const e of entries) {
          const st = await fetchEventState(tokenInfo.accessToken, e.calendarId, e.eventId);
          if (st.state !== "missing") allGone = false;
        }
        if (allGone) {
          await ctx.runMutation(internal.googleCalendarMutations.clearBookingCalendarEventIds, {
            bookingId: b.bookingId,
          });
          cleared++;
        } else {
          failed++; // orphan row recorded above; sweepCalendarOrphans retries + alerts
        }
      } else if (!anyUnreadable) {
        // Every event is confirmed gone — drop the stale ids so this booking stops
        // being re-checked against Google every night.
        await ctx.runMutation(internal.googleCalendarMutations.clearBookingCalendarEventIds, {
          bookingId: b.bookingId,
        });
        cleared++;
      }
    }

    if (liveEvents > 0) {
      const claimed: boolean = await ctx.runMutation(
        internal.googleCalendarMutations.claimAdminAlert,
        { key: "cal-live-after-cancel", minIntervalMs: 12 * 60 * 60 * 1000 }
      );
      if (claimed) {
        await ctx.scheduler.runAfter(0, internal.push.sendAdminPush, {
          title: "🚪 Cancelled sessions still had calendar events",
          body: `${liveEvents} cancelled booking${liveEvents === 1 ? "" : "s"} still had a live Google Calendar event — their door codes were reachable. ${failed === 0 ? "All removed." : `${failed} could NOT be removed — check Google Calendar.`}`,
          url: "/rev-ops-7k2p",
          tag: "cal-live-after-cancel",
        });
      }
    }

    return { scanned: rows.length, liveEvents, cleared, failed };
  },
});

// Daily reconcile cron target. Forward window: yesterday .. +14 days (AWST). A
// silent sync failure only locks someone out near the session (door code activates
// ~45 min before), so the near-term window is where repair matters; the small -1d
// pad catches a booking created late the night before. Far-future anomalies (e.g.
// the 29 Aug Paolo wrong-calendar event) are out of window and handled manually.
export const reconcileCalendarInternal = internalAction({
  args: {},
  handler: async (ctx): Promise<ReconcileResult> => {
    const awstDay = (off: number) =>
      new Date(Date.now() + 8 * 3600 * 1000 + off * 86400000).toISOString().slice(0, 10);
    const result = await runCalendarReconcile(ctx, {
      fromDate: awstDay(-1),
      toDate: awstDay(14),
      dryRun: false,
    });
    if (result.repaired > 0 || result.divergent.length > 0) {
      console.log(
        `Calendar reconcile: repaired ${result.repaired} (missing=${result.missing}, stale=${result.staleCode}, drift=${result.drift}, missingSecondary=${result.missingSecondary}, failedSync=${result.failedSync}) of ${result.scanned} scanned`
      );
    }

    // C3: the pass above only sees CONFIRMED bookings. These two cover the other
    // direction — events that should be GONE and are not. Both are best-effort;
    // neither may abort the confirmed-booking reconcile above.
    try {
      const cancelledPass = await ctx.runAction(
        internal.googleCalendar.reconcileCancelledCalendarEvents,
        {}
      );
      if (cancelledPass.liveEvents > 0 || cancelledPass.failed > 0) {
        console.log(
          `Calendar reconcile (cancelled): scanned ${cancelledPass.scanned}, live-after-cancel ${cancelledPass.liveEvents}, cleared ${cancelledPass.cleared}, failed ${cancelledPass.failed}`
        );
      }
    } catch (e) {
      console.error("Calendar reconcile (cancelled) failed:", e);
    }
    try {
      await ctx.runAction(internal.googleCalendar.sweepCalendarOrphans, {});
    } catch (e) {
      console.error("Calendar orphan sweep failed:", e);
    }

    return result;
  },
});
