/**
 * VTID-05070 — Kiro takes read-only screenshots on staging (Phase 5 of the Kiro runs plan).
 *
 * The end-to-end scenario (auto-allowed title in a real run, `kiro.image` live and on replay,
 * the cross-task inbox, 10 per run) lives in the operator pipeline suite
 * (test/vtid-04465-operator-pipeline-regression.test.ts, "Kiro screenshot (VTID-05070)").
 * This file pins what that scenario cannot pin precisely:
 *   - the media route's auth with the Kiro session pass (off, missing, broken, non-admin),
 *     its refusals (not a PNG, too large, bad viewport), and the owner-only re-sign;
 *   - the trusted title END TO END through the ACP client (kind defaulting) and the broker,
 *     and that any other title from the browser server still asks;
 *   - the session rule line, the mount / atlas / OASIS wiring, the sidecar's Dockerfile pins,
 *     and the task-definition wiring in both runner deploy workflows.
 */
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  ...jest.requireActual('../src/middleware/auth-supabase-jwt'),
  requireAdminAuth: (req: any, res: any, next: any) => {
    const u = req.headers['x-test-user'];
    if (!u) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: u };
    return next();
  },
}));
jest.mock('../src/services/oasis-event-service', () => ({ ...jest.requireActual('../src/services/oasis-event-service'), emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }) }));

import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';
import mediaRouter, { KIRO_SCREENSHOT_LIMIT_ERROR } from '../src/routes/operator-kiro-media';
import { resetKiroMcpLimits, setKiroMcpAdminLookup } from '../src/routes/operator-kiro-mcp';
import { mintKiroMcpToken } from '../src/services/kiro/kiro-mcp-token';
import { setKiroMediaStore, kiroMediaPath, isPng } from '../src/services/kiro/kiro-media-store';
import { KIRO_RUN_SCREENSHOT_LIMIT, setKiroRunExecutor, startKiroRun, resetKiroRunsForTests, liveKiroRunIds } from '../src/services/kiro/kiro-runs';
import { KIRO_BROWSER_TOOL_TITLE, makePermissionHandler, trustedKiroReadTool, answerPermission } from '../src/services/kiro/permission-broker';
import { AcpClient, type AcpChild } from '../src/services/kiro/acp-client';
import { KIRO_SESSION_RULES } from '../src/services/kiro/kiro-turn';
import type { KiroTurnEvent } from '../src/services/kiro/kiro-events';

