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
