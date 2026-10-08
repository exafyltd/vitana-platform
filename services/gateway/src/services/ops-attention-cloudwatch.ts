/**
 * VTID-04987 — the CloudWatch read behind the /ops/attention
 * `cloudwatch_alarms` source (plan C, round-1 Q3 / round-2 F9).
 *
 * One read-only AWS call: `DescribeAlarms` with `StateValue=ALARM`, for both
 * metric and composite alarms, paginated, at most CLOUDWATCH_ALARM_CAP alarms
 * (a capped read is reported `truncated`, which the adapter turns into a
 * partial_error — never a silent "that is all"). Region from AWS_REGION
 * (default eu-central-1). The whole read is bounded by
 * CLOUDWATCH_READ_TIMEOUT_MS (5 s) across all pages.
 *
 * It throws on any error (AccessDenied, throttling, timeout, no credentials):
 * the aggregator maps a throw to an UNKNOWN source. It never turns "could not
 * read" into "no alarms".
 *
 * The gateway task role needs `cloudwatch:DescribeAlarms` (and nothing else)
 * for this: scripts/aws/setup-gateway-cloudwatch-read-grant.sh. The source is
 * only registered when OPS_ATTENTION_CLOUDWATCH_ENABLED=true
 * (attentionAdapters() in ops-attention-adapters.ts).
 *
 * Kept in its own module so the adapter and its tests stay SDK-free: the
 * adapter sees only the AttentionReads interface.
 */

import { CloudWatchClient, DescribeAlarmsCommand, type DescribeAlarmsCommandOutput } from '@aws-sdk/client-cloudwatch';
import type { CloudWatchAlarmLite } from './ops-attention-adapters';

export const CLOUDWATCH_ALARM_CAP = 100;
export const CLOUDWATCH_READ_TIMEOUT_MS = 5_000;

/** The one SDK method this module uses; tests pass a fake. */
export interface DescribeAlarmsSender {
  send(command: DescribeAlarmsCommand, options?: { abortSignal?: AbortSignal }): Promise<DescribeAlarmsCommandOutput>;
}

/** AWS_REGION, else eu-central-1 (the only region Vitana runs in). */
export function cloudwatchRegion(): string {
  return process.env.AWS_REGION || 'eu-central-1';
}

let cachedClient: CloudWatchClient | null = null;

function defaultClient(): DescribeAlarmsSender {
  if (!cachedClient) {
    cachedClient = new CloudWatchClient({ region: cloudwatchRegion(), maxAttempts: 2 });
  }
  return cachedClient as unknown as DescribeAlarmsSender;
}

const isoOf = (d: Date | string | undefined): string | null => {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * Alarms currently in ALARM, newest state change first. Throws on any read
 * error and on a timeout.
 */
export async function describeAlarmsInAlarm(
  opts: { client?: DescribeAlarmsSender; timeoutMs?: number; cap?: number } = {},
): Promise<{ alarms: CloudWatchAlarmLite[]; truncated: boolean }> {
  const client = opts.client ?? defaultClient();
  const cap = opts.cap ?? CLOUDWATCH_ALARM_CAP;
  const timeoutMs = opts.timeoutMs ?? CLOUDWATCH_READ_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`cloudwatch: DescribeAlarms timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  const read = async () => {
    const alarms: CloudWatchAlarmLite[] = [];
    let nextToken: string | undefined;
    let truncated = false;
    do {
      const out = await client.send(
        new DescribeAlarmsCommand({
          StateValue: 'ALARM',
          AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
          MaxRecords: Math.min(100, cap - alarms.length),
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
        { abortSignal: controller.signal },
      );
      for (const a of out.MetricAlarms ?? []) {
        if (a.StateValue && a.StateValue !== 'ALARM') continue;
        alarms.push({
          name: a.AlarmName ?? '(unnamed)',
          type: 'metric',
          namespace: a.Namespace ?? null,
          metric_name: a.MetricName ?? null,
          state_reason: a.StateReason ?? null,
          state_updated_at: isoOf(a.StateUpdatedTimestamp),
        });
      }
      for (const a of out.CompositeAlarms ?? []) {
        if (a.StateValue && a.StateValue !== 'ALARM') continue;
        alarms.push({
          name: a.AlarmName ?? '(unnamed)',
          type: 'composite',
          namespace: null,
          metric_name: null,
          state_reason: a.StateReason ?? null,
          state_updated_at: isoOf(a.StateUpdatedTimestamp),
        });
      }
      nextToken = out.NextToken || undefined;
      if (alarms.length >= cap) {
        truncated = alarms.length > cap || !!nextToken;
        break;
      }
    } while (nextToken);
    return { alarms: alarms.slice(0, cap), truncated };
  };

  try {
    const res = await Promise.race([read(), deadline]);
    res.alarms.sort((a, b) => Date.parse(b.state_updated_at ?? '') - Date.parse(a.state_updated_at ?? '') || a.name.localeCompare(b.name));
    return res;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const msg = e && e.message ? e.message : String(err);
    throw new Error(msg.startsWith('cloudwatch:') ? msg : `cloudwatch: ${e?.name && !msg.includes(e.name) ? `${e.name}: ` : ''}${msg}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
