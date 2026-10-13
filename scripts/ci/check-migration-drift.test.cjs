// VTID-05158 — Aurora-only tables in the migration-drift check.
// Runs in UNIT.yml (node:test, no install): node --test scripts/ci/check-migration-drift.test.cjs
//
// Both branches the plan requires:
//   * an Aurora-only table absent from the live Supabase snapshot  -> pass
//   * an Aurora-only table PRESENT in the live Supabase snapshot   -> fail
//   * a non-listed declared table missing from Supabase            -> fail as before
// plus the real repo state: every table the health store migration declares is
// listed, and the listed entries are well-formed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  evaluateDrift,
  parseAuroraOnly,
  parseMigrationSql,
  collectDeclaredTables,
} = require('./check-migration-drift.cjs');

const ROOT = join(__dirname, '..', '..');
const BASELINE = JSON.parse(readFileSync(join(__dirname, 'migration-drift-baseline.json'), 'utf8'));
const STORE_MIGRATION = join(ROOT, 'supabase', 'migrations', '20261014100100_vtid_05158_health_store.sql');

const aurora = new Map([['health_series_5m', { vtid: 'VTID-05158', reason: 'Aurora only' }]]);
const expected = new Map([
  ['profiles', 'a.sql'],
  ['health_series_5m', 'b.sql'],
]);

test('Aurora-only table absent from Supabase passes and is not reported missing', () => {
  const r = evaluateDrift({ expected, live: new Set(['profiles']), baseline: new Set(), auroraOnly: aurora });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.newlyMissing, []);
  assert.deepEqual(r.auroraOnlyOnSupabase, []);
  assert.deepEqual(r.auroraOnlyAbsent, ['health_series_5m']);
});

test('Aurora-only table present in the Supabase snapshot fails', () => {
  const r = evaluateDrift({
    expected,
    live: new Set(['profiles', 'health_series_5m']),
    baseline: new Set(),
    auroraOnly: aurora,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.auroraOnlyOnSupabase, ['health_series_5m']);
  assert.deepEqual(r.newlyMissing, []);
});

test('a non-listed declared table missing from Supabase still fails as before', () => {
  const r = evaluateDrift({
    expected: new Map([...expected, ['orb_session_state', 'c.sql']]),
    live: new Set(['profiles']),
    baseline: new Set(),
    auroraOnly: aurora,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.newlyMissing, ['orb_session_state']);
});

test('without an Aurora-only list the store table would be reported as new drift', () => {
  const r = evaluateDrift({ expected, live: new Set(['profiles']), baseline: new Set() });
  assert.equal(r.ok, false);
  assert.deepEqual(r.newlyMissing, ['health_series_5m']);
});

test('aurora_only_tables entries need table, VTID and reason', () => {
  const ok = parseAuroraOnly({ aurora_only_tables: [{ table: 'X', vtid: 'VTID-05158', reason: 'r' }] });
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.map.has('x'));
  for (const bad of [{ table: 'x', vtid: 'VTID-05158' }, { table: 'x', reason: 'r' }, { vtid: 'VTID-05158', reason: 'r' }, { table: 'x', vtid: '5158', reason: 'r' }]) {
    const p = parseAuroraOnly({ aurora_only_tables: [bad] });
    assert.equal(p.errors.length, 1, JSON.stringify(bad));
    assert.equal(p.map.size, 0);
  }
});

test('the repo baseline lists every table the health store migration declares, and nothing else of VTID-05158', () => {
  const { map, errors } = parseAuroraOnly(BASELINE);
  assert.deepEqual(errors, []);
  const declared = [...parseMigrationSql(readFileSync(STORE_MIGRATION, 'utf8')).created].sort();
  assert.deepEqual(declared, [
    'health_codes',
    'health_ingest_batches',
    'health_ingest_quarantine',
    'health_observations',
    'health_series_1d',
    'health_series_1h',
    'health_series_5m',
    'health_store_maintenance_runs',
  ]);
  for (const t of declared) assert.ok(map.has(t), `${t} is not in aurora_only_tables`);
  const listed05158 = [...map].filter(([, v]) => v.vtid === 'VTID-05158').map(([t]) => t).sort();
  assert.deepEqual(listed05158, declared);
  // None of them is also a known-missing (Supabase) table.
  for (const t of declared) assert.ok(!BASELINE.known_missing_tables.includes(t));
  // Partitions are created by a function, never by top-level DDL the check would count.
  assert.ok(![...collectDeclaredTables().keys()].some((t) => /^health_.*_p\d{6,8}$/.test(t)));
});

test('CLI: passes on a snapshot without the store tables, fails when one appears on Supabase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-05158-'));
  try {
    const { map } = parseAuroraOnly(BASELINE);
    const known = new Set(BASELINE.known_missing_tables);
    const supabase = [...collectDeclaredTables().keys()].filter((t) => !known.has(t) && !map.has(t));
    const clean = join(dir, 'clean.txt');
    writeFileSync(clean, supabase.join('\n') + '\n');
    const ok = spawnSync(process.execPath, [join(__dirname, 'check-migration-drift.cjs'), '--live', clean], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /No new migration drift/);

    const wrong = join(dir, 'wrong.txt');
    writeFileSync(wrong, [...supabase, 'health_observations'].join('\n') + '\n');
    const bad = spawnSync(process.execPath, [join(__dirname, 'check-migration-drift.cjs'), '--live', wrong], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Aurora-only table "health_observations" \(VTID-05158/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
