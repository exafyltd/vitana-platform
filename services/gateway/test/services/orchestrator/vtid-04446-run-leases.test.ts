/**
 * VTID-04446 — Orchestrator v2 P4: run leases + stage-loop stall detection.
 *
 * AC-1 With ORCHESTRATOR_RUN_LEASE_ENABLED unset nothing reads or writes a
 *      lease and the watchdog keeps the legacy 20-minute rule.
 * AC-2 A live lease is never reclaimed, however stale updated_at is; an
 *      expired lease is reclaimed; no lease → the legacy rule.
 * AC-3 The claim writes a lease with the legacy window; the heartbeat renews
 *      it to the TTL; the end of the running phase releases it.
 * AC-4 The sweep closes expired leases whose execution already left running,
 *      and only those.
 * AC-5 The stage tool loop re-plans once after repeated identical calls and
 *      then forces the tool-less final answer with `stalled: true`.
 * AC-6 The migration is additive: an index and the view's mirror filter,
 *      no table created or altered.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_RUN_LEASE_TTL_MS,
  LEGACY_STUCK_EXECUTION_MS,
  MAX_RUN_LEASE_TTL_MS,
  MIN_RUN_LEASE_TTL_MS,
  acquireDevRunLease,
  buildDevRunLeaseRow,
  decideWatchdogReclaim,
  devRunKey,
  isLeaseLive,
  isRunLeaseEnabled,
  leaseOwnerId,
  outcomeFromExecutionStatus,
  readDevRunLeases,
  releaseDevRunLease,
  releaseRequest,
  renewDevRunLease,
  renewRequest,
  runLeaseTtlMs,
  runPhaseOutcome,
  sweepOrphanDevRunLeases,
  watchdogCandidateWindowMs,
  type LeaseRest,
} from '../../../src/services/orchestrator/run-lease';
import { runStageToolLoop, STAGE_LOOP_REPLAN_PROMPT, type StageLlmCall } from '../../../src/services/llm-stage-tool-loop';
import { startExecutionHeartbeat } from '../../../src/services/autopilot-agent/agent-heartbeat';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const EXEC = '11111111-2222-4333-8444-555555555555';
const EXEC2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const ON = { ORCHESTRATOR_RUN_LEASE_ENABLED: 'true' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;
const NOW = new Date('2026-09-23T20:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

type Call = { path: string; init?: RequestInit };
function fakeRest(responses: Array<{ ok: boolean; data?: unknown; error?: string }> = []): { rest: LeaseRest; calls: Call[] } {
  const calls: Call[] = [];
  const rest = (async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const r = responses.shift() ?? { ok: true };
    return { ...r, status: r.ok ? 200 : 500 };
  }) as LeaseRest;
  return { rest, calls };
}

describe('VTID-04446 flag and configuration (AC-1)', () => {
  it('is off unless the flag is exactly "true"', () => {
    expect(isRunLeaseEnabled(OFF)).toBe(false);
    expect(isRunLeaseEnabled({ ORCHESTRATOR_RUN_LEASE_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isRunLeaseEnabled(ON)).toBe(true);
  });

  it('TTL defaults to 5 min and clamps to [2, 30] min', () => {
    expect(runLeaseTtlMs(OFF)).toBe(DEFAULT_RUN_LEASE_TTL_MS);
    expect(runLeaseTtlMs({ ORCHESTRATOR_RUN_LEASE_TTL_MS: 'x' } as NodeJS.ProcessEnv)).toBe(DEFAULT_RUN_LEASE_TTL_MS);
    expect(runLeaseTtlMs({ ORCHESTRATOR_RUN_LEASE_TTL_MS: '1000' } as NodeJS.ProcessEnv)).toBe(MIN_RUN_LEASE_TTL_MS);
    expect(runLeaseTtlMs({ ORCHESTRATOR_RUN_LEASE_TTL_MS: String(99 * 60_000) } as NodeJS.ProcessEnv)).toBe(MAX_RUN_LEASE_TTL_MS);
  });

  it('the watchdog candidate window is the legacy 20 min when off and the TTL when on', () => {
    expect(watchdogCandidateWindowMs(OFF)).toBe(LEGACY_STUCK_EXECUTION_MS);
    expect(watchdogCandidateWindowMs(ON)).toBe(DEFAULT_RUN_LEASE_TTL_MS);
  });

  it('flag off: acquire and renew make no call', async () => {
    const { rest, calls } = fakeRest();
    expect(await acquireDevRunLease(rest, { id: EXEC }, { env: OFF })).toBe(false);
    expect(await renewDevRunLease(rest, EXEC, { env: OFF })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('owner id names environment, host and process', () => {
    expect(leaseOwnerId({ VITANA_ENV: 'staging' } as NodeJS.ProcessEnv, 'ip-10-0-1-2', 42)).toBe('staging:ip-10-0-1-2:42');
  });
});

describe('VTID-04446 watchdog decision (AC-2)', () => {
  it('a live lease is never reclaimed, even with an hour-old updated_at', () => {
    expect(decideWatchdogReclaim({ updated_at: ago(60 * 60_000) }, { lease_owner: 'x', lease_until: ahead(60_000) }, NOW))
      .toEqual({ action: 'skip', reason: 'lease_live' });
  });

  it('an expired lease is reclaimed, even before the legacy 20 minutes', () => {
    expect(decideWatchdogReclaim({ updated_at: ago(6 * 60_000) }, { lease_owner: 'x', lease_until: ago(1_000) }, NOW))
      .toEqual({ action: 'reclaim', reason: 'lease_expired' });
  });

  it('no lease: the legacy 20-minute rule, both sides of it', () => {
    expect(decideWatchdogReclaim({ updated_at: ago(21 * 60_000) }, null, NOW)).toEqual({ action: 'reclaim', reason: 'legacy_stale' });
    expect(decideWatchdogReclaim({ updated_at: ago(6 * 60_000) }, null, NOW)).toEqual({ action: 'skip', reason: 'fresh' });
  });

  it('isLeaseLive treats a missing or unparseable lease as not live', () => {
    expect(isLeaseLive(null, NOW)).toBe(false);
    expect(isLeaseLive({ lease_until: null }, NOW)).toBe(false);
    expect(isLeaseLive({ lease_until: 'garbage' }, NOW)).toBe(false);
    expect(isLeaseLive({ lease_until: ahead(1) }, NOW)).toBe(true);
  });
});

describe('VTID-04446 lease lifecycle (AC-3)', () => {
  it('the claim row carries the legacy window, the mirror pointer and the run key', () => {
    const row = buildDevRunLeaseRow({ id: EXEC, finding_id: 'f1', metadata: { executor: 'agent' } }, 'gw:a:1', { now: NOW });
    expect(row).toMatchObject({
      agent_id: 'autopilot-agent-executor',
      plane: 'dev_autopilot',
      status: 'running',
      idempotency_key: devRunKey(EXEC),
      lease_owner: 'gw:a:1',
      lease_until: ahead(LEGACY_STUCK_EXECUTION_MS),
      created_via: 'system',
    });
    expect((row.metadata as Record<string, unknown>).mirror_of).toEqual({ table: 'dev_autopilot_executions', id: EXEC });
    expect(buildDevRunLeaseRow({ id: EXEC }, 'o', { now: NOW }).agent_id).toBe('dev-autopilot-executor');
  });

  it('acquire upserts on the idempotency key', async () => {
    const { rest, calls } = fakeRest([{ ok: true }]);
    expect(await acquireDevRunLease(rest, { id: EXEC }, { env: ON, owner: 'o', now: NOW })).toBe(true);
    expect(calls[0].path).toBe('/rest/v1/agent_runs?on_conflict=idempotency_key');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Prefer).toContain('resolution=merge-duplicates');
  });

  it('renew moves the lease to now + TTL, scoped to a running row, and takes ownership', async () => {
    const req = renewRequest(EXEC, 'task:b:7', DEFAULT_RUN_LEASE_TTL_MS, NOW);
    expect(req.path).toBe(`/rest/v1/agent_runs?idempotency_key=eq.${encodeURIComponent(devRunKey(EXEC))}&status=eq.running`);
    expect(req.body).toEqual({ lease_owner: 'task:b:7', lease_until: ahead(DEFAULT_RUN_LEASE_TTL_MS), updated_at: NOW.toISOString() });
    const { rest, calls } = fakeRest([{ ok: true }]);
    expect(await renewDevRunLease(rest, EXEC, { env: ON, owner: 'task:b:7', now: NOW })).toBe(true);
    expect(calls[0].init?.method).toBe('PATCH');
  });

  it('release closes the row with the running phase outcome and clears the lease', () => {
    const req = releaseRequest(EXEC, 'failed', 'boom', NOW);
    expect(req.path).toContain('&status=eq.running');
    expect(req.body).toMatchObject({ status: 'failed', lease_owner: null, lease_until: null, error: 'boom', completed_at: NOW.toISOString() });
    expect(runPhaseOutcome({ ok: true })).toBe('succeeded');
    expect(runPhaseOutcome({ ok: false })).toBe('failed');
    expect(runPhaseOutcome({ ok: false, cancelled: true })).toBe('cancelled');
  });

  it('every call is fail-open', async () => {
    const throwing = (async () => { throw new Error('network'); }) as unknown as LeaseRest;
    await expect(acquireDevRunLease(throwing, { id: EXEC }, { env: ON })).resolves.toBe(false);
    await expect(renewDevRunLease(throwing, EXEC, { env: ON })).resolves.toBe(false);
    await expect(releaseDevRunLease(throwing, EXEC, 'failed')).resolves.toBe(false);
    await expect(readDevRunLeases(throwing, [EXEC])).resolves.toBeNull();
    await expect(sweepOrphanDevRunLeases(throwing, NOW)).resolves.toBe(0);
  });

  it('reads leases keyed back to execution ids; a failed read is null (legacy rule)', async () => {
    const { rest, calls } = fakeRest([{ ok: true, data: [{ idempotency_key: devRunKey(EXEC), lease_owner: 'o', lease_until: ahead(1) }] }]);
    const m = await readDevRunLeases(rest, [EXEC, 'not-a-uuid']);
    expect(m?.get(EXEC)).toEqual({ lease_owner: 'o', lease_until: ahead(1) });
    expect(decodeURIComponent(calls[0].path)).toContain(`idempotency_key=in.("${devRunKey(EXEC)}")`);
    const failed = fakeRest([{ ok: false, error: 'down' }]);
    expect(await readDevRunLeases(failed.rest, [EXEC])).toBeNull();
  });

  it('the heartbeat renews the lease on every beat, and not after stop', async () => {
    jest.useFakeTimers();
    try {
      const renew = jest.fn(async () => true);
      const hb = startExecutionHeartbeat({ url: 'x', key: 'y' }, EXEC, { intervalMs: 5_000, patch: async () => undefined, renewLease: renew });
      jest.advanceTimersByTime(5_000);
      await flush();
      jest.advanceTimersByTime(5_000);
      await flush();
      expect(renew).toHaveBeenCalledTimes(2);
      hb.stop();
      jest.advanceTimersByTime(20_000);
      await flush();
      expect(renew).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('VTID-04446 orphan sweep (AC-4)', () => {
  it('closes expired leases whose execution moved on, with the matching outcome, and leaves running ones', async () => {
    const EXEC3 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const { rest, calls } = fakeRest([
      { ok: true, data: [{ idempotency_key: devRunKey(EXEC) }, { idempotency_key: devRunKey(EXEC2) }, { idempotency_key: devRunKey(EXEC3) }] },
      { ok: true, data: [{ id: EXEC, status: 'ci' }, { id: EXEC2, status: 'running' }] },
      { ok: true }, { ok: true },
    ]);
    expect(await sweepOrphanDevRunLeases(rest, NOW)).toBe(2);
    expect(calls[0].path).toContain('lease_until=lt.');
    expect(calls[0].path).toContain('metadata->mirror_of=not.is.null');
    const patches = calls.slice(2).map((c) => ({ path: c.path, body: JSON.parse(String(c.init?.body)) }));
    expect(patches.map((p) => p.path.includes(encodeURIComponent(devRunKey(EXEC))) ? 'exec1' : p.path.includes(encodeURIComponent(devRunKey(EXEC3))) ? 'exec3' : '?')).toEqual(['exec1', 'exec3']);
    expect(patches[0].body.status).toBe('succeeded');
    expect(patches[1].body).toMatchObject({ status: 'failed', error: 'execution row missing' });
  });

  it('maps execution statuses to a running-phase outcome', () => {
    expect(outcomeFromExecutionStatus('completed')).toBe('succeeded');
    expect(outcomeFromExecutionStatus('awaiting_approval')).toBe('succeeded');
    expect(outcomeFromExecutionStatus('reverted')).toBe('failed');
    expect(outcomeFromExecutionStatus('rejected')).toBe('cancelled');
    expect(outcomeFromExecutionStatus(null)).toBe('failed');
  });
});

describe('VTID-04446 stage-loop stall detection (AC-5)', () => {
  function scripted(turns: Array<{ tools?: Array<{ name: string; args?: Record<string, unknown> }>; text?: string }>) {
    const seen: Array<{ tools: boolean; prompt: string }> = [];
    let i = 0;
    const callLlm: StageLlmCall = async (_stage, prompt, opts) => {
      seen.push({ tools: !!opts.tools, prompt });
      if (!opts.tools) return { ok: true, text: 'final answer', provider: 'bedrock' } as never;
      const t = turns[i++] ?? { text: 'done' };
      if (t.tools) return { ok: true, toolCalls: t.tools.map((c, k) => ({ id: `c${i}-${k}`, name: c.name, arguments: c.args ?? {} })), provider: 'bedrock' } as never;
      return { ok: true, text: t.text, provider: 'bedrock' } as never;
    };
    return { callLlm, seen };
  }
  const same = { tools: [{ name: 'read', args: { path: 'a.ts' } }] };
  const base = {
    stage: 'triage' as const, service: 't', systemPrompt: 's', prompt: 'p',
    tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }] as never,
    execute: async () => ({ result: 'same content' }),
    maxTurns: 10, maxToolCalls: 20,
  };

  it('re-plans once, then forces the tool-less final answer with stalled: true', async () => {
    const { callLlm, seen } = scripted([same, same, same, same, same]);
    const r = await runStageToolLoop({ ...base, callLlm });
    expect(r.ok).toBe(true);
    expect(r.stalled).toBe(true);
    expect(r.budgetExhausted).toBe(false);
    expect(r.text).toBe('final answer');
    expect(seen.filter((s) => s.prompt === STAGE_LOOP_REPLAN_PROMPT)).toHaveLength(1);
    expect(seen[seen.length - 1].tools).toBe(false);
    // 1 progress turn (first read) + 3 idle turns, then the final call.
    expect(r.toolCalls).toBe(4);
    expect(r.steps.some((s) => s.kind === 'nudge')).toBe(true);
  });

  it('new calls are progress: a loop that keeps reading different things is not stalled', async () => {
    const { callLlm } = scripted([
      { tools: [{ name: 'read', args: { path: 'a' } }] },
      { tools: [{ name: 'read', args: { path: 'b' } }] },
      { tools: [{ name: 'read', args: { path: 'c' } }] },
      { tools: [{ name: 'read', args: { path: 'd' } }] },
      { text: 'answer' },
    ]);
    const r = await runStageToolLoop({ ...base, callLlm });
    expect(r).toMatchObject({ ok: true, stalled: false, text: 'answer', toolCalls: 4 });
  });

  it('stall: false keeps the pre-VTID-04446 behaviour', async () => {
    const { callLlm } = scripted([same, same, same, same, { text: 'answer' }]);
    const r = await runStageToolLoop({ ...base, callLlm, stall: false });
    expect(r).toMatchObject({ ok: true, stalled: false, text: 'answer', toolCalls: 4 });
  });
});

describe('VTID-04446 wiring and migration contracts (AC-1, AC-6)', () => {
  const root = join(__dirname, '..', '..', '..');
  const exec = readFileSync(join(root, 'src/services/dev-autopilot-execute.ts'), 'utf8');

  it('the watchdog asks the lease only when the flag is on, and reclaims legacy-style otherwise', () => {
    const block = exec.slice(exec.indexOf('// 0b. Reclaim execution rows'), exec.indexOf('// 0c. State reconciler'));
    expect(block).toMatch(/const leasesOn = isRunLeaseEnabled\(\);/);
    expect(block).toMatch(/watchdogCandidateWindowMs\(\)/);
    expect(block).toMatch(/leasesOn\s*\?\s*decideWatchdogReclaim\(stuck, leases\?\.get\(stuck\.id\) \?\? null\)\s*:\s*\{ action: 'reclaim' as const, reason: 'legacy_stale' as const \}/);
    expect(block).toMatch(/if \(leasesOn\) void releaseDevRunLease/);
    expect(block).toMatch(/if \(leasesOn\) \{\s*const swept = await sweepOrphanDevRunLeases/);
  });

  it('the claim acquires and the result path releases (release gated on the flag)', () => {
    expect(exec).toMatch(/await acquireDevRunLease\(leaseRest\(s\), exec\);/);
    expect(exec).toMatch(/if \(isRunLeaseEnabled\(\)\) await releaseDevRunLease\(leaseRest\(s\), execId, runPhaseOutcome\(result\)/);
  });

  it('the migration only adds an index and the view filter', () => {
    const sql = readFileSync(join(root, '..', '..', 'supabase/migrations/20260923210000_vtid_04446_run_leases.sql'), 'utf8');
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP |INSERT |UPDATE |DELETE /i);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_agent_runs_running_lease/);
    expect(code).toMatch(/FROM agent_runs n\s+WHERE n\.metadata->'mirror_of' IS NULL;/);
    // The other three projections are carried over unchanged.
    for (const t of ['FROM dev_autopilot_executions e', 'FROM automation_runs a', 'FROM self_healing_log s']) expect(code).toContain(t);
    expect((code.match(/UNION ALL/g) || []).length).toBe(3);
  });
});
