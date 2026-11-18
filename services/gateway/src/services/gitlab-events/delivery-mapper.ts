/**
 * VTID-05547 (plan agentic-delivery §3.11): GitLab project-webhook payload → the delivery OASIS events.
 *
 * Builds on mapper.ts (VTID-05541, plan eng-gitlab-m2 §3.5), which stays as it is: its five topics and
 * its payloads are pinned by its own tests. This layer adds to them what the cut needs, and the one
 * delivery can now produce several events (a push: the push, its review entries, its lane-file changes;
 * a pipeline on main: the pipeline, the landing, the staging deploy).
 *
 *   GitLab object_kind   what                                              OASIS topic
 *   merge_request        open | reopen | merge | close  (mapper.ts)        scm.gitlab.merge_request.opened | .merged | .closed
 *                        update, queue label changed or new head           scm.gitlab.merge_request.updated
 *                        open | reopen with a "Moved from <PR URL>" line   scm.migration.pr_moved
 *   pipeline             running | success | failed | canceled             scm.gitlab.pipeline.started | .succeeded | .failed | .canceled
 *                        on main, a squash commit with a Merge-Request:    delivery.landed
 *                        trailer (running | success | failed)
 *                        on main, the deploy-staging job success | failed  staging.deploy.completed | .failed   (live only)
 *                        on main, the rollback-staging job success         staging.deploy.rolled_back           (live only)
 *   push                 to kiro/*, claude/*, assist/*, pm-agent/*         scm.gitlab.push
 *                        a commit with a Collab-Verdict trailer            delivery.review.recorded
 *                        a commit that changes .kiro/specs/<s>/lanes/<l>.md  delivery.lane.updated
 *   tag_push             refs/tags/delivery/cutover-<repo>                 scm.migration.cutover
 *
 * Every event carries payload.dedupe_key (host, project, object, id, state), plane 'delivery', host
 * 'gitlab', mode 'shadow' | 'live' and repo (the project's last path segment). Readers keep the first row
 * per key.
 *
 * VTID: the first whole VTID-\d{5} of the merge request title (merge_request events), of the merge
 * request title and then the commit title (pipeline events, the rule STAGING-VERIFY uses), of the branch's
 * merge request (push events: this task's index, then an injected OASIS lookup, then the commit titles).
 * Facts that have none (a nightly run, a cut tag) use BOOTSTRAP-DELIVERY.
 *
 * mode: a run is 'shadow' when its pipeline carries DELIVERY_MODE=shadow, or when this gateway does not
 * yet deliver the project's repository on GitLab (DELIVERY_HOST_<REPO> not "gitlab", delivery-host.ts);
 * otherwise 'live'. A shadow run writes no staging.deploy.* and no delivery.landed: until the cut GitHub
 * is the only writer of deploy and verification rows (plan §3.6 step 8).
 *
 * Statuses: no topic ending in .failed or .error is ever written with status 'error', because the
 * lifecycle mapper's catch-all (autopilot-event-mapper.ts) would move the VTID to failed. No rule of
 * that file lists any of these topics.
 *
 * The OASIS payload carries ids, refs, shas, statuses, durations, job names and URLs, and the values of
 * named trailers. Never a description, a user, labels other than the queue label, the changes, pipeline
 * variables or the raw builds of the GitLab payload.
 */
import type { CicdEventType, CicdOasisEvent } from '../../types/cicd';
import { DELIVERY_VTID, deliveryHostFor, repoShortName } from '../delivery-host';
import { GITLAB_EVENT_SOURCE, MAX_FIELD_CHARS, firstVtid, mapGitlabEvent, type GitlabIgnoreReason } from './mapper';

