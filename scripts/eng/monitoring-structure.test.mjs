// Structure test for the monitoring of the self-hosted GitLab CI (plan eng-gitlab-m2 §3.6, lane monitoring).
//
// Reads infra/gitlab-engineering/terraform/monitoring.tf together with milestone 1's main.tf and pins what the plan promises:
// an encrypted topic that CloudWatch can really publish to, every alarm of §3.6 with its metric, threshold, period and its
// treatment of missing data (a heartbeat that goes quiet is an alarm, a queue number that is missing is not), the monthly budget at
// 50, 80 and 100 %, and a host role that may publish metrics to one namespace and nothing else. It also pins the two systemd
// units of the metrics job and the CloudWatch agent script, and runs that script against stand-ins for curl, gpg, dpkg and the
// agent, so the one script nobody can try on a real host before the owner's apply is exercised here.
// Dependency-free Node (node:test), so UNIT.yml runs it with no install. It never calls AWS, GitLab or the network.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(REPO, 'infra', 'gitlab-engineering');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// Read when a case runs, never when the module loads, and a case reads only the names it destructures: on a tree without the lane
// (origin/main) every case fails on its own with ENOENT instead of one crash hiding all of them.
const files = {
  get MON() { return read('terraform/monitoring.tf'); },
  get MAIN() { return read('terraform/main.tf'); },
  get SERVICE() { return read('host/units/vitana-ci-metrics.service'); },
  get TIMER() { return read('host/units/vitana-ci-metrics.timer'); },
  get CWAGENT() { return read('host/ops.d/20-cwagent.sh'); },
  get SOURCE() { return readFileSync(path.join(REPO, 'scripts', 'eng', 'ci-metrics.mjs'), 'utf8'); },
  get TASKS() { return readFileSync(path.join(REPO, '.kiro', 'specs', 'eng-gitlab-m2', 'tasks.md'), 'utf8'); },
};
const test = (name, fn) => nodeTest(name, () => fn(files));

