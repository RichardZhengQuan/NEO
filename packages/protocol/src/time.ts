/**
 * Shared timezone helpers — pure, no imports needed.
 * Kept in @neo/protocol so the config schema refinement and tools can share the
 * same check without a circular dependency.
 */

/** True when `timezone` is an IANA zone (or alias) this runtime knows. */
export function isValidTimeZone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || !timezone) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
