// VTID-05552 (agentic-delivery/verify-on-gitlab) — the `.vtid-close` job's environment (plan agentic-delivery §3.6 step 5).
// Run: node --test scripts/eng/verify/vtid-close-env.test.mjs (UNIT.yml runs it on every PR: Node 20, no install).
//
// On GitHub, VTID-AUTO-CLOSE.yml gives scripts/ci/vtid-auto-close.cjs the merged PR as PR_TITLE, PR_BODY, PR_HEAD_REF,
// PR_LABELS and PR_REF. On GitLab the same, unchanged script runs on `main` after landing, with that environment taken
// from the squash commit the merge bot writes: the merge request title (VTID first), its description, then the trailers
// `Merge-Request: !<iid>`, `Source-Branch:`, `Reviewed-Head:`, `Review-Verdict:`, `Reviewer:`, `Accepted-At:` (§3.5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLOSE_SCRIPT = join(HERE, '..', '..', 'ci', 'vtid-auto-close.cjs');
const WRAPPER = join(HERE, 'vtid-close-env.mjs');
const load = () => import(pathToFileURL(WRAPPER).href);
// The unchanged GitHub-side script: its own decision functions judge the mapped environment.
const close = require(CLOSE_SCRIPT);

const REVIEWED = '0123456789abcdef0123456789abcdef01234567';
const squash = ({ title = 'VTID-05552 (agentic-delivery/verify-on-gitlab): STAGING-VERIFY on GitLab', description = 'Runs STAGING-VERIFY on GitLab.\n\nSecond paragraph.', branch = 'kiro/agentic-delivery/verify-on-gitlab', iid = '42', trailers = true } = {}) =>
  [
    title,
    '',
    description,
    ...(trailers ? [
      '',
      ...(iid ? [`Merge-Request: !${iid}`] : []),
      `Source-Branch: ${branch}`,
      `Reviewed-Head: ${REVIEWED}`,
      'Review-Verdict: accept',
      'Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)',
      'Accepted-At: 2026-11-05T12:00:00Z',
    ] : []),
    '',
  ].join('\n');

test('a squash commit with the §3.5 trailers maps to PR_TITLE, PR_BODY, PR_HEAD_REF, PR_LABELS and PR_REF', async () => {
  const m = await load();
  assert.deepEqual(m.vtidCloseEnv({ message: squash(), projectPath: 'vitana/vitana-platform' }), {
    PR_TITLE: 'VTID-05552 (agentic-delivery/verify-on-gitlab): STAGING-VERIFY on GitLab',
    PR_BODY: 'Runs STAGING-VERIFY on GitLab.\n\nSecond paragraph.',
    PR_HEAD_REF: 'kiro/agentic-delivery/verify-on-gitlab',
    PR_LABELS: '[]',
    PR_REF: 'vitana/vitana-platform!42',
  });
});

test('the trailers are parsed from the last block, also without a blank line before them; CRLF is accepted', async () => {
  const m = await load();
  const p = m.parseSquashMessage('VTID-05552 (a/b): t\r\n\r\nBody line.\r\nMerge-Request: !7\r\nSource-Branch: dev-autopilot/VTID-05552-x\r\n');
  assert.equal(p.title, 'VTID-05552 (a/b): t');
  assert.equal(p.body, 'Body line.');
  assert.equal(p.trailers['Merge-Request'], '!7');
  assert.equal(p.trailers['Source-Branch'], 'dev-autopilot/VTID-05552-x');
});

test('the mapped environment gives vtid-auto-close.cjs the same decision as the GitHub pull request did', async () => {
  const m = await load();
  const env = m.vtidCloseEnv({ message: squash(), projectPath: 'vitana/vitana-v1' });
  const github = { title: env.PR_TITLE, body: env.PR_BODY, headRef: 'kiro/agentic-delivery/verify-on-gitlab', labels: [] };
  const gitlab = { title: env.PR_TITLE, body: env.PR_BODY, headRef: env.PR_HEAD_REF, labels: JSON.parse(env.PR_LABELS) };
  assert.deepEqual(close.extractTitleVtids(gitlab.title), ['VTID-05552']);
  assert.deepEqual(close.autoCloseDecision(gitlab), close.autoCloseDecision(github));
  assert.deepEqual(close.autoCloseDecision(gitlab), { close: true, reason: null });
});

test('a dev-autopilot/* source branch keeps its meaning: the Dev Autopilot pipeline closes that VTID, not the landing', async () => {
  const m = await load();
  const env = m.vtidCloseEnv({ message: squash({ branch: 'dev-autopilot/VTID-05552-fix' }), projectPath: 'vitana/vitana-platform' });
  assert.equal(env.PR_HEAD_REF, 'dev-autopilot/VTID-05552-fix');
  const d = close.autoCloseDecision({ headRef: env.PR_HEAD_REF, labels: JSON.parse(env.PR_LABELS), body: env.PR_BODY });
  assert.equal(d.close, false);
  assert.match(d.reason, /Dev Autopilot/);
});