export const DELIVERY_TOPICS = {
  mergeRequestUpdated: 'scm.gitlab.merge_request.updated',
  push: 'scm.gitlab.push',
  pipelineStarted: 'scm.gitlab.pipeline.started',
  pipelineSucceeded: 'scm.gitlab.pipeline.succeeded',
  pipelineFailed: 'scm.gitlab.pipeline.failed',
  pipelineCanceled: 'scm.gitlab.pipeline.canceled',
  prMoved: 'scm.migration.pr_moved',
  cutover: 'scm.migration.cutover',
  reviewRecorded: 'delivery.review.recorded',
  laneUpdated: 'delivery.lane.updated',
  landed: 'delivery.landed',
  stagingDeployCompleted: 'staging.deploy.completed',
  stagingDeployFailed: 'staging.deploy.failed',
  stagingDeployRolledBack: 'staging.deploy.rolled_back',
} as const satisfies Record<string, CicdEventType>;

export type DeliveryMode = 'shadow' | 'live';

export interface DeliveryEventPayload extends Record<string, unknown> {
  plane: 'delivery';
  host: 'gitlab';
  mode: DeliveryMode;
  dedupe_key: string;
  repo: string | null;
}
export type DeliveryEvent = Omit<CicdOasisEvent, 'payload'> & { payload: DeliveryEventPayload };

export type DeliveryIgnoreReason = GitlabIgnoreReason | 'unmapped_ref';
export type DeliveryMapping =
  | { kind: 'emit'; events: DeliveryEvent[] }
  | { kind: 'ignore'; reason: DeliveryIgnoreReason };

/** The two repositories that cut over; any other project (a rehearsal) is always 'shadow'. */
export const DELIVERY_REPOS: readonly string[] = ['vitana-platform', 'vitana-v1'];

/** Branches pushed by agents; only these produce scm.gitlab.push. */
export const AGENT_BRANCH_RE = /^(kiro|claude|assist|pm-agent)\//;

/** At most this many commits of one push, jobs of one pipeline and events of one delivery are looked at. */
export const MAX_COMMITS = 20;
export const MAX_JOBS = 100;
export const MAX_EVENTS = 100;

export const LANDING_TRAILER_KEYS = ['Merge-Request', 'Source-Branch', 'Reviewed-Head', 'Review-Verdict', 'Reviewer', 'Accepted-At'] as const;
export const REVIEW_TRAILER_KEYS = ['Collab-Session', 'Collab-Lane', 'Collab-Review', 'Collab-Verdict', 'Collab-Reviewer', 'Collab-Reviewed-Head'] as const;

// ---------------------------------------------------------------------------------------------------------
// Branch → VTID (a push has no merge request in its payload)
// ---------------------------------------------------------------------------------------------------------

export interface BranchVtidIndex {
  remember(project: string | null, branch: string, vtid: string): void;
  get(project: string | null, branch: string): string | null;
}

