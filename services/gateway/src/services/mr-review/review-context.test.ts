import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewContext, type GitLabMrReader } from './review-context';

const HEAD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);

function reader(seq: Array<{ sha: string; state?: string }>, files = [{ old_path: 'a.ts', new_path: 'a.ts', diff: '+x\n' }]): GitLabMrReader {
  let i = 0;
  return {
    async getMr() {
      const s = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return { sha: s.sha, state: s.state ?? 'opened' };
    },
    async getChanges() {
      return { files };
    },
  };
}

test('an open MR at the expected head yields a context pinned to that head', async () => {
  const r = await buildReviewContext({ reader: reader([{ sha: HEAD }]), mr_iid: 5, expectedHeadSha: HEAD });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.context.head_sha, HEAD);
});

test('a head that moved before review is refused', async () => {
  const r = await buildReviewContext({ reader: reader([{ sha: OTHER }]), mr_iid: 5, expectedHeadSha: HEAD });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /head moved/);
});

test('a head that moved during the fetch is refused', async () => {
  const r = await buildReviewContext({ reader: reader([{ sha: HEAD }, { sha: OTHER }]), mr_iid: 5, expectedHeadSha: HEAD });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /during fetch/);
});

test('a closed or merged MR is refused', async () => {
  const r = await buildReviewContext({ reader: reader([{ sha: HEAD, state: 'merged' }]), mr_iid: 5, expectedHeadSha: HEAD });
  assert.equal(r.ok, false);
});

test('an oversized diff is refused, never truncated', async () => {
  const big = [{ old_path: 'a.ts', new_path: 'a.ts', diff: 'x'.repeat(1000) }];
  const r = await buildReviewContext({ reader: reader([{ sha: HEAD }], big), mr_iid: 5, expectedHeadSha: HEAD, maxDiffBytes: 500 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /review cap/);
});

test('an MR with no changed files is refused', async () => {
  const r = await buildReviewContext({ reader: reader([{ sha: HEAD }], []), mr_iid: 5, expectedHeadSha: HEAD });
  assert.equal(r.ok, false);
});
