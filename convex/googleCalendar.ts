"use node";

import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdminAction } from "./lib/adminGuard";
import { defaultLaneName, variantLabel } from "./lib/lanes";

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

async function getValidToken(ctx: any): Promise<{ accessToken: string; calendarId: string } | null> {
  const tokens = await ctx.runQuery(internal.googleCalendarMutations.getTokens, {});
  if (!tokens) return null;
  if (tokens.expiresAt < Date.now() + 5 * 60 * 1000) {
    if (!tokens.refreshToken) return null;
    try {
      const refreshed = await refreshAccessToken(tokens.refreshToken);
      await ctx.runMutation(internal.googleCalendarMutations.updateAccessToken, {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
      });
      return { accessToken: refreshed.accessToken, calendarId: tokens.calendarId };
    } catch (e) {
      console.error("Failed to refresh token:", e);
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

  let description = `${typeLabel}\n\n`;
  description += `📍 Lane: ${booking.laneName}${variantLabel}${additionalLabel}\n`;
  description += `👤 Customer: ${booking.customerName}\n`;
  description += `📧 Email: ${booking.customerEmail}\n`;
  if (booking.customerPhone) description += `📱 Phone: ${booking.customerPhone}\n`;
  description += `⏰ Time: ${startTime} - ${endTime}\n`;
  description += `⏱️ Duration: ${booking.duration >= 60 ? `${Math.floor(booking.duration / 60)}hr${booking.duration % 60 > 0 ? ` ${booking.duration % 60}min` : ""}` : `${booking.duration}min`}\n`;
  description += `📊 Status: ${booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}\n`;
  if (booking.accessCode) description += `\n🔑 DOOR CODE: ${booking.accessCode}\n`;
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
    status: "confirmed",
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

    const eventBody = buildEventBody({
      laneId: args.laneId, laneName, variantName, date: args.date,
      startHour: args.startHour, duration: args.duration,
      customerName: args.customerName, customerEmail: args.customerEmail,
      customerPhone: args.customerPhone, status: args.status,
      isCoachBooking: args.isCoachBooking, accessCode: args.accessCode,
      additionalLanes, athleteSlots: args.athleteSlots,
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

    const eventBody = buildEventBody({
      laneId: args.laneId, laneName, variantName, date: args.date,
      startHour: args.startHour, duration: args.duration,
      customerName: args.customerName, customerEmail: args.customerEmail,
      customerPhone: args.customerPhone, status: args.status,
      isCoachBooking: args.isCoachBooking, accessCode: args.accessCode,
      additionalLanes, athleteSlots: args.athleteSlots,
    });

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
            console.error(
              `Calendar update PUT failed (${res.status}) for event ${entry.eventId} in calendar ${entry.calendarId}:`,
              await res.text().catch(() => "")
            );
          }
        } catch (e) {
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
          console.error(
            `Calendar update PUT (fallback) failed (${res.status}) for event ${args.googleCalendarEventId}:`,
            await res.text().catch(() => "")
          );
        }
      } catch (e) {
        console.error(`Calendar update PUT (fallback) errored for event ${args.googleCalendarEventId}:`, e);
      }
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
  },
  handler: async (ctx, args) => {
    const tokenInfo = await getValidToken(ctx);
    if (!tokenInfo) return null;

    // INT-4 (audit 2026-06): treat 404/410 as success (event already gone); log
    // anything else instead of swallowing it (was an empty catch{}).
    const deleteOk = (status: number) => (status >= 200 && status < 300) || status === 404 || status === 410;

    // Delete per-lane events if available
    if (args.laneCalendarEventIds && args.laneCalendarEventIds.length > 0) {
      for (const entry of args.laneCalendarEventIds) {
        try {
          const res = await fetch(
            `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(entry.calendarId)}/events/${encodeURIComponent(entry.eventId)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${tokenInfo.accessToken}` } }
          );
          if (!deleteOk(res.status)) {
            console.error(
              `Calendar delete failed (${res.status}) for event ${entry.eventId} in calendar ${entry.calendarId}:`,
              await res.text().catch(() => "")
            );
          }
        } catch (e) {
          console.error(`Error deleting event ${entry.eventId} in calendar ${entry.calendarId}:`, e);
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
          console.error(
            `Calendar delete (fallback) failed (${res.status}) for event ${args.googleCalendarEventId}:`,
            await res.text().catch(() => "")
          );
        }
      } catch (e) {
        console.error(`Error deleting event ${args.googleCalendarEventId} (fallback):`, e);
      }
    }
    return true;
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