// ------------------------------------------------------------ Terraform reading helpers
/** Text of `<kind> "<label>" ... { ... }` found by brace matching (strings and comments skipped). */
function block(src, kind, ...labels) {
  const head = `^${kind}\\s+${labels.map((l) => `"${l}"`).join('\\s+')}\\s*\\{`;
  const m = new RegExp(head, 'm').exec(src);
  assert.ok(m, `${kind} ${labels.join('.')} not found`);
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') { i++; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; } continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) break;
  }
  return src.slice(m.index, i + 1);
}
const namesOf = (src, kind, type) => [...src.matchAll(new RegExp(`^${kind}\\s+"${type}"\\s+"([^"]+)"`, 'gm'))].map((m) => m[1]);
/** Labels of blocks that have one label: variable "x" {  output "x" { */
const labelsOf = (src, kind) => [...src.matchAll(new RegExp(`^${kind}\\s+"([^"]+)"\\s*\\{`, 'gm'))].map((m) => m[1]);
const declared = (src) => [...src.matchAll(/^(resource|data)\s+"([^"]+)"\s+"([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}.${m[3]}`);
const attr = (b, name) => new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(b)?.[1];
const unquote = (s) => (s === undefined ? s : s.replace(/^"(.*)"$/, '$1'));
/** `dimensions = { A = x  B = y }` as an object of the right-hand sides. */
function dimensionsOf(b) {
  const m = /dimensions\s*=\s*\{([^}]*)\}/.exec(b);
  if (!m) return {};
  return Object.fromEntries([...m[1].matchAll(/^\s*(\w+)\s*=\s*(.+?)\s*$/gm)].map((x) => [x[1], unquote(x[2])]));
}
const stripComment = (line) => line.replace(/(^|\s)#.*$/, '');
const codeOf = (src) => src.split('\n').map(stripComment).join('\n');

// What the plan (§3.6) says each alarm is. The metric names, the unit dimension and the namespace are the ones ci-metrics.mjs
// publishes; ci-metrics.test.mjs pins those names in the module, and the last case of this file ties the two together.
const NS = 'Vitana/Engineering';
const ALARMS = {
  oldest_pending_job: {
    name: 'vitana-eng-oldest-pending-job', namespace: NS, metric: 'OldestPendingJobAgeSeconds', dims: {}, statistic: 'Maximum',
    operator: 'GreaterThanThreshold', threshold: '600', period: '60', periods: '3', datapoints: '3', missing: 'notBreaching', // oldest pending job over 10 min
  },
  fleet_at_maximum: {
    name: 'vitana-eng-fleet-at-maximum', namespace: NS, metric: 'FleetRunningJobs', dims: {}, statistic: 'Minimum',
    operator: 'GreaterThanOrEqualToThreshold', threshold: 'var.fleet_alarm_running_jobs', period: '60', periods: '30', datapoints: '30', missing: 'notBreaching', // 30 min
  },
  gitlab_host_status: {
    name: 'vitana-eng-gitlab-host-status', namespace: 'AWS/EC2', metric: 'StatusCheckFailed', dims: { InstanceId: 'aws_instance.gitlab.id' }, statistic: 'Maximum',
    operator: 'GreaterThanThreshold', threshold: '0', period: '60', periods: '5', datapoints: '5', missing: 'breaching',
  },
  gitlab_disk_used: {
    name: 'vitana-eng-gitlab-disk-used', namespace: NS, metric: 'disk_used_percent', dims: { InstanceId: 'aws_instance.gitlab.id' }, statistic: 'Maximum',
    operator: 'GreaterThanThreshold', threshold: '80', period: '300', periods: '3', datapoints: '3', missing: 'notBreaching',
  },
  gitlab_lb_unhealthy_target: {
    name: 'vitana-eng-gitlab-lb-unhealthy-target', namespace: 'AWS/ApplicationELB', metric: 'UnHealthyHostCount',
    dims: { LoadBalancer: 'aws_lb.gitlab.arn_suffix', TargetGroup: 'aws_lb_target_group.gitlab.arn_suffix' }, statistic: 'Maximum',
    operator: 'GreaterThanThreshold', threshold: '0', period: '60', periods: '5', datapoints: '5', missing: 'notBreaching',
  },
  backup_age: {
    name: 'vitana-eng-backup-age', namespace: NS, metric: 'BackupAgeSeconds', dims: {}, statistic: 'Maximum',
    operator: 'GreaterThanThreshold', threshold: '108000', period: '300', periods: '3', datapoints: '3', missing: 'breaching', // 30 h = 108000 s
  },
  merge_bot_tick: {
    name: 'vitana-eng-merge-bot-tick', namespace: NS, metric: 'TickAgeSeconds', dims: { Unit: 'vitana-land' }, statistic: 'Maximum',
    operator: 'GreaterThanThreshold', threshold: '900', period: '60', periods: '3', datapoints: '3', missing: 'breaching', // 15 min = 900 s
  },
  settings_sync_tick: {
    name: 'vitana-eng-settings-sync-tick', namespace: NS, metric: 'TickAgeSeconds', dims: { Unit: 'vitana-settings' }, statistic: 'Maximum',
    operator: 'GreaterThanThreshold', threshold: '900', period: '60', periods: '3', datapoints: '3', missing: 'breaching',
  },
};

// ================================================================== Terraform: fits next to main.tf
test('monitoring.tf is a second file of the same module: it declares no provider, backend or terraform block and no name main.tf already uses', ({ MON, MAIN }) => {
  const code = codeOf(MON);
  assert.equal(/^\s*provider\s+"/m.test(code), false, 'no provider block (main.tf configures AWS)');
  assert.equal(/^\s*terraform\s*\{/m.test(code), false, 'no terraform block (main.tf pins the version and the backend)');
  assert.equal(/^\s*backend\s+"/m.test(code), false, 'no backend');
  const mine = declared(MON);
  const theirs = declared(MAIN);
  assert.deepEqual(mine.sort(), [
    'data.aws_iam_policy_document.alerts_key', 'data.aws_iam_policy_document.monitoring',
    'resource.aws_budgets_budget.monthly', 'resource.aws_iam_role_policy.monitoring', 'resource.aws_kms_alias.alerts', 'resource.aws_kms_key.alerts',
    'resource.aws_sns_topic.alerts', 'resource.aws_sns_topic_subscription.owner_email',
    ...Object.keys(ALARMS).map((a) => `resource.aws_cloudwatch_metric_alarm.${a}`),
  ].sort(), 'exactly what the lane needs, nothing else');
  assert.deepEqual(mine.filter((n) => theirs.includes(n)), [], 'no resource or data source is declared twice');
  assert.deepEqual(labelsOf(MON, 'variable').filter((n) => labelsOf(MAIN, 'variable').includes(n)), [], 'no variable is declared twice');
  assert.deepEqual(labelsOf(MON, 'output').filter((n) => labelsOf(MAIN, 'output').includes(n)), [], 'no output is declared twice');
});

test('every variable has a default, so the owner\'s existing setup.sh apply needs no new -var flag', ({ MON }) => {
  const vars = labelsOf(MON, 'variable');
  assert.deepEqual(vars.sort(), ['alert_email', 'fleet_alarm_running_jobs', 'monthly_budget_usd']);
  for (const v of vars) assert.match(block(MON, 'variable', v), /^\s*default\s*=/m, `${v} has a default`);
  assert.match(block(MON, 'variable', 'alert_email'), /type\s*=\s*string[\s\S]*default\s*=\s*""/);
  assert.match(block(MON, 'variable', 'monthly_budget_usd'), /type\s*=\s*number[\s\S]*default\s*=\s*1000\b/);
  assert.match(block(MON, 'variable', 'fleet_alarm_running_jobs'), /type\s*=\s*number[\s\S]*default\s*=\s*24\b/, 'plan §3.2: fleet_max_instances defaults to 24');
  assert.match(MON, /setup\.sh/, 'the file says why the defaults matter');
});

test('every reference to milestone 1 points at something main.tf really declares', ({ MON, MAIN }) => {
  const code = codeOf(MON);
  const refs = new Set([...code.matchAll(/\b(aws_[a-z0-9_]+)\.([a-z0-9_]+)\b/g)].map((m) => `${m[1]}.${m[2]}`));
  const mine = new Set(declared(MON).map((d) => d.replace(/^(resource|data)\./, '')));
  const theirs = new Set(declared(MAIN).map((d) => d.replace(/^(resource|data)\./, '')));
  const missing = [...refs].filter((r) => !mine.has(r) && !theirs.has(r));
  assert.deepEqual(missing, [], 'a reference that neither file declares would fail terraform validate');
  for (const needed of ['aws_instance.gitlab', 'aws_iam_role.gitlab', 'aws_lb.gitlab', 'aws_lb_target_group.gitlab', 'aws_caller_identity.me']) {
    assert.ok(refs.has(needed), `monitoring.tf uses ${needed} from main.tf`);
    assert.ok(theirs.has(needed), `main.tf declares ${needed}`);
  }
  assert.match(MAIN, /variable "admin_email"/, 'the owner\'s address is a main.tf variable');
});

// ================================================================== Terraform: the topic
test('topic vitana-eng-alerts is encrypted with its own customer-managed key (the M1 key cannot be used by CloudWatch)', ({ MON }) => {
  const topic = block(MON, 'resource', 'aws_sns_topic', 'alerts');
  assert.match(topic, /name\s*=\s*"vitana-eng-alerts"/);
  assert.match(topic, /kms_master_key_id\s*=\s*aws_kms_key\.alerts\.arn/);
  assert.equal(/aws_kms_key\.main|alias\/aws\/sns/.test(topic), false, 'neither the M1 key nor the AWS managed SNS key: CloudWatch cannot use them');
  const key = block(MON, 'resource', 'aws_kms_key', 'alerts');
  assert.match(key, /enable_key_rotation\s*=\s*true/);
  assert.match(key, /deletion_window_in_days\s*=\s*30\b/);
  assert.match(key, /policy\s*=\s*data\.aws_iam_policy_document\.alerts_key\.json/);
  assert.match(block(MON, 'resource', 'aws_kms_alias', 'alerts'), /name\s*=\s*"alias\/vitana-engineering-alerts"/);
  assert.equal(/\bpolicy\s*=\s*"|jsonencode|<<-?[A-Z]/.test(codeOf(MON)), false, 'policies are data documents only');
});

test('key policy: the account keeps control, and cloudwatch.amazonaws.com may only decrypt and generate data keys, for alarms of this account', ({ MON }) => {
  const doc = block(MON, 'data', 'aws_iam_policy_document', 'alerts_key');
  const statements = [...doc.matchAll(/statement\s*\{([\s\S]*?)\n  \}/g)].map((m) => m[1]);
  assert.equal(statements.length, 2);
  const [root, cw] = statements;
  assert.match(root, /sid\s*=\s*"EnableIamPolicies"/);
  assert.match(root, /actions\s*=\s*\["kms:\*"\]/);
  assert.match(root, /arn:aws:iam::\$\{data\.aws_caller_identity\.me\.account_id\}:root/);
  assert.match(cw, /sid\s*=\s*"AllowCloudWatchAlarms"/);
  assert.match(cw, /type\s*=\s*"Service"[\s\S]*identifiers\s*=\s*\["cloudwatch\.amazonaws\.com"\]/);
  assert.match(cw, /actions\s*=\s*\["kms:Decrypt", "kms:GenerateDataKey\*"\]/);
  assert.match(cw, /variable\s*=\s*"aws:SourceAccount"[\s\S]*values\s*=\s*\[data\.aws_caller_identity\.me\.account_id\]/);
  assert.match(cw, /test\s*=\s*"ArnLike"[\s\S]*variable\s*=\s*"aws:SourceArn"[\s\S]*arn:aws:cloudwatch:\$\{var\.region\}:\$\{data\.aws_caller_identity\.me\.account_id\}:alarm:\*/);
});

test('the e-mail subscription goes to alert_email, or to the admin_email setup.sh already passes; a bad address stops the plan', ({ MON }) => {
  assert.match(MON, /monitoring_alert_email\s*=\s*trimspace\(var\.alert_email != "" \? var\.alert_email : var\.admin_email\)/);
  const sub = block(MON, 'resource', 'aws_sns_topic_subscription', 'owner_email');
  assert.match(sub, /topic_arn\s*=\s*aws_sns_topic\.alerts\.arn/);
  assert.match(sub, /protocol\s*=\s*"email"/);
  assert.match(sub, /endpoint\s*=\s*local\.monitoring_alert_email/);
  assert.match(sub, /precondition\s*\{[\s\S]*condition\s*=\s*can\(regex\(/, 'a malformed or empty address fails at plan time, not silently at delivery');
  assert.match(sub, /error_message\s*=\s*"[^"]*alert_email/);
  assert.deepEqual(namesOf(MON, 'resource', 'aws_sns_topic_subscription'), ['owner_email'], 'one subscription');
});

// ================================================================== Terraform: the alarms
test('exactly the eight alarms of plan §3.6 exist', ({ MON }) => {
  assert.deepEqual(namesOf(MON, 'resource', 'aws_cloudwatch_metric_alarm').sort(), Object.keys(ALARMS).sort());
});

for (const [res, want] of Object.entries(ALARMS)) {
  test(`alarm ${want.name}: ${want.metric} ${want.operator} ${want.threshold}, ${want.periods} x ${want.period} s, missing data ${want.missing}`, ({ MON }) => {
    const b = block(MON, 'resource', 'aws_cloudwatch_metric_alarm', res);
    assert.equal(unquote(attr(b, 'alarm_name')), want.name, 'name');
    assert.equal(unquote(attr(b, 'namespace')), want.namespace === NS ? 'local.monitoring_namespace' : want.namespace, 'namespace');
    assert.equal(unquote(attr(b, 'metric_name')), want.metric, 'metric');
    assert.deepEqual(dimensionsOf(b), want.dims, 'dimensions');
    assert.equal(unquote(attr(b, 'statistic')), want.statistic, 'statistic');
    assert.equal(unquote(attr(b, 'comparison_operator')), want.operator, 'operator');
    assert.equal(attr(b, 'threshold'), want.threshold, 'threshold');
    assert.equal(attr(b, 'period'), want.period, 'period');
    assert.equal(attr(b, 'evaluation_periods'), want.periods, 'evaluation periods');
    assert.equal(attr(b, 'datapoints_to_alarm'), want.datapoints, 'datapoints to alarm');
    assert.equal(unquote(attr(b, 'treat_missing_data')), want.missing, 'treatment of missing data');
    assert.equal(attr(b, 'alarm_actions'), '[aws_sns_topic.alerts.arn]', 'tells the topic');
    assert.match(attr(b, 'alarm_description') ?? '', /^".{40,}"$/, 'says in words what it means');
  });
}

test('a heartbeat that goes quiet is an alarm; a queue number that is missing is not (plan §3.6 States)', ({ MON }) => {
  const missing = (res) => unquote(attr(block(MON, 'resource', 'aws_cloudwatch_metric_alarm', res), 'treat_missing_data'));
  for (const heartbeat of ['gitlab_host_status', 'backup_age', 'merge_bot_tick', 'settings_sync_tick']) assert.equal(missing(heartbeat), 'breaching', heartbeat);
  for (const queue of ['oldest_pending_job', 'fleet_at_maximum']) assert.equal(missing(queue), 'notBreaching', queue);
  for (const other of ['gitlab_disk_used', 'gitlab_lb_unhealthy_target']) assert.equal(missing(other), 'notBreaching', `${other}: a quiet agent or an empty target group is not an incident, the host status alarm covers a dead host`);
});

test('only alarm_actions: a healthy system sends nothing, and an alarm that clears does not send a second mail', ({ MON }) => {
  const code = codeOf(MON);
  assert.equal(/\bok_actions\b|\binsufficient_data_actions\b/.test(code), false);
  assert.equal(/actions_enabled\s*=\s*false/.test(code), false, 'no alarm is switched off');
  assert.equal([...code.matchAll(/alarm_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\]/g)].length, 8, 'all eight alarms tell the one topic');
});

test('the fleet alarm threshold is the fleet maximum of plan §3.2 (24) through a variable, evaluated over 30 one-minute periods', ({ MON }) => {
  const b = block(MON, 'resource', 'aws_cloudwatch_metric_alarm', 'fleet_at_maximum');
  assert.equal(attr(b, 'threshold'), 'var.fleet_alarm_running_jobs');
  assert.equal(Number(attr(b, 'period')) * Number(attr(b, 'evaluation_periods')), 30 * 60, 'fleet at maximum for 30 min');
  assert.match(block(MON, 'variable', 'fleet_alarm_running_jobs'), /fleet_max_instances/, 'the description tells the owner to keep the two equal');
});

test('the tick alarms are 15 minutes (900 s) of age on the two units of plan §3.3 and §3.4; the backup alarm is 30 hours', ({ MON }) => {
  for (const res of ['merge_bot_tick', 'settings_sync_tick']) assert.equal(attr(block(MON, 'resource', 'aws_cloudwatch_metric_alarm', res), 'threshold'), '900');
  assert.equal(attr(block(MON, 'resource', 'aws_cloudwatch_metric_alarm', 'backup_age'), 'threshold'), String(30 * 3600));
  assert.equal(attr(block(MON, 'resource', 'aws_cloudwatch_metric_alarm', 'oldest_pending_job'), 'threshold'), String(10 * 60));
});

// ================================================================== Terraform: the budget
test('budget: monthly, in dollars, from a variable, with mails at 50, 80 and 100 percent of the actual cost, straight to the owner', ({ MON }) => {
  const b = block(MON, 'resource', 'aws_budgets_budget', 'monthly');
  assert.equal(unquote(attr(b, 'name')), 'vitana-eng-monthly');
  assert.equal(unquote(attr(b, 'budget_type')), 'COST');
  assert.equal(unquote(attr(b, 'time_unit')), 'MONTHLY');
  assert.equal(unquote(attr(b, 'limit_unit')), 'USD');
  assert.equal(attr(b, 'limit_amount'), 'tostring(var.monthly_budget_usd)');
  const notifications = [...b.matchAll(/notification\s*\{([\s\S]*?)\n  \}/g)].map((m) => m[1]);
  assert.deepEqual(notifications.map((n) => Number(attr(n, 'threshold'))), [50, 80, 100]);
  for (const n of notifications) {
    assert.equal(unquote(attr(n, 'comparison_operator')), 'GREATER_THAN');
    assert.equal(unquote(attr(n, 'threshold_type')), 'PERCENTAGE');
    assert.equal(unquote(attr(n, 'notification_type')), 'ACTUAL');
    assert.equal(attr(n, 'subscriber_email_addresses'), '[local.monitoring_alert_email]');
    assert.equal(/subscriber_sns_topic_arns/.test(n), false, 'a budget refused by an encrypted topic would fail the whole apply');
  }
  assert.match(MON, /Budgets/i, 'the file says why the budget mails the owner directly');
});

// ================================================================== Terraform: IAM
test('the host role may publish metrics to the namespace Vitana/Engineering and do nothing else here', ({ MON }) => {
  const doc = block(MON, 'data', 'aws_iam_policy_document', 'monitoring');
  const statements = [...doc.matchAll(/statement\s*\{([\s\S]*?)\n  \}/g)].map((m) => m[1]);
  assert.equal(statements.length, 1);
  const s = statements[0];
  assert.match(s, /sid\s*=\s*"PublishEngineeringMetrics"/);
  assert.match(s, /actions\s*=\s*\["cloudwatch:PutMetricData"\]/);
  assert.match(s, /resources\s*=\s*\["\*"\]/, 'PutMetricData has no resource-level permission; the namespace condition is the limit');
  assert.match(s, /test\s*=\s*"StringEquals"[\s\S]*variable\s*=\s*"cloudwatch:namespace"[\s\S]*values\s*=\s*\[local\.monitoring_namespace\]/);
  const attach = block(MON, 'resource', 'aws_iam_role_policy', 'monitoring');
  assert.match(attach, /role\s*=\s*aws_iam_role\.gitlab\.id/);
  assert.match(attach, /policy\s*=\s*data\.aws_iam_policy_document\.monitoring\.json/);
  assert.match(attach, /name\s*=\s*"monitoring"/);
  assert.match(MON, /namespace\s*=\s*"Vitana\/Engineering"|monitoring_namespace\s*=\s*"Vitana\/Engineering"/);
});

test('wildcards: only kms:* for the account in the key policy, kms:GenerateDataKey* for CloudWatch, and PutMetricData on * with its namespace condition', ({ MON }) => {
  const code = codeOf(MON);
  const wild = [...code.matchAll(/"[^"\n]*\*[^"\n]*"/g)].map((m) => m[0]).filter((s) => !s.startsWith('"arn:aws:cloudwatch:'));
  assert.deepEqual([...new Set(wild)].sort(), ['"*"', '"kms:*"', '"kms:GenerateDataKey*"'].sort());
  assert.equal(/AdministratorAccess|PowerUserAccess|"arn:aws:iam::aws:policy/.test(code), false, 'no managed policy is attached');
  assert.deepEqual(namesOf(MON, 'resource', 'aws_iam_policy'), [], 'no customer-managed policy resource');
  const attributes = [...code.matchAll(/^\s*(policy|assume_role_policy)\s*=\s*(.+)$/gm)].map((m) => m[2].trim());
  assert.ok(attributes.length >= 2);
  for (const rhs of attributes) assert.match(rhs, /^data\.aws_iam_policy_document\.\w+\.json$/, `a policy must be a data document: ${rhs}`);
});

// ================================================================== Terraform: outputs for m2.sh status
test('outputs give m2.sh status what it needs: topic, recipient, alarm names, budget and namespace; no secret', ({ MON }) => {
  const outs = labelsOf(MON, 'output').sort();
  assert.deepEqual(outs, ['alarm_names', 'alerts_email', 'alerts_topic_arn', 'budget_name', 'metrics_namespace']);
  assert.match(block(MON, 'output', 'alerts_topic_arn'), /value\s*=\s*aws_sns_topic\.alerts\.arn/);
  assert.match(block(MON, 'output', 'alerts_email'), /value\s*=\s*local\.monitoring_alert_email/);
  assert.match(block(MON, 'output', 'budget_name'), /value\s*=\s*aws_budgets_budget\.monthly\.budget_name|value\s*=\s*aws_budgets_budget\.monthly\.name/);
  assert.match(block(MON, 'output', 'metrics_namespace'), /value\s*=\s*local\.monitoring_namespace/);
  const names = block(MON, 'output', 'alarm_names');
  for (const res of Object.keys(ALARMS)) assert.ok(names.includes(`aws_cloudwatch_metric_alarm.${res}.alarm_name`), `alarm_names lists ${res}`);
  assert.equal(/sensitive|token|secret|password/i.test(codeOf(MON).split('\n').filter((l) => /^output|value/.test(l.trim())).join('\n')), false, 'no secret in an output');
});

// ================================================================== the units
test('vitana-ci-metrics.service: one tick under flock -n -E 0, niced, CPU and memory capped, the read-only token, state in /var/lib', ({ SERVICE }) => {
  assert.match(SERVICE, /^\[Unit\]\nDescription=[^\n]+\nAfter=network-online\.target\n/);
  assert.match(SERVICE, /^Type=oneshot$/m);
  assert.match(SERVICE, /^Nice=10$/m);
  assert.match(SERVICE, /^CPUQuota=\d+%$/m);
  assert.match(SERVICE, /^MemoryMax=\d+[MG]$/m);
  const timeout = Number(/^TimeoutStartSec=(\d+)$/m.exec(SERVICE)?.[1]);
  assert.ok(timeout >= 60 && timeout <= 120, `a run ends well before it could overlap many ticks, got ${timeout}`);
  assert.match(SERVICE, /^EnvironmentFile=\/etc\/vitana\/env$/m, 'REGION and BACKUP_BUCKET come from the file M1 wrote');
  assert.match(SERVICE, /^StateDirectory=vitana-ci-metrics$/m);
  assert.match(SERVICE, /^NoNewPrivileges=true$/m);
  assert.match(SERVICE, /^PrivateTmp=true$/m);
  assert.match(SERVICE, /^ProtectSystem=full$/m);
  assert.match(SERVICE, /^ProtectHome=true$/m);
  assert.match(SERVICE, /^Environment=HOME=\/var\/lib\/vitana-ci-metrics$/m, 'the AWS CLI needs a home that the sandbox leaves writable');
  const exec = /^ExecStart=(.+)$/m.exec(SERVICE)?.[1];
  assert.ok(exec, 'ExecStart');
  assert.match(exec, /^\/usr\/bin\/flock -n -E 0 \/run\/vitana-ci-metrics\.lock \/usr\/bin\/node \/opt\/vitana\/platform\/scripts\/eng\/ci-metrics\.mjs run /);
  assert.match(exec, / --token-file \/etc\/vitana\/bot-metrics-token\b/);
  assert.match(exec, / --state-dir \/var\/lib\/vitana-ci-metrics\b/);
  assert.match(exec, / --url http:\/\/127\.0\.0\.1\b/);
  assert.equal(/glpat|glrt|token=|TOKEN=|PRIVATE-TOKEN/i.test(SERVICE.replace('--token-file /etc/vitana/bot-metrics-token', '')), false, 'the unit holds no token');
  assert.equal(/^User=|^Group=/m.test(SERVICE), false, 'like vitana-land: the root-only token file is read by root; the sandbox options above limit what the process can touch');
});

test('vitana-ci-metrics.timer: every minute, 5 s accuracy, starts the service, installed on timers.target', ({ TIMER }) => {
  assert.match(TIMER, /^\[Timer\]$/m);
  assert.match(TIMER, /^OnBootSec=2min$/m);
  assert.match(TIMER, /^OnUnitActiveSec=1min$/m);
  assert.match(TIMER, /^AccuracySec=5s$/m);
  assert.match(TIMER, /^Unit=vitana-ci-metrics\.service$/m);
  assert.match(TIMER, /^\[Install\]\nWantedBy=timers\.target\n/m);
});

test('the units the metrics job watches are the ones the plan gives the merge bot (§3.4) and the settings sync (§3.3)', async ({ TASKS }) => {
  const M = await import('./ci-metrics.mjs'); // inside the case: on a tree without the module this case fails alone
  assert.match(TASKS, /host\/units\/vitana-land\.service/, 'tasks.md B3: the merge bot unit');
  assert.match(TASKS, /host\/units\/vitana-settings\.\*/, 'tasks.md S4: the settings sync unit');
  assert.deepEqual([...M.TICK_UNITS], ['vitana-land', 'vitana-settings']);
  for (const unit of M.TICK_UNITS) assert.ok(TASKS.includes(`host/units/${unit}.`), `${unit} is a unit that tasks.md builds`);
});

// ================================================================== read only on GitLab (static guard on the source)
test('ci-metrics.mjs is read only on GitLab: no write method, no shell, nothing imported but node: modules and the GitLab client', ({ SOURCE }) => {
  const code = SOURCE.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.equal(/\.(post|put|patch|del)\s*\(/.test(code), false, 'no write call on the client');
  assert.equal(/['"`](POST|PUT|PATCH|DELETE)['"`]/.test(code), false, 'no write method named');
  assert.equal(/\bshell\s*:|\bexecSync\b|\bspawnSync?\b|\bfork\b/.test(code), false, 'no shell and no process other than execFile');
  const cp = /import\s*\{([^}]*)\}\s*from\s*'node:child_process'/.exec(code);
  assert.ok(cp, 'child_process is imported');
  assert.deepEqual(cp[1].split(',').map((x) => x.trim()).filter(Boolean), ['execFile'], 'execFile (arguments as a list, no shell) is the only way to start a program');
  const imports = [...code.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 3);
  for (const i of imports) assert.ok(i.startsWith('node:') || i === './gitlab-api.mjs', `unexpected import ${i}`);
  assert.equal(/process\.env\.\w*TOKEN/i.test(code), false, 'the token comes from a file, never from the environment');
  assert.equal(/console\./.test(code), false, 'logs go through the redacting logger');
});

