/**
 * VTID-03801 — Notification Settings stayed in German for Chinese/Turkish
 * users regardless of the selected language.
 *
 * `resolveRequestedLocale()` mirrors journey-checklist.ts's own resolveLocale():
 * an explicit `?locale=` (the live UI language) must win over the cached
 * server-side lookup (getUserLocale(), 5-minute in-process cache, never
 * invalidated by the frontend's Supabase-direct language-switch write).
 * Before this, the route had no `?locale=` handling at all, so a language
 * switch was invisible to this endpoint until the cache happened to expire.
 */
import { Request } from 'express';
import { resolveRequestedLocale } from '../../src/routes/user-category-preferences';

function reqWithLocale(locale: unknown): Request {
  return { query: { locale } } as unknown as Request;
}

describe('resolveRequestedLocale (VTID-03801)', () => {
  it('accepts every registered gateway locale, including tr and zh', () => {
    for (const l of ['de', 'en', 'es', 'sr', 'fr', 'pt', 'ru', 'pl', 'zh', 'ar', 'tr']) {
      expect(resolveRequestedLocale(reqWithLocale(l))).toBe(l);
    }
  });

  it('normalizes BCP-47 tags the frontend language picker sends', () => {
    expect(resolveRequestedLocale(reqWithLocale('zh-CN'))).toBe('zh');
    expect(resolveRequestedLocale(reqWithLocale('tr-TR'))).toBe('tr');
    expect(resolveRequestedLocale(reqWithLocale('DE-DE'))).toBe('de');
  });

  it('returns null for an unregistered or missing locale, so the caller falls back to getUserLocale()', () => {
    expect(resolveRequestedLocale(reqWithLocale('klingon'))).toBeNull();
    expect(resolveRequestedLocale(reqWithLocale(undefined))).toBeNull();
    expect(resolveRequestedLocale({ query: {} } as unknown as Request)).toBeNull();
  });

  it('is not fooled by a long or malformed query value', () => {
    expect(resolveRequestedLocale(reqWithLocale('a'.repeat(500)))).toBeNull();
    expect(resolveRequestedLocale(reqWithLocale(['zh', 'en']))).toBeNull();
  });
});
