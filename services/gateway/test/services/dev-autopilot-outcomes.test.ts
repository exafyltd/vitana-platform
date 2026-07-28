// Dev Autopilot Outcomes — write-through substrate for approve/auto-exec/
// reject/dismiss decisions and their eventual execution outcome.
//
// Scope:
//   1. Missing-config guard — no fetch calls at all when Supabase env vars
//      are unset.
//   2. recordOutcome(): looks up the finding, filters to dev_autopilot /
//      dev_autopilot_impact source_type, builds the insert payload
//      (scanner_name from spec_snapshot, defaults for optional fields),
//      and swallows insert failures.
//   3. recordExecOutcome(): finds the open outcome row (decision in
//      approved/auto_exec, exec_outcome null) and PATCHes it; no-ops when
//      none is found; never throws on network/JSON errors.

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

function loadModule() {
  // Re-require after env vars are set, since SUPABASE_URL/SUPABASE_SERVICE_ROLE
  // are read once at module load time into module-level consts.
  return require('../../src/services/dev-autopilot-outcomes') as typeof import('../../src/services/dev-autopilot-outcomes');
}

function setConfiguredEnv() {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
}

describe('dev-autopilot-outcomes — missing config', () => {
  it('recordOutcome makes no fetch calls when SUPABASE_URL is unset', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    const mockFetch = jest.fn();
    global.fetch = mockFetch as any;
    const { recordOutcome } = loadModule();

    await recordOutcome({ finding_id: 'f1', decision: 'approved' });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('recordExecOutcome makes no fetch calls when SUPABASE_SERVICE_ROLE is unset', async () => {
    process.env.SUPABASE_URL = 'https://supabase.test';
    delete process.env.SUPABASE_SERVICE_ROLE;
    const mockFetch = jest.fn();
    global.fetch = mockFetch as any;
    const { recordExecOutcome } = loadModule();

    await recordExecOutcome('f1', 'success');

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('dev-autopilot-outcomes — recordOutcome', () => {
  beforeEach(() => setConfiguredEnv());

  it('skips the insert when the finding cannot be found', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    global.fetch = mockFetch as any;
    const { recordOutcome } = loadModule();

    await recordOutcome({ finding_id: 'missing', decision: 'approved' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0][0] as string)).toContain('/rest/v1/autopilot_recommendations');
  });

  it('skips the insert when the finding source_type is neither dev_autopilot nor dev_autopilot_impact', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ source_type: 'community_analyzer', risk_class: null, impact_score: null, effort_score: null, spec_snapshot: null }],
    });
    global.fetch = mockFetch as any;
    const { recordOutcome } = loadModule();

    await recordOutcome({ finding_id: 'f1', decision: 'approved' });

    expect(mockFetch).toHaveBeenCalledTimes(1); // only the lookup, no insert
  });

  it('inserts a row for a dev_autopilot finding with scanner_name pulled from spec_snapshot', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.includes('/rest/v1/autopilot_recommendations')) {
        return {
          ok: true,
          json: async () => [
            {
              source_type: 'dev_autopilot',
              risk_class: 'low',
              impact_score: 5,
              effort_score: 2,
              spec_snapshot: { scanner: 'dead_code' },
            },
          ],
        };
      }
      return { ok: true, text: async () => '' };
    });
    global.fetch = mockFetch as any;
    const { recordOutcome } = loadModule();

    await recordOutcome({
      finding_id: 'f1',
      decision: 'auto_exec',
      approver_user_id: 'user-1',
      vtid: 'VTID-99999',
      human_modified_plan: true,
      reason: 'auto-approved',
      metadata: { foo: 'bar' },
    });

    expect(calls).toHaveLength(2);
    const insertCall = calls[1];
    expect(insertCall.url).toContain('/rest/v1/dev_autopilot_outcomes');
    expect(insertCall.init.method).toBe('POST');
    const body = JSON.parse(insertCall.init.body);
    expect(body).toEqual({
      finding_id: 'f1',
      scanner_name: 'dead_code',
      source_type: 'dev_autopilot',
      risk_class: 'low',
      impact_score: 5,
      effort_score: 2,
      decision: 'auto_exec',
      approver_user_id: 'user-1',
      vtid: 'VTID-99999',
      human_modified_plan: true,
      reason: 'auto-approved',
      metadata: { foo: 'bar' },
    });
  });

  it('accepts dev_autopilot_impact findings and defaults optional fields', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.includes('/rest/v1/autopilot_recommendations')) {
        return {
          ok: true,
          json: async () => [
            { source_type: 'dev_autopilot_impact', risk_class: null, impact_score: null, effort_score: null, spec_snapshot: null },
          ],
        };
      }
      return { ok: true, text: async () => '' };
    });
    global.fetch = mockFetch as any;
    const { recordOutcome } = loadModule();

    await recordOutcome({ finding_id: 'f2', decision: 'rejected' });

    const body = JSON.parse(calls[1].init.body);
    expect(body.scanner_name).toBe('unknown');
    expect(body.approver_user_id).toBeNull();
    expect(body.vtid).toBeNull();
    expect(body.human_modified_plan).toBe(false);
    expect(body.reason).toBeNull();
    expect(body.metadata).toEqual({});
  });

  it('swallows an insert failure without throwing', async () => {
    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/rest/v1/autopilot_recommendations')) {
        return {
          ok: true,
          json: async () => [{ source_type: 'dev_autopilot', risk_class: null, impact_score: null, effort_score: null, spec_snapshot: null }],
        };
      }
      return { ok: false, status: 500, text: async () => 'server error' };
    });
    global.fetch = mockFetch as any;
    const { recordOutcome } = loadModule();

    await expect(recordOutcome({ finding_id: 'f3', decision: 'dismissed' })).resolves.toBeUndefined();
  });

  it('swallows a thrown network error without propagating', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    global.fetch = mockFetch as any;
    const { recordOutcome } = loadModule();

    await expect(recordOutcome({ finding_id: 'f4', decision: 'demoted' })).resolves.toBeUndefined();
  });
});

