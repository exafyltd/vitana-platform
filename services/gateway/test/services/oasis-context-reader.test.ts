// VTID-03158 — unit tests for the typed OASIS context reader.
//
// Contract under test:
//   - `getDeveloperOasisContext(options?)`
//       * env guard: returns null when SUPABASE_URL / SUPABASE_SERVICE_ROLE
//         missing (CPB then omits the oasis_context field)
//       * fans out 4 reads in parallel:
//           – vtid-ledger-reader.getDeveloperActiveTasks
//           – oasis_events `topic=like.cicd.deploy.service.*` (recent_deploys)
//           – oasis_events `topic=eq.cicd.github.safe_merge.evaluated`
//             status=info (pending_approvals_count)
//           – oasis_events `topic=like.self-healing.*` status=error within 24h
//             (self_healing_alerts)
//       * counts derive from .length of the matching response array
//       * recent_recommendations is always [] (developer block does not
//         surface autopilot recs)
//       * individual stream failures degrade to empty/zero
//   - `getCommunityOasisContext(userId, options?)`
//       * env guard: returns null when env missing or userId missing
//       * URL: `/rest/v1/autopilot_recommendations?select=title,status&user_id=...
//         &status=in.(activated,completed)&order=updated_at.desc&limit=<N>`
//       * non-ok / empty results → returns null (preserves the pre-VTID-03158
//         "only set oasis_context when recs.length > 0" gate)
//       * ok with rows → returns a block with all zero counts and recs mapped
//
// The community reader is exercised directly by mocking global.fetch.
// The developer reader piggybacks on vtid-ledger-reader; we mock that
// at module level to isolate the oasis_events fan-out.

jest.mock('../../src/services/vtid-ledger-reader', () => ({
  getDeveloperActiveTasks: jest.fn(),
}));

import {
  getDeveloperOasisContext,
  getCommunityOasisContext,
} from '../../src/services/oasis-context-reader';
import { getDeveloperActiveTasks } from '../../src/services/vtid-ledger-reader';

const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;
const mockedActiveTasks = getDeveloperActiveTasks as jest.MockedFunction<
  typeof getDeveloperActiveTasks
>;

beforeEach(() => {
  mockedFetch.mockReset();
  mockedActiveTasks.mockReset();
});

// ---------------------------------------------------------------------------
// getDeveloperOasisContext
// ---------------------------------------------------------------------------

