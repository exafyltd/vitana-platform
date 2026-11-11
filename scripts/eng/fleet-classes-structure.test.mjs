// VTID-05546 — runner classes main and deploy (plan agentic-delivery §3.2, §5) and the job-class rules of §3.2:
// a job tagged vitana-eng declares no id_tokens and names no secret; a job tagged vitana-eng-deploy runs no repository
// script. Reads committed files only; never calls AWS or GitLab. Dependency-free Node 20 (UNIT.yml, no install).
// The fleet manager's config.toml is rendered by host/fleet-manager-install.sh --render-config (M2 lane fleet, edited
// here for the classes), and the installer's class step runs against stub commands in a temporary folder: no network,
// no AWS, no root.
//
// The CI files are parsed with the strict reader of scripts/eng/verify/tpl-verify-structure.test.mjs (VTID-05552): only
// the plain YAML subset (block maps and lists, flow lists, plain and quoted scalars); anything else throws, so a file
// cannot drift into syntax this test would misread. `extends` resolves as GitLab does: maps merge deeply, everything
// else (lists included) is replaced by the child's. Hidden jobs of every file in the directory can be extended (the
// pipelines include every template from vitana/ci-config).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENG = join(ROOT, 'infra', 'gitlab-engineering');
const TF = join(ENG, 'terraform', 'fleet-classes.tf');
const FLEET_TF = join(ENG, 'terraform', 'fleet.tf');
const FLEET_AMI_TF = join(ENG, 'terraform', 'fleet-ami.tf');
const INSTALL_SH = join(ENG, 'host', 'fleet-manager-install.sh');
const RUNBOOK = join(ENG, 'RUNBOOK-delivery-aws.md');
const CI_DIR = join(ENG, 'ci');
const TPL = join(CI_DIR, 'tpl-deploy.yml');
const BUILD = join(ROOT, 'scripts', 'eng', 'deploy', 'build-image.sh');
const UNTRUSTED = 'vitana-eng';
const MAIN = 'vitana-eng-main';
const DEPLOY = 'vitana-eng-deploy';
const BUILDC = 'vitana-eng-build';

// ── Terraform helpers ─────────────────────────────────────────────────────────────────────────────────────────────
const tf = () => readFileSync(TF, 'utf8');
/** Index of the brace that closes the one at `open`; strings and # comments are skipped. */
function closeOf(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"') { i += 1; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i += 1; i += 1; } continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}
function block(src, head, where = 'fleet-classes.tf') {
  const m = new RegExp(`^${head}\\s*\\{`, 'm').exec(src);
  assert.ok(m, `${head} not found in ${where}`);
  return src.slice(m.index, closeOf(src, m.index + m[0].length - 1) + 1);
}
const code = (src) => src.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
/** Bodies of every nested `name { ... }` (any depth) inside a block text. */
function subs(src, name) {
  const out = [];
  const re = new RegExp(`(^|[\\s{])${name}\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    out.push(src.slice(open, closeOf(src, open) + 1));
    re.lastIndex = open + 1;
  }
  return out;
}
/** Statements of an aws_iam_policy_document block: sid, effect, actions, the resources expression, the conditions. */
function statements(doc) {
  const one = (s, re) => re.exec(s)?.[1];
  return subs(doc, 'statement').map((s) => ({
    sid: one(s, /\bsid\s*=\s*"([^"]*)"/),
    effect: one(s, /\beffect\s*=\s*"([^"]*)"/) ?? 'Allow',
    actions: [...(one(s, /\bactions\s*=\s*\[([^\]]*)\]/) ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]),
    resources: (one(s, /\bresources\s*=\s*(\[[^\n]*\])/) ?? '').replace(/\s+/g, ' ').trim(),
    conditions: subs(s, 'condition').map((c) => [one(c, /\btest\s*=\s*"([^"]+)"/), one(c, /\bvariable\s*=\s*"([^"]+)"/), one(c, /\bvalues\s*=\s*(\[[^\n]*\])/)].join(' ')),
  }));
}

// ── YAML reader (same subset as tpl-verify-structure.test.mjs) ─────────────────────────────────────────────────────
function scalar(raw, where) {
  const s = raw.trim();
  if (s === '') return null;
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) throw new Error(`${where}: unterminated single-quoted scalar`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"')) return JSON.parse(s);
  if (/^[&*!|>{@`%]/.test(s)) throw new Error(`${where}: unsupported YAML (${s[0]})`);
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`${where}: unterminated flow list`);
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => scalar(x, where));
  }
  if (/\s#/.test(s)) throw new Error(`${where}: trailing comment`);
  if (/:\s/.test(s) || s.endsWith(':')) throw new Error(`${where}: plain scalar with ": " — quote it`);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^(yes|no|on|off|y|n)$/i.test(s)) throw new Error(`${where}: "${s}" is a YAML 1.1 boolean — quote it`);
  return s;
}
function parseYaml(text) {
  const lines = text.split('\n').map((raw, i) => ({ raw, no: i + 1 })).filter(({ raw }) => raw.trim() !== '' && !raw.trim().startsWith('#'));
  for (const { raw, no } of lines) if (/\t/.test(raw.match(/^\s*/)[0])) throw new Error(`line ${no}: tab indent`);
  let i = 0;
  const indentOf = (l) => l.raw.match(/^ */)[0].length;
  const KEY = /^([A-Za-z0-9_.$\-/{}:"]+?):(?:\s+(.*))?$/;
  const keyName = (k) => (k.startsWith('"') ? JSON.parse(k) : k);
  function blockOf(indent) {
    const first = lines[i];
    const isList = first.raw.slice(indent).startsWith('- ') || first.raw.slice(indent) === '-';
    return isList ? list(indent) : map(indent);
  }
  function map(indent, into = {}) {
    while (i < lines.length && indentOf(lines[i]) === indent && !lines[i].raw.slice(indent).startsWith('-')) {
      const { raw, no } = lines[i];
      const m = KEY.exec(raw.slice(indent));
      if (!m) throw new Error(`line ${no}: expected "key: value", got ${JSON.stringify(raw.trim())}`);
      const k = keyName(m[1]);
      if (Object.prototype.hasOwnProperty.call(into, k)) throw new Error(`line ${no}: duplicate key ${k}`);
      i += 1;
      if (m[2] !== undefined && m[2].trim() !== '') into[k] = scalar(m[2], `line ${no}`);
      else if (i < lines.length && indentOf(lines[i]) > indent) into[k] = blockOf(indentOf(lines[i]));
      else if (i < lines.length && indentOf(lines[i]) === indent && lines[i].raw.slice(indent).startsWith('- ')) into[k] = list(indent);
      else into[k] = null;
    }
    if (i < lines.length && indentOf(lines[i]) > indent) throw new Error(`line ${lines[i].no}: unexpected indent`);
    return into;
  }
  function list(indent) {
    const out = [];
    while (i < lines.length && indentOf(lines[i]) === indent && lines[i].raw.slice(indent).startsWith('- ')) {
      const { raw, no } = lines[i];
      const item = raw.slice(indent + 2);
      const m = KEY.exec(item);
      if (m && !/^['"[]/.test(item)) {
        lines[i] = { raw: `${' '.repeat(indent + 2)}${item}`, no };
        out.push(map(indent + 2));
      } else {
        i += 1;
        out.push(scalar(item, `line ${no}`));
        if (i < lines.length && indentOf(lines[i]) > indent) throw new Error(`line ${lines[i].no}: unexpected indent after a list item`);
      }
    }
    return out;
  }
  const doc = map(0);
  if (i !== lines.length) throw new Error(`line ${lines[i].no}: not parsed`);
  return doc;
}
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isMap(v) && isMap(base[k]) ? merge(base[k], v) : v;
  return out;
}
const RESERVED = new Set(['include', 'workflow', 'stages', 'variables', 'default', 'image', 'services', 'cache', 'before_script', 'after_script']);
function ciFiles() {
  return readdirSync(CI_DIR).filter((f) => f.endsWith('.yml')).sort().map((f) => ({ f, doc: parseYaml(readFileSync(join(CI_DIR, f), 'utf8')) }));
}
// Every job of every file, resolved against the hidden jobs of the whole directory.
function allJobs() {
  const files = ciFiles();
  const hidden = {};
  for (const { doc } of files) for (const [k, v] of Object.entries(doc)) if (k.startsWith('.') && isMap(v)) hidden[k] = v;
  const resolve = (job, seen) => {
    const parents = job.extends === undefined ? [] : [].concat(job.extends);
    let acc = {};
    for (const p of parents) {
      assert.ok(!seen.includes(p), `extends cycle at ${p}`);
      assert.ok(hidden[p], `${p} is defined in ${CI_DIR}`);
      acc = merge(acc, resolve(hidden[p], [...seen, p]));
    }
    const { extends: _e, ...own } = job;
    return merge(acc, own);
  };
  const jobs = [];
  for (const { f, doc } of files) {
    for (const [k, v] of Object.entries(doc)) {
      if (RESERVED.has(k) || !isMap(v) || k.startsWith('.resource-groups')) continue;
      jobs.push({ file: f, name: k, job: resolve(v, [k]) });
    }
  }
  return jobs;
}
const scriptLines = (j) => [...(j.before_script || []), ...(j.script || []), ...(j.after_script || [])].map(String);
const tagsOf = (j) => (Array.isArray(j.tags) ? j.tags : []);

// ── Terraform: the two classes ────────────────────────────────────────────────────────────────────────────────────
test('three new groups, main, deploy and build: min 0, desired left to the runner, scale-in protection, maxima of plan §5', () => {
  const src = code(tf());
  const classes = block(src, 'locals').match(/fleet_classes\s*=\s*\{([\s\S]*)\n {2}\}/);
  assert.ok(classes, 'local.fleet_classes');
  assert.match(classes[1], /\bmain\s*=\s*\{[^}]*name\s*=\s*"vitana-eng-fleet-main"[^}]*tag\s*=\s*"vitana-eng-main"[^}]*max_instances\s*=\s*var\.fleet_main_max_instances/);
  assert.match(classes[1], /\bdeploy\s*=\s*\{[^}]*name\s*=\s*"vitana-eng-fleet-deploy"[^}]*tag\s*=\s*"vitana-eng-deploy"[^}]*max_instances\s*=\s*var\.fleet_deploy_max_instances[^}]*spot_percent\s*=\s*0/);
  assert.match(classes[1], /\bbuild\s*=\s*\{[^}]*name\s*=\s*"vitana-eng-fleet-build"[^}]*tag\s*=\s*"vitana-eng-build"[^}]*max_instances\s*=\s*var\.fleet_build_max_instances/);
  assert.equal((classes[1].match(/^\s{4}[a-z]+\s*=\s*\{/gm) || []).length, 3, 'exactly three classes');
  assert.match(block(src, 'variable "fleet_build_max_instances"'), /default\s*=\s*4\b/);
  assert.match(block(src, 'variable "fleet_main_max_instances"'), /default\s*=\s*12\b/);
  assert.match(block(src, 'variable "fleet_deploy_max_instances"'), /default\s*=\s*6\b/);
  const asg = block(src, 'resource "aws_autoscaling_group" "fleet_class"');
  assert.match(asg, /for_each\s*=\s*local\.fleet_classes/);
  assert.match(asg, /min_size\s*=\s*0\b/);
  assert.match(asg, /desired_capacity\s*=\s*0\b/);
  assert.match(asg, /max_size\s*=\s*each\.value\.max_instances/);
  assert.match(asg, /protect_from_scale_in\s*=\s*true/);
  assert.match(asg, /capacity_rebalance\s*=\s*false/);
  assert.match(asg, /suspended_processes\s*=\s*\["AZRebalance"\]/);
  assert.match(asg, /ignore_changes\s*=\s*\[desired_capacity\]/);
  assert.match(asg, /vpc_zone_identifier\s*=\s*aws_subnet\.private\[\*\]\.id/);
  assert.equal((src.match(/^resource\s+"aws_autoscaling_group"/gm) || []).length, 1, 'one group resource, one instance per class');
});

