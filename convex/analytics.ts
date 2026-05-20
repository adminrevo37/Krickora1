import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ============================================================================
// TRACK EVENT — public mutation for client-side tracker
// ============================================================================
export const trackEvent = mutation({
  args: {
    type: v.string(),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    referrer: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    userId: v.optional(v.string()),
    metadata: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("analytics", {
      type: args.type,
      name: args.name,
      url: args.url,
      referrer: args.referrer,
      sessionId: args.sessionId,
      userId: args.userId,
      metadata: args.metadata,
      userAgent: args.userAgent,
      timestamp: args.timestamp,
    });
  },
});

// ============================================================================
// ADMIN QUERIES
// ============================================================================

// Get recent events (last N)
export const getRecentEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    return await ctx.db
      .query("analytics")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit);
  },
});

// Get pageviews in a date range
export const getPageviews = query({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("analytics")
      .withIndex("by_type_timestamp", (q: any) =>
        q.eq("type", "pageview").gte("timestamp", args.startTimestamp)
      )
      .collect();
    return events.filter((e) => e.timestamp <= args.endTimestamp);
  },
});

// Get event counts by type for a date range
export const getEventSummary = query({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    // Use index range bounds to avoid loading the entire analytics table
    const filtered = await ctx.db
      .query("analytics")
      .withIndex("by_timestamp", (q: any) =>
        q.gte("timestamp", args.startTimestamp).lte("timestamp", args.endTimestamp)
      )
      .collect();

    const summary: Record<string, number> = {};
    for (const e of filtered) {
      const key = e.type === "event" ? `event:${e.name ?? "unknown"}` : e.type;
      summary[key] = (summary[key] ?? 0) + 1;
    }

    return {
      total: filtered.length,
      breakdown: summary,
      uniqueSessions: new Set(filtered.map((e) => e.sessionId).filter(Boolean)).size,
    };
  },
});
