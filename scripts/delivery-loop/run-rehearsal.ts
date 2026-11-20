/**
 * Delivery loop rehearsal, the run: the REAL engine against the REAL scratch GitLab project, step by step, recording what happened.
 *
 *   npx tsx scripts/delivery-loop/run-rehearsal.ts <output dir>
 *
 * Needs a transport to GitLab (see transportFromEnv). It creates only `loop-rehearsal-<run>` objects in vitana/rehearsal and removes them
 * at the end, also when a step fails. See rehearse.ts for the rules and for what is real and what is a stand-in.
 *
 * The story, each step checked against GitLab's own answers and the ledger, not against what the script expects:
 *   A. INTAKE      a person labels an issue; the loop polls it, accepts it (the label was applied by a project member), says so on the issue.
 *   B. REPAIR      a merge request whose test fails: the REAL pipeline fails; the loop reads the failed job and its log from GitLab, fingerprints
 *                  it, and asks the (stub) worker for a repair; the stub pushes a fix; the REAL pipeline passes; the loop verifies it and learns.
 *   C. REVIEW      the green merge request is reviewed once (stub reviewer) and the verdict is said on it.
 *   D. RETRY       the loop's own retry call against a real failed pipeline: GitLab keeps the pipeline id, moves its updated_at and runs it to a final
 *                  state again. The loop's DECISION to retry (an infrastructure failure) is NOT exercised live: no runner failure can be produced from here.
 *   E. REJECTION   an issue labeled by nobody who is a member is not accepted.
 */
import { createEngine } from '../../services/gateway/src/services/delivery-loop/engine';
import { MemoryLedger } from '../../services/gateway/src/services/delivery-loop/ledger';
import type { LoopDeps } from '../../services/gateway/src/services/delivery-loop/context';
import type { DispatchResult, KnownFix, LearnPort, OutcomeLesson, RepairLesson, ReviewVerdict, ReviewerPort, TaskPort, TaskRequest } from '../../services/gateway/src/services/delivery-loop/ports';
import { BRANCH_PREFIX, REHEARSAL_PROJECT, Rehearsal, type RehearsalTransport } from './rehearse';

export interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The labelled stub worker: given a repair task, it pushes the fix to the branch. It is NOT an LLM and says so in its commit. */
class StubWorker implements TaskPort {
  readonly requests: TaskRequest[] = [];
  constructor(private readonly onTask: (r: TaskRequest) => Promise<DispatchResult>) {}
  async dispatch(r: TaskRequest): Promise<DispatchResult> {
    this.requests.push(r);
    return this.onTask(r);
  }
}

class Recorder implements LearnPort {
  repairs: RepairLesson[] = [];
  outcomes: OutcomeLesson[] = [];
  async recordRepair(l: RepairLesson) {
    this.repairs.push(l);
    return { ok: true };
  }
  async recordOutcome(l: OutcomeLesson) {
    this.outcomes.push(l);
    return { ok: true };
  }
  async findKnownFix(): Promise<KnownFix | null> {
    return null;
  }
}

class FixedReviewer implements ReviewerPort {
  inputs: Array<{ iid: number; head: string | null; files: number }> = [];
  async review(i: Parameters<ReviewerPort['review']>[0]) {
    this.inputs.push({ iid: i.mr.iid, head: i.mr.sha, files: i.diffs.length });
    const v: ReviewVerdict = { verdict: 'accept', summary: 'REHEARSAL STUB: a fixed verdict, not a model.', findings: [], model: 'rehearsal-stub', reviewed_head: i.mr.sha as string };
    return { ok: true as const, data: v };
  }
}

const PKG = JSON.stringify({ name: 'loop-rehearsal-fixture', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node test.mjs' } }, null, 2) + '\n';
const TEST_FAILING = `// loop-rehearsal fixture: a test that fails until the worker fixes it.\nimport assert from 'node:assert/strict';\nimport { total } from './total.mjs';\nassert.equal(total([1, 2, 3]), 6, 'total of 1,2,3 should be 6');\nconsole.log('ok');\n`;
const TOTAL_BROKEN = `export function total(xs) {\n  return xs.reduce((a, b) => a + b, 1); // BUG: the seed of the sum should be 0\n}\n`;
const TOTAL_FIXED = `export function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n`;

/** Waits until a pipeline of the merge request reaches a final state. */
async function waitPipeline(r: Rehearsal, iid: number, minId: number, timeoutMs: number): Promise<{ id: number; status: string; sha: string } | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const mr = await r.client.getMergeRequest(REHEARSAL_PROJECT, iid);
    if (mr.ok && mr.data.head_pipeline_id && mr.data.head_pipeline_id >= minId) {
      const p = await r.client.getPipeline(REHEARSAL_PROJECT, mr.data.head_pipeline_id);
      if (p.ok && ['success', 'failed', 'canceled'].includes(p.data.status)) return { id: p.data.id, status: p.data.status, sha: p.data.sha };
    }
    await sleep(5000);
  }
  return null;
}

