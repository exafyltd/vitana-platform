/**
 * VTID-04336 / VTID-04445 — specialist (Devon) voice selection on the cascade.
 *
 * VTID-04445 owner rule: every Devon voice is a man's voice. So:
 *   - Polly-backed language with a male voice (ru): Devon gets it, with one
 *     retry — and NEVER Vitana's female voice when it fails.
 *   - Language without a male Polly voice (tr, zh) or without Polly at all
 *     (sr): Devon gets the male Fish voice; Vitana's voices are untouched.
 *   - Vitana's (receptionist) requests are byte-for-byte what they were.
 */

jest.mock('../../../../../src/services/tts/polly', () => ({
  synthesizePolly: jest.fn(),
  resolvePollyVoice: jest.fn(),
  resolvePollySpecialistVoice: jest.fn(),
}));
jest.mock('../../../../../src/services/tts/fish', () => ({
  synthesizeFish: jest.fn(),
  resolveFishVoice: jest.fn(),
  isFishConfigured: jest.fn(),
}));

import {
  pollyBackend,
  fishBackend,
  synthesizeCascadeReply,
  describeCascadeVoice,
  resolveCascadeSpecialistVoice,
} from '../../../../../src/orb/live/upstream/cascaded/tts-backend';
import {
  synthesizePolly,
  resolvePollyVoice,
  resolvePollySpecialistVoice,
} from '../../../../../src/services/tts/polly';
import { synthesizeFish, resolveFishVoice, isFishConfigured } from '../../../../../src/services/tts/fish';

const polly = synthesizePolly as jest.Mock;
const fish = synthesizeFish as jest.Mock;
const rPolly = resolvePollyVoice as jest.Mock;
const rSpec = resolvePollySpecialistVoice as jest.Mock;
const rFish = resolveFishVoice as jest.Mock;
const fishOn = isFishConfigured as jest.Mock;

const MILICA = { referenceId: '2ad62aaf885e4a14add09fe4a38ffd23', label: 'Milica (Fish Official)' };
const NIKOLA = { referenceId: '076ad255234448a5b2adb3f8bd292acd', label: 'Nikola (Fish Official)' };
const KEREM = { referenceId: '778d117554c9470bb7c664a781fe13a5', label: 'Kerem (Fish Official)' };

