/**
 * VTID-03943 — excludePastPurchases()
 *
 * discover-search.ts computed the past-purchase exclusion (`withoutPast`)
 * but never reported how many products it dropped, so its
 * `hidden_breakdown`/`hidden_total` silently undercounted whenever a user's
 * results included an already-purchased product — the transparency footer
 * (HiddenByLimitationsFooter, which already renders a `past_purchases` row)
 * would just never show it for Search, only for Feed. discover-feed.ts had
 * the correct inline computation; this pins the shared, extracted version
 * both routes now call, so the two can no longer drift apart independently.
 */
import {
  excludePastPurchases,
  buildHiddenBreakdown,
  type LimitationsHiddenBreakdown,
} from '../src/services/limitations-filter';

interface P {
  id: string;
}

const FULL_LIMITATIONS: LimitationsHiddenBreakdown = {
  allergies: 1,
  contraindications: 2,
  medications: 3,
  dietary: 4,
  budget: 5,
  sensitivities: 6,
  geo: 7,
  excluded_region: 8,
};

describe('excludePastPurchases (VTID-03943)', () => {
  it('drops products whose id matches a past purchase', () => {
    const allowed: P[] = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    const result = excludePastPurchases(allowed, [{ product_id: 'p2' }]);
    expect(result.withoutPast.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('reports the correct hidden count, matching the number actually dropped', () => {
    const allowed: P[] = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    const result = excludePastPurchases(allowed, [{ product_id: 'p2' }, { product_id: 'p3' }]);
    expect(result.past_purchases_hidden).toBe(2);
    expect(result.withoutPast).toHaveLength(1);
  });

  it('reports zero when no past purchase overlaps the allowed list', () => {
    const allowed: P[] = [{ id: 'p1' }, { id: 'p2' }];
    const result = excludePastPurchases(allowed, [{ product_id: 'does-not-exist' }]);
    expect(result.past_purchases_hidden).toBe(0);
    expect(result.withoutPast).toEqual(allowed);
  });

  it('reports zero and returns the list unchanged when past purchases is empty', () => {
    const allowed: P[] = [{ id: 'p1' }, { id: 'p2' }];
    const result = excludePastPurchases(allowed, []);
    expect(result.past_purchases_hidden).toBe(0);
    expect(result.withoutPast).toEqual(allowed);
  });

  it('handles an empty allowed list', () => {
    const result = excludePastPurchases([], [{ product_id: 'p1' }]);
    expect(result.past_purchases_hidden).toBe(0);
    expect(result.withoutPast).toEqual([]);
  });

  it('a past purchase with no matching product in allowed contributes nothing', () => {
    const allowed: P[] = [{ id: 'p1' }];
    const result = excludePastPurchases(allowed, [{ product_id: 'p1' }, { product_id: 'unrelated' }]);
    expect(result.past_purchases_hidden).toBe(1);
    expect(result.withoutPast).toEqual([]);
  });
});

/**
 * VTID-03945 — buildHiddenBreakdown()
 *
 * discover-search.ts and discover-feed.ts each manually re-summed `geo`
 * (a pre-filter count over raw rows, plus applyUserLimitations()'s own
 * smaller geo count) and re-spread the other seven limitations fields
 * inline — duplicated merge logic, the same shape that let VTID-03943's
 * bug (and, earlier, VTID-03644/VTID-03696) slip in. This extracts that
 * merge into one function both routes now call, and pins it against the
 * exact formulas the two routes used before this refactor so the
 * refactor itself introduces no behavior change.
 */
describe('buildHiddenBreakdown (VTID-03945)', () => {
  it('sums preFilterGeoHidden and limitations.geo into the final geo count', () => {
    const result = buildHiddenBreakdown({
      preFilterGeoHidden: 10,
      limitations: FULL_LIMITATIONS,
      pastPurchasesHidden: 0,
    });
    expect(result.geo).toBe(10 + FULL_LIMITATIONS.geo);
  });

  it('copies every other limitations category through unchanged', () => {
    const result = buildHiddenBreakdown({
      preFilterGeoHidden: 0,
      limitations: FULL_LIMITATIONS,
      pastPurchasesHidden: 0,
    });
    expect(result.allergies).toBe(FULL_LIMITATIONS.allergies);
    expect(result.contraindications).toBe(FULL_LIMITATIONS.contraindications);
    expect(result.medications).toBe(FULL_LIMITATIONS.medications);
    expect(result.dietary).toBe(FULL_LIMITATIONS.dietary);
    expect(result.budget).toBe(FULL_LIMITATIONS.budget);
    expect(result.sensitivities).toBe(FULL_LIMITATIONS.sensitivities);
    expect(result.excluded_region).toBe(FULL_LIMITATIONS.excluded_region);
  });

  it('passes pastPurchasesHidden straight through', () => {
    const result = buildHiddenBreakdown({
      preFilterGeoHidden: 0,
      limitations: FULL_LIMITATIONS,
      pastPurchasesHidden: 42,
    });
    expect(result.past_purchases).toBe(42);
  });

  it('reports every limitations category as 0 when limitations is undefined (anonymous discover-search request)', () => {
    const result = buildHiddenBreakdown({
      preFilterGeoHidden: 5,
      limitations: undefined,
      pastPurchasesHidden: 0,
    });
    expect(result).toEqual({
      allergies: 0,
      contraindications: 0,
      medications: 0,
      dietary: 0,
      budget: 0,
      sensitivities: 0,
      geo: 5,
      excluded_region: 0,
      past_purchases: 0,
    });
  });

  it('reports every field as 0 for the fully-empty case', () => {
    const result = buildHiddenBreakdown({
      preFilterGeoHidden: 0,
      limitations: undefined,
      pastPurchasesHidden: 0,
    });
    expect(Object.values(result).every((v) => v === 0)).toBe(true);
  });

  it('matches discover-search.ts\'s pre-refactor formula exactly, ctx-present branch', () => {
    // Old inline logic (discover-search.ts, before VTID-03945):
    //   hiddenBreakdown = {
    //     ...result.hidden_breakdown,
    //     geo: hiddenBreakdown.geo /* = preFilterGeoHidden */ + result.hidden_breakdown.geo,
    //     excluded_region: result.hidden_breakdown.excluded_region,
    //     past_purchases: past_purchases_hidden,
    //   };
    const preFilterGeoHidden = 3;
    const limitations: LimitationsHiddenBreakdown = { ...FULL_LIMITATIONS, geo: 2 };
    const pastPurchasesHidden = 7;

    const oldWay = {
      ...limitations,
      geo: preFilterGeoHidden + limitations.geo,
      excluded_region: limitations.excluded_region,
      past_purchases: pastPurchasesHidden,
    };
    const newWay = buildHiddenBreakdown({ preFilterGeoHidden, limitations, pastPurchasesHidden });
    expect(newWay).toEqual(oldWay);
  });

  it('matches discover-feed.ts\'s pre-refactor formula exactly', () => {
    // Old inline logic (discover-feed.ts, before VTID-03945):
    //   hidden_breakdown: {
    //     ...hidden_breakdown,
    //     geo: hidden_breakdown.geo + (candidates.length - geoAllowed.length),
    //     past_purchases: past_purchases_hidden,
    //   }
    const candidatesLength = 20;
    const geoAllowedLength = 15;
    const limitations: LimitationsHiddenBreakdown = { ...FULL_LIMITATIONS, geo: 1 };
    const pastPurchasesHidden = 4;

    const oldWay = {
      ...limitations,
      geo: limitations.geo + (candidatesLength - geoAllowedLength),
      past_purchases: pastPurchasesHidden,
    };
    const newWay = buildHiddenBreakdown({
      preFilterGeoHidden: candidatesLength - geoAllowedLength,
      limitations,
      pastPurchasesHidden,
    });
    expect(newWay).toEqual(oldWay);
  });
});
