/**
 * VTID-05065: Kiro runs — unit tests for the parts the end-to-end scenarios in
 * test/vtid-04465-operator-pipeline-regression.test.ts ("Kiro runs (VTID-05065)")
 * cannot pin precisely: event coalescing, seq order, the batching flush triggers,
 * the status mapping, owner checks at the service, the read-tool title pin, and
 * the wiring (shutdown hook, mount, atlas, OASIS topics, migration).
 */
import fs from 'fs';
import path from 'path';
import {
  KiroRunEventLog, KIRO_RUN_LIMITS, runStatusForOutcome, runFieldsForOutcome, isTerminalRunStatus,
  cancelKiroRun, answerPersistedPermission, type KiroRunEvent, type KiroRunEventWriter,
} from '../src/services/kiro/kiro-runs';
import { KIRO_MCP_TOOL_TITLE, trustedKiroReadTool, makePermissionHandler, answerPermission } from '../src/services/kiro/permission-broker';
import { KIRO_MCP_READ_TOOLS } from '../src/services/kiro/kiro-mcp-tools';
import type { KiroTurnEvent } from '../src/services/kiro/kiro-events';

const LIMITS = { ...KIRO_RUN_LIMITS, coalesceMs: 500, coalesceBytes: 2_048, flushMs: 1_000, flushEvents: 20 };

function recorder(ok: () => boolean = () => true) {
  const batches: Array<Array<{ seq: number; type: string; payload: Record<string, unknown> }>> = [];
  const write: KiroRunEventWriter = async (rows) => { batches.push(rows.map((r) => ({ seq: r.seq, type: r.type, payload: r.payload }))); return ok(); };
  return { batches, write };
}

describe('event log: coalescing', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('text pieces within 500 ms become ONE message event, emitted when the window closes', () => {
    const log = new KiroRunEventLog('r1', null, LIMITS);
    const seen: KiroRunEvent[] = [];
    log.subscribe((e) => seen.push(e));
    log.appendText('Hel');
    log.appendText('lo ');
    jest.advanceTimersByTime(499);
    expect(seen).toHaveLength(0);
    log.appendText('world');
    jest.advanceTimersByTime(1);
    expect(seen).toEqual([expect.objectContaining({ seq: 1, type: 'kiro.message_chunk', payload: { text: 'Hello world' } })]);
    log.appendText('again');
    jest.advanceTimersByTime(500);
    expect(seen.map((e) => e.payload.text)).toEqual(['Hello world', 'again']);
  });

  it('2 KB of text closes the event at once, without waiting for the window', () => {
    const log = new KiroRunEventLog('r1', null, LIMITS);
    const seen: KiroRunEvent[] = [];
    log.subscribe((e) => seen.push(e));
    log.appendText('a'.repeat(2_047));
    expect(seen).toHaveLength(0);
    log.appendText('b');
    expect(seen).toHaveLength(1);
    expect((seen[0].payload.text as string).length).toBe(2_048);
  });

  it('any other event first closes the open text, so order is kept', () => {
    const log = new KiroRunEventLog('r1', null, LIMITS);
    const seen: KiroRunEvent[] = [];
    log.subscribe((e) => seen.push(e));
    log.appendText('before the tool');
    log.push('kiro.tool_call', { tool_call_id: 't1' });
    log.appendText('after');
    log.push('kiro.turn_end', { stop_reason: 'end_turn' });
    expect(seen.map((e) => [e.seq, e.type])).toEqual([[1, 'kiro.message_chunk'], [2, 'kiro.tool_call'], [3, 'kiro.message_chunk'], [4, 'kiro.turn_end']]);
  });
});