/** In memory, per gateway task, bounded; the oldest branch is dropped first. */
export class MemoryBranchVtidIndex implements BranchVtidIndex {
  private readonly map = new Map<string, string>();
  constructor(private readonly max = 5000) {}
  private static key(project: string | null, branch: string): string {
    return `${project ?? ''}\u0000${branch}`;
  }
  remember(project: string | null, branch: string, vtid: string): void {
    const k = MemoryBranchVtidIndex.key(project, branch);
    this.map.delete(k);
    this.map.set(k, vtid);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get(project: string | null, branch: string): string | null {
    return this.map.get(MemoryBranchVtidIndex.key(project, branch)) ?? null;
  }
  size(): number {
    return this.map.size;
  }
}

/** Looks a branch's VTID up where this task's index has none (the OASIS rows of its merge request). Never throws. */
export type BranchVtidLookup = (project: string | null, branch: string) => Promise<string | null>;

const sharedBranchIndex = new MemoryBranchVtidIndex();

export interface DeliveryMapOptions {
  env?: NodeJS.ProcessEnv;
  branches?: BranchVtidIndex;
  lookupBranchVtid?: BranchVtidLookup;
}

// ---------------------------------------------------------------------------------------------------------
// Small readers (the payload is untrusted: every field may be missing or the wrong type)
// ---------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const str = (v: unknown, max = MAX_FIELD_CHARS): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const own = <T>(table: Record<string, T>, key: unknown): T | undefined =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** The value of the LAST "Key: value" line of a commit message for each wanted key (exact key, whole line). */
export function parseTrailers<K extends string>(message: unknown, keys: readonly K[]): Record<K, string | null> {
  const out = Object.fromEntries(keys.map((k) => [k, null])) as Record<K, string | null>;
  if (typeof message !== 'string') return out;
  for (const line of message.slice(0, 20000).split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(\S.*?)\s*$/.exec(line);
    if (m && (keys as readonly string[]).includes(m[1])) out[m[1] as K] = m[2].slice(0, MAX_FIELD_CHARS);
  }
  return out;
}

const QUEUE_LABEL_RE = /^queue-(ready|updating|waiting|blocked|paused)$/;

/** The queue-* label (plan §3.5) among a GitLab labels array ([{title}] or [string]); null when none. */
export function queueLabel(labels: unknown): string | null {
  for (const l of arr(labels)) {
    const title = typeof l === 'string' ? l : str(obj(l).title);
    if (title && QUEUE_LABEL_RE.test(title)) return title;
  }
  return null;
}

const LANE_KEY_RE = /\bVTID-\d{5}\s*\(([a-z0-9][a-z0-9-]*\/_?[a-z0-9][a-z0-9-]*)\)/i;
const PLAIN_LANE_KEY_RE = /^[a-z0-9][a-z0-9-]*\/_?[a-z0-9][a-z0-9-]*$/i;

/** "VTID-05547 (agentic-delivery/gateway-delivery): …" → "agentic-delivery/gateway-delivery". */
export function laneKeyOf(title: unknown): string | null {
  return typeof title === 'string' ? (LANE_KEY_RE.exec(title)?.[1] ?? null) : null;
}

const LANE_FILE_RE = /^\.kiro\/specs\/([a-z0-9][a-z0-9-]*)\/lanes\/(_?[a-z0-9][a-z0-9-]*)\.md$/;
const MOVED_FROM_RE = /^Moved from (https:\/\/github\.com\/exafyltd\/(vitana-platform|vitana-v1)\/pull\/(\d+))[ \t]*$/m;
const DEPLOY_JOB_RE = /^deploy-staging(?:[:\-_/ ]+(.+))?$/;
const ROLLBACK_JOB_RE = /^rollback-staging(?:[:\-_/ ]+(.+))?$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA_RE = /^0+$/;

function reviewerModel(reviewer: string | null): string | null {
  return reviewer ? (/\(([^()]+)\)\s*$/.exec(reviewer)?.[1] ?? null) : null;
}

function secondsBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const s = Math.round((b - a) / 1000);
  return s >= 0 ? s : null;
}

// ---------------------------------------------------------------------------------------------------------
// Mode and event construction
// ---------------------------------------------------------------------------------------------------------

interface Ctx {
  id: string;
  env: NodeJS.ProcessEnv;
  projectId: number | null;
  projectPath: string | null;
  repo: string | null;
  /** Prefix of every dedupe key: the project path, or its id. */
  scope: string;
  where: string;
}

function makeCtx(payload: Obj, webhookId: string, env: NodeJS.ProcessEnv): Ctx {
  const project = obj(payload.project);
  const projectId = num(project.id);
  const projectPath = str(project.path_with_namespace);
  return {
    id: webhookId.slice(0, MAX_FIELD_CHARS),
    env,
    projectId,
    projectPath,
    repo: repoShortName(projectPath),
    scope: projectPath ?? (projectId !== null ? `project-${projectId}` : 'unknown-project'),
    where: projectPath ? `in ${projectPath}` : 'in an unknown project',
  };
}

/** 'shadow' when the pipeline says so, or when this gateway does not deliver the repository on GitLab yet. */
export function modeFor(ctx: Pick<Ctx, 'repo' | 'env'>, pipelineVariables?: unknown): DeliveryMode {
  for (const v of arr(pipelineVariables)) {
    const o = obj(v);
    if (o.key === 'DELIVERY_MODE' && typeof o.value === 'string' && o.value.trim().toLowerCase() === 'shadow') return 'shadow';
  }
  return ctx.repo !== null && DELIVERY_REPOS.includes(ctx.repo) && deliveryHostFor(ctx.repo, ctx.env) === 'gitlab' ? 'live' : 'shadow';
}

