import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE user_guided_journey_state (user_id uuid primary key, metadata jsonb not null default '{}', updated_at timestamptz not null default now());
CREATE TABLE user_tenants (id uuid primary key default gen_random_uuid(), tenant_id uuid, user_id uuid, is_primary boolean, created_at timestamptz default now());
`);
const nowUtc = (await db.query(`select to_char(now() at time zone 'UTC','HH24:MI') t, (now() at time zone 'UTC')::date::text d`)).rows[0];
const [h, m] = nowUtc.t.split(':').map(Number);
const minus = (mins) => { const x = (h * 60 + m - mins + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
if (h * 60 + m < 200 || h >= 22) { console.log('SKIP: run between 03:20 and 22:00 UTC so the windows do not wrap'); process.exit(0); }
const T = 'aaaaaaaa-0000-0000-0000-00000000000';
const rows = [
  ['1', { audiobook_reminder: { time: minus(10), tz: 'UTC' } }],                                   // due
  ['2', { audiobook_reminder: { time: minus(-30), tz: 'UTC' } }],                                  // not yet
  ['3', { audiobook_reminder: { time: minus(180), tz: 'UTC' } }],                                  // window passed
  ['4', { audiobook_reminder: { time: minus(10), tz: 'UTC', last_sent_local_date: nowUtc.d } }],   // already sent today
  ['5', { audiobook_reminder: { time: minus(10), tz: 'UTC' }, daily_listen: { date: nowUtc.d, sessions: [3] } }], // listened today
  ['6', { audiobook_reminder: { time: minus(10), tz: 'Mars/Olympus' } }],                          // bad tz
  ['7', {}],                                                                                         // no reminder
  ['8', { audiobook_reminder: { time: minus(5), tz: 'UTC', last_sent_local_date: '2000-01-01' } }],// sent another day
];
for (const [i, md] of rows) {
  await db.query(`insert into user_guided_journey_state(user_id, metadata) values ($1, $2)`, [T + i, md]);
  await db.query(`insert into user_tenants(tenant_id,user_id,is_primary) values ($1,$2,false),($3,$2,true)`, ['bbbbbbbb-0000-0000-0000-000000000000', T + i, 'cccccccc-0000-0000-0000-000000000000']);
}
await db.exec(fs.readFileSync(process.argv[2], 'utf8'));
const claimed = (await db.query(`select * from claim_due_audiobook_reminders(200)`)).rows;
const ids = claimed.map((r) => r.user_id.slice(-1)).sort().join();
assert(ids === '1,8', `due members claimed: ${ids} (expected 1,8)`);
assert(claimed.every((r) => r.tenant_id === 'cccccccc-0000-0000-0000-000000000000'), 'primary tenant returned');
const md1 = (await db.query(`select metadata from user_guided_journey_state where user_id=$1`, [T + '1'])).rows[0].metadata;
assert(md1.audiobook_reminder.last_sent_local_date === nowUtc.d && md1.audiobook_reminder.time === minus(10), 'claim stamps today and keeps the preference');
const again = (await db.query(`select * from claim_due_audiobook_reminders(200)`)).rows;
assert(again.length === 0, 'a second call the same day claims nobody');
const bad = (await db.query(`select metadata from user_guided_journey_state where user_id=$1`, [T + '6'])).rows[0].metadata;
assert(!bad.audiobook_reminder.last_sent_local_date, 'unknown time zone skipped, not failed');
console.log('ALL CLAIM CHECKS PASSED');
