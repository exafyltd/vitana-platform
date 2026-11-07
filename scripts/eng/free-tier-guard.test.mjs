// Free-tier guard and structure tests of lane `settings`, part B (plan eng-gitlab-m2 sections 2, 3.3, 3.6, 5; tasks S1, S3, S4).
//
// 1. The guard (task S1): GitLab runs without a licence, so nothing in infra/gitlab-engineering/** or scripts/eng/** may use a Premium-only
//    API path or setting. The scanner fails on the names of plan section 2, each checked against the tier banner on docs.gitlab.com (the
//    banner is named next to the rule). It has a negative control (a fixture file per rule that the scanner must catch, near misses and
//    exclusions that it must let pass) and it must pass on the repository today.
// 2. The structure tests of the files this part adds: the three central CI files, the four systemd units, terraform/settings.tf with its policy
//    rendered statement by statement, host/ops-install.sh (run against stand-ins), and m2.sh (run against a stand-in for the AWS CLI).
//    Each file is also tied to part A (scripts/eng/gitlab-settings.mjs and settings/gitlab-settings.json) where they meet.
// Dependency-free Node (node:test), so UNIT.yml runs it with no install. It never calls AWS, GitLab or the network.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readlinkSync, utimesSync, lstatSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(REPO, 'infra', 'gitlab-engineering');
const SELF = 'scripts/eng/free-tier-guard.test.mjs';
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

// Files are read when a case runs, never when the module loads, and a case reads only the names it destructures: on a tree without the lane
// (origin/main) every case fails on its own with ENOENT instead of one crash hiding all of them.
const CI_FILES = { platform: 'ci/platform.gitlab-ci.yml', v1: 'ci/v1.gitlab-ci.yml', rehearsal: 'ci/rehearsal.gitlab-ci.yml' };
const UNIT_NAMES = ['vitana-platform-sync.service', 'vitana-platform-sync.timer', 'vitana-settings.service', 'vitana-settings.timer'];
const files = {
  get CI() { return Object.fromEntries(Object.entries(CI_FILES).map(([k, v]) => [k, read(v)])); },
  get M1_CI() { return { platform: read('host/ci-platform.yml'), v1: read('host/ci-v1.yml') }; },
  get UNITS() { return Object.fromEntries(UNIT_NAMES.map((n) => [n, read(`host/units/${n}`)])); },
  get TF() { return read('terraform/settings.tf'); },
  get MAIN() { return read('terraform/main.tf'); },
  get OPS() { return read('host/ops-install.sh'); },
  get M2() { return read('m2.sh'); },
  get CONFIG() { return JSON.parse(read('settings/gitlab-settings.json')); },
  get ENGINE() { return readRepo('scripts/eng/gitlab-settings.mjs'); },
};
const test = (name, fn) => nodeTest(name, () => fn(files));

// ============================================================================================================================
// 1. THE FREE-TIER GUARD
// ============================================================================================================================
// Each rule: the Premium or Ultimate name, the tier banner it was checked against (docs.gitlab.com, 2026-11-05), a pattern for one line of code, and
// an example line the pattern must catch. `onlyExt` limits a rule to the file kind the name belongs to.
const RULES = [
  { id: 'approval_rules', tier: 'Premium', doc: 'api/merge_request_approvals (approval rules)', re: /\bapproval_rules\b/, example: "send(ctx, 'POST', `/projects/${id}/approval_rules`, rule);" },
  { id: 'approvals (project configuration path)', tier: 'Premium', doc: 'api/merge_request_approvals (Approval rules for projects: GET|POST /projects/:id/approvals)', re: /(?<!merge_requests\/[^\s'"`/]{1,40})\/approvals\b/, example: "await client.request('POST', `/projects/${id}/approvals`, body);" },
  { id: 'merge request approval settings', tier: 'Premium', doc: 'api/merge_request_approvals (update approval configuration)', re: /\b(approval_settings|approvals_before_merge|reset_approvals_on_push|merge_requests_author_approval|merge_requests_disable_committers_approval|disable_overriding_approvers_per_merge_request|require_password_to_approve|require_reauthentication_to_approve|selective_code_owner_removals)\b/, example: 'body.reset_approvals_on_push = false;' },
  { id: 'push rules', tier: 'Premium', doc: 'api/project_push_rules (GET|POST /projects/:id/push_rule)', re: /\bpush_rules?\b/, example: "request('POST', `/projects/${id}/push_rule`, { prevent_secrets: true });" },
  { id: 'merge trains', tier: 'Premium', doc: 'api/merge_trains and ci/pipelines/merge_trains', re: /\b(merge_trains?|merge_pipelines_enabled|merged_results_pipelines)\b|\bmerge[ -]trains?\b/i, example: 'curl "$BASE/projects/$ID/merge_trains"' },
  { id: 'protected environments', tier: 'Premium', doc: 'api/protected_environments', re: /\b(protected_environments?|required_approval_count|deployment_approvals?)\b/, example: "paginate(`/projects/${id}/protected_environments`)" },
  { id: 'code_owner_approval_required', tier: 'Premium', doc: 'api/protected_branches (request parameter, Premium and Ultimate only)', re: /\bcode_owner_approval_required\b/, example: 'const body = { name: "main", code_owner_approval_required: true };' },
  { id: 'protected branch rules by user or group', tier: 'Premium', doc: 'api/protected_branches (allowed_to_*: user_id, group_id and access_level are Premium and Ultimate only)', re: /\b(allowed_to_push|allowed_to_merge|allowed_to_unprotect)\b/, unless: /default_branch_protection_defaults/, example: 'const body = { allowed_to_push: [{ access_level: 0 }] };' },
  { id: 'group hooks', tier: 'Premium', doc: 'api/group_webhooks (GET|POST /groups/:id/hooks)', re: /\/groups\/[^\s'"`]*\/hooks\b|\bgroup[ _-]?(web)?hooks?\b/i, example: "request('POST', `/groups/${gid}/hooks`, { url });" },
  { id: 'external status checks', tier: 'Ultimate', doc: 'api/status_checks (GET|POST /projects/:id/external_status_checks)', re: /\b(external_status_checks?|only_allow_merge_if_all_status_checks_passed)\b|\bexternal status checks?\b|(?<![A-Za-z_])status_checks\b/i, example: "get(`/projects/${id}/external_status_checks`)" },
  { id: 'SAML, SCIM and LDAP group sync', tier: 'Premium', doc: 'administration/auth/ldap/ldap_synchronization (group sync); SAML group links; SCIM provisioning', re: /\b(saml_group_links?|ldap_group_links?|group_saml|saml_provider|scim_(identit(y|ies)|oauth)|ldap_sync|ldap_cn|ldap_access)\b|\/scim\/v2|\b(saml|ldap|scim)[ _-]group[ _-]?sync\b|\bgroup[ _-]?sync\b/i, example: 'POST /groups/7/ldap_group_links cn=agents' },
  { id: 'audit events streaming', tier: 'Ultimate', doc: 'administration/compliance/audit_event_streaming (instance and group streaming destinations)', re: /\b(audit_events?_stream(ing)?|external_audit_event_destinations?|audit_events\/streaming)\b|\baudit[ _-]events?[ _-]stream(ing)?\b/i, example: 'enable audit_event_streaming for the group' },
  { id: 'compliance frameworks', tier: 'Premium', doc: 'user/compliance/compliance_frameworks (compliance frameworks on a group)', re: /\bcompliance_frameworks?(_ids?)?\b|\bcompliance[ -]frameworks?\b/i, example: 'compliance_framework_ids: [3]' },
  { id: 'CI secrets from a vault', tier: 'Premium', doc: 'ci/yaml (secrets: keyword)', onlyExt: /\.ya?ml$/, re: /^\s*secrets:\s*$/, example: '  secrets:' },
];
// Free names that parts A and the merge bot use or may use. The scanner must let every one of them pass.
const NEAR_MISSES = [
  "post(`/projects/${id}/merge_requests/${iid}/approve`)",
  "get(`/projects/${id}/merge_requests/${iid}/approvals`)",
  "{ push_access_level: 40, merge_access_level: 40, allow_force_push: false, unprotect_access_level: 40 }",
  "paginate(`/projects/${id}/protected_branches`)",
  "post(`/projects/${id}/hooks`, { url, merge_requests_events: true })",
  "const lic = await client.raw('GET', '/license');",
  "{ merge_method: 'ff', squash_option: 'always', only_allow_merge_if_pipeline_succeeds: true }",
  "post('/service_accounts', { username })",
  "gh api repos/x/y/branches/main/protection --jq .required_status_checks",
  'workflow:\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
  'resource_group: deploy',
  // milestone 1's instance setting: default_branch_protection_defaults is a Free setting and takes these attribute names
  `-d '{"default_branch_protection_defaults":{"allow_force_push":true,"allowed_to_push":[{"access_level":40}],"allowed_to_merge":[{"access_level":40}]}}'`,
];

const SCAN_ROOTS = ['infra/gitlab-engineering', 'scripts/eng'];
const SKIP_DIRS = new Set(['node_modules', '.terraform', '.git', 'free-tier-guard-fixtures']);
// Not scanned: this file (it names every rule), test files (they hold the fake GitLab's answers and assert that a Premium name is absent), and
// documentation (.md; the owner said "not docs"). Comment lines are not scanned either: a comment calls nothing. Everything else under the two roots is.
const isTestFile = (rel) => /\.test\.(mjs|cjs|js)$/.test(rel);
const isDoc = (rel) => /\.md$/.test(rel);
const isCommentLine = (line) => /^\s*(\/\/|#|\*|\/\*|<!--)/.test(line);

/** Findings for one file's text: [{ file, line, rule, text }]. */
function scanText(rel, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const r of RULES) {
      if (r.onlyExt && !r.onlyExt.test(rel)) continue;
      if (r.unless && r.unless.test(line)) continue; // a Free setting that uses the same attribute names
      if (r.re.test(line)) out.push({ file: rel, line: i + 1, rule: r.id, text: line.trim().slice(0, 140) });
    }
  });
  return out;
}
/** Walks the two roots under `repo`. Returns { scanned: [relative paths], findings }. */
function scanTree(repo, roots = SCAN_ROOTS) {
  const scanned = [];
  const findings = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(repo, abs).split(path.sep).join('/');
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); continue; }
      if (!e.isFile() || rel === SELF || isTestFile(rel) || isDoc(rel)) continue;
      if (statSync(abs).size > 2_000_000) continue;
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue; // binary
      scanned.push(rel);
      findings.push(...scanText(rel, buf.toString('utf8')));
    }
  };
  for (const r of roots) if (existsSync(path.join(repo, r))) walk(path.join(repo, r));
  return { scanned, findings };
}
const tmp = (prefix) => mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), prefix));
const put = (file, text, mode) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); if (mode) chmodSync(file, mode); };

test('free-tier guard: the repository today names no Premium-only API path or setting (scans infra/gitlab-engineering and scripts/eng)', () => {
  const { scanned, findings } = scanTree(REPO);
  assert.deepEqual(findings, [], `Premium-only names found:\n${findings.map((f) => `  ${f.file}:${f.line} [${f.rule}] ${f.text}`).join('\n')}`);
  // The scan must really look at the files it is about, or a wrong path would make it pass for nothing.
  for (const must of ['scripts/eng/gitlab-settings.mjs', 'infra/gitlab-engineering/settings/gitlab-settings.json', 'infra/gitlab-engineering/ci/platform.gitlab-ci.yml',
    'infra/gitlab-engineering/ci/v1.gitlab-ci.yml', 'infra/gitlab-engineering/ci/rehearsal.gitlab-ci.yml', 'infra/gitlab-engineering/terraform/settings.tf',
    'infra/gitlab-engineering/m2.sh', 'infra/gitlab-engineering/host/ops-install.sh', 'infra/gitlab-engineering/host/units/vitana-settings.service',
    'infra/gitlab-engineering/setup.sh', 'infra/gitlab-engineering/terraform/main.tf']) {
    assert.ok(scanned.includes(must), `the scan reaches ${must}`);
  }
  assert.equal(scanned.includes(SELF), false, 'the guard does not scan itself');
  assert.ok(scanned.length >= 20, `a real scan, not an empty one: ${scanned.length} files`);
});

