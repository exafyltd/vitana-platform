/**
 * VTID-04802: Jev P2 gates B5 + B4 — did a deploy cause this self-healing
 * incident, and if so, which commit? (docs/JEV-INTEGRATION-PLAN.md §10.4)
 *
 *   selfheal_deploy_cause   (JEV_SELFHEAL_DEPLOY_CAUSE_MODE = off | shadow | enforce)
 *
 *   B5 "no deploy seen": no deploy of this environment's gateway finished in
 *      the DEPLOY_WINDOW before the incident → not a regression of a recent
 *      change. A rules row; no Jev call.
 *   B4 likely-cause ranking: a deploy did finish in the window → the commits
 *      it brought in (previous deploy's commit … this deploy's commit, newest
 *      first, at most MAX_COMMITS) are each scored by Jev `commit_cause_score`
 *      from the error and the commit's subject and file paths (never a diff).
 *      The top commit is recorded.
 *
 * Deploys are the `*.deploy.completed` events the AWS deploy workflows write
 * (dev-autopilot-deploy-topics.ts), for the process's own environment only.
 *
 * Runs beside the B1–B3 gates when triage is about to run, without delaying
 * it: spawnTriageAgent starts it and only awaits it after triage, to write
 * the outcome. Agreement (B4 only): triage's own report names an affected
 * component; the ranking agrees when that component appears in the top
 * commit's file paths. No enforce behaviour (e.g. proposing a revert).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';
import { failureTextOf, type SelfHealGateInput } from './selfheal-gates';
import * as repo from '../jev-repository';
import { AWS_DEPLOY_TOPICS, toDeployEnv } from '../../dev-autopilot-deploy-topics';
import { VITANA_ENV } from '../../../env';
import { getCommitsBetween } from '../../github-service';

export const DEPLOY_CAUSE_GATE = 'selfheal_deploy_cause';
export const DEPLOY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_COMMITS = 5;
const SYSTEM_CALLER = { actor_id: 'self-healing-triage', system: true } as const;

export interface DeployEvent {
  git_commit: string;
  at: string;
}

export interface DeployCauseDeps {
  /** The two newest deploy-completed events of this environment at or before `before`, newest first. */
  recentDeploys: (beforeIso: string) => Promise<DeployEvent[]>;
  commitsBetween: (base: string, head: string, limit: number) => Promise<Array<{ sha: string; message: string; files: string[] }>>;
}

export function isDeployCauseOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(DEPLOY_CAUSE_GATE, env) !== 'off';
}

export interface DeployCauseResult {
  shadow_id: string | null;
  top: { sha: string; files: string[]; level: number } | null;
}

