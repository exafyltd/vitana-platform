/**
 * VTID-04873 — every language reads its own narration, never the German one.
 *
 * Before this fix `applyTranslationToSeed` overlaid the label and the four
 * explanation fields but never `vitana_voice_script`, and the narration
 * builder prefers the script — so every non-German Audiobook episode and
 * guided-topic narration sent the German script to that language's voice
 * ("English TTS talks German"). These tests pin, for every one of the ten
 * translation targets, that German text can never come back as narration for
 * another language, and that the seeder now translates the script.
 */
import { applyTranslationToSeed } from '../src/services/guided-journey/checklist-service';
import { buildGuidedTopicSpokenText } from '../src/services/tts/guided-topic-narration-audio';
import { GATEWAY_LOCALES } from '../src/i18n/catalog';
import { getSurface } from '../src/services/db-i18n/surfaces';
import type { OrbTopicSeed } from '../src/types/journey-checklist';

const DE_SCRIPT = 'Hallo, ich bin Vitana. Heute zeige ich dir dein Hörbuch.';

function germanSeed(): OrbTopicSeed {
  return {
    topicId: 'T251',
    displayLabel: 'Starte deine Reise',
    vitanaVoiceScript: DE_SCRIPT,
    explanation: {
      whatItIs: 'Was es ist.',
      userBenefit: 'Dein Nutzen.',
      whenToUse: 'Wann es hilft.',
      tryThis: 'Probier das.',
    },
    guidedPracticeTarget: null,
    source: 'published',
    narrationLocale: 'de',
  };
}

function row(locale: string, over: Record<string, string | null> = {}) {
  return {
    topic_id: 'T251',
    display_label: `Label ${locale}`,
    short_description: null,
    explanation_what_it_is: `What (${locale})`,
    explanation_user_benefit: `Benefit (${locale})`,
    explanation_when_to_use: `When (${locale})`,
    explanation_try_this: `Try (${locale})`,
    vitana_voice_script: `Narration in ${locale}.`,
    ...over,
  };
}

const TARGETS = (GATEWAY_LOCALES as readonly string[]).filter((l) => l !== 'de');

describe('narration language (VTID-04873)', () => {
  it('covers all ten translation targets of the eleven languages', () => {
    expect(GATEWAY_LOCALES).toHaveLength(11);
    expect(TARGETS).toHaveLength(10);
  });

  it.each(TARGETS)('%s: reads its translated script', (lang) => {
    const seed = applyTranslationToSeed(germanSeed(), [row(lang)], lang as never);
    expect(seed.narrationLocale).toBe(lang);
    expect(buildGuidedTopicSpokenText({
      topic_id: seed.topicId, topic_title: seed.displayLabel, voice_script: seed.vitanaVoiceScript,
      explanation: seed.explanation, practice_target: null, source: seed.source, narrationAudio: null,
    })).toBe(`Narration in ${lang}.`);
  });

  it.each(TARGETS)('%s: never receives the German script, even with no translation row', (lang) => {
    const seed = applyTranslationToSeed(germanSeed(), [], lang as never);
    expect(seed.vitanaVoiceScript).toBeNull();
    expect(seed.narrationLocale).toBe('de');
  });

  it('without a translated script, narrates the fully translated explanation', () => {
    const seed = applyTranslationToSeed(germanSeed(), [row('en', { vitana_voice_script: null })], 'en');
    expect(seed.narrationLocale).toBe('en');
    expect(seed.vitanaVoiceScript).toBeNull();
    const text = buildGuidedTopicSpokenText({
      topic_id: seed.topicId, topic_title: seed.displayLabel, voice_script: seed.vitanaVoiceScript,
      explanation: seed.explanation, practice_target: null, source: seed.source, narrationAudio: null,
    });
    expect(text).toBe('What (en) Benefit (en) When (en) Try (en)');
    expect(text).not.toMatch(/Hörbuch|Nutzen|Probier/);
  });

  it('a partly translated explanation is not narration in that language', () => {
    const seed = applyTranslationToSeed(
      germanSeed(),
      [row('fr', { vitana_voice_script: null, explanation_try_this: null })],
      'fr',
    );
    expect(seed.narrationLocale).toBe('de');
  });

  it('a whitespace-only script counts as missing', () => {
    const seed = applyTranslationToSeed(germanSeed(), [row('pl', { vitana_voice_script: '   ' })], 'pl');
    expect(seed.vitanaVoiceScript).toBeNull();
    expect(seed.narrationLocale).toBe('pl'); // the explanation is complete
  });
});

describe('the seeder translates the narration script (VTID-04873)', () => {
  const surface = getSurface('journey-checklist');

  it('lists vitana_voice_script as a translated field', () => {
    expect(surface.fields).toContain('vitana_voice_script');
  });

  it('writes the translated script into the row', () => {
    const r = surface.buildRow({
      unit: { key: 'T251', fields: {}, meta: { source_version_id: 'v-1' } },
      locale: 'tr',
      translated: { display_label: 'Yolculuğuna başla', vitana_voice_script: 'Merhaba.' },
      sha: 'abc',
    }) as Record<string, unknown>;
    expect(r.vitana_voice_script).toBe('Merhaba.');
  });

  it('uses small batches so ~2,000-character scripts fit one reply', () => {
    expect(surface.batchSize).toBeLessThanOrEqual(5);
  });
});
