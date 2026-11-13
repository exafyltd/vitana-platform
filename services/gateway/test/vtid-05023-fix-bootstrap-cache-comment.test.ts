// VTID-05023 F1 (syntax): 20260524000001 replaces the unapplied 20260524000000 bootstrap cache file.
// The original builds the COMMENT ON TABLE text with '||', which COMMENT ON does not accept, so the
// file fails to parse. This suite pins the fix: the comment text is unchanged, written as adjacent
// string literals, and the rest of the SQL is identical.
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

const ORIGINAL_PATH = 'supabase/migrations/20260524000000_VTID_03036_bootstrap_cache.sql';
const FIX_PATH = 'supabase/migrations/20260524000001_vtid_05023_fix_bootstrap_cache_comment.sql';

const ORIGINAL = stripComments(read(ORIGINAL_PATH));
const FIX = stripComments(read(FIX_PATH));

// Pulls the COMMENT ON TABLE statement out of the SQL and returns its string literals joined.
const commentText = (sql: string) => {
  const stmt = sql.slice(sql.indexOf('COMMENT ON TABLE bootstrap_cache IS'));
  const body = stmt.slice(0, stmt.indexOf(';'));
  return [...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]).join('');
};

describe('VTID-05023 F1 fix — bootstrap_cache COMMENT ON parse error', () => {
  it('does not use the || operator in the COMMENT ON statement', () => {
    const stmt = FIX.slice(FIX.indexOf('COMMENT ON TABLE bootstrap_cache IS'));
    expect(stmt.slice(0, stmt.indexOf(';'))).not.toContain('||');
  });

  it('keeps the full comment text, identical to the original concatenation', () => {
    expect(commentText(FIX)).toBe(commentText(ORIGINAL));
    expect(commentText(FIX)).toContain('shared response cache for /orb/context-bootstrap');
  });

  it('changes nothing else: the rest of the SQL is identical to the original', () => {
    const strip = (sql: string) => sql.slice(0, sql.indexOf('COMMENT ON TABLE bootstrap_cache IS'));
    expect(strip(FIX).trim()).toBe(strip(ORIGINAL).trim());
  });
});
