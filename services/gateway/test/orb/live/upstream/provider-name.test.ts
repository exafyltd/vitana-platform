/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: contract tests for the canonical voice
 * provider name type and parser.
 */

import {
  VOICE_PROVIDER_NAMES,
  isVoiceProviderName,
  parseVoiceProviderName,
} from '../../../../src/orb/live/upstream/provider-name';

describe('VOICE_PROVIDER_NAMES', () => {
  it('contains exactly vertex, livekit, nova_sonic, cascaded', () => {
    // VTID-03683 added `cascaded` (Transcribe → Bedrock → Polly) for the
    // languages Nova cannot speak. This assertion is deliberately still an
    // exact list rather than a `toContain` — adding a voice provider should
    // require someone to say so here, which is exactly what caught this.
    expect([...VOICE_PROVIDER_NAMES]).toEqual(['vertex', 'livekit', 'nova_sonic', 'cascaded']);
  });
});

describe('parseVoiceProviderName', () => {
  it('accepts every canonical provider name', () => {
    expect(parseVoiceProviderName('vertex')).toBe('vertex');
    expect(parseVoiceProviderName('livekit')).toBe('livekit');
    expect(parseVoiceProviderName('nova_sonic')).toBe('nova_sonic');
    expect(parseVoiceProviderName('cascaded')).toBe('cascaded');
  });

  it('trims whitespace and lowercases before matching', () => {
    expect(parseVoiceProviderName('  nova_sonic  ')).toBe('nova_sonic');
    expect(parseVoiceProviderName('VERTEX')).toBe('vertex');
    expect(parseVoiceProviderName('Nova_Sonic')).toBe('nova_sonic');
  });

  it('rejects aliases and near-misses (no silent coercion)', () => {
    expect(parseVoiceProviderName('novasonic')).toBeNull();
    expect(parseVoiceProviderName('nova-sonic')).toBeNull();
    expect(parseVoiceProviderName('nova sonic')).toBeNull();
    expect(parseVoiceProviderName('google')).toBeNull();
    expect(parseVoiceProviderName('gemini')).toBeNull();
    // `bedrock` stays rejected even though the cascade calls Bedrock for its
    // LLM leg — the provider name describes the TRANSPORT, not the vendors
    // behind it, and coercing one to the other would route a session by
    // something no selector ever returns.
    expect(parseVoiceProviderName('bedrock')).toBeNull();
    expect(parseVoiceProviderName('cascade')).toBeNull();
    expect(parseVoiceProviderName('cascaded_voice')).toBeNull();
  });

  it('rejects non-strings and empties', () => {
    expect(parseVoiceProviderName('')).toBeNull();
    expect(parseVoiceProviderName('   ')).toBeNull();
    expect(parseVoiceProviderName(null)).toBeNull();
    expect(parseVoiceProviderName(undefined)).toBeNull();
    expect(parseVoiceProviderName(42)).toBeNull();
    expect(parseVoiceProviderName({})).toBeNull();
  });
});

describe('isVoiceProviderName', () => {
  it('guards exact members only (no normalization)', () => {
    expect(isVoiceProviderName('vertex')).toBe(true);
    expect(isVoiceProviderName('nova_sonic')).toBe(true);
    expect(isVoiceProviderName('VERTEX')).toBe(false);
    expect(isVoiceProviderName(' nova_sonic')).toBe(false);
    expect(isVoiceProviderName(3)).toBe(false);
  });
});
