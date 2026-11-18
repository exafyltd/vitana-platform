// VTID-05498 read-only checks + rollback proof in PGlite: pre-check -> migration -> post-check -> rollback -> pre-check -> re-apply -> post-check.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const R = join(here, '../../../..'); const V = join(R, 'docs/validation/VTID-05498');
const db = new PGlite();
await db.exec(readFileSync(join(here, 'base_schema.sql'), 'utf8'));
const run = async (label, f) => { const r = await db.exec(readFileSync(f, 'utf8')); const last = [...r].reverse().find((x) => x.rows?.length); console.log(label, JSON.stringify(last?.rows?.[0] ?? 'ok')); return last?.rows?.[0]; };
const mig = join(R, 'supabase/migrations/20261102080000_mt_packs_knowledge_docs_tenant_id.sql');
const pre = await run('pre-check (before)    ', join(V, 'pre-check.sql')); if (pre.column_exists !== false || pre.tenants_key_present !== true || pre.knowledge_docs_exists !== true) process.exit(1);
await run('migration             ', mig);
const post = await run('post-check (applied)  ', join(V, 'post-check.sql')); if (!Object.values(post).every((v) => v === true)) process.exit(1);
await run('rollback              ', join(V, 'rollback.sql'));
const gone = await run('pre-check (rolled)   ', join(V, 'pre-check.sql')); if (gone.column_exists !== false) process.exit(1);
await run('migration (re-apply)  ', mig);
const again = await run('post-check (re-apply) ', join(V, 'post-check.sql')); if (!Object.values(again).every((v) => v === true)) process.exit(1);
console.log('ALL OK');
