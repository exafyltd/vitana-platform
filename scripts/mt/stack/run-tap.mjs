#!/usr/bin/env node
// VTID-05520: run pgTAP-style .sql files on the PGlite local stack through the shim (real pgTAP is not used).
//   node scripts/mt/stack/run-tap.mjs supabase/tests/local-stack/smoke.tap.sql [more.tap.sql ...]
// One in-process database per file. Prints TAP, then "PASS local-stack <file>" or "FAIL local-stack <file>".
// Exit 0 only when every file passed. A stack gate failure (unlisted migration failure or required table) exits 2.
import { basename, resolve } from 'node:path';
import { createStack, runTapFile, StackGateError } from './stack.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: run-tap.mjs <file.tap.sql> [...]');
  process.exit(64);
}
let bad = false;
for (const f of files) {
  let stack;
  try {
    stack = await createStack();
  } catch (e) {
    if (!(e instanceof StackGateError)) throw e;
    console.log(`FAIL local-stack ${basename(f)}: the stack did not build: ${e.message}`);
    process.exit(2);
  }
  const { db, report } = stack;
  console.log(`# stack: required ${report.required.length}, present ${report.tables.present.length}, skipped (unverified) ${report.tables.skipped.length}`);
  const r = await runTapFile(db, resolve(f));
  for (const l of r.lines) console.log(l);
  console.log(`${r.ok ? 'PASS' : 'FAIL'} local-stack ${basename(f)} (${r.run} run, ${r.failed} failed${r.planned === null ? ', no plan' : `, planned ${r.planned}`})`);
  if (!r.ok) bad = true;
  await db.close();
}
process.exit(bad ? 1 : 0);
