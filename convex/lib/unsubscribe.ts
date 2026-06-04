// SPEC_ADMIN_BROADCAST §8 — one-click marketing unsubscribe (Australian Spam Act).
// Stateless HMAC token over the recipient's email, signed with BETTER_AUTH_SECRET
// (always set on prod). The /unsubscribe HTTP route re-derives + compares the
// token before flipping receiveMarketing=false, so a link can only unsubscribe
// the email it was issued for. Web Crypto is available in both the default Convex
// action runtime and httpAction.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC-SHA256(email, BETTER_AUTH_SECRET) as hex. "" when the secret is unset. */
export async function unsubscribeToken(email: string): Promise<string> {
  const secret = process.env.BETTER_AUTH_SECRET || "";
  if (!secret) return "";
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(email.toLowerCase().trim()));
  return toHex(sig);
}

/** Full unsubscribe URL on the Convex .site origin. "" if no secret/site. */
export async function makeUnsubscribeUrl(email: string): Promise<string> {
  const site = process.env.CONVEX_SITE_URL || "";
  const token = await unsubscribeToken(email);
  if (!site || !token) return "";
  return `${site}/unsubscribe?e=${encodeURIComponent(email.toLowerCase().trim())}&t=${token}`;
}

/** Constant-time-ish token check for the /unsubscribe route. */
export async function verifyUnsubscribeToken(email: string, token: string): Promise<boolean> {
  const expected = await unsubscribeToken(email);
  if (!expected || !token || expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
