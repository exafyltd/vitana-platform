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
  it('contains exactly vertex, livekit, nova_sonic', () => {
    expect([...VOICE_PROVIDER_NAMES]).toEqual(['vertex', 'livekit', 'nova_sonic']);
  });
});

describe('parseVoiceProviderName', () => {
  it('accepts every canonical provider name', () => {
    expect(parseVoiceProviderName('vertex')).toBe('vertex');
    expect(parseVoiceProviderName('livekit')).toBe('livekit');
    expect(parseVoiceProviderName('nova_sonic')).toBe('nova_sonic');
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
    expect(parseVoiceProviderName('bedrock')).toBeNull();
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
