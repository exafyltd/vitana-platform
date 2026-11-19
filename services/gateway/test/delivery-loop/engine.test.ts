/**
 * Delivery loop engine: the cycle as a whole. The claim that makes one gateway task run a window, the cursor that survives a restart,
 * the failures of the world, the fact that fails for itself, the quiet cycle that writes nothing, the poller, and the end-to-end paths.
 */
import { createEngine } from '../../src/services/delivery-loop/engine';
import { MAX_FACT_FAILURES } from '../../src/services/delivery-loop/engine';
import { PROJECT, topics, world, type World } from './harness';

const BRANCH = 'dev-autopilot/ab12cd34';
const REF = 'refs/merge-requests/12/head';

const second = (w: World, env: Record<string, string> = {}) =>
  createEngine({ deps: { gitlab: w.gitlab, ledger: w.ledger, tasks: w.tasks, reviewer: w.reviewer, learn: w.learn, now: w.clock.now }, env: { ...w.env, ...env }, isArmed: async () => w.armed.value, cycleMs: 60_000 });

describe('the switch and the claim', () => {
  it('a loop that is not enabled does nothing at all: no read, no write, no claim', async () => {
    const w = world({ DELIVERY_LOOP_ENABLED: 'false' });
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    const r = await w.tick();
    expect(r).toMatchObject({ ran: false, reason: 'disabled' });
    expect(w.gitlab.calls).toEqual([]);
    expect(topics(w, 'delivery.loop.claim')).toHaveLength(0);
    expect(w.ledger.rows).toHaveLength(1); // only the fact the test wrote
  });

  it('one gateway task runs a window: with work for both, the second stops quietly and does none of it', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    const other = second(w);
    // the second task has work (the fact is unread by it) but the first took the window
    const a = await w.engine.cycle();
    w.ledger.insert({ type: 'scm.gitlab.issue.opened', payload: { project_path: PROJECT, issue_iid: 18, url: 'u', labels: ['agent-task'] }, key: 'late-fact' });
    w.gitlab.addIssue({ iid: 18 });
    const b = await other.cycle();
    expect(a.ran).toBe(true);
    expect(b).toMatchObject({ ran: false, reason: 'claimed_elsewhere' });
    expect(w.tasks.requests.map((t) => t.issue_iid)).toEqual([17]);
    expect(topics(w, 'delivery.loop.claim')).toHaveLength(1);
    // the next window: the second task may take it, and the work it left is done
    w.clock.advance(60_000);
    expect((await other.cycle()).ran).toBe(true);
    expect(w.tasks.requests.map((t) => t.issue_iid).sort()).toEqual([17, 18]);
  });

  it('a task with nothing to do does not take the window: claiming is lazy, so an idle task writes nothing', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.engine.cycle();
    const rows = w.ledger.rows.length;
    const idle = await second(w).cycle();
    expect(idle).toMatchObject({ ran: true });
    expect(idle.stats.facts).toBe(0);
    expect(w.ledger.rows.length).toBe(rows);
  });

  it('the next window is claimable again, by either task', async () => {
    const w = world();
    const other = second(w);
    await w.engine.cycle();
    w.clock.advance(60_000);
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    const b = await other.cycle();
    expect(b.ran).toBe(true);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('a cycle that finds nothing writes nothing: no claim, no cycle row (polling is not an OASIS event)', async () => {
    const w = world();
    for (let i = 0; i < 5; i += 1) await w.tick();
    expect(w.ledger.rows).toEqual([]);
    expect(w.gitlab.writes()).toBe(0);
  });
});

