# GitLab operations: interface contract (VTID-05801)

Status: published with the lane branch `claude/gitlab-client-hardening/gitlab-client-hardening` (GitLab `vitana/vitana-platform`).
Consumers: the DeliveryProvider (Session 2) and the CI and runner work (Session 3). Both take GitLab through these two modules
and no other client.

- `scripts/eng/gitlab-api.mjs`: the HTTP client. Use it only for a call that no operation below covers.
- `scripts/eng/gitlab-ops.mjs`: the operations. Use these first.

Nothing else may create a GitLab client, call the GitLab API with `fetch`, or read a GitLab token. Existing consumers
(`gitlab-land.mjs`, `gitlab-settings.mjs`, `rehearse.mjs`, `ci-metrics.mjs`) already use `createClient`. The GitHub bridge
(`github-bridge.mjs`) has its own `fetchInto` for GitLab refs. It is a second transport and should move onto the client;
that change belongs to its lane, not this one.

## 1. Configuration and client

```js
import { clientFromEnv } from './gitlab-ops.mjs';
// A client with explicit options (tests, a custom timeout) comes from ./gitlab-api.mjs: createClient({ baseUrl, token, ... }).
const client = clientFromEnv(process.env);
```

| Variable | Meaning |
|---|---|
| `GITLAB_URL` | Base URL, `https://` only (plain `http://` is allowed for localhost). No credentials, query or fragment. |
| `GITLAB_TOKEN` | Token value. Use only where a secret store injects it into the process environment. |
| `GITLAB_TOKEN_FILE` | Path to a file holding the token. The file must be mode `0600` or stricter, or the client refuses it. |

The token is sent only in the `PRIVATE-TOKEN` header, only to the configured origin, only under `/api/v4`. It is never put in a
URL, a query, an error, a log line or a result. Redirects are not followed.

## 2. Identifiers

- **Project:** a numeric id (`2`) or a path (`vitana/vitana-platform`). A path is resolved once per client with
  `resolveProject`, and GitLab's answer must carry the same `path_with_namespace`, or the call is refused (`check: wrong_project`).
- **Merge request:** always the **iid** (the `!7` number), never a global id. Every merge request read is checked against the
  project (`target_project_id`), so an iid from another project is refused.
- **Branches:** the **source** and **target** names are checked before every write (`expect`, `expectedHeadSha`).
- **Commits:** a full 40-character lowercase SHA. A short SHA or a ref name is refused for merges.

## 3. Operations

