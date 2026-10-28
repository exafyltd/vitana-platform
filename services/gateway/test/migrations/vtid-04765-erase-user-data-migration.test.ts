/**
 * VTID-04765: the erasure migration's safety properties, read from the file.
 * Its behaviour is tested on a throwaway Postgres by
 * scripts/ci/sql-tests/run-erase-user-data-test.sh (CI: SQL-ERASE-USER-DATA.yml).
 */
import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(
  path.join(__dirname, '../../../../supabase/migrations/20261001120000_vtid_04765_erase_user_data.sql'),
  'utf8',
);

describe('VTID-04765 erase_user_data migration', () => {
  it('only service_role can execute it', () => {
    expect(sql).toMatch(/revoke all on function public\.erase_user_data\(uuid, boolean\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.erase_user_data\(uuid, boolean\) to service_role;/);
  });

  it('runs with a fixed search_path', () => {
    expect(sql).toMatch(/security definer\s+set search_path = public, pg_temp/);
  });

  it('every retained table has a reason, and the ledgers keep the account they reference', () => {
    expect(sql).toMatch(/reason text not null check \(length\(btrim\(reason\)\) > 0\)/);
    for (const t of ['wallet_accounts', 'wallet_ledger_entries', 'wallet_deposits']) expect(sql).toContain(`('${t}',`);
  });

  it('leaves auth-cascading tables to the auth delete and skips partitions', () => {
    expect(sql).toContain("con.confrelid = 'auth.users'::regclass");
    expect(sql).toContain('not c.relispartition');
  });

  it('refuses a null user', () => {
    expect(sql).toContain("raise exception 'erase_user_data: p_user_id is required'");
  });
});
