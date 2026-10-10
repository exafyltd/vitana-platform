/**
 * VTID-04465 — operator pipeline regression suite.
 *
 * The Operator Console turns a sentence into a merged, deployed, verified
 * change: console turn → auth gate → autopilot_run_task → on-ramp (VTID,
 * finding, plan, execution) → executor tick (claim) → agent run → PR contract
 * → approval hold → approve → CI watcher → merge → deploy watcher →
 * verification window → ledger closed. Each piece has its own tests, each with
 * its neighbours mocked. This suite runs the REAL code of every stage, in
 * order, over one in-memory database and one in-memory GitHub
 * (test/operator-pipeline/fake-operator-platform.ts), and checks every
 * hand-over.
 *
 * Stubbed, because they lie outside the pipeline (reasons next to each, in
 * test/operator-pipeline/harness.ts): the LLM (a scripted DeepSeek-style model
 * that issues read_file / edit_file / run_check / finish), the git clone
 * (a temp directory the agent's REAL tools edit; clone/push emulated against
 * the fake GitHub), tsc/jest inside that clone, the agent's memory pack, the
 * self-healing triage agent, dev_agent_memory embeddings, and VITANA_ENV (a
 * getter, so one process can play two environments).
 *
 * Choice recorded for the agent executor: the REAL runAgentExecutionSession
 * runs (runAgentLoop, the real tool executor, the scope/coverage checks, the
 * PR contract, the approval decision). Only its process edges — git, tsc, jest,
 * the model — are replaced. No real network call is possible: the suite's
 * fetch refuses anything that is not the fake database or the fake GitHub, and
 * a test asserts none was attempted.
 *
 * If this suite fails after your change, the change broke how an operator
 * request becomes a shipped change. Fix the change; loosen an assertion only
 * when the pipeline's contract changed on purpose, and say so in the PR.
 */

import './operator-pipeline/env-setup';

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';

jest.mock('../src/env', () => require('./operator-pipeline/harness').envModule());
jest.mock('../src/services/llm-router', () => require('./operator-pipeline/harness').llmRouterModule());
jest.mock('../src/services/autopilot-agent/agent-workspace', () => require('./operator-pipeline/harness').workspaceModule());
jest.mock('../src/services/autopilot-agent/agent-validate', () => require('./operator-pipeline/harness').validateModule());
jest.mock('../src/services/autopilot-agent/agent-memory-context', () => require('./operator-pipeline/harness').memoryContextModule());
jest.mock('../src/services/self-healing-triage-service', () => require('./operator-pipeline/harness').triageModule());
jest.mock('../src/services/dev-agent-memory', () => require('./operator-pipeline/harness').devMemoryModule());

import { MACHINE_TOKEN, JWT_SECRET } from './operator-pipeline/env-setup';
import { OperatorPlatform, FakeGitHub, INFLIGHT_UNIQUE_STATUSES, type Row } from './operator-pipeline/fake-operator-platform';
import { current, envState, model, checks, triage, workspaceLog, tools, text, type ModelCallCtx } from './operator-pipeline/harness';

import operatorRouter from '../src/routes/operator';
import {
  backgroundExecutorTick,
  autoApproveTick,
  runExecutionSession,
  getSupabase,
} from '../src/services/dev-autopilot-execute';
import { ciWatcherTick, deployWatcherTick, verificationWatcherTick } from '../src/services/dev-autopilot-watcher';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GREETING = 'services/gateway/src/services/greeting.ts';
const GREETING_TEST = 'services/gateway/test/greeting.test.ts';
const MAIN_FILES: Record<string, string> = {
  [GREETING]: "export function greet(name: string): string {\n  return 'Hello';\n}\n",
  'services/gateway/src/services/farewell.ts': "export const bye = () => 'Bye';\n",
  'services/gateway/src/services/weather.ts': "export const sunny = true;\n",
  'services/gateway/src/services/clock.ts': "export const now = () => Date.now();\n",
  'services/gateway/src/services/names.ts': "export const names = ['Ada'];\n",
  'services/gateway/src/services/colors.ts': "export const red = '#f00';\n",
  'services/gateway/src/services/units.ts': "export const km = 1000;\n",
  'services/gateway/src/services/flags.ts': "export const on = true;\n",
  'services/gateway/src/services/moods.ts': "export const happy = ':)';\n",
  'services/gateway/src/services/sizes.ts': "export const big = 10;\n",
};
const REQUEST = 'Make greet() include the person\'s name, e.g. "Hello, Ada", and cover it with a test.';
const ADMIN_USER = 'd1111111-1111-4111-8111-111111111111';
const MEMBER_USER = 'e2222222-2222-4222-8222-222222222222';
const CI_CHECKS = ['validate-pr', 'Gateway (Jest, ~7.5k tests)', 'tsc'];
const VTID_RE = /^VTID-\d{5}$/;

let platform: OperatorPlatform;
let app: express.Express;
const setupFetch = (global as any).fetch;

function newPlatform(): OperatorPlatform {
  const p = new OperatorPlatform(new FakeGitHub(MAIN_FILES));
  p.insert('dev_autopilot_config', {
    id: 1,
    kill_switch: false,
    daily_budget: 20,
    concurrency_cap: 2,
    cooldown_minutes: 0,
    max_auto_fix_depth: 2,
    allow_scope: ['services/gateway/src/**', 'services/gateway/test/**', 'docs/**'],
    deny_scope: ['supabase/migrations/**', '.github/workflows/**', '**/.env*'],
    auto_approve_enabled: false,
    auto_approve_scanners: [],
    auto_approve_risk_classes: ['low', 'medium'],
    auto_approve_max_effort: 5,
    auto_approve_impact_enabled: false,
  });
  return p;
}

async function jwt(sub: string, exafyAdmin: boolean): Promise<string> {
  return new SignJWT({ app_metadata: { exafy_admin: exafyAdmin }, role: 'authenticated', email: `${sub.slice(0, 4)}@example.test` })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

type Caller = { kind: 'machine' } | { kind: 'jwt'; token: string } | { kind: 'anonymous' };

async function consoleTurn(caller: Caller, message: string, threadId: string) {
  let req = request(app).post('/api/v1/operator/chat');
  if (caller.kind === 'machine') req = req.set('X-Operator-Machine-Token', MACHINE_TOKEN);
  if (caller.kind === 'jwt') req = req.set('Authorization', `Bearer ${caller.token}`);
  const res = await req.send({ message, threadId });
  await platform.settle();
  return res;
}

function toolResult(res: request.Response, name: string): Record<string, any> {
  const tr = (res.body.toolResults || []).find((t: any) => t.name === name);
  if (!tr) throw new Error(`no ${name} tool result in ${JSON.stringify(res.body).slice(0, 500)}`);
  return tr.response;
}

/** The DeepSeek agent that does the job right: read, edit + test, check, finish. */
function goodAgentRun(opts: { note?: string } = {}) {
  return [
    tools(['read_file', { path: GREETING }]),
    tools(
      ['edit_file', { path: GREETING, old_string: "return 'Hello';", new_string: 'return `Hello, ${name}`;' }],
      ['write_file', { path: GREETING_TEST, content: `import { greet } from '../src/services/greeting';\n\ntest('greets by name${opts.note ? ` (${opts.note})` : ''}', () => {\n  expect(greet('Ada')).toBe('Hello, Ada');\n});\n` }],
    ),
    tools(['run_check', { kind: 'jest', target: GREETING_TEST }]),
    tools(['finish', { summary: 'greet() now includes the name; test added.', pr_title: 'feat(greeting): greet by name', pr_body: 'Adds the name to the greeting and a jest test for it.' }]),
  ];
}

/**
 * Run one executor tick and wait for the fire-and-forget session(s) it starts:
 * every row the tick moved to `running` must leave it (the agent touches the
 * file system between database calls, so "no fetch in flight" alone is not
 * "done").
 */
async function executorTick(): Promise<void> {
  const runningBefore = new Set(platform.rows('dev_autopilot_executions').filter((e) => e.status === 'running').map((e) => e.id));
  await backgroundExecutorTick();
  const claimed = platform.rows('dev_autopilot_executions').filter((e) => e.status === 'running' && !runningBefore.has(e.id)).map((e) => e.id);
  const realSetTimeout = globalThis.setTimeout;
  const deadline = Date.now() + 15_000;
  while (claimed.some((id) => platform.execution(id).status === 'running')) {
    if (Date.now() > deadline) throw new Error(`execution(s) still running after 15 s: ${claimed.join(', ')}`);
    await new Promise((r) => realSetTimeout(r, 5));
  }
  await platform.settle();
}

/** ciWatcherTick waits 30 s before re-checking CI; run that wait at once. */
async function ciTick(): Promise<void> {
  const realSetTimeout = global.setTimeout;
  const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn, ms !== undefined && ms >= 30_000 ? 0 : ms, ...args)) as unknown as typeof setTimeout);
  try {
    await ciWatcherTick();
  } finally {
    spy.mockRestore();
  }
  await platform.settle();
}

/** The AWS staging deploy workflow reports a finished deploy of `sha`. */
function stagingDeployCompleted(sha: string): void {
  platform.insert('oasis_events', {
    topic: 'staging.deploy.completed',
    vtid: 'BOOTSTRAP-AWS-STAGE-DEPLOY',
    status: 'success',
    service: 'AWS-STAGE-DEPLOY-GATEWAY.yml',
    metadata: { git_commit: sha, service: 'gateway', env: 'staging' },
    created_at: new Date().toISOString(),
  });
}

/** The verification window is five minutes of wall clock; move the row's start back instead of waiting. */
function elapseVerificationWindow(execId: string): void {
  platform.execution(execId).updated_at = new Date(Date.now() - 6 * 60_000).toISOString();
}

function topics(): string[] {
  return platform.events().map((e) => String(e.topic));
}

function execEvents(topic: string, execId: string): Row[] {
  return platform.events(topic).filter((e) => e.metadata?.execution_id === execId);
}

beforeEach(() => {
  platform = newPlatform();
  current.platform = platform;
  envState.env = 'staging';
  model.reset();
  checks.reset();
  triage.reset();
  workspaceLog.length = 0;
  (global as any).fetch = platform.router;
  if (setupFetch && typeof setupFetch.mockImplementation === 'function') setupFetch.mockImplementation(platform.router);
  Object.assign(process.env, {
    OPERATOR_EXECUTION_ONRAMP_ENABLED: 'true',
    OPERATOR_VTID_SELF_ALLOCATE_ENABLED: 'true',
    OPERATOR_PR_APPROVAL_REQUIRED: 'true',
    OPERATOR_MACHINE_AUTH_ENABLED: 'true',
    OPERATOR_MACHINE_AUTH_TOKEN: MACHINE_TOKEN,
  });
  delete process.env.DEV_AUTOPILOT_EXECUTOR;
  app = express();
  app.use(express.json());
  app.use('/api/v1/operator', operatorRouter);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await platform.settle().catch(() => undefined);
  jest.restoreAllMocks();
  // Every scenario: no request left the process, and the fake answered every
  // query it was asked (an unknown PostgREST operator would otherwise read as
  // "no rows" and could make a guard look like it held).
  expect(platform.externalCalls).toEqual([]);
  expect(platform.unsupported).toEqual([]);
});

// ---------------------------------------------------------------------------
// Shared driver: a console request all the way to "held for approval"
// ---------------------------------------------------------------------------

async function requestChange(threadId: string, caller: Caller = { kind: 'machine' }) {
  model.operatorPlan.push(tools(['autopilot_run_task', { request: REQUEST, title: 'Greet by name' }]));
  const res = await consoleTurn(caller, `Please do this: ${REQUEST}`, threadId);
  expect(res.status).toBe(200);
  return res;
}

describe('Golden path: an operator request becomes a merged, deployed, verified change', () => {
  it('console turn → VTID → execution → agent → held PR → approve → CI → merge → deploy → verify → ledger closed', async () => {
    const threadId = 'a0000000-0000-4000-8000-000000000001';

    // 1. The console turn: the model picks autopilot_run_task, the gate lets
    //    the machine identity through, the on-ramp queues the work.
    const res = await requestChange(threadId);
    const queued = toolResult(res, 'autopilot_run_task');
    expect(queued).toEqual(expect.objectContaining({ ok: true, executor: 'agent', status: 'queued', vtid_allocated: true }));
    const vtid: string = queued.vtid;
    const execId: string = queued.execution_id;
    expect(vtid).toMatch(VTID_RE);

    // VTID allocated through the real RPC and registered as owner-instructed work.
    expect(platform.rpcCalls.filter((c) => c.name === 'allocate_global_vtid')).toEqual([
      expect.objectContaining({ args: { p_source: 'operator-console', p_layer: 'DEV', p_module: 'operator-onramp' } }),
    ]);
    const ledger = platform.ledger(vtid);
    expect(ledger).toEqual(expect.objectContaining({ status: 'in_progress', spec_status: 'approved', is_terminal: false }));
    expect(ledger.title).toBe('Operator: Greet by name');
    expect(ledger.metadata).toEqual(expect.objectContaining({ source: 'operator-onramp', intake: 'open_ended', autopilot_execution_id: execId }));

    // Finding + plan + execution, all pointing at each other.
    const rec = platform.rows('autopilot_recommendations')[0];
    expect(platform.rows('autopilot_recommendations')).toHaveLength(1);
    expect(rec).toEqual(expect.objectContaining({ source_type: 'operator_onramp', status: 'new', activated_vtid: vtid }));
    expect(rec.spec_snapshot).toEqual(expect.objectContaining({ intake: 'open_ended', files_referenced: [], spec_markdown: REQUEST }));
    expect(platform.rows('dev_autopilot_plan_versions')).toEqual([expect.objectContaining({ finding_id: rec.id, version: 1, plan_markdown: REQUEST })]);
    let ex = platform.execution(execId);
    expect(ex).toEqual(expect.objectContaining({ finding_id: rec.id, status: 'cooling', plan_version: 1, approved_by: null }));
    expect(ex.metadata).toEqual(expect.objectContaining({
      executor: 'agent',
      intake: 'open_ended',
      require_approval: true,
      source: 'operator-onramp',
      triggered_by: `operator-chat:${threadId}`,
      // VTID-04593: the coding agent runs on Bedrock Claude Sonnet 4.6.
      llm_on_ramp_override: { provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' },
    }));
    expect(platform.events('operator.execution_onramp.triggered')).toEqual([
      expect.objectContaining({ vtid, metadata: expect.objectContaining({ execution_id: execId, vtid_allocated: true, intake: 'open_ended' }) }),
    ]);
    expect(platform.events('autopilot.intent.executed')).toHaveLength(1);

    // 2. Executor tick: claims the row for THIS environment and runs the agent.
    model.workerRuns.push(goodAgentRun());
    await executorTick();
    ex = platform.execution(execId);
    expect(ex.metadata).toEqual(expect.objectContaining({ claimed_env: 'staging', executor: 'agent' }));
    expect(execEvents('dev_autopilot.execution.running', execId)).toHaveLength(1);

    // The agent ran on DeepSeek Flash (the on-ramp override), through the worker stage.
    const workerCalls = model.calls.filter((c) => c.stage === 'worker');
    expect(workerCalls).toHaveLength(4);
    expect(workerCalls.every((c) => c.providerOverride === 'bedrock' && c.modelOverride === 'eu.anthropic.claude-sonnet-4-6' && c.vtid === vtid)).toBe(true);
    // The runner re-verified independently of the model's own run_check.
    expect(checks.log.map((c) => c.kind)).toEqual(['jest', 'runner:tsc', 'runner:jest']);

    // 3. Held for approval: branch pushed, no PR yet.
    expect(ex.status).toBe('awaiting_approval');
    const branch = `dev-autopilot/${execId.slice(0, 8)}`;
    expect(ex.branch).toBe(branch);
    expect(platform.github.prs.size).toBe(0);
    expect(platform.github.pushes).toHaveLength(1);
    expect(platform.github.pushes[0]).toEqual(expect.objectContaining({ branch, force: true }));
    expect(platform.github.pushes[0].files).toEqual(expect.arrayContaining([GREETING, GREETING_TEST, `docs/validation/${vtid}/acceptance.md`]));
    const pending = ex.metadata.pending_approval;
    expect(pending.branch).toBe(branch);
    expect(pending.diff.files).toEqual(expect.arrayContaining([GREETING, GREETING_TEST]));
    // PR contract: the VTID is in the title and the body carries the validator's markers.
    expect(pending.pr_title).toBe(`feat(greeting): greet by name (${vtid})`);
    expect(pending.pr_body).toMatch(new RegExp(`^VTID: ${vtid}$`, 'm'));
    expect(pending.pr_body).toMatch(/^VALIDATION_PROFILE: gateway_backend$/m);
    const pushed = platform.github.filesAt(branch);
    expect(pushed[GREETING]).toContain('Hello, ${name}');
    expect(pushed[`docs/validation/${vtid}/acceptance.md`]).toMatch(/TEST: /);
    expect(execEvents('dev_autopilot.execution.awaiting_approval', execId)).toHaveLength(1);

    // 4. The operator approves from the console; the PR opens and CI starts.
    model.operatorPlan.push(tools(['autopilot_approve_execution', { execution_id: execId.slice(0, 8) }]));
    const approveRes = await consoleTurn({ kind: 'machine' }, 'Looks good, approve it.', threadId);
    expect(toolResult(approveRes, 'autopilot_approve_execution')).toEqual(expect.objectContaining({ ok: true, approved_by: 'operator-chat:operator-machine-test-harness' }));
    ex = platform.execution(execId);
    expect(ex.status).toBe('ci');
    expect(platform.github.prs.size).toBe(1);
    const pr = [...platform.github.prs.values()][0];
    expect(pr.title).toBe(`feat(greeting): greet by name (${vtid})`);
    expect(pr.head.ref).toBe(branch);
    expect(ex.pr_number).toBe(pr.number);
    expect(ex.pr_url).toBe(pr.html_url);
    expect(ex.metadata.approved).toEqual(expect.objectContaining({ by: 'operator-chat:operator-machine-test-harness' }));
    expect(execEvents('dev_autopilot.execution.pr_opened', execId)).toHaveLength(1);

    // 5. CI pending → nothing happens; CI green → merged.
    await ciTick();
    expect(platform.execution(execId).status).toBe('ci');
    platform.github.setChecks(pr.head.sha, CI_CHECKS);
    await ciTick();
    ex = platform.execution(execId);
    expect(ex.status).toBe('deploying');
    expect(pr.merged).toBe(true);
    expect(ex.metadata.merge_sha).toBe(pr.merge_commit_sha);
    expect(platform.github.filesAt('main')[GREETING]).toContain('Hello, ${name}');
    expect(execEvents('dev_autopilot.execution.ci_passed', execId)).toHaveLength(1);
    expect(execEvents('dev_autopilot.execution.pr_merged', execId)).toHaveLength(1);

    // 6. Deploy: nothing until the staging deploy of the merge commit is reported.
    await deployWatcherTick();
    await platform.settle();
    expect(platform.execution(execId).status).toBe('deploying');
    stagingDeployCompleted(pr.merge_commit_sha!);
    await deployWatcherTick();
    await platform.settle();
    expect(platform.execution(execId).status).toBe('verifying');
    expect(execEvents('dev_autopilot.execution.deployed', execId)).toHaveLength(1);

    // 7. Verification window: pending while open, completed once it has elapsed clean.
    await verificationWatcherTick();
    await platform.settle();
    expect(platform.execution(execId).status).toBe('verifying');
    elapseVerificationWindow(execId);
    await verificationWatcherTick();
    await platform.settle();
    ex = platform.execution(execId);
    expect(ex.status).toBe('completed');
    expect(execEvents('dev_autopilot.execution.completed', execId)).toHaveLength(1);

    // 8. The ledger is closed as a success, the finding is completed, OASIS says so.
    expect(platform.ledger(vtid)).toEqual(expect.objectContaining({ is_terminal: true, terminal_outcome: 'success', status: 'completed' }));
    expect(platform.rows('autopilot_recommendations')[0]).toEqual(expect.objectContaining({ status: 'completed', merged_pr_number: pr.number }));
    expect(platform.events('vtid.lifecycle.completed')).toEqual([expect.objectContaining({ vtid })]);
    expect(platform.events('dev_autopilot.finding.completed')).toHaveLength(1);

    // The order a real run leaves in OASIS.
    const order = [
      'operator.execution_onramp.triggered',
      'dev_autopilot.execution.running',
      'dev_autopilot.execution.awaiting_approval',
      'dev_autopilot.execution.pr_opened',
      'dev_autopilot.execution.ci_passed',
      'dev_autopilot.execution.pr_merged',
      'dev_autopilot.execution.deployed',
      'dev_autopilot.execution.completed',
      'vtid.lifecycle.completed',
    ];
    const seen = topics();
    const idx = order.map((t) => seen.indexOf(t));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);

    // One PR, one push, no failure anywhere, no model stage outside the script, no real network.
    expect(platform.github.prs.size).toBe(1);
    expect(topics().filter((t) => /failed|escalated|reverted|cancelled/.test(t))).toEqual([]);
    expect(model.refused).toEqual([]);
    expect(platform.externalCalls).toEqual([]);
    expect(platform.unsupported).toEqual([]);
  });
});

