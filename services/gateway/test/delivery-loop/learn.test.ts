/**
 * Delivery loop, learn and improve: every outcome leaves a lesson (retried until the memory takes it), and a failure that keeps coming
 * back becomes a proposal for a person, never a task by itself.
 */
import { lessonsFrom, recurrences } from '../../src/services/delivery-loop/learn';
import type { LedgerEvent } from '../../src/services/delivery-loop/facts';
import { PROJECT, topics, world, type World } from './harness';

const BRANCH = 'dev-autopilot/ab12cd34';
const REF = 'refs/merge-requests/12/head';

const row = (id: string, topic: string, metadata: Record<string, unknown>, created_at = '2026-11-19T10:00:00.000Z'): LedgerEvent => ({ id, created_at, vtid: null, topic, status: 'info', message: topic, metadata });

/** Failed, repaired by a new commit, green: the whole repair on a world. */
async function repaired(w: World) {
  w.gitlab.addMr({ iid: 12, source_branch: BRANCH });
  const bad = w.gitlab.addPipeline({ id: 31, status: 'failed', ref: REF });
  w.pipelineFact('failed', bad, { merge_request_iid: 12, mr_source_branch: BRANCH, mr_url: 'https://gitlab.test/mr/12' });
  await w.tick();
  w.clock.advance(5 * 60 * 1000);
  const ok = w.gitlab.addPipeline({ id: 32, status: 'success', ref: REF, sha: 'f'.repeat(40) });
  w.pipelineFact('succeeded', ok, { merge_request_iid: 12, mr_source_branch: BRANCH });
  await w.tick();
}

describe('lessonsFrom and recurrences (pure)', () => {
  it('one lesson per outcome row, each under its own key', () => {
    const plans = lessonsFrom({ verified: [row('v1', 'delivery.heal.verified', {})], exhausted: [row('e1', 'delivery.heal.exhausted', {})], reworks: [row('r1', 'delivery.review.rework', {})] });
    expect(plans.map((p) => p.kind)).toEqual(['repair_verified', 'repair_exhausted', 'review_rework']);
    expect(new Set(plans.map((p) => p.key)).size).toBe(3);
    expect(lessonsFrom({ verified: [], exhausted: [], reworks: [] })).toEqual([]);
  });

  it('recurrences groups by project and fingerprint, counts, orders by count, and keeps the latest details', () => {
    const d = (id: string, project: string, fp: string, at: string, pid: number) => row(id, 'delivery.heal.detected', { project, fingerprint: fp, jobs: ['unit:script_failure'], pipeline_id: pid, url: `https://x/${pid}` }, at);
    const rows = [d('1', 'p/a', 'aaa', '2026-11-12T00:00:00Z', 1), d('2', 'p/a', 'aaa', '2026-11-13T00:00:00Z', 2), d('3', 'p/a', 'aaa', '2026-11-14T00:00:00Z', 3), d('4', 'p/a', 'bbb', '2026-11-14T00:00:00Z', 4), d('5', 'p/b', 'aaa', '2026-11-14T00:00:00Z', 5)];
    expect(recurrences(rows)).toEqual([{ project: 'p/a', fingerprint: 'aaa', count: 3, jobs: ['unit:script_failure'], lastPipeline: 3, lastUrl: 'https://x/3' }]);
    expect(recurrences(rows, 1).map((r) => [r.project, r.fingerprint, r.count])).toEqual([['p/a', 'aaa', 3], ['p/a', 'bbb', 1], ['p/b', 'aaa', 1]]);
    expect(recurrences([row('x', 'delivery.heal.detected', {})])).toEqual([]);
  });
});

