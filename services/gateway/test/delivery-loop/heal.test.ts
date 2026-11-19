/**
 * Delivery loop, heal: a failed pipeline is classified and answered with a retry or a repair, a bounded number of times, and a green
 * pipeline verifies it. The loop acts only on the branches it owns, and every step is idempotent.
 */
import { decideHeal, branchKey } from '../../src/services/delivery-loop/heal';
import { PROJECT, topics, world, type World } from './harness';

const BRANCH = 'dev-autopilot/ab12cd34';
const REF = `refs/merge-requests/12/head`;

/** A failed MR pipeline of an owned branch, with its fact. */
function failedMr(w: World, id = 31, over: Parameters<World['gitlab']['addPipeline']>[0] extends infer O ? Partial<O> : never = {}) {
  if (!w.gitlab.mrs.has(12)) w.gitlab.addMr({ iid: 12, source_branch: BRANCH });
  const p = w.gitlab.addPipeline({ id, status: 'failed', ref: REF, ...over } as never);
  w.pipelineFact('failed', p, { merge_request_iid: 12, mr_source_branch: BRANCH, mr_url: 'https://gitlab.test/mr/12' });
  return p;
}

describe('decideHeal (pure)', () => {
  const d = (over: Partial<Parameters<typeof decideHeal>[0]> = {}) => decideHeal({ failureClass: 'code', hasEvidence: true, executed: 0, max: 3, ...over });

  it('a code failure with evidence is repaired, an infra failure is retried', () => {
    expect(d()).toEqual({ kind: 'repair' });
    expect(d({ failureClass: 'infra', hasEvidence: false })).toEqual({ kind: 'retry' });
  });

  it('a code failure with no evidence, and an unclassified one, end the loop without a try', () => {
    expect(d({ hasEvidence: false })).toEqual({ kind: 'exhausted', reason: 'no_evidence' });
    expect(d({ failureClass: 'unknown' })).toEqual({ kind: 'exhausted', reason: 'unclassified_failure' });
  });

  it('the budget ends it first, whatever the class', () => {
    for (const failureClass of ['code', 'infra', 'unknown'] as const) expect(d({ failureClass, executed: 3 })).toEqual({ kind: 'exhausted', reason: 'budget_spent' });
    expect(d({ executed: 2 })).toEqual({ kind: 'repair' });
    expect(d({ executed: 0, max: 1 })).toEqual({ kind: 'repair' });
    expect(d({ executed: 1, max: 1 })).toEqual({ kind: 'exhausted', reason: 'budget_spent' });
  });
});

