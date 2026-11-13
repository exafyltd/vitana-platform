// VTID-05023 F1 (syntax): 20260205000001 replaces the unapplied 20260205000000 oasis indexes file.
// The original opens its pg_cron DO block with $$, and the inner $$SELECT ...$$ closes it early,
// so the SELECT fails to parse. This suite pins the fix: the DO block uses the $do$ tag, the inner
// $$ literal stays intact, and nothing else in the SQL changes.
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

const ORIGINAL_PATH = 'supabase/migrations/20260205000000_fix_oasis_events_disk_io_indexes.sql';
const FIX_PATH = 'supabase/migrations/20260205000001_vtid_05023_fix_oasis_events_disk_io_indexes.sql';

const ORIGINAL = stripComments(read(ORIGINAL_PATH));
const FIX = stripComments(read(FIX_PATH));

describe('VTID-05023 F1 fix — oasis_events DO block dollar quoting', () => {
  it('opens and closes the DO block with the $do$ tag', () => {
    expect(FIX).toMatch(/^DO \$do\$$/m);
    expect(FIX).toMatch(/^END\$do\$;$/m);
    expect(FIX).not.toMatch(/^DO \$\$$/m);
    expect(FIX).not.toMatch(/^END\$\$;$/m);
  });

  it('keeps the inner $$SELECT ... $$ cron command as a literal inside the DO block', () => {
    const doBlock = FIX.slice(FIX.indexOf('DO $do$'), FIX.indexOf('END$do$;'));
    expect(doBlock).toContain("$$SELECT public.oasis_events_cleanup(14)$$");
  });

  it('changes nothing else: swapping the two DO delimiters gives back the original SQL', () => {
    const restored = FIX.replace('DO $do$', () => 'DO $$').replace('END$do$;', () => 'END$$;');
    expect(restored).toBe(ORIGINAL);
  });
});
