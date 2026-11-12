// VTID-05023 (J): PR-GATE runs aurora-compat-lint.mjs as a command, not as an import.
// aurora-compat-lint.test.mjs imports lintSql only, so a broken command (main() not
// running, a wrong exit code, a bad --base/--head diff) would still pass. A silent
// no-op would also keep PR-GATE green. These tests run the script the way PR-GATE does.
// Run: node --test scripts/aws/test/aurora-compat-lint-cli.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LINT = resolve(here, '..', 'aurora-compat-lint.mjs');
const FAIL = resolve(here, 'fixtures', 'aurora-compat', 'fail.sql');
const PASS = resolve(here, 'fixtures', 'aurora-compat', 'pass.sql');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// Runs the lint script inside `cwd`, the way PR-GATE runs it from the checkout root.
function lint(cwd, script, ...args) {
  return spawnSync('node', [script, ...args], { cwd, encoding: 'utf8' });
}

test('file mode: a Supabase-only file exits 1 and names its rule; a clean file exits 0', () => {
  const bad = lint(here, LINT, FAIL);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /\[auth-schema\]/);
  assert.match(bad.stdout, /flagged 1; clean 0/);

  const good = lint(here, LINT, PASS);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /flagged 0; clean 1/);
});

// PR-GATE is the only caller in CI. If its step is removed or made non-blocking, nothing else
// would notice, so this pins the step's commands and its blocking status.
test('PR-GATE runs the lint command and its unit test in a blocking step', () => {
  const yml = readFileSync(resolve(here, '..', '..', '..', '.github', 'workflows', 'PR-GATE.yml'), 'utf8');
  const start = yml.indexOf('- name: Aurora compatibility (changed migrations)');
  assert.ok(start > 0, 'PR-GATE.yml has the Aurora compatibility step');
  const step = yml.slice(start, yml.indexOf('- name: Scope guard', start));
  assert.match(step, /node --test scripts\/aws\/test\/aurora-compat-lint\.test\.mjs/);
  assert.match(step, /node scripts\/aws\/aurora-compat-lint\.mjs --base "\$BASE" --head "\$HEAD"/);
  assert.doesNotMatch(step, /continue-on-error/);
});

test('no arguments exits 2 with a usage line', () => {
  const r = lint(here, LINT);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test('--base/--head: a PR that adds a Supabase-only migration exits 1; one that adds a clean migration exits 0; one with no migration change exits 0', () => {
  const repo = mkdtempSync(join(tmpdir(), 'aurora-lint-pr-'));
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'supabase', 'migrations'), { recursive: true });
  mkdirSync(join(repo, 'scripts', 'aws'), { recursive: true });
  copyFileSync(LINT, join(repo, 'scripts', 'aws', 'aurora-compat-lint.mjs'));
  writeFileSync(join(repo, 'supabase', 'migrations', '001_base.sql'), 'SELECT 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');

  copyFileSync(FAIL, join(repo, 'supabase', 'migrations', '002_bad.sql'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head: supabase-only migration');
  const head = git(repo, 'rev-parse', 'HEAD');

  const script = join('scripts', 'aws', 'aurora-compat-lint.mjs');
  const bad = lint(repo, script, '--base', base, '--head', head);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /002_bad\.sql:4 \[auth-schema\]/);

  const none = lint(repo, script, '--base', head, '--head', head);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /checked 0 file\(s\)/);

  copyFileSync(PASS, join(repo, 'supabase', 'migrations', '003_good.sql'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head 2: clean migration');
  const head2 = git(repo, 'rev-parse', 'HEAD');
  const good = lint(repo, script, '--base', head, '--head', head2);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /checked 1 file\(s\); flagged 0; clean 1/);
});
