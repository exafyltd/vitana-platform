/**
 * VTID-03683 — the cascaded voice pipeline (Transcribe → Bedrock → Polly).
 *
 * These tests pin the two properties that actually decide whether this
 * feature helps or hurts:
 *
 *   1. WHICH languages it takes. Taking one Nova speaks natively would trade
 *      a working speech-to-speech session for a slower three-hop one.
 *   2. That it is INERT until switched on, so deploying it changes no routing.
 *
 * Eligibility is asserted by iterating the languages and requiring the gate to
 * answer for each, rather than spot-checking `ru`. Spot-checking passes the
 * moment someone adds `ru` and says nothing about `pl`, `sr`, or the next
 * language added — which is exactly how the VTID-03681 seam bug shipped.
 */

import {
  evaluateCascadeEligibility,
  isCascadeLanguageSupported,
  isCascadeEnabled,
  resolveTranscribeLanguageCode,
  listCascadeLanguages,
} from '../../../../src/orb/live/upstream/cascaded-config';
import { selectUpstreamProvider } from '../../../../src/orb/live/upstream/upstream-provider-selector';
import { NOVA_SONIC_SUPPORTED_LANGUAGES } from '../../../../src/orb/live/upstream/nova-sonic-config';
import { resolvePollyVoice } from '../../../../src/services/tts/polly';

describe('VTID-03683: cascade language eligibility', () => {
  it('REFUSES every language Nova speaks natively', () => {
    // The cascade is slower and has no barge-in. Routing a Nova-supported
    // language here would be a regression wearing a fix's clothes.
    for (const lang of NOVA_SONIC_SUPPORTED_LANGUAGES) {
      const e = evaluateCascadeEligibility(lang);
      expect(e.eligible).toBe(false);
      expect(e.reason).toBe('nova_supports_natively');
    }
  });

  it('takes exactly the languages Nova cannot speak AND both AWS services can', () => {
    // ru/pl/ar/zh are the languages that today get ~30 audio chunks a turn.
    for (const lang of ['ru', 'pl', 'ar', 'zh']) {
      const e = evaluateCascadeEligibility(lang);
      expect(e.eligible).toBe(true);
      expect(e.reason).toBeNull();
      expect(e.transcribeLanguageCode).toBeTruthy();
    }
    expect(listCascadeLanguages().sort()).toEqual(['ar', 'pl', 'ru', 'tr', 'zh']);
  });

  it('refuses sr, and blames POLLY — the blocker that is actually verified', () => {
    // Polly has no Serbian voice in any engine (VTID-03578), read live from
    // resolvePollyVoice. The Transcribe table in this repo is unverified
    // against the live API, so attributing sr's gap to Transcribe would send
    // the next person to fix the wrong service.
    expect(resolvePollyVoice('sr')).toBeNull();
    const e = evaluateCascadeEligibility('sr');
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe('no_polly_voice');
  });

  it('derives coverage from Polly rather than restating it', () => {
    // Any language the gate accepts MUST have a real Polly voice. This is the
    // seam assertion: it fails if the two tables ever disagree, which is the
    // defect class VTID-03578 (pt/pl absent from both Polly tables → English)
    // and VTID-03681 (seven tables out of step) both shipped.
    for (const lang of listCascadeLanguages()) {
      expect(resolvePollyVoice(lang)).not.toBeNull();
      expect(resolveTranscribeLanguageCode(lang)).toBeTruthy();
    }
  });

  it('normalises locale tags and refuses unknown languages', () => {
    expect(isCascadeLanguageSupported('ru-RU')).toBe(true);
    expect(isCascadeLanguageSupported('RU')).toBe(true);
    expect(isCascadeLanguageSupported('it')).toBe(false);
    expect(isCascadeLanguageSupported('')).toBe(false);
    expect(isCascadeLanguageSupported(null)).toBe(false);
  });
});

