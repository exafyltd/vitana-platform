// Tests for scripts/collab/kiro-web-session.mjs (plan kiro-web-parity lane session-kit; plan kiro-web-reliability lane
// session-reliability, plan §3.2.7). Run: node --test scripts/collab/kiro-web-session.test.mjs
// Fixtures live in temp dirs only; no network, no push to any real remote, no real preflight or tsc (runners are
// injected, or a fake tsc/preflight is put in the fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKER, GIT_HOOK_MARKER, condensePreflight, onlyPlanSparSessionFalsePositive, defaultWorkspace, findRepos, hookDefs, writeHooks,
  copyReviewer, parseCommand, guard, waitChecks, statusReport, installScript, installGitHooks, gitHooksState, gitPreCommit,
  gitPrePush, prBody, refresh, workflowPaths, globMatch,
} from './kiro-web-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'kiro-web-session.mjs');
const PATH_GUARD = path.join(HERE, '..', 'ci', 'validator-path-guard.cjs');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const VALIDATOR_YML = ['name: VALIDATOR-CHECK', 'on:', '  pull_request:', '    types: [opened]', '    # comment', '    paths:',
  "      - 'services/gateway/src/**'", "      - 'docs/validation/**'", '', 'jobs:', '  validate-pr:', '    runs-on: ubuntu-latest', ''].join('\n');

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiro-web-session-'));
  const ws = path.join(dir, 'ws');
  const platform = path.join(ws, 'vitana-platform');
  const cache = path.join(dir, 'cache');
  mkdirSync(path.join(platform, '.kiro', 'agents'), { recursive: true });
  mkdirSync(path.join(platform, 'scripts', 'collab'), { recursive: true });
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(platform, '.kiro', 'agents', 'vitana-lane-reviewer.md'), '---\nname: vitana-lane-reviewer\n---\nreviewer body\n');
  return { dir, ws, platform, cache, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const hookInput = (command, cwd = null) => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', cwd: '/w',
  tool_name: 'execute_bash', tool_input: { command, cwd } });

/** Fake process runner: answers git / gh / node / npx calls from a table, records every call. */
function fakeRun({ top = '/w/vitana-platform', head = SHA, preflight = { status: 0, output: 'preflight: every check passed' },
  tsc = { status: 0, output: '' }, title = 'VTID-12345 (s/l): x', body = null, staged = '', unstaged = '', changed = '',
  commonDir = '/w/vitana-platform/.git', npm = { status: 0, output: 'added' } } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const a = args.join(' ');
    if (cmd === 'git' && a.includes('rev-parse --show-toplevel')) return { status: 0, output: top };
    if (cmd === 'git' && a.includes('--git-common-dir')) return { status: 0, output: commonDir };
    if (cmd === 'git' && a.includes('rev-parse --verify')) {
      const ref = args[args.length - 1].replace(/\^\{commit\}$/, '');
      return { status: 0, output: /^[0-9a-f]{40}$/.test(ref) ? ref : head };
    }
    if (cmd === 'git' && a.includes('remote get-url origin')) return { status: 0, output: 'https://github.com/exafyltd/vitana-platform.git' };
    if (cmd === 'git' && a.includes('fetch')) return { status: 0, output: '' };
    if (cmd === 'git' && a.includes('diff --cached --name-only')) return { status: 0, output: staged };
    if (cmd === 'git' && a.includes('diff --name-only origin/main...')) return { status: 0, output: changed };
    if (cmd === 'git' && (a.includes('diff --name-only --') || a.includes('diff --name-only HEAD'))) return { status: 0, output: unstaged };
    if (cmd === 'gh') return { status: 0, output: a.includes('.body') ? (body ?? title) : title };
    if (cmd === process.execPath && a.includes('preflight.mjs')) return preflight;
    if (cmd === 'npx' && a.includes('tsc')) return tsc;
    if (cmd === 'npm') return npm;
    return { status: 0, output: '' };
  };
  run.calls = calls;
  return run;
}

