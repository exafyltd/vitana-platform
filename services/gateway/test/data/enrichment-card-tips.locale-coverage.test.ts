/**
 * VTID-05143 (builds VTID-05085 Phase 1) — same guard as
 * feature-tips.locale-coverage.test.ts, for the Unified Card System's
 * enrichment (E1–E11) and boost (G1–G4) card texts: every registered gateway
 * locale present, genuinely translated (not an English copy), German in
 * du-form.
 */
import {
  ENRICHMENT_CARD_TIPS,
  ENRICHMENT_TIP_CARD_TYPES,
  enrichmentCardText,
} from '../../src/data/enrichment-card-tips';
import { ENRICHMENT_CARD_TYPES } from '../../src/services/enrichment/card-catalog';
import { GATEWAY_LOCALES } from '../../src/i18n/catalog';

describe('ENRICHMENT_CARD_TIPS locale coverage', () => {
  it('covers all 15 cards: E1–E11 and G1–G4', () => {
    expect(Object.keys(ENRICHMENT_CARD_TIPS).sort()).toEqual([...ENRICHMENT_TIP_CARD_TYPES].sort());
    expect(ENRICHMENT_TIP_CARD_TYPES).toHaveLength(15);
    for (const t of ENRICHMENT_CARD_TYPES) expect(ENRICHMENT_CARD_TIPS[t]).toBeDefined();
  });

  it('every card has a non-empty title and description for every registered gateway locale', () => {
    const missing: string[] = [];
    for (const [key, tip] of Object.entries(ENRICHMENT_CARD_TIPS)) {
      for (const locale of GATEWAY_LOCALES) {
        if (!tip.title[locale]?.trim()) missing.push(`${key}.title.${locale}`);
        if (!tip.description[locale]?.trim()) missing.push(`${key}.description.${locale}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every non-English title and description is genuinely translated, not a copy of English', () => {
    const copies: string[] = [];
    for (const [key, tip] of Object.entries(ENRICHMENT_CARD_TIPS)) {
      for (const locale of GATEWAY_LOCALES) {
        if (locale === 'en') continue;
        if (tip.title[locale] === tip.title.en) copies.push(`${key}.title.${locale}`);
        if (tip.description[locale] === tip.description.en) copies.push(`${key}.description.${locale}`);
      }
    }
    expect(copies).toEqual([]);
  });

  it('German is du-form (no Sie/Ihr/Ihnen)', () => {
    const formal: string[] = [];
    for (const [key, tip] of Object.entries(ENRICHMENT_CARD_TIPS)) {
      for (const text of [tip.title.de, tip.description.de]) {
        if (/\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihnen)\b/.test(text)) formal.push(`${key}: ${text}`);
      }
    }
    expect(formal).toEqual([]);
  });

  it('enrichmentCardText returns the requested locale', () => {
    expect(enrichmentCardText('E1', 'de').title).toBe('Lade ein Profilfoto hoch');
    expect(enrichmentCardText('E1', 'ar').title).toBe(ENRICHMENT_CARD_TIPS.E1.title.ar);
  });
});
