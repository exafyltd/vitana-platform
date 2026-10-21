/**
 * VTID-04878 — claim_capped_reward migration contract and, when a local
 * PostgreSQL server is available, the SQL harness: the VTID-04809 wallet
 * replica + real credit_wallet(), the migration applied twice, then
 * supabase/tests/vtid_04878_capped_reward.test.sql (caps per day/week,
 * duplicates, window rollover, test-account refusal, sweep candidates).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIGRATION = fs.readFileSync(path.join(REPO, 'supabase/migrations/20261005100000_vtid_04878_claim_capped_reward.sql'), 'utf8');

describe('VTID-04878 migration', () => {
  it('serialises claims per member and rule, and counts what credit_wallet writes', () => {
    expect(MIGRATION).toMatch(/pg_advisory_xact_lock\(hashtextextended\('capped_reward:' \|\| p_user_id::text \|\| ':' \|\| p_rule, 0\)\)/);
    expect(MIGRATION).toContain("AND metadata->>'source' = p_rule");
    expect(MIGRATION).toContain("public.credit_wallet(p_tenant_id, p_user_id, p_amount, 'reward', p_rule, v_key, NULL)");
  });

  it('refuses test and service accounts (CLAUDE.md rules 43-45)', () => {
    for (const s of ['service_bot_accounts', 'notification_test_actors', "e2e-%@%", '%@vitanatest.exafy.io', '00000000-0000-0000-0000-000000000001']) {
      expect(MIGRATION).toContain(s);
    }
  });

  it('measures 15 full minutes on the timestamps, not the rounded duration column', () => {
    expect(MIGRATION).toContain("a.left_at - a.joined_at >= interval '15 minutes'");
    expect(MIGRATION).not.toMatch(/duration_minutes\s*>=/);
  });

  it('keeps every reward function server-side only', () => {
    expect(MIGRATION.match(/FROM PUBLIC, anon, authenticated;|FROM anon, authenticated;/g)?.length).toBeGreaterThanOrEqual(5);
    expect(MIGRATION).toContain('must not be executable by members');
  });

  const pgBin = (() => {
    try {
      const dirs = fs.readdirSync('/usr/lib/postgresql').sort();
      const bin = `/usr/lib/postgresql/${dirs[dirs.length - 1]}/bin`;
      return fs.existsSync(`${bin}/initdb`) ? bin : null;
    } catch {
      return null;
    }
  })();
  (pgBin ? it : it.skip)('applies twice over the live wallet replica and passes the SQL assertions', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-04878-capped-rewards.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55438' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('VTID-04878: all assertions passed');
  }, 120_000);
});
