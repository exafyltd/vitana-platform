/**
 * VTID-04859 — Founding 1000: the first 1,000 members get a free Premium year.
 *
 * Pins the migration's contract and, when a local PostgreSQL server is
 * available, applies it twice to a replica of the live tables and runs the
 * SQL assertions (supabase/tests/vtid_04859_founding_1000.test.sql).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '../../..');
const MIGRATION = fs.readFileSync(path.join(REPO, 'supabase/migrations/20261003100000_vtid_04859_founding_1000.sql'), 'utf8');

describe('VTID-04859 migration', () => {
  it('caps seats at 1,000 and serialises them', () => {
    expect(MIGRATION).toContain('CHECK (seat_number BETWEEN 1 AND 1000)');
    expect(MIGRATION).toContain('pg_advisory_xact_lock');
    expect(MIGRATION).toContain("'SOLD_OUT'");
  });

  it('never seats a test or service account (CLAUDE.md rules 43-45)', () => {
    expect(MIGRATION).toContain('public.service_bot_accounts WHERE user_id = p_user_id');
    expect(MIGRATION).toContain('public.notification_test_actors WHERE user_id = p_user_id');
  });

  it('never overwrites a paying subscription or extends the launch year', () => {
    expect(MIGRATION).toContain("v_source := 'stripe_active'");
    expect(MIGRATION).toContain("v_source := 'launch_auto_grant_2026'");
  });

  it('seats new members at signup without ever blocking the membership insert', () => {
    expect(MIGRATION).toMatch(/CREATE TRIGGER founding_seat_on_primary_membership\s+AFTER INSERT ON public\.user_tenants/);
    expect(MIGRATION).toMatch(/EXCEPTION WHEN OTHERS THEN\s+-- Never block the membership insert/);
  });

  it('keeps the claim server-side only', () => {
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.claim_founding_seat\(uuid, uuid\) FROM PUBLIC, anon, authenticated/);
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.mark_founding_celebrated\(uuid\) FROM PUBLIC, anon, authenticated/);
  });

  it('values the year at 12 x EUR 9.99', () => {
    expect(MIGRATION).toContain('value_cents    integer NOT NULL DEFAULT 11988');
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
  (pgBin ? it : it.skip)('applies twice to a replica of the live tables and passes the SQL assertions', () => {
    const out = execFileSync(path.join(REPO, 'scripts/ci/test-vtid-04859-founding.sh'), {
      env: { ...process.env, PGBIN: pgBin!, PGPORT_TEST: '55434' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('VTID-04859: all assertions passed');
  }, 120_000);
});
