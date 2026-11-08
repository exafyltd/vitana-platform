#!/usr/bin/env node
// VTID-05445 (G1, G5): generate the checked-in inventories from the local PGlite schema and the source trees.
//   node scripts/mt/inventory/generate.mjs           # rebuild the stack, write scripts/mt/inventory/data/*.json
//   node scripts/mt/inventory/generate.mjs --check   # exit 1 and name the files that differ from the committed ones
// Output is deterministic: keys sorted, rows sorted, no timestamp, two-space indent, trailing newline. Follows the
// conventions of scripts/ci/aurora-migration-inventory.cjs (dependency-free, read-only, JSON for tooling), but reads the
// DB schema, which that source scanner does not. Tables of supabase/tests/local-stack/not-replayable.txt are `unverified`.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStack, loadNotReplayable, REPO_ROOT } from '../stack/stack.mjs';
import { readCatalog, scanRoutes, scanEdgeFunctions, scanMigrationText } from './extract.mjs';
import { isHealthTable } from './health-tables.mjs';
import { DATA_DIR, INVENTORY_FILES, writeInventories, checkInventories } from './render.mjs';

export { DATA_DIR, INVENTORY_FILES, serialize, renderInventories, writeInventories, checkInventories } from './render.mjs';

const SCHEMA_VERSION = 1;
const GENERATOR = 'scripts/mt/inventory/generate.mjs';

const head = (name, source, caveat) => ({ inventory: name, schema_version: SCHEMA_VERSION, generated_by: GENERATOR, source, ...(caveat ? { caveat } : {}) });
const count = (rows, f) => rows.filter(f).length;

/** Build all six inventories. `db` is a PGlite database with the migrations replayed. */
export async function buildInventories({ db, gatewayDir, functionsDir, migrationsDir, notReplayable = [], repoRoot }) {
  const cat = await readCatalog(db);
  const listed = new Map(notReplayable.map((e) => [e.table, e]));

  const tableRows = cat.tables
    .filter((t) => !listed.has(t.name))
    .map((t) => ({ ...t, health: isHealthTable(t.name), status: 'verified' }));
  for (const e of notReplayable) {
    tableRows.push({ name: e.table, health: isHealthTable(e.table), status: 'unverified', reason: e.reason, lanes: e.lanes });
  }
  tableRows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const verified = tableRows.filter((t) => t.status === 'verified');
  const tables = {
    ...head('tables', 'PGlite catalog of the replayed supabase/migrations (schema public) + supabase/tests/local-stack/not-replayable.txt',
      'Skipped migrations (replay-skip.json) are not in the schema: counts are a lower bound. Listed tables are unverified, never passing.'),
    summary: {
      total: tableRows.length,
      verified: verified.length,
      unverified: tableRows.length - verified.length,
      with_tenant_id: count(verified, (t) => t.has_tenant_id),
      nullable_tenant_id: count(verified, (t) => t.tenant_id_nullable === true),
      rls_enabled: count(verified, (t) => t.rls_enabled),
      policies: verified.reduce((n, t) => n + t.policies.length, 0),
    },
    rows: tableRows,
  };

  const fnRows = cat.functions;
  const functions = {
    ...head('functions', 'PGlite catalog (schema public, extension members excluded)'),
    summary: {
      total: fnRows.length,
      security_definer: count(fnRows, (f) => f.security_definer),
      security_definer_executable: count(fnRows, (f) => f.security_definer && f.executable_by.length > 0),
      security_definer_without_caller_check: count(fnRows, (f) => f.security_definer && f.executable_by.length > 0 && !f.caller_check),
    },
    rows: fnRows,
  };

  const routeRows = scanRoutes(gatewayDir, repoRoot);
  const routes = {
    ...head('routes', 'router.<method>(path) / app.<method>(path) call sites under the gateway source tree (test files skipped)',
      'Paths are as written; the mount prefix is not resolved, and a registration spread over several lines lists no middleware.'),
    summary: {
      total: routeRows.length,
      without_auth_middleware: count(routeRows, (r) => !r.auth_middleware),
      files: new Set(routeRows.map((r) => r.file)).size,
    },
    rows: routeRows,
  };

  const edgeRows = scanEdgeFunctions(functionsDir, repoRoot);
  const edge_functions = {
    ...head('edge_functions', 'supabase/functions/<name>/index.* and the [functions.<name>] verify_jwt of config.toml when present'),
    summary: {
      total: edgeRows.length,
      reads_authorization_header: count(edgeRows, (e) => e.reads_authorization_header),
      uses_service_role: count(edgeRows, (e) => e.uses_service_role),
      verify_jwt_false: count(edgeRows, (e) => e.verify_jwt === false),
      verify_jwt_unknown: count(edgeRows, (e) => e.verify_jwt === null),
    },
    rows: edgeRows,
  };

  const text = scanMigrationText(migrationsDir);
  const inSchema = new Set(verified.map((t) => t.name));
  const names = new Set([...cat.publication, ...text.realtime]);
  const rtRows = [...names].sort().map((table) => {
    const via = [];
    if (text.realtime.includes(table)) via.push('migrations');
    if (cat.publication.includes(table)) via.push('publication');
    const inS = inSchema.has(table);
    const row = { table, via, in_schema: inS, status: inS ? 'verified' : 'unverified' };
    if (!inS) row.reason = listed.has(table) ? listed.get(table).reason : 'the table is not in the replayed schema (a migration that creates it is a skip)';
    return row;
  });
  const realtime_tables = {
    ...head('realtime_tables', 'pg_publication_tables (supabase_realtime) of the replayed schema + ALTER PUBLICATION in migration text',
      'A realtime table that is not in the replayed schema is unverified.'),
    summary: { total: rtRows.length, verified: count(rtRows, (r) => r.status === 'verified'), unverified: count(rtRows, (r) => r.status === 'unverified') },
    rows: rtRows,
  };

  const buckets = {
    ...head('buckets', 'INSERT INTO storage.buckets and CREATE/DROP POLICY ON storage.objects in migration text',
      'The storage schema does not replay on PGlite: buckets and storage policies come from migration text only (source: migrations).'),
    summary: { buckets: text.buckets.length, storage_policies: text.storage_policies.length },
    rows: text.buckets,
    storage_policies: text.storage_policies,
  };

  return { tables, functions, routes, edge_functions, realtime_tables, buckets };
}

/** The inventories of this repository, from an already replayed stack database. */
export async function buildRepoInventories(db) {
  return buildInventories({
    db,
    gatewayDir: join(REPO_ROOT, 'services', 'gateway', 'src'),
    functionsDir: join(REPO_ROOT, 'supabase', 'functions'),
    migrationsDir: join(REPO_ROOT, 'supabase', 'migrations'),
    notReplayable: loadNotReplayable(),
    repoRoot: REPO_ROOT,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const { db } = await createStack({ fixtures: false, shim: false });
  try {
    const inv = await buildRepoInventories(db);
    if (check) {
      const drift = checkInventories(DATA_DIR, inv);
      if (drift.length) {
        console.log(`DRIFT ${drift.join(', ')}: run \`node scripts/mt/inventory/generate.mjs\` and commit scripts/mt/inventory/data/`);
        process.exitCode = 1;
      } else console.log('PASS inventories match the repo');
    } else {
      writeInventories(DATA_DIR, inv);
      for (const [k, v] of Object.entries(inv)) console.log(`${INVENTORY_FILES[k]}: ${JSON.stringify(v.summary)}`);
    }
  } finally {
    await db.close();
  }
}
