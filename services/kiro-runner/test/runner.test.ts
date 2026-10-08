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
import { childEnv, rewriteCwd, sessionCount, stopAllSessions, READY_FRAME } from '../src/relay';

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

function open(userId = U1, thread = 't1'): Promise<{ ws: WebSocket; frames: any[]; closed: Promise<{ code: number; reason: string }>; ready: Promise<void> }> {
  const ws = new WebSocket(`ws://${base}/sessions?user_id=${userId}&thread_id=${thread}`, { headers: auth });
  const frames: any[] = [];
  let onReady: () => void; const ready = new Promise<void>((r) => { onReady = r; });
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  ws.on('message', (d) => { const s = String(d); if (s === READY_FRAME) onReady(); else frames.push(JSON.parse(s)); });
  return Promise.resolve({ ws, frames, closed, ready });
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
