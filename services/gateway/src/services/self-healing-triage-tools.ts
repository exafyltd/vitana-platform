/**
 * VTID-04232: the self-healing triage agent's tool set — scoped to what a
 * root-cause investigator needs (build plan item 4, docs/AGENT-REGISTRY.md
 * §4 finding 3, triage half).
 *
 * Until now `spawnTriageAgent` pre-fetched the OASIS events of the one
 * session named in the diagnosis and asked the `triage` stage for a report
 * in a single shot — its own prompt still told the model to "call
 * query_oasis_events" and "read the source code in /workspace/repo/", tools
 * it had not had since the Managed-Agents flow was retired. Five read-only
 * tools, every one of them an existing gateway read path, reused not
 * rebuilt (ALWAYS 9):
 *
 *   query_oasis_events(session_id | vtid, limit?)  — the same PostgREST read
 *     the pre-fetch uses (`queryOasisEvents`), now also by VTID.
 *   dev_cloudwatch_logs(log_group, filter_pattern?, minutes?, limit?) —
 *     VTID-04020 `filterVitanaLogs` (group shape enforced, bounded).
 *   dev_ecs_tasks(target, desired_status?, limit?) — VTID-04035
 *     `listEcsTasks` (§1b allowlist enforced, bounded).
 *   dev_run_sql_readonly(sql, max_rows?, timeout_ms?) — VTID-04023
 *     `runReadonlySql` (validated SELECT, READ ONLY transaction, own role).
 *   get_architecture_reports(vtid? | topic?, limit?) — the VTID-04234
 *     investigator's `architecture_reports` rows (root cause, confidence,
 *     suggested fix, provider) so a repeat incident starts from the last
 *     hypothesis instead of from zero.
 *
 * Same kill switches as the Operator Console's copies of these tools —
 * `OPERATOR_AWS_READONLY_ENABLED` for the two AWS reads,
 * `OPERATOR_SQL_READONLY_ENABLED` (+ its URL) for SQL — so a tool that is
 * off on a stack reports that honestly to the model instead of failing
 * later. Every tool returns an error string on failure and never throws.
 */

import { filterVitanaLogs } from './aws-cloudwatch-logs-readonly';
import { listEcsTasks, ALLOWED_ECS_TASK_FAMILIES } from './aws-ecs-readonly';
import { isSqlReadonlyEnabled, runReadonlySql } from './operator-sql-readonly';
import type { LLMRouterTool } from './llm-router';
import type { StageToolOutcome } from './llm-stage-tool-loop';

export const TRIAGE_TOOL_NAMES = ['query_oasis_events', 'dev_cloudwatch_logs', 'dev_ecs_tasks', 'dev_run_sql_readonly', 'get_architecture_reports'] as const;
export type TriageToolName = (typeof TRIAGE_TOOL_NAMES)[number];
export const TRIAGE_OASIS_EVENTS_MAX = 100;
export const TRIAGE_REPORTS_MAX = 10;
export const TRIAGE_TOOL_RESULT_MAX_CHARS = 16_000;

export function triageRouterTools(): LLMRouterTool[] {
  return [
    {
      name: 'query_oasis_events',
      description: 'OASIS events (topic, vtid, status, message, metadata, created_at) for one live session id or one VTID, oldest first. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'A live session id from the diagnosis (metadata.session_id)' },
          vtid: { type: 'string', description: 'A VTID, e.g. VTID-04232 — used when no session_id is known' },
          limit: { type: 'integer', description: `Max events (default 50, max ${TRIAGE_OASIS_EVENTS_MAX})` },
        },
        required: [],
      },
    },
    {
      name: 'dev_cloudwatch_logs',
      description: 'Recent CloudWatch log events for one gateway/agent service log group (/vitana/<service>), optionally filtered. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          log_group: { type: 'string', description: 'e.g. /vitana/gateway (staging) or /vitana/gateway-awsdr (prod)' },
          filter_pattern: { type: 'string', description: 'CloudWatch filter pattern, e.g. "ERROR" or a session id' },
          minutes: { type: 'integer', description: 'Look-back window in minutes (default 30, max 1440)' },
          limit: { type: 'integer', description: 'Max events (default 50, max 200)' },
        },
        required: ['log_group'],
      },
    },
    {
      name: 'dev_ecs_tasks',
      description: `ECS tasks (status, health, task-def revision, stop code/reason, container exit codes) for one documented service or the ${ALLOWED_ECS_TASK_FAMILIES.join('/')} task family. Read-only.`,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'ECS service name (e.g. vitana-gateway) or task family' },
          desired_status: { type: 'string', description: 'RUNNING (default) or STOPPED' },
          limit: { type: 'integer', description: 'Max tasks (default 10, max 25)' },
        },
        required: ['target'],
      },
    },
    {
      name: 'dev_run_sql_readonly',
      description: 'Run ONE bounded read-only SELECT (or WITH … SELECT / EXPLAIN) against the platform database on a read-only connection. Use it to count/aggregate/join what the event feed cannot answer. Read-only by construction.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single SELECT statement, ≤ 4 KB' },
          max_rows: { type: 'integer', description: 'Rows to return (default 50, max 200)' },
          timeout_ms: { type: 'integer', description: 'Statement timeout (default 5000, max 15000)' },
        },
        required: ['sql'],
      },
    },
    {
      name: 'get_architecture_reports',
      description: 'Prior root-cause reports from the architecture investigator (architecture_reports): root cause, confidence, suggested fix, evidence, which model wrote it. Filter by vtid or by incident topic substring; newest first. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'Exact VTID' },
          topic: { type: 'string', description: 'Substring of incident_topic, e.g. "orb.live" or "dev_autopilot"' },
          limit: { type: 'integer', description: `Max reports (default 5, max ${TRIAGE_REPORTS_MAX})` },
        },
        required: [],
      },
    },
  ];
}