All functions take `client` first. Every function is `async`, returns plain JSON objects (GitLab's field names unchanged),
and throws a `GitLabApiError` on failure. A failure is never reported as success.

### Reads

| Function | Returns |
|---|---|
| `resolveProject(client, project)` | `number` (the project id) |
| `getMergeRequest(client, project, iid)` | the merge request object, checked to belong to the project |
| `mergeStatus(mr)` | `{ iid, state, sourceBranch, targetBranch, headSha, detailedMergeStatus, pipelineId, pipelineStatus, mergeable, blockers[] }`. Pure: no call. |
| `findMergeRequestBySource(client, project, branch, { targetBranch='main' })` | the one open merge request from `branch`, or `null`; throws `ambiguous` if there are two |
| `listPipelineJobs(client, project, pipelineId, { scope? })` | every job, all pages |
| `failedJobs(client, project, pipelineId)` | the failed jobs of a pipeline |
| `getJobLog(client, project, jobId, { maxBytes=2000000 })` | `{ jobId, log }`; a larger log is refused, not truncated |
| `getPipeline(client, project, pipelineId)` | the pipeline object |

### Merge requests (writes)

| Function | Behaviour | Returns |
|---|---|---|
| `createMergeRequest(client, project, { sourceBranch, targetBranch='main', title, description='', removeSourceBranch=false, draft=false })` | **Idempotent.** Returns the open merge request from the same source if one exists, and posts nothing. A 409 on create returns the existing one. Sent once (no retry on 5xx). `draft: true` prefixes `Draft: `. | `{ created: boolean, mr }` |
| `updateMergeRequest(client, project, iid, { title?, description?, targetBranch?, draft?, expect })` | `expect.sourceBranch` is **required**; `expect.targetBranch` optional. Refused with no write if the merge request does not match or is not open. | the updated merge request |
| `safeMerge(client, project, iid, { expectedHeadSha, sourceBranch, targetBranch='main', removeSourceBranch=false, squash=true, mergeMessage? })` | Merges only if: source and target match; the head equals `expectedHeadSha`; the merge request is open, not a draft, `mergeable`, and its head pipeline is `success`. Sent **once**. After a failure the merge request is re-read: a merge that did complete is reported as merged. | `{ merged: true, iid, mergeCommitSha, alreadyMerged }` |

### Pipelines and jobs (writes)

| Function | Behaviour | Returns |
|---|---|---|
| `triggerPipeline(client, project, { ref, variables? })` | Sent **once**. A repeated call starts a second pipeline, so after a timeout or 5xx, list the pipelines for the ref first. Variable names and values that look like credentials are refused. | the pipeline object |
| `retryJob(client, project, jobId)` | Only from `failed` or `canceled`; otherwise `precondition` (`not_retryable`). Sent once. | the new job |
| `retryPipeline(client, project, pipelineId)` | Only from `failed` or `canceled`. Sent once. | the new pipeline |

### Webhooks

| Function | Behaviour |
|---|---|
| `verifyWebhook({ headers, body, secret })` | Returns `{ ok: true, objectKind, eventName, uuid, payload }` or `{ ok: false, reason }`. `reason` is one of `missing_token`, `bad_token`, `bad_body`, `not_an_object`, `event_mismatch`. Throws `bad_config` if `secret` is missing or shorter than 8 characters. |
| `isDuplicateDelivery(seen, uuid)` | `seen` has `has(uuid)` and `add(uuid)`. Returns `true` on a repeat. A delivery with no uuid is never a duplicate: its handler must be idempotent. |

**Authentication mechanism.** GitLab does not sign webhook deliveries. The hook is configured with a *secret token*, and GitLab
sends it in the `X-Gitlab-Token` header, in clear, over TLS. `verifyWebhook` compares it with the configured secret in constant
time. Respond `401` to any `ok: false` delivery and do not run the handler. Respond with a 2xx only after the handler has
recorded the event, so that GitLab's retry is not lost. Use `X-Gitlab-Event-UUID` with `isDuplicateDelivery` to skip repeats.

## 4. Errors

Every error is a `GitLabApiError` with `code`, `status`, `method`, `path`, `attempts`. Pass any error to `classifyError(err)`:

| `kind` | Meaning | Caller should |
|---|---|---|
| `permission` | 401 or 403 | Stop. The token lacks the right. Do not retry. |
| `not_found` | 404 | Treat the object as absent, or as not visible to this token. |
| `conflict` | 405, 409, 422 | GitLab refused the change in its current state. Read the object again, then decide. |
| `precondition` | A check in this layer refused the write **before** it was sent. `err.check` names the rule: `wrong_project`, `wrong_source`, `wrong_target`, `head_moved`, `not_mergeable`, `not_open`, `not_retryable`, `merge_not_confirmed`. | Read the object and report the reason. Nothing was sent. |
| `transient` | 429, 5xx, timeout, network. The write **may or may not** have happened. | Read the resource before repeating an action. Do not repeat a trigger, merge or retry blindly. |
| `bad_request` | A bad argument, or a credential in a path, query or variable. | Fix the caller. |
| `unknown` | Anything else. | Treat as a failure. |

## 5. Retries, timeouts, rate limits, pagination

- **Retries** (done by the client): up to 4 by default, exponential back-off with jitter. GET, HEAD, PUT and DELETE are retried
  on 5xx, network errors and timeouts. POST and PATCH are retried **only on 429**, which GitLab sends before processing. Every
  action in this layer passes `retries: 0` where a repeat would be unsafe.
- **Rate limits:** 429 and 503 honour `Retry-After`. A wait longer than `maxDelayMs` (30 s) is not slept through: the call
  fails with `code: 'rate_limited'` and `retryAfterMs`.
- **Timeouts:** 30 s per request by default (`timeoutMs`). A timeout is an error (`code: 'timeout'`), never a hang.
- **Body size:** 16 MiB per response by default (`maxBodyBytes`); a larger body is refused.
- **Pagination:** `client.paginate(path, { query })` follows `X-Next-Page`, then the `Link` header. It returns every item.
  A pagination link to another origin or path is refused. Operations that list (`findMergeRequestBySource`,
  `listPipelineJobs`, `failedJobs`) use it and need no paging code from the caller.

## 6. Examples

```js
import { clientFromEnv, resolveProject, findMergeRequestBySource, createMergeRequest,
         getMergeRequest, mergeStatus, safeMerge, triggerPipeline, retryJob,
         verifyWebhook, isDuplicateDelivery, classifyError } from './scripts/eng/gitlab-ops.mjs';

const client = clientFromEnv(process.env);
const PROJECT = 'vitana/vitana-platform';

// Open (or reuse) a merge request for a lane branch; a second call creates no second one.
const { mr, created } = await createMergeRequest(client, PROJECT, {
  sourceBranch: 'claude/gitlab-client-hardening/gitlab-client-hardening',
  title: 'VTID-05801 GitLab operations', draft: true,
});

// Merge only the head that was reviewed. Any precondition failure throws before the merge is sent.
try {
  const done = await safeMerge(client, PROJECT, mr.iid, {
    expectedHeadSha: reviewedSha, sourceBranch: mr.source_branch, targetBranch: 'main', removeSourceBranch: true,
  });
  console.log(done.mergeCommitSha);
} catch (err) {
  const c = classifyError(err);
  if (c.kind === 'precondition') console.log('not merged:', err.check);
  else if (c.kind === 'transient') console.log('outcome unknown; read the merge request before retrying');
  else throw err;
}

// A webhook handler (any HTTP framework; `req.headers` and the raw body string)
const verdict = verifyWebhook({ headers: req.headers, body: rawBody, secret: process.env.GITLAB_WEBHOOK_SECRET });
if (!verdict.ok) return respond(401);
if (isDuplicateDelivery(seenUuids, verdict.uuid)) return respond(200);
handle(verdict.payload);
return respond(200);
```

## 7. Security rules for callers

- Never print, log or store a token, a webhook secret or a response body that might contain one. The client redacts what it
  knows, but a caller that logs its own input defeats that.
- Never put a credential in a path, a query, a pipeline variable or a commit message. The client refuses these, but a caller
  should not try them.
- Pass the project and the iid together with the expected branches; never act on an iid from a webhook without checking the
  project id of the payload.
- A write from a webhook handler is idempotent, or it checks the resource first (see the examples above).

## 8. Versioning

This contract changes only in an additive way without a new VTID. A removed or renamed function, or a changed error `kind`,
needs a new plan and the consumers' agreement, recorded in their lane files.
