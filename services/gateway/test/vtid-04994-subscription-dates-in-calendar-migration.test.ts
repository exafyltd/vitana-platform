/**
 * VTID-04994 — subscription renewal / trial / Premium end dates are mirrored into
 * the calendar (migration 20261009090000). Behaviour is proven on a throwaway
 * Postgres (scripts/ci/sql-tests/vtid-04994-subscription-dates-in-calendar.test.sql,
 * CI SQL-SUBSCRIPTION-DATES-IN-CALENDAR); this suite pins the safety properties.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CALENDAR_SOURCE_TYPES } from '../src/types/calendar';

const ROOT = join(__dirname, '../../..');
const SQL = readFileSync(join(ROOT, 'supabase/migrations/20261009090000_vtid_04994_subscription_dates_in_calendar.sql'), 'utf8');

describe('VTID-04994: subscription dates in the calendar', () => {
  it("the source-type CHECK in this migration lists 'subscription' and the gateway list has it", () => {
    expect(CALENDAR_SOURCE_TYPES).toContain('subscription');
    const check = SQL.slice(SQL.indexOf('ADD CONSTRAINT valid_source_type'), SQL.indexOf('-- 2. One helper'));
    expect(check).toContain("'subscription'");
    // That every type in the gateway list is in the NEWEST recreate is pinned by vtid-04331-calendar-data-model.test.ts.
  });

  it('declares insert, update and delete triggers on user_subscriptions', () => {
    expect(SQL).toMatch(/CREATE TRIGGER trg_subscription_insert_calendar\s+AFTER INSERT ON public\.user_subscriptions/);
    expect(SQL).toMatch(/CREATE TRIGGER trg_subscription_update_calendar\s+AFTER UPDATE OF [^\n]+ ON public\.user_subscriptions/);
    expect(SQL).toMatch(/CREATE TRIGGER trg_subscription_delete_calendar\s+AFTER DELETE ON public\.user_subscriptions/);
  });

  it('the update trigger fires only when a watched column really changed (trigger-level WHEN)', () => {
    const start = SQL.indexOf('CREATE TRIGGER trg_subscription_update_calendar');
    const t = SQL.slice(start, SQL.indexOf('EXECUTE FUNCTION', start));
    for (const c of ['status', 'current_period_end', 'trial_end', 'cancel_at_period_end', 'stripe_subscription_id', 'plan_key']) {
      expect(t).toContain(`OLD.${c} IS DISTINCT FROM NEW.${c}`);
    }
  });

  it('can never block a billing write: the function catches every error', () => {
    const fn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_subscription_to_calendar'), SQL.indexOf('DROP TRIGGER IF EXISTS trg_subscription_insert_calendar'));
    expect(fn).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(fn).toContain('RAISE WARNING');
  });

  it('creates no reminders, skips test/service accounts, and is not a client RPC', () => {
    expect(SQL.match(/'\{\}'::int\[\]/g)?.length).toBeGreaterThanOrEqual(3);
    expect(SQL.match(/service_bot_accounts/g)?.length).toBeGreaterThanOrEqual(3);
    expect(SQL.match(/notification_test_actors/g)?.length).toBeGreaterThanOrEqual(3);
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.fn_subscription_to_calendar() FROM PUBLIC, anon, authenticated');
    expect(SQL).toContain('SECURITY DEFINER');
  });
});
