// VTID-05550 (plan agentic-delivery §3.3, §3.4, §3.6, §3.9, T3; lane pipelines): the generated GitLab pipelines.
// Dependency-free node:test (UNIT.yml runs scripts/**/*.test.mjs with no install).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODULE = process.env.PIPELINE_GEN_MODULE || path.join(ROOT, 'scripts/eng/pipeline-gen.mjs');
const gen = await import(pathToFileURL(MODULE).href);
const CI = path.join(ROOT, 'infra/gitlab-engineering/ci');
const config = () => gen.loadServices(ROOT);
const REPOS = ['vitana-v1', 'vitana-platform'];
const TEMPLATES = ['tpl-checks.yml', 'tpl-main.yml', 'tpl-nightly.yml', 'tpl-assist.yml'];

const MR = (files, extra = {}) => ({ variables: { CI_PIPELINE_SOURCE: 'merge_request_event', CI_COMMIT_REF_NAME: 'kiro/x/y', CI_DEFAULT_BRANCH: 'main', ...extra }, changes: files });
const MAIN = (extra = {}) => ({ variables: { CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: 'main', CI_COMMIT_REF_NAME: 'main', CI_DEFAULT_BRANCH: 'main', ...extra }, changes: null });
const NIGHTLY = (extra = {}) => ({ variables: { CI_PIPELINE_SOURCE: 'schedule', CI_COMMIT_BRANCH: 'main', CI_COMMIT_REF_NAME: 'main', CI_DEFAULT_BRANCH: 'main', DELIVERY_SCHEDULE: 'nightly', ...extra }, changes: null });
const ASSIST = (extra = {}) => ({ variables: { CI_PIPELINE_SOURCE: 'api', CI_COMMIT_BRANCH: 'assist/12-i18n-propagate', CI_COMMIT_REF_NAME: 'assist/12-i18n-propagate', CI_DEFAULT_BRANCH: 'main', ...extra }, changes: null });

function docsFor(repo) {
  const cfg = config();
  const generated = gen.parseYaml(readFileSync(path.join(ROOT, cfg.repositories[repo].output), 'utf8'));
  const templates = TEMPLATES.map((t) => gen.parseYaml(readFileSync(path.join(CI, t), 'utf8')));
  return { cfg, generated, templates, all: [...templates, generated] };
}
const jobsIn = (repo, ctx) => { const d = docsFor(repo); return gen.evaluatePipeline(d.all, ctx); };
const checkNames = (repo) => Object.keys(config().repositories[repo].checks);

test('renders both project files from the service list, byte for byte', () => {
  const rendered = gen.renderAll(config());
  assert.deepEqual(Object.keys(rendered).sort(), ['infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml', 'infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml']);
  for (const [file, text] of Object.entries(rendered)) assert.equal(readFileSync(path.join(ROOT, file), 'utf8'), text, `${file} is stale: run node scripts/eng/pipeline-gen.mjs`);
});

test('--check exits 0 when the files are current and 3 on drift, and writes nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pipeline-gen-'));
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  cpSync(path.join(ROOT, 'config/delivery'), path.join(dir, 'config/delivery'), { recursive: true });
  mkdirSync(path.join(dir, 'infra/gitlab-engineering'), { recursive: true });
  cpSync(CI, path.join(dir, 'infra/gitlab-engineering/ci'), { recursive: true });
  const out = [];
  assert.equal(await gen.main(['--check', '--root', dir], { log: (l) => out.push(l) }), 0);
  const f = path.join(dir, 'infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml');
  writeFileSync(f, readFileSync(f, 'utf8').replace('vitest', 'vitest-x'));
  const before = readFileSync(f, 'utf8');
  assert.equal(await gen.main(['--check', '--root', dir], { log: (l) => out.push(l) }), 3);
  assert.equal(readFileSync(f, 'utf8'), before, '--check must not rewrite the file');
  assert.ok(out.some((l) => /drift/i.test(l) && /v1-delivery/.test(l)), out.join('\n'));
});

test('GitLab glob semantics: dir/**/* is recursive, a trailing ** is one level, braces and dotfiles match', () => {
  assert.equal(gen.matchGlob('src/**/*', 'src/a/b/c.ts'), true);
  assert.equal(gen.matchGlob('src/**/*', 'src/c.ts'), true);
  assert.equal(gen.matchGlob('src/**', 'src/a/b.ts'), false);
  assert.equal(gen.matchGlob('*.md', 'docs/a.md'), false);
  assert.equal(gen.matchGlob('**/*.md', 'README.md'), true);
  assert.equal(gen.matchGlob('*.{js,ts}', 'vite.config.ts'), true);
  assert.equal(gen.matchGlob('.env*', '.env.local'), true);
  assert.equal(gen.matchGlob('src/lib/*alendar*', 'src/lib/calendar-x.ts'), true);
  assert.equal(gen.matchGlob('src/lib/*alendar*', 'src/lib/x/calendar.ts'), false);
  for (const repo of REPOS) {
    const r = config().repositories[repo];
    const all = [...r.shared_paths, ...r.other_paths, ...r.docs_paths, ...Object.values(r.services).flatMap((s) => s.paths)];
    assert.deepEqual(all.filter((p) => /(^|\/)\*\*$/.test(p)), [], `${repo}: a trailing ** matches one level only in GitLab; write dir/**/*`);
  }
});

