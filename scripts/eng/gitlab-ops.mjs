// GitLab operations on the one client (plan gitlab-client-hardening, VTID-05801, lane gitlab-client-hardening).
// Every call goes through createClient in ./gitlab-api.mjs. There is no second client and no second provider: a caller
// that needs GitLab, the DeliveryProvider included, takes a client from here or from gitlab-api.mjs.
//
// Interface contract: docs/validation/VTID-05801/interface-contract.md (signatures, errors, pagination, identification).
//
//   Configuration   clientFromEnv(env, options)                    GITLAB_URL + GITLAB_TOKEN, or GITLAB_TOKEN_FILE (mode 0600)
//   Identification  resolveProject(client, project)                 a project id, verified against its path (cached per client)
//   Reads           findMergeRequestBySource, getMergeRequest, mergeStatus, listPipelineJobs, failedJobs, getJobLog, getPipeline
//   Merge requests  createMergeRequest (idempotent), updateMergeRequest (expects branches), safeMerge (preconditions, no retry)
//   Pipelines/jobs  triggerPipeline (never repeated), retryJob, retryPipeline (only from failed or canceled)
//   Webhooks        verifyWebhook (X-Gitlab-Token, constant time), isDuplicateDelivery
//   Errors          classifyError: permission | not_found | conflict | precondition | transient | bad_request | unknown
//
// Rules every write follows:
//  - The project is resolved to its numeric id, and every merge request read is checked to belong to that project
//    (target_project_id), so an iid of another project is refused, not acted on.
//  - A merge request is identified by its iid AND checked against the expected source and target branches before a write.
//  - An action (merge, trigger, retry, create) is sent with retries: 0. The client retries a POST only on 429, which GitLab
//    sends before processing. A 5xx or a lost connection on an action is NOT repeated here: the caller gets a transient error
//    and must read the resource (findMergeRequestBySource, listPipelineJobs, getMergeRequest) before it decides anything.
//  - A failed write throws. Nothing here reports success for a call that failed, and nothing logs a credential.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { projectId, createClient, GitLabApiError } from './gitlab-api.mjs';

const SHA = /^[0-9a-f]{40}$/;
const CREDENTIAL_LIKE_KEY = /(token|secret|password|passwd|credential|private)/i;
const CREDENTIAL_LIKE_VALUE = /\b(?:glpat|glrt|gldt|glptt|glft|glcbt|glimt|glagent|gloas|glsoat|glffct|glrtr)-[A-Za-z0-9_-]{10,}|\bBearer\s+\S+/i;
const MIN_SECRET_LENGTH = 8;

const positiveId = (value, name) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new GitLabApiError(`${name} must be a positive integer`, { code: 'bad_request' });
  return n;
};
const nonEmpty = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw new GitLabApiError(`${name} is required`, { code: 'bad_request' });
  return value.trim();
};
const fullSha = (value, name) => {
  if (typeof value !== 'string' || !SHA.test(value)) throw new GitLabApiError(`${name} must be a full 40-character lowercase commit SHA`, { code: 'bad_request' });
  return value;
};

/** A check in this layer refused the write before it was sent. `check` names the rule that stopped it. */
function precondition(message, check) {
  const err = new GitLabApiError(message, { code: 'precondition' });
  err.check = check;
  return err;
}

// --- identification ----------------------------------------------------------------------------------------------------

const projectCache = new WeakMap();

/**
 * The numeric id of a project. A number is taken as it is. A "group/project" path is looked up once per client and checked:
 * GitLab's answer must carry the same path_with_namespace, or the lookup is refused.
 */
export async function resolveProject(client, project) {
  if (typeof project === 'number') return positiveId(project, 'project');
  const path = nonEmpty(project, 'project');
  if (/^\d+$/.test(path)) return positiveId(path, 'project');
  let cache = projectCache.get(client);
  if (!cache) { cache = new Map(); projectCache.set(client, cache); }
  if (cache.has(path)) return cache.get(path);
  const data = await client.get(`/projects/${projectId(path)}`);
  if (!data || typeof data.id !== 'number' || data.path_with_namespace !== path) {
    throw precondition(`the project lookup for "${path}" did not return that project; refused`, 'wrong_project');
  }
  cache.set(path, data.id);
  return data.id;
}

