/**
 * Referral validation: one rule for "does this referral count?", used
 * both when the buyer clicks and when a commission is about to be credited.
 *
 * docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md §9.2 / §9.4: the
 * referral a click carries arrives as a client-supplied `?rec_id=` and must be
 * resolved server-side before anyone is paid for it. A referral counts only
 * when:
 *   - it exists and is active;
 *   - it recommends the product that was bought (a link for product A cannot
 *     earn on product B);
 *   - the recommender is not the buyer (no self-referral);
 *   - the recommender is not a test or service account (NEVER rules 43–45:
 *     such accounts can never earn).
 *
 * Pure: no I/O. Callers load the rows and the exclusion set.
 */

export type ReferralRejection =
  | 'malformed_id'
  | 'not_found'
  | 'disabled'
  | 'product_mismatch'
  | 'self_referral'
  | 'excluded_account';

export interface ReferralRecord {
  id: string;
  user_id: string;
  product_id: string;
  status: string;
}

export type ReferralVerdict = { ok: true } | { ok: false; reason: ReferralRejection };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A referral id must look like a UUID before it is sent to the database. */
export function isReferralId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function validateReferral(input: {
  recommendation: ReferralRecord | null;
  productId: string;
  buyerUserId: string | null;
  excludedUserIds: ReadonlySet<string>;
}): ReferralVerdict {
  const rec = input.recommendation;
  if (!rec) return { ok: false, reason: 'not_found' };
  if (rec.status !== 'active') return { ok: false, reason: 'disabled' };
  if (rec.product_id !== input.productId) return { ok: false, reason: 'product_mismatch' };
  if (input.buyerUserId && input.buyerUserId === rec.user_id) return { ok: false, reason: 'self_referral' };
  if (input.excludedUserIds.has(rec.user_id)) return { ok: false, reason: 'excluded_account' };
  return { ok: true };
}
