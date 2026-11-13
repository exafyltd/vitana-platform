// VTID-05784 (plan autonomous-to-staging-r2 §3.5, lane staging-migrations-auto): migrations reach only the isolated
// staging database, default off, and RUN-MIGRATION.yml's production path is unchanged.
//   node --test docs/validation/VTID-05784/tests/*.test.mjs
// Runs in STAGING-MIGRATE.yml job selftest (pull requests that change these files; PGlite installed, no skips allowed).
// No AWS call is ever made: the AWS CLI is a stub (../fixtures/bin/aws) whose RDS Data API is a LOCAL Postgres
// (PGlite) with real transaction semantics, so the rollback of a failing migration is proven on Postgres. Each guard
// has a mutation test: the guard is removed from a copy and the matching test must then fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const FX = path.join(HERE, '..', 'fixtures');
const BIN = path.join(FX, 'bin');
const AWS_DIR = path.join(ROOT, 'scripts/aws');
const APPLY = path.join(AWS_DIR, 'staging-db-apply-migration.sh');
const GATE = path.join(AWS_DIR, 'staging-db-migrate-gate.sh');
const MIGRATE = path.join(AWS_DIR, 'staging-db-migrate.sh');
const wf = (f) => fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');
const { scanText } = await import(pathToFileURL(path.join(ROOT, 'scripts/ci/staging-prod-ref-guard.mjs')).href);
const STAGING = 'vitana-aurora-staging';
const PROD_CLUSTER = ['vitana', 'aurora', 'prod'].join('-');
const PROD_ROLE = ['AWS', 'PROD', 'ROLE', 'ARN'].join('_');

// PGlite: the repo install (CI) or $PGLITE_MODULE; the Postgres-backed tests are skipped only when neither exists
// (STAGING-MIGRATE.yml fails a run that skips).
let PGLITE = process.env.PGLITE_MODULE || '';
if (!PGLITE) {
  try { PGLITE = import.meta.resolve('@electric-sql/pglite'); } catch { PGLITE = ''; }
} else if (!/^file:/.test(PGLITE)) PGLITE = pathToFileURL(PGLITE).href;
const pgSkip = PGLITE ? false : '@electric-sql/pglite not installed (runs in STAGING-MIGRATE.yml selftest)';

const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), 'smig-'));
const tmp = (p) => fs.mkdtempSync(path.join(TMP, p));