// GET a Google event and parse its "🔑 DOOR CODE: NNNN" out of the description.
async function fetchEventDoorCode(
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null; // can't read → treat as unknown, leave untouched
    const ev = await res.json();
    const m = DOOR_CODE_RE.exec(ev.description ?? "");
    return m ? m[1].replace(/\s+/g, "") : null;
  } catch {
    return null;
  }
}

interface ReconcileResult {
  scanned: number;
  inSync: number;
  missing: number;
  staleCode: number;
  repaired: number;
  capped: boolean;
  divergent: Array<{ bookingId: string; date: string; laneId: string; coach: string; storedCode: string; gcalCode: string | null; issue: "no-event" | "stale-code" }>;
}

// Shared core for the cron + any future admin tool. dryRun=true reports without
// touching Google. Bound by the by_date index window; capped to a safety limit so a
// runaway scan can't fire thousands of Google writes.
async function runCalendarReconcile(
  ctx: any,
  opts: { fromDate: string; toDate: string; dryRun: boolean; limit?: number }
): Promise<ReconcileResult> {
  const empty: ReconcileResult = { scanned: 0, inSync: 0, missing: 0, staleCode: 0, repaired: 0, capped: false, divergent: [] };
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
  const divergent: ReconcileResult["divergent"] = [];

  for (const b of work) {
    const hasEvent = !!b.googleCalendarEventId || (b.googleCalendarEventIds?.length ?? 0) > 0;

    if (!hasEvent) {
      missing++;
      divergent.push({ bookingId: b.bookingId, date: b.date, laneId: b.laneId, coach: b.customerName, storedCode: b.accessCode, gcalCode: null, issue: "no-event" });
      if (!opts.dryRun) {
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
        repaired++;
      }
      continue;
    }

    // Event exists — compare the door code on the PRIMARY lane event (the one HA
    // reads for this booking). A failed lane mapping falls back to the primary id.
    const entries = b.googleCalendarEventIds ?? [];
    const primary = entries.find((e: any) => e.laneId === b.laneId) ?? entries[0];
    let gcalCode: string | null = null;
    if (primary) {
      gcalCode = await fetchEventDoorCode(tokenInfo.accessToken, primary.calendarId, primary.eventId);
    } else if (b.googleCalendarEventId) {
      gcalCode = await fetchEventDoorCode(tokenInfo.accessToken, tokenInfo.calendarId, b.googleCalendarEventId);
    }

    if (gcalCode != null && gcalCode !== b.accessCode) {
      staleCode++;
      divergent.push({ bookingId: b.bookingId, date: b.date, laneId: b.laneId, coach: b.customerName, storedCode: b.accessCode, gcalCode, issue: "stale-code" });
      if (!opts.dryRun) {
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
        });
        repaired++;
      }
    } else {
      inSync++;
    }
  }

  if (capped) console.warn(`Calendar reconcile: capped at ${limit} of ${candidates.length} candidates`);
  return { scanned: work.length, inSync, missing, staleCode, repaired, capped, divergent };
}

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
    if (result.missing > 0 || result.staleCode > 0) {
      console.log(
        `Calendar reconcile: repaired ${result.repaired} (missing=${result.missing}, stale=${result.staleCode}) of ${result.scanned} scanned`
      );
    }
    return result;
  },
});