test('free-tier guard negative control: a fixture file per forbidden name, and the scanner catches every one under its own rule', () => {
  const dir = tmp('guard-');
  try {
    assert.ok(RULES.length >= 14, 'every name of plan section 2 has a rule');
    for (const [i, r] of RULES.entries()) {
      const ext = r.onlyExt ? '.yml' : i % 2 ? '.mjs' : '.sh';
      const rel = `${i % 2 ? 'scripts/eng' : 'infra/gitlab-engineering/host'}/fixture-${i}${ext}`;
      put(path.join(dir, rel), `const ok = 1;\n${r.example}\nconst alsoOk = 2;\n`);
      const { findings } = scanTree(dir);
      const mine = findings.filter((f) => f.file === rel);
      assert.deepEqual(mine.map((f) => f.rule), [r.id], `${r.id} (${r.tier}, ${r.doc}) is caught exactly once and under its own name; got ${JSON.stringify(mine)}`);
      assert.equal(mine[0].line, 2, 'the finding names the line');
      rmSync(path.join(dir, rel));
    }
    // and all together: one finding per rule
    for (const [i, r] of RULES.entries()) put(path.join(dir, `infra/gitlab-engineering/all-${i}${r.onlyExt ? '.yml' : '.sh'}`), `${r.example}\n`);
    assert.deepEqual([...new Set(scanTree(dir).findings.map((f) => f.rule))].sort(), RULES.map((r) => r.id).sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('free-tier guard: every rule names its tier and the documentation page whose banner was checked', () => {
  for (const r of RULES) {
    assert.match(r.tier, /^(Premium|Ultimate)$/, r.id);
    assert.ok(r.doc.length > 10, `${r.id} names its documentation page`);
    assert.ok(r.re.test(r.example), `${r.id}: the example line matches its own pattern`);
  }
  const ids = RULES.map((r) => r.id);
  for (const want of ['approval_rules', 'push rules', 'merge trains', 'protected environments', 'code_owner_approval_required', 'group hooks', 'external status checks',
    'merge request approval settings', 'SAML, SCIM and LDAP group sync', 'audit events streaming', 'compliance frameworks']) {
    assert.ok(ids.includes(want), `plan section 2 and the owner's list: ${want}`);
  }
});

test('free-tier guard: Free-tier names that the sync and the merge bot use pass (near misses), and so do comments, test files, documents and files outside the two folders', () => {
  const dir = tmp('guard-near-');
  try {
    NEAR_MISSES.forEach((line, i) => put(path.join(dir, `scripts/eng/near-${i}.mjs`), `${line}\n`));
    assert.deepEqual(scanTree(dir).findings, [], 'Free names are not flagged');
    // the same Premium name, in the places that are out of scope
    const bad = RULES[3].example; // a push rule
    put(path.join(dir, 'scripts/eng/commented.mjs'), `// ${bad}\n/* ${bad} */\n * ${bad}\n`);
    put(path.join(dir, 'infra/gitlab-engineering/commented.sh'), `# ${bad}\n`);
    put(path.join(dir, 'scripts/eng/some.test.mjs'), `${bad}\n`);
    put(path.join(dir, 'infra/gitlab-engineering/README.md'), `${bad}\n`);
    put(path.join(dir, 'docs/plan.md'), `${bad}\n`);
    put(path.join(dir, 'scripts/other/x.mjs'), `${bad}\n`);
    put(path.join(dir, 'infra/gitlab-engineering/node_modules/x.js'), `${bad}\n`);
    put(path.join(dir, 'infra/gitlab-engineering/.terraform/x.tf'), `${bad}\n`);
    assert.deepEqual(scanTree(dir).findings, [], 'comments, tests, documents and other folders are out of scope');
    // but the exclusions are narrow: the same line as code, in a helper that is not a test, is caught; so is a name after code on a line
    put(path.join(dir, 'scripts/eng/testing/helper.mjs'), `${bad}\n`);
    put(path.join(dir, 'infra/gitlab-engineering/trailing.sh'), `echo go  # ${bad}\n`);
    assert.deepEqual(scanTree(dir).findings.map((f) => f.file).sort(), ['infra/gitlab-engineering/trailing.sh', 'scripts/eng/testing/helper.mjs']);
    // the guard does not scan itself by name, and only by name
    put(path.join(dir, SELF), `${bad}\n`);
    assert.equal(scanTree(dir).findings.some((f) => f.file === SELF), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('free-tier guard: the approvals rule flags the project configuration path and lets the Free merge request endpoints through', () => {
  const rule = RULES.find((r) => r.id.startsWith('approvals'));
  for (const bad of ['/projects/1/approvals', '`/projects/${id}/approvals`', '"/projects/:id/approvals"', '/groups/3/approvals']) assert.ok(rule.re.test(bad), bad);
  for (const ok of ['/projects/1/merge_requests/2/approvals', '`/projects/${id}/merge_requests/${iid}/approvals`', '/projects/1/merge_requests/2/approve', '/projects/1/merge_requests/2/reset_approvals']) {
    assert.equal(rule.re.test(ok), false, ok);
  }
});

// ============================================================================================================================
// 2a. THE CENTRAL CI FILES (task S3)
// ============================================================================================================================
// A reader for the small YAML subset the CI files use (block mappings and sequences, flow sequences, plain and quoted scalars, comments). It refuses
// anything else (anchors, block scalars, flow mappings, tabs), so a file that needs more makes this test say so instead of misreading it. PyYAML
// reads the same files in the next case when it is installed.
function stripYamlComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[,-]/.test(line[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}
function yamlScalar(s, where) {
  const t = s.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (t[0] === '"') { if (!t.endsWith('"') || t.length < 2) throw new Error(`${where}: unterminated string`); return JSON.parse(t); }
  if (t[0] === "'") { if (!t.endsWith("'") || t.length < 2) throw new Error(`${where}: unterminated string`); return t.slice(1, -1).replace(/''/g, "'"); }
  if (t[0] === '[') {
    if (!t.endsWith(']')) throw new Error(`${where}: flow sequence over several lines`);
    const inner = t.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => yamlScalar(x, where));
  }
  if (/^[{|>&*!%@`]/.test(t) || t.startsWith('<<')) throw new Error(`${where}: YAML construct this reader does not support: ${t.slice(0, 20)}`);
  return t;
}
function parseYaml(text) {
  const lines = [];
  text.split('\n').forEach((raw, i) => {
    const s = stripYamlComment(raw);
    if (s.trim() === '') return;
    const lead = /^\s*/.exec(s)[0];
    if (lead.includes('\t')) throw new Error(`line ${i + 1}: tab in the indentation`);
    lines.push({ indent: lead.length, text: s.trim(), no: i + 1 });
  });
  let pos = 0;
  const isItem = (t) => t === '-' || t.startsWith('- ');
  const splitKey = (t, no) => {
    const m = /^((?:"[^"]*"|'[^']*'|[^\s:"'][^:]*?))\s*:(?:\s+(.*))?$/.exec(t);
    if (!m || /^[[{]/.test(t)) return null;
    const key = m[1].replace(/^["']|["']$/g, '');
    if (/\s/.test(key) && !/^["']/.test(m[1])) throw new Error(`line ${no}: ambiguous "key: value" in a plain scalar: ${t.slice(0, 40)}`);
    return [key, m[2] ?? ''];
  };
  function block(minIndent) {
    const first = lines[pos];
    if (!first || first.indent < minIndent) return null;
    return isItem(first.text) ? seq(first.indent) : map(first.indent);
  }
  function value(rest, indent, no) {
    if (rest !== '') return yamlScalar(rest, `line ${no}`);
    const next = lines[pos];
    if (next && next.indent > indent) return block(indent + 1);
    if (next && next.indent === indent && isItem(next.text)) return seq(indent);
    return null;
  }
  function map(indent) {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent && !isItem(lines[pos].text)) {
      const { text, no } = lines[pos];
      const kv = splitKey(text, no);
      if (!kv) throw new Error(`line ${no}: expected "key: value", got: ${text.slice(0, 40)}`);
      pos++;
      if (Object.hasOwn(obj, kv[0])) throw new Error(`line ${no}: duplicate key ${kv[0]}`);
      obj[kv[0]] = value(kv[1], indent, no);
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new Error(`line ${lines[pos].no}: unexpected indentation`);
    return obj;
  }
  function seq(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && isItem(lines[pos].text)) {
      const { text, no } = lines[pos];
      const rest = text === '-' ? '' : text.slice(2).trim();
      if (rest !== '' && splitKey(rest, no) && !/^["'[]/.test(rest)) {
        lines[pos] = { indent: indent + 2, text: rest, no }; // "- key: value" starts a mapping two columns in
        arr.push(map(indent + 2));
      } else {
        pos++;
        arr.push(rest === '' ? (lines[pos] && lines[pos].indent > indent ? block(indent + 1) : null) : yamlScalar(rest, `line ${no}`));
      }
    }
    return arr;
  }
  if (lines.length === 0) return {};
  const doc = block(0);
  if (pos < lines.length) throw new Error(`line ${lines[pos].no}: could not read from here`);
  return doc;
}

const RESERVED = new Set(['workflow', 'default', 'stages', 'variables', 'include']);
const DEPLOY_WORDS = /\b(aws|gcloud|az|kubectl|terraform|helm|ssh|scp|rsync|docker\s+(push|login)|git\s+push|curl|wget)\b/;
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|^AWS_)/i;
const WANT_WORKFLOW = ['$CI_PIPELINE_SOURCE == "merge_request_event"', '$CI_COMMIT_BRANCH == "main"', '$CI_PIPELINE_SOURCE =~ /^(web|api|schedule)$/'];
const WANT_RETRY = { max: 1, when: ['runner_system_failure', 'stuck_or_timeout_failure'] };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { // GitLab's extends: hashes merge deeply, everything else is replaced
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out;
};
function resolveJob(doc, name, trail = []) {
  if (trail.includes(name)) throw new Error(`extends loops: ${[...trail, name].join(' -> ')}`);
  const job = doc[name];
  if (!isObj(job)) throw new Error(`${name} is not a job`);
  const parents = job.extends === undefined ? [] : [].concat(job.extends);
  let base = {};
  for (const p of parents) {
    if (!(p in doc) || RESERVED.has(p)) throw new Error(`${name} extends ${p}, which does not exist`);
    base = merge(base, resolveJob(doc, p, [...trail, name]));
  }
  const { extends: _x, ...own } = job;
  return merge(base, own);
}
/** Everything the plan promises about a central CI file. Returns a list of problems (empty = fine). */
function lintCi(doc, { requiredJobs = [] } = {}) {
  const bad = [];
  const top = Object.keys(doc);
  const jobNames = top.filter((k) => !RESERVED.has(k));
  const real = jobNames.filter((k) => !k.startsWith('.'));
  if ('include' in doc) bad.push('include: a central file must be self-contained (no other file, no remote code)');
  const stages = doc.stages ?? [];
  if (!Array.isArray(stages) || stages.length === 0) bad.push('stages is missing');
  // workflow
  const rules = doc.workflow?.rules;
  if (JSON.stringify((rules ?? []).map((r) => r.if)) !== JSON.stringify(WANT_WORKFLOW)) bad.push(`workflow.rules must be exactly ${JSON.stringify(WANT_WORKFLOW)} (merge-request pipelines first)`);
  // default
  const d = doc.default ?? {};
  if (JSON.stringify(d.tags) !== JSON.stringify(['vitana-eng'])) bad.push('default.tags must be [vitana-eng]');
  if (d.interruptible !== true) bad.push('default.interruptible must be true');
  if (JSON.stringify(d.retry) !== JSON.stringify(WANT_RETRY)) bad.push(`default.retry must be ${JSON.stringify(WANT_RETRY)}`);
  // variables: no credential
  for (const [k, v] of Object.entries(doc.variables ?? {})) {
    if (SECRET_NAME.test(k)) bad.push(`variables.${k}: a variable that looks like a credential`);
    if (/glpat-|glrt-|AKIA[0-9A-Z]{8}|-----BEGIN/.test(String(v))) bad.push(`variables.${k}: a credential value`);
  }
  for (const name of jobNames) {
    const raw = doc[name];
    if (!isObj(raw)) { bad.push(`${name}: a top-level key that is not a job`); continue; }
    let job;
    try { job = resolveJob(doc, name); } catch (e) { bad.push(String(e.message)); continue; }
    if (!name.startsWith('.')) {
      if (/deploy|release|publish|prod/i.test(name)) bad.push(`${name}: a deploy-like job (milestone 2 has no deploy job)`);
      if (!Array.isArray(job.script) || job.script.length === 0 || job.script.some((s) => typeof s !== 'string')) bad.push(`${name}: script must be a list of commands`);
      if (!stages.includes(job.stage)) bad.push(`${name}: stage ${JSON.stringify(job.stage)} is not one of ${JSON.stringify(stages)}`);
    }
    for (const forbidden of ['secrets', 'environment', 'release', 'trigger', 'dast_configuration', 'pages', 'id_tokens', 'services', 'resource_group']) {
      if (forbidden in raw) bad.push(`${name}: the keyword ${forbidden} (a secret, a deployment or a Premium-only feature) is not allowed`);
    }
    if ('tags' in raw && JSON.stringify(raw.tags) !== JSON.stringify(['vitana-eng'])) bad.push(`${name}: tags must stay [vitana-eng]`);
    if ('retry' in raw) bad.push(`${name}: retry is set once in default`);
    if (raw.interruptible === false) bad.push(`${name}: interruptible must not be turned off`);
    for (const line of [].concat(job.script ?? [], job.before_script ?? [], job.after_script ?? [])) {
      if (typeof line === 'string' && DEPLOY_WORDS.test(line)) bad.push(`${name}: the command "${line}" talks to a cloud, a host or a registry (no deploy in milestone 2)`);
    }
    for (const [k, v] of Object.entries(job.variables ?? {})) if (SECRET_NAME.test(k) || /glpat-|glrt-|AKIA/.test(String(v))) bad.push(`${name}: variable ${k} looks like a credential`);
    // rules
    if ('rules' in raw) {
      if (!Array.isArray(raw.rules)) bad.push(`${name}: rules must be a list`);
      else for (const r of raw.rules) {
        if (!isObj(r)) { bad.push(`${name}: a rule must be a mapping`); continue; }
        for (const k of Object.keys(r)) if (!['if', 'changes', 'exists', 'when', 'allow_failure', 'variables'].includes(k)) bad.push(`${name}: rules key ${k} is not one of if, changes, exists, when, allow_failure, variables`);
        if (r.when !== undefined && !['on_success', 'never', 'always', 'manual', 'delayed', 'on_failure'].includes(r.when)) bad.push(`${name}: rules when ${r.when}`);
      }
    }
    // needs
    if ('needs' in raw) {
      if (!Array.isArray(raw.needs)) bad.push(`${name}: needs must be a list`);
      else for (const n of raw.needs) {
        const target = typeof n === 'string' ? n : n?.job;
        if (isObj(n) && ('project' in n || 'pipeline' in n)) bad.push(`${name}: needs of another project or pipeline are Premium-only`);
        if (!real.includes(target)) bad.push(`${name}: needs ${JSON.stringify(target)}, which is not a job of this file`);
        if (target === name) bad.push(`${name}: needs itself`);
      }
    }
  }
  // needs must not loop
  const edges = (n) => (Array.isArray(doc[n]?.needs) ? doc[n].needs.map((x) => (typeof x === 'string' ? x : x?.job)).filter((x) => real.includes(x)) : []);
  const visit = (n, trail) => { if (trail.includes(n)) { bad.push(`needs loops: ${[...trail, n].join(' -> ')}`); return; } for (const m of edges(n)) visit(m, [...trail, n]); };
  real.forEach((n) => visit(n, []));
  for (const req of requiredJobs) if (!real.includes(req)) bad.push(`the required job ${req} (gitlab-settings.json) is not a job of this file`);
  return bad;
}

test('central CI: the three project files exist, named as gitlab-settings.json says, one per project; any other *.yml in the folder has a name the sync accepts', ({ CONFIG }) => {
  const dir = path.join(ROOT, 'ci');
  const present = readdirSync(dir).filter((f) => f.endsWith('.yml'));
  // The delivery lanes of plan agentic-delivery add their templates to this folder and the sync copies every *.yml, so the folder is not closed:
  // the three project files must exist, and any other file only needs a name the sync accepts.
  for (const f of ['platform.gitlab-ci.yml', 'rehearsal.gitlab-ci.yml', 'v1.gitlab-ci.yml']) assert.ok(present.includes(f), `${f} is in the folder: the sync writes every *.yml directly in it to vitana/ci-config under the same name`);
  assert.deepEqual(Object.fromEntries(Object.entries(CONFIG.projects).map(([k, p]) => [k, p.ci_file])),
    { 'vitana-platform': 'platform.gitlab-ci.yml', 'vitana-v1': 'v1.gitlab-ci.yml', rehearsal: 'rehearsal.gitlab-ci.yml' }, 'part A points each project at its own file');
  for (const f of present) assert.match(f, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.yml$/, `${f}: a name the sync accepts`);
});

test('central CI: every file parses, and its structure is what plan section 3.3 promises (workflow, retry, tag, interruptible, no deploy, no secret, nothing Premium)', ({ CI, CONFIG }) => {
  const required = { platform: CONFIG.projects['vitana-platform'].required_jobs, v1: CONFIG.projects['vitana-v1'].required_jobs, rehearsal: CONFIG.projects.rehearsal.required_jobs };
  for (const [name, text] of Object.entries(CI)) assert.deepEqual(lintCi(parseYaml(text), { requiredJobs: required[name] }), [], name);
});

test('central CI: merge-request pipelines come first in workflow.rules, and the main-only rules of milestone 1 stay for the mirrored projects', ({ CI }) => {
  for (const [name, text] of Object.entries(CI)) {
    const rules = parseYaml(text).workflow.rules;
    assert.deepEqual(rules.map((r) => r.if), WANT_WORKFLOW, name);
    assert.equal(rules.every((r) => Object.keys(r).join() === 'if'), true, `${name}: plain if rules`);
  }
});

test('central CI: default has tag vitana-eng, interruptible, and one retry for runner_system_failure and stuck_or_timeout_failure only', ({ CI }) => {
  for (const [name, text] of Object.entries(CI)) {
    const d = parseYaml(text).default;
    assert.deepEqual(d.tags, ['vitana-eng'], name);
    assert.equal(d.interruptible, true, name);
    assert.deepEqual(d.retry, { max: 1, when: ['runner_system_failure', 'stuck_or_timeout_failure'] }, name);
    assert.equal(d.image, 'public.ecr.aws/docker/library/node:20-bookworm', `${name}: the image of milestone 1`);
  }
});

test('central CI: the platform and vitana-v1 jobs are those of milestone 1, unchanged (typecheck: npm ci then pnpm run typecheck; gateway-jest: pnpm install --frozen-lockfile)', ({ CI, M1_CI }) => {
  for (const key of ['platform', 'v1']) {
    const ours = parseYaml(CI[key]);
    const m1 = parseYaml(M1_CI[key]);
    assert.deepEqual(ours.stages, m1.stages, `${key}: stages`);
    assert.deepEqual(ours.variables, m1.variables, `${key}: variables`);
    const { retry: _retry, ...defaultWithoutRetry } = ours.default;
    assert.deepEqual(defaultWithoutRetry, m1.default, `${key}: default, except the added retry`);
    const jobs = (d) => Object.keys(d).filter((k) => !RESERVED.has(k));
    assert.deepEqual(jobs(ours).sort(), jobs(m1).sort(), `${key}: the same job names`);
    // runner-pin-jq: the one allowed difference is the jq install first in .gateway's before_script (node:20-bookworm has no jq).
    const JQ = 'apt-get update -qq && apt-get install -y -qq jq';
    for (const j of jobs(m1)) {
      if (key === 'platform' && j === '.gateway') {
        assert.equal(ours[j].before_script[0], JQ, 'platform: .gateway installs jq first');
        assert.deepEqual({ ...ours[j], before_script: ours[j].before_script.slice(1) }, m1[j], 'platform: .gateway is otherwise word for word the milestone 1 job');
      } else assert.deepEqual(ours[j], m1[j], `${key}: job ${j} is word for word the milestone 1 job`);
    }
  }
  const p = parseYaml(CI.platform);
  assert.deepEqual(p.typecheck.script, ['npm ci --no-audit --no-fund', 'pnpm run typecheck']);
  assert.equal(p['gateway-jest'].script[0], 'pnpm install --frozen-lockfile');
  assert.equal(p['gateway-jest'].parallel, 4);
  assert.deepEqual(Object.keys(parseYaml(CI.v1)).filter((k) => !RESERVED.has(k) && !k.startsWith('.')).sort(), ['build', 'lint', 'unit-tests']);
  assert.equal(parseYaml(CI.v1).lint.allow_failure, true, 'lint still does not fail the pipeline');
});

test('central CI: the required jobs of gitlab-settings.json are real jobs of the project\'s file; rehearsal has the job unit, which runs the seed\'s tests', ({ CI, CONFIG }) => {
  for (const [project, p] of Object.entries(CONFIG.projects)) {
    const key = { 'vitana-platform': 'platform', 'vitana-v1': 'v1', rehearsal: 'rehearsal' }[project];
    const doc = parseYaml(CI[key]);
    const real = Object.keys(doc).filter((k) => !RESERVED.has(k) && !k.startsWith('.'));
    for (const j of p.required_jobs) assert.ok(real.includes(j), `${project}: required job ${j} exists in ${p.ci_file}`);
  }
  assert.deepEqual(CONFIG.projects.rehearsal.required_jobs, ['unit']);
  const r = parseYaml(CI.rehearsal);
  assert.deepEqual(r.unit.script, ['node --version', 'npm test']);
  assert.equal(r.unit.stage, 'check');
  assert.deepEqual(Object.keys(r).filter((k) => !RESERVED.has(k)), ['unit'], 'a tiny file: one job');
});

test('central CI structural walk: a file that breaks a promise is reported, one problem per promise (negative control)', ({ CI }) => {
  const good = () => parseYaml(CI.platform);
  const cases = [
    ['a dangling extends', (d) => { d.typecheck.extends = '.nowhere'; }, /extends \.nowhere, which does not exist/],
    ['an extends loop', (d) => { d['.gateway'].extends = 'typecheck'; }, /extends loops/],
    ['a needs on a job that is not there', (d) => { d['gateway-jest'].needs = ['typecheck', 'ghost']; }, /needs "ghost"/],
    ['a needs loop', (d) => { d.typecheck.needs = ['gateway-jest']; d['gateway-jest'].needs = ['typecheck']; }, /needs loops/],
    ['a needs on another project', (d) => { d.typecheck.needs = [{ project: 'x/y', job: 'a', ref: 'main', artifacts: true }]; }, /Premium-only/],
    ['a rule with an unknown key', (d) => { d.typecheck.rules = [{ if: '$X', changed: ['a'] }]; }, /rules key changed/],
    ['a job without a script', (d) => { delete d.typecheck.script; }, /script must be a list/],
    ['a stage that does not exist', (d) => { d.typecheck.stage = 'ship'; }, /stage "ship"/],
    ['a deploy job', (d) => { d.deploy_prod = { stage: 'check', script: ['echo hi'] }; }, /deploy-like job/],
    ['a deployment keyword', (d) => { d.typecheck.environment = 'production'; }, /keyword environment/],
    ['a secret from a vault', (d) => { d.typecheck.secrets = { DB: { vault: 'a/b/c' } }; }, /keyword secrets/],
    ['a cloud command', (d) => { d.typecheck.script = ['aws s3 ls']; }, /talks to a cloud/],
    ['a credential variable', (d) => { d.variables.DEPLOY_TOKEN = 'x'; }, /looks like a credential/],
    ['a job that sets its own tag', (d) => { d.typecheck.tags = ['vitana-legacy']; }, /tags must stay/],
    ['a job that sets its own retry', (d) => { d.typecheck.retry = 2; }, /retry is set once in default/],
    ['no merge-request rule', (d) => { d.workflow.rules.shift(); }, /workflow\.rules must be exactly/],
    ['no retry in default', (d) => { delete d.default.retry; }, /default\.retry must be/],
    ['retry twice', (d) => { d.default.retry.max = 2; }, /default\.retry must be/],
    ['retry on every failure', (d) => { d.default.retry.when.push('script_failure'); }, /default\.retry must be/],
    ['another tag', (d) => { d.default.tags = ['other']; }, /default\.tags/],
    ['interruptible off', (d) => { d.default.interruptible = false; }, /default\.interruptible/],
    ['an include', (d) => { d.include = [{ remote: 'https://example.test/ci.yml' }]; }, /include/],
  ];
  for (const [label, mutate, expect] of cases) {
    const d = good();
    mutate(d);
    const problems = lintCi(d);
    assert.ok(problems.some((p) => expect.test(p)), `${label} is reported; got ${JSON.stringify(problems)}`);
  }
  assert.deepEqual(lintCi(good()), [], 'and the file as it is has none');
  assert.ok(lintCi(good(), { requiredJobs: ['unit'] }).some((p) => /required job unit/.test(p)), 'a required job that is missing is reported');
});

test('central CI reader: it refuses what it cannot read instead of misreading it', () => {
  for (const [label, text] of [['an anchor', 'a: &x 1\n'], ['a block scalar', 'a: |\n  x\n'], ['a flow mapping', 'a: {b: 1}\n'], ['a tab', 'a:\n\tb: 1\n'], ['a duplicate key', 'a: 1\na: 2\n'], ['a stray indent', 'a: 1\n   b: 2\n']]) {
    assert.throws(() => parseYaml(text), undefined, label);
  }
  assert.deepEqual(parseYaml('a:\n  - b: 1\n    c: [x, y]\n  - "q: r"\n# note\nd: "true" # tail\n'), { a: [{ b: 1, c: ['x', 'y'] }, 'q: r'], d: 'true' });
});

const PYYAML = spawnSync('python3', ['-c', 'import yaml'], { env: process.env }).status === 0;
nodeTest('central CI reader agrees with PyYAML on every file of the folder', { skip: PYYAML ? false : 'PyYAML is not installed on this machine (set PYTHONPATH to a folder that has it)' }, () => {
  for (const f of Object.values(CI_FILES).map((p) => path.basename(p))) {   // the three project files; the delivery templates of other lanes use YAML this reader does not claim to read
    const r = spawnSync('python3', ['-c', 'import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf8"))))', path.join(ROOT, 'ci', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.deepEqual(parseYaml(read(`ci/${f}`)), JSON.parse(r.stdout), `${f}: both readers see the same document`);
  }
});

// ============================================================================================================================
// 2b. THE SYSTEMD UNITS (task S4)
// ============================================================================================================================
function parseUnit(text) {
  const sections = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith(';')) continue;
    const s = /^\[(\w+)\]$/.exec(l);
    if (s) { cur = sections[s[1]] = {}; continue; }
    const kv = /^([A-Za-z0-9]+)=(.*)$/.exec(l);
    if (!kv || !cur) throw new Error(`not a unit line: ${l}`);
    (cur[kv[1]] ??= []).push(kv[2]);
  }
  return sections;
}
function words(s) { // systemd-style words: spaces separate, single and double quotes group
  const out = [];
  let cur = '';
  let q = null;
  let any = false;
  for (const c of s) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}
const one = (sec, key) => { assert.equal((sec[key] ?? []).length, 1, `${key} appears once`); return sec[key][0]; };

test('vitana-settings.service: one tick of `gitlab-settings.mjs apply` under flock -n -E 0, niced and capped, with the env file, root, and room to write /etc/vitana', ({ UNITS }) => {
  const u = parseUnit(UNITS['vitana-settings.service']);
  assert.deepEqual(Object.keys(u), ['Unit', 'Service']);
  assert.match(one(u.Unit, 'After'), /network-online\.target/);
  const s = u.Service;
  assert.equal(one(s, 'Type'), 'oneshot');
  assert.equal(one(s, 'Nice'), '10');
  assert.match(one(s, 'CPUQuota'), /^\d+%$/);
  assert.match(one(s, 'MemoryMax'), /^\d+[MG]$/);
  const timeout = Number(one(s, 'TimeoutStartSec'));
  assert.ok(timeout >= 60 && timeout < 600, `a tick that hangs is stopped before the next one (the timer is every 10 minutes): ${timeout}`);
  assert.equal(one(s, 'EnvironmentFile'), '/etc/vitana/env', 'REGION and DOMAIN, which the script needs');
  assert.match(s.Environment.find((e) => e.startsWith('PATH=')) ?? '', /^PATH=.*\/usr\/local\/bin.*\/usr\/bin/, 'aws is in /usr/local/bin and node in /usr/bin');
  assert.equal(s.User, undefined, 'root: the token files are root only');
  assert.equal(s.Group, undefined);
  // the sandbox may not take away the one thing the sync must do: write /etc/vitana (token files, atomic temp files next to them)
  if (s.ProtectSystem && ['full', 'strict', 'true'].includes(s.ProtectSystem[0])) {
    assert.ok(s.ReadWritePaths, 'ProtectSystem makes /etc read only, so /etc/vitana must be listed in ReadWritePaths');
    assert.deepEqual(s.ReadWritePaths.join(' ').split(/\s+/).sort(), ['/etc/vitana'], 'exactly what is written, nothing wider');
  }
  assert.equal(one(s, 'NoNewPrivileges'), 'true');
  assert.equal(one(s, 'PrivateTmp'), 'true');
  assert.equal(s.ProtectSystem && s.ProtectSystem[0] === 'strict' && !(s.ReadWritePaths ?? []).join(' ').includes('/run'), false, 'strict would make /run read only and break the lock file');
  const exec = words(one(s, 'ExecStart'));
  assert.deepEqual(exec.slice(0, 6), ['/usr/bin/flock', '-n', '-E', '0', '/run/vitana-settings.lock', '/usr/bin/node']);
  assert.equal(exec[6], '/opt/vitana/platform/scripts/eng/gitlab-settings.mjs');
  assert.deepEqual(exec.slice(7), ['apply']);
  assert.equal(/glpat|glrt|token=|PRIVATE-TOKEN|AKIA/i.test(UNITS['vitana-settings.service']), false, 'the unit holds no token');
});

test('vitana-settings.service: the command line is one that gitlab-settings.mjs itself accepts (contract with part A)', async ({ UNITS }) => {
  const A = await import('./gitlab-settings.mjs');
  const exec = words(one(parseUnit(UNITS['vitana-settings.service']).Service, 'ExecStart'));
  const o = A.parseArgs(exec.slice(7));
  assert.equal(o.command, 'apply');
  assert.equal(o.dryRun, false, 'the timer applies');
  assert.equal(o.configFile, undefined, 'the default config is the file in the checkout');
  // the defaults that the unit relies on
  assert.equal(path.relative(path.dirname(fileURLToPath(import.meta.url)), A.defaultConfigPath()), path.join('..', '..', 'infra', 'gitlab-engineering', 'settings', 'gitlab-settings.json'));
  assert.equal(A.DEFAULTS.adminTokenFile, '/etc/vitana/settings-admin-token', 'ops-install.sh writes this file');
  assert.equal(A.DEFAULTS.url, 'http://127.0.0.1');
  assert.ok(A.defaultCiDir().endsWith(path.join('infra', 'gitlab-engineering', 'ci')), 'the CI files of this lane are what the sync copies');
  assert.equal(A.parseArgs(['check']).command, 'check', 'm2.sh status runs the check command');
});

test('vitana-settings.timer: every 10 minutes after a start delay, starts the service, installed on timers.target', ({ UNITS }) => {
  const u = parseUnit(UNITS['vitana-settings.timer']);
  assert.equal(one(u.Timer, 'OnUnitActiveSec'), '10min');
  assert.equal(one(u.Timer, 'OnBootSec'), '3min', 'after the checkout sync (1 min), before nobody notices');
  assert.equal(one(u.Timer, 'AccuracySec'), '5s');
  assert.equal(one(u.Timer, 'Unit'), 'vitana-settings.service');
  assert.deepEqual(u.Install.WantedBy, ['timers.target']);
});

test('vitana-platform-sync.service: fetch and merge --ff-only under one flock, no rebase, no reset, no force, the token through GIT_ASKPASS only', ({ UNITS }) => {
  const text = UNITS['vitana-platform-sync.service'];
  const s = parseUnit(text).Service;
  assert.equal(one(s, 'Type'), 'oneshot');
  assert.equal(one(s, 'Nice'), '10');
  assert.match(one(s, 'CPUQuota'), /^\d+%$/);
  assert.match(one(s, 'MemoryMax'), /^\d+[MG]$/);
  const timeout = Number(one(s, 'TimeoutStartSec'));
  assert.ok(timeout >= 30 && timeout <= 300, `a start timeout well under many ticks: ${timeout}`);
  assert.equal(one(s, 'EnvironmentFile'), '/etc/vitana/env');
  const env = Object.fromEntries(s.Environment.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  assert.match(env.PATH, /\/usr\/bin/);
  assert.equal(env.GIT_ASKPASS, '/opt/vitana/git-askpass.sh', 'the helper that ops-install.sh installs');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0', 'git never waits for a person');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(s.User, undefined, 'root reads /etc/vitana/mirror-token');
  if (s.ProtectSystem) assert.equal(s.ProtectSystem[0], 'full', '/opt/vitana/platform is under /opt, which `full` leaves writable; `strict` would not');
  const exec = words(one(s, 'ExecStart'));
  assert.deepEqual(exec.slice(0, 7), ['/usr/bin/flock', '-n', '-E', '0', '/run/vitana-platform-sync.lock', '/bin/sh', '-c']);
  const script = exec[7];
  assert.equal(exec.length, 8);
  assert.match(script, /^git -C \/opt\/vitana\/platform fetch --quiet origin main && git -C \/opt\/vitana\/platform merge --quiet --ff-only FETCH_HEAD$/);
  for (const never of [/rebase/, /reset/, /--force|\s-f\b/, /\bpull\b/, /\bcheckout\b/, /\bclean\b/, /--hard/, /--no-ff/, /--allow-unrelated/, /stash/, /gc\b/]) assert.equal(never.test(script), false, `${never} is not in the sync`);
  assert.equal(/@127\.0\.0\.1|oauth2:|http:\/\/[^ ]*:[^ ]*@/.test(text), false, 'no credential in a URL');
  assert.equal(/glpat|glrt|PRIVATE-TOKEN|mirror-token/i.test(text.replace(/^#.*$/gm, '')), false, 'the unit holds no token and does not even name the token file (the helper does)');
  assert.equal(/[%$]/.test(one(s, 'ExecStart')), false, 'systemd would expand a % or $ in the command line');
});

test('vitana-platform-sync.timer: every minute, starts the service, installed on timers.target', ({ UNITS }) => {
  const u = parseUnit(UNITS['vitana-platform-sync.timer']);
  assert.equal(one(u.Timer, 'OnUnitActiveSec'), '1min');
  assert.equal(one(u.Timer, 'OnBootSec'), '1min');
  assert.equal(one(u.Timer, 'AccuracySec'), '5s');
  assert.equal(one(u.Timer, 'Unit'), 'vitana-platform-sync.service');
  assert.deepEqual(u.Install.WantedBy, ['timers.target']);
});

test('the four units are exactly the files the lane owns in host/units, and each timer names the service of its pair', () => {
  const have = readdirSync(path.join(ROOT, 'host', 'units')).filter((f) => f.startsWith('vitana-settings.') || f.startsWith('vitana-platform-sync.')).sort();
  assert.deepEqual(have, UNIT_NAMES.slice().sort());
});

// ============================================================================================================================
// 2c. terraform/settings.tf (task S4)
// ============================================================================================================================
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
const declared = (src) => [...src.matchAll(/^(resource|data)\s+"([^"]+)"\s+"([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}.${m[3]}`);
const labelsOf = (src, kind) => [...src.matchAll(new RegExp(`^${kind}\\s+"([^"]+)"\\s*\\{`, 'gm'))].map((m) => m[1]);
const codeOf = (src) => src.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
const otherTf = () => readdirSync(path.join(ROOT, 'terraform')).filter((f) => f.endsWith('.tf') && f !== 'settings.tf' && f !== 'main.tf').map((f) => [f, read(`terraform/${f}`)]);

/** The policy document of settings.tf as AWS will see it: interpolations replaced by the values of a sample account, statements listed. */
const SAMPLE = { region: 'eu-central-1', account: '123456789012', keyArn: 'arn:aws:kms:eu-central-1:123456789012:key/11111111-2222-3333-4444-555555555555' };
function renderPolicy(tf) {
  const locals = {};
  for (const m of codeOf(block(tf, 'locals').replace(/^locals\s*\{/, '')).matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"\s*$/gm)) locals[m[1]] = m[2];
  const sub = (s) => s
    .replace(/\$\{var\.region\}/g, SAMPLE.region)
    .replace(/\$\{data\.aws_caller_identity\.me\.account_id\}/g, SAMPLE.account)
    .replace(/\$\{local\.(\w+)\}/g, (_, n) => { if (!(n in locals)) throw new Error(`unknown local ${n}`); return sub(locals[n]); });
  const doc = codeOf(block(tf, 'data', 'aws_iam_policy_document', 'settings'));
  const statements = [];
  for (const m of doc.matchAll(/statement\s*\{([\s\S]*?)\n  \}/g)) {
    const b = m[1];
    const list = (name) => {
      const x = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(b);
      if (!x) return [];
      return [...x[1].matchAll(/"([^"]*)"|(aws_kms_key\.main\.arn)/g)].map((y) => (y[2] ? SAMPLE.keyArn : sub(y[1])));
    };
    statements.push({ Sid: /sid\s*=\s*"([^"]+)"/.exec(b)?.[1], Effect: /effect\s*=\s*"(\w+)"/.exec(b)?.[1] ?? 'Allow', Action: list('actions'), Resource: list('resources'), hasCondition: /condition\s*\{/.test(b), hasPrincipal: /principals\s*\{/.test(b) });
  }
  return statements;
}
const SECRET_BASE = `arn:aws:secretsmanager:${SAMPLE.region}:${SAMPLE.account}:secret:vitana/engineering/gitlab`;

test('settings.tf is a second file of the same module: no provider, backend, terraform block or variable, no name another file uses, only the policy and its attachment', ({ TF, MAIN }) => {
  const code = codeOf(TF);
  assert.equal(/^\s*provider\s+"/m.test(code), false, 'no provider block (main.tf configures AWS)');
  assert.equal(/^\s*terraform\s*\{/m.test(code), false, 'no terraform block (main.tf pins the version and the backend)');
  assert.equal(/^\s*backend\s+"/m.test(code), false, 'no backend');
  assert.deepEqual(declared(TF).sort(), ['data.aws_iam_policy_document.settings', 'resource.aws_iam_role_policy.settings'], 'exactly what the lane needs');
  for (const v of labelsOf(TF, 'variable')) assert.match(block(TF, 'variable', v), /^\s*default\s*=/m, `variable ${v} has a default`);
  assert.deepEqual(labelsOf(TF, 'variable'), [], 'no variable at all, so the owner\'s setup.sh apply needs no new -var flag');
  assert.deepEqual(labelsOf(TF, 'output').filter((n) => labelsOf(MAIN, 'output').includes(n)), [], 'no output declared twice');
  for (const [name, src] of [['main.tf', MAIN], ...otherTf()]) {
    assert.deepEqual(declared(TF).filter((n) => declared(src).includes(n)), [], `no resource or data source of ${name} is declared again`);
    assert.deepEqual(labelsOf(TF, 'output').filter((n) => labelsOf(src, 'output').includes(n)), [], `no output of ${name} is declared again`);
  }
  const localNames = [...codeOf(block(TF, 'locals')).matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]);
  for (const n of localNames) assert.match(n, /^settings_/, `local ${n} is prefixed, so it cannot clash with another file's locals`);
  for (const [name, src] of otherTf()) for (const n of localNames) assert.equal(new RegExp(`^\\s*${n}\\s*=`, 'm').test(codeOf(src)), false, `${name} has no local ${n}`);
});

test('settings.tf: every reference to another file points at something main.tf really declares', ({ TF, MAIN }) => {
  const code = codeOf(TF);
  const refs = new Set([...code.matchAll(/\b(aws_[a-z0-9_]+)\.([a-z0-9_]+)\b/g)].map((m) => `${m[1]}.${m[2]}`));
  const mine = new Set(declared(TF).map((d) => d.replace(/^(resource|data)\./, '')));
  const theirs = new Set(declared(MAIN).map((d) => d.replace(/^(resource|data)\./, '')));
  assert.deepEqual([...refs].filter((r) => !mine.has(r) && !theirs.has(r)), [], 'unresolved reference');
  for (const must of ['aws_iam_role.gitlab', 'aws_kms_key.main']) assert.ok(refs.has(must), `uses ${must}`);
  const vars = new Set([...code.matchAll(/\bvar\.(\w+)/g)].map((m) => m[1]));
  assert.deepEqual([...vars].filter((v) => !labelsOf(MAIN, 'variable').includes(v)), [], 'only variables that main.tf declares');
  assert.ok(/data\.aws_caller_identity\.me\.account_id/.test(code) && /data "aws_caller_identity" "me"/.test(MAIN));
});

test('settings.tf: an inline policy named settings on the role of the GitLab machine, built from its policy document, and no other role is touched', ({ TF, MAIN }) => {
  const b = block(TF, 'resource', 'aws_iam_role_policy', 'settings');
  assert.match(b, /name\s*=\s*"settings"/);
  assert.match(b, /role\s*=\s*aws_iam_role\.gitlab\.id\b/, 'the host role of main.tf, as monitoring.tf attaches its policy');
  assert.match(b, /policy\s*=\s*data\.aws_iam_policy_document\.settings\.json/);
  assert.match(block(MAIN, 'resource', 'aws_iam_role', 'gitlab'), /name\s*=\s*"vitana-eng-gitlab"/);
  const names = [['main.tf', MAIN], ...otherTf()].flatMap(([, src]) => [...src.matchAll(/resource\s+"aws_iam_role_policy"\s+"[^"]+"\s*\{[^}]*?name\s*=\s*"([^"]+)"[^}]*?role\s*=\s*aws_iam_role\.gitlab\.id/gs)].map((m) => m[1]));
  assert.equal(new Set(names).size, names.length, `inline policy names on the host role are unique: ${names.join(', ')}`);
});

test('settings.tf policy, statement by statement: the agent tokens, the fleet runner token, the webhook signing token, the key, and the read-only view of the fleet group for the rehearsal', ({ TF }) => {
  const st = renderPolicy(TF);
  assert.deepEqual(st.map((s) => s.Sid), ['AgentTokens', 'FleetRunnerToken', 'WebhookSigningToken', 'UseKeyForTheEncryptedSecrets', 'ReadTheFleetGroupForTheRehearsal']);
  const by = Object.fromEntries(st.map((s) => [s.Sid, s]));
  for (const s of st) { assert.equal(s.Effect, 'Allow', `${s.Sid}: Allow only`); assert.equal(s.hasPrincipal, false); assert.equal(s.hasCondition, false, `${s.Sid}: nothing conditional to get wrong`); }
  // 1. agents/*: read, write, create (when the secret does not exist yet) and describe; no tags, nothing else
  assert.deepEqual(by.AgentTokens.Action.slice().sort(), ['secretsmanager:CreateSecret', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']);
  assert.deepEqual(by.AgentTokens.Resource, [`${SECRET_BASE}/agents/*`]);
  // 2. the fleet runner token: read, write, describe; created by the fleet lane, never here
  assert.deepEqual(by.FleetRunnerToken.Action.slice().sort(), ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']);
  assert.deepEqual(by.FleetRunnerToken.Resource, [`${SECRET_BASE}/fleet-runner-token-??????`]);
  // 3. the webhook signing token: read only
  assert.deepEqual(by.WebhookSigningToken.Action.slice().sort(), ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
  assert.deepEqual(by.WebhookSigningToken.Resource, [`${SECRET_BASE}/webhook-signing-token-??????`]);
  // 4. the key of main.tf, for the secrets it encrypts (the fleet token)
  assert.deepEqual(by.UseKeyForTheEncryptedSecrets.Action.slice().sort(), ['kms:Decrypt', 'kms:GenerateDataKey']);
  assert.deepEqual(by.UseKeyForTheEncryptedSecrets.Resource, [SAMPLE.keyArn]);
  // 5. the rehearsal samples the fleet group: two read-only Describe actions, which cannot be limited to one group
  assert.deepEqual(by.ReadTheFleetGroupForTheRehearsal.Action.slice().sort(), ['autoscaling:DescribeAutoScalingGroups', 'autoscaling:DescribeScalingActivities']);
  assert.deepEqual(by.ReadTheFleetGroupForTheRehearsal.Resource, ['*']);
});

test('settings.tf policy: no wildcard action, no bare wildcard resource except the read-only autoscaling Describe pair, no write that the sync does not make', ({ TF }) => {
  const all = renderPolicy(TF);
  const bare = all.filter((s) => s.Resource.includes('*') && s.Resource.every((r) => r === '*'));
  assert.deepEqual(bare.map((s) => s.Sid), ['ReadTheFleetGroupForTheRehearsal'], 'the only statement whose resource is a bare *');
  assert.deepEqual(bare[0].Action.slice().sort(), ['autoscaling:DescribeAutoScalingGroups', 'autoscaling:DescribeScalingActivities'], 'and it holds the two read-only Describe actions of the rehearsal, nothing else');
  assert.equal(bare[0].Action.every((a) => /^autoscaling:Describe[A-Za-z]+$/.test(a)), true, 'Describe only: no write');
  const st = all.filter((s) => s !== bare[0]);
  const actions = st.flatMap((s) => s.Action);
  const resources = st.flatMap((s) => s.Resource);
  assert.equal(actions.some((a) => a.includes('*')), false, 'no * in any action');
  assert.equal(resources.includes('*'), false, 'no bare * resource');
  const wildcarded = resources.filter((r) => r.includes('*'));
  assert.deepEqual(wildcarded, [`${SECRET_BASE}/agents/*`], 'the one prefix wildcard in the file: the per-account agent secrets, made at run time');
  for (const r of resources.filter((x) => x.includes('?'))) assert.match(r, /-\?{6}$/, 'a fixed secret ends in the six characters AWS adds');
  for (const forbidden of ['TagResource', 'UntagResource', 'DeleteSecret', 'PutResourcePolicy', 'DeleteResourcePolicy', 'UpdateSecret', 'RotateSecret', 'RestoreSecret', 'ReplicateSecretToRegions', 'ListSecrets', 'GetResourcePolicy', 'BatchGetSecretValue']) {
    assert.equal(actions.includes(`secretsmanager:${forbidden}`), false, `not granted: ${forbidden}`);
  }
  assert.equal(actions.some((a) => /^(iam|sts|ec2|s3|ssm|organizations):/.test(a)), false, 'Secrets Manager and KMS only');
  assert.equal(resources.some((r) => !r.startsWith('arn:aws:secretsmanager:') && !r.startsWith('arn:aws:kms:')), false);
  // only the three fixed names plus the prefix: no other secret of the engineering tree
  for (const r of resources.filter((x) => x.startsWith('arn:aws:secretsmanager:'))) assert.ok(r.startsWith(`${SECRET_BASE}/`), r);
  // M1's secrets (root password, runner token, GitHub token) are not reachable through this policy
  for (const m1 of ['root-password', 'runner-token', 'github-mirror-token']) assert.equal(resources.some((r) => r.startsWith(`${SECRET_BASE}/${m1}`) || (r.endsWith('/*') && !r.endsWith('/agents/*'))), false, m1);
});

test('settings.tf creates no secret (the fleet lane creates the runner token secret, the sync the agent secrets) and says why each wildcard and the KMS rights are what they are', ({ TF }) => {
  assert.equal(/resource\s+"aws_secretsmanager_secret/.test(TF), false, 'no aws_secretsmanager_secret resource');
  assert.equal(/resource\s+"aws_kms_/.test(TF), false, 'no key');
  assert.match(TF, /agents\/\*[^\n]*\n|prefix, agents\/\*/, 'the agents/* wildcard is explained');
  assert.match(TF, /one per account[^\n]*made at run time|made at run time/, 'because the agent secrets are made at run time');
  assert.match(TF, /aws\/secretsmanager/, 'the key the agent secrets use is named');
  assert.match(TF, /kms:ViaService/, 'and why no KMS statement can or needs to name it');
  assert.match(TF, /TagResource is not granted|so TagResource is not granted/, 'TagResource is left out on purpose');
  assert.match(TF, /fleet lane creates the empty fleet runner token secret/);
  assert.match(TF, /Describe actions have no resource-level permission/, 'the bare * of the autoscaling statement is explained');
});

test('settings.tf matches what part A really calls: Secrets Manager get-secret-value, put-secret-value and create-secret only, on the secrets of its SECRETS table, with no tags and no KMS key', ({ TF, ENGINE }) => {
  const used = new Set([...ENGINE.matchAll(/'secretsmanager',\s*'([a-z-]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ['create-secret', 'get-secret-value', 'put-secret-value'], 'the sync calls exactly these three');
  assert.equal(/--tags|--kms-key-id|--add-replica-regions|--force-overwrite/.test(ENGINE), false, 'it passes no tags, no key and no replica: so TagResource and key rights are not needed, and the agent secrets use the default key');
  const iam = { 'get-secret-value': 'secretsmanager:GetSecretValue', 'put-secret-value': 'secretsmanager:PutSecretValue', 'create-secret': 'secretsmanager:CreateSecret' };
  const st = renderPolicy(TF);
  for (const c of used) assert.ok(st.some((s) => s.Action.includes(iam[c])), `${c} is covered`);
  // the secret names of part A's SECRETS table are each covered by a resource of the policy
  const table = /export const SECRETS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(ENGINE)?.[1] ?? '';
  const agent = /agent: \(username\) => `([^`]+)`/.exec(table)?.[1];
  const fleet = /fleet: '([^']+)'/.exec(table)?.[1];
  const webhook = /webhook: '([^']+)'/.exec(table)?.[1];
  assert.equal(agent, 'vitana/engineering/gitlab/agents/${username}');
  const arn = (n) => `arn:aws:secretsmanager:${SAMPLE.region}:${SAMPLE.account}:secret:${n}`;
  const match = (pattern, value) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(value);
  const covered = (action, name) => st.some((s) => s.Action.includes(action) && s.Resource.some((r) => match(r, `${arn(name)}-AbC123`)));
  for (const name of ['vitana/engineering/gitlab/agents/bot-land', 'vitana/engineering/gitlab/agents/agent-kiro-exafy']) for (const a of Object.values(iam)) assert.ok(covered(a, name), `${a} on ${name}`);
  for (const a of ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']) assert.ok(covered(a, fleet), `${a} on ${fleet}`);
  assert.ok(covered('secretsmanager:GetSecretValue', webhook), `GetSecretValue on ${webhook}`);
  assert.equal(covered('secretsmanager:PutSecretValue', webhook), false, 'the signing token is read only');
  assert.equal(covered('secretsmanager:CreateSecret', fleet), false, 'the fleet secret is never created here');
  for (const other of ['root-password', 'runner-token', 'github-mirror-token', 'agentsx']) assert.equal(covered('secretsmanager:GetSecretValue', `vitana/engineering/gitlab/${other}`), false, other);
  assert.equal(covered('secretsmanager:GetSecretValue', 'vitana/engineering/gitlab/fleet-runner-token-extra'), false, 'a longer name is not matched by the fixed ones');
});

// ============================================================================================================================
// 2d. host/ops-install.sh, run against stand-ins (task S4)
// ============================================================================================================================
const PINNED_SHA = /^NODE_SHA256=([0-9a-f]{64})$/m;
const mode = (f) => (statSync(f).mode & 0o777).toString(8);
const hasLink = (p) => { try { lstatSync(p); return true; } catch { return false; } };
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const sh = (body) => `#!/bin/bash\n${body}\n`;

function opsHarness({ units = true, opsd = ['10-first.sh', '30-last.sh'], failing = [], untouchedUnits = false } = {}) {
  const OPS = read('host/ops-install.sh');
  const pinned = PINNED_SHA.exec(OPS)?.[1] ?? '0'.repeat(64);
  const T = tmp('ops-');
  const root = path.join(T, 'root');
  const bin = path.join(T, 'bin');
  const fake = path.join(T, 'fake');
  for (const d of [root, bin, fake, path.join(fake, 'active'), path.join(fake, 'enabled')]) mkdirSync(d, { recursive: true });
  put(path.join(root, 'etc/vitana/env'), 'DOMAIN=gitlab.example.test\nREGION=eu-central-1\nBACKUP_BUCKET=b\n');
  put(path.join(root, 'etc/vitana/mirror-token'), 'MIRROR-TOKEN-VALUE-0123456789\n', 0o600);
  // the origin: a bare repository with the files a real main has
  const work = path.join(T, 'work');
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  put(path.join(work, 'README.md'), 'platform\n');
  if (units) {
    for (const n of ['vitana-settings.service', 'vitana-settings.timer', 'vitana-platform-sync.service', 'vitana-platform-sync.timer', 'vitana-land.service', 'vitana-land.timer', 'vitana-ci-metrics.service', 'vitana-ci-metrics.timer']) {
      put(path.join(work, 'infra/gitlab-engineering/host/units', n), n.endsWith('.timer') ? `[Timer]\nUnit=${n.replace('.timer', '.service')}\n[Install]\nWantedBy=timers.target\n` : `[Service]\nExecStart=/bin/true\n# ${n}\n`);
    }
    put(path.join(work, 'infra/gitlab-engineering/host/units/README.txt'), 'not a unit\n');
  }
  for (const n of opsd) {
    const fails = failing.includes(n);
    put(path.join(work, 'infra/gitlab-engineering/host/ops.d', n), sh(`echo "${n}" >> "${path.join(T, 'opsd.log')}"\n${fails ? 'echo "this one fails" >&2; exit 3' : 'exit 0'}`), 0o644);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'main');
  git(T, 'clone', '-q', '--bare', work, path.join(T, 'origin.git'));
  // the fake node tarball
  const nodeDir = path.join(T, 'tar/node-v20.20.2-linux-x64/bin');
  mkdirSync(nodeDir, { recursive: true });
  for (const b of ['node', 'npm', 'npx']) put(path.join(nodeDir, b), sh(`[ "$1" = --version ] && echo v20.20.2 || echo ${b}`), 0o755);
  spawnSync('tar', ['-czf', path.join(T, 'node.tar.gz'), '-C', path.join(T, 'tar'), 'node-v20.20.2-linux-x64']);
  put(path.join(fake, 'shasums'), `${pinned}  node-v20.20.2-linux-x64.tar.gz\n${'1'.repeat(64)}  node-v20.20.2-linux-x64.tar.xz\n`);
  put(path.join(fake, 'valid-tokens'), '');
  // stand-ins
  const calls = path.join(fake, 'calls.log');
  writeFileSync(calls, '');
  put(path.join(bin, 'curl'), sh(`echo "curl $*" >> "${calls}"
out=""; fmt=""; cfg=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; -w) fmt="$2"; shift;; -K) cfg="$2"; shift;; -m|--retry) shift;; -*) ;; *) url="$1";; esac; shift; done
case "$url" in
  *.tar.gz) [ "\${FAKE_CURL_FAIL:-}" = node ] && exit 22; cp "${T}/node.tar.gz" "$out" ;;
  *SHASUMS256.txt) [ "\${FAKE_SHASUMS_DOWN:-}" = 1 ] && exit 22; cp "${fake}/shasums" "$out" ;;
  *"/api/v4/personal_access_tokens/self")
    tok=""; [ "$cfg" = - ] && tok="$(sed -n 's/^header = "PRIVATE-TOKEN: \\(.*\\)"$/\\1/p')"
    echo "gitlab-api self token-given=$([ -n "$tok" ] && echo yes || echo no)" >> "${calls}"
    if [ "\${FAKE_GITLAB:-up}" = down ]; then printf 000; exit 7; fi
    if [ -n "$tok" ] && grep -qxF "$tok" "${fake}/valid-tokens"; then printf 200; else printf 401; fi ;;
  *) echo "unexpected curl url: $url" >&2; exit 99 ;;
esac`), 0o755);
  put(path.join(bin, 'sha256sum'), sh(`echo "\${FAKE_SHA:-${pinned}}  $1"`), 0o755);
  put(path.join(bin, 'openssl'), sh(`echo "openssl $*" >> "${calls}"
[ "$1 $2 $3" = "rand -hex 10" ] || { echo "unexpected openssl call: $*" >&2; exit 99; }
[ "\${FAKE_OPENSSL_EMPTY:-}" = 1 ] && exit 0
head -c 10 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo`), 0o755);
  put(path.join(bin, 'uname'), sh('[ "$1" = -m ] && echo "${FAKE_ARCH:-x86_64}" || /usr/bin/uname "$@"'), 0o755);
  put(path.join(bin, 'systemctl'), sh(`echo "systemctl $*" >> "${calls}"
case "$1" in
  is-enabled) shift; [ "$1" = --quiet ] && shift; [ -e "${fake}/enabled/$1" ] ;;
  is-active) shift; [ "$1" = --quiet ] && shift; [ -e "${fake}/active/$1" ] ;;
  enable) shift; [ "$1" = --now ] && shift; [ "\${FAKE_ENABLE_FAIL:-}" = "$1" ] && exit 1; touch "${fake}/enabled/$1" "${fake}/active/$1" ;;
esac`), 0o755);
  put(path.join(bin, 'gitlab-rails'), sh(`echo "gitlab-rails $*" >> "${calls}"
[ "\${FAKE_RAILS_FAIL:-}" = 1 ] && { echo "boom" >&2; exit 1; }
tok="$(printf '%s' "$2" | sed -n "s/.*set_token('\\([^']*\\)').*/\\1/p")"
echo "$tok" >> "${fake}/valid-tokens"
[ "\${FAKE_RAILS_ECHO:-}" = 1 ] && echo "ran: $2"
echo PAT_OK`), 0o755);
  const env = (extra = {}) => ({
    PATH: `${bin}:/usr/bin:/bin`, HOME: T, TMPDIR: T, OPS_PREFIX: root, OPS_GIT_URL: path.join(T, 'origin.git'), LC_ALL: 'C',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test', ...extra,
  });
  const run = (extra = {}) => spawnSync('bash', [path.join(ROOT, 'host/ops-install.sh')], { encoding: 'utf8', env: env(extra) });
  const callLog = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  const log = () => (existsSync(path.join(root, 'var/log/vitana-bootstrap.log')) ? readFileSync(path.join(root, 'var/log/vitana-bootstrap.log'), 'utf8') : '');
  return { T, root, fake, work, run, callLog, log, pinned, opsdLog: () => (existsSync(path.join(T, 'opsd.log')) ? readFileSync(path.join(T, 'opsd.log'), 'utf8').split('\n').filter(Boolean) : []), cleanup: () => rmSync(T, { recursive: true, force: true }), checkout: path.join(root, 'opt/vitana/platform') };
}
const withOps = (opts, fn) => { const h = opsHarness(opts); try { return fn(h); } finally { h.cleanup(); } };

test('ops-install.sh is a strict bash script, installs node only from a pinned version with a pinned SHA256, over https, and never pipes a download into a shell', ({ OPS }) => {
  const r = spawnSync('bash', ['-n', path.join(ROOT, 'host/ops-install.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(OPS, /^#!\/bin\/bash\n/);
  assert.match(OPS, /^set -uo pipefail$/m);
  assert.match(OPS, /^NODE_VERSION=20\.\d+\.\d+$/m, 'Node 20, a pinned version');
  assert.match(OPS, PINNED_SHA, 'a pinned 64-hex SHA256');
  // The value nodejs.org publishes for node-v20.20.2-linux-x64.tar.gz in https://nodejs.org/dist/v20.20.2/SHASUMS256.txt (read 2026-11-05).
  assert.equal(PINNED_SHA.exec(OPS)[1], '19e56f0825510207dd904f087fe52faa0a4eb6b2aab5f0ea7a33830d04888b8b', 'the pin is the published checksum of the pinned version');
  assert.match(OPS, /^NODE_VERSION=20\.20\.2$/m, 'and that checksum belongs to this version');
  assert.match(OPS, /^NODE_URL="https:\/\/nodejs\.org\/dist\/v\$\{NODE_VERSION\}\/\$\{NODE_TARBALL\}"$/m);
  assert.match(OPS, /^SHASUMS_URL="https:\/\/nodejs\.org\/dist\/v\$\{NODE_VERSION\}\/SHASUMS256\.txt"$/m, 'the published checksum list is consulted too');
  assert.match(OPS, /NODE_TARBALL="node-v\$\{NODE_VERSION\}-linux-x64\.tar\.gz"/);
  assert.equal(/\|\s*(ba)?sh\b/.test(OPS.replace(/^\s*#.*$/gm, '')), false, 'nothing downloaded is piped into a shell');
  assert.equal(/http:\/\/(?!127\.0\.0\.1)/.test(OPS), false, 'no plain-http download');
});

test('ops-install.sh handles secrets safely: the token goes to curl on stdin, git gets it through GIT_ASKPASS, the token file is 0600, the log is scrubbed', ({ OPS }) => {
  const code = OPS.replace(/^\s*#.*$/gm, '');
  assert.match(code, /curl -sS -m 20 -o \/dev\/null -w '%\{http_code\}' -K - /, 'curl reads its header from stdin');
  assert.equal(/-H\s+"?PRIVATE-TOKEN/.test(code), false, 'no token in a curl argument');
  assert.match(code, /GIT_ASKPASS="\$OPT\/git-askpass\.sh"/);
  assert.match(code, /GIT_TERMINAL_PROMPT=0/);
  assert.equal(/oauth2:\$|:\/\/[^"' ]*:[^"' ]*@/.test(code), false, 'no credentials in a URL');
  assert.match(code, /umask 077/);
  assert.match(code, /chmod 0600 "\$f\.new"/);
  assert.match(code, /sed "s\/\$tok\/\[redacted\]\/g" >> "\$LOG"/, 'what gitlab-rails prints is scrubbed of the token before it reaches the log');
  assert.match(code, /scopes: \['api'\]/);
  assert.match(code, /expires_at: 30\.days\.from_now/);
  assert.match(code, /User\.find_by_username\('root'\)/);
  assert.match(code, /openssl rand -hex 10/, 'a 20 character token, as gitlab-configure.sh makes');
  assert.equal(/\bset -x\b|\bset -[a-z]*x/.test(code), false, 'xtrace would write the token into the log');
  assert.equal(/echo[^\n]*\$tok|printf[^\n]*\$tok[^\n]*>>\s*"\$LOG"/.test(code.replace(/printf '%s\\n' "\$tok" > "\$f\.new"/, '')), false, 'the token is never echoed');
  assert.match(OPS, /\/var\/log\/vitana-bootstrap\.log/, 'the log of milestone 1');
  for (const never of [/git\s+reset/, /git\s+rebase/, /--force/, /git\s+clean/, /--hard/]) assert.equal(never.test(code), false, `${never}`);
  assert.match(code, /GIT_URL="\$\{OPS_GIT_URL:-http:\/\/127\.0\.0\.1\/vitana\/vitana-platform\.git\}"/, 'the real default: the local project, no credentials');
});

test('ops-install.sh first run: node, the git helper, the checkout, every unit by glob, the admin token, ops.d in order, and every timer', () => withOps({}, (h) => {
  const r = h.run();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}\n--- log\n${h.log()}`);
  // node, and the links the units of the other lanes rely on (/usr/bin/node)
  assert.ok(existsSync(path.join(h.root, 'opt/node/node-v20.20.2-linux-x64/bin/node')));
  assert.equal(readlinkSync(path.join(h.root, 'usr/bin/node')), '/opt/node/node-v20.20.2-linux-x64/bin/node');
  for (const b of ['node', 'npm', 'npx']) assert.equal(readlinkSync(path.join(h.root, 'usr/local/bin', b)), `/opt/node/node-v20.20.2-linux-x64/bin/${b}`);
  // the git helper
  const helper = path.join(h.root, 'opt/vitana/git-askpass.sh');
  assert.equal(mode(helper), '700');
  assert.equal(readFileSync(helper, 'utf8'), '#!/bin/sh\ncase "$1" in Username*) echo oauth2 ;; *) cat /etc/vitana/mirror-token ;; esac\n');
  // the checkout: main of the project, no credential anywhere in it
  assert.equal(git(h.checkout, 'rev-parse', 'HEAD'), git(path.join(h.T, 'origin.git'), 'rev-parse', 'main'));
  assert.equal(git(h.checkout, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(h.checkout, 'remote', 'get-url', 'origin'), path.join(h.T, 'origin.git'));
  assert.equal(spawnSync('git', ['-C', h.checkout, 'config', '--local', '--list'], { encoding: 'utf8' }).stdout.split('\n').some((l) => /credential|extraheader|MIRROR/i.test(l)), false);
  // every unit of host/units by glob, byte for byte, and nothing that is not a unit
  const src = path.join(h.checkout, 'infra/gitlab-engineering/host/units');
  const units = readdirSync(src).filter((f) => /\.(service|timer)$/.test(f));
  assert.equal(units.length, 8, 'the glob finds the units of all four lanes');
  for (const n of units) assert.equal(readFileSync(path.join(h.root, 'etc/systemd/system', n), 'utf8'), readFileSync(path.join(src, n), 'utf8'), n);
  assert.equal(existsSync(path.join(h.root, 'etc/systemd/system/README.txt')), false);
  const calls = h.callLog().filter((c) => c.startsWith('systemctl '));
  assert.equal(calls.filter((c) => c === 'systemctl daemon-reload').length, 1);
  assert.ok(calls.indexOf('systemctl daemon-reload') < calls.findIndex((c) => c.startsWith('systemctl enable')), 'reloaded before the timers are enabled');
  for (const t of ['vitana-platform-sync', 'vitana-settings', 'vitana-land', 'vitana-ci-metrics']) assert.ok(calls.includes(`systemctl enable --now ${t}.timer`), `${t}.timer is enabled and started`);
  assert.equal(calls.filter((c) => c.startsWith('systemctl enable')).length, 4, 'only the timers');
  // the admin token
  const tokFile = path.join(h.root, 'etc/vitana/settings-admin-token');
  assert.equal(mode(tokFile), '600');
  const tok = readFileSync(tokFile, 'utf8').trim();
  assert.match(tok, /^[0-9a-f]{20}$/, 'twenty characters, as GitLab needs for a token that is set by hand');
  const rails = h.callLog().filter((c) => c.startsWith('gitlab-rails '));
  assert.equal(rails.length, 1);
  assert.match(rails[0], /^gitlab-rails runner t = User\.find_by_username\('root'\)\.personal_access_tokens\.create\(scopes: \['api'\], name: 'vitana-settings-admin', expires_at: 30\.days\.from_now\); t\.set_token\('[0-9a-f]{20}'\); t\.save!; puts 'PAT_OK'$/);
  assert.ok(h.callLog().some((c) => c === 'gitlab-api self token-given=yes'), 'the new token was tried against GitLab');
  // ops.d, in order
  assert.deepEqual(h.opsdLog(), ['10-first.sh', '30-last.sh']);
  // the log, and no token anywhere a person or a log file can read it
  assert.match(h.log(), /ops-install: == start/);
  for (const [where, text] of [['stdout', r.stdout], ['stderr', r.stderr], ['log', h.log()]]) {
    assert.equal(text.includes(tok), false, `the admin token is not in the ${where}`);
    assert.equal(text.includes('MIRROR-TOKEN-VALUE'), false, `the mirror token is not in the ${where}`);
  }
  assert.match(r.stdout, /== done: \d+ change\(s\)/);
}));

test('ops-install.sh second run: nothing changes and it says so (no download, no clone, no reload, no new token, no timer touched)', () => withOps({}, (h) => {
  assert.equal(h.run().status, 0);
  const tokFile = path.join(h.root, 'etc/vitana/settings-admin-token');
  const before = { tok: readFileSync(tokFile, 'utf8'), calls: h.callLog().length, unit: statSync(path.join(h.root, 'etc/systemd/system/vitana-settings.service')).mtimeMs, head: git(h.checkout, 'rev-parse', 'HEAD') };
  // make the unit files clearly old, so that a rewrite would show
  for (const f of readdirSync(path.join(h.root, 'etc/systemd/system'))) utimesSync(path.join(h.root, 'etc/systemd/system', f), 1_000_000, 1_000_000);
  const r = h.run();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /== done: nothing changed/);
  const second = h.callLog().slice(before.calls);
  assert.deepEqual(second.filter((c) => /^curl .*(tar\.gz|SHASUMS)/.test(c)), [], 'node is not downloaded again');
  assert.deepEqual(second.filter((c) => c.startsWith('gitlab-rails')), [], 'no new token');
  assert.deepEqual(second.filter((c) => /^systemctl (daemon-reload|enable|restart)/.test(c)), [], 'no reload, no enable, no restart');
  assert.equal(readFileSync(tokFile, 'utf8'), before.tok);
  assert.equal(git(h.checkout, 'rev-parse', 'HEAD'), before.head);
  for (const f of readdirSync(path.join(h.root, 'etc/systemd/system'))) assert.equal(statSync(path.join(h.root, 'etc/systemd/system', f)).mtimeMs, 1_000_000_000, `${f} is not rewritten`);
  for (const line of ['node v20.20.2: already installed', 'git helper: in place', 'checkout: up to date', 'units: 8 already installed', 'admin token: valid, kept']) assert.ok(r.stdout.includes(line), `says: ${line}`);
  assert.deepEqual(h.opsdLog(), ['10-first.sh', '30-last.sh', '10-first.sh', '30-last.sh'], 'ops.d scripts run every time: they are idempotent by their own contract');
}));

test('ops-install.sh: a refused admin token is replaced; an unreachable GitLab is not mistaken for a refused token', () => withOps({}, (h) => {
  assert.equal(h.run().status, 0);
  const tokFile = path.join(h.root, 'etc/vitana/settings-admin-token');
  const old = readFileSync(tokFile, 'utf8');
  writeFileSync(path.join(h.fake, 'valid-tokens'), ''); // GitLab forgets the token (expired, revoked)
  let r = h.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /admin token: made/);
  assert.notEqual(readFileSync(tokFile, 'utf8'), old, 'a new token');
  assert.equal(mode(tokFile), '600');
  // GitLab is down: HTTP 000 is not a 401, so the good token is kept and the step fails loudly
  const kept = readFileSync(tokFile, 'utf8');
  r = h.run({ FAKE_GITLAB: 'down' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /GitLab answered HTTP 000 when the token was tried, so no new token is made now/);
  assert.equal(readFileSync(tokFile, 'utf8'), kept);
  assert.equal(h.callLog().filter((c) => c.startsWith('gitlab-rails')).length, 2, 'rails ran for the first token and the replacement, not for the outage');
}));

test('ops-install.sh: what gitlab-rails prints is scrubbed of the token before it is logged, and a failing gitlab-rails leaves no token file', () => withOps({}, (h) => {
  let r = h.run({ FAKE_RAILS_ECHO: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const tok = readFileSync(path.join(h.root, 'etc/vitana/settings-admin-token'), 'utf8').trim();
  assert.ok(h.log().includes('ran: t = User.find_by_username'), 'the stand-in printed the code it was given');
  assert.equal(h.log().includes(tok), false, 'but the token in it was replaced');
  assert.ok(h.log().includes('set_token(\'[redacted]\')'));
  assert.equal(r.stdout.includes(tok) || r.stderr.includes(tok), false);
  rmSync(path.join(h.root, 'etc/vitana/settings-admin-token'));
  r = h.run({ FAKE_RAILS_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /gitlab-rails could not create it/);
  assert.equal(existsSync(path.join(h.root, 'etc/vitana/settings-admin-token')), false);
  assert.equal(existsSync(path.join(h.root, 'etc/vitana/settings-admin-token.new')), false);
  // a machine without openssl would give an empty token: refused before gitlab-rails is asked to set it
  const railsCalls = h.callLog().filter((c) => c.startsWith('gitlab-rails ')).length;
  r = h.run({ FAKE_OPENSSL_EMPTY: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /openssl did not give 20 hex characters \(is openssl installed\?\)/);
  assert.equal(h.callLog().filter((c) => c.startsWith('gitlab-rails ')).length, railsCalls, 'gitlab-rails was not called with an empty token');
  assert.equal(existsSync(path.join(h.root, 'etc/vitana/settings-admin-token')), false);
}));

test('ops-install.sh: a failing ops.d script is logged and the others still run; the exit code says so at the end', () => withOps({ opsd: ['10-a.sh', '20-bad.sh', '30-c.sh'], failing: ['20-bad.sh'] }, (h) => {
  const r = h.run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(h.opsdLog(), ['10-a.sh', '20-bad.sh', '30-c.sh'], 'the script after the failing one still ran');
  assert.match(r.stdout, /ops\.d\/20-bad\.sh failed with exit 3/);
  assert.match(r.stdout, /ops\.d\/10-a\.sh: ok/);
  assert.match(r.stdout, /ops\.d\/30-c\.sh: ok/);
  assert.match(r.stdout, /== FAILED: ops\.d\/20-bad\.sh/);
  assert.match(h.log(), /this one fails/, 'the failing script\'s output is in the log');
  assert.ok(h.callLog().includes('systemctl enable --now vitana-settings.timer'), 'and the timers were still enabled');
}));

test('ops-install.sh: a tarball with the wrong SHA256, or one that nodejs.org does not list, installs nothing; the steps that do not need node still run', () => {
  withOps({}, (h) => {
    const r = h.run({ FAKE_SHA: 'f'.repeat(64) });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /node: the SHA256 of the tarball is f{64}, not the pinned/);
    assert.equal(existsSync(path.join(h.root, 'opt/node/node-v20.20.2-linux-x64')), false);
    assert.equal(hasLink(path.join(h.root, 'usr/bin/node')), false, 'no link to a node that is not there');
    assert.ok(existsSync(path.join(h.checkout, '.git')), 'the checkout was still made');
    assert.ok(existsSync(path.join(h.root, 'etc/systemd/system/vitana-settings.timer')), 'and the units');
    assert.equal(readdirSync(h.T).some((f) => f.startsWith('ops-node.')), false, 'the temporary directory is gone');
  });
  withOps({}, (h) => {
    put(path.join(h.fake, 'shasums'), `${'a'.repeat(64)}  node-v20.20.2-linux-x64.tar.gz\n`);
    const r = h.run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /nodejs\.org publishes another checksum/);
    assert.equal(existsSync(path.join(h.root, 'opt/node/node-v20.20.2-linux-x64')), false);
  });
  withOps({}, (h) => {
    const r = h.run({ FAKE_SHASUMS_DOWN: '1' });
    assert.equal(r.status, 0, 'the pinned checksum alone was verified and the list could not be fetched: not a failure');
    assert.ok(existsSync(path.join(h.root, 'opt/node/node-v20.20.2-linux-x64/bin/node')));
    assert.match(h.log(), /SHASUMS256\.txt is not reachable; the pinned checksum was verified/);
  });
  withOps({}, (h) => {
    assert.equal(h.run({ FAKE_ARCH: 'aarch64' }).status, 1);
    assert.equal(h.run({ FAKE_CURL_FAIL: 'node' }).status, 1);
    assert.equal(hasLink(path.join(h.root, 'usr/bin/node')), false);
  });
});

test('ops-install.sh: a checkout with no host/units says what is missing; no mirror token, or a project the mirror has not filled, stops the steps that need the checkout and nothing else', () => {
  withOps({ units: false, opsd: [] }, (h) => {
    const r = h.run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /the checkout has no infra\/gitlab-engineering\/host\/units yet.*wait 5 minutes for the mirror/);
    assert.ok(hasLink(path.join(h.root, 'usr/bin/node')), 'node was still installed');
    assert.ok(existsSync(path.join(h.root, 'etc/vitana/settings-admin-token')), 'and the admin token made');
  });
  withOps({}, (h) => {
    rmSync(path.join(h.root, 'etc/vitana/mirror-token'));
    const r = h.run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /mirror-token is missing/);
    assert.match(r.stdout, /ops\.d and the timers wait for a good checkout/);
    assert.equal(existsSync(path.join(h.checkout, '.git')), false);
    assert.deepEqual(h.opsdLog(), []);
    assert.equal(h.callLog().some((c) => c.startsWith('systemctl enable')), false);
  });
  withOps({}, (h) => {
    const r = h.run({ OPS_GIT_URL: path.join(h.T, 'no-such-repository.git') });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /cannot clone branch main of .*If the mirror has not copied vitana-platform into GitLab yet, store the GitHub token \(setup\.sh token\)/);
  });
});

test('ops-install.sh: a later run fast-forwards the checkout; a checkout that cannot fast-forward is left as it was and reported', () => withOps({}, (h) => {
  assert.equal(h.run().status, 0);
  // origin moves on
  put(path.join(h.work, 'NEW.txt'), 'new\n');
  git(h.work, 'add', '-A');
  git(h.work, 'commit', '-q', '-m', 'second');
  git(h.work, 'push', '-q', path.join(h.T, 'origin.git'), 'main');
  const want = git(h.work, 'rev-parse', 'HEAD');
  let r = h.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /checkout: fast-forwarded to /);
  assert.match(r.stdout, /== done: 1 change\(s\)/);
  assert.equal(git(h.checkout, 'rev-parse', 'HEAD'), want);
  // someone commits in the checkout, and origin moves again: no fast-forward is possible
  git(h.checkout, 'commit', '-q', '--allow-empty', '-m', 'local work');
  const local = git(h.checkout, 'rev-parse', 'HEAD');
  put(path.join(h.work, 'NEWER.txt'), 'newer\n');
  git(h.work, 'add', '-A');
  git(h.work, 'commit', '-q', '-m', 'third');
  git(h.work, 'push', '-q', path.join(h.T, 'origin.git'), 'main');
  r = h.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /cannot fast-forward \/opt\/vitana\/platform to main.*Nothing was changed there/);
  assert.equal(git(h.checkout, 'rev-parse', 'HEAD'), local, 'no reset, no rebase, no merge commit');
  // a credential in the origin URL is refused
  git(h.checkout, 'reset', '-q', '--hard', want);
  git(h.checkout, 'config', 'credential.helper', 'store');
  r = h.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /holds a credential setting/);
}));

test('ops-install.sh: a changed timer file is picked up (the running timer is restarted), and a unit file the checkout changed is replaced', () => withOps({}, (h) => {
  assert.equal(h.run().status, 0);
  const rel = 'infra/gitlab-engineering/host/units/vitana-settings.timer';
  writeFileSync(path.join(h.work, rel), `${readFileSync(path.join(h.work, rel), 'utf8')}# changed\n`);
  git(h.work, 'add', '-A');
  git(h.work, 'commit', '-q', '-m', 'timer changed');
  git(h.work, 'push', '-q', path.join(h.T, 'origin.git'), 'main');
  const before = h.callLog().length;
  const r = h.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = h.callLog().slice(before).filter((c) => c.startsWith('systemctl ') && !/^systemctl is-(enabled|active) /.test(c));
  assert.deepEqual(calls, ['systemctl daemon-reload', 'systemctl restart vitana-settings.timer']);
  assert.match(readFileSync(path.join(h.root, 'etc/systemd/system/vitana-settings.timer'), 'utf8'), /# changed/);
}));

test('ops-install.sh stops and says why when the environment file of milestone 1 is missing', () => {
  withOps({}, (h) => {
    rmSync(path.join(h.root, 'etc/vitana/env'));
    const r = h.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /milestone 1 did not finish on this machine/);
  });
});

// ============================================================================================================================
// 2e. m2.sh, run against a stand-in for the AWS CLI (task S4)
// ============================================================================================================================
const TIMERS = ['vitana-platform-sync', 'vitana-settings', 'vitana-land', 'vitana-ci-metrics'];
const ALARMS = ['vitana-eng-oldest-pending-job', 'vitana-eng-fleet-at-maximum', 'vitana-eng-gitlab-host-status', 'vitana-eng-gitlab-disk-used', 'vitana-eng-gitlab-lb-unhealthy-target', 'vitana-eng-backup-age', 'vitana-eng-merge-bot-tick', 'vitana-eng-settings-sync-tick'];
const GOOD_STATUS_OUT = [...TIMERS.map((t) => `timer ${t}: enabled / active`), 'settings check exit: 0 (0 = no drift, 3 = drift, anything else = the check could not run)',
  'last good settings run: 2026-11-05T15:20:03.123Z', 'last settings service result: success'].join('\n');
// assembled at run time, so that no file of the repository carries a token-shaped literal (the secret scan of the evidence reads files, not programs)
const FLEET_SECRET_VALUE = ['glrt', 'SUPERSECRETFLEETVALUE0123456789'].join('-');
const AWS_KEYS = [['AKIA', 'FAKEACCESSKEY0000'].join(''), 'FAKESECRETACCESSKEYVALUE', 'FAKESESSIONTOKENVALUE'];

function m2Harness() {
  const T = tmp('m2-');
  const bin = path.join(T, 'bin');
  const fake = path.join(T, 'fake');
  mkdirSync(bin, { recursive: true });
  mkdirSync(fake, { recursive: true });
  const w = (name, text) => writeFileSync(path.join(fake, name), text);
  w('state', ''); w('status', 'Success'); w('out', GOOD_STATUS_OUT); w('err', '');
  w('tfstate.json', JSON.stringify({ outputs: { alerts_topic_arn: { value: 'arn:aws:sns:eu-central-1:111122223333:vitana-eng-alerts' }, alarm_names: { value: ALARMS }, alerts_email: { value: 'owner@example.test' } } }));
  w('subs.txt', 'email\towner@example.test\tarn:aws:sns:eu-central-1:111122223333:vitana-eng-alerts:1111-2222\n');
  w('alarms.txt', `${ALARMS.map((a) => `${a}\tOK`).join('\n')}\n`);
  w('secret.txt', `${FLEET_SECRET_VALUE}\n`);
  const state = path.join(T, 'state.env');
  writeFileSync(state, 'ACCOUNT_ID=111122223333\nGITLAB_ID=i-0abc123def4567890\n');
  put(path.join(bin, 'sleep'), sh('exit 0'), 0o755);
  put(path.join(bin, 'aws'), sh(`F="${fake}"
echo "aws $*" >> "$F/aws.log"
q=""; prev=""
for a in "$@"; do [ "$prev" = --query ] && q="$a"; [ "$prev" = --parameters ] && printf '%s' "$a" > "$F/params-$(wc -l < "$F/sent" 2>/dev/null || echo 0).json"; prev="$a"; done
case "$1 $2" in
  "sts get-caller-identity") echo 472838866351 ;;
  "organizations list-accounts") echo 111122223333 ;;
  "sts assume-role") echo '{"AccessKeyId":"${AWS_KEYS[0]}","SecretAccessKey":"${AWS_KEYS[1]}","SessionToken":"${AWS_KEYS[2]}"}' ;;
  "ec2 describe-instances") echo i-0abc123def4567890 ;;
  "ssm send-command") echo x >> "$F/sent"; echo "cmd-$(wc -l < "$F/sent" | tr -d ' ')" ;;
  "ssm get-command-invocation") case "$q" in Status) cat "$F/status" ;; StandardOutputContent) cat "$F/out" ;; StandardErrorContent) cat "$F/err" ;; esac ;;
  "s3 cp") [ -s "$F/tfstate.json" ] && cat "$F/tfstate.json" || exit 1 ;;
  "sns list-subscriptions-by-topic") cat "$F/subs.txt" ;;
  "cloudwatch describe-alarms") cat "$F/alarms.txt" ;;
  "secretsmanager get-secret-value") cat "$F/secret.txt" ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac`), 0o755);
  const run = (args, extra = {}) => spawnSync('bash', [path.join(ROOT, 'm2.sh'), ...args], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: T, M2_STATE: state, ...extra },
  });
  const sent = () => (existsSync(path.join(fake, 'sent')) ? readFileSync(path.join(fake, 'sent'), 'utf8').split('\n').filter(Boolean).length : 0);
  const params = (n = 0) => JSON.parse(readFileSync(path.join(fake, `params-${n}.json`), 'utf8'));
  const script = (n = 0) => params(n).commands[0];
  return { T, bin, fake, w, run, sent, params, script, state, awsLog: () => readFileSync(path.join(fake, 'aws.log'), 'utf8'), cleanup: () => rmSync(T, { recursive: true, force: true }) };
}
const withM2 = (fn) => { const h = m2Harness(); try { return fn(h); } finally { h.cleanup(); } };
const noSecrets = (r, label = '') => {
  for (const s of [FLEET_SECRET_VALUE, ...AWS_KEYS]) { assert.equal(r.stdout.includes(s), false, `${label} stdout holds no secret`); assert.equal(r.stderr.includes(s), false, `${label} stderr holds no secret`); }
};

test('m2.sh is a strict bash script with the four commands, no xtrace, and no command that prints a secret', ({ M2 }) => {
  const r = spawnSync('bash', ['-n', path.join(ROOT, 'm2.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(M2, /^#!\/bin\/bash\n/);
  assert.match(M2, /^set -uo pipefail$/m);
  const code = M2.replace(/^\s*#.*$/gm, '');
  assert.equal(/\bset -x\b|\bset -[a-z]*x/.test(code), false);
  for (const c of ['install', 'status', 'settings', 'rehearse']) assert.match(M2, new RegExp(`cmd_${c}\\(\\)`), c);
  assert.match(M2, /MGMT=472838866351/);
  assert.match(code, /OrganizationAccountAccessRole/, 'the same way in as setup.sh');
  assert.match(code, /AWS-RunShellScript/);
  // the fleet token is only compared, never shown: no echo, printf or log of $v after it is read
  const afterRead = code.slice(code.indexOf('v="$(aws secretsmanager get-secret-value'));
  assert.equal(/(echo|printf)[^\n]*\$\{?v\b/.test(afterRead.slice(0, afterRead.indexOf('v=""'))), false, 'the secret value is not printed');
  assert.match(afterRead, /case "\$v" in\n\s*glrt-\*\)/);
  const secretLine = code.split('\n').find((l) => l.includes('get-secret-value')) ?? '';
  assert.equal(secretLine.replace('2>/dev/null', '').includes('>'), false, 'the secret value goes into a variable, not into a file');
});

test('m2.sh: no command, an unknown command or --help print the usage; an unknown command is a usage mistake (exit 2) and calls nothing', () => withM2((h) => {
  for (const args of [[], ['nonsense'], ['install', 'extra'].slice(0, 0)]) {
    const r = h.run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /usage: bash m2\.sh <command>/);
    for (const c of ['install', 'status', 'settings', 'rehearse']) assert.match(r.stderr, new RegExp(c));
  }
  const help = h.run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: bash m2\.sh/);
  assert.equal(existsSync(path.join(h.fake, 'aws.log')), false, 'no AWS call for a usage message');
}));

test('m2.sh install: sends host/ops-install.sh itself (compressed, byte for byte) to the GitLab machine and runs it with bash; prints the result', () => withM2((h) => {
  h.w('out', '2026-11-05T15:00:00Z ops-install: == done: 9 change(s)');
  const r = h.run(['install']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(h.sent(), 1);
  const p = h.params();
  assert.equal(Number(p.executionTimeout[0]) >= 600, true, 'an execution timeout is set');
  const cmd = p.commands[0];
  assert.match(cmd, /^mkdir -p \/opt\/vitana && echo [A-Za-z0-9+/=]+ \| base64 -d \| gunzip > \/opt\/vitana\/ops-install\.sh && bash \/opt\/vitana\/ops-install\.sh$/);
  const b64 = /echo ([A-Za-z0-9+/=]+) \|/.exec(cmd)[1];
  assert.equal(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'), read('host/ops-install.sh'), 'the file that runs on the machine is the file in git');
  assert.ok(cmd.length < 40000, `a command Systems Manager accepts: ${cmd.length} characters`);
  assert.match(r.stdout, /ops-install: == done: 9 change\(s\)/);
  assert.match(r.stdout, /install: done/);
  assert.match(h.awsLog(), /--instance-ids i-0abc123def4567890 --document-name AWS-RunShellScript/);
  assert.match(h.awsLog(), /sts assume-role --role-arn arn:aws:iam::111122223333:role\/OrganizationAccountAccessRole/);
  noSecrets(r, 'install');
  // a failing run on the machine is a failing m2.sh, with the way forward
  h.w('status', 'Failed'); h.w('out', 'ops-install: !! node: the SHA256 of the tarball is x'); h.w('err', 'boom');
  const f = h.run(['install']);
  assert.equal(f.status, 1);
  assert.match(f.stdout, /!! node: the SHA256/);
  assert.match(f.stderr, /install: FAILED \(Systems Manager status Failed\)/);
  assert.match(f.stderr, /safe to run  bash m2\.sh install  again/);
}));

test('m2.sh install: Systems Manager that refuses the command (the machine has not registered with it yet) is said plainly', () => withM2((h) => {
  h.w('status', 'Success');
  const r = h.run(['install'], { PATH: `${h.bin}:/usr/bin:/bin` });
  assert.equal(r.status, 0);
  // send-command refused
  put(path.join(h.bin, 'aws'), sh(`case "$1 $2" in
  "sts assume-role") echo '{"AccessKeyId":"a","SecretAccessKey":"b","SessionToken":"c"}' ;;
  "ssm send-command") exit 254 ;;
  *) echo i-0abc ;;
esac`), 0o755);
  const f = h.run(['install']);
  assert.equal(f.status, 1);
  assert.match(f.stderr + f.stdout, /Systems Manager did not accept the command/);
}));

test('m2.sh status, all well: the four timers, no drift, the last good run, the mail confirmed, every alarm, the fleet token; exit 0; no secret printed', () => withM2((h) => {
  const r = h.run(['status']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const t of TIMERS) assert.match(r.stdout, new RegExp(`timer ${t}: enabled / active`));
  assert.match(r.stdout, /settings check exit: 0/);
  assert.match(r.stdout, /last good settings run: 2026-11-05T15:20:03\.123Z/);
  assert.match(r.stdout, /alert subscription email owner@example\.test: confirmed/);
  for (const a of ALARMS) assert.match(r.stdout, new RegExp(`alarm ${a}: exists \\(OK\\)`));
  assert.match(r.stdout, /fleet runner token: the secret holds a glrt- value/);
  assert.match(r.stdout, /status: all good/);
  noSecrets(r, 'status');
  // read only: no write call of any kind
  const writes = h.awsLog().split('\n').filter((l) => /\b(put-|create-|delete-|update-|start-|run-|terminate|send-command)\b/.test(l) && !/send-command/.test(l));
  assert.deepEqual(writes, [], 'the only thing sent is the read-only status script');
  // the Terraform outputs come from the state in S3, not from a Terraform run
  assert.match(h.awsLog(), /s3 cp s3:\/\/vitana-engineering-tfstate-111122223333\/gitlab-engineering\/terraform\.tfstate -/);
  assert.match(h.awsLog(), /sns list-subscriptions-by-topic --topic-arn arn:aws:sns:eu-central-1:111122223333:vitana-eng-alerts/);
  assert.match(h.awsLog(), /cloudwatch describe-alarms --alarm-names vitana-eng-oldest-pending-job .* vitana-eng-settings-sync-tick/);
}));

test('m2.sh status: an unconfirmed alert subscription is shown loudly and makes the status fail', () => withM2((h) => {
  h.w('subs.txt', 'email\towner@example.test\tPendingConfirmation\n');
  const r = h.run(['status']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /!! ALERT MAIL NOT CONFIRMED: owner@example\.test has not clicked the confirmation link/);
  assert.match(r.stdout, /No alarm reaches anyone until it does/);
  assert.match(r.stdout, /status: 1 thing\(s\) need attention/);
}));

test('m2.sh status: a missing alarm, an empty fleet token, drift, a stopped timer and no good run are each reported, and each makes the status fail', () => withM2((h) => {
  h.w('alarms.txt', `${ALARMS.filter((a) => a !== 'vitana-eng-backup-age').map((a) => `${a}\tOK`).join('\n')}\n`);
  let r = h.run(['status']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /!! alarm vitana-eng-backup-age does not exist/);
  assert.equal((r.stdout.match(/^!! /gm) ?? []).length, 1, 'exactly the one problem');
  h.w('alarms.txt', `${ALARMS.map((a) => `${a}\tOK`).join('\n')}\n`);
  h.w('secret.txt', 'None\n');
  r = h.run(['status']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /!! fleet runner token: the secret is empty/);
  h.w('secret.txt', 'not-a-runner-token-VALUE-123\n');
  r = h.run(['status']);
  assert.match(r.stdout, /!! fleet runner token: the secret holds a value that is not a glrt- runner token/);
  assert.equal(r.stdout.includes('not-a-runner-token-VALUE-123'), false, 'even a wrong value is not printed');
  h.w('secret.txt', `${FLEET_SECRET_VALUE}\n`);
  h.w('out', GOOD_STATUS_OUT.replace('settings check exit: 0', 'settings check exit: 3').replace('timer vitana-land: enabled / active', 'timer vitana-land: disabled / inactive').replace(/last good settings run: .*/, 'last good settings run: none in the journal yet'));
  r = h.run(['status']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /!! the settings check did not end with exit 0 \(3 means GitLab differs/);
  assert.match(r.stdout, /!! the timer vitana-land is not enabled and active/);
  assert.match(r.stdout, /!! the settings sync has no good run in the journal yet/);
  assert.match(r.stdout, /status: 3 thing\(s\) need attention/);
  // each of the four timers is checked on its own
  for (const t of TIMERS) {
    h.w('out', GOOD_STATUS_OUT.replace(`timer ${t}: enabled / active`, `timer ${t}: enabled / failed`));
    r = h.run(['status']);
    assert.equal(r.status, 1, `${t} not active`);
    assert.match(r.stdout, new RegExp(`!! the timer ${t} is not enabled and active`));
    assert.equal((r.stdout.match(/^!! /gm) ?? []).length, 1, `${t}: exactly one problem`);
  }
  // Terraform state without the monitoring outputs, and a machine that does not answer
  h.w('out', GOOD_STATUS_OUT);
  h.w('tfstate.json', '{"outputs":{}}');
  r = h.run(['status']);
  assert.match(r.stdout, /!! the Terraform state has no alerts_topic_arn or alarm_names output yet: run  bash setup\.sh/);
  h.w('status', 'Failed'); h.w('out', '');
  r = h.run(['status']);
  assert.match(r.stdout, /!! the GitLab machine did not answer Systems Manager \(status Failed\)/);
  assert.equal(r.status, 1);
}));

test('m2.sh status: the script it sends runs for real on stand-ins: timers, the drift lines of `check` (exit 3), and the date of the last good tick from the journal', () => withM2((h) => {
  const r = h.run(['status'], { M2_CHECKOUT: path.join(h.T, 'checkout'), M2_HOST_ENV: path.join(h.T, 'env') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const script = h.script(0);
  assert.match(script, /^CK=\S+\nENVF=\S+\n/);
  // a fake machine
  const ck = path.join(h.T, 'checkout');
  put(path.join(ck, 'scripts/eng/gitlab-settings.mjs'), '// stand-in\n');
  put(path.join(h.T, 'env'), 'REGION=eu-central-1\nDOMAIN=gitlab.example.test\n');
  const hbin = path.join(h.T, 'hbin');
  put(path.join(hbin, 'systemctl'), sh(`case "$1" in
  is-enabled) [ "$2" = vitana-land.timer ] && { echo disabled; exit 1; } || echo enabled ;;
  is-active) [ "$2" = vitana-land.timer ] && { echo inactive; exit 3; } || echo active ;;
  show) echo failed ;;
esac`), 0o755);
  put(path.join(hbin, 'journalctl'), sh(`cat <<'J'
{"ts":"2026-11-05T14:10:03.000Z","event":"start","command":"apply"}
{"ts":"2026-11-05T14:10:09.000Z","event":"done","exit":0,"applied":0,"failed":0,"skipped":0}
{"ts":"2026-11-05T14:20:03.000Z","event":"start","command":"apply"}
{"ts":"2026-11-05T14:20:07.000Z","event":"done","exit":1,"applied":0,"failed":1,"skipped":0}
J`), 0o755);
  put(path.join(hbin, 'node'), sh(`[ "$1" = scripts/eng/gitlab-settings.mjs ] && [ "$2" = check ] || { echo "unexpected node call: $*" >&2; exit 99; }
[ "$REGION" = eu-central-1 ] || { echo "REGION is not loaded" >&2; exit 98; }
echo '{"ts":"x","event":"start"}'
echo "drift: accounts: create service account agent-kiro-new"
echo "warning: central CI: something to look at"
echo "settings check: 1 drift(s), 1 warning(s)"
exit 3`), 0o755);
  const out = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { PATH: `${hbin}:/usr/bin:/bin` } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /timer vitana-settings: enabled \/ active/);
  assert.match(out.stdout, /timer vitana-land: disabled \/ inactive/);
  assert.match(out.stdout, /^drift: accounts: create service account agent-kiro-new$/m);
  assert.match(out.stdout, /^settings check: 1 drift\(s\), 1 warning\(s\)$/m);
  assert.equal(out.stdout.includes('{"ts"'), false, 'JSON log lines are not part of the answer');
  assert.match(out.stdout, /^settings check exit: 3 \(0 = no drift, 3 = drift/m);
  assert.match(out.stdout, /^last good settings run: 2026-11-05T14:10:09\.000Z$/m, 'the last done line with exit 0, not the later failed one');
  // a machine without the checkout
  const bare = spawnSync('sh', ['-c', script.replace(/^CK=\S+/, `CK=${path.join(h.T, 'nowhere')}`)], { encoding: 'utf8', env: { PATH: `${hbin}:/usr/bin:/bin` } });
  assert.match(bare.stdout, /settings check: not run, .* has no scripts\/eng\/gitlab-settings\.mjs \(run m2\.sh install/);
}));

test('m2.sh settings: pulls the newest main first, then runs the sync now, and prints this run\'s log; the script it sends runs for real on stand-ins', () => withM2((h) => {
  h.w('out', '{"ts":"t","event":"done","exit":0}\nsettings sync exit: 0');
  const r = h.run(['settings']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /settings: the sync finished with exit 0/);
  const script = h.script(0);
  const iSync = script.indexOf('systemctl start vitana-platform-sync.service');
  const iSettings = script.indexOf('systemctl start vitana-settings.service');
  assert.ok(iSync > -1 && iSettings > -1 && iSync < iSettings, 'the checkout first, then the sync');
  // run it on stand-ins
  const hbin = path.join(h.T, 'hbin');
  const calls = path.join(h.T, 'hcalls.log');
  put(path.join(hbin, 'systemctl'), sh(`echo "systemctl $*" >> "${calls}"; [ "\${FAKE_SYNC_FAIL:-}" = 1 ] && [ "$2" = vitana-settings.service ] && exit 1; exit 0`), 0o755);
  put(path.join(hbin, 'journalctl'), sh(`echo "journalctl $*" >> "${calls}"; echo '{"ts":"t","event":"start"}'; echo '{"ts":"t","event":"done","exit":0}'`), 0o755);
  const ok = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { PATH: `${hbin}:/usr/bin:/bin` } });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /checkout sync exit: 0/);
  assert.match(ok.stdout, /"event":"done","exit":0/);
  assert.match(ok.stdout, /settings sync exit: 0/);
  assert.match(readFileSync(calls, 'utf8'), /journalctl -u vitana-settings\.service --since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d -o cat --no-pager/);
  assert.deepEqual(readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('systemctl ')), ['systemctl start vitana-platform-sync.service', 'systemctl start vitana-settings.service'], 'on the machine: the checkout is pulled, then the sync runs, in that order');
  const bad = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { PATH: `${hbin}:/usr/bin:/bin`, FAKE_SYNC_FAIL: '1' } });
  assert.equal(bad.status, 1, 'the exit code of the sync is the exit code of the script');
  assert.match(bad.stdout, /settings sync exit: 1/);
  // and m2.sh turns a failed run into a failed command
  h.w('status', 'Failed');
  const f = h.run(['settings']);
  assert.equal(f.status, 1);
  assert.match(f.stderr, /settings: the sync did NOT finish well/);
}));

test('m2.sh rehearse: runs scripts/eng/rehearse.mjs --project rehearsal --agents 12 on the machine; when the file is absent it says so plainly and exits 1; nothing is run then', () => withM2((h) => {
  h.w('out', 'REPORT: peak fleet 24\nrehearse exit: 0');
  let r = h.run(['rehearse']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /command id: cmd-1/);
  assert.match(r.stdout, /REPORT: peak fleet 24/);
  assert.equal(Number(h.params().executionTimeout[0]) >= 7200, true, 'a long run is allowed');
  const script = h.script(0);
  assert.match(script, /node scripts\/eng\/rehearse\.mjs --project rehearsal --agents 12/);
  // on a machine where the file is absent
  const ck = path.join(h.T, 'checkout');
  mkdirSync(ck, { recursive: true });
  const hbin = path.join(h.T, 'hbin');
  put(path.join(hbin, 'node'), sh(`echo "node $*" >> "${path.join(h.T, 'node.log')}"; echo REPORT`), 0o755);
  put(path.join(h.T, 'env'), 'REGION=eu-central-1\n');
  const mine = (s) => s.replace(/^CK=\S+/, `CK=${ck}`).replace(/^ENVF=\S+/m, `ENVF=${path.join(h.T, 'env')}`);
  const absent = spawnSync('sh', ['-c', mine(script)], { encoding: 'utf8', env: { PATH: `${hbin}:/usr/bin:/bin` } });
  assert.equal(absent.status, 1);
  assert.match(absent.stdout, /rehearse: .*scripts\/eng\/rehearse\.mjs does not exist\. The rehearsal script belongs to the lane 'rehearsal' of plan eng-gitlab-m2 and has not reached this machine\. Nothing was run\./);
  assert.equal(existsSync(path.join(h.T, 'node.log')), false, 'node was not started');
  // m2.sh passes that on
  h.w('status', 'Failed'); h.w('out', absent.stdout);
  r = h.run(['rehearse']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /does not exist\. The rehearsal script belongs to the lane 'rehearsal'/);
  assert.match(r.stderr, /rehearse: did NOT finish well/);
  // and where it is present it runs with the environment of the machine
  put(path.join(ck, 'scripts/eng/rehearse.mjs'), '// stand-in\n');
  const present = spawnSync('sh', ['-c', mine(script)], { encoding: 'utf8', env: { PATH: `${hbin}:/usr/bin:/bin` } });
  assert.equal(present.status, 0, present.stdout + present.stderr);
  assert.equal(readFileSync(path.join(h.T, 'node.log'), 'utf8').trim(), 'node scripts/eng/rehearse.mjs --project rehearsal --agents 12');
  assert.match(present.stdout, /rehearse exit: 0/);
}));

test('m2.sh finds the engineering account and the machine by itself when state.env is missing, and stops with a clear message when it cannot', () => withM2((h) => {
  writeFileSync(h.state, '');
  const r = h.run(['status']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(h.awsLog(), /organizations list-accounts/);
  assert.match(h.awsLog(), /ec2 describe-instances --filters Name=tag:Name,Values=vitana-eng-gitlab/);
  // not the management account
  put(path.join(h.bin, 'aws'), sh('case "$1 $2" in "sts get-caller-identity") echo 999999999999 ;; *) echo x ;; esac'), 0o755);
  const f = h.run(['status']);
  assert.equal(f.status, 1);
  assert.match(f.stderr, /run this in the management account 472838866351/);
}));

test('the pieces agree: ops-install.sh installs what the units run (git helper path, node path, env file, token file), and m2.sh asks for the timers that exist', ({ OPS, UNITS, M2 }) => {
  const sync = UNITS['vitana-platform-sync.service'];
  assert.ok(OPS.includes('git-askpass.sh') && sync.includes('GIT_ASKPASS=/opt/vitana/git-askpass.sh'));
  assert.ok(OPS.includes('"$P/usr/bin/node"') && UNITS['vitana-settings.service'].includes('ExecStart=/usr/bin/flock -n -E 0 /run/vitana-settings.lock /usr/bin/node '));
  assert.ok(OPS.includes('settings-admin-token'));
  assert.ok(OPS.includes('/etc/vitana/mirror-token'));
  assert.ok(OPS.includes('infra/gitlab-engineering/host/units') && OPS.includes('infra/gitlab-engineering/host/ops.d'));
  const timers = [...M2.matchAll(/for t in ([a-z -]+); do/g)].map((m) => m[1].split(' '));
  assert.ok(timers.some((l) => l.join() === TIMERS.join()), 'status looks at the four timers of plan section 3');
  // the merge bot's and the metrics job's units look for node where ops-install.sh puts it (their files arrive with their lanes)
  for (const other of ['vitana-land.service', 'vitana-ci-metrics.service']) {
    const f = path.join(ROOT, 'host/units', other);
    if (existsSync(f)) assert.match(readFileSync(f, 'utf8'), /\/usr\/bin\/node /, `${other} runs /usr/bin/node`);
  }
  // part B does not edit M1 files or the files of other lanes
  assert.equal(OPS.includes('gitlab-configure.sh') && /sed -i|>> *"?\$?\{?[A-Za-z_]*\}?\/?gitlab-configure/.test(OPS), false);
});


// eng-gitlab-m2/runner-pin-jq: node:20-bookworm has no jq, GitHub's ubuntu-latest has it; on GitLab 28 gateway tests failed with
// "jq: not found" (pipelines 154, 155). The .gateway jobs install jq before their script, so they run what GitHub runs.
nodeTest('the platform .gateway jobs install jq before their script', () => {
  const ci = read('ci/platform.gitlab-ci.yml');
  const block = ci.slice(ci.indexOf('\n.gateway:'), ci.indexOf('\n', ci.indexOf('before_script:', ci.indexOf('\n.gateway:'))) + 400);
  const bs = block.slice(block.indexOf('before_script:')).split('\n').slice(1).filter((l) => /^\s+- /.test(l)).map((l) => l.trim());
  assert.ok(bs.some((l) => /apt-get install -y -qq jq\b/.test(l)), `.gateway before_script installs jq: ${JSON.stringify(bs)}`);
  for (const job of ['typecheck', 'gateway-jest']) {
    const j = ci.slice(ci.indexOf(`\n${job}:`), ci.indexOf('\n\n', ci.indexOf(`\n${job}:`) + 2));
    assert.match(j, /extends: \.gateway/, `${job} extends .gateway`);
    assert.equal(/before_script:/.test(j), false, `${job} keeps the .gateway before_script`);
  }
});