// --- reads -------------------------------------------------------------------------------------------------------------

/** One merge request by iid, checked to belong to the project. */
export async function getMergeRequest(client, project, iid) {
  const id = positiveId(iid, 'iid');
  const pid = await resolveProject(client, project);
  const mr = await client.get(`/projects/${pid}/merge_requests/${id}`);
  if (!mr || typeof mr !== 'object' || (mr.target_project_id ?? mr.project_id) !== pid) {
    throw precondition(`merge request !${id} does not belong to project ${pid}; refused`, 'wrong_project');
  }
  return mr;
}

/** Whether a merge request can be merged now, with the reasons when it cannot. Pure: it reads the object it is given. */
export function mergeStatus(mr) {
  const blockers = [];
  if (mr.state !== 'opened') blockers.push(`state is ${mr.state}`);
  if (mr.draft || mr.work_in_progress) blockers.push('draft');
  const detailed = mr.detailed_merge_status ?? mr.merge_status ?? 'unknown';
  if (detailed !== 'mergeable') blockers.push(`merge status is ${detailed}`);
  const pipelineStatus = mr.head_pipeline?.status ?? null;
  if (pipelineStatus !== 'success') blockers.push(`head pipeline is ${pipelineStatus ?? 'missing'}`);
  return {
    iid: mr.iid,
    state: mr.state,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    headSha: mr.sha ?? null,
    detailedMergeStatus: detailed,
    pipelineId: mr.head_pipeline?.id ?? null,
    pipelineStatus,
    mergeable: blockers.length === 0,
    blockers,
  };
}

