// VTID-05803: the Aurora staging acceptance runner (scripts/aws/staging-acceptance/k5.py) and its CI job file
// (infra/gitlab-engineering/ci/vtid-05803-acceptance.gitlab-ci.yml). Hermetic: a fake psql answers the runner's queries
// and a fake aws records the evidence upload; no database, AWS call or network. Needs node, python3 and tar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const K5 = path.join(ROOT, 'scripts/aws/staging-acceptance/k5.py');
const EMBED = path.join(ROOT, 'scripts/aws/staging-acceptance/embed.py');
const JOB = path.join(ROOT, 'infra/gitlab-engineering/ci/vtid-05803-acceptance.gitlab-ci.yml');
const PW = 'S3cr@t:pw#/1';

// Catalog rows of a faithful restore: the staging side adds only what the package defines (outbox, owner-implicit grants).
const A07_SOURCE = ['table|orders|kind=r;cols=3', 'index|orders_status_idx|def=CREATE INDEX x;valid=true', 'function|order_total(p bigint)|src=aa',
  'owner|relation:orders|owner=postgres', 'grant|orders.authenticated.SELECT|grantable=false', 'fk|orders.orders_user_fkey|ref=auth.users;def=x'];
const A07_STAGING = ['table|orders|kind=r;cols=3', 'index|orders_status_idx|def=CREATE INDEX x;valid=true', 'function|order_total(p bigint)|src=aa',
  'owner|relation:orders|owner=postgres', 'grant|orders.authenticated.SELECT|grantable=false', 'table|outbound_http_requests|kind=r;cols=3'];
const A08 = ['rls|orders|rowsecurity=t;force=f', 'policy|orders.own|cmd=r;permissive=t;roles={authenticated}', 'table_grant|orders:authenticated|SELECT'];

const FAKE_PSQL = `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2); const e = process.env;
fs.appendFileSync(e.FAKE_LOG, JSON.stringify({ argv: a, host: e.PGHOST, port: e.PGPORT, user: e.PGUSER }) + '\\n');
if (a[0] !== '-X' || a.indexOf('SET SESSION default_transaction_read_only = on') < 0) { process.stderr.write('psql: session not forced read-only'); process.exit(9); }
const side = e.PGPORT === '5001' ? 'SOURCE' : 'STAGING';
if (e['FAKE_DOWN_' + side]) { process.stderr.write('psql: error: connection to server at "' + e.PGHOST + '" failed: Connection refused'); process.exit(2); }
const f = a[a.indexOf('-f') + 1] || ''; const c = a.lastIndexOf('-c') > 0 ? a[a.lastIndexOf('-c') + 1] : '';
const out = (rows) => process.stdout.write(rows.join('\\n') + '\\n');
if (/server_version/.test(c)) out(['17.5|' + (e['FAKE_RO_' + side] || 'on') + '|' + (e['FAKE_TABLES_' + side] || '700')]);
else if (/pg_roles/.test(c)) out(['postgres', 'anon', 'authenticated', 'service_role']);
else if (/A07/.test(f)) out(JSON.parse(e['FAKE_A07_' + side]));
else if (/A08/.test(f)) out(JSON.parse(e['FAKE_A08_' + side]));
else if (/A09/.test(f)) out(JSON.parse(e.FAKE_A09));
else { process.stderr.write('fake psql: unexpected ' + JSON.stringify(a)); process.exit(3); }
`;
const FAKE_AWS = `#!/bin/sh
[ "\${FAKE_S3_FAIL:-0}" = 1 ] && { echo "upload failed: AccessDenied" >&2; exit 1; }
for x in "$@"; do last2="$last1"; last1="$x"; done
mkdir -p "$FAKE_S3/out" && cp -r "$last2"/. "$FAKE_S3/out/"
`;

