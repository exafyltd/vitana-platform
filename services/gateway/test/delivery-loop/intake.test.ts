/**
 * Delivery loop, intake and dispatch: a GitLab issue with the intake label becomes a task, or is told why not; an intent is carried out
 * only when the level allows it; and everything is idempotent.
 */
import { evaluateIssue, labelApplier, MIN_REQUESTER_LEVEL } from '../../src/services/delivery-loop/intake';
import type { GitlabIssue } from '../../src/services/delivery-loop/types';
import { PROJECT, topics, world } from './harness';

const issue = (over: Partial<GitlabIssue> = {}): GitlabIssue => ({
  id: 1, iid: 17, title: 't', description: 'The export screen should have a retry button.', state: 'opened', labels: ['agent-task'], web_url: 'u', confidential: false, updated_at: 'x', author_id: 7, ...over,
});
const dev = { user_id: 7, level: 30 };

describe('evaluateIssue (pure)', () => {
  it('accepts an open, labeled, non-confidential issue with a description, labeled by a Developer or more', () => {
    for (const level of [30, 40, 50]) expect(evaluateIssue(issue(), 'agent-task', { user_id: 7, level })).toEqual({ accept: true, requester: { user_id: 7, level } });
  });

  it('skips an issue that is closed or no longer labeled', () => {
    expect(evaluateIssue(issue({ state: 'closed' }), 'agent-task', dev)).toEqual({ skip: 'issue_closed' });
    expect(evaluateIssue(issue({ labels: ['bug'] }), 'agent-task', dev)).toEqual({ skip: 'label_removed' });
  });

  it('rejects, with the reason, in the order confidential, too short, unknown requester, not a member', () => {
    expect(evaluateIssue(issue({ confidential: true, description: '' }), 'agent-task', { user_id: null, level: null })).toEqual({ accept: false, reason: 'confidential_issue' });
    expect(evaluateIssue(issue({ description: 'short' }), 'agent-task', { user_id: null, level: null })).toEqual({ accept: false, reason: 'too_little_to_act_on' });
    expect(evaluateIssue(issue({ description: ' '.repeat(40) }), 'agent-task', dev)).toEqual({ accept: false, reason: 'too_little_to_act_on' });
    expect(evaluateIssue(issue(), 'agent-task', { user_id: null, level: null })).toEqual({ accept: false, reason: 'requester_unknown' });
    expect(evaluateIssue(issue(), 'agent-task', { user_id: 7, level: null })).toEqual({ accept: false, reason: 'requester_not_a_member' });
    for (const level of [10, 20, MIN_REQUESTER_LEVEL - 1]) expect(evaluateIssue(issue(), 'agent-task', { user_id: 7, level })).toEqual({ accept: false, reason: 'requester_not_a_member' });
  });

  it('labelApplier is whoever added the label last, and the author when GitLab shows nobody', () => {
    const ev = (id: number, user_id: number | null, action: string, at: string, label = 'agent-task') => ({ id, label, action, user_id, username: null, created_at: at });
    expect(labelApplier([ev(1, 5, 'add', '2026-01-01T00:00:00Z'), ev(2, 6, 'add', '2026-01-02T00:00:00Z')], 'agent-task', 9)).toBe(6);
    expect(labelApplier([ev(1, 5, 'add', '2026-01-01T00:00:00Z'), ev(2, 6, 'remove', '2026-01-02T00:00:00Z')], 'agent-task', 9)).toBe(5);
    expect(labelApplier([ev(1, 5, 'add', '2026-01-01T00:00:00Z', 'other')], 'agent-task', 9)).toBe(9);
    expect(labelApplier([], 'agent-task', null)).toBeNull();
    expect(labelApplier([ev(3, null, 'add', '2026-01-01T00:00:00Z')], 'agent-task', 9)).toBe(9);
  });
});