test('the `VTID_AUTO_CLOSE: no` line in the description keeps its meaning and stays in PR_BODY', async () => {
  const m = await load();
  const env = m.vtidCloseEnv({ message: squash({ description: 'Part 1 of 2.\n\nVTID_AUTO_CLOSE: no' }), projectPath: 'vitana/vitana-platform' });
  assert.match(env.PR_BODY, /^VTID_AUTO_CLOSE: no$/m);
  const d = close.autoCloseDecision({ headRef: env.PR_HEAD_REF, labels: JSON.parse(env.PR_LABELS), body: env.PR_BODY });
  assert.deepEqual(d, { close: false, reason: 'VTID_AUTO_CLOSE: no in the PR body' });
});

test('a commit on main without a Merge-Request trailer is not a merge-bot landing: no environment, nothing is closed', async () => {
  const m = await load();
  assert.equal(m.vtidCloseEnv({ message: squash({ trailers: false }), projectPath: 'vitana/vitana-platform' }), null);
  assert.equal(m.vtidCloseEnv({ message: squash({ iid: '' }), projectPath: 'vitana/vitana-platform' }), null);
  assert.equal(m.vtidCloseEnv({ message: '', projectPath: 'vitana/vitana-platform' }), null);
});

// ── The CLI the `.vtid-close` job runs: the unchanged script, end to end, against an offline fake gateway ─────────
// fetch is replaced (node --import) in the child that runs vtid-auto-close.cjs; it records each request.
const FETCH_STUB = `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input));
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ method: init.method || 'GET', url: u.href, auth: Boolean(init.headers && init.headers.Authorization), body: init.body || null }) + '\\n');
  if (!init.method) return new Response(JSON.stringify({ vtid: 'VTID-05552', status: 'in_progress', is_terminal: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};
`;

function runCli(env) {
  const dir = mkdtempSync(join(tmpdir(), 'vtid-close-env-'));
  try {
    writeFileSync(join(dir, 'stub.mjs'), FETCH_STUB);
    writeFileSync(join(dir, 'secret.json'), JSON.stringify({ GATEWAY_SERVICE_TOKEN: 'fake-service-token' }));
    const r = spawnSync(process.execPath, [WRAPPER, 'run', '--close-script', CLOSE_SCRIPT, '--secret-file', join(dir, 'secret.json')], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH, STUB_LOG: join(dir, 'requests.log'),
        NODE_OPTIONS: `--import ${pathToFileURL(join(dir, 'stub.mjs')).href}`,
        GATEWAY_URL: 'https://gateway.example.invalid',
        CI_PROJECT_PATH: 'vitana/vitana-platform',
        ...env,
      },
    });
    const log = existsSync(join(dir, 'requests.log')) ? readFileSync(join(dir, 'requests.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { status: r.status, output: `${r.stdout}${r.stderr}`, requests: log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('`vtid-close-env.mjs run` in live mode runs vtid-auto-close.cjs with the mapped environment and the service token', () => {
  const r = runCli({ DELIVERY_MODE: 'live', CI_COMMIT_MESSAGE: squash() });
  assert.equal(r.status, 0, r.output);
  assert.equal(r.requests.length, 2, r.output);
  assert.equal(r.requests[0].url, 'https://gateway.example.invalid/api/v1/oasis/tasks/VTID-05552');
  assert.equal(r.requests[1].method, 'POST');
  assert.equal(r.requests[1].url, 'https://gateway.example.invalid/api/v1/oasis/tasks/VTID-05552/complete');
  assert.equal(r.requests[1].auth, true, 'the gateway service token is sent');
  assert.deepEqual(JSON.parse(r.requests[1].body), { terminal_outcome: 'success', reason: 'PR merged to main (vitana/vitana-platform!42)' });
  assert.doesNotMatch(r.output, /fake-service-token/, 'the token is never printed');
});

test('`vtid-close-env.mjs run` closes nothing in shadow mode, or when DELIVERY_MODE is unset (GitHub stays the only closer)', () => {
  for (const mode of ['shadow', '', undefined]) {
    const r = runCli({ ...(mode === undefined ? {} : { DELIVERY_MODE: mode }), CI_COMMIT_MESSAGE: squash() });
    assert.notEqual(r.status, 0, `DELIVERY_MODE=${mode}: refused`);
    assert.match(r.output, /shadow/i);
    assert.deepEqual(r.requests, [], `DELIVERY_MODE=${mode}: no gateway call`);
  }
});

test('`vtid-close-env.mjs run` on a commit without the merge-bot trailers makes no gateway call and says why', () => {
  const r = runCli({ DELIVERY_MODE: 'live', CI_COMMIT_MESSAGE: squash({ trailers: false }) });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Merge-Request/);
  assert.deepEqual(r.requests, []);
});
