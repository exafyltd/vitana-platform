// VTID-05552 (agentic-delivery/verify-on-gitlab) — how the verify, record and close jobs read their secret (plan
// agentic-delivery §7: roles gl-verify and gl-record, one audience per role, no AWS key on the GitLab side).
// Run: node --test scripts/eng/verify/aws-secret.test.mjs (UNIT.yml runs it on every PR: Node 20, no install).
//
// A job exchanges its GitLab ID token for short-lived credentials (STS AssumeRoleWithWebIdentity, an unsigned call)
// and reads one Secrets Manager secret with them (GetSecretValue, signed with Signature Version 4). Dependency-free, so
// the jobs run on the Node 20 job image with nothing installed. fetch is injected: no test reaches AWS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'aws-secret.mjs');
const load = () => import(pathToFileURL(MODULE).href);

const ROLE = 'arn:aws:iam::472838866351:role/gl-record';
const NOW = Date.parse('2026-11-05T12:34:56.000Z');
const STS_OK = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>ASIAEXAMPLEKEY</AccessKeyId>
      <SecretAccessKey>tempSecret/Example+Key</SecretAccessKey>
      <SessionToken>FwoGZXIvYXdzEExampleSession/Token+==</SessionToken>
      <Expiration>2026-11-05T12:49:56Z</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;

function fakeAws({ sts = { status: 200, body: STS_OK }, sm = { status: 200, body: JSON.stringify({ Name: 'vitana/ci/oasis-recorder', SecretString: '{"SUPABASE_URL":"https://example.invalid","SUPABASE_SERVICE_ROLE":"k"}' }) } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = String(url).startsWith('https://sts.') ? sts : sm;
    return new Response(r.body, { status: r.status, headers: { 'content-type': String(url).startsWith('https://sts.') ? 'text/xml' : 'application/x-amz-json-1.1' } });
  };
  return { calls, fetchImpl };
}

