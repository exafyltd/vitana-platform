#!/usr/bin/env node
// VTID-05550 (plan agentic-delivery §3.3, §3.4, §3.6, §3.9, T3; lane pipelines).
// Renders one GitLab pipeline file per repository from config/delivery/services.json into infra/gitlab-engineering/ci/
// (M2's settings sync copies that directory into vitana/ci-config, so a branch never changes the pipeline that judges it).
//   node scripts/eng/pipeline-gen.mjs            write the rendered files
//   node scripts/eng/pipeline-gen.mjs --check    write nothing; exit 3 when a committed file differs (drift)
//   node scripts/eng/pipeline-gen.mjs gate --repo <key> --base <sha> --head <sha> --ran-dir <dir>
//        the `gate` job: every check the change needs ran and passed; an unknown path fails closed
// Dependency-free Node 20. The model functions (matchGlob, evaluatePipeline, selectChecks) follow GitLab's documented
// rules semantics so the tests can prove what a merge request selects without a GitLab instance.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'vitana.delivery-services/v1';
export const SERVICES_FILE = 'config/delivery/services.json';
export const GOVERNANCE = ['lane-scope', 'change-suite', 'pr-gate-report', 'collab-handoff'];
export const TEMPLATE_FILES = ['tpl-checks.yml', 'tpl-main.yml', 'tpl-nightly.yml', 'tpl-assist.yml', 'tpl-deploy.yml', 'tpl-verify.yml'];
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------- service list ----------
export function loadServices(root = DEFAULT_ROOT) {
  const config = JSON.parse(readFileSync(path.join(root, SERVICES_FILE), 'utf8'));
  validateServices(config);
  return config;
}

export function validateServices(config) {
  if (config.schema !== SCHEMA) throw new Error(`${SERVICES_FILE}: schema must be ${SCHEMA}`);
  for (const [key, r] of Object.entries(config.repositories || {})) {
    for (const [name, s] of Object.entries(r.services)) {
      for (const c of s.checks) if (!r.checks[c]) throw new Error(`${key}: service ${name} names unknown check ${c}`);
      for (const p of s.paths) if (/(^|\/)\*\*$/.test(p)) throw new Error(`${key}: ${name} path ${p}: a trailing ** matches one level in GitLab; write ${p}/*`);
    }
    for (const [name, c] of Object.entries(r.checks)) {
      if (c.install && !r.install[c.install]) throw new Error(`${key}: check ${name} names unknown install ${c.install}`);
      if (c.image && !config.images[c.image]) throw new Error(`${key}: check ${name} names unknown image ${c.image}`);
      for (const p of c.apt || []) if (!config.apt_tools?.[p]) throw new Error(`${key}: check ${name} installs ${p}, which apt_tools does not list`);
    }
    if (r.pr_gate_install && !r.install[r.pr_gate_install]) throw new Error(`${key}: pr_gate_install names unknown install ${r.pr_gate_install}`);
  }
}

// The first script line of a check that needs Debian packages its image lacks (apt_tools of the service list).
export const aptLine = (pkgs) => `apt-get update -qq && apt-get install -y -qq --no-install-recommends ${pkgs.join(' ')} >/dev/null`;

// ---------- globs: GitLab rules:changes = Ruby File.fnmatch(pattern, path, FNM_PATHNAME | FNM_DOTMATCH | FNM_EXTGLOB) ----------
const reCache = new Map();
function expandBraces(p) {
  const m = p.match(/\{([^{}]*)\}/);
  if (!m) return [p];
  return m[1].split(',').flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
}
const esc = (c) => c.replace(/[.+^${}()|[\]\\/-]/g, '\\$&');
function globRegex(p) {
  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      // `**/` at the start of a segment matches zero or more directories; any other `**` is a plain `*`.
      if (p[i + 1] === '*' && (i === 0 || p[i - 1] === '/') && p[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; continue; }
      while (p[i + 1] === '*') i += 1;
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[' && p.indexOf(']', i + 2) > 0) {
      const j = p.indexOf(']', i + 2);
      let body = p.slice(i + 1, j);
      const neg = body[0] === '!' || body[0] === '^';
      if (neg) body = body.slice(1);
      body = body.replace(/\\/g, '\\\\');
      re += neg ? `[^/${body}]` : `[${body}]`;
      i = j;
    } else if (c === '\\' && i + 1 < p.length) { re += esc(p[i + 1]); i += 1; }
    else re += esc(c);
  }
  return new RegExp(`^${re}$`);
}
export function matchGlob(pattern, file) {
  let res = reCache.get(pattern);
  if (!res) { res = expandBraces(pattern).map(globRegex); reCache.set(pattern, res); }
  return res.some((r) => r.test(file));
}

