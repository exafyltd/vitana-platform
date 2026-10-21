/**
 * BOOTSTRAP-CASCADE-WIRING — the cascade is actually REACHABLE.
 *
 * VTID-03683 built the Transcribe→Bedrock→Polly pipeline, its eligibility
 * gate, its selector branch and its factory case — and shipped it unreachable.
 * Three seams in `routes/orb-live.ts` were missing:
 *
 *   1. `selectUpstreamProvider({...})` was called with no `cascade` field, so
 *      `tryCascadeRescue`'s `if (ctx.cascade?.enabled !== true) return null`
 *      fired on every session.
 *   2. `deps.cascaded` was never supplied to `createUpstreamClient`.
 *   3. The factory was called with the LITERAL `'nova_sonic'`, so even a
 *      `provider: 'cascaded'` decision built a Nova client.
 *
 * Net effect: `ORB_CASCADED_VOICE_ENABLED=true` changed nothing, because
 * `isCascadeEnabled()` had no caller on any live path. Russian, Polish,
 * Chinese and Arabic sessions stayed on a model that cannot speak them
 * (measured: ~30 audio chunks/turn against de/en's ~165).
 *
 * These are SOURCE-CHECK tests, matching the established pattern for this
 * module (`nova-bedrock-factory-memo.test.ts`, `nova-close-reasons.test.ts`):
 * `orb-live.ts` is ~15k lines of stateful route wiring with no export surface
 * to drive a real session through in-process.
 *
 * They assert the shape of a CALL rather than a behaviour, which is exactly
 * the right instrument here — the defect was the absence of a call, and a
 * behavioural test of the cascade client itself (which exists, and passes)
 * proved nothing about whether anything invoked it. That is the VTID-03531
 * lesson: a green unit suite proves a function works, not that it is wired.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ORB_LIVE = readFileSync(
  join(__dirname, '../../../../src/routes/orb-live.ts'),
  'utf8',
);

describe('seam 1 — the selector is told about the cascade', () => {
  it('imports the cascade gate helpers (they previously had NO caller on any live path)', () => {
    expect(ORB_LIVE).toMatch(/import\s*\{[^}]*isCascadeEnabled[^}]*\}\s*from\s*'\.\.\/orb\/live\/upstream\/cascaded-config'/s);
    expect(ORB_LIVE).toContain('isCascadeLanguageSupported');
  });

  it('passes a `cascade` field into selectUpstreamProvider', () => {
    // The selector call is the ONLY place this can be supplied; without it
    // tryCascadeRescue short-circuits to null for every session.
    const call = ORB_LIVE.slice(
      ORB_LIVE.indexOf('selectUpstreamProvider({'),
      ORB_LIVE.indexOf('selectUpstreamProvider({') + 3000,
    );
    expect(call).toContain('cascade:');
    expect(call).toContain('enabled: isCascadeEnabled()');
    expect(call).toContain('isCascadeLanguageSupported(session.lang)');
  });

  it('derives languageSupported from the session language, not a hardcoded list', () => {
    // A second copy of the language table here would drift from
    // cascaded-config's — the VTID-03644 five-copies failure.
    expect(ORB_LIVE).not.toMatch(/cascade:\s*\{[^}]*languageSupported:\s*(true|false)\b/s);
  });
});

describe('seam 2 + 3 — a cascaded decision actually builds a cascaded client', () => {
  it('has a branch on the cascaded provider decision', () => {
    expect(ORB_LIVE).toContain("__upstreamDecision.provider === 'cascaded'");
  });

  it("constructs the client with the 'cascaded' provider and supplies deps.cascaded", () => {
    expect(ORB_LIVE).toMatch(/createUpstreamClient\(\s*'cascaded'\s*,\s*\{\s*cascaded:\s*\{/s);
  });

  it('the cascaded branch precedes the nova_sonic branch and returns', () => {
    const cascadedAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'cascaded'");
    const novaAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'nova_sonic'", cascadedAt);
    expect(cascadedAt).toBeGreaterThan(-1);
    expect(novaAt).toBeGreaterThan(cascadedAt);
    // Must resolve/return inside its own branch. Falling through would land
    // on the Vertex path at the bottom of the function, which is dead since
    // the GCP shutdown — turning a named failure into a connect timeout.
    const branch = ORB_LIVE.slice(cascadedAt, novaAt);
    expect(branch).toContain('resolve(cascadedFacade)');
    expect(branch).toContain('reject(err as Error)');
  });

  it('binds the shared session handlers to the cascaded client', () => {
    const cascadedAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'cascaded'");
    const branch = ORB_LIVE.slice(cascadedAt, cascadedAt + 6000);
    expect(branch).toContain('bindUpstreamSessionHandlers({');
    expect(branch).toContain('client: cascadedClient');
  });

  it('reuses the generic ws facade rather than introducing a second adapter', () => {
    const cascadedAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'cascaded'");
    const branch = ORB_LIVE.slice(cascadedAt, cascadedAt + 6000);
    // createNovaWsFacade takes an UpstreamLiveClient, not a Nova client.
    expect(branch).toContain('createNovaWsFacade(cascadedClient)');
  });

  it('sets upstreamProvider so telemetry does not report the session as Nova', () => {
    const cascadedAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'cascaded'");
    const branch = ORB_LIVE.slice(cascadedAt, cascadedAt + 6000);
    expect(branch).toContain("session.upstreamProvider = 'cascaded'");
  });
});

describe('the cascade must NOT inherit Nova-specific transport behaviour', () => {
  it('does not arm the silence keepalive on the cascaded path', () => {
    // Nova needs synthetic PCM because Bedrock kills an idle bidirectional
    // stream after ~15s. The cascade has no such stream — Transcribe opens
    // lazily per turn — so silence would bill STT for ambient quiet and push
    // endpoint detection around, guarding a deadline that does not exist.
    const cascadedAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'cascaded'");
    const novaAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'nova_sonic'", cascadedAt);
    const branch = ORB_LIVE.slice(cascadedAt, novaAt);
    expect(branch).not.toContain('armUpstreamKeepalive');
    expect(branch).not.toContain('enableSilenceKeepalive');
  });

  it('does not arm Nova stream rotation on the cascaded path', () => {
    const cascadedAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'cascaded'");
    const novaAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'nova_sonic'", cascadedAt);
    const branch = ORB_LIVE.slice(cascadedAt, novaAt);
    // The 8-minute rotation exists for Bedrock's bidirectional stream cap.
    expect(branch).not.toContain('onRotationDue');
    expect(branch).not.toContain('rotateNovaStream');
  });
});

describe('failure is loud', () => {
  it('emits a typed failure event carrying the error code', () => {
    const cascadedAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'cascaded'");
    const branch = ORB_LIVE.slice(cascadedAt, cascadedAt + 8000);
    expect(branch).toContain('orb.upstream.cascaded.connect_failed');
    // The IAM case (missing transcribe/polly on the task role) is the most
    // likely first failure — VTID-03665 shape — and must be distinguishable
    // from an unsupported language or an unconfigured client.
    expect(branch).toMatch(/code:\s*\(err as \{ code\?: string \}\)\?\.code/);
  });

  it('emits a success event so the rescue is observable in oasis_events', () => {
    const cascadedAt = ORB_LIVE.indexOf("__upstreamDecision.provider === 'cascaded'");
    const branch = ORB_LIVE.slice(cascadedAt, cascadedAt + 8000);
    expect(branch).toContain('orb.upstream.cascaded.connect_succeeded');
  });
});
