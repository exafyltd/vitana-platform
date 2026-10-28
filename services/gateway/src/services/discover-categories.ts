/**
 * VTID-04783 — Discover's category list, built from data.
 *
 * Categories and subcategories live in discover_categories /
 * discover_subcategories (owner direction 2026-10-01: more categories will be
 * added over time, so adding one must be a data row, not a code change).
 * Labels are i18n KEYS — the frontend translates them; the gateway never ships
 * display text.
 *
 * Pure: takes the three query results and returns the tree, so it is tested
 * without a database.
 */

export interface DiscoverCategoryRow {
  key: string;
  label_key: string;
  icon: string | null;
  sort_order: number;
}

export interface DiscoverSubcategoryRow {
  category_key: string;
  key: string;
  label_key: string;
  sort_order: number;
}

export interface DiscoverCategoryCountRow {
  category: string;
  subcategory: string | null;
  product_count: number | string;
}

export interface DiscoverSubcategoryNode {
  key: string;
  label_key: string;
  product_count: number;
}

export interface DiscoverCategoryNode {
  key: string;
  label_key: string;
  icon: string | null;
  product_count: number;
  /** Live products in this category with no (known) subcategory. */
  unsorted_count: number;
  subcategories: DiscoverSubcategoryNode[];
}

/**
 * The category tree with live product counts.
 *
 * - Without `includeEmpty` a category shows only once it has live products,
 *   and a subcategory only once it has some — a new category stays hidden
 *   until a supplier fills it. The supplier portal asks with `includeEmpty`
 *   to offer every subcategory.
 * - A product whose subcategory is not a known key for its category counts
 *   toward `unsorted_count`, never disappears.
 */
export function buildDiscoverCategoryTree(
  categories: DiscoverCategoryRow[],
  subcategories: DiscoverSubcategoryRow[],
  counts: DiscoverCategoryCountRow[],
  includeEmpty = false,
): DiscoverCategoryNode[] {
  const known = new Map<string, Set<string>>();
  for (const s of subcategories) {
    if (!known.has(s.category_key)) known.set(s.category_key, new Set());
    known.get(s.category_key)!.add(s.key);
  }

  const total = new Map<string, number>();
  const bySub = new Map<string, number>();
  const unsorted = new Map<string, number>();
  for (const c of counts) {
    const n = Number(c.product_count) || 0;
    total.set(c.category, (total.get(c.category) ?? 0) + n);
    if (c.subcategory && known.get(c.category)?.has(c.subcategory)) {
      bySub.set(`${c.category}\u0000${c.subcategory}`, n);
    } else {
      unsorted.set(c.category, (unsorted.get(c.category) ?? 0) + n);
    }
  }

  return [...categories]
    .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
    .map((c) => ({
      key: c.key,
      label_key: c.label_key,
      icon: c.icon,
      product_count: total.get(c.key) ?? 0,
      unsorted_count: unsorted.get(c.key) ?? 0,
      subcategories: subcategories
        .filter((s) => s.category_key === c.key)
        .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
        .map((s) => ({
          key: s.key,
          label_key: s.label_key,
          product_count: bySub.get(`${c.key}\u0000${s.key}`) ?? 0,
        }))
        .filter((s) => includeEmpty || s.product_count > 0),
    }))
    .filter((c) => includeEmpty || c.product_count > 0);
}
