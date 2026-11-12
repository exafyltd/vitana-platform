// VTID-05520 (mt-guardrails-r2/local-test-stack-pglite): the gate over the repo's real migration tree
// (plan.md Amendments 2 and 3). One in-process PGlite database per test file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  PATHS,
  openDb,
  replay,
  checkRequiredTables,
  loadSkips,
  loadRequired,
  loadNotReplayable,
  createStack,
  StackGateError,
} from '../../../scripts/mt/stack/stack.mjs';

const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');
const HEALTH = ['health_features_daily', 'biomarker_results', 'wearable_samples', 'partner_health_test_orders', 'data_sharing_consents'];

describe('the lists', () => {
  const required = loadRequired();
  const notReplayable = loadNotReplayable();
  const skips = loadSkips();

  test('required-tables.txt: the 18 tenant tables of docs/MULTI-TENANT-PLAN.md section 2, the 5 health tables and user_tenants (24)', () => {
    const plan = read('docs/MULTI-TENANT-PLAN.md');
    const line = plan.split('\n').find((l) => l.includes('access_audit_log, community_groups'));
    assert.ok(line, 'plan section 2 line listing the 18 tables not found');
    const eighteen = line.slice(line.indexOf('access_audit_log'), line.indexOf('. User-private')).split(',').map((s) => s.trim().replace(/`/g, ''));
    assert.equal(eighteen.length, 18);
    const expected = [...new Set([...eighteen, ...HEALTH, 'tenants', 'user_tenants'])].sort();
    assert.equal(expected.length, 24);
    assert.deepEqual([...required].sort(), expected);
  });

  test('not-replayable.txt: every entry is a required table with a reason and at least one lane; no duplicates', () => {
    assert.ok(notReplayable.length > 0);
    const seen = new Set();
    for (const e of notReplayable) {
      assert.ok(required.includes(e.table), `${e.table} is listed but not required`);
      assert.ok(e.reason.length >= 10, `${e.table} needs a real reason`);
      assert.ok(e.lanes.length >= 1, `${e.table} needs the lanes that need it`);
      assert.ok(!seen.has(e.table), `${e.table} listed twice`);
      seen.add(e.table);
    }
  });

  test('replay-skip.json: sorted, unique, each skip has file, reason and error, and the file exists', () => {
    assert.ok(skips.length > 0);
    const files = skips.map((s) => s.file);
    assert.deepEqual(files, [...files].sort());
    assert.equal(new Set(files).size, files.length);
    for (const s of skips) {
      assert.ok(s.reason && s.reason.length >= 5, `${s.file}: reason`);
      assert.ok(s.error && s.error.length >= 5, `${s.file}: error line`);
      assert.ok(existsSync(join(PATHS.migrations, s.file)), `${s.file} does not exist in supabase/migrations`);
    }
  });
});

describe('replay of supabase/migrations on PGlite', () => {
  let db;
  let result;
  before(async () => {
    db = await openDb();
    result = await replay(db, { migrationsDir: PATHS.migrations, skips: loadSkips(), attemptSkipped: true });
  });
  after(async () => { await db.close(); });

  test('every migration either applies or is a listed skip: no unlisted failure, no stale skip', () => {
    assert.deepEqual(result.failed, [], `unlisted failures: ${result.failed.map((f) => `${f.file}: ${f.error}`).join(' | ')}`);
    assert.deepEqual(result.staleSkips, []);
  });

  test('each listed skip still fails with the error line recorded for it', () => {
    const byFile = new Map(loadSkips().map((s) => [s.file, s]));
    for (const s of result.skipped) assert.equal(s.error, byFile.get(s.file).error, s.file);
    assert.equal(result.skipped.length, byFile.size);
  });

  test('required tables: present + SKIP (listed) = all, no failure', async () => {
    const required = loadRequired();
    const r = await checkRequiredTables(db, required, loadNotReplayable());
    assert.deepEqual(r.failures, []);
    assert.equal(r.present.length + r.skipped.length, required.length);
    assert.deepEqual(r.skipped.map((s) => s.table).sort(), loadNotReplayable().map((e) => e.table).sort());
    for (const h of ['health_features_daily', 'biomarker_results', 'wearable_samples']) assert.ok(r.present.includes(h), h);
    for (const t of ['tenants', 'user_tenants']) assert.ok(r.present.includes(t), t);
  });
});

describe('createStack', () => {
  test('without attemptSkipped it reaches the same required-table result and reports the numbers', async () => {
    const { db, report } = await createStack({ fixtures: false, shim: false });
    assert.equal(report.required.length, loadRequired().length);
    assert.equal(report.tables.present.length + report.tables.skipped.length, report.required.length);
    assert.equal(report.replay.failed.length, 0);
    assert.equal(report.replay.skipped.length, loadSkips().length);
    await db.close();
  });

  test('a stale not-replayable listing makes createStack throw and name the table', async () => {
    await assert.rejects(
      createStack({ fixtures: false, shim: false, notReplayable: [...loadNotReplayable(), { table: 'tenants', reason: 'stale on purpose', lanes: ['isolation-suite'] }] }),
      (e) => e instanceof StackGateError && /tenants/.test(e.message) && /stale/i.test(e.message),
    );
  });

  test('an unlisted missing required table makes createStack throw and name the table', async () => {
    const dropped = loadNotReplayable().filter((e) => e.table !== 'live_rooms');
    await assert.rejects(
      createStack({ fixtures: false, shim: false, notReplayable: dropped }),
      (e) => e instanceof StackGateError && /live_rooms/.test(e.message),
    );
  });
});

describe('docs, workflow and dependency', () => {
  test('LOCAL-STACK.md reports every listed table as unverified with its reason, states pgTAP is not used and what is not covered', () => {
    const doc = read('docs/multitenancy/LOCAL-STACK.md');
    for (const e of loadNotReplayable()) {
      assert.ok(doc.includes(`\`${e.table}\``), `LOCAL-STACK.md does not name ${e.table}`);
    }
    assert.match(doc, /unverified/i);
    assert.match(doc, /real pgTAP is not used/i);
    assert.match(doc, /does not cover/i);
    assert.match(doc, /replay-skip\.json/);
    assert.match(doc, /required-tables\.txt/);
    assert.match(doc, /stack\.mjs:\d+/);
  });

  test('LOCAL-STACK.md unverified-tables section lists exactly the tables of not-replayable.txt', () => {
    const doc = read('docs/multitenancy/LOCAL-STACK.md');
    const section = doc.slice(doc.indexOf('## Unverified tables'));
    const rows = [...section.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]).sort();
    assert.deepEqual(rows, loadNotReplayable().map((e) => e.table).sort());
  });

  test('LOCAL-STACK.md loader references point at the line that defines the named function', () => {
    const doc = read('docs/multitenancy/LOCAL-STACK.md');
    const src = read('scripts/mt/stack/stack.mjs').split('\n');
    const refs = [...doc.matchAll(/`(\w+)` \(`scripts\/mt\/stack\/stack\.mjs:(\d+)`\)/g)];
    assert.ok(refs.length >= 6);
    for (const [, name, line] of refs) {
      assert.match(src[Number(line) - 1], new RegExp(`(function|class) ${name}\\b`), `${name} is not defined at stack.mjs:${line}`);
    }
  });

  test('MT-LOCAL-STACK.yml runs the suite on PGlite with no Docker, no service container and no secret', () => {
    const wf = read('.github/workflows/MT-LOCAL-STACK.yml');
    assert.match(wf, /^name: MT-LOCAL-STACK$/m);
    assert.match(wf, /^on:\n  push:\n    branches:/m);
    assert.doesNotMatch(wf.split('workflow_dispatch:')[0], /^    paths:/m, 'a push path filter skips the run on an update-branch merge commit');
    assert.match(wf, /kiro\/mt-guardrails-r2\/\*\*/);
    assert.match(wf, /workflow_dispatch:/);
    assert.doesNotMatch(wf, /^  pull_request:/m, 'a path-filtered pull_request workflow must be in config/delivery/services.json, which is outside this lane');
    assert.match(wf, /npm run test:mt-stack|pnpm run test:mt-stack/);
    // YAML comments explain the rule ("no Docker"); only the workflow's own keys and commands are checked.
    const code = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(code, /docker|container:|services:|supabase start|secrets\./i);
  });

  test('package.json pins @electric-sql/pglite exactly and the lockfile carries that version', () => {
    const pkg = JSON.parse(read('package.json'));
    const v = (pkg.devDependencies || {})['@electric-sql/pglite'];
    assert.match(v, /^\d+\.\d+\.\d+$/);
    assert.ok(read('pnpm-lock.yaml').includes(`'@electric-sql/pglite@${v}'`));
    assert.match(pkg.scripts['test:mt-stack'], /node --test .*supabase\/tests\/local-stack/);
  });
});
