/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5, lane scm-webhook): GitLab webhook events → OASIS topics.
 *
 * Pure: no I/O, no clock. The route (routes/internal-gitlab-webhook.ts) verifies the signature first and calls
 * mapGitlabEvent() only for a body it has parsed. Five GitLab facts map to five new topics; everything else is
 * acknowledged and ignored. No existing `cicd.*` topic is reused: `cicd.merge.success` is the Command Hub's own
 * "merged" signal (board-adapter.ts turns it into a COMPLETED card), and a GitLab event must not complete a real VTID.
 * `autopilot-event-mapper.ts` has no rule for `scm.gitlab.*`, so no event mapped here moves a VTID's state.
 *
 *   merge_request  object_attributes.action  open | reopen  →  scm.gitlab.merge_request.opened
 *                                            merge          →  scm.gitlab.merge_request.merged
 *                                            close          →  scm.gitlab.merge_request.closed
 *   pipeline       object_attributes.status  success        →  scm.gitlab.pipeline.succeeded
 *                                            failed         →  scm.gitlab.pipeline.failed
 *
 * The VTID is the first `VTID-\d{5}` in the merge request title (merge_request events), or in `merge_request.title`
 * and then `commit.title` (pipeline events). An event without one is ignored: OASIS rows always carry a VTID.
 */
import type { CicdEventType } from '../../types/cicd';

export type GitlabTopic = Extract<
  CicdEventType,
  | 'scm.gitlab.merge_request.opened'
  | 'scm.gitlab.merge_request.merged'
  | 'scm.gitlab.merge_request.closed'
  | 'scm.gitlab.pipeline.succeeded'
  | 'scm.gitlab.pipeline.failed'
>;

/** The five topics, in table order (tests iterate over them). */
export const GITLAB_TOPICS: readonly GitlabTopic[] = [
  'scm.gitlab.merge_request.opened',
  'scm.gitlab.merge_request.merged',
  'scm.gitlab.merge_request.closed',
  'scm.gitlab.pipeline.succeeded',
  'scm.gitlab.pipeline.failed',
];

export type GitlabEventMapping =
  | {
      kind: 'emit';
      topic: GitlabTopic;
      vtid: string;
      status: 'info' | 'success' | 'error';
      message: string;
      payload: Record<string, unknown>;
    }
  | { kind: 'ignore'; reason: string };

const VTID_RE = /\bVTID-(\d{5})(?!\d)/;

/** The first `VTID-\d{5}` in the given texts, in order; a longer number is not a VTID. */
export function firstVtid(...texts: unknown[]): string | null {
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    const m = VTID_RE.exec(t);
    if (m) return `VTID-${m[1]}`;
  }
  return null;
}

const MR_ACTIONS: Record<string, GitlabTopic> = {
  open: 'scm.gitlab.merge_request.opened',
  reopen: 'scm.gitlab.merge_request.opened',
  merge: 'scm.gitlab.merge_request.merged',
  close: 'scm.gitlab.merge_request.closed',
};

const PIPELINE_STATUSES: Record<string, GitlabTopic> = {
  success: 'scm.gitlab.pipeline.succeeded',
  failed: 'scm.gitlab.pipeline.failed',
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const short = (s: string | null, n = 200): string | null => (s === null ? null : s.length > n ? `${s.slice(0, n)}…` : s);

function projectOf(body: Obj): { path: string | null; id: number | null } {
  const p = obj(body.project);
  return { path: str(p.path_with_namespace), id: num(p.id) };
}

/** Map one verified, parsed GitLab webhook body to an OASIS event, or say why it is ignored. */
export function mapGitlabEvent(body: unknown): GitlabEventMapping {
  const b = obj(body);
  const kind = str(b.object_kind);
  const attrs = obj(b.object_attributes);
  const project = projectOf(b);

  if (kind === 'merge_request') {
    const action = str(attrs.action);
    const topic = action ? MR_ACTIONS[action] : undefined;
    if (!topic) return { kind: 'ignore', reason: `merge_request action ${action ?? 'missing'} is not mapped` };
    const title = str(attrs.title);
    const vtid = firstVtid(title);
    if (!vtid) return { kind: 'ignore', reason: 'merge_request title names no VTID' };
    const iid = num(attrs.iid);
    const lastCommit = obj(attrs.last_commit);
    return {
      kind: 'emit',
      topic,
      vtid,
      status: action === 'merge' ? 'success' : 'info',
      message: `GitLab merge request ${project.path ?? '?'}!${iid ?? '?'} ${action}`,
      payload: {
        host: 'gitlab',
        project: project.path,
        project_id: project.id,
        iid,
        action,
        state: str(attrs.state),
        title: short(title),
        url: str(attrs.url),
        source_branch: str(attrs.source_branch),
        target_branch: str(attrs.target_branch),
        head_sha: str(lastCommit.id),
        merge_commit_sha: str(attrs.merge_commit_sha),
        updated_at: str(attrs.updated_at),
      },
    };
  }

  if (kind === 'pipeline') {
    const status = str(attrs.status);
    const topic = status ? PIPELINE_STATUSES[status] : undefined;
    if (!topic) return { kind: 'ignore', reason: `pipeline status ${status ?? 'missing'} is not mapped` };
    const mr = obj(b.merge_request);
    const commit = obj(b.commit);
    const vtid = firstVtid(str(mr.title), str(commit.title));
    if (!vtid) return { kind: 'ignore', reason: 'pipeline names no VTID (merge request title, then commit title)' };
    const id = num(attrs.id);
    return {
      kind: 'emit',
      topic,
      vtid,
      status: status === 'success' ? 'success' : 'error',
      message: `GitLab pipeline ${project.path ?? '?'} #${id ?? '?'} ${status}`,
      payload: {
        host: 'gitlab',
        project: project.path,
        project_id: project.id,
        pipeline_id: id,
        status,
        ref: str(attrs.ref),
        sha: str(attrs.sha),
        source: str(attrs.source),
        duration_s: num(attrs.duration),
        queued_duration_s: num(attrs.queued_duration),
        merge_request_iid: num(mr.iid),
        url: str(mr.url),
        finished_at: str(attrs.finished_at),
      },
    };
  }

  return { kind: 'ignore', reason: `event ${kind ?? 'without object_kind'} is not mapped` };
}