/** The one open merge request from `branch` to `targetBranch` in the project; null if there is none; throws if several. */
export async function findMergeRequestBySource(client, project, branch, { targetBranch = 'main' } = {}) {
  nonEmpty(branch, 'branch');
  const pid = await resolveProject(client, project);
  const all = await client.paginate(`/projects/${pid}/merge_requests`, {
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

// --- merge requests ----------------------------------------------------------------------------------------------------

/**
 * Creates the merge request from sourceBranch to targetBranch, or returns the open one that already exists. A repeated call,
 * or a call after a lost answer, creates no second merge request. Returns { created, mr }.
 */
export async function createMergeRequest(client, project, { sourceBranch, targetBranch = 'main', title, description = '', removeSourceBranch = false, draft = false } = {}) {
  const source = nonEmpty(sourceBranch, 'sourceBranch');
  const target = nonEmpty(targetBranch, 'targetBranch');
  const name = nonEmpty(title, 'title');
  if (source === target) throw new GitLabApiError('sourceBranch and targetBranch must differ', { code: 'bad_request' });
  if (name.length > 255) throw new GitLabApiError('title is longer than 255 characters', { code: 'bad_request' });
  const pid = await resolveProject(client, project);
  const existing = await findMergeRequestBySource(client, pid, source, { targetBranch: target });
  if (existing) return { created: false, mr: existing };
  const body = {
    source_branch: source, target_branch: target, title: draft ? `Draft: ${name}` : name,
    description: String(description), remove_source_branch: removeSourceBranch === true,
  };
  try {
    const mr = await client.post(`/projects/${pid}/merge_requests`, { body, retries: 0 });
    if (!mr || (mr.target_project_id ?? mr.project_id) !== pid) throw precondition('the created merge request is not in the project; refused', 'wrong_project');
    return { created: true, mr };
  } catch (err) {
    // 409: GitLab already has an open one (another writer, or a lost answer). Return it; never create a second.
    if (err instanceof GitLabApiError && err.status === 409) {
      const again = await findMergeRequestBySource(client, pid, source, { targetBranch: target });
      if (again) return { created: false, mr: again };
    }
    throw err;
  }
}

/**
 * Changes title, description, target branch or draft state of one open merge request. `expect` is required: the merge request
 * is read first and refused if its source (and, when given, its target) is not what the caller expects, so an iid cannot be
 * edited by mistake. The PUT carries the whole change and is idempotent, so the client may retry it.
 */
export async function updateMergeRequest(client, project, iid, { title, description, targetBranch, draft, expect } = {}) {
  if (!expect || typeof expect !== 'object') throw new GitLabApiError('updateMergeRequest needs expect: { sourceBranch, targetBranch? }', { code: 'bad_request' });
  const sourceExpected = nonEmpty(expect.sourceBranch, 'expect.sourceBranch');
  const pid = await resolveProject(client, project);
  const id = positiveId(iid, 'iid');
  const mr = await getMergeRequest(client, pid, id);
  if (mr.source_branch !== sourceExpected) throw precondition(`merge request !${id} has source ${mr.source_branch}, not ${sourceExpected}; refused`, 'wrong_source');
  if (expect.targetBranch !== undefined && mr.target_branch !== expect.targetBranch) {
    throw precondition(`merge request !${id} has target ${mr.target_branch}, not ${expect.targetBranch}; refused`, 'wrong_target');
  }
  if (mr.state !== 'opened') throw precondition(`merge request !${id} is ${mr.state}, not open; refused`, 'not_open');
  const body = {};
  if (title !== undefined || typeof draft === 'boolean') {
    const base = (title !== undefined ? nonEmpty(title, 'title') : mr.title).replace(/^Draft:\s*/i, '');
    const isDraft = typeof draft === 'boolean' ? draft : /^Draft:\s*/i.test(mr.title);
    body.title = isDraft ? `Draft: ${base}` : base;
  }
  if (description !== undefined) body.description = String(description);
  if (targetBranch !== undefined) body.target_branch = nonEmpty(targetBranch, 'targetBranch');
  if (Object.keys(body).length === 0) throw new GitLabApiError('updateMergeRequest has nothing to change', { code: 'bad_request' });
  return client.put(`/projects/${pid}/merge_requests/${id}`, { body });
}

/**
 * Merges one merge request only when every precondition holds at the moment of the call. The merge is pinned to the head
 * commit the caller reviewed, so GitLab refuses it if the head has moved. It sends one request (retries: 0). If the request
 * fails, the merge request is read again: a merge GitLab did complete is reported as merged, not as a failure.
 * Returns { merged: true, iid, mergeCommitSha, alreadyMerged }.
 */
export async function safeMerge(client, project, iid, {
  expectedHeadSha, sourceBranch, targetBranch = 'main', removeSourceBranch = false, squash = true, mergeMessage,
} = {}) {
  const head = fullSha(expectedHeadSha, 'expectedHeadSha');
  const source = nonEmpty(sourceBranch, 'sourceBranch');
  const target = nonEmpty(targetBranch, 'targetBranch');
  const pid = await resolveProject(client, project);
  const id = positiveId(iid, 'iid');
  const mr = await getMergeRequest(client, pid, id);
  if (mr.source_branch !== source) throw precondition(`merge request !${id} has source ${mr.source_branch}, not ${source}; refused`, 'wrong_source');
  if (mr.target_branch !== target) throw precondition(`merge request !${id} has target ${mr.target_branch}, not ${target}; refused`, 'wrong_target');
  if (mr.sha !== head) throw precondition(`merge request !${id} head is ${mr.sha}, not the reviewed ${head}; the head moved, refused`, 'head_moved');
  const status = mergeStatus(mr);
  if (!status.mergeable) throw precondition(`merge request !${id} is not mergeable: ${status.blockers.join('; ')}`, 'not_mergeable');
  const body = { sha: head, squash: squash === true, should_remove_source_branch: removeSourceBranch === true };
  if (mergeMessage !== undefined) body.merge_commit_message = String(mergeMessage);
  try {
    const done = await client.put(`/projects/${pid}/merge_requests/${id}/merge`, { body, retries: 0 });
    if (done?.state !== 'merged') throw precondition(`GitLab answered the merge of !${id} without state merged; not reported as merged`, 'merge_not_confirmed');
    return { merged: true, iid: id, mergeCommitSha: done.merge_commit_sha ?? null, alreadyMerged: false };
  } catch (err) {
    // The merge may have completed although the answer was lost: read the merge request before deciding it failed.
    const after = await getMergeRequest(client, pid, id).catch(() => null);
    if (after?.state === 'merged') return { merged: true, iid: id, mergeCommitSha: after.merge_commit_sha ?? null, alreadyMerged: true };
    throw err;
  }
}

// --- pipelines and jobs ------------------------------------------------------------------------------------------------

/**
 * Starts a pipeline on a ref. Sent once (retries: 0): a repeated trigger starts a second pipeline. After a timeout or a 5xx,
 * list the project's pipelines for the ref before triggering again. Variables are plain key/value strings. A credential-looking
 * name or value is refused, because a pipeline variable is stored and shown in the pipeline.
 */
export async function triggerPipeline(client, project, { ref, variables = {} } = {}) {
  const r = nonEmpty(ref, 'ref');
  const entries = Object.entries(variables ?? {});
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new GitLabApiError('a variable name must be letters, digits and underscores', { code: 'bad_request' });
    if (CREDENTIAL_LIKE_KEY.test(key)) throw new GitLabApiError(`variable "${key}" looks like a credential; credentials never go into a pipeline variable`, { code: 'bad_request' });
    if (typeof value !== 'string') throw new GitLabApiError(`variable "${key}" must be a string`, { code: 'bad_request' });
    if (CREDENTIAL_LIKE_VALUE.test(value)) throw new GitLabApiError(`variable "${key}" holds a credential-shaped value; refused`, { code: 'bad_request' });
  }
  const pid = await resolveProject(client, project);
  return client.post(`/projects/${pid}/pipeline`, {
    body: { ref: r, variables: entries.map(([key, value]) => ({ key, value, variable_type: 'env_var' })) },
    retries: 0,
  });
}

/** Retries one job, only when it is failed or canceled: a running or passed job is refused, so no job runs twice. */
export async function retryJob(client, project, jobId) {
  const id = positiveId(jobId, 'jobId');
  const pid = await resolveProject(client, project);
  const job = await client.get(`/projects/${pid}/jobs/${id}`);
  if (!['failed', 'canceled'].includes(job?.status)) throw precondition(`job ${id} is ${job?.status}; only a failed or canceled job is retried`, 'not_retryable');
  return client.post(`/projects/${pid}/jobs/${id}/retry`, { retries: 0 });
}

/** Retries a pipeline, only when it is failed or canceled. */
export async function retryPipeline(client, project, pipelineId) {
  const id = positiveId(pipelineId, 'pipelineId');
  const pid = await resolveProject(client, project);
  const pipeline = await client.get(`/projects/${pid}/pipelines/${id}`);
  if (!['failed', 'canceled'].includes(pipeline?.status)) throw precondition(`pipeline ${id} is ${pipeline?.status}; only a failed or canceled pipeline is retried`, 'not_retryable');
  return client.post(`/projects/${pid}/pipelines/${id}/retry`, { retries: 0 });
}

// --- errors ------------------------------------------------------------------------------------------------------------

/**
 * Sorts an error from this layer into what the caller should do:
 *   permission   401/403: the token lacks the right; fix the access, do not retry
 *   not_found    404: the project, merge request, job or pipeline does not exist, or the token cannot see it
 *   conflict     405/409/422: GitLab refused the change in its current state; read again before acting
 *   precondition a check in this layer refused the write before it was sent (err.check names the rule)
 *   transient    429, 5xx, timeout, network: a write may or may not have happened; read before repeating it
 *   bad_request  the caller passed a bad argument
 *   unknown      anything else
 */
export function classifyError(err) {
  if (!(err instanceof GitLabApiError)) return { kind: 'unknown', retryable: false };
  if (err.code === 'precondition') return { kind: 'precondition', retryable: false, check: err.check };
  if (err.code === 'rate_limited' || err.code === 'timeout' || err.code === 'network') return { kind: 'transient', retryable: true };
  if (err.code === 'bad_request' || err.code === 'bad_path' || err.code === 'bad_config') return { kind: 'bad_request', retryable: false };
  if (err.status === 401 || err.status === 403) return { kind: 'permission', retryable: false };
  if (err.status === 404) return { kind: 'not_found', retryable: false };
  if (err.status === 405 || err.status === 409 || err.status === 422) return { kind: 'conflict', retryable: false };
  if (err.status === 429 || (err.status >= 500 && err.status !== 501)) return { kind: 'transient', retryable: true };
  return { kind: 'unknown', retryable: false };
}

// --- configuration -----------------------------------------------------------------------------------------------------

/**
 * A client from the environment: GITLAB_URL, and the token from GITLAB_TOKEN or from the file GITLAB_TOKEN_FILE. A token file
 * must not be readable by group or others (mode 0600 or stricter). No error names the token or prints its value.
 */
export function clientFromEnv(env = process.env, options = {}) {
  const url = env.GITLAB_URL;
  if (!url) throw new GitLabApiError('GITLAB_URL is not set', { code: 'bad_config' });
  let token = env.GITLAB_TOKEN;
  if (!token && env.GITLAB_TOKEN_FILE) {
    let st;
    try { st = fs.statSync(env.GITLAB_TOKEN_FILE); } catch { throw new GitLabApiError('GITLAB_TOKEN_FILE cannot be read', { code: 'bad_config' }); }
    if ((st.mode & 0o077) !== 0) throw new GitLabApiError('GITLAB_TOKEN_FILE is readable by group or others; use mode 0600', { code: 'bad_config' });
    token = fs.readFileSync(env.GITLAB_TOKEN_FILE, 'utf8').trim();
  }
  if (!token) throw new GitLabApiError('set GITLAB_TOKEN or GITLAB_TOKEN_FILE', { code: 'bad_config' });
  return createClient({ ...options, baseUrl: url, token });
}

// --- webhooks ----------------------------------------------------------------------------------------------------------

// The X-Gitlab-Event value GitLab sends for each object_kind.
const EVENT_NAME_FOR_KIND = Object.freeze({
  merge_request: 'Merge Request Hook', pipeline: 'Pipeline Hook', push: 'Push Hook', tag_push: 'Tag Push Hook', job: 'Job Hook',
});

function headerOf(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

const digest = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest();

/**
 * Checks a GitLab webhook delivery. GitLab does not sign its deliveries: it sends the secret token set on the hook in the
 * X-Gitlab-Token header, in clear, over TLS. The header is compared with the configured secret in constant time (both are
 * hashed first, so the secret's length does not leak). Fails closed: a missing secret is a configuration error, never an
 * accepted delivery. Returns { ok: true, objectKind, eventName, uuid, payload } or { ok: false, reason } with one of the fixed
 * reasons missing_token, bad_token, bad_body, not_an_object, event_mismatch. Neither the token nor the header is returned.
 */
export function verifyWebhook({ headers, body, secret } = {}) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new GitLabApiError(`the webhook secret token is not configured (at least ${MIN_SECRET_LENGTH} characters); no delivery is accepted without it`, { code: 'bad_config' });
  }
  const given = headerOf(headers, 'x-gitlab-token');
  if (typeof given !== 'string' || given === '') return { ok: false, reason: 'missing_token' };
  // Equal digests and equal length: the length check is the one that matters, the digests make the comparison constant time.
  if (!crypto.timingSafeEqual(digest(given), digest(secret)) || given.length !== secret.length) return { ok: false, reason: 'bad_token' };
  let payload;
  try {
    const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : JSON.stringify(body ?? null);
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad_body' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.object_kind !== 'string') return { ok: false, reason: 'not_an_object' };
  const eventName = headerOf(headers, 'x-gitlab-event') ?? null;
  const expectedName = EVENT_NAME_FOR_KIND[payload.object_kind];
  if (eventName !== null && expectedName !== undefined && eventName !== expectedName) return { ok: false, reason: 'event_mismatch' };
  return { ok: true, objectKind: payload.object_kind, eventName, uuid: headerOf(headers, 'x-gitlab-event-uuid') ?? null, payload };
}

/**
 * Whether a delivery was seen before, by its X-Gitlab-Event-UUID. `seen` is any object with has(uuid) and add(uuid). A
 * delivery without a uuid cannot be recognised, so it is never reported as a duplicate; its handler must be idempotent instead.
 */
export function isDuplicateDelivery(seen, uuid) {
  if (!uuid) return false;
  if (seen.has(uuid)) return true;
  seen.add(uuid);
  return false;
}