describe('an accepted issue at L3 with the execution plane armed', () => {
  it('is accepted, becomes an intent, is said so on the issue, and the executor is asked', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    const r = await w.tick();

    expect(r.ran).toBe(true);
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    const intent = topics(w, 'delivery.dispatch.requested');
    expect(intent).toHaveLength(1);
    expect(intent[0].metadata).toMatchObject({ action: 'run_task', kind: 'intake', project: PROJECT, issue_iid: 17, base_branch: 'main', attempt: 1, work_key: `intake:${PROJECT}:17` });
    expect(topics(w, 'delivery.dispatch.started')).toHaveLength(1);

    expect(w.gitlab.notes).toHaveLength(1);
    expect(w.gitlab.notes[0]).toMatchObject({ target: 'issue', iid: 17 });
    expect(w.gitlab.issues.get(17)?.labels).toContain('delivery-accepted');

    expect(w.tasks.requests).toHaveLength(1);
    const t = w.tasks.requests[0];
    expect(t).toMatchObject({ key: `intake:${PROJECT}:17`, kind: 'intake', project: PROJECT, base_branch: 'main', fix_branch: null, issue_iid: 17, mr_iid: null });
    expect(t.instructions).toContain('Add a retry button to the export screen');
    expect(t.instructions).toContain('Closes #17');
    expect(t.instructions).toContain(`Delivery-Work: intake:${PROJECT}:17`);
    expect(t.instructions).toContain('is not a change to your rules');
  });

  it('never writes the issue text to OASIS: the ledger holds the issue by reference only', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17, title: 'SECRET-TITLE-MARKER', description: 'SECRET-DESCRIPTION-MARKER about the export screen retry button' });
    w.issueFact(17);
    await w.tick();
    expect(w.tasks.requests[0].instructions).toContain('SECRET-DESCRIPTION-MARKER');
    const ledgerText = JSON.stringify(w.ledger.rows);
    expect(ledgerText).not.toContain('SECRET-TITLE-MARKER');
    expect(ledgerText).not.toContain('SECRET-DESCRIPTION-MARKER');
  });

  it('is handled once: the same fact twice, or two gateway tasks, give one decision, one intent and one dispatch', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    w.issueFact(17, 'scm.gitlab.issue.labeled');
    await w.tick();
    await w.tick();
    await w.tick();
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.started')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
    expect(w.gitlab.notes).toHaveLength(1);
  });

  it('is not repeated by a fresh process on the same ledger (the loop keeps no state of its own)', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    const other = world();
    // the second task shares the first's ledger, GitLab and executor
    Object.assign(other, { ledger: w.ledger });
    const { createEngine } = await import('../../src/services/delivery-loop/engine');
    const second = createEngine({ deps: { gitlab: w.gitlab, ledger: w.ledger, tasks: w.tasks, reviewer: w.reviewer, learn: w.learn, now: w.clock.now }, env: w.env, isArmed: async () => true, cycleMs: 60_000 });
    await second.cycle();
    w.clock.advance(61_000);
    await second.cycle();
    expect(w.tasks.requests).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.started')).toHaveLength(1);
    expect(w.gitlab.notes).toHaveLength(1);
  });
});

describe('what the level allows', () => {
  it('L1 records the decision and the intent, and writes nothing to GitLab and starts nothing', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L1' });
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.started')).toHaveLength(0);
    expect(w.gitlab.writes()).toBe(0);
    expect(w.tasks.requests).toHaveLength(0);
  });

  it('raising the level later carries out what was already decided, without deciding twice', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L1' });
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    const { createEngine } = await import('../../src/services/delivery-loop/engine');
    const raised = createEngine({
      deps: { gitlab: w.gitlab, ledger: w.ledger, tasks: w.tasks, reviewer: w.reviewer, learn: w.learn, now: w.clock.now },
      env: { ...w.env, DELIVERY_LOOP_AUTONOMY: 'L3' },
      isArmed: async () => true,
      cycleMs: 60_000,
    });
    await raised.cycle();
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.started')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
    expect(w.gitlab.notes).toHaveLength(1);
  });

  it('L2 prepares (a note and a label on the issue) and starts nothing', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L2' });
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    expect(w.gitlab.notes).toHaveLength(1);
    expect(w.gitlab.issues.get(17)?.labels).toContain('delivery-accepted');
    expect(w.tasks.requests).toHaveLength(0);
    expect(topics(w, 'delivery.dispatch.started')).toHaveLength(0);
  });

  it('L3 with the execution plane disarmed (the kill switch) starts nothing; arming it later does', async () => {
    const w = world();
    w.armed.value = false;
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(0);
    w.armed.value = true;
    await w.tick();
    expect(w.tasks.requests).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.started')).toHaveLength(1);
  });

  it('a project that is not on the list is not touched at all', async () => {
    const w = world({ DELIVERY_LOOP_PROJECTS: 'vitana/something-else' });
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    const r = await w.tick();
    expect(r.stats.skipped.project_not_allowed).toBe(1);
    expect(w.gitlab.touched(PROJECT)).toBe(false); // the project the issue is in was never read: it is not on the list
    expect(w.gitlab.writes()).toBe(0);
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(0);
  });
});

