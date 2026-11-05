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
  const MAIN_CLASS = /^(full-suite:|build-image:|preview-build:main$|staging-verify:|staging-verify-nightly:|assist:)/;
  const DEPLOY_CLASS = /^(push-image:|deploy-staging:|rollback-staging:|record:|record-nightly:|vtid-close$|notify-platform$|preview-upload|preview-stop)/;
  for (const repo of REPOS) {
    for (const ctx of [MAIN({ DELIVERY_MODE: 'live' }), MAIN(), NIGHTLY({ DELIVERY_MODE: 'live' })]) {
      const jobs = jobsIn(repo, ctx);
      const full = Object.keys(jobs).filter((n) => n.startsWith('full-suite:')).map((n) => n.slice('full-suite:'.length));
      assert.deepEqual(full.sort(), checkNames(repo).sort(), `${repo}: full suite`);
      for (const [name, job] of Object.entries(jobs)) {
        assert.equal(job.interruptible, false, `${repo}: ${name} is interruptible on main`);
        if (MAIN_CLASS.test(name)) assert.deepEqual(job.tags, ['vitana-eng-main'], `${repo}: ${name}`);
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

test('sibling sweep: every workflow plan §2.2 moves to GitLab has its jobs in a generated file', () => {
  for (const repo of REPOS) {
    const { cfg, generated } = docsFor(repo);
    const reg = cfg.repositories[repo].github_workflows;
    const all = new Set(Object.keys(generated));
    for (const [wf, e] of Object.entries(reg)) {
      if (!['t1', 't2', 't3', 't4', 't7'].includes(e.fate)) continue;
      for (const j of [...e.jobs, ...(e.pr_jobs || [])]) assert.ok(all.has(j), `${repo}: ${wf} → ${j} is not in ${cfg.repositories[repo].output}`);
      if (e.fate === 't1') assert.ok(e.jobs.length > 0, `${repo}: ${wf} maps to no job`);
    }
  }
});
