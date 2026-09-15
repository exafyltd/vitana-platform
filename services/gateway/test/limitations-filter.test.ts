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
import { excludePastPurchases } from '../src/services/limitations-filter';

interface P {
  id: string;
}

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
