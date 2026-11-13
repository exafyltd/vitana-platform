// VTID-05623: when the welcome trigger's allowlist lookup fails (notification_test_actors missing),
// the trigger's exception handler must raise a WARNING and the user_tenants insert must still succeed.
// The skip stays silent by design (no block on the user's insert). Only the warning is loud.
// Needs PGlite: node supabase/tests/vtid_05623_welcome_warning.test.mjs (run from the repo root).
// Synthetic UUIDs only.
import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';

const fixture = 'supabase/tests/vtid_05623_welcome_skip_fixture.sql';
const migration = 'supabase/migrations/20261113120000_vtid_05623_welcome_trigger_service_account_skip.sql';
const TENANT = '11111111-1111-4111-8111-111111111200';
const MEMBER = '11111111-1111-4111-8111-111111111201';

const db = new PGlite();
await db.exec(readFileSync(fixture, 'utf8'));
await db.exec(readFileSync(migration, 'utf8'));
// Make the allowlist table missing, so the function's lookup raises an error.
await db.exec('DROP TABLE public.notification_test_actors;');

const warnings = [];
const onNotice = (n) => { if (n.severity === 'WARNING') warnings.push(n.message); };

let insertError = null;
try {
  await db.exec(`INSERT INTO public.tenants (id, name) VALUES ('${TENANT}', 'synthetic tenant');`, { onNotice });
  await db.exec(`INSERT INTO public.app_users (user_id, email, display_name, vitana_id)
                 VALUES ('${MEMBER}', 'synthetic-warn@example.test', 'Warn Member', 'V-WARN');`, { onNotice });
  await db.exec(`INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
                 VALUES ('${TENANT}', '${MEMBER}', true);`, { onNotice });
} catch (e) {
  insertError = e;
}

const rows = (await db.query(`SELECT COUNT(*)::int AS n FROM public.user_tenants WHERE user_id = '${MEMBER}';`)).rows;
const membershipRows = rows[0].n;
const failedWarnings = warnings.filter((m) => m.includes(`FAILED for user ${MEMBER}`));

const checks = [
  ['user_tenants insert succeeds when allowlist table is missing', insertError === null && membershipRows === 1],
  ['trigger raises a WARNING naming the failed user', failedWarnings.length === 1],
  ['WARNING carries the SQL error (notification_test_actors does not exist)',
    failedWarnings.some((m) => m.includes('notification_test_actors'))],
];

console.log(`1..${checks.length}`);
let bad = false;
checks.forEach(([desc, pass], i) => {
  console.log(`${pass ? 'ok' : 'not ok'} ${i + 1} - ${desc}`);
  if (!pass) bad = true;
});
if (bad) {
  console.log(`# insertError: ${insertError ? insertError.message : 'none'}`);
  console.log(`# warnings: ${JSON.stringify(warnings)}`);
}
process.exit(bad ? 1 : 0);
