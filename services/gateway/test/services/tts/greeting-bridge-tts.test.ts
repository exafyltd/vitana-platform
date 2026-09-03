/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: greeting bridge TTS synthesis — WAV-header
 * stripping (the one nontrivial pure logic here) and the empty-text
 * fast-path guard.
 *
 * BOOTSTRAP-ORB-GREETING-BRIDGE-NO-GOOGLE (VTID-03802): also pins that a
 * Polly failure returns null immediately rather than falling through to a
 * live Google Cloud TTS call — GCP is decommissioned, so that fallback used
 * to hang the entire SSE session-start path (see the function's own doc
 * comment for the production evidence).
 */

jest.mock('../../../src/services/tts/tts-provider', () => ({
  ...jest.requireActual('../../../src/services/tts/tts-provider'),
  tryPollySynthesis: jest.fn(),
}));
jest.mock('../../../src/services/voice-config', () => ({
  getVoiceConfig: jest.fn().mockResolvedValue({ tts: { speaking_rate: 1.0 } }),
}));

import { stripWavHeaderIfPresent, synthesizeGreetingBridgeAudioPcm } from '../../../src/services/tts/greeting-bridge-tts';
import { tryPollySynthesis } from '../../../src/services/tts/tts-provider';

function buildWavBuffer(pcmBytes: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBytes.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24000, 24); // sample rate
  header.writeUInt32LE(48000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBytes.length, 40);
  return Buffer.concat([header, pcmBytes]);
}

describe('stripWavHeaderIfPresent', () => {
  it('strips a standard 44-byte RIFF/WAVE header, returning only the PCM payload', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = buildWavBuffer(pcm);
    expect(stripWavHeaderIfPresent(wav)).toEqual(pcm);
  });

  it('passes through a buffer with no RIFF/WAVE signature unchanged', () => {
    const raw = Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
    expect(stripWavHeaderIfPresent(raw)).toEqual(raw);
  });

  it('passes through a too-short buffer unchanged rather than throwing', () => {
    const tiny = Buffer.from([1, 2, 3]);
    expect(stripWavHeaderIfPresent(tiny)).toEqual(tiny);
  });
});

describe('synthesizeGreetingBridgeAudioPcm', () => {
  beforeEach(() => {
    (tryPollySynthesis as jest.Mock).mockReset();
  });

  it('returns null for empty text without attempting synthesis', async () => {
    expect(await synthesizeGreetingBridgeAudioPcm('', 'en')).toBeNull();
    expect(await synthesizeGreetingBridgeAudioPcm('   ', 'en')).toBeNull();
    expect(tryPollySynthesis).not.toHaveBeenCalled();
  });

  it('returns the Polly result when Polly serves the request', async () => {
    (tryPollySynthesis as jest.Mock).mockResolvedValue({
      audioB64: 'abc123',
      sampleRateHz: 16000,
      voice: 'Vicki',
      languageCode: 'de-DE',
      provider: 'polly',
    });
    const result = await synthesizeGreetingBridgeAudioPcm('Hallo', 'de');
    expect(result).toEqual({ audioB64: 'abc123', sampleRateHz: 16000 });
  });

  // BOOTSTRAP-ORB-GREETING-BRIDGE-NO-GOOGLE (VTID-03802): the literal
  // regression this test exists to catch — before this fix, a null from
  // Polly fell through to a live `bridgeTtsClient.synthesizeSpeech()` call
  // against Google Cloud TTS, which is decommissioned and hung the entire
  // SSE session-start path with no error and no timeout.
  it('returns null (never calls out to Google) when Polly cannot serve the request', async () => {
    (tryPollySynthesis as jest.Mock).mockResolvedValue(null);
    const result = await synthesizeGreetingBridgeAudioPcm('Hello', 'sr');
    expect(result).toBeNull();
  });
});
