/**
 * VTID-04813 — the ru-only Vertex Live bridge.
 *
 * Owner report: "The Russian voice is also like from a desperate old woman
 * with zero energy" → "Replace Tatyana voice with a Google voice like for
 * Serbian". Polly cannot serve that: `DescribeVoices(ru-RU)` returns only
 * `Tatyana` and `Maxim`, both `standard`-engine, no neural, no generative
 * (re-measured live 2026-09-29). So `ru` moves onto the same Vertex Live
 * bridge `sr` already runs on in production.
 *
 * These tests pin three things:
 *   1. the new predicates behave exactly like the Serbian pair (default
 *      OFF, exact-string `'true'`, one language only);
 *   2. the selector fires the bridge for `ru` with its OWN reason, so a
 *      Russian session is never reported as a Serbian one;
 *   3. the two bridges are INDEPENDENT — Russian's switch cannot turn
 *      Serbian on, Serbian's cannot turn Russian on, and neither language
 *      predicate has been widened into a list.
 *
 * (3) is the one that matters most: `vertex-serbian-bridge.ts` promises its
 * predicate is "never widened to a language list", and the whole point of
 * adding a second file instead of editing that one is to keep that promise
 * mechanically true rather than only in prose.
 */

import {
  isVertexRussianBridgeEnabled,
  isVertexRussianBridgeLanguage,
} from '../../../../src/orb/live/upstream/vertex-russian-bridge';
import {
  isVertexSerbianBridgeEnabled,
  isVertexSerbianBridgeLanguage,
} from '../../../../src/orb/live/upstream/vertex-serbian-bridge';
import { selectUpstreamProvider } from '../../../../src/orb/live/upstream/upstream-provider-selector';

describe('VTID-04813: isVertexRussianBridgeEnabled', () => {
  afterEach(() => {
    delete process.env.VERTEX_RUSSIAN_BRIDGE_ENABLED;
  });

  it('defaults to disabled — merging this file changes nothing on its own', () => {
    expect(isVertexRussianBridgeEnabled()).toBe(false);
  });

  it('is enabled only by the exact string "true" — a typo resolves to off, never truthy', () => {
    for (const bad of ['yes', 'TRUE', 'True', '1', 'on', 'enabled', 'false']) {
      process.env.VERTEX_RUSSIAN_BRIDGE_ENABLED = bad;
      expect(isVertexRussianBridgeEnabled()).toBe(false);
    }
    process.env.VERTEX_RUSSIAN_BRIDGE_ENABLED = 'true';
    expect(isVertexRussianBridgeEnabled()).toBe(true);
  });

  it('tolerates surrounding whitespace on the real value', () => {
    process.env.VERTEX_RUSSIAN_BRIDGE_ENABLED = '  true  ';
    expect(isVertexRussianBridgeEnabled()).toBe(true);
  });
});

describe('VTID-04813: isVertexRussianBridgeLanguage — Russian only, never widened', () => {
  it('matches bare "ru"', () => {
    expect(isVertexRussianBridgeLanguage('ru')).toBe(true);
  });

  it('matches region/script-tagged variants', () => {
    expect(isVertexRussianBridgeLanguage('ru-RU')).toBe(true);
    expect(isVertexRussianBridgeLanguage('ru_RU')).toBe(true);
    expect(isVertexRussianBridgeLanguage('RU-ru')).toBe(true);
  });

  it('rejects every other language — including sr, which has its own bridge', () => {
    for (const lang of ['sr', 'en', 'de', 'fr', 'es', 'pl', 'ar', 'zh', 'pt', 'tr', 'uk', 'be', 'kk']) {
      expect(isVertexRussianBridgeLanguage(lang)).toBe(false);
    }
  });

  it('rejects null/undefined/empty without throwing', () => {
    expect(isVertexRussianBridgeLanguage(null)).toBe(false);
    expect(isVertexRussianBridgeLanguage(undefined)).toBe(false);
    expect(isVertexRussianBridgeLanguage('')).toBe(false);
  });
});

