// VTID-03509 — coverage + fidelity guards for the gateway locale catalogs.
//
// These strings land on lock screens and in email subject lines, where the
// frontend cannot intercept and retranslate them. Before this change, `es` and
// `sr` were `{ ...EN }` — literal English objects claiming to be Spanish and
// Serbian. That shape defeats every obvious check: `tt()` found a value for
// every key, so no fallback fired, and a naive "does the locale have all the
// keys?" test passed with 100% coverage while the content was English.
//
// The tests below therefore check three separate properties, because key
// coverage alone provably does not catch the bug that actually happened:
//   1. coverage      — every key present
//   2. fidelity      — the value is not just the English string
//   3. interpolation — {placeholders} survive translation

import {
  GATEWAY_LOCALES,
  missingKeysForLocale,
  tt,
  normalizeLocale,
  resolveLocaleStrict,
  type GatewayI18nKey,
  type GatewayLocale,
} from '../../src/i18n/catalog';

import de from '../../src/i18n/locales/de.json';
import en from '../../src/i18n/locales/en.json';
import es from '../../src/i18n/locales/es.json';
import sr from '../../src/i18n/locales/sr.json';
import fr from '../../src/i18n/locales/fr.json';
import pt from '../../src/i18n/locales/pt.json';
import ru from '../../src/i18n/locales/ru.json';
import pl from '../../src/i18n/locales/pl.json';
import zh from '../../src/i18n/locales/zh.json';
// VTID-03644: ar registered (9-language activation prep) but deliberately
// ships EMPTY — see the note above `FULLY_TRANSLATED_LOCALES` below for why
// this is not treated the same as the other 8 by the coverage/fidelity/
// placeholder suites.
import ar from '../../src/i18n/locales/ar.json';

const RAW: Record<GatewayLocale, Record<string, string>> = {
  de, en, es, sr, fr, pt, ru, pl, zh, ar,
};

const KEYS = Object.keys(de) as GatewayI18nKey[];

// VTID-03644 — locales that are REGISTERED (GATEWAY_LOCALES) but not yet
// EXPECTED to have full coverage. `ar` was added for the 9-language rollout
// with an intentionally empty catalog (`{}`) rather than a copy of English —
// VTID-03509's own lesson is that a fake "complete" translation is worse than
// an honest gap, because it defeats every coverage check silently. So `ar` is
// carved OUT of the "must be 100%" suites below and gets its own explicit
// "is honestly incomplete, and tt() falls back visibly" assertion instead.
// Promote it out of this list (and its `supported_locales.status` out of
// 'draft') once it goes through the normal translate+audit pipeline
// (`docs/DB-CONTENT-I18N.md`-adjacent workflow: `scripts/translate-keys.mjs`
// + `i18n-audit-llm.yml`), the same graduation path every other locale here
// took.
const FULLY_TRANSLATED_LOCALES: GatewayLocale[] = GATEWAY_LOCALES.filter(
  (l) => l !== 'ar',
) as GatewayLocale[];

/** Placeholder names in a string, sorted — `{count}` etc. */
function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('gateway i18n catalog coverage', () => {
  it('ships all 10 registered locales', () => {
    // zh added VTID-03569; ar added VTID-03644. This assertion is deliberately
    // an exact list rather than a count: it is the one place a locale silently
    // disappearing from GATEWAY_LOCALES — and therefore falling back to German
    // for every push notification — would be caught.
    expect([...GATEWAY_LOCALES].sort()).toEqual(
      ['ar', 'de', 'en', 'es', 'fr', 'pl', 'pt', 'ru', 'sr', 'zh'],
    );
  });

  it.each(FULLY_TRANSLATED_LOCALES)('%s has every key DE has', (locale) => {
    expect(missingKeysForLocale(locale)).toEqual([]);
  });

  it.each(FULLY_TRANSLATED_LOCALES)('%s has no empty values', (locale) => {
    const empty = KEYS.filter((k) => !String(RAW[locale][k] ?? '').trim());
    expect(empty).toEqual([]);
  });

  it('ar is honestly incomplete (registered, not yet translated) and tt() falls back visibly', () => {
    // The assertion this test guards against: shipping `{ ...en }` for ar to
    // make the coverage suite pass, which is precisely the bug VTID-03509 dug
    // this whole file out of. Missing 100% of DE's keys is the correct, honest
    // state for a locale that has not gone through the translate+audit
    // pipeline yet — and every push notification for an Arabic user still
    // renders (via the EN → DE fallback chain in `tt()`), never a raw key.
    expect(missingKeysForLocale('ar')).toEqual(KEYS);
    expect(tt('notif.diary_reminder.title', 'ar')).toBe(en['notif.diary_reminder.title']);
  });
});

