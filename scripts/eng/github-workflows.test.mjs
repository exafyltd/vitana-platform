// Tests of scripts/eng/github-workflows.json (plan agentic-delivery section 2.2, lane cutover, VTID-05545): every GitHub workflow of
// both repositories has exactly one action at the cut, `disable` or `keep`, and the list obeys the rules of the plan:
//   - the platform half is compared with .github/workflows on this tree, file by file (a new workflow cannot slip through unclassified);
//   - the vitana-v1 half is compared with the vitana-v1 checkout when VITANA_V1_WORKFLOWS_DIR names one (`delivery-cutover.sh status`
//     fetches the 46 files and sets it); without it the recorded pin and the recorded triggers are checked;
//   - a kept workflow has no pull_request trigger except PLAN-SPAR (plan PRs) and MIGRATION-DRIFT-CHECK (path-filtered), never pushes
//     to main, and the only kept workflow that a push to main starts and that deploys production is DEPLOY-CLOUDFLARE-WORKERS.
// Dependency-free Node (node:test), so UNIT.yml runs it with no install. The checks live in lint(), so the negative controls can feed
// it a list or a file set that breaks one rule at a time and see that rule's message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const LIST_FILE = path.join(HERE, 'github-workflows.json');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const PROTECTED_FILE = path.join(ROOT, 'scripts', 'collab', 'protected-gate-files.json');
const V1_DIR = process.env.VITANA_V1_WORKFLOWS_DIR || null;
const clone = (v) => JSON.parse(JSON.stringify(v));
const readList = () => JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));

