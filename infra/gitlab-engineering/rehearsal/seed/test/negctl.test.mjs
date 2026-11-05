// A smoke test of the negative controls with stand-ins for the network (the controls themselves run after the tests, in scripts/ci-test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAwsEnv, checkGitlabHost, checkImds, formatLine, NAMES } from '../scripts/negctl.mjs';

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

test('imds and gitlab-host fail when something answers and pass when nothing does', async () => {
  const silentRequest = () => { const h = {}; return { on: (ev, fn) => { h[ev] = fn; if (ev === 'error') setImmediate(() => fn(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }))); }, end() {}, destroy() {} }; };
  assert.equal((await checkImds({ timeoutMs: 100, request: silentRequest })).pass, true);
  const refused = () => { const s = { on: (ev, fn) => { if (ev === 'error') setImmediate(() => fn(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))); return s; }, destroy() {} }; return s; };
  assert.equal((await checkGitlabHost({ ip: '10.0.1.5', timeoutMs: 100, connect: refused })).pass, true);
  assert.equal((await checkGitlabHost({ timeoutMs: 100, connect: refused })).pass, false);
});