// ---------- the pipeline document ----------
const IF = {
  t1: '$CI_PIPELINE_SOURCE == "merge_request_event" || $CI_COMMIT_BRANCH =~ /^train\\//',
  mr: '$CI_PIPELINE_SOURCE == "merge_request_event"',
  main: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"',
  mainOrNightly: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push" || $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "schedule" && $DELIVERY_SCHEDULE == "nightly"',
  nightly: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "schedule" && $DELIVERY_SCHEDULE == "nightly"',
  notLive: '$DELIVERY_MODE != "live"',
};
const NEVER_IN_SHADOW = { if: IF.notLive, when: 'never' };

const checkPatterns = (r, check) => {
  const out = [...r.shared_paths, ...r.other_paths];
  for (const s of Object.values(r.services)) if (s.checks.includes(check)) for (const p of s.paths) if (!out.includes(p)) out.push(p);
  return out;
};
const servicePatterns = (r, s) => [...new Set([...s.paths, ...r.shared_paths])];

function checkJob(config, r, name, c, mode) {
  const job = {};
  job.extends = mode === 't1' ? (c.central ? ['.check', '.central-tools'] : '.check') : (c.central ? ['.full-suite', '.central-tools'] : '.full-suite');
  job.stage = mode === 't1' ? 'checks' : 'full-suite';
  if (c.image && config.images[c.image]) job.image = config.images[c.image];
  if (c.postgres) job.services = [{ name: config.images.postgres, alias: 'postgres', variables: { POSTGRES_PASSWORD: '$PGPASSWORD' } }];
  if (c.parallel > 1) job.parallel = c.parallel;
  const prefix = mode === 't1' ? '' : 'full-suite:';
  if (c.needs) job.needs = c.needs.map((n) => ({ job: `${prefix}${n}`, artifacts: true }));
  const vars = { DELIVERY_CHECK: name, ...(c.variables || {}) };
  if (c.postgres) Object.assign(vars, { PGHOST: 'postgres', PGPORT: '5432', PGUSER: 'postgres', PGPASSWORD: vars.PGPASSWORD || 'postgres' });
  job.variables = vars;
  const cache = c.install ? r.install[c.install] : c.install_cache;
  if (cache) job.cache = { key: { files: cache.lockfiles, prefix: name }, paths: [...cache.cache_paths, ...(c.cache_paths || [])], policy: 'pull-push' };
  // The apt line, then the install lines; a `cd` in them (services/gateway, apps/mobile) stays in force for the check's lines.
  job.script = [...(c.apt?.length ? [aptLine(c.apt)] : []), ...(c.install ? r.install[c.install].script : []), ...c.script];
  if (c.artifacts) job.artifacts = { when: 'always', expire_in: '1 day', paths: [...c.artifacts, '.delivery-ran/'] };
  job.rules = mode === 't1'
    ? [{ if: IF.t1, changes: { paths: checkPatterns(r, name), compare_to: 'refs/heads/main' } }]
    : [{ if: IF.mainOrNightly }];
  return job;
}