describe('a failed pipeline of a branch the loop owns', () => {
  it('is detected, fingerprinted from its log, becomes a repair intent, is announced on the merge request, and the executor is asked', async () => {
    const w = world();
    failedMr(w);
    const r = await w.tick();

    expect(r.ran).toBe(true);
    const detected = topics(w, 'delivery.heal.detected');
    expect(detected).toHaveLength(1);
    expect(detected[0].metadata).toMatchObject({ project: PROJECT, branch: BRANCH, ref: REF, pipeline_id: 31, mr_iid: 12, failure_class: 'code', has_evidence: true, jobs: ['unit:script_failure'] });
    expect(detected[0].metadata.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    const intent = topics(w, 'delivery.dispatch.requested');
    expect(intent).toHaveLength(1);
    expect(intent[0].metadata).toMatchObject({ action: 'run_task', kind: 'repair', branch: BRANCH, fix_branch: BRANCH, mr_iid: 12, base_branch: 'main', attempt: 1 });

    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
    const t = w.tasks.requests[0];
    expect(t).toMatchObject({ kind: 'repair', project: PROJECT, fix_branch: BRANCH, mr_iid: 12, base_branch: 'main' });
    expect(t.instructions).toContain('Expected values to be strictly equal');
    expect(t.instructions).toContain('Never skip, disable or loosen a test');
    expect(w.gitlab.notes.some((n) => n.target === 'mr' && n.iid === 12 && n.body.includes('prepares a repair'))).toBe(true);
  });

  it('never writes the text of a log to OASIS', async () => {
    const w = world();
    failedMr(w, 31, { log: '2026-11-19T10:00:01.000000Z 01O Error: SECRET-LOG-MARKER leaked a token\n' });
    await w.tick();
    expect(w.tasks.requests[0].instructions).toContain('SECRET-LOG-MARKER');
    expect(JSON.stringify(w.ledger.rows)).not.toContain('SECRET-LOG-MARKER');
  });

  it('is handled once: the fact twice and several cycles give one detection, one intent, one attempt', async () => {
    const w = world();
    const p = failedMr(w);
    w.pipelineFact('failed', p, { merge_request_iid: 12, mr_source_branch: BRANCH }); // the same key: a duplicate row
    for (let i = 0; i < 4; i += 1) await w.tick();
    expect(topics(w, 'delivery.heal.detected')).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(1);
    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('an infra failure is a pipeline retry, not a repair', async () => {
    const w = world();
    failedMr(w, 31, { jobs: [{ id: 310, name: 'unit', status: 'failed', failure_reason: 'runner_system_failure' }] });
    await w.tick();
    expect(w.tasks.requests).toHaveLength(0);
    expect(w.gitlab.retried).toEqual([31]);
    expect(topics(w, 'delivery.dispatch.requested')[0].metadata).toMatchObject({ action: 'retry_pipeline', kind: 'retry' });
    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(1);
    expect(w.gitlab.notes.some((n) => n.body.includes("GitLab's side"))).toBe(true);
  });

  it('a code failure whose log has nothing to repair from, and a failure GitLab does not explain, are not tried: a person is asked', async () => {
    for (const [jobs, reason] of [
      [[{ id: 310, name: 'unit', status: 'failed', failure_reason: 'script_failure' }], 'no_evidence'],
      [[{ id: 310, name: 'unit', status: 'failed', failure_reason: 'unknown_failure' }], 'unclassified_failure'],
    ] as const) {
      const w = world();
      failedMr(w, 31, { jobs: [...jobs], log: 'all good\n' });
      await w.tick();
      expect(topics(w, 'delivery.heal.exhausted')).toHaveLength(1);
      expect(topics(w, 'delivery.heal.exhausted')[0].metadata.reason).toBe(reason);
      expect(w.tasks.requests).toHaveLength(0);
      expect(w.gitlab.retried).toEqual([]);
      expect(w.gitlab.notes.some((n) => n.target === 'mr' && n.body.includes('A person needs to look'))).toBe(true);
    }
  });

  it('is not repaired blind when GitLab is down: the failure is handled again later, never mistaken for "no evidence"', async () => {
    const w = world();
    failedMr(w);
    w.gitlab.failOnce.add('getJobTrace');
    const first = await w.tick();
    expect(topics(w, 'delivery.heal.exhausted')).toHaveLength(0);
    expect(first.stats.errors).toBeGreaterThan(0);
    await w.tick();
    expect(topics(w, 'delivery.heal.exhausted')).toHaveLength(0);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('a log that GitLab no longer has (404) is no evidence, which is final', async () => {
    const w = world();
    failedMr(w, 31, { jobs: [{ id: 310, name: 'unit', status: 'failed', failure_reason: 'script_failure' }] });
    delete w.gitlab.pipelines.get(31)!.traces[310];
    await w.tick();
    expect(topics(w, 'delivery.heal.exhausted')[0].metadata.reason).toBe('no_evidence');
  });

  it('a known fix of the same failure is passed to the executor as a hint', async () => {
    const w = world();
    const p = failedMr(w);
    await w.tick(); // first repair: learn nothing yet
    // The same failure is recorded as repaired earlier: a second pipeline fails the same way on another branch.
    w.learn.known.clear();
    const detected = topics(w, 'delivery.heal.detected')[0].metadata.fingerprint as string;
    w.learn.known.set(detected, { fingerprint: detected, summary: 'fixed by clamping the total at zero', success_count: 2 });
    w.gitlab.addMr({ iid: 13, source_branch: 'dev-autopilot/zz99' });
    const p2 = w.gitlab.addPipeline({ id: 41, status: 'failed', ref: 'refs/merge-requests/13/head', jobs: [{ id: 410, name: 'unit', status: 'failed', failure_reason: 'script_failure' }], log: w.gitlab.pipelines.get(31)!.traces[310] });
    w.pipelineFact('failed', p2, { merge_request_iid: 13, mr_source_branch: 'dev-autopilot/zz99' });
    await w.tick();
    const second = w.tasks.requests[1];
    expect(second.hints.join(' ')).toContain('clamping the total at zero');
    expect(p.id).toBe(31);
  });
});

describe('what the loop leaves alone', () => {
  it.each([
    ['a lane branch of a Kiro session', 'kiro/some-plan/lane'],
    ['a feature branch of a person', 'feature/export-button'],
    ['main, which the fix-forward drivers own', 'main'],
  ])('%s', async (_name, branch) => {
    const w = world();
    const p = w.gitlab.addPipeline({ id: 31, status: 'failed', ref: branch });
    w.pipelineFact('failed', p, { mr_source_branch: null });
    const r = await w.tick();
    expect(r.stats.skipped.branch_not_owned).toBe(1);
    expect(topics(w, 'delivery.heal.detected')).toHaveLength(0);
    expect(w.tasks.requests).toHaveLength(0);
    expect(w.gitlab.writes()).toBe(0);
  });

  it('main is repaired when the owner asks for it, on a branch of its own, never by pushing to main', async () => {
    const w = world({ DELIVERY_LOOP_HEAL_MAIN: 'true' });
    const p = w.gitlab.addPipeline({ id: 31, status: 'failed', ref: 'main' });
    w.pipelineFact('failed', p, { mr_source_branch: null });
    await w.tick();
    expect(w.tasks.requests).toHaveLength(1);
    expect(w.tasks.requests[0].fix_branch).toBeNull();
    expect(w.tasks.requests[0].base_branch).toBe('main');
  });

  it('a tag pipeline, and a project that is not listed, are skipped', async () => {
    const w = world();
    failedMr(w);
    const fact = w.ledger.topic('scm.gitlab.pipeline.failed')[0];
    fact.metadata.tag = true;
    const r = await w.tick();
    expect(r.stats.skipped.tag_pipeline).toBe(1);
    const other = world({ DELIVERY_LOOP_PROJECTS: 'vitana/other' });
    failedMr(other);
    expect((await other.tick()).stats.skipped.project_not_allowed).toBe(1);
  });

  it('a merge request that is closed, and a failure that a newer pipeline has replaced, are history', async () => {
    const closed = world();
    failedMr(closed);
    closed.gitlab.mrs.get(12)!.state = 'closed';
    expect((await closed.tick()).stats.skipped.mr_not_open).toBe(1);
    expect(closed.tasks.requests).toHaveLength(0);

    const moved = world();
    failedMr(moved);
    moved.gitlab.addPipeline({ id: 32, status: 'running', ref: REF });
    expect((await moved.tick()).stats.skipped.superseded).toBe(1);
    expect(moved.tasks.requests).toHaveLength(0);
  });
});

describe('the attempts and their end', () => {
  it('a repair that goes green is verified, and the merge request is told', async () => {
    const w = world();
    failedMr(w);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(1);

    // the executor pushed a fix: a new pipeline ran and passed
    w.clock.advance(5 * 60 * 1000);
    const green = w.gitlab.addPipeline({ id: 32, status: 'success', ref: REF, sha: 'f'.repeat(40) });
    w.pipelineFact('succeeded', green, { merge_request_iid: 12, mr_source_branch: BRANCH });
    await w.tick();

    const verified = topics(w, 'delivery.heal.verified');
    expect(verified).toHaveLength(1);
    expect(verified[0].metadata).toMatchObject({ project: PROJECT, branch: BRANCH, pipeline_id: 32, attempts: 1, mr_iid: 12, changed: true, action: 'run_task' });
    expect(w.gitlab.notes.some((n) => n.body.includes('is green again'))).toBe(true);
    await w.tick();
    expect(topics(w, 'delivery.heal.verified')).toHaveLength(1);
  });

  it('a retried pipeline that goes green is verified without any new fact: the reconciler reads GitLab', async () => {
    const w = world();
    failedMr(w, 31, { jobs: [{ id: 310, name: 'unit', status: 'failed', failure_reason: 'runner_system_failure' }] });
    await w.tick();
    expect(w.gitlab.retried).toEqual([31]);
    w.clock.advance(3 * 60 * 1000);
    w.gitlab.setPipeline(31, 'success'); // the same pipeline id, moved
    await w.tick();
    const verified = topics(w, 'delivery.heal.verified');
    expect(verified).toHaveLength(1);
    expect(verified[0].metadata).toMatchObject({ pipeline_id: 31, action: 'retry_pipeline' });
  });

  it('a repair that fails again is the next attempt, up to the budget, then a person', async () => {
    const w = world({ DELIVERY_LOOP_HEAL_MAX_ATTEMPTS: '2' });
    failedMr(w);
    await w.tick();
    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(1);

    // attempt 1's push fails again, differently
    w.clock.advance(10 * 60 * 1000);
    const second = failedMr(w, 32, { jobs: [{ id: 320, name: 'unit', status: 'failed', failure_reason: 'script_failure' }], log: '2026-11-19T10:20:00.000000Z 01O   error: |-\n2026-11-19T10:20:00.000000Z 01O     TypeError: cannot read properties of undefined\n' });
    await w.tick();
    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(2);
    expect(w.tasks.requests).toHaveLength(2);

    // attempt 2's push fails again too: the budget of 2 is spent
    w.clock.advance(10 * 60 * 1000);
    failedMr(w, 33, { jobs: [{ id: 330, name: 'unit', status: 'failed', failure_reason: 'script_failure' }], log: '2026-11-19T10:40:00.000000Z 01O   error: |-\n2026-11-19T10:40:00.000000Z 01O     RangeError: out of range\n' });
    await w.tick();
    expect(w.tasks.requests).toHaveLength(2);
    const ex = topics(w, 'delivery.heal.exhausted');
    expect(ex).toHaveLength(1);
    expect(ex[0].metadata).toMatchObject({ reason: 'budget_spent', attempts: 2, branch: BRANCH });
    expect(w.gitlab.notes.some((n) => n.body.includes('attempts for today are used up'))).toBe(true);
    expect(second.id).toBe(32);
  });

  it('the budget is per branch, not per failure: a new failure after each repair cannot keep the loop going', async () => {
    const w = world({ DELIVERY_LOOP_HEAL_MAX_ATTEMPTS: '3' });
    let n = 0;
    for (const id of [31, 32, 33, 34, 35]) {
      failedMr(w, id, { jobs: [{ id: id * 10, name: 'unit', status: 'failed', failure_reason: 'script_failure' }], log: `2026-11-19T10:00:00.000000Z 01O   error: |-\n2026-11-19T10:00:00.000000Z 01O     Error: a different failure number ${id}\n` });
      await w.tick();
      w.clock.advance(10 * 60 * 1000);
      n += 1;
    }
    expect(n).toBe(5);
    expect(w.tasks.requests).toHaveLength(3);
    expect(topics(w, 'delivery.heal.exhausted')).toHaveLength(1);
  });

  it('the budget comes back after a day', async () => {
    const w = world({ DELIVERY_LOOP_HEAL_MAX_ATTEMPTS: '1' });
    failedMr(w);
    await w.tick();
    failedMr(w, 32, { log: '2026-11-19T10:20:00.000000Z 01O   error: |-\n2026-11-19T10:20:00.000000Z 01O     Error: second\n' });
    w.clock.advance(10 * 60 * 1000);
    await w.tick();
    expect(topics(w, 'delivery.heal.exhausted')).toHaveLength(1);
    w.clock.advance(25 * 60 * 60 * 1000);
    failedMr(w, 40, { log: '2026-11-20T11:00:00.000000Z 01O   error: |-\n2026-11-20T11:00:00.000000Z 01O     Error: next day\n' });
    await w.tick();
    expect(w.tasks.requests).toHaveLength(2);
  });

  it('an attempt that produced nothing (no pipeline after it) counts as spent after its timeout', async () => {
    const w = world({ DELIVERY_LOOP_HEAL_MAX_ATTEMPTS: '2' });
    failedMr(w);
    await w.tick();
    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(1);
    w.clock.advance(30 * 60 * 1000);
    await w.tick();
    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(1); // not yet: a repair has an hour
    w.clock.advance(40 * 60 * 1000);
    await w.tick(); // the reconciler finds the attempt empty and requests the next one (after this cycle's drive)...
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(2);
    expect(w.tasks.requests).toHaveLength(1);
    await w.tick(); // ...and the next cycle carries it out
    expect(w.tasks.requests).toHaveLength(2);
    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(2);
  });

  it('a heal in flight is not started twice: a second failure fact while an intent is open is left to it', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L1' });
    failedMr(w, 31);
    await w.tick();
    failedMr(w, 32, { log: '2026-11-19T10:20:00.000000Z 01O   error: |-\n2026-11-19T10:20:00.000000Z 01O     Error: another\n' });
    const r = await w.tick();
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(1);
    expect(r.stats.skipped.intent_open ?? 0).toBeGreaterThanOrEqual(1);
    expect(w.tasks.requests).toHaveLength(0);
  });
});

describe('what the level allows for a heal', () => {
  it('L1 records the detection and the intent and touches nothing', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L1' });
    failedMr(w);
    await w.tick();
    expect(topics(w, 'delivery.heal.detected')).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(1);
    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(0);
    expect(w.gitlab.writes()).toBe(0);
    expect(w.tasks.requests).toHaveLength(0);
  });

  it('a disarmed execution plane retries and repairs nothing, and arming it later does', async () => {
    const w = world();
    w.armed.value = false;
    failedMr(w);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(0);
    w.armed.value = true;
    await w.tick();
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('a zero action budget records and decides but writes and executes nothing', async () => {
    const w = world({ DELIVERY_LOOP_MAX_ACTIONS: '0' });
    failedMr(w);
    const r = await w.tick();
    expect(r.ran).toBe(true);
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(0);
    expect(w.gitlab.writes()).toBe(0);
  });

  it('the action budget caps one cycle and the rest is done on the next, nothing lost', async () => {
    const w = world({ DELIVERY_LOOP_MAX_ACTIONS: '1' });
    failedMr(w);
    await w.tick();
    const first = w.tasks.requests.length + w.gitlab.notes.length;
    expect(first).toBeLessThanOrEqual(1);
    for (let i = 0; i < 5; i += 1) await w.tick();
    expect(w.tasks.requests).toHaveLength(1);
    expect(topics(w, 'delivery.heal.attempt')).toHaveLength(1);
    expect(w.gitlab.notes.some((n) => n.body.includes('prepares a repair'))).toBe(true);
  });
});

describe('the intent of a repair is closed when its reason is gone', () => {
  it('a branch that went green by itself before the drive needs no repair', async () => {
    const w = world();
    w.armed.value = false;
    failedMr(w);
    await w.tick();
    w.gitlab.addPipeline({ id: 32, status: 'success', ref: REF });
    w.armed.value = true;
    await w.tick();
    expect(w.tasks.requests).toHaveLength(0);
    expect(topics(w, 'delivery.dispatch.failed')[0].metadata.reason).toMatch(/superseded|already_green/);
  });

  it('a retry whose pipeline is no longer failed is not sent', async () => {
    const w = world();
    w.armed.value = false;
    failedMr(w, 31, { jobs: [{ id: 310, name: 'unit', status: 'failed', failure_reason: 'runner_system_failure' }] });
    await w.tick();
    w.gitlab.setPipeline(31, 'success');
    w.armed.value = true;
    await w.tick();
    expect(w.gitlab.retried).toEqual([]);
  });

  it('the branch key joins project and branch', () => {
    expect(branchKey(PROJECT, BRANCH)).toBe(`${PROJECT}|${BRANCH}`);
  });
});
