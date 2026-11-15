// Read-only check of the operations layer against the live GitLab (VTID-05801). GET requests only; prints counts and
// statuses, never a token, a header or a response body. Run: GITLAB_URL=... GITLAB_TOKEN=... node live-readonly.mjs
import { clientFromEnv, resolveProject, getMergeRequest, mergeStatus, failedJobs, getPipeline, classifyError } from '../../../../scripts/eng/gitlab-ops.mjs';

const client = clientFromEnv(process.env);
const out = {};
const step = async (name, fn) => {
  try { out[name] = await fn(); } catch (e) { out[name] = { error: classifyError(e).kind, status: e.status ?? null, code: e.code ?? null }; }
};
await step('resolveProject(vitana/vitana-platform)', () => resolveProject(client, 'vitana/vitana-platform'));
await step('open merge requests (first page)', async () => {
  const list = await client.get('/projects/2/merge_requests', { query: { state: 'opened', per_page: 5 } });
  return { count: list.length, iids: list.map((m) => m.iid) };
});
await step('getMergeRequest + mergeStatus (first open MR)', async () => {
  const list = await client.get('/projects/2/merge_requests', { query: { state: 'opened', per_page: 1 } });
  if (list.length === 0) return { none: true };
  const mr = await getMergeRequest(client, 2, list[0].iid);
  const s = mergeStatus(mr);
  return { iid: s.iid, mergeable: s.mergeable, blockers: s.blockers.length, pipelineStatus: s.pipelineStatus };
});
await step('nonexistent merge request is not_found', async () => {
  try { await getMergeRequest(client, 2, 999999999); return { unexpected: 'answered' }; } catch (e) { return { kind: classifyError(e).kind, status: e.status }; }
});
await step('failed jobs of a failed pipeline (first page)', async () => {
  const pipes = await client.get('/projects/2/pipelines', { query: { status: 'failed', per_page: 1 } });
  if (pipes.length === 0) return { none: true };
  const jobs = await failedJobs(client, 2, pipes[0].id);
  return { pipelineId: pipes[0].id, failedJobs: jobs.length };
});
console.log(JSON.stringify(out, null, 2));
