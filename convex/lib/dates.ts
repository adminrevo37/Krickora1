// Single source for AWST-correct booking-date display formatting. See
// cricket/krickora/SPEC_DATE_FORMAT_STANDARDIZATION_2026-08.md for the full rationale —
// this consolidates 5 previously-independent copies of the same logic.
//
// toLocaleDateString without an explicit timeZone uses the Convex server zone (UTC),
// which can flip the weekday at the day boundary for AWST recipients (Bug #4) — every
// function here sets timeZone explicitly.

// en-AU's Intl output has no comma after the weekday ("Tuesday 1 September
// 2026") — build it explicitly rather than rely on locale punctuation, which
// can vary by runtime/ICU version.
function weekdayOf(d: Date): string {
  return d.toLocaleDateString("en-AU", { timeZone: "Australia/Perth", weekday: "long" });
}

// Long form — every UI display, email body, PDF, push notification body.
// e.g. "Tuesday, 1 September 2026"
export function fmtAwstDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const rest = d.toLocaleDateString("en-AU", {
    timeZone: "Australia/Perth",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `${weekdayOf(d)}, ${rest}`;
}

// Short form — email SUBJECT LINES ONLY. Same as the long form minus the year.
// e.g. "Tuesday, 1 September"
export function fmtAwstDateShort(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const rest = d.toLocaleDateString("en-AU", {
    timeZone: "Australia/Perth",
    day: "numeric",
    month: "long",
  });
  return `${weekdayOf(d)}, ${rest}`;
}
