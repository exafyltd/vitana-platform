/**
 * VTID-04987 — CloudWatch alarms in the Overview cockpit (plan C).
 *
 * The DescribeAlarms read (paginated, ALARM-only, capped, throws), the
 * cloudwatch_alarms rubric (P1 = `vitana-gateway-prod-*`, P2 = everything
 * else in ALARM), the OPS_ATTENTION_CLOUDWATCH_ENABLED gate, the aggregator
 * using attentionAdapters(), the staging-only workflow flag and the two
 * operator scripts. The SDK client is a fake: no network, no AWS, no database.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import {
  ATTENTION_ADAPTERS,
  CLOUDWATCH_ALARMS_ADAPTER,
  GATEWAY_PROD_ALARM_PREFIX,
  TILE_DOMAINS,
  attentionAdapters,
  cloudwatchAlarmsAdapter,
  isCloudwatchAlarmsEnabled,
  type CloudWatchAlarmLite,
} from '../src/services/ops-attention-adapters';
import { buildDomainSummary, buildOpsAttention, type AttentionStateStore } from '../src/services/ops-attention';
import {
  CLOUDWATCH_ALARM_CAP,
  cloudwatchRegion,
  describeAlarmsInAlarm,
  type DescribeAlarmsSender,
} from '../src/services/ops-attention-cloudwatch';
import { fakeReads } from './fixtures/ops-attention-fakes';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const memStore = (): AttentionStateStore => ({ load: async () => [], save: async () => {} });
const REPO = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

const FLAG = 'OPS_ATTENTION_CLOUDWATCH_ENABLED';
function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}
async function withFlagAsync<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

const metric = (name: string, o: Record<string, unknown> = {}) => ({
  AlarmName: name,
  StateValue: 'ALARM',
  Namespace: 'AWS/ApplicationELB',
  MetricName: 'HealthyHostCount',
  StateReason: 'Threshold Crossed: 2 datapoints [0.0, 0.0] were less than the threshold (1.0).',
  StateUpdatedTimestamp: new Date(NOW - 5 * 60_000),
  ...o,
});

/** A fake DescribeAlarms client serving `pages` in order, recording every input. */
function fakeClient(pages: Array<Record<string, unknown>>): DescribeAlarmsSender & { inputs: any[] } {
  const inputs: any[] = [];
  let i = 0;
  return {
    inputs,
    async send(cmd: DescribeAlarmsCommand) {
      expect(cmd).toBeInstanceOf(DescribeAlarmsCommand);
      inputs.push(cmd.input);
      return (pages[i++] ?? {}) as any;
    },
  };
}

// ── The read ────────────────────────────────────────────────────────────────

