"use node";

import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const SEAM_API_BASE = "https://connect.getseam.com";

function getSeamApiKey(): string {
  const key = process.env.SEAM_API_KEY;
  if (!key) {
    throw new Error("SEAM_API_KEY not configured. Set it in Convex environment variables.");
  }
  return key;
}

async function seamFetch(path: string, options: RequestInit = {}): Promise<any> {
  const apiKey = getSeamApiKey();
  const response = await fetch(`${SEAM_API_BASE}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Seam API error (${path}):`, response.status, errText);
    let detail = `Seam API error: ${response.status}`;
    try {
      const errJson = JSON.parse(errText);
      detail = errJson.error?.message || errJson.message || detail;
    } catch {}
    throw new Error(detail);
  }

  return response.json();
}

// ============================================================================
// DEVICE MANAGEMENT
// ============================================================================

/**
 * List all connected lock devices from Seam
 */
export const listDevices = action({
  args: {},
  handler: async () => {
    const data = await seamFetch("/devices/list", {
      method: "POST",
      body: JSON.stringify({
        device_types: [
          "schlage_lock",
          "yale_lock",
          "august_lock",
          "kwikset_lock",
          "smartthings_lock",
          "ttlock_lock",
          "igloo_lock",
          "nuki_lock",
        ],
      }),
    });

    return (data.devices || []).map((device: any) => ({
      id: device.device_id,
      name: device.properties?.name || device.display_name || "Unknown Lock",
      brand: device.device_type?.split("_")[0] || "unknown",
      model: device.properties?.model?.display_name || "",
      online: device.properties?.online ?? false,
      batteryLevel: device.properties?.battery_level,
      locked: device.properties?.locked,
      supportsAccessCodes: device.capabilities_supported?.includes("access_code") ?? true,
    }));
  },
});

/**
 * Get a single device's status
 */
export const getDeviceStatus = action({
  args: { deviceId: v.string() },
  handler: async (_ctx, args) => {
    const data = await seamFetch("/devices/get", {
      method: "POST",
      body: JSON.stringify({ device_id: args.deviceId }),
    });

    const device = data.device;
    return {
      id: device.device_id,
      name: device.properties?.name || device.display_name || "Unknown Lock",
      brand: device.device_type?.split("_")[0] || "unknown",
      online: device.properties?.online ?? false,
      batteryLevel: device.properties?.battery_level,
      locked: device.properties?.locked,
      lastSeen: device.properties?.last_seen,
    };
  },
});

// ============================================================================
// ACCESS CODE MANAGEMENT
// ============================================================================

/**
 * Push an access code to a physical lock device via Seam.
 * Creates a time-bound access code that activates before the booking and expires after.
 */
export const pushAccessCode = internalAction({
  args: {
    bookingId: v.string(),
    accessCode: v.string(),
    deviceIds: v.array(v.string()),
    startsAt: v.string(),
    endsAt: v.string(),
    customerName: v.string(),
    customerEmail: v.string(),
    laneId: v.string(),
  },
  handler: async (ctx, args) => {
    const seamCodeIds: string[] = [];
    const errors: string[] = [];

    for (const deviceId of args.deviceIds) {
      try {
        const data = await seamFetch("/access_codes/create", {
          method: "POST",
          body: JSON.stringify({
            device_id: deviceId,
            name: `Krickora: ${args.customerName} - ${args.laneId.toUpperCase()} (${args.startsAt.split("T")[0]})`,
            code: args.accessCode,
            starts_at: args.startsAt,
            ends_at: args.endsAt,
            type: "time_bound",
          }),
        });

        if (data.access_code?.access_code_id) {
          seamCodeIds.push(data.access_code.access_code_id);
          console.log(`Access code pushed to device ${deviceId}: ${data.access_code.access_code_id}`);
        }
      } catch (e: any) {
        console.error(`Failed to push code to device ${deviceId}:`, e.message);
        errors.push(`${deviceId}: ${e.message}`);
      }
    }

    const status = seamCodeIds.length === 0
      ? "failed"
      : errors.length > 0
        ? "partial"
        : "active";

    // Save lock code record
    await ctx.runMutation(internal.lockMutations.createLockCode, {
      bookingId: args.bookingId,
      accessCode: args.accessCode,
      deviceIds: args.deviceIds,
      seamAccessCodeIds: seamCodeIds,
      status,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      laneId: args.laneId,
      errorMessage: errors.length > 0 ? errors.join("; ") : undefined,
    });

    // Update booking sync status
    await ctx.runMutation(internal.lockMutations.updateBookingLockStatus, {
      bookingId: args.bookingId,
      lockSyncStatus: status === "active" ? "synced" : "failed",
    });

    return {
      success: seamCodeIds.length > 0,
      seamCodeIds,
      errors,
    };
  },
});

/**
 * Remove access codes from physical locks (on cancellation or expiry)
 */
