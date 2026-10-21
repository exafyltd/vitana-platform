// Awareness Watchdogs (VTID-02859) — unit tests
//
// Scope:
//   1. getWatchdogManifest() — static manifest integrity (unique ids, each
//      watchdog covers real signal keys).
//   2. getWatchdogStatuses() — the telemetry join against oasis_events:
//      no-supabase fallback, per-topic pass/fail verdicts, "most recent
//      wins" selection, the unique-topic query shape, and the no-topic
//      ("manual probe required") branch.

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: any[]) => mockGetSupabase(...args),
}));

import { getWatchdogManifest, getWatchdogStatuses } from '../../src/services/awareness-watchdogs';

interface OasisRow {
  topic: string;
  created_at: string;
}

/** Builds a fake Supabase client whose oasis_events query resolves with `rows`,
 *  recording the exact filter args passed to `.in()` / `.gte()`. */
function createSupabaseMock(rows: OasisRow[]) {
  const inMock = jest.fn(() => chain);
  const gteMock = jest.fn(() => chain);
  const orderMock = jest.fn(() => chain);
  const limitMock = jest.fn(() => Promise.resolve({ data: rows, error: null }));
  const selectMock = jest.fn(() => chain);
  const chain: any = { select: selectMock, in: inMock, gte: gteMock, order: orderMock, limit: limitMock };
  const fromMock = jest.fn(() => chain);
  return { from: fromMock, _mocks: { fromMock, selectMock, inMock, gteMock, orderMock, limitMock } };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Manifest integrity
// ---------------------------------------------------------------------------

describe('getWatchdogManifest', () => {
  it('returns exactly the 10 documented watchdogs with unique ids', () => {
    const manifest = getWatchdogManifest();
    expect(manifest.length).toBe(10);
    const ids = manifest.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('identity_lock_active watches the three identity-lock signal keys', () => {
    const w = getWatchdogManifest().find((x) => x.id === 'identity_lock_active');
    expect(w).toBeDefined();
    expect(w?.watches).toEqual(['identity.user_id', 'identity.tenant_id', 'identity.active_role']);
    expect(w?.oasis_topic).toBe('vtid.live.session.start');
  });

  it('watchdogs without an oasis_topic exist (manual-probe-required watchdogs)', () => {
    const manifest = getWatchdogManifest();
    const noTopic = manifest.filter((w) => !w.oasis_topic);
    const ids = noTopic.map((w) => w.id).sort();
    expect(ids).toEqual(['conversation_history_reconnect', 'conversation_summary', 'proactive_opener_override']);
  });
});

// ---------------------------------------------------------------------------
// 2. getWatchdogStatuses() — no supabase
// ---------------------------------------------------------------------------

describe('getWatchdogStatuses — no supabase available', () => {
  it('every watchdog with an oasis_topic reports FAIL (no telemetry reachable), never PASS', async () => {
    mockGetSupabase.mockReturnValue(null);
    const statuses = await getWatchdogStatuses();

    expect(statuses.length).toBe(10);
    const withTopic = statuses.filter((s) => s.watchdog.oasis_topic);
    expect(withTopic.length).toBeGreaterThan(0);
    for (const s of withTopic) {
      expect(s.verdict).toBe('fail');
      expect(s.last_run_at).toBeNull();
    }
  });

  it('watchdogs with no oasis_topic report UNKNOWN with the manual-probe summary', async () => {
    mockGetSupabase.mockReturnValue(null);
    const statuses = await getWatchdogStatuses();

    const summary = statuses.find((s) => s.watchdog.id === 'conversation_summary');
    expect(summary?.verdict).toBe('unknown');
    expect(summary?.last_result_summary).toBe('No telemetry topic configured — manual probe required.');
    expect(summary?.last_run_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. getWatchdogStatuses() — with supabase + telemetry rows
// ---------------------------------------------------------------------------

describe('getWatchdogStatuses — with telemetry', () => {
  it('queries the deduplicated union of oasis_topics across all watchdogs (3 unique)', async () => {
    const sb = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(sb);

    await getWatchdogStatuses();

    expect(sb._mocks.fromMock).toHaveBeenCalledWith('oasis_events');
    const [, topicsArg] = sb._mocks.inMock.mock.calls[0];
    expect(topicsArg.sort()).toEqual(
      ['orb.live.tool.executed', 'orb.navigator.consulted', 'vtid.live.session.start'].sort(),
    );
  });

  it('a watchdog whose topic has a recent row within 24h reports PASS with that timestamp', async () => {
    const sb = createSupabaseMock([{ topic: 'vtid.live.session.start', created_at: '2026-07-20T10:00:00.000Z' }]);
    mockGetSupabase.mockReturnValue(sb);

    const statuses = await getWatchdogStatuses();
    const identity = statuses.find((s) => s.watchdog.id === 'identity_lock_active');

    expect(identity?.verdict).toBe('pass');
    expect(identity?.last_run_at).toBe('2026-07-20T10:00:00.000Z');
    expect(identity?.last_result_summary).toContain('vtid.live.session.start');
  });

  it('all watchdogs sharing a topic get the same pass verdict from a single row', async () => {
    const sb = createSupabaseMock([{ topic: 'vtid.live.session.start', created_at: '2026-07-20T10:00:00.000Z' }]);
    mockGetSupabase.mockReturnValue(sb);

    const statuses = await getWatchdogStatuses();
    const sharing = statuses.filter((s) => s.watchdog.oasis_topic === 'vtid.live.session.start');
    // identity_lock_active, environment_context_geo, memory_facts_injected,
    // temporal_journey_block, health_pillar_data all share this topic.
    expect(sharing.length).toBe(5);
    for (const s of sharing) expect(s.verdict).toBe('pass');
  });

  it('picks the FIRST (most recent, per query ordering) row per topic when duplicates are returned', async () => {
    const sb = createSupabaseMock([
      { topic: 'vtid.live.session.start', created_at: '2026-07-20T12:00:00.000Z' },
      { topic: 'vtid.live.session.start', created_at: '2026-07-19T08:00:00.000Z' },
    ]);
    mockGetSupabase.mockReturnValue(sb);

    const statuses = await getWatchdogStatuses();
    const identity = statuses.find((s) => s.watchdog.id === 'identity_lock_active');
    expect(identity?.last_run_at).toBe('2026-07-20T12:00:00.000Z');
  });

  it('a watchdog whose topic has NO row in the window reports FAIL with a window-hours summary', async () => {
    // Only navigator's topic has data; surface_scoping's topic (orb.live.tool.executed) does not.
    const sb = createSupabaseMock([{ topic: 'orb.navigator.consulted', created_at: '2026-07-20T10:00:00.000Z' }]);
    mockGetSupabase.mockReturnValue(sb);

    const statuses = await getWatchdogStatuses();
    const surfaceScoping = statuses.find((s) => s.watchdog.id === 'surface_scoping');

    expect(surfaceScoping?.verdict).toBe('fail');
    expect(surfaceScoping?.last_run_at).toBeNull();
    expect(surfaceScoping?.last_result_summary).toContain('orb.live.tool.executed');
    expect(surfaceScoping?.last_result_summary).toContain('24h');
  });

  it('navigator_policy_section passes independently on its own distinct topic', async () => {
    const sb = createSupabaseMock([{ topic: 'orb.navigator.consulted', created_at: '2026-07-20T09:00:00.000Z' }]);
    mockGetSupabase.mockReturnValue(sb);

    const statuses = await getWatchdogStatuses();
    const nav = statuses.find((s) => s.watchdog.id === 'navigator_policy_section');
    expect(nav?.verdict).toBe('pass');
    expect(nav?.last_run_at).toBe('2026-07-20T09:00:00.000Z');
  });
});
