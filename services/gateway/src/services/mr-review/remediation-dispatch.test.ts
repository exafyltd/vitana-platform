// MOCK-ONLY: the implementation agent is a stub. No live agent is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failClosedRemediation, type ImplementationAgent } from './remediation-dispatch';
import { runReviewCycle, MAX_REMEDIATION_ROUNDS } from './remediation';

const HEAD = '1'.repeat(40);
const NEW = '2'.repeat(40);
const meta = { correlationId: 'c/r1', mr_iid: 5 };
const agentReturning = (r: unknown): ImplementationAgent => ({ dispatch: async () => r as never });

test('a fixed head from the agent is accepted and passed on', async () => {
  const remediate = failClosedRemediation(agentReturning({ ok: true, new_head_sha: NEW }), 1000);
  assert.deepEqual(await remediate(HEAD, [{}], meta), { ok: true, newHead: NEW });
});

test('the agent throwing is a failed remediation, not an exception', async () => {
  const remediate = failClosedRemediation({ dispatch: async () => { throw new Error('connection reset'); } }, 1000);
  const r = await remediate(HEAD, [{}], meta);
  assert.equal(r.ok, false);
});

test('the agent that never answers times out and fails closed', async () => {
  const remediate = failClosedRemediation({ dispatch: () => new Promise(() => {}) }, 20);
  const r = await remediate(HEAD, [{}], meta);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /unavailable/);
});

test('an agent returning the same head, or no valid head, is a failed remediation', async () => {
  assert.equal((await failClosedRemediation(agentReturning({ ok: true, new_head_sha: HEAD }), 1000)(HEAD, [], meta)).ok, false);
  assert.equal((await failClosedRemediation(agentReturning({ ok: true, new_head_sha: 'nope' }), 1000)(HEAD, [], meta)).ok, false);
});

test('an agent-reported failure is passed through with its message', async () => {
  const r = await failClosedRemediation(agentReturning({ ok: false, error: 'tests still red' }), 1000)(HEAD, [], meta);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /tests still red/);
});

test('the cycle carries a correlation id per round and never runs more than three rounds', async () => {
  const seen: string[] = [];
  const out = await runReviewCycle({
    startHead: HEAD, maxRounds: 10, correlationId: 'pipe-9-job-4',
    review: async (head, cid) => { seen.push(cid); return { kind: 'changes', head, findings: [{}], attestation: {} }; },
    remediate: async () => ({ ok: true, newHead: HEAD }),
  });
  assert.equal(MAX_REMEDIATION_ROUNDS, 3);
  assert.equal(out.status, 'escalated');
  assert.deepEqual(seen, ['pipe-9-job-4/r1', 'pipe-9-job-4/r2', 'pipe-9-job-4/r3']);
});

test('a failing remediation inside the cycle escalates and names the failure', async () => {
  const out = await runReviewCycle({
    startHead: HEAD, maxRounds: 3, correlationId: 'c',
    review: async (head) => ({ kind: 'changes', head, findings: [{}], attestation: {} }),
    remediate: failClosedRemediation({ dispatch: async () => ({ ok: false, error: 'agent down' }) }, 1000),
  });
  assert.equal(out.status, 'escalated');
  if (out.status === 'escalated') { assert.equal(out.reason, 'remediation_failed'); assert.match(out.detail.join(' '), /agent down/); }
});
