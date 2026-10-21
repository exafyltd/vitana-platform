/**
 * VTID-04999: the gateway's kiro-runner backend.
 * A real `ws` server plays the runner (auth, ready frame, close codes) and
 * relays to the scripted fake `kiro-cli acp`, so the real AcpClient and
 * kiro-turn run end to end over a socket. Plus the key-route forwarding and
 * the guards that keep keys and production out of it.
 */
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { setKiroBackend, runKiroTurn, listKiroModels, setKiroModel, closeAllKiroSessions } from '../src/services/kiro/kiro-turn';
import { createRemoteKiroBackend, registerKiroBackendFromEnv, kiroKeyRequest, runnerConfig, RUNNER_READY_FRAME } from '../src/services/kiro/remote-backend';

const TOKEN = 'runner-token';
const USER = '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
const ENV = { KIRO_ENGINE_ENABLED: 'true' } as NodeJS.ProcessEnv;

const MODEL_OPTION = {
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'claude-sonnet',
  options: [{ value: 'claude-sonnet', name: 'Claude Sonnet' }, { value: 'claude-opus', name: 'Claude Opus' }],
};

/** What kiro-cli acp would answer, one frame per message. */
function acp(msg: any, send: (o: unknown) => void): void {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'R1', configOptions: [MODEL_OPTION] } });
  else if (msg.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{ ...MODEL_OPTION, currentValue: msg.params.value }] } });
  else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'R1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from Kiro' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
}

let wss: WebSocketServer;
let url: string;
let seen: { auth?: string; user?: string | null; thread?: string | null; frames: any[] };
let mode: 'ok' | 'no_key' | 'unavailable' = 'ok';

beforeEach(async () => {
  seen = { frames: [] };
  mode = 'ok';
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    seen.auth = req.headers.authorization;
    seen.user = q.get('user_id');
    seen.thread = q.get('thread_id');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { ws.close(4001, 'unauthorized'); return; }
    if (mode === 'no_key') { ws.close(4401, 'kiro_key_missing'); return; }
    if (mode === 'unavailable') { ws.close(1011, 'kiro_key_unavailable'); return; }
    ws.send(RUNNER_READY_FRAME);
    ws.on('message', (d) => { const m = JSON.parse(String(d)); seen.frames.push(m); acp(m, (o) => ws.send(JSON.stringify(o))); });
  });
  await new Promise((r) => wss.once('listening', r));
  url = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  setKiroBackend(createRemoteKiroBackend({ url, token: TOKEN }));
});

afterEach(async () => {
  closeAllKiroSessions();
  setKiroBackend(null);
  await new Promise((r) => wss.close(() => r(null)));
});

describe('remote backend, end to end over a socket', () => {
  it('runs a turn through the runner with the signed-in user and thread', async () => {
    const chunks: string[] = [];
    const r = await runKiroTurn({ threadId: 'thread-1', userId: USER, message: 'hi', emit: (e) => { if (e.type === 'kiro.message_chunk') chunks.push(e.text); } }, ENV);
    expect(r.meta).toMatchObject({ engine: 'kiro', kiro_status: 'ok', kiro_model: 'claude-sonnet' });
    expect(r.reply).toBe('Hello from Kiro');
    expect(chunks).toEqual(['Hello from Kiro']);
    expect(seen).toMatchObject({ auth: `Bearer ${TOKEN}`, user: USER, thread: 'thread-1' });
    // One JSON-RPC message per frame, no trailing newline, cwd left for the runner to rewrite.
    expect(seen.frames.map((f) => f.method)).toEqual(['initialize', 'session/new', 'session/prompt']);
  });

  it('lists and switches Kiro’s models through the runner', async () => {
    await runKiroTurn({ threadId: 't', userId: USER, message: 'hi' }, ENV);
    expect(listKiroModels('t', USER)).toMatchObject({ ok: true, current: 'claude-sonnet' });
    expect(await setKiroModel('t', USER, 'claude-opus')).toMatchObject({ ok: true, current: 'claude-opus' });
  });

  it('a user without a linked key gets "not connected" with the link hint', async () => {
    mode = 'no_key';
    const r = await runKiroTurn({ threadId: 't', userId: USER, message: 'hi' }, ENV);
    expect(r.meta).toMatchObject({ kiro_status: 'not_connected', error: 'kiro_key_missing' });
    expect(r.reply).toBe('Link your Kiro API key in the Kiro workspace panel.');
  });

  it('a transient key-store failure is a start error, not "no key"', async () => {
    mode = 'unavailable';
    const r = await runKiroTurn({ threadId: 't', userId: USER, message: 'hi' }, ENV);
    expect(r.meta).toMatchObject({ kiro_status: 'error', error: 'kiro_key_unavailable' });
  });

  it('the runner closing mid-session ends the turn as an error and forgets the session', async () => {
    await runKiroTurn({ threadId: 't', userId: USER, message: 'hi' }, ENV);
    for (const c of wss.clients) c.close(1011, 'kiro_exited_1');
    await new Promise((r) => setTimeout(r, 50));
    expect((await runKiroTurn({ threadId: 't', userId: USER, message: 'again' }, ENV)).meta.kiro_status).toBe('error');
    // The dead session is gone; the next turn opens a fresh one.
    expect((await runKiroTurn({ threadId: 't', userId: USER, message: 'once more' }, ENV)).meta.kiro_status).toBe('ok');
  });
});