// ================================================================== the CloudWatch agent script
const FINGERPRINT = '937616F3450B7D806CBD9725D58167303B789C72'; // AWS: "9376 16F3 450B 7D80 6CBD 9725 D581 6730 3B78 9C72"

test('20-cwagent.sh is a strict bash script, installs only a package whose AWS signature and fingerprint it checked, over https', ({ CWAGENT }) => {
  assert.match(CWAGENT, /^#!\/bin\/bash\n/);
  assert.match(CWAGENT, /^set -euo pipefail$/m);
  const r = spawnSync('bash', ['-n', path.join(ROOT, 'host/ops.d/20-cwagent.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const code = codeOf(CWAGENT);
  assert.equal(/\bset\s+-[A-Za-z]*x|\bset\s+-o\s+xtrace|\bbash\s+-[A-Za-z]*x\b/.test(code), false, 'no xtrace');
  assert.ok(code.includes(FINGERPRINT), 'the key fingerprint AWS publishes is written in the script');
  assert.match(code, /gpg --batch --verify/);
  assert.match(code, /amazoncloudwatch-agent[^\s"']*\.amazonaws\.com\/assets\/amazon-cloudwatch-agent\.gpg/);
  assert.match(code, /ubuntu\/amd64\/latest\/amazon-cloudwatch-agent\.deb/);
  assert.equal(/http:\/\//.test(code), false, 'https only');
  assert.equal(/curl[^\n]*(-k\b|--insecure)|--no-check-certificate|apt-key|--allow-unauthenticated|--force|--no-verify/.test(code), false, 'no check is switched off');
  assert.match(code, /dpkg -s amazon-cloudwatch-agent/, 'installed once');
  assert.match(code, /cmp -s/, 'the configuration is rewritten only when it changed');
  assert.match(code, /trap /, 'the download directory is removed');
  assert.match(code, /amazon-cloudwatch-agent-ctl/);
  assert.match(code, /-a fetch-config -m ec2 -c file:/);
  assert.equal(/AKIA|ASIA|secret|password|token/i.test(code), false, 'no credential');
});

/** The JSON between the markers of the heredoc in 20-cwagent.sh. */
function agentConfig(src) {
  const m = /<<'CWAGENT_JSON'\n([\s\S]*?)\nCWAGENT_JSON\n/.exec(src);
  assert.ok(m, 'the agent configuration heredoc <<\'CWAGENT_JSON\' ... CWAGENT_JSON');
  return JSON.parse(m[1]);
}

test('the agent publishes disk_used_percent of / to the namespace Vitana/Engineering, rolled up to the InstanceId dimension the disk alarm reads', ({ CWAGENT, MON }) => {
  const cfg = agentConfig(CWAGENT);
  assert.equal(cfg.metrics.namespace, NS);
  assert.deepEqual(cfg.metrics.append_dimensions, { InstanceId: '${aws:InstanceId}' });
  assert.deepEqual(cfg.metrics.aggregation_dimensions, [['InstanceId']]);
  const disk = cfg.metrics.metrics_collected.disk;
  assert.deepEqual(Object.keys(cfg.metrics.metrics_collected), ['disk'], 'one metric only');
  assert.deepEqual(disk.measurement, ['used_percent']);
  assert.deepEqual(disk.resources, ['/']);
  assert.equal(disk.drop_device, true, 'device names change on Nitro machines');
  assert.equal(disk.metrics_collection_interval, 60);
  assert.equal(cfg.agent.metrics_collection_interval, 60);
  // the alarm reads exactly what the agent writes
  const alarm = block(MON, 'resource', 'aws_cloudwatch_metric_alarm', 'gitlab_disk_used');
  assert.equal(unquote(attr(alarm, 'metric_name')), 'disk_used_percent');
  assert.deepEqual(Object.keys(dimensionsOf(alarm)), Object.keys(cfg.metrics.append_dimensions));
  assert.equal(Number(attr(alarm, 'threshold')), 80);
});

// ---- running the script against stand-ins
function standIns() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cwagent-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const put = (name, body) => { writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
  const log = path.join(dir, 'calls.log');
  writeFileSync(log, '');
  // each stand-in writes one line per call, with its arguments
  put('curl', `echo "curl $*" >> "${log}"; out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done; echo "downloaded" > "$out"`);
  put('gpg', `echo "gpg $*" >> "${log}"
case "$*" in
  *--import*) ;;
  *--fingerprint*) echo "fpr:::::::::\${FAKE_FPR:-${FINGERPRINT}}:" ;;
  *--verify*) [ "\${FAKE_VERIFY:-ok}" = ok ] || { echo "gpg: BAD signature" >&2; exit 1; } ;;
esac`);
  put('dpkg', `echo "dpkg $*" >> "${log}"; case "$1" in -s) [ -e "${dir}/installed" ] && exit 0 || exit 1;; -i) touch "${dir}/installed";; esac`);
  put('systemctl', `echo "systemctl $*" >> "${log}"; case "$1" in is-active) [ -e "${dir}/active" ] && exit 0 || exit 1;; esac`);
  put('ctl', `echo "ctl $*" >> "${log}"; [ -n "\${FAKE_CTL_INERT:-}" ] || touch "${dir}/active"; echo '{"status":"running"}'`);
  const env = path.join(dir, 'env');
  writeFileSync(env, 'DOMAIN=gitlab.example.test\nREGION=eu-central-1\nBACKUP_BUCKET=b\n');
  const config = path.join(dir, 'cwagent.json');
  const scriptPath = path.join(ROOT, 'host/ops.d/20-cwagent.sh');
  const run = (extra = {}) => spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir, VITANA_ENV: env, CWAGENT_CTL: path.join(bin, 'ctl'), CWAGENT_CONFIG: config, CWAGENT_START_TRIES: '2', CWAGENT_START_SLEEP: '0', ...extra },
  });
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { dir, run, calls, config, log };
}

test('first run: downloads the package, its signature and the key over https, verifies, installs, writes the configuration and starts the agent', ({ CWAGENT }) => {
  assert.ok(CWAGENT);
  const s = standIns();
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = s.calls();
  const curls = calls.filter((c) => c.startsWith('curl '));
  assert.equal(curls.length, 3, 'package, signature, key');
  for (const c of curls) assert.match(c, /https:\/\/amazoncloudwatch-agent[^ ]*\.amazonaws\.com\//);
  const REGIONAL = 'https://amazoncloudwatch-agent-eu-central-1.s3.eu-central-1.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb';
  assert.ok(curls.some((c) => c.endsWith(` ${REGIONAL}`)), 'the Region-specific package');
  assert.ok(curls.some((c) => c.endsWith(` ${REGIONAL}.sig`)), 'its signature');
  assert.ok(curls.some((c) => c.endsWith(' https://amazoncloudwatch-agent.s3.amazonaws.com/assets/amazon-cloudwatch-agent.gpg')), 'the AWS public key');
  assert.ok(curls.every((c) => /(^| )-f[A-Za-z]*\b|--fail/.test(c)), 'curl fails on an HTTP error');
  const order = calls.map((c) => (c.startsWith('dpkg -i') ? 'dpkg:install' : c.split(' ')[0] + (c.includes('--verify') ? ':verify' : c.includes('--import') ? ':import' : c.includes('--fingerprint') ? ':fpr' : '')));
  assert.ok(order.indexOf('gpg:import') < order.indexOf('gpg:fpr') && order.indexOf('gpg:fpr') < order.indexOf('gpg:verify') && order.indexOf('gpg:verify') < order.indexOf('dpkg:install'), `verified before installed: ${order.join(' ')}`);
  assert.ok(calls.some((c) => /^dpkg -i /.test(c)));
  assert.ok(calls.some((c) => c.startsWith('ctl -a fetch-config -m ec2 -c file:') && c.endsWith(' -s')));
  assert.ok(calls.some((c) => c === 'systemctl enable amazon-cloudwatch-agent'));
  assert.deepEqual(JSON.parse(readFileSync(s.config, 'utf8')), agentConfig(CWAGENT));
  assert.equal(readdirSync(s.dir).filter((f) => f.startsWith('cwagent-dl')).length, 0, 'the download directory is gone');
});

test('a key with another fingerprint stops the script before anything is installed', ({ CWAGENT }) => {
  assert.ok(CWAGENT);
  const s = standIns();
  const r = s.run({ FAKE_FPR: '0000000000000000000000000000000000000000' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /fingerprint/i);
  assert.equal(s.calls().some((c) => c.startsWith('dpkg -i') || c.startsWith('ctl ')), false, 'nothing installed, nothing started');
});

test('a package whose signature does not verify is not installed', ({ CWAGENT }) => {
  assert.ok(CWAGENT);
  const s = standIns();
  const r = s.run({ FAKE_VERIFY: 'bad' });
  assert.notEqual(r.status, 0);
  assert.equal(s.calls().some((c) => c.startsWith('dpkg -i') || c.startsWith('ctl ')), false);
});

test('second run: nothing to do, no download, no restart; a changed configuration is loaded again', ({ CWAGENT }) => {
  assert.ok(CWAGENT);
  const s = standIns();
  assert.equal(s.run().status, 0);
  const before = s.calls().length;
  const again = s.run();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(s.calls().slice(before).filter((c) => /^(curl|gpg|ctl|dpkg -i)/.test(c)).length, 0, 'nothing downloaded, installed or reloaded');
  writeFileSync(s.config, '{"changed":true}\n');
  const third = s.run();
  assert.equal(third.status, 0);
  const after = s.calls().slice(before);
  assert.equal(after.filter((c) => c.startsWith('ctl ')).length, 1, 'the new configuration is loaded once');
  assert.equal(after.some((c) => c.startsWith('curl')), false, 'but the package is not downloaded again');
  assert.deepEqual(JSON.parse(readFileSync(s.config, 'utf8')), agentConfig(CWAGENT));
});

test('configuration unchanged but the agent has stopped: it is started again, and nothing is downloaded', ({ CWAGENT }) => {
  assert.ok(CWAGENT);
  const s = standIns();
  assert.equal(s.run().status, 0);
  rmSync(path.join(s.dir, 'active')); // the agent died
  const before = s.calls().length;
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = s.calls().slice(before);
  assert.equal(after.filter((c) => c.startsWith('ctl ')).length, 1, 'started once');
  assert.equal(after.some((c) => /^(curl|gpg|dpkg -i)/.test(c)), false, 'but nothing downloaded or installed');
});

test('an agent that does not come up is an error the owner sees (non-zero exit and a message), not a silent success', ({ CWAGENT }) => {
  assert.ok(CWAGENT);
  const s = standIns();
  const r = s.run({ FAKE_CTL_INERT: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not running/);
});

test('installed but not running: the agent is started again with the same configuration', ({ CWAGENT }) => {
  assert.ok(CWAGENT);
  const s = standIns();
  writeFileSync(path.join(s.dir, 'installed'), '');
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = s.calls();
  assert.equal(calls.some((c) => c.startsWith('curl')), false, 'already installed: no download');
  assert.ok(calls.some((c) => c.startsWith('ctl -a fetch-config')), 'started');
});

// ================================================================== the two halves agree
test('every metric, dimension and namespace an alarm reads is one that ci-metrics.mjs or the agent publishes', async ({ MON, CWAGENT }) => {
  const M = await import('./ci-metrics.mjs'); // inside the case: on a tree without the module this case fails alone
  const own = new Set(Object.values(M.METRIC));
  const fromAgent = new Set(['disk_used_percent']);
  for (const [res, want] of Object.entries(ALARMS)) {
    if (want.namespace !== NS) continue;
    assert.ok(own.has(want.metric) || fromAgent.has(want.metric), `${res}: ${want.metric} is published by nobody`);
    if (want.dims.Unit) assert.ok(M.TICK_UNITS.includes(want.dims.Unit), `${res}: ${want.dims.Unit} is not a unit ci-metrics.mjs watches`);
    const b = block(MON, 'resource', 'aws_cloudwatch_metric_alarm', res);
    assert.equal(unquote(attr(b, 'metric_name')), want.metric);
  }
  assert.equal(M.NAMESPACE, NS);
  assert.equal(agentConfig(CWAGENT).metrics.namespace, M.NAMESPACE, 'the agent and the metrics job write to the same namespace');
  const iam = block(MON, 'data', 'aws_iam_policy_document', 'monitoring');
  assert.match(iam, /local\.monitoring_namespace/);
  assert.match(MON, new RegExp(`monitoring_namespace\\s*=\\s*"${M.NAMESPACE}"`));
  // the units pass the paths the module would use by default
  const defaults = M.parseArgs(['run'], { REGION: 'eu-central-1' });
  const exec = /^ExecStart=(.+)$/m.exec(files.SERVICE)[1];
  assert.ok(exec.includes(`--token-file ${defaults.tokenFile}`) && exec.includes(`--state-dir ${defaults.stateDir}`) && exec.includes(`--url ${defaults.url}`));
  assert.match(files.SERVICE, new RegExp(`^StateDirectory=${defaults.stateDir.replace('/var/lib/', '')}$`, 'm'));
});
