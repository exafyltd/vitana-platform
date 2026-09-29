/** VTID-04742: the du rule reaches the guide-mode blocks too. */

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

describe('VTID-04742: guided-topic and journey-guide instructions carry the register rule', () => {
  it('German guided-topic lesson block says du, not Sie', () => {
    const block = buildGuidedTopicNarrationBlock(TOPIC_CONTENT, 'de');
    expect(block).toMatch(/SPRACHE: [^\n]*\nREGISTER: Use du-form/);
    expect(block).toContain('NOT Sie-form');
  });

  it('German journey-guide block says du, not Sie', () => {
    const block = buildJourneyGuideBlock(GUIDE_CONTENT, 'de');
    expect(block).toContain('REGISTER: Use du-form');
  });

  it('Serbian guided-topic block carries the ti-form', () => {
    expect(buildGuidedTopicNarrationBlock(TOPIC_CONTENT, 'sr')).toContain('ti-form');
  });

  it('English blocks carry no REGISTER line', () => {
    expect(buildGuidedTopicNarrationBlock(TOPIC_CONTENT, 'en')).not.toContain('REGISTER:');
    expect(buildJourneyGuideBlock(GUIDE_CONTENT, 'en')).not.toContain('REGISTER:');
  });
});
