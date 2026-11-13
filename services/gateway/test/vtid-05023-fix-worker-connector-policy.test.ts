// VTID-05023 F1 (syntax): 20260117000001 replaces the unapplied 20260117000000 worker connector file.
// The original uses CREATE POLICY IF NOT EXISTS, which PostgreSQL does not support, so the file
// fails to parse. This suite pins the fix: the policy is dropped if present and created with the
// same name, target and USING clause, and nothing else in the SQL changes.
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

const ORIGINAL_PATH = 'supabase/migrations/20260117000000_vtid_01183_worker_agent_connector.sql';
const FIX_PATH = 'supabase/migrations/20260117000001_vtid_05023_fix_vtid_01183_policy_syntax.sql';

const ORIGINAL = stripComments(read(ORIGINAL_PATH));
const FIX = stripComments(read(FIX_PATH));

const POLICY = '"Service role full access to worker_registry"';

describe('VTID-05023 F1 fix — worker connector policy syntax', () => {
  it('never uses CREATE POLICY IF NOT EXISTS', () => {
    expect(FIX).not.toMatch(/CREATE POLICY\s+IF NOT EXISTS/i);
  });

  it('drops the policy if present, then creates it with the same name and target', () => {
    expect(FIX).toContain(`DROP POLICY IF EXISTS ${POLICY} ON worker_registry;`);
    expect(FIX).toContain(`CREATE POLICY ${POLICY}\n  ON worker_registry FOR ALL\n  USING (auth.role() = 'service_role');`);
    expect(FIX.indexOf('DROP POLICY IF EXISTS')).toBeLessThan(FIX.indexOf('CREATE POLICY'));
  });

  it('changes nothing else: the original with IF NOT EXISTS removed and a DROP added is the fix', () => {
    const expected = ORIGINAL.replace(
      `CREATE POLICY IF NOT EXISTS ${POLICY}`,
      `DROP POLICY IF EXISTS ${POLICY} ON worker_registry;\nCREATE POLICY ${POLICY}`,
    );
    expect(FIX.trim()).toBe(expected.trim());
  });
});
