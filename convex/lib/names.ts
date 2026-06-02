/**
 * Customer name helpers (SPEC_NAME_SPLIT).
 *
 * Customers carry firstName/lastName as the SOURCE fields, with `name` kept as a
 * DERIVED display string (`name = "first last"`) so the ~277 existing reads of
 * `name`/`customerName`/etc. keep working untouched. These two helpers are the
 * single place that compose/split, used by every capture point + the migration.
 */

/** Compose the display name from first/last. Trims + drops empties. */
export function composeName(
  first?: string | null,
  last?: string | null
): string {
  return [String(first ?? "").trim(), String(last ?? "").trim()]
    .filter(Boolean)
    .join(" ");
}

/**
 * Best-effort split of a single display name into first/last on the LAST space
 * (so multi-word given names stay with firstName). Single-word names → all
 * firstName, empty lastName. Imperfect for multi-word surnames ("van der Berg")
 * — admins can correct via the edit forms; that's why signup captures the two
 * fields explicitly rather than relying on this.
 */
export function splitName(full?: string | null): {
  firstName: string;
  lastName: string;
} {
  const name = String(full ?? "").trim().replace(/\s+/g, " ");
  if (!name) return { firstName: "", lastName: "" };
  const idx = name.lastIndexOf(" ");
  if (idx === -1) return { firstName: name, lastName: "" };
  return { firstName: name.slice(0, idx), lastName: name.slice(idx + 1) };
}
