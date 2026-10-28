// VTID-04864 — claim_invite_reward() against an in-memory Postgres (PGlite).
// Usage: node pglite-claim-invite-check.mjs <migration.sql>
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE referrals (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, referrer_id uuid not null,
  referred_id uuid, status text not null default 'created', reward_amount integer, rewarded_at timestamptz);
`);
await db.exec(fs.readFileSync(process.argv[2], 'utf8'));
const INV = '11111111-1111-4111-8111-111111111111', T = '22222222-2222-4222-8222-222222222222';
const claim = async (id, now = new Date().toISOString(), inviter = INV) =>
  (await db.query(`select claim_invite_reward($1,$2,1000,10,30,$3) r`, [id, inviter, now])).rows[0].r;
const add = async (status, rewardedAt = null) =>
  (await db.query(`insert into referrals(tenant_id,referrer_id,status,rewarded_at) values ($1,$2,$3,$4) returning id`, [T, INV, status, rewardedAt])).rows[0].id;

const a = await add('signed_up');
const r1 = await claim(a);
assert(r1.ok && r1.claimed === true, 'a signed_up referral is claimed');
const row = (await db.query(`select status, reward_amount from referrals where id=$1`, [a])).rows[0];
assert(row.status === 'rewarded' && row.reward_amount === 1000, 'status rewarded, amount 1000');
assert((await claim(a)).claimed === false && (await claim(a)).reason === 'already_rewarded', 'the same referral is never claimed twice');

const other = await add('signed_up');
assert((await claim(other, new Date().toISOString(), '33333333-3333-4333-8333-333333333333')).claimed === false, 'another inviter cannot claim this referral');

for (let i = 0; i < 9; i++) await add('rewarded', new Date().toISOString()); // 1 + 9 = 10 in window
const capped = await add('signed_up');
const r2 = await claim(capped);
assert(r2.claimed === false && r2.reason === 'monthly_cap', 'the 11th in 30 days hits the cap');
assert((await db.query(`select status from referrals where id=$1`, [capped])).rows[0].status === 'signed_up', 'a capped referral stays signed_up');

const later = new Date(Date.now() + 31 * 86_400_000).toISOString();
assert((await claim(capped, later)).claimed === true, 'after the 30-day window it can be claimed');
console.log('ALL CLAIM_INVITE_REWARD CHECKS PASSED');