describe('the cursor', () => {
  it('is written with each cycle that did something, and a fresh process resumes from it without redoing anything', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    const cycles = topics(w, 'delivery.loop.cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].metadata).toMatchObject({ autonomy: 'L3', armed: true, stopped_early: false });
    expect(typeof cycles[0].metadata.cursor_id).toBe('string');

    const fresh = second(w);
    w.clock.advance(60_000);
    const writes = w.gitlab.writes();
    const rows = w.ledger.rows.length;
    const r = await fresh.cycle();
    expect(r.ran).toBe(true);
    expect(r.stats.facts).toBe(0); // the facts are behind the cursor the first process stored
    expect(fresh.cursor()).not.toBeNull();
    expect(w.gitlab.writes()).toBe(writes);
    expect(w.ledger.rows.length).toBe(rows); // and nothing was written for a cycle with nothing to do
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('rows that share a timestamp are not skipped: the cursor is (time, id), not time', async () => {
    const w = world();
    const at = '2026-11-19T10:00:00.000Z';
    for (const iid of [17, 18, 19]) {
      w.gitlab.addIssue({ iid });
      w.ledger.insert({ type: 'scm.gitlab.issue.opened', created_at: at, payload: { project_path: PROJECT, issue_iid: iid, url: 'u', labels: ['agent-task'] }, key: `same-time-${iid}` });
    }
    const one = world({ DELIVERY_LOOP_MAX_ACTIONS: '20' });
    void one;
    // a batch of one: each cycle takes the next row, never the same twice and never skipping one
    const e = createEngine({ deps: { gitlab: w.gitlab, ledger: w.ledger, tasks: w.tasks, reviewer: w.reviewer, learn: w.learn, now: w.clock.now }, env: w.env, isArmed: async () => true, cycleMs: 60_000 });
    await e.cycle();
    expect(topics(w, 'delivery.intake.accepted').map((r) => r.metadata.issue_iid).sort()).toEqual([17, 18, 19]);
  });
});

describe('failures of the world', () => {
  it('GitLab down: the fact is not passed, nothing is half-written, and it is done when GitLab is back', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    w.gitlab.down = true;
    const r = await w.tick();
    expect(r.stoppedEarly).toBe(true);
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(0);
    expect(topics(w, 'delivery.blocked')).toHaveLength(0);
    w.gitlab.down = false;
    await w.tick();
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('GitLab failing in the middle of a note (the label after the comment) repeats only the label, never the comment', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    w.gitlab.failOnce.add('updateIssueLabels');
    const first = await w.tick();
    expect(first.stats.errors).toBeGreaterThan(0); // the failure was seen and counted
    for (let i = 0; i < 3; i += 1) await w.tick();
    // The invariant: the person who reads the issue sees ONE comment and the label, however the failure fell.
    expect(w.gitlab.notes).toHaveLength(1);
    expect(w.gitlab.issues.get(17)!.labels).toContain('delivery-accepted');
    expect(w.gitlab.count('updateIssueLabels')).toBe(2); // the failed call and its repeat
    expect(w.gitlab.count('commentIssue')).toBe(1);
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    expect(topics(w, 'delivery.note.posted').filter((r) => r.metadata.step === 'done')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('OASIS unreadable: the cycle ends without acting and says so', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    w.ledger.failNext.read = 1;
    const r = await w.tick();
    expect(r).toMatchObject({ ran: false, reason: 'ledger_unreachable' });
    expect(w.tasks.requests).toHaveLength(0);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('OASIS not writable: the loop does not act on what it could not record, and loses nothing', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    w.ledger.failNext.record = 100; // every write fails
    await w.tick();
    await w.tick();
    expect(w.tasks.requests).toHaveLength(0);
    expect(w.gitlab.writes()).toBe(0);
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(0);
    w.ledger.failNext.record = 0; // OASIS is back
    await w.tick();
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('a fact that keeps failing for itself is set aside after three tries, recorded, and does not stop the facts behind it', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    w.gitlab.addIssue({ iid: 18 });
    w.issueFact(18);
    // the first issue's fact breaks the handler with a bug-shaped failure, not a GitLab one
    const original = w.gitlab.getIssue;
    w.gitlab.getIssue = (p: string, iid: number) => {
      if (iid === 17) throw new TypeError('a bug in the handler');
      return original(p, iid);
    };
    for (let i = 0; i < MAX_FACT_FAILURES + 1; i += 1) await w.tick();
    const blocked = topics(w, 'delivery.blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].status).toBe('warning');
    expect(blocked[0].metadata.error).toContain('a bug in the handler');
    expect(topics(w, 'delivery.intake.accepted').map((r) => r.metadata.issue_iid)).toEqual([18]);
    expect(w.tasks.requests.map((t) => t.issue_iid)).toEqual([18]);
  });
});

describe('the action budget', () => {
  it('caps the side effects of a cycle (a note, an execution, a retry: each one unit), completes the rest later, loses no decision', async () => {
    const w = world({ DELIVERY_LOOP_MAX_ACTIONS: '2' });
    for (const iid of [17, 18, 19]) {
      w.gitlab.addIssue({ iid });
      w.issueFact(iid);
    }
    const first = await w.tick();
    expect(first.stoppedEarly).toBe(true);
    // two units: here, two notes. Nothing beyond the budget happened in this cycle.
    expect(w.gitlab.notes.length + w.tasks.requests.length).toBeLessThanOrEqual(2);
    for (let i = 0; i < 12; i += 1) await w.tick();
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(3);
    expect(w.tasks.requests.map((t) => t.issue_iid).sort()).toEqual([17, 18, 19]);
    expect(w.gitlab.notes).toHaveLength(3);
  });
});

describe('the poller', () => {
  it('finds an issue with the intake label that no webhook announced, so a project without a webhook still works', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 }); // no fact written: the webhook never came
    const r = await w.tick();
    expect(r.stats.polled).toBe(1);
    expect(topics(w, 'scm.gitlab.issue.labeled')[0].metadata).toMatchObject({ source: 'poll', issue_iid: 17, project_path: PROJECT });
    await w.tick();
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('finds a failed pipeline no webhook announced, under the webhook stage\'s own key', async () => {
    const w = world();
    w.gitlab.addMr({ iid: 12, source_branch: BRANCH });
    w.gitlab.addPipeline({ id: 31, status: 'failed', ref: REF });
    await w.tick();
    const polled = topics(w, 'scm.gitlab.pipeline.failed');
    expect(polled).toHaveLength(1);
    expect(polled[0].metadata).toMatchObject({ source: 'poll', pipeline_id: 31, merge_request_iid: 12, mr_source_branch: BRANCH, host: 'gitlab' });
    expect(polled[0].metadata.dedupe_key).toBe(`gitlab:${PROJECT}:pipeline:31:failed`);
    expect(polled[0].metadata.failed_jobs).toEqual([{ id: 310, name: 'unit', stage: 'test', failure_reason: 'script_failure', exit_code: null }]);
    await w.tick();
    expect(topics(w, 'delivery.heal.detected')).toHaveLength(1);
  });

  it('a fact the webhook AND the poller saw is one row: the same key', async () => {
    const w = world();
    w.gitlab.addMr({ iid: 12, source_branch: BRANCH });
    const p = w.gitlab.addPipeline({ id: 31, status: 'failed', ref: REF });
    w.pipelineFact('failed', p, { merge_request_iid: 12, mr_source_branch: BRANCH });
    await w.tick();
    expect(topics(w, 'scm.gitlab.pipeline.failed')).toHaveLength(1);
    expect(topics(w, 'delivery.heal.detected')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('leaves branches the loop does not own alone, even when GitLab shows them failing', async () => {
    const w = world();
    w.gitlab.addMr({ iid: 12, source_branch: 'kiro/plan/lane' });
    w.gitlab.addPipeline({ id: 31, status: 'failed', ref: REF });
    w.gitlab.addPipeline({ id: 32, status: 'failed', ref: 'feature/x' });
    const r = await w.tick();
    expect(r.stats.polled).toBe(0);
    expect(topics(w, 'scm.gitlab.pipeline.failed')).toHaveLength(0);
  });

  it('is off below level 1, and a project outside the list is never read', async () => {
    const off = world({ DELIVERY_LOOP_AUTONOMY: 'L0' });
    off.gitlab.addIssue({ iid: 17 });
    await off.tick();
    expect(off.gitlab.calls).toEqual([]);
    const other = world({ DELIVERY_LOOP_PROJECTS: 'vitana/other' });
    other.gitlab.addIssue({ iid: 17 });
    await other.tick();
    expect(other.gitlab.touched(PROJECT)).toBe(false);
  });
});

describe('end to end', () => {
  it('an issue becomes a merge request that fails, is repaired, goes green, is reviewed, and the loop learns from it', async () => {
    const w = world();
    // 1. a Developer labels an issue
    w.gitlab.addIssue({ iid: 17, title: 'Add a retry button', description: 'The export screen should have a retry button next to the error message.' });
    w.issueFact(17);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(1);
    expect(w.tasks.requests[0].kind).toBe('intake');

    // 2. the executor opens a merge request on its own branch; its pipeline fails
    w.gitlab.addMr({ iid: 12, source_branch: BRANCH, title: 'Add a retry button', description: 'Closes #17\nDelivery-Work: intake:vitana/rehearsal:17', sha: 'h1'.padEnd(40, '0') });
    const bad = w.gitlab.addPipeline({ id: 31, status: 'failed', ref: REF, sha: 'h1'.padEnd(40, '0') });
    w.pipelineFact('failed', bad, { merge_request_iid: 12, mr_source_branch: BRANCH, mr_url: 'https://gitlab.test/mr/12' });
    await w.tick();
    await w.tick();

    // 3. a repair is asked for, on that branch, with the evidence
    expect(w.tasks.requests).toHaveLength(2);
    expect(w.tasks.requests[1]).toMatchObject({ kind: 'repair', fix_branch: BRANCH, mr_iid: 12 });
    expect(w.tasks.requests[1].instructions).toContain('Expected values to be strictly equal');

    // 4. the executor pushes a fix; the pipeline is green; the head moved
    w.clock.advance(5 * 60 * 1000);
    w.gitlab.mrs.get(12)!.sha = 'h2'.padEnd(40, '0');
    const good = w.gitlab.addPipeline({ id: 32, status: 'success', ref: REF, sha: 'h2'.padEnd(40, '0') });
    w.pipelineFact('succeeded', good, { merge_request_iid: 12, mr_source_branch: BRANCH });
    await w.tick();
    await w.tick();

    // 5. verified, reviewed once, learned
    expect(topics(w, 'delivery.heal.verified')).toHaveLength(1);
    expect(w.reviewer.inputs).toEqual([{ project: PROJECT, iid: 12, head: 'h2'.padEnd(40, '0'), files: 1 }]);
    expect(topics(w, 'delivery.review.verdict')[0].metadata.verdict).toBe('accept');
    expect(w.learn.repairs).toHaveLength(1);
    expect(w.learn.outcomes.map((o) => o.kind)).toEqual(['repair_verified']);
    // and the loop settles: once everything is learned, further cycles do nothing and write nothing
    await w.tick();
    await w.tick();
    const requests = w.tasks.requests.length;
    const rows = w.ledger.rows.length;
    const writes = w.gitlab.writes();
    for (let i = 0; i < 3; i += 1) await w.tick();
    expect(w.tasks.requests.length).toBe(requests);
    expect(w.ledger.rows.length).toBe(rows);
    expect(w.gitlab.writes()).toBe(writes);
  });
});
