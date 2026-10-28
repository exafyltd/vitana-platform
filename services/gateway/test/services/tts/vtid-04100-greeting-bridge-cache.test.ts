/**
 * VTID-04100 — the greeting bridge is cached, and its pre-connect await is
 * bounded.
 *
 * The bridge is the only mechanism that makes ORB audible before the speech
 * model has produced anything, and it had two defects that undercut it: every
 * session re-synthesized the identical phrase through Polly, and the call was
 * awaited unboundedly on the pre-connect critical path — the shape that made
 * VTID-03802 a production outage ("just connecting all the time").
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getCachedGreetingBridgeAudio,
  putCachedGreetingBridgeAudio,
  resetGreetingBridgeCache,
  greetingBridgeCacheSize,
  greetingBridgeCacheKey,
  GREETING_BRIDGE_CACHE_MAX_ENTRIES,
  GREETING_BRIDGE_CACHE_TTL_MS,
} from '../../../src/services/tts/greeting-bridge-cache';

const audio = (b = 'AAAA') => ({ audioB64: b, sampleRateHz: 16000 });

beforeEach(() => resetGreetingBridgeCache());

describe('greeting bridge cache', () => {
  it('misses before anything is stored', () => {
    expect(getCachedGreetingBridgeAudio('de', 'Guten Morgen')).toBeNull();
  });

  it('returns what was stored, with its sample rate', () => {
    putCachedGreetingBridgeAudio('de', 'Guten Morgen', audio('XYZ'));
    expect(getCachedGreetingBridgeAudio('de', 'Guten Morgen')).toEqual({ audioB64: 'XYZ', sampleRateHz: 16000 });
  });

  it('keys on language AND text — the same words in two locales are different audio', () => {
    putCachedGreetingBridgeAudio('de', 'hello', audio('DE'));
    putCachedGreetingBridgeAudio('en', 'hello', audio('EN'));
    expect(getCachedGreetingBridgeAudio('de', 'hello')?.audioB64).toBe('DE');
    expect(getCachedGreetingBridgeAudio('en', 'hello')?.audioB64).toBe('EN');
  });

  it('normalises locale case so de and DE are one entry, not two', () => {
    expect(greetingBridgeCacheKey('DE', 'x')).toBe(greetingBridgeCacheKey('de', 'x'));
  });

  it('expires by TTL — the text embeds the date, so a stale day must not be served', () => {
    const t0 = 1_000_000;
    putCachedGreetingBridgeAudio('de', 'Heute ist Montag', audio(), t0);
    expect(getCachedGreetingBridgeAudio('de', 'Heute ist Montag', t0 + 1000)).not.toBeNull();
    expect(getCachedGreetingBridgeAudio('de', 'Heute ist Montag', t0 + GREETING_BRIDGE_CACHE_TTL_MS + 1)).toBeNull();
  });

  it('is bounded — a long-lived task must not accumulate an entry per locale per day forever', () => {
    for (let i = 0; i < GREETING_BRIDGE_CACHE_MAX_ENTRIES + 25; i++) {
      putCachedGreetingBridgeAudio('de', `phrase ${i}`, audio(String(i)));
    }
    expect(greetingBridgeCacheSize()).toBeLessThanOrEqual(GREETING_BRIDGE_CACHE_MAX_ENTRIES);
  });

  it('evicts the least recently used, so the phrase in active use survives eviction pressure', () => {
    putCachedGreetingBridgeAudio('de', 'today', audio('KEEP'));
    for (let i = 0; i < GREETING_BRIDGE_CACHE_MAX_ENTRIES - 1; i++) {
      putCachedGreetingBridgeAudio('de', `filler ${i}`, audio());
      getCachedGreetingBridgeAudio('de', 'today'); // keep it hot
    }
    putCachedGreetingBridgeAudio('de', 'overflow', audio());
    expect(getCachedGreetingBridgeAudio('de', 'today')?.audioB64).toBe('KEEP');
  });

  it('never throws on a malformed store — a cache holds no truth', () => {
    expect(() => putCachedGreetingBridgeAudio('de', 'x', { audioB64: '', sampleRateHz: 0 })).not.toThrow();
    expect(getCachedGreetingBridgeAudio('de', 'x')).toBeNull();
  });
});

describe('orb-live.ts wiring (VTID-04511: the bridge is removed)', () => {
  const src = readFileSync(join(__dirname, '../../../src/routes/orb-live.ts'), 'utf8');

  it('never synthesizes or sends the greeting bridge — Nova is the only voice', () => {
    expect(src).not.toContain('sendGreetingAudioBridge');
    expect(src).not.toContain('synthesizeGreetingBridgeAudioPcm');
    expect(src).not.toContain('getCachedGreetingBridgeAudio');
    expect(src).not.toContain("'greeting_bridge_sent'");
    expect(src).not.toContain("source: 'greeting_bridge'");
  });
});
