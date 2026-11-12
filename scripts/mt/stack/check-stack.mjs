#!/usr/bin/env node
// VTID-05520: build the stack the way CI does and print the numbers.
//   node scripts/mt/stack/check-stack.mjs
// Skipped migrations are run too and must still fail with their recorded error (a stale skip fails the job).
// Prints one PASS or SKIP line per required table. Exit 0 = gate green, 1 = gate failed (the message names the file or table).
import { createStack, StackGateError } from './stack.mjs';

try {
  const { db, report } = await createStack({ attemptSkipped: true });
  const { replay, tables, required, fixtures } = report;
  console.log(`replay: ${replay.applied.length} applied, ${replay.skipped.length} skipped (replay-skip.json), ${replay.failed.length} failed`);
  for (const t of required) {
    const skip = tables.skipped.find((s) => s.table === t);
    console.log(skip ? `SKIP ${t} (unverified): ${skip.reason} [needed by: ${skip.lanes.join(', ')}]` : `PASS ${t}`);
  }
  console.log(`required tables: ${required.length}, present ${tables.present.length}, not replayable (unverified) ${tables.skipped.length}`);
  console.log(`fixtures: ${fixtures.join(', ')}`);
  console.log('PASS local-stack gate');
  await db.close();
} catch (e) {
  if (!(e instanceof StackGateError)) throw e;
  console.log(`FAIL local-stack gate: ${e.message}`);
  process.exit(1);
}