// ===========================================================================
// 1. Who may queue work
// ===========================================================================

describe('Safety: only a verified exafy_admin (or the machine credential) can queue an execution', () => {
  function expectNothingQueued() {
    expect(platform.rpcCalls.filter((c) => c.name === 'allocate_global_vtid')).toEqual([]);
    expect(platform.rows('vtid_ledger')).toEqual([]);
    expect(platform.rows('autopilot_recommendations')).toEqual([]);
    expect(platform.rows('dev_autopilot_executions')).toEqual([]);
    expect(platform.events('operator.execution_onramp.triggered')).toEqual([]);
  }

  it('an anonymous console request is refused before any VTID, finding or execution exists', async () => {
    const res = await requestChange('a0000000-0000-4000-8000-000000000011', { kind: 'anonymous' });
    const r = toolResult(res, 'autopilot_run_task');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/autopilot_run_task requires an authenticated session/);
    expectNothingQueued();
    expect(platform.events('autopilot.intent.rejected')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'auth_unauthenticated', tool: 'autopilot_run_task' }) }),
    ]);
  });

  it('a signed-in member who is not an exafy admin is refused (autopilot_run_task and autopilot_execute_task)', async () => {
    const token = await jwt(MEMBER_USER, false);
    const thread = 'a0000000-0000-4000-8000-000000000012';
    const res = await requestChange(thread, { kind: 'jwt', token });
    expect(toolResult(res, 'autopilot_run_task').error).toMatch(/requires an exafy_admin session/);

    model.operatorPlan.push(tools(['autopilot_execute_task', { vtid: 'VTID-04000', plan_markdown: '## Files to modify\n- `services/gateway/src/services/greeting.ts`', files_referenced: [GREETING, GREETING_TEST] }]));
    const res2 = await consoleTurn({ kind: 'jwt', token }, 'Execute VTID-04000 now.', thread);
    expect(toolResult(res2, 'autopilot_execute_task').error).toMatch(/requires an exafy_admin session/);
    expectNothingQueued();
    expect(platform.events('autopilot.intent.rejected').map((e) => e.metadata.reason)).toEqual(['auth_not_admin', 'auth_not_admin']);
  });

  it('an anonymous request that reuses an admin\'s thread does not inherit the admin marker', async () => {
    const thread = 'a0000000-0000-4000-8000-000000000013';
    const admin = await jwt(ADMIN_USER, true);
    model.operatorPlan.push(text('Hello! How can I help?'));
    const hello = await consoleTurn({ kind: 'jwt', token: admin }, 'Hi', thread);
    expect(hello.status).toBe(200);

    const res = await requestChange(thread, { kind: 'anonymous' });
    expect(toolResult(res, 'autopilot_run_task').error).toMatch(/requires an authenticated session/);
    expectNothingQueued();
  });

  it('a wrong machine token is not a credential', async () => {
    model.operatorPlan.push(tools(['autopilot_run_task', { request: REQUEST }]));
    const res = await request(app)
      .post('/api/v1/operator/chat')
      .set('X-Operator-Machine-Token', `${MACHINE_TOKEN.slice(0, -1)}X`)
      .send({ message: REQUEST, threadId: 'a0000000-0000-4000-8000-000000000014' });
    await platform.settle();
    expect(toolResult(res, 'autopilot_run_task').error).toMatch(/requires an authenticated session/);
    expectNothingQueued();
  });

  it('a verified exafy_admin JWT queues the same execution the machine credential does', async () => {
    const res = await requestChange('a0000000-0000-4000-8000-000000000015', { kind: 'jwt', token: await jwt(ADMIN_USER, true) });
    const r = toolResult(res, 'autopilot_run_task');
    expect(r).toEqual(expect.objectContaining({ ok: true, executor: 'agent' }));
    expect(platform.execution(r.execution_id).status).toBe('cooling');
  });
});

// ===========================================================================
// 2. Provider outage
// ===========================================================================

const OUTAGE_ERROR = 'both providers failed: primary=deepseek 402 Insufficient Balance; fallback=bedrock AccessDeniedException: Operation not allowed';
const outageRun = () => [{ ok: false, error: OUTAGE_ERROR, fallbackUsed: true }];

/** Earlier executions that died on the same outage, minutes ago. */
function seedOutageFailures(n: number): void {
  for (let i = 0; i < n; i++) {
    const f = platform.insert('autopilot_recommendations', { source_type: 'dev_autopilot', status: 'new', title: `earlier finding ${i}` });
    platform.insert('dev_autopilot_executions', {
      finding_id: f.id,
      plan_version: 1,
      status: 'failed',
      approved_at: new Date(Date.now() - (10 + i) * 60_000).toISOString(),
      metadata: { error: `LLM call failed on turn 1: ${OUTAGE_ERROR}` },
    });
    const row = platform.rows('dev_autopilot_executions').slice(-1)[0];
    row.updated_at = new Date(Date.now() - (5 + i) * 60_000).toISOString();
  }
}

async function queueRequest(threadId: string): Promise<{ vtid: string; execId: string }> {
  const r = toolResult(await requestChange(threadId), 'autopilot_run_task');
  expect(r.ok).toBe(true);
  return { vtid: r.vtid, execId: r.execution_id };
}

function workerRunsStarted(): number {
  return model.calls.filter((c) => c.stage === 'worker' && c.historyLength === 0).length;
}

describe('Safety: an LLM provider outage stops the loop instead of feeding it', () => {
  it('both providers failing on the first call fails the execution with the outage error', async () => {
    const { execId, vtid } = await queueRequest('a0000000-0000-4000-8000-000000000021');
    model.workerRuns.push(outageRun());
    await executorTick();
    const ex = platform.execution(execId);
    expect(['failed', 'reverted', 'failed_escalated']).toContain(ex.status);
    expect(ex.metadata.error).toContain('Insufficient Balance');
    expect(ex.metadata.error).toMatch(/^LLM call failed on turn 1: both providers failed/);
    expect(execEvents('dev_autopilot.execution.failed', execId)).toHaveLength(1);
    expect(platform.github.pushes).toEqual([]);
    expect(platform.github.prs.size).toBe(0);
    expect(model.workerCalls()).toBe(1);
    // The bridge still hands the failure to self-heal (triage is stubbed as
    // confident): the parent is `reverted`, a child waits with the same
    // DeepSeek override, and the VTID stays open for it. What keeps that child
    // from becoming a retry storm is the outage gate at claim time (below).
    expect(ex.status).toBe('reverted');
    const child = platform.rows('dev_autopilot_executions').find((e) => e.parent_execution_id === execId)!;
    expect(child).toEqual(expect.objectContaining({ status: 'cooling', auto_fix_depth: 1 }));
    expect(child.metadata.llm_on_ramp_override).toEqual({ provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' });
    expect(platform.ledger(vtid).is_terminal).toBe(false);
  });

  it('after one outage failure the next tick claims at most one execution (a probe)', async () => {
    const first = await queueRequest('a0000000-0000-4000-8000-000000000022');
    model.workerRuns.push(outageRun());
    await executorTick();
    // Now ready to run: the failed run's self-heal child (if the bridge spawned
    // one) plus two fresh requests — at least two cooling rows.
    await queueRequest('a0000000-0000-4000-8000-000000000023');
    await queueRequest('a0000000-0000-4000-8000-000000000024');
    const coolingBefore = platform.rows('dev_autopilot_executions').filter((e) => e.status === 'cooling').length;
    expect(coolingBefore).toBeGreaterThanOrEqual(2);
    expect(platform.execution(first.execId).metadata.error).toContain('both providers failed');

    const before = workerRunsStarted();
    model.workerRuns.push(goodAgentRun());
    await executorTick();
    expect(workerRunsStarted() - before).toBe(1);
    expect(platform.rows('dev_autopilot_executions').filter((e) => e.status === 'cooling')).toHaveLength(coolingBefore - 1);
  });

  it('three outage failures in a row: the next tick claims nothing — no retry storm', async () => {
    seedOutageFailures(2);
    const { execId } = await queueRequest('a0000000-0000-4000-8000-000000000025');
    model.workerRuns.push(outageRun());
    await executorTick();
    expect(platform.execution(execId).metadata.error).toContain('both providers failed');
    await queueRequest('a0000000-0000-4000-8000-000000000026');
    const cooling = platform.rows('dev_autopilot_executions').filter((e) => e.status === 'cooling').map((e) => e.id);
    expect(cooling.length).toBeGreaterThanOrEqual(1);

    const callsBefore = model.workerCalls();
    for (let i = 0; i < 3; i++) await executorTick();
    expect(model.workerCalls()).toBe(callsBefore);
    for (const id of cooling) expect(platform.execution(id).status).toBe('cooling');
    expect(platform.events('dev_autopilot.provider_outage.detected').length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 3. Turn cap → retry breaker
// ===========================================================================

describe('Safety: a run that exhausts the turn cap is snoozed, not re-approved', () => {
  it('auto-approve → agent reads until the cap → failure → the next auto-approve pass snoozes the finding', async () => {
    const cfg = platform.rows('dev_autopilot_config')[0];
    Object.assign(cfg, { auto_approve_enabled: true, auto_approve_scanners: ['todo-scanner-v1'] });
    const finding = platform.insert('autopilot_recommendations', {
      title: 'Stale TODO in greeting',
      source_type: 'dev_autopilot',
      status: 'new',
      risk_class: 'low',
      effort_score: 2,
      impact_score: 7,
      spec_snapshot: { scanner: 'todo-scanner-v1', title: 'Stale TODO in greeting', file_path: GREETING },
    });
    platform.insert('dev_autopilot_plan_versions', {
      finding_id: finding.id,
      version: 1,
      plan_markdown: `# Remove the stale TODO\n\n## Files to modify\n- \`${GREETING}\`\n- \`${GREETING_TEST}\`\n`,
      files_referenced: [GREETING, GREETING_TEST],
    });
    process.env.DEV_AUTOPILOT_EXECUTOR = 'agent';
    triage.confidence = 0.1; // triage cannot explain it — the bridge escalates

    await autoApproveTick();
    await platform.settle();
    const execs = platform.rows('dev_autopilot_executions');
    expect(execs).toHaveLength(1);
    const vtid = platform.rows('autopilot_recommendations')[0].activated_vtid;
    expect(vtid).toMatch(VTID_RE);
    expect(platform.ledger(vtid)).toEqual(expect.objectContaining({ status: 'in_progress', spec_status: 'approved' }));

    // The model only ever reads a new file; it never edits or finishes.
    const files = Object.keys(MAIN_FILES);
    model.workerRuns.push((ctx: ModelCallCtx) => tools(['read_file', { path: files[ctx.turn % files.length] }]));
    await executorTick();
    const ex = platform.execution(execs[0].id);
    expect(ex.metadata.executor).toBe('agent');
    expect(ex.metadata.error).toMatch(/agent hit the 8-turn cap without calling finish/);
    expect(model.workerCalls()).toBe(8);
    expect(ex.status).toBe('failed_escalated');
    expect(platform.github.pushes).toEqual([]);
    expect(platform.ledger(vtid)).toEqual(expect.objectContaining({ is_terminal: true, terminal_outcome: 'failed' }));

    // Next auto-approve pass: the breaker refuses and snoozes — no second execution.
    await autoApproveTick();
    await platform.settle();
    expect(platform.rows('dev_autopilot_executions')).toHaveLength(1);
    const rec = platform.rows('autopilot_recommendations')[0];
    expect(rec.status).toBe('snoozed');
    expect(Date.parse(rec.snoozed_until)).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    expect(platform.events('dev_autopilot.finding.snoozed')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ finding_id: finding.id, pass: 'baseline', reason: 'turn_cap_failure' }) }),
    ]);
    await executorTick();
    expect(model.workerCalls()).toBe(8);
  });
});

// ===========================================================================
// 4. CI failure on an agent PR → fix mode on the same PR
// ===========================================================================

/** First attempt ships a bug (no comma); CI catches it. */
function buggyAgentRun() {
  return [
    tools(['read_file', { path: GREETING }]),
    tools(
      ['edit_file', { path: GREETING, old_string: "return 'Hello';", new_string: 'return `Hello ${name}`;' }],
      ['write_file', { path: GREETING_TEST, content: "import { greet } from '../src/services/greeting';\n\ntest('greets by name', () => {\n  expect(greet('Ada')).toBe('Hello, Ada');\n});\n" }],
    ),
    tools(['finish', { summary: 'greet() includes the name.', pr_title: 'feat(greeting): greet by name', pr_body: 'Adds the name to the greeting.' }]),
  ];
}

async function openAgentPr(threadId: string): Promise<{ vtid: string; execId: string; prNumber: number }> {
  process.env.OPERATOR_PR_APPROVAL_REQUIRED = 'false';
  const { vtid, execId } = await queueRequest(threadId);
  expect(platform.execution(execId).metadata.require_approval).toBeUndefined();
  model.workerRuns.push(buggyAgentRun());
  await executorTick();
  const ex = platform.execution(execId);
  expect(ex.status).toBe('ci');
  expect(typeof ex.pr_number).toBe('number');
  return { vtid, execId, prNumber: ex.pr_number };
}

describe('CI failure on an agent PR: the fix continues on the same PR', () => {
  it('red CI → triage → fix-mode child on the SAME branch → no second PR → green → merged → parent self_healed', async () => {
    const { vtid, execId, prNumber } = await openAgentPr('a0000000-0000-4000-8000-000000000041');
    const pr = platform.github.prs.get(prNumber)!;
    expect(pr.title).toBe(`feat(greeting): greet by name (${vtid})`);
    const branch = pr.head.ref;

    // CI goes red on the PR head.
    platform.github.setChecks(pr.head.sha, CI_CHECKS, ['Gateway (Jest, ~7.5k tests)']);
    await ciTick();
    const parent = platform.execution(execId);
    expect(parent.status).toBe('reverted');
    expect(parent.metadata).toEqual(expect.objectContaining({ failed_checks: ['Gateway (Jest, ~7.5k tests)'], bridge_fix_mode: true }));
    expect(parent.metadata.pr_closed_unmerged_at).toBeUndefined();
    expect(pr.state).toBe('open'); // fix mode leaves the PR open
    const failedEvt = execEvents('dev_autopilot.execution.ci_failed', execId);
    expect(failedEvt).toHaveLength(1);
    expect(failedEvt[0].metadata.gate_reason).toBe('blocked: required check(s) failed: Gateway (Jest, ~7.5k tests)');

    // The child carries the PR and the real CI log excerpt.
    const child = platform.rows('dev_autopilot_executions').find((e) => e.parent_execution_id === execId)!;
    expect(child).toEqual(expect.objectContaining({ status: 'cooling', auto_fix_depth: 1 }));
    expect(child.metadata.fix_mode).toEqual({ branch, pr_number: prNumber, pr_url: pr.html_url, parent_execution_id: execId });
    expect(child.metadata.executor).toBe('agent');
    expect(child.metadata.parent_failure).toContain('expected "Hello, Ada" received "Hello, undefined"');
    expect(platform.events('dev_autopilot.execution.self_heal_injected')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ fix_mode: true, fix_pr_number: prNumber, child_execution_id: child.id }) }),
    ]);

    // The fix run: the PR-flood guard lets it through (its target IS the open PR).
    let fixPrompt = '';
    model.workerRuns.push([
      (ctx: ModelCallCtx) => { fixPrompt = ctx.prompt; return tools(['read_file', { path: GREETING }]); },
      tools(['edit_file', { path: GREETING, old_string: 'return `Hello ${name}`;', new_string: 'return `Hello, ${name}`;' }]),
      tools(['run_check', { kind: 'jest', target: GREETING_TEST }]),
      tools(['finish', { summary: 'Add the missing comma.', pr_title: 'fix(greeting): comma', pr_body: 'CI expected "Hello, Ada".' }]),
    ]);
    await executorTick();
    expect(fixPrompt).toMatch(new RegExp(`^# Task ${vtid} — FIX MODE \\(attempt 2 of `));
    expect(fixPrompt).toContain(`You are on branch ${branch}, the branch of the open pull request ${pr.html_url}`);
    expect(fixPrompt).toContain('Gateway (Jest, ~7.5k tests)');
    expect(fixPrompt).toContain('expected "Hello, Ada" received "Hello, undefined"');
    const fixed = platform.execution(child.id);
    expect(fixed.status).toBe('ci');
    expect(fixed.pr_number).toBe(prNumber);
    expect(fixed.pr_url).toBe(pr.html_url);
    expect(workspaceLog.filter((w) => w.op === 'clone')).toEqual([
      { op: 'clone', branch, existingBranch: false },
      { op: 'clone', branch, existingBranch: true },
    ]);

    // One PR, two pushes to the same branch; the second is a fast-forward.
    expect(platform.github.prs.size).toBe(1);
    expect(platform.github.pushes.map((p) => [p.branch, p.force])).toEqual([[branch, true], [branch, false]]);
    expect(pr.head.sha).toBe(platform.github.pushes[1].sha);
    expect(platform.github.filesAt(branch)[GREETING]).toContain('Hello, ${name}');

    // Green → merge → deploy → verify; the parent lineage closes as self_healed.
    platform.github.setChecks(pr.head.sha, CI_CHECKS);
    await ciTick();
    expect(platform.execution(child.id).status).toBe('deploying');
    stagingDeployCompleted(pr.merge_commit_sha!);
    await deployWatcherTick();
    await platform.settle();
    elapseVerificationWindow(child.id);
    await verificationWatcherTick();
    await platform.settle();
    expect(platform.execution(child.id).status).toBe('completed');
    expect(platform.execution(execId).status).toBe('self_healed');
    expect(platform.github.prs.size).toBe(1);
    expect(pr.merged).toBe(true);
    expect(platform.rows('autopilot_recommendations')[0].status).toBe('completed');
    expect(platform.rows('dev_autopilot_executions')).toHaveLength(2);
    expect(model.refused).toEqual([]);
  });

  it('VTID-04472 — the VTID of a fix-mode lineage closes as success when the fix lands (it used to close as failed at the first red CI)', async () => {
    // dev-autopilot-watcher.ts ciWatcherTick moves the parent ci → failed via
    // transitionStatus(), which calls applyExecTerminalSideEffects(…, 'failed')
    // → terminalizeVtidLedgerForExecution(…, 'failed') BEFORE the bridge
    // re-labels the row `reverted` and spawns the fix-mode child. The child's
    // later `completed` cannot reopen it (the ledger PATCH is guarded by
    // is_terminal=eq.false). Remove `.failing` when that is fixed.
    // `.failing` passes on ANY failure; the test above drives the identical
    // flow with every precondition asserted, so a break upstream shows there.
    // Verified when written: this test fails only on its last line (ledger
    // reads status=failed, terminal_outcome=failed while the child completed).
    const { vtid, execId, prNumber } = await openAgentPr('a0000000-0000-4000-8000-000000000042');
    const pr = platform.github.prs.get(prNumber)!;
    platform.github.setChecks(pr.head.sha, CI_CHECKS, ['Gateway (Jest, ~7.5k tests)']);
    await ciTick();
    const child = platform.rows('dev_autopilot_executions').find((e) => e.parent_execution_id === execId)!;
    model.workerRuns.push([
      tools(['edit_file', { path: GREETING, old_string: 'return `Hello ${name}`;', new_string: 'return `Hello, ${name}`;' }]),
      tools(['finish', { summary: 'comma', pr_title: 'fix: comma', pr_body: 'comma' }]),
    ]);
    await executorTick();
    platform.github.setChecks(pr.head.sha, CI_CHECKS);
    await ciTick();
    stagingDeployCompleted(pr.merge_commit_sha!);
    await deployWatcherTick();
    await platform.settle();
    elapseVerificationWindow(child.id);
    await verificationWatcherTick();
    await platform.settle();
    expect(platform.execution(child.id).status).toBe('completed');
    expect(platform.ledger(vtid)).toEqual(expect.objectContaining({ is_terminal: true, terminal_outcome: 'success', status: 'completed' }));
  });
});