interface Spec {
  vtid: string;
  type: CicdEventType;
  status: CicdOasisEvent['status'];
  message: string;
  key: string;
  payload: Obj;
  task_stage?: CicdOasisEvent['task_stage'];
}

function build(ctx: Ctx, mode: DeliveryMode, s: Spec): DeliveryEvent {
  return {
    vtid: s.vtid,
    type: s.type,
    source: GITLAB_EVENT_SOURCE,
    status: s.status,
    message: s.message,
    ...(s.task_stage ? { task_stage: s.task_stage } : {}),
    payload: { ...s.payload, repo: ctx.repo, plane: 'delivery', host: 'gitlab', mode, dedupe_key: s.key },
  };
}

/** The event of mapper.ts, kept as it is, plus the delivery fields. */
function enrich(ctx: Ctx, mode: DeliveryMode, event: CicdOasisEvent, extra: Obj, key: string): DeliveryEvent {
  return { ...event, payload: { ...(event.payload ?? {}), ...extra, repo: ctx.repo, plane: 'delivery', host: 'gitlab', mode, dedupe_key: key } };
}

// ---------------------------------------------------------------------------------------------------------
// merge_request
// ---------------------------------------------------------------------------------------------------------

function mapMergeRequest(payload: Obj, ctx: Ctx, branches: BranchVtidIndex): DeliveryMapping {
  const attrs = obj(payload.object_attributes);
  const action = typeof attrs.action === 'string' ? attrs.action : '';
  const iid = num(attrs.iid);
  const vtid = firstVtid(attrs.title);
  const sourceBranch = str(attrs.source_branch);
  const updatedAt = str(attrs.updated_at);
  const headSha = str(obj(attrs.last_commit).id);
  const laneKey = laneKeyOf(attrs.title);
  const queue = queueLabel(payload.labels);
  const mode = modeFor(ctx);
  const stamp = updatedAt ?? headSha ?? '';
  const mrKey = (state: string) => `gitlab:${ctx.scope}:merge_request:${iid ?? '?'}:${state}:${stamp}`;

  if (vtid && sourceBranch) branches.remember(ctx.projectPath, sourceBranch, vtid);

  const events: DeliveryEvent[] = [];
  const base = mapGitlabEvent(payload, ctx.id);
  let reason: DeliveryIgnoreReason = base.kind === 'ignore' ? base.reason : 'unmapped_action';

  if (base.kind === 'emit') {
    events.push(enrich(ctx, mode, base.event, { lane_key: laneKey, queue_label: queue }, mrKey(action)));
  } else if (action === 'update') {
    const changes = obj(payload.changes);
    const labelChange = isObj(changes.labels) ? changes.labels : null;
    const previousQueue = labelChange ? queueLabel(labelChange.previous) : null;
    const currentQueue = labelChange ? queueLabel(labelChange.current) : queue;
    const queueChanged = labelChange !== null && previousQueue !== currentQueue;
    const previousHead = str(attrs.oldrev);
    if (queueChanged || previousHead) {
      if (!vtid) {
        reason = 'no_vtid';
      } else {
        events.push(
          build(ctx, mode, {
            vtid,
            type: DELIVERY_TOPICS.mergeRequestUpdated,
            status: 'info',
            // The word "merge" in the topic would otherwise infer the Deploy stage (emitOasisEvent); same as mapper.ts.
            task_stage: 'VALIDATOR',
            message: `GitLab merge request !${iid ?? '?'} updated ${ctx.where}`,
            key: mrKey('updated'),
            payload: {
              gitlab_event: 'merge_request',
              webhook_id: ctx.id,
              action: 'update',
              project_id: ctx.projectId,
              project_path: ctx.projectPath,
              merge_request_iid: iid,
              state: str(attrs.state),
              source_branch: sourceBranch,
              target_branch: str(attrs.target_branch),
              head_sha: headSha,
              merge_commit_sha: str(attrs.merge_commit_sha),
              url: str(attrs.url),
              lane_key: laneKey,
              queue_label: currentQueue,
              queue_label_previous: previousQueue,
              new_head: previousHead !== null,
              previous_head_sha: previousHead,
            },
          }),
        );
      }
    }
  }

  if (action === 'open' || action === 'reopen') {
    const moved = MOVED_FROM_RE.exec(typeof attrs.description === 'string' ? attrs.description.slice(0, 20000) : '');
    if (moved) {
      events.push(
        build(ctx, mode, {
          vtid: vtid ?? DELIVERY_VTID,
          type: DELIVERY_TOPICS.prMoved,
          status: 'info',
          message: `GitHub ${moved[2]} pull request #${moved[3]} moved to GitLab merge request !${iid ?? '?'}`,
          key: `gitlab:${ctx.scope}:pr_moved:${iid ?? '?'}:${moved[3]}`,
          payload: {
            gitlab_event: 'merge_request',
            webhook_id: ctx.id,
            project_id: ctx.projectId,
            project_path: ctx.projectPath,
            merge_request_iid: iid,
            github_pr_url: moved[1],
            github_repo: moved[2],
            github_pr_number: Number(moved[3]),
            url: str(attrs.url),
          },
        }),
      );
    }
  }

  return events.length > 0 ? { kind: 'emit', events } : { kind: 'ignore', reason };
}

