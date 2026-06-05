// SPEC_ANALYTICS_BUILD_2026-06 — shared helpers for the admin analytics queries.
// All venue time is AWST (UTC+8, no DST), so date bucketing converts a ms epoch
// into AWST wall-clock by adding a fixed offset and reading the UTC parts.

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const AWST_OFFSET_MS = 8 * HOUR_MS;

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
export const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad2 = (n: number) => String(n).padStart(2, "0");

/** AWST calendar parts for a ms epoch. */
export function awstParts(ms: number) {
  const d = new Date(ms + AWST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(), // 0-based
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    dow: d.getUTCDay(),
  };
}

/** AWST YYYY-MM-DD for a ms epoch. */
export function awstDateKey(ms: number): string {
  const p = awstParts(ms);
  return `${p.y}-${pad2(p.m + 1)}-${pad2(p.day)}`;
}

/** Parse a YYYY-MM-DD (AWST local date) to the ms epoch of its AWST midnight. */
export function awstDateKeyToMs(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  // AWST midnight = that wall-clock minus the +8 offset, expressed in UTC ms.
  return Date.UTC(y, (m || 1) - 1, d || 1) - AWST_OFFSET_MS;
}

/** Monday-anchored ISO-week key (YYYY-Www) for an AWST date string. */
export function isoWeekKey(dateKey: string): { key: string; label: string; mondayMs: number } {
  const ms = awstDateKeyToMs(dateKey);
  const p = awstParts(ms);
  // Days since Monday (AWST dow: 0=Sun..6=Sat).
  const sinceMon = (p.dow + 6) % 7;
  const mondayMs = ms - sinceMon * DAY_MS;
  const mp = awstParts(mondayMs);
  const key = `${mp.y}-${pad2(mp.m + 1)}-${pad2(mp.day)}`;
  const label = `${MONTH_ABBR[mp.m]} ${mp.day}`;
  return { key, label, mondayMs };
}

/** Month key (YYYY-MM) + short label for an AWST date string. */
export function monthKey(dateKey: string): { key: string; label: string } {
  const [y, m] = dateKey.split("-").map(Number);
  return { key: `${y}-${pad2(m)}`, label: `${MONTH_ABBR[(m || 1) - 1]} ${String(y).slice(2)}` };
}

export function dayLabel(dateKey: string): string {
  const [, m, d] = dateKey.split("-").map(Number);
  return `${MONTH_ABBR[(m || 1) - 1]} ${d}`;
}

/** Coarse platform bucket from a Web Push endpoint URL. */
export function platformFromEndpoint(endpoint: string): string {
  const e = (endpoint || "").toLowerCase();
  if (e.includes("push.apple.com")) return "ios";
  if (e.includes("fcm.googleapis.com") || e.includes("android")) return "fcm";
  if (e.includes("mozilla.com")) return "firefox";
  if (e.includes("windows.com") || e.includes("microsoft")) return "windows";
  return "other";
}

/** Coarse platform/device/browser from a user-agent string. */
export function parseUserAgent(ua: string): { device: string; os: string; browser: string } {
  const s = (ua || "").toLowerCase();
  const isTablet = s.includes("ipad") || (s.includes("android") && !s.includes("mobile"));
  const isMobile = !isTablet && (s.includes("mobile") || s.includes("iphone") || s.includes("android"));
  const device = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";
  let os = "other";
  if (s.includes("iphone") || s.includes("ipad") || s.includes("ios")) os = "iOS";
  else if (s.includes("android")) os = "Android";
  else if (s.includes("windows")) os = "Windows";
  else if (s.includes("mac os") || s.includes("macintosh")) os = "macOS";
  else if (s.includes("linux")) os = "Linux";
  let browser = "other";
  if (s.includes("edg/")) browser = "Edge";
  else if (s.includes("chrome/") && !s.includes("edg/")) browser = "Chrome";
  else if (s.includes("firefox/")) browser = "Firefox";
  else if (s.includes("safari/") && !s.includes("chrome/")) browser = "Safari";
  return { device, os, browser };
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function safeParseJson(s: string | undefined | null): Record<string, any> {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