describe('VTID-04636 — the self-healing reconciler judges a fix-mode VTID by its lineage', () => {
  it('leaves the VTID open while the child is in CI, then closes it success (live: VTID-04608/04614 closed failed)', async () => {
    const { reconcileAutopilotLinkedSelfHealingVtids } = await import('../src/services/self-healing-reconciler');
    const { vtid, execId, prNumber } = await openAgentPr('a0000000-0000-4000-8000-000000004636');
    expect(platform.ledger(vtid).metadata?.autopilot_execution_id).toBe(execId);
    const pr = platform.github.prs.get(prNumber)!;
    platform.github.setChecks(pr.head.sha, CI_CHECKS, ['Gateway (Jest, ~7.5k tests)']);
    await ciTick();
    const child = platform.rows('dev_autopilot_executions').find((e) => e.parent_execution_id === execId)!;
    expect(platform.execution(execId).status).toBe('reverted');
    // The reconciler runs every cycle; here the parent is reverted and the child has not run yet.
    await reconcileAutopilotLinkedSelfHealingVtids();
    expect(platform.ledger(vtid).is_terminal).toBe(false);
    model.workerRuns.push([
      tools(['edit_file', { path: GREETING, old_string: 'return `Hello ${name}`;', new_string: 'return `Hello, ${name}`;' }]),
      tools(['finish', { summary: 'comma', pr_title: 'fix: comma', pr_body: 'comma' }]),
    ]);
    await executorTick();
    await reconcileAutopilotLinkedSelfHealingVtids();
    expect(platform.ledger(vtid).is_terminal).toBe(false);
    platform.github.setChecks(pr.head.sha, CI_CHECKS);
    await ciTick();
    stagingDeployCompleted(pr.merge_commit_sha!);
    await deployWatcherTick();
    await platform.settle();
    elapseVerificationWindow(child.id);
    await verificationWatcherTick();
    await platform.settle();
    await reconcileAutopilotLinkedSelfHealingVtids();
    expect(platform.execution(child.id).status).toBe('completed');
    expect(platform.ledger(vtid)).toEqual(expect.objectContaining({ is_terminal: true, terminal_outcome: 'success', status: 'completed' }));
  });
});

// ===========================================================================
// 5. Environment ownership (one table, two gateways)
// ===========================================================================

/** An execution another gateway claimed, already at `ci` with a green PR. */
function seedForeignCiExecution(claimedEnv: string | null): { execId: string; prNumber: number } {
  const f = platform.insert('autopilot_recommendations', { source_type: 'operator_onramp', status: 'new', risk_class: 'medium', title: 'foreign' });
  const branch = `dev-autopilot/${f.id.slice(0, 8)}`;
  const sha = platform.github.push(branch, { ...MAIN_FILES, [GREETING]: 'export const x = 1;\n' }, true);
  const created = platform.github.handle('POST', new URL(`https://api.github.com/repos/${platform.github.repo}/pulls`), { title: 'foreign', body: '', head: branch, base: 'main' });
  expect(created.status).toBe(201);
  const pr = platform.github.prForBranch(branch)!;
  platform.github.setChecks(sha, CI_CHECKS);
  const ex = platform.insert('dev_autopilot_executions', {
    finding_id: f.id, plan_version: 1, status: 'ci', branch, pr_url: pr.html_url, pr_number: pr.number,
    metadata: claimedEnv ? { claimed_env: claimedEnv, executor: 'agent' } : { executor: 'agent' },
  });
  return { execId: ex.id, prNumber: pr.number };
}

describe('Safety: an execution claimed by one environment is left alone by the other', () => {
  it('staging\'s CI watcher ignores a production-claimed PR; production\'s merges it', async () => {
    const { execId, prNumber } = seedForeignCiExecution('production');
    envState.env = 'staging';
    await ciTick();
    expect(platform.execution(execId).status).toBe('ci');
    expect(platform.github.calls.filter((c) => c.path.endsWith(`/pulls/${prNumber}`) || c.path.endsWith(`/pulls/${prNumber}/merge`))).toEqual([]);

    envState.env = 'production';
    await ciTick();
    expect(platform.execution(execId).status).toBe('deploying');
    expect(platform.github.prs.get(prNumber)!.merged).toBe(true);
  });

  it('a legacy row with no claim stamp stays visible to every environment', async () => {
    const { execId } = seedForeignCiExecution(null);
    envState.env = 'staging';
    await ciTick();
    expect(platform.execution(execId).status).toBe('deploying');
  });

  it('staging\'s running-watchdog does not reclaim a stale run production owns; it does reclaim its own', async () => {
    const mk = (env: string) => {
      const f = platform.insert('autopilot_recommendations', { source_type: 'operator_onramp', status: 'new', title: `stale ${env}` });
      const ex = platform.insert('dev_autopilot_executions', { finding_id: f.id, plan_version: 1, status: 'running', metadata: { claimed_env: env, executor: 'agent' } });
      ex.updated_at = new Date(Date.now() - 25 * 60_000).toISOString();
      return ex.id;
    };
    const prodRun = mk('production');
    const stagingRun = mk('staging');
    envState.env = 'staging';
    await executorTick();
    expect(platform.execution(prodRun).status).toBe('running');
    expect(platform.execution(stagingRun).metadata.error).toMatch(/^watchdog: stuck in 'running'/);
    expect(['failed', 'reverted', 'failed_escalated']).toContain(platform.execution(stagingRun).status);
    // The reclaim merged, never replaced, the row's metadata (VTID-04011).
    expect(platform.execution(stagingRun).metadata).toEqual(expect.objectContaining({ claimed_env: 'staging', executor: 'agent' }));
  });

  // VTID-04497: a merge to main deploys staging only, so a production claim
  // waits for a prod deploy that never comes and reverts the merge. Live:
  // 593cb4d1 → #3585 and 5769e66a → #3594 (2026-09-22), b3d4f2b3 (2026-09-24).
  it('the production gateway does not claim a queued execution; staging does', async () => {
    const threadId = 'a0000000-0000-4000-8000-000000000051';
    const { execId } = await queueRequest(threadId);

    envState.env = 'production';
    await executorTick();
    expect(platform.execution(execId).status).toBe('cooling');
    expect(platform.execution(execId).metadata.claimed_env).toBeUndefined();
    expect(execEvents('dev_autopilot.execution.running', execId)).toHaveLength(0);

    envState.env = 'staging';
    model.workerRuns.push(goodAgentRun());
    await executorTick();
    expect(platform.execution(execId).metadata).toEqual(expect.objectContaining({ claimed_env: 'staging' }));
    expect(platform.execution(execId).status).toBe('awaiting_approval');
  });

  it('production claims only with DEV_AUTOPILOT_PROD_CLAIM_ENABLED=true (exact)', async () => {
    const { executorClaimsHere } = await import('../src/services/dev-autopilot-env-ownership');
    expect(executorClaimsHere('staging', {})).toBe(true);
    expect(executorClaimsHere('production', {})).toBe(false);
    expect(executorClaimsHere('production', { DEV_AUTOPILOT_PROD_CLAIM_ENABLED: 'TRUE' })).toBe(false);
    expect(executorClaimsHere('production', { DEV_AUTOPILOT_PROD_CLAIM_ENABLED: 'true' })).toBe(true);
  });
});

// ===========================================================================
// 6. Cancel while running
// ===========================================================================

describe('Safety: cancelling a running execution stops it — nothing pushed, nothing retried', () => {
  it('the operator cancels from the console mid-run; the agent stops at its next boundary', async () => {
    const threadId = 'a0000000-0000-4000-8000-000000000061';
    const { vtid, execId } = await queueRequest(threadId);
    // The heartbeat is the agent's only view of the row; beat fast in this test.
    const realSetInterval = global.setInterval;
    jest.spyOn(global, 'setInterval').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      realSetInterval(fn, ms === 60_000 ? 10 : ms, ...args)) as unknown as typeof setInterval);

    let cancelReply: request.Response | null = null;
    model.workerRuns.push([
      tools(['read_file', { path: GREETING }]),
      async () => {
        // "Stop that, wrong file." — a second console turn while the agent thinks.
        model.operatorPlan.push(tools(['autopilot_cancel_execution', { execution_id: execId, reason: 'wrong file' }]));
        cancelReply = await request(app)
          .post('/api/v1/operator/chat')
          .set('X-Operator-Machine-Token', MACHINE_TOKEN)
          .send({ message: 'Stop that run, it is the wrong file.', threadId });
        // Give the heartbeat a few beats to read the cancelled row back.
        await new Promise((r) => setTimeout(r, 80));
        return tools(['edit_file', { path: GREETING, old_string: "return 'Hello';", new_string: "return 'Hi';" }]);
      },
      tools(['finish', { summary: 'x', pr_title: 'x', pr_body: 'x' }]),
    ]);
    await executorTick();

    expect(toolResult(cancelReply!, 'autopilot_cancel_execution')).toEqual(expect.objectContaining({ ok: true, cancelled_by: 'operator-chat:operator-machine-test-harness' }));
    const ex = platform.execution(execId);
    expect(ex.status).toBe('cancelled');
    expect(ex.metadata.cancelled).toEqual(expect.objectContaining({ by: 'operator-chat:operator-machine-test-harness', reason: 'wrong file', was: 'running' }));
    expect(model.workerCalls()).toBe(2); // the edit turn's tool call was never run, finish never asked for
    expect(platform.github.pushes).toEqual([]);
    expect(platform.github.prs.size).toBe(0);
    expect(platform.rows('dev_autopilot_executions')).toHaveLength(1); // no self-heal child
    expect(triage.calls).toEqual([]);
    // The stop came from the heartbeat's read-back of the cancelled row.
    expect(platform.events('dev_autopilot.agent.error').filter((e) => e.metadata?.execution_id === execId).map((e) => String(e.message)))
      .toEqual(expect.arrayContaining([expect.stringContaining('cancel requested by operator')]));
    expect(execEvents('dev_autopilot.execution.cancelled', execId)).toHaveLength(1);
    expect(execEvents('dev_autopilot.execution.failed', execId)).toEqual([]);
    expect(platform.ledger(vtid)).toEqual(expect.objectContaining({ is_terminal: true, terminal_outcome: 'cancelled' }));
    expect(platform.github.filesAt('main')[GREETING]).toBe(MAIN_FILES[GREETING]);
  });
});

// ===========================================================================
// 7. A stranded PR the bridge closed does not block the retry
// ===========================================================================

