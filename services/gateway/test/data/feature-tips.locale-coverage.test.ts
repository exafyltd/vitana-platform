/**
 * VTID-03801 — codex review finding on PR #3250.
 *
 * `FEATURE_TIPS`'s title/description type is `{ en, de } & Partial<Record<
 * OtherLocale, string>>` — Partial, so `tsc` does NOT fail loudly when a
 * locale added to GatewayLocale has no entry here, unlike the exhaustive
 * `Record<GatewayLocale,...>` maps in catalog.ts/llm-locale.ts/
 * feedback-settings-tools.ts. Turkish's registration (this VTID) was
 * initially missing from every one of the 12 tips, which would have made
 * `POST /daily-feature-tip`'s `text[locale] ?? text.en` (scheduled-
 * notifications.ts) silently serve English feature names/bodies to every
 * Turkish user, every day, with no error anywhere.
 *
 * This test makes that class of gap loud instead of silent: it fails for
 * ANY registered gateway locale missing from ANY tip, not just tr.
 */
import { FEATURE_TIPS } from '../../src/data/feature-tips';
import { GATEWAY_LOCALES } from '../../src/i18n/catalog';

describe('FEATURE_TIPS locale coverage', () => {
  it('every tip has a title and description for every registered gateway locale', () => {
    const missing: string[] = [];
    for (const tip of FEATURE_TIPS) {
      for (const locale of GATEWAY_LOCALES) {
        if (!tip.title[locale]) missing.push(`${tip.key}.title.${locale}`);
        if (!tip.description[locale]) missing.push(`${tip.key}.description.${locale}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every non-English value is genuinely translated, not a copy of English', () => {
    const copies: string[] = [];
    for (const tip of FEATURE_TIPS) {
      for (const locale of GATEWAY_LOCALES) {
        if (locale === 'en') continue;
        if (tip.description[locale] === tip.description.en) {
          copies.push(`${tip.key}.description.${locale}`);
        }
      }
    }
    expect(copies).toEqual([]);
  });
});