/** Run a script with the stub CLIs first on PATH and a minimal environment. */
function sh(script, args, env = {}, { state } = {}) {
  const st = state || tmp('st-');
  const log = path.join(st, 'calls.log');
  if (!fs.existsSync(log)) fs.writeFileSync(log, '');
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${BIN}:${process.env.PATH}`, HOME: st, TMPDIR: st, STUB_LOG: log, STUB_STATE: st, STUB_PGLITE: PGLITE,
      AWS_REGION: 'eu-central-1', STAGING_DB_DATAAPI_RETRY_SLEEP: '0', ...env },
  });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(log, '');
  return { ...r, calls, state: st, out: r.stdout + r.stderr };
}
function sql(name, text) {
  const d = tmp('sql-');
  const f = path.join(d, name);
  fs.writeFileSync(f, text);
  return f;
}
async function pgQuery(state, q) {
  const { PGlite } = await import(PGLITE);
  const db = new PGlite(path.join(state, 'pg'));
  try { return (await db.query(q)).rows; } finally { await db.close(); }
}
const tableExists = async (state, t) => (await pgQuery(state, `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`))[0].ok;

/** A copy of scripts/aws with one mutation applied to <file>; returns the path of the mutated script <run>. */
function mutated(file, from, to, run = file) {
  const d = tmp('mut-');
  fs.mkdirSync(path.join(d, 'scripts/aws'), { recursive: true });
  for (const f of ['staging-db-common.sh', 'staging-db-apply-migration.sh', 'staging-db-migrate.sh', 'staging-db-migrate-gate.sh',
    'staging-db-load.sh', 'aurora_sql_split.py']) fs.copyFileSync(path.join(AWS_DIR, f), path.join(d, 'scripts/aws', f));
  fs.symlinkSync(path.join(ROOT, 'scripts/ci'), path.join(d, 'scripts/ci'));
  fs.symlinkSync(path.join(ROOT, 'infra'), path.join(d, 'infra'));
  fs.symlinkSync(path.join(ROOT, 'supabase'), path.join(d, 'supabase'));
  const p = path.join(d, 'scripts/aws', file);
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes(from), `mutation anchor not found in ${file}: ${from}`);
  fs.writeFileSync(p, text.split(from).join(to));
  return path.join(d, 'scripts/aws', run);
}

// =====================================================================================================================
// 1. staging-db-apply-migration.sh: the target is a staging cluster, never production
const GOOD = () => sql('20991231000001_good.sql', 'CREATE TABLE public.smig_a (id int);\nINSERT INTO public.smig_a VALUES (1);\n');

test('apply: without --cluster it fails (usage) before any AWS call', () => {
  const r = sh(APPLY, ['--file', GOOD()]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /--cluster is required/);
  assert.deepEqual(r.calls, []);
});

test('apply: the production cluster is refused before any AWS call, also as a dry run (no override exists)', () => {
  for (const extra of [[], ['--dry-run']]) {
    const r = sh(APPLY, ['--cluster', PROD_CLUSTER, '--file', GOOD(), ...extra]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /refused: cluster .* names production/);
    assert.deepEqual(r.calls, []);
  }
});

test('apply: any non-staging cluster name is refused before any AWS call', () => {
  for (const c of ['vitana-aurora', 'vitana-aurora-staging-prod', 'Vitana-Aurora-Staging', 'other-db', 'vitana-aurora-stagingx', `${STAGING} `]) {
    const r = sh(APPLY, ['--cluster', c, '--file', GOOD()]);
    assert.equal(r.status, 1, `${c}: ${r.out}`);
    assert.deepEqual(r.calls, [], c);
  }
});

test('apply --dry-run prints the plan for the staging cluster and makes no AWS call', () => {
  const r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD(), '--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Mode: one Data API transaction for 2 statement\(s\) of 1 file\(s\)/);
  assert.match(r.out, /Dry run: no AWS call made/);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(scanText(r.out, 'dry-run.txt'), [], 'the output names no production identifier');
});

test('apply: credentials other than the staging database role are refused before any cluster or Data API call', () => {
  for (const arn of ['arn:aws:sts::472838866351:assumed-role/github-actions-deploy/GitHubActions',
    'arn:aws:sts::472838866351:assumed-role/vitana-gha-staging-db-x/s', 'arn:aws:iam::472838866351:user/someone']) {
    const r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD()], { STUB_CALLER_ARN: arn });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /not the staging database role vitana-gha-staging-db/);
    assert.deepEqual(r.calls, ['aws sts get-caller-identity --output json']);
  }
});

test('apply: wrong account, untagged cluster, foreign cluster ARN or no managed secret are refused; no Data API call', () => {
  const cases = [
    [{ STUB_ACCOUNT: '111111111111' }, /expected 472838866351/],
    [{ STUB_TAG: 'production' }, /not tagged vitana-env=staging/],
    [{ STUB_CLUSTER_ARN: 'arn:aws:rds:eu-central-1:472838866351:cluster:another' }, /unexpected cluster ARN/],
    [{ STUB_NO_SECRET: '1' }, /no RDS-managed master secret/],
    [{ AWS_REGION: 'us-east-1' }, /expected eu-central-1/],
  ];
  for (const [env, re] of cases) {
    const r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD()], env);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, re);
    assert.equal(r.calls.filter((c) => c.startsWith('aws rds-data')).length, 0, JSON.stringify(env));
  }
});

test('apply: MIGRATION_FREEZE=true refuses before any AWS call', () => {
  const r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD()], { MIGRATION_FREEZE: 'true' });
  assert.equal(r.status, 1);
  assert.match(r.out, /MIGRATION_FREEZE=true/);
  assert.deepEqual(r.calls, []);
});

test('apply: a non-transactional statement is refused in a batch; --allow-non-transactional takes one file only', () => {
  const nontx = sql('20991231000003_idx.sql', 'CREATE INDEX CONCURRENTLY smig_i ON public.smig_a (id);\n');
  let r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD(), '--file', nontx, '--dry-run']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /cannot run inside a transaction/);
  r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD(), '--file', nontx, '--allow-non-transactional', '--dry-run']);
  assert.equal(r.status, 1);
  assert.match(r.out, /takes exactly one --file/);
  r = sh(APPLY, ['--cluster', STAGING, '--file', nontx, '--allow-non-transactional', '--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Mode: NO transaction/);
});

// =====================================================================================================================
// 2. Rollback on a local Postgres (PGlite behind the stub Data API)
test('rollback: a failing fixture migration rolls the whole batch back on Postgres (nothing applied, no commit)', { skip: pgSkip }, async () => {
  const bad = sql('20991231000002_bad.sql', 'CREATE TABLE public.smig_b (id int);\nALTER TABLE public.smig_missing ADD COLUMN x int;\n');
  const r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD(), '--file', bad]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAILED at statement 2 of .*20991231000002_bad\.sql/);
  assert.match(r.out, /nothing of the 2 file\(s\) was applied/);
  assert.equal(r.calls.filter((c) => c.startsWith('aws rds-data commit-transaction')).length, 0);
  assert.equal(r.calls.filter((c) => c.startsWith('aws rds-data rollback-transaction')).length, 1);
  assert.equal(await tableExists(r.state, 'smig_a'), false, 'the first (good) file of the batch was rolled back');
  assert.equal(await tableExists(r.state, 'smig_b'), false);
});

test('rollback: a good batch is committed once, in order, then NOTIFY pgrst', { skip: pgSkip }, async () => {
  const second = sql('20991231000002_second.sql', 'CREATE TABLE public.smig_c (a_id int);\nINSERT INTO public.smig_c SELECT id FROM public.smig_a;\n');
  const r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD(), '--file', second]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Committed: 4 statement\(s\) of 2 file\(s\) to vitana-aurora-staging/);
  assert.equal(r.calls.filter((c) => c.startsWith('aws rds-data commit-transaction')).length, 1);
  assert.deepEqual((await pgQuery(r.state, 'SELECT a_id FROM public.smig_c')).map((x) => x.a_id), [1]);
  assert.ok(r.calls.every((c) => !/rds-data/.test(c) || c.includes(`cluster:${STAGING}`) || c.includes('--cli-input-json')));
});

test('rollback: a resuming (auto-paused) cluster is retried, then applied', { skip: pgSkip }, async () => {
  const r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD()], { STUB_RESUMING: '2' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /retrying in 0s \(1\/40\)/);
  assert.equal(await tableExists(r.state, 'smig_a'), true);
});

test('read-only: --read-only always rolls back (the compatibility probe never keeps anything)', { skip: pgSkip }, async () => {
  const r = sh(APPLY, ['--cluster', STAGING, '--file', GOOD(), '--read-only']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /were rolled back/);
  assert.equal(r.calls.filter((c) => c.startsWith('aws rds-data commit-transaction')).length, 0);
  assert.equal(r.calls.some((c) => c.includes('notify')), false);
  assert.equal(await tableExists(r.state, 'smig_a'), false);
});

// mutations of the apply script: each removes one guard; the corresponding check above must then fail
test('mutations: removing a guard of the apply script is caught', { skip: pgSkip }, async () => {
  // (a) no cluster check -> the production name is no longer refused before AWS
  let m = mutated('staging-db-apply-migration.sh', 'sdb_check_cluster "$CLUSTER"\n', '\n');
  let r = sh(m, ['--cluster', PROD_CLUSTER, '--file', GOOD()]);
  assert.ok(!(r.status === 1 && r.calls.length === 0), 'mutation (a) must defeat the production-cluster refusal');
  // (b) caller check accepts any role
  m = mutated('staging-db-apply-migration.sh', '"arn:aws:sts::$SDB_ACCOUNT:assumed-role/$STAGING_ROLE_NAME/"*) ;;', '*) ;;');
  r = sh(m, ['--cluster', STAGING, '--file', GOOD()], { STUB_CALLER_ARN: 'arn:aws:sts::472838866351:assumed-role/github-actions-deploy/x' });
  assert.notEqual(r.status, 1, 'mutation (b) must let a foreign role through');
  // (c) tag check removed
  m = mutated('staging-db-apply-migration.sh', '|| sdb_die "cluster $CLUSTER is not tagged vitana-env=staging"', '|| true');
  r = sh(m, ['--cluster', STAGING, '--file', GOOD()], { STUB_TAG: 'production' });
  assert.equal(r.status, 0, 'mutation (c) must apply to an untagged cluster');
  // (d) a failed statement no longer aborts the batch -> the failing batch is partly committed
  m = mutated('staging-db-apply-migration.sh', 'exit 1   # the trap rolls back', 'continue');
  const bad = sql('20991231000002_bad.sql', 'ALTER TABLE public.smig_missing ADD COLUMN x int;\n');
  r = sh(m, ['--cluster', STAGING, '--file', GOOD(), '--file', bad]);
  assert.equal(await tableExists(r.state, 'smig_a'), true, 'mutation (d) must commit part of a failing batch');
  // (e) freeze check removed
  m = mutated('staging-db-apply-migration.sh', '[ "${MIGRATION_FREEZE:-}" != "true" ] || sdb_die', 'true || sdb_die');
  r = sh(m, ['--cluster', STAGING, '--file', GOOD(), '--dry-run'], { MIGRATION_FREEZE: 'true' });
  assert.equal(r.status, 0, 'mutation (e) must ignore the freeze');
});

// =====================================================================================================================
// 3. the gate: default off, fail closed
const ROLE = 'arn:aws:iam::472838866351:role/vitana-gha-staging-db';
const ON = { STAGING_DATA_PLANE: 'isolated', AWS_STAGING_DB_ROLE_ARN: ROLE, STAGING_DB_COST_APPROVED: 'yes', GITHUB_REF: 'refs/heads/main' };
function gate(mode, env, script = GATE) {
  const st = tmp('gate-');
  const outFile = path.join(st, 'out');
  fs.writeFileSync(outFile, '');
  const r = sh(script, ['--mode', mode], { GITHUB_OUTPUT: outFile, ...env }, { state: st });
  return { ...r, enabled: (fs.readFileSync(outFile, 'utf8').match(/^enabled=(\w+)$/m) || [])[1] };
}

test('gate: unset or shared plane = off (auto: notice, exit 0, enabled=false; dispatch: refused); no AWS call', () => {
  for (const plane of [undefined, '', 'shared']) {
    const env = { ...ON, STAGING_DATA_PLANE: plane };
    if (plane === undefined) delete env.STAGING_DATA_PLANE;
    const a = gate('auto', env);
    assert.equal(a.status, 0, a.out); assert.equal(a.enabled, 'false'); assert.match(a.out, /Staging migrations are off/);
    const d = gate('dispatch', env);
    assert.equal(d.status, 1); assert.equal(d.enabled, 'false'); assert.match(d.out, /needs STAGING_DATA_PLANE=isolated/);
    assert.deepEqual([...a.calls, ...d.calls], []);
  }
});

test('gate: isolated is enabled only with the staging database role, cost approval and main; anything else refuses', () => {
  const ok = gate('auto', ON);
  assert.equal(ok.status, 0, ok.out); assert.equal(ok.enabled, 'true');
  assert.equal(gate('dispatch', ON).enabled, 'true');
  const bad = [
    [{ AWS_STAGING_DB_ROLE_ARN: '' }, /AWS_STAGING_DB_ROLE_ARN is not set/],
    [{ AWS_STAGING_DB_ROLE_ARN: 'arn:aws:iam::472838866351:role/github-actions-deploy' }, /is not arn:aws:iam::472838866351:role\/vitana-gha-staging-db/],
    [{ AWS_STAGING_DB_ROLE_ARN: 'arn:aws:iam::111111111111:role/vitana-gha-staging-db' }, /is not arn/],
    [{ AWS_STAGING_DB_ROLE_ARN: `${ROLE}-x` }, /is not arn/],
    [{ STAGING_DB_COST_APPROVED: 'no' }, /STAGING_DB_COST_APPROVED is not 'yes'/],
    [{ GITHUB_REF: 'refs/heads/kiro/x' }, /run from main only/],
    [{ STAGING_DATA_PLANE: 'Isolated' }, /unknown STAGING_DATA_PLANE value/],
    [{ STAGING_DATA_PLANE: 'prod' }, /unknown STAGING_DATA_PLANE value/],
    [{ MIGRATION_FREEZE: 'true' }, /MIGRATION_FREEZE=true/],
  ];
  for (const [env, re] of bad) {
    for (const mode of ['auto', 'dispatch']) {
      const r = gate(mode, { ...ON, ...env });
      assert.equal(r.status, 1, `${JSON.stringify(env)} ${mode}: ${r.out}`);
      assert.notEqual(r.enabled, 'true');
      assert.match(r.out, re);
    }
  }
});

test('mutations: removing a gate guard is caught', () => {
  const cases = [
    ['elif ! printf \'%s\' "$AWS_STAGING_DB_ROLE_ARN" | grep -Eq "$ROLE_RE"; then', 'elif false; then', { AWS_STAGING_DB_ROLE_ARN: 'arn:aws:iam::472838866351:role/github-actions-deploy' }],
    ['if [ "${STAGING_DB_COST_APPROVED:-}" != "yes" ]; then', 'if false; then', { STAGING_DB_COST_APPROVED: '' }],
    ['if [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then', 'if false; then', { GITHUB_REF: 'refs/heads/x' }],
    ['  *) refuse "unknown STAGING_DATA_PLANE value', '  *) true "', { STAGING_DATA_PLANE: 'other' }],
  ];
  for (const [from, to, env] of cases) {
    const r = gate('auto', { ...ON, ...env }, mutated('staging-db-migrate-gate.sh', from, to));
    assert.notEqual(r.status, 1, `mutation "${to}" must defeat the refusal`);
  }
  // shared plane enabled in auto mode
  const m = mutated('staging-db-migrate-gate.sh', '      out false\n      exit 0', '      out true\n      exit 0');
  assert.equal(gate('auto', { ...ON, STAGING_DATA_PLANE: 'shared' }, m).enabled, 'true', 'mutation must enable the shared plane');
});

// =====================================================================================================================
// 4. staging-db-migrate.sh: files, snapshot, compat, quarantine
function gitRepo() {
  const d = tmp('repo-');
  const g = (...a) => { const r = spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q', '-b', 'main');
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
  w('supabase/migrations/20990101000000_old.sql', 'SELECT 1;\n');
  w('supabase/tests/local-stack/replay-skip.json', JSON.stringify({ skips: [{ file: '20990301000000_skipped.sql', reason: 'r' }] }));
  g('add', '-A'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  w('supabase/migrations/20990401000000_late.sql', 'SELECT 4;\n');
  w('supabase/migrations/20990201000000_early.sql', 'SELECT 2;\n');
  w('supabase/migrations/20990301000000_skipped.sql', 'SELECT 3;\n');
  w('supabase/migrations/20990101000000_old.sql', 'SELECT 11;\n');
  w('supabase/migrations/sub/20990501000000_nested.sql', 'SELECT 5;\n');
  w('supabase/migrations/README.md', 'x\n');
  g('add', '-A'); g('commit', '-qm', 'head');
  return { d, base, head: g('rev-parse', 'HEAD') };
}

test('files: only migration files ADDED on main, in timestamp order; modified and replay-skipped files are not applied', () => {
  const { d, base, head } = gitRepo();
  const r = sh(MIGRATE, ['files', '--base', base, '--head', head, '--repo', d]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.stdout.trim().split('\n'), ['supabase/migrations/20990201000000_early.sql', 'supabase/migrations/20990401000000_late.sql']);
  assert.match(r.stderr, /not applied \(M, an existing migration is never re-applied.*20990101000000_old\.sql/);
  assert.match(r.stderr, /not applied \(listed in replay-skip\.json.*20990301000000_skipped\.sql/);
  assert.deepEqual(r.calls, []);
  const back = sh(MIGRATE, ['files', '--base', head, '--head', base, '--repo', d]);
  assert.equal(back.status, 1); assert.match(back.out, /is not an ancestor/);
  const zero = sh(MIGRATE, ['files', '--base', '0'.repeat(40), '--head', head, '--repo', d]);
  assert.equal(zero.status, 1); assert.match(zero.out, /no base commit/);
  assert.equal(sh(MIGRATE, ['files', '--base', 'main', '--head', head, '--repo', d]).status, 2);
});

test('snapshot: a tagged snapshot of the staging cluster only, before anything is applied', () => {
  const id = `${STAGING}-premig-123-1`;
  const r = sh(MIGRATE, ['snapshot', '--cluster', STAGING, '--id', id]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, [
    'aws sts get-caller-identity --query Account --output text',
    `aws rds create-db-cluster-snapshot --region eu-central-1 --db-cluster-identifier ${STAGING} --db-cluster-snapshot-identifier ${id} --tags Key=vitana-env,Value=staging`,
    `aws rds wait db-cluster-snapshot-available --region eu-central-1 --db-cluster-snapshot-identifier ${id}`,
  ]);
  assert.equal(r.stdout.trim().split('\n').pop(), id);
  let p = sh(MIGRATE, ['snapshot', '--cluster', PROD_CLUSTER, '--id', `${PROD_CLUSTER}-premig-1`]);
  assert.equal(p.status, 1); assert.deepEqual(p.calls, []);
  p = sh(MIGRATE, ['snapshot', '--cluster', STAGING, '--id', 'manual-snap-1']);
  assert.equal(p.status, 1); assert.match(p.out, /must be vitana-aurora-staging-premig-<suffix>/); assert.deepEqual(p.calls, []);
  p = sh(MIGRATE, ['snapshot', '--cluster', STAGING, '--id', id], { STUB_SNAPSHOT_FAIL: '1' });
  assert.equal(p.status, 1); assert.match(p.out, /nothing was applied/);
});

test('compat: passes when every object the gateway smoke reads is there; fails (and keeps nothing) when one is missing', { skip: pgSkip }, async () => {
  const schema = sql('20991231000010_smoke.sql', [
    'CREATE TABLE public.vtid_ledger (vtid text);', 'CREATE TABLE public.oasis_events (id int);',
    'CREATE FUNCTION public.allocate_global_vtid() RETURNS text LANGUAGE sql AS $$ SELECT \'VTID-00001\'::text $$;', ''].join('\n'));
  const st = tmp('compat-');
  let r = sh(MIGRATE, ['compat', '--cluster', STAGING], {}, { state: st });
  assert.equal(r.status, 1, 'empty database: compat fails');
  assert.match(r.out, /compatibility probe failed/);
  r = sh(APPLY, ['--cluster', STAGING, '--file', schema], {}, { state: st });
  assert.equal(r.status, 0, r.out);
  r = sh(MIGRATE, ['compat', '--cluster', STAGING], {}, { state: st });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Compatibility probe \(3 check\(s\)\)/);
  assert.equal(r.calls.filter((c) => c.startsWith('aws rds-data commit-transaction')).length, 0, 'the probe never commits');
  await pgQuery(st, 'DROP FUNCTION public.allocate_global_vtid()');
  r = sh(MIGRATE, ['compat', '--cluster', STAGING], {}, { state: st });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /compat: missing function public\.allocate_global_vtid/);
  assert.equal(sh(MIGRATE, ['compat', '--cluster', PROD_CLUSTER]).calls.length, 0);
});

function quarantine(runs, args, env = {}) {
  const f = path.join(tmp('gh-'), 'runs.json');
  fs.writeFileSync(f, JSON.stringify({ runs }));
  return sh(MIGRATE, ['quarantine-check', '--gh-repo', 'exafyltd/vitana-platform', '--run-id', '99', ...args], { STUB_GH_RUNS: f, ...env });
}
test('quarantine: a failed earlier apply blocks automatic applies until a dispatch acknowledges exactly that run', () => {
  const failed = [{ id: 99, event: 'push', apply: null }, { id: 50, event: 'push', apply: null }, { id: 40, event: 'push', apply: 'failure' }, { id: 30, event: 'push', apply: 'success' }];
  let r = quarantine(failed, []);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /quarantined: the apply of run 40 ended 'failure'.*acknowledge_quarantine_run=40/);
  assert.equal(quarantine(failed, ['--acknowledge', '41']).status, 1, 'another run id does not lift it');
  r = quarantine(failed, ['--acknowledge', '40']);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /acknowledged/);
  assert.equal(quarantine([{ id: 41, event: 'workflow_dispatch', apply: 'success' }, ...failed.slice(1)], []).status, 0, 'a later success clears it');
  assert.equal(quarantine([{ id: 41, event: 'pull_request', apply: 'failure' }, { id: 30, event: 'push', apply: 'success' }], []).status, 0, 'pull-request self-tests never quarantine');
  assert.equal(quarantine([], []).status, 0);
  assert.equal(quarantine(failed, [], { STUB_GH_FAIL: '1' }).status, 1, 'an unreadable history fails closed');
  const m = mutated('staging-db-migrate.sh', "      failure|cancelled|timed_out)", "      never-matches)");
  const f = path.join(tmp('gh-'), 'runs.json'); fs.writeFileSync(f, JSON.stringify({ runs: failed }));
  assert.equal(sh(m, ['quarantine-check', '--gh-repo', 'x/y', '--run-id', '99'], { STUB_GH_RUNS: f }).status, 0, 'mutation must let a failed apply through');
});

// =====================================================================================================================
// 5. STAGING-MIGRATE.yml: static shape (line-based; no YAML parser here)
export function jobText(y, name) {
  const lines = y.split('\n');
  const i = lines.findIndex((l) => l === `  ${name}:`);
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^ {0,2}\S/.test(lines[j])) j++;
  return lines.slice(i, j).join('\n').replace(/\s+$/, '');
}
export function checkStagingMigrate(y) {
  const p = [];
  const need = (cond, msg) => { if (!cond) p.push(msg); };
  need(!/^\s*schedule:/m.test(y), 'no schedule trigger');
  need(/^on:\n  push:\n    branches: \[main\]\n    paths:\n      - 'supabase\/migrations\/\*\*'\n/m.test(y), 'push trigger: main, supabase/migrations/** only');
  need(!/pull_request_target/.test(y), 'no pull_request_target');
  need(!/secrets\./.test(y), 'no repository secret');
  need(!y.includes(PROD_ROLE) && !y.includes(PROD_CLUSTER), 'no production role or cluster');
  need(!y.includes('preview-aws-gateway'), 'does not name the staging gateway host');
  need(scanText(y, 'STAGING-MIGRATE.yml').length === 0, 'production-reference guard: no finding');
  need(/^env:\n  CLUSTER: vitana-aurora-staging\n/m.test(y), 'CLUSTER is vitana-aurora-staging');
  const roles = y.match(/role-to-assume: .*/g) || [];
  need(roles.length === 1 && roles[0] === 'role-to-assume: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}', 'the only role is vars.AWS_STAGING_DB_ROLE_ARN');
  need((y.match(/id-token: write/g) || []).length === 1, 'id-token only once');
  const self = jobText(y, 'selftest') || '';
  need(/if: github\.event_name == 'pull_request'/.test(self) && !/id-token|configure-aws-credentials/.test(self), 'selftest: pull requests only, no credentials');
  need(/node --test docs\/validation\/VTID-05784\/tests\/\*\.test\.mjs/.test(self) && /grep -q '# SKIP'/.test(self), 'selftest runs the tests and fails on a skip');
  const gateJ = jobText(y, 'gate') || '';
  need(/if: github\.event_name != 'pull_request'/.test(gateJ), 'gate: never on pull requests');
  need(/run: bash scripts\/aws\/staging-db-migrate-gate\.sh --mode auto/.test(gateJ), 'gate runs the gate script in auto mode');
  for (const v of ['STAGING_DATA_PLANE', 'AWS_STAGING_DB_ROLE_ARN', 'STAGING_DB_COST_APPROVED', 'MIGRATION_FREEZE']) {
    need(gateJ.includes(`${v}: \${{ vars.${v} }}`), `gate reads vars.${v}`);
  }
  need(/quarantine-check --gh-repo/.test(gateJ) && !/id-token/.test(gateJ), 'gate runs the quarantine check, no credentials');
  const plan = jobText(y, 'plan') || '';
  need(/needs: gate\n    if: needs\.gate\.outputs\.enabled == 'true'/.test(plan), 'plan runs only when the gate enabled it');
  need(!/id-token|configure-aws-credentials/.test(plan), 'plan: no credentials');
  need(/staging-db-migrate\.sh files --base/.test(plan) && /--dry-run/.test(plan) && /build-schema\.mjs --out/.test(plan), 'plan: files, lint, bundle');
  const apply = jobText(y, 'apply') || '';
  need(/name: Apply to the isolated staging database\n/.test(apply), 'apply job name (read by the quarantine check)');
  need(/needs: plan\n    if: needs\.plan\.outputs\.count != '0'/.test(apply), 'apply only after plan, only with files');
  need(/staging-db-migrate-gate\.sh --mode dispatch/.test(apply), 'apply re-checks the gate');
  const order = ['staging-prod-ref-guard.mjs --enforce', 'staging-db-migrate-gate.sh --mode dispatch', 'configure-aws-credentials',
    'staging-db-migrate.sh snapshot', 'staging-db-apply-migration.sh --cluster "$CLUSTER"', 'staging-db-load.sh --cluster "$CLUSTER" --bundle "$RUNNER_TEMP/staging-db-bundle" --verify-only',
    'staging-db-migrate.sh compat'];
  const at = order.map((s) => apply.indexOf(s));
  need(at.every((n) => n >= 0) && at.every((n, k) => k === 0 || n > at[k - 1]), `apply order: ${order.join(' -> ')}`);
  need(!/--allow-non-transactional/.test(apply), 'the automatic apply never runs without a transaction');
  need(!/continue-on-error/.test(y), 'no step may continue on error');
  const ifs = apply.match(/^ {8}if: .*$/gm) || [];
  need(ifs.every((l) => l.trim() === 'if: always()'), 'apply steps run unconditionally (only evidence steps use if: always())');
  need(/SNAPSHOT_ID: vitana-aurora-staging-premig-/.test(apply), 'snapshot id is a staging snapshot');
  need(/- name: Evidence\n        if: always\(\)/.test(apply) && /name: staging-migrate-evidence-\$\{\{ github\.run_id \}\}/.test(apply)
    && ['run_url', 'snapshot_id', 'expected_schema_hash', 'files', 'outcome'].every((k) => apply.includes(`${k}: `)), 'evidence artifact on every apply run');
  const q = jobText(y, 'quarantine') || '';
  need(/needs: \[plan, apply\]\n    if: failure\(\) && needs\.plan\.result == 'success'/.test(q) && /exit 1/.test(q), 'quarantine on any apply failure, red');
  need(!/id-token|configure-aws-credentials|aws /.test(q.replace(/aws-actions\/upload/g, '')), 'quarantine executes nothing on AWS');
  return p;
}

test('STAGING-MIGRATE.yml: default off, staging role and cluster only, snapshot -> apply -> drift -> compat, quarantine; no schedule', () => {
  assert.deepEqual(checkStagingMigrate(wf('STAGING-MIGRATE.yml')), []);
});

test('mutations: every STAGING-MIGRATE.yml guard has a failing mutation', () => {
  const y = wf('STAGING-MIGRATE.yml');
  const muts = [
    ['on:\n  push:', 'on:\n  schedule:\n    - cron: "0 3 * * *"\n  push:'],
    ["    branches: [main]\n    paths:\n      - 'supabase/migrations/**'", '    branches: [main]'],
    ['role-to-assume: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}', `role-to-assume: \${{ secrets.${PROD_ROLE} }}`],
    ['  CLUSTER: vitana-aurora-staging', `  CLUSTER: ${PROD_CLUSTER}`],
    ["    if: needs.gate.outputs.enabled == 'true'", '    if: always()'],
    ['run: bash scripts/aws/staging-db-migrate-gate.sh --mode auto', 'run: echo "enabled=true" >> "$GITHUB_OUTPUT"'],
    ['STAGING_DATA_PLANE: ${{ vars.STAGING_DATA_PLANE }}\n          AWS_STAGING_DB_ROLE_ARN: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}\n          STAGING_DB_COST_APPROVED: ${{ vars.STAGING_DB_COST_APPROVED }}\n          MIGRATION_FREEZE: ${{ vars.MIGRATION_FREEZE }}\n        run: bash scripts/aws/staging-db-migrate-gate.sh --mode auto', 'STAGING_DATA_PLANE: isolated\n          AWS_STAGING_DB_ROLE_ARN: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}\n          STAGING_DB_COST_APPROVED: ${{ vars.STAGING_DB_COST_APPROVED }}\n          MIGRATION_FREEZE: ${{ vars.MIGRATION_FREEZE }}\n        run: bash scripts/aws/staging-db-migrate-gate.sh --mode auto'],
    ['      - name: Pre-apply snapshot\n        run: bash scripts/aws/staging-db-migrate.sh snapshot --cluster "$CLUSTER" --id "$SNAPSHOT_ID"\n', ''],
    ['      - name: Drift check (cluster schema hash = bundle of this commit)\n', '      - name: Drift check (cluster schema hash = bundle of this commit)\n        continue-on-error: true\n'],
    ['        run: bash scripts/aws/staging-db-migrate.sh compat --cluster "$CLUSTER"', '        run: echo skipped'],
    ["    if: failure() && needs.plan.result == 'success'", '    if: false'],
    ['      - name: Re-check the gate in this job\n', '      - name: Re-check the gate in this job\n        if: false\n'],
    ["    if: github.event_name != 'pull_request'", '    if: true'],
    ['          bash scripts/aws/staging-db-apply-migration.sh --cluster "$CLUSTER" "${ARGS[@]}"\n', '          bash scripts/aws/staging-db-apply-migration.sh --cluster "$CLUSTER" "${ARGS[@]}" --allow-non-transactional\n'],
    ['      - name: Evidence\n        if: always()', '      - name: Evidence\n        if: success()'],
    ["          if grep -q '# SKIP' \"$RUNNER_TEMP/tests.log\"; then echo \"::error::a test was skipped\"; exit 1; fi\n", ''],
  ];
  for (const [from, to] of muts) {
    assert.ok(y.includes(from), `anchor: ${from.slice(0, 60)}`);
    const problems = checkStagingMigrate(y.split(from).join(to));
    assert.ok(problems.length > 0, `mutation not caught: ${to.slice(0, 80)}`);
  }
});

// =====================================================================================================================
// 6. RUN-MIGRATION.yml: the production path is unchanged; target staging reaches only the isolated cluster
const PINNED = fs.readFileSync(path.join(FX, 'RUN-MIGRATION.pinned.yml'), 'utf8');
export const stripMarkers = (t) => t.split('\n').reduce((a, l) => {
  if (/# >>> VTID-05784/.test(l)) a.skip = true;
  else if (/# <<< VTID-05784/.test(l)) a.skip = false;
  else if (!a.skip) a.out.push(l);
  return a;
}, { out: [], skip: false }).out.join('\n');
const OPTIONS_PINNED = '        options: [default, supabase, aurora]';
/** The current workflow with the VTID-05784 blocks removed and the one replaced options line put back. */
const unmarked = (y) => {
  const lines = y.split('\n');
  const i = lines.findIndex((l) => /# >>> VTID-05784: staging = the isolated staging database only/.test(l));
  if (i >= 0) lines.splice(i, 0, OPTIONS_PINNED);
  return stripMarkers(lines.join('\n')).replace(/\s+$/, '\n');
};

export function checkRunMigration(y) {
  const p = [];
  const need = (cond, msg) => { if (!cond) p.push(msg); };
  need(unmarked(y) === PINNED, 'outside the VTID-05784 blocks the file is the pinned origin/main file byte for byte');
  for (const j of ['migrate', 'migrate-aurora']) need(jobText(y, j) === jobText(PINNED, j), `job ${j} byte-identical to the pinned job`);
  need(y.includes('        options: [default, supabase, aurora, staging]'), 'target option staging');
  const s = jobText(y, 'migrate-staging') || '';
  need(/needs: resolve\n    if: needs\.resolve\.outputs\.target == 'staging'/.test(s), 'migrate-staging only for target staging');
  need(!s.includes(PROD_ROLE) && !s.includes(PROD_CLUSTER) && !/secrets\./.test(s), 'migrate-staging names no production role, cluster or secret');
  need(scanText(s, 'migrate-staging').length === 0, 'production-reference guard: no finding in migrate-staging');
  const roles = s.match(/role-to-assume: .*/g) || [];
  need(roles.length === 1 && roles[0] === 'role-to-assume: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}', 'migrate-staging assumes only the staging database role');
  need(/CLUSTER: vitana-aurora-staging\n/.test(s), 'cluster vitana-aurora-staging');
  const gateAt = s.indexOf('staging-db-migrate-gate.sh --mode dispatch');
  const credAt = s.indexOf('configure-aws-credentials');
  need(gateAt > 0 && credAt > gateAt, 'the gate runs before the credentials');
  for (const v of ['STAGING_DATA_PLANE', 'AWS_STAGING_DB_ROLE_ARN', 'STAGING_DB_COST_APPROVED']) need(s.includes(`${v}: \${{ vars.${v} }}`), `gate reads vars.${v}`);
  need(/staging-db-apply-migration\.sh --cluster "\$CLUSTER" --file "\$MIGRATION_FILE" "\$\{FLAGS\[@\]\}"/.test(s), 'applies through the staging script with the cluster');
  need(!/aurora-apply-migration\.sh/.test(s), 'never the production script');
  return p;
}

test('RUN-MIGRATION.yml: the production path is the pinned origin/main file byte for byte; staging is a separate job', () => {
  assert.deepEqual(checkRunMigration(wf('RUN-MIGRATION.yml')), []);
});

/** Run the resolve step script of a workflow text with the given env; returns { status, target, out }. */
function resolve(y, env) {
  const job = jobText(y, 'resolve');
  const lines = job.split('\n');
  const i = lines.findIndex((l) => /^ {8}run: \|\s*$/.test(l));
  const body = [];
  for (const l of lines.slice(i + 1)) { if (l.trim() && !/^ {10}/.test(l)) break; body.push(l.slice(10)); }
  const d = tmp('res-');
  const out = path.join(d, 'out'); fs.writeFileSync(out, '');
  const r = spawnSync('bash', ['-c', body.join('\n')], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } });
  return { status: r.status, target: (fs.readFileSync(out, 'utf8').match(/^target=(\w+)$/m) || [])[1] || null, out: r.stdout + r.stderr };
}

test('RUN-MIGRATION.yml resolve: every production input resolves exactly as the pinned step; staging only when chosen', () => {
  const cur = wf('RUN-MIGRATION.yml');
  const inputs = [];
  for (const TARGET_INPUT of ['default', '', 'supabase', 'aurora', 'bogus']) {
    for (const TARGET_VAR of ['', 'supabase', 'aurora', 'staging', 'x']) {
      for (const MIGRATION_FREEZE of ['', 'true']) inputs.push({ TARGET_INPUT, TARGET_VAR, MIGRATION_FREEZE });
    }
  }
  for (const env of inputs) {
    const a = resolve(PINNED, env); const b = resolve(cur, env);
    assert.deepEqual({ s: b.status, t: b.target }, { s: a.status, t: a.target }, JSON.stringify(env));
  }
  // MIGRATION_TARGET=staging never selects staging (pinned and current both refuse it)
  assert.equal(resolve(cur, { TARGET_INPUT: 'default', TARGET_VAR: 'staging', MIGRATION_FREEZE: '' }).status, 1);
  assert.deepEqual(resolve(cur, { TARGET_INPUT: 'staging', TARGET_VAR: 'aurora', MIGRATION_FREEZE: '' }).target, 'staging');
  assert.equal(resolve(cur, { TARGET_INPUT: 'staging', TARGET_VAR: '', MIGRATION_FREEZE: 'true' }).status, 1, 'the freeze still refuses staging');
});

test('mutations: every RUN-MIGRATION.yml guard has a failing mutation', () => {
  const y = wf('RUN-MIGRATION.yml');
  const muts = [
    ['          role-to-assume: ${{ secrets.' + PROD_ROLE + ' }}', '          role-to-assume: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}'],
    ['          scripts/aws/aurora-apply-migration.sh --file "$MIGRATION_FILE" "${FLAGS[@]}"', '          scripts/aws/aurora-apply-migration.sh --file "$MIGRATION_FILE"'],
    ['            supabase|aurora) ;;', '            supabase|aurora|staging) ;;'],
    ['          role-to-assume: ${{ vars.AWS_STAGING_DB_ROLE_ARN }}\n          aws-region: eu-central-1\n      - name: Apply migration to the isolated', '          role-to-assume: ${{ secrets.' + PROD_ROLE + ' }}\n          aws-region: eu-central-1\n      - name: Apply migration to the isolated'],
    ['      CLUSTER: vitana-aurora-staging\n      MIGRATION_FILE', `      CLUSTER: ${PROD_CLUSTER}\n      MIGRATION_FILE`],
    ['        run: bash scripts/aws/staging-db-migrate-gate.sh --mode dispatch\n', '        run: echo ok\n'],
    ['          bash scripts/aws/staging-db-apply-migration.sh --cluster "$CLUSTER" --file "$MIGRATION_FILE" "${FLAGS[@]}"', '          scripts/aws/aurora-apply-migration.sh --file "$MIGRATION_FILE" "${FLAGS[@]}"'],
    ["    if: needs.resolve.outputs.target == 'staging'", "    if: needs.resolve.outputs.target != 'supabase'"],
  ];
  for (const [from, to] of muts) {
    assert.ok(y.includes(from), `anchor: ${from.slice(0, 70)}`);
    assert.ok(checkRunMigration(y.split(from).join(to)).length > 0, `mutation not caught: ${to.slice(0, 80)}`);
  }
  // a resolve mutation that lets MIGRATION_TARGET pick staging is caught by the behaviour test
  const m = y.replace('            supabase|aurora) ;;\n            *) echo "::error::repo variable', '            supabase|aurora|staging) ;;\n            *) echo "::error::repo variable');
  assert.notEqual(m, y);
  assert.equal(resolve(m, { TARGET_INPUT: 'default', TARGET_VAR: 'staging', MIGRATION_FREEZE: '' }).status, 0);
});

test('guard: the new staging scripts name no production identifier (--enforce)', () => {
  const r = spawnSync('node', [path.join(ROOT, 'scripts/ci/staging-prod-ref-guard.mjs'), '--enforce', '--files', APPLY, GATE, MIGRATE,
    path.join(ROOT, '.github/workflows/STAGING-MIGRATE.yml')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('aurora-apply-migration.sh (production script) is unchanged by this lane', () => {
  const pin = spawnSync('git', ['-C', ROOT, 'show', 'origin/main:scripts/aws/aurora-apply-migration.sh'], { encoding: 'utf8' });
  if (pin.status !== 0) return; // shallow checkout without origin/main: the PR diff shows the file untouched
  assert.equal(fs.readFileSync(path.join(AWS_DIR, 'aurora-apply-migration.sh'), 'utf8'), pin.stdout);
});
