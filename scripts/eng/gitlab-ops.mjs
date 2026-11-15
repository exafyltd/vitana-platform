// GitLab operations on top of the one client (plan gitlab-client-hardening, lane gitlab-client-hardening).
// Every call goes through createClient in ./gitlab-api.mjs; there is no second client and no second provider.
//   findMergeRequestBySource(client, project, branch)  the open merge request whose SOURCE is this branch (never a number)
//   listPipelineJobs(client, project, pipelineId, { scope })  every job of a pipeline, all pages
//   failedJobs(client, project, pipelineId)            the failed jobs of a pipeline, so an agent can read the exact failure
//   getJobLog(client, project, jobId, { maxBytes })    the trace (log) of one job, as text
//   getPipeline(client, project, pipelineId)           one pipeline's status
// A bad id is refused before anything is sent. A failed read throws; nothing here reports success on a failed call.
import { projectId, GitLabApiError } from './gitlab-api.mjs';

const positiveId = (value, name) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new GitLabApiError(`${name} must be a positive integer`, { code: 'bad_request' });
  return n;
};
const nonEmpty = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw new GitLabApiError(`${name} is required`, { code: 'bad_request' });
  return value;
};

/** The one open merge request from `branch` to `targetBranch` in the project; null if there is none; throws if several. */
export async function findMergeRequestBySource(client, project, branch, { targetBranch = 'main' } = {}) {
  nonEmpty(branch, 'branch');
  const all = await client.paginate(`/projects/${projectId(project)}/merge_requests`, {
    query: { state: 'opened', source_branch: branch, target_branch: targetBranch },
  });
  const same = all.filter((m) => m?.source_branch === branch && m.target_branch === targetBranch
    && m.source_project_id === m.target_project_id);
  if (same.length > 1) throw new GitLabApiError(`more than one open merge request has source ${branch}`, { code: 'ambiguous' });
  return same[0] ?? null;
}

/** Every job of a pipeline, all pages. `scope` (e.g. ['failed']) is passed to GitLab as the scope filter. */
export async function listPipelineJobs(client, project, pipelineId, { scope } = {}) {
  const id = positiveId(pipelineId, 'pipelineId');
  return client.paginate(`/projects/${projectId(project)}/pipelines/${id}/jobs`, { query: scope ? { scope } : {} });
}

/** The failed jobs of a pipeline: the entry point for diagnosing a red pipeline. */
export async function failedJobs(client, project, pipelineId) {
  return listPipelineJobs(client, project, pipelineId, { scope: ['failed'] });
}

/** The trace (log) of one job as text. Refuses a log larger than maxBytes instead of truncating it silently. */
export async function getJobLog(client, project, jobId, { maxBytes = 2_000_000 } = {}) {
  const id = positiveId(jobId, 'jobId');
  const res = await client.raw('GET', `/projects/${projectId(project)}/jobs/${id}/trace`, { expect: 'text', maxBodyBytes: maxBytes });
  return { jobId: id, log: typeof res.data === 'string' ? res.data : '' };
}

/** One pipeline's status object, as GitLab reports it. */
export async function getPipeline(client, project, pipelineId) {
  const id = positiveId(pipelineId, 'pipelineId');
  return client.get(`/projects/${projectId(project)}/pipelines/${id}`);
}