test('each T1 check job has rules: changes: from its service paths plus the shared and other paths', () => {
  for (const repo of REPOS) {
    const { cfg, generated } = docsFor(repo);
    const r = cfg.repositories[repo];
    for (const check of checkNames(repo)) {
      const job = generated[check];
      assert.ok(job, `${repo}: T1 job ${check} missing`);
      const expected = new Set([...r.shared_paths, ...r.other_paths]);
      for (const s of Object.values(r.services)) if (s.checks.includes(check)) for (const p of s.paths) expected.add(p);
      const rule = job.rules.find((x) => x.changes);
      assert.ok(rule, `${repo}: ${check} has no changes rule`);
      assert.deepEqual([...rule.changes.paths].sort(), [...expected].sort(), `${repo}: ${check}`);
      assert.equal(rule.changes.compare_to, 'refs/heads/main');
      assert.ok(rule.changes.paths.length <= cfg.max_changes_patterns, `${repo}: ${check} has ${rule.changes.paths.length} patterns; GitLab allows ${cfg.max_changes_patterns}`);
    }
  }
});

test('a shared path, or an area no single service owns, selects every check', () => {
  assert.deepEqual(gen.selectChecks(config(), 'vitana-v1', ['package-lock.json']).selected.sort(), checkNames('vitana-v1').sort());
  assert.deepEqual(gen.selectChecks(config(), 'vitana-v1', ['scripts/new-tool.mjs']).selected.sort(), checkNames('vitana-v1').sort());
  assert.deepEqual(gen.selectChecks(config(), 'vitana-platform', ['packages/openapi/x.ts']).selected.sort(), checkNames('vitana-platform').sort());
  assert.deepEqual(gen.selectChecks(config(), 'vitana-platform', ['Dockerfile']).selected.sort(), checkNames('vitana-platform').sort());
});

test('a change to one service selects only that service checks; a documentation-only change selects none', () => {
  const sql = gen.selectChecks(config(), 'vitana-v1', ['supabase/migrations/20990101000000_x.sql']);
  assert.deepEqual(sql.selected.sort(), ['migration-lint', 'sql-tests']);
  const docs = gen.selectChecks(config(), 'vitana-platform', ['docs/a.md', '.kiro/specs/x/lanes/y.md', 'CLAUDE.md']);
  assert.deepEqual(docs, { selected: [], unknown: [] });
  const jobs = Object.keys(jobsIn('vitana-platform', MR(['docs/a.md'])));
  assert.deepEqual(jobs.sort(), ['change-suite', 'collab-handoff', 'gate', 'lane-scope', 'pr-gate-report']);
  const gw = gen.selectChecks(config(), 'vitana-platform', ['services/gateway/src/routes/x.ts']).selected;
  assert.ok(gw.includes('gateway-jest') && gw.includes('gateway-typecheck'));
  assert.ok(!gw.includes('aurora-privilege-parity') && !gw.includes('sql-activity-tiers') && !gw.includes('phase-2b-doc-gate'), gw.join(','));
});

test('an unknown path makes gate fail and name it, so the merge request cannot land with fewer checks', () => {
  const sel = gen.selectChecks(config(), 'vitana-v1', ['newtopdir/x.txt']);
  assert.deepEqual(sel.unknown, ['newtopdir/x.txt']);
  const v = gen.gateVerdict(config(), 'vitana-v1', ['newtopdir/x.txt'], []);
  assert.equal(v.ok, false);
  assert.match(v.message, /newtopdir\/x\.txt/);
  const ok = gen.gateVerdict(config(), 'vitana-v1', ['supabase/migrations/a.sql'], ['migration-lint', 'sql-tests']);
  assert.equal(ok.ok, true, ok.message);
  const missing = gen.gateVerdict(config(), 'vitana-v1', ['supabase/migrations/a.sql'], ['sql-tests']);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /migration-lint/);
});

test('gate needs every check with optional: true and runs only when they passed', () => {
  for (const repo of REPOS) {
    const { generated } = docsFor(repo);
    const gate = generated.gate;
    const needs = Object.fromEntries(gate.needs.map((n) => [n.job, n]));
    for (const check of checkNames(repo)) {
      assert.ok(needs[check], `${repo}: gate does not need ${check}`);
      assert.equal(needs[check].optional, true, `${repo}: gate need ${check} is not optional`);
      assert.equal(needs[check].artifacts, true);
    }
    assert.notEqual(gate.when, 'always');
    assert.ok(gate.needs.length <= 50, `${repo}: gate needs ${gate.needs.length} jobs; GitLab's ci_max_needs default is 50`);
    for (const check of checkNames(repo)) assert.notEqual(generated[check].allow_failure, true, `${repo}: ${check} may not fail silently`);
  }
});

test('governance jobs carry no path rule, come first, and are the only jobs besides gate that always run', () => {
  for (const repo of REPOS) {
    const { generated } = docsFor(repo);
    assert.equal(generated.stages[0], 'governance');
    const names = Object.keys(generated).filter((k) => !['stages', 'variables', 'workflow', 'include', 'default'].includes(k));
    assert.deepEqual(names.slice(0, 4), ['lane-scope', 'change-suite', 'pr-gate-report', 'collab-handoff']);
    for (const g of ['lane-scope', 'change-suite', 'pr-gate-report', 'collab-handoff']) {
      assert.equal(generated[g].stage, 'governance');
      assert.ok(generated[g].rules.every((r) => !r.changes), `${repo}: ${g} has a path rule`);
    }
    assert.equal(generated['collab-handoff'].allow_failure === true, repo === 'vitana-v1', `${repo}: collab-handoff is ${repo === 'vitana-v1' ? 'report-only' : 'required'} as today`);
  }
});