test('signV4 reproduces the AWS documentation example (IAM ListUsers, 20150830T123600Z)', async () => {
  const m = await load();
  const s = m.signV4({
    method: 'GET', host: 'iam.amazonaws.com', path: '/', query: 'Action=ListUsers&Version=2010-05-08',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'X-Amz-Date': '20150830T123600Z' },
    body: '', region: 'us-east-1', service: 'iam',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z',
  });
  assert.equal(s.canonicalRequestHash, 'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
  assert.equal(s.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  assert.equal(s.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

test('readSecret: the ID token buys 15-minute credentials for the role, which read the one secret', async () => {
  const m = await load();
  const aws = fakeAws();
  const secret = await m.readSecret({ token: 'header.payload.sig', roleArn: ROLE, secretId: 'vitana/ci/oasis-recorder', region: 'eu-central-1', sessionName: 'gitlab-12-345', fetchImpl: aws.fetchImpl, now: () => NOW });
  assert.equal(secret, '{"SUPABASE_URL":"https://example.invalid","SUPABASE_SERVICE_ROLE":"k"}');
  assert.equal(aws.calls.length, 2);
  const [sts, sm] = aws.calls;
  assert.equal(sts.url, 'https://sts.eu-central-1.amazonaws.com/');
  assert.equal(sts.init.method, 'POST');
  assert.equal(sts.init.headers.authorization, undefined, 'AssumeRoleWithWebIdentity is not signed');
  const form = new URLSearchParams(sts.init.body);
  assert.deepEqual(Object.fromEntries(form), {
    Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: ROLE, RoleSessionName: 'gitlab-12-345',
    WebIdentityToken: 'header.payload.sig', DurationSeconds: '900',
  });
  assert.equal(sm.url, 'https://secretsmanager.eu-central-1.amazonaws.com/');
  assert.equal(sm.init.method, 'POST');
  assert.equal(sm.init.body, '{"SecretId":"vitana/ci/oasis-recorder"}');
  assert.equal(sm.init.headers['x-amz-target'], 'secretsmanager.GetSecretValue');
  assert.equal(sm.init.headers['content-type'], 'application/x-amz-json-1.1');
  assert.equal(sm.init.headers['x-amz-security-token'], 'FwoGZXIvYXdzEExampleSession/Token+==');
  assert.equal(sm.init.headers['x-amz-date'], '20261105T123456Z');
  const expected = m.signV4({
    method: 'POST', host: 'secretsmanager.eu-central-1.amazonaws.com', path: '/', query: '',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-date': '20261105T123456Z', 'x-amz-security-token': 'FwoGZXIvYXdzEExampleSession/Token+==', 'x-amz-target': 'secretsmanager.GetSecretValue' },
    body: '{"SecretId":"vitana/ci/oasis-recorder"}', region: 'eu-central-1', service: 'secretsmanager',
    accessKeyId: 'ASIAEXAMPLEKEY', secretAccessKey: 'tempSecret/Example+Key', amzDate: '20261105T123456Z',
  });
  assert.equal(sm.init.headers.authorization, expected.authorization);
  assert.match(sm.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLEKEY\/20261105\/eu-central-1\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/);
});

test('a role outside account 472838866351 or a region other than eu-central-1 is refused before any call (IF–THEN 11)', async () => {
  const m = await load();
  for (const over of [{ roleArn: 'arn:aws:iam::111122223333:role/gl-record' }, { region: 'us-east-1' }, { roleArn: 'gl-record' }]) {
    const aws = fakeAws();
    await assert.rejects(() => m.readSecret({ token: 't', roleArn: ROLE, secretId: 'vitana/ci/test-user', region: 'eu-central-1', sessionName: 's', fetchImpl: aws.fetchImpl, now: () => NOW, ...over }), /472838866351|eu-central-1/);
    assert.equal(aws.calls.length, 0, JSON.stringify(over));
  }
});

test('an STS or Secrets Manager error names the role or secret and the AWS error, never the token', async () => {
  const m = await load();
  const denied = fakeAws({ sts: { status: 403, body: '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>' } });
  await assert.rejects(
    () => m.readSecret({ token: 'secret-id-token-value', roleArn: ROLE, secretId: 'vitana/ci/test-user', region: 'eu-central-1', sessionName: 's', fetchImpl: denied.fetchImpl, now: () => NOW }),
    (e) => /gl-record/.test(e.message) && /AccessDenied/.test(e.message) && !/secret-id-token-value/.test(e.message),
  );
  const missing = fakeAws({ sm: { status: 400, body: JSON.stringify({ __type: 'ResourceNotFoundException', Message: "Secrets Manager can't find the specified secret." }) } });
  await assert.rejects(
    () => m.readSecret({ token: 't', roleArn: ROLE, secretId: 'vitana/ci/test-user', region: 'eu-central-1', sessionName: 's', fetchImpl: missing.fetchImpl, now: () => NOW }),
    /vitana\/ci\/test-user.*ResourceNotFoundException/,
  );
});

// ── The CLI the jobs run ────────────────────────────────────────────────────────────────────────────────────────
const FETCH_STUB = `
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith('https://sts.')) return new Response(${JSON.stringify(STS_OK)}, { status: 200 });
  return new Response(JSON.stringify({ SecretString: '{"TEST_USER_EMAIL":"e2e@example.invalid","TEST_USER_PASSWORD":"pw-not-real"}' }), { status: 200 });
};
`;

function cli(args, env) {
  const dir = mkdtempSync(join(tmpdir(), 'aws-secret-'));
  try {
    writeFileSync(join(dir, 'stub.mjs'), FETCH_STUB);
    const out = join(dir, 'secrets', 'test-user.json');
    const r = spawnSync(process.execPath, [MODULE, ...args(out)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_OPTIONS: `--import ${pathToFileURL(join(dir, 'stub.mjs')).href}`, CI_PROJECT_ID: '12', CI_JOB_ID: '345', ...env },
    });
    const written = existsSync(out) ? { text: readFileSync(out, 'utf8'), mode: statSync(out).mode & 0o777 } : null;
    return { status: r.status, output: `${r.stdout}${r.stderr}`, written };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const ARGS = (out) => ['--token-env', 'VERIFY_ID_TOKEN', '--role-arn', 'arn:aws:iam::472838866351:role/gl-verify', '--secret-id', 'vitana/ci/test-user', '--out', out];

test('the CLI writes the secret to --out (mode 0600) and never prints it', () => {
  const r = cli(ARGS, { VERIFY_ID_TOKEN: 'id-token-not-real' });
  assert.equal(r.status, 0, r.output);
  assert.equal(r.written.text, '{"TEST_USER_EMAIL":"e2e@example.invalid","TEST_USER_PASSWORD":"pw-not-real"}');
  assert.equal(r.written.mode, 0o600);
  assert.doesNotMatch(r.output, /pw-not-real|id-token-not-real|tempSecret/);
  assert.match(r.output, /vitana\/ci\/test-user/);
});

test('the CLI fails, naming the variable, when the job has no ID token', () => {
  const r = cli(ARGS, {});
  assert.notEqual(r.status, 0);
  assert.match(r.output, /VERIFY_ID_TOKEN/);
  assert.equal(r.written, null);
});
