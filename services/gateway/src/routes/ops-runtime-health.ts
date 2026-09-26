/**
 * VTID-04664 — Service Health Phase 3: checks for systems that had none.
 *
 * Mounted at /api/v1/ops/runtime. Six groups, each check a small read with a
 * `status` (ok / degraded / down / not_configured / no_access):
 *
 *   deploy/*     STAGING-VERIFY, staging + prod deploy results, both gateways'
 *                build-info, both frontends reachable
 *   aws/ecs/*    running vs desired for every ECS service in CLAUDE.md §1b
 *   autopilot/*  kill switch, stuck runs, approval backlog, 7-day success rate,
 *                scan freshness, dispatch failures
 *   voice/*, ai/*, media/*  Polly, Fish, Serbian bridge, Titan, Bedrock,
 *                DeepSeek configuration, and the live voice error rate
 *   data/*       OASIS write lag, database latency, Redis, code index,
 *                scheduled GitHub workflows
 *   support/*, business/*  stuck support tickets, ERP bridge, Jev
 *
 * `not_configured` means the capability is deliberately off on this stack
 * (e.g. Fish without a key) — the panel shows it grey, never green and never
 * as an outage. `no_access` means the gateway's own role may not read the
 * source (an AWS AccessDenied). Every source is cached for CACHE_MS; a failing
 * read is `down` with its reason. Read-only, public, aggregates only.
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { describeEcsServices, ALLOWED_ECS_SERVICES, type EcsServiceStatus } from '../services/aws-ecs-readonly';
import { isRedisHealthy, getRedisClient } from '../services/redis-client';
import { isFishConfigured } from '../services/tts/fish';
import { isJevConfigured } from '../services/jev/jev-client';
import { isVertexSerbianBridgeEnabled } from '../orb/live/upstream/vertex-serbian-bridge';
import { getWorkflowRuns } from '../services/github-service';

const router = Router();

export type RuntimeStatus = 'ok' | 'degraded' | 'down' | 'not_configured' | 'no_access';
export interface RuntimeCheck {
  status: RuntimeStatus;
  reason?: string;
  [key: string]: unknown;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export function resetOpsRuntimeCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = load()
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function sb() {
  const client = getSupabase();
  if (!client) throw new Error('supabase_unconfigured');
  return client;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const HOUR = 3600_000;
const ageMin = (iso: string, now: number) => Math.round((now - new Date(iso).getTime()) / 60000);

// ── Deploy & Release ────────────────────────────────────────────────────────

/** Latest event wins: the newest `<prefix>.passed|completed` vs `.failed`. */
export function evalLatestEvent(
  row: { topic: string; created_at: string } | null,
  opts: { okSuffix: string; failStatus: RuntimeStatus; staleHours: number; now?: number },
): RuntimeCheck {
  const now = opts.now ?? Date.now();
  if (!row) return { status: 'degraded', reason: 'no_recent_event', window_hours: opts.staleHours };
  const age = ageMin(row.created_at, now);
  if (row.topic.endsWith(opts.okSuffix)) {
    return age > opts.staleHours * 60
      ? { status: 'degraded', reason: 'last_event_stale', last: row.topic, age_min: age }
      : { status: 'ok', last: row.topic, age_min: age };
  }
  return { status: opts.failStatus, reason: 'last_event_failed', last: row.topic, age_min: age };
}

async function latestEvent(topics: string[], sinceHours: number) {
  const since = new Date(Date.now() - sinceHours * HOUR).toISOString();
  const { data, error } = await sb()
    .from('oasis_events')
    .select('topic,created_at')
    .in('topic', topics)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`oasis_events: ${error.message}`);
  return (data?.[0] ?? null) as { topic: string; created_at: string } | null;
}

