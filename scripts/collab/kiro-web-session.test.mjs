// Tests for scripts/collab/kiro-web-session.mjs (plan kiro-web-parity, lane session-kit, plan §4 cases 1-7).
// Run: node --test scripts/collab/kiro-web-session.test.mjs
// Fixtures live in temp dirs only; no network, no real git push, no real preflight or tsc (runners are injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKER, condensePreflight, onlyPlanSparSessionFalsePositive, defaultWorkspace, findRepos, hookDefs, writeHooks, copyReviewer, markDirty, dirtyFile, parseCommand, guard, waitChecks, statusReport,
} from './kiro-web-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'kiro-web-session.mjs');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

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
  tsc = { status: 0, output: '' }, title = 'VTID-12345 (s/l): x', nodeModules = true, gwDiff = '' } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const a = args.join(' ');
    if (cmd === 'git' && a.includes('rev-parse --show-toplevel')) return { status: 0, output: top };
    if (cmd === 'git' && a.includes('rev-parse --verify')) {
      const ref = args[args.length - 1].replace(/\^\{commit\}$/, '');
      return { status: 0, output: /^[0-9a-f]{40}$/.test(ref) ? ref : head };
    }
    if (cmd === 'git' && a.includes('remote get-url origin')) return { status: 0, output: 'https://github.com/exafyltd/vitana-platform.git' };
    if (cmd === 'git' && a.includes('fetch')) return { status: 0, output: '' };
    if (cmd === 'git' && a.includes('diff --name-only HEAD')) return { status: 0, output: gwDiff };
    if (cmd === 'gh') return { status: 0, output: title };
    if (cmd === process.execPath && a.includes('preflight.mjs')) return preflight;
    if (cmd === 'npx' && a.includes('tsc')) return tsc;
    if (cmd === 'npm') return { status: 0, output: 'added' };
    return { status: 0, output: '' };
  };
  run.calls = calls;
  run.nodeModules = nodeModules;
  return run;
}

// ---------------------------------------------------------------- case 1-2: setup writes hooks + reviewer copy
test('setup writes exactly the two marked hook files, one entry each, with the right trigger/matcher/command', () => {
  const f = fixture();
  try {
    const r = writeHooks({ workspace: f.ws, platformRoot: f.platform });
    const dir = path.join(f.ws, '.kiro', 'hooks');
    assert.deepEqual(readdirSync(dir).sort(), ['vitana-web-dirty.json', 'vitana-web-guard.json']);
    assert.deepEqual(r.written.sort(), ['vitana-web-dirty.json', 'vitana-web-guard.json']);
    const g = JSON.parse(readFileSync(path.join(dir, 'vitana-web-guard.json'), 'utf8'));
    const d = JSON.parse(readFileSync(path.join(dir, 'vitana-web-dirty.json'), 'utf8'));
    for (const h of [g, d]) {
      assert.equal(h.generatedBy, MARKER);
      assert.equal(h.version, 'v1');
      assert.equal(h.hooks.length, 1, 'only the first hook entry of a file runs in Kiro Web');
      assert.equal(h.hooks[0].action.type, 'command');
      assert.ok(h.hooks[0].action.command.includes(path.join(f.platform, 'scripts', 'collab', 'kiro-web-session.mjs')));
    }
    assert.equal(g.hooks[0].trigger, 'PreToolUse');
    assert.equal(g.hooks[0].matcher, '^execute_bash$');
    assert.match(g.hooks[0].action.command, / guard$/);
    assert.ok(g.hooks[0].action.timeout >= 300, 'cold tsc + preflight exceed the 60 s default');
    assert.equal(d.hooks[0].trigger, 'PostToolUse');
    assert.equal(d.hooks[0].matcher, '^(fs_write|str_replace)$');
    assert.match(d.hooks[0].action.command, / mark-dirty$/);
    assert.equal(hookDefs({ platformRoot: f.platform }).length, 2);
  } finally { f.done(); }
});

