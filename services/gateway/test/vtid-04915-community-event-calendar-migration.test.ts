/**
 * VTID-04915 — community event host entry, event edits move entries, event
 * delete cancels them (migration 20261006140000).
 *
 * The behaviour is proven against a throwaway Postgres next to the VTID-04321
 * attendee trigger (scripts/ci/sql-tests/vtid-04915-community-event-calendar
 * .test.sql, CI SQL-COMMUNITY-EVENT-CALENDAR). This suite pins the parts that
 * keep it safe and cheap on the shared database, so a later edit cannot drop
 * them without a red build.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const SQL = readFileSync(
  join(ROOT, 'supabase/migrations/20261006140000_vtid_04915_community_event_host_and_time_sync.sql'),
  'utf8',
);

describe('VTID-04915: community event calendar triggers', () => {
  it('declares the three triggers on global_community_events', () => {
    expect(SQL).toMatch(/CREATE TRIGGER trg_community_event_host_calendar\s+AFTER INSERT ON public\.global_community_events/);
    expect(SQL).toMatch(/CREATE TRIGGER trg_community_event_change_calendar\s+AFTER UPDATE OF start_time, end_time, location, virtual_link, title, description/);
    expect(SQL).toMatch(/CREATE TRIGGER trg_community_event_delete_calendar\s+AFTER DELETE ON public\.global_community_events/);
  });

  it('the change trigger fires only when a relevant column really changed', () => {
    const when = SQL.slice(SQL.indexOf('CREATE TRIGGER trg_community_event_change_calendar'));
    expect(when).toMatch(/WHEN \(OLD\.start_time IS DISTINCT FROM NEW\.start_time/);
  });

  it('moves and cancels with set-based statements only: no loop, no network call', () => {
    const fn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_community_event_to_calendar'), SQL.indexOf('DROP TRIGGER IF EXISTS trg_community_event_host_calendar'));
    expect(fn).not.toMatch(/\bFOR\s+\w+\s+IN\b/i);
    expect(fn).not.toMatch(/\bLOOP\b/);
    expect(fn).not.toMatch(/http|net\.|pg_net/i);
    expect(fn).toMatch(/SET status = 'cancelled'/);
  });

  it('matches trigger rows and legacy client rows, and never revives a cancelled entry', () => {
    expect(SQL.match(/c\.metadata->>'meetup_id' = (NEW|OLD|e)\.id::text/g)?.length).toBeGreaterThanOrEqual(3);
    expect(SQL.match(/c\.status <> 'cancelled'/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('the host row has the VTID-04321 shape plus host=true, so the existing dedupe still applies', () => {
    expect(SQL).toContain("'community_rsvp'");
    expect(SQL).toContain("'community_event'");
    expect(SQL).toContain("'host', true");
  });

  it('is not executable by clients and backfills only future events, idempotently', () => {
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.fn_community_event_to_calendar() FROM PUBLIC, anon, authenticated;');
    expect(SQL).toMatch(/e\.start_time > now\(\)/);
    expect(SQL).toMatch(/ON CONFLICT \(user_id, source_ref_id, source_ref_type\) WHERE source_ref_id IS NOT NULL DO NOTHING/);
  });

  it('has a throwaway-Postgres behaviour test wired into CI', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/SQL-COMMUNITY-EVENT-CALENDAR.yml'), 'utf8');
    expect(wf).toContain('scripts/ci/sql-tests/run-community-event-calendar-test.sh');
    expect(wf).toContain('PASS vtid-04915 community event calendar');
  });
});
