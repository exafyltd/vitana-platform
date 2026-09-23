/**
 * VTID-04336 — backend-local specialist voice selection (§2c-fish-scope):
 * Polly picks its specialist voice, Fish keeps its single curated voice, and
 * `synthesizeCascadeReply()`'s Polly-first/Fish-fallback ORDER is unchanged.
 * Pinned for `ru` (Polly) and `sr` (Fish).
 */

jest.mock('../../../../../src/services/tts/polly', () => ({
  synthesizePolly: jest.fn(),
  resolvePollyVoice: jest.fn(),
  resolvePollySpecialistVoice: jest.fn(),
}));
jest.mock('../../../../../src/services/tts/fish', () => ({
  synthesizeFish: jest.fn(),
  resolveFishVoice: jest.fn(),
}));

import {
  pollyBackend,
  fishBackend,
  synthesizeCascadeReply,
  describeCascadeVoice,
} from '../../../../../src/orb/live/upstream/cascaded/tts-backend';
import {
  synthesizePolly,
  resolvePollyVoice,
  resolvePollySpecialistVoice,
} from '../../../../../src/services/tts/polly';
import { synthesizeFish, resolveFishVoice } from '../../../../../src/services/tts/fish';

const polly = synthesizePolly as jest.Mock;
const fish = synthesizeFish as jest.Mock;
const rPolly = resolvePollyVoice as jest.Mock;
const rSpec = resolvePollySpecialistVoice as jest.Mock;
const rFish = resolveFishVoice as jest.Mock;

beforeEach(() => {
  [polly, fish, rPolly, rSpec, rFish].forEach((m) => m.mockReset());
});

describe('ru (Polly-backed)', () => {
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

describe('sr (Fish-only)', () => {
  beforeEach(() => {
    rPolly.mockReturnValue(null);
    rSpec.mockReturnValue(null);
    rFish.mockReturnValue({ referenceId: '2ad62aaf885e4a14add09fe4a38ffd23', label: 'Milica (Fish Official)' });
    polly.mockResolvedValue(null);
    fish.mockResolvedValue({ audioB64: 'BBBB' });
  });

  it('fishBackend ignores the voice role — the curated voice, same request', async () => {
    await fishBackend.synthesize('zdravo', 'sr', { voiceRole: 'specialist' });
    expect(fish).toHaveBeenCalledWith({ text: 'zdravo', lang: 'sr', format: 'pcm' });
  });

  it('synthesizeCascadeReply keeps Polly-first/Fish-fallback for the specialist', async () => {
    const r = await synthesizeCascadeReply('zdravo', 'sr', { voiceRole: 'specialist' });
    expect(r).toEqual({ audioB64: 'BBBB', backend: 'fish' });
    expect(polly).toHaveBeenCalledWith({ text: 'zdravo', lang: 'sr', format: 'pcm' });
  });

  it('describeCascadeVoice: curated Fish voice, not distinct', () => {
    expect(describeCascadeVoice('sr', 'specialist')).toEqual({ backend: 'fish', voice: 'Milica (Fish Official)', distinct: false });
  });
});