function world() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'k5-acceptance-'));
  const bin = path.join(w, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'psql'), FAKE_PSQL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'aws'), FAKE_AWS, { mode: 0o755 });
  const pkg = path.join(w, 'pkg'); fs.mkdirSync(pkg);
  const sums = [];
  for (const n of ['A07-object-parity-suite.sql', 'A08-rls-grants-extensions.sql', 'A09-migration-acceptance-suite.sql']) {
    const body = `-- ${n}\nSELECT 1;\n`; fs.writeFileSync(path.join(pkg, n), body);
    sums.push(`${crypto.createHash('sha256').update(body).digest('hex')}  ${n}`);
  }
  fs.writeFileSync(path.join(pkg, 'SHA256SUMS'), sums.join('\n') + '\n');
  const work = path.join(w, 'work'); fs.mkdirSync(work);
  execFileSync('tar', ['-czf', path.join(work, 'a.tgz'), '-C', pkg, '.']);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(work, 'a.tgz'))).digest('hex');
  return { w, bin, work, sha, s3: path.join(w, 's3'), log: path.join(w, 'psql.log') };
}

function run(extra = {}) {
  const x = world();
  const env = {
    PATH: `${x.bin}:${process.env.PATH}`, HOME: x.w, K5_TEST: '1', K5_W: x.work, K5_SSLMODE: 'disable', K5_DB: 'vitana', K5_RUN: 'test',
    ACCEPT_S3_URI: 's3://unused/a.tgz', ACCEPT_SHA256: x.sha, FAKE_LOG: x.log, FAKE_S3: x.s3,
    SOURCE_URI: `postgresql://postgres:${PW}@127.0.0.1:5001/postgres`, PGHOST: '127.0.0.1', PGPORT: '5002', PGUSER: 'master', PGPASSWORD: PW,
    FAKE_A07_SOURCE: JSON.stringify(A07_SOURCE), FAKE_A07_STAGING: JSON.stringify(A07_STAGING),
    FAKE_A08_SOURCE: JSON.stringify(A08), FAKE_A08_STAGING: JSON.stringify(A08),
    FAKE_A09: JSON.stringify(['chk|staging|has_rows|public.*|rows=0|PASS', 'A09|staging|GATE|PASS|clean']),
    ...extra,
  };
  const r = spawnSync('python3', [K5], { env, encoding: 'utf8' });
  const files = fs.existsSync(path.join(x.work, 'out')) ? fs.readdirSync(path.join(x.work, 'out')) : [];
  const text = [r.stdout, r.stderr, ...files.map((f) => fs.readFileSync(path.join(x.work, 'out', f), 'utf8'))].join('\n');
  const psqlCalls = fs.existsSync(x.log) ? fs.readFileSync(x.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const report = fs.existsSync(path.join(x.work, 'out', 'report.json')) ? JSON.parse(fs.readFileSync(path.join(x.work, 'out', 'report.json'), 'utf8')) : null;
  return { status: r.status, text, psqlCalls, report, uploaded: fs.existsSync(path.join(x.s3, 'out', 'report.json')) };
}

test('a faithful restore is accepted: exit 0, every session forced read-only, the password never on argv or in any output', () => {
  const r = run({ K5_OUT: 's3://bucket/runs/test' });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.report.result, 'ACCEPTED');
  assert.deepEqual(r.report.verdict, { A07: true, A08: true, A09: true });
  assert.ok(r.uploaded, 'evidence uploaded');
  assert.ok(r.psqlCalls.length >= 7, `psql calls: ${r.psqlCalls.length}`);
  for (const c of r.psqlCalls) assert.ok(!JSON.stringify(c.argv).includes(PW) && !JSON.stringify(c.argv).includes('postgresql://'), `argv carries a credential: ${JSON.stringify(c.argv)}`);
  assert.ok(!r.text.includes(PW), 'password printed or stored');
  assert.ok(!r.text.includes('pw#/1'), 'password tail printed or stored');
  assert.equal(r.psqlCalls.find((c) => c.port === '5001').user, 'postgres', 'source user parsed from a URI whose password holds @ : # /');
});

