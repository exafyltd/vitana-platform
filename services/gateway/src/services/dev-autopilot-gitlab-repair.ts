/**
 * Queues a GitLab-native repair on Dev Autopilot's existing executor.
 *
 * Owner instruction 2026-11-19: "Implement the GitLab failure adapter against the existing self-healing architecture, but make it
 * GitLab-native. Do not route GitLab failures through GitHub PRs."
 *
 * The delivery loop (services/delivery-loop/) decides that a failed GitLab merge-request pipeline needs a code repair and hands it here
 * through its executor port. This writes the rows Dev Autopilot's background executor already claims and runs, and nothing else:
 *
 *   finding       one per merge request (`spec_snapshot.dedupe_key`), the carrier the executor's tables require. It is INERT: status
 *                 `auto_archived` (no tick acts on it: auto-approve and planning read `new`, the activation reaper reads `activated`),
 *                 scanner `delivery-loop`, and no `activated_vtid`, so no cancel, failure or completion of a repair can close a VTID.
 *                 One finding per merge request also makes the executor's in-flight unique index allow one repair per merge request
 *                 at a time.
 *   plan version  one per attempt; `files_referenced` is empty, so the claim-time overlap check makes no GitHub call.
 *   execution     `cooling`, executable now, GitLab-hosted (`metadata.host = 'gitlab'`, `metadata.gitlab` = the target), on the agent
 *                 executor, in ONE insert with all its metadata (never an insert and a later patch, which the tick could claim in
 *                 between and run as a GitHub execution). It has no `branch`, `pr_url` or `pr_number`, so no GitHub watcher,
 *                 reconciler or bridge path can take it; the runner and applyExecutionResult branch on the host.
 *
 * One dispatch key is one execution: a dispatch sent again (the loop crashed between the effect and its record) answers the
 * execution it made. Nothing is written for an invalid target, while the executor's kill switch is on, or when the config cannot be
 * read (never assumed off). No VTID is allocated here (CLAUDE.md §4.1: VTIDs come from sparred plans only); the merge request's own
 * VTID, if it has one, stays the merge request's.
 */
import { randomUUID } from 'crypto';
import { parseGitlabTarget, type GitlabTarget } from './autopilot-agent/gitlab-target';

export const GITLAB_REPAIR_SCANNER = 'delivery-loop';
/** What the agent runner keeps of a failure text (the bridge's own bound, PARENT_FAILURE_MAX_CHARS). */
export const PARENT_FAILURE_MAX_CHARS = 8000;
const PLAN_MAX_CHARS = 4000;

export interface GitlabRepairRequest {
  /** The delivery loop's attempt key: at most one execution per dispatch key. */
  dispatch_key: string;
  /** The delivery loop's work key (shared by the attempts at one failure). */
  work_key: string;
  project_path: string;
  mr_iid: number;
  mr_url: string | null;
  source_branch: string;
  target_branch: string;
  pipeline_id: number;
  /** The head whose pipeline failed. */
  sha: string;
  title: string;
  /** What to do, with the failing job's output quoted as data (the loop's drive.ts builds it). */
  instructions: string;
  hints: string[];
}

export type GitlabRepairEnqueueResult =
  | { ok: true; execution_id: string; created: boolean }
  | { ok: false; error: string; retryable: boolean };

interface Supa {
  url: string;
  key: string;
}

export function findingDedupeKey(projectPath: string, mrIid: number): string {
  return `delivery-loop:gitlab:${projectPath}!${mrIid}`;
}

function supaFromEnv(): Supa | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? { url, key } : null;
}

