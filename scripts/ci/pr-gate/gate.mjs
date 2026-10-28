#!/usr/bin/env node
// VTID-04948 — PR-GATE checks (plan B1–B6, D2 lint). One CLI, one subcommand
// per check; each exits 0 (pass/skip) or 1 (fail) and writes a summary line.
//
//   node scripts/ci/pr-gate/gate.mjs <check> --base <sha> --head <sha> --title "<PR title>"
//   checks: scope | sparring | weakening | ratchet-tsc <file> | ratchet-eslint <file>
//           | red-green | migrations | baseline-tsc <file> | baseline-eslint <file>
import { existsSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as L from './lib.mjs';

const args = process.argv.slice(2);
const check = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = opt('base');
const head = opt('head') || 'HEAD';
const title = opt('title') ?? process.env.PR_TITLE ?? '';
const vtids = L.vtidsFromTitle(title);
const ROOT = process.cwd();
const BASELINE_DIR = 'scripts/ci/pr-gate/baseline';

function loadScopes() {
  const scopes = {};
  const errors = [];
  for (const v of vtids) {
    const p = `docs/validation/${v}/scope.json`;
    if (!existsSync(p)) continue;
    try {
      const obj = JSON.parse(readFileSync(p, 'utf8'));
      const e = L.validateScope(obj, v);
      if (e.length) errors.push(`${p}: ${e.join('; ')}`);
      else scopes[v] = obj;
    } catch (err) {
      errors.push(`${p}: ${err.message}`);
    }
  }
  return { scopes, errors };
}

function done(ok, md) {
  L.summary(md);
  process.exit(ok ? 0 : 1);
}

const checks = {
  scope() {
    const { scopes, errors } = loadScopes();
    if (errors.length) done(false, `❌ **scope** — invalid scope.json:\n${errors.map((e) => `- ${e}`).join('\n')}`);
    const changed = L.changedFiles(base, head);
    const r = L.evaluateScope({ vtids, scopes, changed, botOnly: L.botOnlyFiles(base, head) });
    if (r.skipped) done(true, `➖ **scope** — skipped: ${r.skipped}`);
    if (r.missing.length) done(false, `❌ **scope** — missing \`docs/validation/<VTID>/scope.json\` for ${r.missing.join(', ')} (create it with \`node scripts/ci/pr-gate/vtid-scope.mjs init <VTID> --kind <kind> --paths "<glob>,…"\`)`);
    if (!r.ok) done(false, `❌ **scope** — ${r.outside.length} file(s) changed outside the declared scope of ${vtids.join(', ')}:\n${r.outside.slice(0, 50).map((f) => `- \`${f}\``).join('\n')}`);
    done(true, `✅ **scope** — ${changed.length} changed file(s), all inside the scope of ${vtids.join(', ')}`);
  },

  sparring() {
    if (vtids.length === 0) done(true, '➖ **sparring record** — skipped: no VTID in the PR title');
    const { scopes } = loadScopes();
    const problems = [];
    for (const v of vtids) {
      const rec = scopes[v]?.sparring_record || `docs/validation/${v}/plan-sparring.md`;
      if (!existsSync(rec)) { problems.push(`${v}: no sparring record at \`${rec}\` (set "sparring_record" in scope.json when the plan's record lives under another VTID)`); continue; }
      const p = L.evaluateSparringRecord(readFileSync(rec, 'utf8'));
      if (p.length) problems.push(`${v}: \`${rec}\` — ${p.join(', ')}`);
    }
    if (problems.length) done(false, `❌ **sparring record**:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    done(true, `✅ **sparring record** — present and approved for ${vtids.join(', ')}`);
  },

  weakening() {
    const { scopes } = loadScopes();
    const exempt = Object.values(scopes).flatMap((s) => s.weakens_tests || []);
    const files = L.changedFiles(base, head)
      .filter((f) => L.TEST_FILE.test(f))
      .map((file) => ({ file, base: L.showFile(base, file), head: L.showFile(head, file) }));
    const r = L.evaluateWeakening({ files, exempt });
    const declared = r.findings.filter((f) => !r.blocking.includes(f));
    const extra = declared.length ? `\n\nDeclared in scope.json (shown at Gate 2):\n${declared.map((f) => `- \`${f.file}\`: ${f.why}`).join('\n')}` : '';
    if (!r.ok) done(false, `❌ **test weakening** — undeclared:\n${r.blocking.map((f) => `- \`${f.file}\`: ${f.why}`).join('\n')}${extra}`);
    done(true, `✅ **test weakening** — ${files.length} changed test file(s), none weakened without a declaration${extra}`);
  },

  'ratchet-tsc'() {
    ratchet('tsc', L.countTsc(readFileSync(args[1], 'utf8')));
  },
  'ratchet-eslint'() {
    ratchet('eslint', L.countEslint(JSON.parse(readFileSync(args[1], 'utf8')), ROOT));
  },
  'baseline-tsc'() {
    writeBaseline('tsc', L.countTsc(readFileSync(args[1], 'utf8')));
  },
  'baseline-eslint'() {
    writeBaseline('eslint', L.countEslint(JSON.parse(readFileSync(args[1], 'utf8')), ROOT));
  },

  'red-green'() {
    const { scopes } = loadScopes();
    const fixVtids = vtids.filter((v) => scopes[v]?.kind === 'fix');
    if (fixVtids.length === 0) done(true, '➖ **red→green** — skipped: no VTID of kind "fix"');
    const exempt = new Set(fixVtids.flatMap((v) => (scopes[v].red_green_exempt || []).map((e) => e.file)));
    // Which tests count and how they run come from config.json "red_green"
    // (vitana-v1: Vitest at the root; vitana-platform: Jest in services/gateway).
    const rg = { test_pattern: '^src/.*\\.test\\.(ts|tsx)$', cwd: '.', cmd: ['npx', 'vitest', 'run'], ...(L.loadConfig().red_green || {}) };
    const pattern = new RegExp(rg.test_pattern);
    const tests = L.changedFiles(base, head).filter((f) => pattern.test(f) && existsSync(f) && !exempt.has(f));
    if (tests.length === 0) {
      done(exempt.size > 0, exempt.size > 0
        ? `✅ **red→green** — every changed test is declared in red_green_exempt (shown at Gate 2)`
        : `❌ **red→green** — a "fix" must add or change a Vitest test that fails without the fix (or declare red_green_exempt)`);
    }
    const wt = mkdtempSync(join(tmpdir(), 'pr-gate-base-'));
    try {
      L.git(['worktree', 'add', '--detach', wt, base], { stdio: 'ignore' });
      symlinkSync(resolve(rg.cwd, 'node_modules'), join(wt, rg.cwd, 'node_modules'));
      for (const t of tests) {
        mkdirSync(dirname(join(wt, t)), { recursive: true });
        copyFileSync(t, join(wt, t));
      }
      const rel = tests.map((t) => (rg.cwd === '.' ? t : t.slice(rg.cwd.replace(/\/$/, '').length + 1)));
      const r = spawnSync(rg.cmd[0], [...rg.cmd.slice(1), ...rel], { cwd: join(wt, rg.cwd), encoding: 'utf8', env: { ...process.env, CI: '1' } });
      const out = `${r.stdout}${r.stderr}`;
      if (r.status === 0) done(false, `❌ **red→green** — the new/changed tests also PASS on the base commit, so they do not prove the fix:\n${tests.map((t) => `- \`${t}\``).join('\n')}`);
      const failed = (out.match(/Tests:?\s+(\d+) failed/) || [])[1] || '≥1';
      done(true, `✅ **red→green** — ${failed} test(s) fail on the base commit and the full suite passes on head (${tests.length} file(s))`);
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', wt]);
      rmSync(wt, { recursive: true, force: true });
    }
  },

  async migrations() {
    const { scopes } = loadScopes();
    const nonTx = new Set(Object.values(scopes).flatMap((s) => s.non_transactional || []));
    const files = L.changedFiles(base, head).filter((f) => /^supabase\/migrations\/.+\.sql$/.test(f) && existsSync(f));
    if (files.length === 0) done(true, '➖ **migrations** — no migration changed');
    const problems = files.flatMap((f) => L.lintMigration(readFileSync(f, 'utf8'), { nonTransactional: nonTx.has(f) }).map((p) => `\`${f}\`: ${p}`));
    // Exact Postgres grammar (libpg_query), offline.
    let parser = null;
    try {
      parser = await import('libpg-query');
      if (parser.loadModule) await parser.loadModule();
    } catch {
      problems.push('Postgres parser (libpg-query) unavailable — install it in the job');
    }
    if (parser) {
      for (const f of files) {
        try { parser.parseSync(readFileSync(f, 'utf8')); } catch (e) { problems.push(`\`${f}\`: does not parse as Postgres SQL — ${e.message}`); }
      }
    }
    // Best-effort semantic dry run on the stub DB (PG* env from the job's service container).
    const levels = [];
    if (process.env.PGHOST && problems.length === 0) {
      for (const f of files) {
        if (nonTx.has(f)) { levels.push(`\`${f}\`: parsed; dry run skipped (non_transactional, flagged for Gate 2)`); continue; }
        const r = spawnSync('psql', ['-X', '-q'], { input: L.dryRunScript(readFileSync(f, 'utf8')), encoding: 'utf8' });
        if (r.status === 0) { levels.push(`\`${f}\`: parsed, dry run OK (rolled back)`); continue; }
        const c = L.classifyDryRun(`${r.stdout}${r.stderr}`);
        if (c.verdict === 'unverifiable') levels.push(`\`${f}\`: parsed, dry run **unverifiable** — ${c.sqlstate} ${c.message} (object outside this repo's history; Gate 2 lists it)`);
        else problems.push(`\`${f}\`: dry run failed — ${c.sqlstate || ''} ${c.message}`);
      }
    }
    if (problems.length) done(false, `❌ **migrations** — ${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join('\n')}`);
    done(true, `✅ **migrations** — ${files.length} file(s) transactional, idempotent and parsed${levels.length ? `:\n${levels.map((l) => `- ${l}`).join('\n')}` : ''}`);
  },
};

