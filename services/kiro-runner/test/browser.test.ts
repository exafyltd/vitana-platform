/**
 * VTID-05070: the `vitana-browser` tool path in the runner — the relay is attached only when
 * this task has the screenshot sidecar (KIRO_BROWSER_URL) and the session has a gateway pass;
 * kiro-cli gets a localhost URL and a per-session token, never the pass, the registry token
 * or the test user's password; the token is registered with the sidecar and removed at the end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { KeyStore, type SecretsClient } from '../src/key-store';
import { createRunnerServer } from '../src/server';
import { childEnv, mcpServersFor, stopAllSessions, READY_FRAME } from '../src/relay';
import { BROWSER_PROXY_PATH, browserConfigFromEnv, browserServerEntry, openBrowserSession } from '../src/browser';
import { BROWSER_TOOL, handle } from '../src/browser-proxy';

const FAKE = path.join(__dirname, 'fixtures/fake-kiro-cli.js');
const TOKEN = 'runner-token-abc';
const U1 = '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
const PASS = 'eyJ1IjoidSJ9.c2ln';
const REG = 'registry-token-0123456789abcdef';
const limits = { idleMs: 60_000, maxSessionMs: 60_000, pingMs: 60_000, maxLineBytes: 1024 * 1024, maxBufferedBytes: 8 * 1024 * 1024 };

class OneKeySM implements SecretsClient {
  async send(cmd: any) {
    if (cmd.constructor.name === 'GetSecretValueCommand') return { SecretString: 'ksk_user_one' };
    throw Object.assign(new Error('ResourceNotFoundException'), { name: 'ResourceNotFoundException' });
  }
}

/** A stand-in for the kiro-browser sidecar's registry. */
let sidecar: http.Server; let sidecarUrl = ''; const registry: Array<{ method: string; auth: string; body: any }> = [];
let runner: http.Server; let base = '';
const saved = { url: process.env.KIRO_BROWSER_URL, reg: process.env.KIRO_BROWSER_REGISTRY_TOKEN };

