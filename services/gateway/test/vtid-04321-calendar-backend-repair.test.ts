/**
 * VTID-04321 — calendar step 1, backend repair.
 *  - community event sign-ups (global_event_participants) reach the calendar
 *    (migration 20260923120000, behaviour verified against a local Postgres,
 *    see docs/validation/VTID-04320/outputs/rsvp-trigger-local-pg.txt)
 *  - backoffice gets the admin calendar view
 *  - upcoming-events picks "today" in the user's timezone, not UTC
 *  - calendar_add_event no longer writes a tenant_id column that does not exist
 */

import * as fs from 'fs';
import * as path from 'path';
import { getVisibleContexts, toWritableRoleContext, CALENDAR_EVENT_TYPES } from '../src/types/calendar';
import { wideTodayWindow, pickFirstEventTodayPerUser } from '../src/services/calendar-today';

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '../..');

describe('backoffice calendar view', () => {
  it('sees admin + personal entries, like staff', () => {
    expect(getVisibleContexts('backoffice')).toEqual(['admin', 'personal']);
  });
  it('writes admin role_context', () => {
    expect(toWritableRoleContext('backoffice')).toBe('admin');
  });
});

describe('CALENDAR_EVENT_TYPES mirrors the valid_event_type CHECK', () => {
  it('lists the 13 allowed values', () => {
    expect([...CALENDAR_EVENT_TYPES].sort()).toEqual([
      'admin_task', 'autopilot', 'community', 'deployment', 'dev_task', 'health',
      'journey_milestone', 'nutrition', 'personal', 'professional', 'sprint_milestone',
      'wellness_nudge', 'workout',
    ]);
  });
});

describe('upcoming-events: today in the user timezone', () => {
  // 2026-09-23 06:00 UTC = 08:00 Berlin (the job's fire time)
  const now = new Date('2026-09-23T06:00:00Z');

  it('window spans every zone', () => {
    const w = wideTodayWindow(now);
    expect(w.from).toBe('2026-09-22T16:00:00.000Z');
    expect(w.to).toBe('2026-09-24T20:00:00.000Z');
  });

  it('keeps the first event on the local date and prints local time', () => {
    const rows = [
      // 23:30 UTC on the 22nd = 01:30 Berlin on the 23rd -> today in Berlin
      { id: 'late', user_id: 'berlin', title: 'Night', start_time: '2026-09-22T23:30:00Z' },
      { id: 'noon', user_id: 'berlin', title: 'Lunch', start_time: '2026-09-23T10:30:00Z' },
      // 22:30 UTC on the 23rd = 00:30 Berlin on the 24th -> NOT today in Berlin
      { id: 'tomorrow', user_id: 'berlin2', title: 'Tomorrow', start_time: '2026-09-23T22:30:00Z' },
      // New York: 2026-09-23 02:00 local = 06:00 UTC -> today in NY
      { id: 'ny', user_id: 'nyc', title: 'Run', start_time: '2026-09-23T06:00:00Z' },
    ];
    const tz = (u: string) => (u === 'nyc' ? 'America/New_York' : 'Europe/Berlin');
    const picks = pickFirstEventTodayPerUser(rows, tz, now);
    const byUser = Object.fromEntries(picks.map((p) => [p.event.user_id, p]));

    expect(byUser.berlin.event.id).toBe('late');
    expect(byUser.berlin.localTime).toBe('01:30');
    expect(byUser.berlin2).toBeUndefined();
    expect(byUser.nyc.localTime).toBe('02:00');
  });

  it('the route uses the helper instead of setHours on the gateway clock', () => {
    const src = fs.readFileSync(path.join(root, 'src/routes/scheduled-notifications.ts'), 'utf8');
    const handler = src.slice(src.indexOf("router.post('/upcoming-events'"), src.indexOf("upcoming_event_today → "));
    expect(handler).toContain('wideTodayWindow(now)');
    expect(handler).toContain('pickFirstEventTodayPerUser(');
    expect(handler).not.toContain('setHours(');
    expect(handler).not.toContain('getHours()');
  });
});

describe('RSVP -> calendar migration', () => {
  const sql = fs.readFileSync(
    path.join(repoRoot, 'supabase/migrations/20260923120000_vtid_04321_rsvp_calendar_global_events.sql'),
    'utf8',
  );

  it('fires on the real sign-up table, for join and leave', () => {
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OF status OR DELETE ON public\.global_event_participants/);
    expect(sql).toContain("NEW.status = 'attending'");
  });

  it('writes a constraint-valid row with the client-compatible meetup_id', () => {
    expect(sql).toContain("'community_rsvp'");
    expect(sql).toContain("'community_event'");
    expect(sql).toContain("jsonb_build_object('meetup_id'");
  });

  it('lets a client-written row replace the trigger row (no duplicates, no client error)', () => {
    expect(sql).toMatch(/AFTER INSERT ON public\.calendar_events/);
    expect(sql).toContain("NEW.source_type IS DISTINCT FROM 'community_rsvp'");
  });
});
