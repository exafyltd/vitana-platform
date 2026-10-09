/**
 * VTID-05005: the Operator's developer tools, served to a Kiro session as MCP.
 *
 * Phase A is read tools only (owner decision 2026-10-09: including read-only
 * SQL, table reads and CloudWatch logs). Write tools — PRs, merges, deploys,
 * autopilot execute, approvals — are a later, separately approved phase.
 *
 * The tools ARE the Operator's: their declarations come from
 * GEMINI_TOOL_DEFINITIONS and every call goes through the same executeTool().
 * executeTool reads the caller from two thread-scoped maps (identity and
 * auth), so each call registers the verified caller under a one-off thread id
 * and removes it in `finally`.
 */
import { randomUUID } from 'crypto';
import { clearThreadIdentity, executeTool, GEMINI_TOOL_DEFINITIONS, setThreadIdentity } from '../gemini-operator';
import { clearThreadAuth, setThreadAuth } from '../operator-execute-authz';

export const KIRO_MCP_READ_TOOLS = [
  // code
  'dev_search_codebase', 'dev_read_file', 'dev_repowise', 'dev_graphify', 'dev_domain_atlas',
  // dev_deep_dive is left out: it runs up to 150 s (deep-dive.ts), past the ALB's 120 s idle limit,
  // and Kiro can do the same multi-step reading with the tools above.
  // OASIS, VTID ledger, tasks
  'dev_query_oasis_events', 'discover_oasis_tasks', 'oasis_analyze_vtid', 'dev_list_tasks', 'dev_get_task_detail',
  // autopilot (read)
  'autopilot_get_status', 'autopilot_list_recent_tasks', 'autopilot_get_recommendations',
  // infrastructure
  'dev_aws_ecs_status', 'dev_ecs_tasks', 'dev_system_status', 'dev_deployment_status', 'dev_cicd_health', 'dev_lock_status',
  // data and logs (owner decision: full read access)
  'dev_run_sql_readonly', 'dev_db_query', 'dev_cloudwatch_logs',
  'knowledge_search',
] as const;

export type KiroMcpToolName = (typeof KIRO_MCP_READ_TOOLS)[number];

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }

/** Gemini declarations use JSON Schema; normalise type names to lowercase for MCP clients. */
function toJsonSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toJsonSchema);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = k === 'type' && typeof val === 'string' ? val.toLowerCase() : toJsonSchema(val);
  }
  return out;
}

let cached: McpTool[] | null = null;
/** The MCP tool list: the read set, in declaration order, each declared once. */
export function kiroMcpTools(): McpTool[] {
  if (cached) return cached;
  const wanted = new Set<string>(KIRO_MCP_READ_TOOLS);
  const seen = new Set<string>();
  const decls = GEMINI_TOOL_DEFINITIONS.functionDeclarations as Array<{ name: string; description?: string; parameters?: unknown }>;
  cached = decls
    .filter((d) => wanted.has(d.name) && !seen.has(d.name) && seen.add(d.name))
    .map((d) => ({
      name: d.name,
      description: d.description ?? d.name,
      inputSchema: (toJsonSchema(d.parameters) as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));
  return cached;
}

export function isKiroMcpTool(name: string): name is KiroMcpToolName {
  return (KIRO_MCP_READ_TOOLS as readonly string[]).includes(name);
}

export interface KiroMcpCaller { userId: string; tenantId: string | null; threadId: string }

/** One tool call's budget: inside the ALB's 120 s idle timeout, under the relay's 115 s. */
export const KIRO_MCP_TOOL_TIMEOUT_MS = 100_000;

/** Largest tool result handed back to Kiro in one call (characters). */
export const KIRO_MCP_RESULT_MAX_CHARS = 200_000;

export interface KiroMcpCallResult { ok: boolean; text: string }

type Executor = typeof executeTool;

/** Run one read tool as the verified caller. Only callers the route has already checked as exafy_admin get here. */
export async function callKiroMcpTool(
  caller: KiroMcpCaller,
  name: string,
  args: Record<string, unknown>,
  exec: Executor = executeTool,
): Promise<KiroMcpCallResult> {
  if (!isKiroMcpTool(name)) return { ok: false, text: `Unknown tool: ${name}` };
  if (!caller.userId) return { ok: false, text: 'No verified caller' };
  const syntheticId = `kiro-mcp:${caller.threadId}:${randomUUID()}`;
  setThreadAuth(syntheticId, { user_id: caller.userId, exafy_admin: true });
  setThreadIdentity(syntheticId, { tenant_id: caller.tenantId ?? '', user_id: caller.userId, role: 'developer' });
  try {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<{ ok: false; error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `timed out after ${KIRO_MCP_TOOL_TIMEOUT_MS / 1000} s — narrow the request` }), KIRO_MCP_TOOL_TIMEOUT_MS);
      timer.unref?.();
    });
    const r = await Promise.race([exec(name, args, syntheticId), timedOut]).finally(() => clearTimeout(timer));
    let text = JSON.stringify(r.ok ? (r.data ?? { ok: true }) : { ok: false, error: r.error ?? 'failed' });
    if (text.length > KIRO_MCP_RESULT_MAX_CHARS) text = `${text.slice(0, KIRO_MCP_RESULT_MAX_CHARS)}… [truncated: ${text.length} chars total — narrow the query]`;
    return { ok: r.ok, text };
  } catch (e) {
    return { ok: false, text: `The tool failed: ${e instanceof Error ? e.message.slice(0, 300) : 'unknown error'}` };
  } finally {
    clearThreadAuth(syntheticId);
    clearThreadIdentity(syntheticId);
  }
}
