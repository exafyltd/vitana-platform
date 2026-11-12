// VTID-05445 (G4): the shared health-table list. Read it from here, never copy the names.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEALTH_TABLES_FILE = join(dirname(fileURLToPath(import.meta.url)), 'health-tables.json');
export const HEALTH_TABLES = Object.freeze(JSON.parse(readFileSync(HEALTH_TABLES_FILE, 'utf8')).tables);
const SET = new Set(HEALTH_TABLES);
export const isHealthTable = (name) => SET.has(name);