export function buildPipeline(config, repoKey) {
  const r = config.repositories[repoKey];
  if (!r) throw new Error(`unknown repository ${repoKey}`);
  const v1 = repoKey === 'vitana-v1';
  const checks = Object.keys(r.checks);
  const doc = {};
  doc.include = [{ project: config.ci_config.project, ref: config.ci_config.ref, file: [...TEMPLATE_FILES] }];
  doc.workflow = {
    auto_cancel: { on_new_commit: 'interruptible' },
    rules: [
      { if: IF.mr },
      { if: '$CI_COMMIT_BRANCH =~ /^train\\//' },
      { if: IF.main },
      { if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "schedule"' },
      { if: '$CI_COMMIT_BRANCH =~ /^assist\\//' },
      { when: 'never' },
    ],
  };
  doc.stages = ['governance', 'checks', 'gate', 'preview', 'full-suite', 'build', 'push', 'deploy', 'verify', 'record', 'close', 'assist'];
  doc.variables = {
    DELIVERY_MODE: 'shadow',
    DELIVERY_REPOSITORY: repoKey,
    GATE_BASE: '$CI_MERGE_REQUEST_DIFF_BASE_SHA',
    GATE_HEAD: '$CI_COMMIT_SHA',
    GATE_BRANCH: '$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME',
    GATE_TITLE: '$CI_MERGE_REQUEST_TITLE',
  };
  // T1 governance: always, first, no path rule.
  const t1 = { if: IF.t1 };
  doc['lane-scope'] = { extends: ['.governance', '.lane-scope'], stage: 'governance', rules: [t1] };
  doc['change-suite'] = { extends: ['.governance', '.change-suite'], stage: 'governance', variables: { CHANGE_SUITE_SERVICE: v1 ? 'community-app' : 'gateway' }, rules: [t1] };
  // red-green runs the change's tests on the base commit with the checkout's node_modules (gate.mjs red-green), so a
  // fix VTID installs them first; the cache is keyed by that lockfile.
  const rgInstall = r.install[r.pr_gate_install];
  doc['pr-gate-report'] = { extends: ['.governance', '.pr-gate-report'], stage: 'governance', ...(rgInstall ? { cache: { key: { files: rgInstall.lockfiles, prefix: 'pr-gate-report' }, paths: rgInstall.cache_paths, policy: 'pull-push' } } : {}), rules: [t1] };
  doc['collab-handoff'] = { extends: ['.governance', '.collab-handoff'], stage: 'governance', ...(r.collab_handoff === 'report-only' ? { allow_failure: true } : {}), rules: [t1] };
  // T1 service checks, selected by path.
  for (const name of checks) doc[name] = checkJob(config, r, name, r.checks[name], 't1');
  doc.gate = { extends: ['.gate', '.central-tools'], stage: 'gate', needs: checks.map((c) => ({ job: c, optional: true, artifacts: true })), rules: [t1] };
  // T4: merge-request preview (vitana-v1, live mode only; projects have no merge requests before the cut).
  for (const [svc, s] of Object.entries(r.services)) {
    if (s.preview !== 'spa') continue;
    const changes = { paths: servicePatterns(r, s), compare_to: 'refs/heads/main' };
    doc['preview-build'] = { extends: ['.t1-base', '.preview-build'], stage: 'preview', variables: { PREVIEW_SERVICE: svc, PREVIEW_BASE: '/mr-$CI_MERGE_REQUEST_IID/' }, rules: [NEVER_IN_SHADOW, { if: IF.mr, changes }] };
    doc['preview-upload'] = { extends: '.preview-upload', stage: 'preview', tags: [config.runner_tags.deploy], interruptible: false, needs: [{ job: 'preview-build', artifacts: true }], variables: { PREVIEW_SERVICE: svc, PREVIEW_PREFIX: 'mr-$CI_MERGE_REQUEST_IID/' }, environment: { name: 'review/mr-$CI_MERGE_REQUEST_IID', on_stop: 'preview-stop', auto_stop_in: '1 week' }, rules: [NEVER_IN_SHADOW, { if: IF.mr, changes }] };
    doc['preview-stop'] = { extends: '.preview-stop', stage: 'preview', tags: [config.runner_tags.deploy], interruptible: false, needs: [{ job: 'preview-upload', optional: true }], variables: { PREVIEW_SERVICE: svc, PREVIEW_PREFIX: 'mr-$CI_MERGE_REQUEST_IID/' }, environment: { name: 'review/mr-$CI_MERGE_REQUEST_IID', action: 'stop' }, rules: [NEVER_IN_SHADOW, { if: IF.mr, changes, when: 'manual', allow_failure: true }] };
    // Shadow proof (plan §8.1 step 3): the non-production preview path gl-main/ on every main commit.
    doc['preview-build:main'] = { extends: ['.full-suite', '.preview-build'], stage: 'build', needs: [], variables: { PREVIEW_SERVICE: svc, PREVIEW_BASE: '/gl-main/' }, rules: [{ if: `${IF.notLive} && ${IF.main}`, changes: { paths: servicePatterns(r, s) } }] };
    doc['preview-upload:main'] = { extends: '.preview-upload', stage: 'deploy', tags: [config.runner_tags.deploy], interruptible: false, needs: [{ job: 'preview-build:main', artifacts: true }], variables: { PREVIEW_SERVICE: svc, PREVIEW_PREFIX: 'gl-main/' }, rules: [{ if: `${IF.notLive} && ${IF.main}`, changes: { paths: servicePatterns(r, s) } }] };
    // E2E-PREVIEW-ORB (dispatch only on GitHub): by hand on main, main class (it signs in as the test user), live mode only.
    doc['e2e-preview-orb'] = { extends: '.e2e-preview-orb', stage: 'verify', tags: [config.runner_tags.main], interruptible: false, allow_failure: true, needs: [], rules: [NEVER_IN_SHADOW, { if: IF.main, when: 'manual' }] };
  }
  // T2: every check once per landing (and on the nightly run, T3), on the main class, never interrupted.
  for (const name of checks) doc[`full-suite:${name}`] = checkJob(config, r, name, r.checks[name], 'main');
  // T2: image, push, staging deploy and rollback, STAGING-VERIFY, record, per changed deployable service.
  for (const [svc, s] of Object.entries(r.services)) {
    if (!s.image || !s.staging) continue;
    const on = { if: IF.main, changes: { paths: servicePatterns(r, s) } };
    const deployVars = {
      DEPLOY_SERVICE: svc,
      DEPLOY_ECR_REPOSITORY: s.image.ecr_repository,
      DEPLOY_IMAGE_CONTEXT: s.image.context,
      DEPLOY_DOCKERFILE: s.image.dockerfile,
      DEPLOY_ECS_CLUSTER: s.staging.ecs_cluster,
      DEPLOY_ECS_SERVICE: s.staging.ecs_service,
      DEPLOY_RUNS_FILE: '$CI_PROJECT_DIR/deploy-runs.json',
    };
    doc[`build-image:${svc}`] = { extends: '.build-image', stage: 'build', needs: [], tags: ['vitana-eng-build'], interruptible: false, variables: { ...deployVars }, rules: [on] };
    doc[`push-image:${svc}`] = { extends: '.push-image', stage: 'push', tags: [config.runner_tags.deploy], interruptible: false, needs: [{ job: `build-image:${svc}`, artifacts: true }], variables: { ...deployVars }, rules: [on] };
    const overrides = Object.keys(s.env_overrides || {}).length ? JSON.stringify(s.env_overrides) : null;
    doc[`deploy-staging:${svc}`] = {
      extends: '.deploy-staging', stage: 'deploy', tags: [config.runner_tags.deploy], interruptible: false, resource_group: `staging-deploy-${svc}`,
      needs: [{ job: `push-image:${svc}`, artifacts: true }], variables: { ...deployVars },
      rules: overrides ? [{ if: `$DELIVERY_MODE == "live" && ${IF.main}`, changes: on.changes, variables: { DEPLOY_ENV_OVERRIDES: overrides } }, on] : [on],
    };
    doc[`rollback-staging:${svc}`] = { extends: '.rollback-staging', stage: 'deploy', tags: [config.runner_tags.deploy], interruptible: false, needs: [{ job: `deploy-staging:${svc}`, artifacts: true }], variables: { ...deployVars }, rules: [{ ...on, when: 'on_failure' }] };
    if (s.staging_verify) {
      doc[`staging-verify:${svc}`] = { extends: '.staging-verify', stage: 'verify', tags: [config.runner_tags.main], interruptible: false, needs: [{ job: `deploy-staging:${svc}`, artifacts: true }], variables: { VERIFY_SERVICE: s.staging_verify }, rules: [on] };
      doc[`record:${svc}`] = { extends: '.record', stage: 'record', tags: [config.runner_tags.deploy], interruptible: false, needs: [{ job: `staging-verify:${svc}`, artifacts: true }], variables: { VERIFY_SERVICE: s.staging_verify }, rules: [NEVER_IN_SHADOW, { ...on, when: 'always' }] };
      doc[`staging-verify-nightly:${svc}`] = { extends: '.staging-verify-nightly', stage: 'verify', tags: [config.runner_tags.main], interruptible: false, needs: [], variables: { VERIFY_SERVICE: s.staging_verify }, rules: [{ if: IF.nightly }] };
      doc[`record-nightly:${svc}`] = { extends: '.record', stage: 'record', tags: [config.runner_tags.deploy], interruptible: false, needs: [{ job: `staging-verify-nightly:${svc}`, artifacts: true }], variables: { VERIFY_SERVICE: s.staging_verify }, rules: [NEVER_IN_SHADOW, { if: IF.nightly, when: 'always' }] };
    }
  }
  doc['vtid-close'] = { extends: '.vtid-close', stage: 'close', tags: [config.runner_tags.deploy], interruptible: false, needs: [], rules: [NEVER_IN_SHADOW, { if: IF.main }] };
  if (r.notify_platform_paths.length) doc['notify-platform'] = { extends: '.notify-platform', stage: 'close', tags: [config.runner_tags.deploy], interruptible: false, needs: [], rules: [NEVER_IN_SHADOW, { if: IF.main, changes: { paths: r.notify_platform_paths } }] };
  // T7: assist jobs on the protected assist/<iid>-<rule> refs (and the scheduled safety net), live mode only.
  for (const [rule, a] of Object.entries(r.assist_rules)) {
    const trigger = a.trigger === 'schedule'
      ? `$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "schedule" && $DELIVERY_SCHEDULE == "${rule}"`
      : `$CI_COMMIT_BRANCH =~ /^assist\\// && $ASSIST_RULE == "${rule}"`;
    doc[`assist:${rule}`] = { extends: '.assist', stage: 'assist', tags: [config.runner_tags.main], interruptible: false, variables: { ASSIST_RULE: rule, ASSIST_KIND: a.trigger }, script: a.script, rules: [NEVER_IN_SHADOW, { if: trigger }] };
  }
  return doc;
}

// ---------- YAML: a deterministic emitter and a reader for the subset the templates and the emitter use ----------
const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
const key = (k) => (PLAIN_KEY.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k));
const scalar = (v) => (typeof v === 'string' ? JSON.stringify(v) : v === null ? 'null' : String(v));
function emit(v, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return ' []';
    return v.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) {
        const body = emit(item, indent + 2).replace(/^\n/, '');
        return `\n${pad}- ${body.slice(indent + 2)}`;
      }
      return `\n${pad}-${emit(item, indent + 2)}`;
    }).join('');
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return ' {}';
    return keys.map((k) => `\n${pad}${key(k)}:${emit(v[k], indent + 2)}`).join('');
  }
  return ` ${scalar(v)}`;
}
export function renderYaml(doc, header = []) {
  const head = header.map((l) => `# ${l}`.trimEnd()).join('\n');
  return `${head}${head ? '\n' : ''}${Object.keys(doc).map((k) => `${key(k)}:${emit(doc[k], 2)}`).join('\n\n')}\n`;
}