// ── a small reader for the `on:` block of a workflow (no YAML parser: UNIT.yml installs nothing) ─────────────────────────────────
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const noComment = (l) => l.replace(/\s+#.*$/, '');
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
/** The names of the triggers, and for `push` its branches and paths (null = no filter). */
export function parseOn(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^(?:"on"|'on'|on)\s*:/.test(l));
  if (at < 0) throw new Error('no top-level on: block');
  const rest = noComment(lines[at].replace(/^(?:"on"|'on'|on)\s*:/, '')).trim();
  const res = { names: [], push: null, pullRequestPaths: false };
  if (rest) {
    const inner = /^[[{]/.test(rest) ? rest.slice(1, rest.lastIndexOf(rest[0] === '[' ? ']' : '}')) : rest;
    for (const part of splitTop(inner)) {
      const name = unquote(part.split(':')[0]);
      if (name) res.names.push(name);
      if (name === 'push') res.push = { branches: null, paths: null };
    }
    res.names.sort();
    return res;
  }
  const block = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) break;
    block.push(lines[i]);
  }
  const live = block.filter((l) => l.trim() && !/^\s*#/.test(l));
  const base = Math.min(...live.map((l) => l.match(/^ */)[0].length));
  const keyRe = new RegExp(`^ {${base}}([A-Za-z_][A-Za-z0-9_-]*)\\s*:\\s*(.*)$`);
  const subOf = (k) => {
    const i = block.findIndex((l) => { const m = keyRe.exec(l); return m && m[1] === k; });
    const sub = [];
    for (let j = i + 1; j < block.length; j += 1) {
      if (keyRe.test(block[j])) break;
      sub.push(block[j]);
    }
    return sub;
  };
  const listOf = (sub, key) => {
    const i = sub.findIndex((l) => new RegExp(`^\\s+${key}\\s*:`).test(l));
    if (i < 0) return null;
    const inline = noComment(sub[i].replace(new RegExp(`^\\s+${key}\\s*:`), '')).trim();
    if (inline.startsWith('[')) return splitTop(inline.slice(1, inline.lastIndexOf(']'))).map(unquote);
    const indent = sub[i].match(/^ */)[0].length;
    const items = [];
    for (let j = i + 1; j < sub.length; j += 1) {
      const m = /^(\s*)-\s+(.*)$/.exec(sub[j]);
      if (m && m[1].length > indent) items.push(unquote(noComment(m[2])));
      else if (sub[j].trim() && !/^\s*#/.test(sub[j])) break;
    }
    return items;
  };
  for (const l of block) {
    const m = keyRe.exec(l);
    if (m) res.names.push(m[1]);
  }
  if (res.names.includes('push')) { const sub = subOf('push'); res.push = { branches: listOf(sub, 'branches'), paths: listOf(sub, 'paths') }; }
  if (res.names.includes('pull_request')) { const sub = subOf('pull_request'); res.pullRequestPaths = Boolean(listOf(sub, 'paths') ?? listOf(sub, 'paths-ignore')); }
  res.names.sort();
  return res;
}
const matchesMain = (patterns) => !patterns || patterns.some((p) => p === 'main' || p === '**' || p === '*');
export const startsOnMainPush = (on) => Boolean(on.push) && matchesMain(on.push.branches);

// what a kept workflow must not do (text rules; they read the workflow file, so they run where the file is available)
// a push to main, written out, or to the dispatched ref (github.ref_name is main when the Command Hub dispatches a workflow on main)
const PUSH_TO_MAIN = /^\s*[^#\n]*\bgit\s+(?:-C\s+\S+\s+)?push\b[^\n]*(?:\bmain\b|HEAD:refs\/heads\/main\b|\$\{\{\s*github\.ref_name\s*\}\})/m;
const PUSH_TO_MAIN_WRITTEN = /^\s*[^#\n]*\bgit\s+(?:-C\s+\S+\s+)?push\b[^\n]*(?:\bmain\b|HEAD:refs\/heads\/main\b)/m;
// a kept workflow may push to its dispatched ref only when its entry records it (pushes_dispatched_ref with a note); never to main written out
export const pushesToMain = (text, e) => API_WRITE_TO_MAIN.test(text) || PUSH_TO_MAIN_WRITTEN.test(text) || (PUSH_TO_MAIN.test(text) && e?.pushes_dispatched_ref !== true);
const API_WRITE_TO_MAIN = /^\s*[^#\n]*(?:-X\s+PUT|--method\s+PUT)[^\n]*\/contents\/[^\n]*\bmain\b/m;
const PRODUCTION_DEPLOY = /ecs\s+update-service|deploy-task-definition|register-task-definition|\bwrangler\b|supabase\s+functions\s+deploy|supabase\s+db\s+push|cloudfront\s+create-invalidation/i;

export const FAMILIES = {
  disable: ['pr-checks', 'staging-deploy-verify', 'preview', 'i18n-propagate', 'dead'],
  keep: ['plan-sparring', 'prod-publish', 'ops-dispatch', 'scheduled-ops', 'cloudflare-workers', 'i18n-dispatch', 'supabase-ops'],
};
const GITLAB_TARGETS = ['T1', 'T2', 'T3', 'T4', 'T7', 'none'];
const MAIN_PUSH = ['none', 'reads', 'frozen', 'deploys-production'];
const DISPATCH = new Set(['workflow_dispatch', 'repository_dispatch', 'workflow_call']);
const PR_EXCEPTIONS = { 'vitana-platform': { 'PLAN-SPAR.yml': 'plan-prs', 'MIGRATION-DRIFT-CHECK.yml': 'path-filtered' }, 'vitana-v1': {} };
const REPOS = ['vitana-platform', 'vitana-v1'];

/** globToRegex as scripts/collab/queue.mjs does it for the protected list: * stays inside a path segment, ** crosses them. */
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);

/**
 * Every rule of the list. `files` is { repo: { name: text } | null }: the workflow files that are available (null = not available, only
 * the recorded fields are checked). `protectedGlobs` are the globs of scripts/collab/protected-gate-files.json. Returns problem strings.
 */
export function lint(doc, files, protectedGlobs) {
  const bad = [];
  const protectedRe = protectedGlobs.map(globRe);
  if (doc.schema !== 'vitana.github-workflows/v1') bad.push(`schema is ${doc.schema}`);
  if (!/^[0-9a-f]{40}$/.test(doc.v1_pinned_commit ?? '')) bad.push('v1_pinned_commit is not a 40-character commit');
  for (const repo of REPOS) {
    const R = doc.repositories?.[repo];
    if (!R) { bad.push(`${repo}: missing`); continue; }
    const names = Object.keys(R.workflows ?? {});
    const present = files[repo];
    if (present) {
      for (const f of Object.keys(present)) if (!R.workflows[f]) bad.push(`${repo}/${f}: a workflow file with no action in the list (classify it as disable or keep)`);
      for (const f of names) if (!(f in present)) bad.push(`${repo}/${f}: listed, but there is no such workflow file`);
    }
    let deploysProduction = 0;
    for (const f of names) {
      const e = R.workflows[f];
      const id = `${repo}/${f}`;
      if (e.action !== 'disable' && e.action !== 'keep') { bad.push(`${id}: action must be disable or keep (got ${JSON.stringify(e.action)})`); continue; }
      if (!FAMILIES[e.action].includes(e.family)) bad.push(`${id}: family ${JSON.stringify(e.family)} is not a ${e.action} family of plan section 2.2`);
      if (!Array.isArray(e.triggers) || e.triggers.length === 0) bad.push(`${id}: no recorded triggers`);
      if (typeof e.push_main !== 'boolean') bad.push(`${id}: push_main must be true or false`);
      const isProtected = protectedRe.some((re) => re.test(`.github/workflows/${f}`));
      if (repo === 'vitana-platform' && isProtected !== (e.protected === true)) bad.push(`${id}: protected is ${e.protected === true}, but scripts/collab/protected-gate-files.json says ${isProtected}`);
      if (e.action === 'disable') {
        if (!GITLAB_TARGETS.includes(e.gitlab)) bad.push(`${id}: gitlab must be one of ${GITLAB_TARGETS.join(', ')}`);
      } else {
        if (!MAIN_PUSH.includes(e.main_push)) bad.push(`${id}: main_push must be one of ${MAIN_PUSH.join(', ')}`);
        if (typeof e.dispatch_only !== 'boolean') bad.push(`${id}: dispatch_only must be true or false`);
        if (e.pushes_dispatched_ref !== undefined && (e.pushes_dispatched_ref !== true || typeof e.note !== 'string' || !e.note)) bad.push(`${id}: pushes_dispatched_ref must be true and come with a note`);
        if (typeof e.after_cut !== 'string' || !e.after_cut) bad.push(`${id}: after_cut is missing`);
        const pr = (e.triggers ?? []).filter((t) => t === 'pull_request' || t === 'pull_request_target');
        if (pr.length && (PR_EXCEPTIONS[repo][f] === undefined || PR_EXCEPTIONS[repo][f] !== e.pull_request)) bad.push(`${id}: a kept workflow runs on a pull request (${pr.join(', ')}); only PLAN-SPAR (plan PRs) and the path-filtered MIGRATION-DRIFT-CHECK may`);
        if (!pr.length && e.pull_request !== undefined) bad.push(`${id}: pull_request is recorded, but no pull request trigger is`);
        if (e.push_main !== (e.main_push !== 'none')) bad.push(`${id}: main_push ${e.main_push} does not agree with push_main ${e.push_main} (a push to main ${e.push_main ? 'starts' : 'does not start'} it)`);
        if (e.dispatch_only === true && (e.triggers ?? []).some((t) => !DISPATCH.has(t))) bad.push(`${id}: dispatch_only is true, but it also runs on ${(e.triggers ?? []).filter((t) => !DISPATCH.has(t)).join(', ')}`);
        if (e.main_push === 'deploys-production') {
          deploysProduction += 1;
          if (f !== 'DEPLOY-CLOUDFLARE-WORKERS.yml') bad.push(`${id}: a push to main starts it and it deploys production; the only such kept workflow is DEPLOY-CLOUDFLARE-WORKERS (plan section 3.13, 4)`);
        }
        const text = present?.[f];
        if (text !== undefined) {
          if (pushesToMain(text, e)) bad.push(`${id}: a kept workflow pushes to main`);
          if (e.pushes_dispatched_ref === true && !PUSH_TO_MAIN.test(text)) bad.push(`${id}: pushes_dispatched_ref is recorded, but the file does not push to github.ref_name`);
          if (e.main_push === 'reads' && PRODUCTION_DEPLOY.test(text)) bad.push(`${id}: a push to main starts it and it looks like a production deploy, but main_push says reads`);
          if (e.main_push === 'frozen' && !(/\bcutover_gate\b/.test(text) && /needs:\s*cutover_gate/.test(text) && /frozen/.test(text))) bad.push(`${id}: main_push says frozen, but the file has no cutover_gate that the deploy job needs`);
          if (e.main_push === 'deploys-production') {
            const on = parseOn(text);
            if (!on.push?.paths?.includes('cloudflare/**')) bad.push(`${id}: its push to main must be filtered to cloudflare/**`);
            if (!PRODUCTION_DEPLOY.test(text)) bad.push(`${id}: classified as deploying production, but the file shows no deploy command`);
          }
        }
      }
      const text = present?.[f];
      if (text !== undefined) {
        let on;
        try { on = parseOn(text); } catch (err) { bad.push(`${id}: ${err.message}`); continue; }
        if (JSON.stringify(on.names) !== JSON.stringify([...(e.triggers ?? [])].sort())) bad.push(`${id}: the file runs on ${on.names.join(', ')}, the list records ${(e.triggers ?? []).join(', ')} (a trigger changed: classify it again)`);
        if (startsOnMainPush(on) !== e.push_main) bad.push(`${id}: push_main is recorded as ${e.push_main}, the file says ${startsOnMainPush(on)}`);
        if (e.pull_request === 'path-filtered' && !on.pullRequestPaths) bad.push(`${id}: recorded as path-filtered, but its pull_request trigger has no paths filter`);
      }
    }
    if (deploysProduction > 1) bad.push(`${repo}: ${deploysProduction} kept workflows deploy production on a push to main`);
  }
  return bad;
}

const protectedGlobs = () => JSON.parse(fs.readFileSync(PROTECTED_FILE, 'utf8')).globs;
const readDir = (dir) => Object.fromEntries(fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
const realFiles = () => ({ 'vitana-platform': readDir(WF_DIR), 'vitana-v1': V1_DIR ? readDir(V1_DIR) : null });
const wfs = (doc, repo) => doc.repositories[repo].workflows;
const namesOf = (doc, repo, action) => Object.entries(wfs(doc, repo)).filter(([, e]) => e.action === action).map(([f]) => f).sort();
const countBy = (doc, repo, action, key) => Object.entries(wfs(doc, repo)).filter(([, e]) => e.action === action).reduce((a, [, e]) => ({ ...a, [e[key]]: (a[e[key]] ?? 0) + 1 }), {});

// ═════════════════════════════════════════ the list against the tree and the rules ═════════════════════════════════════════════════
test('list: 160 workflow files of both repositories (114 platform, 46 vitana-v1), each with exactly one action, disable or keep, and a recorded pin for vitana-v1', () => {
  const doc = readList();
  assert.equal(Object.keys(wfs(doc, 'vitana-platform')).length, 114);
  assert.equal(Object.keys(wfs(doc, 'vitana-v1')).length, 46);
  for (const repo of REPOS) for (const [f, e] of Object.entries(wfs(doc, repo))) assert.ok(e.action === 'disable' || e.action === 'keep', `${repo}/${f}: ${e.action}`);
  assert.match(doc.v1_pinned_commit, /^[0-9a-f]{40}$/);
  assert.equal(doc.repositories['vitana-platform'].github, 'exafyltd/vitana-platform');
  assert.equal(doc.repositories['vitana-v1'].github, 'exafyltd/vitana-v1');
});

test('list: the platform entries are exactly the files of .github/workflows on this tree, and the recorded triggers match the files (a new workflow or trigger cannot slip through unclassified)', () => {
  const files = realFiles();
  assert.equal(Object.keys(files['vitana-platform']).length, 114, 'the tree has the 114 workflows (plan section 2.2 counted 113; SQL-LIVE-ROOM-COHOST.yml, VTID-05558, came after it)');
  const problems = lint(readList(), { 'vitana-platform': files['vitana-platform'], 'vitana-v1': null }, protectedGlobs());
  assert.deepEqual(problems, []);
});

test('list: the vitana-v1 entries are exactly the files of the vitana-v1 checkout when VITANA_V1_WORKFLOWS_DIR names one; the full rules pass on both halves', () => {
  const doc = readList();
  const files = realFiles();
  if (V1_DIR) {
    assert.equal(Object.keys(files['vitana-v1']).length, Object.keys(wfs(doc, 'vitana-v1')).length, `${V1_DIR} holds the same number of workflows as the list`);
    assert.deepEqual(lint(doc, files, protectedGlobs()), [], 'platform and vitana-v1 files agree with the list');
  } else {
    // CI of this repository has no vitana-v1 checkout: the recorded half is checked, `delivery-cutover.sh status` runs this file again with the files
    assert.deepEqual(lint(doc, { 'vitana-platform': files['vitana-platform'], 'vitana-v1': null }, protectedGlobs()), []);
    assert.equal(Object.keys(wfs(doc, 'vitana-v1')).length, 46);
  }
});

test('plan 2.2: the disabled workflows are the ones of the table, family by family (71 of 160), and nothing else is disabled', () => {
  const doc = readList();
  const platformSql = Object.keys(wfs(doc, 'vitana-platform')).filter((f) => f.startsWith('SQL-'));
  assert.equal(platformSql.length, 22, 'SQL-* (22; SQL-LIVE-ROOM-COHOST.yml came after the plan)');
  const platformDisabled = [
    'PR-GATE', 'UNIT', 'TEST-SUITE', 'CICDL-CORE-LINT-SERVICES', 'CICDL-CORE-OPENAPI-ENFORCE', 'CICDL-GATEWAY-CI', 'OASIS-PERSISTENCE', 'VALIDATOR-CHECK', 'COMMAND-HUB-GUARDRAILS', 'CI-SCRIPTS-TEST',
    'AURORA-I18N-INTEGRATION', 'AURORA-PRIVILEGE-PARITY-UNIT', 'VOICE-PIPELINE-PARITY-SCANNER', 'VOICE-TOOLS-MANIFEST-RECONCILE', 'ORB-TOOLS-LIFT-SCANNER', 'CALENDAR-REGRESSION', 'DEV-AUTOPILOT-IMPACT',
    'VCAOP-GUARDRAILS-CI', 'STAGING-TESTS-REQUIRED', 'ENFORCE-FRONTEND-CANONICAL-SOURCE', 'PHASE-2B-NAMING-ENFORCEMENT', 'PHASE-2B-DOC-GATE',
    'AWS-STAGE-DEPLOY-ERP-BRIDGE', 'AWS-STAGE-DEPLOY-GATEWAY', 'AWS-STAGE-DEPLOY-KIRO-RUNNER', 'AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY', 'STAGING-VERIFY', 'STAGING-VERIFY-NIGHTLY', 'VTID-AUTO-CLOSE', 'TEST-SUITE-RERUN',
    'AUTO-DEPLOY', 'VTID-02409-BOOTSTRAP', 'VCAOP-CICD',
  ].map((n) => `${n}.yml`);
  assert.deepEqual(namesOf(doc, 'vitana-platform', 'disable'), [...platformDisabled, ...platformSql].sort());
  assert.equal(namesOf(doc, 'vitana-platform', 'disable').length, 55);
  const v1Disabled = ['PR-GATE', 'UNIT-TESTS', 'STAGING-TESTS-REQUIRED', 'i18n-check', 'CALENDAR-REGRESSION', 'NATIVE-CI', 'SQL-CALENDAR-ENTRY-SHARE', 'SQL-EVENT-SHARE-POSTS', 'SQL-GROUP-PARTICIPANTS', 'SQL-THREAD-JOIN-HARDENING',
    'AWS-STAGE-DEPLOY-FRONTEND', 'PREVIEW-DEPLOY-FRONTEND', 'PREVIEW-TEARDOWN-FRONTEND', 'E2E-PREVIEW-ORB', 'I18N-PROPAGATE', 'STAGE-DEPLOY-FRONTEND'].map((n) => `${n}.yml`);
  assert.deepEqual(namesOf(doc, 'vitana-v1', 'disable'), v1Disabled.sort());
  assert.deepEqual(countBy(doc, 'vitana-platform', 'disable', 'family'), { 'pr-checks': 44, 'staging-deploy-verify': 8, dead: 3 });
  assert.deepEqual(countBy(doc, 'vitana-v1', 'disable', 'family'), { 'pr-checks': 10, 'staging-deploy-verify': 1, preview: 3, 'i18n-propagate': 1, dead: 1 });
  for (const f of ['PLAN-SPAR.yml', 'PLAN-SPAR']) assert.ok(!namesOf(doc, 'vitana-platform', 'disable').includes(f), 'PLAN-SPAR stays on GitHub for plan PRs');
});

test('plan 2.2: the kept workflows are the families of the table (89 of 160): dispatch-only production and migration workflows, scheduled jobs, PLAN-SPAR, the Cloudflare Workers deploy', () => {
  const doc = readList();
  assert.deepEqual(countBy(doc, 'vitana-platform', 'keep', 'family'), { 'plan-sparring': 1, 'prod-publish': 10, 'ops-dispatch': 16, 'scheduled-ops': 31, 'cloudflare-workers': 1 });
  assert.deepEqual(countBy(doc, 'vitana-v1', 'keep', 'family'), { 'i18n-dispatch': 5, 'prod-publish': 2, 'supabase-ops': 23 });
  assert.equal(namesOf(doc, 'vitana-platform', 'keep').length + namesOf(doc, 'vitana-v1', 'keep').length, 89);
  const prod = Object.keys(wfs(doc, 'vitana-platform')).filter((f) => f.startsWith('AWS-PROD-DEPLOY-'));
  assert.equal(prod.length, 9, 'AWS-PROD-DEPLOY-* (9)');
  for (const f of [...prod, 'VISUAL-VERIFY-FRONTEND.yml']) assert.equal(wfs(doc, 'vitana-platform')[f].dispatch_only, true, `${f}: dispatch only (PUBLISH)`);
  assert.equal(wfs(doc, 'vitana-v1')['AWS-PROD-DEPLOY-FRONTEND.yml'].dispatch_only, true);
  assert.equal(Object.keys(wfs(doc, 'vitana-v1')).filter((f) => f.startsWith('apply-')).length, 21, 'apply-*-migration (21)');
  for (const f of Object.keys(wfs(doc, 'vitana-v1')).filter((x) => x.startsWith('apply-'))) assert.equal(wfs(doc, 'vitana-v1')[f].action, 'keep', `${f}: owner-approved migration, stays`);
});

test('kept workflows: only PLAN-SPAR (plan PRs) and the path-filtered MIGRATION-DRIFT-CHECK run on a pull request; nothing else that runs on a pull request is kept', () => {
  const doc = readList();
  const files = realFiles();
  for (const repo of REPOS) {
    for (const [f, e] of Object.entries(wfs(doc, repo))) {
      const onPr = e.triggers.some((t) => t === 'pull_request' || t === 'pull_request_target');
      if (e.action === 'keep') assert.equal(onPr, Boolean(PR_EXCEPTIONS[repo][f]), `${repo}/${f}`);
    }
  }
  const drift = parseOn(files['vitana-platform']['MIGRATION-DRIFT-CHECK.yml']);
  assert.ok(drift.pullRequestPaths, 'MIGRATION-DRIFT-CHECK is path-filtered');
  assert.deepEqual(parseOn(files['vitana-platform']['PLAN-SPAR.yml']).names, ['pull_request_target']);
});

test('kept workflows: none pushes to main, and the only one that a push to main starts and that deploys production is DEPLOY-CLOUDFLARE-WORKERS with its cloudflare/** filter', () => {
  const doc = readList();
  const files = realFiles();
  const startedByMain = [];
  for (const repo of REPOS) {
    for (const [f, e] of Object.entries(wfs(doc, repo))) {
      if (e.action === 'keep' && e.push_main) startedByMain.push(`${repo}/${f}:${e.main_push}`);
    }
  }
  assert.deepEqual(startedByMain.sort(), [
    'vitana-platform/CODEINTEL-INDEX.yml:reads', 'vitana-platform/DEPLOY-CLOUDFLARE-WORKERS.yml:deploys-production', 'vitana-platform/REGEN-SCREENS-CATALOG.yml:reads', 'vitana-platform/TEST-CATALOG.yml:reads',
    'vitana-v1/DEPLOY.yml:frozen', 'vitana-v1/SCREENS-CATALOG-TRIGGER.yml:reads', 'vitana-v1/WHATS-NEW-DRAFT.yml:reads', 'vitana-v1/supabase-functions-deploy.yml:frozen',
  ].sort(), 'the kept workflows a push to main starts');
  const on = parseOn(files['vitana-platform']['DEPLOY-CLOUDFLARE-WORKERS.yml']);
  assert.deepEqual(on.push.branches, ['main']);
  assert.ok(on.push.paths.includes('cloudflare/**'));
  for (const [f, text] of Object.entries(files['vitana-platform'])) {
    if (wfs(doc, 'vitana-platform')[f].action === 'keep') assert.equal(pushesToMain(text, wfs(doc, 'vitana-platform')[f]), false, `${f} does not push to main`);
  }
  assert.deepEqual(lint(doc, { 'vitana-platform': files['vitana-platform'], 'vitana-v1': files['vitana-v1'] }, protectedGlobs()).filter((p) => /pushes to main|deploys production|production deploy/.test(p)), []);
});

test('protected gate files: PR-GATE (both repositories), PLAN-SPAR and AWS-PROD-* are flagged, as scripts/collab/protected-gate-files.json says; PR-GATE is disabled on the owner command that names the plan', () => {
  const doc = readList();
  const flagged = (repo) => Object.entries(wfs(doc, repo)).filter(([, e]) => e.protected === true).map(([f]) => f).sort();
  assert.deepEqual(flagged('vitana-platform'), ['AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-KIRO-RUNNER.yml', 'AWS-PROD-DEPLOY-OASIS-OPERATOR.yml', 'AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml',
    'AWS-PROD-DEPLOY-ORB-AGENT.yml', 'AWS-PROD-DEPLOY-POSTGREST-AURORA-PROXY.yml', 'AWS-PROD-DEPLOY-REALTIME-AURORA.yml', 'AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml',
    'AWS-PROD-SETUP-POSTGREST-AURORA-PROXY-EDGE.yml', 'AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml', 'PLAN-SPAR.yml', 'PR-GATE.yml']);
  assert.deepEqual(flagged('vitana-v1'), ['AWS-PROD-DEPLOY-FRONTEND.yml', 'DEPLOY.yml', 'PR-GATE.yml']);
  for (const repo of REPOS) assert.equal(wfs(doc, repo)['PR-GATE.yml'].action, 'disable');
  assert.equal(wfs(doc, 'vitana-platform')['PLAN-SPAR.yml'].action, 'keep');
  for (const f of Object.keys(wfs(doc, 'vitana-platform')).filter((x) => x.startsWith('AWS-PROD-'))) assert.equal(wfs(doc, 'vitana-platform')[f].action, 'keep', `${f} stays`);
});

// ═════════════════════════════════════════ negative controls: one rule broken at a time ═════════════════════════════════════════════
const base = () => ({ doc: readList(), files: realFiles(), globs: protectedGlobs() });
const run = ({ doc, files, globs }) => lint(doc, { 'vitana-platform': files['vitana-platform'], 'vitana-v1': files['vitana-v1'] ?? null }, globs);
const CONTROLS = [
  ['a new workflow file nobody classified', (b) => { b.files['vitana-platform']['NEW-THING.yml'] = 'name: x\non:\n  workflow_dispatch:\n'; }, /NEW-THING\.yml: a workflow file with no action/],
  ['a listed workflow whose file is gone', (b) => { delete b.files['vitana-platform']['UNIT.yml']; }, /UNIT\.yml: listed, but there is no such workflow file/],
  ['an action that is neither disable nor keep', (b) => { b.doc.repositories['vitana-platform'].workflows['UNIT.yml'].action = 'maybe'; }, /UNIT\.yml: action must be disable or keep/],
  ['a kept workflow that gains a pull_request trigger', (b) => { b.files['vitana-platform']['CI-HEALTH.yml'] = b.files['vitana-platform']['CI-HEALTH.yml'].replace(/^on:/m, 'on:\n  pull_request:'); }, /CI-HEALTH\.yml: the file runs on .*pull_request/],
  ['a kept workflow recorded with a pull_request trigger', (b) => { b.doc.repositories['vitana-platform'].workflows['CI-HEALTH.yml'].triggers.push('pull_request'); }, /CI-HEALTH\.yml: a kept workflow runs on a pull request/],
  ['a kept workflow that pushes to main', (b) => { b.files['vitana-platform']['CI-HEALTH.yml'] += '\n      - run: git push origin HEAD:main\n'; }, /CI-HEALTH\.yml: a kept workflow pushes to main/],
  ['a kept workflow that writes main through the contents API', (b) => { b.files['vitana-platform']['CI-HEALTH.yml'] += '\n      - run: gh api -X PUT repos/o/r/contents/x -f branch=main\n'; }, /CI-HEALTH\.yml: a kept workflow pushes to main/],
  ['a kept workflow that a push to main starts, recorded as not started by it', (b) => { b.files['vitana-platform']['CI-HEALTH.yml'] = b.files['vitana-platform']['CI-HEALTH.yml'].replace(/^on:/m, 'on:\n  push:\n    branches: [main]'); }, /CI-HEALTH\.yml: the file runs on|CI-HEALTH\.yml: push_main is recorded as false/],
  ['a second kept workflow that deploys production on a push to main', (b) => { const e = b.doc.repositories['vitana-platform'].workflows['TEST-CATALOG.yml']; e.main_push = 'deploys-production'; }, /TEST-CATALOG\.yml: a push to main starts it and it deploys production; the only such kept workflow is DEPLOY-CLOUDFLARE-WORKERS/],
  ['a reads workflow that grows a production deploy command', (b) => { b.files['vitana-platform']['TEST-CATALOG.yml'] += '\n      - run: aws ecs update-service --cluster c --service s\n'; }, /TEST-CATALOG\.yml: a push to main starts it and it looks like a production deploy/],
  ['a frozen workflow that loses its cutover_gate', (b) => { b.doc.repositories['vitana-platform'].workflows['TEST-CATALOG.yml'].main_push = 'frozen'; }, /TEST-CATALOG\.yml: main_push says frozen/],
  ['the Cloudflare deploy loses its path filter', (b) => { b.files['vitana-platform']['DEPLOY-CLOUDFLARE-WORKERS.yml'] = b.files['vitana-platform']['DEPLOY-CLOUDFLARE-WORKERS.yml'].replace(/'cloudflare\/\*\*'/, "'docs/**'"); }, /DEPLOY-CLOUDFLARE-WORKERS\.yml: its push to main must be filtered to cloudflare\/\*\*/],
  ['a dispatch-only workflow that gets a schedule', (b) => { b.files['vitana-platform']['RUN-MIGRATION.yml'] = b.files['vitana-platform']['RUN-MIGRATION.yml'].replace(/^on:/m, 'on:\n  schedule:\n    - cron: "0 3 * * *"'); }, /RUN-MIGRATION\.yml: the file runs on/],
  ['dispatch_only claimed for a scheduled workflow', (b) => { b.doc.repositories['vitana-platform'].workflows['CI-HEALTH.yml'].dispatch_only = true; }, /CI-HEALTH\.yml: dispatch_only is true, but it also runs on schedule/],
  ['a protected gate file that is not flagged', (b) => { delete b.doc.repositories['vitana-platform'].workflows['PR-GATE.yml'].protected; }, /PR-GATE\.yml: protected is false, but scripts\/collab\/protected-gate-files\.json says true/],
  ['an unknown family', (b) => { b.doc.repositories['vitana-v1'].workflows['PR-GATE.yml'].family = 'other'; }, /vitana-v1\/PR-GATE\.yml: family "other"/],
  ['a disabled workflow without its GitLab target', (b) => { delete b.doc.repositories['vitana-v1'].workflows['PR-GATE.yml'].gitlab; }, /vitana-v1\/PR-GATE\.yml: gitlab must be one of/],
  ['a path-filtered claim for a pull_request trigger without paths', (b) => { b.files['vitana-platform']['MIGRATION-DRIFT-CHECK.yml'] = b.files['vitana-platform']['MIGRATION-DRIFT-CHECK.yml'].replace(/^(\s+)paths:/m, '$1xpaths:'); }, /MIGRATION-DRIFT-CHECK\.yml: recorded as path-filtered/],
];
test('negative controls: each rule of the list fails with its own message when it is the only thing broken, and the untouched list has no problem', () => {
  assert.deepEqual(run(base()), []);
  for (const [label, mutate, expected] of CONTROLS) {
    const b = clone(base());
    mutate(b);
    const problems = run(b);
    assert.ok(problems.some((p) => expected.test(p)), `${label}: expected ${expected}, got ${JSON.stringify(problems.slice(0, 4))}`);
  }
});

test('on: reader: block, inline list, inline map, quoted key, branch and path lists in both YAML list styles', () => {
  assert.deepEqual(parseOn('name: x\non: [pull_request]\njobs: {}\n').names, ['pull_request']);
  assert.deepEqual(parseOn('name: x\non: { pull_request: {} }\n').names, ['pull_request']);
  assert.deepEqual(parseOn('on: workflow_dispatch\n').names, ['workflow_dispatch']);
  assert.deepEqual(parseOn('"on":\n  workflow_dispatch:\n  schedule:\n    - cron: "1 2 * * *"\n').names, ['schedule', 'workflow_dispatch']);
  const a = parseOn('on:\n  push:\n    branches: [ main, "release/**" ]\n    paths:\n      - \'a/**\'\n      - b/*.js # c\n  pull_request:\n    paths-ignore:\n      - docs/**\njobs: {}\n');
  assert.deepEqual(a.push, { branches: ['main', 'release/**'], paths: ['a/**', 'b/*.js'] });
  assert.equal(a.pullRequestPaths, true);
  assert.equal(startsOnMainPush(a), true);
  assert.equal(startsOnMainPush(parseOn('on:\n  push:\n    branches:\n      - kiro/**\n')), false);
  assert.equal(startsOnMainPush(parseOn('on:\n  push:\n')), true, 'a push trigger without a branch filter starts on main too');
  assert.throws(() => parseOn('name: no triggers\n'), /no top-level on/);
});

test('kept workflows: a push to the dispatched ref (github.ref_name) counts as a push to main unless the entry records it; the three i18n workflows record it with a note', () => {
  const doc = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  const marked = Object.entries(doc.repositories['vitana-v1'].workflows).filter(([, e]) => e.pushes_dispatched_ref === true).map(([f]) => f).sort();
  assert.deepEqual(marked, ['i18n-audit-llm.yml', 'i18n-long-words.yml', 'i18n-translate.yml']);
  for (const f of marked) {
    const e = doc.repositories['vitana-v1'].workflows[f];
    assert.equal(e.action, 'keep', `${f} keeps its action`);
    assert.match(e.note, /refuses after cut step 1/);
  }
  const ref = '      - run: |\n          if git push origin HEAD:${{ github.ref_name }}; then echo ok; fi\n';
  assert.equal(PUSH_TO_MAIN.test(ref), true, 'github.ref_name is caught');
  assert.equal(pushesToMain(ref, {}), true, 'an entry that does not record it fails');
  assert.equal(pushesToMain(ref, { pushes_dispatched_ref: true }), false, 'a recorded one passes');
  assert.equal(pushesToMain('      - run: git push origin HEAD:main\n', { pushes_dispatched_ref: true }), true, 'main written out never passes');
  assert.equal(pushesToMain('      - run: git push origin "HEAD:$BRANCH"\n', {}), false, 'another branch is not main');
  const e = { ...doc.repositories['vitana-v1'].workflows['i18n-translate.yml'] };
  delete e.note;
  const broken = JSON.parse(JSON.stringify(doc));
  broken.repositories['vitana-v1'].workflows['i18n-translate.yml'] = e;
  assert.ok(lint(broken, {}, protectedGlobs()).some((x) => /i18n-translate\.yml: pushes_dispatched_ref must be true and come with a note/.test(x)));
  const plain = JSON.parse(JSON.stringify(doc));
  delete plain.repositories['vitana-v1'].workflows['i18n-translate.yml'].pushes_dispatched_ref;
  assert.ok(lint(plain, { 'vitana-v1': { 'i18n-translate.yml': ref } }, protectedGlobs()).some((x) => /vitana-v1\/i18n-translate\.yml: a kept workflow pushes to main/.test(x)));
});
