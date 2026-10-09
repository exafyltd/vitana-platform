/**
 * VTID-05005: a Kiro session gets the Operator's read tools over MCP.
 * The pass (signature, environment, expiry), the route's gates (off, no pass,
 * non-admin, rate limit), the exact read set, the identity adapter (both maps
 * registered for the call and removed after), the OASIS log, the header the
 * gateway sends the runner, and the workflow wiring per environment.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

const mockEmit = jest.fn(async (_e: any) => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (e: any) => mockEmit(e) }));

import { mintKiroMcpToken, verifyKiroMcpToken, KIRO_MCP_TOKEN_TTL_MS } from '../src/services/kiro/kiro-mcp-token';
import { callKiroMcpTool, kiroMcpTools, KIRO_MCP_READ_TOOLS } from '../src/services/kiro/kiro-mcp-tools';
import { getThreadAuth } from '../src/services/operator-execute-authz';
import router, { resetKiroMcpLimits, setKiroMcpAdminLookup } from '../src/routes/operator-kiro-mcp';

const U = '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
const STAGING = { GATEWAY_INTERNAL_TOKEN: 'internal-secret-staging', VITANA_ENV: 'staging' } as NodeJS.ProcessEnv;
const PROD = { GATEWAY_INTERNAL_TOKEN: 'internal-secret-prod' } as NodeJS.ProcessEnv;

describe('the session pass', () => {
  it('verifies for its own environment, user and thread until it expires', () => {
    const t = mintKiroMcpToken(U, 'thread-1', STAGING, 1_000)!;
    expect(verifyKiroMcpToken(t, STAGING, 2_000)).toEqual({ ok: true, claims: { userId: U, threadId: 'thread-1', env: 'staging', expiresAt: 1_000 + KIRO_MCP_TOKEN_TTL_MS } });
    expect(KIRO_MCP_TOKEN_TTL_MS).toBeLessThanOrEqual(60 * 60_000);
    expect(verifyKiroMcpToken(t, STAGING, 1_000 + KIRO_MCP_TOKEN_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a forged, tampered, cross-environment or garbage pass; no secret = cannot sign', () => {
    const t = mintKiroMcpToken(U, 'thread-1', STAGING)!;
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'someone-else', t: 'x', e: 'staging', x: Date.now() + 1e6 })).toString('base64url');
    expect(verifyKiroMcpToken(`${forged}.${sig}`, STAGING)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyKiroMcpToken(`${body}.${sig.slice(0, -2)}AA`, STAGING).ok).toBe(false);
    // A staging pass never works on production, even if both secrets were the same.
    expect(verifyKiroMcpToken(t, PROD).ok).toBe(false);
    expect(verifyKiroMcpToken(t, { ...STAGING, VITANA_ENV: 'production' }).ok).toBe(false);
    expect(verifyKiroMcpToken('nonsense', STAGING)).toEqual({ ok: false, reason: 'malformed' });
    expect(mintKiroMcpToken(U, 't', {} as any)).toBeNull();
    expect(verifyKiroMcpToken(t, {} as any)).toEqual({ ok: false, reason: 'unconfigured' });
  });
});

describe('the tool set', () => {
  it('is exactly the approved read set, each declared once, with an object schema', () => {
    const tools = kiroMcpTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...KIRO_MCP_READ_TOOLS].sort());
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('holds no write tool', () => {
    const names = kiroMcpTools().map((t) => t.name);
    for (const w of ['dev_create_pr', 'dev_merge_pr', 'dev_deploy_service', 'autopilot_execute_task', 'autopilot_run_task', 'dev_approve_item', 'dev_approve_spec', 'send_chat_message', 'run_code']) {
      expect(names).not.toContain(w);
    }
  });

  it('runs a tool as the caller: auth + identity registered for the call only, then removed', async () => {
    let seen: { id: string; auth: any } | null = null;
    const exec = jest.fn(async (_n: string, _a: any, threadId: string) => {
      seen = { id: threadId, auth: getThreadAuth(threadId) };
      return { ok: true, data: { hello: 'world' } };
    });
    const r = await callKiroMcpTool({ userId: U, tenantId: 'tenant-1', threadId: 'th' }, 'dev_deep_dive', { question: 'q' }, exec as any);
    expect(r).toEqual({ ok: true, text: '{"hello":"world"}' });
    expect(seen!.id).toMatch(/^kiro-mcp:th:/);
    // dev_deep_dive's own check: a signed-in developer session.
    expect(seen!.auth).toEqual({ user_id: U, exafy_admin: true });
    expect(getThreadAuth(seen!.id)).toBeUndefined();
  });

  it('refuses unknown tools and callers without a user; a thrown tool is an error result', async () => {
    const exec = jest.fn();
    expect((await callKiroMcpTool({ userId: U, tenantId: null, threadId: 't' }, 'dev_merge_pr', {}, exec as any)).ok).toBe(false);
    expect((await callKiroMcpTool({ userId: '', tenantId: null, threadId: 't' }, 'dev_read_file', {}, exec as any)).ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    const boom = jest.fn(async () => { throw new Error('kaput'); });
    expect(await callKiroMcpTool({ userId: U, tenantId: null, threadId: 't' }, 'dev_read_file', {}, boom as any)).toEqual({ ok: false, text: 'The tool failed: kaput' });
  });
});

describe('POST /api/v1/operator/kiro/mcp', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/operator/kiro/mcp', router);
  const saved = { ...process.env };
  let admin = true;

  beforeEach(() => {
    Object.assign(process.env, { KIRO_MCP_ENABLED: 'true', GATEWAY_INTERNAL_TOKEN: 'internal-secret-staging', VITANA_ENV: 'staging' });
    admin = true;
    setKiroMcpAdminLookup(async () => ({ admin, tenantId: 'tenant-1' }));
    resetKiroMcpLimits();
    mockEmit.mockClear();
  });
  afterAll(() => { process.env = saved; setKiroMcpAdminLookup(null); });

  const pass = () => `Bearer ${mintKiroMcpToken(U, 'thread-9')}`;
  const rpc = (body: unknown, auth: string | null = pass()) => {
    const r = request(app).post('/api/v1/operator/kiro/mcp').send(body as object);
    return auth ? r.set('Authorization', auth) : r;
  };

  it('is off (404) unless KIRO_MCP_ENABLED=true', async () => {
    process.env.KIRO_MCP_ENABLED = 'false';
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
  });

  it('401 without or with a bad pass, 503 when the gateway cannot verify, 403 for a non-admin', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer abc.def')).status).toBe(401);
    const p = pass();
    delete process.env.GATEWAY_INTERNAL_TOKEN;
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, p)).status).toBe(503);
    process.env.GATEWAY_INTERNAL_TOKEN = 'internal-secret-staging';
    admin = false;
    setKiroMcpAdminLookup(async () => ({ admin, tenantId: null }));
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(403);
  });

  it('initialize and tools/list answer as MCP; notifications get 202', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'vitana' }, capabilities: { tools: {} } });
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.body.result.tools.map((t: any) => t.name).sort()).toEqual([...KIRO_MCP_READ_TOOLS].sort());
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });

  it('tools/call refuses a write tool and logs a read call to OASIS without its arguments', async () => {
    const w = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dev_merge_pr', arguments: {} } });
    expect(w.body.error.message).toBe('Unknown tool: dev_merge_pr');
    const r = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dev_domain_atlas', arguments: { query: 'secret-arg-value' } } });
    expect(r.body.result.content[0].type).toBe('text');
    expect(typeof r.body.result.isError).toBe('boolean');
    // executeTool keeps its own Operator logging; ours is exactly one tool_called event.
    const ours = mockEmit.mock.calls.map((c) => c[0]).filter((e) => e.type === 'operator.kiro.tool_called');
    expect(ours).toHaveLength(1);
    const ev = ours[0];
    expect(ev).toMatchObject({ vtid: 'VTID-05005', type: 'operator.kiro.tool_called', actor_id: U, payload: { tool: 'dev_domain_atlas', thread_id: 'thread-9' } });
    expect(JSON.stringify(ev)).not.toContain('secret-arg-value');
  });

  it('rate-limits a runaway loop per user (429)', async () => {
    let last = 0;
    for (let i = 0; i < 241; i++) last = (await rpc({ jsonrpc: '2.0', id: i, method: 'ping' })).status;
    expect(last).toBe(429);
  });
});

describe('wiring (source check)', () => {
  const root = path.join(__dirname, '../../..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('the gateway sends the pass to the runner in a header, never the URL', () => {
    const rb = read('services/gateway/src/services/kiro/remote-backend.ts');
    expect(rb).toContain("headers['X-Kiro-Mcp-Token'] = mcpToken;");
    expect(rb).not.toMatch(/URLSearchParams\(\{[^}]*mcp/i);
  });

  it('the route is mounted before the operator router and claimed by the domain atlas', () => {
    const idx = read('services/gateway/src/index.ts');
    expect(idx.indexOf("'/api/v1/operator/kiro/mcp'")).toBeGreaterThan(0);
    expect(idx.indexOf("'/api/v1/operator/kiro/mcp'")).toBeLessThan(idx.indexOf("mountRouterSync(app, '/api/v1/operator', operatorRouter"));
    expect(read('services/gateway/src/orb/developer/domain-atlas.ts')).toContain('/^operator-kiro-mcp$/');
    expect(read('services/gateway/src/types/cicd.ts')).toContain("| 'operator.kiro.tool_called'");
  });

  it('each environment turns the tools on with its engine and points its runner at its own gateway', () => {
    expect(read('.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml')).toContain('{name:"KIRO_MCP_ENABLED", value:"true"}');
    expect(read('.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml')).toContain('{name:"KIRO_MCP_ENABLED", value:"true"}');
    const stageRunner = read('.github/workflows/AWS-STAGE-DEPLOY-KIRO-RUNNER.yml');
    const prodRunner = read('.github/workflows/AWS-PROD-DEPLOY-KIRO-RUNNER.yml');
    expect(stageRunner).toContain('MCP_GATEWAY_URL: https://preview-aws-gateway.vitanaland.com');
    expect(stageRunner).not.toContain('https://gateway.vitanaland.com');
    expect(prodRunner).toContain('MCP_GATEWAY_URL: https://gateway.vitanaland.com');
    expect(prodRunner).not.toContain('preview-aws-gateway');
  });
});
