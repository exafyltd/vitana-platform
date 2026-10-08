/**
 * VTID-05002 — SSE ORB requests that land on the task without the session are
 * forwarded once to the owning task.
 *
 * Two real HTTP servers in this process stand in for the two gateway tasks of
 * a deploy overlap. Each mounts the real middleware in front of handlers that
 * read only their own session Map, exactly like the live routes read their
 * own `liveSessions`.
 */

import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  FORWARDED_HEADER,
  __setSelfAddressForTests,
  createCrossTaskForward,
  decodeOwner,
  encodeOwner,
  isPrivateIPv4,
  mintLiveSessionId,
  ownerTokenOf,
} from '../../src/orb/live/session/cross-task-forward';

const SECRET = 'test-internal-token';
const ENV_ON = { ORB_SSE_CROSS_TASK_FORWARD_ENABLED: 'true', GATEWAY_INTERNAL_TOKEN: SECRET };
const ENV_OFF = { GATEWAY_INTERNAL_TOKEN: SECRET };

type Task = {
  server: http.Server;
  port: number;
  sessions: Map<string, { sent: string[] }>;
  outbound: number;
};

async function startTask(env: Record<string, string>): Promise<Task> {
  const sessions = new Map<string, { sent: string[] }>();
  const app = express();
  app.use(express.json());
  const task = { sessions, outbound: 0 } as Task;
  const fwd = createCrossTaskForward({
    hasSession: (id) => sessions.has(id),
    getSessionId: (req) => (req.query.session_id as string) || (req.body || {}).session_id,
    allowTarget: (host) => host === '127.0.0.1', // loopback stands in for the VPC in this test
    env,
  });
  const counting: express.RequestHandler = (req, res, next) => {
    // Count requests this task forwards (they come back with the hop header).
    const end = res.end.bind(res);
    (res as any).end = (...a: any[]) => {
      if (res.getHeader('x-orb-served-by') === 'forward') task.outbound++;
      return end(...a);
    };
    next();
  };
  app.post('/api/v1/orb/live/stream/send', counting, fwd, (req, res) => {
    const s = sessions.get(req.query.session_id as string);
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    s.sent.push(String(req.body.chunk));
    res.json({ ok: true, served_by: task.port, forwarded: !!req.get(FORWARDED_HEADER), auth: req.get('authorization') });
  });
  app.post('/api/v1/orb/live/stream/end-turn', counting, fwd, (req, res) => {
    const s = sessions.get(req.body.session_id);
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, served_by: task.port });
  });
  app.post('/api/v1/orb/live/session/stop', counting, fwd, (req, res) => {
    if (!sessions.delete(req.body.session_id)) return res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, served_by: task.port });
  });
  app.get('/api/v1/orb/live/stream', counting, fwd, (req, res) => {
    const s = sessions.get(req.query.session_id as string);
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'ready', served_by: task.port })}\n\n`);
    setTimeout(() => { res.write('data: {"type":"done"}\n\n'); res.end(); }, 30);
  });
  await new Promise<void>((r) => { task.server = app.listen(0, '127.0.0.1', () => r()); });
  task.port = (task.server.address() as AddressInfo).port;
  return task;
}

function request(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {})
  : Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: {
      ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
      authorization: 'Bearer member-jwt', ...headers,
    } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('VTID-05002: owner token', () => {
  it('round-trips and is opaque', () => {
    const t = encodeOwner('10.0.3.17:8080', SECRET);
    expect(t).not.toContain('10.0');
    expect(decodeOwner(t, SECRET)).toBe('10.0.3.17:8080');
  });
  it('rejects a token made with another key or tampered with', () => {
    const t = encodeOwner('10.0.3.17:8080', SECRET);
    expect(decodeOwner(t, 'other')).toBeNull();
    const raw = Buffer.from(t, 'base64url'); raw[raw.length - 1] ^= 1;
    expect(decodeOwner(raw.toString('base64url'), SECRET)).toBeNull();
    expect(decodeOwner('not-a-token', SECRET)).toBeNull();
  });
  it('only private IPv4 targets are allowed by default', () => {
    for (const ok of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1']) expect(isPrivateIPv4(ok)).toBe(true);
    for (const no of ['127.0.0.1', '169.254.169.254', '8.8.8.8', '172.32.0.1', 'localhost', '10.0.0.256']) expect(isPrivateIPv4(no)).toBe(false);
  });
});

describe('VTID-05002: session id', () => {
  afterEach(() => __setSelfAddressForTests(undefined));
  it('is live-<uuid> exactly as before when the flag is off', async () => {
    __setSelfAddressForTests('10.0.0.5:8080');
    expect(await mintLiveSessionId(ENV_OFF)).toMatch(/^live-[0-9a-f-]{36}$/);
  });
  it('is live-<uuid> when the task does not know its address (local dev)', async () => {
    __setSelfAddressForTests(null);
    expect(await mintLiveSessionId(ENV_ON)).toMatch(/^live-[0-9a-f-]{36}$/);
  });
  it('is live-<uuid> when the internal token is missing', async () => {
    __setSelfAddressForTests('10.0.0.5:8080');
    expect(await mintLiveSessionId({ ORB_SSE_CROSS_TASK_FORWARD_ENABLED: 'true' })).toMatch(/^live-[0-9a-f-]{36}$/);
  });
  it('carries the encrypted owner when on', async () => {
    __setSelfAddressForTests('10.0.0.5:8080');
    const id = await mintLiveSessionId(ENV_ON);
    expect(id).toMatch(/^live-[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
    expect(decodeOwner(ownerTokenOf(id)!, SECRET)).toBe('10.0.0.5:8080');
  });
});

describe('VTID-05002: two tasks in a deploy overlap', () => {
  let a: Task; let b: Task;
  let sid: string;

  beforeEach(async () => {
    a = await startTask(ENV_ON);
    b = await startTask(ENV_ON);
    // Session started on A: A mints the id with its own address.
    __setSelfAddressForTests(`127.0.0.1:${a.port}`);
    sid = await mintLiveSessionId(ENV_ON);
    a.sessions.set(sid, { sent: [] });
    // From here on, "this process" is B for the self-address check.
    __setSelfAddressForTests(`127.0.0.1:${b.port}`);
  });
  afterEach(async () => {
    __setSelfAddressForTests(undefined);
    await Promise.all([a, b].map((t) => new Promise((r) => t.server.close(r))));
  });

  it('serves send on B by forwarding to A, body and auth intact', async () => {
    const r = await request(b.port, 'POST', `/api/v1/orb/live/stream/send?session_id=${sid}`, { chunk: 'pcm-1' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, served_by: a.port, forwarded: true, auth: 'Bearer member-jwt' });
    expect(r.headers['x-orb-served-by']).toBe('forward');
    expect(a.sessions.get(sid)!.sent).toEqual(['pcm-1']);
  });

  it('serves end-turn and stop (session id in the body) through the forward', async () => {
    const e = await request(b.port, 'POST', '/api/v1/orb/live/stream/end-turn', { session_id: sid });
    expect(JSON.parse(e.text).served_by).toBe(a.port);
    const s = await request(b.port, 'POST', '/api/v1/orb/live/session/stop', { session_id: sid });
    expect(JSON.parse(s.text)).toEqual({ ok: true, served_by: a.port });
    expect(a.sessions.has(sid)).toBe(false);
  });

  it('streams the SSE response through without buffering it away', async () => {
    const r = await request(b.port, 'GET', `/api/v1/orb/live/stream?session_id=${sid}&token=t`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.text).toContain(`"served_by":${a.port}`);
    expect(r.text).toContain('"type":"done"');
  });

  it('serves locally on the owner, with no forward', async () => {
    __setSelfAddressForTests(`127.0.0.1:${a.port}`);
    const r = await request(a.port, 'POST', `/api/v1/orb/live/stream/send?session_id=${sid}`, { chunk: 'x' });
    expect(r.headers['x-orb-served-by']).toBeUndefined();
    expect(JSON.parse(r.text).forwarded).toBe(false);
  });

  it('never forwards a forwarded request again (one hop)', async () => {
    const r = await request(b.port, 'POST', `/api/v1/orb/live/stream/send?session_id=${sid}`, { chunk: 'x' },
      { [FORWARDED_HEADER]: 'someone' });
    expect(r.status).toBe(404);
    expect(a.sessions.get(sid)!.sent).toEqual([]);
  });

  it('a forged owner (other key) gets today\'s 404 and no outbound request', async () => {
    const forged = `live-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.${encodeOwner(`127.0.0.1:${a.port}`, 'attacker')}`;
    a.sessions.set(forged, { sent: [] });
    const r = await request(b.port, 'POST', `/api/v1/orb/live/stream/send?session_id=${forged}`, { chunk: 'x' });
    expect(r.status).toBe(404);
    expect(a.sessions.get(forged)!.sent).toEqual([]);
  });

  it('a target outside the allowed range is refused (SSRF guard)', async () => {
    const outside = `live-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.${encodeOwner('169.254.169.254:80', SECRET)}`;
    const r = await request(b.port, 'POST', `/api/v1/orb/live/stream/send?session_id=${outside}`, { chunk: 'x' });
    expect(r.status).toBe(404);
    expect(r.headers['x-orb-served-by']).toBeUndefined();
  });

  it('an id without an owner part behaves exactly as today', async () => {
    const r = await request(b.port, 'POST', '/api/v1/orb/live/stream/send?session_id=live-abc', { chunk: 'x' });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text)).toEqual({ ok: false, error: 'Session not found' });
  });

  it('owner gone (connection refused) falls back to the local 404', async () => {
    await new Promise((r) => a.server.close(r));
    const r = await request(b.port, 'POST', `/api/v1/orb/live/stream/send?session_id=${sid}`, { chunk: 'x' });
    expect(r.status).toBe(404);
    a = await startTask(ENV_ON); // so afterEach can close something
  });
});

describe('VTID-05002: flag off', () => {
  it('is byte-identical 404 behaviour even for an id that carries an owner', async () => {
    const a = await startTask(ENV_OFF);
    const b = await startTask(ENV_OFF);
    const sid = `live-${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}.${encodeOwner(`127.0.0.1:${a.port}`, SECRET)}`;
    a.sessions.set(sid, { sent: [] });
    try {
      const r = await request(b.port, 'POST', `/api/v1/orb/live/stream/send?session_id=${sid}`, { chunk: 'x' });
      expect(r.status).toBe(404);
      expect(JSON.parse(r.text)).toEqual({ ok: false, error: 'Session not found' });
      expect(a.sessions.get(sid)!.sent).toEqual([]);
    } finally {
      await Promise.all([a, b].map((t) => new Promise((r) => t.server.close(r))));
    }
  });
});

describe('VTID-05002: wiring in the gateway', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const orbLive = fs.readFileSync(path.resolve(__dirname, '../../src/routes/orb-live.ts'), 'utf8');
  const controller = fs.readFileSync(path.resolve(__dirname, '../../src/orb/live/session/live-session-controller.ts'), 'utf8');
  it('all four SSE session routes run the forward right after auth', () => {
    for (const r of [
      "router.get('/live/stream', optionalAuth, orbSseCrossTaskForward,",
      "router.post('/live/stream/send', optionalAuth, orbSseCrossTaskForward,",
      "router.post('/live/stream/end-turn', optionalAuth, orbSseCrossTaskForward,",
      "router.post('/live/session/stop', optionalAuth, orbSseCrossTaskForward,",
    ]) expect(orbLive).toContain(r);
  });
  it('the session id is minted by mintLiveSessionId', () => {
    expect(controller).toContain('const sessionId = await mintLiveSessionId();');
    expect(controller).not.toContain('const sessionId = `live-${randomUUID()}`;');
  });
});
