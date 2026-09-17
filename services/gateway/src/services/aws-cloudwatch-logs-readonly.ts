/**
 * AWS CloudWatch Logs read-only client — VTID-04020 (operator agent W5a).
 *
 * Backs the Operator Console's `dev_cloudwatch_logs` tool: "what did
 * service X log in the last N minutes matching Y" for the `/ecs/vitana-*`
 * log groups the ECS services in CLAUDE.md §1b write to — the third item
 * of the gap analysis' §4.4 access list ("CloudWatch logs:FilterLogEvents
 * on /ecs/vitana-*"). Until now the console could see a service's ECS
 * rollout state (VTID-03836) but never what the service actually said.
 *
 * Same posture as `aws-ecs-readonly.ts`, deliberately: a separate module
 * and cached client; runs under the gateway task's own broad IAM role (the
 * platform owner's recorded VTID-03929 decision — no narrow role); every
 * call is read-only (`FilterLogEventsCommand` only); the log group must
 * match the documented `/ecs/vitana-…` shape before any AWS call is made;
 * the window, the event count and the total payload are bounded so one
 * tool call can never pull a whole day of a busy service into a prompt.
 * If the task role lacks `logs:FilterLogEvents`, the AWS error is returned
 * verbatim to the operator — an honest "not permitted", never a silent
 * empty result. Gated by the same `OPERATOR_AWS_READONLY_ENABLED` flag as
 * the ECS tool (pinned on staging only).
 */

import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const REGION = process.env.AWS_LOGS_REGION || process.env.AWS_ECS_REGION || process.env.AWS_REGION || 'eu-central-1';

/** `/ecs/vitana-<service>` — the log-group shape the §1b task definitions use. */
export const ALLOWED_LOG_GROUP_RE = /^\/ecs\/vitana-[a-z0-9-]{2,60}$/;

export const LOGS_DEFAULT_MINUTES = 30;
export const LOGS_MAX_MINUTES = 24 * 60;
export const LOGS_DEFAULT_LIMIT = 50;
export const LOGS_MAX_LIMIT = 200;
export const LOGS_MESSAGE_MAX_CHARS = 600;
export const LOGS_TOTAL_MAX_CHARS = 24_000;
export const LOGS_FILTER_PATTERN_MAX_CHARS = 200;

let cachedClient: CloudWatchLogsClient | null = null;

function getReadonlyClient(): CloudWatchLogsClient {
  if (!cachedClient) cachedClient = new CloudWatchLogsClient({ region: REGION });
  return cachedClient;
}

export interface LogsQuery {
  logGroup: string;
  filterPattern?: string;
  minutes?: number;
  limit?: number;
}

export interface LogsQueryNormalized {
  logGroup: string;
  filterPattern: string | undefined;
  minutes: number;
  limit: number;
}

/** Validate + clamp a query; throws on a log group outside the documented shape. */
export function normalizeLogsQuery(q: LogsQuery): LogsQueryNormalized {
  const logGroup = (q.logGroup || '').trim();
  if (!ALLOWED_LOG_GROUP_RE.test(logGroup)) {
    throw new Error(`log_group "${logGroup}" is not an /ecs/vitana-<service> log group — only the documented ECS services' groups can be read`);
  }
  const minutesRaw = Number(q.minutes);
  const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? Math.min(Math.floor(minutesRaw), LOGS_MAX_MINUTES) : LOGS_DEFAULT_MINUTES;
  const limitRaw = Number(q.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), LOGS_MAX_LIMIT) : LOGS_DEFAULT_LIMIT;
  const fp = typeof q.filterPattern === 'string' ? q.filterPattern.trim().slice(0, LOGS_FILTER_PATTERN_MAX_CHARS) : '';
  return { logGroup, filterPattern: fp || undefined, minutes, limit };
}

export interface LogEventOut {
  timestamp: string;
  stream: string;
  message: string;
}

export interface LogsResult {
  log_group: string;
  window_minutes: number;
  filter_pattern: string | null;
  events: LogEventOut[];
  truncated: boolean;
  note?: string;
}

/** Bound the events to the per-message and total character budgets. */
export function boundLogEvents(raw: Array<{ timestamp?: number; logStreamName?: string; message?: string }>, totalMax = LOGS_TOTAL_MAX_CHARS): { events: LogEventOut[]; truncated: boolean } {
  const events: LogEventOut[] = [];
  let total = 0;
  for (const e of raw) {
    const msg = (e.message || '').replace(/\s+$/, '');
    const message = msg.length > LOGS_MESSAGE_MAX_CHARS ? `${msg.slice(0, LOGS_MESSAGE_MAX_CHARS)}…` : msg;
    if (total + message.length > totalMax) return { events, truncated: true };
    total += message.length;
    events.push({ timestamp: new Date(e.timestamp || 0).toISOString(), stream: (e.logStreamName || '').split('/').pop() || '', message });
  }
  return { events, truncated: false };
}

/**
 * Read-only: FilterLogEvents over one allowlisted group for the last N
 * minutes. Never CreateLogGroup/PutLogEvents/DeleteLogStream — this module
 * imports only the Filter command.
 */
export async function filterVitanaLogs(q: LogsQuery, now: () => number = Date.now): Promise<LogsResult> {
  const n = normalizeLogsQuery(q);
  const endTime = now();
  const startTime = endTime - n.minutes * 60_000;
  const client = getReadonlyClient();
  const res = await client.send(new FilterLogEventsCommand({
    logGroupName: n.logGroup,
    startTime,
    endTime,
    limit: n.limit,
    ...(n.filterPattern ? { filterPattern: n.filterPattern } : {}),
    interleaved: true,
  }));
  const { events, truncated } = boundLogEvents(res.events || []);
  return {
    log_group: n.logGroup,
    window_minutes: n.minutes,
    filter_pattern: n.filterPattern || null,
    events,
    truncated: truncated || !!res.nextToken,
    ...(events.length === 0 ? { note: 'no events matched in the window — widen minutes, loosen the filter pattern, or check the service is actually running (dev_aws_ecs_status)' } : {}),
  };
}
