/**
 * VTID-05068: Kiro runs survive a gateway deploy — the parts the end-to-end
 * scenarios in test/vtid-04465-operator-pipeline-regression.test.ts
 * ("Kiro runs survive a gateway deploy (VTID-05068)") do not pin precisely:
 * the token derivation (never stored), the candidate rule, ACP adoption, and
 * the REAL remote backend over a real WebSocket against a runner double that
 * speaks the runner's reattach protocol (detach on 1001, `reattached` frame,
 * replayed frames in the same tick, 4403/4404 refusals). Plus the wiring.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  KIRO_REATTACH_DEFAULT_MS, hashKiroReattachToken, isKiroReattachConfigured, kiroReattachToken, kiroReattachWindowMs, newKiroReattachNonce,
} from '../src/services/kiro/kiro-reattach-token';
import { isReattachCandidate, KIRO_RUN_LIMITS } from '../src/services/kiro/kiro-runs';
import { AcpClient } from '../src/services/kiro/acp-client';
import { applyRunnerFrame, createRemoteKiroBackend, KiroReattachRefusedError, RUNNER_READY_FRAME } from '../src/services/kiro/remote-backend';
import { setKiroBackend, runKiroTurn, reattachKiroSession, detachKiroSession, closeAllKiroSessions } from '../src/services/kiro/kiro-turn';

const SECRET_ENV = { GATEWAY_INTERNAL_TOKEN: 'internal-secret-a' } as NodeJS.ProcessEnv;

describe('reattach token: derived, never stored', () => {
  it('is HMAC(nonce) under the gateway secret: same nonce + secret → same token; another secret or nonce → another token', () => {
    const nonce = newKiroReattachNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const a = kiroReattachToken(nonce, SECRET_ENV)!;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(kiroReattachToken(nonce, SECRET_ENV)).toBe(a);
    expect(kiroReattachToken(nonce, { GATEWAY_INTERNAL_TOKEN: 'internal-secret-b' } as NodeJS.ProcessEnv)).not.toBe(a);
    expect(kiroReattachToken(newKiroReattachNonce(), SECRET_ENV)).not.toBe(a);
    expect(a).not.toContain(nonce);
    // The stored hash is the hex sha256 the runner compares against.
    expect(hashKiroReattachToken(a)).toBe(createHash('sha256').update(a).digest('hex'));
  });

  it('no secret, a malformed nonce, or a window of 0 → not reattachable', () => {
    expect(kiroReattachToken(newKiroReattachNonce(), {} as NodeJS.ProcessEnv)).toBeNull();
    expect(kiroReattachToken('bad nonce!', SECRET_ENV)).toBeNull();
    expect(isKiroReattachConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isKiroReattachConfigured(SECRET_ENV)).toBe(true);
    expect(isKiroReattachConfigured({ ...SECRET_ENV, KIRO_RUNNER_REATTACH_MS: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(kiroReattachWindowMs({} as NodeJS.ProcessEnv)).toBe(KIRO_REATTACH_DEFAULT_MS);
    expect(KIRO_REATTACH_DEFAULT_MS).toBe(600_000);
    expect(kiroReattachWindowMs({ KIRO_RUNNER_REATTACH_MS: '90000' } as NodeJS.ProcessEnv)).toBe(90_000);
    expect(kiroReattachWindowMs({ KIRO_RUNNER_REATTACH_MS: 'x' } as NodeJS.ProcessEnv)).toBe(KIRO_REATTACH_DEFAULT_MS);
  });
});

describe('which other task\'s run is tried for a reattach', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const W = 600_000;
  const base = { status: 'running' as const, reattach_nonce: 'n'.repeat(22), reattach_token_hash: 'h'.repeat(64), reattach_expires_at: null as string | null, last_heartbeat_at: null as string | null };
  const iso = (ms: number) => new Date(ms).toISOString();

  it('let go on shutdown: inside the window yes (whatever the heartbeat), after it no', () => {
    expect(isReattachCandidate({ ...base, reattach_expires_at: iso(now + 1), last_heartbeat_at: iso(now - 5_000) }, now, W)).toBe(true);
    expect(isReattachCandidate({ ...base, reattach_expires_at: iso(now - 1), last_heartbeat_at: iso(now - 5_000) }, now, W)).toBe(false);
  });

  it('a crash: only once the heartbeat is stale (2 min), and only inside the window counted from it', () => {
    expect(isReattachCandidate({ ...base, last_heartbeat_at: iso(now - 60_000) }, now, W)).toBe(false);
    expect(isReattachCandidate({ ...base, last_heartbeat_at: iso(now - KIRO_RUN_LIMITS.staleMs - 1) }, now, W)).toBe(true);
    expect(isReattachCandidate({ ...base, last_heartbeat_at: iso(now - W - 1) }, now, W)).toBe(false);
    expect(isReattachCandidate({ ...base }, now, W)).toBe(false);
  });

  it('never: no identity stored, queued, finished, or reattach switched off', () => {
    const stale = { ...base, last_heartbeat_at: iso(now - 3 * 60_000) };
    expect(isReattachCandidate({ ...stale, reattach_nonce: null }, now, W)).toBe(false);
    expect(isReattachCandidate({ ...stale, reattach_token_hash: null }, now, W)).toBe(false);
    expect(isReattachCandidate({ ...stale, status: 'queued' }, now, W)).toBe(false);
    expect(isReattachCandidate({ ...stale, status: 'completed' as any }, now, W)).toBe(false);
    expect(isReattachCandidate({ ...stale, status: 'waiting_permission' }, now, W)).toBe(true);
    expect(isReattachCandidate(stale, now, 0)).toBe(false);
  });
});

describe('AcpClient: adopting a request another client sent, and letting go', () => {
  function child() {
    const stdout = new EventEmitter();
    const proc = new EventEmitter();
    const written: any[] = [];
    let detached = 0;
    return {
      c: { stdout, stdin: { write: (l: string) => { written.push(JSON.parse(l)); return true; }, end: () => {} }, kill: () => proc.emit('exit'), on: (e: string, cb: any) => proc.on(e, cb), detach: () => { detached += 1; proc.emit('exit'); } } as any,
      stdout, written, get detached() { return detached; },
    };
  }

  it('adopt(id) resolves with the answer to that id; later requests never reuse it', async () => {
    const k = child();
    const client = new AcpClient(k.c);
    const p = client.adopt<{ stopReason: string }>(7, 1_000);
    k.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } })}\n`);
    await expect(p).resolves.toEqual({ stopReason: 'end_turn' });
    void client.request('session/set_model', {}, 0).catch(() => undefined);
    expect(k.written[0].id).toBe(8);
  });

  it('detach(): the socket is let go (not killed) and a pending prompt is NOT failed here', async () => {
    const k = child();
    const client = new AcpClient(k.c);
    let settled = false;
    void client.prompt('S', 'hi').then(() => { settled = true; }, () => { settled = true; });
    expect(client.detach()).toBe(true);
    expect(k.detached).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(client.detach()).toBe(false);
  });

  it('a backend without detach (in-process child) cannot let go', () => {
    const k = child();
    delete k.c.detach;
    expect(new AcpClient(k.c).detach()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The REAL remote backend over a real socket. The double keeps one "kiro-cli"
// per thread alive across sockets, like services/kiro-runner/src/relay.ts.
// ---------------------------------------------------------------------------

const RUNNER_TOKEN = 'runner-token';
const USER = '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
const THREAD = 't-reattach';
const ENV = { KIRO_ENGINE_ENABLED: 'true', GATEWAY_INTERNAL_TOKEN: 'internal-secret-a' } as NodeJS.ProcessEnv;

interface Kiro { tokenHash: string | null; ws: WebSocket | null; buffer: string[]; pending: Set<number>; pendingAtDrop: number[]; release: (() => void) | null; closes: number[] }
let wss: WebSocketServer;
let kiros: Map<string, Kiro>;
let seenHeaders: Array<Record<string, unknown>>;
let seenUrls: string[];

function send(k: Kiro, o: unknown): void {
  const line = JSON.stringify(o);
  if (k.ws && k.ws.readyState === k.ws.OPEN) k.ws.send(line); else k.buffer.push(line);
}

function wire(k: Kiro, ws: WebSocket): void {
  k.ws = ws;
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.method === 'initialize') send(k, { jsonrpc: '2.0', id: m.id, result: {} });
    else if (m.method === 'session/new') send(k, { jsonrpc: '2.0', id: m.id, result: { sessionId: 'RS' } });
    else if (m.method === 'session/prompt') {
      k.pending.add(m.id);
      send(k, { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'RS', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one ' } } } });
      k.release = () => {
        send(k, { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'RS', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two ' } } } });
        send(k, { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'RS', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'three' } } } });
        k.pending.delete(m.id);
        send(k, { jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      };
    }
  });
  ws.on('close', (code) => {
    k.closes.push(code);
    if (k.ws !== ws) return;
    k.ws = null;
    k.pendingAtDrop = [...k.pending];
    if (code === 1000) kiros.delete(THREAD);
  });
}

beforeEach(async () => {
  kiros = new Map();
  seenHeaders = [];
  seenUrls = [];
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    seenHeaders.push({ ...req.headers });
    seenUrls.push(req.url ?? '');
    const u = new URL(req.url ?? '/', 'http://x');
    const thread = u.searchParams.get('thread_id') ?? '';
    const token = req.headers['x-kiro-reattach-token'];
    if (u.pathname === '/sessions') {
      const k: Kiro = { tokenHash: typeof token === 'string' ? createHash('sha256').update(token).digest('hex') : null, ws: null, buffer: [], pending: new Set(), pendingAtDrop: [], release: null, closes: [] };
      kiros.set(thread, k);
      wire(k, ws);
      ws.send(JSON.stringify({ kiro_runner: 'workspace', state: 'fresh' }));
      ws.send(RUNNER_READY_FRAME);
      return;
    }
    // /sessions/reattach
    const k = kiros.get(thread);
    if (!k) { ws.close(4404, 'kiro_session_not_found'); return; }
    if (typeof token !== 'string' || createHash('sha256').update(token).digest('hex') !== k.tokenHash) { ws.close(4403, 'kiro_reattach_refused'); return; }
    const replay = k.buffer.splice(0);
    wire(k, ws);
    // Everything in ONE tick, as the runner does: the client must not lose a replayed frame.
    ws.send(JSON.stringify({ kiro_runner: 'reattached', session_id: 'RS', pending_prompts: k.pendingAtDrop.map(String), replayed: replay.length }));
    for (const l of replay) ws.send(l);
  });
  await new Promise((r) => wss.once('listening', r));
  const url = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  setKiroBackend(createRemoteKiroBackend({ url, token: RUNNER_TOKEN }));
  Object.assign(process.env, { GATEWAY_INTERNAL_TOKEN: ENV.GATEWAY_INTERNAL_TOKEN });
});

afterEach(async () => {
  closeAllKiroSessions();
  setKiroBackend(null);
  delete process.env.GATEWAY_INTERNAL_TOKEN;
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(() => r(null)));
});

const waitFor = async (fn: () => boolean, ms = 3_000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };

describe('remote backend: a session survives its gateway task', () => {
  it('spawn sends the token in a header (never the URL); detach closes 1001; another client reattaches and finishes the turn with the buffered text', async () => {
    let record: { nonce: string; tokenHash: string } | null = null;
    const first = runKiroTurn({ threadId: THREAD, userId: USER, message: 'go', onReattach: (r) => { record = r; } }, ENV);
    await waitFor(() => !!kiros.get(THREAD)?.pending.size);
    const token = seenHeaders[0]['x-kiro-reattach-token'] as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(seenUrls[0]).not.toContain(token);
    expect(record).toEqual({ nonce: expect.any(String), tokenHash: createHash('sha256').update(token).digest('hex') });
    expect(kiroReattachToken(record!.nonce, ENV)).toBe(token);

    // The old task goes away mid-turn.
    expect(detachKiroSession(THREAD)).toBe(true);
    const k = kiros.get(THREAD)!;
    await waitFor(() => k.closes.length === 1);
    expect(k.closes).toEqual([1001]);
    let firstSettled = false;
    void first.then(() => { firstSettled = true; });
    k.release!(); // Kiro finishes while nobody listens
    expect(k.buffer.length).toBe(3);

    // The new task.
    expect(await reattachKiroSession({ threadId: THREAD, userId: USER, reattach: record! }, ENV)).toEqual({ ok: true });
    const reattachHeaders = seenHeaders[1];
    expect(seenUrls[1]).toMatch(/^\/sessions\/reattach\?/);
    expect(reattachHeaders['x-kiro-reattach-token']).toBe(token);
    const events: any[] = [];
    const r = await runKiroTurn({ threadId: THREAD, userId: USER, message: 'go', emit: (e) => events.push(e), resume: { priorReply: 'one ', priorTools: [] } }, ENV);
    expect(r.reply).toBe('one two three');
    expect(r.meta).toMatchObject({ kiro_status: 'ok', stop_reason: 'end_turn', kiro_reattached: true });
    expect(events.filter((e) => e.type === 'kiro.message_chunk').map((e) => e.text)).toEqual(['two ', 'three']);
    expect(events[events.length - 1]).toEqual({ type: 'kiro.turn_end', stop_reason: 'end_turn' });
    expect(firstSettled).toBe(false); // the old task's turn was never failed (it would have recorded an error)
  });

  it('refused: a wrong token → 4403, no session → 4404; both are KiroReattachRefusedError and nothing is registered', async () => {
    const first = runKiroTurn({ threadId: THREAD, userId: USER, message: 'go', onReattach: () => {} }, ENV);
    void first;
    await waitFor(() => !!kiros.get(THREAD)?.pending.size);
    expect(detachKiroSession(THREAD)).toBe(true);
    const wrong = { nonce: newKiroReattachNonce(), tokenHash: '' };
    wrong.tokenHash = hashKiroReattachToken(kiroReattachToken(wrong.nonce, ENV)!);
    expect(await reattachKiroSession({ threadId: THREAD, userId: USER, reattach: wrong }, ENV)).toMatchObject({ ok: false, reason: 'refused', message: 'kiro_reattach_refused' });
    expect(await reattachKiroSession({ threadId: 'other-thread', userId: USER, reattach: wrong }, ENV)).toMatchObject({ ok: false, reason: 'refused', message: 'kiro_session_not_found' });
    // A stored hash that does not match the derived token (rotated secret) is never presented.
    expect(await reattachKiroSession({ threadId: THREAD, userId: USER, reattach: { nonce: wrong.nonce, tokenHash: 'f'.repeat(64) } }, ENV)).toEqual({ ok: false, reason: 'token_mismatch' });
    expect(seenUrls.filter((u) => u.startsWith('/sessions/reattach'))).toHaveLength(2);
    const backend = createRemoteKiroBackend({ url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, token: RUNNER_TOKEN });
    await expect(backend.reattach!({ userId: USER, threadId: 'nope' }, 'x'.repeat(43))).rejects.toBeInstanceOf(KiroReattachRefusedError);
  });

  it('without the gateway secret (or a backend without reattach) nothing is minted and reattach is not supported', async () => {
    const env = { KIRO_ENGINE_ENABLED: 'true' } as NodeJS.ProcessEnv;
    delete process.env.GATEWAY_INTERNAL_TOKEN;
    let called = false;
    void runKiroTurn({ threadId: THREAD, userId: USER, message: 'go', onReattach: () => { called = true; } }, env);
    await waitFor(() => !!kiros.get(THREAD)?.pending.size);
    expect(seenHeaders[0]['x-kiro-reattach-token']).toBeUndefined();
    expect(called).toBe(false);
    expect(detachKiroSession(THREAD)).toBe(false);
    expect(await reattachKiroSession({ threadId: 'x', userId: USER, reattach: { nonce: newKiroReattachNonce(), tokenHash: '0' } }, env)).toEqual({ ok: false, reason: 'not_supported' });
  });

  it('the runner\'s reattached frame is read into runner info and kept out of the ACP stream', () => {
    const info: any = { workspace: null, dirty: null };
    expect(applyRunnerFrame(JSON.stringify({ kiro_runner: 'reattached', session_id: 'RS', pending_prompts: ['3', 'x', '-1'], replayed: 2 }), info)).toBe(true);
    expect(info.reattached).toEqual({ sessionId: 'RS', pendingPrompts: [3] });
  });
});

describe('wiring', () => {
  const root = path.resolve(__dirname, '../../..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('the migration adds the reattach columns (additive, nullable) and the schema doc lists them', () => {
    const sql = read('supabase/migrations/20261010220000_vtid_05068_kiro_run_reattach.sql');
    for (const c of ['reattach_nonce', 'reattach_token_hash', 'reattach_expires_at', 'turn_context']) expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${c}`);
    expect(sql).not.toMatch(/NOT NULL|DROP |CREATE POLICY/i);
    expect(sql).not.toMatch(/reattach_token\s/);
    const doc = read('DATABASE_SCHEMA.md');
    expect(doc).toContain('### Reattach columns on `kiro_runs` (VTID-05068');
    expect(doc).toContain('operator.kiro.run_reattached');
  });

  it('the OASIS topic is declared; the executor passes onReattach and resume through; the drain log counts detached runs', () => {
    expect(read('services/gateway/src/types/cicd.ts')).toContain("| 'operator.kiro.run_reattached'");
    expect(read('services/gateway/src/routes/operator.ts')).toContain('runKiroTurn({ onReattach: a.onReattach, resume: a.resume, ');
    expect(read('services/gateway/src/index.ts')).toContain('detached=${r.detached}');
  });

  it('the run API never selects the reattach columns', () => {
    const runs = read('services/gateway/src/services/kiro/kiro-runs.ts');
    const cols = /export const KIRO_RUN_COLUMNS = '([^']+)'/.exec(runs)![1];
    expect(cols).not.toMatch(/reattach|turn_context/);
  });
});