describe('VTID-04813: the two bridges are independent, not one widened gate', () => {
  afterEach(() => {
    delete process.env.VERTEX_RUSSIAN_BRIDGE_ENABLED;
    delete process.env.VERTEX_SERBIAN_BRIDGE_ENABLED;
  });

  it('the Serbian predicate still refuses ru — it was not widened to carry Russian', () => {
    expect(isVertexSerbianBridgeLanguage('ru')).toBe(false);
    expect(isVertexSerbianBridgeLanguage('ru-RU')).toBe(false);
  });

  it('the Russian predicate still refuses sr — the new gate did not become a list either', () => {
    expect(isVertexRussianBridgeLanguage('sr')).toBe(false);
    expect(isVertexRussianBridgeLanguage('sr-RS')).toBe(false);
  });

  it('each switch controls only its own bridge', () => {
    process.env.VERTEX_RUSSIAN_BRIDGE_ENABLED = 'true';
    expect(isVertexRussianBridgeEnabled()).toBe(true);
    expect(isVertexSerbianBridgeEnabled()).toBe(false);

    delete process.env.VERTEX_RUSSIAN_BRIDGE_ENABLED;
    process.env.VERTEX_SERBIAN_BRIDGE_ENABLED = 'true';
    expect(isVertexSerbianBridgeEnabled()).toBe(true);
    expect(isVertexRussianBridgeEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Selector integration. `languageBlocked` is what makes a rescue eligible at
// all, so every case below is built as a Nova session whose language Nova
// cannot speak — exactly how a real `ru` session reaches the selector.
// ---------------------------------------------------------------------------

function novaBlockedCtx(overrides: Record<string, unknown> = {}) {
  return {
    systemConfigProvider: 'nova_sonic',
    nova: {
      enabled: true,
      languageSupported: false, // Nova cannot speak ru/sr
      runtimeSupported: true,
      allowlisted: true,
      globalEnabled: true,
    },
    ...overrides,
  } as Parameters<typeof selectUpstreamProvider>[0];
}

describe('VTID-04813: selectUpstreamProvider routes a ru session to the bridge', () => {
  it('fires for ru with its OWN reason, so telemetry never mislabels it Serbian', () => {
    const d = selectUpstreamProvider(
      novaBlockedCtx({
        vertexRussianBridge: { enabled: true, languageSupported: true },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('vertex_russian_bridge');
  });

  it('still reports vertex_serbian_bridge for a Serbian session — unchanged', () => {
    const d = selectUpstreamProvider(
      novaBlockedCtx({
        vertexSerbianBridge: { enabled: true, languageSupported: true },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('vertex_serbian_bridge');
  });

  it('needs BOTH of its own fields true — a flag alone never reaches Vertex', () => {
    for (const bridge of [
      { enabled: true, languageSupported: false },
      { enabled: false, languageSupported: true },
      { enabled: false, languageSupported: false },
    ]) {
      const d = selectUpstreamProvider(novaBlockedCtx({ vertexRussianBridge: bridge }));
      expect(d.provider).not.toBe('vertex');
      expect(d.reason).not.toBe('vertex_russian_bridge');
    }
  });

  it('an absent vertexRussianBridge object cannot satisfy the gate', () => {
    const d = selectUpstreamProvider(novaBlockedCtx());
    expect(d.provider).not.toBe('vertex');
    expect(d.reason).not.toBe('vertex_russian_bridge');
  });

  it('is checked BEFORE the cascade, so ru gets Gemini rather than Transcribe->Bedrock->Polly', () => {
    const d = selectUpstreamProvider(
      novaBlockedCtx({
        vertexRussianBridge: { enabled: true, languageSupported: true },
        cascade: { enabled: true, languageSupported: true },
      }),
    );
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('vertex_russian_bridge');
  });

  it('with the bridge off, a ru session keeps the existing cascade behaviour byte-for-byte', () => {
    const withBridgeOff = selectUpstreamProvider(
      novaBlockedCtx({
        vertexRussianBridge: { enabled: false, languageSupported: true },
        cascade: { enabled: true, languageSupported: true },
      }),
    );
    const withoutBridgeAtAll = selectUpstreamProvider(
      novaBlockedCtx({ cascade: { enabled: true, languageSupported: true } }),
    );
    expect(withBridgeOff).toEqual(withoutBridgeAtAll);
    expect(withBridgeOff.provider).toBe('cascaded');
    expect(withBridgeOff.reason).toBe('cascaded_language_rescue');
  });

  it('never routes a healthy Nova language to Vertex, even with the flag on', () => {
    const d = selectUpstreamProvider({
      systemConfigProvider: 'nova_sonic',
      nova: {
        enabled: true,
        languageSupported: true, // Nova speaks it — nothing is blocked
        runtimeSupported: true,
        allowlisted: true,
        globalEnabled: true,
      },
      // A context that lies (claims ru support on a de session) must still
      // not reach Vertex: `languageBlocked` gates the rescue first.
      vertexRussianBridge: { enabled: true, languageSupported: true },
    } as Parameters<typeof selectUpstreamProvider>[0]);
    expect(d.provider).not.toBe('vertex');
  });
});
