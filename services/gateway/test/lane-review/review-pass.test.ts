/** Bedrock lane reviewer — review-pass behaviour (no AWS: the model call is injected). */
import { runLaneReview, parseVerdict, type CallReviewModel, type LaneReviewInput } from '../../src/services/lane-review/review-pass';
import { LANE_REVIEWER_CHAIN } from '../../src/services/lane-review/models';

const base: LaneReviewInput = {
  repo: 'exafyltd/vitana-platform',
  pr: 1,
  headSha: 'a'.repeat(40),
  laneKey: 'x/y',
  acceptance: 'criteria',
  changedFiles: ['services/gateway/src/x.ts'],
  diff: 'diff',
};
const accept = { verdict: 'accept', findings: [] };
const ok = (toolInput: unknown) => async () => ({ ok: true as const, toolInput });
const fail = async () => ({ ok: false as const, error: 'throttled' });

describe('runLaneReview', () => {
  it('refuses a protected gate file without calling a model', async () => {
    const call = jest.fn(ok(accept));
    const r = await runLaneReview({ ...base, changedFiles: ['scripts/collab/queue.mjs'] }, call as unknown as CallReviewModel);
    expect(r.ok && r.verdict).toBe('changes');
    expect(call).not.toHaveBeenCalled();
  });

  it('accepts on the primary model', async () => {
    const r = await runLaneReview(base, ok(accept));
    expect(r).toMatchObject({ ok: true, verdict: 'accept', model: 'claude-opus-4.6' });
  });

  it('falls back to the second model on a failure', async () => {
    const r = await runLaneReview(base, async (req) => (req.model.name === 'claude-opus-4.6' ? fail() : ok(accept)(req)));
    expect(r).toMatchObject({ ok: true, verdict: 'accept', model: 'claude-sonnet-4.6' });
  });

  it('downgrades an accept that has a blocking finding', async () => {
    const r = await runLaneReview(base, ok({ verdict: 'accept', findings: [{ file: 'a.ts', line: 3, severity: 'blocking', summary: 'bad' }] }));
    expect(r).toMatchObject({ ok: true, verdict: 'changes' });
  });

  it('returns model_unavailable when every tier fails, never an accept', async () => {
    const r = await runLaneReview(base, fail);
    expect(r).toMatchObject({ ok: false, error: 'model_unavailable' });
    if (!r.ok) expect(r.attempts).toHaveLength(LANE_REVIEWER_CHAIN.length);
  });

  it('falls through a malformed verdict to the next tier', async () => {
    const r = await runLaneReview(base, async (req) => (req.model.name === 'claude-opus-4.6' ? ok({ verdict: 'yes' })(req) : ok(accept)(req)));
    expect(r).toMatchObject({ ok: true, model: 'claude-sonnet-4.6' });
  });

  it('records a thrown error and moves on', async () => {
    const r = await runLaneReview(base, async () => { throw new Error('boom'); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.attempts[0].error).toMatch(/boom/);
  });
});

describe('parseVerdict', () => {
  it('rejects an unknown severity', () => {
    expect(parseVerdict({ verdict: 'accept', findings: [{ file: 'a', line: 1, severity: 'minor', summary: 's' }] })).toBeNull();
  });
});
