/**
 * VTID-04999 kiro-runner: auth, the key store (never echoes, status never
 * reads the value, revoke force-deletes and ends sessions), and the relay
 * against a fake kiro-cli (frames both ways, cwd rewrite, child env, bounds).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { KeyStore, isPlausibleKey, onlyRunnerReadsPolicy, type SecretsClient } from '../src/key-store';
import { createRunnerServer, tokenMatches } from '../src/server';
import { childEnv, mcpServersFor, MCP_PROXY_PATH, rewriteCwd, sessionCount, stopAllSessions, READY_FRAME } from '../src/relay';
import { PARK_MARKER, park, parkedCount, rescanParked, resetParked, sweepParked, takeParked } from '../src/workspace-park';
import { promptRequestId, responseId } from '../src/relay';

const FAKE = path.join(__dirname, 'fixtures/fake-kiro-cli.js');
const TOKEN = 'runner-token-abc';
const U1 = '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
const U2 = '11111111-2222-4333-8444-555555555555';

class FakeSM implements SecretsClient {
  secrets = new Map<string, { value: string; changed: Date }>();
  calls: string[] = [];
  failGet: string | null = null;
  policies = new Map<string, string>();
  async send(cmd: any) {
    const name = cmd.constructor.name as string;
    const input = cmd.input;
    this.calls.push(name);
    const err = (n: string) => Object.assign(new Error(n), { name: n });
    const id = input.SecretId ?? input.Name;
    switch (name) {
      case 'CreateSecretCommand': if (this.secrets.has(id)) throw err('ResourceExistsException'); this.secrets.set(id, { value: input.SecretString, changed: new Date() }); return {};
      case 'PutSecretValueCommand': this.secrets.set(id, { value: input.SecretString, changed: new Date() }); return {};
      case 'DescribeSecretCommand': { const s = this.secrets.get(id); if (!s) throw err('ResourceNotFoundException'); return { Name: id, LastChangedDate: s.changed }; }
      case 'GetSecretValueCommand': { if (this.failGet) throw err(this.failGet); const s = this.secrets.get(id); if (!s) throw err('ResourceNotFoundException'); return { SecretString: s.value }; }
      case 'PutResourcePolicyCommand': this.policies.set(id, input.ResourcePolicy); return {};
      case 'DeleteSecretCommand': if (!input.ForceDeleteWithoutRecovery) throw new Error('expected force delete'); if (!this.secrets.delete(id)) throw err('ResourceNotFoundException'); return {};
    }
    throw new Error(`unexpected ${name}`);
  }
}

let sm: FakeSM; let server: ReturnType<typeof createRunnerServer>; let base: string; let work: string; const logs: string[] = [];
const limits = { idleMs: 60_000, maxSessionMs: 60_000, pingMs: 60_000, maxLineBytes: 1024 * 1024, maxBufferedBytes: 8 * 1024 * 1024 };

async function start(over: Partial<Parameters<typeof createRunnerServer>[0]> = {}) {
  sm = new FakeSM();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-runner-test-'));
  server = createRunnerServer({ token: TOKEN, workRoot: work, maxSessions: 10, limits, kiroCliVersion: '2.28.0', kiroBin: FAKE, log: (m) => logs.push(m), ...over }, new KeyStore(sm, 'vitana/kiro/staging/users'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => { stopAllSessions(); await new Promise((r) => server.close(() => r(null))); logs.length = 0; });

const auth = { Authorization: `Bearer ${TOKEN}` };
const http = (method: string, p: string, body?: unknown, headers: Record<string, string> = auth) =>
  fetch(`http://${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

function open(userId = U1, thread = 't1', extra: Record<string, string> = {}): Promise<{ ws: WebSocket; frames: any[]; runner: any[]; closed: Promise<{ code: number; reason: string }>; ready: Promise<void> }> {
  const ws = new WebSocket(`ws://${base}/sessions?user_id=${userId}&thread_id=${thread}`, { headers: { ...auth, ...extra } });
  const frames: any[] = [];
  let onReady: () => void; const ready = new Promise<void>((r) => { onReady = r; });
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  // VTID-05064: runner status frames ({kiro_runner: ...}) are kept apart from the relayed JSON-RPC frames.
  const runner: any[] = [];
  ws.on('message', (d) => { const s = String(d); if (s === READY_FRAME) onReady(); else { const m = JSON.parse(s); (m && m.kiro_runner ? runner : frames).push(m); } });
  return Promise.resolve({ ws, frames, runner, closed, ready });
}
const waitFor = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

describe('auth', () => {
  beforeEach(() => start());
  it('/alive is open and reports the kiro-cli version', async () => {
    const r = await http('GET', '/alive', undefined, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, service: 'kiro-runner', kiro_cli_version: '2.28.0' });
  });
  it('key routes need the token', async () => {
    expect((await http('GET', `/keys/${U1}`, undefined, {})).status).toBe(401);
    expect((await http('GET', `/keys/${U1}`, undefined, { Authorization: 'Bearer wrong-token-xyz' })).status).toBe(401);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches(`Bearer ${TOKEN}`, '')).toBe(false);
  });
  it('a session needs the token', async () => {
    const ws = new WebSocket(`ws://${base}/sessions?user_id=${U1}&thread_id=t1`);
    const status = await new Promise((r) => ws.on('unexpected-response', (_q, res) => r(res.statusCode)));
    expect(status).toBe(401);
  });
});

describe('key store', () => {
  beforeEach(() => start());
  it('links, never echoes, and status never reads the value', async () => {
    expect(await (await http('GET', `/keys/${U1}`)).json()).toEqual({ ok: true, linked: false, updated_at: null });
    const put = await http('PUT', `/keys/${U1}`, { key: 'ksk_secret_value_123' });
    const text = await put.text();
    expect(put.status).toBe(200);
    expect(text).not.toContain('ksk_secret_value_123');
    expect(JSON.parse(text)).toMatchObject({ ok: true, linked: true });
    expect(sm.secrets.get(`vitana/kiro/staging/users/${U1}`)?.value).toBe('ksk_secret_value_123');
    sm.calls.length = 0;
    await http('GET', `/keys/${U1}`);
    expect(sm.calls).toEqual(['DescribeSecretCommand']);
    expect(logs.join('\n')).not.toContain('ksk_secret_value_123');
    expect(logs.join('\n')).not.toContain(U1);
  });
  it('replaces an existing key', async () => {
    await http('PUT', `/keys/${U1}`, { key: 'first' });
    await http('PUT', `/keys/${U1}`, { key: 'second' });
    expect(sm.secrets.get(`vitana/kiro/staging/users/${U1}`)?.value).toBe('second');
  });
  it('rejects a bad user id and an implausible key', async () => {
    expect((await http('GET', '/keys/not-a-uuid')).status).toBe(400);
    expect((await http('PUT', `/keys/${U1}`, { key: 'has space' })).status).toBe(400);
    expect((await http('PUT', `/keys/${U1}`, { key: '' })).status).toBe(400);
    expect(isPlausibleKey('x'.repeat(4097))).toBe(false);
  });
  it('revoke force-deletes and ends that user’s sessions only', async () => {
    await http('PUT', `/keys/${U1}`, { key: 'k1' });
    await http('PUT', `/keys/${U2}`, { key: 'k2' });
    const a = await open(U1, 'a'); const b = await open(U2, 'b');
    await a.ready; await b.ready;
    const del = await (await http('DELETE', `/keys/${U1}`)).json();
    expect(del).toMatchObject({ ok: true, linked: false, sessions_ended: 1 });
    expect((await a.closed).reason).toBe('kiro_key_revoked');
    expect(sm.secrets.has(`vitana/kiro/staging/users/${U1}`)).toBe(false);
    expect(sessionCount()).toBe(1);
    b.ws.close();
  });
});

describe('relay', () => {
  beforeEach(async () => { await start(); await http('PUT', `/keys/${U1}`, { key: 'ksk_user_one' }); });

  it('relays frames both ways in the session’s own directory, with only the allowlisted env', async () => {
    const s = await open();
    await s.ready;
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/etc', mcpServers: [] } }));
    await waitFor(() => s.frames.length >= 2);
    const r = s.frames[1].result;
    expect(r.echo_cwd).toBe(r.proc_cwd);
    expect(r.echo_cwd.startsWith(work)).toBe(true);
    expect(r.key).toBe('ksk_user_one');
    expect(r.env_keys).toEqual(['HOME', 'KIRO_API_KEY', 'LANG', 'PATH', 'TMPDIR']);
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'S1', prompt: [{ type: 'text', text: 'hello' }] } }));
    await waitFor(() => s.frames.length >= 4);
    expect(s.frames[2].method).toBe('session/update');
    expect(s.frames[3].result.stopReason).toBe('end_turn');
    const dir = r.echo_cwd;
    s.ws.close();
    await waitFor(() => !fs.existsSync(dir));
  });

  it('closes 4401 when the user has no key', async () => {
    const s = await open(U2);
    expect(await s.closed).toEqual({ code: 4401, reason: 'kiro_key_missing' });
  });

  it('closes 1011 when Secrets Manager cannot be asked (transient, not "no key")', async () => {
    sm.failGet = 'ThrottlingException';
    const s = await open();
    expect(await s.closed).toEqual({ code: 1011, reason: 'kiro_key_unavailable' });
  });

  it('closes 1011 when kiro-cli exits (e.g. not logged in) and logs its message', async () => {
    await http('PUT', `/keys/${U1}`, { key: 'not-logged-in' });
    const s = await open();
    const c = await s.closed;
    expect(c.code).toBe(1011);
    expect(c.reason).toMatch(/^kiro_exited/);
    await waitFor(() => logs.some((l) => l.includes('kiro-cli said: Error: You are not logged in')));
  });

  it('enforces the cap on a complete (newline-terminated) line too', async () => {
    const s = await open();
    await s.ready;
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'S1', prompt: [{ type: 'text', text: 'bigline' }] } }));
    expect(await s.closed).toEqual({ code: 1009, reason: 'kiro_line_too_long' });
    expect(s.frames).toHaveLength(0);
  });

  it('decodes a multi-byte character split across stdout chunks', async () => {
    const s = await open();
    await s.ready;
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'S1', prompt: [{ type: 'text', text: 'utf8' }] } }));
    await waitFor(() => s.frames.length >= 1);
    expect(s.frames[0].result.text).toBe('café ünïcode');
    s.ws.close();
  });

  it('kills the session when kiro-cli writes a line over the cap', async () => {
    const s = await open();
    await s.ready;
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'S1', prompt: [{ type: 'text', text: 'flood' }] } }));
    expect(await s.closed).toEqual({ code: 1009, reason: 'kiro_line_too_long' });
  });
});

describe('bounds', () => {
  it('closes 4429 at the runner’s own cap', async () => {
    await start({ maxSessions: 1 });
    await http('PUT', `/keys/${U1}`, { key: 'k' });
    const a = await open(U1, 'a'); await a.ready;
    const b = await open(U1, 'b');
    expect(await b.closed).toEqual({ code: 4429, reason: 'kiro_runner_busy' });
    a.ws.close();
  });
  it('reserves the slot before the key read, so concurrent connects cannot pass the cap', async () => {
    await start({ maxSessions: 1 });
    await http('PUT', `/keys/${U1}`, { key: 'k' });
    const realGet = sm.send.bind(sm);
    sm.send = async (cmd: any) => { if (cmd.constructor.name === 'GetSecretValueCommand') await new Promise((r) => setTimeout(r, 80)); return realGet(cmd); };
    const a = await open(U1, 'a'); const b = await open(U1, 'b'); const c = await open(U1, 'c');
    const results = await Promise.race([Promise.all([b.closed, c.closed]), new Promise((r) => setTimeout(() => r('timeout'), 2000))]);
    expect(results).toEqual([{ code: 4429, reason: 'kiro_runner_busy' }, { code: 4429, reason: 'kiro_runner_busy' }]);
    await a.ready;
    expect(sessionCount()).toBe(1);
    a.ws.close();
  });

  it('ends an idle session', async () => {
    await start({ limits: { ...limits, idleMs: 150 } });
    await http('PUT', `/keys/${U1}`, { key: 'k' });
    const s = await open();
    expect(await s.closed).toEqual({ code: 4408, reason: 'kiro_session_idle' });
  });
  it('ends a session at its absolute lifetime even while busy', async () => {
    await start({ limits: { ...limits, maxSessionMs: 200 } });
    await http('PUT', `/keys/${U1}`, { key: 'k' });
    const s = await open(); await s.ready;
    const t = setInterval(() => s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })), 30);
    try { expect(await s.closed).toEqual({ code: 4410, reason: 'kiro_session_max_lifetime' }); } finally { clearInterval(t); }
  });
});

describe('relink right after a revoke', () => {
  it('retries the create while the old secret is still pending deletion', async () => {
    const fake = new FakeSM();
    let pendingDeletion = 2;
    const send = fake.send.bind(fake);
    fake.send = async (cmd: any) => {
      const err = (n: string) => Object.assign(new Error(n), { name: n });
      if (pendingDeletion > 0 && cmd.constructor.name === 'CreateSecretCommand') { pendingDeletion--; throw err('InvalidRequestException'); }
      return send(cmd);
    };
    const sleeps: number[] = [];
    const store = new KeyStore(fake, 'p', null, async (ms) => { sleeps.push(ms); });
    await store.put(U1, 'new-key');
    expect(fake.secrets.get(`p/${U1}`)?.value).toBe('new-key');
    expect(sleeps).toEqual([500, 1000]);
  });
  it('a pending deletion seen as "exists" then put-fails is retried too, and gives up after 6 tries', async () => {
    const fake = new FakeSM();
    const err = (n: string) => Object.assign(new Error(n), { name: n });
    fake.send = async (cmd: any) => {
      if (cmd.constructor.name === 'CreateSecretCommand') throw err('ResourceExistsException');
      if (cmd.constructor.name === 'PutSecretValueCommand') throw err('InvalidRequestException');
      return {};
    };
    const sleeps: number[] = [];
    await expect(new KeyStore(fake, 'p', null, async (ms) => { sleeps.push(ms); }).put(U1, 'k')).rejects.toThrow('ResourceExistsException');
    expect(sleeps).toHaveLength(5);
  });
});

describe('only the runner reads keys', () => {
  it('every linked key gets a Deny-read-unless-runner resource policy', async () => {
    const fake = new FakeSM();
    const role = 'arn:aws:iam::472838866351:role/vitana-kiro-runner-task-role';
    await new KeyStore(fake, 'p', role).put(U1, 'k');
    const pol = JSON.parse(fake.policies.get(`p/${U1}`)!);
    expect(pol.Statement[0]).toMatchObject({ Effect: 'Deny', Principal: '*', Action: 'secretsmanager:GetSecretValue', Condition: { StringNotEquals: { 'aws:PrincipalArn': role } } });
    expect(onlyRunnerReadsPolicy(role)).toContain(role);
  });
});

describe('helpers', () => {
  it('childEnv never carries the runner’s own env', () => {
    const env = childEnv('k', '/work/x', { PATH: '/bin', AWS_SECRET_ACCESS_KEY: 's', KIRO_RUNNER_TOKEN: 't', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2' } as any);
    expect(env).toEqual({ PATH: '/bin', LANG: 'C.UTF-8', HOME: '/work/x', TMPDIR: '/work/x/.tmp', KIRO_API_KEY: 'k' });
  });
  it('rewriteCwd only touches session/new and session/load', () => {
    expect(JSON.parse(rewriteCwd('{"method":"session/load","params":{"cwd":"/"}}', '/w')).params.cwd).toBe('/w');
    expect(rewriteCwd('{"method":"session/prompt","params":{"cwd":"/"}}', '/w')).toContain('"cwd":"/"');
    expect(rewriteCwd('not json', '/w')).toBe('not json');
  });
});

// VTID-05005: the `vitana` tools — the runner, never the gateway, decides the MCP servers.
const PASS = 'eyJ1IjoidSJ9.c2ln';
describe('vitana tools (VTID-05005)', () => {
  const newSession = (s: { ws: WebSocket }, servers: unknown) =>
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/etc', mcpServers: servers } }));

  it('with a pass and a gateway URL: exactly the vitana relay, whatever the gateway sent', async () => {
    await start({ mcpGatewayUrl: 'https://preview-aws-gateway.vitanaland.com/' });
    await http('PUT', `/keys/${U1}`, { key: 'ksk_user_one' });
    const s = await open(U1, 't1', { 'X-Kiro-Mcp-Token': PASS });
    await s.ready;
    newSession(s, [{ name: 'evil', command: '/bin/sh', args: ['-c', 'id'] }]);
    await waitFor(() => s.frames.length >= 1);
    const mcp = s.frames[0].result.echo_mcp;
    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toMatchObject({ name: 'vitana', command: process.execPath, args: [MCP_PROXY_PATH] });
    expect(mcp[0].env).toEqual([
      { name: 'VITANA_MCP_URL', value: 'https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/mcp' },
      { name: 'VITANA_MCP_TOKEN', value: PASS },
    ]);
    s.ws.close();
  });

  it('no pass, a malformed pass, or no gateway URL: no MCP servers at all', async () => {
    await start({ mcpGatewayUrl: 'https://preview-aws-gateway.vitanaland.com' });
    await http('PUT', `/keys/${U1}`, { key: 'ksk_user_one' });
    for (const extra of [{}, { 'X-Kiro-Mcp-Token': 'not a token; rm -rf /' }]) {
      const s = await open(U1, 't1', extra);
      await s.ready;
      newSession(s, [{ name: 'evil', command: '/bin/sh' }]);
      await waitFor(() => s.frames.length >= 1);
      expect(s.frames[0].result.echo_mcp).toEqual([]);
      s.ws.close();
      await s.closed;
    }
    expect(mcpServersFor({ gatewayUrl: '', token: PASS })).toEqual([]);
    expect(mcpServersFor(null)).toEqual([]);
  });

  it('session/load gets the same list; other methods are untouched', () => {
    const servers = mcpServersFor({ gatewayUrl: 'https://gateway.vitanaland.com', token: PASS });
    expect(JSON.parse(rewriteCwd('{"method":"session/load","params":{"cwd":"/","mcpServers":[{"name":"x"}]}}', '/w', servers)).params.mcpServers).toEqual(servers);
    expect(rewriteCwd('{"method":"session/prompt","params":{"mcpServers":[1]}}', '/w', servers)).toContain('"mcpServers":[1]');
  });

  it('the pass reaches only the relay env, never kiro-cli’s own env', () => {
    expect(Object.keys(childEnv('k', '/w'))).not.toContain('VITANA_MCP_TOKEN');
  });
});

describe('mcp-proxy (VTID-05005)', () => {
  it('posts each message with the pass and returns the gateway answer; notifications get none', async () => {
    process.env.VITANA_MCP_URL = 'https://gw/api/v1/operator/kiro/mcp';
    process.env.VITANA_MCP_TOKEN = PASS;
    const { forward } = await import('../src/mcp-proxy');
    const calls: any[] = [];
    const ok = (async (u: string, init: any) => { calls.push([u, init]); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), { status: 200 }); }) as any;
    expect(await forward('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', ok)).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    expect(calls[0][0]).toBe('https://gw/api/v1/operator/kiro/mcp');
    expect(calls[0][1].headers.Authorization).toBe(`Bearer ${PASS}`);
    const accepted = (async () => new Response(null, { status: 202 })) as any;
    expect(await forward('{"jsonrpc":"2.0","method":"notifications/initialized"}', accepted)).toBeNull();
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    expect(await forward('{"jsonrpc":"2.0","id":7,"method":"tools/list"}', down)).toMatchObject({ id: 7, error: { message: expect.stringContaining('unreachable') } });
    expect(await forward('not json', ok)).toMatchObject({ error: { code: -32700 } });
  });
});

// VTID-05006: both repos in every session; Kiro abandoning a call aborts it.
import { execFileSync } from 'child_process';
import { RepoMirrors } from '../src/repo-mirrors';

describe('repo mirrors (VTID-05006)', () => {
  it('clones once, then gives each session its own worktree of main; a missing repo never blocks', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-mirror-'));
    const origin = path.join(tmp, 'origin');
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    fs.writeFileSync(path.join(origin, 'README.md'), 'hello\n');
    execFileSync('git', ['-C', origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
    execFileSync('git', ['-C', origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    const root = path.join(tmp, 'work');
    const logs: string[] = [];
    const m = new RepoMirrors(root, [{ name: 'repo-a', url: origin }, { name: 'repo-missing', url: path.join(tmp, 'nope') }], (l) => logs.push(l));
    await m.refresh();
    expect(m.isReady('repo-a')).toBe(true);
    expect(m.isReady('repo-missing')).toBe(false);
    expect(logs.some((l) => l.includes('repo-missing refresh failed'))).toBe(true);
    const s1 = path.join(root, 's1'); const s2 = path.join(root, 's2');
    fs.mkdirSync(s1); fs.mkdirSync(s2);
    expect(await m.addWorktrees(s1)).toEqual(['repo-a']);
    expect(await m.addWorktrees(s2)).toEqual(['repo-a']);
    expect(fs.readFileSync(path.join(s1, 'repo-a', 'README.md'), 'utf8')).toBe('hello\n');
    // Each session edits its own copy.
    fs.writeFileSync(path.join(s1, 'repo-a', 'README.md'), 'changed\n');
    expect(fs.readFileSync(path.join(s2, 'repo-a', 'README.md'), 'utf8')).toBe('hello\n');
    // Session gone: its worktree is pruned on the next refresh.
    fs.rmSync(s1, { recursive: true, force: true });
    await m.refresh();
    expect(await m.addWorktrees(path.join(root, 'gone'))).toEqual([]);
  });
});

describe('mcp-proxy cancellation (VTID-05006)', () => {
  it('notifications/cancelled aborts the matching in-flight call', async () => {
    process.env.VITANA_MCP_URL = 'https://gw/api/v1/operator/kiro/mcp';
    process.env.VITANA_MCP_TOKEN = 'a.b';
    const { dispatch, handleCancel, inFlight } = await import('../src/mcp-proxy');
    let aborted = false;
    const hang = ((_u: string, init: any) => new Promise((_r, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    })) as any;
    const outs: unknown[] = [];
    const p = dispatch('{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"dev_merge_pr"}}', (m) => outs.push(m), hang);
    expect(inFlight.has('42')).toBe(true);
    expect(handleCancel('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":42}}')).toBe(true);
    await p;
    expect(aborted).toBe(true);
    expect(inFlight.has('42')).toBe(false);
    expect(outs[0]).toMatchObject({ id: 42, error: { message: expect.stringContaining('unreachable') } });
  });
});

describe('parked workspaces (VTID-05064)', () => {
  const parkLimits = { ttlMs: 60_000, maxParked: 20 };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd });
  beforeEach(async () => { resetParked(); await start({ park: parkLimits }); await http('PUT', `/keys/${U1}`, { key: 'k' }); });
  afterEach(() => resetParked());

  async function sessionDir(s: Awaited<ReturnType<typeof open>>): Promise<string> {
    await s.ready;
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/x', mcpServers: [] } }));
    await waitFor(() => s.frames.length >= 1);
    return s.frames[0].result.echo_cwd;
  }
  function repoIn(dir: string, dirty: boolean): void {
    const r = path.join(dir, 'repo-a');
    fs.mkdirSync(r);
    execFileSync('git', ['init', '-q', '-b', 'main', r]);
    fs.writeFileSync(path.join(r, 'a.txt'), 'one\n');
    git(r, 'add', '.'); git(r, 'commit', '-qm', 'init');
    if (dirty) fs.writeFileSync(path.join(r, 'a.txt'), 'edited\n');
  }

  it('a dirty workspace survives the session and the same thread gets it back; another thread starts fresh', async () => {
    const s1 = await open(U1, 'thread-a');
    const dir = await sessionDir(s1);
    expect(s1.runner).toEqual([{ kiro_runner: 'workspace', state: 'fresh' }]);
    repoIn(dir, true);
    s1.ws.close();
    await waitFor(() => fs.existsSync(path.join(dir, PARK_MARKER)));
    expect(parkedCount()).toBe(1);

    const other = await open(U1, 'thread-b');
    expect(await sessionDir(other)).not.toBe(dir);
    expect(other.runner[0]).toEqual({ kiro_runner: 'workspace', state: 'fresh' });

    const s2 = await open(U1, 'thread-a');
    expect(await sessionDir(s2)).toBe(dir);
    expect(s2.runner[0]).toEqual({ kiro_runner: 'workspace', state: 'restored' });
    expect(fs.readFileSync(path.join(dir, 'repo-a', 'a.txt'), 'utf8')).toBe('edited\n');
    expect(fs.existsSync(path.join(dir, PARK_MARKER))).toBe(false);
    expect(parkedCount()).toBe(0);
  });

  it('a clean workspace is removed as before', async () => {
    const s = await open(U1, 'thread-c');
    const dir = await sessionDir(s);
    repoIn(dir, false);
    s.ws.close();
    await waitFor(() => !fs.existsSync(dir));
    expect(takeParked(U1, 'thread-c')).toBeNull();
  });

  it('each prompt response is preceded by the workspace state', async () => {
    const s = await open(U1, 'thread-d');
    const dir = await sessionDir(s);
    repoIn(dir, true);
    s.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: 'S1', prompt: [{ type: 'text', text: 'hello' }] } }));
    await waitFor(() => s.frames.some((f) => f.id === 7));
    expect(s.runner).toContainEqual({ kiro_runner: 'workspace_state', dirty: ['repo-a'] });
  });

  it('a revoked key removes that user’s parked workspace', async () => {
    const s = await open(U1, 'thread-e');
    const dir = await sessionDir(s);
    repoIn(dir, true);
    s.ws.close();
    await waitFor(() => parkedCount() === 1);
    await http('DELETE', `/keys/${U1}`);
    await waitFor(() => !fs.existsSync(dir));
    expect(takeParked(U1, 'thread-e')).toBeNull();
  });

  it('retention TTL and the parked cap remove the oldest; a restart rescans the markers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-park-'));
    const mk = (n: string) => { const d = path.join(root, n); fs.mkdirSync(d); return d; };
    const log: string[] = [];
    park(mk('a'), U1, 't-a', { ttlMs: 1000, maxParked: 2 }, (m) => log.push(m), 1_000);
    park(mk('b'), U1, 't-b', { ttlMs: 1000, maxParked: 2 }, (m) => log.push(m), 2_000);
    park(mk('c'), U1, 't-c', { ttlMs: 1000, maxParked: 2 }, (m) => log.push(m), 3_000);
    expect(parkedCount()).toBe(2);
    expect(log.some((l) => l.includes('over the parked cap'))).toBe(true);
    await waitFor(() => !fs.existsSync(path.join(root, 'a')));
    resetParked();
    expect(rescanParked(root, { ttlMs: 10_000_000_000_000, maxParked: 20 }, () => {})).toBe(2);
    expect(sweepParked({ ttlMs: 1000, maxParked: 20 }, () => {}, 3_500)).toBe(1);
    expect(parkedCount()).toBe(1);
    expect(takeParked(U1, 't-c')).toBe(path.join(root, 'c'));
    expect(takeParked(U1, 't-c')).toBeNull();
  });

  it('helpers recognise prompt requests and responses only', () => {
    expect(promptRequestId(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {} }))).toBe('3');
    expect(promptRequestId(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/new', params: {} }))).toBeNull();
    expect(responseId(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }))).toBe('3');
    expect(responseId(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }))).toBeNull();
  });
});