test('IMDSv2 required with hop limit 1, no public IP, encrypted gp3 with the engineering key', () => {
  const lt = block(code(tf()), 'resource "aws_launch_template" "fleet_class"');
  assert.match(lt, /http_tokens\s*=\s*"required"/);
  assert.match(lt, /http_put_response_hop_limit\s*=\s*1\b/);
  assert.match(lt, /associate_public_ip_address\s*=\s*false/);
  assert.match(lt, /encrypted\s*=\s*true/);
  assert.match(lt, /kms_key_id\s*=\s*aws_kms_key\.main\.arn/);
  assert.match(lt, /volume_type\s*=\s*"gp3"/);
});

// The class machines hold no AWS permission (plan §3.2: jobs get AWS access only through their per-job ID tokens, §7).
// The one IAM resource in this file widens the M2 fleet manager's role to the two class groups (the next test).
test('no instance policy: the class machines get no instance profile, and the only IAM resource here is the fleet manager policy for the two classes', () => {
  const src = code(tf());
  assert.equal(/iam_instance_profile/.test(src), false, 'no instance profile on the class machines');
  const iam = [...src.matchAll(/^(resource|data)\s+"(aws_iam_[a-z_]+)"\s+"([a-z_]+)"/gm)].map((m) => `${m[1]} ${m[2]}.${m[3]}`);
  assert.deepEqual(iam.sort(), ['data aws_iam_policy_document.fleet_manager_classes', 'resource aws_iam_role_policy.fleet_manager_classes']);
  const p = block(src, 'resource "aws_iam_role_policy" "fleet_manager_classes"');
  assert.match(p, /\brole\s*=\s*aws_iam_role\.fleet_manager\.id/, 'attached to the M2 manager role, never to a job machine');
  assert.match(p, /\bpolicy\s*=\s*data\.aws_iam_policy_document\.fleet_manager_classes\.json/);
  assert.equal(/aws_iam_role\.fleet_job\b|aws_iam_instance_profile\./.test(src), false, 'the M2 job role and profiles are not used here');
});

