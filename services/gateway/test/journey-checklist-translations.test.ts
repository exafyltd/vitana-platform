/**
 * BOOTSTRAP-GUIDED-JOURNEY-POPUP — Guided Journey curriculum translation overlay.
 * Verifies applyTranslations overlays per-locale fields and falls back to the
 * German source for any missing field/topic.
 */

import { applyTranslations, type ChecklistLocale } from '../src/services/guided-journey/checklist-service';
import { GATEWAY_LOCALES } from '../src/i18n/catalog';
import type { PublicChecklistTopic } from '../src/types/journey-checklist';

function deTopic(id: string): PublicChecklistTopic {
  return {
    topicId: id,
    session: 1,
    position: 1,
    chapterId: 'basics',
    displayLabel: 'Sektor-Fit',
    shortDescription: 'Kurzbeschreibung',
    explanation: {
      whatItIs: 'Was es ist (DE)',
      userBenefit: 'Dein Nutzen (DE)',
      whenToUse: 'Wann es hilft (DE)',
      tryThis: 'Probier das (DE)',
    },
    guidedPracticeTarget: null,
    businessGate: null,
  };
}

describe('applyTranslations', () => {
  it('overlays a fully-translated topic', () => {
    const out = applyTranslations(
      [deTopic('T001')],
      [
        {
          topic_id: 'T001',
          display_label: 'Sector Fit',
          short_description: 'Short description',
          explanation_what_it_is: 'What it is (EN)',
          explanation_user_benefit: 'Your benefit (EN)',
          explanation_when_to_use: 'When it helps (EN)',
          explanation_try_this: 'Try this (EN)',
        },
      ],
    );
    expect(out[0].displayLabel).toBe('Sector Fit');
    expect(out[0].explanation.whatItIs).toBe('What it is (EN)');
    expect(out[0].explanation.tryThis).toBe('Try this (EN)');
  });

  it('falls back to German for missing fields', () => {
    const out = applyTranslations(
      [deTopic('T001')],
      [
        {
          topic_id: 'T001',
          display_label: 'Sector Fit',
          short_description: null,
          explanation_what_it_is: 'What it is (EN)',
          explanation_user_benefit: null, // missing → keep German
          explanation_when_to_use: '', // empty → keep German
          explanation_try_this: 'Try this (EN)',
        },
      ],
    );
    expect(out[0].displayLabel).toBe('Sector Fit');
    expect(out[0].explanation.whatItIs).toBe('What it is (EN)');
    expect(out[0].explanation.userBenefit).toBe('Dein Nutzen (DE)');
    expect(out[0].explanation.whenToUse).toBe('Wann es hilft (DE)');
  });

  it('leaves untranslated topics untouched and is a no-op with no rows', () => {
    const topics = [deTopic('T001'), deTopic('T002')];
    const out = applyTranslations(topics, [
      {
        topic_id: 'T001',
        display_label: 'Sector Fit',
        short_description: null,
        explanation_what_it_is: null,
        explanation_user_benefit: null,
        explanation_when_to_use: null,
        explanation_try_this: null,
      },
    ]);
    expect(out[0].displayLabel).toBe('Sector Fit');
    expect(out[1].displayLabel).toBe('Sektor-Fit'); // untouched

    expect(applyTranslations(topics, [])).toEqual(topics); // no-op
  });
});

// ---------------------------------------------------------------------------
// VTID-03509 — curriculum locale surface for the 18 Aug 8-language release.
//
// ChecklistLocale was its own hardcoded 'de'|'en'|'es'|'sr' union, and
// routes/journey-checklist.ts re-listed the same four codes in SUPPORTED_LOCALES.
// `?locale=fr` was therefore REJECTED and silently downgraded to the caller's
// stored profile locale — a French user asking for French got German with no
// indication the request had been ignored.
//
// Both now derive from GatewayLocale / GATEWAY_LOCALES. The flow behaviour these
// tests pin is: the curriculum is SERVED in any release locale, and a locale with
// no translation rows yet degrades to the authored German source rather than
// erroring or being refused.
// ---------------------------------------------------------------------------
describe('curriculum locale surface (VTID-03509)', () => {
  const RELEASE_LOCALES = ['de', 'en', 'es', 'sr', 'fr', 'pt', 'ru', 'pl', 'zh'] as const;

  it('accepts every release locale as a ChecklistLocale', () => {
    // Compile-time assertion: if ChecklistLocale ever narrows again, this fails
    // to typecheck rather than silently rejecting locales at runtime.
    const locales: ChecklistLocale[] = [...RELEASE_LOCALES];
    expect(locales).toHaveLength(9);
    expect(GATEWAY_LOCALES).toEqual(expect.arrayContaining([...RELEASE_LOCALES]));
  });

  it('exposes exactly the release locale set — no more, no less', () => {
    // Guards both directions: a locale added to the gateway without a curriculum
    // decision, and a release locale quietly dropped.
    // VTID-03569 added zh. This assertion asks for a CURRICULUM DECISION when a
    // locale reaches the gateway, and the decision is: serve it. zh behaves
    // exactly like fr/pt/ru/pl did on arrival — zero rows in
    // journey_checklist_translations, so the curriculum degrades to the authored
    // German source rather than erroring or refusing the request. Serving German
    // to a zh reader is the honest failure; refusing the request is not.
    expect([...GATEWAY_LOCALES].sort()).toEqual(
      ['de', 'en', 'es', 'fr', 'pl', 'pt', 'ru', 'sr', 'zh'],
    );
  });

  it('serves the German source verbatim for a locale with no translation rows', () => {
    // fr/pt/ru/pl have zero rows in journey_checklist_translations today. The
    // curriculum must still render — degraded to German, never empty or broken.
    const topics = [deTopic('T001'), deTopic('T002')];
    for (const _locale of ['fr', 'pt', 'ru', 'pl'] as const) {
      const out = applyTranslations(topics, []);
      expect(out).toEqual(topics);
      expect(out[0].displayLabel).toBe('Sektor-Fit');
      expect(out[0].explanation.whatItIs).toBe('Was es ist (DE)');
    }
  });

  it('overlays a partially-translated locale without losing the German remainder', () => {
    // Serbian is the live example: 94 of 254 topics translated. A topic inside
    // the translated set must show Serbian; one outside it must stay German,
    // rather than the whole locale falling back or rendering blank.
    const out = applyTranslations([deTopic('T001'), deTopic('T002')], [
      {
        topic_id: 'T001',
        display_label: 'Sektorska usklađenost',
        short_description: 'Kratak opis',
        explanation_what_it_is: 'Šta je to (SR)',
        explanation_user_benefit: null,
        explanation_when_to_use: null,
        explanation_try_this: null,
      },
    ]);
    expect(out[0].displayLabel).toBe('Sektorska usklađenost');
    expect(out[0].explanation.whatItIs).toBe('Šta je to (SR)');
    expect(out[0].explanation.userBenefit).toBe('Dein Nutzen (DE)'); // gap → German
    expect(out[1].displayLabel).toBe('Sektor-Fit'); // untranslated topic → German
  });
});