/** Never throws. */
export async function runDeployCauseCheck(
  input: SelfHealGateInput,
  deps: DeployCauseDeps,
  opts: { env?: NodeJS.ProcessEnv; sb?: SupabaseClient | null; now?: () => number; decideOptions?: Omit<DecideOptions, 'source' | 'env'> } = {},
): Promise<DeployCauseResult> {
  const none: DeployCauseResult = { shadow_id: null, top: null };
  const env = opts.env ?? process.env;
  const mode = jevGateMode(DEPLOY_CAUSE_GATE, env);
  if (mode === 'off') return none;
  try {
    const error = failureTextOf(input);
    if (!error) return none;
    const nowMs = (opts.now ?? Date.now)();
    const sb = opts.sb === undefined ? getSupabase() : opts.sb;
    const base = {
      gate: DEPLOY_CAUSE_GATE,
      mode,
      plane: 'internal',
      tenant_id: null,
      subject_type: 'triage',
      subject_ref: input.vtid,
      system_action: 'triage',
    };

    const deploys = await deps.recentDeploys(new Date(nowMs).toISOString());
    const latest = deploys[0];
    const inWindow = latest && nowMs - Date.parse(latest.at) <= DEPLOY_WINDOW_MS;
    if (!inWindow) {
      // B5: no deploy seen.
      const id = await recordJevShadowDecision(
        {
          ...base,
          decision: 'rules:no_deploy_seen',
          jev_outcome: 'decided',
          jev_verdict: { source: 'rules', deploy_seen: false, last_deploy_at: latest?.at ?? null, window_h: DEPLOY_WINDOW_MS / 3_600_000 },
          jev_confidence: 1,
          cost_usd: 0,
        },
        sb,
      );
      return { shadow_id: id, top: null };
    }

    const previous = deploys[1];
    const commits = previous ? await deps.commitsBetween(previous.git_commit, latest.git_commit, MAX_COMMITS) : [];
    if (commits.length === 0) {
      const id = await recordJevShadowDecision(
        {
          ...base,
          decision: 'rules:deploy_without_commits',
          jev_outcome: 'decided',
          jev_verdict: { source: 'rules', deploy_seen: true, deploy_commit: latest.git_commit, previous_commit: previous?.git_commit ?? null, commits: 0 },
          jev_confidence: 1,
          cost_usd: 0,
        },
        sb,
      );
      return { shadow_id: id, top: null };
    }

    // B4: score each commit.
    const endpoint = input.failure?.endpoint || input.endpoint || undefined;
    const scored: Array<{ sha: string; level: number | null; confidence: number | null; files: string[] }> = [];
    let cost = 0;
    for (const c of commits.slice(0, MAX_COMMITS)) {
      const r = await decide(
        'commit_cause_score',
        { error: error.slice(0, 4000), endpoint: endpoint?.slice(0, 200), commit_message: c.message.slice(0, 300) || '(no message)', files: c.files.slice(0, 60) },
        SYSTEM_CALLER,
        { ...(opts.decideOptions || {}), source: `gate:${DEPLOY_CAUSE_GATE}`, env },
      );
      if (r.ok) cost += r.cost_usd;
      scored.push({ sha: c.sha, level: r.ok && typeof r.verdict.value === 'number' ? r.verdict.value : null, confidence: r.ok ? r.verdict.confidence : null, files: c.files });
    }
    const ranked = scored.filter((x) => x.level !== null).sort((a, b) => (b.level as number) - (a.level as number));
    const topScored = ranked[0] ?? null;
    const id = await recordJevShadowDecision(
      {
        ...base,
        decision: 'commit_cause_score',
        jev_outcome: topScored ? 'decided' : 'fallback',
        jev_verdict: {
          source: 'jev',
          deploy_seen: true,
          deploy_commit: latest.git_commit,
          previous_commit: previous?.git_commit ?? null,
          ranking: scored.map((x) => ({ sha: x.sha.slice(0, 12), level: x.level })),
          top_sha: topScored?.sha ?? null,
          top_level: topScored?.level ?? null,
        },
        jev_confidence: topScored?.confidence ?? null,
        cost_usd: cost,
      },
      sb,
    );
    return { shadow_id: id, top: topScored ? { sha: topScored.sha, files: topScored.files, level: topScored.level as number } : null };
  } catch (err: any) {
    console.warn(`[jev] ${DEPLOY_CAUSE_GATE} check failed for ${input.vtid}: ${err?.message || err}`);
    return none;
  }
}

/** The affected component triage names, matched against the top commit's file paths. */
export function componentInFiles(component: string | null | undefined, files: string[]): boolean | null {
  const c = (component || '').trim().toLowerCase();
  if (!c || c.length < 3 || files.length === 0) return null;
  const base = c.replace(/\.(ts|tsx|js)$/, '').split('/').pop() || c;
  return files.some((f) => {
    const lf = f.toLowerCase();
    return lf.includes(c) || (base.length >= 3 && lf.includes(base));
  });
}

/** Never throws. */
export async function recordDeployCauseOutcome(
  result: DeployCauseResult,
  report: { affected_component?: string | null; severity?: string } | null,
  sb?: SupabaseClient | null,
): Promise<void> {
  try {
    if (!result.shadow_id) return;
    if (!report) {
      await recordJevShadowOutcome(result.shadow_id, 'triage_no_report', null, sb);
      return;
    }
    const agreed = result.top && result.top.level >= 2 ? componentInFiles(report.affected_component, result.top.files) : null;
    await recordJevShadowOutcome(result.shadow_id, `triage_ok:${report.severity ?? 'unknown'}`, agreed, sb);
  } catch (err: any) {
    console.warn(`[jev] ${DEPLOY_CAUSE_GATE} outcome not recorded: ${err?.message || err}`);
  }
}

/** The real reads: this environment's deploy events, and GitHub compare for the commit range. */
export function defaultDeployCauseDeps(): DeployCauseDeps {
  const topic = AWS_DEPLOY_TOPICS[toDeployEnv(VITANA_ENV)].success;
  const ghRepo = process.env.DEV_AUTOPILOT_GITHUB_REPO || 'exafyltd/vitana-platform';
  return {
    recentDeploys: async (beforeIso) => {
      const sb = getSupabase();
      if (!sb) return [];
      const { data, error } = await repo.fetchRecentDeployEvents(sb, topic, beforeIso, 2);
      if (error || !data) return [];
      return (data as Array<{ created_at: string; metadata?: { git_commit?: string } | null }>)
        .filter((r) => typeof r.metadata?.git_commit === 'string' && r.metadata.git_commit.length >= 7)
        .map((r) => ({ git_commit: r.metadata!.git_commit as string, at: r.created_at }));
    },
    commitsBetween: (base, head, limit) => getCommitsBetween(ghRepo, base, head, limit),
  };
}
