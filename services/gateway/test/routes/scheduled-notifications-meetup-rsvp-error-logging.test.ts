/**
 * routes/scheduled-notifications.ts — the meetup-RSVP reminder job.
 *
 * History: `repo.fetchMeetupRsvps()` queried `community_meetup_attendance`,
 * a table that does not exist in live Supabase (docs/AURORA-B2-DEAD-
 * CALLSITE-AUDIT.md Addendum 9). This file first pinned that both call
 * sites at least logged the error instead of swallowing it — the missing
 * table itself was left as a product decision.
 *
 * VTID-04374 made that decision: re-checked live 2026-09-23 —
 * `community_meetup_attendance` still does not exist, `community_meetups`
 * has never had a row, and no `meetup_starting_*` notification was ever
 * sent. Community events a member signs up for reach the calendar
 * (global_event_participants → calendar_events, VTID-04321) and get the
 * calendar's own reminders (VTID-04338). The job is retired to a no-op, so
 * this file now pins that nothing reads the missing table any more.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROUTES = path.join(__dirname, '..', '..', 'src', 'routes');

describe('routes/scheduled-notifications.ts — retired meetup reminders', () => {
  const src = fs.readFileSync(path.join(ROUTES, 'scheduled-notifications.ts'), 'utf8');
  const repo = fs.readFileSync(path.join(ROUTES, 'scheduled-notifications-repository.ts'), 'utf8');

  it('no code path reads the missing attendance table', () => {
    expect(src).not.toContain('fetchMeetupRsvps');
    expect(repo).not.toContain('fetchMeetupRsvps');
    expect(repo).not.toContain('community_meetup_attendance');
  });

  it('the route answers old callers with an explicit retired no-op', () => {
    const route = src.slice(src.indexOf("router.post('/meetup-reminders'"));
    const body = route.slice(0, route.indexOf('});') + 3);
    expect(body).toContain('retired: true');
    expect(body).toContain('dispatched: 0');
    expect(body).not.toContain('notifyUser');
  });
});