beforeEach(async () => {
  registry.length = 0;
  sidecar = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { registry.push({ method: req.method!, auth: req.headers.authorization ?? '', body: b ? JSON.parse(b) : null }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise<void>((r) => sidecar.listen(0, '127.0.0.1', () => r()));
  sidecarUrl = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
});
afterEach(async () => {
  stopAllSessions();
  await new Promise((r) => runner?.close(() => r(null)) ?? r(null));
  await new Promise((r) => sidecar.close(() => r(null)));
  process.env.KIRO_BROWSER_URL = saved.url; process.env.KIRO_BROWSER_REGISTRY_TOKEN = saved.reg;
  if (saved.url === undefined) delete process.env.KIRO_BROWSER_URL;
  if (saved.reg === undefined) delete process.env.KIRO_BROWSER_REGISTRY_TOKEN;
});

async function startRunner() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-browser-test-'));
  runner = createRunnerServer({ token: TOKEN, workRoot: work, maxSessions: 10, limits, kiroCliVersion: '2.28.0', kiroBin: FAKE, mcpGatewayUrl: 'https://preview-aws-gateway.vitanaland.com', log: () => {} }, new KeyStore(new OneKeySM(), 'vitana/kiro/staging/users'));
  await new Promise<void>((r) => runner.listen(0, '127.0.0.1', () => r()));
  base = `127.0.0.1:${(runner.address() as AddressInfo).port}`;
}

async function sessionNew(headers: Record<string, string>) {
  const ws = new WebSocket(`ws://${base}/sessions?user_id=${U1}&thread_id=t1`, { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } });
  const frames: any[] = [];
  const ready = new Promise<void>((r) => ws.on('message', (d) => { const s = String(d); if (s === READY_FRAME) r(); else { const m = JSON.parse(s); if (!m.kiro_runner) frames.push(m); } }));
  const closed = new Promise<void>((r) => ws.on('close', () => r()));
  await ready;
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/etc', mcpServers: [] } }));
  const t = Date.now();
  while (frames.length === 0) { if (Date.now() - t > 3000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
  return { ws, result: frames[0].result, closed };
}
const waitFor = async (fn: () => boolean) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > 3000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

describe('vitana-browser relay (VTID-05070)', () => {
  it('with KIRO_BROWSER_URL and a pass: vitana + vitana-browser; the sidecar gets the token and the pass; removed at the end', async () => {
    process.env.KIRO_BROWSER_URL = sidecarUrl;
    process.env.KIRO_BROWSER_REGISTRY_TOKEN = REG;
    await startRunner();
    const s = await sessionNew({ 'X-Kiro-Mcp-Token': PASS });
    const mcp = s.result.echo_mcp;
    expect(mcp.map((m: any) => m.name)).toEqual(['vitana', 'vitana-browser']);
    expect(mcp[1]).toMatchObject({ command: process.execPath, args: [BROWSER_PROXY_PATH] });
    expect(mcp[1].env.map((e: any) => e.name)).toEqual(['KIRO_BROWSER_URL', 'KIRO_BROWSER_SESSION_TOKEN']);
    expect(mcp[1].env[0].value).toBe(sidecarUrl);
    const sessionToken = mcp[1].env[1].value;
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Nothing but the URL and the session token: not the pass, not the registry token.
    expect(JSON.stringify(mcp[1])).not.toContain(PASS);
    expect(JSON.stringify(mcp[1])).not.toContain(REG);
    await waitFor(() => registry.length >= 1);
    expect(registry[0]).toEqual({ method: 'POST', auth: `Bearer ${REG}`, body: { session_token: sessionToken, gateway_pass: PASS } });
    // kiro-cli's own environment has none of it.
    expect(s.result.env_keys.filter((k: string) => /BROWSER|MCP|REGISTRY|PASSWORD/.test(k))).toEqual([]);
    s.ws.close();
    await s.closed;
    await waitFor(() => registry.length >= 2);
    expect(registry[1]).toEqual({ method: 'DELETE', auth: `Bearer ${REG}`, body: { session_token: sessionToken } });
  });

  it('without KIRO_BROWSER_URL: only the vitana relay, and the sidecar is never called', async () => {
    delete process.env.KIRO_BROWSER_URL;
    process.env.KIRO_BROWSER_REGISTRY_TOKEN = REG;
    await startRunner();
    const s = await sessionNew({ 'X-Kiro-Mcp-Token': PASS });
    expect(s.result.echo_mcp.map((m: any) => m.name)).toEqual(['vitana']);
    s.ws.close();
    await s.closed;
    expect(registry).toEqual([]);
  });

  it('with KIRO_BROWSER_URL but no pass: no MCP servers at all (screenshots need the pass to be stored)', async () => {
    process.env.KIRO_BROWSER_URL = sidecarUrl;
    process.env.KIRO_BROWSER_REGISTRY_TOKEN = REG;
    await startRunner();
    const s = await sessionNew({});
    expect(s.result.echo_mcp).toEqual([]);
    s.ws.close();
    await s.closed;
    expect(registry).toEqual([]);
  });

  it('only a loopback http URL and a real registry token turn it on', () => {
    expect(browserConfigFromEnv({ KIRO_BROWSER_URL: 'http://127.0.0.1:8090', KIRO_BROWSER_REGISTRY_TOKEN: REG })).toEqual({ url: 'http://127.0.0.1:8090', registryToken: REG });
    expect(browserConfigFromEnv({ KIRO_BROWSER_URL: 'http://localhost:8090/', KIRO_BROWSER_REGISTRY_TOKEN: REG })?.url).toBe('http://localhost:8090');
    for (const url of ['http://kiro-browser.vitana.internal:8090', 'https://127.0.0.1:8090', 'http://10.0.0.5:8090', '', 'http://127.0.0.1']) {
      expect(browserConfigFromEnv({ KIRO_BROWSER_URL: url, KIRO_BROWSER_REGISTRY_TOKEN: REG })).toBeNull();
    }
    expect(browserConfigFromEnv({ KIRO_BROWSER_URL: 'http://127.0.0.1:8090', KIRO_BROWSER_REGISTRY_TOKEN: 'short' })).toBeNull();
  });

  it('the registry token, the pass and the password never reach kiro-cli’s env', () => {
    const env = childEnv('k', '/w', { PATH: '/bin', KIRO_BROWSER_URL: 'http://127.0.0.1:8090', KIRO_BROWSER_REGISTRY_TOKEN: REG, KIRO_BROWSER_TEST_USER_PASSWORD: 'pw' } as NodeJS.ProcessEnv);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'KIRO_API_KEY', 'LANG', 'PATH', 'TMPDIR']);
    const cfg = { url: 'http://127.0.0.1:8090', registryToken: REG };
    const session = { token: 'T'.repeat(43), close() {} };
    expect(mcpServersFor(null, { cfg, session })).toEqual([]);
    expect(JSON.stringify(browserServerEntry(cfg, session))).not.toContain(REG);
  });

  it('a session token is minted per session', () => {
    const f = (async () => new Response('{}')) as any;
    const a = openBrowserSession({ url: 'http://127.0.0.1:1', registryToken: REG }, PASS, () => {}, f);
    const b = openBrowserSession({ url: 'http://127.0.0.1:1', registryToken: REG }, PASS, () => {}, f);
    expect(a.token).not.toBe(b.token);
  });
});

