// VTID-05520: the pgTAP-compatible shim. Real pgTAP is not used on this stack; the shim is the harness.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createStack, runTapFile, REPO_ROOT } from '../../../scripts/mt/stack/stack.mjs';

const here = (f) => join(REPO_ROOT, 'supabase/tests/local-stack', f);
const CLI = join(REPO_ROOT, 'scripts/mt/stack/run-tap.mjs');

describe('shim', () => {
  let db;
  before(async () => { ({ db } = await createStack()); });
  after(async () => { await db.close(); });

  test('smoke.tap.sql passes: plan, ok, is, isnt, matches, lives_ok, throws_ok, is_empty, results_eq, set_eq, finish', async () => {
    const r = await runTapFile(db, here('smoke.tap.sql'));
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.ok(r.planned >= 12 && r.run === r.planned);
    assert.equal(r.failed, 0);
  });

  test('role switching works: authenticated sees the claims, and the shim stays callable', async () => {
    const r = await runTapFile(db, here('role-claims.tap.sql'));
    assert.equal(r.ok, true, r.lines.join('\n'));
  });

  for (const [file, why] of [
    ['negative/failing-assertion.tap.sql', /not ok 1/],
    ['negative/plan-mismatch.tap.sql', /planned 3 tests but ran 1/],
    ['negative/plan-mismatch-no-finish.tap.sql', /ok 1 - only one test runs/],
    ['negative/no-plan.tap.sql', /^ok 1 - a test without a plan/m],
    ['negative/sql-error.tap.sql', /SQL ERROR/],
    ['negative/listed-table.tap.sql', /unverified/i],
  ]) {
    test(`${file} fails (the shim does not pass what it should fail)`, async () => {
      const r = await runTapFile(db, here(file));
      assert.equal(r.ok, false);
      assert.match(r.lines.join('\n'), why);
    });
  }

  test('require_table on a listed table is "not ok", names the reason, and on a present table is "ok"', async () => {
    const bad = await runTapFile(db, here('negative/listed-table.tap.sql'));
    assert.match(bad.lines.join('\n'), /not ok 1 .*live_rooms/);
    assert.match(bad.lines.join('\n'), /unverified: /);
    const good = await runTapFile(db, here('smoke.tap.sql'));
    assert.match(good.lines.join('\n'), /ok \d+ - table tenants is replayed/);
  });
});

describe('run-tap.mjs CLI', () => {
  const run = (f) => spawnSync(process.execPath, [CLI, here(f)], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000 });
  test('exits 0 and prints PASS on a green file', () => {
    const r = run('smoke.tap.sql');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS local-stack smoke\.tap\.sql/m);
  });
  test('exits 1 and prints FAIL on a red file, never PASS', () => {
    const r = run('negative/failing-assertion.tap.sql');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL/);
    assert.doesNotMatch(r.stdout, /^PASS/m);
  });
});