describe('describeAlarmsInAlarm (DescribeAlarms, read-only)', () => {
  it('asks for ALARM state only, metric + composite alarms, and follows NextToken', async () => {
    const client = fakeClient([
      { MetricAlarms: [metric('a-1')], NextToken: 't1' },
      { MetricAlarms: [metric('a-2')], CompositeAlarms: [{ AlarmName: 'c-1', StateValue: 'ALARM', StateReason: 'child', StateUpdatedTimestamp: new Date(NOW - 60_000) }], NextToken: 't2' },
      { MetricAlarms: [metric('a-3')] },
    ]);
    const out = await describeAlarmsInAlarm({ client });
    expect(client.inputs).toHaveLength(3);
    for (const input of client.inputs) {
      expect(input.StateValue).toBe('ALARM');
      expect(input.AlarmTypes).toEqual(['MetricAlarm', 'CompositeAlarm']);
      expect(input.MaxRecords).toBeLessThanOrEqual(100);
    }
    expect(client.inputs.map((x) => x.NextToken)).toEqual([undefined, 't1', 't2']);
    expect(out.truncated).toBe(false);
    expect(out.alarms.map((a) => a.name).sort()).toEqual(['a-1', 'a-2', 'a-3', 'c-1']);
    expect(out.alarms.find((a) => a.name === 'c-1')).toEqual({
      name: 'c-1', type: 'composite', namespace: null, metric_name: null, state_reason: 'child', state_updated_at: ago(60_000),
    });
    expect(out.alarms.find((a) => a.name === 'a-1')).toMatchObject({
      type: 'metric', namespace: 'AWS/ApplicationELB', metric_name: 'HealthyHostCount', state_updated_at: ago(5 * 60_000),
    });
  });

  it('drops anything the service returns that is not in ALARM (defence in depth)', async () => {
    const out = await describeAlarmsInAlarm({ client: fakeClient([{ MetricAlarms: [metric('ok-1', { StateValue: 'OK' }), metric('al-1')] }]) });
    expect(out.alarms.map((a) => a.name)).toEqual(['al-1']);
  });

  it(`caps at ${CLOUDWATCH_ALARM_CAP} alarms and reports truncated when more remain`, async () => {
    const page = (from: number, n: number, next?: string) => ({
      MetricAlarms: Array.from({ length: n }, (_, k) => metric(`m-${from + k}`)),
      ...(next ? { NextToken: next } : {}),
    });
    const client = fakeClient([page(0, 60, 'p2'), page(60, 40, 'p3'), page(100, 10)]);
    const out = await describeAlarmsInAlarm({ client });
    expect(out.alarms).toHaveLength(CLOUDWATCH_ALARM_CAP);
    expect(out.truncated).toBe(true);
    expect(client.inputs).toHaveLength(2); // stopped at the cap, did not read page 3
    expect(client.inputs[1].MaxRecords).toBe(40);
    // Exactly the cap with no further page is not truncated.
    const exact = await describeAlarmsInAlarm({ client: fakeClient([page(0, 100)]) });
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.alarms).toHaveLength(100);
  });

  it('throws on AccessDenied — never "no alarms"', async () => {
    const denied = Object.assign(new Error('User: arn:aws:sts::1:assumed-role/x is not authorized to perform: cloudwatch:DescribeAlarms'), { name: 'AccessDenied' });
    const client: DescribeAlarmsSender = { send: async () => { throw denied; } };
    await expect(describeAlarmsInAlarm({ client })).rejects.toThrow(/^cloudwatch: AccessDenied: User: .*cloudwatch:DescribeAlarms/);
  });

  it('throws when a later page fails (no partial "all clear")', async () => {
    let n = 0;
    const client: DescribeAlarmsSender = {
      send: async () => {
        if (n++ === 0) return { MetricAlarms: [metric('a-1')], NextToken: 't' } as any;
        throw Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });
      },
    };
    await expect(describeAlarmsInAlarm({ client })).rejects.toThrow('cloudwatch: Throttling: Rate exceeded');
  });

  it('times out (5 s by default) and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const client: DescribeAlarmsSender = {
      send: (_c, opts) => {
        signal = opts?.abortSignal;
        return new Promise(() => {});
      },
    };
    await expect(describeAlarmsInAlarm({ client, timeoutMs: 20 })).rejects.toThrow('cloudwatch: DescribeAlarms timed out after 20 ms');
    expect(signal?.aborted).toBe(true);
  });

  it('region comes from AWS_REGION, default eu-central-1', () => {
    const prev = process.env.AWS_REGION;
    try {
      delete process.env.AWS_REGION;
      expect(cloudwatchRegion()).toBe('eu-central-1');
      process.env.AWS_REGION = 'eu-central-1';
      expect(cloudwatchRegion()).toBe('eu-central-1');
    } finally {
      if (prev === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = prev;
    }
  });

  it('the module makes no write call: DescribeAlarms is the only CloudWatch command it imports', () => {
    const src = read('services/gateway/src/services/ops-attention-cloudwatch.ts');
    const imported = src.match(/import \{([^}]*)\} from '@aws-sdk\/client-cloudwatch'/)![1];
    expect(imported.split(',').map((s) => s.trim().replace(/^type /, '')).filter(Boolean).sort()).toEqual(
      ['CloudWatchClient', 'DescribeAlarmsCommand', 'DescribeAlarmsCommandOutput'],
    );
  });
});

// ── The rubric ──────────────────────────────────────────────────────────────

const alarm = (name: string, o: Partial<CloudWatchAlarmLite> = {}): CloudWatchAlarmLite => ({
  name, type: 'metric', namespace: 'AWS/ApplicationELB', metric_name: 'HealthyHostCount',
  state_reason: 'Threshold Crossed', state_updated_at: ago(10 * 60_000), ...o,
});