describe('browser-proxy: the vitana-browser MCP server (VTID-05070)', () => {
  const env = { url: 'http://127.0.0.1:8090', token: 'T'.repeat(43) };
  const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id: 7, method, params });

  it('initialize names the server vitana-browser (the permission title is "Running: @vitana-browser/browser_screenshot")', async () => {
    const r: any = await handle(rpc('initialize', { protocolVersion: '2025-03-26' }), fetch, env);
    expect(r.result.serverInfo.name).toBe('vitana-browser');
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(BROWSER_TOOL.name).toBe('browser_screenshot');
    expect(BROWSER_TOOL.annotations.readOnlyHint).toBe(true);
  });

  it('tools/list offers the tool only while the sidecar reports a working browser', async () => {
    const alive = (ok: boolean) => (async (u: any) => { expect(String(u)).toBe('http://127.0.0.1:8090/alive'); return new Response(JSON.stringify({ ok: true, browser: { ok } })); }) as any;
    expect(((await handle(rpc('tools/list'), alive(true), env)) as any).result.tools.map((t: any) => t.name)).toEqual(['browser_screenshot']);
    expect(((await handle(rpc('tools/list'), alive(false), env)) as any).result.tools).toEqual([]);
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    expect(((await handle(rpc('tools/list'), down, env)) as any).result.tools).toEqual([]);
  });

  it('tools/call forwards the arguments with the session token; the sidecar’s errors reach Kiro as tool errors', async () => {
    const calls: any[] = [];
    const ok = (async (u: any, i: any) => { calls.push({ u: String(u), i }); return new Response(JSON.stringify({ ok: true, images: [{ media_id: 'm1', width: 1400, height: 900 }] })); }) as any;
    const r: any = await handle(rpc('tools/call', { name: 'browser_screenshot', arguments: { url: 'https://preview-aws.vitanaland.com/' } }), ok, env);
    expect(calls[0].u).toBe('http://127.0.0.1:8090/screenshot');
    expect(calls[0].i.headers.Authorization).toBe(`Bearer ${env.token}`);
    expect(JSON.parse(calls[0].i.body)).toEqual({ url: 'https://preview-aws.vitanaland.com/' });
    expect(r.result).toEqual({ content: [{ type: 'text', text: '{"images":[{"media_id":"m1","width":1400,"height":900}]}' }], isError: false });
    const limit = (async () => new Response(JSON.stringify({ ok: false, error: 'screenshot limit reached for this run' }), { status: 429 })) as any;
    const r2: any = await handle(rpc('tools/call', { name: 'browser_screenshot', arguments: {} }), limit, env);
    expect(r2.result).toEqual({ content: [{ type: 'text', text: 'screenshot limit reached for this run' }], isError: true });
    const r3: any = await handle(rpc('tools/call', { name: 'other_tool' }), ok, env);
    expect(r3.error.code).toBe(-32602);
  });

  it('notifications get no answer', async () => {
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, fetch, env)).toBeNull();
  });
});
