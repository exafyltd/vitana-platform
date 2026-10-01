/**
 * VTID-04735 — the one rule for "does this referral count?", shared by the
 * click redirect and the recommender credit.
 */
import { isReferralId, validateReferral } from '../../src/services/recommendation-commissions/referral-validation';

const REC = { id: '11111111-1111-4111-8111-111111111111', user_id: 'recommender-1', product_id: 'prod-1', status: 'active' };
const base = { recommendation: REC, productId: 'prod-1', buyerUserId: 'buyer-1', excludedUserIds: new Set<string>() };

describe('validateReferral', () => {
  it('accepts an active referral for the bought product by someone else', () => {
    expect(validateReferral(base)).toEqual({ ok: true });
  });

  it('accepts it for an anonymous buyer', () => {
    expect(validateReferral({ ...base, buyerUserId: null })).toEqual({ ok: true });
  });

  it.each([
    ['not_found', { recommendation: null }],
    ['disabled', { recommendation: { ...REC, status: 'disabled' } }],
    ['product_mismatch', { productId: 'prod-2' }],
    ['self_referral', { buyerUserId: 'recommender-1' }],
    ['excluded_account', { excludedUserIds: new Set(['recommender-1']) }],
  ])('rejects %s', (reason, override) => {
    expect(validateReferral({ ...base, ...(override as object) })).toEqual({ ok: false, reason });
  });

  it('checks existence before anything else, and self-referral before the exclusion list', () => {
    expect(validateReferral({ ...base, recommendation: null, buyerUserId: 'recommender-1' })).toEqual({ ok: false, reason: 'not_found' });
    expect(
      validateReferral({ ...base, buyerUserId: 'recommender-1', excludedUserIds: new Set(['recommender-1']) }),
    ).toEqual({ ok: false, reason: 'self_referral' });
  });
});

describe('isReferralId', () => {
  it('accepts a UUID and rejects anything else before it reaches the database', () => {
    expect(isReferralId(REC.id)).toBe(true);
    for (const bad of ['', 'rec-1', "1' OR '1'='1", `${REC.id}x`, null, undefined, 42]) {
      expect(isReferralId(bad)).toBe(false);
    }
  });
});