// Each class group: out tcp 80, tcp 443 and DNS (inside the VPC); in only SSH from the M2 fleet manager, which opens the
// runner's Docker connection through it (one-time key over EC2 Instance Connect, as for the untrusted fleet). The manager
// group gets the matching way out, and nothing else.
test('egress tcp 80, tcp 443 and DNS only; ingress only tcp 22 from the fleet manager', () => {
  const src = code(tf());
  const rules = [...src.matchAll(/^resource\s+"aws_vpc_security_group_(egress|ingress)_rule"\s+"([a-z_]+)"\s*\{/gm)];
  assert.ok(rules.length > 0);
  const seen = [];
  for (const [, kind, name] of rules) {
    const b = block(src, `resource "aws_vpc_security_group_${kind}_rule" "${name}"`);
    assert.match(b, /for_each\s*=\s*local\.fleet_classes\b/, `${name}: one rule per class`);
    const group = /^\s*security_group_id\s*=\s*aws_security_group\.([a-z_]+(?:\[each\.key\])?)\.id/m.exec(b);
    assert.ok(group, `${name}: security_group_id`);
    const ref = /^\s*referenced_security_group_id\s*=\s*aws_security_group\.([a-z_]+(?:\[each\.key\])?)\.id/m.exec(b);
    const cidr = /^\s*cidr_ipv4\s*=\s*(\S+)/m.exec(b)?.[1];
    assert.ok(Boolean(ref) !== Boolean(cidr), `${name}: one source or destination`);
    const proto = /ip_protocol\s*=\s*"([^"]+)"/.exec(b)[1];
    const from = /from_port\s*=\s*(\d+)/.exec(b)[1];
    const to = /to_port\s*=\s*(\d+)/.exec(b)[1];
    assert.equal(from, to, `${name}: one port`);
    seen.push(`${group[1]} ${kind} ${proto}/${from} ${ref ? `group:${ref[1]}` : cidr}`);
  }
  assert.deepEqual(seen.sort(), [
    'fleet_class[each.key] egress tcp/443 "0.0.0.0/0"',
    'fleet_class[each.key] egress tcp/53 aws_vpc.main.cidr_block',
    'fleet_class[each.key] egress tcp/80 "0.0.0.0/0"',
    'fleet_class[each.key] egress udp/53 aws_vpc.main.cidr_block',
    'fleet_class[each.key] ingress tcp/22 group:fleet_manager',
    'fleet_manager egress tcp/22 group:fleet_class[each.key]',
  ]);
  assert.equal(/ingress\s*\{|egress\s*\{/.test(src), false, 'no inline rules');
  assert.equal(/cidr_ipv6|::\/0/.test(src), false, 'no IPv6');
});

test('the fleet manager may scale only the two class groups, open SSH only to their machines as ubuntu, and read only their two runner tokens', () => {
  const src = code(tf());
  const doc = block(src, 'data "aws_iam_policy_document" "fleet_manager_classes"');
  const st = statements(doc);
  assert.deepEqual(st.map((s) => s.sid), ['ScaleClassGroups', 'ConnectToClassMachines', 'ReadClassRunnerTokens']);
  for (const s of st) assert.equal(s.effect, 'Allow', s.sid);
  const [scale, connect, read] = st;
  assert.deepEqual(scale.actions, ['autoscaling:SetDesiredCapacity', 'autoscaling:SetInstanceProtection', 'autoscaling:TerminateInstanceInAutoScalingGroup']);
  assert.equal(scale.resources, '[for g in aws_autoscaling_group.fleet_class : g.arn]', 'the two class groups, nothing else');
  assert.deepEqual(connect.actions, ['ec2-instance-connect:SendSSHPublicKey']);
  assert.equal(connect.resources, '["arn:aws:ec2:${var.region}:${data.aws_caller_identity.me.account_id}:instance/*"]');
  assert.deepEqual(connect.conditions.sort(), [
    'StringEquals ec2:ResourceTag/aws:autoscaling:groupName [for c in local.fleet_classes : c.name]',
    'StringEquals ec2:osuser ["ubuntu"]',
  ]);
  assert.deepEqual(read.actions, ['secretsmanager:GetSecretValue']);
  assert.equal(read.resources, '[for s in aws_secretsmanager_secret.fleet_class_runner_token : s.arn]', 'the two class tokens, nothing else');
  assert.equal(st.flatMap((s) => s.actions).some((a) => a.includes('*')), false, 'no wildcard action');
  // What the plugin also needs is already in the M2 manager policy: describing groups and machines, and the key that
  // encrypts the class secrets (fleet.tf, statements DescribeGroupAndMachines and UseKey).
  const m2 = statements(block(code(readFileSync(FLEET_TF, 'utf8')), 'data "aws_iam_policy_document" "fleet_manager"', 'fleet.tf'));
  const describe = m2.find((s) => s.sid === 'DescribeGroupAndMachines');
  assert.ok(describe && describe.actions.includes('autoscaling:DescribeAutoScalingGroups') && describe.actions.includes('ec2:DescribeInstances'));
  const key = m2.find((s) => s.sid === 'UseKey');
  assert.ok(key && key.actions.includes('kms:Decrypt') && key.resources === '[aws_kms_key.main.arn]');
  assert.match(block(src, 'resource "aws_secretsmanager_secret" "fleet_class_runner_token"'), /kms_key_id\s*=\s*aws_kms_key\.main\.arn/);
});

test('the classes run on the M2 job image and launch through the Auto Scaling role that holds the key grant', () => {
  const src = code(tf());
  const lt = block(src, 'resource "aws_launch_template" "fleet_class"');
  assert.match(lt, /image_id\s*=\s*one\(aws_imagebuilder_image\.fleet\.output_resources\[0\]\.amis\)\.image/, 'the job image M2 builds (fleet-ami.tf)');
  assert.equal(/fleet_class_ami_id/.test(src), false, 'no separate image input that could stay empty or drift from the M2 image');
  const asg = block(src, 'resource "aws_autoscaling_group" "fleet_class"');
  assert.match(asg, /service_linked_role_arn\s*=\s*aws_iam_service_linked_role\.fleet_autoscaling\.arn/,
    'the volumes are encrypted with the engineering key; only this Auto Scaling role holds a grant on it (fleet.tf)');
  const deps = /depends_on\s*=\s*\[([^\]]*)\]/.exec(asg)?.[1] ?? '';
  for (const d of ['aws_kms_grant.fleet_autoscaling', 'aws_kms_grant.fleet_spot']) assert.ok(deps.includes(d), `the groups start after ${d}`);
  assert.match(asg, /force_delete\s*=\s*true/, 'protected machines cannot block a destroy');
  assert.match(block(src, 'resource "aws_secretsmanager_secret" "fleet_class_runner_token"'), /recovery_window_in_days\s*=\s*0\b/, 'a destroyed class can be applied again');
  const m2 = code(`${readFileSync(FLEET_TF, 'utf8')}\n${readFileSync(FLEET_AMI_TF, 'utf8')}`);
  for (const head of ['resource "aws_imagebuilder_image" "fleet"', 'resource "aws_iam_service_linked_role" "fleet_autoscaling"', 'resource "aws_kms_grant" "fleet_autoscaling"',
    'resource "aws_kms_grant" "fleet_spot"', 'resource "aws_security_group" "fleet_manager"', 'resource "aws_iam_role" "fleet_manager"']) {
    assert.match(m2, new RegExp(`^${head}\\s*\\{`, 'm'), `${head} exists in fleet.tf or fleet-ami.tf`);
  }
});