/** "staging=<url>,prod=<url>" — the bootstrap pack's own env (VTID-04018). */
export function parseTargets(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const DEFAULT_FRONTENDS = 'prod=https://vitanaland.com,staging=https://preview-aws.vitanaland.com';

async function probeUrl(url: string | undefined, expectJson: boolean): Promise<RuntimeCheck> {
  if (!url) return { status: 'not_configured', reason: 'no_url' };
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url, 5000, { headers: { Accept: expectJson ? 'application/json' : 'text/html' } });
    const latency = Date.now() - start;
    if (!res.ok) return { status: 'down', reason: `http_${res.status}`, latency_ms: latency };
    if (expectJson) {
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return { status: 'down', reason: 'not_json', latency_ms: latency };
      const commit = typeof body.git_commit === 'string' ? body.git_commit.slice(0, 12) : null;
      return { status: 'ok', latency_ms: latency, commit, env: body.env ?? null };
    }
    return { status: 'ok', latency_ms: latency };
  } catch (err) {
    return { status: 'down', reason: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
}

// ── AWS runtime ─────────────────────────────────────────────────────────────

export function evalEcsService(svc: EcsServiceStatus | undefined): RuntimeCheck {
  if (!svc) return { status: 'down', reason: 'service_not_found' };
  const base = {
    desired: svc.desiredCount,
    running: svc.runningCount,
    pending: svc.pendingCount,
    task_definition: svc.taskDefinition.split('/').pop() ?? svc.taskDefinition,
  };
  if (svc.status !== 'ACTIVE') return { status: 'down', reason: `service_${svc.status.toLowerCase()}`, ...base };
  if (svc.desiredCount === 0) return { status: 'degraded', reason: 'scaled_to_zero', ...base };
  if (svc.runningCount === 0) return { status: 'down', reason: 'no_running_tasks', ...base };
  if (svc.runningCount < svc.desiredCount) return { status: 'degraded', reason: 'below_desired', ...base };
  const rolling = svc.deployments.some((d) => d.rolloutState === 'IN_PROGRESS');
  if (rolling) return { status: 'degraded', reason: 'rollout_in_progress', ...base };
  const failed = svc.deployments.some((d) => d.rolloutState === 'FAILED');
  if (failed) return { status: 'degraded', reason: 'rollout_failed', ...base };
  return { status: 'ok', ...base };
}

async function loadEcs(): Promise<{ services: EcsServiceStatus[] } | { error: RuntimeCheck }> {
  try {
    return { services: await describeEcsServices([...ALLOWED_ECS_SERVICES]) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : '';
    if (/AccessDenied|not authorized/i.test(`${name} ${message}`)) {
      return { error: { status: 'no_access', reason: 'aws_access_denied', detail: message.slice(0, 300) } };
    }
    if (/credential|Could not load/i.test(message)) {
      return { error: { status: 'not_configured', reason: 'no_aws_credentials' } };
    }
    return { error: { status: 'down', reason: 'aws_error', detail: message.slice(0, 300) } };
  }
}

// ── Dev Autopilot ───────────────────────────────────────────────────────────

export const AUTOPILOT_STUCK_MIN = 30;
export const AUTOPILOT_STUCK_DOWN_MIN = 120;
export const APPROVAL_STALE_HOURS = 72;
export const SUCCESS_RATE_MIN = 0.25;
export const SUCCESS_RATE_MIN_SAMPLE = 10;

export function evalStuckRuns(rows: Array<{ updated_at: string }>, now = Date.now()): RuntimeCheck {
  const stuck = rows.filter((r) => ageMin(r.updated_at, now) > AUTOPILOT_STUCK_MIN);
  if (stuck.length === 0) return { status: 'ok', running: rows.length };
  const oldest = Math.max(...stuck.map((r) => ageMin(r.updated_at, now)));
  return {
    status: oldest > AUTOPILOT_STUCK_DOWN_MIN ? 'down' : 'degraded',
    reason: 'running_without_heartbeat',
    stuck: stuck.length,
    oldest_min: oldest,
  };
}

export function evalApprovalBacklog(rows: Array<{ updated_at: string }>, now = Date.now()): RuntimeCheck {
  const stale = rows.filter((r) => ageMin(r.updated_at, now) > APPROVAL_STALE_HOURS * 60);
  return stale.length === 0
    ? { status: 'ok', awaiting: rows.length }
    : { status: 'degraded', reason: 'held_executions_waiting', awaiting: rows.length, older_than_72h: stale.length };
}

const SUCCESS = ['completed', 'self_healed'];
const FAILURE = ['failed', 'failed_escalated', 'reverted'];
export function evalSuccessRate(rows: Array<{ status: string }>): RuntimeCheck {
  const ok = rows.filter((r) => SUCCESS.includes(r.status)).length;
  const bad = rows.filter((r) => FAILURE.includes(r.status)).length;
  const total = ok + bad;
  if (total < SUCCESS_RATE_MIN_SAMPLE) return { status: 'ok', reason: 'small_sample', succeeded: ok, failed: bad };
  const rate = ok / total;
  const base = { succeeded: ok, failed: bad, success_rate: Math.round(rate * 1000) / 1000 };
  return rate < SUCCESS_RATE_MIN ? { status: 'degraded', reason: 'low_success_rate', ...base } : { status: 'ok', ...base };
}

export function evalScanFreshness(row: { started_at: string; status: string } | null, now = Date.now()): RuntimeCheck {
  if (!row) return { status: 'degraded', reason: 'no_scan_in_3_days' };
  const age = ageMin(row.started_at, now);
  if (row.status === 'failed') return { status: 'degraded', reason: 'last_scan_failed', age_min: age };
  if (age > 26 * 60) return { status: 'degraded', reason: 'last_scan_stale', age_min: age };
  return { status: 'ok', last_status: row.status, age_min: age };
}

// ── Voice & AI configuration ────────────────────────────────────────────────

export function evalPollyConfig(env: NodeJS.ProcessEnv): RuntimeCheck {
  if (env.TTS_PROVIDER !== 'polly') return { status: 'down', reason: 'tts_provider_not_polly', tts_provider: env.TTS_PROVIDER ?? null };
  if (env.TTS_POLLY_STRICT !== 'true') return { status: 'degraded', reason: 'polly_not_strict' };
  return { status: 'ok' };
}

export function evalSerbianBridge(env: NodeJS.ProcessEnv, enabled: boolean): RuntimeCheck {
  if (!enabled) return { status: 'not_configured', reason: 'bridge_disabled' };
  const project = env.GOOGLE_CLOUD_PROJECT || env.GCP_PROJECT_ID || '';
  if (!project || project === 'lovable-vitana-vers1') return { status: 'down', reason: 'bridge_enabled_without_new_project' };
  if (!env.GCP_SERVICE_ACCOUNT_JSON) return { status: 'down', reason: 'bridge_enabled_without_credentials' };
  return { status: 'ok' };
}

export function evalTitanConfig(env: NodeJS.ProcessEnv): RuntimeCheck {
  if (env.IMAGE_PROVIDER !== 'bedrock') return { status: 'down', reason: 'image_provider_not_bedrock', image_provider: env.IMAGE_PROVIDER ?? null };
  if (!env.BEDROCK_ROLE_ARN) return { status: 'down', reason: 'bedrock_role_missing' };
  return { status: 'ok' };
}

export function evalVoiceErrors(starts: number, errors: number): RuntimeCheck {
  if (starts === 0) return { status: 'ok', reason: 'no_sessions_24h', sessions_24h: 0 };
  const rate = errors / starts;
  const base = { sessions_24h: starts, errors_24h: errors, error_rate: Math.round(rate * 1000) / 1000 };
  if (rate > 0.3) return { status: 'down', reason: 'voice_error_rate_high', ...base };
  if (rate > 0.1) return { status: 'degraded', reason: 'voice_error_rate_elevated', ...base };
  return { status: 'ok', ...base };
}

// ── Data & scheduling ───────────────────────────────────────────────────────

export function evalOasisLag(latest: string | null, now = Date.now()): RuntimeCheck {
  if (!latest) return { status: 'down', reason: 'no_events' };
  const age = ageMin(latest, now);
  if (age > 15) return { status: 'down', reason: 'no_event_written', age_min: age };
  if (age > 5) return { status: 'degraded', reason: 'event_writes_slow', age_min: age };
  return { status: 'ok', age_min: age };
}

export const SCHEDULED_WORKFLOWS = [
  'MORNING-SYSTEM-HEALTH-CHECK.yml',
  'SCREEN-LOAD-TIMING.yml',
  'DEV-AUTOPILOT.yml',
  'CODEINTEL-INDEX.yml',
  'ALERT-PUSH-DISPATCH-HEALTH.yml',
];

export function evalScheduledWorkflows(
  results: Array<{ workflow: string; conclusion: string | null; error?: string }>,
): RuntimeCheck {
  const failing = results.filter((r) => r.error || r.conclusion === 'failure' || r.conclusion === 'timed_out');
  const detail = results.map((r) => ({ workflow: r.workflow, last: r.error ? 'unreadable' : r.conclusion ?? 'running' }));
  return failing.length === 0
    ? { status: 'ok', workflows: detail }
    : { status: 'degraded', reason: 'scheduled_workflow_failing', failing: failing.map((r) => r.workflow), workflows: detail };
}

// ── Support ─────────────────────────────────────────────────────────────────

export const OPEN_TICKET_STATUSES = ['new', 'interviewing', 'triaged', 'needs_more_info', 'spec_ready', 'answer_ready', 'in_progress'];
export function evalStuckTickets(rows: Array<{ created_at: string; status: string }>, now = Date.now()): RuntimeCheck {
  const stale = rows.filter((r) => ageMin(r.created_at, now) > 7 * 24 * 60);
  return stale.length === 0
    ? { status: 'ok', open: rows.length }
    : { status: 'degraded', reason: 'tickets_open_over_7_days', open: rows.length, stale: stale.length };
}

// ── Routes ──────────────────────────────────────────────────────────────────

function respond(res: Response, key: string, fn: () => Promise<RuntimeCheck>): void {
  cached(key, fn)
    .then((check) => res.status(200).json({ ...check, checked_at: new Date().toISOString() }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(200).json({ status: 'down', reason: 'check_failed', detail: message.slice(0, 300) });
    });
}

type Handler = () => Promise<RuntimeCheck>;
export const RUNTIME_CHECKS: Record<string, Handler> = {
  // Deploy & Release
  'deploy/staging-verify': async () =>
    evalLatestEvent(await latestEvent(['staging.verify.passed', 'staging.verify.failed'], 72), {
      okSuffix: '.passed',
      failStatus: 'down',
      staleHours: 72,
    }),
  'deploy/staging-deploy': async () =>
    evalLatestEvent(await latestEvent(['staging.deploy.completed', 'staging.deploy.failed'], 168), {
      okSuffix: '.completed',
      failStatus: 'down',
      staleHours: 168,
    }),
  'deploy/prod-deploy': async () =>
    evalLatestEvent(await latestEvent(['prod.deploy.completed', 'prod.deploy.failed'], 24 * 30), {
      okSuffix: '.completed',
      // A failed prod deploy is rolled back automatically (VTID-04647) — the
      // previous build keeps serving, so degraded rather than down.
      failStatus: 'degraded',
      staleHours: 24 * 30,
    }),
  'deploy/prod-gateway': async () => probeUrl(parseTargets(process.env.OPERATOR_BOOTSTRAP_BUILD_INFO_URLS).prod, true),
  'deploy/staging-gateway': async () => probeUrl(parseTargets(process.env.OPERATOR_BOOTSTRAP_BUILD_INFO_URLS).staging, true),
  'deploy/frontend-prod': async () =>
    probeUrl(parseTargets(process.env.SERVICE_HEALTH_FRONTEND_URLS || DEFAULT_FRONTENDS).prod, false),
  'deploy/frontend-staging': async () =>
    probeUrl(parseTargets(process.env.SERVICE_HEALTH_FRONTEND_URLS || DEFAULT_FRONTENDS).staging, false),

  // Dev Autopilot
  'autopilot/kill-switch': async () => {
    const { data, error } = await sb().from('dev_autopilot_config').select('kill_switch,auto_approve_enabled').limit(1);
    if (error) throw new Error(`dev_autopilot_config: ${error.message}`);
    const row = data?.[0] as { kill_switch?: boolean; auto_approve_enabled?: boolean } | undefined;
    if (!row) return { status: 'down', reason: 'config_row_missing' };
    return row.kill_switch
      ? { status: 'degraded', reason: 'kill_switch_on', auto_approve: row.auto_approve_enabled ?? null }
      : { status: 'ok', kill_switch: false, auto_approve: row.auto_approve_enabled ?? null };
  },
  'autopilot/stuck-runs': async () => {
    const { data, error } = await sb().from('dev_autopilot_executions').select('updated_at').eq('status', 'running').limit(200);
    if (error) throw new Error(`dev_autopilot_executions: ${error.message}`);
    return evalStuckRuns((data ?? []) as Array<{ updated_at: string }>);
  },
  'autopilot/approval-backlog': async () => {
    const { data, error } = await sb()
      .from('dev_autopilot_executions')
      .select('updated_at')
      .eq('status', 'awaiting_approval')
      .limit(500);
    if (error) throw new Error(`dev_autopilot_executions: ${error.message}`);
    return evalApprovalBacklog((data ?? []) as Array<{ updated_at: string }>);
  },
  'autopilot/success-rate': async () => {
    const since = new Date(Date.now() - 7 * 24 * HOUR).toISOString();
    const { data, error } = await sb()
      .from('dev_autopilot_executions')
      .select('status')
      .in('status', [...SUCCESS, ...FAILURE])
      .gte('updated_at', since)
      .limit(5000);
    if (error) throw new Error(`dev_autopilot_executions: ${error.message}`);
    return evalSuccessRate((data ?? []) as Array<{ status: string }>);
  },
  'autopilot/scan-freshness': async () => {
    const since = new Date(Date.now() - 72 * HOUR).toISOString();
    const { data, error } = await sb()
      .from('dev_autopilot_runs')
      .select('started_at,status')
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`dev_autopilot_runs: ${error.message}`);
    return evalScanFreshness((data?.[0] ?? null) as { started_at: string; status: string } | null);
  },
  'autopilot/dispatch-failures': async () => {
    const since = new Date(Date.now() - 24 * HOUR).toISOString();
    const { count, error } = await sb()
      .from('oasis_events')
      .select('id', { count: 'exact', head: true })
      .eq('topic', 'dev_autopilot.execution.dispatch_failed')
      .gte('created_at', since);
    if (error) throw new Error(`oasis_events: ${error.message}`);
    return (count ?? 0) === 0
      ? { status: 'ok', dispatch_failed_24h: 0 }
      : { status: 'degraded', reason: 'executor_dispatch_failed', dispatch_failed_24h: count };
  },

  // Voice, AI & media
  'voice/polly': async () => evalPollyConfig(process.env),
  'voice/fish': async () => (isFishConfigured() ? { status: 'ok' } : { status: 'not_configured', reason: 'fish_off_or_no_key' }),
  'voice/serbian-bridge': async () => evalSerbianBridge(process.env, isVertexSerbianBridgeEnabled()),
  'voice/session-errors': async () => {
    const since = new Date(Date.now() - 24 * HOUR).toISOString();
    const count = async (topics: string[]) => {
      const { count: n, error } = await sb()
        .from('oasis_events')
        .select('id', { count: 'exact', head: true })
        .in('topic', topics)
        .gte('created_at', since);
      if (error) throw new Error(`oasis_events: ${error.message}`);
      return n ?? 0;
    };
    const [starts, errors] = await Promise.all([
      count(['vtid.live.session.start']),
      count(['orb.live.stall_detected', 'orb.live.connection_failed']),
    ]);
    return evalVoiceErrors(starts, errors);
  },
  'ai/bedrock': async () => (process.env.BEDROCK_ROLE_ARN ? { status: 'ok' } : { status: 'down', reason: 'bedrock_role_missing' }),
  'ai/deepseek': async () =>
    process.env.DEEPSEEK_API_KEY ? { status: 'ok' } : { status: 'not_configured', reason: 'deepseek_key_missing' },
  'media/titan': async () => evalTitanConfig(process.env),

  // Data & scheduling
  'data/oasis-write-lag': async () => {
    const { data, error } = await sb().from('oasis_events').select('created_at').order('created_at', { ascending: false }).limit(1);
    if (error) throw new Error(`oasis_events: ${error.message}`);
    return evalOasisLag((data?.[0] as { created_at?: string } | undefined)?.created_at ?? null);
  },
  'data/db-latency': async () => {
    const start = Date.now();
    const { error } = await sb().from('dev_autopilot_config').select('id').limit(1);
    const latency = Date.now() - start;
    if (error) return { status: 'down', reason: 'query_failed', detail: error.message.slice(0, 200) };
    if (latency > 2000) return { status: 'degraded', reason: 'slow_query', latency_ms: latency };
    return { status: 'ok', latency_ms: latency };
  },
  'data/redis': async () => {
    if (!getRedisClient()) return { status: 'not_configured', reason: 'redis_url_unset' };
    return (await isRedisHealthy()) ? { status: 'ok' } : { status: 'down', reason: 'redis_ping_failed' };
  },
  'data/code-index': async () => {
    const bucket = process.env.CODE_INDEX_BUCKET || 'vitana-code-index';
    try {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });
      const out = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: 'exafyltd/vitana-platform/latest/manifest.json' }),
      );
      const text = await out.Body?.transformToString();
      const manifest = JSON.parse(text || '{}') as { sha?: string; built_at?: string };
      if (!manifest.built_at) return { status: 'degraded', reason: 'manifest_without_built_at' };
      const age = ageMin(manifest.built_at, Date.now());
      const base = { sha: (manifest.sha || '').slice(0, 12), age_min: age };
      return age > 48 * 60 ? { status: 'degraded', reason: 'index_stale', ...base } : { status: 'ok', ...base };
    } catch (err) {
      const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      if (/AccessDenied|not authorized/i.test(message)) return { status: 'no_access', reason: 'aws_access_denied' };
      if (/credential|Could not load/i.test(message)) return { status: 'not_configured', reason: 'no_aws_credentials' };
      return { status: 'down', reason: 'manifest_unreadable', detail: message.slice(0, 200) };
    }
  },
  'data/scheduled-workflows': async () => {
    if (!process.env.GITHUB_SAFE_MERGE_TOKEN && !process.env.GITHUB_TOKEN) {
      return { status: 'not_configured', reason: 'github_token_missing' };
    }
    const repo = process.env.GITHUB_REPO || 'exafyltd/vitana-platform';
    const results = await Promise.all(
      SCHEDULED_WORKFLOWS.map(async (workflow) => {
        try {
          const runs = await getWorkflowRuns(repo, workflow);
          const done = runs.workflow_runs.find((r) => r.status === 'completed');
          return { workflow, conclusion: done ? done.conclusion : null };
        } catch (err) {
          return { workflow, conclusion: null, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return evalScheduledWorkflows(results);
  },

  // Support & business
  'support/stuck-tickets': async () => {
    const { data, error } = await sb()
      .from('feedback_tickets')
      .select('created_at,status')
      .in('status', OPEN_TICKET_STATUSES)
      .is('resolved_at', null)
      .limit(1000);
    if (error) throw new Error(`feedback_tickets: ${error.message}`);
    return evalStuckTickets((data ?? []) as Array<{ created_at: string; status: string }>);
  },
  'business/erp-bridge': async () => {
    const base = (process.env.ERP_BRIDGE_URL || '').replace(/\/+$/, '');
    if (!base) return { status: 'not_configured', reason: 'erp_bridge_url_unset' };
    return probeUrl(`${base}/ready`, true);
  },
  'business/jev': async () => (isJevConfigured() ? { status: 'ok' } : { status: 'not_configured', reason: 'jev_off_or_no_key' }),
};

for (const [path, handler] of Object.entries(RUNTIME_CHECKS)) {
  router.get(`/${path}`, (_req: Request, res: Response) => { // public-route
    respond(res, path, handler);
  });
}

// One DescribeServices call serves all nine ECS checks.
for (const service of ALLOWED_ECS_SERVICES) {
  router.get(`/aws/ecs/${service}`, (_req: Request, res: Response) => { // public-route
    cached('ecs', loadEcs)
      .then((r) => {
        const check = 'error' in r ? r.error : evalEcsService(r.services.find((s) => s.serviceName === service));
        res.status(200).json({ ...check, service, checked_at: new Date().toISOString() });
      })
      .catch((err: unknown) =>
        res.status(200).json({ status: 'down', reason: 'check_failed', detail: String(err).slice(0, 300) }),
      );
  });
}

export { router as opsRuntimeHealthRouter };