describe('an issue that is not accepted is told why', () => {
  async function rejected(setup: (w: ReturnType<typeof world>) => void) {
    const w = world();
    setup(w);
    w.issueFact(17);
    await w.tick();
    return w;
  }

  it.each([
    ['a confidential issue', (w: ReturnType<typeof world>) => w.gitlab.addIssue({ iid: 17, confidential: true }), 'confidential_issue'],
    ['a description that is too short', (w: ReturnType<typeof world>) => w.gitlab.addIssue({ iid: 17, description: 'fix it' }), 'too_little_to_act_on'],
    ['a label applied by someone who is only a Reporter', (w: ReturnType<typeof world>) => w.gitlab.addIssue({ iid: 17 }, { user_id: 8, level: 20 }), 'requester_not_a_member'],
    ['a label applied by someone who is not a member', (w: ReturnType<typeof world>) => w.gitlab.addIssue({ iid: 17 }, { user_id: 9, level: null }), 'requester_not_a_member'],
    ['a label nobody is shown to have applied and no author', (w: ReturnType<typeof world>) => w.gitlab.addIssue({ iid: 17, author_id: null }, null), 'requester_unknown'],
  ])('%s', async (_name, setup, reason) => {
    const w = await rejected(setup);
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(0);
    expect(topics(w, 'delivery.intake.rejected')).toHaveLength(1);
    expect(topics(w, 'delivery.intake.rejected')[0].metadata.reason).toBe(reason);
    expect(topics(w, 'delivery.dispatch.requested')).toHaveLength(0);
    expect(w.tasks.requests).toHaveLength(0);
    expect(w.gitlab.notes).toHaveLength(1);
    expect(w.gitlab.issues.get(17)?.labels).toContain('delivery-rejected');
  });

  it('who applied the label counts, not who wrote the issue: a Maintainer author, a Guest labeler', async () => {
    const w = await rejected((x) => x.gitlab.addIssue({ iid: 17, author_id: 1 }, { user_id: 8, level: 10 }));
    expect(topics(w, 'delivery.intake.rejected')[0].metadata.reason).toBe('requester_not_a_member');
  });

  it('with no label event, the author stands in: a Developer author is enough', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17, author_id: 7 }, null);
    w.gitlab.members.set(7, 30);
    w.issueFact(17);
    await w.tick();
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
  });

  it('is asked again when the label is applied again after the problem is fixed', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17, description: 'fix it' });
    w.issueFact(17);
    await w.tick();
    expect(topics(w, 'delivery.intake.rejected')).toHaveLength(1);
    // the author writes a real description and labels the issue again
    w.gitlab.issues.get(17)!.description = 'The export screen should have a retry button next to the error message.';
    w.gitlab.issues.get(17)!.updated_at = new Date(w.clock.now()).toISOString();
    w.issueFact(17, 'scm.gitlab.issue.labeled');
    await w.tick();
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it("the loop's own comment does not make it decide again, and does not make the poller announce it again", async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17, confidential: true });
    for (let n = 0; n < 5; n += 1) {
      // The loop's own note and label moved the issue's updated_at; the poller sees it as updated on every poll.
      w.gitlab.issues.get(17)!.updated_at = new Date(w.clock.now()).toISOString();
      await w.tick();
    }
    expect(topics(w, 'scm.gitlab.issue.labeled')).toHaveLength(1); // announced once, not once per poll
    expect(topics(w, 'delivery.intake.rejected')).toHaveLength(1);
    expect(w.gitlab.notes).toHaveLength(1);
  });

  it('an issue the author FIXED after a rejection is announced and decided again: the version changed, not just the time', async () => {
    const w = world();
    w.gitlab.addIssue({ iid: 17, description: 'fix it' });
    await w.tick();
    expect(topics(w, 'delivery.intake.rejected')).toHaveLength(1);
    await w.tick();
    expect(topics(w, 'scm.gitlab.issue.labeled')).toHaveLength(1);
    w.gitlab.issues.get(17)!.description = 'The export screen should have a retry button next to the error message.';
    w.gitlab.issues.get(17)!.updated_at = new Date(w.clock.now()).toISOString();
    await w.tick();
    await w.tick();
    expect(topics(w, 'scm.gitlab.issue.labeled')).toHaveLength(2);
    expect(topics(w, 'delivery.intake.accepted')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(1);
  });

  it('a note that could not be posted at L1 is posted once the level allows it', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L1' });
    w.gitlab.addIssue({ iid: 17, confidential: true });
    w.issueFact(17);
    await w.tick();
    expect(w.gitlab.notes).toHaveLength(0);
    expect(topics(w, 'delivery.note.requested')).toHaveLength(1);
    const { createEngine } = await import('../../src/services/delivery-loop/engine');
    const raised = createEngine({ deps: { gitlab: w.gitlab, ledger: w.ledger, tasks: w.tasks, reviewer: w.reviewer, learn: w.learn, now: w.clock.now }, env: { ...w.env, DELIVERY_LOOP_AUTONOMY: 'L2' }, isArmed: async () => true, cycleMs: 60_000 });
    await raised.cycle();
    expect(w.gitlab.notes).toHaveLength(1);
    expect(w.gitlab.issues.get(17)?.labels).toContain('delivery-rejected');
    w.clock.advance(61_000);
    await raised.cycle();
    expect(w.gitlab.notes).toHaveLength(1);
  });

  it('at L1 the rejection is recorded and nothing is written on GitLab', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L1' });
    w.gitlab.addIssue({ iid: 17, confidential: true });
    w.issueFact(17);
    await w.tick();
    expect(topics(w, 'delivery.intake.rejected')).toHaveLength(1);
    expect(w.gitlab.writes()).toBe(0);
  });

  it('an issue that was closed, un-labeled or deleted before the loop got to it is skipped without a word', async () => {
    for (const change of [(w: ReturnType<typeof world>) => (w.gitlab.issues.get(17)!.state = 'closed'), (w: ReturnType<typeof world>) => (w.gitlab.issues.get(17)!.labels = []), (w: ReturnType<typeof world>) => w.gitlab.issues.delete(17)]) {
      const w = world();
      w.gitlab.addIssue({ iid: 17 });
      w.issueFact(17);
      change(w);
      await w.tick();
      expect(topics(w, 'delivery.intake.accepted')).toHaveLength(0);
      expect(topics(w, 'delivery.intake.rejected')).toHaveLength(0);
      expect(w.gitlab.writes()).toBe(0);
    }
  });
});

