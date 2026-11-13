// VTID-05782 (plan autonomous-to-staging-r2, lane staging-db-provision): the staging schema bundle (design.md §5).
//   node --test scripts/ci/staging-db/build-schema.test.mjs
// The pure helpers run everywhere (UNIT.yml, no install). The replay cases need @electric-sql/pglite and run where it
// is installed (STAGING-DB-SCHEMA.yml, `pnpm install`); without it they are skipped and say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SMOKE_OBJECTS, MARKER, BuildError, missingSmokeObjects, bundleText, parseBundle, checkBundleRefs, verifyBundle, parseArgs, build, sha256,
} from './build-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `sdb-${p}-`));
let pglite = true;
try { await import('@electric-sql/pglite'); } catch { pglite = false; }
const NEEDS = pglite ? {} : { skip: '@electric-sql/pglite not installed (runs in STAGING-DB-SCHEMA.yml)' };

/** A fake db: query(sql, [schema, name]) finds `present` names. */
const fakeDb = (present) => ({ query: async (_sql, p) => ({ rows: present.includes(p[1]) ? [{ '?column?': 1 }] : [] }) });

test('smoke objects are the ledger and OASIS tables the gateway smoke reads, and the VTID allocator', () => {
  assert.deepEqual(SMOKE_OBJECTS.map((o) => `${o.kind} ${o.schema}.${o.name}`),
    ['table public.vtid_ledger', 'table public.oasis_events', 'function public.allocate_global_vtid']);
  const smoke = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/staging-verify/smoke/gateway.json'), 'utf8'));
  assert.ok(smoke.tests.some((t) => t.path === '/api/v1/vtid/health') && smoke.tests.some((t) => t.path === '/api/v1/oasis/tasks'));
});

test('missingSmokeObjects names every object that is not there', async () => {
  assert.deepEqual(await missingSmokeObjects(fakeDb(['vtid_ledger', 'oasis_events', 'allocate_global_vtid'])), []);
  assert.deepEqual(await missingSmokeObjects(fakeDb(['oasis_events'])), ['table public.vtid_ledger', 'function public.allocate_global_vtid']);
});

test('bundle round trip keeps every part byte-exact and checks each sha256', () => {
  const parts = [{ name: 'a.sql', sql: 'SELECT 1;\n' }, { name: 'b.sql', sql: 'SELECT 2; -- no trailing newline' }, { name: 'c.sql', sql: '\n\nSELECT 3;\n\n' }];
  const text = bundleText(parts);
  const back = parseBundle(text);
  assert.deepEqual(back.map((p) => [p.name, p.sql]), parts.map((p) => [p.name, p.sql]));
  assert.throws(() => parseBundle(text.replace('SELECT 2', 'SELECT 9')), /sha256 mismatch for part 1 b\.sql/);
  assert.throws(() => bundleText([{ name: 'x.sql', sql: `${MARKER}0000 evil.sql sha256=${'0'.repeat(64)}\n` }]), BuildError);
});

test('production references in the bundle must be in the allow list, with the exact count; stale entries fail', () => {
  const parts = [{ name: 'm1.sql', sql: '-- runs on vitana-gateway-awsdr\nSELECT 1;\n' }];
  const ok = { entries: [{ part: 'm1.sql', id: 'awsdr-service', match: 'vitana-gateway-awsdr', count: 1 }] };
  assert.deepEqual(checkBundleRefs(parts, ok).unallowed, []);
  assert.deepEqual(checkBundleRefs(parts, ok).stale, []);
  assert.equal(checkBundleRefs(parts, { entries: [] }).unallowed.length, 1);
  assert.match(checkBundleRefs(parts, { entries: [{ ...ok.entries[0], count: 2 }] }).unallowed[0], /occurs 1 time/);
  const added = [...parts, { name: 'm2.sql', sql: "SELECT 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';\n" }];
  assert.match(checkBundleRefs(added, ok).unallowed[0], /m2\.sql: supabase-project-ref/);
  assert.equal(checkBundleRefs([{ name: 'm1.sql', sql: 'SELECT 1;\n' }], ok).stale.length, 1);
});

test('the allow list in the repo names only migration parts and gives a reason for each', () => {
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra/staging-db/bundle-prod-ref-allow.json'), 'utf8'));
  assert.ok(allow.entries.length > 0);
  for (const e of allow.entries) {
    assert.match(e.part, /^supabase\/migrations\/[^/]+\.sql$/);
    assert.ok(fs.existsSync(path.join(ROOT, e.part)), e.part);
    assert.ok(e.reason && e.reason.length > 10, e.part);
    assert.ok(Number.isInteger(e.count) && e.count > 0);
  }
});