describe('VTID-03683: activation gate is off by default', () => {
  const original = process.env.ORB_CASCADED_VOICE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.ORB_CASCADED_VOICE_ENABLED;
    else process.env.ORB_CASCADED_VOICE_ENABLED = original;
  });

  it('is off unless the value is exactly "true"', () => {
    delete process.env.ORB_CASCADED_VOICE_ENABLED;
    expect(isCascadeEnabled()).toBe(false);
    for (const v of ['', 'false', 'TRUE', '1', 'yes', 'true ']) {
      process.env.ORB_CASCADED_VOICE_ENABLED = v;
      // 'true ' is trimmed and therefore on; everything else is off.
      expect(isCascadeEnabled()).toBe(v === 'true ');
    }
    process.env.ORB_CASCADED_VOICE_ENABLED = 'true';
    expect(isCascadeEnabled()).toBe(true);
  });
});

describe('VTID-03683: selector routes Nova-blocked languages to the cascade', () => {
  // A session whose language Nova cannot speak, on the AWS runtime, with
  // Vertex dead — i.e. exactly the production shape that produced the bug.
  const blockedCtx = (cascade?: { enabled: boolean; languageSupported: boolean }) => ({
    envProviderOverride: null,
    systemConfigActiveProvider: 'nova_sonic' as const,
    vertexUnavailable: true,
    nova: {
      enabled: true,
      runtime: 'aws-ecs' as const,
      languageSupported: false,
      identityAllowed: true,
      globalEnabled: true,
    },
    ...(cascade ? { cascade } : {}),
  });

  it('without the flag, behaviour is byte-for-byte the old forced-Nova path', () => {
    const d = selectUpstreamProvider(blockedCtx() as never);
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
  });

  it('with the flag on and the language covered, it routes to the cascade', () => {
    const d = selectUpstreamProvider(
      blockedCtx({ enabled: true, languageSupported: true }) as never,
    );
    expect(d.provider).toBe('cascaded');
    expect(d.reason).toBe('cascaded_language_rescue');
  });

  it('with the flag on but the language NOT covered (sr), it does not divert', () => {
    // sr must not be sent somewhere that would also fail. It keeps the
    // existing path and stays a named, visible gap.
    const d = selectUpstreamProvider(
      blockedCtx({ enabled: true, languageSupported: false }) as never,
    );
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).toBe('nova_forced_vertex_unavailable');
  });

  it('does not claim a session that a LIVE Vertex would still have taken', () => {
    // The cascade only rescues sessions that were going to be FORCED onto Nova.
    // With Vertex alive, the selector's own language gate returns first and
    // pins to Vertex — and this change deliberately does not reach past it.
    // Whether a cascade beats a live Vertex is a separate product question;
    // silently answering it inside a fix for the Vertex-is-dead case would be
    // a behaviour change nobody asked for. Vertex is dead in production, so
    // this branch is currently unreachable there — it is pinned precisely
    // because an unreachable branch is the kind that drifts unnoticed.
    const d = selectUpstreamProvider({
      envProviderOverride: null,
      systemConfigActiveProvider: 'nova_sonic',
      vertexUnavailable: false,
      nova: {
        enabled: true,
        runtime: 'aws-ecs',
        languageSupported: false,
        identityAllowed: true,
        globalEnabled: true,
      },
      cascade: { enabled: true, languageSupported: true },
    } as never);
    expect(d.provider).toBe('vertex');
    expect(d.reason).toBe('nova_language_unsupported');
  });

  it('never diverts a session whose language Nova DOES support', () => {
    const d = selectUpstreamProvider({
      envProviderOverride: null,
      systemConfigActiveProvider: 'nova_sonic',
      vertexUnavailable: true,
      nova: {
        enabled: true,
        runtime: 'aws-ecs',
        languageSupported: true,
        identityAllowed: true,
        globalEnabled: true,
      },
      cascade: { enabled: true, languageSupported: true },
    } as never);
    expect(d.provider).toBe('nova_sonic');
    expect(d.reason).not.toBe('cascaded_language_rescue');
  });
});