function navigationConfig(): Array<{ section: string; tabs: Array<{ key: string }> }> {
  const src = read('services/gateway/src/frontend/command-hub/app.js');
  const start = src.indexOf('const NAVIGATION_CONFIG = [');
  const end = src.indexOf('\n];', start);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${src.slice(start + 'const NAVIGATION_CONFIG = '.length, end + 2)};`)();
}

describe('cloudwatch_alarms adapter rubric', () => {
  it(`P1 = an alarm in ALARM named ${GATEWAY_PROD_ALARM_PREFIX}*; every other alarm in ALARM = P2 (staging included)`, async () => {
    const out = await cloudwatchAlarmsAdapter(fakeReads({
      cloudwatchAlarms: async () => ({
        truncated: false,
        alarms: [
          alarm('vitana-gateway-prod-no-healthy-targets'),
          alarm('vitana-gateway-staging-no-healthy-targets'),
          alarm('vitana-oasis-operator-cpu', { namespace: 'AWS/ECS', metric_name: 'CPUUtilization' }),
          alarm('xvitana-gateway-prod-lookalike'),
          alarm('composite-x', { type: 'composite', namespace: null, metric_name: null }),
        ],
      }),
    }));
    expect(out.partial_error).toBeUndefined();
    expect(out.candidates.map((c) => [c.key, c.severity])).toEqual([
      ['vitana-gateway-prod-no-healthy-targets', 'P1'],
      ['vitana-gateway-staging-no-healthy-targets', 'P2'],
      ['vitana-oasis-operator-cpu', 'P2'],
      ['xvitana-gateway-prod-lookalike', 'P2'],
      ['composite-x', 'P2'],
    ]);
    expect(out.candidates.every((c) => c.domain === 'platform')).toBe(true);
  });

  it('items deep-link to the platform tile screen and carry name, namespace, reason and state time', async () => {
    const out = await cloudwatchAlarmsAdapter(fakeReads({
      cloudwatchAlarms: async () => ({ truncated: false, alarms: [alarm('vitana-gateway-prod-no-healthy-targets', { state_reason: 'no targets' })] }),
    }));
    const c = out.candidates[0];
    expect(c.deeplink).toEqual(TILE_DOMAINS.find((d) => d.key === 'platform')!.deeplink);
    expect(c.deeplink).toEqual({ section: 'overview', tab: 'system-overview', query: {} });
    const nav = navigationConfig();
    expect(nav.find((s) => s.section === 'overview')!.tabs.map((t) => t.key)).toContain('system-overview');
    expect(c.evidence).toMatchObject({
      alarm_name: 'vitana-gateway-prod-no-healthy-targets',
      namespace: 'AWS/ApplicationELB',
      reason: 'no targets',
      state_updated_at: ago(10 * 60_000),
    });
    // CloudWatch already held it for its evaluation periods: no second hold.
    expect(c).toMatchObject({ since: ago(10 * 60_000), hold_ms: 0, count: 1 });
    expect(c.title).toContain('vitana-gateway-prod-no-healthy-targets');
  });

  it('a capped read is partial (UNKNOWN) and still shows what it found; a failed read throws', async () => {
    const capped = await cloudwatchAlarmsAdapter(fakeReads({ cloudwatchAlarms: async () => ({ truncated: true, alarms: [alarm('a')] }) }));
    expect(capped.partial_error).toMatch(/cap/);
    expect(capped.candidates).toHaveLength(1);
    await expect(cloudwatchAlarmsAdapter(fakeReads({ cloudwatchAlarms: async () => { throw new Error('cloudwatch: AccessDenied'); } })))
      .rejects.toThrow('cloudwatch: AccessDenied');
  });

  it('no alarms in ALARM = no items', async () => {
    expect((await cloudwatchAlarmsAdapter(fakeReads())).candidates).toEqual([]);
  });
});

// ── Gating ──────────────────────────────────────────────────────────────────

describe('OPS_ATTENTION_CLOUDWATCH_ENABLED gate', () => {
  it('only the exact string "true" registers the source; unset, "false", "TRUE", "1" do not', () => {
    for (const v of [undefined, 'false', 'TRUE', '1', ' true', '']) {
      withFlag(v, () => {
        expect(isCloudwatchAlarmsEnabled()).toBe(false);
        expect(attentionAdapters()).toBe(ATTENTION_ADAPTERS);
      });
    }
    withFlag('true', () => {
      expect(isCloudwatchAlarmsEnabled()).toBe(true);
      expect(attentionAdapters()).toEqual([...ATTENTION_ADAPTERS, CLOUDWATCH_ALARMS_ADAPTER]);
    });
    expect(ATTENTION_ADAPTERS.map((a) => a.id)).not.toContain('cloudwatch_alarms');
    expect(CLOUDWATCH_ALARMS_ADAPTER).toMatchObject({ id: 'cloudwatch_alarms', timeoutMs: 6_000 });
  });

  it('flag off: the platform tile shows cloudwatch_alarms as not monitored — the tile is not unknown', () => {
    withFlag(undefined, () => {
      const sources = ATTENTION_ADAPTERS.map((a) => ({ id: a.id, status: 'ok' as const, fetched_at: ago(0) }));
      const platform = buildDomainSummary(sources, []).find((d) => d.key === 'platform')!;
      expect(platform).toMatchObject({ monitored: true, status: 'ok', sources_total: 1, sources_fresh: 1, source_ids: ['service_health'] });
      expect(platform.not_wired).toEqual([{ id: 'cloudwatch_alarms', reason: expect.stringContaining('OPS_ATTENTION_CLOUDWATCH_ENABLED') }]);
    });
  });

  it('flag on: a registered source that did not report is unknown (never ok)', () => {
    withFlag('true', () => {
      const sources = ATTENTION_ADAPTERS.map((a) => ({ id: a.id, status: 'ok' as const, fetched_at: ago(0) }));
      const platform = buildDomainSummary(sources, []).find((d) => d.key === 'platform')!;
      expect(platform).toMatchObject({ status: 'unknown', sources_total: 2, source_ids: ['service_health', 'cloudwatch_alarms'], not_wired: [] });
    });
  });
});

// ── The aggregator uses attentionAdapters() ─────────────────────────────────

describe('aggregator default = attentionAdapters()', () => {
  it('flag off: no cloudwatch_alarms source runs; the platform tile is ok with the source not monitored; nothing UNKNOWN', async () => {
    const calls: number[] = [];
    const data = await withFlagAsync(undefined, () => buildOpsAttention({
      env: 'production', now: NOW, state: memStore(),
      reads: fakeReads({ cloudwatchAlarms: async () => { calls.push(1); return { alarms: [], truncated: false }; } }),
    }));
    expect(calls).toEqual([]);
    expect(data.sources.map((s) => s.id)).not.toContain('cloudwatch_alarms');
    const platform = data.domains.find((d) => d.key === 'platform')!;
    expect(platform.status).toBe('ok');
    expect(platform.not_wired.map((n) => n.id)).toEqual(['cloudwatch_alarms']);
    // Gated off is not missing data: nothing reads UNKNOWN because of it.
    expect(data.sources.every((src) => src.status === 'ok')).toBe(true);
    expect(data.verdict).not.toBe('UNKNOWN');
  });

  it('flag on + AccessDenied: the source is unknown with the error; the platform tile and the verdict are UNKNOWN', async () => {
    const data = await withFlagAsync('true', () => buildOpsAttention({
      env: 'production', now: NOW, state: memStore(),
      reads: fakeReads({
        cloudwatchAlarms: async () => { throw new Error('cloudwatch: AccessDenied: not authorized to perform: cloudwatch:DescribeAlarms'); },
      }),
    }));
    expect(data.sources.find((s) => s.id === 'cloudwatch_alarms')).toMatchObject({
      status: 'unknown', error: expect.stringContaining('AccessDenied'),
    });
    const platform = data.domains.find((d) => d.key === 'platform')!;
    expect(platform).toMatchObject({ status: 'unknown', not_wired: [] });
    expect(platform.errors).toEqual([expect.stringContaining('cloudwatch_alarms: cloudwatch: AccessDenied')]);
    expect(data.verdict).toBe('UNKNOWN');
  });

  it('flag on + a production-gateway alarm in ALARM: a P1 item on the platform tile, verdict CRITICAL', async () => {
    const data = await withFlagAsync('true', () => buildOpsAttention({
      env: 'production', now: NOW, state: memStore(),
      reads: fakeReads({
        cloudwatchAlarms: async () => ({ truncated: false, alarms: [alarm('vitana-gateway-prod-no-healthy-targets'), alarm('vitana-gateway-staging-no-healthy-targets')] }),
      }),
    }));
    expect(data.sources.find((s) => s.id === 'cloudwatch_alarms')).toMatchObject({ status: 'ok' });
    const items = data.items.filter((i) => i.source === 'cloudwatch_alarms');
    expect(items.map((i) => [i.fingerprint, i.severity])).toEqual([
      ['production:cloudwatch_alarms:vitana-gateway-prod-no-healthy-targets', 'P1'],
      ['production:cloudwatch_alarms:vitana-gateway-staging-no-healthy-targets', 'P2'],
    ]);
    expect(data.domains.find((d) => d.key === 'platform')).toMatchObject({ status: 'ok', worst_severity: 'P1', open: 2, sources_total: 2 });
    expect(data.verdict).toBe('CRITICAL');
  });

  it('explicit adapters still override the default (the existing test seam)', async () => {
    const data = await withFlagAsync('true', () => buildOpsAttention({
      env: 'production', now: NOW, state: memStore(), reads: fakeReads(), adapters: [CLOUDWATCH_ALARMS_ADAPTER],
    }));
    expect(data.sources.map((s) => s.id)).toEqual(['cloudwatch_alarms', 'attention_state']);
  });

  it('the aggregator source reads the helper, not the constant', () => {
    const src = read('services/gateway/src/services/ops-attention.ts');
    expect(src).toContain('const adapters = input.adapters ?? attentionAdapters();');
    expect(src).not.toMatch(/input\.adapters \?\? ATTENTION_ADAPTERS/);
  });
});

// ── Staging-only flag ───────────────────────────────────────────────────────

describe('OPS_ATTENTION_CLOUDWATCH_ENABLED pinning', () => {
  it('staging strips it and sets exactly "true"', () => {
    const s = read('.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(s).toContain('"OPS_ATTENTION_CLOUDWATCH_ENABLED",');
    expect(s).toContain('{name:"OPS_ATTENTION_CLOUDWATCH_ENABLED", value:"true"}');
  });
  it('prod does not set it (a later follow-up PR, after staging shows the source ok)', () => {
    expect(read('.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml')).not.toContain('OPS_ATTENTION_CLOUDWATCH_ENABLED');
  });
});

// ── Operator scripts (static checks; never executed here) ───────────────────

describe('operator scripts', () => {
  const grant = read('scripts/aws/setup-gateway-cloudwatch-read-grant.sh');
  const alarmScript = read('scripts/aws/setup-gateway-alb-health-alarm.sh');
  const code = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('both are dry-run by default and change something only with --apply', () => {
    for (const s of [grant, alarmScript]) {
      expect(s).toMatch(/APPLY=0/);
      expect(s).toContain('--apply) APPLY=1');
      expect(s).toContain('set -euo pipefail');
    }
  });

  it('the grant resolves the task role from the live task definition and grants cloudwatch:DescribeAlarms only', () => {
    const c = code(grant);
    expect(c).toContain('describe-services');
    expect(c).toContain('describe-task-definition');
    expect(c).toContain('taskRoleArn');
    expect(c).toContain('put-role-policy');
    expect(c.match(/"cloudwatch:[A-Za-z]+"/g)).toEqual(['"cloudwatch:DescribeAlarms"']);
    expect(c).toContain('"Resource": "*"');
    expect(c).toContain('vitana-gateway-awsdr');
    expect(c).toMatch(/staging\)\s+SERVICE="vitana-gateway"/);
    // Verifies with a read-only call.
    expect(c).toContain('cloudwatch describe-alarms');
    expect(c).toContain('472838866351');
  });

  it('the alarm resolves service → target group → ALB from AWS, never by target-group name, and refuses without the SNS topic', () => {
    const c = code(alarmScript);
    expect(c).toContain('describe-services');
    expect(c).toContain('loadBalancers[].targetGroupArn');
    expect(c).toContain('--target-group-arns');
    expect(c).not.toMatch(/describe-target-groups[^\n]*--names/);
    expect(alarmScript).toContain('vitana-tg-gateway-prod');
    expect(alarmScript).toMatch(/serves STAGING/);
    expect(c).toContain('vitana-gateway-prod-no-healthy-targets');
    expect(c).toContain('vitana-gateway-staging-no-healthy-targets');
    expect(c).toContain('--namespace AWS/ApplicationELB');
    expect(c).toContain('--metric-name HealthyHostCount');
    expect(c).toContain('--statistic Minimum');
    expect(c).toContain('--comparison-operator LessThanThreshold');
    expect(c).toContain('--threshold 1');
    expect(c).toContain('--period 60');
    expect(c).toContain('--evaluation-periods 2');
    expect(c).toContain('--treat-missing-data breaching');
    expect(c).toContain('vitana-alarms-prod');
    expect(alarmScript).toContain(GATEWAY_PROD_ALARM_PREFIX);
    expect(alarmScript).toMatch(/TreatMissingData/);
  });
});