test('verifyBundle refuses a tampered bundle, a missing manifest and a wrong schema', () => {
  const dir = tmp('verify');
  const parts = [{ name: 'supabase/migrations/x.sql', sql: 'SELECT 1;\n' }];
  const text = bundleText(parts);
  const manifest = { schema: 'vitana.staging-db-bundle/v1', schema_hash: 'a'.repeat(64), bundle_sha256: sha256(text), files: [{ n: 0, name: parts[0].name, sha256: sha256(parts[0].sql) }] };
  const allowFile = path.join(dir, 'allow.json');
  fs.writeFileSync(allowFile, '{"entries":[]}');
  assert.throws(() => verifyBundle(dir, { allowFile }), /bundle\.sql missing/);
  fs.writeFileSync(path.join(dir, 'bundle.sql'), text);
  assert.throws(() => verifyBundle(dir, { allowFile }), /manifest\.json missing/);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.equal(verifyBundle(dir, { allowFile }).schema_hash, 'a'.repeat(64));
  fs.writeFileSync(path.join(dir, 'bundle.sql'), text.replace('SELECT 1', 'SELECT 2'));
  assert.throws(() => verifyBundle(dir, { allowFile }), /sha256 does not match/);
  fs.writeFileSync(path.join(dir, 'bundle.sql'), text);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, schema: 'other' }));
  assert.throws(() => verifyBundle(dir, { allowFile }), /manifest schema/);
});

test('CLI usage: --out is required; --verify takes one directory', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--bogus']), /usage/);
  assert.deepEqual(parseArgs(['--verify', 'd']), { verify: 'd' });
  assert.deepEqual(parseArgs(['--out', 'o', '--skips', 's']), { out: 'o', skips: 's' });
});

test('build-schema succeeds on this checkout: hash, bundle, smoke objects, seed, no live production reference', NEEDS, async () => {
  const out = tmp('build');
  const m = await build({ outDir: out });
  assert.match(m.schema_hash, /^[0-9a-f]{64}$/);
  assert.ok(m.counts.migrations_applied > 300, `${m.counts.migrations_applied} migrations applied`);
  assert.equal(m.counts.seed, fs.readdirSync(path.join(ROOT, 'infra/staging-db/seed')).filter((f) => f.endsWith('.sql')).length);
  assert.equal(m.files[0].name, 'scripts/mt/stack/stub-auth.sql');
  assert.equal(m.files.at(-1).name, 'infra/staging-db/seed/020_neutralize_production_callouts.sql');
  const text = fs.readFileSync(path.join(out, 'bundle.sql'), 'utf8');
  assert.equal(sha256(text), m.bundle_sha256);
  assert.ok(text.includes("'a27552a3-0257-4305-8ed0-351a80fd3701'"), 'the documented test user is seeded');
  const again = await build({ outDir: tmp('build2') });
  assert.equal(again.schema_hash, m.schema_hash, 'the hash is deterministic');
  assert.equal(again.bundle_sha256, m.bundle_sha256, 'the bundle is deterministic');
  const cli = spawnSync(process.execPath, [path.join(HERE, 'build-schema.mjs'), '--verify', out], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
});

test('build-schema fails when a required table is removed from the replay (fixture skip list)', NEEDS, async () => {
  const skips = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase/tests/local-stack/replay-skip.json'), 'utf8'));
  const file = path.join(tmp('skips'), 'replay-skip.json');
  skips.skips.push({ file: '20251231000000_vtid_01101_phase_a_bootstrap.sql', reason: 'fixture: drop the creator of user_tenants', error: 'fixture' });
  fs.writeFileSync(file, JSON.stringify(skips));
  const r = spawnSync(process.execPath, [path.join(HERE, 'build-schema.mjs'), '--out', tmp('neg'), '--skips', file], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL staging-db schema build: local-stack gate: /m);
});

test('build-schema fails when the creator of the VTID ledger is skipped (smoke object missing)', NEEDS, async () => {
  const skips = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase/tests/local-stack/replay-skip.json'), 'utf8'));
  skips.skips.push({ file: '20251217000000_vtid_ledger_and_allocator.sql', reason: 'fixture', error: 'fixture' });
  const file = path.join(tmp('skips2'), 'replay-skip.json');
  fs.writeFileSync(file, JSON.stringify(skips));
  await assert.rejects(build({ skipsFile: file }), /vtid_ledger|failed and is not listed/);
});

test('build-schema fails when a production call-out is not neutralized by the seed (live check)', NEEDS, async () => {
  const seed = tmp('seed');
  fs.copyFileSync(path.join(ROOT, 'infra/staging-db/seed/010_staging_test_user.sql'), path.join(seed, '010_staging_test_user.sql'));
  await assert.rejects(build({ seedDir: seed }), /still names production: function public\.notify_welcome_discount/);
});
