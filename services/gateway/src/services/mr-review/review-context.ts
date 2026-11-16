/**
 * Exact-SHA review context for one GitLab MR. The reviewer may only see the
 * diff of the head it is asked to review. If the MR head has moved, or the MR
 * is not open, the context is refused. An oversized diff is refused too; it is
 * never truncated, because a partial review cannot support an ACCEPT.
 */

export interface MrChangeFile {
  old_path: string;
  new_path: string;
  diff: string;
}

export interface GitLabMrReader {
  getMr(iid: number): Promise<{ sha: string; state: string }>;
  getChanges(iid: number): Promise<{ files: MrChangeFile[] }>;
}

export interface ReviewContext {
  mr_iid: number;
  head_sha: string;
  files: MrChangeFile[];
  diff_bytes: number;
}

export type ContextResult = { ok: true; context: ReviewContext } | { ok: false; reason: string };

export const MAX_REVIEW_DIFF_BYTES = 400_000;

export async function buildReviewContext(input: {
  reader: GitLabMrReader;
  mr_iid: number;
  expectedHeadSha: string;
  maxDiffBytes?: number;
}): Promise<ContextResult> {
  if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha)) return { ok: false, reason: 'expected head must be a full 40-hex SHA' };
  const mr = await input.reader.getMr(input.mr_iid);
  if (mr.state !== 'opened') return { ok: false, reason: `MR !${input.mr_iid} is ${mr.state}, not opened` };
  if (mr.sha !== input.expectedHeadSha) return { ok: false, reason: `head moved: MR is at ${mr.sha}, expected ${input.expectedHeadSha}` };
  const changes = await input.reader.getChanges(input.mr_iid);
  // The head can move while the changes are fetched; re-check before reviewing.
  const after = await input.reader.getMr(input.mr_iid);
  if (after.sha !== input.expectedHeadSha) return { ok: false, reason: `head moved during fetch: now ${after.sha}` };
  const bytes = changes.files.reduce((n, f) => n + Buffer.byteLength(f.diff, 'utf8'), 0);
  const cap = input.maxDiffBytes ?? MAX_REVIEW_DIFF_BYTES;
  if (bytes > cap) return { ok: false, reason: `diff is ${bytes} bytes, above the ${cap}-byte review cap; split the MR` };
  if (changes.files.length === 0) return { ok: false, reason: 'MR has no changed files' };
  return { ok: true, context: { mr_iid: input.mr_iid, head_sha: input.expectedHeadSha, files: changes.files, diff_bytes: bytes } };
}
