/**
 * VTID-05547 (plan agentic-delivery §3.13): which Git host delivers a repository, and the guard that
 * keeps the gateway from merging on GitHub once the repository has moved to GitLab.
 *
 *   DELIVERY_HOST_VITANA_PLATFORM=gitlab   DELIVERY_HOST_VITANA_V1=gitlab
 *
 * The name is DELIVERY_HOST_ plus the repository name (the part after the owner), upper-cased, every
 * run of other characters turned into "_". The value "gitlab" (any case) means the repository
 * delivers on GitLab; anything else, including unset, means GitHub, so merging this changes no
 * behaviour. The staging deploy sets the two variables with the first GitLab deploy of the cut
 * (plan §3.6 step 2, §8.2 step 7).
 *
 * The guard covers the two GitHub write calls of services/github-service.ts that land work:
 * mergePullRequest and updatePullRequestBranch. With the flag set for the repository they make no
 * GitHub call, write one OASIS event (delivery.merge.refused, with the VTID found in the commit title
 * or BOOTSTRAP-DELIVERY) and refuse with MergeMovedToGitlabError (code merge_moved_to_gitlab).
 *
 * The refusal is a thrown error, not a return value, on purpose: routes/cicd.ts reads `.sha` of the
 * merge result in five places and would report a merge that did not happen. Thrown, every caller's
 * existing catch reports it as a refused merge: safeMerge answers refused and emits
 * cicd.github.safe_merge.blocked (and the Project Manager records merge_refused, the lane is not
 * set done); the Dev Autopilot watcher marks the execution failed. checkGithubMerge is the same
 * decision as plain data, for callers that want to ask first.
 *
 * Reads keep working against the GitHub mirror; only these two calls are guarded.
 */
import type { CicdOasisEvent } from '../types/cicd';
import { firstVtid } from './gitlab-events/mapper';

export const MERGE_MOVED_TO_GITLAB = 'merge_moved_to_gitlab' as const;

/** The VTID of a delivery fact that belongs to no task (a nightly run, a cut tag, a refusal without a VTID in its title). */
export const DELIVERY_VTID = 'BOOTSTRAP-DELIVERY';

export type DeliveryHost = 'github' | 'gitlab';
export type GuardedOperation = 'merge' | 'update_branch';

/** "exafyltd/vitana-platform" → "vitana-platform"; "vitana/vitana-v1" → "vitana-v1". */
export function repoShortName(repoOrProjectPath: string | null | undefined): string | null {
  if (typeof repoOrProjectPath !== 'string') return null;
  const name = repoOrProjectPath.split('/').filter(Boolean).pop();
  return name ? name : null;
}

/** DELIVERY_HOST_VITANA_PLATFORM for "exafyltd/vitana-platform". */
export function deliveryHostEnvName(repo: string): string {
  const name = repoShortName(repo) ?? repo;
  return `DELIVERY_HOST_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/** The host that delivers `repo` right now. Reads the environment at call time. */
export function deliveryHostFor(repo: string, env: NodeJS.ProcessEnv = process.env): DeliveryHost {
  return (env[deliveryHostEnvName(repo)] ?? '').trim().toLowerCase() === 'gitlab' ? 'gitlab' : 'github';
}

export type GuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: typeof MERGE_MOVED_TO_GITLAB; host: 'gitlab'; repo: string; operation: GuardedOperation };

/** The guard's decision as plain data. Pure: no I/O, no event. */
export function checkGithubMerge(repo: string, operation: GuardedOperation, env: NodeJS.ProcessEnv = process.env): GuardVerdict {
  return deliveryHostFor(repo, env) === 'gitlab'
    ? { allowed: false, reason: MERGE_MOVED_TO_GITLAB, host: 'gitlab', repo, operation }
    : { allowed: true };
}

const OPERATION_TEXT: Record<GuardedOperation, string> = { merge: 'merge', update_branch: 'update-branch' };

export class MergeMovedToGitlabError extends Error {
  readonly code = MERGE_MOVED_TO_GITLAB;
  constructor(
    readonly repo: string,
    readonly operation: GuardedOperation,
    readonly prNumber?: number,
  ) {
    super(
      `${MERGE_MOVED_TO_GITLAB}: ${repo} delivers on GitLab; the GitHub ${OPERATION_TEXT[operation]} was refused` +
        (prNumber ? ` (PR #${prNumber})` : ''),
    );
    this.name = 'MergeMovedToGitlabError';
  }
}

/** By code, not instanceof, so it survives a reset module registry in tests. */
export function isMergeMovedToGitlab(err: unknown): err is MergeMovedToGitlabError {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === MERGE_MOVED_TO_GITLAB;
}

export interface GuardContext {
  prNumber?: number;
  /** The merge commit title; its first VTID-\d{5} becomes the VTID of the refusal event. */
  commitTitle?: string;
}

export interface GuardDeps {
  env?: NodeJS.ProcessEnv;
  emit?: (event: CicdOasisEvent) => Promise<unknown>;
}

async function defaultEmit(event: CicdOasisEvent): Promise<unknown> {
  // Loaded when a merge is refused, not when github-service.ts is imported, so the common path pulls in nothing.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { emitOasisEvent } = require('./oasis-event-service') as typeof import('./oasis-event-service');
  return emitOasisEvent(event);
}

/**
 * Throws MergeMovedToGitlabError (after writing one delivery.merge.refused event) when `repo` delivers on
 * GitLab; returns without doing anything otherwise. A failing OASIS write never stops the refusal.
 */
export async function assertGithubMergeAllowed(
  repo: string,
  operation: GuardedOperation,
  ctx: GuardContext = {},
  deps: GuardDeps = {},
): Promise<void> {
  const verdict = checkGithubMerge(repo, operation, deps.env ?? process.env);
  if (verdict.allowed) return;

  const pr = typeof ctx.prNumber === 'number' ? ctx.prNumber : undefined;
  const emit = deps.emit ?? defaultEmit;
  try {
    await emit({
      vtid: firstVtid(ctx.commitTitle) ?? DELIVERY_VTID,
      type: 'delivery.merge.refused',
      source: 'gateway-delivery-guard',
      status: 'warning',
      message: `GitHub ${OPERATION_TEXT[operation]} refused: ${repo} delivers on GitLab${pr ? ` (PR #${pr})` : ''}`,
      // The word "merge" in the topic would otherwise infer the Deploy stage (emitOasisEvent).
      task_stage: 'VALIDATOR',
      surface: 'cicd',
      payload: {
        plane: 'delivery',
        host: 'gitlab',
        mode: 'live',
        repo: repoShortName(repo),
        github_repo: repo,
        pr_number: pr ?? null,
        operation,
        reason: MERGE_MOVED_TO_GITLAB,
        // Exactly one fact per (pull request, operation): readers keep the first row per key.
        dedupe_key: `github:${repo}:pull:${pr ?? 'none'}:refused_${operation}`,
      },
    });
  } catch {
    console.error(`[delivery-host] OASIS write failed for ${MERGE_MOVED_TO_GITLAB} (${operation} ${repo}); refusing anyway`);
  }
  throw new MergeMovedToGitlabError(repo, operation, pr);
}
