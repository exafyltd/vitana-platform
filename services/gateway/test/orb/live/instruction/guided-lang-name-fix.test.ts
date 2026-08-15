/**
 * VTID-03644 — regression test for the 9-language rollout locale gap.
 *
 * `buildGuidedTopicNarrationBlock` and `buildJourneyGuideBlock` each carried
 * their own local `langName` ternary (es/sr/fr/else-English), independently
 * of the shared `LOCALE_ENGLISH_NAME` registry `catalog.ts` centralized under
 * VTID-03509 for exactly this reason. Any locale outside that 4-way ternary —
 * pt, ru, pl (already GA/beta) and every locale in the 9-language activation —
 * was silently told "Speak ONLY in English" for the whole guided-topic /
 * journey-guide session (turns 2+). This locks in that pt/ru/pl/ar/zh now
 * resolve to their own language instead of falling back to English.
 */

import { buildGuidedTopicNarrationBlock } from '../../../../src/orb/live/instruction/guided-topic-narration-prompt';
import type { GuidedTopicNarrationContent } from '../../../../src/services/assistant-continuation/providers/guided-topic-narration';
import { buildJourneyGuideBlock } from '../../../../src/orb/live/instruction/journey-guide-prompt';
import type { JourneyGuideContent } from '../../../../src/services/assistant-continuation/providers/journey-guide';

const TOPIC_CONTENT: GuidedTopicNarrationContent = {
  topic_id: 'T001',
  topic_title: 'Vitanaland',
  voice_script: 'Vitanaland ist deine Langlebigkeits-Community.',
  explanation: { whatItIs: null, userBenefit: null, whenToUse: null, tryThis: null },
  practice_target: 'community',
  source: 'published',
};

const GUIDE_CONTENT: JourneyGuideContent = {
  step_key: 'life_compass',
  step_title: 'Lebenskompass',
  execute_prompt: 'Setz deinen Lebenskompass.',
  benefit: 'Gibt dir Richtung.',
  step_type: 'action',
  navigation_route: null,
  opener_key: 'life_compass',
  upcoming_steps: [],
};

describe('VTID-03644: guided-topic-narration language-name fix', () => {
  it.each([
    ['pt', 'Portuguese'],
    ['ru', 'Russian'],
    ['pl', 'Polish'],
    ['ar', 'Arabic'],
    ['zh', 'Chinese'],
    ['es', 'Spanish'],
    ['sr', 'Serbian'],
    ['fr', 'French'],
  ])('lang=%s resolves to %s, not the English fallback', (lang, expectedName) => {
    const block = buildGuidedTopicNarrationBlock(TOPIC_CONTENT, lang);
    expect(block).toContain(`Speak ONLY in ${expectedName}`);
    expect(block).not.toContain('Speak ONLY in English');
  });

  it('unrecognized lang still falls back to English (unchanged behavior)', () => {
    const block = buildGuidedTopicNarrationBlock(TOPIC_CONTENT, 'xx-not-a-locale');
    expect(block).toContain('Speak ONLY in English');
  });
});

describe('VTID-03644: journey-guide language-name fix', () => {
  it.each([
    ['pt', 'Portuguese'],
    ['ru', 'Russian'],
    ['pl', 'Polish'],
    ['ar', 'Arabic'],
    ['zh', 'Chinese'],
  ])('lang=%s resolves to %s, not the English fallback', (lang, expectedName) => {
    const block = buildJourneyGuideBlock(GUIDE_CONTENT, lang);
    expect(block).toContain(`Speak ONLY in ${expectedName}`);
    expect(block).not.toContain('Speak ONLY in English');
  });
});