// ---------------------------------------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------------------------------------

const PIPELINE_STATUSES: Record<string, { topic: CicdEventType; verb: string; status: CicdOasisEvent['status'] }> = {
  running: { topic: DELIVERY_TOPICS.pipelineStarted, verb: 'started', status: 'info' },
  success: { topic: DELIVERY_TOPICS.pipelineSucceeded, verb: 'succeeded', status: 'success' },
  failed: { topic: DELIVERY_TOPICS.pipelineFailed, verb: 'failed', status: 'warning' },
  canceled: { topic: DELIVERY_TOPICS.pipelineCanceled, verb: 'canceled', status: 'info' },
};

export interface JobSummary {
  name: string | null;
  stage: string | null;
  status: string | null;
  wait_s: number | null;
  run_s: number | null;
}

/** Each job's name, status, wait and run seconds. Nothing else of the GitLab builds. */
export function jobsOf(builds: unknown): JobSummary[] {
  return arr(builds)
    .filter(isObj)
    .slice(0, MAX_JOBS)
    .map((b) => ({ name: str(b.name), stage: str(b.stage), status: str(b.status), wait_s: num(b.queued_duration), run_s: num(b.duration) }));
}

function mapPipeline(payload: Obj, ctx: Ctx): DeliveryMapping {
  const attrs = obj(payload.object_attributes);
  const mapped = own(PIPELINE_STATUSES, attrs.status);
  if (!mapped) return { kind: 'ignore', reason: 'unmapped_status' };
  const status = attrs.status as string;
  const mr = obj(payload.merge_request);
  const commit = obj(payload.commit);
  const vtid = firstVtid(mr.title, commit.title) ?? DELIVERY_VTID;
  const mode = modeFor(ctx, attrs.variables);
  const pipelineId = num(attrs.id);
  const ref = str(attrs.ref);
  const sha = str(attrs.sha);
  const url = str(attrs.url);
  const jobs = jobsOf(payload.builds);
  const events: DeliveryEvent[] = [];

  const pipelineExtra = {
    jobs,
    queued_s: num(attrs.queued_duration),
    tag: attrs.tag === true,
    lane_key: laneKeyOf(mr.title) ?? laneKeyOf(commit.title),
  };
  const key = `gitlab:${ctx.scope}:pipeline:${pipelineId ?? '?'}:${status}`;

  // success / failed with a VTID: the event of mapper.ts, kept as it is. Otherwise built here in the same shape.
  const base = status === 'success' || status === 'failed' ? mapGitlabEvent(payload, ctx.id) : null;
  if (base && base.kind === 'emit') {
    events.push(enrich(ctx, mode, base.event, pipelineExtra, key));
  } else {
    events.push(
      build(ctx, mode, {
        vtid,
        type: mapped.topic,
        status: mapped.status,
        message: `GitLab pipeline ${pipelineId ?? '?'} ${mapped.verb} on ${ref ?? 'an unknown ref'} ${ctx.where}`,
        key,
        payload: {
          gitlab_event: 'pipeline',
          webhook_id: ctx.id,
          status,
          project_id: ctx.projectId,
          project_path: ctx.projectPath,
          pipeline_id: pipelineId,
          ref,
          sha,
          source: str(attrs.source),
          merge_request_iid: num(mr.iid),
          duration_s: num(attrs.duration),
          url,
          ...pipelineExtra,
        },
      }),
    );
  }

  // The landing and the staging deploy: only a live run of a commit on main.
  if (mode === 'live' && ref === 'main' && attrs.tag !== true) {
    if (status === 'running' || status === 'success' || status === 'failed') {
      const landed = landedEvent(ctx, mode, vtid, commit, attrs, ref, sha, url, pipelineId);
      if (landed) events.push(landed);
    }
    if (status === 'success' || status === 'failed' || status === 'canceled') {
      events.push(...deployEvents(ctx, mode, vtid, payload.builds, sha, url, pipelineId));
    }
  }

  return { kind: 'emit', events: events.slice(0, MAX_EVENTS) };
}

