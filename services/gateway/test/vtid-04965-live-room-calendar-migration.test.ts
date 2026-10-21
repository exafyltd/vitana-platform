/**
 * VTID-04965 — "Erinnern" on a scheduled Live Room puts it in the member's
 * calendar (migration 20261007200000).
 *
 * The behaviour is proven against a throwaway Postgres
 * (scripts/ci/sql-tests/vtid-04965-live-room-calendar.test.sql, CI
 * SQL-LIVE-ROOM-CALENDAR). This suite pins the safety properties so a later
 * edit cannot drop them without a red build.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const SQL = readFileSync(
  join(ROOT, 'supabase/migrations/20261007200000_vtid_04965_live_room_reminder_calendar.sql'),
  'utf8',
);

describe('VTID-04965: live room reminder calendar trigger', () => {
  it('fires on subscribe and unsubscribe of live_stream_subscribers', () => {
    expect(SQL).toMatch(/CREATE TRIGGER trg_live_stream_subscription_calendar\s+AFTER INSERT OR DELETE ON public\.live_stream_subscribers/);
  });

  it('writes the live_room shape that valid_source_type already allows', () => {
    expect(SQL).toMatch(/'live_room',\s+NEW\.stream_id::text,\s+'live_room'/);
    expect(SQL).not.toContain("'community_rsvp'");
  });

  it('only a pending room with a future date reaches the calendar, in the trigger and the backfill', () => {
    expect(SQL).toMatch(/v_stream\.status = 'pending'/);
    expect(SQL).toMatch(/v_stream\.scheduled_for > now\(\)/);
    expect(SQL).toMatch(/l\.status = 'pending'/);
    expect(SQL).toMatch(/l\.scheduled_for > now\(\)/);
  });

  it('skips registered service and test accounts, in the trigger and the backfill', () => {
    expect(SQL.match(/service_bot_accounts/g)?.length).toBeGreaterThanOrEqual(2);
    expect(SQL.match(/notification_test_actors/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('is idempotent: only a cancelled row is revived, the backfill never overwrites', () => {
    expect(SQL).toMatch(/WHERE public\.calendar_events\.status = 'cancelled'/);
    expect(SQL).toMatch(/DO NOTHING/);
    expect(SQL).toContain('DROP TRIGGER IF EXISTS trg_live_stream_subscription_calendar');
  });

  it('cancels with one set-based statement: no loop, no network call', () => {
    const fn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION'), SQL.indexOf('DROP TRIGGER IF EXISTS'));
    expect(fn).not.toMatch(/\bFOR\s+\w+\s+IN\b/i);
    expect(fn).not.toMatch(/\bLOOP\b/);
    expect(fn).not.toMatch(/http|net\.|pg_net/i);
    expect(fn).toMatch(/SET status = 'cancelled'/);
  });

  it('defaults to a one-hour room and is not executable by clients', () => {
    expect(SQL).toMatch(/COALESCE\(NULLIF\(v_stream\.duration_minutes, 0\), 60\)/);
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.fn_live_stream_subscription_to_calendar() FROM PUBLIC, anon, authenticated;');
  });

  it('has a throwaway-Postgres behaviour test wired into CI', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/SQL-LIVE-ROOM-CALENDAR.yml'), 'utf8');
    expect(wf).toContain('scripts/ci/sql-tests/run-live-room-calendar-test.sh');
    expect(wf).toContain('PASS vtid-04965 live room calendar');
  });
});
