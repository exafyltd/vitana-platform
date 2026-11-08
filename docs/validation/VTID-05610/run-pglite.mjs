// VTID-05610: in-process PGlite twin of scripts/ci/test-vtid-05150-provision-tenant.sh (database 1 only, up to the SQL assertions).
// Usage: node run-pglite.mjs [--with-141000] [--test <file>] [--mutate-unknown-key]
// Order as the runner: fixture -> Lane A M1 (real 20261014000100) -> fixture_after_a -> 05150 M1 x2 -> 05150 M2 x2 -> [141000 x2] -> test.
// --mutate-unknown-key additionally wraps provision_tenant so a provisioned tenant also gets feature_flags.rogue = true.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const a = process.argv.slice(2);
const withErp = a.includes('--with-141000'), mutate = a.includes('--mutate-unknown-key');
const test = a.includes('--test') ? a[a.indexOf('--test') + 1] : join(ROOT, 'supabase/tests/vtid_05150_provision_tenant.test.sql');
const T = join(ROOT, 'supabase/tests'), M = join(ROOT, 'supabase/migrations');
const aM1 = join(M, readdirSync(M).filter(f => f.startsWith('20261014000100_'))[0]);
const files = [join(T, 'vtid_05150_fixture.sql'), aM1, join(T, 'vtid_05150_fixture_after_a.sql'),
  ...[ '20261014000400_vtid_05150_tenant_brand_pack.sql', '20261014000500_vtid_05150_provision_tenant.sql' ].flatMap(f => [join(M, f), join(M, f)]),
  ...(withErp ? [join(M, '20261102141000_vtid_05506_mt_provision_erp_request.sql')].flatMap(f => [f, f]) : [])];
const db = new PGlite({ extensions: { pgcrypto } });
const strip = s => s.split('\n').filter(l => !/^\\/.test(l)).join('\n');
for (const f of files) { try { await db.exec(strip(readFileSync(f, 'utf8'))); console.log('# loaded', f.replace(ROOT + '/', '')); } catch (e) { console.log('# FAILED loading', f, e.message); process.exit(2); } }
if (mutate) {
  // Mutation: a trigger gives every tenant_settings row of a provisioned tenant an unknown feature_flags key (signature-agnostic).
  await db.exec(`CREATE FUNCTION public.vtid_05610_mutation() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
    IF NEW.provisioned_at IS NOT NULL THEN NEW.feature_flags := coalesce(NEW.feature_flags,'{}'::jsonb) || '{"rogue":true}'::jsonb; END IF; RETURN NEW; END $f$;
  CREATE TRIGGER vtid_05610_mutation BEFORE INSERT OR UPDATE ON public.tenant_settings FOR EACH ROW EXECUTE FUNCTION public.vtid_05610_mutation();`);
  console.log('# mutation installed: provisioned tenants get feature_flags.rogue');
}
try { await db.exec(strip(readFileSync(test, 'utf8'))); console.log('RESULT: all assertions passed'); }
catch (e) { console.log('RESULT: FAILED:', e.message); process.exit(1); }