describe('gateway i18n catalog fidelity', () => {
  // The `{ ...EN }` bug. A translated locale shares SOME strings with English
  // legitimately — 'Vitana' is 'Vitana' everywhere, and emoji-only values are
  // identical by design. What is not legitimate is the vast majority matching.
  const TRANSLATED: GatewayLocale[] = ['de', 'es', 'sr', 'fr', 'pt', 'ru', 'pl', 'zh'];

  it.each(TRANSLATED)('%s is not a copy of the English catalog', (locale) => {
    const identical = KEYS.filter((k) => RAW[locale][k] === en[k]);
    const ratio = identical.length / KEYS.length;

    // Jest's expect() takes no message argument, so the diagnostic is encoded
    // in the compared value — a failure prints the ratio and offending keys.
    const verdict =
      ratio < 0.1
        ? 'distinct-from-en'
        : `COPY-OF-EN: ${identical.length}/${KEYS.length} values verbatim ` +
          `(sample: ${identical.slice(0, 5).join(', ')})`;

    expect(verdict).toBe('distinct-from-en');
  });
});

describe('gateway i18n placeholder integrity', () => {
  // A translator dropping {count} or renaming it to {cantidad} produces a
  // grammatical sentence with a missing number — invisible to a reviewer who
  // does not speak the language, and only ever seen by the affected users.
  it.each(FULLY_TRANSLATED_LOCALES)('%s preserves every {placeholder} exactly', (locale) => {
    const broken = KEYS.filter(
      (k) => placeholders(RAW[locale][k]).join(',') !== placeholders(en[k]).join(','),
    ).map((k) => `${k}: en{${placeholders(en[k])}} vs ${locale}{${placeholders(RAW[locale][k])}}`);

    expect(broken).toEqual([]);
  });
});

describe('locale resolution', () => {
  it('resolves language words whose spelling does not match their ISO code', () => {
    // Both begin with "po" — neither matches its own code, and they collide.
    expect(normalizeLocale('Portuguese')).toBe('pt');
    expect(normalizeLocale('Polish')).toBe('pl');
    expect(normalizeLocale('polnisch')).toBe('pl');
    expect(normalizeLocale('portugiesisch')).toBe('pt');
    // Pre-existing cases this file's sibling comment documents.
    expect(normalizeLocale('Serbian')).toBe('sr');
    expect(normalizeLocale('Spanish')).toBe('es');
  });

  it('resolves BCP-47 tags the frontend language picker writes', () => {
    expect(normalizeLocale('fr-FR')).toBe('fr');
    expect(normalizeLocale('pt-PT')).toBe('pt');
    expect(normalizeLocale('ru-RU')).toBe('ru');
    expect(normalizeLocale('pl-PL')).toBe('pl');
  });

  it('distinguishes "unknown" from "German" (strict resolver)', () => {
    // normalizeLocale collapses both to 'de'. Callers deciding whether to
    // constrain an LLM at all need to tell them apart.
    expect(resolveLocaleStrict('de')).toBe('de');
    expect(resolveLocaleStrict('klingon')).toBeNull();
    expect(resolveLocaleStrict(null)).toBeNull();
    expect(normalizeLocale('klingon')).toBe('de');
  });
});

describe('tt() fallback chain', () => {
  it('returns the locale value when present', () => {
    expect(tt('notif.diary_reminder.title', 'pl')).toBe(pl['notif.diary_reminder.title']);
    expect(tt('notif.diary_reminder.title', 'ru')).toBe(ru['notif.diary_reminder.title']);
  });

  it('substitutes placeholders', () => {
    const out = tt('notif.daily_learning.body', 'fr', { count: 3 });
    expect(out).toContain('3');
    expect(out).not.toContain('{count}');
  });

  it('leaves unknown placeholders untouched rather than printing undefined', () => {
    const out = tt('notif.daily_learning.body', 'fr', {});
    expect(out).toContain('{count}');
    expect(out).not.toContain('undefined');
  });

  it('falls back to an unknown locale via German, not a raw key', () => {
    expect(tt('notif.diary_reminder.title', 'klingon')).toBe(de['notif.diary_reminder.title']);
  });
});