describe('VTID-03158 getDeveloperOasisContext', () => {
  it('returns null when env is missing', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      const r = await getDeveloperOasisContext();
      expect(r).toBeNull();
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(mockedActiveTasks).not.toHaveBeenCalled();
    } finally {
      process.env.SUPABASE_URL = prevUrl;
    }
  });

  it('fans out 4 parallel reads + builds a typed block', async () => {
    mockedActiveTasks.mockResolvedValueOnce([
      { vtid: 'VTID-01', title: 'task', status: 'in_progress' },
    ]);
    // Three sequential fetch calls in deterministic order from Promise.all:
    //   1. deploys, 2. approvals, 3. healing
    mockedFetch.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('topic=like.cicd.deploy.service.*')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { service: 'gateway', status: 'success', created_at: '2026-05-25T12:00:00Z' },
            { service: 'agents', status: 'failure', created_at: '2026-05-25T10:00:00Z' },
          ],
        } as any;
      }
      if (u.includes('topic=eq.cicd.github.safe_merge.evaluated')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: '1' }, { id: '2' }, { id: '3' }],
        } as any;
      }
      if (u.includes('topic=like.self-healing.*')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'a' }, { id: 'b' }],
        } as any;
      }
      throw new Error(`unexpected URL: ${u}`);
    });

    const block = await getDeveloperOasisContext();
    expect(block).not.toBeNull();
    expect(block!.active_tasks).toHaveLength(1);
    expect(block!.recent_deploys).toEqual([
      { service: 'gateway', status: 'success', created_at: '2026-05-25T12:00:00Z' },
      { service: 'agents', status: 'failure', created_at: '2026-05-25T10:00:00Z' },
    ]);
    expect(block!.pending_approvals_count).toBe(3);
    expect(block!.self_healing_alerts).toBe(2);
    expect(block!.recent_recommendations).toEqual([]);
  });

  it('URL contract: 24h self-healing window + limit=50 + correct topics', async () => {
    mockedActiveTasks.mockResolvedValueOnce([]);
    mockedFetch.mockImplementation(async () => ({
      ok: true, status: 200, json: async () => [],
    } as any));
    await getDeveloperOasisContext();
    const urls = mockedFetch.mock.calls.map(c => String(c[0]));
    const deploys = urls.find(u => u.includes('cicd.deploy.service'));
    const approvals = urls.find(u => u.includes('safe_merge.evaluated'));
    const healing = urls.find(u => u.includes('self-healing'));
    expect(deploys).toBeDefined();
    expect(deploys!).toMatch(/order=created_at\.desc.*limit=3/);
    expect(approvals!).toMatch(/status=eq\.info.*limit=20/);
    expect(healing!).toMatch(/status=eq\.error/);
    expect(healing!).toMatch(/limit=50/);
    // 24h window: 'created_at=gte.' followed by an ISO timestamp <= now
    expect(healing!).toMatch(/created_at=gte\.\d{4}-\d{2}-\d{2}T/);
  });

  it('degrades stream failures to empty/zero without throwing', async () => {
    mockedActiveTasks.mockResolvedValueOnce([
      { vtid: 'VTID-77', title: 'survives', status: 'in_progress' },
    ]);
    mockedFetch.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('self-healing')) {
        // healing stream throws → degrades to 0
        throw new Error('boom');
      }
      if (u.includes('safe_merge.evaluated')) {
        return { ok: false, status: 500, json: async () => ({}) } as any;
      }
      return { ok: true, status: 200, json: async () => [] } as any;
    });
    const block = await getDeveloperOasisContext();
    expect(block).not.toBeNull();
    expect(block!.active_tasks).toHaveLength(1);
    expect(block!.pending_approvals_count).toBe(0);
    expect(block!.self_healing_alerts).toBe(0);
  });

  it('forwards activeTasksLimit option to vtid-ledger-reader', async () => {
    mockedActiveTasks.mockResolvedValueOnce([]);
    mockedFetch.mockImplementation(async () => ({
      ok: true, status: 200, json: async () => [],
    } as any));
    await getDeveloperOasisContext({ activeTasksLimit: 12 });
    expect(mockedActiveTasks).toHaveBeenCalledWith({ limit: 12 });
  });
});

// ---------------------------------------------------------------------------
// getCommunityOasisContext
// ---------------------------------------------------------------------------

describe('VTID-03158 getCommunityOasisContext', () => {
  it('returns null when userId is missing', async () => {
    const r = await getCommunityOasisContext(null);
    expect(r).toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns null when env is missing', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      const r = await getCommunityOasisContext('user-1');
      expect(r).toBeNull();
    } finally {
      process.env.SUPABASE_URL = prevUrl;
    }
  });

  it('builds the canonical URL — user_id, status filter, default limit=3', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => [],
    } as any);
    await getCommunityOasisContext('user-1');
    const [url] = mockedFetch.mock.calls[0];
    const u = String(url);
    expect(u).toContain('/rest/v1/autopilot_recommendations');
    expect(u).toContain('select=title,status');
    expect(u).toContain('user_id=eq.user-1');
    expect(u).toContain('status=in.(activated,completed)');
    expect(u).toContain('order=updated_at.desc');
    expect(u).toContain('limit=3');
  });

  it('returns null when no rows are found (preserves the legacy gate)', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => [],
    } as any);
    const r = await getCommunityOasisContext('user-1');
    expect(r).toBeNull();
  });

  it('returns null on non-ok HTTP', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false, status: 502, json: async () => ({}),
    } as any);
    const r = await getCommunityOasisContext('user-1');
    expect(r).toBeNull();
  });

  it('returns a typed block with zeroed dev counts when recs exist', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { title: 'Activated rec', status: 'activated' },
        { title: 'Completed rec', status: 'completed' },
      ],
    } as any);
    const r = await getCommunityOasisContext('user-1');
    expect(r).toEqual({
      active_tasks: [],
      recent_deploys: [],
      pending_approvals_count: 0,
      self_healing_alerts: 0,
      recent_recommendations: [
        { title: 'Activated rec', status: 'activated' },
        { title: 'Completed rec', status: 'completed' },
      ],
    });
  });

  it('honors the caller-provided limit', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => [],
    } as any);
    await getCommunityOasisContext('user-1', { limit: 7 });
    const [url] = mockedFetch.mock.calls[0];
    expect(String(url)).toContain('limit=7');
  });
});
