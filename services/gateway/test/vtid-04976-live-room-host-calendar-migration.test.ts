/**
 * VTID-04976 — a live room's calendar entries follow the room (migration
 * 20261008130000). Behaviour is proven on a throwaway Postgres
 * (scripts/ci/sql-tests/vtid-04976-live-room-host-calendar.test.sql, CI
 * SQL-LIVE-ROOM-HOST-CALENDAR); this suite pins the safety properties.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const SQL = readFileSync(join(ROOT, 'supabase/migrations/20261008130000_vtid_04976_live_room_follows_host.sql'), 'utf8');

describe('VTID-04976: live room follows its host', () => {
  it('declares host, change and delete triggers on community_live_streams', () => {
    expect(SQL).toMatch(/CREATE TRIGGER trg_live_stream_host_calendar\s+AFTER INSERT ON public\.community_live_streams/);
    expect(SQL).toMatch(/CREATE TRIGGER trg_live_stream_change_calendar\s+AFTER UPDATE OF scheduled_for, duration_minutes, title, description, status ON public\.community_live_streams/);
    expect(SQL).toMatch(/CREATE TRIGGER trg_live_stream_delete_calendar\s+AFTER DELETE ON public\.community_live_streams/);
  });

  it('the change trigger fires only when a watched column really changed (trigger-level WHEN)', () => {
    const t = SQL.slice(SQL.indexOf('CREATE TRIGGER trg_live_stream_change_calendar'), SQL.indexOf('DROP TRIGGER IF EXISTS trg_live_stream_delete_calendar'));
    for (const c of ['scheduled_for', 'duration_minutes', 'title', 'description', 'status']) {
      expect(t).toContain(`OLD.${c} IS DISTINCT FROM NEW.${c}`);
    }
  });

  it('status is a whitelist: only cancelled (or no date) cancels; times follow only while pending', () => {
    expect(SQL).toContain("IF NEW.status = 'cancelled' OR NEW.scheduled_for IS NULL THEN");
    expect(SQL).toContain("ELSIF NEW.status = 'pending' THEN");
    expect(SQL).not.toMatch(/NEW\.status <> 'pending'/);
  });

  it('only live entries are touched: an edit never revives a cancelled one', () => {
    const fn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_live_stream_to_calendar'), SQL.indexOf('DROP TRIGGER IF EXISTS trg_live_stream_host_calendar'));
    expect(fn.match(/c\.status <> 'cancelled'/g)?.length).toBeGreaterThanOrEqual(3);
    expect(fn).not.toMatch(/SET status = 'confirmed'/);
  });

  it("the host's own entry survives their un-notify, and the host flag survives their Erinnern", () => {
    expect(SQL).toContain("AND COALESCE(c.metadata->>'host', '') <> 'true'");
    expect(SQL).toContain("metadata = public.calendar_events.metadata || jsonb_build_object('host', true)");
  });

  it('re-notify after a reschedule revives at the current time', () => {
    const sub = SQL.slice(SQL.indexOf('fn_live_stream_subscription_to_calendar'), SQL.indexOf('fn_live_stream_to_calendar()\nRETURNS'));
    expect(sub).toMatch(/start_time = EXCLUDED\.start_time/);
    expect(sub).toMatch(/WHERE public\.calendar_events\.status = 'cancelled'/);
  });

  it('skips registered service/test accounts as host, in the trigger and the backfill', () => {
    expect(SQL.match(/service_bot_accounts/g)?.length).toBeGreaterThanOrEqual(2);
    expect(SQL.match(/notification_test_actors/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('is set-based (no loop, no network call) and not executable by clients', () => {
    expect(SQL).not.toMatch(/\bFOR\s+\w+\s+IN\b/i);
    expect(SQL).not.toMatch(/\bLOOP\b/);
    expect(SQL).not.toMatch(/http|net\.|pg_net/i);
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.fn_live_stream_to_calendar() FROM PUBLIC, anon, authenticated;');
  });

  it('has a throwaway-Postgres behaviour test wired into CI', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/SQL-LIVE-ROOM-HOST-CALENDAR.yml'), 'utf8');
    expect(wf).toContain('scripts/ci/sql-tests/run-live-room-host-calendar-test.sh');
    expect(wf).toContain('PASS vtid-04976 live room host calendar');
  });
});