describe('event log: seq order and batched writes', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('seq is 1..n, every listener gets the same events, the in-memory log holds them', () => {
    const log = new KiroRunEventLog('r1', null, LIMITS);
    const a: number[] = [];
    const b: number[] = [];
    log.subscribe((e) => a.push(e.seq));
    const off = log.subscribe((e) => b.push(e.seq));
    for (let i = 0; i < 5; i += 1) log.push('kiro.tool_update', { i });
    off();
    log.push('kiro.turn_end', {});
    expect(a).toEqual([1, 2, 3, 4, 5, 6]);
    expect(b).toEqual([1, 2, 3, 4, 5]);
    expect(log.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(log.lastSeq).toBe(6);
  });

  it('a listener that throws does not stop the others or the write', async () => {
    const r = recorder();
    const log = new KiroRunEventLog('r1', r.write, LIMITS);
    const seen: number[] = [];
    log.subscribe(() => { throw new Error('boom'); });
    log.subscribe((e) => seen.push(e.seq));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    log.push('kiro.tool_call', {});
    warn.mockRestore();
    expect(seen).toEqual([1]);
    await log.drain();
    expect(r.batches).toHaveLength(1);
  });

  it('20 events → one bulk insert at once; fewer wait for the 1 s timer; drain writes the rest', async () => {
    const r = recorder();
    const log = new KiroRunEventLog('r1', r.write, LIMITS);
    for (let i = 0; i < 20; i += 1) log.push('kiro.tool_update', { i });
    await Promise.resolve(); await Promise.resolve();
    expect(r.batches.map((b) => b.length)).toEqual([20]);
    log.push('kiro.tool_update', { i: 20 });
    log.push('kiro.tool_update', { i: 21 });
    await Promise.resolve();
    expect(r.batches).toHaveLength(1);
    jest.advanceTimersByTime(999);
    await Promise.resolve();
    expect(r.batches).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await Promise.resolve(); await Promise.resolve();
    expect(r.batches.map((b) => b.length)).toEqual([20, 2]);
    log.appendText('tail');
    await log.drain();
    expect(r.batches.map((b) => b.length)).toEqual([20, 2, 1]);
    expect(r.batches.flat().map((x) => x.seq)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(log.inserts).toBe(3);
  });

  it('a failed insert keeps its rows for the next flush, in seq order', async () => {
    let fail = true;
    const r = recorder(() => !fail);
    const log = new KiroRunEventLog('r1', r.write, LIMITS);
    log.push('a', {});
    log.push('b', {});
    await log.flush();
    fail = false;
    log.push('c', {});
    await log.flush();
    expect(r.batches.map((b) => b.map((x) => x.seq))).toEqual([[1, 2], [1, 2, 3]]);
  });

  it('a typical turn (≈20 tool calls, ≈10 KB text over ~6 s) is a handful of inserts, not one per event', async () => {
    const r = recorder();
    const log = new KiroRunEventLog('r1', r.write, LIMITS);
    for (let i = 0; i < 20; i += 1) {
      log.push('kiro.tool_call', { i });
      log.push('kiro.tool_update', { i });
      for (let j = 0; j < 10; j += 1) { log.appendText('x'.repeat(50)); jest.advanceTimersByTime(30); }
      await Promise.resolve();
    }
    await log.drain();
    expect(r.batches.flat()).toHaveLength(log.lastSeq);
    expect(log.inserts).toBeLessThanOrEqual(15);
  });
});

describe('status mapping', () => {
  const out = (meta: Record<string, unknown>, status = 200) => ({ status, body: { ok: status === 200, reply: 'r', meta } });
  it.each([
    ['ok', 'completed'], ['refused', 'refused'], ['incomplete', 'incomplete'],
    ['error', 'failed'], ['busy', 'failed'], ['not_connected', 'failed'], ['no_credits', 'failed'], [undefined, 'failed'],
  ])('kiro_status %s → %s', (kiroStatus, runStatus) => {
    expect(runStatusForOutcome(out({ kiro_status: kiroStatus }))).toBe(runStatus);
  });
  it('a turn Kiro stopped because it was cancelled is cancelled; a non-200 outcome is failed', () => {
    expect(runStatusForOutcome(out({ kiro_status: 'incomplete', stop_reason: 'cancelled' }))).toBe('cancelled');
    expect(runStatusForOutcome(out({ kiro_status: 'ok' }, 403))).toBe('failed');
  });
  it('a failed run says why; a refused or incomplete one has no error', () => {
    expect(runFieldsForOutcome(out({ kiro_status: 'busy' })).error).toBe('busy');
    expect(runFieldsForOutcome(out({ kiro_status: 'error', error: 'kiro-cli exited' })).error).toBe('error: kiro-cli exited');
    expect(runFieldsForOutcome({ status: 403, body: { ok: false, error: 'kiro_requires_admin' } }).error).toBe('kiro_requires_admin');
    expect(runFieldsForOutcome(out({ kiro_status: 'refused', stop_reason: 'refusal' }))).toMatchObject({ error: null, stop_reason: 'refusal', reply: 'r' });
    expect(runFieldsForOutcome(out({ kiro_status: 'ok', kiro_workspace: 'lost', kiro_workspace_dirty: ['vitana-platform'] })).workspace)
      .toEqual({ kiro_workspace: 'lost', kiro_workspace_dirty: ['vitana-platform'] });
  });
  it('terminal vs unfinished statuses', () => {
    for (const s of ['queued', 'running', 'waiting_permission']) expect(isTerminalRunStatus(s)).toBe(false);
    for (const s of ['completed', 'refused', 'incomplete', 'failed', 'cancelled', 'interrupted']) expect(isTerminalRunStatus(s)).toBe(true);
    expect(isTerminalRunStatus('bogus')).toBe(false);
  });
});

describe('read-tool trust: the recorded kiro-cli title format (kiro-cli 2.28.0, production 2026-10-10)', () => {
  // Recorded strings: the owner's permission cards and OASIS operator.chat.message toolCalls.
  const RECORDED = ['Running: @vitana/dev_read_file', 'Running: @vitana/dev_search_codebase', 'Running: @vitana/dev_system_status'];
  const opts = [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }];

  it.each(RECORDED)('"%s" (kind other) is an Operator read tool and is allowed without a card', async (title) => {
    expect(trustedKiroReadTool({ title, kind: 'other' })).toBe(title.split('/')[1]);
    const emitted: KiroTurnEvent[] = [];
    const handler = makePermissionHandler({ threadId: 't', userId: 'u', emit: (e) => emitted.push(e) });
    await expect(handler({ sessionId: 's', toolCallId: 'c', title, kind: 'other', options: opts })).resolves.toBe('allow');
    expect(emitted).toEqual([]);
  });

  it.each([
    ['a write tool', 'Running: @vitana/dev_create_pr', 'other'],
    ['a write tool (branch push)', 'Running: @vitana/dev_push_kiro_branch', 'other'],
    ['an unknown name', 'Running: @vitana/dev_drop_database', 'other'],
    ['another MCP server', 'Running: @github/dev_read_file', 'other'],
    ['a different format', 'Run @vitana/dev_read_file', 'other'],
    ['extra text', 'Running: @vitana/dev_read_file now', 'other'],
    ['kind edit', 'Running: @vitana/dev_read_file', 'edit'],
    ['kind execute', 'Running: @vitana/dev_read_file', 'execute'],
  ])('%s still asks (card, never an allow)', async (_label, title, kind) => {
    expect(trustedKiroReadTool({ title, kind })).toBeNull();
    const emitted: KiroTurnEvent[] = [];
    const handler = makePermissionHandler({ threadId: 't', userId: 'u', emit: (e) => emitted.push(e) }, { KIRO_PERMISSION_TIMEOUT_MS: '60000' } as NodeJS.ProcessEnv);
    const answer = handler({ sessionId: 's', toolCallId: 'c', title, kind, options: opts });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'kiro.permission_request', title, kind });
    answerPermission((emitted[0] as any).request_id, 'u', false);
    await expect(answer).resolves.toBeNull();
    expect(emitted[1]).toMatchObject({ type: 'kiro.permission_answer', allow: false, by: 'user' });
  });

  it('the trusted names are exactly the read tools; no write tool is on the list', () => {
    expect(KIRO_MCP_TOOL_TITLE.source).toBe('^Running: @vitana\\/([a-z0-9_]+)$');
    for (const w of ['dev_create_pr', 'dev_merge_pr', 'dev_push_kiro_branch', 'autopilot_execute_task', 'dev_deploy_service']) {
      expect(KIRO_MCP_READ_TOOLS as readonly string[]).not.toContain(w);
    }
    for (const r of ['dev_read_file', 'dev_search_codebase', 'dev_system_status', 'dev_db_query']) expect(KIRO_MCP_READ_TOOLS as readonly string[]).toContain(r);
  });

  it('a card nobody answers is denied at the timeout and the answer is reported', async () => {
    jest.useFakeTimers();
    try {
      const emitted: KiroTurnEvent[] = [];
      const handler = makePermissionHandler({ threadId: 't', userId: 'u', emit: (e) => emitted.push(e) }, { KIRO_PERMISSION_TIMEOUT_MS: '1000' } as NodeJS.ProcessEnv);
      const answer = handler({ sessionId: 's', toolCallId: 'c', title: 'Edit a.ts', kind: 'edit', options: opts });
      jest.advanceTimersByTime(1000);
      await expect(answer).resolves.toBeNull();
      expect(emitted[1]).toMatchObject({ type: 'kiro.permission_answer', allow: false, by: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('owner checks at the service (a run on another gateway task, read from the store)', () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE, fetch: (global as any).fetch };
  let rows: any[] = [];
  const patches: string[] = [];
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://store.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
    patches.length = 0;
    (global as any).fetch = async (url: string, init: any = {}) => {
      if ((init.method || 'GET') === 'PATCH') { patches.push(url); return new Response(JSON.stringify([{ id: rows[0]?.id }]), { status: 200 }); }
      return new Response(JSON.stringify(rows), { status: 200 });
    };
  });
  afterEach(() => {
    process.env.SUPABASE_URL = saved.url;
    process.env.SUPABASE_SERVICE_ROLE = saved.key;
    (global as any).fetch = saved.fetch;
  });

  it('cancel: another user is forbidden, a finished run is not active, a missing run is not found — and nothing is written', async () => {
    rows = [{ id: 'r1', user_id: 'owner', thread_id: 't', status: 'running' }];
    expect(await cancelKiroRun('r1', 'someone-else')).toEqual({ ok: false, error: 'forbidden' });
    rows = [{ id: 'r1', user_id: 'owner', thread_id: 't', status: 'completed' }];
    expect(await cancelKiroRun('r1', 'owner')).toEqual({ ok: false, error: 'not_active' });
    rows = [];
    expect(await cancelKiroRun('r1', 'owner')).toEqual({ ok: false, error: 'not_found' });
    expect(patches).toEqual([]);
    rows = [{ id: 'r1', user_id: 'owner', thread_id: 't', status: 'running' }];
    expect(await cancelKiroRun('r1', 'owner')).toEqual({ ok: true, status: 'cancelling' });
    expect(patches[0]).toContain('status=in.(queued,running,waiting_permission)');
  });

  it('a persisted card: only the run\'s user may answer it; the write is guarded by the request id', async () => {
    rows = [{ id: 'r1', user_id: 'owner', pending_permission: { request_id: 'q1', title: 'Edit' } }];
    expect(await answerPersistedPermission('q1', 'intruder', true)).toEqual({ ok: false, error: 'forbidden' });
    expect(patches).toEqual([]);
    expect(await answerPersistedPermission('q1', 'owner', true)).toEqual({ ok: true });
    expect(patches[0]).toContain('pending_permission->>request_id=eq.q1');
  });
});

describe('wiring (source checks)', () => {
  const root = path.join(__dirname, '../../..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('the Kiro drain hook is appended to the ONE existing drainHooks array, with its own 3 s bound', () => {
    const index = read('services/gateway/src/index.ts');
    expect(index.match(/installGracefulShutdown\(/g)).toHaveLength(1);
    const install = index.slice(index.indexOf('installGracefulShutdown(server, {'), index.indexOf('Graceful shutdown handler installation failed'));
    expect(install).toContain('emitShutdownStopsForLiveSessions');
    expect(install).toContain('drainKiroRunsForShutdown(3_000)');
    expect(index).toContain("mountRouterSync(app, '/api/v1/operator/kiro/runs', require('./routes/operator-kiro-runs').default");
    expect(index).toContain('startKiroRunTimers()');
  });

  it('the run routes are admin-only and claimed by the agents domain', () => {
    const routes = read('services/gateway/src/routes/operator-kiro-runs.ts');
    for (const r of ["router.post('/', requireAdminAuth", "router.get('/', requireAdminAuth", "router.get('/:id', requireAdminAuth", "router.get('/:id/stream', requireAdminAuth", "router.post('/:id/cancel', requireAdminAuth"]) {
      expect(routes).toContain(r);
    }
    expect(read('services/gateway/src/orb/developer/domain-atlas.ts')).toContain('/^operator-kiro-runs$/');
  });

  it('the three OASIS topics are declared', () => {
    const cicd = read('services/gateway/src/types/cicd.ts');
    for (const t of ['run_started', 'run_finished', 'run_interrupted']) expect(cicd).toContain(`| 'operator.kiro.${t}'`);
  });

  it('the migration: both tables, the status check, the indexes, unique (run_id, seq), RLS on and no client access', () => {
    const sql = read('supabase/migrations/20261010210000_vtid_05065_kiro_runs.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.kiro_runs');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.kiro_run_events');
    expect(sql).toMatch(/CHECK \(status IN \('queued', 'running', 'waiting_permission', 'completed', 'refused',\s+'incomplete', 'failed', 'cancelled', 'interrupted'\)\)/);
    for (const c of ['last_heartbeat_at', 'gateway_task', 'pending_permission']) expect(sql).toContain(c);
    expect(sql).toContain('ON public.kiro_runs (thread_id, created_at DESC)');
    expect(sql).toContain('ON public.kiro_runs (status, last_heartbeat_at)');
    expect(sql).toContain('UNIQUE (run_id, seq)');
    expect(sql).toContain('ALTER TABLE public.kiro_runs ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE public.kiro_run_events ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON public.kiro_runs FROM anon, authenticated');
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(read('DATABASE_SCHEMA.md')).toContain('## Kiro runs — `kiro_runs`, `kiro_run_events` (VTID-05065');
  });
});
