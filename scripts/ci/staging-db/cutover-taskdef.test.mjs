// VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover): the data-plane switch of a staging task definition
// (scripts/aws/staging-cutover-taskdef.mjs). No AWS call. Fixtures: fixtures/cutover/taskdef-{gateway,postgrest}.json
// have the shape of today's shared staging task definitions.
//   node --test scripts/ci/staging-db/cutover-taskdef.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  transformText, toIsolated, restoreShared, productionEntries, AUTH_UNCHANGED, MARKER, BACKUP, Refused,
} from '../../aws/staging-cutover-taskdef.mjs';
import { scanText } from '../staging-prod-ref-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const FX = path.join(HERE, 'fixtures', 'cutover');
const SM = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:';
const ARNS = {
  database_url: `${SM}vitana/aurora/staging-db/database-url-AbCdEf`,
  authenticator_uri: `${SM}vitana/aurora/staging-db/postgrest-authenticator-uri-GhIjKl`,
};
const ISO_URL = `${SM}vitana/supabase/staging/url-aurora-proxy-iso-MnOpQr`;
const CANDIDATE = 'https://preview-iso-gateway.vitanaland.com';
const gwText = fs.readFileSync(path.join(FX, 'taskdef-gateway.json'), 'utf8');
const pgText = fs.readFileSync(path.join(FX, 'taskdef-postgrest.json'), 'utf8');
const gw = () => JSON.parse(gwText);
const pg = () => JSON.parse(pgText);
const entry = (td, kind, name, c = 0) => (td.containerDefinitions[c][kind] || []).find((e) => e.name === name);
const allEntries = (td) => td.containerDefinitions.flatMap((c) => ['environment', 'secrets'].flatMap((k) => (c[k] || []).map((e) => ({ c: c.name, k, ...e }))));

test('shared: an unmarked task definition passes through byte for byte (gateway, postgrest, compact and pretty)', () => {
  for (const [svc, t] of [['gateway', gwText], ['postgrest', pgText]]) {
    assert.equal(transformText(t, { plane: 'shared', service: svc }), t);
    const compact = JSON.stringify(JSON.parse(t));
    assert.equal(transformText(compact, { plane: 'shared', service: svc }), compact);
  }
});

test('isolated gateway: data-plane secrets move to the staging database, auth entries are unchanged, allocator off', () => {
  const out = toIsolated(gw(), { service: 'gateway', arns: ARNS });
  assert.equal(entry(out, 'secrets', 'AURORA_DATABASE_URL').valueFrom, ARNS.database_url);
  assert.equal(entry(out, 'secrets', 'AURORA_RLS_DATABASE_URL').valueFrom, ARNS.authenticator_uri);
  assert.equal(entry(out, 'secrets', 'SUPABASE_URL').valueFrom, entry(gw(), 'secrets', 'SUPABASE_URL').valueFrom, 'flip keeps the staging proxy URL secret');
  assert.equal(entry(out, 'environment', 'VTID_ALLOCATOR_ENABLED').value, 'false');
  assert.equal(entry(out, 'environment', 'OPERATOR_SQL_READONLY_BACKEND').value, 'supabase');
  assert.equal(entry(out, 'secrets', 'OPERATOR_SQL_READONLY_DATABASE_URL'), undefined);
  for (const n of AUTH_UNCHANGED) {
    for (const k of ['environment', 'secrets']) assert.deepEqual(entry(out, k, n), entry(gw(), k, n), `${n} unchanged`);
  }
  assert.equal(entry(out, 'environment', MARKER).value, 'isolated');
  assert.equal(out.family, 'vitana-gateway');
  assert.equal(out.containerDefinitions[0].image, gw().containerDefinitions[0].image);
  assert.deepEqual(productionEntries(out), []);
});

