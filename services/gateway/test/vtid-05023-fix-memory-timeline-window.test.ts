// VTID-05023 F1 (syntax): 20251231000002 replaces the unapplied 20251231000001 memory timeline file.
// The original fails to parse because `window` is a reserved word used as an unquoted column name.
// This suite pins the fix: the only SQL difference is the quoting of "window", and the identifier
// is quoted at every column use.
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

const ORIGINAL_PATH = 'supabase/migrations/20251231000001_vtid_01098_memory_timeline_causality.sql';
const FIX_PATH = 'supabase/migrations/20251231000002_vtid_05023_fix_vtid_01098_window_identifier.sql';

const ORIGINAL = stripComments(read(ORIGINAL_PATH));
const FIX = stripComments(read(FIX_PATH));

describe('VTID-05023 F1 fix — memory timeline `window` identifier', () => {
  it('quotes the window column in the table definition and GIN index', () => {
    expect(FIX).toMatch(/^\s{4}"window" JSONB NOT NULL DEFAULT/m);
    expect(FIX).toContain('USING GIN ("window");');
  });

  it('quotes the window column in the INSERT column list and ON CONFLICT update', () => {
    expect(FIX).toMatch(/^\s{8}"window",$/m);
    expect(FIX).toMatch(/^\s{8}"window" = EXCLUDED\."window",$/m);
  });

  it('changes nothing else: removing the added quotes gives back the original SQL', () => {
    expect(FIX.replace(/"window"/g, 'window')).toBe(ORIGINAL);
  });

  it('leaves the original migration unedited', () => {
    expect(ORIGINAL).toMatch(/^\s{4}window JSONB NOT NULL/m);
  });
});
