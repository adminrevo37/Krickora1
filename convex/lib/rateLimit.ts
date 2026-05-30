/**
 * Simple fixed-window rate limiter backed by the `rateLimits` table.
 *
 * SEC decision #5 fallback: the official @convex-dev/rate-limiter component is
 * preferred, but it cannot be installed while Convex is locked on Shipper. This
 * table-based limiter is dependency-free and works inside any mutation context.
 *
 * Call from a MUTATION (it writes to the DB). For read-only queries, gate the
 * mutation that follows instead.
 */

export interface RateLimitOptions {
  /** Logical action name, e.g. "mate-search", "password-reset". */
  action: string;
  /** Caller identifier — userId, email, or IP. */
  identifier: string;
  /** Max allowed calls within the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Returns true if the call is allowed, false if the limit is exceeded.
 * Increments the counter when allowed. Never throws (fails open on error so a
 * limiter bug can't lock users out of core flows).
 */
export async function checkRateLimit(
  ctx: any,
  { action, identifier, max, windowMs }: RateLimitOptions
): Promise<boolean> {
  try {
    const key = `${action}:${identifier}`;
    const now = Date.now();
    const existing = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q: any) => q.eq("key", key))
      .first();

    if (!existing || now - existing.windowStart >= windowMs) {
      // New window
      if (existing) {
        await ctx.db.patch(existing._id, { windowStart: now, count: 1 });
      } else {
        await ctx.db.insert("rateLimits", { key, windowStart: now, count: 1 });
      }
      return true;
    }

    if (existing.count >= max) {
      return false; // limit exceeded — do NOT increment further
    }

    await ctx.db.patch(existing._id, { count: existing.count + 1 });
    return true;
  } catch (e) {
    console.error("checkRateLimit failed (failing open):", e);
    return true;
  }
}

/** Throwing variant — use when a blocked call should surface an error. */
export async function enforceRateLimit(
  ctx: any,
  opts: RateLimitOptions,
  message = "Too many requests. Please try again shortly."
): Promise<void> {
  const ok = await checkRateLimit(ctx, opts);
  if (!ok) throw new Error(message);
}
