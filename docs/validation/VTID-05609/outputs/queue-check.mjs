#!/usr/bin/env node
// VTID-05609 queue consistency check. Read-only: parses docs/multitenancy/MIGRATION-QUEUE.md and supabase/migrations/.
// Usage: node queue-check.mjs [--repo <checkout>]   exit 0 = all checks pass, 1 = at least one fails.
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : process.cwd();
const md = fs.readFileSync(path.join(repo, 'docs/multitenancy/MIGRATION-QUEUE.md'), 'utf8');
const migDir = path.join(repo, 'supabase/migrations');
const files = new Set(fs.readdirSync(migDir));

const rows = [];
for (const line of md.split('\n')) {
  const m = /^\| (\d+[a-z]?) \| (.+?) \|/.exec(line);
  if (m) rows.push({ id: m[1], cell: m[2], line });
}
const num = (id) => parseInt(id, 10) + (/[a-z]$/.test(id) ? 0.5 : 0);

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// 1. unique row numbers
const ids = rows.map((r) => r.id);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
check('row numbers are unique', dup.length === 0, dup.join(','));

// 2. row numbers increase monotonically down the table
const bad = [];
for (let i = 1; i < rows.length; i++) if (num(rows[i].id) <= num(rows[i - 1].id)) bad.push(`${rows[i - 1].id}->${rows[i].id}`);
check('row numbers increase monotonically down the table', bad.length === 0, bad.join(','));

// 3. every migration file named in a row exists (vitana-v1 rows are skipped)
const missing = [];
for (const r of rows) {
  if (/repo \*\*vitana-v1\*\*/.test(r.line)) continue;
  const f = /`(\d{14}_[a-z0-9_]+\.sql)`/.exec(r.cell);
  if (f && !files.has(f[1])) missing.push(`${r.id}:${f[1]}`);
}
check('every migration file named in a row exists under supabase/migrations/', missing.length === 0, missing.join(','));

// 4. every merged mt-network-r2 / 05569 migration on main has a row
const listed = new Set(rows.map((r) => (/`(\d{14}_[a-z0-9_]+\.sql)`/.exec(r.cell) || [])[1]).filter(Boolean));
const owed = [...files].filter((f) => /^\d{14}_vtid_(05582|05573|05575|05569)_/.test(f));
const unlisted = owed.filter((f) => !listed.has(f));
check('every VTID-05582/05573/05575/05569 migration on main has a queue row', unlisted.length === 0, unlisted.join(','));

// 5. VTID rows are in the planned order: 05582 < 05573 < 05575 < 05569 (apply order)
const pos = (v) => rows.findIndex((r) => r.cell.includes(`_vtid_${v}_`));
const order = ['05582', '05573', '05575', '05569'].map(pos);
check('queue order is 05582, 05573, 05575, 05569', order.every((p) => p >= 0) && order.every((p, i) => i === 0 || p > order[i - 1]), order.join(','));

// 6. 05569 rows are 57-58 and the old numbers are gone from text
const r69 = rows.filter((r) => r.cell.includes('_vtid_05569_')).map((r) => r.id).join(',');
check('VTID-05569 rows are 57,58', r69 === '57,58', r69);
const stale = [];
for (const re of [/Rows 51-52 \(VTID-05569/, /Rows 48-50 are reserved/, /row 52, a no-op: row 51/, /\(row 51\)/, /rollback of row 51/, /VTID-05582, rows for `20261102051000`/]) {
  if (re.test(md)) stale.push(String(re));
}
check('no stale reference to the old rows 51-52 / 48-50', stale.length === 0, stale.join(' | '));

// 7. dependencies: no 05575 row depends on 05576 (row 45) (review finding R2-F1)
const dep = (id) => {
  const r = rows.find((x) => x.id === id);
  return r ? r.line.split(' | ')[3] || '' : '';
};
const dep54 = dep('54');
check('row 54 (053000) is expand only and declares no dependency on row 45', rows.some((r) => r.id === '54') && !/#45\b/.test(dep54) && /expand/.test(dep54), dep54);
check('rows 55-56 depend on #48 and not on #45', ['55', '56'].every((id) => /#48\b/.test(dep(id)) && !/#45\b/.test(dep(id))), `${dep('55')} || ${dep('56')}`);

// 8. 05573 apply preconditions are carried by row 50
const r50 = rows.find((r) => r.id === '50');
check('row 50 carries the 05573 apply preconditions', !!r50 && /retire/i.test(r50.line) && /live-before\.sql/.test(r50.line) && /clean/.test(r50.line), '');

let fail = 0;
for (const r of results) {
  if (!r.ok) fail++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : '  [' + r.detail + ']'}`);
}
console.log(`\n${results.length - fail} pass, ${fail} fail (${rows.length} rows parsed)`);
process.exit(fail ? 1 : 0);
