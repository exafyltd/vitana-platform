/**
 * VTID-03650 — guided-topic prompt builders after the Polly narration switch.
 *
 * `buildGuidedTopicPostNarrationLine` is the short, safe turn-1 line used
 * when the lesson was already delivered as pre-recorded Polly audio, and
 * `buildGuidedTopicNarrationBlock` must switch to its short post-narration
 * variant (no raw curriculum text) whenever `content.narrationAudio` is set —
 * that raw text is exactly the payload VTID-03647/03648 measured Nova and
 * Vertex both independently rejecting, so it must never re-enter the prompt
 * once the audio bridge has already spoken it.
 */

import {
  buildGuidedTopicPostNarrationLine,
  buildGuidedTopicNarrationBlock,
} from '../../../../src/orb/live/instruction/guided-topic-narration-prompt';
import type { GuidedTopicNarrationContent } from '../../../../src/services/assistant-continuation/providers/guided-topic-narration';

const BASE_CONTENT: GuidedTopicNarrationContent = {
  topic_id: 'T001',
  topic_title: 'Vitanaland',
  voice_script: 'Vitanaland ist deine Langlebigkeits-Community und hilft dir dabei, gesünder zu leben.',
  explanation: { whatItIs: 'Eine Community', userBenefit: 'Du lernst', whenToUse: 'Täglich', tryThis: 'Schau rein' },
  practice_target: 'community',
  source: 'published',
};

describe('buildGuidedTopicPostNarrationLine', () => {
  it('mentions the topic and offers questions + practice in German', () => {
    const line = buildGuidedTopicPostNarrationLine('Vitanaland', 'de', { hasPracticeTarget: true });
    expect(line).toContain('Vitanaland');
    expect(line.toLowerCase()).toMatch(/frage/);
  });

  it('mentions the topic and offers questions + practice in English', () => {
    const line = buildGuidedTopicPostNarrationLine('Vitanaland', 'en', { hasPracticeTarget: true });
    expect(line).toContain('Vitanaland');
    expect(line.toLowerCase()).toMatch(/question/);
  });

  it('drops the practice offer when there is no practice target', () => {
    const withTarget = buildGuidedTopicPostNarrationLine('Vitanaland', 'en', { hasPracticeTarget: true });
    const withoutTarget = buildGuidedTopicPostNarrationLine('Vitanaland', 'en', { hasPracticeTarget: false });
    expect(withoutTarget.length).toBeLessThan(withTarget.length);
    expect(withoutTarget.toLowerCase()).not.toMatch(/practic/);
  });

  it('is short — a native-audio-safe direct turn, not an instructional paragraph', () => {
    const line = buildGuidedTopicPostNarrationLine('Vitanaland', 'de', { hasPracticeTarget: true });
    expect(line.length).toBeLessThan(200);
  });
});

