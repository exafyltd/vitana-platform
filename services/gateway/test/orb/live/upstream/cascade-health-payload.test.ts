/**
 * VTID-03721 — the cascade's runtime state must be observable from outside.
 *
 * Answering "is the cascade actually on?" required AWS console access:
 * `ORB_CASCADED_VOICE_ENABLED` was set nowhere in the repo (VTID-03720), no
 * endpoint reported it, and session telemetry records no upstream provider.
 * So pl/pt answered in English for hours with the cause invisible, and the
 * state had to be reconstructed from code plus a guess about live config.
 *
 * The field that matters is `effective`, NOT `enabled` — `VERTEX_LIVE_UNAVAILABLE`
 * gates the branch above the cascade, so `enabled` alone is true-but-useless.
 */

import { buildCascadeHealthPayload } from '../../../../src/orb/live/upstream/cascaded-config';

const ON = {
  ORB_CASCADED_VOICE_ENABLED: 'true',
  VERTEX_LIVE_UNAVAILABLE: 'true',
} as NodeJS.ProcessEnv;

describe('VTID-03721: cascade health payload', () => {
  describe('effective — the field that actually answers the question', () => {
    it('is true only when BOTH flags are set', () => {
      expect(buildCascadeHealthPayload(ON).effective).toBe(true);
    });

    it('is false when the cascade flag is on but Vertex is not marked dead', () => {
      // This is the exact configuration that silently does nothing: the
      // selector returns {provider:'vertex'} before tryCascadeRescue is
      // consulted, and Vertex has been dead since the GCP shutdown.
      const p = buildCascadeHealthPayload({
        ORB_CASCADED_VOICE_ENABLED: 'true',
      } as NodeJS.ProcessEnv);
      expect(p.enabled).toBe(true);
      expect(p.effective).toBe(false);
    });

    it('is false when the cascade flag is absent', () => {
      const p = buildCascadeHealthPayload({
        VERTEX_LIVE_UNAVAILABLE: 'true',
      } as NodeJS.ProcessEnv);
      expect(p.enabled).toBe(false);
      expect(p.effective).toBe(false);
    });
  });

  describe('the flag is exact-string, and the payload must say so honestly', () => {
    // `' true '` is deliberately NOT in this list — isCascadeEnabled() trims,
    // so it is genuinely ON. Covered by the trim test below instead. (I had it
    // here first; the suite caught the contradiction, which is the point.)
    it.each(['TRUE', 'True', '1', 'yes', 'on', ''])(
      'treats %p as OFF, matching isCascadeEnabled()',
      (v) => {
        const p = buildCascadeHealthPayload({
          ORB_CASCADED_VOICE_ENABLED: v,
          VERTEX_LIVE_UNAVAILABLE: 'true',
        } as NodeJS.ProcessEnv);
        expect(p.enabled).toBe(false);
        expect(p.effective).toBe(false);
      },
    );

    it('accepts the exact string with surrounding whitespace trimmed', () => {
      // isCascadeEnabled() trims, so the health report must trim identically
      // or it would disagree with routing — a health endpoint that contradicts
      // the code is worse than none.
      const p = buildCascadeHealthPayload({
        ORB_CASCADED_VOICE_ENABLED: '  true  ',
        VERTEX_LIVE_UNAVAILABLE: 'true',
      } as NodeJS.ProcessEnv);
      expect(p.enabled).toBe(true);
    });
  });

  describe('per-language verdicts come from the real routing functions', () => {
    it('reports the languages the cascade rescues, with their Transcribe codes', () => {
      const langs = buildCascadeHealthPayload(ON).languages as Record<string, string>;
      expect(langs.pl).toBe('cascade:pl-PL');
      expect(langs.pt).toBe('cascade:pt-BR');
      expect(langs.ru).toBe('cascade:ru-RU');
      expect(langs.ar).toBe('cascade:ar-AE');
      expect(langs.zh).toBe('cascade:zh-CN');
      // BOOTSTRAP-NOVA-ESFR-CASCADE — fr/es join pt: found live-answering in
      // English despite being "Nova-native" on paper, removed from
      // NOVA_SONIC_SUPPORTED_LANGUAGES, and now cascade-eligible.
      expect(langs.fr).toBe('cascade:fr-FR');
      expect(langs.es).toBe('cascade:es-ES');
    });

    it('reports Serbian as refused, naming Polly as the real blocker', () => {
      // Not "not wired" — Polly publishes no Serbian voice in any engine.
      // A reason naming the wrong service sends the next person to fix the
      // wrong thing.
      const langs = buildCascadeHealthPayload(ON).languages as Record<string, string>;
      expect(langs.sr).toBe('no:no_polly_voice');
    });

    it('reports Nova-native languages as refused for that reason', () => {
      const langs = buildCascadeHealthPayload(ON).languages as Record<string, string>;
      for (const l of ['en', 'de']) {
        expect(langs[l]).toBe('no:nova_supports_natively');
      }
    });
  });

  it('reports the Transcribe region it would actually use', () => {
    expect(
      buildCascadeHealthPayload({
        ...ON,
        AWS_TRANSCRIBE_REGION: 'eu-west-1',
      } as NodeJS.ProcessEnv).transcribe_region,
    ).toBe('eu-west-1');

    expect(
      buildCascadeHealthPayload({ ...ON, AWS_REGION: 'us-east-1' } as NodeJS.ProcessEnv)
        .transcribe_region,
    ).toBe('us-east-1');

    expect(buildCascadeHealthPayload(ON).transcribe_region).toBe('eu-central-1');
  });

  it('leaks no credentials', () => {
    // Secret-free by construction: booleans, a region name, and per-language
    // verdicts. Asserted rather than assumed, because this route is public.
    const json = JSON.stringify(
      buildCascadeHealthPayload({
        ...ON,
        AWS_SECRET_ACCESS_KEY: 'SHOULD-NEVER-APPEAR',
        BEDROCK_ROLE_ARN: 'arn:aws:iam::123:role/secret-ish',
      } as NodeJS.ProcessEnv),
    );
    expect(json).not.toContain('SHOULD-NEVER-APPEAR');
    expect(json).not.toContain('arn:aws:iam');
  });
});