function landedEvent(
  ctx: Ctx,
  mode: DeliveryMode,
  vtid: string,
  commit: Obj,
  attrs: Obj,
  ref: string,
  sha: string | null,
  url: string | null,
  pipelineId: number | null,
): DeliveryEvent | null {
  const t = parseTrailers(commit.message, LANDING_TRAILER_KEYS);
  const mrRef = t['Merge-Request'];
  if (!mrRef) return null;
  const mergeRequestIid = /^!?(\d+)$/.test(mrRef) ? Number(mrRef.replace('!', '')) : null;
  const landedAt = str(commit.timestamp);
  const acceptedAt = t['Accepted-At'];
  const mergeSha = sha ?? str(commit.id);
  return build(ctx, mode, {
    vtid,
    type: DELIVERY_TOPICS.landed,
    status: 'success',
    message: `Landed ${mergeSha ? mergeSha.slice(0, 12) : 'a commit'} (${mrRef}) on ${ref} ${ctx.where}`,
    key: `gitlab:${ctx.scope}:landed:${mergeSha ?? pipelineId ?? '?'}`,
    payload: {
      gitlab_event: 'pipeline',
      webhook_id: ctx.id,
      project_id: ctx.projectId,
      project_path: ctx.projectPath,
      merge_sha: mergeSha,
      merge_request: mrRef,
      merge_request_iid: mergeRequestIid,
      source_branch: t['Source-Branch'],
      reviewed_head: t['Reviewed-Head'],
      verdict: t['Review-Verdict'],
      reviewer: t.Reviewer,
      reviewer_model: reviewerModel(t.Reviewer),
      accepted_at: acceptedAt,
      landed_at: landedAt,
      accept_to_land_s: secondsBetween(acceptedAt, landedAt),
      pipeline_id: pipelineId,
      ref,
      url,
      lane_key: laneKeyOf(commit.title),
    },
  });
}