describe('buildGuidedTopicNarrationBlock — post-narration branch (content.narrationAudio set)', () => {
  const narratedContent: GuidedTopicNarrationContent = {
    ...BASE_CONTENT,
    narrationAudio: { audioB64: 'YQ==', sampleRateHz: 16000 },
  };

  it('never includes the raw voice_script text once the audio bridge already spoke it', () => {
    const block = buildGuidedTopicNarrationBlock(narratedContent, 'de');
    expect(block).not.toContain(narratedContent.voice_script);
  });

  it('never includes the raw explanation fields either', () => {
    const block = buildGuidedTopicNarrationBlock(narratedContent, 'de');
    expect(block).not.toContain('Eine Community');
    expect(block).not.toContain('Du lernst');
  });

  it('still names the topic and practice target so follow-up guidance works', () => {
    const block = buildGuidedTopicNarrationBlock(narratedContent, 'de');
    expect(block).toContain('Vitanaland');
    expect(block).toContain('community');
  });

  it('tells the model NOT to re-narrate the lesson', () => {
    const de = buildGuidedTopicNarrationBlock(narratedContent, 'de');
    expect(de.toLowerCase()).toMatch(/nicht (selbst )?vorgetragen|nicht wiederholen/);
    const en = buildGuidedTopicNarrationBlock(narratedContent, 'en');
    expect(en.toLowerCase()).toMatch(/did not narrate|not repeat|already narrated/);
  });

  it('respects the requested language independent of the German-authored content', () => {
    const block = buildGuidedTopicNarrationBlock(narratedContent, 'en');
    expect(block).toContain('Speak ONLY in English');
  });

  it('VTID-03686/03686-followup: instructs checking for follow-up questions before moving on from a brief "yes"', () => {
    const de = buildGuidedTopicNarrationBlock(narratedContent, 'de');
    expect(de.toLowerCase()).toMatch(/ja.*mach das.*okay.*rückfragen|rückfragen.*bevor/);
    const en = buildGuidedTopicNarrationBlock(narratedContent, 'en');
    expect(en.toLowerCase()).toMatch(/yes.*sure.*okay.*follow-up|follow-up questions before/);
  });

  // VTID-03762: the GUIDE MODE block previously had no exit condition at
  // all — it is re-injected for the WHOLE session with no turn-count limit,
  // so once the model finished (or, in this post-narration branch, once it
  // finished fielding follow-ups) it free-wheeled into ordinary conversation
  // forever. The overlay never closed, so the "Well done" drawer (already
  // mounted underneath it since tap time) never became visible and the
  // topic was never reachable to mark done. Fixed with a model-callable
  // tool mirroring Teacher Mode's proven end_teaching_session pattern.
  it('VTID-03762: instructs calling end_guided_topic_teaching once follow-ups are answered', () => {
    const de = buildGuidedTopicNarrationBlock(narratedContent, 'de');
    expect(de).toContain('end_guided_topic_teaching');
    const en = buildGuidedTopicNarrationBlock(narratedContent, 'en');
    expect(en).toContain('end_guided_topic_teaching');
    expect(en.toLowerCase()).toMatch(/do not just keep talking|general conversation/);
  });
});

describe('buildGuidedTopicNarrationBlock — legacy model-narrated branch (no narrationAudio)', () => {
  it('still includes the paraphrase-material block unchanged when Polly did not deliver audio', () => {
    const block = buildGuidedTopicNarrationBlock(BASE_CONTENT, 'de');
    expect(block).toContain(BASE_CONTENT.voice_script);
    expect(block).toMatch(/nicht vorlesen|NICHT vorlesen/);
  });

  it('behaves identically whether narrationAudio is undefined or explicitly null', () => {
    const withUndefined = buildGuidedTopicNarrationBlock(BASE_CONTENT, 'de');
    const withNull: GuidedTopicNarrationContent = { ...BASE_CONTENT, narrationAudio: null };
    expect(buildGuidedTopicNarrationBlock(withNull, 'de')).toBe(withUndefined);
  });

  it('VTID-03686/03686-followup: instructs explaining core points before moving to practice on a brief "yes"', () => {
    const de = buildGuidedTopicNarrationBlock(BASE_CONTENT, 'de');
    expect(de.toLowerCase()).toMatch(/ja.*mach das.*okay.*erklär mir das jetzt/);
    const en = buildGuidedTopicNarrationBlock(BASE_CONTENT, 'en');
    expect(en.toLowerCase()).toMatch(/yes.*sure.*okay.*explain it to me now/);
  });

  // VTID-03762: this is the FULL teach branch (turn-1's raw material, no
  // Polly pre-narration) — the same missing-exit-condition problem applies
  // here too, and it's the branch the live incident (topic T007, taught for
  // real 44s then the session never ended) actually went through.
  it('VTID-03762: instructs calling end_guided_topic_teaching once the topic is taught and next step proposed', () => {
    const de = buildGuidedTopicNarrationBlock(BASE_CONTENT, 'de');
    expect(de).toContain('end_guided_topic_teaching');
    const en = buildGuidedTopicNarrationBlock(BASE_CONTENT, 'en');
    expect(en).toContain('end_guided_topic_teaching');
    expect(en.toLowerCase()).toMatch(/do not just keep talking|general conversation/);
    // Must come AFTER the practice/next-step guidance, not before — the
    // model should teach the material and propose next steps FIRST.
    // BASE_CONTENT has a practice_target set, so the "GUIDE them to the
    // practice" line is the one that must precede it.
    expect(en.indexOf('GUIDE them to the practice')).toBeLessThan(en.indexOf('end_guided_topic_teaching'));
  });
});
