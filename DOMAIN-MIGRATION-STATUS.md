# Domain migration — `cricketrevolution.au` → `cricketrevolution.com.au`

**Status as of 2026-06-09** · Branch: `claude/beautiful-wozniak-586bm1` · PR: #1

Handoff doc for resuming on another device. The migration is **partially done**;
email is currently **paused** (see "Production impact" below). Work the
"Remaining steps" in order.

---

## Goal
- Make **`cricketrevolution.com.au`** (apex, no `www`) the **primary** domain.
- Make **`cricketrevolution.au`** **redirect** to the primary.
- Move email sending to **`@cricketrevolution.com.au`**.

## Decisions made
- **Primary = apex** `cricketrevolution.com.au` (not `www`).
- **DNS path = Vercel nameservers.** `.com.au` is registered at **Squarespace**
  but was delegated to **Google Cloud DNS** (which we have no login for), so we
  repointed its nameservers to Vercel (`ns1.vercel-dns.com` / `ns2.vercel-dns.com`)
  and manage all its DNS in Vercel. No registrar transfer needed.
- **Email cutover = "delete now, accept a gap."** Resend free plan allows only
  1 domain, so the old `.au` sender was removed to add `.com.au`. Email is down
  until `.com.au` verifies + `EMAIL_FROM` is switched.

## Completed ✅
- **Code (PR #1, not yet merged/deployed):**
  - `.com.au` + `www.com.au` added to all 3 CORS allowlists (`convex/http.ts`
    ×2, `convex/auth.ts`); `.au` kept for the redirect window.
  - All in-email / booking / invite links + email footer → `.com.au`
    (`convex/emails.ts`, `convex/lib/email.ts`, `weeklySummary.ts`,
    `waitlist.ts`, `mates.ts`, `testEmails.ts`).
  - `EMAIL_FROM` example + `robots.txt` / `sitemap.xml` → `.com.au`.
- **Squarespace:** nameservers changed to Vercel — **propagated** (confirmed by
  Vercel showing the domain valid).
- **Vercel:** `cricketrevolution.com.au` shows **Valid Configuration** (apex
  live, HTTPS cert issued).
- **Resend:** old `.au` domain deleted; `cricketrevolution.com.au` added
  (**pending DNS verification**).

## Remaining steps (in order) ⬜

1. **Add the 4 Resend DNS records in Vercel** (Domains → `cricketrevolution.com.au`
   → DNS Records → Add). See exact values in "Reference" below. Name = host only
   (Vercel appends the domain). Then in **Resend → Verify DNS Records**.

2. **Flip Convex `EMAIL_FROM`** — *after* Resend shows Verified.
   dashboard.convex.dev → krickora-prod **production** deployment → Settings →
   Environment Variables:
   - `EMAIL_FROM` = `Cricket Revolution <noreply@cricketrevolution.com.au>`
   - Takes effect immediately (read at send time, no redeploy). **This restores email.**

3. **Set `SITE_URL`** (same env screen):
   - `SITE_URL` = `https://cricketrevolution.com.au`
   - Drives Stripe `success_url`/`cancel_url` + auth trusted origins.

4. **Vercel redirect:** Edit the `cricketrevolution.au` domain → **Redirect →
   `cricketrevolution.com.au`** (currently it still serves the app directly, so
   `.com.au` isn't yet the single canonical URL).

5. **Merge & deploy PR #1.** Required for the CORS allowlist + in-email `.com.au`
   link constants to take effect on the live Convex deployment. (`EMAIL_FROM` and
   `SITE_URL` are env-only and independent of this deploy.)

6. **Verify end-to-end:** load `https://cricketrevolution.com.au`, confirm
   `https://cricketrevolution.au` redirects to it, make a test booking, confirm
   the confirmation email arrives **from `@cricketrevolution.com.au`**.

## Production impact right now ⚠️
- **Email is paused** until steps 1–2 are done. Bookings + Stripe payments still
  work; the notification email (incl. **door access codes**) won't send during
  the gap. Close the gap by completing steps 1–2.
- Both `.au` and `.com.au` currently serve the site; the redirect (step 4) makes
  `.com.au` canonical.

## Reference — exact Resend DNS records (enter in Vercel)
| Purpose | Type | Name | Value | Priority | TTL |
|---|---|---|---|---|---|
| DKIM | TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDUUBJq4yuQivR2NEqo7QdsbnbPWSiHUTasz3UZyrEX8p2KnYBaLboid0ZCSFRNkrCEkLqrxygflV3MYqi3Ky1sdgzZms3TFtoRnlkFyTwkGC3iy68vYzr6101S2QMPF2LLOSREpTZSCuwzsemznAbUNcoj4bEIdtBY3FLXwftp1wIDAQAB` | — | 60 |
| SPF | MX | `send` | `feedback-smtp.ap-northeast-1.amazonses.com` | 10 | 60 |
| SPF | TXT | `send` | `v=spf1 include:amazonses.com ~all` | — | 60 |
| DMARC | TXT | `_dmarc` | `v=DMARC1; p=none;` | — | 60 |

Gotchas: copy the full DKIM value (ends `…wIDAQAB`, no spaces/line breaks); two
records named `send` (MX + TXT) is correct.

## Separate follow-up — Google Cloud / Calendar ownership (NOT urgent)
- Calendar **sync** (`convex/googleCalendar.ts`) runs on a stored refresh token,
  so it keeps working on the new domain — **don't reconnect mid-migration.**
- Risk: it depends on a Google Cloud project (the `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` OAuth app) and a connected Google account that we may
  not control — possibly the same project that held the DNS.
- The OAuth **authorized redirect URI** is domain-specific. A future *reconnect*
  from `.com.au` will fail with `redirect_uri_mismatch` until someone adds
  `https://cricketrevolution.com.au/…` to the OAuth app's redirect URIs in Google
  Cloud Console.
- Action: establish ownership of that GCP project + the connected Google account;
  add the new redirect URI. Calendar sync is a staff convenience, not in the
  booking/payment path.

## Accounts / where things live
- **Registrar (.com.au):** Squarespace · **DNS (.com.au):** Vercel (nameservers)
- **Registrar/DNS (.au):** GoDaddy
- **Hosting:** Vercel (project `krickora-prod`) · **Backend:** Convex (`krickora-prod`)
- **Email:** Resend · **Payments:** Stripe
