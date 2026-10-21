/**
 * VTID-04978 — one-shot personal reminders are mirrored into the calendar
 * (migration 20261008150000). Behaviour is proven on a throwaway Postgres
 * (scripts/ci/sql-tests/vtid-04978-reminders-in-calendar.test.sql, CI
 * SQL-REMINDERS-IN-CALENDAR); this suite pins the safety properties.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CALENDAR_SOURCE_TYPES } from '../src/types/calendar';

const ROOT = join(__dirname, '../../..');
const SQL = readFileSync(join(ROOT, 'supabase/migrations/20261008150000_vtid_04978_reminders_in_calendar.sql'), 'utf8');

const SCOPE = "created_via IN ('voice', 'ui') AND %s.calendar_event_id IS NULL AND %s.recurrence_rule IS NULL";

describe('VTID-04978: reminders in the calendar', () => {
  it("the source-type CHECK in this migration lists 'reminder' and the gateway type list has it", () => {
    expect(CALENDAR_SOURCE_TYPES).toContain('reminder');
    const check = SQL.slice(SQL.indexOf('ADD CONSTRAINT valid_source_type'), SQL.indexOf('-- 2. Mirror function'));
    expect(check).toContain("'reminder'");
    // That every type in the gateway list is in the NEWEST recreate is pinned by vtid-04331-calendar-data-model.test.ts.
  });

  it('all three triggers carry the member-made, one-shot, unlinked scope in their WHEN clause', () => {
    for (const [name, row] of [['trg_reminder_insert_calendar', 'NEW'], ['trg_reminder_update_calendar', 'NEW'], ['trg_reminder_delete_calendar', 'OLD']]) {
      const start = SQL.indexOf(`CREATE TRIGGER ${name}`);
      const t = SQL.slice(start, SQL.indexOf('EXECUTE FUNCTION', start));
      expect(t).toContain(`${row}.created_via IN ('voice', 'ui')`);
      expect(t).toContain(`${row}.calendar_event_id IS NULL`);
      expect(t).toContain(`${row}.recurrence_rule IS NULL`);
    }
    expect(SCOPE).toContain('calendar_event_id IS NULL'); // keeps the system-reminder loop guard visible in this file
  });

  it('the update trigger fires only when a watched column really changed', () => {
    const start = SQL.indexOf('CREATE TRIGGER trg_reminder_update_calendar');
    const t = SQL.slice(start, SQL.indexOf('EXECUTE FUNCTION', start));
    for (const c of ['status', 'next_fire_at', 'action_text', 'description']) expect(t).toContain(`OLD.${c} IS DISTINCT FROM NEW.${c}`);
  });

  it('mirror rows add no second reminder and skip test/service accounts', () => {
    expect(SQL.match(/'\{\}'::int\[\]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(SQL.match(/service_bot_accounts/g)?.length).toBeGreaterThanOrEqual(2);
    expect(SQL.match(/notification_test_actors/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('is a trigger function, never a client RPC', () => {
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.fn_reminder_to_calendar() FROM PUBLIC, anon, authenticated');
    expect(SQL).toContain('SECURITY DEFINER');
  });
});
