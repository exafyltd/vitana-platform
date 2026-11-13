#!/usr/bin/env node
// VTID-05782 (plan autonomous-to-staging-r2, lane staging-db-provision; design.md §5): the schema bundle of the
// isolated staging database, built in CI with no AWS call and no production data.
//
//   node scripts/ci/staging-db/build-schema.mjs --out <dir> [--skips <replay-skip.json>] [--migrations <dir>]
//
// 1. Replays supabase/migrations/*.sql in timestamp order on PGlite with the existing local stack
//    (scripts/mt/stack/stack.mjs: stub auth, replay-skip.json, the required-table gate of required-tables.txt /
//    not-replayable.txt), then the synthetic fixtures (supabase/tests/fixtures/*.sql) and the staging seed
//    (infra/staging-db/seed/*.sql).
// 2. Fails closed (exit 1) when the stack gate fails (a migration fails that is not a listed skip, a required table is
//    missing), when an object the gateway smoke reads is missing (SMOKE_OBJECTS), when a function body, column default
//    or view of the replayed database names production, or when a production identifier in the bundle text is not in
//    infra/staging-db/bundle-prod-ref-allow.json (or an entry there is stale).
//    `--verify <dir>` re-checks a built bundle (sha256s and the allow list) before staging-db-load.sh loads it.
// 3. Writes <dir>/bundle.sql (every SQL file that was applied, in order, each behind a `-- @@file` marker) and
//    <dir>/manifest.json (schema hash of infra/staging-db/schema-hash.sql, bundle sha256, file list, counts, and the
//    reviewed production references found by scripts/ci/staging-prod-ref-guard.mjs in the bundle text).
// scripts/aws/staging-db-load.sh applies the bundle through the RDS Data API and compares the cluster's schema hash
// with manifest.schema_hash. PGlite is imported lazily, so the pure helpers below run in the no-install unit job.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanText } from '../staging-prod-ref-guard.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SEED_DIR = path.join(REPO_ROOT, 'infra', 'staging-db', 'seed');
export const HASH_SQL = path.join(REPO_ROOT, 'infra', 'staging-db', 'schema-hash.sql');
export const ALLOW_FILE = path.join(REPO_ROOT, 'infra', 'staging-db', 'bundle-prod-ref-allow.json');
export const MARKER = '-- @@file ';
export const BUNDLE_SCHEMA = 'vitana.staging-db-bundle/v1';

/**
 * Objects the gateway smoke (scripts/ci/staging-verify/smoke/gateway.json) reads: the VTID ledger health and the OASIS
 * tasks list read public.vtid_ledger, VTID writes go to public.oasis_events, allocation is public.allocate_global_vtid.
 * (design.md §5.2 names `next_vtid`; no migration defines it — only a comment in 20251218000000 does — so the
 * allocator the gateway calls is listed instead.)
 */
export const SMOKE_OBJECTS = Object.freeze([
  { kind: 'table', schema: 'public', name: 'vtid_ledger' },
  { kind: 'table', schema: 'public', name: 'oasis_events' },
  { kind: 'function', schema: 'public', name: 'allocate_global_vtid' },
]);

export class BuildError extends Error {
  constructor(message) { super(message); this.name = 'BuildError'; }
}

const firstLine = (e) => String((e && e.message) || e).split('\n')[0];

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Missing smoke objects of a database exposing `query(sql, params) -> { rows }`. */
export async function missingSmokeObjects(db, objects = SMOKE_OBJECTS) {
  const missing = [];
  for (const o of objects) {
    const sql = o.kind === 'table'
      ? `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')`
      : `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2`;
    const r = await db.query(sql, [o.schema, o.name]);
    if (!r.rows.length) missing.push(`${o.kind} ${o.schema}.${o.name}`);
  }
  return missing;
}

/** One bundle text from [{ name, sql }]; refuses an input that already holds a marker line. */
export function bundleText(parts) {
  const out = [];
  parts.forEach((p, i) => {
    if (p.sql.split('\n').some((l) => l.startsWith(MARKER))) throw new BuildError(`${p.name} contains a "${MARKER.trim()}" line`);
    if (/\s/.test(p.name)) throw new BuildError(`bundle part name has whitespace: ${p.name}`);
    out.push(`${MARKER}${String(i).padStart(4, '0')} ${p.name} sha256=${sha256(p.sql)}\n${p.sql.endsWith('\n') ? p.sql : `${p.sql}\n`}`);
  });
  return out.join('');
}

/** Inverse of bundleText (used by tests; staging-db-load.sh splits the same markers with awk). Verifies each sha256. */
export function parseBundle(text) {
  const parts = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith(MARKER)) {
      const m = line.slice(MARKER.length).match(/^(\d{4}) (\S+) sha256=([0-9a-f]{64})$/);
      if (!m) throw new BuildError(`bad marker: ${line}`);
      cur = { n: Number(m[1]), name: m[2], sha256: m[3], lines: [] };
      parts.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  return parts.map((p, i) => {
    let sql = p.lines.join('\n');
    if (i === parts.length - 1 && sql.endsWith('\n')) sql = sql.slice(0, -1);
    sql += '\n';
    const raw = [sql, sql.slice(0, -1)].find((s) => sha256(s) === p.sha256);
    if (raw === undefined) throw new BuildError(`sha256 mismatch for part ${p.n} ${p.name}`);
    return { n: p.n, name: p.name, sha256: p.sha256, sql: raw };
  });
}

