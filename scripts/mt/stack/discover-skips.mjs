#!/usr/bin/env node
// VTID-05520: regenerate supabase/tests/local-stack/replay-skip.json. A developer tool, not part of CI.
//   node scripts/mt/stack/discover-skips.mjs          print the skip list it finds
//   node scripts/mt/stack/discover-skips.mjs --write  write replay-skip.json
// Replays every migration in timestamp order on an empty PGlite database; each file that fails becomes a skip (with its
// first error line), and the replay is repeated without it until no file fails, so a skip's effects on later files are
// part of the result. It changes nothing but replay-skip.json. It does not touch required-tables.txt or not-replayable.txt.
import { writeFileSync } from 'node:fs';
import { openDb, replay, listMigrations, PATHS } from './stack.mjs';

export function reasonFor(error) {
  let m;
  if (/type "?vector"? does not exist|extension "vector"/.test(error)) return 'needs pgvector, which PGlite does not bundle';
  if ((m = /extension "([^"]+)" is not available/.exec(error))) return `extension ${m[1]} is not bundled with PGlite`;
  if (/auth\.role\(\)/.test(error)) return 'calls auth.role(), which the stub auth schema does not define (Amendment 2, decision 4)';
  if ((m = /schema "([^"]+)" does not exist/.exec(error)) || (m = /relation "(storage|realtime|vault|extensions|graphql)\.[^"]*" does not exist/.exec(error))) {
    return `needs the Supabase ${m[1]} schema, which the stub does not reproduce`;
  }
  if (/relation "[^"]+" does not exist/.test(error)) return 'needs a table that no replayed migration creates (no committed creator, or an earlier skipped migration)';
  if (/column "[^"]+"( of relation "[^"]+")? does not exist|referenced in foreign key constraint does not exist/.test(error)) {
    return 'expects a column the replayed schema does not have (its table has no committed creator, or comes from a skipped migration)';
  }
  if (/^VTID-\d+/.test(error)) return 'a guard inside the migration refuses the replayed state: it asserts production data or a production function body that a fresh replay does not have';
  if (/function "?[\w.]+\(\)"? does not exist|function [\w.]+\([^)]*\) does not exist/.test(error)) return 'changes a function that no replayed migration creates (its creator is a skipped migration or was never committed)';
  if (/pg_cron|cron\./.test(error)) return 'needs pg_cron, which PGlite does not bundle';
  return 'fails on a fresh replay on PGlite (see the error line)';
}

const skips = [];
for (let pass = 1; ; pass++) {
  const db = await openDb();
  const r = await replay(db, { skips });
  await db.close();
  if (!r.failed.length) break;
  for (const f of r.failed) skips.push({ file: f.file, reason: reasonFor(f.error), error: f.error });
  skips.sort((a, b) => (a.file < b.file ? -1 : 1));
  if (pass > 50) throw new Error('replay did not settle in 50 passes');
}
const total = listMigrations().length;
console.log(`${total} migrations, ${total - skips.length} apply, ${skips.length} skipped`);
if (process.argv.includes('--write')) {
  writeFileSync(PATHS.skips, JSON.stringify({ skips }, null, 2) + '\n');
  console.log(`wrote ${PATHS.skips}`);
}
