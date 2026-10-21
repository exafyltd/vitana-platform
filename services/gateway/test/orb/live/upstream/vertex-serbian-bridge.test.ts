/**
 * VTID-04000 — unit tests for the narrow Serbian-only Vertex bridge
 * predicates. See `vertex-serbian-bridge.ts`'s own header for the full
 * rationale; `upstream-provider-selector.test.ts`'s "VTID-04000" describe
 * block covers how these two gates combine inside the selector itself.
 */

import {
  isVertexSerbianBridgeEnabled,
  isVertexSerbianBridgeLanguage,
} from '../../../../src/orb/live/upstream/vertex-serbian-bridge';

describe('VTID-04000: isVertexSerbianBridgeEnabled', () => {
  afterEach(() => {
    delete process.env.VERTEX_SERBIAN_BRIDGE_ENABLED;
  });

  it('defaults to disabled — deploying this file changes nothing', () => {
    expect(isVertexSerbianBridgeEnabled()).toBe(false);
  });

  it('is enabled only by the exact string "true", same convention as isCascadeEnabled/NOVA_SONIC_GLOBAL_ENABLED', () => {
    process.env.VERTEX_SERBIAN_BRIDGE_ENABLED = 'yes';
    expect(isVertexSerbianBridgeEnabled()).toBe(false);
    process.env.VERTEX_SERBIAN_BRIDGE_ENABLED = 'TRUE';
    expect(isVertexSerbianBridgeEnabled()).toBe(false);
    process.env.VERTEX_SERBIAN_BRIDGE_ENABLED = '1';
    expect(isVertexSerbianBridgeEnabled()).toBe(false);
    process.env.VERTEX_SERBIAN_BRIDGE_ENABLED = 'true';
    expect(isVertexSerbianBridgeEnabled()).toBe(true);
  });

  it('tolerates surrounding whitespace on the real "true" value', () => {
    process.env.VERTEX_SERBIAN_BRIDGE_ENABLED = '  true  ';
    expect(isVertexSerbianBridgeEnabled()).toBe(true);
  });
});

describe('VTID-04000: isVertexSerbianBridgeLanguage — Serbian only, never widened', () => {
  it('matches bare "sr"', () => {
    expect(isVertexSerbianBridgeLanguage('sr')).toBe(true);
  });

  it('matches region/script-tagged variants', () => {
    expect(isVertexSerbianBridgeLanguage('sr-RS')).toBe(true);
    expect(isVertexSerbianBridgeLanguage('sr_RS')).toBe(true);
    expect(isVertexSerbianBridgeLanguage('SR-rs')).toBe(true);
  });

  it('rejects every other language, including ones Nova/the cascade already cover', () => {
    for (const lang of ['en', 'de', 'fr', 'es', 'ru', 'pl', 'ar', 'zh', 'pt', 'tr', 'hr', 'bs']) {
      expect(isVertexSerbianBridgeLanguage(lang)).toBe(false);
    }
  });

  it('rejects null/undefined/empty without throwing', () => {
    expect(isVertexSerbianBridgeLanguage(null)).toBe(false);
    expect(isVertexSerbianBridgeLanguage(undefined)).toBe(false);
    expect(isVertexSerbianBridgeLanguage('')).toBe(false);
  });
});