describe('what a verified repair teaches', () => {
  it('stores the repair pattern and a memory note, once, and records that it did', async () => {
    const w = world();
    await repaired(w);
    await w.tick();
    expect(topics(w, 'delivery.heal.verified')).toHaveLength(1);
    expect(w.learn.repairs).toHaveLength(1);
    expect(w.learn.repairs[0]).toMatchObject({ project: PROJECT, failure_class: 'code', jobs: ['unit:script_failure'], attempts: 1, mr_url: 'https://gitlab.test/mr/12' });
    expect(w.learn.repairs[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(w.learn.outcomes).toHaveLength(1);
    expect(w.learn.outcomes[0]).toMatchObject({ project: PROJECT, kind: 'repair_verified' });
    expect(w.learn.outcomes[0].summary).toContain('verified by a green pipeline');
    expect(topics(w, 'delivery.learn.recorded')).toHaveLength(1);
    await w.tick();
    await w.tick();
    expect(w.learn.repairs).toHaveLength(1);
    expect(w.learn.outcomes).toHaveLength(1);
  });

  it('a failure met again finds its known fix: the next repair of it is given the hint', async () => {
    const w = world();
    await repaired(w);
    await w.tick();
    // the same failure on another branch
    w.gitlab.addMr({ iid: 13, source_branch: 'dev-autopilot/zz99' });
    const again = w.gitlab.addPipeline({ id: 41, status: 'failed', ref: 'refs/merge-requests/13/head', jobs: [{ id: 410, name: 'unit', status: 'failed', failure_reason: 'script_failure' }], log: w.gitlab.pipelines.get(31)!.traces[310] });
    w.pipelineFact('failed', again, { merge_request_iid: 13, mr_source_branch: 'dev-autopilot/zz99' });
    await w.tick();
    await w.tick();
    const second = w.tasks.requests.find((t) => t.mr_iid === 13);
    expect(second?.hints.join(' ')).toContain('earlier repair of this same failure was verified');
  });

  it('a retry that went green is remembered as infrastructure, not as a code fix: no repair pattern is stored', async () => {
    const w = world();
    w.gitlab.addMr({ iid: 12, source_branch: BRANCH });
    const p = w.gitlab.addPipeline({ id: 31, status: 'failed', ref: REF, jobs: [{ id: 310, name: 'unit', status: 'failed', failure_reason: 'runner_system_failure' }] });
    w.pipelineFact('failed', p, { merge_request_iid: 12, mr_source_branch: BRANCH });
    await w.tick();
    w.clock.advance(3 * 60 * 1000);
    w.gitlab.setPipeline(31, 'success');
    await w.tick();
    await w.tick();
    expect(w.learn.repairs).toHaveLength(0);
    expect(w.learn.outcomes).toHaveLength(1);
    expect(w.learn.outcomes[0].summary).toContain('cleared by retrying the failed jobs');
  });

  it('a memory that is down loses nothing: the lesson is tried again until it is taken, then written once', async () => {
    const w = world();
    w.learn.down = true;
    await repaired(w);
    for (let i = 0; i < 3; i += 1) await w.tick();
    expect(topics(w, 'delivery.learn.recorded')).toHaveLength(0);
    expect(w.learn.repairs).toHaveLength(0);
    w.learn.down = false;
    await w.tick();
    expect(topics(w, 'delivery.learn.recorded')).toHaveLength(1);
    expect(w.learn.repairs).toHaveLength(1);
    await w.tick();
    expect(w.learn.repairs).toHaveLength(1);
  });
});

describe('what an exhausted repair and a rework teach', () => {
  it('an exhausted repair is a memory note with the reason', async () => {
    const w = world();
    w.gitlab.addMr({ iid: 12, source_branch: BRANCH });
    const p = w.gitlab.addPipeline({ id: 31, status: 'failed', ref: REF, jobs: [{ id: 310, name: 'unit', status: 'failed', failure_reason: 'unknown_failure' }] });
    w.pipelineFact('failed', p, { merge_request_iid: 12, mr_source_branch: BRANCH });
    await w.tick();
    await w.tick();
    expect(w.learn.outcomes).toHaveLength(1);
    expect(w.learn.outcomes[0]).toMatchObject({ project: PROJECT, kind: 'repair_exhausted' });
    expect(w.learn.outcomes[0].summary).toContain('unclassified_failure');
    expect(w.learn.outcomes[0].summary).toContain('needs a person');
    expect(w.learn.repairs).toHaveLength(0);
  });

  it('a rework is a memory note with the number of findings', async () => {
    const w = world();
    w.reviewer.verdict = 'changes';
    const head = 'h1'.padEnd(40, '0');
    w.gitlab.addMr({ iid: 12, source_branch: BRANCH, sha: head });
    const g = w.gitlab.addPipeline({ id: 50, status: 'success', ref: REF, sha: head });
    w.pipelineFact('succeeded', g, { merge_request_iid: 12, mr_source_branch: BRANCH });
    await w.tick();
    await w.tick();
    const o = w.learn.outcomes.find((x) => x.kind === 'review_rework');
    expect(o?.summary).toContain('2 findings');
    expect(o?.summary).toContain('round 1');
  });

  it('learning is a level-1 act: at L0 nothing is learned', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L0' });
    await repaired(w);
    expect(w.learn.outcomes).toHaveLength(0);
  });

  it('a lesson for a project that is not on the list is not written, though its outcome row is in the ledger', async () => {
    const w = world();
    // an outcome of another project (written by another loop's configuration) sits in the shared table
    w.ledger.insert({ type: 'delivery.heal.verified', status: 'success', payload: { project: 'vitana/other', branch: 'dev-autopilot/x', heal_key: 'k', fingerprint: 'f'.repeat(16), action: 'run_task', attempts: 1, changed: true, jobs: ['unit:script_failure'] }, key: 'verified:other' });
    await w.tick();
    await w.tick();
    expect(w.learn.outcomes).toHaveLength(0);
    expect(w.learn.repairs).toHaveLength(0);
    expect(topics(w, 'delivery.learn.recorded')).toHaveLength(0);
    // and the same row for the listed project IS learned from, so the test is not passing because nothing is ever learned
    w.ledger.insert({ type: 'delivery.heal.verified', status: 'success', payload: { project: PROJECT, branch: 'dev-autopilot/x', heal_key: 'k2', fingerprint: 'e'.repeat(16), action: 'run_task', attempts: 1, changed: true, jobs: ['unit:script_failure'] }, key: 'verified:mine' });
    await w.tick();
    expect(w.learn.outcomes).toHaveLength(1);
  });
});

describe('improve: a failure that keeps coming back', () => {
  async function fail(w: World, id: number, branch: string) {
    const mrIid = 100 + id;
    w.gitlab.addMr({ iid: mrIid, source_branch: branch });
    const p = w.gitlab.addPipeline({ id, status: 'failed', ref: `refs/merge-requests/${mrIid}/head`, jobs: [{ id: id * 10, name: 'unit', status: 'failed', failure_reason: 'script_failure' }], log: '2026-11-19T10:00:00.000000Z 01O   error: |-\n2026-11-19T10:00:00.000000Z 01O     Error: the same failure every time\n' });
    w.pipelineFact('failed', p, { merge_request_iid: mrIid, mr_source_branch: branch });
    await w.tick();
  }

  it('three detections of one failure in a week become one proposal: an issue labeled delivery-proposal, never the intake label', async () => {
    const w = world();
    for (const [n, id] of [31, 32, 33].entries()) {
      await fail(w, id, `dev-autopilot/b${n}`);
      w.clock.advance(60 * 60 * 1000);
    }
    await w.tick();
    const proposals = topics(w, 'delivery.improve.proposed');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].metadata).toMatchObject({ project: PROJECT, count: 3, jobs: ['unit:script_failure'] });
    expect(w.gitlab.createdIssues).toHaveLength(1);
    const issue = w.gitlab.createdIssues[0];
    expect(issue.labels).toEqual(['delivery-proposal']);
    expect(issue.labels).not.toContain('agent-task');
    expect(issue.title).toContain('3 times in 7 days');
    expect(issue.description).toContain(proposals[0].metadata.fingerprint as string);
    expect(proposals[0].metadata.issue_iid).toBe(issue.iid);
  });

  it('is proposed once a week however many cycles run, and not before the third detection', async () => {
    const w = world();
    await fail(w, 31, 'dev-autopilot/b0');
    await fail(w, 32, 'dev-autopilot/b1');
    await w.tick();
    expect(topics(w, 'delivery.improve.proposed')).toHaveLength(0);
    await fail(w, 33, 'dev-autopilot/b2');
    for (let i = 0; i < 4; i += 1) await w.tick();
    expect(topics(w, 'delivery.improve.proposed')).toHaveLength(1);
    expect(w.gitlab.createdIssues).toHaveLength(1);
  });

  it('at L1 the proposal is recorded and no issue is created', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L1' });
    for (const [n, id] of [31, 32, 33].entries()) await fail(w, id, `dev-autopilot/b${n}`);
    await w.tick();
    expect(topics(w, 'delivery.improve.proposed')).toHaveLength(1);
    expect(topics(w, 'delivery.improve.proposed')[0].metadata.issue_iid).toBeNull();
    expect(w.gitlab.createdIssues).toHaveLength(0);
  });

  it('a proposal never feeds itself: the issue it created is not an intake task until a person labels it', async () => {
    const w = world();
    for (const [n, id] of [31, 32, 33].entries()) await fail(w, id, `dev-autopilot/b${n}`);
    await w.tick();
    const before = w.tasks.requests.length;
    const proposal = w.gitlab.createdIssues[0];
    w.gitlab.issues.set(proposal.iid, { id: 1, iid: proposal.iid, title: proposal.title, description: proposal.description, state: 'opened', labels: proposal.labels, web_url: 'u', confidential: false, updated_at: new Date(w.clock.now()).toISOString(), author_id: 1 });
    for (let i = 0; i < 3; i += 1) await w.tick();
    expect(w.tasks.requests.filter((t) => t.kind === 'intake')).toHaveLength(0);
    expect(w.tasks.requests.length).toBe(before);
  });
});