describe('Safety: a prior PR the bridge closed unmerged does not block the finding\'s retry', () => {
  it('red CI on a single-shot PR → bridge closes it and stamps pr_closed_unmerged_at → the retry runs and opens a new PR', async () => {
    const vtidRow = platform.insert('vtid_ledger', { vtid: 'VTID-04601', status: 'in_progress', spec_status: 'approved', title: 'seeded' });
    const f = platform.insert('autopilot_recommendations', {
      source_type: 'dev_autopilot', status: 'new', risk_class: 'low', title: 'Greet by name', activated_vtid: vtidRow.vtid,
      spec_snapshot: { scanner: 'todo-scanner-v1', title: 'Greet by name' },
    });
    platform.insert('dev_autopilot_plan_versions', {
      finding_id: f.id, version: 1, plan_markdown: `## Files to modify\n- \`${GREETING}\`\n- \`${GREETING_TEST}\`\n`, files_referenced: [GREETING, GREETING_TEST],
    });
    const oldBranch = `dev-autopilot/${f.id.slice(0, 8)}`;
    const sha = platform.github.push(oldBranch, { ...MAIN_FILES, [GREETING]: 'broken' }, true);
    platform.github.handle('POST', new URL(`https://api.github.com/repos/${platform.github.repo}/pulls`), { title: 'first attempt', body: '', head: oldBranch, base: 'main' });
    const oldPr = platform.github.prForBranch(oldBranch)!;
    platform.github.setChecks(sha, CI_CHECKS, ['tsc']);
    const parent = platform.insert('dev_autopilot_executions', {
      finding_id: f.id, plan_version: 1, status: 'ci', branch: oldBranch, pr_url: oldPr.html_url, pr_number: oldPr.number,
      approved_at: new Date(Date.now() - 60_000).toISOString(), metadata: { claimed_env: 'staging' },
    });

    await ciTick();
    const p = platform.execution(parent.id);
    expect(p.status).toBe('reverted');
    expect(oldPr.state).toBe('closed');
    expect(oldPr.merged).toBe(false);
    expect(platform.github.deletedBranches).toContain(oldBranch);
    expect(typeof p.metadata.pr_closed_unmerged_at).toBe('string');
    expect(p.revert_pr_url).toBe(`${oldPr.html_url}#closed`);
    const child = platform.rows('dev_autopilot_executions').find((e) => e.parent_execution_id === parent.id)!;
    expect(child.status).toBe('cooling');
    expect(child.metadata.fix_mode).toBeUndefined(); // single-shot parent: start over, new PR

    // Control: without the stamp the same guard WOULD refuse the retry.
    const stamp = p.metadata.pr_closed_unmerged_at;
    delete p.metadata.pr_closed_unmerged_at;
    const blocked = await runExecutionSession(getSupabase()!, child.id);
    expect(blocked).toEqual(expect.objectContaining({ ok: false }));
    expect(blocked.error).toMatch(/already has an unmerged PR/);
    p.metadata.pr_closed_unmerged_at = stamp;

    // With it, the retry runs on the agent executor and opens a fresh PR.
    process.env.DEV_AUTOPILOT_EXECUTOR = 'agent';
    model.workerRuns.push(goodAgentRun());
    await executorTick();
    const retried = platform.execution(child.id);
    expect(retried.status).toBe('ci');
    expect(retried.pr_number).not.toBe(oldPr.number);
    expect(platform.github.prs.size).toBe(2);
    const newPr = platform.github.prs.get(retried.pr_number)!;
    expect(newPr.state).toBe('open');
    expect(newPr.title).toBe(`feat(greeting): greet by name (${vtidRow.vtid})`);
  });
});

// ===========================================================================
// Kill switch, and the contract between the fake and the real database
// ===========================================================================

describe('Safety: the kill switch stops claiming and the watchers', () => {
  it('an armed kill switch: a queued execution is not claimed and a green PR is not merged', async () => {
    const { execId } = await queueRequest('a0000000-0000-4000-8000-000000000081');
    const foreign = seedForeignCiExecution('staging');
    platform.rows('dev_autopilot_config')[0].kill_switch = true;
    await executorTick();
    await ciTick();
    expect(platform.execution(execId).status).toBe('cooling');
    expect(platform.execution(foreign.execId).status).toBe('ci');
    expect(model.workerCalls()).toBe(0);
    expect(platform.github.prs.get(foreign.prNumber)!.merged).toBe(false);
  });
});

// ===========================================================================
// VTID-04612 — a green PR that is behind main
// ===========================================================================

describe('Merge: a green PR while main keeps moving (VTID-04612)', () => {
  it('main moved but touched none of the PR files → merged on its green CI, no branch update', async () => {
    const { execId, prNumber } = seedForeignCiExecution(null);
    platform.github.mainAhead = { behindBy: 2, files: ['services/gateway/src/services/unrelated.ts', 'docs/notes.md'] };
    await ciTick();
    expect(platform.github.calls.some((c) => c.path.endsWith(`/pulls/${prNumber}/update-branch`))).toBe(false);
    expect(platform.github.prs.get(prNumber)!.merged).toBe(true);
    expect(platform.execution(execId).status).not.toBe('ci');
    expect(execEvents('dev_autopilot.execution.branch_updated', execId)).toEqual([]);
  });

  it('main touched a file the PR changes → the branch is updated and the PR waits for CI on the new head', async () => {
    const { execId, prNumber } = seedForeignCiExecution(null);
    platform.github.mainAhead = { behindBy: 1, files: [GREETING] };
    await ciTick();
    expect(platform.github.calls.some((c) => c.path.endsWith(`/pulls/${prNumber}/update-branch`))).toBe(true);
    expect(platform.github.prs.get(prNumber)!.merged).toBe(false);
    expect(platform.execution(execId).status).toBe('ci');
    expect(execEvents('dev_autopilot.execution.branch_updated', execId)).toHaveLength(1);
  });
});

describe('Console turn: several rounds of tools until the model answers (VTID-04628)', () => {
  const THREAD = 'c4c4c4c4-0000-4000-8000-000000004628';
  afterEach(() => { delete process.env.OPERATOR_MAX_TOOL_ROUNDS; });

  it('a failed tool call is corrected in the next round and the answer comes from the second result', async () => {
    model.operatorPlan.push(tools(['run_code', { code: 'this is not javascript (' }]));
    model.operatorContinue.push(tools(['run_code', { code: 'return 6 * 7' }]));
    model.operatorContinue.push(text('6 × 7 is 42.'));
    const res = await consoleTurn({ kind: 'machine' }, 'what is 6 times 7?', THREAD);
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('6 × 7 is 42.');
    const results = res.body.toolResults as Array<{ name: string; response: { ok: boolean } }>;
    expect(results.map((r) => [r.name, r.response.ok])).toEqual([['run_code', false], ['run_code', true]]);
    // Two continuation calls, each carrying the tool transcript back WITH the tools.
    const cont = model.calls.filter((c) => c.stage === 'operator' && c.service === 'gemini-operator-continue');
    expect(cont).toHaveLength(2);
    expect(cont[0].historyLength).toBeLessThan(cont[1].historyLength);
    // The single-round final call is not used when the model answered itself.
    expect(model.calls.filter((c) => c.service === 'gemini-operator-tool-results')).toHaveLength(0);
  });

  it('OPERATOR_MAX_TOOL_ROUNDS=1 keeps the single round: tools once, then the tool-less final call', async () => {
    process.env.OPERATOR_MAX_TOOL_ROUNDS = '1';
    model.operatorPlan.push(tools(['run_code', { code: 'return 1 + 1' }]));
    const res = await consoleTurn({ kind: 'machine' }, 'what is 1 + 1?', THREAD);
    expect(res.status).toBe(200);
    expect(model.calls.filter((c) => c.service === 'gemini-operator-continue')).toHaveLength(0);
    expect(model.calls.filter((c) => c.service === 'gemini-operator-tool-results')).toHaveLength(1);
  });

  it('the round budget ends a model that keeps calling tools: the tool-less final call answers', async () => {
    process.env.OPERATOR_MAX_TOOL_ROUNDS = '3';
    model.operatorPlan.push(tools(['run_code', { code: 'return 1' }]));
    for (let i = 0; i < 5; i++) model.operatorContinue.push(tools(['run_code', { code: `return ${i + 2}` }]));
    const res = await consoleTurn({ kind: 'machine' }, 'keep going', THREAD);
    expect(res.status).toBe(200);
    expect((res.body.toolResults as unknown[]).length).toBe(3);
    expect(model.calls.filter((c) => c.service === 'gemini-operator-continue')).toHaveLength(2);
    expect(model.calls.filter((c) => c.service === 'gemini-operator-tool-results')).toHaveLength(1);
  });
});

describe('Verification: sporadic unrelated errors do not revert a deployed change (VTID-04625)', () => {
  async function toVerifying(): Promise<string> {
    const { execId, prNumber } = seedForeignCiExecution(null);
    await ciTick();
    expect(platform.execution(execId).status).toBe('deploying');
    stagingDeployCompleted(platform.github.prs.get(prNumber)!.merge_commit_sha!);
    await deployWatcherTick();
    await platform.settle();
    expect(platform.execution(execId).status).toBe('verifying');
    return execId;
  }
  const errorEvent = (topic: string, vtid: string) => platform.insert('oasis_events', {
    topic, vtid, status: 'error', service: 'gateway', message: topic, metadata: {}, created_at: new Date().toISOString(),
  });

  it('the 2026-09-26 revert case: telemetry and two stray errors → completed, not reverted', async () => {
    const execId = await toVerifying();
    errorEvent('voice.latency.measured', 'VTID-03177');
    errorEvent('voice.latency.measured', 'VTID-03177');
    errorEvent('assistant.turn', 'VTID-0536');
    errorEvent('orb.live.connection_failed', 'VTID-01155');
    errorEvent('orb.live.connection_failed', 'VTID-01155');
    elapseVerificationWindow(execId);
    await verificationWatcherTick();
    await platform.settle();
    expect(platform.execution(execId).status).toBe('completed');
    expect(execEvents('dev_autopilot.execution.verification_failed', execId)).toEqual([]);
  });

  it('a new error type firing 3 times after the deploy still fails verification', async () => {
    const execId = await toVerifying();
    for (let i = 0; i < 3; i++) errorEvent('memory.write.failed', 'VTID-02000');
    elapseVerificationWindow(execId);
    await verificationWatcherTick();
    await platform.settle();
    expect(platform.execution(execId).status).not.toBe('completed');
    expect(execEvents('dev_autopilot.execution.verification_failed', execId)).toHaveLength(1);
  });
});

describe('Runner checks: a Command Hub frontend change runs the suites that read the asset (VTID-04617)', () => {
  const APP = 'services/gateway/src/frontend/command-hub/app.js';
  const PIN_TEST = 'services/gateway/test/command-hub/cache-bust-pin.test.ts';
  const OTHER_TEST = 'services/gateway/test/unrelated.test.ts';
  const NEW_TEST = 'services/gateway/test/ch-reason-meta.test.ts';

  it('the runner jest targets include every suite that names app.js, not only the paired ones', async () => {
    const gh = platform.github;
    gh.branches.set('main', gh.commit({
      ...gh.filesAt('main'),
      [APP]: "function renderReasons() { return 'x'; }\n",
      [PIN_TEST]: "import * as fs from 'fs';\ntest('pin', () => { expect(fs.readFileSync('src/frontend/command-hub/app.js', 'utf8')).toBeTruthy(); });\n",
      [OTHER_TEST]: "test('other', () => { expect(1).toBe(1); });\n",
    }));
    model.operatorPlan.push(tools(['autopilot_run_task', { request: 'Show recency on the Command Hub failure reasons.', title: 'Failure reason recency' }]));
    const res = await consoleTurn({ kind: 'machine' }, 'Please do this: show recency on the Command Hub failure reasons.', 'c4c4c4c4-0000-4000-8000-000000004617');
    expect(res.status).toBe(200);
    model.workerRuns.push([
      tools(
        ['edit_file', { path: APP, old_string: "return 'x';", new_string: "return 'x (recent)';" }],
        ['write_file', { path: NEW_TEST, content: "test('meta', () => { expect(true).toBe(true); });\n" }],
      ),
      tools(['finish', { summary: 'Recency on the failure reasons.', pr_title: 'feat(command-hub): failure reason recency', pr_body: 'Shows recency.' }]),
    ]);
    await executorTick();

    const runnerJest = checks.log.filter((c) => c.kind === 'runner:jest').map((c) => String(c.target));
    expect(runnerJest).toHaveLength(1);
    expect(runnerJest[0]).toContain('test/command-hub/cache-bust-pin.test.ts');
    expect(runnerJest[0]).toContain('test/ch-reason-meta.test.ts');
    expect(runnerJest[0]).not.toContain('unrelated.test.ts');
  });
});

describe('Contract: the emulated one-in-flight-execution index matches the migration', () => {
  it('the fake refuses a second in-flight execution for a finding with the same statuses the real index covers', () => {
    const dir = path.join(__dirname, '../../../supabase/migrations');
    const file = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .filter((f) => /dev_autopilot_executions_finding_inflight_uniq/.test(fs.readFileSync(path.join(dir, f), 'utf8')) && /CREATE UNIQUE INDEX/i.test(fs.readFileSync(path.join(dir, f), 'utf8')))
      .pop();
    expect(file).toBeDefined();
    const sql = fs.readFileSync(path.join(dir, file!), 'utf8');
    const m = /WHERE\s+status\s+IN\s*\(([^)]*)\)/i.exec(sql);
    expect(m).not.toBeNull();
    const statuses = m![1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect([...statuses].sort()).toEqual([...INFLIGHT_UNIQUE_STATUSES].sort());
  });
});

// ---------------------------------------------------------------------------
// VTID-05006: a Kiro session asks for an Operator write. The REAL MCP route,
// gates, confirmation store (over the fake database) and Operator executor run;
// only the admin lookup is stubbed (Supabase Auth's admin API is outside the
// pipeline).
// ---------------------------------------------------------------------------
import kiroMcpRouter, { resetKiroMcpLimits, setKiroMcpAdminLookup } from '../src/routes/operator-kiro-mcp';
import { mintKiroMcpToken } from '../src/services/kiro/kiro-mcp-token';

