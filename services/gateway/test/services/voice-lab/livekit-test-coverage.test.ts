/**
 * VTID-03025: parity coverage between `tool-manifest.json` and
 * `livekit_test_cases` — tests for `loadToolManifest()` (fs read + TTL
 * cache) and `getCoverage()` (the surface/coverage aggregation itself).
 *
 * `fs` and Supabase are both mocked at the module boundary. Because
 * `loadToolManifest()` keeps a module-scoped 60s cache, every test that
 * needs a distinct manifest fixture resets the module registry and
 * re-requires the module under test fresh.
 */

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

const mockGetSupabase = jest.fn();
jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

type Row = { expected: unknown; enabled: boolean };

function makeCasesSupabase(rows: Row[], error: { message: string } | null = null) {
  const eq = jest.fn().mockResolvedValue({ data: rows, error });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  return { from, select, eq };
}

/** Fresh require of the module under test — needed to reset its internal
 *  `cached` manifest variable between tests with different fixtures. */
function freshModule() {
  return require('../../../src/services/voice-lab/livekit-test-coverage') as typeof import('../../../src/services/voice-lab/livekit-test-coverage');
}

beforeEach(() => {
  jest.resetModules();
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockGetSupabase.mockReset();
});

describe('loadToolManifest', () => {
  it('parses and returns the manifest JSON when the file exists', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ generated_at: '2026-01-01T00:00:00Z', total: 1, tools: [{ name: 'x' }] }),
    );
    const { loadToolManifest } = freshModule();
    const manifest = loadToolManifest();
    expect(manifest.generated_at).toBe('2026-01-01T00:00:00Z');
    expect(manifest.tools).toEqual([{ name: 'x' }]);
  });

  it('caches within the TTL window — a second call does not re-read the file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tools: [{ name: 'a' }] }));
    const { loadToolManifest } = freshModule();
    loadToolManifest();
    loadToolManifest();
    loadToolManifest();
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('fails open with an empty tool list when no candidate path exists', () => {
    mockExistsSync.mockReturnValue(false);
    const { loadToolManifest } = freshModule();
    const manifest = loadToolManifest();
    expect(manifest).toEqual({ tools: [] });
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('does not throw when the manifest file contains invalid JSON — degrades to empty manifest', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{not valid json');
    const { loadToolManifest } = freshModule();
    expect(() => loadToolManifest()).not.toThrow();
    expect(loadToolManifest()).toEqual({ tools: [] });
  });
});

describe('getCoverage', () => {
  const TEST_MANIFEST = {
    generated_at: '2026-02-02T00:00:00Z',
    total: 5,
    tools: [
      { name: 'tool_live_a', surface: 'orb', status: 'live', wired_in: ['orb'] },
      { name: 'tool_live_b', surface: 'orb', status: 'live', wired_in: [] },
      { name: 'tool_live_c', surface: 'ops', status: 'live' },
      { name: 'tool_wip', surface: 'orb', status: 'wip' },
      { name: 'tool_planned', surface: 'ops', status: 'planned' },
    ],
  };

  function withManifest() {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(TEST_MANIFEST));
  }

  it('throws when Supabase is not configured', async () => {
    withManifest();
    mockGetSupabase.mockReturnValue(null);
    const { getCoverage } = freshModule();
    await expect(getCoverage()).rejects.toThrow('Supabase client not configured');
  });

  it('throws with the underlying message on a query error', async () => {
    withManifest();
    const sb = makeCasesSupabase([], { message: 'connection reset' });
    mockGetSupabase.mockReturnValue(sb);
    const { getCoverage } = freshModule();
    await expect(getCoverage()).rejects.toThrow('connection reset');
  });

  it('only counts tools with status "live"; wip/planned tools are excluded from every total', async () => {
    withManifest();
    const sb = makeCasesSupabase([]);
    mockGetSupabase.mockReturnValue(sb);
    const { getCoverage } = freshModule();
    const report = await getCoverage();
    expect(report.live_total).toBe(3);
    expect(report.manifest_total).toBe(5);
  });

  it('computes tested/uncovered/coverage_pct/surfaces/orphans from the union of tools[] and tools_any[]', async () => {
    withManifest();
    const rows: Row[] = [
      { expected: { tools: ['tool_live_a'] }, enabled: true },
      { expected: { tools_any: ['tool_live_c', 'tool_orphan_not_in_manifest'] }, enabled: true },
      // malformed rows must be skipped, not crash the aggregation
      { expected: null, enabled: true },
      { expected: 'not-an-object' as unknown, enabled: true },
    ];
    const sb = makeCasesSupabase(rows);
    mockGetSupabase.mockReturnValue(sb);
    const { getCoverage } = freshModule();
    const report = await getCoverage();

    expect(report.tested_total).toBe(2); // tool_live_a + tool_live_c (both live)
    expect(report.uncovered_total).toBe(1); // tool_live_b
    expect(report.uncovered).toEqual([{ name: 'tool_live_b', surface: 'orb', wired_in: [] }]);
    expect(report.coverage_pct).toBe(67); // round(2/3 * 100)
    expect(report.orphan_tested).toEqual(['tool_orphan_not_in_manifest']);

    const bySurface = Object.fromEntries(report.surfaces.map((s) => [s.surface, s]));
    expect(bySurface.orb).toEqual({ surface: 'orb', live: 2, tested: 1 });
    expect(bySurface.ops).toEqual({ surface: 'ops', live: 1, tested: 1 });
    // Sorted by live count descending.
    expect(report.surfaces[0].surface).toBe('orb');
  });

  it('queries only enabled=true rows', async () => {
    withManifest();
    const sb = makeCasesSupabase([]);
    mockGetSupabase.mockReturnValue(sb);
    const { getCoverage } = freshModule();
    await getCoverage();
    expect(sb.from).toHaveBeenCalledWith('livekit_test_cases');
    expect(sb.eq).toHaveBeenCalledWith('enabled', true);
  });

  it('coverage_pct is 0 (not NaN/Infinity) when there are zero live tools', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ tools: [{ name: 'x', status: 'wip' }] }));
    const sb = makeCasesSupabase([{ expected: { tools: ['x'] }, enabled: true }]);
    mockGetSupabase.mockReturnValue(sb);
    const { getCoverage } = freshModule();
    const report = await getCoverage();
    expect(report.live_total).toBe(0);
    expect(report.coverage_pct).toBe(0);
  });

  it('full coverage (100%) reports zero uncovered tools', async () => {
    withManifest();
    const rows: Row[] = [
      { expected: { tools: ['tool_live_a', 'tool_live_b'] }, enabled: true },
      { expected: { tools_any: ['tool_live_c'] }, enabled: true },
    ];
    const sb = makeCasesSupabase(rows);
    mockGetSupabase.mockReturnValue(sb);
    const { getCoverage } = freshModule();
    const report = await getCoverage();
    expect(report.coverage_pct).toBe(100);
    expect(report.uncovered).toEqual([]);
    expect(report.uncovered_total).toBe(0);
  });

  it('treats null `rows` from Supabase as an empty set rather than throwing', async () => {
    withManifest();
    const sb = makeCasesSupabase(null as unknown as Row[]);
    mockGetSupabase.mockReturnValue(sb);
    const { getCoverage } = freshModule();
    const report = await getCoverage();
    expect(report.tested_total).toBe(0);
    expect(report.uncovered_total).toBe(3);
  });
});