test('a quota that is too low makes the Terraform check print the request', () => {
  const c = block(code(tf()), 'check "fleet_classes_vcpu_quota"');
  for (const q of ['L-1216C47A', 'L-34B43A08']) {
    assert.match(c, new RegExp(`request-service-quota-increase --region \\$\\{var\\.region\\} --service-code ec2 --quota-code ${q} --desired-value`));
  }
});

// ── Job classes (plan §3.2) ───────────────────────────────────────────────────────────────────────────────────────
test('a job tagged vitana-eng declares no id_tokens and names no secret', () => {
  const jobs = allJobs();
  assert.ok(jobs.length > 0);
  for (const { file, name, job } of jobs) {
    if (!tagsOf(job).includes(UNTRUSTED)) continue;
    assert.equal(job.id_tokens, undefined, `${file} ${name}: id_tokens on the untrusted class`);
    assert.equal(job.secrets, undefined, `${file} ${name}: secrets on the untrusted class`);
    for (const l of scriptLines(job)) assert.equal(/secretsmanager|aws-secret\.mjs|--secret-id|_ID_TOKEN\b/.test(l), false, `${file} ${name}: names a secret: ${l}`);
  }
});

test('a job tagged vitana-eng-deploy runs no repository script', () => {
  const RUNNER = /(?:^|[;&|]\s*|\bthen\s+|\bdo\s+)(node|bash|sh|python3?|ruby|perl|deno|bun)\s+("?)([^\s"]+)/g;
  for (const { file, name, job } of allJobs()) {
    if (!tagsOf(job).includes(DEPLOY)) continue;
    for (const l of scriptLines(job)) {
      assert.equal(/(?:^|[\s;&|(])(npm|npx|pnpm|yarn|make)\s|(?:^|[\s;&|(])\.\/|(?:^|\s)source\s|(?:^|[;&|]\s*)\.\s/.test(l), false, `${file} ${name}: runs repository code: ${l}`);
      for (const m of l.matchAll(RUNNER)) {
        if (m[1] === 'node' && m[3].startsWith('-')) assert.fail(`${file} ${name}: inline node code: ${l}`);
        assert.ok(m[3].startsWith('$CENTRAL_DIR/') || m[3].startsWith('${CENTRAL_DIR}/'), `${file} ${name}: ${m[1]} runs ${m[3]}, not a platform-main script: ${l}`);
      }
    }
  }
});

test('tpl-deploy defines the six jobs of plan §9: build on the build class, the rest on the deploy class', () => {
  const doc = parseYaml(readFileSync(TPL, 'utf8'));
  for (const k of Object.keys(doc)) assert.ok(k.startsWith('.'), `${k}: only hidden jobs`);
  const byName = Object.fromEntries(allJobs().filter((j) => j.file === 'tpl-deploy.yml').map((j) => [j.name, j.job]));
  const auds = (j) => Object.values(j.id_tokens || {}).map((t) => t.aud).sort();
  const build = byName['.build-image'];
  assert.deepEqual(build.tags, [BUILDC], 'image builds run on their own class, the only one whose services are unconfined');
  assert.equal(build.id_tokens, undefined, 'the build has no AWS access');
  assert.match(String(build.variables.BUILDKITD_FLAGS), /--oci-worker-no-process-sandbox/);
  assert.match(String(build.image.name), /^docker\.io\/moby\/buildkit:v[0-9.]+-rootless@sha256:[0-9a-f]{64}$/, 'rootless BuildKit pinned by digest');
  assert.deepEqual(build.image.entrypoint, [''], 'the job runs build-image.sh, not the image entrypoint');
  assert.equal(JSON.stringify(build).includes('privileged'), false);
  for (const n of ['.push-image', '.deploy-staging', '.rollback-staging']) {
    assert.deepEqual(byName[n].tags, [DEPLOY], n);
    assert.deepEqual(auds(byName[n]), ['aws:platform:staging', 'aws:v1:staging'], n);
  }
  for (const n of ['.preview-upload', '.preview-stop']) {
    assert.deepEqual(byName[n].tags, [DEPLOY], n);
    assert.deepEqual(auds(byName[n]), ['aws:v1:preview'], n);
  }
  assert.deepEqual(byName['.deploy-staging'].artifacts.paths, ['deploy-runs.json', 'deploy-state.json', 'deploy-out/']);
  assert.equal(byName['.deploy-staging'].artifacts.when, 'always', 'the rollback job reads the state of a failed deploy');
  const roles = new Set([...readFileSync(TPL, 'utf8').matchAll(/role\/(gl-[a-z0-9-]+|\$DEPLOY_ROLE)/g)].map((m) => m[1]));
  assert.deepEqual([...roles].sort(), ['$DEPLOY_ROLE', 'gl-v1-preview']);
  assert.match(readFileSync(TPL, 'utf8'), /DEPLOY_ROLE=gl-v1-staging;[^;]+;; vitana\/vitana-platform\) DEPLOY_ROLE=gl-platform-staging;/);
});

test('build-image.sh refuses without --oci-worker-no-process-sandbox', () => {
  const env = { PATH: process.env.PATH, BUILDKITD_FLAGS: '' };
  const r = spawnSync('sh', [BUILD, '--context', ROOT, '--dockerfile', BUILD, '--out', '/tmp/x.tar'], { encoding: 'utf8', env });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--oci-worker-no-process-sandbox/);
  assert.ok(existsSync(BUILD));
});

// ── The fleet manager: one runner block per class (host/fleet-manager-install.sh, M2 lane fleet) ────────────────────
/** A small reader for the subset of TOML config.toml uses (tables, arrays of tables, strings, integers, booleans,
 *  string arrays); anything else throws. */
function parseToml(text) {
  const root = {};
  let cur = root;
  const walk = (parts) => {
    let o = root;
    for (const p of parts) o = Array.isArray(o[p]) ? o[p].at(-1) : (o[p] ??= {});
    return o;
  };
  text.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    let m;
    if ((m = /^\[\[([A-Za-z0-9_.]+)\]\]$/.exec(line))) {
      const parts = m[1].split('.');
      const parent = walk(parts.slice(0, -1));
      (parent[parts.at(-1)] ??= []).push((cur = {}));
    } else if ((m = /^\[([A-Za-z0-9_.]+)\]$/.exec(line))) {
      cur = walk(m[1].split('.'));
    } else if ((m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line))) {
      assert.equal(m[1] in cur, false, `config.toml line ${i + 1}: ${m[1]} is set twice in one table`);
      const v = m[2].trim();
      if (/^"(?:[^"\\]|\\.)*"$/.test(v) || /^\[[^\]]*\]$/.test(v)) cur[m[1]] = JSON.parse(v);
      else if (v === 'true' || v === 'false') cur[m[1]] = v === 'true';
      else if (/^-?\d+$/.test(v)) cur[m[1]] = Number(v);
      else assert.fail(`config.toml line ${i + 1}: a value this reader does not know: ${v}`);
    } else {
      assert.fail(`config.toml line ${i + 1}: not TOML this reader knows: ${line}`);
    }
  });
  return root;
}