test('no T1 job declares id_tokens or a secret, no file uses include: local, and T1 jobs are untrusted and interruptible', () => {
  const SECRETISH = /(TOKEN|SECRET|PASSWORD|_KEY|AWS_)/;
  for (const repo of REPOS) {
    const d = docsFor(repo);
    for (const doc of d.all) for (const inc of [].concat(doc.include || [])) assert.ok(!inc.local, `${repo}: include: local`);
    for (const ctx of [MR(['package.json']), { variables: { ...MR([]).variables, CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: 'train/1', CI_COMMIT_REF_NAME: 'train/1' }, changes: ['package.json'] }]) {
      const jobs = gen.evaluatePipeline(d.all, ctx);
      assert.ok(Object.keys(jobs).length > 5, `${repo}: no T1 jobs`);
      for (const [name, job] of Object.entries(jobs)) {
        assert.equal(job.id_tokens, undefined, `${repo}: ${name} declares id_tokens`);
        assert.equal(job.secrets, undefined, `${repo}: ${name} names a secret`);
        const text = JSON.stringify({ v: job.variables || {}, s: job.script || [], b: job.before_script || [] });
        for (const m of text.match(/\$\{?([A-Z][A-Z0-9_]*)/g) || []) {
          const v = m.replace(/^\$\{?/, '');
          if (v.startsWith('CI_') || v === 'PGPASSWORD') continue;
          assert.ok(!SECRETISH.test(v), `${repo}: ${name} reads ${v}`);
        }
        assert.deepEqual(job.tags, ['vitana-eng'], `${repo}: ${name} tags`);
        assert.equal(job.interruptible, true, `${repo}: ${name} is not interruptible`);
      }
    }
  }
});

test('every test job is sharded so its fixture duration is under 4 minutes', () => {
  for (const repo of REPOS) {
    const cfg = config();
    const r = cfg.repositories[repo];
    const fx = JSON.parse(readFileSync(path.join(ROOT, r.fixture), 'utf8'));
    for (const [name, c] of Object.entries(r.checks)) {
      if (c.kind !== 'test') continue;
      const minutes = gen.fixtureMinutes(c, fx);
      assert.ok(Number.isFinite(minutes) && minutes > 0, `${repo}: ${name} has no fixture duration`);
      const shards = (c.parallel || 1) * (c.duration?.split || 1);
      assert.ok(minutes / shards < cfg.max_check_minutes, `${repo}: ${name} takes ${minutes} min over ${shards} shard(s)`);
      if (c.parallel > 1) assert.equal(docsFor(repo).generated[name].parallel, c.parallel);
    }
  }
});

test('dependencies come from the cache keyed by the lockfile', () => {
  for (const repo of REPOS) {
    const d = docsFor(repo);
    const r = d.cfg.repositories[repo];
    for (const [name, c] of Object.entries(r.checks)) {
      const want = c.install ? r.install[c.install].lockfiles : c.install_cache?.lockfiles;
      if (!want) continue;
      const job = gen.resolveJob(d.all, name);
      assert.deepEqual(job.cache?.key?.files, want, `${repo}: ${name} cache key`);
      assert.ok(job.cache.paths.length > 0);
    }
  }
});

test('main pipelines run every check once, are not interruptible, and use the main and deploy classes', () => {
  const MAIN_CLASS = /^(full-suite:|preview-build:main$|staging-verify:|staging-verify-nightly:|assist:|e2e-preview-orb$)/;
  const DEPLOY_CLASS = /^(push-image:|deploy-staging:|rollback-staging:|record:|record-nightly:|vtid-close$|notify-platform$|preview-upload|preview-stop)/;
  for (const repo of REPOS) {
    for (const ctx of [MAIN({ DELIVERY_MODE: 'live' }), MAIN(), NIGHTLY({ DELIVERY_MODE: 'live' })]) {
      const jobs = jobsIn(repo, ctx);
      const full = Object.keys(jobs).filter((n) => n.startsWith('full-suite:')).map((n) => n.slice('full-suite:'.length));
      assert.deepEqual(full.sort(), checkNames(repo).sort(), `${repo}: full suite`);
      for (const [name, job] of Object.entries(jobs)) {
        assert.equal(job.interruptible, false, `${repo}: ${name} is interruptible on main`);
        if (MAIN_CLASS.test(name)) assert.deepEqual(job.tags, ['vitana-eng-main'], `${repo}: ${name}`);
        else if (/^build-image:/.test(name)) assert.deepEqual(job.tags, ['vitana-eng-build'], `${repo}: ${name} (build class, VTID-05671)`);
        else if (DEPLOY_CLASS.test(name)) assert.deepEqual(job.tags, ['vitana-eng-deploy'], `${repo}: ${name}`);
        else assert.fail(`${repo}: ${name} runs on main in no known class`);
      }
    }
    const live = jobsIn(repo, MAIN({ DELIVERY_MODE: 'live' }));
    for (const [svc, s] of Object.entries(config().repositories[repo].services)) {
      if (!s.image || !s.staging) continue;
      for (const j of ['build-image', 'push-image', 'deploy-staging', 'rollback-staging']) assert.ok(live[`${j}:${svc}`], `${repo}: ${j}:${svc}`);
      assert.deepEqual(live[`push-image:${svc}`].needs.map((n) => n.job), [`build-image:${svc}`]);
      assert.equal(live[`rollback-staging:${svc}`].when, 'on_failure');
      if (s.staging_verify) {
        assert.ok(live[`staging-verify:${svc}`] && live[`record:${svc}`], `${repo}: verify chain of ${svc}`);
        assert.equal(live[`staging-verify:${svc}`].variables.VERIFY_SERVICE, s.staging_verify);
      }
    }
  }
});

test('DELIVERY_MODE defaults to shadow; in shadow mode record, vtid-close, notify-platform and assists are absent and no env_overrides pass', () => {
  for (const repo of REPOS) {
    const { generated, all } = docsFor(repo);
    assert.equal(generated.variables.DELIVERY_MODE, 'shadow');
    for (const ctx of [MAIN(), NIGHTLY(), ASSIST(), MAIN({ DELIVERY_MODE: 'shadow' })]) {
      const jobs = gen.evaluatePipeline(all, ctx);
      for (const [name, job] of Object.entries(jobs)) {
        const ext = [].concat(job.extends || []);
        for (const banned of ['.record', '.vtid-close', '.notify-platform', '.assist']) assert.ok(!ext.includes(banned), `${repo}: ${name} (${banned}) runs in shadow mode`);
        assert.equal((job.variables || {}).DEPLOY_ENV_OVERRIDES, undefined, `${repo}: ${name} passes env_overrides in shadow mode`);
      }
    }
    const live = gen.evaluatePipeline(all, MAIN({ DELIVERY_MODE: 'live' }));
    assert.ok(live['vtid-close'], `${repo}: vtid-close in live mode`);
  }
  const live = jobsIn('vitana-platform', MAIN({ DELIVERY_MODE: 'live' }));
  assert.deepEqual(JSON.parse(live['deploy-staging:gateway'].variables.DEPLOY_ENV_OVERRIDES), { PM_AGENT_ENABLED: 'false', DELIVERY_HOST_VITANA_PLATFORM: 'gitlab', DELIVERY_HOST_VITANA_V1: 'gitlab' });
  const assist = jobsIn('vitana-v1', ASSIST({ DELIVERY_MODE: 'live', ASSIST_RULE: 'i18n-propagate' }));
  assert.deepEqual(Object.keys(assist), ['assist:i18n-propagate']);
  assert.deepEqual(assist['assist:i18n-propagate'].tags, ['vitana-eng-main']);
});

test('the generated files include the deploy and verify templates by the job names of plan §9', () => {
  for (const repo of REPOS) {
    const { generated } = docsFor(repo);
    const files = [].concat(generated.include).flatMap((i) => [].concat(i.file));
    for (const t of [...TEMPLATES, 'tpl-deploy.yml', 'tpl-verify.yml']) assert.ok(files.includes(t), `${repo}: include ${t}`);
    for (const i of [].concat(generated.include)) { assert.equal(i.project, 'vitana/ci-config'); assert.equal(i.ref, 'main'); }
    const used = new Set(Object.values(generated).filter((j) => j && typeof j === 'object').flatMap((j) => [].concat(j.extends || [])));
    for (const name of ['.build-image', '.push-image', '.deploy-staging', '.rollback-staging', '.staging-verify', '.staging-verify-nightly', '.record', '.vtid-close']) assert.ok(used.has(name), `${repo}: ${name} not used`);
  }
  const v1 = docsFor('vitana-v1').generated;
  for (const name of ['.notify-platform', '.preview-upload', '.preview-stop', '.assist']) assert.ok(Object.values(v1).some((j) => [].concat(j?.extends || []).includes(name)), `vitana-v1: ${name}`);
});

// Plan §2.2's table: one row per repository and workflow family, with what happens to it at the cut.
function planWorkflowRows() {
  const plan = readFileSync(path.join(ROOT, '.kiro/specs/agentic-delivery/plan.md'), 'utf8');
  const sec = plan.slice(plan.indexOf('### 2.2 '), plan.indexOf('### 2.3 '));
  return sec.split('\n').filter((l) => /^\| (v1|platform) \|/.test(l)).map((l) => {
    const cells = l.split('|').map((c) => c.trim());
    const families = cells[2].replace(/\([^)]*\)/g, '').split(',').map((f) => f.trim()).filter(Boolean);
    return { repo: cells[1], families, cut: cells[3] };
  });
}
const familyMatch = (fam, wf) => new RegExp(`^${fam.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(wf.replace(/\.ya?ml$/, ''));
// A moved workflow that keeps no job of its own is allowed only where plan §2.2 names what replaces it.
const REPLACED_BY = {
  retry: (all) => ['.t1-base', '.full-suite'].every((t) => [].concat(gen.resolveJob(all, t).retry?.when || []).includes('runner_system_failure')),
};

test('sibling sweep: every workflow has its plan §2.2 fate, and every moved workflow has its jobs in a generated file', () => {
  const rows = planWorkflowRows();
  assert.ok(rows.length >= 15, `plan §2.2 rows: ${rows.length}`);
  for (const repo of REPOS) {
    const { cfg, generated, all } = docsFor(repo);
    const reg = cfg.repositories[repo].github_workflows;
    const names = new Set(Object.keys(generated));
    for (const [wf, e] of Object.entries(reg)) {
      const row = rows.find((r) => r.repo === (repo === 'vitana-v1' ? 'v1' : 'platform') && r.families.some((f) => familyMatch(f, wf)));
      assert.ok(row, `${repo}: ${wf} is in no plan §2.2 row`);
      const moved = ['t1', 't2', 't3', 't4', 't7'].includes(e.fate);
      if (moved) assert.match(row.cut, new RegExp(`^disabled; .*\\bT${e.fate.slice(1)}\\b`), `${repo}: ${wf} is ${e.fate} here but "${row.cut}" in plan §2.2`);
      else if (e.fate === 'kept') assert.match(row.cut, /^kept/, `${repo}: ${wf} is kept here but "${row.cut}" in plan §2.2`);
      else if (e.fate === 'dead') assert.match(row.cut, /dead/, `${repo}: ${wf} is dead here but "${row.cut}" in plan §2.2`);
      else assert.fail(`${repo}: ${wf} has unknown fate ${e.fate}`);
      for (const j of [...e.jobs, ...(e.pr_jobs || [])]) assert.ok(names.has(j), `${repo}: ${wf} → ${j} is not in ${cfg.repositories[repo].output}`);
      if (moved && e.jobs.length === 0) {
        assert.ok(REPLACED_BY[e.replaced_by], `${repo}: ${wf} (${e.fate}) maps to no job and names no replacement that plan §2.2 gives`);
        assert.ok(REPLACED_BY[e.replaced_by](all), `${repo}: ${wf}: the templates lack the ${e.replaced_by} that replaces it`);
      }
    }
  }
});

// ---------- review round 1 (agent:vitana-lane-reviewer on e2c50732): jobs that can pass on GitLab ----------
// The first word of every simple command in a script line (keywords, VAR=value prefixes and paths dropped).
const TRACKED = new Set(['jq', 'node', 'npm', 'npx', 'pnpm', 'psql', 'pg_isready', 'python3', 'java', 'gradlew', 'spectral', 'git', 'curl', 'gh']);
const NEEDS = { gradlew: ['java', 'android-sdk'] };
function commandsOf(line) {
  const out = [];
  for (let seg of line.replace(/'[^']*'/g, "''").split(/\|\||&&|\$\(|[;|&()`\n{}]/)) {
    seg = seg.trim();
    for (let m; (m = seg.match(/^(?:if|then|do|else|elif|while|until|!|time|exec|xargs)\s+/) || seg.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\S*)\s+/));) seg = seg.slice(m[0].length);
    const w = (seg.match(/^[^\s"'<>=]+/) || [''])[0];
    if (w) out.push(w.replace(/^.*\//, ''));
  }
  return out;
}
function installedBy(line, cfg) {
  const got = [];
  for (const m of line.matchAll(/apt-get install\b([^;&|\n]*)/g)) for (const p of m[1].split(/\s+/)) got.push(...(cfg.apt_tools[p] || []));
  for (const m of line.matchAll(/npm (?:install|i) (?:-g|--global)\b([^;&|\n]*)/g)) for (const p of m[1].split(/\s+/)) got.push(...(cfg.npm_global_tools[p.replace(/(.)@[^@/]*$/, '$1')] || []));
  if (/\$ANDROID_HOME\/licenses\/android-sdk-license/.test(line)) got.push('android-sdk');
  return got;
}
const imageKey = (cfg, image) => Object.entries(cfg.images).find(([, v]) => v === image)?.[0];

test('every generated job: its image provides each tool its script runs, or an earlier line installs it; no GitHub Actions variable', () => {
  const cfg = config();
  let checked = 0;
  for (const repo of REPOS) {
    const d = docsFor(repo);
    for (const name of Object.keys(d.generated)) {
      if (['include', 'workflow', 'stages', 'variables'].includes(name)) continue;
      const job = gen.resolveJob(d.all, name);
      if (!job.script) continue; // its template is another lane's (tpl-deploy.yml, tpl-verify.yml)
      const key = imageKey(cfg, job.image);
      assert.ok(key && cfg.image_tools[key], `${repo}: ${name} runs on ${job.image}, which has no image_tools entry`);
      const have = new Set(cfg.image_tools[key]);
      if (job.variables?.ANDROID_HOME === undefined) have.delete('android-sdk');
      for (const line of [...[].concat(job.before_script || []), ...[].concat(job.script)]) {
        assert.doesNotMatch(line, /\$\{?GITHUB_[A-Z_]+/, `${repo}: ${name} uses a GitHub Actions variable: ${line.slice(0, 120)}`);
        for (const c of commandsOf(line)) if (TRACKED.has(c)) for (const t of NEEDS[c] || [c]) assert.ok(have.has(t), `${repo}: ${name} runs ${c}, but ${job.image} has no ${t} and no earlier line installs it`);
        for (const t of installedBy(line, cfg)) have.add(t);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 100, `checked ${checked} jobs`);
  // the four jobs of finding 1 and the Android job of finding 2, by name
  const p = docsFor('vitana-platform');
  const cicdl = gen.resolveJob(p.all, 'cicdl-lint-services').script;
  assert.ok(cicdl.findIndex((l) => /apt-get install[^\n]*\bjq\b/.test(l)) < cicdl.findIndex((l) => /\bjq\b/.test(l) && !/apt-get/.test(l)), 'cicdl-lint-services installs jq before it uses it');
  assert.doesNotMatch(gen.resolveJob(p.all, 'openapi-enforce').script.join('\n'), /GITHUB_OUTPUT/);
  const bridge = gen.resolveJob(p.all, 'sql-auth-bridge');
  assert.ok(new Set([...cfg.image_tools[imageKey(cfg, bridge.image)], ...bridge.script.flatMap((l) => installedBy(l, cfg))]).has('npm'), 'sql-auth-bridge has npm');
});

test('validator-check reads the merge request title and description only in merge-request pipelines and logs why it skips them elsewhere', () => {
  const MR_ONLY = /^if \[ "\$CI_PIPELINE_SOURCE" = "merge_request_event" \]; then /;
  for (const name of ['validator-check', 'full-suite:validator-check']) {
    const job = gen.resolveJob(docsFor('vitana-platform').all, name);
    for (const line of job.script) if (/CI_MERGE_REQUEST_(DESCRIPTION|TITLE)|\/tmp\/pr_(body|title)\.txt|\$VC_VTID|\$VC_PROFILE/.test(line)) assert.match(line, MR_ONLY, `${name}: reads merge request text outside a merge-request pipeline: ${line.slice(0, 100)}`);
    const skip = job.script.find((l) => /^if \[ "\$CI_PIPELINE_SOURCE" != "merge_request_event" \]; then echo /.test(l));
    assert.ok(skip && /skipped/.test(skip) && /merge request/.test(skip), `${name}: no skip reason in the job log for main, nightly and train pipelines`);
    assert.equal(job.variables.GIT_DEPTH, '0', `${name}: needs the full history for origin/<target>...HEAD`);
  }
  const sel = gen.selectChecks(config(), 'vitana-platform', ['services/gateway/src/routes/x.ts']).selected;
  assert.ok(sel.includes('validator-check'));
});

test('android-module: Node from the image, JDK 17 and an Android SDK home with accepted licences before gradlew, cached', () => {
  const cfg = config();
  for (const name of ['android-module', 'full-suite:android-module']) {
    const job = gen.resolveJob(docsFor('vitana-v1').all, name);
    const at = (re) => job.script.findIndex((l) => re.test(l));
    assert.ok(cfg.image_tools[imageKey(cfg, job.image)].includes('node'), `${name}: ${job.image} has no Node`);
    assert.ok(at(/apt-get install[^\n]*openjdk-17-jdk-headless/) >= 0 && at(/apt-get install[^\n]*openjdk-17/) < at(/gradlew/), `${name}: JDK 17 before gradlew`);
    assert.ok(at(/android-sdk-license/) >= 0 && at(/android-sdk-license/) < at(/gradlew/), `${name}: SDK licences before gradlew`);
    assert.equal(job.variables.ANDROID_HOME, '$CI_PROJECT_DIR/.android-sdk');
    for (const p of ['.npm', '.android-sdk', '.gradle-home']) assert.ok(job.cache.paths.includes(p), `${name}: cache ${p}`);
  }
});

test('pr-gate-report passes the merge request title to every gate.mjs check and installs what red-green runs', () => {
  const cfg = config();
  for (const repo of REPOS) {
    const d = docsFor(repo);
    assert.equal(d.generated.variables.GATE_TITLE, '$CI_MERGE_REQUEST_TITLE');
    const job = gen.resolveJob(d.all, 'pr-gate-report');
    const calls = job.script.filter((l) => /pr-gate\/gate\.mjs/.test(l));
    assert.ok(calls.length > 0);
    for (const c of calls) assert.match(c, /--title "\$GATE_TITLE"/, `${repo}: gate.mjs without --title skips scope, sparring and red-green (gate.mjs:22-23)`);
    const install = job.script.findIndex((l) => /red_green/.test(l) && /npm ci/.test(l));
    const redGreen = job.script.findIndex((l) => /red-green/.test(l) && /gate\.mjs/.test(l));
    assert.ok(install >= 0 && install < redGreen, `${repo}: red-green runs the tests with node_modules of the checkout; install them first`);
    const lock = cfg.repositories[repo].install[cfg.repositories[repo].pr_gate_install].lockfiles;
    assert.deepEqual(job.cache?.key?.files, lock, `${repo}: pr-gate-report cache keyed by ${lock}`);
  }
});

test('dev-autopilot-impact scans against the merge request target (main for trains, the pushed range on main), never HEAD~1', () => {
  for (const name of ['dev-autopilot-impact', 'full-suite:dev-autopilot-impact']) {
    const job = gen.resolveJob(docsFor('vitana-platform').all, name);
    const text = job.script.join('\n');
    const set = job.script.findIndex((l) => /IMPACT_SCAN_BASE=/.test(l));
    const scan = job.script.findIndex((l) => /dev-autopilot-impact-scan\.mjs/.test(l));
    assert.ok(set >= 0 && set < scan, `${name}: IMPACT_SCAN_BASE is set before the scan`);
    assert.match(text, /IMPACT_SCAN_BASE="origin\/\$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"/);
    assert.match(text, /IMPACT_SCAN_BASE="\$CI_COMMIT_BEFORE_SHA"/);
    assert.match(text, /git rev-parse --verify --quiet "\$IMPACT_SCAN_BASE\^\{commit\}"[^\n]*\|\| \{[^\n]*exit 1/, `${name}: fails closed instead of the scan's HEAD~1 fallback (dev-autopilot-impact-scan.mjs:48-56)`);
    assert.doesNotMatch(text, /HEAD~1/);
    assert.equal(job.variables.GIT_DEPTH, '0');
  }
});

// Each `run` step of a GitHub job: "<job>/<step name>".
function runSteps(text) {
  const out = [];
  let job = null; let cur = null; let inJobs = false;
  const flush = () => { if (cur && cur.run && cur.name) out.push(`${job}/${cur.name}`); cur = null; };
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    let m;
    if ((m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/))) { flush(); job = m[1]; continue; }
    if ((m = line.match(/^ {6}- (\w+):\s*(.*)$/))) { flush(); cur = { name: null, run: false }; }
    else if (!(m = line.match(/^ {8}(\w+):\s*(.*)$/)) || !cur) continue;
    if (m[1] === 'name') cur.name = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (m[1] === 'run') cur.run = true;
  }
  flush();
  return out;
}
// Steps whose work needs what plan §3.2 gives no GitLab class yet; open items for the driver (acceptance.md).
const OPEN_STEPS = new Set([
  'vitana-platform DEV-AUTOPILOT-IMPACT.yml scan/Ingest impact findings into Developer Autopilot queue',
  'vitana-platform DEV-AUTOPILOT-IMPACT.yml scan/Build PR comment body',
  'vitana-platform DEV-AUTOPILOT-IMPACT.yml scan/Post or update PR comment',
]);

test('the multi-gate ports: every run step of the GitHub workflow has a GitLab job (or is a listed open item); no partial port is left', () => {
  const STEP_MAPPED = { 'vitana-v1': ['PR-GATE.yml'], 'vitana-platform': ['PR-GATE.yml', 'VALIDATOR-CHECK.yml', 'DEV-AUTOPILOT-IMPACT.yml'] };
  const open = [];
  for (const repo of REPOS) {
    const { cfg, generated } = docsFor(repo);
    const r = cfg.repositories[repo];
    for (const [name, c] of Object.entries(r.checks)) assert.notEqual(c.port, 'partial', `${repo}: ${name} is still a partial port`);
    const fx = JSON.parse(readFileSync(path.join(ROOT, r.fixture), 'utf8'));
    for (const wf of STEP_MAPPED[repo]) {
      const steps = repo === 'vitana-platform' ? runSteps(readFileSync(path.join(ROOT, '.github/workflows', wf), 'utf8')) : fx.workflow_steps[wf].steps;
      assert.ok(steps.length >= 3, `${repo}: ${wf} has ${steps.length} run steps`);
      const map = r.github_workflows[wf].steps || {};
      assert.deepEqual(Object.keys(map).sort(), [...steps].sort(), `${repo}: ${wf}: the step map differs from the workflow's run steps`);
      for (const [step, to] of Object.entries(map)) {
        if (to && to.open) { open.push(`${repo} ${wf} ${step}`); continue; }
        for (const j of [].concat(to)) assert.ok(generated[j], `${repo}: ${wf} "${step}" → ${j} is not a generated job`);
      }
    }
  }
  assert.deepEqual(open.sort(), [...OPEN_STEPS].sort());
});

test('vitana-v1: PR-GATE preview-e2e on a local vite preview without a session; the gate and Kiro steering self-tests; E2E-PREVIEW-ORB by hand', () => {
  const d = docsFor('vitana-v1');
  const cfg = config();
  const e2e = gen.resolveJob(d.all, 'preview-e2e');
  const text = e2e.script.join('\n');
  assert.match(text, /vite preview --host 127\.0\.0\.1 --port 4173 --strictPort/);
  assert.match(text, /playwright test \$SPECS --config=\.pr-gate\.playwright\.config\.mjs/);
  assert.match(text, /scripts\/ci\/staging-verify\/staging-guard\.ts/);
  assert.match(text, /enforce_preview_e2e/);
  assert.doesNotMatch(text, /TEST_USER_(EMAIL|PASSWORD)|E2E_PASSWORD/, 'plan §3.4: no session on the untrusted class');
  assert.deepEqual(e2e.tags, ['vitana-eng']);
  for (const f of ['src/App.tsx', 'public/logo.svg', 'index.html', 'vite.config.ts', 'package-lock.json', 'tests/e2e/staging/smoke.staging.spec.ts']) assert.ok(gen.selectChecks(cfg, 'vitana-v1', [f]).selected.includes('preview-e2e'), `preview-e2e not selected by ${f} (PR-GATE.yml:211)`);
  for (const [job, cmd, file] of [['gate-selftest', /^node --test scripts\/ci\/pr-gate\/__tests__\/\*\.test\.mjs$/, 'scripts/ci/pr-gate/lib.mjs'], ['kiro-steering-selftest', /^node --test scripts\/ci\/kiro-steering\/guard\.test\.cjs$/, 'scripts/ci/kiro-steering/guard.cjs']]) {
    assert.ok(gen.resolveJob(d.all, job).script.some((l) => cmd.test(l)), `${job} runs ${cmd}`);
    assert.ok(gen.selectChecks(cfg, 'vitana-v1', [file]).selected.includes(job), `${job} selected by ${file}`);
  }
  const orb = gen.evaluatePipeline(d.all, MAIN({ DELIVERY_MODE: 'live' }))['e2e-preview-orb'];
  assert.ok(orb, 'e2e-preview-orb on main in live mode');
  assert.equal(orb.when, 'manual');
  assert.equal(orb.allow_failure, true, 'a manual job must not block the main pipeline');
  assert.deepEqual(orb.tags, ['vitana-eng-main']);
  assert.match(orb.script.join('\n'), /node tests\/e2e\/orb-preview\.mjs/);
  assert.equal(gen.evaluatePipeline(d.all, MAIN())['e2e-preview-orb'], undefined, 'not in shadow mode');
  assert.equal(gen.evaluatePipeline(d.all, MR(['src/App.tsx']))['e2e-preview-orb'], undefined, 'never on the untrusted class');
});

// VTID-05550 review round 2 (d5b609bf): pins the four blocking findings.
import { readFileSync as _readFileSync } from 'node:fs';
const _root = new URL('../../', import.meta.url);
const _read = (p) => _readFileSync(new URL(p, _root), 'utf8');

test('T7 assist commits the i18n stamps with the translations (review: stamps dropped)', () => {
  const tpl = _read('infra/gitlab-engineering/ci/tpl-assist.yml');
  const m = tpl.match(/ASSIST_DATA_PATHS:\s*(.+)/);
  assert.ok(m, 'ASSIST_DATA_PATHS is set');
  assert.ok(m[1].split(/\s+/).includes('src/i18n'), 'translations are committed');
  assert.ok(m[1].split(/\s+/).includes('i18n-source-stamps'), 'i18n-source-stamps are committed');
});

test('T7 assist never uses a Google provider (review: AI-27)', () => {
  const tpl = _read('infra/gitlab-engineering/ci/tpl-assist.yml');
  const p = tpl.match(/I18N_PROVIDER:\s*(\S+)/);
  assert.ok(p, 'I18N_PROVIDER is set');
  assert.notEqual(p[1], 'gemini');
  assert.ok(!/gemini/i.test(tpl.split('\n').filter((l) => /I18N_PROVIDER/.test(l)).join('\n')), 'no Gemini provider in the assist template');
});

test('the i18n fan-out translates from the English pivot, not from de (review: wrong source)', () => {
  const cfg = _read('config/delivery/services.json');
  const loops = cfg.split('\n').filter((l) => l.includes('for L in') && l.includes('i18n-locales'));
  assert.ok(loops.length >= 2, 'both i18n assist rules have a fan-out loop');
  for (const l of loops) {
    assert.ok(l.includes('--source=en'), 'fan-out source is en');
    assert.ok(!l.includes('--source=de'), 'fan-out does not read de');
  }
});

test('dev-autopilot-impact runs for migrations and scripts, not only gateway (review: blockers never enforced)', () => {
  const cfg = JSON.parse(_read('config/delivery/services.json'));
  const svcs = cfg.repositories['vitana-platform'].services;
  for (const name of ['supabase', 'scripts']) {
    assert.ok(svcs[name].checks.includes('dev-autopilot-impact'), `${name} selects dev-autopilot-impact`);
  }
});

test('build-image and preview-build:main do not wait for the full suite (review: plan §3.6 step 1)', () => {
  for (const f of ['v1-delivery.gitlab-ci.yml', 'platform-delivery.gitlab-ci.yml']) {
    const lines = _read(`infra/gitlab-engineering/ci/${f}`).split('\n');
    const heads = lines.map((l, n) => [l, n]).filter(([l]) => /^"(build-image:[a-z0-9-]+|preview-build:main)":\s*$/.test(l));
    assert.ok(heads.length >= 1, `${f}: at least one build job is generated (the test must not pass on zero jobs)`);
    for (const [head, n] of heads) {
      const block = [];
      for (let k = n + 1; k < lines.length && /^\s/.test(lines[k]); k++) block.push(lines[k]);
      assert.ok(block.some((l) => /^\s+needs: \[\]\s*$/.test(l)), `${f}: ${head.replace(/:\s*$/, '')} declares needs: []`);
    }
  }
});

// VTID-05671 (build-class-retag-2): the image builds run on the build class. Its BuildKit daemon is the only service with an
// unconfined seccomp and AppArmor profile (deploy-path, review 1ea5 finding 2), so no build job may run on the main class.
test('build-image jobs run on the build class vitana-eng-build, in every repository and context', () => {
  for (const repo of REPOS) {
    const seen = new Set();
    for (const ctx of [MAIN({ DELIVERY_MODE: 'live' }), MAIN(), NIGHTLY({ DELIVERY_MODE: 'live' })]) {
      const jobs = jobsIn(repo, ctx);
      for (const n of Object.keys(jobs).filter((x) => x.startsWith('build-image:'))) {
        seen.add(n);
        assert.deepEqual(jobs[n].tags, ['vitana-eng-build'], `${repo}: ${n}`);
      }
    }
    assert.ok(seen.size > 0, `${repo}: has build-image jobs in some context`);
  }
});
