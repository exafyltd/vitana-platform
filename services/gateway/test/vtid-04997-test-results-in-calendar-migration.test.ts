/**
 * VTID-04997 — the expected date of a health test result is mirrored into the
 * calendar (migration 20261010100000). Behaviour is proven on a throwaway
 * Postgres (scripts/ci/sql-tests/vtid-04997-test-results-in-calendar.test.sql,
 * CI SQL-TEST-RESULTS-IN-CALENDAR); this suite pins the safety properties.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CALENDAR_SOURCE_TYPES } from '../src/types/calendar';

const ROOT = join(__dirname, '../../..');
const SQL = readFileSync(join(ROOT, 'supabase/migrations/20261010100000_vtid_04997_test_results_in_calendar.sql'), 'utf8');

describe('VTID-04997: expected test-result dates in the calendar', () => {
  it("the source-type CHECK lists 'test_result' and the gateway list has it", () => {
    expect(CALENDAR_SOURCE_TYPES).toContain('test_result');
    const check = SQL.slice(SQL.indexOf('ADD CONSTRAINT valid_source_type'), SQL.indexOf('-- 2. One helper'));
    for (const t of CALENDAR_SOURCE_TYPES) expect(check).toContain(`'${t}'`);
  });

  it('declares insert, update and delete triggers on partner_health_test_orders', () => {
    expect(SQL).toMatch(/CREATE TRIGGER trg_test_result_insert_calendar\s+AFTER INSERT ON public\.partner_health_test_orders/);
    expect(SQL).toMatch(/CREATE TRIGGER trg_test_result_update_calendar\s+AFTER UPDATE OF [^\n]+ ON public\.partner_health_test_orders/);
    expect(SQL).toMatch(/CREATE TRIGGER trg_test_result_delete_calendar\s+AFTER DELETE ON public\.partner_health_test_orders/);
  });

  it('the update trigger fires only when a watched column really changed (trigger-level WHEN)', () => {
    const start = SQL.indexOf('CREATE TRIGGER trg_test_result_update_calendar');
    const t = SQL.slice(start, SQL.indexOf('EXECUTE FUNCTION', start));
    for (const c of ['status', 'expected_result_at', 'test_name']) {
      expect(t).toContain(`OLD.${c} IS DISTINCT FROM NEW.${c}`);
    }
  });

  it('can never block an order write: the function catches every error', () => {
    const fn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_test_result_to_calendar'), SQL.indexOf('DROP TRIGGER IF EXISTS trg_test_result_insert_calendar'));
    expect(fn).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(fn).toContain('RAISE WARNING');
  });

  it('wants an entry only for pending orders with a future date, and shows the test name only', () => {
    const fn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_test_result_to_calendar'), SQL.indexOf('DROP TRIGGER IF EXISTS trg_test_result_insert_calendar'));
    expect(fn).toContain("o.status IN ('ordered', 'sample_kit_shipped', 'sample_received', 'processing')");
    expect(fn).toContain('o.expected_result_at > now()');
    expect(fn).toContain('o.expected_result_at, o.test_name)');
    expect(fn).not.toMatch(/external_|result_inbox|raw_payload/);
  });

  it('creates no reminders, skips test/service accounts, and is not a client RPC', () => {
    expect(SQL.match(/'\{\}'::int\[\]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(SQL.match(/service_bot_accounts/g)?.length).toBeGreaterThanOrEqual(2);
    expect(SQL.match(/notification_test_actors/g)?.length).toBeGreaterThanOrEqual(2);
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.fn_test_result_to_calendar() FROM PUBLIC, anon, authenticated');
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.fn_test_result_calendar_sync(uuid, text, boolean, timestamptz, text) FROM PUBLIC, anon, authenticated');
    expect(SQL).toContain('SECURITY DEFINER');
  });
});
