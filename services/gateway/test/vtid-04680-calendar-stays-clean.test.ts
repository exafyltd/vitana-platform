/**
 * VTID-04680 — a member's calendar holds only what they created or accepted.
 *
 * Goal plans used to fill every day (a daily series per habit plus an entry
 * per weekly check-in). These tests pin the new rule on the SQL that writes
 * them, the one-shot fix that cancels what was already written, and the
 * staff work lens (opt-in, no deploys).
 */
import fs from 'fs';
import path from 'path';

const MIG = path.resolve(__dirname, '../../../supabase/migrations');
const read = (f: string) => fs.readFileSync(path.join(MIG, f), 'utf8');
const strip = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('goal-plan steps and the calendar', () => {
  const sql = strip(read('20260928100000_vtid_04680_goal_plans_keep_calendar_clean.sql'));
  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.calendar_sync_goal_plan_step'));

  it('replaces the function the step trigger calls', () => {
    expect(body).toContain('RETURNS uuid');
    expect(body).toContain('SECURITY DEFINER');
  });

  it('writes no daily series — no RRULE anywhere', () => {
    expect(sql).not.toMatch(/FREQ=/);
    expect(sql).not.toContain('calendar_rrule_until');
  });

  it('returns before any write for everything that is not a milestone', () => {
    const guard = body.indexOf("IF p_step.kind IS DISTINCT FROM 'milestone' THEN");
    const upsert = body.indexOf('calendar_upsert_from_source(');
    expect(guard).toBeGreaterThan(0);
    expect(upsert).toBeGreaterThan(guard);
    expect(body.slice(guard, upsert)).toContain('RETURN NULL;');
    expect(body.match(/calendar_upsert_from_source\(/g)).toHaveLength(1);
  });

  it('still cancels the entries of a plan that is no longer active', () => {
    const inactive = body.indexOf("v_plan.status <> 'active'");
    expect(inactive).toBeGreaterThan(0);
    expect(body.slice(inactive, inactive + 200)).toContain('calendar_cancel_source');
  });

  it('keeps milestone completion in step with the plan', () => {
    expect(body).toContain("calendar_complete_source(p_step.user_id, 'goal_plan_step', v_ref, p_step.status = 'done')");
  });
});

describe('one-shot fix for entries already written', () => {
  const sql = strip(read('data-fixups/20260928100100_vtid_04680_cancel_generated_goal_plan_entries.sql'));

  it('is a data fix, not an automatic migration', () => {
    expect(fs.existsSync(path.join(MIG, '20260928100100_vtid_04680_cancel_generated_goal_plan_entries.sql'))).toBe(false);
  });

  it('only touches untouched habit and check-in entries the trigger wrote', () => {
    for (const cond of [
      "e.source_type = 'goal_plan'",
      "e.source_ref_type = 'goal_plan_step'",
      "s.kind IN ('habit', 'checkpoint')",
      'e.completed_at IS NULL',
      'COALESCE(e.reschedule_count, 0) = 0',
      'e.original_start_time IS NULL',
      'e.activated_at IS NULL',
    ]) {
      expect(sql).toContain(cond);
    }
    expect(sql).not.toContain("'milestone'");
  });

  it('cancels, never deletes, and takes the pending reminders with it', () => {
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).toContain("SET status = 'cancelled'");
    expect(sql).toMatch(/UPDATE public\.reminders[\s\S]*r\.status = 'pending'/);
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });
});

describe('staff work lens', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../src/routes/calendar.ts'), 'utf8');
  const lens = fs.readFileSync(path.resolve(__dirname, '../src/services/calendar-work-lens.ts'), 'utf8');

  it('is opt-in on the window route', () => {
    expect(route).toContain("req.query.include_work !== 'true'");
  });

  it('never reads deploys', () => {
    const list = lens.slice(lens.indexOf('export async function listWorkItems'), lens.indexOf('export function inWindow'));
    expect(list).not.toContain('oasis_events');
    expect(list).not.toContain('deploy.completed');
  });
});