beforeEach(() => {
  [polly, fish, rPolly, rSpec, rFish, fishOn].forEach((m) => m.mockReset());
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('ru (Polly-backed, male Polly voice exists)', () => {
  beforeEach(() => {
    rPolly.mockReturnValue({ voiceId: 'Tatyana', engine: 'standard', languageCode: 'ru-RU' });
    rSpec.mockReturnValue({ voiceId: 'Maxim', engine: 'standard', languageCode: 'ru-RU' });
  });

  it('specialist → one specialist Polly request', async () => {
    polly.mockResolvedValue({ audioB64: 'AAAA' });
    expect(await pollyBackend.synthesize('hi', 'ru', { voiceRole: 'specialist' })).toEqual({ audioB64: 'AAAA' });
    expect(polly).toHaveBeenCalledTimes(1);
    expect(polly).toHaveBeenCalledWith({ text: 'hi', lang: 'ru', format: 'pcm', voiceRole: 'specialist' });
  });

  it('a failed specialist synthesis retries the MALE voice once and never uses the female voice', async () => {
    polly.mockResolvedValue(null);
    expect(await synthesizeCascadeReply('hi', 'ru', { voiceRole: 'specialist' })).toBeNull();
    expect(polly).toHaveBeenCalledTimes(2);
    for (const call of polly.mock.calls) expect(call[0].voiceRole).toBe('specialist');
    expect(fish).not.toHaveBeenCalled();
  });

  it('receptionist / no options → the exact pre-VTID-04336 request', async () => {
    polly.mockResolvedValue({ audioB64: 'AAAA' });
    await pollyBackend.synthesize('hi', 'ru');
    await pollyBackend.synthesize('hi', 'ru', { voiceRole: 'receptionist' });
    expect(polly.mock.calls).toEqual([
      [{ text: 'hi', lang: 'ru', format: 'pcm' }],
      [{ text: 'hi', lang: 'ru', format: 'pcm' }],
    ]);
  });

  it('describeCascadeVoice reports a distinct specialist voice', () => {
    expect(describeCascadeVoice('ru', 'specialist')).toEqual({ backend: 'polly', voice: 'Maxim', distinct: true });
    expect(describeCascadeVoice('ru', 'receptionist')).toEqual({ backend: 'polly', voice: 'Tatyana', distinct: false });
  });
});

describe('tr (Polly has only female voices)', () => {
  beforeEach(() => {
    rPolly.mockReturnValue({ voiceId: 'Burcu', engine: 'neural', languageCode: 'tr-TR' });
    rSpec.mockReturnValue(null);
    rFish.mockImplementation((_l: string, role?: string) => (role === 'specialist' ? KEREM : null));
  });

  it('Devon speaks with the male Fish voice, never Burcu', async () => {
    fish.mockResolvedValue({ audioB64: 'KKKK' });
    const r = await synthesizeCascadeReply('merhaba', 'tr', { voiceRole: 'specialist' });
    expect(r).toEqual({ audioB64: 'KKKK', backend: 'fish' });
    expect(polly).not.toHaveBeenCalled();
    expect(fish).toHaveBeenCalledWith({ text: 'merhaba', lang: 'tr', format: 'pcm', voiceRole: 'specialist' });
  });

  it('no Fish → no audio for Devon (the hand-off gate keeps Devon off this call)', async () => {
    fish.mockResolvedValue(null);
    expect(await synthesizeCascadeReply('merhaba', 'tr', { voiceRole: 'specialist' })).toBeNull();
    expect(polly).not.toHaveBeenCalled();
  });

  it('resolveCascadeSpecialistVoice: Fish male voice only when Fish is configured', () => {
    fishOn.mockReturnValue(false);
    expect(resolveCascadeSpecialistVoice('tr')).toBeNull();
    fishOn.mockReturnValue(true);
    expect(resolveCascadeSpecialistVoice('tr')).toEqual({ backend: 'fish', voice: 'Kerem (Fish Official)' });
  });

  it('Vitana keeps Burcu', async () => {
    polly.mockResolvedValue({ audioB64: 'VVVV' });
    expect(await synthesizeCascadeReply('merhaba', 'tr')).toEqual({ audioB64: 'VVVV', backend: 'polly' });
    expect(polly).toHaveBeenCalledWith({ text: 'merhaba', lang: 'tr', format: 'pcm' });
  });
});

describe('sr (Fish-only)', () => {
  beforeEach(() => {
    rPolly.mockReturnValue(null);
    rSpec.mockReturnValue(null);
    rFish.mockImplementation((_l: string, role?: string) => (role === 'specialist' ? NIKOLA : MILICA));
    polly.mockResolvedValue(null);
    fish.mockResolvedValue({ audioB64: 'BBBB' });
  });

  it('fishBackend passes the role: Devon → specialist voice, Vitana → receptionist voice', async () => {
    await fishBackend.synthesize('zdravo', 'sr', { voiceRole: 'specialist' });
    await fishBackend.synthesize('zdravo', 'sr');
    expect(fish.mock.calls).toEqual([
      [{ text: 'zdravo', lang: 'sr', format: 'pcm', voiceRole: 'specialist' }],
      [{ text: 'zdravo', lang: 'sr', format: 'pcm', voiceRole: 'receptionist' }],
    ]);
  });

  it('synthesizeCascadeReply: Devon gets the male Fish voice', async () => {
    const r = await synthesizeCascadeReply('zdravo', 'sr', { voiceRole: 'specialist' });
    expect(r).toEqual({ audioB64: 'BBBB', backend: 'fish' });
    expect(fish).toHaveBeenCalledWith({ text: 'zdravo', lang: 'sr', format: 'pcm', voiceRole: 'specialist' });
  });

  it('describeCascadeVoice: Nikola for Devon (distinct), Milica for Vitana', () => {
    fishOn.mockReturnValue(true);
    expect(describeCascadeVoice('sr', 'specialist')).toEqual({ backend: 'fish', voice: 'Nikola (Fish Official)', distinct: true });
    expect(describeCascadeVoice('sr', 'receptionist')).toEqual({ backend: 'fish', voice: 'Milica (Fish Official)', distinct: false });
  });
});
