/**
 * Pure slug utilities.
 *
 * These helpers are intentionally dependency-free and side-effect free so
 * they can be reused across routes, services, and tooling without pulling in
 * any gateway infrastructure (Supabase, auth, events, etc.).
 */

const VALID_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const MIN_SLUG_LENGTH = 1;
const MAX_SLUG_LENGTH = 64;

/**
 * Returns true iff `input` is a valid slug:
 *   - matches ^[a-z0-9]+(-[a-z0-9]+)*$
 *   - length is between 1 and 64 inclusive
 *
 * Returns false for empty strings, uppercase letters, spaces, leading /
 * trailing / consecutive hyphens, and any input longer than 64 chars.
 */
export function isValidSlug(input: string): boolean {
  if (input.length < MIN_SLUG_LENGTH || input.length > MAX_SLUG_LENGTH) {
    return false;
  }
  return VALID_SLUG_PATTERN.test(input);
}

/**
 * Normalizes arbitrary text into a slug.
 *
 * Steps:
 *   1. trim whitespace
 *   2. lowercase
 *   3. replace any run of whitespace or underscores with a single hyphen
 *   4. strip any remaining character that is not [a-z0-9-]
 *   5. collapse any run of 2+ hyphens into one hyphen
 *   6. strip leading/trailing hyphens
 *
 * If the result is empty after the above (e.g. the input was only
 * punctuation, emoji, or whitespace), returns the literal string "item".
 *
 * NOTE: `toSlug` does NOT enforce the 64-char length cap — that is
 * `isValidSlug`'s job. Inputs are not truncated.
 */
export function toSlug(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized.length > 0 ? normalized : 'item';
}