function ratchet(kind, current) {
  const p = join(BASELINE_DIR, `${kind}.json`);
  const baseline = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).counts : {};
  const r = L.compareRatchet(baseline, current);
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  const better = r.better.length ? `\n\n${r.better.length} file(s) improved — lower the baseline in this PR: \`node scripts/ci/pr-gate/gate.mjs baseline-${kind} <output>\`` : '';
  if (!r.ok) {
    done(false, `❌ **${kind} ratchet** — ${r.worse.length} file(s) got worse (errors may only go down):\n${r.worse.slice(0, 40).map((w) => `- \`${w.file}\`: ${w.baseline} → ${w.now}`).join('\n')}${better}`);
  }
  done(true, `✅ **${kind} ratchet** — no file got worse (${total} known error(s) in ${Object.keys(current).length} file(s))${better}`);
}

function writeBaseline(kind, counts) {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(BASELINE_DIR, `${kind}.json`), `${JSON.stringify({ kind, note: 'VTID-04948 ratchet: per-file error counts may only go down', counts: sorted }, null, 2)}\n`);
  console.log(`baseline ${kind}: ${Object.keys(sorted).length} file(s)`);
}

if (!checks[check]) {
  console.error(`unknown check "${check}". Known: ${Object.keys(checks).join(', ')}`);
  process.exit(2);
}
if (!['baseline-tsc', 'baseline-eslint', 'ratchet-tsc', 'ratchet-eslint'].includes(check) && !base) {
  console.error('--base <sha> is required');
  process.exit(2);
}
await checks[check]();