test('an unexplained difference rejects: container exit 11-17 names the failing suites (job exit 1)', () => {
  const missingIndex = JSON.stringify(A07_STAGING.filter((l) => !l.startsWith('index|')));
  const r = run({ FAKE_A07_STAGING: missingIndex });
  assert.equal(r.status, 11, r.text);
  assert.equal(r.report.result, 'REJECTED');
  assert.deepEqual(r.report.verdict, { A07: false, A08: true, A09: true });
  const lostGrant = JSON.stringify(A08.filter((l) => !l.startsWith('table_grant|')));
  assert.equal(run({ FAKE_A08_STAGING: lostGrant }).status, 12);
  assert.equal(run({ FAKE_A09: JSON.stringify(['chk|staging|has_rows|public.orders|rows=3|FAIL', 'A09|staging|GATE|FAIL|1']) }).status, 14);
  assert.equal(run({ FAKE_A07_STAGING: missingIndex, FAKE_A08_STAGING: lostGrant }).status, 13);
});

test('a session that reports read_only=off is refused before any catalog query (46 source, 56 staging)', () => {
  for (const [side, code] of [['SOURCE', 46], ['STAGING', 56]]) {
    const r = run({ [`FAKE_RO_${side}`]: 'off' });
    assert.equal(r.status, code, r.text);
    assert.ok(!r.psqlCalls.some((c) => c.argv.includes('-f')), 'a catalog file ran after the refusal');
  }
});

test('configuration and infrastructure errors are never a pass: missing secret 30, prod host 33, connection 42/52, package 60', () => {
  assert.equal(run({ SOURCE_URI: '' }).status, 30);
  assert.equal(run({ PGHOST: 'vitana-aurora-prod.cluster-x.eu-central-1.rds.amazonaws.com' }).status, 33);
  assert.equal(run({ FAKE_DOWN_SOURCE: '1' }).status, 42);
  assert.equal(run({ FAKE_DOWN_STAGING: '1' }).status, 52);
  assert.equal(run({ ACCEPT_SHA256: '0'.repeat(64) }).status, 60);
});

test('an evidence upload failure turns a pass into 80 and keeps a failure a failure (111-117)', () => {
  const pass = run({ K5_OUT: 's3://bucket/runs/test', FAKE_S3_FAIL: '1' });
  assert.equal(pass.status, 80, pass.text);
  assert.equal(pass.report.result, 'ACCEPTED', 'report.json is written before the upload is attempted');
  const fail = run({ K5_OUT: 's3://bucket/runs/test', FAKE_S3_FAIL: '1', FAKE_A07_STAGING: JSON.stringify(A07_STAGING.slice(1)) });
  assert.equal(fail.status, 111, fail.text);
});

test('the job file embeds exactly k5.py and the ECS override stays under 8192 bytes', () => {
  const r = spawnSync('python3', [EMBED, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the job maps only container exit 0 to a pass, and auto runs only on a reported staging load', () => {
  const job = fs.readFileSync(JOB, 'utf8');
  const run = job.slice(job.indexOf('\nvtid-05803-acceptance-run:'));
  assert.ok(run.length > 1000, 'run job present');
  assert.equal((run.match(/fin 0 /g) || []).length, 1, 'exactly one path reports a pass');
  assert.match(run, /\n {8}0\) fin 0 "acceptance passed/);
  assert.match(run, /\n {8}1\|11\|12\|13\|14\|15\|16\|17\) /);
  assert.match(run, /\n {8}""\) fin 2 "no container exit code/);
  assert.match(run, /\n {8}\*\) fin 2 /);
  assert.match(run, /\[ "\$ST" = STOPPED \] \|\| fin 2/);
  // GitLab accepts allow_failure: exit_codes only at job level (inside rules: only a boolean); a rule-level map made every
  // vitana-platform pipeline config invalid after the 01:15Z sync.
  assert.match(run, /^ {2}allow_failure:\n {4}exit_codes: \[3\]$/m);
  assert.ok(!/^ {6}allow_failure:/m.test(run), 'no rule-level allow_failure');
  assert.match(run, /vtid-05803-staging-load\/latest\/marker\.json/);
  // :3 pins SOURCE_URI to the AWSPREVIOUS secret version, which fails source auth (runs 509, 511, 529: container 41).
  assert.match(run, /^ {4}K5_TD: vitana-aurora-staging-migrate:2$/m);
  assert.match(run, /assignPublicIp = "DISABLED"/);
  for (const m of job.matchAll(/^ {4}- if: (.*)$/gm)) assert.match(m[1], /^\$CI_COMMIT_BRANCH == "main" && /, `every job rule is main-only: ${m[1]}`);
});
