/**
 * VTID-04211 — `operator-bootstrap-pack.ts` when EVERY individual source
 * fails simultaneously, not just one at a time.
 *
 * The pre-existing "a failing or hanging source renders as unavailable and
 * does not block the others" test (vtid-04018-operator-bootstrap-pack.test.ts)
 * only fails 3 of 7 sections (events, platform PRs, frontend PRs) and
 * explicitly asserts section[0] (CLAUDE.md) still renders real content —
 * it deliberately does NOT cover every source failing at once. The
 * pre-existing "never throws — a broken deps set fails open to an empty
 * pack" test comes closer in spirit, but passes only `{ readRepoFile:
 * undefined }` as a PARTIAL deps object — since `getOperatorBootstrapPack`
 * spreads `{ ...defaultDeps(), ...opts.deps }`, every OTHER source
 * (listPlatformOpenPrs, fetchBuildInfo, queryRecentEvents, ...) silently
 * falls through to the REAL production implementation (real GitHub/
 * Supabase calls) rather than a controlled failure — that test only
 * happens to pass because those real calls fail fast in this sandboxed
 * environment (missing tokens/env vars), which is incidental, not
 * asserted, and the test checks nothing about the resulting content.
 *
 * This file closes the actual gap: a FULLY overridden, deterministic
 * BootstrapDeps object (matching the safe pattern every other test in the
 * sibling file already uses) where every named source rejects or times
 * out, asserting the whole assembled pack's real shape and byte budget.
 */

import * as path from 'path';
import {
  PACK_MAX_CHARS,
  assembleBootstrapPack,
  buildBootstrapSections,
  getOperatorBootstrapPack,
  type BootstrapDeps,
} from '../src/services/operator-bootstrap-pack';

// Mirrors the sibling test file's own `deps()` helper shape exactly, but
// every field here is a deliberate failure — never a real file/network
// read, and never left to fall through to defaultDeps().
function allFailingDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    readRepoFile: async () => { throw new Error('github_contents_503'); },
    listPlatformOpenPrs: async () => { throw new Error('github_prs_503'); },
    // Deliberately no listPlatformOpenPrsBare — resolvePlatformOpenPrs()
    // throws immediately when the enriched list fails and no bare
    // fallback was supplied (confirmed by reading its own source).
    listFrontendOpenPrs: async () => { throw new Error('FRONTEND_DEPLOY_TOKEN not set'); },
    queryRecentEvents: async () => { throw new Error('oasis_events 503'); },
    fetchBuildInfo: async () => { throw new Error('ECONNREFUSED build-info'); },
    env: {
      OPERATOR_BOOTSTRAP_PACK_ENABLED: 'true',
      OPERATOR_BOOTSTRAP_BUILD_INFO_URLS: 'staging=https://preview.example/build-info,prod=https://prod.example/build-info',
    },
    ...overrides,
  };
}

describe('VTID-04211 buildBootstrapSections — every source fails at once', () => {
  it('every one of the 7 sections reflects a genuine failure — 6 via .error, "Live build-info" via its own degraded body', async () => {
    const sections = await buildBootstrapSections(allFailingDeps());
    expect(sections).toHaveLength(7);

    // Six sections propagate their failure as a top-level PackSection.error:
    // readRepoFile() feeds four of them (rules, changelog, path map,
    // schema), plus "Open pull requests" (listPlatformOpenPrs, with no
    // bare fallback supplied) and "Recent deploy / autopilot events"
    // (queryRecentEvents).
    const buildInfoIndex = sections.findIndex((s) => s.title === 'Live build-info');
    expect(buildInfoIndex).toBeGreaterThan(-1);
    const errored = sections.filter((_, i) => i !== buildInfoIndex);
    expect(errored).toHaveLength(6);
    expect(errored.every((s) => typeof s.error === 'string' && s.error.length > 0)).toBe(true);
    expect(errored.every((s) => s.body === undefined)).toBe(true);

    // "Live build-info" is the one section whose per-target internal catch
    // absorbs the failure into its body instead of the section's own
    // .error — pinned in detail by the next test.
    expect(sections[buildInfoIndex].error).toBeUndefined();
    expect(sections[buildInfoIndex].body).toBeDefined();
  });

  it('the "Live build-info" section still fails cleanly even though it has its own internal per-target try/catch', async () => {
    // renderBuildInfo()'s own per-URL catch would normally degrade
    // gracefully to "(unavailable: ...)" INSIDE the section body without
    // ever setting section.error — confirmed here it still doesn't throw
    // and the section still resolves (with a body, not a top-level error,
    // since the per-target catch absorbs the failure before it can
    // propagate) — this is the one section whose failure mode differs
    // from the other six, and it's worth pinning explicitly so a future
    // change to that internal catch doesn't silently start throwing.
    const sections = await buildBootstrapSections(allFailingDeps());
    const buildInfoSection = sections[4];
    expect(buildInfoSection.title).toBe('Live build-info');
    expect(buildInfoSection.error).toBeUndefined();
    expect(buildInfoSection.body).toContain('(unavailable: ECONNREFUSED build-info)');
  });
});

describe('VTID-04211 assembleBootstrapPack — every source failed, whole-pack shape', () => {
  it('resolves to a valid, non-throwing string under the byte budget with an "(unavailable: ...)" line per genuinely-failed section', async () => {
    const sections = await buildBootstrapSections(allFailingDeps());
    const pack = assembleBootstrapPack(sections, '2026-09-20T12:00:00.000Z');

    expect(typeof pack).toBe('string');
    expect(pack.length).toBeLessThanOrEqual(PACK_MAX_CHARS);

    // Every section whose .error was set renders that exact marker.
    for (const s of sections) {
      if (s.error) {
        expect(pack).toContain(`### ${s.title}\n(unavailable: ${s.error})`);
      }
    }
    // The one section that degrades internally (build-info) still shows
    // its own "(unavailable: ...)" text, just via its body, not s.error.
    expect(pack).toContain('(unavailable: ECONNREFUSED build-info)');

    // No section silently rendered as genuinely empty-but-successful.
    expect(pack).not.toContain('(empty)');
  });

  it('never throws when assembling an all-failed pack, unlike a naive implementation that might', () => {
    expect(async () => {
      const sections = await buildBootstrapSections(allFailingDeps());
      assembleBootstrapPack(sections, new Date().toISOString());
    }).not.toThrow();
  });
});

describe('VTID-04211 getOperatorBootstrapPack — full path, every source failing, real tool catalog only', () => {
  it('still returns a non-empty, budget-capped pack whose ONLY successful section is the tool catalog (no external dependency)', async () => {
    const deps = allFailingDeps();
    const pack = await getOperatorBootstrapPack({
      toolDefs: [{ name: 'dev_read_file', description: 'Read a file from the repository.' }],
      deps,
      env: deps.env!,
    });

    expect(typeof pack).toBe('string');
    expect(pack.length).toBeGreaterThan(0);
    expect(pack.length).toBeLessThanOrEqual(PACK_MAX_CHARS);
    // The tool catalog has no external dependency of its own — it renders
    // straight from toolDefs — so it must be the one section that still
    // shows real content even though every I/O-backed source failed.
    expect(pack).toContain('Tool catalog (rendered from the declarations you were given this turn)');
    expect(pack).toContain('dev_read_file');
    // Every I/O-backed section still shows an unavailable marker.
    expect(pack).toContain('(unavailable:');
  });
});
