/**
 * VTID-04783 — Discover's category list, built from data.
 */
import { buildDiscoverCategoryTree } from '../../src/services/discover-categories';

const CATS = [
  { key: 'skincare', label_key: 'discover.categoryNames.skincare', icon: 'sparkles', sort_order: 20 },
  { key: 'supplements', label_key: 'discover.categoryNames.supplements', icon: 'pill', sort_order: 10 },
  { key: 'fitness', label_key: 'discover.categoryNames.fitness', icon: 'dumbbell', sort_order: 40 },
];
const SUBS = [
  { category_key: 'supplements', key: 'vitamins', label_key: 'discover.subcategories.vitamins', sort_order: 30 },
  { category_key: 'supplements', key: 'longevity', label_key: 'discover.subcategories.longevity', sort_order: 10 },
  { category_key: 'skincare', key: 'makeup', label_key: 'discover.subcategories.makeup', sort_order: 20 },
];
const COUNTS = [
  { category: 'supplements', subcategory: 'vitamins', product_count: '15' },
  { category: 'supplements', subcategory: null, product_count: 6 },
  { category: 'supplements', subcategory: 'sleep', product_count: 2 },   // not a known key
  { category: 'skincare', subcategory: 'makeup', product_count: 104 },
];

describe('buildDiscoverCategoryTree', () => {
  it('lists only categories and subcategories with live products, in sort order', () => {
    const tree = buildDiscoverCategoryTree(CATS, SUBS, COUNTS);
    expect(tree.map((c) => c.key)).toEqual(['supplements', 'skincare']);   // fitness has none yet
    expect(tree[0]).toEqual({
      key: 'supplements',
      label_key: 'discover.categoryNames.supplements',
      icon: 'pill',
      product_count: 23,
      unsorted_count: 8,                                                    // no or unknown subcategory
      subcategories: [{ key: 'vitamins', label_key: 'discover.subcategories.vitamins', product_count: 15 }],
    });
  });

  it('a product with no or an unknown subcategory is counted as unsorted, never lost', () => {
    const [supplements] = buildDiscoverCategoryTree(CATS, SUBS, COUNTS);
    const inSubs = supplements.subcategories.reduce((n, s) => n + s.product_count, 0);
    expect(inSubs + supplements.unsorted_count).toBe(supplements.product_count);
  });

  it('include_empty returns every category and subcategory (the supplier portal picker)', () => {
    const tree = buildDiscoverCategoryTree(CATS, SUBS, COUNTS, true);
    expect(tree.map((c) => c.key)).toEqual(['supplements', 'skincare', 'fitness']);
    expect(tree[0].subcategories.map((s) => s.key)).toEqual(['longevity', 'vitamins']);
    expect(tree[2]).toMatchObject({ key: 'fitness', product_count: 0, subcategories: [] });
  });

  it('ships label keys, never display text', () => {
    for (const c of buildDiscoverCategoryTree(CATS, SUBS, COUNTS, true)) {
      expect(c.label_key).toMatch(/^discover\./);
      for (const s of c.subcategories) expect(s.label_key).toMatch(/^discover\./);
    }
  });
});
