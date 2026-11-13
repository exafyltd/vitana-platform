/**
 * VTID-05023 F3: the autopilot event loop migration failed because
 * idx_autopilot_processed_events_recent used NOW() in its WHERE predicate.
 * The fix is a new migration that drops that index. These checks read the
 * migration files; the PGlite pass (docs/validation/VTID-05023/pgtap) covers
 * the apply behaviour.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS = path.resolve(__dirname, '../../../supabase/migrations');
const ORIGINAL = '20260116000000_vtid_01179_autopilot_event_loop.sql';
const FIX = '20260116000001_vtid_05023_autopilot_recent_index_immutable.sql';
const BROKEN_INDEX = 'idx_autopilot_processed_events_recent';

// Functions that are not IMMUTABLE and therefore cannot appear in an index predicate.
const NON_IMMUTABLE = /\b(now|current_timestamp|current_date|current_time|localtimestamp|localtime|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|random)\s*\(?/i;

function read(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
}

function indexStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s));
}

describe('VTID-05023 F3: autopilot recent index predicate', () => {
  it('the original migration still holds the non-immutable predicate that causes the failure', () => {
    const original = read(ORIGINAL);
    const broken = new RegExp(`CREATE INDEX IF NOT EXISTS ${BROKEN_INDEX}[\\s\\S]*?WHERE processed_at > NOW\\(\\)`, 'i');
    expect(original).toMatch(broken);
  });

  it('the fix migration drops the broken index with a guard', () => {
    const fix = read(FIX);
    expect(fix).toMatch(new RegExp(`DROP INDEX IF EXISTS public\\.${BROKEN_INDEX}\\s*;`));
  });

  it('the fix migration creates no index whose predicate calls a non-immutable function', () => {
    const creates = indexStatements(read(FIX));
    for (const stmt of creates) {
      const where = stmt.split(/\bWHERE\b/i)[1] ?? '';
      expect({ stmt, call: NON_IMMUTABLE.test(where) }).toEqual({ stmt, call: false });
    }
  });

  it('the fix migration contains only the drop statement', () => {
    const fix = read(FIX).replace(/--[^\n]*/g, '');
    const statements = fix.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toEqual([`DROP INDEX IF EXISTS public.${BROKEN_INDEX}`]);
  });
});