function deployEvents(
  ctx: Ctx,
  mode: DeliveryMode,
  vtid: string,
  builds: unknown,
  sha: string | null,
  url: string | null,
  pipelineId: number | null,
): DeliveryEvent[] {
  const out: DeliveryEvent[] = [];
  for (const b of arr(builds).filter(isObj).slice(0, MAX_JOBS)) {
    const name = str(b.name);
    const jobStatus = str(b.status);
    if (!name) continue;
    const deploy = DEPLOY_JOB_RE.exec(name);
    const rollback = deploy ? null : ROLLBACK_JOB_RE.exec(name);
    let type: CicdEventType | null = null;
    let status: CicdOasisEvent['status'] = 'info';
    let verb = '';
    if (deploy && jobStatus === 'success') { type = DELIVERY_TOPICS.stagingDeployCompleted; status = 'success'; verb = 'completed'; }
    else if (deploy && jobStatus === 'failed') { type = DELIVERY_TOPICS.stagingDeployFailed; status = 'warning'; verb = 'failed'; }
    else if (rollback && jobStatus === 'success') { type = DELIVERY_TOPICS.stagingDeployRolledBack; status = 'warning'; verb = 'rolled back'; }
    if (!type) continue;
    const service = (deploy ?? rollback)?.[1] ?? null;
    out.push(
      build(ctx, mode, {
        vtid,
        type,
        status,
        message: `Staging deploy ${verb}${service ? ` for ${service}` : ''} at ${sha ? sha.slice(0, 12) : 'an unknown commit'} ${ctx.where}`,
        key: `gitlab:${ctx.scope}:deploy:${pipelineId ?? '?'}:${name}:${jobStatus}`,
        payload: {
          gitlab_event: 'pipeline',
          webhook_id: ctx.id,
          // The fields the GitHub deploy rows carry (workflow-written staging.deploy.* rows): git_commit, env, workflow.
          env: 'staging',
          workflow: `gitlab:${ctx.scope}/${name}`,
          git_commit: sha,
          branch: 'main',
          service,
          job: name,
          job_id: num(b.id),
          project_id: ctx.projectId,
          project_path: ctx.projectPath,
          pipeline_id: pipelineId,
          wait_s: num(b.queued_duration),
          run_s: num(b.duration),
          url,
        },
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// push and tag_push
// ---------------------------------------------------------------------------------------------------------

async function mapPush(payload: Obj, ctx: Ctx, branches: BranchVtidIndex, lookup: BranchVtidLookup | undefined): Promise<DeliveryMapping> {
  const ref = str(payload.ref);
  if (!ref || !ref.startsWith('refs/heads/')) return { kind: 'ignore', reason: 'unmapped_ref' };
  const branch = ref.slice('refs/heads/'.length);
  if (!AGENT_BRANCH_RE.test(branch)) return { kind: 'ignore', reason: 'unmapped_ref' };
  const after = str(payload.after);
  if (!after || ZERO_SHA_RE.test(after)) return { kind: 'ignore', reason: 'unmapped_action' }; // a branch deleted

  const commits = arr(payload.commits).filter(isObj).slice(0, MAX_COMMITS);
  let vtid = branches.get(ctx.projectPath, branch);
  if (!vtid && lookup) {
    try {
      vtid = await lookup(ctx.projectPath, branch);
    } catch {
      vtid = null;
    }
  }
  vtid = vtid ?? firstVtid(...commits.map((c) => c.title)) ?? DELIVERY_VTID;

  const mode = modeFor(ctx);
  const head = commits.find((c) => c.id === after) ?? commits[commits.length - 1] ?? {};
  const headTrailers = parseTrailers(head.message, REVIEW_TRAILER_KEYS);
  const total = num(payload.total_commits_count) ?? commits.length;
  const events: DeliveryEvent[] = [
    build(ctx, mode, {
      vtid,
      type: DELIVERY_TOPICS.push,
      status: 'info',
      message: `GitLab push to ${branch} (${total} commit${total === 1 ? '' : 's'}) ${ctx.where}`,
      key: `gitlab:${ctx.scope}:push:${branch}:${after}`,
      payload: {
        gitlab_event: 'push',
        webhook_id: ctx.id,
        project_id: ctx.projectId,
        project_path: ctx.projectPath,
        branch,
        before: str(payload.before),
        head_sha: after,
        commits: total,
        session: headTrailers['Collab-Session'],
        lane_key: headTrailers['Collab-Lane'] ?? headTrailers['Collab-Review'],
      },
    }),
  ];

  for (const c of commits) {
    const commitSha = str(c.id);
    const t = parseTrailers(c.message, REVIEW_TRAILER_KEYS);
    const verdict = t['Collab-Verdict']?.toLowerCase() ?? null;
    if (verdict === 'accept' || verdict === 'changes') {
      const review = t['Collab-Review'];
      events.push(
        build(ctx, mode, {
          vtid,
          type: DELIVERY_TOPICS.reviewRecorded,
          status: 'info',
          message: `Review ${verdict} recorded for ${review ?? 'a lane'} ${ctx.where}`,
          key: `gitlab:${ctx.scope}:review:${commitSha ?? '?'}`,
          payload: {
            gitlab_event: 'push',
            webhook_id: ctx.id,
            project_id: ctx.projectId,
            project_path: ctx.projectPath,
            branch,
            commit_sha: commitSha,
            lane_key: review && PLAIN_LANE_KEY_RE.test(review) ? review : null,
            verdict,
            reviewer: t['Collab-Reviewer'],
            reviewer_model: reviewerModel(t['Collab-Reviewer']),
            reviewed_head: t['Collab-Reviewed-Head'] && SHA40_RE.test(t['Collab-Reviewed-Head']) ? t['Collab-Reviewed-Head'] : null,
            session: t['Collab-Session'],
          },
        }),
      );
    }
    for (const [change, files] of [['added', c.added], ['modified', c.modified], ['removed', c.removed]] as const) {
      for (const file of arr(files)) {
        const m = typeof file === 'string' ? LANE_FILE_RE.exec(file) : null;
        if (!m) continue;
        events.push(
          build(ctx, mode, {
            vtid,
            type: DELIVERY_TOPICS.laneUpdated,
            status: 'info',
            message: `Lane ${m[1]}/${m[2]} ${change} ${ctx.where}`,
            key: `gitlab:${ctx.scope}:lane:${commitSha ?? '?'}:${m[1]}/${m[2]}`,
            payload: {
              gitlab_event: 'push',
              webhook_id: ctx.id,
              project_id: ctx.projectId,
              project_path: ctx.projectPath,
              branch,
              commit_sha: commitSha,
              slug: m[1],
              lane: m[2],
              lane_key: `${m[1]}/${m[2]}`,
              change,
              session: t['Collab-Session'],
            },
          }),
        );
      }
    }
  }
  return { kind: 'emit', events: events.slice(0, MAX_EVENTS) };
}

function mapTagPush(payload: Obj, ctx: Ctx): DeliveryMapping {
  const ref = str(payload.ref);
  const m = ref ? /^refs\/tags\/(delivery\/cutover-(vitana-platform|vitana-v1))$/.exec(ref) : null;
  if (!m) return { kind: 'ignore', reason: 'unmapped_ref' };
  const sha = str(payload.checkout_sha) ?? str(payload.after);
  if (!sha || ZERO_SHA_RE.test(sha)) return { kind: 'ignore', reason: 'unmapped_action' }; // a tag deleted
  return {
    kind: 'emit',
    events: [
      build(ctx, modeFor(ctx), {
        vtid: DELIVERY_VTID,
        type: DELIVERY_TOPICS.cutover,
        status: 'info',
        message: `Repository ${m[2]} cut over to GitLab (tag ${m[1]}) ${ctx.where}`,
        key: `gitlab:${ctx.scope}:tag:${m[1]}`,
        payload: {
          gitlab_event: 'tag_push',
          webhook_id: ctx.id,
          project_id: ctx.projectId,
          project_path: ctx.projectPath,
          cutover_repo: m[2],
          tag: m[1],
          sha,
        },
      }),
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------

/**
 * Maps one verified GitLab delivery to its OASIS events. Never throws on a hostile payload; the only I/O is
 * the optional branch lookup of a push. An unknown event, an unmapped action, status or ref, or a fact with
 * no VTID where one is required is ignored with a reason (the route answers 202).
 */
export async function mapGitlabDelivery(payload: unknown, webhookId: string, options: DeliveryMapOptions = {}): Promise<DeliveryMapping> {
  if (!isObj(payload)) return { kind: 'ignore', reason: 'unknown_event' };
  const ctx = makeCtx(payload, webhookId, options.env ?? process.env);
  const branches = options.branches ?? sharedBranchIndex;
  switch (payload.object_kind) {
    case 'merge_request':
      return mapMergeRequest(payload, ctx, branches);
    case 'pipeline':
      return mapPipeline(payload, ctx);
    case 'push':
      return mapPush(payload, ctx, branches, options.lookupBranchVtid);
    case 'tag_push':
      return mapTagPush(payload, ctx);
    default:
      return { kind: 'ignore', reason: 'unknown_event' };
  }
}
