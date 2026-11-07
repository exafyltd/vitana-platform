// VTID-05546 — push-image.mjs: push by digest to the service's own ECR repository (plan agentic-delivery §3.6 step 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushImage, imageTag } from './push-image.mjs';

const REG = '472838866351.dkr.ecr.eu-central-1.amazonaws.com';
const SHA = 'e'.repeat(40);
const DIGEST = `sha256:${'f'.repeat(64)}`;
const PASSWORD = 'ecr-password-value';

function fake({ digest = DIGEST } = {}) {
  const calls = [];
  const inputs = [];
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    if (opts.input !== undefined) inputs.push([cmd, args[0], opts.input]);
    if (cmd === 'aws' && args[0] === 'sts') return { code: 0, stdout: JSON.stringify({ Account: '472838866351' }) };
    if (cmd === 'aws' && args[0] === 'ecr' && args[1] === 'get-login-password') return { code: 0, stdout: `${PASSWORD}\n` };
    if (cmd === 'skopeo' && args[0] === 'login') return { code: 0, stdout: 'Login Succeeded!' };
    if (cmd === 'skopeo' && args[0] === 'copy') {
      const file = args[args.indexOf('--digestfile') + 1];
      if (digest) writeFileSync(file, digest);
      return { code: 0, stdout: '' };
    }
    return { code: 1, stderr: `unexpected ${cmd} ${args.join(' ')}` };
  };
  return { run, calls, inputs };
}

function archive() {
  const dir = mkdtempSync(join(tmpdir(), 'push-image-'));
  const file = join(dir, 'image.oci.tar');
  writeFileSync(file, 'oci');
  return { dir, file };
}

const quiet = () => {};

test('it pushes the archive, outputs the digest and the image by digest', () => {
  const { dir, file } = archive();
  const f = fake();
  const out = pushImage({ service: 'gateway', repository: 'vitana/gateway', archive: file, sha: SHA, mode: 'live', out: join(dir, 'push-image.json'), workDir: dir }, { run: f.run, log: quiet });
  assert.equal(out.digest, DIGEST);
  assert.equal(out.image, `${REG}/vitana/gateway@${DIGEST}`);
  assert.equal(out.tag, SHA.slice(0, 12));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'push-image.json'), 'utf8')), out);
  const copy = f.calls.find((c) => c[0] === 'skopeo' && c[1] === 'copy');
  assert.equal(copy[copy.length - 2], `oci-archive:${file}`);
  assert.equal(copy[copy.length - 1], `docker://${REG}/vitana/gateway:${SHA.slice(0, 12)}`);
  assert.equal(f.calls.some((c) => c.join(' ').includes(PASSWORD)), false, 'the ECR password is never an argument');
  assert.deepEqual(f.inputs, [['skopeo', 'login', PASSWORD]], 'the password goes to skopeo on stdin');
});

test('shadow mode pushes only a shadow-<sha12> tag', () => {
  const { dir, file } = archive();
  const f = fake();
  const out = pushImage({ service: 'community-app', repository: 'vitana/community-app', archive: file, sha: SHA, mode: 'shadow', workDir: dir }, { run: f.run, log: quiet });
  assert.equal(out.tag, `shadow-${SHA.slice(0, 12)}`);
  assert.equal(imageTag(SHA, undefined), `shadow-${SHA.slice(0, 12)}`, 'anything but live is shadow');
  const copy = f.calls.find((c) => c[0] === 'skopeo' && c[1] === 'copy');
  assert.equal(copy[copy.length - 1], `docker://${REG}/vitana/community-app:shadow-${SHA.slice(0, 12)}`);
});

test('it refuses a target outside the service ECR repository', () => {
  const { dir, file } = archive();
  for (const o of [
    { service: 'community-app', repository: 'vitana/gateway' },
    { service: 'gateway', repository: 'vitana/gateway-prod' },
    { service: 'gateway', repository: 'vitana/gateway', registry: '111111111111.dkr.ecr.eu-central-1.amazonaws.com' },
    { service: 'gateway', repository: 'vitana/gateway', registry: '472838866351.dkr.ecr.us-east-1.amazonaws.com' },
    { service: 'prod-gateway', repository: 'vitana/gateway' },
  ]) {
    const f = fake();
    assert.throws(() => pushImage({ ...o, archive: file, sha: SHA, mode: 'live', workDir: dir }, { run: f.run, log: quiet }), (e) => e.exitCode === 2, JSON.stringify(o));
    assert.equal(f.calls.length, 0, `no call for ${JSON.stringify(o)}`);
  }
});

test('a push without a digest fails the job', () => {
  const { dir, file } = archive();
  const f = fake({ digest: '' });
  assert.throws(() => pushImage({ service: 'gateway', repository: 'vitana/gateway', archive: file, sha: SHA, mode: 'live', workDir: dir }, { run: f.run, log: quiet }), /no image digest/);
});