export interface TriageToolContext {
  vtid: string;
  /** The pre-fetch's OASIS reader; injected so the service owns one implementation. */
  queryOasisEvents: (filter: { sessionId?: string; vtid?: string }, limit: number) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

function clampInt(v: unknown, def: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

function clip(s: string): string {
  return s.length > TRIAGE_TOOL_RESULT_MAX_CHARS ? `${s.slice(0, TRIAGE_TOOL_RESULT_MAX_CHARS)}\n…[truncated]` : s;
}

export async function fetchArchitectureReports(
  args: { vtid?: string; topic?: string; limit?: number },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const supabaseUrl = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !key) throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE)');
  const limit = clampInt(args.limit, 5, TRIAGE_REPORTS_MAX);
  const params = new URLSearchParams();
  params.set('select', 'id,incident_topic,vtid,trigger_reason,root_cause,confidence,suggested_fix,alternative_hypotheses,evidence_summary,llm_provider,llm_model,status,created_at');
  params.set('order', 'created_at.desc');
  params.set('limit', String(limit));
  if (args.vtid) params.set('vtid', `eq.${args.vtid}`);
  if (args.topic) params.set('incident_topic', `ilike.*${args.topic.replace(/[%*,()]/g, '')}*`);
  const resp = await fetchImpl(`${supabaseUrl}/rest/v1/architecture_reports?${params.toString()}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!resp.ok) throw new Error(`architecture_reports read failed: ${resp.status} ${await resp.text()}`);
  const rows = (await resp.json()) as Array<Record<string, unknown>>;
  if (!rows.length) return `no architecture_reports rows match${args.vtid ? ` vtid=${args.vtid}` : ''}${args.topic ? ` topic~${args.topic}` : ''}`;
  return JSON.stringify(rows, null, 2);
}

export function createTriageToolExecutor(ctx: TriageToolContext): (name: string, args: Record<string, unknown>) => Promise<StageToolOutcome> {
  const env = ctx.env || process.env;
  return async (tool, args) => {
    try {
      switch (tool) {
        case 'query_oasis_events': {
          const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
          const vtid = typeof args.vtid === 'string' ? args.vtid.trim() : '';
          if (!sessionId && !vtid) return { result: 'query_oasis_events: session_id or vtid is required', isError: true };
          const text = await ctx.queryOasisEvents({ sessionId: sessionId || undefined, vtid: vtid || undefined }, clampInt(args.limit, 50, TRIAGE_OASIS_EVENTS_MAX));
          return { result: clip(text), isError: text.startsWith('Error:') };
        }
        case 'dev_cloudwatch_logs': {
          if (env.OPERATOR_AWS_READONLY_ENABLED !== 'true') return { result: 'dev_cloudwatch_logs is disabled on this stack (OPERATOR_AWS_READONLY_ENABLED is not "true")', isError: true };
          const logGroup = typeof args.log_group === 'string' ? args.log_group.trim() : '';
          if (!logGroup) return { result: 'dev_cloudwatch_logs: log_group is required (e.g. /vitana/gateway)', isError: true };
          const r = await filterVitanaLogs({
            logGroup,
            filterPattern: typeof args.filter_pattern === 'string' ? args.filter_pattern : undefined,
            minutes: typeof args.minutes === 'number' ? args.minutes : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          return { result: clip(JSON.stringify(r, null, 2)) };
        }
        case 'dev_ecs_tasks': {
          if (env.OPERATOR_AWS_READONLY_ENABLED !== 'true') return { result: 'dev_ecs_tasks is disabled on this stack (OPERATOR_AWS_READONLY_ENABLED is not "true")', isError: true };
          const target = typeof args.target === 'string' ? args.target.trim() : '';
          if (!target) return { result: 'dev_ecs_tasks: target is required', isError: true };
          const r = await listEcsTasks({
            target,
            desiredStatus: typeof args.desired_status === 'string' ? args.desired_status : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          return { result: clip(JSON.stringify(r, null, 2)) };
        }
        case 'dev_run_sql_readonly': {
          if (!isSqlReadonlyEnabled(env)) return { result: 'dev_run_sql_readonly is disabled on this stack (OPERATOR_SQL_READONLY_ENABLED is not "true")', isError: true };
          const sql = typeof args.sql === 'string' ? args.sql : '';
          if (!sql.trim()) return { result: 'dev_run_sql_readonly: sql is required', isError: true };
          const r = await runReadonlySql({ sql, max_rows: typeof args.max_rows === 'number' ? args.max_rows : undefined, timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined }, { env, threadId: `triage:${ctx.vtid}` });
          return { result: clip(JSON.stringify(r, null, 2)) };
        }
        case 'get_architecture_reports': {
          const text = await fetchArchitectureReports({
            vtid: typeof args.vtid === 'string' ? args.vtid.trim() || undefined : undefined,
            topic: typeof args.topic === 'string' ? args.topic.trim() || undefined : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          }, env, ctx.fetchImpl);
          return { result: clip(text) };
        }
        default:
          return { result: `unknown tool: ${tool} (triage tools: ${TRIAGE_TOOL_NAMES.join(', ')})`, isError: true };
      }
    } catch (err) {
      return { result: `${tool} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  };
}