async function rest<T>(s: Supa, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data?: T }> {
  try {
    const res = await fetch(`${s.url}${path}`, {
      ...init,
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    if (!text) return { ok: true, status: res.status };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { ok: true, status: res.status };
    }
  } catch {
    return { ok: false, status: 0 };
  }
}

const enc = encodeURIComponent;

function planMarkdown(t: GitlabTarget, req: GitlabRepairRequest): string {
  const hints = req.hints.filter((h) => typeof h === 'string' && h.trim()).slice(0, 5);
  return [
    `# Repair GitLab merge request !${t.mr_iid} (${t.project_path})`,
    '',
    `${req.title}`.slice(0, 200),
    '',
    `The pipeline ${t.pipeline_id} of the merge request's branch ${t.source_branch} (into ${t.target_branch}) failed at ${t.sha}.`,
    `Fix the failure on that branch with the smallest change. The failing job's output is the CI failure evidence below.`,
    ...(hints.length ? ['', '## What is known', ...hints.map((h) => `- ${h.slice(0, 300)}`)] : []),
  ].join('\n').slice(0, PLAN_MAX_CHARS);
}

export async function enqueueGitlabRepair(
  req: GitlabRepairRequest,
  deps: { s?: Supa | null; now?: () => Date; newId?: () => string } = {},
): Promise<GitlabRepairEnqueueResult> {
  const s = deps.s === undefined ? supaFromEnv() : deps.s;
  if (!s) return { ok: false, error: 'dev_autopilot_not_configured: SUPABASE_URL / SUPABASE_SERVICE_ROLE are not set', retryable: false };

  // The target is validated exactly as the runner will read it, before anything is read or written.
  const parsed = parseGitlabTarget({
    host: 'gitlab',
    gitlab: {
      project_path: req.project_path, mr_iid: req.mr_iid, mr_url: req.mr_url, source_branch: req.source_branch, target_branch: req.target_branch,
      pipeline_id: req.pipeline_id, sha: req.sha, work_key: req.work_key, dispatch_key: req.dispatch_key,
    },
  });
  if (!parsed.ok) return { ok: false, error: `invalid_request: ${parsed.error}`, retryable: false };
  const target = parsed.target;

  // The executor's own kill switch. Unreadable is not "off": nothing is queued until it can be read.
  const cfg = await rest<Array<{ kill_switch?: boolean }>>(s, '/rest/v1/dev_autopilot_config?id=eq.1&select=kill_switch&limit=1');
  if (!cfg.ok || !Array.isArray(cfg.data) || cfg.data.length === 0) return { ok: false, error: 'executor_config_unreadable: the kill switch could not be read', retryable: true };
  if (cfg.data[0].kill_switch === true) return { ok: false, error: 'executor_kill_switch: Dev Autopilot is switched off', retryable: true };

  // One dispatch key is one execution.
  const existing = await rest<Array<{ id: string; status: string }>>(
    s, `/rest/v1/dev_autopilot_executions?metadata->>delivery_dispatch_key=eq.${enc(target.dispatch_key)}&select=id,status&limit=1`,
  );
  if (!existing.ok) return { ok: false, error: 'executor_unreachable: could not look for an existing execution', retryable: true };
  if (Array.isArray(existing.data) && existing.data.length > 0) return { ok: true, execution_id: existing.data[0].id, created: false };

  // The carrier finding of this merge request: found, or written once, inert.
  const dedupe = findingDedupeKey(target.project_path, target.mr_iid);
  const found = await rest<Array<{ id: string }>>(s, `/rest/v1/autopilot_recommendations?spec_snapshot->>dedupe_key=eq.${enc(dedupe)}&select=id&limit=1`);
  if (!found.ok) return { ok: false, error: 'executor_unreachable: could not read the merge request finding', retryable: true };
  let findingId = Array.isArray(found.data) && found.data.length > 0 ? found.data[0].id : null;
  if (!findingId) {
    const created = await rest<Array<{ id: string }>>(s, '/rest/v1/autopilot_recommendations', {
      method: 'POST',
      body: JSON.stringify({
        title: `Repair GitLab merge request !${target.mr_iid} (${target.project_path})`.slice(0, 200),
        summary: `Carrier of the GitLab-native repairs of merge request !${target.mr_iid} of ${target.project_path}, queued by the delivery loop. Never auto-approved or planned.`,
        domain: 'general',
        risk_level: 'medium',
        impact_score: 5,
        effort_score: 3,
        source_type: 'dev_autopilot',
        status: 'auto_archived',
        activated_vtid: null,
        spec_snapshot: { scanner: GITLAB_REPAIR_SCANNER, host: 'gitlab', dedupe_key: dedupe, project_path: target.project_path, mr_iid: target.mr_iid, mr_url: target.mr_url },
      }),
    });
    findingId = created.ok && Array.isArray(created.data) && created.data[0]?.id ? created.data[0].id : null;
    if (!findingId) return { ok: false, error: 'executor_unreachable: could not write the merge request finding', retryable: true };
  }

  // The plan of this attempt.
  const last = await rest<Array<{ version: number }>>(s, `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${findingId}&select=version&order=version.desc&limit=1`);
  if (!last.ok) return { ok: false, error: 'executor_unreachable: could not read the plan versions', retryable: true };
  const version = (Array.isArray(last.data) && last.data.length > 0 ? Number(last.data[0].version) || 0 : 0) + 1;
  const plan = await rest(s, '/rest/v1/dev_autopilot_plan_versions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ finding_id: findingId, version, plan_markdown: planMarkdown(target, req), files_referenced: [] }),
  });
  if (!plan.ok) return { ok: false, error: `executor_busy: the plan of this attempt could not be written (${plan.status})`, retryable: true };

  // The execution: one insert with all of its metadata, executable now.
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const id = (deps.newId ?? randomUUID)();
  const ins = await rest(s, '/rest/v1/dev_autopilot_executions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      id,
      finding_id: findingId,
      plan_version: version,
      status: 'cooling',
      approved_at: now,
      execute_after: now,
      auto_fix_depth: 0,
      metadata: {
        source: 'delivery-loop',
        host: 'gitlab',
        executor: 'agent',
        gitlab: target,
        delivery_dispatch_key: target.dispatch_key,
        delivery_work_key: target.work_key,
        parent_failure: req.instructions.slice(0, PARENT_FAILURE_MAX_CHARS),
      },
    }),
  });
  if (ins.status === 409) return { ok: false, error: 'executor_busy: a repair of this merge request is already in flight', retryable: true };
  if (!ins.ok) return { ok: false, error: `executor_unreachable: the execution could not be written (${ins.status})`, retryable: true };
  return { ok: true, execution_id: id, created: true };
}