function parseScalar(s) {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === '[]') return [];
  if (t === '{}') return {};
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"')) return JSON.parse(t);
  if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('[') && t.endsWith(']')) return splitFlow(t.slice(1, -1)).map(parseScalar);
  return t;
}
function splitFlow(s) {
  const out = []; let cur = ''; let q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
const splitKey = (line) => {
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) { if (ch === q && line[i - 1] !== '\\') q = null; continue; }
    if ((ch === '"' || ch === "'") && i === 0) { q = ch; continue; }
    if (ch === ':' && (i + 1 === line.length || line[i + 1] === ' ')) return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
};
export function parseYaml(text) {
  const lines = text.split('\n').map((raw) => ({ raw, ind: raw.match(/^ */)[0].length, t: raw.trim() }))
    .filter((l) => l.t && !l.t.startsWith('#'));
  let i = 0;
  function block(ind) {
    if (i >= lines.length) return null;
    if (lines[i].t.startsWith('- ') || lines[i].t === '-') {
      const arr = [];
      while (i < lines.length && lines[i].ind === ind && (lines[i].t.startsWith('- ') || lines[i].t === '-')) {
        const rest = lines[i].t === '-' ? '' : lines[i].t.slice(2);
        const kv = splitKey(rest);
        if (kv && !rest.startsWith('"') && !rest.startsWith("'")) {
          // "- key: value" starts a mapping whose further keys sit at ind + 2
          lines[i] = { raw: rest, ind: ind + 2, t: rest };
          arr.push(mapping(ind + 2));
        } else if (rest === '') { i += 1; arr.push(block(lines[i]?.ind ?? ind + 2)); } else { arr.push(parseScalar(rest)); i += 1; }
      }
      return arr;
    }
    return mapping(ind);
  }
  function mapping(ind) {
    const obj = {};
    while (i < lines.length && lines[i].ind === ind && !lines[i].t.startsWith('- ')) {
      const kv = splitKey(lines[i].t);
      if (!kv) throw new Error(`yaml: cannot read line: ${lines[i].raw}`);
      const k = parseScalar(kv[0]);
      const v = kv[1].trim();
      i += 1;
      if (v === '') obj[k] = i < lines.length && (lines[i].ind > ind || (lines[i].ind === ind && lines[i].t.startsWith('- '))) ? block(lines[i].ind) : null;
      else obj[k] = parseScalar(v);
    }
    return obj;
  }
  return lines.length ? block(lines[0].ind) : {};
}

