/**
 * VTID-03895: a dev_autopilot_executions terminal status (completed/failed/
 * cancelled) must propagate to the vtid_ledger row the Operator on-ramp
 * activated it for, via applyExecTerminalSideEffects() — the single shared
 * choke point every status-changing call site in dev-autopilot-execute.ts
 * and dev-autopilot-watcher.ts already routes through (see its own
 * VTID-AUTOPILOT-DUPMERGE docstring).
 *
 * Before this, nothing ever wrote is_terminal/terminal_outcome for an
 * on-ramp execution's own VTID, so Task Management's board showed the card
 * stuck IN_PROGRESS forever even after a clean merge+deploy. These tests
 * pin: the PATCH shape and mapping per status, that autonomous-plane
 * findings (no activated_vtid) are correctly left untouched, that the
 * is_terminal=eq.false guard is always present in the request URL, and that
 * cancelExecution() (which PATCHes dev_autopilot_executions directly,
 * bypassing patchExecution()) still reaches this path.
 */

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
  cicdEvents: {
    vtidLifecycleCompleted: jest.fn().mockResolvedValue(undefined),
    vtidLifecycleFailed: jest.fn().mockResolvedValue(undefined),
  },
}));

import { applyExecTerminalSideEffects, cancelExecution } from '../src/services/dev-autopilot-execute';
import { emitOasisEvent, cicdEvents } from '../src/services/oasis-event-service';

const mockedEmitOasisEvent = emitOasisEvent as jest.Mock;
const mockedVtidLifecycleCompleted = cicdEvents.vtidLifecycleCompleted as jest.Mock;
const mockedVtidLifecycleFailed = cicdEvents.vtidLifecycleFailed as jest.Mock;