test('isolated names no production identifier outside the unchanged auth entries (guard scanText, --enforce semantics)', () => {
  for (const [svc, td] of [['gateway', gw()], ['postgrest', pg()]]) {
    const out = toIsolated(td, { service: svc, arns: ARNS });
    const dataPlane = allEntries(out).filter((e) => !AUTH_UNCHANGED.includes(e.name) && e.name !== BACKUP);
    const findings = dataPlane.flatMap((e) => scanText(String(e.value ?? e.valueFrom), 'entry.txt'));
    assert.deepEqual(findings, [], `${svc}: ${JSON.stringify(findings)}`);
    // and the input did name production in exactly those places (the switch is not vacuous)
    const before = allEntries(td).filter((e) => !AUTH_UNCHANGED.includes(e.name)).flatMap((e) => scanText(String(e.value ?? e.valueFrom), 'e.txt'));
    assert.ok(before.length > 0, `${svc} fixture names production on the shared plane`);
  }
});

test('isolated postgrest: PGRST_DB_URI to the staging authenticator, shared writer host removed, JWT and auth host unchanged', () => {
  const out = toIsolated(pg(), { service: 'postgrest', arns: ARNS });
  assert.equal(entry(out, 'secrets', 'PGRST_DB_URI', 1).valueFrom, ARNS.authenticator_uri);
  assert.equal(entry(out, 'environment', 'PGRST_DB_HOST', 1), undefined);
  assert.deepEqual(entry(out, 'secrets', 'PGRST_JWT_SECRET', 1), entry(pg(), 'secrets', 'PGRST_JWT_SECRET', 1));
  assert.deepEqual(entry(out, 'environment', 'SUPABASE_AUTH_HOST', 0), entry(pg(), 'environment', 'SUPABASE_AUTH_HOST', 0));
});

test('round trip: shared(isolated(x)) is x exactly (same JSON text), for both services', () => {
  for (const [svc, t] of [['gateway', gwText], ['postgrest', pgText]]) {
    const iso = transformText(t, { plane: 'isolated', service: svc, arns: ARNS });
    const back = transformText(iso, { plane: 'shared', service: svc });
    assert.equal(back, JSON.stringify(JSON.parse(t)));
  }
});

test('re-deploy while isolated: a shared deploy refresh followed by isolated again stays isolated with one marker', () => {
  const iso = toIsolated(gw(), { service: 'gateway', arns: ARNS });
  // the deploy workflow's own jq step resets AURORA_* to the shared ARNs on every deploy
  const refreshed = JSON.parse(JSON.stringify(iso));
  for (const n of ['AURORA_DATABASE_URL', 'AURORA_RLS_DATABASE_URL']) entry(refreshed, 'secrets', n).valueFrom = entry(gw(), 'secrets', n).valueFrom;
  const again = toIsolated(refreshed, { service: 'gateway', arns: ARNS });
  assert.equal(again.containerDefinitions[0].environment.filter((e) => e.name === MARKER).length, 1);
  assert.equal(entry(again, 'secrets', 'AURORA_DATABASE_URL').valueFrom, ARNS.database_url);
  assert.deepEqual(productionEntries(again), []);
  // and a shared restore of the refreshed one keeps the fresh shared values and removes the allocator override
  const shared = restoreShared(refreshed);
  assert.equal(entry(shared, 'environment', 'VTID_ALLOCATOR_ENABLED'), undefined);
  assert.equal(entry(shared, 'secrets', 'AURORA_DATABASE_URL').valueFrom, entry(gw(), 'secrets', 'AURORA_DATABASE_URL').valueFrom);
  assert.deepEqual(entry(shared, 'secrets', 'OPERATOR_SQL_READONLY_DATABASE_URL'), entry(gw(), 'secrets', 'OPERATOR_SQL_READONLY_DATABASE_URL'));
});

test('candidate (rehearsal): -iso family, candidate URLs, background loops off, merge token dropped, -iso proxy URL', () => {
  const out = toIsolated(gw(), { service: 'gateway', arns: { ...ARNS, supabase_url: ISO_URL }, candidateUrl: CANDIDATE });
  assert.equal(out.family, 'vitana-gateway-iso');
  assert.equal(entry(out, 'environment', 'GATEWAY_URL').value, CANDIDATE);
  assert.equal(entry(out, 'environment', 'GATEWAY_PUBLIC_URL').value, CANDIDATE);
  for (const n of ['AUTOPILOT_HEARTBEAT_ENABLED', 'DEV_AUTOPILOT_WATCHER_LIVE', 'REMINDERS_INPROCESS_DISPATCH_ENABLED', 'FEEDBACK_AUTO_DISPATCH_ENABLED', 'PM_AGENT_ENABLED']) {
    assert.equal(entry(out, 'environment', n).value, 'false', n);
  }
  assert.equal(entry(out, 'secrets', 'GITHUB_SAFE_MERGE_TOKEN'), undefined);
  assert.equal(entry(out, 'secrets', 'SUPABASE_URL').valueFrom, ISO_URL);
  assert.equal(toIsolated(pg(), { service: 'postgrest', arns: ARNS, candidateUrl: CANDIDATE }).family, 'vitana-postgrest-aurora-staging-iso');
});