test('setup removes a stale marked hook, never touches an unmarked file, and writes nothing inside a repository', () => {
  const f = fixture();
  try {
    const dir = path.join(f.ws, '.kiro', 'hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'vitana-web-old.json'), JSON.stringify({ version: 'v1', generatedBy: MARKER, hooks: [] }));
    writeFileSync(path.join(dir, 'user-hook.json'), JSON.stringify({ version: 'v1', hooks: [] }));
    writeFileSync(path.join(dir, 'notes.txt'), 'keep');
    const before = readdirSync(f.platform, { recursive: true }).sort();
    const r = writeHooks({ workspace: f.ws, platformRoot: f.platform });
    assert.deepEqual(r.removed, ['vitana-web-old.json']);
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
    const g = path.join(f.ws, '.kiro', 'hooks', 'vitana-web-guard.json');
    const g1 = snap(g);
    const r2 = writeHooks({ workspace: f.ws, platformRoot: f.platform });
    assert.deepEqual(r2.written, []);
    assert.equal(snap(g), g1);
    assert.equal(copyReviewer({ workspace: f.ws, platformRoot: f.platform }).changed, false);
  } finally { f.done(); }
});

// ---------------------------------------------------------------- case 3: mark-dirty
test('mark-dirty marks a gateway src edit, ignores other paths and survives malformed stdin', () => {
  const f = fixture();
  try {
    const p = '/w/vitana-platform/services/gateway/src/routes/x.ts';
    const m = markDirty(JSON.stringify({ tool_name: 'str_replace', tool_input: { path: p } }), { cacheDir: f.cache });
    assert.equal(m, dirtyFile(f.cache, '/w/vitana-platform'));
    assert.ok(existsSync(m));
    assert.equal(markDirty(JSON.stringify({ tool_name: 'fs_write', tool_input: { path: '/w/vitana-platform/docs/a.md' } }), { cacheDir: f.cache }), null);
    assert.equal(markDirty('{not json', { cacheDir: f.cache }), null);
    const cli = spawnSync(process.execPath, [SCRIPT, 'mark-dirty'], { input: '{bad', encoding: 'utf8',
      env: { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache } });
    assert.equal(cli.status, 0);
    assert.equal(cli.stdout, '');
  } finally { f.done(); }
});

// ---------------------------------------------------------------- case 4: command parsing
test('parseCommand finds every push form with repo dir, branch and source', () => {
  const p = (c, cwd = '/w') => parseCommand(c, cwd).filter((a) => a.op === 'push');
  assert.deepEqual(p(`git -C /w/vitana-platform push origin ${SHA}:refs/heads/kiro/s/l`)[0],
    { op: 'push', dir: '/w/vitana-platform', remote: 'origin', src: SHA, branch: 'kiro/s/l', del: false, title: null });
  assert.deepEqual(p('git push origin kiro/s/plan')[0], { op: 'push', dir: '/w', remote: 'origin', src: 'kiro/s/plan', branch: 'kiro/s/plan', del: false, title: null });
  assert.equal(p("PR_TITLE='plan(s): x y' git push origin kiro/s/plan")[0].title, 'plan(s): x y');
  assert.equal(p('PR_TITLE="VTID-1 (s/l): a b" git -C /w push origin kiro/s/l')[0].title, 'VTID-1 (s/l): a b');
  assert.equal(p("export PR_TITLE='VTID-2 (s/l): c' && git push origin kiro/s/l")[0].title, 'VTID-2 (s/l): c');
  assert.equal(p("PR_TITLE='x' true; git push origin kiro/s/l")[0].title, null, 'a prefix applies to its own command only');
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

// ---------------------------------------------------------------- case 5: guard decisions
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

test('guard blocks a push whose sha is not the checked-out HEAD, and a commit+push in one command', () => {
  const f = fixture();
  try {
    const r = guard(hookInput(`git -C /w/vitana-platform push origin ${OTHER_SHA}:refs/heads/kiro/s/l`),
      { run: fakeRun(), cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not the checked-out HEAD/);
    const r2 = guard(hookInput('git commit -m x && git push origin kiro/s/l'),
      { run: fakeRun(), cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r2.code, 2);
    assert.match(r2.stderr, /separate commands/);
  } finally { f.done(); }
});

test('guard typechecks the gateway on commit after a gateway edit: errors block, clean clears the marker', () => {
  const f = fixture();
  try {
    const top = '/w/vitana-platform';
    const mark = () => markDirty(JSON.stringify({ tool_input: { path: `${top}/services/gateway/src/a.ts` } }), { cacheDir: f.cache });
    mark();
    const bad = fakeRun({ tsc: { status: 2, output: 'src/a.ts(1,7): error TS2322: Type string is not assignable to number.\nmore' } });
    const r1 = guard(hookInput('git commit -m x', top), { run: bad, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r1.code, 2);
    assert.match(r1.stderr, /error TS2322/);
    assert.ok(existsSync(dirtyFile(f.cache, top)), 'marker stays while errors remain');
    const tscCall = bad.calls.find((x) => x.cmd === 'npx');
    assert.equal(tscCall.cwd, path.join(top, 'services', 'gateway'));
    assert.ok(tscCall.args.includes('--noEmit') && tscCall.args.includes('--incremental'));
    const good = fakeRun();
    assert.equal(guard(hookInput('git commit -m x', top), { run: good, cacheDir: f.cache, platformRoot: f.platform, exists: () => true }).code, 0);
    assert.ok(!existsSync(dirtyFile(f.cache, top)));
    const none = fakeRun();
    assert.equal(guard(hookInput('git commit -m y', top), { run: none, cacheDir: f.cache, platformRoot: f.platform, exists: () => true }).code, 0);
    assert.equal(none.calls.filter((x) => x.cmd === 'npx').length, 0, 'no gateway edit, no typecheck');
  } finally { f.done(); }
});

test('guard installs missing gateway dependencies before the typecheck instead of failing', () => {
  const f = fixture();
  try {
    const top = '/w/vitana-platform';
    markDirty(JSON.stringify({ tool_input: { path: `${top}/services/gateway/src/a.ts` } }), { cacheDir: f.cache });
    const run = fakeRun();
    const r = guard(hookInput('git commit -m x', top), { run, cacheDir: f.cache, platformRoot: f.platform, exists: (p) => !p.endsWith('node_modules') });
    assert.equal(r.code, 0);
    const order = run.calls.map((c) => c.cmd).filter((c) => c === 'npm' || c === 'npx');
    assert.deepEqual(order, ['npm', 'npx']);
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

// ---------------------------------------------------------------- case 6: wait
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

// ---------------------------------------------------------------- case 7: status --check
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

test('from a linked worktree the workspace is the main checkout\'s parent, and worktrees are never taken as repos', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiro-web-ws-'));
  try {
    const ws = path.join(dir, 'ws');
    const main = path.join(ws, 'vitana-platform');
    const g = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    mkdirSync(main, { recursive: true });
    g(['init', '-q', '-b', 'main'], main);
    g(['remote', 'add', 'origin', 'https://github.com/exafyltd/vitana-platform.git'], main);
    writeFileSync(path.join(main, 'f'), 'x');
    g(['add', 'f'], main);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], main);
    const wt = path.join(main, '.agents', 'wt', 'lane');
    g(['worktree', 'add', '-q', '-b', 'kiro/s/l', wt], main);
    assert.equal(defaultWorkspace(wt), ws);
    assert.equal(defaultWorkspace(main), ws);
    assert.deepEqual(findRepos(ws).map((r) => r.name), ['vitana-platform']);
    assert.deepEqual(findRepos(path.dirname(wt)), [], 'a worktree folder holds no main checkout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('guard typechecks on commit when gateway src differs from HEAD even without a marker (bash edit / parallel race)', () => {
  const f = fixture();
  try {
    const top = '/w/vitana-platform';
    const bad = fakeRun({ gwDiff: 'services/gateway/src/routes/health.ts', tsc: { status: 2, output: "src/routes/health.ts(26,7): error TS2322: x" } });
    const r = guard(hookInput('git commit -m x', top), { run: bad, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /TS2322/);
    assert.match(r.stderr, /last-block\.txt/);
    const good = fakeRun({ gwDiff: 'services/gateway/src/routes/health.ts' });
    assert.equal(guard(hookInput('git commit -m x', top), { run: good, cacheDir: f.cache, platformRoot: f.platform, exists: () => true }).code, 0);
    assert.equal(good.calls.filter((c) => c.cmd === 'npx').length, 1);
  } finally { f.done(); }
});

test('the CLI writes every block to last-block.txt (the main session shows a blocked command as {})', () => {
  const f = fixture();
  try {
    const cli = spawnSync(process.execPath, [SCRIPT, 'guard'], { encoding: 'utf8',
      input: hookInput('git commit -m x && git push origin kiro/s/l', f.ws),
      env: { ...process.env, VITANA_KIRO_WEB_CACHE: f.cache, VITANA_KIRO_WEB_PLATFORM: f.platform } });
    assert.equal(cli.status, 2);
    assert.match(readFileSync(path.join(f.cache, 'last-block.txt'), 'utf8'), /separate commands/);
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

test('guard asks preflight for required-only status: a report-only failure is printed, not blocking, and not cached', () => {
  const f = fixture();
  try {
    const out = 'FAIL  Collab handoff [report-only in CI (vitana-v1 Collab handoff step)]\n  1465834a: a lane PR needs Collab-Session and Collab-Lane trailers on every commit\nPASS  Lane scope [required]';
    const run = fakeRun({ preflight: { status: 0, output: out } });
    const r = guard(hookInput('git -C /w/vitana-platform push origin kiro/s/l'), { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /report-only in CI and failed/);
    assert.match(r.stdout, /needs Collab-Session/);
    assert.ok(run.calls.find((x) => x.cmd === process.execPath).args.includes('--required-only'));
    const again = fakeRun({ preflight: { status: 0, output: out } });
    guard(hookInput('git -C /w/vitana-platform push origin kiro/s/l'), { run: again, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(again.calls.filter((x) => x.cmd === process.execPath).length, 1, 'not cached, so printed again');
  } finally { f.done(); }
});

test('guard still blocks when preflight exits non-zero (a required failure under --required-only)', () => {
  const f = fixture();
  try {
    const run = fakeRun({ preflight: { status: 1, output: 'FAIL  Lane scope [required]\n  out of scope\nFAIL  PR-GATE scope [report-only in CI]' } });
    const r = guard(hookInput('git -C /w/vitana-platform push origin kiro/s/l'), { run, cacheDir: f.cache, platformRoot: f.platform, exists: () => true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Lane scope/);
  } finally { f.done(); }
});
