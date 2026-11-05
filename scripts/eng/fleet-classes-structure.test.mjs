// VTID-05546 — runner classes main and deploy (plan agentic-delivery §3.2, §5) and the job-class rules of §3.2:
// a job tagged vitana-eng declares no id_tokens and names no secret; a job tagged vitana-eng-deploy runs no repository
// script. Reads committed files only; never calls AWS or GitLab. Dependency-free Node 20 (UNIT.yml, no install).
//
// The CI files are parsed with the strict reader of scripts/eng/verify/tpl-verify-structure.test.mjs (VTID-05552): only
// the plain YAML subset (block maps and lists, flow lists, plain and quoted scalars); anything else throws, so a file
// cannot drift into syntax this test would misread. `extends` resolves as GitLab does: maps merge deeply, everything
// else (lists included) is replaced by the child's. Hidden jobs of every file in the directory can be extended (the
// pipelines include every template from vitana/ci-config).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TF = join(ROOT, 'infra', 'gitlab-engineering', 'terraform', 'fleet-classes.tf');
const CI_DIR = join(ROOT, 'infra', 'gitlab-engineering', 'ci');
const TPL = join(CI_DIR, 'tpl-deploy.yml');
const BUILD = join(ROOT, 'scripts', 'eng', 'deploy', 'build-image.sh');
const UNTRUSTED = 'vitana-eng';
const MAIN = 'vitana-eng-main';
const DEPLOY = 'vitana-eng-deploy';

// ── Terraform helpers ─────────────────────────────────────────────────────────────────────────────────────────────
const tf = () => readFileSync(TF, 'utf8');
function block(src, head) {
  const m = new RegExp(`^${head}\\s*\\{`, 'm').exec(src);
  assert.ok(m, `${head} not found in fleet-classes.tf`);
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"') { i += 1; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i += 1; i += 1; } continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) break;
  }
  return src.slice(m.index, i + 1);
}
const code = (src) => src.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');

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
test('two new groups, main and deploy: min 0, desired left to the runner, scale-in protection, maxima of plan §5', () => {
  const src = code(tf());
  const classes = block(src, 'locals').match(/fleet_classes\s*=\s*\{([\s\S]*)\n {2}\}/);
  assert.ok(classes, 'local.fleet_classes');
  assert.match(classes[1], /\bmain\s*=\s*\{[^}]*name\s*=\s*"vitana-eng-fleet-main"[^}]*tag\s*=\s*"vitana-eng-main"[^}]*max_instances\s*=\s*var\.fleet_main_max_instances/);
  assert.match(classes[1], /\bdeploy\s*=\s*\{[^}]*name\s*=\s*"vitana-eng-fleet-deploy"[^}]*tag\s*=\s*"vitana-eng-deploy"[^}]*max_instances\s*=\s*var\.fleet_deploy_max_instances[^}]*spot_percent\s*=\s*0/);
  assert.equal((classes[1].match(/^\s{4}[a-z]+\s*=\s*\{/gm) || []).length, 2, 'exactly two classes');
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

test('no instance policy: no instance profile and no IAM resource for the classes', () => {
  const src = code(tf());
  assert.equal(/iam_instance_profile/.test(src), false);
  assert.equal(/resource\s+"aws_iam_/.test(src), false);
});

test('egress tcp 80, tcp 443 and DNS only, and no ingress', () => {
  const src = code(tf());
  const rules = [...src.matchAll(/^resource\s+"aws_vpc_security_group_(egress|ingress)_rule"\s+"([a-z_]+)"\s*\{/gm)];
  assert.ok(rules.length > 0);
  const seen = [];
  for (const [, kind, name] of rules) {
    assert.equal(kind, 'egress', `${name}: no ingress (SSH from the fleet manager comes with the M2 fleet edit)`);
    const b = block(src, `resource "aws_vpc_security_group_${kind}_rule" "${name}"`);
    assert.match(b, /security_group_id\s*=\s*aws_security_group\.fleet_class\[each\.key\]\.id/);
    const proto = /ip_protocol\s*=\s*"([^"]+)"/.exec(b)[1];
    const from = /from_port\s*=\s*(\d+)/.exec(b)[1];
    const to = /to_port\s*=\s*(\d+)/.exec(b)[1];
    assert.equal(from, to, `${name}: one port`);
    if (from === '53') assert.match(b, /cidr_ipv4\s*=\s*aws_vpc\.main\.cidr_block/, `${name}: DNS stays in the VPC`);
    seen.push(`${proto}/${from}`);
  }
  assert.deepEqual(seen.sort(), ['tcp/443', 'tcp/53', 'tcp/80', 'udp/53']);
  assert.equal(/ingress\s*\{|egress\s*\{/.test(src), false, 'no inline rules');
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

test('tpl-deploy defines the six jobs of plan §9: build on the main class, the rest on the deploy class', () => {
  const doc = parseYaml(readFileSync(TPL, 'utf8'));
  for (const k of Object.keys(doc)) assert.ok(k.startsWith('.'), `${k}: only hidden jobs`);
  const byName = Object.fromEntries(allJobs().filter((j) => j.file === 'tpl-deploy.yml').map((j) => [j.name, j.job]));
  const auds = (j) => Object.values(j.id_tokens || {}).map((t) => t.aud).sort();
  const build = byName['.build-image'];
  assert.deepEqual(build.tags, [MAIN]);
  assert.equal(build.id_tokens, undefined, 'the build has no AWS access');
  assert.match(String(build.variables.BUILDKITD_FLAGS), /--oci-worker-no-process-sandbox/);
  assert.match(String(build.image.name), /^docker\.io\/moby\/buildkit:v[0-9.]+-rootless@sha256:[0-9a-f]{64}$/, 'rootless BuildKit pinned by digest');
  assert.deepEqual(build.image.entrypoint, [''], 'the job runs buildctl-daemonless.sh, not the image entrypoint');
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
