/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5): GitLab project-webhook payload → OASIS event.
 *
 * Pure: no I/O. The route (routes/internal-gitlab-webhook.ts) verifies the signature first and calls
 * this with the parsed body of a verified delivery.
 *
 *   GitLab event     object_attributes value       OASIS topic
 *   merge_request    action = open | reopen        scm.gitlab.merge_request.opened
 *   merge_request    action = merge                scm.gitlab.merge_request.merged
 *   merge_request    action = close                scm.gitlab.merge_request.closed
 *   pipeline         status = success              scm.gitlab.pipeline.succeeded
 *   pipeline         status = failed               scm.gitlab.pipeline.failed
 *
 * Every other event, action or status is ignored. The event kind comes from the signed body
 * (`object_kind`), never from the X-Gitlab-Event header, which the signature does not cover.
 *
 * The VTID is the first whole VTID-\d{5} of the merge request title (merge_request events), or of
 * merge_request.title and then commit.title (pipeline events). No VTID → ignored.
 *
 * Why these statuses and stages (no existing topic is reused, and the VTID lifecycle mapper
 * autopilot-event-mapper.ts has no scm.gitlab.* rule, so no GitLab event moves a VTID):
 *   - scm.gitlab.pipeline.failed is status 'warning', never 'error': the lifecycle mapper's catch-all
 *     rule matches any `*.failed` topic whose status is 'error' and would move the VTID to failed.
 *   - The merge request topics are status 'info' and carry task_stage 'VALIDATOR'. Without an explicit
 *     stage, emitOasisEvent infers DEPLOY from the word "merge" in the topic, and the VTID list
 *     projection (routes/vtid.ts) shows a non-terminal VTID in the Deploy stage whose latest event
 *     says "merged" as Done. The pipeline topics get no stage (the inference gives none).
 *
 * The OASIS payload carries ids, refs, shas, statuses and URLs only: never the description, the user,
 * labels, assignees, changes, pipeline variables or builds of the GitLab payload.
 */
import type { CicdEventType, CicdOasisEvent } from '../../types/cicd';

export const GITLAB_OASIS_TOPICS = {
  mergeRequestOpened: 'scm.gitlab.merge_request.opened',
  mergeRequestMerged: 'scm.gitlab.merge_request.merged',
  mergeRequestClosed: 'scm.gitlab.merge_request.closed',
  pipelineSucceeded: 'scm.gitlab.pipeline.succeeded',
  pipelineFailed: 'scm.gitlab.pipeline.failed',
} as const satisfies Record<string, CicdEventType>;

export type GitlabOasisTopic = (typeof GITLAB_OASIS_TOPICS)[keyof typeof GITLAB_OASIS_TOPICS];

/** The `service` column of every row this route writes. */
export const GITLAB_EVENT_SOURCE = 'gitlab-webhook';

/** Longest string copied from a GitLab payload into an OASIS event. */
export const MAX_FIELD_CHARS = 512;

export type GitlabIgnoreReason = 'unknown_event' | 'unmapped_action' | 'unmapped_status' | 'no_vtid';

export type GitlabMapping =
  | { kind: 'emit'; event: CicdOasisEvent & { type: GitlabOasisTopic } }
  | { kind: 'ignore'; reason: GitlabIgnoreReason };

const MERGE_REQUEST_ACTIONS: Record<string, { topic: GitlabOasisTopic; verb: string }> = {
  open: { topic: GITLAB_OASIS_TOPICS.mergeRequestOpened, verb: 'opened' },
  reopen: { topic: GITLAB_OASIS_TOPICS.mergeRequestOpened, verb: 'reopened' },
  merge: { topic: GITLAB_OASIS_TOPICS.mergeRequestMerged, verb: 'merged' },
  close: { topic: GITLAB_OASIS_TOPICS.mergeRequestClosed, verb: 'closed' },
};

const PIPELINE_STATUSES: Record<string, { topic: GitlabOasisTopic; verb: string; status: CicdOasisEvent['status'] }> = {
  success: { topic: GITLAB_OASIS_TOPICS.pipelineSucceeded, verb: 'succeeded', status: 'success' },
  failed: { topic: GITLAB_OASIS_TOPICS.pipelineFailed, verb: 'failed', status: 'warning' },
};

const VTID_RE = /\bVTID-\d{5}\b/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function obj(v: unknown): Obj {
  return isObj(v) ? v : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v.slice(0, MAX_FIELD_CHARS) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function own<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The first whole VTID-\d{5} in the first text that has one. */
export function firstVtid(...texts: unknown[]): string | null {
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    const m = VTID_RE.exec(t);
    if (m) return m[0];
  }
  return null;
}

export function mapGitlabEvent(payload: unknown, webhookId: string): GitlabMapping {
  if (!isObj(payload)) return { kind: 'ignore', reason: 'unknown_event' };
  const attrs = obj(payload.object_attributes);
  const project = obj(payload.project);
  const projectId = num(project.id);
  const projectPath = str(project.path_with_namespace);
  const where = projectPath ? `in ${projectPath}` : 'in an unknown project';
  const id = webhookId.slice(0, MAX_FIELD_CHARS);

  if (payload.object_kind === 'merge_request') {
    const mapped = own(MERGE_REQUEST_ACTIONS, attrs.action);
    if (!mapped) return { kind: 'ignore', reason: 'unmapped_action' };
    const vtid = firstVtid(attrs.title);
    if (!vtid) return { kind: 'ignore', reason: 'no_vtid' };
    const iid = num(attrs.iid);
    return {
      kind: 'emit',
      event: {
        vtid,
        type: mapped.topic,
        source: GITLAB_EVENT_SOURCE,
        status: 'info',
        message: `GitLab merge request !${iid ?? '?'} ${mapped.verb} ${where}`,
        task_stage: 'VALIDATOR',
        payload: {
          gitlab_event: 'merge_request',
          webhook_id: id,
          action: str(attrs.action),
          project_id: projectId,
          project_path: projectPath,
          merge_request_iid: iid,
          state: str(attrs.state),
          source_branch: str(attrs.source_branch),
          target_branch: str(attrs.target_branch),
          head_sha: str(obj(attrs.last_commit).id),
          merge_commit_sha: str(attrs.merge_commit_sha),
          url: str(attrs.url),
        },
      },
    };
  }

  if (payload.object_kind === 'pipeline') {
    const mapped = own(PIPELINE_STATUSES, attrs.status);
    if (!mapped) return { kind: 'ignore', reason: 'unmapped_status' };
    const mr = obj(payload.merge_request);
    const vtid = firstVtid(mr.title, obj(payload.commit).title);
    if (!vtid) return { kind: 'ignore', reason: 'no_vtid' };
    const pipelineId = num(attrs.id);
    const ref = str(attrs.ref);
    return {
      kind: 'emit',
      event: {
        vtid,
        type: mapped.topic,
        source: GITLAB_EVENT_SOURCE,
        status: mapped.status,
        message: `GitLab pipeline ${pipelineId ?? '?'} ${mapped.verb} on ${ref ?? 'an unknown ref'} ${where}`,
        payload: {
          gitlab_event: 'pipeline',
          webhook_id: id,
          status: str(attrs.status),
          project_id: projectId,
          project_path: projectPath,
          pipeline_id: pipelineId,
          ref,
          sha: str(attrs.sha),
          source: str(attrs.source),
          merge_request_iid: num(mr.iid),
          duration_s: num(attrs.duration),
          url: str(attrs.url),
        },
      },
    };
  }

  return { kind: 'ignore', reason: 'unknown_event' };
}
