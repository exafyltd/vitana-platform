// VTID-05023 F1 (syntax): 20260420130001 replaces the unapplied 20260420130000 ai_usage_log file.
// The original opens its pg_cron DO block with $$, and the inner $$refresh ...$$ closes it early,
// so the trailing refresh statement fails to parse. This suite pins the fix: the DO block uses the
// $do$ tag, the inner $$ literal stays intact, and nothing else in the SQL changes.
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

const ORIGINAL_PATH = 'supabase/migrations/20260420130000_BOOTSTRAP_ai_usage_log.sql';
const FIX_PATH = 'supabase/migrations/20260420130001_vtid_05023_fix_ai_usage_log_dollar_quote.sql';

const ORIGINAL = stripComments(read(ORIGINAL_PATH));
const FIX = stripComments(read(FIX_PATH));

describe('VTID-05023 F1 fix — ai_usage_log DO block dollar quoting', () => {
  it('opens and closes the DO block with the $do$ tag', () => {
    expect(FIX).toMatch(/^do \$do\$$/m);
    expect(FIX).toMatch(/^end\$do\$;$/m);
    expect(FIX).not.toMatch(/^do \$\$$/m);
    expect(FIX).not.toMatch(/^end\$\$;$/m);
  });

  it('keeps the inner $$refresh ... $$ cron command as a literal inside the DO block', () => {
    const doBlock = FIX.slice(FIX.indexOf('do $do$'), FIX.indexOf('end$do$;'));
    expect(doBlock).toContain(
      '$$refresh materialized view concurrently public.ai_usage_month_by_user_provider;$$',
    );
  });

  it('keeps the initial REFRESH outside the DO block', () => {
    expect(FIX.indexOf('refresh materialized view public.ai_usage_month_by_user_provider;')).toBeLessThan(
      FIX.indexOf('do $do$'),
    );
  });

  it('changes nothing else: swapping the two DO delimiters gives back the original SQL', () => {
    const restored = FIX.replace('do $do$', () => 'do $$').replace('end$do$;', () => 'end$$;');
    expect(restored).toBe(ORIGINAL);
  });
});
