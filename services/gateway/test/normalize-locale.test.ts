/**
 * normalizeLocale — regression coverage for language-name resolution.
 *
 * The assistant-inferred `memory_facts.preferred_language` fallback stores
 * values as language WORDS ("German", "Serbian", "Spanish"), not ISO codes.
 * The original ISO-prefix-only logic mis-resolved "serbian" → 'de' (starts
 * with "se", not "sr") and "spanish" → 'de' (starts with "sp", not "es"),
 * so non-de/en users were silently served German content. These tests pin
 * the corrected behaviour.
 */

import { normalizeLocale, GATEWAY_DEFAULT_LOCALE } from '../src/i18n/catalog';

describe('normalizeLocale', () => {
  it('resolves ISO codes and regional variants', () => {
    expect(normalizeLocale('de')).toBe('de');
    expect(normalizeLocale('de-DE')).toBe('de');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('sr')).toBe('sr');
    expect(normalizeLocale('sr-RS')).toBe('sr');
    expect(normalizeLocale('es')).toBe('es');
    expect(normalizeLocale('es-ES')).toBe('es');
  });

  it('resolves full English language names (the stored fact form)', () => {
    expect(normalizeLocale('English')).toBe('en');
    expect(normalizeLocale('German')).toBe('de');
    // Regression: these two used to collapse to the default ('de').
    expect(normalizeLocale('Serbian')).toBe('sr');
    expect(normalizeLocale('Spanish')).toBe('es');
  });

  it('resolves native language names', () => {
    expect(normalizeLocale('Deutsch')).toBe('de');
    expect(normalizeLocale('Srpski')).toBe('sr');
    expect(normalizeLocale('Español')).toBe('es');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeLocale('  serbian  ')).toBe('sr');
    expect(normalizeLocale('SPANISH')).toBe('es');
  });

  it('falls back to the default locale for empty or unsupported input', () => {
    expect(normalizeLocale(null)).toBe(GATEWAY_DEFAULT_LOCALE);
    expect(normalizeLocale(undefined)).toBe(GATEWAY_DEFAULT_LOCALE);
    expect(normalizeLocale('')).toBe(GATEWAY_DEFAULT_LOCALE);
    expect(normalizeLocale('Klingon')).toBe(GATEWAY_DEFAULT_LOCALE);
  });
});
