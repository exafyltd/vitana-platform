/**
 * Delivery loop, review: a green merge request of a branch the loop owns is reviewed once per head, a verdict of "changes" becomes a
 * bounded rework, and the loop never merges.
 */
import { decideReview, decideVerdict } from '../../src/services/delivery-loop/review';
import { PROJECT, topics, world, type World } from './harness';

const BRANCH = 'dev-autopilot/ab12cd34';
const REF = 'refs/merge-requests/12/head';
const HEAD = 'h1'.padEnd(40, '0');

function greenMr(w: World, over: { head?: string; pipelineId?: number; draft?: boolean } = {}) {
  const head = over.head ?? HEAD;
  const mr = w.gitlab.mrs.get(12) ?? w.gitlab.addMr({ iid: 12, source_branch: BRANCH, sha: head });
  mr.sha = head;
  mr.draft = over.draft ?? false;
  const p = w.gitlab.addPipeline({ id: over.pipelineId ?? 50, status: 'success', ref: REF, sha: head });
  w.pipelineFact('succeeded', p, { merge_request_iid: 12, mr_source_branch: BRANCH });
  return p;
}

describe('decideReview (pure)', () => {
  const d = (over: Partial<Parameters<typeof decideReview>[0]> = {}) => decideReview({ draft: false, state: 'opened', head: HEAD, pipelineSha: HEAD, alreadyReviewed: false, ...over });
  it('reviews an open, ready merge request whose green pipeline is the head, once', () => {
    expect(d()).toEqual({ kind: 'review' });
    expect(d({ pipelineSha: null })).toEqual({ kind: 'review' });
  });
  it.each([
    [{ state: 'merged' }, 'mr_not_open'],
    [{ draft: true }, 'mr_is_draft'],
    [{ head: null }, 'no_head'],
    [{ pipelineSha: 'x'.repeat(40) }, 'pipeline_not_for_head'],
    [{ alreadyReviewed: true }, 'already_reviewed'],
  ])('%j is skipped: %s', (over, reason) => {
    expect(d(over as never)).toEqual({ kind: 'skip', reason });
  });
});

describe('decideVerdict (pure)', () => {
  it('accept is accepted; changes is a rework until the rounds are used, then a person', () => {
    expect(decideVerdict({ verdict: 'accept', reworkRounds: 5, maxRounds: 2 })).toEqual({ kind: 'accepted' });
    expect(decideVerdict({ verdict: 'changes', reworkRounds: 0, maxRounds: 2 })).toEqual({ kind: 'rework', round: 1 });
    expect(decideVerdict({ verdict: 'changes', reworkRounds: 1, maxRounds: 2 })).toEqual({ kind: 'rework', round: 2 });
    expect(decideVerdict({ verdict: 'changes', reworkRounds: 2, maxRounds: 2 })).toEqual({ kind: 'escalate' });
  });
});

describe('a green merge request of an owned branch', () => {
  it('is reviewed, the verdict recorded and said on the merge request, and nothing is merged', async () => {
    const w = world();
    greenMr(w);
    await w.tick();
    expect(w.reviewer.inputs).toEqual([{ project: PROJECT, iid: 12, head: HEAD, files: 1 }]);
    expect(topics(w, 'delivery.review.requested')).toHaveLength(1);
    const v = topics(w, 'delivery.review.verdict');
    expect(v).toHaveLength(1);
    expect(v[0].metadata).toMatchObject({ project: PROJECT, mr_iid: 12, head: HEAD, verdict: 'accept', model: 'fake-model' });
    expect(w.gitlab.notes.some((n) => n.target === 'mr' && n.iid === 12 && n.body.includes('accepted') && n.body.includes('Merging stays with the project'))).toBe(true);
    expect(w.gitlab.calls).not.toContain('mergeMergeRequest');
    expect(topics(w, 'delivery.review.rework')).toHaveLength(0);
  });

  it('is reviewed once per head: the same head again, and a second gateway task, review nothing more', async () => {
    const w = world();
    greenMr(w);
    await w.tick();
    greenMr(w, { pipelineId: 51 }); // another green pipeline of the same head
    await w.tick();
    await w.tick();
    expect(w.reviewer.inputs).toHaveLength(1);
    expect(topics(w, 'delivery.review.verdict')).toHaveLength(1);
  });

  it('a new head is a new review', async () => {
    const w = world();
    greenMr(w);
    await w.tick();
    greenMr(w, { head: 'h2'.padEnd(40, '0'), pipelineId: 52 });
    await w.tick();
    expect(w.reviewer.inputs.map((i) => i.head)).toEqual([HEAD, 'h2'.padEnd(40, '0')]);
  });

  it('is not reviewed while a draft, or when its pipeline is not the head, or when it is not an owned branch', async () => {
    const draft = world();
    greenMr(draft, { draft: true });
    expect((await draft.tick()).stats.skipped.mr_is_draft).toBe(1);

    const stale = world();
    stale.gitlab.addMr({ iid: 12, source_branch: BRANCH, sha: HEAD });
    const p = stale.gitlab.addPipeline({ id: 50, status: 'success', ref: REF, sha: 'old'.padEnd(40, '0') });
    stale.pipelineFact('succeeded', p, { merge_request_iid: 12, mr_source_branch: BRANCH });
    expect((await stale.tick()).stats.skipped.pipeline_not_for_head).toBe(1);

    const lane = world();
    lane.gitlab.addMr({ iid: 12, source_branch: 'kiro/plan/lane', sha: HEAD });
    const lp = lane.gitlab.addPipeline({ id: 50, status: 'success', ref: REF, sha: HEAD });
    lane.pipelineFact('succeeded', lp, { merge_request_iid: 12, mr_source_branch: 'kiro/plan/lane' });
    expect((await lane.tick()).stats.skipped.branch_not_owned).toBe(1);
    for (const x of [draft, stale, lane]) expect(x.reviewer.inputs).toHaveLength(0);
  });

  it('needs L2: at L1 nothing is reviewed (a review is a model call and a note)', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L1' });
    greenMr(w);
    expect((await w.tick()).stats.skipped.review_needs_l2).toBe(1);
    expect(w.reviewer.inputs).toHaveLength(0);
  });

  it('with no reviewer configured the loop does not review', async () => {
    const w = world({}, { reviewer: false });
    greenMr(w);
    expect((await w.tick()).stats.skipped.no_reviewer).toBe(1);
  });

  it('a reviewer that is down is the world failing, not the merge request: it is tried again, never set aside', async () => {
    const w = world();
    w.reviewer.down = true;
    greenMr(w);
    for (let i = 0; i < 5; i += 1) await w.tick();
    expect(topics(w, 'delivery.blocked')).toHaveLength(0);
    expect(topics(w, 'delivery.review.verdict')).toHaveLength(0);
    w.reviewer.down = false;
    await w.tick();
    expect(topics(w, 'delivery.review.verdict')).toHaveLength(1);
  });

  it('bounds what the reviewer is shown: the diff text is cut to a limit', async () => {
    const w = world();
    greenMr(w);
    w.gitlab.diffs.set(12, Array.from({ length: 5 }, (_, i) => ({ old_path: `f${i}`, new_path: `f${i}`, new_file: false, deleted_file: false, diff: 'x'.repeat(60_000) })));
    let seen = 0;
    w.reviewer.review = async (input) => {
      seen = input.diffs.reduce((n, d) => n + d.diff.length, 0);
      return { ok: true as const, data: { verdict: 'accept', summary: 's', findings: [], model: 'm', reviewed_head: HEAD } };
    };
    await w.tick();
    expect(seen).toBe(120_000);
  });
});

