// VTID-05445 (G1, G5): rendering, writing and drift-checking of the inventories. No PGlite import, so tests that need no
// database can use it. Output is deterministic: keys sorted, rows sorted by the builders, no timestamp, two-space indent.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
export const INVENTORY_FILES = Object.freeze({
  tables: 'tables.json',
  functions: 'functions.json',
  routes: 'routes.json',
  edge_functions: 'edge-functions.json',
  realtime_tables: 'realtime-tables.json',
  buckets: 'buckets.json',
});

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
export const serialize = (obj) => JSON.stringify(sortKeys(obj), null, 2) + '\n';

/** Map of file name -> text, in the order of INVENTORY_FILES. */
export function renderInventories(inv) {
  return new Map(Object.entries(INVENTORY_FILES).map(([key, file]) => [file, serialize(inv[key])]));
}

export function writeInventories(dir, inv) {
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of renderInventories(inv)) writeFileSync(join(dir, file), text);
}

/** Names of the files in `dir` that differ (or are missing) from what `inv` renders to. */
export function checkInventories(dir, inv) {
  const drift = [];
  for (const [file, text] of renderInventories(inv)) {
    let have = null;
    try { have = readFileSync(join(dir, file), 'utf8'); } catch { /* missing */ }
    if (have !== text) drift.push(file);
  }
  return drift;
}

