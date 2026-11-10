// VTID-05546 — preview.mjs: vitana-v1 merge-request previews (plan agentic-delivery §3.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upload, stop } from './preview.mjs';

const DIST_ID = 'E1PREVIEW2DIST3';

function fake() {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'aws' && args[0] === 'sts') return { code: 0, stdout: JSON.stringify({ Account: '472838866351' }) };
    if (cmd === 'aws' && args[0] === 'cloudfront') return { code: 0, stdout: JSON.stringify({ Invalidation: { Id: 'I1' } }) };
    if (cmd === 'aws' && args[0] === 's3') return { code: 0, stdout: '' };
    return { code: 1, stderr: `unexpected ${cmd} ${args.join(' ')}` };
  };
  return { run, calls };
}

function dist() {
  const dir = mkdtempSync(join(tmpdir(), 'preview-'));
  const d = join(dir, 'dist');
  mkdirSync(join(d, 'assets'), { recursive: true });
  writeFileSync(join(d, 'index.html'), '<html></html>');
  writeFileSync(join(d, 'assets', 'index-abc.js'), '');
  return d;
}

const s3Targets = (calls) => calls.filter((c) => c[1] === 's3').flatMap((c) => c.filter((x) => String(x).startsWith('s3://')));
const paths = (calls) => calls.filter((c) => c[1] === 'cloudfront').map((c) => c[c.indexOf('--paths') + 1]);
const quiet = () => {};

test('a merge request preview is uploaded to mr-<iid>/ only and that path is invalidated', () => {
  const f = fake();
  const r = upload({ service: 'community-app', prefix: 'mr-42/', dist: dist(), mode: 'live', distributionId: DIST_ID, domain: 'previews.example' }, { run: f.run, log: quiet });
  assert.equal(r.url, 'https://previews.example/mr-42/');
  const targets = s3Targets(f.calls);
  assert.ok(targets.length >= 2);
  for (const t of targets) assert.ok(t.startsWith('s3://vitana-pr-previews/mr-42/'), t);
  const sync = f.calls.find((c) => c[1] === 's3' && c[2] === 'sync');
  assert.ok(sync.includes('--delete'));
  assert.deepEqual(paths(f.calls), ['/mr-42/*']);
});

test('only the prefixes mr-<iid>/ and gl-main/ exist', () => {
  for (const prefix of ['pr-42/', 'mr-42', 'mr-0/', 'mr-/', 'gl-main', '../', 'mr-42/../x/', '', 'mr-42/x/', 'staging/']) {
    const f = fake();
    assert.throws(() => upload({ service: 'community-app', prefix, dist: dist(), mode: 'live', distributionId: DIST_ID }, { run: f.run, log: quiet }), (e) => e.exitCode === 2, prefix);
    assert.equal(f.calls.length, 0, `no call for '${prefix}'`);
  }
  const f = fake();
  upload({ service: 'community-app', prefix: 'gl-main/', dist: dist(), mode: 'shadow', distributionId: DIST_ID }, { run: f.run, log: quiet });
  for (const t of s3Targets(f.calls)) assert.ok(t.startsWith('s3://vitana-pr-previews/gl-main/'), t);
});

test('shadow mode writes only the gl-main/ preview', () => {
  const f = fake();
  assert.throws(() => upload({ service: 'community-app', prefix: 'mr-42/', dist: dist(), mode: 'shadow', distributionId: DIST_ID }, { run: f.run, log: quiet }), (e) => e.exitCode === 2);
  assert.throws(() => upload({ service: 'community-app', prefix: 'mr-42/', dist: dist(), distributionId: DIST_ID }, { run: f.run, log: quiet }), (e) => e.exitCode === 2, 'unset mode is shadow');
  assert.equal(f.calls.length, 0);
});

test('teardown removes only its own prefix', () => {
  const f = fake();
  stop({ service: 'community-app', prefix: 'mr-42/', mode: 'live', distributionId: DIST_ID }, { run: f.run, log: quiet });
  const rm = f.calls.filter((c) => c[1] === 's3');
  assert.equal(rm.length, 1);
  assert.deepEqual(rm[0].slice(0, 5), ['aws', 's3', 'rm', 's3://vitana-pr-previews/mr-42/', '--recursive']);
  assert.deepEqual(paths(f.calls), ['/mr-42/*']);
  for (const prefix of ['gl-main/', 'mr-42', 'mr-4', '', 'pr-42/']) {
    const g = fake();
    assert.throws(() => stop({ service: 'community-app', prefix, mode: 'live', distributionId: DIST_ID }, { run: g.run, log: quiet }), (e) => e.exitCode === 2, prefix);
    assert.equal(g.calls.length, 0, `no call for '${prefix}'`);
  }
});

test('only the community app has a preview, and the distribution id is required', () => {
  const f = fake();
  assert.throws(() => upload({ service: 'gateway', prefix: 'mr-1/', dist: dist(), mode: 'live', distributionId: DIST_ID }, { run: f.run, log: quiet }), (e) => e.exitCode === 2);
  assert.throws(() => upload({ service: 'community-app', prefix: 'mr-1/', dist: dist(), mode: 'live', distributionId: '' }, { run: f.run, log: quiet }), (e) => e.exitCode === 2);
  assert.equal(f.calls.length, 0);
});
