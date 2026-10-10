/**
 * VTID-05060: resume a VTID from anywhere, and keep the developer's own Kiro
 * model pick across a Kiro session reopen.
 *
 * Pins:
 *  - the resume pack: sections, the one-PR-read focus, evidence ref (main
 *    once merged, the PR branch while open), deploy containment from the
 *    compare status, every section failing open with its reason, the text
 *    cap, invalid / not-found VTIDs, and the separate instructions field;
 *  - GET /api/v1/dev-memory/resume/:vtid: auth before validation (401
 *    without a caller), 403 for a non-admin, 400 / 404 / 200, pack token,
 *    ?format=text appends the instructions;
 *  - the Operator tool dev_resume_vtid is declared, read-only (code_lookup)
 *    and offered to Kiro;
 *  - the model pick: a NEW session re-applies the last pick when Kiro offers
 *    it; a pick Kiro no longer offers leaves Kiro's model and says so; no
 *    pick, or a pick that is already current, sends nothing; a live session
 *    never looks the pick up. No server-side default exists.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type { AcpChild } from '../src/services/kiro/acp-client';
import {
  buildResumePackWith, clearResumePackCache, containsFromCompare, planBlock,
  RESUME_INSTRUCTIONS, RESUME_TEXT_MAX_CHARS, type ResumeDeps,
} from '../src/services/dev-memory/resume-pack';
import { setKiroBackend, runKiroTurn, closeAllKiroSessions } from '../src/services/kiro/kiro-turn';
import { KIRO_MCP_READ_TOOLS } from '../src/services/kiro/kiro-mcp-tools';

// ── resume pack ──────────────────────────────────────────────────────────────

const LEDGER = { vtid: 'VTID-05047', title: 'Lock the cicd routes', summary: 'Gate nine routes', status: 'in_progress', spec_status: 'approved', is_terminal: false, metadata: { plan_hash: 'f0191f47' } };
const MERGED_PR = { repo: 'exafyltd/vitana-platform', number: 3999, title: 'VTID-05047: lock', state: 'closed' as const, merged: true, html_url: 'https://github.com/exafyltd/vitana-platform/pull/3999', body: 'Where it stopped: merged.', updated_at: '2026-10-10T11:00:00Z' };
const OPEN_PR = { ...MERGED_PR, number: 4100, state: 'open' as const, merged: false, body: 'Where it stopped: tests half done.\nNext: finish the route test.' };

function deps(over: Partial<ResumeDeps> = {}): ResumeDeps & { calls: string[] } {
  const calls: string[] = [];
  const d: ResumeDeps & { calls: string[] } = {
    calls,
    loadLedger: async (v) => { calls.push(`ledger:${v}`); return { ok: true, row: { ...LEDGER, vtid: v } }; },
    loadMemory: async () => { calls.push('memory'); return [{ category: 'handoff', title: 'Thread', content: 'Stopped at the route test.', created_at: '2026-10-10T12:00:00Z' }]; },
    searchPrs: async () => { calls.push('search'); return [MERGED_PR]; },
    prDetail: async (repo, n) => { calls.push(`pr:${repo}#${n}`); return { head_branch: 'claude/x', merge_commit: 'acc91e988ffa2e17' }; },
    readFile: async (repo, p, ref) => { calls.push(`file:${p}@${ref}`); return p.endsWith('acceptance.md') ? '# AC\nAC-1: works' : 'intro\n<!-- plan:begin -->\nTHE PLAN\n<!-- plan:end -->\nresponses'; },
    buildInfoCommit: async (env) => { calls.push(`build:${env}`); return env === 'staging' ? 'acc91e988ffa' : '9f47f25567ba'; },
    compare: async (_r, _b, head) => { calls.push(`compare:${head}`); return head.startsWith('acc91') ? 'identical' : 'behind'; },
    now: () => new Date('2026-10-10T13:00:00Z'),
    ...over,
  };
  return d;
}

describe('buildResumePackWith', () => {
  it('builds every section for a merged PR and places the merge on staging, not production', async () => {
    const d = deps();
    const r = await buildResumePackWith(d, 'VTID-05047');
    if (!r.ok) throw new Error(r.error);
    const t = r.pack.text;
    expect(t).toMatch(/^# Resume VTID-05047 — Lock the cicd routes/);
    expect(t).toContain('status=in_progress spec_status=approved terminal=no');
    expect(t).toContain('exafyltd/vitana-platform#3999 [merged]');
    expect(t).toContain('(merge acc91e98)');
    expect(t).toContain('- staging: acc91e98 — contains the merge commit: yes');
    expect(t).toContain('- production: 9f47f255 — contains the merge commit: no');
    expect(t).toContain('AC-1: works');
    expect(t).toContain('THE PLAN');
    expect(t).not.toContain('responses');
    expect(t).toContain('Stopped at the route test.');
    expect(r.pack.unavailable).toEqual([]);
    // merged → evidence from main; exactly one PR read; two compares
    expect(d.calls).toContain('file:docs/validation/VTID-05047/acceptance.md@main');
    expect(d.calls.filter((c) => c.startsWith('pr:'))).toHaveLength(1);
    expect(d.calls.filter((c) => c.startsWith('compare:'))).toHaveLength(2);
  });

  it('prefers the open PR: its branch for the evidence, no merge commit, deploy unknown', async () => {
    const d = deps({ searchPrs: async () => [OPEN_PR, MERGED_PR] });
    const r = await buildResumePackWith(d, 'VTID-05047');
    if (!r.ok) throw new Error(r.error);
    expect(d.calls).toContain('pr:exafyltd/vitana-platform#4100');
    expect(d.calls).toContain('file:docs/validation/VTID-05047/acceptance.md@claude/x');
    expect(r.pack.text).toContain('Next: finish the route test.');
    expect(r.pack.text).toContain('contains the merge commit: unknown');
    expect(d.calls.some((c) => c.startsWith('compare:'))).toBe(false);
  });

  it('fails open section by section with the reason', async () => {
    const boom = async () => { throw new Error('rate limited'); };
    const r = await buildResumePackWith(deps({ searchPrs: boom, loadMemory: boom, buildInfoCommit: boom, readFile: boom }), 'VTID-05047');
    if (!r.ok) throw new Error(r.error);
    expect(r.pack.prs).toEqual([]);
    expect(r.pack.unavailable).toEqual(expect.arrayContaining(['prs: rate limited', 'memory: rate limited']));
    expect(r.pack.unavailable.some((u) => u.startsWith('staging build-info'))).toBe(true);
    expect(r.pack.unavailable.some((u) => u.startsWith('acceptance.md'))).toBe(true);
    expect(r.pack.text).toContain('(unavailable: ');
  });

  it('caps the text and keeps instructions out of it', async () => {
    const r = await buildResumePackWith(deps({ readFile: async () => 'x'.repeat(50_000), searchPrs: async () => [{ ...MERGED_PR, body: 'y'.repeat(50_000) }] }), 'VTID-05047');
    if (!r.ok) throw new Error(r.error);
    expect(r.pack.text.length).toBeLessThanOrEqual(RESUME_TEXT_MAX_CHARS);
    expect(r.pack.instructions).toBe(RESUME_INSTRUCTIONS);
    expect(r.pack.text).not.toContain('Do not allocate a new VTID');
    expect(RESUME_INSTRUCTIONS).toMatch(/Do not allocate a new VTID/);
  });

  it('rejects a malformed VTID before any read, and reports a missing one', async () => {
    const d = deps();
    expect(await buildResumePackWith(d, 'VTID-1')).toEqual({ ok: false, error: 'invalid_vtid' });
    expect(d.calls).toEqual([]);
    expect(await buildResumePackWith(deps({ loadLedger: async () => ({ ok: true, row: null }) }), 'VTID-09999')).toEqual({ ok: false, error: 'not_found' });
    expect(await buildResumePackWith(deps({ loadLedger: async () => ({ ok: false, error: 'db down' }) }), 'VTID-09999')).toEqual({ ok: false, error: 'unavailable' });
  });

  it('a vitana-v1 merge is not placed against the gateway build-info', async () => {
    const d = deps({ searchPrs: async () => [{ ...MERGED_PR, repo: 'exafyltd/vitana-v1' }] });
    const r = await buildResumePackWith(d, 'VTID-05047');
    if (!r.ok) throw new Error(r.error);
    expect(d.calls.some((c) => c.startsWith('compare:'))).toBe(false);
  });

  it('caches a built pack for 60 s per VTID', async () => {
    // the route block below mocks buildResumePack for this file; use the real one here
    const { buildResumePack: realBuild } = jest.requireActual('../src/services/dev-memory/resume-pack');
    const buildResumePack = realBuild as typeof import('../src/services/dev-memory/resume-pack').buildResumePack;
    clearResumePackCache();
    let t = Date.parse('2026-10-10T13:00:00Z');
    const d = deps({ now: () => new Date(t) });
    await buildResumePack('VTID-05047', d);
    await buildResumePack('VTID-05047', d);
    expect(d.calls.filter((c) => c === 'search')).toHaveLength(1);
    t += 61_000;
    await buildResumePack('VTID-05047', d);
    expect(d.calls.filter((c) => c === 'search')).toHaveLength(2);
    clearResumePackCache();
  });

  it('helpers', () => {
    expect(containsFromCompare('ahead')).toBe(true);
    expect(containsFromCompare('identical')).toBe(true);
    expect(containsFromCompare('behind')).toBe(false);
    expect(containsFromCompare('diverged')).toBe(false);
    expect(containsFromCompare('weird')).toBeNull();
    expect(planBlock('no markers')).toBe('no markers');
  });
});

// ── route ────────────────────────────────────────────────────────────────────

let identity: Record<string, unknown> | null = null;
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    requireAdminAuth: (req: any, res: any, next: () => void) => {
      if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      if (identity.exafy_admin !== true) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      req.identity = identity;
      next();
    },
  };
});
const mockBuild = jest.fn();
jest.mock('../src/services/dev-memory/resume-pack', () => {
  const actual = jest.requireActual('../src/services/dev-memory/resume-pack');
  return { ...actual, buildResumePack: (...a: unknown[]) => mockBuild(...a) };
});

describe('GET /api/v1/dev-memory/resume/:vtid', () => {
  const ENV0 = { ...process.env };
  let app: express.Express;
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/dev-memory').default;
    app = express();
    app.use('/api/v1/dev-memory', router);
  });
  beforeEach(() => {
    identity = null;
    mockBuild.mockReset();
    mockBuild.mockResolvedValue({ ok: true, pack: { text: '# Resume VTID-05047', instructions: RESUME_INSTRUCTIONS, unavailable: [] } });
    process.env = { ...ENV0, DEV_MEMORY_PACK_TOKEN: 'p'.repeat(32) };
  });
  afterAll(() => { process.env = ENV0; });

  it('authenticates before it validates', async () => {
    expect((await request(app).get('/api/v1/dev-memory/resume/VTID-05047')).status).toBe(401);
    expect((await request(app).get('/api/v1/dev-memory/resume/not-a-vtid')).status).toBe(401);
    expect(mockBuild).not.toHaveBeenCalled();
  });
  it('a signed-in non-admin gets 403', async () => {
    identity = { user_id: 'u', exafy_admin: false };
    expect((await request(app).get('/api/v1/dev-memory/resume/VTID-05047')).status).toBe(403);
  });
  it('admin: 400 for a malformed id, 404 when the ledger has none, 200 with the pack', async () => {
    identity = { user_id: 'a', exafy_admin: true };
    expect((await request(app).get('/api/v1/dev-memory/resume/VTID-1')).status).toBe(400);
    mockBuild.mockResolvedValueOnce({ ok: false, error: 'not_found' });
    expect((await request(app).get('/api/v1/dev-memory/resume/VTID-09999')).status).toBe(404);
    const ok = await request(app).get('/api/v1/dev-memory/resume/vtid-05047');
    expect(ok.status).toBe(200);
    expect(ok.body.pack.text).toBe('# Resume VTID-05047');
    expect(mockBuild).toHaveBeenLastCalledWith('VTID-05047');
  });
  it('the read-only pack token works and ?format=text appends the instructions', async () => {
    const r = await request(app).get('/api/v1/dev-memory/resume/VTID-05047?format=text').set('X-Dev-Memory-Token', 'p'.repeat(32));
    expect(r.status).toBe(200);
    expect(r.type).toBe('text/plain');
    expect(r.text).toContain('# Resume VTID-05047');
    expect(r.text).toContain('## Instructions\nYou are continuing an existing VTID.');
  });
  it('a wrong pack token is not a caller', async () => {
    expect((await request(app).get('/api/v1/dev-memory/resume/VTID-05047').set('X-Dev-Memory-Token', 'q'.repeat(32))).status).toBe(401);
  });
});

// ── Operator tool + script ───────────────────────────────────────────────────

describe('dev_resume_vtid and the script', () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  it('is declared, dispatched, read-only (code_lookup) and offered to Kiro', () => {
    const op = src('src/services/gemini-operator.ts');
    expect(op).toContain("name: 'dev_resume_vtid'");
    expect(op).toContain("case 'dev_resume_vtid':");
    expect(src('src/services/jev/gates/operator-route-gate.ts')).toContain("dev_resume_vtid: 'code_lookup'");
    expect(KIRO_MCP_READ_TOOLS).toContain('dev_resume_vtid');
  });
  it('the script reads the route with the pack token and never echoes it', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'dev', 'resume-vtid.sh'), 'utf8');
    expect(sh).toContain('X-Dev-Memory-Token: ${TOKEN}');
    expect(sh).toContain('/api/v1/dev-memory/resume/${VTID}?format=text');
    expect(sh).not.toMatch(/echo[^\n]*\$\{?TOKEN/);
  });
});

// ── Kiro model pick ──────────────────────────────────────────────────────────

function fakeChild(models: { availableModels: Array<{ modelId: string; name: string }>; currentModelId: string } | null): AcpChild & { written: any[] } {
  const out = new EventEmitter();
  const proc = new EventEmitter();
  const written: any[] = [];
  const send = (o: unknown) => out.emit('data', `${JSON.stringify(o)}\n`);
  const child: any = {
    written,
    stdout: out,
    stdin: {
      write: (line: string) => {
        const msg = JSON.parse(line);
        written.push(msg);
        if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'S1', ...(models ? { models } : {}) } });
        else if (msg.method === 'session/set_model') send({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (msg.method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        return true;
      },
      end: () => {},
    },
    kill() { proc.emit('exit'); },
    on: (ev: string, cb: any) => proc.on(ev, cb),
  };
  return child;
}

describe('Kiro keeps the developer model pick across a session reopen', () => {
  const ENV = { KIRO_ENGINE_ENABLED: 'true' } as NodeJS.ProcessEnv;
  const MODELS = { availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'claude-opus-5.5', name: 'Claude Opus 5.5' }], currentModelId: 'auto' };
  let children: Array<ReturnType<typeof fakeChild>> = [];
  const setModels = () => children.flatMap((c) => c.written.filter((m) => m.method === 'session/set_model'));
  const use = (models: typeof MODELS | null) => {
    children = [];
    setKiroBackend({ spawn: () => { const c = fakeChild(models); children.push(c); return c; }, workspace: () => '/work/t' });
  };
  afterEach(() => { closeAllKiroSessions(); setKiroBackend(null); });

  it('a new session re-applies the last pick when Kiro offers it', async () => {
    use(MODELS);
    const r = await runKiroTurn({ threadId: 't1', userId: 'u1', message: 'hi', loadModelPick: async () => 'claude-opus-5.5' }, ENV);
    expect(r.meta.kiro_model).toBe('claude-opus-5.5');
    expect(r.meta.kiro_model_restore).toBe('applied:claude-opus-5.5');
    expect(setModels()).toHaveLength(1);
    expect(setModels()[0].params).toEqual({ sessionId: 'S1', modelId: 'claude-opus-5.5' });
    // the switch happens before the prompt
    const order = children[0].written.map((m) => m.method);
    expect(order.indexOf('session/set_model')).toBeLessThan(order.indexOf('session/prompt'));
  });

  it('a pick Kiro no longer offers leaves Kiro\'s model and says so', async () => {
    use(MODELS);
    const r = await runKiroTurn({ threadId: 't2', userId: 'u1', message: 'hi', loadModelPick: async () => 'gone-model' }, ENV);
    expect(setModels()).toHaveLength(0);
    expect(r.meta.kiro_model).toBe('auto');
    expect(r.meta.kiro_model_restore).toBe('unavailable:gone-model');
  });

  it('no pick, or the pick already current, sends nothing and reports nothing', async () => {
    use(MODELS);
    const a = await runKiroTurn({ threadId: 't3', userId: 'u1', message: 'hi', loadModelPick: async () => null }, ENV);
    const b = await runKiroTurn({ threadId: 't4', userId: 'u1', message: 'hi', loadModelPick: async () => 'auto' }, ENV);
    const c = await runKiroTurn({ threadId: 't5', userId: 'u1', message: 'hi' }, ENV);
    expect(setModels()).toHaveLength(0);
    for (const r of [a, b, c]) expect(r.meta.kiro_model_restore).toBeUndefined();
  });

  it('a live session never looks the pick up; a failed lookup does not break the turn', async () => {
    use(MODELS);
    const lookups = jest.fn(async () => 'claude-opus-5.5');
    await runKiroTurn({ threadId: 't6', userId: 'u1', message: 'one', loadModelPick: lookups }, ENV);
    await runKiroTurn({ threadId: 't6', userId: 'u1', message: 'two', loadModelPick: lookups }, ENV);
    expect(lookups).toHaveBeenCalledTimes(1);
    const r = await runKiroTurn({ threadId: 't7', userId: 'u1', message: 'hi', loadModelPick: async () => { throw new Error('db down'); } }, ENV);
    expect(r.meta.kiro_status ?? 'ok').not.toBe('error');
    expect(r.meta.kiro_model_restore).toBeUndefined();
  });

  it('there is no server-side default model', () => {
    const turn = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'kiro', 'kiro-turn.ts'), 'utf8');
    expect(turn).not.toMatch(/KIRO_PREFERRED_MODEL|KIRO_DEFAULT_MODEL/);
  });

  it('the Operator reads the pick from the model_selected event, owner and thread scoped', () => {
    const op = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'operator.ts'), 'utf8');
    expect(op).toContain('type=eq.operator.kiro.model_selected&actor_id=eq.');
    expect(op).toContain('payload->>thread_id=eq.');
    expect(op).toContain('loadHistory, loadModelPick });');
  });
});