// ---------- GitLab rules evaluation (the subset the generated files use) ----------
function evalIf(expr, vars) {
  return expr.split('||').some((alt) => alt.split('&&').every((term) => evalTerm(term.trim(), vars)));
}
function operand(s, vars) {
  const t = s.trim();
  if (t.startsWith('$')) { const v = vars[t.slice(1)]; return v === undefined || v === null ? null : String(v); }
  if (t.startsWith('"') || t.startsWith("'")) return t.slice(1, -1);
  if (t === 'null') return null;
  return t;
}
function evalTerm(term, vars) {
  let m = term.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (m) { const a = operand(m[1], vars); const b = operand(m[3], vars); return m[2] === '==' ? a === b : a !== b; }
  m = term.match(/^(.+?)\s*(=~|!~)\s*\/(.*)\/([a-z]*)$/);
  if (m) { const a = operand(m[1], vars); const hit = a !== null && new RegExp(m[3].replace(/\\\//g, '/'), m[4]).test(a); return m[2] === '=~' ? hit : !hit; }
  const v = operand(term, vars);
  return v !== null && v !== '';
}

function mergeDeep(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? mergeDeep(out[k], v) : v;
  return out;
}
export function resolveJob(docs, name, seen = new Set()) {
  let job = null;
  for (const d of docs) if (d && d[name] && typeof d[name] === 'object') job = job ? mergeDeep(job, d[name]) : d[name];
  if (!job) return {};
  if (seen.has(name)) throw new Error(`extends cycle at ${name}`);
  seen.add(name);
  let base = {};
  for (const parent of [].concat(job.extends || [])) base = mergeDeep(base, resolveJob(docs, parent, new Set(seen)));
  const own = { ...job };
  return { ...mergeDeep(base, own), extends: job.extends };
}

const NOT_JOBS = new Set(['include', 'workflow', 'stages', 'variables', 'default', 'image', 'services', 'cache', 'before_script', 'after_script']);
// Which jobs a pipeline creates for the context { variables, changes } (changes null = not a push or merge request diff:
// GitLab treats rules:changes as true then). Pipeline variables override the file's global variables, as in GitLab.
export function evaluatePipeline(docs, ctx) {
  docs = [].concat(docs);
  const globals = Object.assign({}, ...docs.map((d) => d.variables || {}));
  const vars = { ...globals, ...ctx.variables };
  const generated = docs[docs.length - 1];
  if (generated.workflow?.rules) {
    const hit = generated.workflow.rules.find((r) => (r.if ? evalIf(r.if, vars) : true));
    if (!hit || hit.when === 'never') return {};
  }
  const jobs = {};
  for (const name of Object.keys(generated)) {
    if (NOT_JOBS.has(name) || name.startsWith('.')) continue;
    const job = resolveJob(docs, name);
    const rules = job.rules || [{}];
    const rule = rules.find((r) => (r.if ? evalIf(r.if, vars) : true) && (!r.changes || ctx.changes === null || (ctx.changes || []).some((f) => [].concat(r.changes.paths || r.changes).some((p) => matchGlob(p, f)))));
    if (!rule || rule.when === 'never') continue;
    const created = { ...job, variables: { ...(job.variables || {}), ...(rule.variables || {}) } };
    if (rule.when) created.when = rule.when;
    jobs[name] = created;
  }
  return jobs;
}

// ---------- selection model ----------
export function selectChecks(config, repoKey, files) {
  const r = config.repositories[repoKey];
  const doc = buildPipeline(config, repoKey);
  const selected = [];
  for (const name of Object.keys(r.checks)) {
    const rule = doc[name].rules[0];
    if (files.some((f) => rule.changes.paths.some((p) => matchGlob(p, f)))) selected.push(name);
  }
  const claimed = [...r.shared_paths, ...r.other_paths, ...r.docs_paths, ...Object.values(r.services).flatMap((s) => s.paths)];
  const unknown = files.filter((f) => !claimed.some((p) => matchGlob(p, f)));
  return { selected, unknown };
}

export function gateVerdict(config, repoKey, files, ran) {
  const { selected, unknown } = selectChecks(config, repoKey, files);
  const ranSet = new Set(ran);
  const missing = selected.filter((c) => !ranSet.has(c));
  const lines = [];
  if (unknown.length) lines.push(`unknown path(s): ${unknown.join(', ')}. Every check is required for a path no service claims, and GitLab rules:changes cannot select a path no pattern lists: claim it in ${SERVICES_FILE} (a service, shared_paths, other_paths or docs_paths) and push again.`);
  if (missing.length) lines.push(`check(s) this change needs did not run: ${missing.join(', ')}`);
  return { ok: !lines.length, selected, unknown, missing, message: lines.join('\n') || `gate: ${selected.length} selected check(s) ran and passed` };
}

export function fixtureMinutes(check, fixture) {
  const d = check.duration;
  if (!d) return NaN;
  if (d.fixture === null) return d.minutes;
  const hits = Object.entries(fixture.job_durations || {}).filter(([k]) => k === d.fixture || k.startsWith(d.fixture));
  if (!hits.length) return NaN;
  const sum = hits.reduce((a, [, v]) => a + v.median_minutes, 0);
  return Math.round((d.github_shards > 1 ? sum : sum / hits.length) * 100) / 100;
}

// ---------- render, check, gate ----------
export function renderAll(config) {
  const out = {};
  for (const [repoKey, r] of Object.entries(config.repositories)) {
    out[r.output] = renderYaml(buildPipeline(config, repoKey), [
      `GENERATED by scripts/eng/pipeline-gen.mjs from ${SERVICES_FILE} (VTID-05550, plan agentic-delivery §3.3). Do not edit:`,
      'change the service list and run `node scripts/eng/pipeline-gen.mjs`; `--check` exits 3 on drift.',
      `Project ${r.gitlab_project}. M2's settings sync copies infra/gitlab-engineering/ci/*.yml into ${config.ci_config.project}.`,
      'T1 merge-request checks (governance first, path-selected checks, gate) · T2 main delivery · T3 nightly · T4 preview · T7 assist.',
    ]);
  }
  return out;
}

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

export async function main(argv = process.argv.slice(2), io = { log: (l) => console.log(l) }) {
  const root = arg(argv, '--root') || DEFAULT_ROOT;
  if (argv[0] === 'gate') {
    const config = loadServices(root);
    const repoKey = arg(argv, '--repo');
    const base = arg(argv, '--base');
    const head = arg(argv, '--head');
    const ranDir = arg(argv, '--ran-dir');
    const repoRoot = arg(argv, '--repo-root') || process.cwd();
    if (!repoKey || !base || !head || !ranDir) { io.log('gate: --repo, --base, --head and --ran-dir are required'); return 2; }
    let files;
    try { files = execFileSync('git', ['-C', repoRoot, 'diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) { io.log(`gate: cannot diff ${base}...${head}: ${e.message}`); return 1; }
    const ran = existsSync(ranDir) ? readdirSync(ranDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(ranDir, f), 'utf8')).check) : [];
    const v = gateVerdict(config, repoKey, files, ran);
    io.log(v.message);
    return v.ok ? 0 : 1;
  }
  const check = argv.includes('--check');
  const config = loadServices(root);
  const rendered = renderAll(config);
  let drift = 0;
  for (const [file, text] of Object.entries(rendered)) {
    const abs = path.join(root, file);
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (current === text) { io.log(`ok      ${file}`); continue; }
    if (check) { drift += 1; io.log(`drift   ${file}: differs from ${SERVICES_FILE}; run node scripts/eng/pipeline-gen.mjs`); continue; }
    writeFileSync(abs, text);
    io.log(`written ${file}`);
  }
  return check && drift ? 3 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.stack || e.message); process.exitCode = 1; });
}
