#!/usr/bin/env node
// VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover; design.md §3, §8): the one place an ECS task
// definition of the STAGING gateway or STAGING PostgREST proxy is switched between the shared data plane (today) and the
// isolated staging data plane (vitana-aurora-staging).
//
//   node scripts/aws/staging-cutover-taskdef.mjs --plane shared|isolated --service gateway|postgrest \
//        [--arn database_url=<arn>] [--arn authenticator_uri=<arn>] [--arn supabase_url=<arn>] \
//        [--candidate-url https://preview-iso-…] < in.json > out.json
//
// shared   An input WITHOUT the plane marker is written back byte for byte (every deploy today). An input WITH the marker
//          (it was switched to isolated) is restored: every entry the isolated switch changed, added or removed is put
//          back exactly as it was, unless a later shared deploy already refreshed it.
// isolated The data-plane references move to the staging database: gateway AURORA_DATABASE_URL, AURORA_RLS_DATABASE_URL
//          and SUPABASE_URL (the PostgREST proxy URL); PostgREST PGRST_DB_URI. Direct production database URLs without a
//          staging twin are removed. The gateway gets VTID_ALLOCATOR_ENABLED=false (one ledger: design.md §9).
//          Authentication is NOT changed (owner directive 2026-11-12): the entries of AUTH_UNCHANGED keep the production
//          Supabase GoTrue issuer. Every other entry is checked with the staging production-reference guard; any
//          remaining production identifier refuses the switch (exit 2). Unknown production-bound entries are refused,
//          never guessed.
// --candidate-url  Rehearsal only: the output family becomes the -iso candidate family, GATEWAY_URL/GATEWAY_PUBLIC_URL
//          point at the candidate host, the background loops are off and the GitHub merge token is dropped, so the
//          candidate can never act on GitHub or on members.
//
// Exit codes: 0 ok, 2 refused / usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '../ci/staging-prod-ref-guard.mjs';

export const MARKER = 'STAGING_DATA_PLANE';
export const BACKUP = 'STAGING_DATA_PLANE_SHARED';
const SM = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:';
const SUFFIX = '-[A-Za-z0-9]{6}';

/** Entries that carry the unchanged authentication path (production GoTrue issuer, design.md §3). Never switched. */
export const AUTH_UNCHANGED = Object.freeze([
  'SUPABASE_JWT_SECRET', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE_KEY',
  'GATEWAY_SERVICE_TOKEN', 'SUPABASE_PUBLIC_URL', 'SUPABASE_AUTH_HOST', 'PGRST_JWT_SECRET',
]);

/** Staging-only secret ARNs each switched reference may point at. */
export const ARN_PATTERNS = Object.freeze({
  database_url: new RegExp(`^${SM}vitana/aurora/staging-db/database-url${SUFFIX}$`),
  authenticator_uri: new RegExp(`^${SM}vitana/aurora/staging-db/postgrest-authenticator-uri${SUFFIX}$`),
  supabase_url: new RegExp(`^${SM}vitana/supabase/staging/url-aurora-proxy(-iso)?${SUFFIX}$`),
});

export const SERVICES = Object.freeze({
  gateway: {
    families: ['vitana-gateway', 'vitana-gateway-iso'],
    candidateFamily: 'vitana-gateway-iso',
    secrets: { AURORA_DATABASE_URL: 'database_url', AURORA_RLS_DATABASE_URL: 'authenticator_uri', SUPABASE_URL: 'supabase_url' },
    // Present only on the shared plane; no staging twin. OPERATOR_SQL_READONLY falls back to the REST path (supabase).
    removeSecrets: ['OPERATOR_SQL_READONLY_DATABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL', 'SUPABASE_DATABASE_URL'],
    removeEnv: [],
    env: { VTID_ALLOCATOR_ENABLED: 'false', OPERATOR_SQL_READONLY_BACKEND: 'supabase' },
    requireEnv: ['SUPABASE_PUBLIC_URL'],
    candidateEnv: {
      AUTOPILOT_HEARTBEAT_ENABLED: 'false', DEV_AUTOPILOT_WATCHER_LIVE: 'false', REMINDERS_INPROCESS_DISPATCH_ENABLED: 'false',
      REMINDERS_STAGING_DISPATCH_OVERRIDE: 'false', CALENDAR_MAINTENANCE_ENABLED: 'false', CALENDAR_GOOGLE_SYNC_ENABLED: 'false',
      FEEDBACK_AUTO_DISPATCH_ENABLED: 'false', PM_AGENT_ENABLED: 'false', AUTOMATIONS_DELIVERY_MODE: 'shadow',
    },
    candidateUrlEnv: ['GATEWAY_URL', 'GATEWAY_PUBLIC_URL'],
    candidateRemoveSecrets: ['GITHUB_SAFE_MERGE_TOKEN'],
  },
  postgrest: {
    families: ['vitana-postgrest-aurora-staging', 'vitana-postgrest-aurora-staging-iso'],
    candidateFamily: 'vitana-postgrest-aurora-staging-iso',
    secrets: { PGRST_DB_URI: 'authenticator_uri' },
    removeSecrets: [],
    // The URI carries the host; PostgREST reads only PGRST_DB_URI. The host env is the shared writer.
    removeEnv: ['PGRST_DB_HOST'],
    env: {},
    requireEnv: [],
    candidateEnv: {},
    candidateUrlEnv: [],
    candidateRemoveSecrets: [],
  },
});

