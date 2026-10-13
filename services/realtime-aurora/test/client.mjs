// realtime-js client for services/realtime-aurora/test/local-delivery.sh
// (VTID-05023, plan part 7a). Connects the way the app will — RealtimeClient
// on wss://realtime.vitanaland.com/socket — but over plain ws to the local
// container, with the Host header set to the production host so the server
// derives the tenant exactly as it will behind the ALB.
//
// Env: RT_URL (ws://127.0.0.1:<port>/socket), RT_HOST (realtime.vitanaland.com),
//      TENANT_JWT_SECRET, USER_A, USER_B, PSQL (JSON array: command that runs
//      one SQL statement as the master user), MODE (full | changes).
// Exit 0 only when every assertion holds.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { RealtimeClient } from '@supabase/realtime-js';
import WS from 'ws';

const { RT_URL, RT_HOST, TENANT_JWT_SECRET, USER_A, USER_B } = process.env;
const PSQL = JSON.parse(process.env.PSQL);
const MODE = process.env.MODE || 'full';

const b64u = (b) => Buffer.from(b).toString('base64url');
function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iat: now, exp: now + 3600, iss: 'supabase', ...claims }));
  const s = crypto.createHmac('sha256', TENANT_JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
const anonKey = jwt({ role: 'anon' });
const userAToken = jwt({ role: 'authenticated', sub: USER_A, aud: 'authenticated' });

class HostWS extends WS {
  constructor(url, protocols) {
    super(url, protocols, { headers: { host: RT_HOST } });
  }
}

const sql = (stmt) => execFileSync(PSQL[0], [...PSQL.slice(1), stmt], { stdio: ['ignore', 'pipe', 'inherit'] });
const fail = (msg) => { console.error(`FAIL ${msg}`); process.exit(1); };
const pass = (msg) => console.log(`PASS ${msg}`);
const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms));

// The join reply (SUBSCRIBED) comes before the server has registered the
// postgres_changes subscription in realtime.subscription; the server then
// sends a system message {extension: 'postgres_changes', status: 'ok'}.
// Rows written before that message are not delivered (on Supabase too), so
// wait for it before writing.
function changesReady(channel, what) {
  return Promise.race([
    new Promise((resolve, reject) => {
      channel.on('system', {}, (msg) => {
        if (msg?.extension !== 'postgres_changes') return;
        if (msg.status === 'ok') resolve(msg);
        else console.error(`   ${what}: system message ${JSON.stringify(msg)} (server retries)`);
      });
    }),
    timeout(45000, `${what} postgres_changes ready (system ok)`),
  ]);
}

function subscribed(channel, what) {
  return Promise.race([
    new Promise((resolve, reject) => {
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          reject(new Error(`${what}: ${status} ${err ? err.message || err : ''}`));
        }
      });
    }),
    timeout(30000, `${what} SUBSCRIBED`),
  ]);
}

const client = new RealtimeClient(RT_URL, { params: { apikey: anonKey }, transport: HostWS });
await client.setAuth(userAToken);

try {
  // 1. postgres_changes, RLS-filtered: user A must get A's row and never B's.
  const got = [];
  let resolveA;
  const gotA = new Promise((r) => { resolveA = r; });
  const changes = client
    .channel('probe-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'realtime_probe' }, (payload) => {
      got.push(payload);
      if (payload.new?.body === 'for-a') resolveA(payload);
    });
  const changesOk = changesReady(changes, 'postgres_changes channel');
  await subscribed(changes, 'postgres_changes channel');
  pass('postgres_changes channel SUBSCRIBED (tenant from Host header, member JWT accepted)');
  const sys = await changesOk;
  pass(`postgres_changes subscription registered (system: ${sys.message})`);
  sql(`insert into public.realtime_probe (user_id, body) values ('${USER_B}', 'for-b')`);
  sql(`insert into public.realtime_probe (user_id, body) values ('${USER_A}', 'for-a')`);
  const evt = await Promise.race([gotA, timeout(20000, 'INSERT event for user A')]);
  if (evt.eventType !== 'INSERT' || evt.schema !== 'public' || evt.table !== 'realtime_probe') {
    fail(`unexpected event shape ${JSON.stringify(evt)}`);
  }
  if (evt.new.user_id !== USER_A) fail(`event row user_id ${evt.new.user_id}, want ${USER_A}`);
  pass(`INSERT delivered to the subscriber (commit_timestamp ${evt.commit_timestamp})`);
  await new Promise((r) => setTimeout(r, 2000));
  if (got.some((p) => p.new?.body === 'for-b')) fail("RLS: user A received user B's row");
  pass("RLS: user A did not receive user B's row");

  if (MODE === 'full') {
    // 2. UPDATE carries the old row (REPLICA IDENTITY FULL, as on Supabase).
    let resolveU;
    const gotU = new Promise((r) => { resolveU = r; });
    const upd = client
      .channel('probe-updates')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'realtime_probe' }, (p) => resolveU(p));
    const updOk = changesReady(upd, 'UPDATE channel');
    await subscribed(upd, 'UPDATE channel');
    await updOk;
    sql(`update public.realtime_probe set body = 'for-a-2' where body = 'for-a'`);
    const u = await Promise.race([gotU, timeout(20000, 'UPDATE event')]);
    if (u.new?.body !== 'for-a-2' || u.old?.body !== 'for-a') fail(`UPDATE payload ${JSON.stringify(u)}`);
    pass('UPDATE delivered with old and new row (REPLICA IDENTITY FULL)');

    // 3. Broadcast on the same server (call signalling, typing indicators).
    let resolveB;
    const gotB = new Promise((r) => { resolveB = r; });
    const bc = client
      .channel('probe-broadcast', { config: { broadcast: { self: true, ack: true } } })
      .on('broadcast', { event: 'ping' }, (m) => resolveB(m));
    await subscribed(bc, 'broadcast channel');
    const ack = await bc.send({ type: 'broadcast', event: 'ping', payload: { n: 1 } });
    if (ack !== 'ok') fail(`broadcast ack ${ack}`);
    const m = await Promise.race([gotB, timeout(10000, 'broadcast echo')]);
    if (m.payload?.n !== 1) fail(`broadcast payload ${JSON.stringify(m)}`);
    pass('broadcast round trip (ack + self echo)');

    // 4. Presence.
    let resolveP;
    const gotP = new Promise((r) => { resolveP = r; });
    const pr = client.channel('probe-presence', { config: { presence: { key: USER_A } } });
    pr.on('presence', { event: 'sync' }, () => {
      const state = pr.presenceState();
      if (state[USER_A]?.length) resolveP(state);
    });
    await subscribed(pr, 'presence channel');
    await pr.track({ online_at: new Date().toISOString() });
    await Promise.race([gotP, timeout(10000, 'presence sync')]);
    pass('presence track + sync');
  }
} catch (e) {
  fail(e.message);
} finally {
  await client.removeAllChannels().catch(() => {});
  client.disconnect();
}
process.exit(0);
