// VTID-05445: builds the inventories of the tiny fixture schema (fixtures/). Used by the generator and lint tests.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, parseNotReplayable } from '../stack/stack.mjs';
import { buildInventories } from './generate.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export async function fixtureInventories() {
  const db = await openDb();
  try {
    await db.exec(readFileSync(join(FX, 'schema.sql'), 'utf8'));
    return await buildInventories({
      db,
      gatewayDir: join(FX, 'gateway'),
      functionsDir: join(FX, 'functions'),
      migrationsDir: join(FX, 'migrations'),
      notReplayable: parseNotReplayable(readFileSync(join(FX, 'not-replayable.txt'), 'utf8')),
      repoRoot: FX,
    });
  } finally {
    await db.close();
  }
}