export const removeAccessCode = internalAction({
  args: {
    bookingId: v.string(),
  },
  handler: async (ctx, args) => {
    // Get the lock code record
    const lockCode = await ctx.runQuery(internal.lockMutations.getLockCodeByBooking, {
      bookingId: args.bookingId,
    });

    if (!lockCode || lockCode.status === "removed") {
      return { success: true, message: "No active lock code to remove" };
    }

    const errors: string[] = [];

    for (const seamCodeId of lockCode.seamAccessCodeIds) {
      try {
        await seamFetch("/access_codes/delete", {
          method: "POST",
          body: JSON.stringify({ access_code_id: seamCodeId }),
        });
        console.log(`Removed access code ${seamCodeId}`);
      } catch (e: any) {
        console.error(`Failed to remove code ${seamCodeId}:`, e.message);
        errors.push(`${seamCodeId}: ${e.message}`);
      }
    }

    // Update lock code status
    await ctx.runMutation(internal.lockMutations.updateLockCodeStatus, {
      bookingId: args.bookingId,
      status: "removed",
    });

    // Update booking sync status
    await ctx.runMutation(internal.lockMutations.updateBookingLockStatus, {
      bookingId: args.bookingId,
      lockSyncStatus: "removed",
    });

    return { success: errors.length === 0, errors };
  },
});

/**
 * Sync a booking's access code to all mapped lock devices.
 * Called after booking confirmation.
 */
export const syncBookingToLocks = internalAction({
  args: {
    bookingId: v.string(),
    accessCode: v.string(),
    laneId: v.string(),
    additionalLaneIds: v.optional(v.array(v.string())),
    date: v.string(),
    startHour: v.number(),
    duration: v.number(),
    customerName: v.string(),
    customerEmail: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    // Check if lock sync is enabled
    const settings: any = await ctx.runQuery(internal.lockMutations.getLockSettings);
    if (!settings || !settings.enabled) {
      console.log("Lock sync disabled — skipping");
      return { skipped: true };
    }

    // Get device mappings for all lanes
    const allLaneIds = [args.laneId, ...(args.additionalLaneIds ?? [])];
    const deviceIds = new Set<string>();

    for (const lid of allLaneIds) {
      const mappings = await ctx.runQuery(internal.lockMutations.getDeviceMappingsByLane, { laneId: lid });
      for (const m of mappings) {
        deviceIds.add(m.deviceId);
      }
    }

    // Add default devices (e.g. main entrance)
    for (const did of settings.defaultDeviceIds) {
      deviceIds.add(did);
    }

    if (deviceIds.size === 0) {
      console.log("No lock devices mapped — skipping sync");
      await ctx.runMutation(internal.lockMutations.updateBookingLockStatus, {
        bookingId: args.bookingId,
        lockSyncStatus: "pending",
      });
      return { skipped: true, reason: "No devices mapped" };
    }

    // Calculate time window with lead/trail time
    const leadMinutes = settings.codeLeadTimeMinutes;
    const trailMinutes = settings.codeTrailTimeMinutes;

    const [year, month, day] = args.date.split("-").map(Number);
    const startWhole = Math.floor(args.startHour);
    const startMins = Math.round((args.startHour - startWhole) * 60);
    const endHour = args.startHour + args.duration / 60;
    const endWhole = Math.floor(endHour);
    const endMins = Math.round((endHour - endWhole) * 60);

    const startDate = new Date(year, month - 1, day, startWhole, startMins);
    startDate.setMinutes(startDate.getMinutes() - leadMinutes);

    const endDate = new Date(year, month - 1, day, endWhole, endMins);
    endDate.setMinutes(endDate.getMinutes() + trailMinutes);

    // Format as ISO with AWST offset
    const formatAWST = (d: Date) => {
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const da = String(d.getDate()).padStart(2, "0");
      const h = String(d.getHours()).padStart(2, "0");
      const mi = String(d.getMinutes()).padStart(2, "0");
      return `${y}-${mo}-${da}T${h}:${mi}:00+08:00`;
    };

    const startsAt = formatAWST(startDate);
    const endsAt = formatAWST(endDate);

    // Push the code
    return await ctx.runAction(internal.locks.pushAccessCode, {
      bookingId: args.bookingId,
      accessCode: args.accessCode,
      deviceIds: Array.from(deviceIds),
      startsAt,
      endsAt,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      laneId: args.laneId,
    });
  },
});

/**
 * Test connection to Seam API
 */
export const testConnection = action({
  args: {},
  handler: async () => {
    try {
      const data = await seamFetch("/health", { method: "GET" });
      return { connected: true, ok: data.ok ?? true };
    } catch (e: any) {
      // Try listing devices as fallback health check
      try {
        const data = await seamFetch("/devices/list", {
          method: "POST",
          body: JSON.stringify({ limit: 1 }),
        });
        return {
          connected: true,
          deviceCount: data.devices?.length ?? 0,
        };
      } catch (e2: any) {
        return { connected: false, error: e2.message };
      }
    }
  },
});

/**
 * List all access codes currently on a device
 */
export const listDeviceAccessCodes = action({
  args: { deviceId: v.string() },
  handler: async (_ctx, args) => {
    const data = await seamFetch("/access_codes/list", {
      method: "POST",
      body: JSON.stringify({ device_id: args.deviceId }),
    });

    return (data.access_codes || []).map((code: any) => ({
      id: code.access_code_id,
      code: code.code,
      name: code.name,
      type: code.type,
      status: code.status,
      startsAt: code.starts_at,
      endsAt: code.ends_at,
      createdAt: code.created_at,
    }));
  },
});