const ROOT = path.join(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const USER = 'd5070000-0000-4000-8000-000000000001';
const THREAD = 'a5070000-0000-4000-8000-000000000001';

function png(w = 1400, h = 900, extra = 0): Buffer {
  const b = Buffer.alloc(40 + extra);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

describe('media route: the Kiro session pass, refusals, owner-only re-sign', () => {
  const saved = { mcp: process.env.KIRO_MCP_ENABLED, internal: process.env.GATEWAY_INTERNAL_TOKEN, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE };
  const objects = new Map<string, Buffer>();
  let app: express.Express;
  let admin = true;

  beforeEach(() => {
    Object.assign(process.env, { KIRO_MCP_ENABLED: 'true', GATEWAY_INTERNAL_TOKEN: 'unit-internal-token' });
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE; // runs stay in memory (fail-open store)
    admin = true;
    setKiroMcpAdminLookup(async () => ({ admin, tenantId: null }));
    resetKiroMcpLimits();
    objects.clear();
    setKiroMediaStore({ put: async (p, b) => { objects.set(p, b); return { error: null }; }, sign: async (p) => ({ url: objects.has(p) ? `https://signed/${p}` : null, error: null }) });
    app = express();
    app.use(express.json());
    app.use('/api/v1/operator/kiro/media', mediaRouter);
  });
  afterEach(() => {
    setKiroMediaStore(null);
    setKiroMcpAdminLookup(null);
    setKiroRunExecutor(null);
    resetKiroRunsForTests();
    for (const [k, v] of Object.entries({ KIRO_MCP_ENABLED: saved.mcp, GATEWAY_INTERNAL_TOKEN: saved.internal, SUPABASE_URL: saved.url, SUPABASE_SERVICE_ROLE: saved.key })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const pass = () => mintKiroMcpToken(USER, THREAD)!;
  const upload = (body: Buffer, token = pass(), q = 'viewport=desktop&page_url=https%3A%2F%2Fpreview-aws.vitanaland.com%2F', type = 'image/png') =>
    request(app).post(`/api/v1/operator/kiro/media?${q}`).set('Authorization', `Bearer ${token}`).set('Content-Type', type).send(body);

  /** A run of THREAD held open in this process (the store is unset, so it lives in memory). */
  async function openRun(): Promise<{ id: string; finish: () => void }> {
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    setKiroRunExecutor(async () => { await gate; return { status: 200, body: { ok: true, reply: 'x', meta: { kiro_status: 'ok' } } }; });
    const r = await startKiroRun({ threadId: THREAD, userId: USER, message: 'm', turn: { requestId: 'r', createdAt: new Date().toISOString(), attachments: [], mode: 'chat' } });
    if (!r.ok) throw new Error(r.error);
    return { id: r.run_id, finish };
  }

  it('off unless KIRO_MCP_ENABLED; no pass 401; a broken or foreign-environment pass 401; a non-admin 403 — all JSON', async () => {
    process.env.KIRO_MCP_ENABLED = 'false';
    expect((await upload(png())).status).toBe(404);
    process.env.KIRO_MCP_ENABLED = 'true';
    const none = await request(app).get('/api/v1/operator/kiro/media/quota');
    expect(none.status).toBe(401);
    expect(none.headers['content-type']).toContain('application/json');
    expect((await upload(png(), 'abc.def')).status).toBe(401);
    const staging = mintKiroMcpToken(USER, THREAD, { ...process.env, VITANA_ENV: 'staging' } as NodeJS.ProcessEnv)!;
    expect((await upload(png(), staging)).body.error).toBe('invalid token (wrong_env)');
    admin = false;
    expect((await upload(png())).status).toBe(403);
  });

  it('a valid pass stores the PNG under kiro/<user>/<thread>/ and appends kiro.image to the running run', async () => {
    const run = await openRun();
    const res = await upload(png(390 * 2, 844 * 2), pass(), 'viewport=mobile&page_url=https%3A%2F%2Fpreview-aws.vitanaland.com%2Fsettings');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, run_id: run.id, width: 780, height: 1688, event_appended: true });
    expect([...objects.keys()]).toEqual([`kiro/${USER}/${THREAD}/${res.body.media_id}.png`]);
    const q = await request(app).get('/api/v1/operator/kiro/media/quota').set('Authorization', `Bearer ${pass()}`);
    expect(q.body).toEqual({ ok: true, run_id: run.id, used: 1, limit: 10, remaining: 9 });
    expect(liveKiroRunIds()).toEqual([run.id]);
    run.finish();
  });

  it(`at most ${KIRO_RUN_SCREENSHOT_LIMIT} per run: the next one answers 429 "${KIRO_SCREENSHOT_LIMIT_ERROR}" and is not stored`, async () => {
    const run = await openRun();
    for (let i = 0; i < 10; i += 1) expect((await upload(png())).status).toBe(201);
    const r = await upload(png());
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ ok: false, error: 'screenshot limit reached for this run' });
    expect(objects.size).toBe(10);
    run.finish();
  });

  it('refusals: no running run 409; not a PNG 415 (magic bytes, not the header); bad viewport/page_url 400; over 5 MB 413 JSON', async () => {
    expect((await upload(png())).body).toEqual({ ok: false, error: 'no running Kiro run for this thread' });
    const run = await openRun();
    expect((await upload(Buffer.from('GIF89a definitely not a png at all'))).status).toBe(415);
    expect((await upload(png(), pass(), 'viewport=tablet&page_url=https%3A%2F%2Fx')).status).toBe(400);
    expect((await upload(png(), pass(), 'viewport=desktop&page_url=javascript%3Aalert(1)')).status).toBe(400);
    const big = await upload(png(10, 10, 5 * 1024 * 1024));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ ok: false, error: 'image larger than 5 MB' });
    expect(objects.size).toBe(0);
    run.finish();
  });

  it('the console re-signs only the caller\'s own screenshot (the path is built from the caller id)', async () => {
    const run = await openRun();
    const id = (await upload(png())).body.media_id as string;
    const mine = await request(app).get(`/api/v1/operator/kiro/media/${THREAD}/${id}`).set('x-test-user', USER);
    expect(mine.body).toEqual({ ok: true, url: `https://signed/kiro/${USER}/${THREAD}/${id}.png`, expires_in: 3600 });
    expect((await request(app).get(`/api/v1/operator/kiro/media/${THREAD}/${id}`).set('x-test-user', 'f0000000-0000-4000-8000-000000000009')).status).toBe(404);
    expect((await request(app).get(`/api/v1/operator/kiro/media/${THREAD}/${id}`)).status).toBe(401);
    expect((await request(app).get(`/api/v1/operator/kiro/media/${THREAD}/..%2F..%2Fx`).set('x-test-user', USER)).status).toBe(400);
    expect(kiroMediaPath(USER, '../etc', id)).toBeNull();
    expect(isPng(png())).toBe(true);
    run.finish();
  });
});