const g = (args, cwd, env = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

/** A real main checkout with origin = exafyltd/vitana-platform (URL only; nothing is ever pushed there). */
function gitRepo(dir, { gateway = true } = {}) {
  mkdirSync(dir, { recursive: true });
  g(['init', '-q', '-b', 'main'], dir);
  g(['remote', 'add', 'origin', 'https://github.com/exafyltd/vitana-platform.git'], dir);
  if (gateway) {
    mkdirSync(path.join(dir, 'services', 'gateway', 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'services', 'gateway', 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'services', 'gateway', 'src', 'a.ts'), 'export const a: number = 1;\n');
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  }
  writeFileSync(path.join(dir, 'README.md'), 'x\n');
  g(['add', '-A'], dir);
  g([...ID, 'commit', '-q', '-m', 'init'], dir);
  return dir;
}

// ---------------------------------------------------------------- setup writes hooks + reviewer copy
test('setup writes exactly the generated hook files (guard + refresh), one entry each, with the right trigger/matcher/command', () => {
  const f = fixture();
  try {
    const r = writeHooks({ workspace: f.ws, platformRoot: f.platform });
    const dir = path.join(f.ws, '.kiro', 'hooks');
    assert.deepEqual(readdirSync(dir).sort(), ['vitana-web-guard.json', 'vitana-web-refresh.json']);
    assert.deepEqual(r.written.sort(), ['vitana-web-guard.json', 'vitana-web-refresh.json']);
    const gd = JSON.parse(readFileSync(path.join(dir, 'vitana-web-guard.json'), 'utf8'));
    const rf = JSON.parse(readFileSync(path.join(dir, 'vitana-web-refresh.json'), 'utf8'));
    for (const h of [gd, rf]) {
      assert.equal(h.generatedBy, MARKER);
      assert.equal(h.version, 'v1');
      assert.equal(h.hooks.length, 1, 'only the first hook entry of a file runs in Kiro Web');
      assert.equal(h.hooks[0].action.type, 'command');
      assert.ok(h.hooks[0].action.command.includes(path.join(f.platform, 'scripts', 'collab', 'kiro-web-session.mjs')));
    }
    assert.equal(gd.hooks[0].trigger, 'PreToolUse');
    assert.equal(gd.hooks[0].matcher, '^execute_bash$');
    assert.match(gd.hooks[0].action.command, / guard$/);
    assert.ok(gd.hooks[0].action.timeout >= 300, 'cold preflight exceeds the 60 s default');
    assert.equal(rf.hooks[0].trigger, 'UserPromptSubmit');
    assert.match(rf.hooks[0].action.command, / refresh$/);
    assert.equal(hookDefs({ platformRoot: f.platform }).length, 2);
    assert.ok(!hookDefs({ platformRoot: f.platform }).some((d) => d.json.hooks[0].trigger === 'PostToolUse'), 'the mark-dirty PostToolUse hook is gone');
  } finally { f.done(); }
});

test('the guard hook description names every kiro/** and claude/** branch and the git hooks (not kiro/<slug>/<lane>)', () => {
  const d = hookDefs({ platformRoot: '/p' }).find((x) => x.file === 'vitana-web-guard.json').json.hooks[0].description;
  assert.doesNotMatch(d, /kiro\/<slug>\/<lane>/);
  assert.match(d, /kiro\/\*\* or claude\/\*\*/);
  assert.match(d, /pre-push/);
});

test('setup removes a stale marked hook (incl. the old vitana-web-dirty.json), never touches an unmarked file, writes nothing inside a repository', () => {
  const f = fixture();
  try {
    const dir = path.join(f.ws, '.kiro', 'hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'vitana-web-dirty.json'), JSON.stringify({ version: 'v1', generatedBy: MARKER, hooks: [] }));
    writeFileSync(path.join(dir, 'user-hook.json'), JSON.stringify({ version: 'v1', hooks: [] }));
    writeFileSync(path.join(dir, 'notes.txt'), 'keep');
    const before = readdirSync(f.platform, { recursive: true }).sort();
    const r = writeHooks({ workspace: f.ws, platformRoot: f.platform });
    assert.deepEqual(r.removed, ['vitana-web-dirty.json']);
    assert.ok(existsSync(path.join(dir, 'user-hook.json')));
    assert.ok(existsSync(path.join(dir, 'notes.txt')));
    copyReviewer({ workspace: f.ws, platformRoot: f.platform });
    assert.deepEqual(readdirSync(f.platform, { recursive: true }).sort(), before);
  } finally { f.done(); }
});

test('reviewer agent copy is byte-identical and a second setup is a no-op', () => {
  const f = fixture();
  try {
    assert.equal(copyReviewer({ workspace: f.ws, platformRoot: f.platform }).changed, true);
    const src = readFileSync(path.join(f.platform, '.kiro', 'agents', 'vitana-lane-reviewer.md'));
    const dst = readFileSync(path.join(f.ws, '.kiro', 'agents', 'vitana-lane-reviewer.md'));
    assert.ok(src.equals(dst));
    writeHooks({ workspace: f.ws, platformRoot: f.platform });
    const snap = (p) => readFileSync(p, 'utf8');
    const gp = path.join(f.ws, '.kiro', 'hooks', 'vitana-web-guard.json');
    const g1 = snap(gp);
    const r2 = writeHooks({ workspace: f.ws, platformRoot: f.platform });
    assert.deepEqual(r2.written, []);
    assert.equal(snap(gp), g1);
    assert.equal(copyReviewer({ workspace: f.ws, platformRoot: f.platform }).changed, false);
  } finally { f.done(); }
});

test('the old mark-dirty CLI is a silent no-op (a stale hook file from before setup re-ran never fails an edit)', () => {
  const f = fixture();
  try {
    const cli = spawnSync(process.execPath, [SCRIPT, 'mark-dirty'], { input: '{bad', encoding: 'utf8',
      env: { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache } });
    assert.equal(cli.status, 0);
    assert.equal(cli.stdout, '');
    assert.ok(!existsSync(path.join(f.cache, 'dirty')));
  } finally { f.done(); }
});

// ---------------------------------------------------------------- command parsing
test('parseCommand finds every push form with repo dir, branch, source, PR_TITLE and PR_BODY_FILE', () => {
  const p = (c, cwd = '/w') => parseCommand(c, cwd).filter((a) => a.op === 'push');
  assert.deepEqual(p(`git -C /w/vitana-platform push origin ${SHA}:refs/heads/kiro/s/l`)[0],
    { op: 'push', dir: '/w/vitana-platform', remote: 'origin', src: SHA, branch: 'kiro/s/l', del: false, title: null, bodyFile: null });
  assert.deepEqual(p('git push origin kiro/s/plan')[0], { op: 'push', dir: '/w', remote: 'origin', src: 'kiro/s/plan', branch: 'kiro/s/plan', del: false, title: null, bodyFile: null });
  assert.equal(p("PR_TITLE='plan(s): x y' git push origin kiro/s/plan")[0].title, 'plan(s): x y');
  assert.equal(p('PR_TITLE="VTID-1 (s/l): a b" git -C /w push origin kiro/s/l')[0].title, 'VTID-1 (s/l): a b');
  assert.equal(p("export PR_TITLE='VTID-2 (s/l): c' && git push origin kiro/s/l")[0].title, 'VTID-2 (s/l): c');
  assert.equal(p("PR_TITLE='x' true; git push origin kiro/s/l")[0].title, null, 'a prefix applies to its own command only');
  assert.equal(p("PR_TITLE='t' PR_BODY_FILE=/tmp/b.md git push origin kiro/s/l")[0].bodyFile, '/tmp/b.md');
  assert.equal(p("export PR_BODY_FILE='/tmp/c d.md' && git push origin kiro/s/l")[0].bodyFile, '/tmp/c d.md');
  assert.equal(p('PR_BODY_FILE=/tmp/b.md true; git push origin kiro/s/l')[0].bodyFile, null);
  assert.equal(p('git push -u origin kiro/s/l')[0].branch, 'kiro/s/l');
  assert.equal(p('git push -q --set-upstream origin kiro/s/l')[0].branch, 'kiro/s/l');
  assert.equal(p('cd /w/vitana-v1 && git push origin kiro/s/l')[0].dir, '/w/vitana-v1');
  assert.equal(p('git -C sub push origin kiro/s/l', '/w')[0].dir, '/w/sub');
  assert.equal(p('git push origin --delete refs/heads/collab-driver/s')[0].del, true);
  assert.equal(p('git push origin :refs/heads/kiro/s/l')[0].del, true);
  assert.equal(p('git push')[0].branch, null);
  assert.deepEqual(p('echo git push origin x'), []);
  assert.deepEqual(p('ls -la; npm test'), []);
  const both = parseCommand('git commit -m "a && b" && git push origin kiro/s/l', '/w').map((a) => a.op);
  assert.deepEqual(both, ['commit', 'push']);
});

// ---------------------------------------------------------------- PreToolUse guard
test('guard passes non-git commands and claim/driver/other pushes without running anything', () => {
  const f = fixture();
  try {
    for (const c of ['ls', 'npm test', 'git status', `git push origin ${SHA}:refs/heads/collab-claim/s/l`,
      'git push origin --delete refs/heads/collab-driver/s', 'git push origin pm-agent/s']) {
      const run = fakeRun();
      const r = guard(hookInput(c), { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
      assert.equal(r.code, 0, c);
      assert.equal(run.calls.filter((x) => x.cmd === process.execPath).length, 0, c);
    }
  } finally { f.done(); }
});

test('guard blocks a lane push on a failing preflight with its output, passes and caches a green one', () => {
  const f = fixture();
  try {
    const bad = fakeRun({ preflight: { status: 1, output: 'FAIL  Collab handoff [required]\n  lane file: bad state' } });
    const r1 = guard(hookInput('git -C /w/vitana-platform push origin kiro/s/l'), { run: bad, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r1.code, 2);
    assert.match(r1.stderr, /Collab handoff/);
    assert.match(r1.stderr, /preflight/);
    const pf = bad.calls.find((x) => x.cmd === process.execPath);
    assert.ok(pf.args.includes('--branch') && pf.args.includes('kiro/s/l') && pf.args.includes('--title'));
    assert.equal(pf.args[pf.args.indexOf('--head') + 1], SHA);

    const good = fakeRun();
    const r2 = guard(hookInput('git -C /w/vitana-platform push origin kiro/s/l'), { run: good, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r2.code, 0);
    assert.equal(good.calls.filter((x) => x.cmd === process.execPath).length, 1);
    const again = fakeRun();
    const r3 = guard(hookInput(`git -C /w/vitana-platform push origin ${SHA}:refs/heads/kiro/s/l`), { run: again, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r3.code, 0);
    assert.equal(again.calls.filter((x) => x.cmd === process.execPath).length, 0, 'a passed head is not re-checked');
  } finally { f.done(); }
});

test('guard asks for PR_TITLE when the branch has no open PR, and passes a given title to preflight', () => {
  const f = fixture();
  try {
    const noPr = fakeRun({ title: '' });
    const r = guard(hookInput('git -C /w/vitana-platform push origin kiro/s/l'), { run: noPr, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /PR_TITLE=/);
    assert.equal(noPr.calls.filter((x) => x.cmd === process.execPath).length, 0);
    const given = fakeRun({ title: '' });
    const r2 = guard(hookInput("PR_TITLE='VTID-12345 (s/l): x' git -C /w/vitana-platform push origin kiro/s/l"), { run: given, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r2.code, 0);
    const pf = given.calls.find((x) => x.cmd === process.execPath);
    assert.equal(pf.args[pf.args.indexOf('--title') + 1], 'VTID-12345 (s/l): x');
    assert.equal(given.calls.filter((x) => x.cmd === 'gh').length, 0, 'a given title needs no PR lookup');
  } finally { f.done(); }
});

test('guard blocks a push whose sha is not the checked-out HEAD', () => {
  const f = fixture();
  try {
    const r = guard(hookInput(`git -C /w/vitana-platform push origin ${OTHER_SHA}:refs/heads/kiro/s/l`),
      { run: fakeRun(), cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not the checked-out HEAD/);
  } finally { f.done(); }
});

test('guard allows `git commit && git push` and does not run the push check for a push after a commit (pre-push checks the real commit)', () => {
  const f = fixture();
  try {
    const common = path.join(f.dir, 'common');
    installGitHooks({ repos: [{ dir: '/w/vitana-platform' }], run: fakeRun({ commonDir: common }), script: SCRIPT });
    const run = fakeRun({ commonDir: common, preflight: { status: 1, output: 'FAIL  x' } });
    const r = guard(hookInput("git -C /w/vitana-platform commit -m x && PR_TITLE='VTID-1 (s/l): x' git -C /w/vitana-platform push origin HEAD:refs/heads/kiro/s/l"),
      { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /pre-push/);
    assert.equal(run.calls.filter((x) => x.cmd === process.execPath).length, 0, 'no preflight');
    assert.equal(run.calls.filter((x) => x.cmd === 'gh').length, 0, 'no PR/title lookup');
    assert.equal(run.calls.filter((x) => x.cmd === 'npx').length, 0, 'no commit typecheck in the PreToolUse guard');
    assert.ok(!existsSync(path.join(f.cache, 'preflight-ok')), 'no pass-cache write');
  } finally { f.done(); }
});

test('guard: `commit && push` into a checkout without the marked pre-push hook still blocks (nothing would check the new commit)', () => {
  const f = fixture();
  try {
    const run = fakeRun({ commonDir: path.join(f.dir, 'no-hooks') });
    const r = guard(hookInput('git commit -m x && git push origin kiro/s/l', '/w/vitana-platform'), { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /kiro-web-session\.mjs setup/);
  } finally { f.done(); }
});

test('guard runs no gateway typecheck at `git commit` any more (the git pre-commit hook does it)', () => {
  const f = fixture();
  try {
    const run = fakeRun({ staged: 'services/gateway/src/a.ts', unstaged: 'services/gateway/src/a.ts', tsc: { status: 2, output: 'src/a.ts(1,1): error TS2322: x' } });
    const r = guard(hookInput('git commit -m x', '/w/vitana-platform'), { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 0);
    assert.equal(run.calls.filter((x) => x.cmd === 'npx' || x.cmd === 'npm').length, 0);
  } finally { f.done(); }
});

test('guard never blocks on its own internal error', () => {
  const f = fixture();
  try {
    assert.equal(guard('{broken', { run: fakeRun(), cacheDir: f.cache, platformRoot: f.platform }).code, 0);
    const boom = () => { throw new Error('spawn failed'); };
    const r = guard(hookInput('git push origin kiro/s/l'), { run: boom, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /internal error/);
    const cli = spawnSync(process.execPath, [SCRIPT, 'guard'], { input: '{bad', encoding: 'utf8',
      env: { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache } });
    assert.equal(cli.status, 0);
  } finally { f.done(); }
});

// ---------------------------------------------------------------- PR body: PR_BODY_FILE, open PR body, --body-file support
function validatorFixture(f, { supports = true } = {}) {
  mkdirSync(path.join(f.platform, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(f.platform, '.github', 'workflows', 'VALIDATOR-CHECK.yml'), VALIDATOR_YML);
  writeFileSync(path.join(f.platform, 'scripts', 'collab', 'preflight.mjs'), supports ? "const o = ['body-file'];\n" : '// old preflight\n');
  const bodyFile = path.join(f.dir, 'body.md');
  writeFileSync(bodyFile, 'VALIDATION_PROFILE: gateway_backend\n');
  return bodyFile;
}

test('first push with PR_BODY_FILE reaches preflight as --body-file; without it (VALIDATOR-CHECK applies, no PR) the push is blocked naming PR_BODY_FILE', () => {
  const f = fixture();
  try {
    const bodyFile = validatorFixture(f);
    const run = fakeRun({ top: f.platform, title: '', changed: 'docs/validation/VTID-1/acceptance.md' });
    const r = guard(hookInput(`PR_TITLE='VTID-1 (s/l): x' PR_BODY_FILE=${bodyFile} git -C ${f.platform} push origin kiro/s/l`),
      { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 0, r.stderr);
    const pf = run.calls.find((x) => x.cmd === process.execPath);
    assert.equal(pf.args[pf.args.indexOf('--body-file') + 1], bodyFile);

    const f2 = fixture();
    try {
      validatorFixture(f2);
      const run2 = fakeRun({ top: f2.platform, title: '', changed: 'docs/validation/VTID-1/acceptance.md' });
      const r2 = guard(hookInput(`PR_TITLE='VTID-1 (s/l): x' git -C ${f2.platform} push origin kiro/s/l`),
        { run: run2, cacheDir: f2.cache, platformRoot: f2.platform, exists: () => true });
      assert.equal(r2.code, 2);
      assert.match(r2.stderr, /PR_BODY_FILE=/);
      assert.match(r2.stderr, /pr-body/);
      assert.equal(run2.calls.filter((x) => x.cmd === process.execPath).length, 0);
    } finally { f2.done(); }
  } finally { f.done(); }
});

test('the open PR body is passed as --body-file when preflight supports it, and --body-file is never passed to a preflight without it', () => {
  const f = fixture();
  try {
    validatorFixture(f, { supports: true });
    const run = fakeRun({ top: f.platform, body: 'VALIDATION_PROFILE: gateway_backend\nSCOPE_ALLOWLIST: x', changed: 'docs/validation/VTID-1/a.md' });
    assert.equal(gitPrePush({ top: f.platform, stdin: `refs/heads/kiro/s/l ${SHA} refs/heads/kiro/s/l ${ZERO}\n`, run, cacheDir: f.cache, platformRoot: f.platform, env: {} }).code, 0);
    const pf = run.calls.find((x) => x.cmd === process.execPath);
    const bf = pf.args[pf.args.indexOf('--body-file') + 1];
    assert.match(readFileSync(bf, 'utf8'), /SCOPE_ALLOWLIST: x/);
  } finally { f.done(); }
  const f2 = fixture();
  try {
    const bodyFile = validatorFixture(f2, { supports: false });
    const run = fakeRun({ top: f2.platform, changed: 'docs/validation/VTID-1/a.md' });
    assert.equal(gitPrePush({ top: f2.platform, stdin: `refs/heads/kiro/s/l ${SHA} refs/heads/kiro/s/l ${ZERO}\n`, run, cacheDir: f2.cache,
      platformRoot: f2.platform, env: { PR_BODY_FILE: bodyFile } }).code, 0);
    const pf = run.calls.find((x) => x.cmd === process.execPath);
    assert.ok(!pf.args.includes('--body-file'));
  } finally { f2.done(); }
});

test('VALIDATOR-CHECK paths are read from the workflow and matched as globs', () => {
  assert.deepEqual(workflowPaths(VALIDATOR_YML), ['services/gateway/src/**', 'docs/validation/**']);
  assert.equal(globMatch('docs/validation/**', 'docs/validation/VTID-1/outputs/a.txt'), true);
  assert.equal(globMatch('services/gateway/src/**', 'services/gateway/test/a.ts'), false);
  assert.equal(globMatch('scripts/*.mjs', 'scripts/a/b.mjs'), false);
});

// ---------------------------------------------------------------- pr-body
test('pr-body prints the five declarations (defaults) and passes validator-path-guard --pr-body-check', () => {
  const f = fixture();
  try {
    const cli = spawnSync(process.execPath, [SCRIPT, 'pr-body', '--vtid', 'VTID-01234', '--scope', 'scripts/collab/a.mjs, docs/validation/VTID-01234/**',
      '--acceptance', 'docs/validation/VTID-01234/acceptance.md', '--payload', 'VTID-01234 (s/l): x. Deploys nothing.'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const out = path.join(f.dir, 'body.md');
    writeFileSync(out, cli.stdout);
    const chk = spawnSync(process.execPath, [PATH_GUARD, '--pr-body-check', out], { encoding: 'utf8' });
    assert.equal(chk.status, 0, chk.stdout);
    assert.equal(/VALIDATION_PROFILE:\s*([a-zA-Z0-9_/-]+)/.exec(cli.stdout)[1], 'gateway_backend', 'the first match is the real value');
    assert.equal(/OASIS_IMPACT:\s*(\w+)/.exec(cli.stdout)[1], 'no');
    assert.match(cli.stdout, /^SCOPE_ALLOWLIST: scripts\/collab\/a\.mjs, docs\/validation\/VTID-01234\/\*\*$/m);
    assert.match(cli.stdout, /^ACCEPTANCE: docs\/validation\/VTID-01234\/acceptance\.md$/m);
    assert.doesNotMatch(cli.stdout, /VTID-XXXXX/);
  } finally { f.done(); }
});

test('pr-body --profile command_hub_frontend --oasis yes passes the body check with those values; a bad profile is refused', () => {
  const f = fixture();
  try {
    const body = prBody({ vtid: 'VTID-01234', scope: 'services/gateway/src/frontend/**', acceptance: 'docs/validation/VTID-01234/acceptance.md',
      payload: 'Command Hub change', profile: 'command_hub_frontend', oasis: 'yes' });
    const out = path.join(f.dir, 'body.md');
    writeFileSync(out, body);
    assert.equal(spawnSync(process.execPath, [PATH_GUARD, '--pr-body-check', out], { encoding: 'utf8' }).status, 0);
    assert.equal(/VALIDATION_PROFILE:\s*([a-zA-Z0-9_/-]+)/.exec(body)[1], 'command_hub_frontend');
    assert.equal(/OASIS_IMPACT:\s*(\w+)/.exec(body)[1], 'yes');
    assert.throws(() => prBody({ vtid: 'VTID-1', scope: 'x', acceptance: 'y', payload: 'z', profile: 'other' }), /profile/);
    assert.throws(() => prBody({ vtid: 'VTID-1', scope: 'x', acceptance: 'y', payload: 'z', oasis: 'maybe' }), /oasis/);
  } finally { f.done(); }
});

// ---------------------------------------------------------------- git hooks: install, status
test('git hooks are installed in <git common dir>/hooks with the marker, executable; an unmarked hook is never overwritten', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiro-web-gh-'));
  try {
    const repo = gitRepo(path.join(dir, 'vitana-platform'));
    const wt = path.join(repo, '.agents', 'wt', 'lane');
    g(['worktree', 'add', '-q', '-b', 'kiro/s/l', wt], repo);
    const r = installGitHooks({ repos: [{ dir: repo }], script: SCRIPT });
    const hooks = path.join(repo, '.git', 'hooks');
    for (const k of ['pre-commit', 'pre-push']) {
      const p = path.join(hooks, k);
      assert.ok(readFileSync(p, 'utf8').split('\n').includes(GIT_HOOK_MARKER), k);
      assert.ok(statSync(p).mode & 0o111, `${k} executable`);
      assert.match(readFileSync(p, 'utf8'), new RegExp(`git-${k}`));
    }
    assert.deepEqual(r[0].written.sort(), ['pre-commit', 'pre-push']);
    assert.equal(GIT_HOOK_MARKER, '# generated by vitana-platform/scripts/collab/kiro-web-session.mjs');
    assert.deepEqual(installGitHooks({ repos: [{ dir: repo }], script: SCRIPT })[0].written, [], 'second install is a no-op');
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho mine\n');
    const r2 = installGitHooks({ repos: [{ dir: repo }], script: SCRIPT });
    assert.deepEqual(r2[0].skipped, ['pre-commit']);
    assert.equal(readFileSync(path.join(hooks, 'pre-commit'), 'utf8'), '#!/bin/sh\necho mine\n');
    // the linked worktree uses the same hooks (common dir), nothing is written inside it
    assert.ok(!existsSync(path.join(wt, '.git', 'hooks')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status: git-hooks is a required item and fails for a missing, unmarked or non-executable hook', () => {
  const f = fixture();
  try {
    const common = path.join(f.dir, 'common');
    const repos = [{ dir: '/w/vitana-platform', slug: 'exafyltd/vitana-platform', name: 'vitana-platform' }];
    const st = () => statusReport({ workspace: f.ws, platformRoot: f.platform, cacheDir: f.cache, env: {}, run: fakeRun({ commonDir: common, title: 'login' }), repos })
      .items.find((i) => i.name === 'git-hooks');
    assert.equal(st().ok, false);
    assert.equal(st().required, true);
    installGitHooks({ repos, run: fakeRun({ commonDir: common }), script: SCRIPT });
    assert.equal(st().ok, true, st().detail);
    chmodSync(path.join(common, 'hooks', 'pre-push'), 0o644);
    assert.equal(st().ok, false);
    assert.match(st().detail, /pre-push/);
    writeFileSync(path.join(common, 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(common, 'hooks', 'pre-push'), 0o755);
    assert.equal(st().ok, false);
    assert.match(st().detail, /marker|unmarked/);
    assert.equal(gitHooksState({ repos, run: fakeRun({ commonDir: common }) }).ok, false);
  } finally { f.done(); }
});

// ---------------------------------------------------------------- git-pre-commit
test('git-pre-commit: staged gateway file + tsc error → exit 1 with the errors; clean → 0; no gateway file → no tsc', () => {
  const f = fixture();
  try {
    const top = '/w/vitana-platform';
    const bad = fakeRun({ staged: 'services/gateway/src/a.ts', tsc: { status: 2, output: 'src/a.ts(1,7): error TS2322: Type string is not assignable to number.\nmore' } });
    const r1 = gitPreCommit({ top, run: bad, cacheDir: f.cache, exists: () => true, env: {} });
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /error TS2322/);
    const tscCall = bad.calls.find((x) => x.cmd === 'npx');
    assert.equal(tscCall.cwd, path.join(top, 'services', 'gateway'));
    assert.ok(tscCall.args.includes('--noEmit') && tscCall.args.includes('--incremental'));
    assert.ok(tscCall.args[tscCall.args.indexOf('--tsBuildInfoFile') + 1].startsWith(path.join(f.cache, 'tsc')));
    assert.equal(gitPreCommit({ top, run: fakeRun({ staged: 'services/gateway/src/a.ts' }), cacheDir: f.cache, exists: () => true, env: {} }).code, 0);
    const none = fakeRun({ staged: '' });
    assert.equal(gitPreCommit({ top, run: none, cacheDir: f.cache, exists: () => true, env: {} }).code, 0);
    assert.equal(none.calls.filter((x) => x.cmd === 'npx').length, 0, 'no gateway file, no typecheck');
  } finally { f.done(); }
});

test('git-pre-commit: an unstaged gateway type error also blocks and names the unstaged file', () => {
  const f = fixture();
  try {
    const run = fakeRun({ staged: 'services/gateway/src/a.ts', unstaged: 'services/gateway/src/b.ts', tsc: { status: 2, output: 'src/b.ts(1,1): error TS2322: x' } });
    const r = gitPreCommit({ top: '/w/vitana-platform', run, cacheDir: f.cache, exists: () => true, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unstaged/i);
    assert.match(r.stderr, /services\/gateway\/src\/b\.ts/);
  } finally { f.done(); }
});

test('git-pre-commit in a linked worktree without node_modules runs npm ci there before tsc; an npm ci failure does not block', () => {
  const f = fixture();
  try {
    const top = '/w/vitana-platform/.agents/wt/lane';
    const run = fakeRun({ top, staged: 'services/gateway/src/a.ts' });
    const exists = (p) => !p.endsWith('node_modules');
    assert.equal(gitPreCommit({ top, run, cacheDir: f.cache, exists, env: {} }).code, 0);
    const order = run.calls.filter((c) => c.cmd === 'npm' || c.cmd === 'npx');
    assert.deepEqual(order.map((c) => c.cmd), ['npm', 'npx']);
    assert.deepEqual(order[0].args.slice(0, 1), ['ci']);
    assert.equal(order[0].cwd, path.join(top, 'services', 'gateway'));
    const failing = fakeRun({ top, staged: 'services/gateway/src/a.ts', npm: { status: 1, output: 'npm ERR! network' }, tsc: { status: 2, output: 'error TS1' } });
    const r = gitPreCommit({ top, run: failing, cacheDir: f.cache, exists, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /npm ci failed/);
    assert.equal(failing.calls.filter((c) => c.cmd === 'npx').length, 0);
  } finally { f.done(); }
});

test('git-pre-commit never blocks on its own internal error', () => {
  const f = fixture();
  try {
    const r = gitPreCommit({ top: '/w', run: () => { throw new Error('boom'); }, cacheDir: f.cache, exists: () => true, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /internal error/);
  } finally { f.done(); }
});

test('REAL GIT race: a background writer edits a gateway file after the PreToolUse check and before `git add`; the installed pre-commit hook still blocks', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiro-web-race-'));
  try {
    const repo = gitRepo(path.join(dir, 'vitana-platform'));
    const cache = path.join(dir, 'cache');
    installGitHooks({ repos: [{ dir: repo }], script: SCRIPT });
    // fake tsc: reports an error for every line containing BAD under src/ (reads the working tree, as tsc does)
    const fakeTsc = 'if grep -rn BAD src >/dev/null; then echo "src/a.ts(2,1): error TS2322: Type string is not assignable to type number."; exit 2; fi; exit 0';
    const env = { VITANA_KIRO_WEB_CACHE: cache, VITANA_KIRO_WEB_TSC: fakeTsc };
    writeFileSync(path.join(repo, 'services', 'gateway', 'src', 'a.ts'), 'export const a: number = 2;\n');
    const cmd = `git -C ${repo} add -A && git -C ${repo} commit -m change`;
    // background writer: lands after the PreToolUse check below
    const writer = spawn('sh', ['-c', `sleep 0.3; echo 'export const BAD: number = "x";' >> ${path.join(repo, 'services', 'gateway', 'src', 'a.ts')}`]);
    const pre = guard(hookInput(cmd, repo), { cacheDir: cache });
    assert.equal(pre.code, 0, 'the PreToolUse check passes: the tree was clean when it ran');
    await new Promise((res) => writer.on('exit', res));
    const before = g(['rev-parse', 'HEAD'], repo).stdout.trim();
    const gitEnv = { ...process.env, ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: gitEnv });
    assert.notEqual(r.status, 0, 'the commit is blocked');
    assert.match(r.stderr, /error TS2322/);
    assert.equal(g(['rev-parse', 'HEAD'], repo).stdout.trim(), before, 'no commit was created');
    // fixed → the same commit goes through
    writeFileSync(path.join(repo, 'services', 'gateway', 'src', 'a.ts'), 'export const a: number = 2;\n');
    const ok = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: gitEnv });
    assert.equal(ok.status, 0, ok.stderr);
    assert.notEqual(g(['rev-parse', 'HEAD'], repo).stdout.trim(), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- git-pre-push
test('git-pre-push: stdin parsing — lane refs checked on the pushed sha, non-lane refs and deletions ignored, failing preflight → exit 1', () => {
  const f = fixture();
  try {
    const stdin = [`refs/heads/main ${SHA} refs/heads/main ${ZERO}`, `refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}`,
      `(delete) ${ZERO} refs/heads/kiro/s/old ${OTHER_SHA}`, `HEAD ${SHA} refs/heads/collab-claim/s/l ${ZERO}`].join('\n');
    const quiet = fakeRun();
    assert.equal(gitPrePush({ top: '/w/vitana-platform', stdin, run: quiet, cacheDir: f.cache, platformRoot: f.platform, env: {} }).code, 0);
    assert.equal(quiet.calls.filter((c) => c.cmd === process.execPath).length, 0, 'nothing to check');
    const bad = fakeRun({ preflight: { status: 1, output: 'FAIL  Lane scope [required]\n  - x leaves its paths' } });
    const r = gitPrePush({ top: '/w/vitana-platform', stdin: `${stdin}\nHEAD ${SHA} refs/heads/kiro/s/l ${ZERO}\n`, run: bad, cacheDir: f.cache,
      platformRoot: f.platform, env: { PR_TITLE: 'VTID-1 (s/l): x' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Lane scope/);
    const pf = bad.calls.find((c) => c.cmd === process.execPath);
    assert.equal(pf.args[pf.args.indexOf('--head') + 1], SHA);
    assert.equal(pf.args[pf.args.indexOf('--title') + 1], 'VTID-1 (s/l): x');
    assert.equal(bad.calls.filter((c) => c.cmd === 'gh').length, 0, 'PR_TITLE from the environment needs no lookup');
  } finally { f.done(); }
});

test('git-pre-push shares the pass cache with the PreToolUse guard and never blocks on an internal error', () => {
  const f = fixture();
  try {
    const run = fakeRun();
    guard(hookInput('git -C /w/vitana-platform push origin kiro/s/l'), { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    const again = fakeRun();
    assert.equal(gitPrePush({ top: '/w/vitana-platform', stdin: `HEAD ${SHA} refs/heads/kiro/s/l ${ZERO}\n`, run: again, cacheDir: f.cache, platformRoot: f.platform, env: {} }).code, 0);
    assert.equal(again.calls.filter((c) => c.cmd === process.execPath).length, 0);
    const r = gitPrePush({ top: '/w', stdin: `HEAD ${SHA} refs/heads/kiro/s/l ${ZERO}\n`, run: () => { throw new Error('boom'); }, cacheDir: f.cache, platformRoot: f.platform, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /internal error/);
  } finally { f.done(); }
});

test('REAL GIT: a push the PreToolUse parser cannot read (heredoc with an apostrophe) is still checked by pre-push, on the new commit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiro-web-push-'));
  try {
    const ws = path.join(dir, 'ws');
    const platform = path.join(ws, 'fake-platform');
    mkdirSync(path.join(platform, 'scripts', 'collab'), { recursive: true });
    const log = path.join(dir, 'preflight-args.txt');
    writeFileSync(path.join(platform, 'scripts', 'collab', 'preflight.mjs'),
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log('FAIL  Lane scope [required]');\nprocess.exit(1);\n`);
    const repo = gitRepo(path.join(ws, 'vitana-platform'), { gateway: false });
    const bare = path.join(dir, 'remote.git');
    g(['init', '-q', '--bare', bare], dir);
    g(['remote', 'set-url', 'origin', bare], repo);
    g(['push', '-q', 'origin', 'main'], repo);
    installGitHooks({ repos: [{ dir: repo }], script: SCRIPT });
    const env = { ...process.env, VITANA_KIRO_WEB_CACHE: path.join(dir, 'cache'), VITANA_KIRO_WEB_PLATFORM: platform,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const cmd = [`cd ${repo}`, "cat > notes.md <<'EOF'", "it's a note", 'EOF', 'git add notes.md',
      "git commit -q -m 'notes' && PR_TITLE='VTID-1 (s/l): x' git push -q origin HEAD:refs/heads/kiro/s/l"].join('\n');
    const pre = guard(hookInput(cmd, repo), { cacheDir: path.join(dir, 'cache'), platformRoot: platform });
    assert.equal(pre.code, 0);
    assert.ok(!existsSync(log), 'the PreToolUse guard ran no preflight');
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env });
    assert.notEqual(r.status, 0, 'the push is blocked by pre-push');
    assert.match(r.stderr, /Lane scope/);
    const head = g(['rev-parse', 'HEAD'], repo).stdout.trim();
    const args = readFileSync(log, 'utf8');
    assert.ok(args.includes(`--head ${head}`), 'preflight judged the NEW commit');
    assert.equal(g(['ls-remote', bare, 'refs/heads/kiro/s/l'], repo).stdout.trim(), '', 'nothing reached the remote');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- wait
function fakeGh(seq, logs = 'log line 1\nlog line 2') {
  const calls = [];
  let i = 0;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'run') return { status: 0, output: logs };
    const runs = seq[Math.min(i++, seq.length - 1)];
    return { status: 0, output: JSON.stringify({ total_count: runs.length, check_runs: runs }) };
  };
  gh.calls = calls;
  return gh;
}
const cr = (name, status, conclusion = null, id = 77) => ({ name, status, conclusion, html_url: `https://x/${name}`,
  details_url: `https://github.com/exafyltd/vitana-platform/actions/runs/${id}/job/9` });

test('wait returns 0 once every check run completed green, polling at the given interval', () => {
  let slept = 0;
  const gh = fakeGh([[cr('a', 'in_progress')], [cr('a', 'completed', 'success'), cr('b', 'completed', 'skipped')]]);
  const r = waitChecks({ repo: 'exafyltd/vitana-platform', sha: SHA, timeout: 600, interval: 120 },
    { gh, sleep: (ms) => { slept += ms; }, now: (() => { let t = 0; return () => (t += 1000); })() });
  assert.equal(r.code, 0);
  assert.equal(slept, 120000);
});

test('wait returns 1 with the failed run name, link and log tail', () => {
  const gh = fakeGh([[cr('Lane scope', 'completed', 'failure', 4242), cr('unit', 'completed', 'success')]], 'x\n##[error] lane leaves its paths');
  const r = waitChecks({ repo: 'exafyltd/vitana-platform', sha: SHA, timeout: 600, interval: 120 }, { gh, sleep: () => {}, now: () => 0 });
  assert.equal(r.code, 1);
  assert.match(r.report, /Lane scope/);
  assert.match(r.report, /lane leaves its paths/);
  assert.ok(gh.calls.some((a) => a[0] === 'run' && a.includes('4242') && a.includes('--log-failed')));
});

test('wait returns 3 on timeout naming what is still pending (and waits while no run exists yet)', () => {
  let t = 0;
  const gh = fakeGh([[], [cr('spar', 'in_progress')]]);
  const r = waitChecks({ repo: 'exafyltd/vitana-platform', sha: SHA, timeout: 300, interval: 120 },
    { gh, sleep: (ms) => { t += ms; }, now: () => t });
  assert.equal(r.code, 3);
  assert.match(r.report, /spar/);
});

// ---------------------------------------------------------------- status
test('status reports missing hooks as required failures; --check --json exits 1 naming them', () => {
  const f = fixture();
  try {
    const run = () => ({ status: 0, output: 'login' });
    const rep = statusReport({ workspace: f.ws, platformRoot: f.platform, cacheDir: f.cache, env: {}, run });
    const hooks = rep.items.find((i) => i.name === 'hooks');
    assert.equal(hooks.ok, false);
    assert.equal(hooks.required, true);
    assert.equal(rep.ok, false);
    const tokens = rep.items.find((i) => i.name === 'tokens');
    assert.ok(!JSON.stringify(tokens).includes('secret-value'));
    const cli = spawnSync(process.execPath, [SCRIPT, 'status', '--check', '--json', '--workspace', f.ws], { encoding: 'utf8',
      env: { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache, VITANA_KIRO_WEB_PLATFORM: f.platform, DEV_MEMORY_PACK_TOKEN: 'secret-value' } });
    assert.equal(cli.status, 1);
    const j = JSON.parse(cli.stdout);
    assert.ok(j.items.some((i) => i.name === 'hooks' && !i.ok));
    assert.ok(!cli.stdout.includes('secret-value'), 'a token value is never printed');
    writeHooks({ workspace: f.ws, platformRoot: f.platform });
    copyReviewer({ workspace: f.ws, platformRoot: f.platform });
    const rep2 = statusReport({ workspace: f.ws, platformRoot: f.platform, cacheDir: f.cache, env: {}, run });
    assert.equal(rep2.items.find((i) => i.name === 'hooks').ok, true);
    assert.equal(rep2.items.find((i) => i.name === 'reviewer-agent').ok, true);
  } finally { f.done(); }
});

test('status: the hooks message lists exactly the generated hook names (from hookDefs)', () => {
  const f = fixture();
  try {
    writeHooks({ workspace: f.ws, platformRoot: f.platform });
    const item = statusReport({ workspace: f.ws, platformRoot: f.platform, cacheDir: f.cache, env: {}, run: () => ({ status: 0, output: 'x' }), repos: [] })
      .items.find((i) => i.name === 'hooks');
    const names = hookDefs({ platformRoot: f.platform }).map((d) => d.json.hooks[0].name);
    assert.ok(item.detail.startsWith(`${names.join(' + ')} in `), item.detail);
    assert.doesNotMatch(item.detail, /mark-dirty/);
  } finally { f.done(); }
});

test('status: installs is not ready while a step stamp is missing or older than setup.start, naming the steps', () => {
  const f = fixture();
  try {
    const st = () => statusReport({ workspace: f.ws, platformRoot: f.platform, cacheDir: f.cache, env: {}, run: () => ({ status: 0, output: 'x' }), repos: [] })
      .items.find((i) => i.name === 'installs');
    assert.equal(st().ok, false);
    assert.match(st().detail, /never ran|setup\.start/);
    const t0 = '2026-10-28T10:00:00.000Z';
    writeFileSync(path.join(f.cache, 'setup.start'), `${t0}\n`);
    writeFileSync(path.join(f.cache, 'steering.done'), '2026-10-28T10:00:01.000Z\n');
    writeFileSync(path.join(f.cache, 'hooks.done'), '2026-10-28T09:00:00.000Z\n'); // older than setup.start → missing
    assert.equal(st().ok, false);
    assert.match(st().detail, /hooks/);
    assert.match(st().detail, /codeintel/);
    assert.doesNotMatch(st().detail.split('missing')[1] || '', /steering/);
    writeFileSync(path.join(f.cache, 'hooks.done'), '2026-10-28T10:00:02.000Z\n');
    writeFileSync(path.join(f.cache, 'codeintel.skipped'), '2026-10-28T10:00:03.000Z\n');
    assert.equal(st().ok, true, st().detail);
  } finally { f.done(); }
});

test('status: workspace steering is the kiro-web-steering --check result when the generator exists', () => {
  const f = fixture();
  try {
    const gen = path.join(f.platform, 'scripts', 'collab', 'kiro-web-steering.mjs');
    const calls = [];
    const run = (code) => (cmd, args) => { calls.push(args); return args.includes('--check') ? { status: code, output: code ? 'stale: x.md' : 'ok' } : { status: 0, output: 'login' }; };
    writeFileSync(gen, '// fake');
    const bad = statusReport({ workspace: f.ws, platformRoot: f.platform, cacheDir: f.cache, env: {}, run: run(1), repos: [] });
    const item = bad.items.find((i) => i.name === 'workspace-steering');
    assert.equal(item.ok, false);
    assert.match(item.detail, /stale: x\.md/);
    assert.ok(calls.some((a) => a[0] === gen && a.includes('--check') && a.includes(f.ws)));
    const good = statusReport({ workspace: f.ws, platformRoot: f.platform, cacheDir: f.cache, env: {}, run: run(0), repos: [] });
    assert.equal(good.items.find((i) => i.name === 'workspace-steering').ok, true);
  } finally { f.done(); }
});

// ---------------------------------------------------------------- setup: steering first, foreground, stamps, EPIPE
function fakeGenerator(f) {
  const log = path.join(f.dir, 'gen-calls.txt');
  writeFileSync(path.join(f.platform, 'scripts', 'collab', 'kiro-web-steering.mjs'), [
    "import { appendFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';",
    'const a = process.argv.slice(2); const ws = a[a.indexOf("--workspace") + 1];',
    `appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n');`,
    "const flag = ws + '/.kiro/steering/generated.md';",
    "if (a.includes('--check')) process.exit(existsSync(flag) ? 0 : 1);",
    "mkdirSync(ws + '/.kiro/steering', { recursive: true }); writeFileSync(flag, 'x'); console.log('kiro-web-steering: ok');", ''].join('\n'));
  return log;
}

test('setup runs the steering generator first, writes setup.start and the step stamps, and deletes the stale mark-dirty hook', () => {
  const f = fixture();
  try {
    const log = fakeGenerator(f);
    const hooks = path.join(f.ws, '.kiro', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(path.join(hooks, 'vitana-web-dirty.json'), JSON.stringify({ version: 'v1', generatedBy: MARKER, hooks: [] }));
    const cli = spawnSync(process.execPath, [SCRIPT, 'setup', '--no-install', '--workspace', f.ws], { encoding: 'utf8',
      env: { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache, VITANA_KIRO_WEB_PLATFORM: f.platform } });
    assert.equal(cli.status, 0, cli.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls[0].includes('--workspace') && calls[0].includes(f.ws) && !calls[0].includes('--check'), 'the generator wrote the steering');
    assert.ok(existsSync(path.join(f.ws, '.kiro', 'steering', 'generated.md')));
    const start = readFileSync(path.join(f.cache, 'setup.start'), 'utf8').trim();
    assert.match(start, /^\d{4}-\d\d-\d\dT/);
    assert.ok(readFileSync(path.join(f.cache, 'steering.done'), 'utf8').trim() >= start);
    assert.ok(!existsSync(path.join(hooks, 'vitana-web-dirty.json')));
    assert.match(cli.stdout, /steering: ok/);
  } finally { f.done(); }
});

test('setup --no-install never fetches the morning pack (no network), even with the token set', () => {
  const f = fixture();
  try {
    const cli = spawnSync(process.execPath, [SCRIPT, 'setup', '--no-install', '--workspace', f.ws], { encoding: 'utf8',
      env: { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache, VITANA_KIRO_WEB_PLATFORM: f.platform, DEV_MEMORY_PACK_TOKEN: 'secret-value',
        DEV_MEMORY_PACK_URL: 'http://127.0.0.1:9' } });
    assert.equal(cli.status, 0);
    assert.doesNotMatch(cli.stdout, /morning pack/);
    assert.doesNotMatch(cli.stdout + cli.stderr, /secret-value/);
    assert.ok(existsSync(path.join(f.ws, '.kiro', 'hooks', 'vitana-web-guard.json')));
  } finally { f.done(); }
});

test('setup runs every install in the foreground (no detached child); --no-codeintel skips only the venv and index build', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /detached:\s*true/);
  const repos = [{ dir: '/w/vitana-platform', slug: 'exafyltd/vitana-platform', name: 'vitana-platform' }];
  const full = installScript({ repos, cacheDir: '/c', codeintelDir: '/ci', platformRoot: '/w/vitana-platform' });
  assert.match(full, /npm ci/);
  assert.match(full, /repowise/);
  assert.match(full, /session-setup\.sh/);
  assert.match(full, /codeintel\.done/);
  assert.match(full, /deps-[^ ]*\.done/);
  const lite = installScript({ repos, cacheDir: '/c', codeintelDir: '/ci', platformRoot: '/w/vitana-platform', codeintel: false });
  assert.match(lite, /npm ci/);
  assert.doesNotMatch(lite, /repowise|session-setup\.sh/);
  assert.match(lite, /codeintel\.skipped/);
});

test('setup output survives a closed pipe (no EPIPE crash)', () => {
  const f = fixture();
  try {
    const r = spawnSync('bash', ['-c', `"${process.execPath}" "${SCRIPT}" setup --no-install --workspace "${f.ws}" 2>"${f.dir}/err" | head -c 1 >/dev/null; echo "rc=\${PIPESTATUS[0]}"`],
      { encoding: 'utf8', env: { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache, VITANA_KIRO_WEB_PLATFORM: f.platform } });
    assert.match(r.stdout, /rc=0/);
    assert.doesNotMatch(readFileSync(path.join(f.dir, 'err'), 'utf8'), /EPIPE/);
  } finally { f.done(); }
});

// ---------------------------------------------------------------- refresh
test('refresh regenerates stale steering, hooks and git hooks, logs one line, and is silent when ready', () => {
  const f = fixture();
  try {
    fakeGenerator(f);
    gitRepo(f.platform, { gateway: true });
    const env = { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache, VITANA_KIRO_WEB_PLATFORM: f.platform };
    const r1 = spawnSync(process.execPath, [SCRIPT, 'refresh', '--workspace', f.ws], { encoding: 'utf8', env });
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /fixed .*steering/);
    assert.ok(existsSync(path.join(f.ws, '.kiro', 'steering', 'generated.md')));
    assert.ok(existsSync(path.join(f.ws, '.kiro', 'hooks', 'vitana-web-guard.json')));
    assert.ok(readFileSync(path.join(f.platform, '.git', 'hooks', 'pre-push'), 'utf8').includes(GIT_HOOK_MARKER));
    const r2 = spawnSync(process.execPath, [SCRIPT, 'refresh', '--workspace', f.ws], { encoding: 'utf8', env });
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout, '', `silent when ready: ${r2.stdout}`);
    assert.equal(readFileSync(path.join(f.cache, 'refresh.log'), 'utf8').trim().split('\n').length, 2);
    const r3 = refresh({ workspace: f.ws, platformRoot: f.platform, cacheDir: f.cache, run: () => { throw new Error('x'); } });
    assert.equal(typeof r3.line, 'string', 'never throws');
  } finally { f.done(); }
});

// ---------------------------------------------------------------- misc (unchanged)
test('the preflight failure shown to the agent drops the queue table and keeps every FAIL line', () => {
  const out = ['preflight vitana-platform /w', '  base x  head y', 'FAIL  Collab handoff [required]', '      <details><summary>queue</summary>',
    ...Array.from({ length: 200 }, (_, i) => `      | r | p | s${i} | l | | ready |`), '      </details>',
    '      lane preflight: illegal transition done → ready', 'FAIL  Lane scope [required]', 'PASS  Kiro steering', 'preflight: 2 check(s) failed'].join('\n');
  const c = condensePreflight(out);
  assert.doesNotMatch(c, /\| s1 /);
  assert.match(c, /illegal transition done → ready/);
  assert.match(c, /FAIL  Lane scope/);
  assert.match(c, /^preflight vitana-platform/);
});

test('only the ci-plan-spar _plan-session false positive passes; every other Collab handoff or FAIL line blocks', () => {
  const pf = (body, extra = '') => ['preflight vitana-platform /w', 'FAIL  Collab handoff [required]', '      ❌ **collab handoff** — 1 problem(s):',
    ...body.map((b) => `      - ${b}`), extra, 'PASS  Lane scope [required]', 'preflight: 1 check(s) failed'].filter(Boolean).join('\n');
  const fp = 'lane s/_plan: commits from 2 sessions (ci-plan-spar, kiro-exafy-202610261526-5cd7) — one session per lane';
  assert.equal(onlyPlanSparSessionFalsePositive(pf([fp])), true);
  assert.equal(onlyPlanSparSessionFalsePositive(pf([fp, '.kiro/specs/s/lanes/l.md: "done" is terminal'])), false);
  assert.equal(onlyPlanSparSessionFalsePositive(pf(['lane s/l: commits from 2 sessions (ci-plan-spar, kiro-x-202610261526-5cd7) — one session per lane'])), false, 'a work lane is never exempt');
  assert.equal(onlyPlanSparSessionFalsePositive(pf(['lane s/_plan: commits from 2 sessions (kiro-a-202610261526-5cd7, kiro-b-202610261526-5cd8) — one session per lane'])), false, 'two planners are a real violation');
  assert.equal(onlyPlanSparSessionFalsePositive(pf([fp], 'FAIL  Lane scope [required]')), false);
  const f = fixture();
  try {
    const run = fakeRun({ preflight: { status: 1, output: pf([fp]) } });
    const r = guard(hookInput('git -C /w/vitana-platform push origin kiro/s/plan'), { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /false positive/);
  } finally { f.done(); }
});

test('from a linked worktree the workspace is the main checkout\'s parent, and worktrees are never taken as repos', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiro-web-ws-'));
  try {
    const ws = path.join(dir, 'ws');
    const main = gitRepo(path.join(ws, 'vitana-platform'), { gateway: false });
    const wt = path.join(main, '.agents', 'wt', 'lane');
    g(['worktree', 'add', '-q', '-b', 'kiro/s/l', wt], main);
    assert.equal(defaultWorkspace(wt), ws);
    assert.equal(defaultWorkspace(main), ws);
    assert.deepEqual(findRepos(ws).map((r) => r.name), ['vitana-platform']);
    assert.deepEqual(findRepos(path.dirname(wt)), [], 'a worktree folder holds no main checkout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI writes every block to last-block.txt (the main session may show a blocked command as {})', () => {
  const f = fixture();
  try {
    const repo = path.join(f.dir, 'repo');
    mkdirSync(repo);
    g(['init', '-q', '-b', 'kiro/s/l'], repo);
    g([...ID, 'commit', '-q', '--allow-empty', '-m', 'x'], repo);
    g(['remote', 'add', 'origin', path.join(f.dir, 'nowhere.git')], repo);
    const cli = spawnSync(process.execPath, [SCRIPT, 'guard'], { encoding: 'utf8',
      input: hookInput(`git -C ${repo} push origin HEAD:refs/heads/kiro/s/l`, repo),
      env: { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache, VITANA_KIRO_WEB_PLATFORM: f.platform } });
    assert.equal(cli.status, 2);
    assert.match(readFileSync(path.join(f.cache, 'last-block.txt'), 'utf8'), /PR_TITLE=/);
  } finally { f.done(); }
});

test('guard preflights every kiro/** and claude/** branch, not only kiro/<slug>/<lane>', () => {
  const f = fixture();
  try {
    for (const b of ['kiro/s-v2', 'claude/s/l', 'kiro/a/b/c']) {
      const run = fakeRun({ preflight: { status: 1, output: 'FAIL  Lane scope [required]' } });
      const r = guard(hookInput(`git -C /w/vitana-platform push origin HEAD:refs/heads/${b}`), { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
      assert.equal(r.code, 2, b);
    }
    const run = fakeRun();
    assert.equal(guard(hookInput('git push origin feature/x'), { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true }).code, 0);
    assert.equal(run.calls.filter((c) => c.cmd === process.execPath).length, 0);
  } finally { f.done(); }
});
