// VTID-05552 (agentic-delivery/verify-on-gitlab) — structure of infra/gitlab-engineering/ci/tpl-verify.yml
// (plan agentic-delivery §3.2 runner classes, §3.6 steps 3 to 6 and 8, §7 roles gl-verify and gl-record).
// Run: node --test scripts/eng/verify/tpl-verify-structure.test.mjs (UNIT.yml runs it on every PR: Node 20, no install).
//
// The template is parsed with the small YAML reader below, which accepts only the subset the template uses (block maps
// and lists, flow lists, plain and quoted scalars) and throws on anything else (anchors, tags, block scalars, flow
// maps), so the file cannot drift into syntax this test would misread. `extends` is resolved as GitLab does: maps merge
// deeply, every other value (lists included) is replaced by the child's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '..', '..', '..', 'infra', 'gitlab-engineering', 'ci', 'tpl-verify.yml');

// ── A strict reader for the YAML subset of the template ─────────────────────────────────────────────────────────────
function scalar(raw, where) {
  const s = raw.trim();
  if (s === '') return null;
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) throw new Error(`${where}: unterminated single-quoted scalar`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"')) return JSON.parse(s);
  if (/^[&*!|>{@`%]/.test(s)) throw new Error(`${where}: unsupported YAML (${s[0]}) — keep the template in the plain subset`);
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`${where}: unterminated flow list`);
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => scalar(x, where));
  }
  if (/\s#/.test(s)) throw new Error(`${where}: trailing comment — put comments on their own line`);
  if (/:\s/.test(s) || s.endsWith(':')) throw new Error(`${where}: plain scalar with ": " — quote it`);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^(yes|no|on|off|y|n)$/i.test(s)) throw new Error(`${where}: "${s}" is a boolean in YAML 1.1 (GitLab) — quote it`);
  return s;
}

function parseYaml(text) {
  const lines = text.split('\n').map((raw, i) => ({ raw, no: i + 1 }))
    .filter(({ raw }) => raw.trim() !== '' && !raw.trim().startsWith('#'));
  for (const { raw, no } of lines) if (/\t/.test(raw.match(/^\s*/)[0])) throw new Error(`line ${no}: tab indent`);
  let i = 0;
  const indentOf = (l) => l.raw.match(/^ */)[0].length;
  const KEY = /^([A-Za-z0-9_.$\-/{}]+):(?:\s+(.*))?$/;

  function block(indent) {
    const first = lines[i];
    const isList = first.raw.slice(indent).startsWith('- ') || first.raw.slice(indent) === '-';
    return isList ? list(indent) : map(indent);
  }
  function map(indent, into = {}) {
    while (i < lines.length && indentOf(lines[i]) === indent && !lines[i].raw.slice(indent).startsWith('-')) {
      const { raw, no } = lines[i];
      const m = KEY.exec(raw.slice(indent));
      if (!m) throw new Error(`line ${no}: expected "key: value", got ${JSON.stringify(raw.trim())}`);
      if (Object.prototype.hasOwnProperty.call(into, m[1])) throw new Error(`line ${no}: duplicate key ${m[1]}`);
      i++;
      if (m[2] !== undefined && m[2].trim() !== '') into[m[1]] = scalar(m[2], `line ${no}`);
      else if (i < lines.length && indentOf(lines[i]) > indent) into[m[1]] = block(indentOf(lines[i]));
      else if (i < lines.length && indentOf(lines[i]) === indent && lines[i].raw.slice(indent).startsWith('- ')) into[m[1]] = list(indent);
      else into[m[1]] = null;
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
        // `- key: value` starts a map whose other keys sit at indent + 2.
        lines[i] = { raw: `${' '.repeat(indent + 2)}${item}`, no };
        out.push(map(indent + 2));
      } else {
        i++;
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
function resolve(doc, name, seen = []) {
  const job = doc[name];
  assert.ok(isMap(job), `${name} is defined`);
  assert.ok(!seen.includes(name), `extends cycle at ${name}`);
  const parents = job.extends === undefined ? [] : [].concat(job.extends);
  let acc = {};
  for (const p of parents) acc = merge(acc, resolve(doc, p, [...seen, name]));
  const { extends: _e, ...own } = job;
  return merge(acc, own);
}

let cached;
function template() {
  if (!cached) {
    const text = readFileSync(TEMPLATE, 'utf8');
    cached = { text, doc: parseYaml(text) };
  }
  return cached;
}
const job = (name) => resolve(template().doc, name);
const scriptOf = (j) => [...(j.before_script || []), ...(j.script || [])];
const MAIN = 'vitana-eng-main';
const DEPLOY = 'vitana-eng-deploy';
const UNTRUSTED = 'vitana-eng';
const JOBS = ['.staging-verify', '.staging-verify-nightly', '.record', '.vtid-close', '.notify-platform'];
const audiences = (j) => Object.values(j.id_tokens || {}).map((t) => t && t.aud);
const liveOnly = (j) => {
  const r = j.rules || [];
  return r.length > 0 && r[0].if === '$DELIVERY_MODE != "live"' && r[0].when === 'never';
};

test('the template defines the hidden jobs of plan §9 and nothing that runs on its own', () => {
  const { doc } = template();
  for (const name of JOBS) assert.ok(isMap(doc[name]), `${name} defined`);
  for (const key of Object.keys(doc)) assert.ok(key.startsWith('.'), `${key}: only hidden jobs; the pipelines of lane pipelines extend them`);
  for (const name of JOBS) assert.equal(job(name).secrets, undefined, `${name}: no secrets: keyword (Premium); secrets come through the §7 roles`);
});

test('.staging-verify: main class, a resource_group per service, not interruptible, audience of gl-verify only', () => {
  const j = job('.staging-verify');
  assert.deepEqual(j.tags, [MAIN]);
  assert.equal(j.interruptible, false);
  assert.equal(j.resource_group, 'staging-verify-${VERIFY_SERVICE}');
  assert.deepEqual(audiences(j), ['aws:verify']);
  assert.equal(j.variables.GIT_DEPTH, '0', 'full history: every commit between production and the deployed commit');
  assert.equal(j.rules, undefined, 'it runs in shadow and live mode');
  const run = j.script.find((l) => /shadow-wait\.mjs/.test(l));
  assert.ok(run, 'the shadow-wait wrapper runs run.mjs');
  assert.match(run, /--run-mjs "\$CENTRAL_DIR\/scripts\/ci\/staging-verify\/run\.mjs"/, 'run.mjs from platform main');
  assert.match(run, /--deploy-runs-file "\$DEPLOY_RUNS_FILE"/, 'the deploy-runs file, never the GitHub API');
  assert.match(run, /--sha "\$CI_COMMIT_SHA"/);
  assert.match(run, /--full "\$VERIFY_FULL"/);
  assert.equal(j.variables.VERIFY_FULL, 'false');
  assert.equal(j.artifacts.when, 'always', 'the result stays in the artifact whatever the outcome');
  assert.deepEqual(j.artifacts.paths, ['staging-verify-out/']);
});

test('the resource groups are oldest first: every group the template uses is declared for the settings sync', () => {
  const modes = template().doc['.resource-groups'];
  assert.ok(isMap(modes), '.resource-groups declares the process modes (GitLab sets them only through the API)');
  const groups = [];
  for (const name of JOBS) {
    const g = job(name).resource_group;
    if (g) for (const service of ['gateway', 'community-app']) groups.push(g.replace('${VERIFY_SERVICE}', service));
  }
  assert.ok(groups.length >= 4);
  for (const g of groups) assert.equal(modes[g], 'oldest_first', g);
});

test('the nightly run passes full=true on the commit staging serves, in its own resource group', () => {
  const j = job('.staging-verify-nightly');
  assert.deepEqual(j.tags, [MAIN]);
  assert.equal(j.interruptible, false);
  assert.equal(j.variables.VERIFY_FULL, 'true');
  assert.equal(j.resource_group, 'staging-verify-${VERIFY_SERVICE}-full', 'a full run never delays a per-landing verification');
  assert.deepEqual(audiences(j), ['aws:verify']);
  const run = j.script.find((l) => /shadow-wait\.mjs/.test(l));
  assert.match(run, /--full "\$VERIFY_FULL"/);
  assert.match(run, /--sha-from-staging/);
  assert.doesNotMatch(run, /--sha "/);
  assert.match(run, /--deploy-runs-file "\$DEPLOY_RUNS_FILE"/);
});

test('.record: deploy class, audience of gl-record only, checks out nothing, live mode only, runs record-oasis.sh', () => {
  const j = job('.record');
  assert.deepEqual(j.tags, [DEPLOY]);
  assert.deepEqual(audiences(j), ['aws:record']);
  assert.equal(j.variables.GIT_STRATEGY, 'none');
  assert.ok(liveOnly(j), 'never in shadow mode');
  assert.equal(j.rules[j.rules.length - 1].when, 'always', 'records a failed verification too');
  const s = scriptOf(j).join('\n');
  assert.match(s, /aws-secret\.mjs" --token-env RECORD_ID_TOKEN --role-arn "\$GL_RECORD_ROLE_ARN" --secret-id vitana\/ci\/oasis-recorder /);
  assert.match(s, /record-env\.mjs" run --record-script "\$CENTRAL_DIR\/scripts\/ci\/staging-verify\/record-oasis\.sh"/);
  assert.equal(j.allow_failure, undefined, 'a record without its secret turns the job red');
});

test('.vtid-close: deploy class, audience of gl-record only, checks out nothing, live mode only, at landing', () => {
  const j = job('.vtid-close');
  assert.deepEqual(j.tags, [DEPLOY]);
  assert.deepEqual(audiences(j), ['aws:record']);
  assert.equal(j.variables.GIT_STRATEGY, 'none');
  assert.ok(liveOnly(j), 'never in shadow mode');
  assert.deepEqual(j.needs, [], 'closes at landing, as VTID-AUTO-CLOSE does at merge');
  assert.equal(j.allow_failure, true, 'as on GitHub, a close that does not happen never fails the landing');
  const s = scriptOf(j).join('\n');
  assert.match(s, /--secret-id vitana\/ci\/gateway-service-token /);
  assert.match(s, /vtid-close-env\.mjs" run --close-script "\$CENTRAL_DIR\/scripts\/ci\/vtid-auto-close\.cjs"/);
});

test('.notify-platform: deploy class, no ID token, live mode only, starts the platform pipeline SCREENS-CATALOG-TRIGGER starts', () => {
  const j = job('.notify-platform');
  assert.deepEqual(j.tags, [DEPLOY]);
  assert.equal(j.id_tokens, undefined);
  assert.equal(j.variables.GIT_STRATEGY, 'none');
  assert.ok(liveOnly(j), 'never in shadow mode');
  const push = j.rules.find((r) => r.changes);
  assert.deepEqual(push.changes, ['src/config/admin-navigation.ts', 'src/lib/screen-id.ts'], 'the paths of SCREENS-CATALOG-TRIGGER.yml');
  const s = scriptOf(j).join('\n');
  assert.match(s, /--form "token=\$\{CI_JOB_TOKEN\}"/);
  assert.match(s, /--form ref=main/);
  assert.match(s, /variables\[DISPATCH_EVENT_TYPE\]=regen-screens-catalog/);
  assert.match(s, /variables\[DISPATCH_SOURCE_REPO\]=vitana-v1/);
  assert.match(s, /variables\[DISPATCH_SOURCE_SHA\]=\$\{CI_COMMIT_SHA\}/);
  assert.match(s, /\$\{CI_API_V4_URL\}\/projects\/vitana%2Fvitana-platform\/trigger\/pipeline/);
});

test('shadow mode: every writing job also refuses in its own script, so a pipeline that overrides rules still writes nothing', () => {
  for (const name of ['.record', '.vtid-close', '.notify-platform']) {
    const s = scriptOf(job(name)).join('\n');
    assert.ok(/record-env\.mjs" run|vtid-close-env\.mjs" run|\[ "\$DELIVERY_MODE" = "live" \] \|\|/.test(s), `${name}: a script-level live-mode guard`);
  }
});

test('runner classes (§3.2): nothing on the untrusted class; deploy-class jobs run only platform main\'s scripts', () => {
  for (const name of JOBS) {
    const j = job(name);
    assert.ok(!(j.tags || []).includes(UNTRUSTED), `${name}: not on ${UNTRUSTED}`);
    assert.equal((j.tags || []).length, 1, `${name}: exactly one class`);
  }
  for (const name of ['.record', '.vtid-close', '.notify-platform']) {
    const j = job(name);
    assert.equal(j.variables.GIT_STRATEGY, 'none', `${name}: the commit under test is not even checked out`);
    for (const line of scriptOf(j)) {
      const scripts = [...line.matchAll(/(?:^|\s)(?:node|bash|sh)\s+("?)([^\s"]+)\1/g)].map((m) => m[2]);
      for (const p of scripts) assert.match(p, /^\$CENTRAL_DIR\//, `${name}: ${p} must come from the platform main clone`);
      assert.doesNotMatch(line, /(?:^|\s)\.\/|\$CI_PROJECT_DIR\/scripts\//, `${name}: no repository script (${line})`);
    }
  }
  for (const name of ['.staging-verify', '.staging-verify-nightly']) {
    for (const line of scriptOf(job(name))) {
      for (const m of line.matchAll(/(?:^|\s)node\s+"([^"]+)"/g)) assert.match(m[1], /^\$CENTRAL_DIR\//, `${name}: ${m[1]} from platform main`);
    }
  }
});

test('the central scripts come from platform main through the job token; the AWS roles are in account 472838866351', () => {
  const j = job('.delivery-central');
  const s = j.before_script.join('\n');
  assert.match(s, /git clone [^\n]*--branch main [^\n]*"https:\/\/gitlab-ci-token:\$\{CI_JOB_TOKEN\}@\$\{CI_SERVER_HOST\}\/\$\{PLATFORM_PROJECT_PATH\}\.git" "\$CENTRAL_DIR"/);
  assert.equal(j.variables.PLATFORM_PROJECT_PATH, 'vitana/vitana-platform');
  assert.equal(j.variables.AWS_REGION, 'eu-central-1');
  assert.equal(job('.staging-verify').variables.GL_VERIFY_ROLE_ARN, 'arn:aws:iam::472838866351:role/gl-verify');
  for (const name of ['.record', '.vtid-close']) assert.equal(job(name).variables.GL_RECORD_ROLE_ARN, 'arn:aws:iam::472838866351:role/gl-record', name);
});
