/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: greeting bridge TTS synthesis — WAV-header
 * stripping (the one nontrivial pure logic here; synthesis itself needs a
 * live GCP client and is exercised on staging, not in unit tests) and the
 * empty-text fast-path guard.
 */

import { stripWavHeaderIfPresent, synthesizeGreetingBridgeAudioPcm } from '../../../src/services/tts/greeting-bridge-tts';

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
  it('returns null for empty text without attempting synthesis', async () => {
    expect(await synthesizeGreetingBridgeAudioPcm('', 'en')).toBeNull();
    expect(await synthesizeGreetingBridgeAudioPcm('   ', 'en')).toBeNull();
  });
});