describe('Kiro writes: held until the user answers in the thread (VTID-05006)', () => {
  jest.setTimeout(30_000);
  const KIRO_VTID = 'VTID-09001';
  let mcp: express.Express;

  beforeEach(() => {
    Object.assign(process.env, { KIRO_MCP_ENABLED: 'true', KIRO_MCP_WRITE_ENABLED: 'true', GATEWAY_INTERNAL_TOKEN: 'pipeline-internal-token' });
    setKiroMcpAdminLookup(async () => ({ admin: true, tenantId: null }));
    resetKiroMcpLimits();
    platform.insert('vtid_ledger', { vtid: KIRO_VTID, status: 'in_progress', spec_status: 'approved', title: 'Kiro write scenario' });
    mcp = express();
    mcp.use(express.json());
    mcp.use('/api/v1/operator/kiro/mcp', kiroMcpRouter);
  });
  afterEach(() => {
    setKiroMcpAdminLookup(null);
    delete process.env.KIRO_MCP_WRITE_ENABLED;
  });

  const call = (name: string, args: Record<string, unknown>) =>
    request(mcp).post('/api/v1/operator/kiro/mcp')
      .set('Authorization', `Bearer ${mintKiroMcpToken(ADMIN_USER, 'kiro-thread-1')}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  async function pendingRow(): Promise<Row> {
    const realSetTimeout = globalThis.setTimeout;
    const deadline = Date.now() + 5_000;
    for (;;) {
      const r = platform.rows('kiro_mcp_confirmations').find((c) => c.status === 'pending');
      if (r) return r;
      if (Date.now() > deadline) throw new Error('no pending confirmation; rows=' + JSON.stringify(platform.rows('kiro_mcp_confirmations')) + ' unsupported=' + JSON.stringify(platform.unsupported) + ' ext=' + JSON.stringify(platform.externalCalls));
      await new Promise((res) => realSetTimeout(res, 20));
    }
  }

  async function answer(id: string, decision: 'allow' | 'deny') {
    const token = await jwt(ADMIN_USER, true);
    return request(app).post(`/api/v1/operator/kiro/confirmations/${id}`).set('Authorization', `Bearer ${token}`).send({ decision });
  }

  it('Allow: the card appears for the thread, the answer lands, the real executor runs, OASIS records it', async () => {
    const pending = call('autopilot_cancel_execution', { vtid: KIRO_VTID });
    const done = pending.then((r) => r);
    const row = await pendingRow();
    expect(row).toMatchObject({ user_id: ADMIN_USER, thread_id: 'kiro-thread-1', tool: 'autopilot_cancel_execution', vtid: KIRO_VTID });
    const token = await jwt(ADMIN_USER, true);
    const list = await request(app).get('/api/v1/operator/kiro/confirmations?thread_id=kiro-thread-1').set('Authorization', `Bearer ${token}`);
    expect(list.body.pending.map((p: any) => p.id)).toEqual([row.id]);
    expect((await answer(String(row.id), 'allow')).status).toBe(200);
    const res = await done;
    const text = res.body.result.content[0].text as string;
    expect(text).not.toMatch(/^(Refused|Denied|No answer)/);
    expect(platform.rows('kiro_mcp_confirmations')[0].status).toBe('allowed');
    expect(topics()).toEqual(expect.arrayContaining(['operator.kiro.write_confirmed', 'operator.kiro.write_tool_called']));
    // A second answer changes nothing.
    expect((await answer(String(row.id), 'deny')).status).toBe(409);
  });

  it('Deny: nothing runs', async () => {
    const done = call('autopilot_cancel_execution', { vtid: KIRO_VTID }).then((r) => r);
    const row = await pendingRow();
    expect((await answer(String(row.id), 'deny')).status).toBe(200);
    const res = await done;
    expect(res.body.result).toMatchObject({ isError: true, content: [{ text: 'Denied by the user. Nothing was done.' }] });
  });

  it('no open VTID: refused before anyone is asked', async () => {
    const res = await call('autopilot_cancel_execution', { vtid: 'VTID-09999' });
    expect(res.body.result.content[0].text).toBe('Refused: VTID-09999 does not exist. Nothing was done.');
    expect(platform.rows('kiro_mcp_confirmations')).toHaveLength(0);
  });

  // VTID-05014: the same path to the second repo. The real push runs against the fake
  // vitana-v1 repo, with the vitana-v1 token on every call and the platform repo untouched.
  it('vitana-v1 push under Allow: one commit on the kiro branch, v1 token only, platform repo untouched', async () => {
    process.env.FRONTEND_DEPLOY_TOKEN = 'pipeline-v1-token';
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'pipeline-platform-token';
    const branch = `kiro/${ADMIN_USER.replace(/-/g, '').slice(0, 8)}/home-copy`;
    const platformCalls = platform.github.calls.length;
    const done = call('dev_push_kiro_branch', {
      vtid: KIRO_VTID, repo: 'exafyltd/vitana-v1', branch, message: `${KIRO_VTID}: home copy`,
      files: [{ path: 'src/pages/Home.tsx', content: 'export default 2;\n' }],
    }).then((r) => r);
    const row = await pendingRow();
    expect(row).toMatchObject({ tool: 'dev_push_kiro_branch', vtid: KIRO_VTID });
    expect(String(row.summary)).toContain(`exafyltd/vitana-v1:${branch}`);
    expect((await answer(String(row.id), 'allow')).status).toBe(200);
    const res = await done;
    expect(res.body.result.isError).toBeFalsy();
    expect(platform.githubV1.filesAt(branch)).toEqual({ 'src/pages/Home.tsx': 'export default 2;\n' });
    expect(platform.githubV1.pushes).toEqual([expect.objectContaining({ branch, force: false })]);
    expect(new Set(platform.githubV1.auths)).toEqual(new Set(['Bearer pipeline-v1-token']));
    expect(platform.github.calls.length).toBe(platformCalls);
    expect(topics()).toEqual(expect.arrayContaining(['operator.kiro.write_confirmed', 'operator.kiro.branch_pushed']));
    delete process.env.FRONTEND_DEPLOY_TOKEN;
  });

  it('vitana-v1 push into supabase/: refused before anyone is asked', async () => {
    process.env.FRONTEND_DEPLOY_TOKEN = 'pipeline-v1-token';
    const branch = `kiro/${ADMIN_USER.replace(/-/g, '').slice(0, 8)}/edge-fn`;
    const res = await call('dev_push_kiro_branch', {
      vtid: KIRO_VTID, repo: 'exafyltd/vitana-v1', branch, message: `${KIRO_VTID}: fn`,
      files: [{ path: 'supabase/functions/x/index.ts', content: 'x' }],
    });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/may not change supabase\/functions\/x\/index\.ts/);
    expect(platform.githubV1.pushes).toHaveLength(0);
    delete process.env.FRONTEND_DEPLOY_TOKEN;
  });

  it('writes switched off: the write tools are not offered and a call is unknown', async () => {
    process.env.KIRO_MCP_WRITE_ENABLED = 'false';
    const res = await call('dev_merge_pr', { vtid: KIRO_VTID, pr_number: 1 });
    expect(res.body.error.message).toBe('Unknown tool: dev_merge_pr');
    expect(platform.rows('kiro_mcp_confirmations')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VTID-05018: a Kiro thread whose Kiro session is gone (idle close, deploy,
// another task) gets its stored turns back. The REAL chat route, thread store
// (over the fake database), Kiro turn runner and ACP client run; only
// `kiro-cli acp` is a scripted fake.
// ---------------------------------------------------------------------------
import { EventEmitter } from 'events';
import { setKiroBackend, closeAllKiroSessions } from '../src/services/kiro/kiro-turn';

describe('Kiro thread memory: a reopened session gets the thread back (VTID-05018)', () => {
  const THREAD = 'a5018000-0000-4000-8000-000000000001';
  const prompts: any[] = [];

  function fakeKiro(): any {
    const out = new EventEmitter();
    const proc = new EventEmitter();
    const send = (o: unknown) => out.emit('data', `${JSON.stringify(o)}\n`);
    return {
      stdout: out,
      stdin: {
        write: (line: string) => {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'K1' } });
          else if (msg.method === 'session/prompt') {
            prompts.push(msg.params.prompt);
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'K1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You asked me to wire GitHub, AWS and Supabase.' } } } });
            send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
          return true;
        },
        end: () => {},
      },
      kill() { proc.emit('exit'); },
      on: (ev: string, cb: any) => proc.on(ev, cb),
    };
  }

  beforeEach(() => {
    prompts.length = 0;
    Object.assign(process.env, { OPERATOR_THREADS_ENABLED: 'true', KIRO_ENGINE_ENABLED: 'true' });
    setKiroBackend({ spawn: () => fakeKiro(), workspace: () => '/work/pipeline' });
    platform.insert('operator_threads', { id: THREAD, user_id: ADMIN_USER, engine: 'kiro', title: 'Kiro wiring', created_at: new Date(Date.now() - 6 * 3600_000).toISOString() });
    platform.insert('operator_messages', { id: 'm1', thread_id: THREAD, role: 'user', content: 'Wire GitHub, AWS and Supabase into the Operator.', created_at: new Date(Date.now() - 6 * 3600_000).toISOString() });
    platform.insert('operator_messages', { id: 'm2', thread_id: THREAD, role: 'tool', tool_name: 'dev_search_codebase', content: '{"raw":"tool output"}', created_at: new Date(Date.now() - 6 * 3600_000 + 1_000).toISOString() });
    platform.insert('operator_messages', { id: 'm3', thread_id: THREAD, role: 'assistant', content: 'Here is what is wired today.', created_at: new Date(Date.now() - 6 * 3600_000 + 2_000).toISOString() });
  });
  afterEach(() => {
    closeAllKiroSessions();
    setKiroBackend(null);
    delete process.env.OPERATOR_THREADS_ENABLED;
    delete process.env.KIRO_ENGINE_ENABLED;
  });

  it('6 h later in the same thread: Kiro\'s first prompt carries the earlier turns (no tool rows), then the message', async () => {
    const res = await consoleTurn({ kind: 'jwt', token: await jwt(ADMIN_USER, true) }, 'Do you remember what I asked?', THREAD);
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(1);
    const [history, message] = prompts[0];
    expect(history.text).toContain('=== RESTORED THREAD HISTORY');
    expect(history.text).toContain('User: Wire GitHub, AWS and Supabase into the Operator.');
    expect(history.text).toContain('You (Kiro): Here is what is wired today.');
    expect(history.text).not.toContain('tool output');
    expect(message).toEqual({ type: 'text', text: 'Do you remember what I asked?' });
  });

  it('another user\'s thread is not restored into this user\'s session', async () => {
    platform.rows('operator_threads').find((t) => t.id === THREAD)!.user_id = 'e2222222-2222-4222-8222-222222222222';
    await consoleTurn({ kind: 'jwt', token: await jwt(ADMIN_USER, true) }, 'hello', THREAD);
    for (const p of prompts) expect(JSON.stringify(p)).not.toContain('Wire GitHub');
  });
});

// ---------------------------------------------------------------------------
// VTID-05064: a Kiro turn the model cut off (stopReason 'refusal') is recorded
// as 'refused', not 'ok'; the thread row exists as soon as the message is sent;
// the next reopened session sees that reply labelled as cut off, gets the
// session rules, and is told when unpushed edits of the last turn were lost.
// ---------------------------------------------------------------------------
describe('Kiro early stops and lost workspaces are visible (VTID-05064)', () => {
  const THREAD = 'a5064000-0000-4000-8000-000000000001';
  const prompts: any[] = [];
  let stopReason = 'refusal';
  let runner: { workspace: 'restored' | 'fresh' | null; dirty: string[] | null } = { workspace: 'fresh', dirty: ['vitana-platform'] };
  let rowAtPrompt: Row | undefined;

  function fakeKiro(): any {
    const out = new EventEmitter();
    const proc = new EventEmitter();
    const send = (o: unknown) => out.emit('data', `${JSON.stringify(o)}\n`);
    return {
      runner,
      stdout: out,
      stdin: {
        write: (line: string) => {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'K5' } });
          else if (msg.method === 'session/prompt') {
            prompts.push(msg.params.prompt);
            const row = platform.rows('operator_threads').find((t) => t.id === THREAD);
            if (!rowAtPrompt && row) rowAtPrompt = { ...row };
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'K5', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me look at the upload endpoint' } } } });
            send({ jsonrpc: '2.0', id: msg.id, result: { stopReason } });
          }
          return true;
        },
        end: () => {},
      },
      kill() { proc.emit('exit'); },
      on: (ev: string, cb: any) => proc.on(ev, cb),
    };
  }

  beforeEach(() => {
    prompts.length = 0;
    rowAtPrompt = undefined;
    stopReason = 'refusal';
    runner = { workspace: 'fresh', dirty: ['vitana-platform'] };
    Object.assign(process.env, { OPERATOR_THREADS_ENABLED: 'true', KIRO_ENGINE_ENABLED: 'true' });
    setKiroBackend({ spawn: () => fakeKiro(), workspace: () => '/work/pipeline' });
  });
  afterEach(() => {
    closeAllKiroSessions();
    setKiroBackend(null);
    delete process.env.OPERATOR_THREADS_ENABLED;
    delete process.env.KIRO_ENGINE_ENABLED;
  });

  it('a refused turn is recorded as refused; the thread row existed before the turn ended; the next session is told', async () => {
    const res = await request(app).post('/api/v1/operator/chat')
      .set('Authorization', `Bearer ${await jwt(ADMIN_USER, true)}`)
      .send({ message: 'enable paste of images', mode: 'chat', threadId: THREAD, engine: 'kiro' });
    await platform.settle();
    expect(res.status).toBe(200);
    // Thread row created at send, before Kiro answered.
    expect(rowAtPrompt).toBeDefined();
    expect(rowAtPrompt!.turns).toBe(0);
    // First prompt of the session: the rules, then the message.
    expect(prompts[0][0].text).toContain('=== OPERATOR SESSION RULES');
    const assistant = platform.rows('operator_messages').find((m) => m.thread_id === THREAD && m.role === 'assistant')!;
    expect(assistant.meta).toMatchObject({ kiro_status: 'refused', stop_reason: 'refusal', kiro_workspace_dirty: ['vitana-platform'] });

    // The session closes (idle); the runner starts the next one without the parked workspace.
    closeAllKiroSessions();
    stopReason = 'end_turn';
    runner = { workspace: 'fresh', dirty: [] };
    const res2 = await request(app).post('/api/v1/operator/chat')
      .set('Authorization', `Bearer ${await jwt(ADMIN_USER, true)}`)
      .send({ message: 'what is the status', mode: 'chat', threadId: THREAD });
    await platform.settle();
    expect(res2.status).toBe(200);
    expect(prompts[1][0].text).toContain('You (Kiro): [this reply was cut off: refusal] Let me look at the upload endpoint');
    const last = platform.rows('operator_messages').filter((m) => m.thread_id === THREAD && m.role === 'assistant').pop()!;
    expect(last.meta).toMatchObject({ kiro_status: 'ok', kiro_workspace: 'lost' });
    expect(platform.rows('oasis_events').some((e) => JSON.stringify(e).includes('operator.kiro.parked_workspace_lost'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VTID-05060: the developer picks the Kiro model (Auto or one from Kiro's own
// drop-down). When the thread's Kiro session reopens, the REAL chat route
// reads the last operator.kiro.model_selected pick from OASIS (fake database)
// and the REAL turn runner re-applies it through ACP before the prompt.
// ---------------------------------------------------------------------------
describe('Kiro model pick: a reopened session keeps the developer\'s model (VTID-05060)', () => {
  const THREAD = 'a5060000-0000-4000-8000-000000000001';
  const sent: any[] = [];

  function fakeKiro(): any {
    const out = new EventEmitter();
    const proc = new EventEmitter();
    const send = (o: unknown) => out.emit('data', `${JSON.stringify(o)}\n`);
    return {
      stdout: out,
      stdin: {
        write: (line: string) => {
          const msg = JSON.parse(line);
          sent.push(msg);
          if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'K2', models: { availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'claude-opus-5.5', name: 'Claude Opus 5.5' }], currentModelId: 'auto' } } });
          else if (msg.method === 'session/set_model') send({ jsonrpc: '2.0', id: msg.id, result: {} });
          else if (msg.method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          return true;
        },
        end: () => {},
      },
      kill() { proc.emit('exit'); },
      on: (ev: string, cb: any) => proc.on(ev, cb),
    };
  }

  beforeEach(() => {
    sent.length = 0;
    Object.assign(process.env, { OPERATOR_THREADS_ENABLED: 'true', KIRO_ENGINE_ENABLED: 'true' });
    setKiroBackend({ spawn: () => fakeKiro(), workspace: () => '/work/pipeline' });
    platform.insert('operator_threads', { id: THREAD, user_id: ADMIN_USER, engine: 'kiro', title: 'Model pick', created_at: new Date(Date.now() - 3600_000).toISOString() });
  });
  afterEach(() => {
    closeAllKiroSessions();
    setKiroBackend(null);
    delete process.env.OPERATOR_THREADS_ENABLED;
    delete process.env.KIRO_ENGINE_ENABLED;
  });

  it('the developer\'s last pick is re-applied before the first prompt of the new session', async () => {
    platform.insert('oasis_events', { id: 'e1', type: 'operator.kiro.model_selected', actor_id: ADMIN_USER, payload: { thread_id: THREAD, model_id: 'auto' }, created_at: new Date(Date.now() - 1800_000).toISOString() });
    platform.insert('oasis_events', { id: 'e2', type: 'operator.kiro.model_selected', actor_id: ADMIN_USER, payload: { thread_id: THREAD, model_id: 'claude-opus-5.5' }, created_at: new Date(Date.now() - 600_000).toISOString() });
    const res = await consoleTurn({ kind: 'jwt', token: await jwt(ADMIN_USER, true) }, 'continue', THREAD);
    expect(res.status).toBe(200);
    const methods = sent.map((m) => m.method);
    const setModel = sent.find((m) => m.method === 'session/set_model');
    expect(setModel?.params).toEqual({ sessionId: 'K2', modelId: 'claude-opus-5.5' });
    expect(methods.indexOf('session/set_model')).toBeLessThan(methods.indexOf('session/prompt'));
  });

  it('no pick on record (or another user\'s pick) changes nothing: Kiro\'s own default stays', async () => {
    platform.insert('oasis_events', { id: 'e3', type: 'operator.kiro.model_selected', actor_id: 'e2222222-2222-4222-8222-222222222222', payload: { thread_id: THREAD, model_id: 'claude-opus-5.5' }, created_at: new Date().toISOString() });
    const res = await consoleTurn({ kind: 'jwt', token: await jwt(ADMIN_USER, true) }, 'continue', THREAD);
    expect(res.status).toBe(200);
    expect(sent.some((m) => m.method === 'session/set_model')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VTID-05065: a Kiro turn is a server-side RUN. The REAL run routes, run
// service, chat-turn executor, permission broker, Kiro turn runner and ACP
// client run over the fake database; the SSE streams are read over a real
// HTTP socket (so a stream can be dropped mid-run); only `kiro-cli acp` is a
// scripted fake whose turns the test steps through.
// ---------------------------------------------------------------------------
import * as http from 'http';
import type { AddressInfo } from 'net';
import kiroRunsRouter from '../src/routes/operator-kiro-runs';
import operatorMediaRouter from '../src/routes/operator-media';
import {
  KIRO_RUN_LIMITS, drainKiroRunsForShutdown, sweepStaleKiroRuns, resetKiroRunsForTests, answerPersistedPermission,
  kiroRunsControlTick, kiroRunsHeartbeatTick, GATEWAY_TASK_ID,
} from '../src/services/kiro/kiro-runs';

describe('Kiro runs (VTID-05065)', () => {
  const THREAD = 'a5065000-0000-4000-8000-000000000001';
  const OTHER_ADMIN = 'f3333333-3333-4333-8333-333333333333';
  const realSetTimeout = globalThis.setTimeout;
  const sleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
  const savedLimits = { ...KIRO_RUN_LIMITS };

  interface Ctl {
    chunk(t: string): void; tool(id: string, title: string, kind: string): void; toolDone(id: string): void;
    ask(title: string, kind: string): Promise<any>; cancelled: Promise<void>;
  }
  type Handler = (k: Ctl) => Promise<string>;
  // VTID-05067: `caps` = the agentCapabilities the fake kiro-cli advertises at initialize.
  const kiro = { prompts: [] as any[], handlers: [] as Handler[], replies: new Map<number, (r: any) => void>(), cancels: 0, permissionReplies: [] as any[], caps: undefined as Record<string, unknown> | undefined };

  function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

  function runsKiro(): any {
    const out = new EventEmitter();
    const proc = new EventEmitter();
    const send = (o: unknown) => out.emit('data', `${JSON.stringify(o)}\n`);
    let cancel: (() => void) | null = null;
    let nextReq = 900;
    const upd = (update: Record<string, unknown>) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'KR', update } });
    return {
      stdout: out,
      stdin: {
        write: (line: string) => {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, ...(kiro.caps ? { agentCapabilities: kiro.caps } : {}) } });
          else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'KR' } });
          else if (msg.method === 'session/cancel') { kiro.cancels += 1; cancel?.(); }
          else if (msg.method === 'session/prompt') {
            kiro.prompts.push(msg.params.prompt);
            const handler = kiro.handlers.shift() ?? (async (k: Ctl) => { k.chunk('done'); return 'end_turn'; });
            const c = deferred();
            cancel = c.resolve;
            const ctl: Ctl = {
              chunk: (t) => upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }),
              tool: (id, title, kind) => upd({ sessionUpdate: 'tool_call', toolCallId: id, title, kind, status: 'pending' }),
              toolDone: (id) => upd({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' }),
              ask: (title, kind) => new Promise((res) => {
                const id = nextReq++;
                kiro.replies.set(id, res);
                send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'KR', toolCall: { toolCallId: `tc${id}`, title, kind }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
              }),
              cancelled: c.promise,
            };
            void handler(ctl).then((stopReason) => send({ jsonrpc: '2.0', id: msg.id, result: { stopReason } }));
          } else if (msg.id !== undefined && !msg.method) {
            kiro.permissionReplies.push(msg.result);
            const r = kiro.replies.get(msg.id);
            if (r) { kiro.replies.delete(msg.id); r(msg.result); }
          }
          return true;
        },
        end: () => {},
      },
      kill() { proc.emit('exit'); },
      on: (ev: string, cb: any) => proc.on(ev, cb),
    };
  }

  interface Frame { id: number | null; event: string; data: any }
  function openStream(runId: string, token: string, afterSeq = 0) {
    const frames: Frame[] = [];
    let status = 0;
    let contentType = '';
    let resolveEnd!: () => void;
    const ended = new Promise<void>((r) => { resolveEnd = r; });
    const req = http.request({ host: '127.0.0.1', port, path: `/api/v1/operator/kiro/runs/${runId}/stream?after_seq=${afterSeq}`, method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (res) => {
      status = res.statusCode || 0;
      contentType = String(res.headers['content-type'] || '');
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const f: Frame = { id: null, event: 'message', data: null };
          let isFrame = false;
          for (const line of raw.split('\n')) {
            if (line.startsWith('id: ')) { f.id = Number(line.slice(4)); isFrame = true; }
            else if (line.startsWith('event: ')) { f.event = line.slice(7); isFrame = true; }
            else if (line.startsWith('data: ')) { f.data = JSON.parse(line.slice(6)); isFrame = true; }
          }
          if (isFrame) frames.push(f);
        }
      });
      res.on('end', () => resolveEnd());
      res.on('close', () => resolveEnd());
    });
    req.on('error', () => resolveEnd());
    req.end();
    openRequests.push(req);
    return { frames, ended, close: () => req.destroy(), get status() { return status; }, get contentType() { return contentType; } };
  }
  const openRequests: http.ClientRequest[] = [];

  async function waitFor(cond: () => boolean, what: string, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(5);
    }
  }

  let server: http.Server;
  let port = 0;
  let admin = '';
  let other = '';

  async function startRun(message: string, token = admin, threadId = THREAD) {
    return request(app).post('/api/v1/operator/kiro/runs').set('Authorization', `Bearer ${token}`).send({ thread_id: threadId, message });
  }
  async function startRunWith(message: string, attachments: string[], token = admin, threadId = THREAD) {
    return request(app).post('/api/v1/operator/kiro/runs').set('Authorization', `Bearer ${token}`).send({ thread_id: threadId, message, attachments });
  }
  const run = (id: string) => platform.rows('kiro_runs').find((r) => r.id === id)!;
  const runEvents = (id: string) => platform.rows('kiro_run_events').filter((e) => e.run_id === id).sort((a, b) => a.seq - b.seq);
  const seqs = (frames: Frame[]) => frames.filter((f) => f.id !== null).map((f) => f.id as number);
  const isDone = (id: string) => ['completed', 'refused', 'incomplete', 'failed', 'cancelled', 'interrupted'].includes(run(id)?.status);

  beforeAll(() => { Object.assign(KIRO_RUN_LIMITS, { coalesceMs: 20, flushMs: 20, streamPollMs: 20 }); });
  afterAll(() => { Object.assign(KIRO_RUN_LIMITS, savedLimits); });

  beforeEach(async () => {
    kiro.prompts.length = 0;
    kiro.handlers.length = 0;
    kiro.replies.clear();
    kiro.cancels = 0;
    kiro.permissionReplies.length = 0;
    kiro.caps = undefined;
    Object.assign(process.env, { OPERATOR_THREADS_ENABLED: 'true', KIRO_ENGINE_ENABLED: 'true' });
    setKiroBackend({ spawn: () => runsKiro(), workspace: () => '/work/runs' });
    app.use('/api/v1/operator/kiro/runs', kiroRunsRouter);
    app.use('/api/v1/operator/media', operatorMediaRouter); // VTID-05067
    server = app.listen(0);
    port = (server.address() as AddressInfo).port;
    admin = await jwt(ADMIN_USER, true);
    other = await jwt(OTHER_ADMIN, true);
  });
  afterEach(async () => {
    closeAllKiroSessions();
    await platform.settle().catch(() => undefined);
    resetKiroRunsForTests();
    setKiroBackend(null);
    // A stream a failing scenario left open must not hold the server (or the suite) open.
    for (const r of openRequests.splice(0)) r.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.OPERATOR_THREADS_ENABLED;
    delete process.env.KIRO_ENGINE_ENABLED;
  });

  it('start → 202 at once; the stream carries the whole turn in seq order and ends on the terminal status; row, events and OASIS agree', async () => {
    const gate = deferred();
    kiro.handlers.push(async (k) => { k.chunk('part one '); await gate.promise; k.tool('t1', 'Read a file', 'read'); k.chunk('part two'); k.toolDone('t1'); return 'end_turn'; });
    const res = await startRun('look at the upload endpoint');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, status: 'running' });
    const id = res.body.run_id as string;
    // Returned before the turn finished.
    expect(run(id)).toMatchObject({ status: 'running', thread_id: THREAD, user_id: ADMIN_USER, gateway_task: GATEWAY_TASK_ID });
    const s = openStream(id, admin);
    await waitFor(() => s.frames.some((f) => f.event === 'kiro.message_chunk'), 'first text');
    gate.resolve();
    await s.ended;
    expect(s.status).toBe(200);
    expect(s.contentType).toContain('text/event-stream');
    const ids = seqs(s.frames);
    expect(ids).toEqual(ids.map((_, i) => i + 1));
    expect(s.frames[0]).toMatchObject({ event: 'run.status', data: { status: 'running' } });
    expect(s.frames[s.frames.length - 1]).toMatchObject({ event: 'run.status', data: { status: 'completed' } });
    expect(s.frames.map((f) => f.event)).toEqual(expect.arrayContaining(['kiro.tool_call', 'kiro.tool_update', 'kiro.turn_end']));
    expect(s.frames.filter((f) => f.event === 'kiro.message_chunk').map((f) => f.data.text).join('')).toBe('part one part two');
    await waitFor(() => isDone(id), 'run row terminal');
    await platform.settle();
    expect(run(id)).toMatchObject({ status: 'completed', reply: 'part one part two', stop_reason: 'end_turn', pending_permission: null });
    expect(run(id).ended_at).toBeTruthy();
    expect(runEvents(id).map((e) => e.seq)).toEqual(ids);
    // The turn is recorded exactly as the old path records it.
    expect(platform.rows('operator_messages').filter((m) => m.thread_id === THREAD).map((m) => m.role)).toEqual(expect.arrayContaining(['user', 'assistant']));
    for (const t of ['operator.kiro.run_started', 'operator.kiro.run_finished']) {
      const evs = platform.events(t).filter((e) => e.metadata?.run_id === id);
      expect(evs).toHaveLength(1);
      expect(evs[0].metadata).toMatchObject({ run_id: id, thread_id: THREAD });
      expect(JSON.stringify(evs[0])).not.toContain('upload endpoint');
    }
    expect(platform.events('operator.kiro.run_finished').find((e) => e.metadata?.run_id === id)!.metadata.status).toBe('completed');
  });

  it('a dropped stream reattaches with after_seq (nothing lost, nothing twice); a second listener sees the same events; a finished run replays from the store', async () => {
    const g1 = deferred();
    const g2 = deferred();
    kiro.handlers.push(async (k) => { k.chunk('step one '); await g1.promise; k.tool('t1', 'Search code', 'search'); await g2.promise; k.chunk('step two'); k.toolDone('t1'); return 'end_turn'; });
    const id = (await startRun('two steps')).body.run_id as string;
    const second = openStream(id, admin);
    const first = openStream(id, admin);
    await waitFor(() => first.frames.some((f) => f.event === 'kiro.message_chunk'), 'first text on stream 1');
    first.close();
    await first.ended;
    const lastSeen = Math.max(...seqs(first.frames));
    g1.resolve();
    // Events happen while nobody of stream 1 listens.
    await waitFor(() => second.frames.some((f) => f.event === 'kiro.tool_call'), 'tool call on stream 2');
    const again = openStream(id, admin, lastSeen);
    await waitFor(() => again.frames.some((f) => f.event === 'kiro.tool_call'), 'replayed tool call');
    g2.resolve();
    await Promise.all([again.ended, second.ended]);
    const all = seqs(second.frames);
    expect(all).toEqual(all.map((_, i) => i + 1));
    expect([...seqs(first.frames), ...seqs(again.frames)]).toEqual(all);
    expect(seqs(again.frames)[0]).toBe(lastSeen + 1);
    expect([...first.frames, ...again.frames].map((f) => [f.id, f.event])).toEqual(second.frames.map((f) => [f.id, f.event]));
    await waitFor(() => isDone(id), 'run finished');
    await platform.settle();
    // After the run: a fresh listener replays it from kiro_run_events alone.
    const replay = openStream(id, admin, 0);
    await replay.ended;
    expect(replay.frames.map((f) => [f.id, f.event, JSON.stringify(f.data)])).toEqual(second.frames.map((f) => [f.id, f.event, JSON.stringify(f.data)]));
    // Last-Event-ID style resume from the middle.
    const tail = openStream(id, admin, all[all.length - 2]);
    await tail.ended;
    expect(seqs(tail.frames)).toEqual([all[all.length - 1]]);
  });

  it('an approval card is persisted on the run, shown to two listeners, and answered from the second through the existing route', async () => {
    kiro.handlers.push(async (k) => { const r = await k.ask('Edit services/gateway/src/a.ts', 'edit'); k.chunk(r.outcome.outcome === 'selected' ? 'edited' : 'not edited'); return 'end_turn'; });
    const id = (await startRun('edit a file')).body.run_id as string;
    const a = openStream(id, admin);
    const b = openStream(id, admin);
    await waitFor(() => a.frames.some((f) => f.event === 'kiro.permission_request') && b.frames.some((f) => f.event === 'kiro.permission_request'), 'card on both');
    const card = b.frames.find((f) => f.event === 'kiro.permission_request')!.data;
    await waitFor(() => run(id).status === 'waiting_permission', 'waiting_permission persisted');
    expect(run(id).pending_permission).toMatchObject({ request_id: card.request_id, title: 'Edit services/gateway/src/a.ts', kind: 'edit' });
    // Another admin cannot answer it.
    const denied = await request(app).post(`/api/v1/operator/kiro/permissions/${card.request_id}`).set('Authorization', `Bearer ${other}`).send({ allow: true });
    expect(denied.status).toBe(403);
    const ans = await request(app).post(`/api/v1/operator/kiro/permissions/${card.request_id}`).set('Authorization', `Bearer ${admin}`).send({ allow: true });
    expect(ans.status).toBe(200);
    await Promise.all([a.ended, b.ended]);
    for (const s of [a, b]) {
      expect(s.frames.find((f) => f.event === 'kiro.permission_answer')!.data).toMatchObject({ request_id: card.request_id, allow: true, by: 'user' });
      expect(s.frames.filter((f) => f.event === 'run.status').map((f) => f.data.status)).toEqual(['running', 'waiting_permission', 'running', 'completed']);
    }
    expect(kiro.permissionReplies[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await waitFor(() => isDone(id), 'run finished');
    await platform.settle();
    expect(run(id)).toMatchObject({ status: 'completed', reply: 'edited', pending_permission: null });
    expect(platform.events('operator.kiro.permission_answered')).toHaveLength(1);
  });

  it('an answer written from another gateway task reaches Kiro through the owning task\'s control tick', async () => {
    kiro.handlers.push(async (k) => { const r = await k.ask('Run shell command', 'execute'); k.chunk(r.outcome.outcome === 'selected' ? 'ran' : 'skipped'); return 'end_turn'; });
    const id = (await startRun('run it')).body.run_id as string;
    await waitFor(() => run(id).status === 'waiting_permission', 'waiting_permission');
    const reqId = run(id).pending_permission.request_id as string;
    expect(await answerPersistedPermission(reqId, OTHER_ADMIN, false)).toEqual({ ok: false, error: 'forbidden' });
    expect(await answerPersistedPermission(reqId, ADMIN_USER, false)).toEqual({ ok: true });
    expect(run(id).pending_permission.answer).toMatchObject({ allow: false });
    expect(kiro.permissionReplies).toHaveLength(0);
    await kiroRunsControlTick();
    await waitFor(() => isDone(id), 'run finished');
    await platform.settle();
    expect(kiro.permissionReplies[0]).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(run(id)).toMatchObject({ status: 'completed', reply: 'skipped', pending_permission: null });
  });

  it('the existing permission route answers a card waiting in a run on another gateway task (written onto the run record)', async () => {
    platform.insert('kiro_runs', { id: 'b5065000-0000-4000-8000-0000000000d1', thread_id: THREAD, user_id: ADMIN_USER, status: 'waiting_permission', message: 'm', gateway_task: 'other-task', last_heartbeat_at: new Date().toISOString(), pending_permission: { request_id: 'q-remote', title: 'Edit a.ts', kind: 'edit' } });
    const foreign = await request(app).post('/api/v1/operator/kiro/permissions/q-remote').set('Authorization', `Bearer ${other}`).send({ allow: true });
    expect(foreign.status).toBe(403);
    const res = await request(app).post('/api/v1/operator/kiro/permissions/q-remote').set('Authorization', `Bearer ${admin}`).send({ allow: true });
    expect(res.status).toBe(200);
    expect(run('b5065000-0000-4000-8000-0000000000d1').pending_permission).toMatchObject({ request_id: 'q-remote', answer: { allow: true } });
    expect((await request(app).post('/api/v1/operator/kiro/permissions/q-unknown').set('Authorization', `Bearer ${admin}`).send({ allow: true })).status).toBe(404);
  });

  it('a cancel written from another gateway task stops the run through the owning task\'s control tick', async () => {
    kiro.handlers.push(async (k) => { k.chunk('busy'); await k.cancelled; return 'cancelled'; });
    const id = (await startRun('stop me elsewhere')).body.run_id as string;
    await waitFor(() => kiro.prompts.length === 1, 'prompt sent');
    run(id).cancel_requested_at = new Date().toISOString();
    expect(kiro.cancels).toBe(0);
    await kiroRunsControlTick();
    await waitFor(() => isDone(id), 'cancelled');
    await platform.settle();
    expect(kiro.cancels).toBe(1);
    expect(run(id).status).toBe('cancelled');
  });

  it('the heartbeat is ONE update over this task\'s unfinished runs; other tasks\' rows are untouched', async () => {
    const gate = deferred();
    kiro.handlers.push(async (k) => { k.chunk('x'); await gate.promise; return 'end_turn'; });
    const id = (await startRun('beat')).body.run_id as string;
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    platform.insert('kiro_runs', { id: 'b5065000-0000-4000-8000-0000000000e1', thread_id: 'a5065000-0000-4000-8000-0000000000e0', user_id: ADMIN_USER, status: 'running', message: 'm', gateway_task: 'other-task', last_heartbeat_at: old });
    run(id).last_heartbeat_at = old;
    const before = platform.restCalls.filter((c) => c.method === 'PATCH' && c.table === 'kiro_runs').length;
    expect(await kiroRunsHeartbeatTick()).toBe(true);
    expect(platform.restCalls.filter((c) => c.method === 'PATCH' && c.table === 'kiro_runs').length).toBe(before + 1);
    expect(Date.parse(run(id).last_heartbeat_at)).toBeGreaterThan(Date.now() - 5_000);
    expect(run('b5065000-0000-4000-8000-0000000000e1').last_heartbeat_at).toBe(old);
    // This task's own run is never swept, even with an old heartbeat.
    run(id).last_heartbeat_at = old;
    expect(await sweepStaleKiroRuns()).toBe(1);
    expect(run(id).status).toBe('running');
    gate.resolve();
    await waitFor(() => isDone(id), 'finished');
    await platform.settle();
  });

  it('Kiro\'s own MCP read tool (recorded title, kind other) runs without a card; a write tool still asks', async () => {
    kiro.handlers.push(async (k) => {
      const r = await k.ask('Running: @vitana/dev_read_file', 'other');
      k.chunk(`read:${r.outcome.optionId ?? 'none'}`);
      return 'end_turn';
    });
    const id = (await startRun('read a file')).body.run_id as string;
    const s = openStream(id, admin);
    await s.ended;
    expect(s.frames.some((f) => f.event === 'kiro.permission_request')).toBe(false);
    expect(s.frames.filter((f) => f.event === 'run.status').map((f) => f.data.status)).toEqual(['running', 'completed']);
    expect(kiro.permissionReplies[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await waitFor(() => isDone(id), 'run finished');
    await platform.settle();
    expect(run(id).reply).toBe('read:allow');

    kiro.handlers.push(async (k) => { await k.ask('Running: @vitana/dev_create_pr', 'other'); return 'end_turn'; });
    const id2 = (await startRun('open a PR')).body.run_id as string;
    await waitFor(() => run(id2).status === 'waiting_permission', 'write tool asks');
    expect(run(id2).pending_permission.title).toBe('Running: @vitana/dev_create_pr');
    await request(app).post(`/api/v1/operator/kiro/permissions/${run(id2).pending_permission.request_id}`).set('Authorization', `Bearer ${admin}`).send({ allow: false });
    await waitFor(() => isDone(id2), 'second run finished');
    await platform.settle();
  });

  it('a run sent while one runs is queued, starts by itself when the first ends; a third queued run is refused (queue_full)', async () => {
    const gate = deferred();
    kiro.handlers.push(async (k) => { k.chunk('first'); await gate.promise; return 'end_turn'; });
    kiro.handlers.push(async (k) => { k.chunk('second'); return 'end_turn'; });
    kiro.handlers.push(async (k) => { k.chunk('third'); return 'end_turn'; });
    const r1 = await startRun('one');
    const r2 = await startRun('two');
    const r3 = await startRun('three');
    const r4 = await startRun('four');
    expect([r1.body.status, r2.body.status, r3.body.status]).toEqual(['running', 'queued', 'queued']);
    expect(r4.status).toBe(409);
    expect(r4.body).toEqual({ ok: false, error: 'queue_full' });
    expect(platform.rows('kiro_runs')).toHaveLength(3);
    expect(run(r2.body.run_id).started_at ?? null).toBeNull();
    const list = await request(app).get(`/api/v1/operator/kiro/runs?thread_id=${THREAD}`).set('Authorization', `Bearer ${admin}`);
    expect(list.body.runs.map((r: any) => r.status)).toEqual(['queued', 'queued', 'running']);
    gate.resolve();
    await waitFor(() => isDone(r3.body.run_id), 'third run finished');
    await platform.settle();
    expect(kiro.prompts.map((p) => p[p.length - 1].text)).toEqual(['one', 'two', 'three']);
    expect([r1, r2, r3].map((r) => run(r.body.run_id).status)).toEqual(['completed', 'completed', 'completed']);
    expect([r1, r2, r3].map((r) => run(r.body.run_id).reply)).toEqual(['first', 'second', 'third']);
    expect(platform.events('operator.kiro.run_started')).toHaveLength(3);
  });

  it('cancel: a queued run is cancelled at once; a running run ends cancelled through Kiro\'s own cancel; only the owner may cancel', async () => {
    kiro.handlers.push(async (k) => { k.chunk('working'); await k.cancelled; return 'cancelled'; });
    const r1 = await startRun('long job');
    const r2 = await startRun('next job');
    expect(r2.body.status).toBe('queued');
    const foreign = await request(app).post(`/api/v1/operator/kiro/runs/${r2.body.run_id}/cancel`).set('Authorization', `Bearer ${other}`);
    expect(foreign.status).toBe(403);
    const c2 = await request(app).post(`/api/v1/operator/kiro/runs/${r2.body.run_id}/cancel`).set('Authorization', `Bearer ${admin}`);
    expect(c2.body).toEqual({ ok: true, status: 'cancelled' });
    expect(run(r2.body.run_id).status).toBe('cancelled');
    const s = openStream(r1.body.run_id, admin);
    await waitFor(() => s.frames.some((f) => f.event === 'kiro.message_chunk'), 'running');
    const c1 = await request(app).post(`/api/v1/operator/kiro/runs/${r1.body.run_id}/cancel`).set('Authorization', `Bearer ${admin}`);
    expect(c1.body).toEqual({ ok: true, status: 'cancelling' });
    await s.ended;
    expect(kiro.cancels).toBe(1);
    expect(s.frames[s.frames.length - 1]).toMatchObject({ event: 'run.status', data: { status: 'cancelled', stop_reason: 'cancelled' } });
    await waitFor(() => isDone(r1.body.run_id), 'run row cancelled');
    await platform.settle();
    expect(run(r1.body.run_id).status).toBe('cancelled');
    // The cancelled queued run never reached Kiro.
    expect(kiro.prompts).toHaveLength(1);
    const late = await request(app).post(`/api/v1/operator/kiro/runs/${r1.body.run_id}/cancel`).set('Authorization', `Bearer ${admin}`);
    expect(late.status).toBe(409);
    expect(platform.events('operator.kiro.run_finished').map((e) => e.metadata.status).sort()).toEqual(['cancelled', 'cancelled']);
  });

  it('graceful shutdown marks this task\'s running run interrupted at once (one OASIS event), the stream ends, and a late turn end changes nothing', async () => {
    kiro.handlers.push(async (k) => { k.chunk('halfway'); await new Promise(() => undefined); return 'end_turn'; });
    const id = (await startRun('a long task')).body.run_id as string;
    const s = openStream(id, admin);
    await waitFor(() => s.frames.some((f) => f.event === 'kiro.message_chunk'), 'running');
    const r = await drainKiroRunsForShutdown(3_000);
    // VTID-05068: `detached` counts runs let go for the next task; this backend cannot reattach, so 0.
    expect(r).toEqual({ interrupted: 1, detached: 0, timedOut: false });
    await s.ended;
    expect(s.frames[s.frames.length - 1]).toMatchObject({ event: 'run.status', data: { status: 'interrupted' } });
    expect(run(id)).toMatchObject({ status: 'interrupted', error: 'gateway_shutdown' });
    // The halfway text was written before the task went away.
    expect(runEvents(id).some((e) => e.type === 'kiro.message_chunk' && e.payload.text === 'halfway')).toBe(true);
    // The process ends: the session dies, the executor finishes late — the run stays interrupted.
    closeAllKiroSessions();
    await platform.settle();
    expect(run(id).status).toBe('interrupted');
    expect(platform.events('operator.kiro.run_interrupted').filter((e) => e.metadata?.run_id === id)).toHaveLength(1);
  });

  it('a run whose row another task already ended (its sweep) is never overwritten by the late finish here', async () => {
    const gate = deferred();
    kiro.handlers.push(async (k) => { k.chunk('late'); await gate.promise; return 'end_turn'; });
    const id = (await startRun('slow')).body.run_id as string;
    await waitFor(() => kiro.prompts.length === 1, 'prompt sent');
    Object.assign(run(id), { status: 'interrupted', error: 'gateway_task_lost' });
    gate.resolve();
    await waitFor(() => platform.events('operator.kiro.run_finished').length === 1, 'local finish');
    await platform.settle();
    expect(run(id)).toMatchObject({ status: 'interrupted', error: 'gateway_task_lost' });
    expect(run(id).reply ?? null).toBeNull();
  });

  it('the sweep marks another task\'s stale run interrupted exactly once (guarded update, one OASIS event); fresh and finished runs are untouched', async () => {
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    platform.insert('kiro_runs', { id: 'b5065000-0000-4000-8000-00000000000a', thread_id: THREAD, user_id: ADMIN_USER, status: 'running', message: 'x', gateway_task: 'dead-task', last_heartbeat_at: old });
    platform.insert('kiro_runs', { id: 'b5065000-0000-4000-8000-00000000000b', thread_id: THREAD, user_id: ADMIN_USER, status: 'waiting_permission', message: 'y', gateway_task: 'live-task', last_heartbeat_at: new Date().toISOString() });
    platform.insert('kiro_runs', { id: 'b5065000-0000-4000-8000-00000000000c', thread_id: THREAD, user_id: ADMIN_USER, status: 'completed', message: 'z', gateway_task: 'dead-task', last_heartbeat_at: old });
    expect(await sweepStaleKiroRuns()).toBe(1);
    expect(await sweepStaleKiroRuns()).toBe(0);
    expect(run('b5065000-0000-4000-8000-00000000000a')).toMatchObject({ status: 'interrupted', error: 'gateway_task_lost' });
    expect(run('b5065000-0000-4000-8000-00000000000b').status).toBe('waiting_permission');
    expect(run('b5065000-0000-4000-8000-00000000000c').status).toBe('completed');
    const evs = platform.events('operator.kiro.run_interrupted');
    expect(evs).toHaveLength(1);
    expect(evs[0].metadata).toMatchObject({ run_id: 'b5065000-0000-4000-8000-00000000000a', thread_id: THREAD, status: 'interrupted' });
    // A listener of the swept run is told how it ended.
    const s = openStream('b5065000-0000-4000-8000-00000000000a', admin);
    await s.ended;
    expect(s.frames[s.frames.length - 1]).toMatchObject({ event: 'run.status', data: { status: 'interrupted' } });
  });

  it('continue after interrupted: a new run on the same thread opens a new session with the thread\'s history', async () => {
    platform.insert('operator_threads', { id: THREAD, user_id: ADMIN_USER, engine: 'kiro', title: 'Upload', created_at: new Date(Date.now() - 3600_000).toISOString() });
    platform.insert('operator_messages', { id: 'h1', thread_id: THREAD, role: 'user', content: 'Enable paste of images.', created_at: new Date(Date.now() - 3600_000).toISOString() });
    platform.insert('operator_messages', { id: 'h2', thread_id: THREAD, role: 'assistant', content: 'The upload endpoint needs a size limit.', created_at: new Date(Date.now() - 3599_000).toISOString() });
    kiro.handlers.push(async (k) => { k.chunk('started'); await new Promise(() => undefined); return 'end_turn'; });
    const first = (await startRun('go on')).body.run_id as string;
    await waitFor(() => runEvents(first).length > 0 || run(first).status === 'running', 'running');
    await waitFor(() => kiro.prompts.length === 1, 'first prompt');
    await drainKiroRunsForShutdown(3_000);
    closeAllKiroSessions(); // the new gateway task has no Kiro session
    await platform.settle();
    expect(run(first).status).toBe('interrupted');
    kiro.handlers.push(async (k) => { k.chunk('continuing'); return 'end_turn'; });
    const res = await startRun('continue');
    expect(res.body.status).toBe('running');
    await waitFor(() => isDone(res.body.run_id), 'continued run finished');
    await platform.settle();
    const [ctx, msg] = kiro.prompts[1];
    expect(ctx.text).toContain('=== RESTORED THREAD HISTORY');
    expect(ctx.text).toContain('You (Kiro): The upload endpoint needs a size limit.');
    expect(msg).toEqual({ type: 'text', text: 'continue' });
    expect(run(res.body.run_id)).toMatchObject({ status: 'completed', reply: 'continuing' });
  });

  it('owner checks: unauthenticated 401 JSON, a non-admin 403, another admin cannot read, stream, list or use the thread; bad ids 400', async () => {
    kiro.handlers.push(async (k) => { k.chunk('mine'); return 'end_turn'; });
    const id = (await startRun('private')).body.run_id as string;
    await waitFor(() => isDone(id), 'finished');
    await platform.settle();
    const anon = await request(app).get('/api/v1/operator/kiro/runs');
    expect(anon.status).toBe(401);
    expect(anon.headers['content-type']).toContain('application/json');
    const member = await request(app).get(`/api/v1/operator/kiro/runs/${id}`).set('Authorization', `Bearer ${await jwt(MEMBER_USER, false)}`);
    expect(member.status).toBe(403);
    expect((await request(app).get(`/api/v1/operator/kiro/runs/${id}`).set('Authorization', `Bearer ${other}`)).status).toBe(403);
    const mine = await request(app).get(`/api/v1/operator/kiro/runs/${id}`).set('Authorization', `Bearer ${admin}`);
    expect(mine.body.run).toMatchObject({ id, status: 'completed', reply: 'mine' });
    const foreignStream = openStream(id, other);
    await foreignStream.ended;
    expect(foreignStream.status).toBe(403);
    expect(foreignStream.frames).toHaveLength(0);
    const otherList = await request(app).get(`/api/v1/operator/kiro/runs?thread_id=${THREAD}`).set('Authorization', `Bearer ${other}`);
    expect(otherList.body.runs).toEqual([]);
    const hijack = await startRun('let me in', other);
    expect(hijack.status).toBe(403);
    expect((await request(app).get('/api/v1/operator/kiro/runs/not-a-uuid').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
    expect((await request(app).get('/api/v1/operator/kiro/runs?thread_id=x').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
    expect((await startRun('', admin)).status).toBe(400);
    expect((await request(app).get(`/api/v1/operator/kiro/runs/b5065000-0000-4000-8000-0000000000ff`).set('Authorization', `Bearer ${admin}`)).status).toBe(404);
    // An LLM thread is not a Kiro run's thread.
    platform.insert('operator_threads', { id: 'a5065000-0000-4000-8000-0000000000aa', user_id: ADMIN_USER, engine: 'llm', title: 'LLM' });
    expect((await startRun('x', admin, 'a5065000-0000-4000-8000-0000000000aa')).status).toBe(409);
  });

  // VTID-05067: a screenshot pasted into the Kiro composer is stored through the media route
  // and reaches Kiro as an ACP image block — only when kiro-cli advertises image input.
  it('a run with a pasted image reaches Kiro as image blocks; without image input Kiro gets one text line and the console is told', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-screenshot-bytes')]);
    const up = await request(app).post(`/api/v1/operator/media?thread_id=${THREAD}`).set('Authorization', `Bearer ${admin}`).set('Content-Type', 'image/png').send(png);
    expect(up.status).toBe(201);
    const mediaId = up.body.media_id as string;
    expect(platform.storageObjects.get(`operator-media/${ADMIN_USER}/${THREAD}/${mediaId}.png`)!.bytes.equals(png)).toBe(true);
    expect(platform.rows('operator_media')).toEqual([expect.objectContaining({ id: mediaId, user_id: ADMIN_USER, thread_id: THREAD, mime_type: 'image/png' })]);
    expect(platform.events('operator.media.uploaded')).toHaveLength(1);
    // Another admin cannot attach it.
    const foreign = await startRunWith('look at mine', [mediaId], other, 'a5067000-0000-4000-8000-0000000000f1');
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('invalid_attachment');

    kiro.caps = { promptCapabilities: { image: true } };
    kiro.handlers.push(async (k) => { k.chunk('I see the broken layout'); return 'end_turn'; });
    const res = await startRunWith('what is wrong on this screen?', [mediaId]);
    expect(res.status).toBe(202);
    const id = res.body.run_id as string;
    const s = openStream(id, admin);
    await s.ended;
    await waitFor(() => isDone(id), 'run finished');
    await platform.settle();
    const prompt = kiro.prompts[0];
    expect(prompt.filter((b: any) => b.type === 'image')).toEqual([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
    expect(prompt.find((b: any) => b.type === 'text' && b.text === 'what is wrong on this screen?')).toBeTruthy();
    expect(s.frames.find((f) => f.event === 'kiro.images')!.data).toMatchObject({ count: 1, delivery: 'sent', sent: 1 });
    expect(run(id)).toMatchObject({ status: 'completed', reply: 'I see the broken layout', attachments: [{ media_id: mediaId, mime_type: 'image/png' }] });
    const list = await request(app).get(`/api/v1/operator/kiro/runs?thread_id=${THREAD}`).set('Authorization', `Bearer ${admin}`);
    expect(list.body.runs[0].attachments).toEqual([{ media_id: mediaId, mime_type: 'image/png' }]);

    // A kiro-cli without image input: no image block, one line, and the console is told.
    closeAllKiroSessions();
    kiro.caps = { promptCapabilities: { image: false } };
    kiro.handlers.push(async (k) => { k.chunk('I cannot view images'); return 'end_turn'; });
    const res2 = await startRunWith('and now?', [mediaId]);
    await waitFor(() => isDone(res2.body.run_id), 'second run finished');
    await platform.settle();
    const p2 = kiro.prompts[1];
    expect(p2.some((b: any) => b.type === 'image')).toBe(false);
    expect(p2[p2.length - 1]).toEqual({ type: 'text', text: 'and now?\n\nThe user attached 1 image(s) that this agent cannot view.' });
    expect(runEvents(res2.body.run_id).find((e) => e.type === 'kiro.images')!.payload).toMatchObject({ delivery: 'unsupported', count: 1 });
    // More than 4 images per message is refused before a run exists.
    const many = await startRunWith('five', [mediaId, 'c5067000-0000-4000-8000-000000000002', 'c5067000-0000-4000-8000-000000000003', 'c5067000-0000-4000-8000-000000000004', 'c5067000-0000-4000-8000-000000000005']);
    expect(many.status).toBe(400);
    expect(many.body.error).toBe('too_many_attachments');
    expect(platform.rows('kiro_runs')).toHaveLength(2);
  });

  it('the old /chat/stream path runs through a run and still sends only the frames it always sent', async () => {
    kiro.handlers.push(async (k) => { k.chunk('old '); k.tool('t1', 'Read a file', 'read'); k.toolDone('t1'); k.chunk('path'); return 'end_turn'; });
    const res = await request(app).post('/api/v1/operator/chat/stream')
      .set('Authorization', `Bearer ${admin}`)
      .send({ message: 'hello', mode: 'chat', threadId: THREAD, engine: 'kiro' });
    await platform.settle();
    const events = [...res.text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe('turn.started');
    expect(events.slice(-2)).toEqual(['reply', 'done']);
    expect(new Set(events)).toEqual(new Set(['turn.started', 'kiro.message_chunk', 'kiro.tool_call', 'kiro.tool_update', 'kiro.turn_end', 'reply', 'done']));
    expect(res.text).not.toMatch(/"seq":/);
    const reply = JSON.parse(/event: reply\ndata: (.+)\n/.exec(res.text)![1]);
    expect(reply).toMatchObject({ ok: true, reply: 'old path', threadId: THREAD, meta: { engine: 'kiro', kiro_status: 'ok' } });
    // …and the turn has a run record.
    expect(platform.rows('kiro_runs')).toHaveLength(1);
    expect(platform.rows('kiro_runs')[0]).toMatchObject({ thread_id: THREAD, status: 'completed', reply: 'old path' });
  });
});

// VTID-05067: a screenshot pasted into the Operator (LLM) composer reaches the model as an
// image block through the router's `images` (the Bedrock/Anthropic adapters, VTID-03496).
describe('Operator turn with a pasted image (VTID-05067)', () => {
  const THREAD = 'a5067000-0000-4000-8000-0000000000b1';

  it('the image is stored, attached by media id, and handed to the model; another admin\'s image is refused', async () => {
    app.use('/api/v1/operator/media', operatorMediaRouter);
    const admin = await jwt(ADMIN_USER, true);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('operator-screenshot')]);
    const up = await request(app).post(`/api/v1/operator/media?thread_id=${THREAD}`).set('Authorization', `Bearer ${admin}`).set('Content-Type', 'image/png').send(png);
    expect(up.status).toBe(201);
    let seen: any = null;
    model.operatorPlan.push((ctx: ModelCallCtx) => { seen = ctx.opts.images; return text('The button overlaps the header.'); });
    const res = await request(app).post('/api/v1/operator/chat').set('Authorization', `Bearer ${admin}`)
      .send({ message: 'what is wrong here?', threadId: THREAD, attachments: [{ oasis_ref: up.body.oasis_ref, kind: 'image', media_id: up.body.media_id }] });
    await platform.settle();
    expect(res.status).toBe(200);
    expect(res.body.reply).toContain('The button overlaps the header.');
    expect(seen).toEqual([{ mimeType: 'image/png', base64: png.toString('base64') }]);

    const other = await jwt('f3333333-3333-4333-8333-333333333333', true);
    const refused = await request(app).post('/api/v1/operator/chat').set('Authorization', `Bearer ${other}`)
      .send({ message: 'peek', threadId: 'a5067000-0000-4000-8000-0000000000b2', attachments: [{ oasis_ref: 'x', kind: 'image', media_id: up.body.media_id }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_attachment');
  });
});

// ---------------------------------------------------------------------------
// VTID-05068: runs survive a gateway deploy. The REAL run service, chat-turn
// executor, Kiro turn runner, ACP client and token derivation run over the fake
// database; the kiro-runner is a fake whose kiro-cli "process" outlives its
// gateway socket (buffering output while detached) and checks the reattach
// token, exactly as services/kiro-runner/src/relay.ts does (pinned there by
// the runner's own vitest suite).
// ---------------------------------------------------------------------------
import { createHash } from 'crypto';
import { detachKiroSession } from '../src/services/kiro/kiro-turn';
import { KiroReattachRefusedError } from '../src/services/kiro/remote-backend';

describe('Kiro runs survive a gateway deploy (VTID-05068)', () => {
  const THREAD = 'a5068000-0000-4000-8000-000000000001';
  const realSetTimeout = globalThis.setTimeout;
  const sleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
  const savedLimits = { ...KIRO_RUN_LIMITS };
  function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
  async function waitFor(cond: () => boolean, what: string, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await sleep(5); }
  }

  interface Ctl { chunk(t: string): void; tool(id: string, title: string): void; toolDone(id: string): void; ask(title: string): Promise<any> }
  type Handler = (k: Ctl) => Promise<string>;

  /** One kiro-cli process on the fake runner: it outlives a dropped socket and buffers meanwhile. */
  class FakeKiroProcess {
    sink: EventEmitter | null = null;
    buffer: string[] = [];
    promptIds = new Set<number>();
    pendingAtDrop: number[] = [];
    replies = new Map<number, (r: any) => void>();
    openAsks = new Map<number, string>();
    ended = false;
    endedHow: string | null = null;
    dropped = 0;
    nextReq = 700;
    constructor(readonly userId: string, readonly threadId: string, readonly tokenHash: string | null, readonly handlers: Handler[]) {}
    send(o: unknown): void {
      if (this.ended) return;
      const line = JSON.stringify(o);
      if (this.sink) this.sink.emit('data', `${line}\n`); else this.buffer.push(line);
    }
    handle(line: string): void {
      const msg = JSON.parse(line);
      const upd = (update: Record<string, unknown>) => this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'KD', update } });
      if (msg.method === 'initialize') this.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      else if (msg.method === 'session/new') this.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'KD' } });
      else if (msg.method === 'session/prompt') {
        this.promptIds.add(msg.id);
        const handler = this.handlers.shift() ?? (async (k: Ctl) => { k.chunk('done'); return 'end_turn'; });
        const ctl: Ctl = {
          chunk: (t) => upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }),
          tool: (id, title) => upd({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'read', status: 'pending' }),
          toolDone: (id) => upd({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' }),
          ask: (title) => new Promise((res) => {
            const id = this.nextReq++;
            this.replies.set(id, res);
            const req = { jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'KD', toolCall: { toolCallId: `tc${id}`, title, kind: 'edit' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } };
            this.openAsks.set(id, JSON.stringify(req));
            this.send(req);
          }),
        };
        void handler(ctl).then((stopReason) => { this.promptIds.delete(msg.id); this.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason } }); });
      } else if (msg.id !== undefined && !msg.method) {
        this.openAsks.delete(msg.id);
        const r = this.replies.get(msg.id);
        if (r) { this.replies.delete(msg.id); r(msg.result); }
      }
    }
    /** The gateway socket dropped (a detach, or a dead task). */
    drop(): void { if (!this.sink) return; this.sink = null; this.dropped += 1; this.pendingAtDrop = [...this.promptIds]; }
    end(how: string): void { this.ended = true; this.endedHow = how; this.sink = null; }
    child(reattached: boolean): any {
      const out = new EventEmitter();
      const proc = new EventEmitter();
      const runner: any = { workspace: reattached ? null : 'fresh', dirty: null, reattached: null };
      if (reattached) {
        runner.reattached = { sessionId: 'KD', pendingPrompts: this.pendingAtDrop };
        // Like the runner: unanswered requests first, then the buffer — handed over a tick later (socketAsAcpChild).
        const replay = [...this.openAsks.values(), ...this.buffer.splice(0)];
        setImmediate(() => { for (const l of replay) out.emit('data', `${l}\n`); this.sink = out; });
      } else {
        this.sink = out;
      }
      return {
        stdout: out,
        stdin: { write: (line: string) => { this.handle(line); return true; }, end: () => this.end('closed_by_gateway') },
        kill: () => this.end('closed_by_gateway'),
        detach: () => this.drop(),
        on: (ev: string, cb: any) => proc.on(ev, cb),
        runner,
      };
    }
  }

  const fake = { procs: [] as FakeKiroProcess[], handlers: [] as Handler[], tokensSeen: [] as string[], refuse: null as null | 4403 | 4404 };
  const backend = {
    workspace: () => '/work/reattach',
    spawn: (ctx: { userId: string | null; threadId: string; reattachToken?: string | null }) => {
      if (ctx.reattachToken) fake.tokensSeen.push(ctx.reattachToken);
      const p = new FakeKiroProcess(ctx.userId ?? '', ctx.threadId, ctx.reattachToken ? createHash('sha256').update(ctx.reattachToken).digest('hex') : null, fake.handlers);
      fake.procs.push(p);
      return p.child(false);
    },
    reattach: async (ctx: { userId: string | null; threadId: string }, token: string) => {
      const p = fake.procs.find((x) => !x.ended && x.userId === ctx.userId && x.threadId === ctx.threadId);
      if (fake.refuse === 4404 || !p) throw new KiroReattachRefusedError(4404, 'kiro_session_not_found');
      if (fake.refuse === 4403 || createHash('sha256').update(token).digest('hex') !== p.tokenHash) throw new KiroReattachRefusedError(4403, 'kiro_reattach_refused');
      return p.child(true);
    },
  };

  let admin = '';
  const run = (id: string) => platform.rows('kiro_runs').find((r) => r.id === id)!;
  const runEvents = (id: string) => platform.rows('kiro_run_events').filter((e) => e.run_id === id).sort((a, b) => a.seq - b.seq);
  const isDone = (id: string) => ['completed', 'refused', 'incomplete', 'failed', 'cancelled', 'interrupted'].includes(run(id)?.status);
  async function startRun(message: string) {
    return request(app).post('/api/v1/operator/kiro/runs').set('Authorization', `Bearer ${admin}`).send({ thread_id: THREAD, message });
  }
  /** A running run whose session is reattachable and whose first text is stored. */
  async function runningRun(gate: Promise<void>, ask = false): Promise<string> {
    fake.handlers.push(async (k) => {
      k.chunk('before the deploy. ');
      await gate;
      if (ask) { const r = await k.ask('Edit services/gateway/src/a.ts'); k.chunk(r.outcome.outcome === 'selected' ? 'edited. ' : 'not edited. '); }
      k.tool('t1', 'Read a file');
      k.chunk('after the deploy.');
      k.toolDone('t1');
      return 'end_turn';
    });
    const res = await startRun('finish the upload endpoint');
    expect(res.status).toBe(202);
    const id = res.body.run_id as string;
    await waitFor(() => !!run(id).reattach_nonce && runEvents(id).some((e) => e.type === 'kiro.message_chunk'), 'reattach identity and first text stored');
    return id;
  }
  /** The deploy: this task drains (lets the session go); the current process then plays the NEW task. */
  async function deployDrain(id: string) {
    const r = await drainKiroRunsForShutdown(3_000);
    expect(r).toEqual({ interrupted: 0, detached: 1, timedOut: false });
    run(id).gateway_task = 'old-task-before-deploy';
  }

  beforeAll(() => { Object.assign(KIRO_RUN_LIMITS, { coalesceMs: 20, flushMs: 20, streamPollMs: 20 }); });
  afterAll(() => { Object.assign(KIRO_RUN_LIMITS, savedLimits); });
  beforeEach(async () => {
    fake.procs.length = 0; fake.handlers.length = 0; fake.tokensSeen.length = 0; fake.refuse = null;
    Object.assign(process.env, { OPERATOR_THREADS_ENABLED: 'true', KIRO_ENGINE_ENABLED: 'true', GATEWAY_INTERNAL_TOKEN: 'pipeline-internal-token' });
    setKiroBackend(backend as any);
    app.use('/api/v1/operator/kiro/runs', kiroRunsRouter);
    admin = await jwt(ADMIN_USER, true);
  });
  afterEach(async () => {
    closeAllKiroSessions();
    await platform.settle().catch(() => undefined);
    resetKiroRunsForTests();
    setKiroBackend(null);
    delete process.env.OPERATOR_THREADS_ENABLED;
    delete process.env.KIRO_ENGINE_ENABLED;
    delete process.env.GATEWAY_INTERNAL_TOKEN;
  });

  it('a deploy mid-run: the old task lets the session go, the new task reattaches it, and the run completes with contiguous seq, one reply and no interrupted event', async () => {
    const gate = deferred();
    const id = await runningRun(gate.promise);
    // The row holds the nonce and the token hash — never the token the runner got.
    const token = fake.tokensSeen[0];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(run(id).reattach_token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(run(id))).not.toContain(token);
    expect(run(id).turn_context).toMatchObject({ mode: expect.any(String) });

    await deployDrain(id);
    const proc = fake.procs[0];
    expect(proc).toMatchObject({ ended: false, dropped: 1 }); // the runner kept kiro-cli alive
    expect(run(id).status).toBe('running');
    expect(Date.parse(run(id).reattach_expires_at)).toBeGreaterThan(Date.now() + 9 * 60_000);
    const seqBefore = runEvents(id).map((e) => e.seq);

    // Kiro keeps working while no gateway task listens: its output is buffered by the runner.
    gate.resolve();
    await waitFor(() => proc.buffer.length >= 4, 'output buffered while detached');

    // The new task's boot sweep: reattach first.
    expect(await sweepStaleKiroRuns()).toBe(0);
    await waitFor(() => isDone(id), 'reattached run finished');
    await platform.settle();
    expect(run(id)).toMatchObject({ status: 'completed', reply: 'before the deploy. after the deploy.', stop_reason: 'end_turn', gateway_task: GATEWAY_TASK_ID });
    const seqs = runEvents(id).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(seqs.slice(0, seqBefore.length)).toEqual(seqBefore);
    const types = runEvents(id).map((e) => e.type);
    expect(types[seqBefore.length]).toBe('run.reattached');
    expect(types).toEqual(expect.arrayContaining(['kiro.tool_call', 'kiro.tool_update', 'kiro.turn_end']));
    expect(runEvents(id).filter((e) => e.type === 'kiro.message_chunk').map((e) => e.payload.text).join('')).toBe('before the deploy. after the deploy.');
    expect(runEvents(id).filter((e) => e.type === 'run.status').map((e) => e.payload.status)).toEqual(['running', 'completed']);
    expect(platform.events('operator.kiro.run_reattached').filter((e) => e.metadata?.run_id === id)).toHaveLength(1);
    expect(platform.events('operator.kiro.run_interrupted')).toHaveLength(0);
    // The turn is recorded once, by the task that finished it.
    const assistant = platform.rows('operator_messages').filter((m) => m.thread_id === THREAD && m.role === 'assistant');
    expect(assistant.map((m) => m.content)).toEqual(['before the deploy. after the deploy.']);
    // The same kiro-cli process answered the turn: no second spawn.
    expect(fake.procs).toHaveLength(1);
  });

  it('an approval card open at the deploy is shown again by the reattached session and answered there', async () => {
    const gate = deferred();
    const id = await runningRun(gate.promise, true);
    gate.resolve();
    await waitFor(() => run(id).status === 'waiting_permission', 'card open on the old task');
    await deployDrain(id);
    expect(await sweepStaleKiroRuns()).toBe(0);
    await waitFor(() => run(id).status === 'waiting_permission' && run(id).gateway_task === GATEWAY_TASK_ID && !!run(id).pending_permission, 'card again on the new task');
    const reqId = run(id).pending_permission.request_id as string;
    const ans = await request(app).post(`/api/v1/operator/kiro/permissions/${reqId}`).set('Authorization', `Bearer ${admin}`).send({ allow: true });
    expect(ans.status).toBe(200);
    await waitFor(() => isDone(id), 'finished');
    await platform.settle();
    expect(run(id)).toMatchObject({ status: 'completed', reply: 'before the deploy. edited. after the deploy.' });
  });

  it('the runner refuses the reattach (session gone, or token rejected): the run is interrupted exactly as in Phase 1', async () => {
    for (const code of [4404, 4403] as const) {
      const gate = deferred();
      const id = await runningRun(gate.promise);
      await deployDrain(id);
      fake.refuse = code;
      expect(await sweepStaleKiroRuns()).toBe(1);
      expect(run(id)).toMatchObject({ status: 'interrupted', error: 'gateway_task_lost', pending_permission: null, gateway_task: GATEWAY_TASK_ID });
      expect(run(id).ended_at).toBeTruthy();
      expect(platform.events('operator.kiro.run_interrupted').filter((e) => e.metadata?.run_id === id)).toHaveLength(1);
      expect(platform.events('operator.kiro.run_reattached').filter((e) => e.metadata?.run_id === id)).toHaveLength(0);
      // A second sweep changes nothing.
      expect(await sweepStaleKiroRuns()).toBe(0);
      fake.refuse = null;
      for (const p of fake.procs) p.end('test');
      gate.resolve();
      closeAllKiroSessions();
      await platform.settle();
      resetKiroRunsForTests();
    }
  });

  it('a crashed task (no drain): once its heartbeat is stale the run is reattached inside the window; past the window it is interrupted as before', async () => {
    const gate = deferred();
    const id = await runningRun(gate.promise);
    // The task dies: its socket drops, nothing is written.
    expect(detachKiroSession(THREAD)).toBe(true);
    resetKiroRunsForTests();
    Object.assign(run(id), { gateway_task: 'crashed-task', last_heartbeat_at: new Date(Date.now() - 60_000).toISOString() });
    // Heartbeat not stale yet: nothing happens.
    expect(await sweepStaleKiroRuns()).toBe(0);
    expect(run(id).status).toBe('running');
    run(id).last_heartbeat_at = new Date(Date.now() - 3 * 60_000).toISOString();
    gate.resolve();
    expect(await sweepStaleKiroRuns()).toBe(0);
    await waitFor(() => isDone(id), 'reattached after a crash');
    await platform.settle();
    expect(run(id)).toMatchObject({ status: 'completed', reply: 'before the deploy. after the deploy.' });

    // Past the window (heartbeat 11 min old, no hand-over mark): the Phase 1 sweep, no reattach.
    const gate2 = deferred();
    const id2 = await runningRun(gate2.promise);
    expect(detachKiroSession(THREAD)).toBe(true);
    resetKiroRunsForTests();
    Object.assign(run(id2), { gateway_task: 'crashed-task', last_heartbeat_at: new Date(Date.now() - 11 * 60_000).toISOString() });
    expect(await sweepStaleKiroRuns()).toBe(1);
    expect(run(id2)).toMatchObject({ status: 'interrupted', error: 'gateway_task_lost', gateway_task: 'crashed-task' });
    expect(platform.events('operator.kiro.run_reattached').filter((e) => e.metadata?.run_id === id2)).toHaveLength(0);
    gate2.resolve();
  });
});