// Tokens are built at run time, so no token-looking literal sits in this file (the secret scan looks for them).
const tok = (s) => ['glrt', s].join('-');
const FLEET_TOKEN = tok('t1_FLEETTESTONLY');
const MAIN_TOKEN = tok('t1_MAINTESTONLY');
const DEPLOY_TOKEN = tok('t1_DEPLOYTESTONLY');
const BUILD_TOKEN = tok('t1_BUILDTESTONLY');
const KEY_ARN = 'arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const FLEET_SECRET = 'vitana/engineering/gitlab/fleet-runner-token';

/** Step A2 of RUNBOOK-delivery-aws.md as data: the lines it writes into /etc/vitana/env.classes on the manager, the
 *  untrusted sizes it writes into /etc/vitana/env, and the Terraform values it puts into terraform.tfvars. */
function stepA2() {
  const rb = readFileSync(RUNBOOK, 'utf8');
  const classEnv = {};
  for (const m of rb.matchAll(/echo (CLASS_[A-Z_]+)=([^\s">]+) >>? \/etc\/vitana\/env\.classes/g)) {
    assert.equal(m[1] in classEnv, false, `${m[1]} is written twice`);
    classEnv[m[1]] = m[2];
  }
  const managerEnv = Object.fromEntries([...rb.matchAll(/s\/\^(FLEET_[A-Z_]+)=\.\*\/\1=(\d+)\//g)].map((m) => [m[1], m[2]]));
  const tfvars = Object.fromEntries([...rb.matchAll(/^\s*(fleet_[a-z_]+)\s*=\s*(\d+)\s*$/gm)].map((m) => [m[1], m[2]]));
  return { rb, classEnv, managerEnv, tfvars };
}
// What step A2 gives the manager (the step's own test checks the runbook says exactly this): the untrusted sizes of
// plan §3.2 and §5 in /etc/vitana/env, and the classes of fleet-classes.tf in /etc/vitana/env.classes.
const A2_MANAGER_ENV = { FLEET_MAX_INSTANCES: '96', FLEET_IDLE_COUNT: '4' };
const A2_CLASS_ENV = {
  CLASS_MAIN_ASG_NAME: 'vitana-eng-fleet-main', CLASS_MAIN_MAX_INSTANCES: '12', CLASS_MAIN_TOKEN_SECRET: 'vitana/engineering/gitlab/vitana-eng-fleet-main-runner-token',
  CLASS_DEPLOY_ASG_NAME: 'vitana-eng-fleet-deploy', CLASS_DEPLOY_MAX_INSTANCES: '6', CLASS_DEPLOY_TOKEN_SECRET: 'vitana/engineering/gitlab/vitana-eng-fleet-deploy-runner-token',
  CLASS_BUILD_ASG_NAME: 'vitana-eng-fleet-build', CLASS_BUILD_MAX_INSTANCES: '4', CLASS_BUILD_TOKEN_SECRET: 'vitana/engineering/gitlab/vitana-eng-fleet-build-runner-token',
};
/** The manager's environment after step A2, with a runner token for every block. */
function fullEnv() {
  return {
    DOMAIN: 'gitlab.vitanaland.com', REGION: 'eu-central-1', FLEET_ASG_NAME: 'vitana-eng-fleet', ...A2_MANAGER_ENV,
    FLEET_CACHE_BUCKET: 'vitana-engineering-ci-cache-111122223333', FLEET_CACHE_KMS_KEY_ARN: KEY_ARN, FLEET_RUNNER_TOKEN: FLEET_TOKEN,
    CLASS_MAIN_ASG_NAME: A2_CLASS_ENV.CLASS_MAIN_ASG_NAME, CLASS_MAIN_MAX_INSTANCES: A2_CLASS_ENV.CLASS_MAIN_MAX_INSTANCES, CLASS_MAIN_RUNNER_TOKEN: MAIN_TOKEN,
    CLASS_DEPLOY_ASG_NAME: A2_CLASS_ENV.CLASS_DEPLOY_ASG_NAME, CLASS_DEPLOY_MAX_INSTANCES: A2_CLASS_ENV.CLASS_DEPLOY_MAX_INSTANCES, CLASS_DEPLOY_RUNNER_TOKEN: DEPLOY_TOKEN,
    CLASS_BUILD_ASG_NAME: A2_CLASS_ENV.CLASS_BUILD_ASG_NAME, CLASS_BUILD_MAX_INSTANCES: A2_CLASS_ENV.CLASS_BUILD_MAX_INSTANCES, CLASS_BUILD_RUNNER_TOKEN: BUILD_TOKEN,
  };
}
/** Runs the installer in render mode: environment in, config.toml out. No network, no file, no root. */
function render(env) {
  const e = { PATH: process.env.PATH, LANG: 'C', ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync('bash', [INSTALL_SH, '--render-config'], { encoding: 'utf8', env: e, timeout: 20000 });
}
function rendered(env) {
  const r = render(env);
  assert.equal(r.status, 0, `render failed (${r.status}): ${r.stderr}`);
  return { text: r.stdout, toml: parseToml(r.stdout) };
}
const NAMES = ['vitana-eng-fleet', 'vitana-eng-fleet-main', 'vitana-eng-fleet-deploy', 'vitana-eng-fleet-build'];

test('the manager renders four runner blocks: vitana-eng on the untrusted group with the warm pool of 4, vitana-eng-main and vitana-eng-deploy on their own groups, at the maxima of plan §5', () => {
  const { text, toml } = rendered(fullEnv());
  assert.deepEqual(toml.runners.map((r) => r.name), NAMES);
  assert.deepEqual(toml.runners.map((r) => r.autoscaler.plugin_config.name), NAMES, 'each block scales its own group (fleet.tf, fleet-classes.tf)');
  assert.deepEqual(toml.runners.map((r) => r.autoscaler.max_instances), [96, 12, 6, 4], 'plan §5: 96 / 12 / 6, plus 4 build machines');
  const [untrusted, main, deploy, build] = toml.runners;
  assert.deepEqual(untrusted.autoscaler.policy, [{ idle_count: 4, idle_time: '10m0s' }], 'the warm pool of 4 ready machines (plan §3.2)');
  for (const r of [main, deploy, build]) assert.deepEqual(r.autoscaler.policy, [{ idle_count: 0, idle_time: '10m0s' }], `${r.name}: no machine waits idle`);
  assert.equal(toml.concurrent, 96 + 12 + 6 + 4, 'concurrent covers every block, so one class never uses up the job slots of another');
  assert.deepEqual([main.limit, deploy.limit, build.limit], [12, 6, 4], 'a class runs at most its own maximum of jobs');
  for (const r of toml.runners) {
    assert.equal(r.url, 'https://gitlab.vitanaland.com');
    assert.equal(r.executor, 'docker-autoscaler');
    assert.equal(r.autoscaler.plugin, 'aws');
    assert.equal(r.autoscaler.plugin_config.region, 'eu-central-1');
    assert.deepEqual(r.autoscaler.connector_config, { username: 'ubuntu', use_external_addr: false });
  }
  // Tags belong to a runner's token in GitLab: each block takes the token of its own class.
  assert.deepEqual(toml.runners.map((r) => r.token), [FLEET_TOKEN, MAIN_TOKEN, DEPLOY_TOKEN, BUILD_TOKEN]);
  const classes = block(code(tf()), 'locals').match(/fleet_classes\s*=\s*\{([\s\S]*)\n {2}\}/)[1];
  for (const [cls, tag] of [['main', MAIN], ['deploy', DEPLOY], ['build', BUILDC]]) {
    assert.match(classes, new RegExp(`\\b${cls}\\s*=\\s*\\{[^}]*name\\s*=\\s*"vitana-eng-fleet-${cls}"[^}]*tag\\s*=\\s*"${tag}"`));
    assert.match(text, new RegExp(`^# vitana-eng-fleet-${cls}: runner tag ${tag}\\b`, 'm'), `the block says which tag its token carries (${tag})`);
  }
  assert.match(text, /^# vitana-eng-fleet-main: runner tag vitana-eng-main, a protected runner/m);
});

test('every block: one job per single-use machine, privileged = false, no Docker socket and no extra power', () => {
  const { text, toml } = rendered(fullEnv());
  assert.equal(toml.runners.length, 4);
  for (const r of toml.runners) {
    assert.equal(r.autoscaler.capacity_per_instance, 1, `${r.name}: one job per machine`);
    assert.equal(r.autoscaler.max_use_count, 1, `${r.name}: a machine is deleted after its job`);
    assert.equal(r.docker.privileged, false, `${r.name}: privileged = false`);
    assert.deepEqual(r.docker.pull_policy, ['if-not-present']);
    assert.deepEqual(r.docker.volumes, ['/cache'], `${r.name}: only the cache volume`);
    assert.equal(r.docker.image, 'public.ecr.aws/docker/library/node:20-bookworm', `${r.name}: the image the M2 machine image carries`);
  }
  assert.equal(/docker\.sock|privileged\s*=\s*true|\/var\/run|host_network|network_mode|cap_add|devices\s*=|services_privileged|allowed_privileged/.test(text), false,
    'no socket mount, no privileged service, no extra capability');
});

test("seccomp and AppArmor unconfined only for the build class's BuildKit service: no job container of any class loses either profile", () => {
  const { toml } = rendered(fullEnv());
  const [untrusted, main, deploy, build] = toml.runners;
  for (const r of toml.runners) assert.equal(r.docker.security_opt, undefined, `${r.name}: job containers keep the default seccomp and AppArmor profiles`);
  assert.equal(untrusted.docker.services_security_opt, undefined, 'untrusted: services keep both profiles');
  assert.equal(deploy.docker.services_security_opt, undefined, 'deploy: services keep both profiles');
  assert.equal(main.docker.services_security_opt, undefined, 'main: services (postgres and the rest) keep both profiles (review d1ea5: unconfined only for build jobs)');
  assert.deepEqual(build.docker.services_security_opt, ['seccomp=unconfined', 'apparmor=unconfined'], 'build: the rootless BuildKit daemon that .build-image starts as its service (plan R5)');
  // Strict (planner decision 2, 2026-11-08): a job on the build class is the image build, either the hidden template or a
  // concrete build-image:<service> job; and every concrete build-image:<service> job is on the build class.
  for (const { file, name, job } of allJobs()) {
    if (tagsOf(job).includes(BUILDC)) assert.ok(name === '.build-image' || name.startsWith('build-image:'), `${file} ${name}: only the image build runs on the build class`);
    if (name.startsWith('build-image:')) assert.deepEqual(tagsOf(job), [BUILDC], `${file} ${name}: every image build runs on the build class`);
  }
  // The daemon is a service of .build-image on the build class only; every other job image stays a plain client.
  const withBuildkit = allJobs().filter(({ job }) => (job.services || []).some((s) => /moby\/buildkit/.test(typeof s === 'string' ? s : String(s.name))));
  assert.ok(withBuildkit.some(({ name }) => name === '.build-image'));
  for (const { file, name, job } of withBuildkit) assert.deepEqual(tagsOf(job), [BUILDC], `${file} ${name}: the BuildKit daemon runs only on the build class`);
});

test("each block has its own token, once, and each class its own cache path: no class reads another class's cache", () => {
  const { text, toml } = rendered(fullEnv());
  for (const t of [FLEET_TOKEN, MAIN_TOKEN, DEPLOY_TOKEN]) assert.equal(text.split(t).length - 1, 1, 'each token appears once');
  const [untrusted, main, deploy] = toml.runners;
  assert.equal(untrusted.cache.Path, undefined, 'the untrusted block keeps the M2 cache path');
  assert.deepEqual([main.cache.Path, deploy.cache.Path], [MAIN, DEPLOY]);
  for (const r of toml.runners) {
    assert.equal(r.cache.Type, 's3');
    assert.notEqual(r.cache.Shared, true, `${r.name}: the cache is never shared between runners`);
    assert.deepEqual(r.cache.s3, {
      ServerAddress: 's3.eu-central-1.amazonaws.com', BucketName: 'vitana-engineering-ci-cache-111122223333', BucketLocation: 'eu-central-1',
      AuthenticationType: 'iam', ServerSideEncryption: 'KMS', ServerSideEncryptionKeyID: KEY_ARN,
    }, `${r.name}: the M2 bucket with the engineering key; the manager signs the URLs`);
  }
});

test('a class renders only with its token; a wrong class input refuses the whole config, names the input and never echoes a token', () => {
  const none = rendered({ ...fullEnv(), CLASS_MAIN_RUNNER_TOKEN: undefined, CLASS_DEPLOY_RUNNER_TOKEN: undefined, CLASS_BUILD_RUNNER_TOKEN: undefined });
  assert.deepEqual(none.toml.runners.map((r) => r.name), ['vitana-eng-fleet'], 'no class token: the M2 configuration alone');
  assert.equal(none.toml.concurrent, 96);
  const onlyMain = rendered({ ...fullEnv(), CLASS_DEPLOY_RUNNER_TOKEN: '', CLASS_BUILD_RUNNER_TOKEN: '' });
  assert.deepEqual(onlyMain.toml.runners.map((r) => r.name), ['vitana-eng-fleet', 'vitana-eng-fleet-main']);
  assert.equal(onlyMain.toml.concurrent, 96 + 12);
  const bad = [
    ['CLASS_MAIN_RUNNER_TOKEN', 'glpat-wrongkind'], ['CLASS_MAIN_RUNNER_TOKEN', `${MAIN_TOKEN}"\nconcurrent = 999`],
    ['CLASS_MAIN_ASG_NAME', ''], ['CLASS_MAIN_ASG_NAME', 'a b'], ['CLASS_MAIN_ASG_NAME', 'vitana-eng-fleet'],
    ['CLASS_DEPLOY_ASG_NAME', 'vitana-eng-fleet-main'], ['CLASS_MAIN_MAX_INSTANCES', '0'], ['CLASS_MAIN_MAX_INSTANCES', '12; rm -rf /'],
    ['CLASS_DEPLOY_MAX_INSTANCES', ''], ['CLASS_DEPLOY_MAX_INSTANCES', '7000'],
  ];
  assert.equal(render(fullEnv()).status, 0, 'control: the same inputs, unspoiled, render');
  for (const [k, v] of bad) {
    const r = render({ ...fullEnv(), [k]: v });
    assert.notEqual(r.status, 0, `${k}=${JSON.stringify(v)} must be refused`);
    assert.equal(r.stdout, '', `${k}=${JSON.stringify(v)}: no config text`);
    assert.ok(r.stderr.includes(k), `${k}=${JSON.stringify(v)}: the refusal names the input (stderr: ${r.stderr.slice(0, 160)})`);
    for (const t of [FLEET_TOKEN, MAIN_TOKEN, DEPLOY_TOKEN]) assert.equal((r.stdout + r.stderr).includes(t), false, `${k}: no token is echoed`);
  }
});

// The installer's own flow, against stub commands in a temporary folder (the pattern of M2's fleet-structure.test.mjs):
// the absolute paths of the script are pointed at the folder, aws answers by secret name, nothing needs root or a network.
function runInstaller({ classes, answers }) {
  const T = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'fleet-classes-'));
  try {
    for (const d of ['bin', 'etc/vitana', 'etc/gitlab-runner', 'etc/systemd/system/gitlab-runner.service.d', 'opt/vitana', 'root', 'answers']) mkdirSync(join(T, d), { recursive: true });
    writeFileSync(join(T, 'etc/vitana/env'), [
      'DOMAIN=gitlab.vitanaland.com', 'REGION=eu-central-1', 'RUNNER_VERSION=19.5.2-1', 'FLEET_ASG_NAME=vitana-eng-fleet', 'FLEET_MAX_INSTANCES=24',
      'FLEET_IDLE_COUNT=0', 'FLEET_CACHE_BUCKET=vitana-engineering-ci-cache-111122223333', `FLEET_CACHE_KMS_KEY_ARN=${KEY_ARN}`, `FLEET_TOKEN_SECRET=${FLEET_SECRET}`, ''].join('\n'));
    if (classes) writeFileSync(join(T, 'etc/vitana/env.classes'), `${Object.entries(classes).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
    const log = join(T, 'calls.log');
    const stub = (name, body) => { writeFileSync(join(T, 'bin', name), `#!/bin/bash\n${body}\n`); chmodSync(join(T, 'bin', name), 0o755); };
    for (const n of ['apt-get', 'apt-mark', 'unzip', 'sleep', 'systemctl']) stub(n, `echo "${n} $*" >> "${log}"`);
    stub('curl', `echo "curl $*" >> "${log}"; exit 0`);
    stub('seq', 'echo 1; echo 2; echo 3; echo 4');
    stub('id', 'echo 0');
    stub('install', `echo "install $*" >> "${log}"; mode=""; args=(); while [ $# -gt 0 ]; do case "$1" in -m) mode="$2"; shift 2 ;; -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; cp "\${args[0]}" "\${args[1]}"; chmod "\${mode:-0644}" "\${args[1]}"`);
    // aws: answers get-secret-value from answers/<secret name with / as _>; no file means the secret has no value yet.
    for (const [id, value] of Object.entries(answers)) if (value !== null) writeFileSync(join(T, 'answers', id.replace(/\//g, '_')), `${value}\n`);
    stub('aws', `id=""; while [ $# -gt 0 ]; do [ "$1" = --secret-id ] && id="$2"; shift; done; echo "aws secretsmanager get-secret-value $id" >> "${log}"; `
      + `f="${T}/answers/\${id//\\//_}"; if [ -f "$f" ]; then cat "$f"; else echo "An error occurred (ResourceNotFoundException)" >&2; exit 254; fi`);
    stub('gitlab-runner', `echo "gitlab-runner $*" >> "${log}"; if [ "$1" = verify ]; then echo "Verifying runner... is alive runner=t1_ABCDEFGH"; fi`);
    let script = readFileSync(INSTALL_SH, 'utf8');
    for (const [from, to] of [['/etc/vitana/env', 'etc/vitana/env'], ['/etc/systemd/system/gitlab-runner.service.d', 'etc/systemd/system/gitlab-runner.service.d'],
      ['/opt/vitana/fleeting-plugins', 'opt/vitana/fleeting-plugins'], ['/etc/gitlab-runner/config.toml', 'etc/gitlab-runner/config.toml'], ['/root/config.toml.XXXXXX', 'root/config.toml.XXXXXX']]) {
      assert.ok(script.includes(from), `the installer uses ${from}`);
      script = script.split(from).join(join(T, to));
    }
    writeFileSync(join(T, 'installer.sh'), script);
    const r = spawnSync('bash', [join(T, 'installer.sh')], { encoding: 'utf8', env: { PATH: `${join(T, 'bin')}:${process.env.PATH}`, LANG: 'C' }, timeout: 30000 });
    const conf = join(T, 'etc/gitlab-runner/config.toml');
    return {
      status: r.status, out: r.stdout + r.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
      config: existsSync(conf) ? readFileSync(conf, 'utf8') : null, mode: existsSync(conf) ? statSync(conf).mode & 0o777 : null,
    };
  } finally {
    rmSync(T, { recursive: true, force: true });
  }
}

test('installer with the class env file of step A2: reads each class token once after the untrusted one, renders the classes that have one, leaves the others off, prints no token', () => {
  const classEnv = A2_CLASS_ENV;
  const r = runInstaller({ classes: classEnv, answers: { [FLEET_SECRET]: FLEET_TOKEN, [classEnv.CLASS_MAIN_TOKEN_SECRET]: MAIN_TOKEN, [classEnv.CLASS_DEPLOY_TOKEN_SECRET]: null, [classEnv.CLASS_BUILD_TOKEN_SECRET]: null } });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.out}`);
  const reads = r.calls.split('\n').filter((l) => l.startsWith('aws secretsmanager get-secret-value')).map((l) => l.split(' ').at(-1));
  assert.deepEqual(reads, [FLEET_SECRET, classEnv.CLASS_MAIN_TOKEN_SECRET, classEnv.CLASS_DEPLOY_TOKEN_SECRET, classEnv.CLASS_BUILD_TOKEN_SECRET], 'the untrusted token first, then each class once');
  const toml = parseToml(r.config);
  assert.deepEqual(toml.runners.map((x) => x.name), ['vitana-eng-fleet', 'vitana-eng-fleet-main'], 'deploy has no token yet: it stays off, its jobs wait');
  assert.equal(toml.concurrent, 24 + 12);
  assert.deepEqual(toml.runners.map((x) => x.token), [FLEET_TOKEN, MAIN_TOKEN]);
  assert.equal(r.mode, 0o600, 'config.toml holds the tokens and is mode 0600');
  assert.match(r.out, /class main: runner token found in vitana\/engineering\/gitlab\/vitana-eng-fleet-main-runner-token/);
  assert.match(r.out, /class deploy: no runner token in vitana\/engineering\/gitlab\/vitana-eng-fleet-deploy-runner-token yet; the class stays off/);
  for (const t of [FLEET_TOKEN, MAIN_TOKEN]) assert.equal(r.out.includes(t) || r.calls.includes(t), false, 'no token in the output or on any command line');
  assert.match(r.calls, /^systemctl restart gitlab-runner$/m);
  const wrong = rendered({ ...fullEnv(), CLASS_MAIN_RUNNER_TOKEN: undefined, CLASS_DEPLOY_RUNNER_TOKEN: undefined, CLASS_BUILD_RUNNER_TOKEN: undefined });
  assert.equal(wrong.toml.runners.length, 1, 'control: without class tokens the same inputs give the M2 block alone');
});

test('installer: a class token secret outside vitana/engineering/gitlab/ is never read, and a value that is not a runner token is never written', () => {
  const classEnv = A2_CLASS_ENV;
  const odd = { ...classEnv, CLASS_DEPLOY_TOKEN_SECRET: 'vitana/ci/test-user' };
  const notToken = ['glpat', 'NOT-A-RUNNER-TOKEN-0000'].join('-');
  const r = runInstaller({ classes: odd, answers: { [FLEET_SECRET]: FLEET_TOKEN, [classEnv.CLASS_MAIN_TOKEN_SECRET]: notToken, [classEnv.CLASS_BUILD_TOKEN_SECRET]: null } });
  assert.equal(r.status, 0, r.out);
  const reads = r.calls.split('\n').filter((l) => l.startsWith('aws secretsmanager get-secret-value')).map((l) => l.split(' ').at(-1));
  assert.deepEqual(reads, [FLEET_SECRET, classEnv.CLASS_MAIN_TOKEN_SECRET, classEnv.CLASS_BUILD_TOKEN_SECRET], 'the odd secret name is not read');
  assert.match(r.out, /CLASS_DEPLOY_TOKEN_SECRET has an unexpected form; class deploy stays off/);
  assert.deepEqual(parseToml(r.config).runners.map((x) => x.name), ['vitana-eng-fleet']);
  assert.equal((r.out + r.calls + r.config).includes(notToken), false, 'a wrong value is neither written nor echoed');
});

test('step A2 gives the manager the groups, sizes and token secrets of fleet-classes.tf, and the untrusted sizes of plan §3.2', () => {
  const { rb, classEnv, managerEnv, tfvars } = stepA2();
  assert.deepEqual(classEnv, A2_CLASS_ENV, 'the class env file the installer reads');
  for (const c of ['main', 'deploy']) {
    assert.equal(classEnv[`CLASS_${c.toUpperCase()}_ASG_NAME`], `vitana-eng-fleet-${c}`, 'the group names of local.fleet_classes');
    assert.equal(classEnv[`CLASS_${c.toUpperCase()}_TOKEN_SECRET`], `vitana/engineering/gitlab/vitana-eng-fleet-${c}-runner-token`);
  }
  const src = code(tf());
  assert.match(block(src, 'resource "aws_secretsmanager_secret" "fleet_class_runner_token"'), /name\s*=\s*"vitana\/engineering\/gitlab\/\$\{each\.value\.name\}-runner-token"/,
    'the secret names Terraform creates');
  assert.match(block(src, 'variable "fleet_main_max_instances"'), new RegExp(`default\\s*=\\s*${classEnv.CLASS_MAIN_MAX_INSTANCES}\\b`));
  assert.match(block(src, 'variable "fleet_deploy_max_instances"'), new RegExp(`default\\s*=\\s*${classEnv.CLASS_DEPLOY_MAX_INSTANCES}\\b`));
  assert.deepEqual(tfvars, { fleet_max_instances: '96', fleet_idle_count: '4' }, 'the M2 variables at the sizes of plan §3.2 and §5');
  assert.deepEqual(managerEnv, A2_MANAGER_ENV, 'and the same sizes on the manager');
  const m2 = code(readFileSync(FLEET_TF, 'utf8'));
  for (const v of Object.keys(tfvars)) assert.match(m2, new RegExp(`^variable\\s+"${v}"\\s*\\{`, 'm'), `${v} is an M2 variable`);
  assert.match(rb, /bash \/opt\/vitana\/fleet-manager-install\.sh >> \/var\/log\/vitana-bootstrap\.log 2>&1/, 'the installer runs again on the manager');
  assert.match(rb, /aws ssm send-command --instance-ids "\$MGR" --document-name AWS-RunShellScript/);
});

test('.build-image starts rootless BuildKit as its service with --oci-worker-no-process-sandbox; the job container is only its client', () => {
  const build = allJobs().find((j) => j.file === 'tpl-deploy.yml' && j.name === '.build-image').job;
  assert.equal(build.services.length, 1);
  const [svc] = build.services;
  assert.equal(svc.name, build.image.name, 'the daemon is the same rootless image, pinned by digest');
  assert.equal(svc.alias, 'buildkitd');
  assert.equal(svc.entrypoint, undefined, 'the image entrypoint (rootlesskit buildkitd) starts the daemon');
  assert.deepEqual(svc.command, ['--addr', 'tcp://0.0.0.0:1234', '--oci-worker-no-process-sandbox']);
  assert.equal(build.variables.BUILDKIT_HOST, 'tcp://buildkitd:1234');
  assert.equal(JSON.stringify(build).includes('privileged'), false);
});

test('build-image.sh builds through the BuildKit service when BUILDKIT_HOST is set, and with the daemonless helper otherwise', () => {
  const T = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'build-image-'));
  try {
    mkdirSync(join(T, 'bin'));
    mkdirSync(join(T, 'ctx'));
    writeFileSync(join(T, 'ctx', 'Dockerfile'), 'FROM scratch\n');
    const log = join(T, 'calls.log');
    // buildctl and the helper write down how they were called and leave the archive where --output points.
    const fake = (n) => `echo "${n} $*" >> "${log}"; for a in "$@"; do case "$a" in type=oci,dest=*) printf oci > "\${a#type=oci,dest=}" ;; esac; done; exit 0`;
    for (const [n, body] of [['buildctl', fake('buildctl')], ['buildctl-daemonless.sh', fake('buildctl-daemonless.sh')], ['id', 'echo 1000']]) {
      writeFileSync(join(T, 'bin', n), `#!/bin/sh\n${body}\n`);
      chmodSync(join(T, 'bin', n), 0o755);
    }
    const run = (extra) => spawnSync('sh', [BUILD, '--context', join(T, 'ctx'), '--dockerfile', join(T, 'ctx', 'Dockerfile'), '--out', join(T, 'image.oci.tar')],
      { encoding: 'utf8', env: { PATH: `${join(T, 'bin')}:${process.env.PATH}`, BUILDKITD_FLAGS: '--oci-worker-no-process-sandbox', ...extra } });
    const remote = run({ BUILDKIT_HOST: 'tcp://buildkitd:1234' });
    assert.equal(remote.status, 0, remote.stderr);
    let calls = readFileSync(log, 'utf8');
    assert.match(calls, /^buildctl --addr tcp:\/\/buildkitd:1234 debug workers$/m, 'waits until the service answers');
    assert.match(calls, /^buildctl --addr tcp:\/\/buildkitd:1234 build --progress=plain --frontend dockerfile\.v0 .*--output type=oci,dest=\S+image\.oci\.tar/m);
    assert.equal(/buildctl-daemonless/.test(calls), false, 'no daemon in the job container');
    rmSync(log);
    const local = run({});
    assert.equal(local.status, 0, local.stderr);
    calls = readFileSync(log, 'utf8');
    assert.match(calls, /^buildctl-daemonless\.sh build --progress=plain /m);
    assert.equal(/^buildctl /m.test(calls), false);
  } finally {
    rmSync(T, { recursive: true, force: true });
  }
});
