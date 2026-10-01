/**
 * VTID-04496 — the golden set itself must stay honest.
 *
 * Fails when a case names a screen the catalog does not have (a screen was
 * renamed or removed without updating the set), when ids collide, when a case
 * both expects and forbids a screen, or when a shipped locale has no coverage.
 */
process.env.NODE_ENV = 'test';

import { GOLDEN_SET } from './golden-set';
import { NAVIGATION_CATALOG } from '../../src/lib/navigation-catalog';

const KNOWN = new Set(NAVIGATION_CATALOG.map((e) => e.screen_id));
const SHIPPED_LOCALES = ['en', 'de', 'es', 'fr', 'sr', 'pl', 'pt', 'ru', 'tr', 'ar', 'zh'];

describe('VTID-04496 golden navigation set — integrity', () => {
  it('has unique case ids', () => {
    const seen = new Set<string>();
    const dupes = GOLDEN_SET.filter((c) => (seen.has(c.id) ? true : (seen.add(c.id), false))).map((c) => c.id);
    expect(dupes).toEqual([]);
  });

  it('only names screens that exist in the catalog', () => {
    const unknown = GOLDEN_SET.flatMap((c) =>
      [...c.expect, ...(c.forbid || [])].filter((id) => !KNOWN.has(id)).map((id) => `${c.id} → ${id}`),
    );
    expect(unknown).toEqual([]);
  });

  it('never expects and forbids the same screen', () => {
    const clashes = GOLDEN_SET.filter((c) => c.expect.some((id) => c.forbid?.includes(id))).map((c) => c.id);
    expect(clashes).toEqual([]);
  });

  it('gives navigation cases at least one acceptable screen and non-navigation cases none', () => {
    const bad = GOLDEN_SET.filter((c) => (c.intent === 'none') !== (c.expect.length === 0)).map((c) => c.id);
    expect(bad).toEqual([]);
  });

  it('covers every shipped locale with at least one explicit "open" request', () => {
    const missing = SHIPPED_LOCALES.filter(
      (l) => !GOLDEN_SET.some((c) => c.lang === l && c.intent === 'open'),
    );
    expect(missing).toEqual([]);
  });

  it('keeps every production failure as a permanent case', () => {
    const prod = GOLDEN_SET.filter((c) => c.source === 'prod').map((c) => c.id);
    expect(prod).toEqual(expect.arrayContaining(['prod.news-to-cart.sr.1', 'prod.all-news.en.1', 'prod.community-news.en.1']));
  });
});