export class Refused extends Error {}
const refuse = (m) => { throw new Refused(m); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const dec = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const KIND_VALUE = { environment: 'value', secrets: 'valueFrom' };

function checkFamily(td, svc) {
  const fam = String(td.family || '');
  if (/awsdr|prod/i.test(fam)) refuse(`refusing task-definition family '${fam}': production-looking name`);
  if (!svc.families.includes(fam)) refuse(`task-definition family '${fam}' is not a staging family of this service (${svc.families.join(', ')})`);
}

const findMarker = (td) => {
  for (const c of td.containerDefinitions || []) {
    const m = (c.environment || []).find((e) => e.name === MARKER);
    const b = (c.environment || []).find((e) => e.name === BACKUP);
    if (m) return { container: c, marker: m.value, backup: b ? b.value : null };
  }
  return null;
};

/** Restore a marked task definition to the shared plane. Unmarked input: returned unchanged (same object). */
export function restoreShared(td) {
  const mk = findMarker(td);
  if (!mk) return td;
  if (!mk.backup) refuse(`${MARKER} marker without ${BACKUP}: cannot restore exactly; roll back to the recorded revision`);
  const out = clone(td);
  let bk;
  try { bk = dec(mk.backup); } catch { refuse(`${BACKUP} is not readable: roll back to the recorded revision`); }
  if (!bk || bk.v !== 1 || !Array.isArray(bk.ops)) refuse(`${BACKUP} has an unknown format: roll back to the recorded revision`);
  for (const c of out.containerDefinitions) {
    if (c.environment) c.environment = c.environment.filter((e) => e.name !== MARKER && e.name !== BACKUP);
  }
  for (const op of [...bk.ops].reverse()) {
    const c = out.containerDefinitions.find((x) => x.name === op.container);
    if (!c) continue;
    const list = (c[op.kind] = c[op.kind] || []);
    const i = list.findIndex((e) => e.name === op.name);
    if (op.after === null) { // removed by the switch: put back where it was, unless a later deploy re-added it
      if (i < 0 && op.before) list.splice(Math.min(op.index, list.length), 0, op.before);
    } else if (i >= 0 && eq(list[i], op.after)) { // still the value the switch set: put the shared one back
      if (op.before === null) list.splice(i, 1);
      else list[i] = op.before;
    } // else: a later shared deploy refreshed it; keep the fresh value
  }
  for (const c of out.containerDefinitions) {
    for (const k of bk.absent?.[c.name] || []) if (Array.isArray(c[k]) && c[k].length === 0) delete c[k];
  }
  return out;
}

/** Every entry that still names a production identifier, outside AUTH_UNCHANGED and the backup. */
export function productionEntries(td) {
  const out = [];
  for (const c of td.containerDefinitions || []) {
    for (const kind of ['environment', 'secrets']) {
      for (const e of c[kind] || []) {
        if (AUTH_UNCHANGED.includes(e.name) || e.name === BACKUP) continue;
        const v = String(e[KIND_VALUE[kind]] ?? '');
        const f = scanText(v, 'entry.txt');
        if (f.length) out.push({ container: c.name, kind, name: e.name, ids: [...new Set(f.map((x) => x.id))] });
      }
    }
  }
  return out;
}

/** Switch a task definition to the isolated staging data plane. */
export function toIsolated(input, { service, arns = {}, candidateUrl = null } = {}) {
  const svc = SERVICES[service];
  if (!svc) refuse(`unknown service '${service}' (gateway|postgrest)`);
  checkFamily(input, svc);
  const restored = restoreShared(input);
  const td = restored === input ? clone(input) : restored;
  const ops = [];
  const containers = td.containerDefinitions || [];
  if (!containers.length) refuse('task definition has no containers');
  const absent = {};
  for (const c of containers) absent[c.name] = ['environment', 'secrets'].filter((k) => !Array.isArray(c[k]));

  const set = (c, kind, name, entry) => {
    const list = (c[kind] = c[kind] || []);
    const i = list.findIndex((e) => e.name === name);
    const before = i >= 0 ? list[i] : null;
    if (before && eq(before, entry)) return;
    if (i >= 0) list[i] = entry; else list.push(entry);
    ops.push({ container: c.name, kind, name, index: i >= 0 ? i : list.length - 1, before, after: entry });
  };
  const remove = (c, kind, name) => {
    const list = c[kind] || [];
    const i = list.findIndex((e) => e.name === name);
    if (i < 0) return;
    ops.push({ container: c.name, kind, name, index: i, before: list[i], after: null });
    list.splice(i, 1);
  };

  for (const [name, key] of Object.entries(svc.secrets)) {
    const holders = containers.filter((c) => (c.secrets || []).some((e) => e.name === name));
    let arn = arns[key];
    if (!arn && key === 'supabase_url') {
      // Flip: keep the proxy URL secret if it already is the staging proxy (the proxy itself moves to staging data).
      const cur = holders.length ? holders[0].secrets.find((e) => e.name === name).valueFrom : '';
      if (ARN_PATTERNS.supabase_url.test(cur) && !/-iso-/.test(cur)) arn = cur;
      else refuse(`${name} is '${cur || '(absent)'}', not the staging PostgREST proxy URL secret; the isolated plane needs the proxy (dispatch data_backend=aurora on the shared plane first, or pass --arn supabase_url=…)`);
    }
    if (!arn) refuse(`missing --arn ${key}=<arn> for ${name}`);
    if (!ARN_PATTERNS[key].test(arn)) refuse(`--arn ${key} '${arn}' is not a staging secret ARN (${ARN_PATTERNS[key]})`);
    if (key === 'supabase_url' && candidateUrl && !/url-aurora-proxy-iso-/.test(arn)) refuse('a candidate must use the -iso proxy URL secret');
    if (key === 'supabase_url' && !candidateUrl && /url-aurora-proxy-iso-/.test(arn)) refuse('the -iso proxy URL secret is for the candidate only');
    if (!holders.length) refuse(`no container carries ${name}; refusing to guess where the data plane is wired`);
    for (const c of holders) set(c, 'secrets', name, { name, valueFrom: arn });
  }
  for (const c of containers) {
    for (const n of svc.removeSecrets) remove(c, 'secrets', n);
    for (const n of svc.removeEnv) remove(c, 'environment', n);
  }
  const main = containers.find((c) => (c.secrets || []).some((e) => Object.keys(svc.secrets).includes(e.name))) || containers[0];
  for (const n of svc.requireEnv) {
    if (!(main.environment || []).some((e) => e.name === n)) refuse(`${n} is not set on '${main.name}': the unchanged sign-in path needs it (shared plane on data_backend=aurora first)`);
  }
  for (const [n, v] of Object.entries(svc.env)) set(main, 'environment', n, { name: n, value: v });

  if (candidateUrl) {
    if (!/^https:\/\/preview-iso-[a-z0-9.-]+$/.test(candidateUrl)) refuse(`candidate URL '${candidateUrl}' must be https://preview-iso-…`);
    td.family = svc.candidateFamily;
    for (const [n, v] of Object.entries(svc.candidateEnv)) set(main, 'environment', n, { name: n, value: v });
    for (const n of svc.candidateUrlEnv) set(main, 'environment', n, { name: n, value: candidateUrl });
    for (const c of containers) for (const n of svc.candidateRemoveSecrets) remove(c, 'secrets', n);
  }

  const left = productionEntries(td);
  if (left.length) {
    refuse(`isolated plane still names production: ${left.map((e) => `${e.container}.${e.kind}.${e.name} (${e.ids.join(',')})`).join('; ')}`);
  }
  main.environment = main.environment || [];
  main.environment.push({ name: MARKER, value: 'isolated' }, { name: BACKUP, value: enc({ v: 1, ops, absent }) });
  return td;
}

/** stdin text -> stdout text. shared + unmarked = the input text itself, byte for byte. */
export function transformText(text, { plane, service, arns, candidateUrl }) {
  if (plane !== 'shared' && plane !== 'isolated') refuse(`STAGING_DATA_PLANE must be shared or isolated, got '${plane}'`);
  let td;
  try { td = JSON.parse(text); } catch { refuse('input is not a task-definition JSON'); }
  if (plane === 'shared') {
    const svc = SERVICES[service];
    if (!svc) refuse(`unknown service '${service}' (gateway|postgrest)`);
    if (!findMarker(td)) return text;
    checkFamily(td, svc);
    return JSON.stringify(restoreShared(td));
  }
  if (candidateUrl === undefined) candidateUrl = null;
  return JSON.stringify(toIsolated(td, { service, arns, candidateUrl }));
}

export function parseArgs(argv) {
  const a = { plane: null, service: null, arns: {}, candidateUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--plane') a.plane = argv[++i];
    else if (x === '--service') a.service = argv[++i];
    else if (x === '--candidate-url') a.candidateUrl = argv[++i];
    else if (x === '--arn') { const [k, ...v] = String(argv[++i] || '').split('='); if (!ARN_PATTERNS[k]) throw new Refused(`unknown --arn key '${k}'`); a.arns[k] = v.join('='); }
    else throw new Refused(`unknown argument: ${x}`);
  }
  if (!a.plane || !a.service) throw new Refused('--plane and --service are required');
  return a;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.stdout.write(transformText(fs.readFileSync(0, 'utf8'), args));
  } catch (e) {
    process.stderr.write(`staging-cutover-taskdef: REFUSED: ${e.message}\n`);
    process.exitCode = 2;
  }
}