describe('registration', () => {
  it('registers only when the engine, the runner URL and the token are all set', () => {
    expect(registerKiroBackendFromEnv({ KIRO_ENGINE_ENABLED: 'true', KIRO_RUNNER_URL: 'http://r' } as any)).toBe(false);
    expect(registerKiroBackendFromEnv({ KIRO_ENGINE_ENABLED: 'false', KIRO_RUNNER_URL: 'http://r', KIRO_RUNNER_TOKEN: 't' } as any)).toBe(false);
    expect(registerKiroBackendFromEnv({ KIRO_RUNNER_URL: 'http://r', KIRO_RUNNER_TOKEN: 't' } as any)).toBe(false);
    expect(registerKiroBackendFromEnv({ KIRO_ENGINE_ENABLED: 'true', KIRO_RUNNER_URL: 'http://r', KIRO_RUNNER_TOKEN: 't' } as any)).toBe(true);
    expect(runnerConfig({} as any)).toBeNull();
  });
});

describe('key forwarding', () => {
  const env = { KIRO_RUNNER_URL: 'http://kiro-runner.vitana.internal:8080/', KIRO_RUNNER_TOKEN: TOKEN } as any;

  it('sends the key to the runner for the given user and returns only the status', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, linked: true, updated_at: '2026-10-08T00:00:00.000Z', key: 'should-not-pass' }) }));
    const r = await kiroKeyRequest('PUT', USER, 'ksk_secret', env, fetchMock as any);
    expect(r).toEqual({ ok: true, linked: true, updated_at: '2026-10-08T00:00:00.000Z' });
    const [u, init] = (fetchMock.mock.calls[0] as any[]);
    expect(u).toBe(`http://kiro-runner.vitana.internal:8080/keys/${USER}`);
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ key: 'ksk_secret' });
  });

  it('GET and DELETE carry no body', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, linked: false, updated_at: null }) }));
    await kiroKeyRequest('GET', USER, undefined, env, fetchMock as any);
    await kiroKeyRequest('DELETE', USER, undefined, env, fetchMock as any);
    expect((fetchMock.mock.calls as any[]).map((c) => [c[1].method, c[1].body])).toEqual([['GET', undefined], ['DELETE', undefined]]);
  });

  it('reports a missing runner, a refused key and an unreachable runner', async () => {
    expect(await kiroKeyRequest('GET', USER, undefined, {} as any)).toEqual({ ok: false, error: 'kiro_runner_not_configured', status: 503 });
    const bad = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'invalid_key' }) }));
    expect(await kiroKeyRequest('PUT', USER, 'x', env, bad as any)).toEqual({ ok: false, error: 'invalid_key', status: 400 });
    const down = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await kiroKeyRequest('GET', USER, undefined, env, down as any)).toEqual({ ok: false, error: 'kiro_runner_unreachable', status: 502 });
  });
});

describe('routes and guards (source check)', () => {
  const root = path.join(__dirname, '../../..');
  const operator = fs.readFileSync(path.join(__dirname, '../src/routes/operator.ts'), 'utf8');
  const keyBlock = operator.slice(operator.indexOf('// ==================== Kiro API key (VTID-04999)'), operator.indexOf('GET /threads → /api/v1/operator/threads'));

  it('the key routes are admin-only and take the user id from the identity only', () => {
    expect(keyBlock).toContain("router.get('/kiro/key', requireAdminAuth,");
    expect(keyBlock).toContain("router.put('/kiro/key', requireAdminAuth,");
    expect(keyBlock).toContain("router.delete('/kiro/key', requireAdminAuth,");
    expect(keyBlock.match(/const userId = req\.identity\?\.user_id;/g)).toHaveLength(3);
    expect(keyBlock).not.toMatch(/req\.(body|params|query)\.user/);
  });

  it('link and revoke log OASIS events that never carry the key', () => {
    expect(keyBlock).toContain("type: 'operator.kiro.key_linked'");
    expect(keyBlock).toContain("type: 'operator.kiro.key_revoked'");
    expect(keyBlock).not.toMatch(/payload:\s*\{[^}]*key\b(?!_)/);
    expect(keyBlock).not.toMatch(/console\.(log|info|warn|error)/);
    const cicd = fs.readFileSync(path.join(__dirname, '../src/types/cicd.ts'), 'utf8');
    expect(cicd).toContain("| 'operator.kiro.key_linked'");
    expect(cicd).toContain("| 'operator.kiro.key_revoked'");
  });

  it('the backend is registered from the operator module and status reports the runner', () => {
    expect(operator).toContain('registerKiroBackendFromEnv();');
    // VTID-05003 made the status per-user; the runner flag is still reported.
    expect(operator).toContain('runner_configured: runnerConfigured');
  });

  it('production is never pointed at the staging kiro-runner', () => {
    // VTID-05003 shipped the production runner: production may name only the production
    // runner (kiro-runner-prod / vitana/kiro-runner/production), never staging's.
    const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(prod).not.toContain('kiro-runner.vitana.internal');
    expect(prod).not.toContain('vitana/kiro-runner/staging');
    expect(prod).toContain('http://kiro-runner-prod.vitana.internal:8080');
  });
});

describe('VTID-05064: runner status frames', () => {
  it('are applied to the runner info and never reach the ACP stream', () => {
    const { applyRunnerFrame } = jest.requireActual('../src/services/kiro/remote-backend');
    const info = { workspace: null, dirty: null } as any;
    expect(applyRunnerFrame('{"kiro_runner":"workspace","state":"restored"}', info)).toBe(true);
    expect(info.workspace).toBe('restored');
    expect(applyRunnerFrame('{"kiro_runner":"workspace_state","dirty":["vitana-platform",3]}', info)).toBe(true);
    expect(info.dirty).toEqual(['vitana-platform']);
    expect(applyRunnerFrame('{"jsonrpc":"2.0","id":1,"result":{}}', info)).toBe(false);
    expect(applyRunnerFrame('{"kiro_runner":', info)).toBe(false);
  });
});
