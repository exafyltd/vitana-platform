/**
 * VTID-04336 — the specialist (Devon) voice table for the cascade.
 */

import {
  resolvePollyVoice,
  resolvePollySpecialistVoice,
  listPollySpecialistVoices,
} from '../../src/services/tts/polly';

describe('VTID-04336 resolvePollySpecialistVoice', () => {
  it.each([
    ['en', 'Matthew'],
    ['de', 'Daniel'],
    ['fr', 'Remi'],
    ['es', 'Sergio'],
    ['ar', 'Zayd'],
    ['ru', 'Maxim'],
    ['pt', 'Thiago'],
    ['pl', 'Jacek'],
  ])('%s → %s, a different voice in the SAME language code as the receptionist', (lang, voiceId) => {
    const specialist = resolvePollySpecialistVoice(lang);
    const receptionist = resolvePollyVoice(lang);
    expect(specialist?.voiceId).toBe(voiceId);
    expect(specialist?.voiceId).not.toBe(receptionist?.voiceId);
    expect(specialist?.languageCode).toBe(receptionist?.languageCode);
  });

  it.each(['zh', 'tr'])('%s has no male Polly voice → null (keeps the receptionist voice, never another language)', (lang) => {
    expect(resolvePollySpecialistVoice(lang)).toBeNull();
  });

  it('sr → null (Polly has no Serbian voice at all)', () => {
    expect(resolvePollySpecialistVoice('sr')).toBeNull();
    expect(resolvePollySpecialistVoice('sr-RS')).toBeNull();
  });

  it('every specialist language also has a receptionist voice', () => {
    for (const lang of Object.keys(listPollySpecialistVoices())) {
      expect(resolvePollyVoice(lang)).not.toBeNull();
    }
  });
});
