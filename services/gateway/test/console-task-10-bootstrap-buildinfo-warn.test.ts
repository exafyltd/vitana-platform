/**
 * VTID-04173: the session bootstrap pack's build-info source no longer
 * degrades in silence when `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS` is unset.
 *
 * Pins: exactly one `console.warn` per PROCESS naming the env var (not one
 * per call/turn), no warning at all once the var is set, and no change to
 * the rendered pack in either case.
 */

import {
  MISSING_BUILD_INFO_ENV_NAME,
  buildBootstrapSections,
  getOperatorBootstrapPack,
  resetBootstrapPackCache,
  resetMissingBuildInfoEnvWarning,
  type BootstrapDeps,
} from '../src/services/operator-bootstrap-pack';

const TARGETS = 'staging=https://preview.example/build-info,prod=https://prod.example/build-info';

function deps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    readRepoFile: async (p) => (p === 'DATABASE_SCHEMA.md' ? '### vtid_ledger' : p === 'config/service-path-map.json' ? '{"svc":{"path":"services/svc"}}' : '# PART 1: CORE RULES\nrule'),
    listPlatformOpenPrs: async () => [],
    listFrontendOpenPrs: async () => [],
    queryRecentEvents: async () => [],
    fetchBuildInfo: async () => ({ env: 'staging', git_commit: 'abcdef1234567890', booted_at: '2026-09-20T10:00:00.000Z' }),
    ...overrides,
  };
}

/** Build the sections twice with a cold cache — two honest build-info builds. */
async function buildTwice(env: NodeJS.ProcessEnv): Promise<void> {
  await buildBootstrapSections({ ...deps(), env });
  await buildBootstrapSections({ ...deps(), env });
}

describe('VTID-04173 missing build-info env var warning', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    resetBootstrapPackCache();
    resetMissingBuildInfoEnvWarning();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('AC-1/AC-3: warns exactly once per process, naming the env var, across two calls', async () => {
    await buildTwice({});

    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(MISSING_BUILD_INFO_ENV_NAME);
    expect(lines[0]).toMatch(/unset or empty/i);
  });

  it('AC-1: an explicitly blank env var counts as unset', async () => {
    await buildTwice({ [MISSING_BUILD_INFO_ENV_NAME]: '   ' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(MISSING_BUILD_INFO_ENV_NAME);
  });

  it('AC-2: no warning at all when the env var is set, and behavior is unchanged', async () => {
    const sections = await buildBootstrapSections({ ...deps(), env: { [MISSING_BUILD_INFO_ENV_NAME]: TARGETS } });

    expect(warn).not.toHaveBeenCalled();
    expect(sections[4].title).toBe('Live build-info');
    expect(sections[4].body).toContain('- staging: env=staging commit=abcdef123456 booted=2026-09-20T10:00:00.000Z');
  });

  it('AC-2: the pack still renders the "(no build-info targets …)" line when unset', async () => {
    const sections = await buildBootstrapSections({ ...deps(), env: {} });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(sections[4].body).toContain('(no build-info targets configured — set OPERATOR_BOOTSTRAP_BUILD_INFO_URLS)');
  });

  it('AC-1: a per-turn warning does not reappear after the 5-minute cache expires', async () => {
    let now = 1_000_000;
    const env = { OPERATOR_BOOTSTRAP_PACK_ENABLED: 'true' };
    const d = deps({ now: () => now });
    await getOperatorBootstrapPack({ toolDefs: [], deps: d, env });
    now += 6 * 60_000; // past BOOTSTRAP_TTL_MS — the sections are rebuilt
    await getOperatorBootstrapPack({ toolDefs: [], deps: d, env });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(MISSING_BUILD_INFO_ENV_NAME);
  });
});