const refusals = [
  ['a production family', () => toIsolated({ ...gw(), family: 'vitana-gateway-awsdr' }, { service: 'gateway', arns: ARNS }), /production-looking/],
  ['an unknown family', () => toIsolated({ ...gw(), family: 'vitana-orb-agent' }, { service: 'gateway', arns: ARNS }), /not a staging family/],
  ['a production ARN passed as the staging one', () => toIsolated(gw(), { service: 'gateway', arns: { ...ARNS, database_url: `${SM}vitana/aurora/prod/database-url-URDvEh` } }), /not a staging secret ARN/],
  ['a missing ARN', () => toIsolated(gw(), { service: 'gateway', arns: { database_url: ARNS.database_url } }), /missing --arn authenticator_uri/],
  ['an unknown production-bound entry', () => { const t = gw(); t.containerDefinitions[0].secrets.push({ name: 'LEGACY_DB', valueFrom: `${SM}vitana/aurora/prod/legacy-AaBbCc` }); return toIsolated(t, { service: 'gateway', arns: ARNS }); }, /still names production: gateway\.secrets\.LEGACY_DB/],
  ['SUPABASE_URL not the staging proxy', () => { const t = gw(); entry(t, 'secrets', 'SUPABASE_URL').valueFrom = `${SM}vitana/supabase/staging/url-I9rciI`; return toIsolated(t, { service: 'gateway', arns: ARNS }); }, /not the staging PostgREST proxy URL secret/],
  ['no SUPABASE_PUBLIC_URL (sign-in path)', () => { const t = gw(); t.containerDefinitions[0].environment = t.containerDefinitions[0].environment.filter((e) => e.name !== 'SUPABASE_PUBLIC_URL'); return toIsolated(t, { service: 'gateway', arns: ARNS }); }, /SUPABASE_PUBLIC_URL is not set/],
  ['the -iso proxy URL on the live flip', () => toIsolated(gw(), { service: 'gateway', arns: { ...ARNS, supabase_url: ISO_URL } }), /candidate only/],
  ['a candidate without the -iso proxy URL', () => toIsolated(gw(), { service: 'gateway', arns: ARNS, candidateUrl: CANDIDATE }), /a candidate must use the -iso proxy URL secret|not the staging PostgREST proxy URL secret/],
  ['a candidate URL that is the live staging host', () => toIsolated(pg(), { service: 'postgrest', arns: ARNS, candidateUrl: 'https://preview-aws-gateway.vitanaland.com' }), /preview-iso/],
  ['an unknown plane value', () => transformText(gwText, { plane: 'isloated', service: 'gateway' }), /shared or isolated/],
  ['an unknown service', () => transformText(gwText, { plane: 'shared', service: 'orb-agent' }), /unknown service/],
  ['a marker without backup (shared restore)', () => { const t = gw(); t.containerDefinitions[0].environment.push({ name: MARKER, value: 'isolated' }); return restoreShared(t); }, /without STAGING_DATA_PLANE_SHARED/],
];
for (const [name, fn, re] of refusals) {
  test(`refuses ${name}`, () => assert.throws(fn, (e) => e instanceof Refused && re.test(e.message)));
}

test('CLI: exit 2 and nothing on stdout when refused; exit 0 and the same bytes on shared', () => {
  const cli = path.join(ROOT, 'scripts/aws/staging-cutover-taskdef.mjs');
  const bad = spawnSync('node', [cli, '--plane', 'isolated', '--service', 'gateway'], { input: gwText, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  const ok = spawnSync('node', [cli, '--plane', 'shared', '--service', 'gateway'], { input: gwText, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, gwText);
});