describe('dev-autopilot-outcomes — recordExecOutcome', () => {
  beforeEach(() => setConfiguredEnv());

  it('no-ops when no open outcome row exists', async () => {
    const calls: string[] = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => [] };
    });
    global.fetch = mockFetch as any;
    const { recordExecOutcome } = loadModule();

    await recordExecOutcome('f1', 'success');

    expect(calls).toHaveLength(1); // only the find query, no PATCH
    expect(calls[0]).toContain('/rest/v1/dev_autopilot_outcomes');
    expect(calls[0]).toContain('exec_outcome=is.null');
    expect(calls[0]).toContain('decision=in.(approved,auto_exec)');
  });

  it('no-ops when the find query itself fails', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    global.fetch = mockFetch as any;
    const { recordExecOutcome } = loadModule();

    await expect(recordExecOutcome('f1', 'failure')).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('PATCHes the found row with exec_outcome + exec_completed_at, omitting vtid when not passed', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) {
        return { ok: true, json: async () => [{ id: 'outcome-1' }] };
      }
      return { ok: true, text: async () => '' };
    });
    global.fetch = mockFetch as any;
    const { recordExecOutcome } = loadModule();

    await recordExecOutcome('f5', 'success');

    expect(calls).toHaveLength(2);
    const patchCall = calls[1];
    expect(patchCall.url).toBe('https://supabase.test/rest/v1/dev_autopilot_outcomes?id=eq.outcome-1');
    expect(patchCall.init.method).toBe('PATCH');
    const body = JSON.parse(patchCall.init.body);
    expect(body.exec_outcome).toBe('success');
    expect(typeof body.exec_completed_at).toBe('string');
    expect(body).not.toHaveProperty('vtid');
  });

  it('includes vtid in the PATCH body when passed', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) {
        return { ok: true, json: async () => [{ id: 'outcome-2' }] };
      }
      return { ok: true, text: async () => '' };
    });
    global.fetch = mockFetch as any;
    const { recordExecOutcome } = loadModule();

    await recordExecOutcome('f6', 'timeout', 'VTID-11111');

    const body = JSON.parse(calls[1].init.body);
    expect(body.vtid).toBe('VTID-11111');
    expect(body.exec_outcome).toBe('timeout');
  });

  it('swallows a PATCH failure without throwing', async () => {
    const mockFetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
      if (!init || init.method === undefined) {
        return { ok: true, json: async () => [{ id: 'outcome-3' }] };
      }
      return { ok: false, status: 409, text: async () => 'conflict' };
    });
    global.fetch = mockFetch as any;
    const { recordExecOutcome } = loadModule();

    await expect(recordExecOutcome('f7', 'rolled_back')).resolves.toBeUndefined();
  });

  it('swallows a thrown network error without propagating', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('network down'));
    global.fetch = mockFetch as any;
    const { recordExecOutcome } = loadModule();

    await expect(recordExecOutcome('f8', 'success')).resolves.toBeUndefined();
  });
});
