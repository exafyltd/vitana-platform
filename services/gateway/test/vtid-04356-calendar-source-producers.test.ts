/**
 * VTID-04356 — calendar step 5: plans, orders, bookings and rooms land in
 * the calendar.
 *
 * The triggers themselves were exercised on a throwaway local Postgres (34
 * scenarios, docs/validation/VTID-04356/outputs/). This suite pins:
 *   - the migration's contract (which sources, which states, never failing
 *     the source write, backfill future-only, not callable by browsers);
 *   - the calendar -> goal step write-back;
 *   - that the gateway writers no longer bypass the contract.
 */
import fs from 'fs';
import path from 'path';
import { completeSourceForCalendarEvent } from '../src/services/calendar-producers';

const root = path.resolve(__dirname, '..', '..', '..');
const read = (p: string) => fs.readFileSync(path.resolve(root, p), 'utf8');
const MIGRATION = 'supabase/migrations/20260923160000_vtid_04356_calendar_source_producers.sql';

describe('migration contract', () => {
  const sql = read(MIGRATION);

  it.each([
    ['goal_plan_steps', 'trg_goal_plan_step_calendar'],
    ['goal_plans', 'trg_goal_plan_calendar'],
    ['user_health_plans', 'trg_health_plan_calendar'],
    ['provider_appointments', 'trg_appointment_calendar'],
    ['lab_test_orders', 'trg_lab_order_calendar'],
    ['live_room_sessions', 'trg_live_room_session_calendar'],
    ['live_room_access_grants', 'trg_live_room_grant_calendar'],
  ])('%s has its calendar trigger', (table, trigger) => {
    expect(sql).toMatch(new RegExp(`CREATE TRIGGER ${trigger}[\\s\\S]*?ON public\\.${table}`));
  });

  it('every trigger body swallows calendar errors so the source write is never lost', () => {
    const bodies = sql.split('CREATE OR REPLACE FUNCTION public.fn_').slice(1);
    expect(bodies).toHaveLength(7);
    for (const b of bodies) {
      expect(b).toContain('EXCEPTION WHEN OTHERS THEN');
      expect(b).toContain('RAISE WARNING');
    }
  });

  it('one upsert, keyed on the source-ref unique index, keeps completions', () => {
    expect(sql).toContain('ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL');
    expect(sql).toMatch(/WHERE c\.completed_at IS NULL\s+AND \(/);
    expect(sql).toContain("status      = CASE WHEN c.status = 'cancelled' THEN 'confirmed' ELSE c.status END");
  });

  it('an unpaid booking (pending) never shows; only paid ones do', () => {
    expect(sql).toContain("IF v_status IN ('scheduled', 'confirmed', 'completed') AND p_appt.start_time IS NOT NULL");
    expect(sql).toMatch(/pending \(checkout not paid yet\)[\s\S]*calendar_cancel_source\(p_appt\.user_id/);
  });

  it('lab orders use the lab ref type, so the lab reminder rules apply', () => {
    // calendar-reminders.isLab: source_type 'lab_order' or ref type 'lab_*'.
    expect(sql).toContain("'lab_order', 'lab_test_order'");
  });

  it('a habit is a daily series and its completion is not mirrored', () => {
    expect(sql).toContain("'FREQ=DAILY;UNTIL=' || public.calendar_rrule_until(v_plan.target_date, v_tz)");
    expect(sql).toMatch(/habit is a daily series|habit is a series/);
  });

  it('times are local to the user', () => {
    expect(sql).toContain("(p_step.scheduled_date + time '09:00') AT TIME ZONE v_tz");
    expect(sql).toContain('public.calendar_user_timezone(');
  });

  it('backfill writes future items only', () => {
    const backfill = sql.slice(sql.indexOf('DO $backfill$'));
    expect(backfill).toContain("st.scheduled_date >= current_date");
    expect(backfill).toContain('start_time > now()');
    expect(backfill).toContain('scheduled_date > now()');
    expect(backfill).toContain('starts_at > now()');
  });

  it('the helpers are not callable from the browser', () => {
    for (const fn of [
      'calendar_user_timezone', 'calendar_upsert_from_source', 'calendar_cancel_source', 'calendar_complete_source',
      // SECURITY DEFINER and row-typed: callable with a forged row for another user.
      'calendar_sync_goal_plan_step', 'calendar_sync_health_plan', 'calendar_sync_appointment',
      'calendar_sync_lab_order', 'calendar_sync_live_room_entry',
    ]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    }
  });

  it('every source type written is allowed by valid_source_type', () => {
    const allowed = ['health_plan', 'lab_order', 'appointment', 'live_room', 'goal_plan'];
    const written = [...sql.matchAll(/p_\w+\.user_id, '(\w+)', '\w+'/g)].map((m) => m[1]);
    expect(written.length).toBeGreaterThan(0);
    for (const t of written) expect(allowed).toContain(t);
  });
});

describe('calendar -> goal step write-back', () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; method: string; body: any }> = [];
  beforeEach(() => {
    calls = [];
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
  });
  afterAll(() => {
    global.fetch = realFetch;
  });
  const respond = (rows: unknown[], status = 200) => {
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(rows), { status });
    }) as any;
  };

  it('ticking a goal entry off marks its step done, scoped to the user, never a habit', async () => {
    respond([{ id: 'step1' }]);
    const r = await completeSourceForCalendarEvent({ source_ref_type: 'goal_plan_step', source_ref_id: 'step1' }, 'u1');
    expect(r.completed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toContain('/rest/v1/goal_plan_steps?id=eq.step1&user_id=eq.u1');
    expect(calls[0].url).toContain('kind=neq.habit');
    expect(calls[0].url).toContain('status=neq.done');
    expect(calls[0].body).toMatchObject({ status: 'done' });
  });

  it('an already-done or habit step is reported as not completed', async () => {
    respond([]);
    expect((await completeSourceForCalendarEvent({ source_ref_type: 'goal_plan_step', source_ref_id: 'h1' }, 'u1')).completed).toBe(false);
  });

  it('a failing write is reported, not thrown', async () => {
    respond([], 500);
    const r = await completeSourceForCalendarEvent({ source_ref_type: 'goal_plan_step', source_ref_id: 's' }, 'u1');
    expect(r.completed).toBe(false);
    expect(r.error).toBeDefined();
  });
});

describe('gateway writers go through the contract', () => {
  const src = (p: string) => read(`services/gateway/${p}`);

  it('the broken goal-plan mirror is gone (the trigger replaces it)', () => {
    const planner = src('src/services/journey/goal-planner-service.ts');
    expect(planner).not.toContain('mirrorStepsToCalendar');
    expect(planner).not.toContain('bulkCreateCalendarEvents');
  });

  it('Autopilot activation upserts on the recommendation id', () => {
    const route = src('src/routes/autopilot-recommendations.ts');
    expect(route).toContain("{ source_type: 'autopilot', source_ref_type: 'autopilot_recommendation', source_ref_id: id }");
    expect(route).not.toMatch(/calendarEvent = await createCalendarEvent\(/);
  });

  it('voice-created entries use the shared role -> view mapping', () => {
    const live = src('src/routes/orb-live.ts');
    expect(live).toContain('role_context: toWritableRoleContext(role)');
    expect(live).not.toContain("role === 'developer' ? 'developer' : role === 'admin' ? 'admin' : 'community'");
  });
});