/**
 * Production references per bundle part, checked against the reviewed allow list: → { findings, unallowed, stale }.
 * A finding is allowed only by an entry with the same part, id and match and the exact count; an entry that matches
 * nothing is stale. Both make the bundle unusable for the load.
 */
export function checkBundleRefs(parts, allow) {
  const counts = new Map();
  const findings = [];
  for (const p of parts) {
    for (const f of scanText(p.sql, p.name)) {
      findings.push({ part: p.name, id: f.id, match: f.match, line: f.line });
      const k = `${p.name}\u0000${f.id}\u0000${f.match}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const entries = new Map((allow.entries || []).map((e) => [`${e.part}\u0000${e.id}\u0000${e.match}`, e]));
  const unallowed = [];
  for (const [k, n] of counts) {
    const e = entries.get(k);
    const [part, id, match] = k.split('\u0000');
    if (!e) unallowed.push(`${part}: ${id} "${match}" x${n} is not in bundle-prod-ref-allow.json`);
    else if (e.count !== n) unallowed.push(`${part}: ${id} "${match}" occurs ${n} time(s), bundle-prod-ref-allow.json says ${e.count}`);
  }
  const stale = [...entries.keys()].filter((k) => !counts.has(k)).map((k) => `stale bundle-prod-ref-allow.json entry: ${k.split('\u0000').join(' / ')}`);
  return { findings, unallowed, stale };
}

/** Function bodies, column defaults and view definitions of the replayed database that name production. */
export async function liveProductionRefs(db) {
  const r = await db.query(`
    SELECT 'function ' || n.nspname || '.' || p.proname AS what, p.prosrc AS body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'default ' || c.oid::regclass::text || '.' || a.attname, pg_get_expr(ad.adbin, ad.adrelid)
      FROM pg_attrdef ad JOIN pg_class c ON c.oid = ad.adrelid JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
    UNION ALL
    SELECT 'view ' || schemaname || '.' || viewname, definition FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`);
  const out = [];
  for (const row of r.rows) for (const f of scanText(String(row.body || ''), 'live.sql')) out.push(`${row.what}: ${f.label} (${f.match})`);
  return out;
}

export async function schemaHash(db) {
  const sql = fs.readFileSync(HASH_SQL, 'utf8');
  let r;
  try { r = await db.query(sql); } catch (e) { throw new BuildError(`schema hash query failed: ${firstLine(e)}`); }
  const row = r.rows[0];
  if (!row || !/^[0-9a-f]{64}$/.test(row.schema_hash)) throw new BuildError('schema hash query returned no hash');
  return { hash: row.schema_hash, objects: Number(row.objects) };
}

/** The whole build. Returns the manifest; throws BuildError / StackGateError (message names the file or object). */
export async function build({ outDir, skipsFile, migrationsDir, seedDir = SEED_DIR, allowFile = ALLOW_FILE, stackModule } = {}) {
  const stack = stackModule || await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/mt/stack/stack.mjs')).href);
  const migDir = migrationsDir || stack.PATHS.migrations;
  const skips = stack.loadSkips(skipsFile || stack.PATHS.skips);
  let created;
  try {
    created = await stack.createStack({ migrationsDir: migDir, skips, fixtures: true, shim: false });
  } catch (e) {
    if (e instanceof stack.StackGateError) throw new BuildError(`local-stack gate: ${e.message}`);
    throw e;
  }
  const { db, report } = created;
  try {
    const seeds = fs.existsSync(seedDir) ? fs.readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort() : [];
    for (const f of seeds) {
      try { await db.exec(fs.readFileSync(path.join(seedDir, f), 'utf8')); } catch (e) {
        try { await db.exec('ROLLBACK'); } catch { /* none open */ }
        throw new BuildError(`seed ${f} failed: ${firstLine(e)}`);
      }
    }
    const live = await liveProductionRefs(db);
    if (live.length) throw new BuildError(`the replayed staging schema still names production: ${live.join('; ')}`);
    const missing = await missingSmokeObjects(db);
    if (missing.length) throw new BuildError(`objects the gateway smoke reads are missing after the replay: ${missing.join(', ')}`);
    const { hash, objects } = await schemaHash(db);
    const parts = [
      { name: 'scripts/mt/stack/stub-auth.sql', sql: fs.readFileSync(stack.PATHS.stubAuth, 'utf8') },
      ...report.replay.applied.map((f) => ({ name: `supabase/migrations/${f}`, sql: fs.readFileSync(path.join(migDir, f), 'utf8') })),
      ...report.fixtures.map((f) => ({ name: `supabase/tests/fixtures/${f}`, sql: fs.readFileSync(path.join(stack.PATHS.fixtures, f), 'utf8') })),
      ...seeds.map((f) => ({ name: `infra/staging-db/seed/${f}`, sql: fs.readFileSync(path.join(seedDir, f), 'utf8') })),
    ];
    const text = bundleText(parts);
    const refs = checkBundleRefs(parts, JSON.parse(fs.readFileSync(allowFile, 'utf8')));
    if (refs.unallowed.length || refs.stale.length) throw new BuildError(`production references in the bundle: ${[...refs.unallowed, ...refs.stale].join('; ')}`);
    const manifest = {
      schema: BUNDLE_SCHEMA,
      schema_hash: hash,
      objects,
      bundle_sha256: sha256(text),
      bundle_bytes: Buffer.byteLength(text, 'utf8'),
      counts: {
        parts: parts.length,
        migrations_applied: report.replay.applied.length,
        migrations_skipped: report.replay.skipped.length,
        fixtures: report.fixtures.length,
        seed: seeds.length,
        required_tables_present: report.tables.present.length,
        required_tables_not_replayable: report.tables.skipped.length,
      },
      smoke_objects: SMOKE_OBJECTS.map((o) => `${o.kind} ${o.schema}.${o.name}`),
      production_references: refs.findings,
      files: parts.map((p, i) => ({ n: i, name: p.name, sha256: sha256(p.sql) })),
    };
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'bundle.sql'), text);
      fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return manifest;
  } finally {
    await db.close();
  }
}

/**
 * Check a built bundle directory before it is loaded (staging-db-load.sh): manifest schema, bundle sha256, every part's
 * sha256, and the production references against the allow list in this checkout. → manifest; throws BuildError.
 */
export function verifyBundle(dir, { allowFile = ALLOW_FILE } = {}) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { throw new BuildError(`${f} missing in ${dir}`); } };
  const text = read('bundle.sql');
  let manifest;
  try { manifest = JSON.parse(read('manifest.json')); } catch (e) { if (e instanceof BuildError) throw e; throw new BuildError('manifest.json is not JSON'); }
  if (manifest.schema !== BUNDLE_SCHEMA) throw new BuildError(`manifest schema is ${manifest.schema}, expected ${BUNDLE_SCHEMA}`);
  if (!/^[0-9a-f]{64}$/.test(manifest.schema_hash || '')) throw new BuildError('manifest has no schema_hash');
  if (sha256(text) !== manifest.bundle_sha256) throw new BuildError('bundle.sql sha256 does not match manifest.bundle_sha256');
  const parts = parseBundle(text);
  if (parts.length !== (manifest.files || []).length || parts.some((p, i) => p.name !== manifest.files[i].name || p.sha256 !== manifest.files[i].sha256)) {
    throw new BuildError('bundle parts do not match manifest.files');
  }
  // Stale entries are the build's concern (the allow list follows the migrations of this checkout); here only a
  // finding without an entry counts, so an older bundle with fewer references still verifies.
  const refs = checkBundleRefs(parts, JSON.parse(fs.readFileSync(allowFile, 'utf8')));
  if (refs.unallowed.length) throw new BuildError(`production references in the bundle: ${refs.unallowed.join('; ')}`);
  return manifest;
}

export function parseArgs(argv) {
  if (argv[0] === '--verify') {
    if (argv.length !== 2) throw new BuildError('usage: build-schema.mjs --verify <bundle dir>');
    return { verify: argv[1] };
  }
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (['--out', '--skips', '--migrations', '--seed'].includes(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) a[k.slice(2)] = argv[++i];
    else throw new BuildError(`usage: build-schema.mjs --out <dir> [--skips <file>] [--migrations <dir>] [--seed <dir>] (bad argument ${k})`);
  }
  if (!a.out) throw new BuildError('usage: build-schema.mjs --out <dir> [--skips <file>] [--migrations <dir>] [--seed <dir>]');
  return a;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2));
    if (a.verify) {
      const v = verifyBundle(a.verify);
      console.log(`PASS staging-db bundle verify: ${v.files.length} part(s), schema hash ${v.schema_hash}, ${v.production_references.length} reviewed production reference(s)`);
      process.exit(0);
    }
    const m = await build({ outDir: a.out, skipsFile: a.skips, migrationsDir: a.migrations, seedDir: a.seed || SEED_DIR });
    console.log(`staging-db bundle: ${m.counts.parts} part(s), ${m.counts.migrations_applied} migration(s) applied, ${m.counts.migrations_skipped} skipped (replay-skip.json)`);
    console.log(`schema hash ${m.schema_hash} over ${m.objects} object(s); bundle ${m.bundle_bytes} bytes sha256 ${m.bundle_sha256}`);
    console.log(`production references in the bundle: ${m.production_references.length}, all in bundle-prod-ref-allow.json; none in a live function, default or view`);
    console.log('PASS staging-db schema build');
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    console.log(`FAIL staging-db schema build: ${e.message}`);
    process.exitCode = 1;
  }
}
