// VTID-03158 — unit tests for the typed vtid_ledger reader added in
// `services/gateway/src/services/vtid-ledger-reader.ts`.
//
// Contract under test:
//   - `getActiveVTIDs(tenantId, limit?)`
//       * env guard: returns [] when SUPABASE_URL / SUPABASE_SERVICE_ROLE
//         is missing
//       * URL contract: filters `status=in.(in-progress,scheduled,planned)`,
//         orders by `created_at.desc`, applies the caller's limit
//       * HTTP non-ok → returns []
//       * HTTP ok → maps rows; `title` falls back to `vtid` when null
//   - `getDeveloperActiveTasks({limit?})`
//       * env guard: returns []
//       * URL contract: selects vtid/title/status, filters
//         `status=in.(in_progress,scheduled,allocated)` + `is_terminal=is.false`,
//         orders by `updated_at.desc`, applies the caller's limit (default 5)
//       * HTTP non-ok → returns []
//       * HTTP ok → maps rows

import {
  getActiveVTIDs,
  getDeveloperActiveTasks,
} from '../../src/services/vtid-ledger-reader';

const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('VTID-03158 getActiveVTIDs', () => {
  it('returns [] when SUPABASE env vars are missing', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      const r = await getActiveVTIDs('tenant-x');
      expect(r).toEqual([]);
      expect(mockedFetch).not.toHaveBeenCalled();
    } finally {
      process.env.SUPABASE_URL = prevUrl;
    }
  });

  it('builds the canonical URL — status, order, default limit=5', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => [],
    } as any);
    await getActiveVTIDs('tenant-x');
    const [url] = mockedFetch.mock.calls[0];
    const u = String(url);
    expect(u).toContain('/rest/v1/vtid_ledger');
    expect(u).toContain('status=in.(in-progress,scheduled,planned)');
    expect(u).toContain('order=created_at.desc');
    expect(u).toContain('limit=5');
  });

  it('honors the caller-provided limit', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => [],
    } as any);
    await getActiveVTIDs('tenant-x', 12);
    const [url] = mockedFetch.mock.calls[0];
    expect(String(url)).toContain('limit=12');
  });

  it('returns [] when REST returns non-ok', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false, status: 502, json: async () => ({}),
    } as any);
    const r = await getActiveVTIDs('tenant-x');
    expect(r).toEqual([]);
  });

  it('maps row fields; title falls back to vtid when missing', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { vtid: 'VTID-01', title: 'first', status: 'in-progress', priority: 'high' },
        { vtid: 'VTID-02', title: '', status: 'scheduled' },
        { vtid: 'VTID-03', status: 'planned' },
      ],
    } as any);
    const r = await getActiveVTIDs('tenant-x');
    expect(r).toEqual([
      { vtid: 'VTID-01', title: 'first', status: 'in-progress', priority: 'high' },
      { vtid: 'VTID-02', title: 'VTID-02', status: 'scheduled', priority: undefined },
      { vtid: 'VTID-03', title: 'VTID-03', status: 'planned', priority: undefined },
    ]);
  });

  it('returns [] when fetch throws (error-tolerant)', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('network'));
    const r = await getActiveVTIDs('tenant-x');
    expect(r).toEqual([]);
  });
});

describe('VTID-03158 getDeveloperActiveTasks', () => {
  it('returns [] when env is missing', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      const r = await getDeveloperActiveTasks();
      expect(r).toEqual([]);
      expect(mockedFetch).not.toHaveBeenCalled();
    } finally {
      process.env.SUPABASE_URL = prevUrl;
    }
  });

  it('builds the canonical URL — narrow status set, is_terminal=false, updated_at order, default limit=5', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => [],
    } as any);
    await getDeveloperActiveTasks();
    const [url] = mockedFetch.mock.calls[0];
    const u = String(url);
    expect(u).toContain('/rest/v1/vtid_ledger');
    expect(u).toContain('select=vtid,title,status');
    expect(u).toContain('status=in.(in_progress,scheduled,allocated)');
    expect(u).toContain('is_terminal=is.false');
    expect(u).toContain('order=updated_at.desc');
    expect(u).toContain('limit=5');
  });

  it('honors the caller-provided limit', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => [],
    } as any);
    await getDeveloperActiveTasks({ limit: 9 });
    const [url] = mockedFetch.mock.calls[0];
    expect(String(url)).toContain('limit=9');
  });

  it('returns [] on non-ok', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false, status: 401, json: async () => ({}),
    } as any);
    const r = await getDeveloperActiveTasks();
    expect(r).toEqual([]);
  });

  it('maps row fields; title falls back to vtid when missing', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { vtid: 'VTID-99', title: 'final', status: 'in_progress' },
        { vtid: 'VTID-100', status: 'scheduled' },
      ],
    } as any);
    const r = await getDeveloperActiveTasks();
    expect(r).toEqual([
      { vtid: 'VTID-99', title: 'final', status: 'in_progress' },
      { vtid: 'VTID-100', title: 'VTID-100', status: 'scheduled' },
    ]);
  });
});
