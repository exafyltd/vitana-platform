// A smoke test of the negative controls with stand-ins for the network (the controls themselves run after the tests, in scripts/ci-test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAwsEnv, checkBaseline, checkGitlabHost, checkImds, formatInfo, formatLine, NAMES } from '../scripts/negctl.mjs';

test('the three controls are named as the report reads them', () => {
  assert.deepEqual([...NAMES], ['imds', 'gitlab-host', 'aws-env']);
  assert.equal(formatLine({ name: 'imds', pass: true }), 'NEGCTL imds PASS');
  assert.equal(formatLine({ name: 'aws-env', pass: false }), 'NEGCTL aws-env FAIL');
});

test('aws-env passes without an AWS_ variable and fails with one, naming it but never its value', () => {
  assert.equal(checkAwsEnv({ PATH: '/bin', CI: 'true' }).pass, true);
  const r = checkAwsEnv({ AWS_REGION: 'eu-central-1', AWS_SECRET_ACCESS_KEY: 'do-not-print-this-value' });
  assert.equal(r.pass, false);
  assert.match(r.detail, /AWS_REGION, AWS_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(r.detail, /do-not-print-this-value|eu-central-1/);
});

// The metadata service as a stand-in: what the token request (PUT) and the plain read (GET) meet. A number is an HTTP status, 'error' a connection error.
const standIn = (put, get) => (options, cb) => {
  const how = options.method === 'PUT' ? put : get;
  const req = { on: (ev, fn) => { if (ev === 'error' && how === 'error') setImmediate(() => fn(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }))); return req; }, destroy() {}, end() { if (typeof how === 'number') setImmediate(() => cb({ statusCode: how, resume() {} })); } };
  return req;
};

test('imds passes when no token is issued and no data is read, and fails on a token or on a 2xx read; 401 and 403 are the protection working', async () => {
  for (const [put, get] of [['error', 'error'], [401, 401], [403, 403], ['error', 401], [404, 500]]) {
    assert.equal((await checkImds({ timeoutMs: 100, request: standIn(put, get) })).pass, true, `${put} / ${get}`);
  }
  assert.equal((await checkImds({ timeoutMs: 100, request: standIn(200, 401) })).pass, false, 'a token was issued');
  assert.equal((await checkImds({ timeoutMs: 100, request: standIn(401, 200) })).pass, false, 'data was read without a token');
  const r = await checkImds({ timeoutMs: 100, request: standIn(401, 401) });
  assert.match(r.detail, /PUT \/latest\/api\/token: HTTP 401; GET \/latest\/meta-data\/: HTTP 401/, 'the statuses seen are in the detail');
});

test('gitlab-host fails when something answers or no address is configured, and passes when nothing does', async () => {
  const refused = () => { const s = { on: (ev, fn) => { if (ev === 'error') setImmediate(() => fn(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))); return s; }, destroy() {} }; return s; };
  assert.equal((await checkGitlabHost({ ip: '10.0.1.5', timeoutMs: 100, connect: refused })).pass, true);
  assert.equal((await checkGitlabHost({ timeoutMs: 100, connect: refused })).pass, false);
});

test('the baseline says whether GitLab was reached from the job and is information only: it prints the host and port, never the URL, and is not a control', async () => {
  const refused = () => { const s = { on: (ev, fn) => { if (ev === 'error') setImmediate(() => fn(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))); return s; }, destroy() {} }; return s; };
  const r = await checkBaseline({ env: { CI_SERVER_URL: 'https://gitlab.example.com/some/path?x=1' }, timeoutMs: 100, connect: refused });
  assert.equal(r.state, 'not reachable');
  assert.equal(formatInfo(r), 'NEGCTL-INFO baseline gitlab: not reachable (gitlab.example.com:443 ECONNREFUSED)');
  assert.equal((await checkBaseline({ env: {}, timeoutMs: 100, connect: refused })).state, 'not checked');
  assert.ok(!NAMES.includes('baseline'));
});