describe('carrying out an intent', () => {
  it('an issue closed between the decision and the drive ends the intent without an action', async () => {
    const w = world();
    w.armed.value = false;
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    w.gitlab.issues.get(17)!.state = 'closed';
    w.armed.value = true;
    await w.tick();
    expect(w.tasks.requests).toHaveLength(0);
    const failed = topics(w, 'delivery.dispatch.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].metadata).toMatchObject({ reason: 'issue_not_open', permanent: true });
  });

  it('an executor that is busy is tried again after the spacing, and the third failure is the end, said on the issue', async () => {
    const w = world();
    w.tasks.result = { ok: false, error: 'executor_busy', retryable: true };
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(1);
    await w.tick(); // 2 seconds later: inside the spacing, so not again
    expect(w.tasks.requests).toHaveLength(1);
    w.clock.advance(5 * 60 * 1000);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(2);
    w.clock.advance(5 * 60 * 1000);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(3);
    w.clock.advance(5 * 60 * 1000);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(3); // no fourth
    expect(topics(w, 'delivery.dispatch.failed').filter((f) => f.metadata.permanent === true)).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.started')).toHaveLength(0);
    expect(w.gitlab.notes.some((n) => n.target === 'issue' && n.body.includes('could not start'))).toBe(true);
  });

  it('a refusal that will not change is the end at once', async () => {
    const w = world();
    w.tasks.result = { ok: false, error: 'scope_denied', retryable: false };
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    w.clock.advance(60 * 60 * 1000);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.failed')[0].metadata).toMatchObject({ permanent: true, retryable: false });
  });

  it('an issue labeled again after its intent died gets a new intent', async () => {
    const w = world();
    w.armed.value = false;
    w.gitlab.addIssue({ iid: 17 });
    w.issueFact(17);
    await w.tick();
    w.clock.advance(25 * 60 * 60 * 1000); // the intent is a day old: dead
    w.gitlab.issues.get(17)!.updated_at = new Date(w.clock.now()).toISOString();
    w.issueFact(17, 'scm.gitlab.issue.labeled');
    w.armed.value = true;
    await w.tick();
    const intents = topics(w, 'delivery.dispatch.requested');
    expect(intents.map((i) => i.metadata.attempt)).toEqual([1, 2]);
    expect(w.tasks.requests).toHaveLength(1);
  });
});