const ORIGINAL_ENV = process.env;
const EXECUTION_ID = 'exec-1111-2222-3333-444444444444';
const FINDING_ID = 'finding-aaaa-bbbb-cccc-dddddddddddd';

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as any;
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('VTID-03895: terminalizeVtidLedgerForExecution (via applyExecTerminalSideEffects)', () => {
  let calls: Array<{ url: string; init: any }>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE: 'test-key' };
    calls = [];
    mockedEmitOasisEvent.mockClear();
    mockedVtidLifecycleCompleted.mockClear();
    mockedVtidLifecycleFailed.mockClear();
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes('/dev_autopilot_executions?')) {
        return jsonRes(200, [{ finding_id: FINDING_ID }]);
      }
      if (u.includes('/autopilot_recommendations?')) {
        return jsonRes(200, [{ activated_vtid: 'VTID-09999' }]);
      }
      if (u.includes('/vtid_ledger?')) {
        return jsonRes(200, []);
      }
      return jsonRes(200, []);
    }) as any;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('completed: PATCHes vtid_ledger with is_terminal=true, terminal_outcome=success, and emits vtidLifecycleCompleted', async () => {
    applyExecTerminalSideEffects({ url: process.env.SUPABASE_URL!, key: process.env.SUPABASE_SERVICE_ROLE! }, EXECUTION_ID, 'completed');
    await flush();

    const ledgerCall = calls.find((c) => c.url.includes('/vtid_ledger?'));
    expect(ledgerCall).toBeDefined();
    expect(ledgerCall!.url).toContain('vtid=eq.VTID-09999');
    expect(ledgerCall!.url).toContain('is_terminal=eq.false');
    expect(ledgerCall!.init.method).toBe('PATCH');
    expect(JSON.parse(ledgerCall!.init.body)).toEqual({
      is_terminal: true,
      terminal_outcome: 'success',
      status: 'completed',
    });

    expect(mockedVtidLifecycleCompleted).toHaveBeenCalledWith(
      'VTID-09999',
      'operator',
      expect.stringContaining(EXECUTION_ID.slice(0, 8)),
    );
    expect(mockedVtidLifecycleFailed).not.toHaveBeenCalled();
  });

  it('failed: terminal_outcome/status = failed, emits vtidLifecycleFailed', async () => {
    applyExecTerminalSideEffects({ url: process.env.SUPABASE_URL!, key: process.env.SUPABASE_SERVICE_ROLE! }, EXECUTION_ID, 'failed');
    await flush();

    const ledgerCall = calls.find((c) => c.url.includes('/vtid_ledger?'));
    expect(JSON.parse(ledgerCall!.init.body)).toEqual({
      is_terminal: true,
      terminal_outcome: 'failed',
      status: 'failed',
    });
    expect(mockedVtidLifecycleFailed).toHaveBeenCalledWith('VTID-09999', 'operator', expect.any(String));
    expect(mockedVtidLifecycleCompleted).not.toHaveBeenCalled();
  });

  it('cancelled: terminal_outcome/status = cancelled, emits vtidLifecycleFailed (not a success outcome)', async () => {
    applyExecTerminalSideEffects({ url: process.env.SUPABASE_URL!, key: process.env.SUPABASE_SERVICE_ROLE! }, EXECUTION_ID, 'cancelled');
    await flush();

    const ledgerCall = calls.find((c) => c.url.includes('/vtid_ledger?'));
    expect(JSON.parse(ledgerCall!.init.body)).toEqual({
      is_terminal: true,
      terminal_outcome: 'cancelled',
      status: 'cancelled',
    });
    expect(mockedVtidLifecycleFailed).toHaveBeenCalledTimes(1);
  });

  it('never PATCHes vtid_ledger for a status other than completed/failed/cancelled', async () => {
    for (const status of ['queued', 'cooling', 'running', 'ci', 'merging', 'deploying', 'verifying', 'reverted', 'self_healed', 'failed_escalated']) {
      applyExecTerminalSideEffects({ url: process.env.SUPABASE_URL!, key: process.env.SUPABASE_SERVICE_ROLE! }, EXECUTION_ID, status);
    }
    await flush();
    expect(calls.some((c) => c.url.includes('/vtid_ledger?'))).toBe(false);
  });

  it('autonomous-plane finding (no activated_vtid): looks up the recommendation but never PATCHes vtid_ledger', async () => {
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes('/dev_autopilot_executions?')) return jsonRes(200, [{ finding_id: FINDING_ID }]);
      if (u.includes('/autopilot_recommendations?')) return jsonRes(200, [{ activated_vtid: null }]);
      return jsonRes(200, []);
    }) as any;

    applyExecTerminalSideEffects({ url: process.env.SUPABASE_URL!, key: process.env.SUPABASE_SERVICE_ROLE! }, EXECUTION_ID, 'completed');
    await flush();

    expect(calls.some((c) => c.url.includes('/autopilot_recommendations?'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/vtid_ledger?'))).toBe(false);
    expect(mockedVtidLifecycleCompleted).not.toHaveBeenCalled();
  });

  it('missing finding_id on the execution row: bails before even looking up the recommendation', async () => {
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/dev_autopilot_executions?')) return jsonRes(200, [{ finding_id: null }]);
      return jsonRes(200, []);
    }) as any;

    applyExecTerminalSideEffects({ url: process.env.SUPABASE_URL!, key: process.env.SUPABASE_SERVICE_ROLE! }, EXECUTION_ID, 'completed');
    await flush();

    expect(calls.some((c) => c.url.includes('/autopilot_recommendations?'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/vtid_ledger?'))).toBe(false);
  });

  it('a failed vtid_ledger PATCH is logged, not thrown, and never crashes the caller', async () => {
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes('/dev_autopilot_executions?')) return jsonRes(200, [{ finding_id: FINDING_ID }]);
      if (u.includes('/autopilot_recommendations?')) return jsonRes(200, [{ activated_vtid: 'VTID-09999' }]);
      if (u.includes('/vtid_ledger?')) return jsonRes(500, { error: 'boom' });
      return jsonRes(200, []);
    }) as any;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      applyExecTerminalSideEffects({ url: process.env.SUPABASE_URL!, key: process.env.SUPABASE_SERVICE_ROLE! }, EXECUTION_ID, 'completed'),
    ).not.toThrow();
    await flush();

    expect(mockedVtidLifecycleCompleted).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('vtid_ledger terminalize failed'));
    warnSpy.mockRestore();
  });

  it('cancelExecution() (direct-PATCH path, bypassing patchExecution) also terminalizes vtid_ledger', async () => {
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes(`/dev_autopilot_executions?id=eq.${EXECUTION_ID}&status=eq.cooling`)) {
        return jsonRes(204, undefined);
      }
      if (u.includes('/dev_autopilot_executions?id=eq.') && u.includes('select=finding_id')) {
        return jsonRes(200, [{ finding_id: FINDING_ID }]);
      }
      if (u.includes('/autopilot_recommendations?')) return jsonRes(200, [{ activated_vtid: 'VTID-09999' }]);
      if (u.includes('/vtid_ledger?')) return jsonRes(200, []);
      return jsonRes(200, []);
    }) as any;

    const result = await cancelExecution(EXECUTION_ID);
    expect(result.ok).toBe(true);
    await flush();

    const ledgerCall = calls.find((c) => c.url.includes('/vtid_ledger?'));
    expect(ledgerCall).toBeDefined();
    expect(JSON.parse(ledgerCall!.init.body)).toEqual({
      is_terminal: true,
      terminal_outcome: 'cancelled',
      status: 'cancelled',
    });
  });
});