describe('trusted title, end to end through the ACP client (F16)', () => {
  /** A fake kiro-cli that asks one permission with the given toolCall and records the answer. */
  function fakeChild(toolCall: Record<string, unknown>) {
    const out = new EventEmitter();
    const proc = new EventEmitter();
    const answers: any[] = [];
    const child: AcpChild = {
      stdout: out as any,
      stdin: { write: (line: string) => { const m = JSON.parse(line); if (m.id === 77 && !m.method) answers.push(m.result); return true; }, end: () => undefined } as any,
      kill: () => undefined,
      on: (ev: string, cb: any) => proc.on(ev, cb),
    };
    const ask = () => out.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId: 'S', toolCall, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } })}\n`);
    return { child, ask, answers };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it.each([
    ['kind other', { toolCallId: 'c1', title: 'Running: @vitana-browser/browser_screenshot', kind: 'other' }],
    ['no kind at all (the client defaults it to other)', { toolCallId: 'c1', title: 'Running: @vitana-browser/browser_screenshot' }],
  ])('"Running: @vitana-browser/browser_screenshot" (%s) is allowed without a card', async (_l, toolCall) => {
    const emitted: KiroTurnEvent[] = [];
    const f = fakeChild(toolCall);
    new AcpClient(f.child, { onPermissionRequest: makePermissionHandler({ threadId: 't', userId: 'u', emit: (e) => emitted.push(e) }) });
    f.ask();
    await flush(); await flush();
    expect(f.answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow' } }]);
    expect(emitted).toEqual([]);
  });

  it.each([
    ['another browser tool name', 'Running: @vitana-browser/browser_click', 'other'],
    ['extra text', 'Running: @vitana-browser/browser_screenshot now', 'other'],
    ['another server, same tool', 'Running: @evil-browser/browser_screenshot', 'other'],
    ['kind execute', 'Running: @vitana-browser/browser_screenshot', 'execute'],
    ['kind edit', 'Running: @vitana-browser/browser_screenshot', 'edit'],
  ])('%s still asks (a card, never an allow)', async (_l, title, kind) => {
    expect(trustedKiroReadTool({ title, kind })).toBeNull();
    const emitted: KiroTurnEvent[] = [];
    const f = fakeChild({ toolCallId: 'c2', title, kind });
    new AcpClient(f.child, { onPermissionRequest: makePermissionHandler({ threadId: 't', userId: 'u', emit: (e) => emitted.push(e) }, { KIRO_PERMISSION_TIMEOUT_MS: '60000' } as NodeJS.ProcessEnv) });
    f.ask();
    await flush();
    expect(emitted[0]).toMatchObject({ type: 'kiro.permission_request', title });
    answerPermission((emitted[0] as any).request_id, 'u', false);
    await flush(); await flush();
    expect(f.answers).toEqual([{ outcome: { outcome: 'cancelled' } }]);
  });

  it('the constant is exactly the relay\'s server name and tool name', () => {
    expect(KIRO_BROWSER_TOOL_TITLE).toBe('Running: @vitana-browser/browser_screenshot');
    expect(read('services/kiro-runner/src/browser.ts')).toContain("name: 'vitana-browser'");
    expect(read('services/kiro-runner/src/browser-proxy.ts')).toContain("name: 'browser_screenshot'");
  });
});

describe('wiring', () => {
  it('session rules: screenshot a UI change on staging at desktop and mobile before asking to publish', () => {
    expect(KIRO_SESSION_RULES).toMatch(/After a UI change is on staging, screenshot it at desktop and mobile with browser_screenshot .* before asking to publish\./);
  });

  it('mounted before the operator router; atlas claims the route file; OASIS topic declared', () => {
    const idx = read('services/gateway/src/index.ts');
    expect(idx).toContain("mountRouterSync(app, '/api/v1/operator/kiro/media', require('./routes/operator-kiro-media').default");
    expect(idx.indexOf("'/api/v1/operator/kiro/media'")).toBeLessThan(idx.indexOf("mountRouterSync(app, '/api/v1/operator', operatorRouter"));
    expect(read('services/gateway/src/orb/developer/domain-atlas.ts')).toContain('/^operator-kiro-media$/');
    expect(read('services/gateway/src/types/cicd.ts')).toContain("| 'operator.kiro.screenshot_stored'");
  });

  it('the sidecar image: official Playwright image pinned by tag and digest, playwright-core the same version, non-root, 127.0.0.1 only', () => {
    const df = read('services/kiro-browser/Dockerfile');
    const froms = df.split('\n').filter((l) => /^FROM /.test(l));
    expect(froms.length).toBe(2);
    for (const f of froms) expect(f).toMatch(/^FROM mcr\.microsoft\.com\/playwright:v1\.58\.2-noble@sha256:[0-9a-f]{64} AS /);
    expect(JSON.parse(read('services/kiro-browser/package.json')).dependencies['playwright-core']).toBe('1.58.2');
    expect(df).toContain('USER pwuser');
    expect(read('services/kiro-browser/src/index.ts')).toContain("server.listen(port, '127.0.0.1'");
    // The runner image stays lean: no browser in it.
    expect(read('services/kiro-runner/Dockerfile')).not.toMatch(/playwright|chromium/i);
    expect(JSON.parse(read('services/kiro-runner/package.json')).dependencies).not.toHaveProperty('playwright-core');
  });

  describe.each([
    ['staging', '.github/workflows/AWS-STAGE-DEPLOY-KIRO-RUNNER.yml'],
    ['production', '.github/workflows/AWS-PROD-DEPLOY-KIRO-RUNNER.yml'],
  ])('%s runner deploy: the sidecar is a second container of the SAME task definition', (env, file) => {
    const wf = read(file);
    it('KIRO_BROWSER_URL on the runner is the pinned loopback port; the password goes to the sidecar container only', () => {
      expect(wf).toContain('{name:"KIRO_BROWSER_URL",            value:"http://127.0.0.1:8090"}');
      expect(wf).toContain('name:"kiro-browser"');
      expect(wf).toContain('essential:false');
      expect(wf).toContain('readonlyRootFilesystem:true');
      // The test user's password is only ever a secret of the kiro-browser container.
      const uses = wf.split('\n').filter((l) => l.includes('KIRO_BROWSER_TEST_USER_PASSWORD') && !l.trim().startsWith('#'));
      expect(uses).toHaveLength(1);
      for (const l of wf.split('\n').filter((x) => x.includes('.containerDefinitions[0]'))) expect(l).not.toContain('PASSWORD');
      // Behaviour, not only text: run the workflow's own jq program on a task definition.
      const step = (yaml.load(wf) as any).jobs[env === 'production' ? 'promote' : 'build-push-deploy'].steps
        .find((s: any) => String(s.name).startsWith('Register task-definition'));
      const prog = String(step.run).split(" '\n")[1].split("')")[0];
      const td = {
        taskRoleArn: `arn:aws:iam::472838866351:role/${env === 'production' ? 'vitana-kiro-runner-prod-task-role' : 'vitana-kiro-runner-task-role'}`,
        cpu: '1024', memory: '2048', revision: 3,
        containerDefinitions: [{ name: 'kiro-runner', image: 'old', environment: [], secrets: [], logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/vitana/kiro-runner', 'awslogs-stream-prefix': 'ecs' } } }],
      };
      const jq = (bon: string) => JSON.parse(execFileSync('jq', [
        '--arg', 'IMG', 'img', '--arg', 'SEC_TOKEN', 'arn:tok', '--arg', 'PREFIX', 'p', '--arg', 'REGION', 'eu-central-1', '--arg', 'MCPURL', 'https://gw',
        '--arg', 'SUFFIX', '/vitana-kiro-runner-prod-task-role', '--arg', 'BON', bon, '--arg', 'BIMG', 'browser', '--arg', 'REG', 'arn:reg',
        '--arg', 'PW', 'arn:pw', '--arg', 'NOSB', 'false', '--arg', 'SUPA', 'https://x.supabase.co', prog,
      ], { input: JSON.stringify(td) }).toString());
      const on = jq('true');
      expect(on.containerDefinitions.map((c: any) => c.name)).toEqual(['kiro-runner', 'kiro-browser']);
      expect(on.containerDefinitions[0].secrets.map((x: any) => x.name)).toEqual(['KIRO_RUNNER_TOKEN', 'KIRO_BROWSER_REGISTRY_TOKEN']);
      expect(on.containerDefinitions[0].environment).toContainEqual({ name: 'KIRO_BROWSER_URL', value: 'http://127.0.0.1:8090' });
      expect(on.containerDefinitions[1]).toMatchObject({ essential: false, readonlyRootFilesystem: true, image: 'browser' });
      expect(on.containerDefinitions[1].secrets.map((x: any) => x.name)).toEqual(['KIRO_BROWSER_REGISTRY_TOKEN', 'KIRO_BROWSER_TEST_USER_PASSWORD']);
      const off = jq('false');
      expect(off.containerDefinitions.map((c: any) => c.name)).toEqual(['kiro-runner']);
      expect(JSON.stringify(off)).not.toMatch(/KIRO_BROWSER/);
      expect(wf).toContain('{name:"KIRO_BROWSER_TEST_USER_PASSWORD", valueFrom:$PW}');
      // Sandbox first: the no-sandbox fallback is an explicit input, off by default.
      expect(wf).toMatch(/browser_no_sandbox:[\s\S]*?default: false/);
    });
    if (env === 'production') {
      it('production: off unless the dispatch input asks for it, never staging names, no describe-secret', () => {
        expect(wf).toMatch(/enable_browser:[\s\S]*?default: false/);
        expect(wf).not.toContain('vitana/kiro-runner/staging');
        expect(wf).not.toContain('describe-secret');
        expect(wf).not.toContain('preview-aws-gateway');
      });
    } else {
      it('staging: the sidecar image is built, smoke-tested and pushed to its own ECR repo; never a production gateway', () => {
        expect(wf).toContain('ECR_BROWSER_REPOSITORY: vitana/kiro-browser');
        expect(wf).toContain('docker build -t kiro-browser:ci services/kiro-browser');
        expect(wf).toContain("'services/kiro-browser/**'");
        expect(wf).not.toContain('https://gateway.vitanaland.com');
      });
    }
  });
});
