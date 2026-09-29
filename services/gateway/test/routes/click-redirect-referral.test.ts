/**
 * VTID-04735 — the click redirect resolves `?rec_id=` server-side. A referral
 * that does not count is dropped from the click, with the reason; a failed
 * lookup keeps it as `unverified` (the crediting step re-checks strictly).
 */
const mockFetchRec = jest.fn();
jest.mock('../../src/routes/click-redirect-repository', () => ({
  fetchRecommendationForReferral: (...a: unknown[]) => mockFetchRec(...a),
}));
const mockExcluded = jest.fn();
jest.mock('../../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIds: (...a: unknown[]) => mockExcluded(...a),
}));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => null }));
jest.mock('../../src/services/reward-events', () => ({ emitClickOutbound: jest.fn(), emitGeoMismatch: jest.fn() }));

import { resolveClickReferral } from '../../src/routes/click-redirect';

const SB: any = {};
const ID = '11111111-1111-4111-8111-111111111111';
const REC = { id: ID, user_id: 'recommender-1', product_id: 'prod-1', status: 'active' };

beforeEach(() => {
  jest.clearAllMocks();
  mockExcluded.mockResolvedValue(new Set());
  mockFetchRec.mockResolvedValue({ data: REC, error: null });
});

describe('resolveClickReferral', () => {
  it('no rec_id: nothing to resolve, no lookup', async () => {
    expect(await resolveClickReferral(SB, null, 'prod-1', null)).toEqual({ recommendationId: null, rejected: null });
    expect(mockFetchRec).not.toHaveBeenCalled();
  });

  it('keeps a valid referral', async () => {
    expect(await resolveClickReferral(SB, ID, 'prod-1', 'buyer-1')).toEqual({ recommendationId: ID, rejected: null });
  });

  it('drops a malformed id without querying the database', async () => {
    expect(await resolveClickReferral(SB, 'x; drop', 'prod-1', null)).toEqual({ recommendationId: null, rejected: 'malformed_id' });
    expect(mockFetchRec).not.toHaveBeenCalled();
  });

  const cases: Array<[string, () => void, string | null, string]> = [
    ['not_found', () => mockFetchRec.mockResolvedValue({ data: null, error: null }), null, 'prod-1'],
    ['product_mismatch', () => undefined, null, 'prod-2'],
    ['self_referral', () => undefined, 'recommender-1', 'prod-1'],
    ['excluded_account', () => mockExcluded.mockResolvedValue(new Set(['recommender-1'])), null, 'prod-1'],
  ];
  it.each(cases)('drops a referral that does not count: %s', async (reason, arrange, buyer, product) => {
    arrange();
    expect(await resolveClickReferral(SB, ID, product, buyer)).toEqual({ recommendationId: null, rejected: reason });
  });

  it('keeps the referral as unverified when the lookup fails, so the redirect never depends on the database', async () => {
    mockFetchRec.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    expect(await resolveClickReferral(SB, ID, 'prod-1', null)).toEqual({ recommendationId: ID, rejected: 'unverified' });
    mockFetchRec.mockRejectedValue(new Error('boom'));
    expect(await resolveClickReferral(SB, ID, 'prod-1', null)).toEqual({ recommendationId: ID, rejected: 'unverified' });
  });
});