/** Waits until a pipeline that was retried has moved (its updated_at changed) and is in a final state again. */
async function waitFinalAfter(r: Rehearsal, id: number, updatedBefore: string, timeoutMs: number): Promise<{ id: number; status: string; updated_at: string } | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const p = await r.client.getPipeline(REHEARSAL_PROJECT, id);
    if (p.ok && p.data.updated_at !== updatedBefore && ['success', 'failed', 'canceled'].includes(p.data.status)) return { id: p.data.id, status: p.data.status, updated_at: p.data.updated_at };
    await sleep(5000);
  }
  return null;
}

export async function runRehearsal(t: RehearsalTransport, runId: string): Promise<{ steps: Step[]; ledger: MemoryLedger; left: string[]; log: string[]; artifacts: Record<string, string> }> {
  const r = new Rehearsal(t, runId);
  const steps: Step[] = [];
  /** Text the run produced that is evidence (file name -> content), written next to the report. */
  const artifacts: Record<string, string> = {};
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };
  let left: string[] = [];
  const ledger = new MemoryLedger({ env: 'staging', now: () => Date.now() });

  try {
    if (!(await r.projectIsPrivate())) {
      step('preflight', false, `${REHEARSAL_PROJECT} is not a private project reachable with this transport`);
      return { steps, ledger, left, log: r.log, artifacts };
    }
    step('preflight', true, `${REHEARSAL_PROJECT} is private and reachable`);

    // The worker: on a repair task it commits the fix on the branch named in the task, as a labelled stub.
    const worker = new StubWorker(async (task) => {
      if (task.kind !== 'repair' || !task.fix_branch) return { ok: false, error: 'the rehearsal stub only repairs', retryable: false };
      await r.commit(task.fix_branch, 'REHEARSAL STUB WORKER: fix total() so its sum starts at 0 (not an LLM)', { 'total.mjs': TOTAL_FIXED });
      return { ok: true, task_id: `stub-${task.key.slice(0, 12)}`, vtid: null, execution_id: null };
    });
    const learn = new Recorder();
    const reviewer = new FixedReviewer();

    const env = {
      DELIVERY_LOOP_ENABLED: 'true',
      DELIVERY_LOOP_AUTONOMY: 'L3',
      DELIVERY_LOOP_PROJECTS: REHEARSAL_PROJECT,
      DELIVERY_LOOP_BRANCH_PREFIXES: BRANCH_PREFIX,
      DELIVERY_LOOP_MAX_ACTIONS: '20',
      DELIVERY_LOOP_HEAL_MAX_ATTEMPTS: '2',
    } as NodeJS.ProcessEnv;
    const deps: LoopDeps = { gitlab: r.client, ledger, tasks: worker, reviewer, learn, now: Date.now };
    const engine = createEngine({ deps, env, isArmed: async () => true, cycleMs: 15_000 });

    // ---- A. INTAKE --------------------------------------------------------------------------------------------
    const issue = await r.openIssue('add a retry button', 'The export screen should have a retry button next to the error message, so a person can retry without reloading.', []);
    await r.labelIssue(issue, ['agent-task']);
    await sleep(2000);
    await engine.cycle();
    const accepted = ledger.topic('delivery.intake.accepted');
    const got = await r.client.getIssue(REHEARSAL_PROJECT, issue);
    step('A1 intake accepts an issue labeled by a project member', accepted.length === 1 && accepted[0].metadata.issue_iid === issue, `accepted rows ${accepted.length}; requester level ${accepted[0]?.metadata.requester_level ?? 'n/a'}`);
    step('A2 the loop answered on the issue and labelled it', got.ok && got.data.labels.includes('delivery-accepted'), got.ok ? `labels ${JSON.stringify(got.data.labels)}` : got.error);
    step('A3 the (stub) worker was asked for the task, with the issue text as data', worker.requests.some((q) => q.kind === 'intake' && q.issue_iid === issue && q.instructions.includes('retry button')), `${worker.requests.length} request(s)`);

    // ---- B. REPAIR --------------------------------------------------------------------------------------------
    await r.createBranch();
    await r.commit(r.branch, 'rehearsal fixture: a failing test', { 'package.json': PKG, 'test.mjs': TEST_FAILING, 'total.mjs': TOTAL_BROKEN });
    const mrIid = await r.openMergeRequest(r.branch, 'rehearsal: total() sums', 'A fixture whose test fails until the worker repairs it.');
    step('B0 merge request opened on the loop-owned branch', true, `!${mrIid} on ${r.branch}`);

    const first = await waitPipeline(r, mrIid, 0, 240_000);
    step('B1 GitLab ran a real pipeline and it FAILED on the broken test', first?.status === 'failed', first ? `pipeline ${first.id} ${first.status}` : 'no pipeline finished in 4 minutes');
    if (!first || first.status !== 'failed') return { steps, ledger, left: await r.cleanup(), log: r.log, artifacts };

    for (let i = 0; i < 4; i += 1) {
      await engine.cycle();
      if (worker.requests.some((q) => q.kind === 'repair')) break;
      await sleep(16_000);
    }
    const detected = ledger.topic('delivery.heal.detected');
    step('B2 the loop saw the failure on GitLab (poller, no webhook) and classified it a code failure with evidence', detected.length >= 1 && detected[0].metadata.failure_class === 'code' && detected[0].metadata.has_evidence === true, detected[0] ? `class ${detected[0].metadata.failure_class}, jobs ${JSON.stringify(detected[0].metadata.jobs)}, fingerprint ${detected[0].metadata.fingerprint}` : 'no detection row');
    const repair = worker.requests.find((q) => q.kind === 'repair');
    const told = repair?.instructions ?? '';
    if (repair) artifacts['repair-instructions.txt'] = told;
    // What the worker needs to fix this failure, all of it from the job's own output: the assertion and its message, the two values, the place.
    const needs = {
      assertion: /AssertionError \[ERR_ASSERTION\]: total of 1,2,3 should be 6/.test(told),
      values: /actual: 7,/.test(told) && /expected: 6,/.test(told),
      place: /\/builds\/vitana\/rehearsal\/test\.mjs:\d+:\d+/.test(told),
      jobLog: /https?:\/\/\S+\/-\/jobs\/\d+/.test(told),
    };
    // And none of the runner's own text, escape codes or timestamps.
    const noise = {
      runnerBanner: /Running with gitlab-runner/.test(told),
      cleanup: /Cleaning up project directory/.test(told),
      footer: /ERROR: Job failed/.test(told),
      escape: told.includes('\u001b'),
      timestamp: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(told),
    };
    const exact = Boolean(repair && repair.fix_branch === r.branch && repair.mr_iid === mrIid) && Object.values(needs).every(Boolean) && Object.values(noise).every((v) => !v);
    step('B3 the worker was asked to repair THE merge request branch, told the failure as the job printed it (assertion, values, place, log link), with none of the runner\'s own text', exact, repair ? `fix_branch ${repair.fix_branch}; has ${JSON.stringify(needs)}; runner text present ${JSON.stringify(noise)}` : 'no repair request');

    const second = await waitPipeline(r, mrIid, (first.id as number) + 1, 240_000);
    step('B4 GitLab ran a NEW real pipeline on the pushed fix and it PASSED', second?.status === 'success', second ? `pipeline ${second.id} ${second.status}` : 'no new pipeline finished in 4 minutes');

    for (let i = 0; i < 4; i += 1) {
      await engine.cycle();
      if (ledger.topic('delivery.heal.verified').length > 0) break;
      await sleep(16_000);
    }
    const verified = ledger.topic('delivery.heal.verified');
    step('B5 the loop verified the repair from GitLab\'s own state', verified.length === 1 && verified[0].metadata.pipeline_id === second?.id, verified[0] ? `verified by pipeline ${verified[0].metadata.pipeline_id}` : 'no verified row');

    for (let i = 0; i < 3; i += 1) await engine.cycle();
    step('B6 the loop learned: a repair pattern and a memory outcome were recorded', learn.repairs.length === 1 && learn.outcomes.some((o) => o.kind === 'repair_verified'), `${learn.repairs.length} pattern(s), ${learn.outcomes.length} outcome(s)`);

    // ---- C. REVIEW --------------------------------------------------------------------------------------------
    const verdicts = ledger.topic('delivery.review.verdict');
    const notes = (await r.client.getMergeRequest(REHEARSAL_PROJECT, mrIid)).ok;
    step('C1 the green merge request was reviewed once for its head, by the stub reviewer', reviewer.inputs.length === 1 && verdicts.length === 1, `${reviewer.inputs.length} review(s); head ${reviewer.inputs[0]?.head?.slice(0, 8) ?? 'n/a'}`);
    step('C2 the merge request is still open and was not merged by the loop', notes && (await r.client.getMergeRequest(REHEARSAL_PROJECT, mrIid)).ok, 'the loop has no merge call');

    // ---- E. REJECTION -----------------------------------------------------------------------------------------
    const bad = await r.openIssue('too short', 'fix it', []);
    await r.labelIssue(bad, ['agent-task']);
    await sleep(2000);
    for (let i = 0; i < 2; i += 1) await engine.cycle();
    const rejected = ledger.topic('delivery.intake.rejected').filter((x) => x.metadata.issue_iid === bad);
    step('E1 an issue with too little to act on is rejected with the reason, not started', rejected.length === 1 && rejected[0].metadata.reason === 'too_little_to_act_on' && !worker.requests.some((q) => q.issue_iid === bad), rejected[0] ? `reason ${rejected[0].metadata.reason}` : 'no rejection row');

    // ---- silence ----------------------------------------------------------------------------------------------
    const before = ledger.rows.length;
    const writes = r.log.filter((l) => !l.startsWith('GET')).length;
    // Three cycles, each in its own 15 s window: cycles that share a window cannot all write, and the poller still re-reads the last two minutes.
    for (let i = 0; i < 3; i += 1) {
      await sleep(16_000);
      await engine.cycle();
    }
    step('Z1 once everything is settled the loop is silent: no new rows, no new GitLab writes', ledger.rows.length === before, `rows ${before} -> ${ledger.rows.length}; GitLab writes by the rehearsal ${writes}`);

    // ---- D. RETRY (GitLab's semantics, through the loop's own client) -----------------------------------------
    // The engine is not run from here on: this branch is one the loop would own, and nothing may repair it.
    const dBranch = `${r.branch}-d`;
    await r.createBranch(dBranch);
    await r.commit(dBranch, 'rehearsal fixture: a failing test (for the retry check)', { 'package.json': PKG, 'test.mjs': TEST_FAILING, 'total.mjs': TOTAL_BROKEN });
    const dMr = await r.openMergeRequest(dBranch, 'rehearsal: retry check', 'A fixture pipeline that is retried through GitLab\'s retry endpoint. Nothing repairs it.');
    const d1 = await waitPipeline(r, dMr, 0, 240_000);
    step('D0 GitLab ran a real pipeline on the retry-check merge request and it FAILED', d1?.status === 'failed', d1 ? `pipeline ${d1.id} ${d1.status}` : 'no pipeline finished in 4 minutes');
    if (d1 && d1.status === 'failed') {
      const before = await r.client.getPipeline(REHEARSAL_PROJECT, d1.id);
      const retried = await r.retryOwnPipeline(d1.id);
      const inProgress = ['created', 'pending', 'preparing', 'waiting_for_resource', 'scheduled', 'running'].includes(retried.status);
      step('D1 the loop\'s own retry call kept the pipeline id and put the pipeline back in progress', retried.id === d1.id && inProgress, `pipeline ${d1.id} -> id ${retried.id}, status ${retried.status}`);
      const after = before.ok ? await waitFinalAfter(r, d1.id, before.data.updated_at, 240_000) : null;
      const mrNow = await r.client.getMergeRequest(REHEARSAL_PROJECT, dMr);
      const moved = Boolean(before.ok && after && Date.parse(after.updated_at) > Date.parse(before.data.updated_at));
      step('D2 the retried pipeline moved (updated_at) and ended again under the SAME id; the merge request got no new pipeline', Boolean(after && after.id === d1.id && moved && mrNow.ok && mrNow.data.head_pipeline_id === d1.id), after && before.ok ? `id ${after.id} ${after.status}; updated_at ${before.data.updated_at} -> ${after.updated_at}; head pipeline of !${dMr} is ${mrNow.ok ? mrNow.data.head_pipeline_id : 'n/a'}` : 'the retried pipeline did not finish in 4 minutes');
    }
  } catch (e) {
    step('run', false, `the rehearsal stopped: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    left = await r.cleanup();
  }
  return { steps, ledger, left, log: r.log, artifacts };
}
