/**
 * BOOTSTRAP-GUIDED-JOURNEY-POPUP — Guided Journey curriculum translation overlay.
 * Verifies applyTranslations overlays per-locale fields and falls back to the
 * German source for any missing field/topic.
 */

import { applyTranslations } from '../src/services/guided-journey/checklist-service';
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
