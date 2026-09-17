/**
 * VTID-03987 — dedicated tests for the extracted TTS-backend boundary,
 * separate from `cascaded-live-client.ts`'s own suites so the selection
 * logic (Polly-first, Fish-fallback) is verified in isolation from
 * Transcribe/turn-gating concerns.
 */

jest.mock('../../../../../src/services/tts/polly', () => ({
  synthesizePolly: jest.fn(),
  resolvePollyVoice: jest.fn(),
}));

jest.mock('../../../../../src/services/tts/fish', () => ({
  synthesizeFish: jest.fn(),
}));

import {
  pollyBackend,
  fishBackend,
  synthesizeCascadeReply,
} from '../../../../../src/orb/live/upstream/cascaded/tts-backend';
import { synthesizePolly, resolvePollyVoice } from '../../../../../src/services/tts/polly';
import { synthesizeFish } from '../../../../../src/services/tts/fish';

const mockSynthesizePolly = synthesizePolly as jest.Mock;
const mockResolvePollyVoice = resolvePollyVoice as jest.Mock;
const mockSynthesizeFish = synthesizeFish as jest.Mock;

describe('VTID-03987: cascade TTS backend boundary', () => {
  beforeEach(() => {
    mockSynthesizePolly.mockReset();
    mockResolvePollyVoice.mockReset();
    mockSynthesizeFish.mockReset();
  });

  describe('pollyBackend / fishBackend — individually', () => {
    it('pollyBackend.synthesize returns audioB64 on a successful Polly call', async () => {
      mockSynthesizePolly.mockResolvedValueOnce({ audioB64: 'AAAA', sampleRateHz: 16000 });
      const result = await pollyBackend.synthesize('hi', 'ru');
      expect(result).toEqual({ audioB64: 'AAAA' });
      expect(mockSynthesizePolly).toHaveBeenCalledWith({ text: 'hi', lang: 'ru', format: 'pcm' });
    });

    it('pollyBackend.synthesize returns null when Polly returns null', async () => {
      mockSynthesizePolly.mockResolvedValueOnce(null);
      expect(await pollyBackend.synthesize('hi', 'sr')).toBeNull();
    });

    it('fishBackend.synthesize returns audioB64 on a successful Fish call', async () => {
      mockSynthesizeFish.mockResolvedValueOnce({ audioB64: 'BBBB', sampleRateHz: 16000 });
      const result = await fishBackend.synthesize('zdravo', 'sr');
      expect(result).toEqual({ audioB64: 'BBBB' });
      expect(mockSynthesizeFish).toHaveBeenCalledWith({ text: 'zdravo', lang: 'sr', format: 'pcm' });
    });

    it('fishBackend.synthesize returns null when Fish returns null', async () => {
      mockSynthesizeFish.mockResolvedValueOnce(null);
      expect(await fishBackend.synthesize('zdravo', 'sr')).toBeNull();
    });
  });

  describe('synthesizeCascadeReply — selection logic (Polly-backed language, e.g. ru)', () => {
    it('returns the Polly result and never calls Fish when Polly succeeds', async () => {
      mockSynthesizePolly.mockResolvedValueOnce({ audioB64: 'AAAA', sampleRateHz: 16000 });

      const result = await synthesizeCascadeReply('privet', 'ru');

      expect(result).toEqual({ audioB64: 'AAAA', backend: 'polly' });
      expect(mockSynthesizeFish).not.toHaveBeenCalled();
      // Fish is never even consulted for a language Polly already covers,
      // regardless of resolvePollyVoice — Polly succeeding is enough.
      expect(mockResolvePollyVoice).not.toHaveBeenCalled();
    });

    it('does not fall back to Fish when Polly fails but the language HAS a Polly voice (a runtime failure, not a coverage gap)', async () => {
      mockSynthesizePolly.mockResolvedValueOnce(null);
      mockResolvePollyVoice.mockReturnValueOnce({ voiceId: 'Tatyana', engine: 'standard' });

      const result = await synthesizeCascadeReply('privet', 'ru');

      expect(result).toBeNull();
      expect(mockSynthesizeFish).not.toHaveBeenCalled();
    });
  });

  describe('synthesizeCascadeReply — selection logic (Fish-only language, e.g. sr)', () => {
    it('falls back to Fish when Polly fails AND the language has no Polly voice at all', async () => {
      mockSynthesizePolly.mockResolvedValueOnce(null);
      mockResolvePollyVoice.mockReturnValueOnce(null);
      mockSynthesizeFish.mockResolvedValueOnce({ audioB64: 'BBBB', sampleRateHz: 16000 });

      const result = await synthesizeCascadeReply('zdravo', 'sr');

      expect(result).toEqual({ audioB64: 'BBBB', backend: 'fish' });
      // Polly is still tried first, unconditionally — same as before extraction.
      expect(mockSynthesizePolly).toHaveBeenCalledWith({ text: 'zdravo', lang: 'sr', format: 'pcm' });
    });

    it('returns null when both Polly and Fish fail for a Fish-only language', async () => {
      mockSynthesizePolly.mockResolvedValueOnce(null);
      mockResolvePollyVoice.mockReturnValueOnce(null);
      mockSynthesizeFish.mockResolvedValueOnce(null);

      const result = await synthesizeCascadeReply('zdravo', 'sr');

      expect(result).toBeNull();
    });
  });
});
