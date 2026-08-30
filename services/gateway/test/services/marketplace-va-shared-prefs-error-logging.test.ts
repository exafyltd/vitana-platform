/**
 * services/orb-tools/marketplace-va-shared.ts — loadMarketplacePrefs()
 * previously had zero test coverage.
 *
 * fetchMarketplacePrefFacts()'s error was discarded entirely (not even
 * destructured), inside a try/catch that only catches a thrown/rejected
 * promise — a real Supabase error resolves normally as {data: null,
 * error: {...}}, so it fell straight through as "no preference facts,"
 * indistinguishable from a user who genuinely has none set.
 *
 * This function feeds ~19 call sites across marketplace-journey-tools.ts
 * and marketplace-guide-tools.ts — on a transient error, a user's
 * previously-stated dietary/exclusion preferences (e.g. "no pills",
 * ingredient/brand avoidances) silently vanish for that call, and the
 * shopping guide can recommend products the user explicitly asked to
 * avoid, with nothing in logs. This pins that the error is now logged,
 * while the safe empty-prefs fallback (a deliberate, unchanged design
 * choice for this best-effort personalization seed) stays as-is.
 */

const mockFetchMarketplacePrefFacts = jest.fn();

jest.mock('../../src/services/orb-tools/marketplace-va-shared-repository', () => ({
  fetchMarketplacePrefFacts: (...args: unknown[]) => mockFetchMarketplacePrefFacts(...args),
}));

jest.mock('../../src/routes/universal-cart', () => ({
  emitCartEvent: jest.fn(),
}));

import { loadMarketplacePrefs } from '../../src/services/orb-tools/marketplace-va-shared';

const SB: any = {};

describe('loadMarketplacePrefs — fetchMarketplacePrefFacts error visibility', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs via console.error when the fact fetch errors, and still returns safe empty prefs (unchanged fallback)', async () => {
    mockFetchMarketplacePrefFacts.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });

    const prefs = await loadMarketplacePrefs(SB, 't1', 'u1');

    expect(prefs.dietary).toEqual([]);
    expect(prefs.exclusions).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchMarketplacePrefFacts failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
  });

  it('logs nothing and parses real preferences on success', async () => {
    mockFetchMarketplacePrefFacts.mockResolvedValue({
      data: [
        { fact_key: 'marketplace_pref_dietary', fact_value: 'vegan, gluten-free' },
        { fact_key: 'marketplace_pref_exclusions', fact_value: 'pills' },
      ],
      error: null,
    });

    const prefs = await loadMarketplacePrefs(SB, 't1', 'u1');

    expect(prefs.dietary).toEqual(['vegan', 'gluten-free']);
    expect(prefs.exclusions).toEqual(['pills']);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