describe('a verdict of changes', () => {
  it('becomes a rework intent on the same branch, carried out by the executor, with the findings', async () => {
    const w = world();
    w.reviewer.verdict = 'changes';
    greenMr(w);
    await w.tick();
    expect(topics(w, 'delivery.review.rework')).toHaveLength(1);
    const intent = topics(w, 'delivery.dispatch.requested').filter((i) => i.metadata.kind === 'rework');
    expect(intent).toHaveLength(1);
    expect(intent[0].metadata).toMatchObject({ action: 'run_task', kind: 'rework', fix_branch: BRANCH, mr_iid: 12, round: 1, reviewed_head: HEAD });
    expect(w.gitlab.notes.some((n) => n.body.includes('changes are needed (round 1 of 2)') && n.body.includes('no test for the empty case'))).toBe(true);
    await w.tick();
    expect(w.tasks.requests).toHaveLength(1);
    expect(w.tasks.requests[0]).toMatchObject({ kind: 'rework', fix_branch: BRANCH, mr_iid: 12 });
    expect(w.tasks.requests[0].instructions).toContain('The new branch has no test for the empty case.');
    expect(w.tasks.requests[0].instructions).toContain('Do not open a new merge request');
  });

  it('is limited to the configured rounds, then a person is asked and nothing more is started', async () => {
    const w = world({ DELIVERY_LOOP_REWORK_MAX_ROUNDS: '2' });
    w.reviewer.verdict = 'changes';
    for (const [n, head] of ['h1', 'h2', 'h3', 'h4'].entries()) {
      greenMr(w, { head: head.padEnd(40, '0'), pipelineId: 60 + n });
      await w.tick();
      await w.tick();
    }
    expect(topics(w, 'delivery.review.rework')).toHaveLength(2);
    expect(w.tasks.requests.filter((t) => t.kind === 'rework')).toHaveLength(2);
    expect(w.gitlab.notes.some((n) => n.body.includes('after 2 rounds of rework') && n.body.includes('a person is needed'))).toBe(true);
  });

  it('is closed without action when the merge request moved on before the rework was carried out', async () => {
    const w = world();
    w.armed.value = false;
    w.reviewer.verdict = 'changes';
    greenMr(w);
    await w.tick();
    w.gitlab.mrs.get(12)!.sha = 'moved'.padEnd(40, '0');
    w.armed.value = true;
    await w.tick();
    expect(w.tasks.requests).toHaveLength(0);
    expect(topics(w, 'delivery.dispatch.failed').some((f) => f.metadata.reason === 'head_moved')).toBe(true);
  });

  it('a verdict about another commit is recorded and acted on by no one', async () => {
    const w = world();
    w.reviewer.verdict = 'changes';
    w.reviewer.reviewedHead = 'other'.padEnd(40, '0');
    greenMr(w);
    await w.tick();
    expect(topics(w, 'delivery.review.verdict')).toHaveLength(1);
    expect(topics(w, 'delivery.review.rework')).toHaveLength(0);
    expect(w.tasks.requests).toHaveLength(0);
  });

  it('at L2 the rework is decided and said, and started only at L3', async () => {
    const w = world({ DELIVERY_LOOP_AUTONOMY: 'L2' });
    w.reviewer.verdict = 'changes';
    greenMr(w);
    await w.tick();
    await w.tick();
    expect(topics(w, 'delivery.review.rework')).toHaveLength(1);
    expect(topics(w, 'delivery.dispatch.requested').filter((i) => i.metadata.kind === 'rework')).toHaveLength(1);
    expect(w.tasks.requests).toHaveLength(0);
  });
});
