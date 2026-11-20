// Plan kiro-web-steering §4: the generator that mirrors the repos' steering into a Kiro Web workspace root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as gen from './kiro-web-steering.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'kiro-web-steering.mjs');

function repo(ws, name, slug, files) {
  const dir = path.join(ws, name);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q');
  g('remote', 'add', 'origin', `https://github.com/${slug}.git`);
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture');
  return dir;
}

const STANDING = '---\ninclusion: always\n---\n# Standing\n\n#[[file:CLAUDE.md]]\n';
const NOTES = '---\ninclusion: always\n---\n# Notes, no links\n';
const COLLAB = '---\ninclusion: fileMatch\nfileMatchPattern:\n  - ".kiro/specs/**"\n  - src/**\n---\n#[[file:.claude/rules/collaboration.md]]\n';
const PIPE = '# Pipeline (no front matter)\nfollow `.kiro/pipeline/driver.md`\n';
const PIPELINE_FILES = {
  '.kiro/pipeline/driver.md': '# driver\n',
  '.kiro/pipeline/common-rules.md': '# common\n',
  '.kiro/pipeline/planning.md': '# planning\n',
  '.kiro/pipeline/quality-checks.md': '# quality checks\n',
};

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kws-'));
  repo(ws, 'vitana-platform', 'exafyltd/vitana-platform', {
    'CLAUDE.md': '# platform rules\n',
    '.claude/rules/collaboration.md': '# collab\n',
    '.kiro/steering/vitana-standing-rules.md': STANDING,
    '.kiro/steering/vitana-kiro-notes.md': NOTES,
    '.kiro/steering/vitana-collaboration.md': COLLAB,
    '.kiro/steering/vitana-pipeline.md': PIPE,
    ...PIPELINE_FILES,
  });
  repo(ws, 'vitana-v1', 'exafyltd/vitana-v1', {
    'CLAUDE.md': '# v1 rules\n',
    '.kiro/steering/vitana-standing-rules.md': STANDING,
    '.kiro/steering/vitana-kiro-notes.md': NOTES,
    '.kiro/steering/vitana-pipeline.md': `${PIPE}v1 differs\n`,
  });
  repo(ws, 'other', 'someone/else', { '.kiro/steering/x.md': '# not ours\n' });
  return ws;
}

const steer = (ws, name) => fs.readFileSync(path.join(ws, '.kiro', 'steering', name), 'utf8');
const run = (ws, ...a) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--workspace', ws, ...a], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout) };
  }
};

test('case 1: links and fileMatchPattern globs are prefixed; front matter stays first; inclusion kept', () => {
  const ws = workspace();
  assert.equal(run(ws).code, 0);
  const s = steer(ws, 'vitana-platform--vitana-standing-rules.md');
  assert.ok(s.startsWith('---\ninclusion: always\n---\n'));
  assert.match(s, /#\[\[file:vitana-platform\/CLAUDE\.md\]\]/);
  assert.match(steer(ws, 'vitana-v1--vitana-standing-rules.md'), /#\[\[file:vitana-v1\/CLAUDE\.md\]\]/);
  const c = steer(ws, 'vitana-platform--vitana-collaboration.md');
  assert.match(c, /^---\ninclusion: fileMatch\nfileMatchPattern:\n  - "vitana-platform\/\.kiro\/specs\/\*\*"\n  - "vitana-platform\/src\/\*\*"\n---\n/);
  assert.match(c, /#\[\[file:vitana-platform\/\.claude\/rules\/collaboration\.md\]\]/);
  const p = steer(ws, 'vitana-platform--vitana-pipeline.md');
  assert.ok(p.startsWith(gen.MARKER), 'a file without front matter gets no invented inclusion');
  assert.ok(p.includes(PIPE));
});

test('case 2: identical link-free v1 file written once; differing or linked files per repo', () => {
  const ws = workspace();
  run(ws);
  const names = fs.readdirSync(path.join(ws, '.kiro', 'steering'));
  assert.ok(names.includes('vitana-platform--vitana-kiro-notes.md'));
  assert.ok(!names.includes('vitana-v1--vitana-kiro-notes.md'));
  assert.ok(names.includes('vitana-v1--vitana-pipeline.md'));
  assert.ok(names.includes('vitana-v1--vitana-standing-rules.md'));
  assert.ok(!names.some((n) => n.startsWith('other--')), 'only exafyltd Vitana checkouts are mirrored');
});

test('case 3: the driver file is always-included and links driver, common-rules, planning', () => {
  const ws = workspace();
  run(ws);
  const d = steer(ws, `vitana-platform--${gen.DRIVER_FILE}`);
  assert.ok(d.startsWith('---\ninclusion: always\n---\n'));
  for (const l of gen.DRIVER_LINKS) assert.ok(d.includes(`#[[file:vitana-platform/${l}]]`), l);
});

test('case 4: stale marked files removed, unmarked files untouched, nothing written in a repo', () => {
  const ws = workspace();
  const out = path.join(ws, '.kiro', 'steering');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'mine.md'), '# user file\n');
  fs.writeFileSync(path.join(out, 'vitana-platform--gone.md'), `${gen.MARKER} from x @ y; do not edit -->\n`);
  run(ws);
  assert.equal(fs.readFileSync(path.join(out, 'mine.md'), 'utf8'), '# user file\n');
  assert.ok(!fs.existsSync(path.join(out, 'vitana-platform--gone.md')));
  for (const r of ['vitana-platform', 'vitana-v1']) {
    assert.equal(execFileSync('git', ['-C', path.join(ws, r), 'status', '--porcelain'], { encoding: 'utf8' }), '');
  }
});

test('case 5: --check is clean after a run and fails on missing target, stale file and nested link', () => {
  const ws = workspace();
  assert.equal(run(ws, '--check').code, 1, 'nothing generated yet');
  run(ws);
  assert.equal(run(ws, '--check').code, 0);

  fs.appendFileSync(path.join(ws, 'vitana-platform', '.kiro', 'steering', 'vitana-kiro-notes.md'), 'changed\n');
  assert.match(run(ws, '--check').out, /vitana-platform--vitana-kiro-notes\.md: out of date/);
  run(ws);

  fs.rmSync(path.join(ws, 'vitana-v1', 'CLAUDE.md'));
  assert.match(run(ws, '--check').out, /#\[\[file:vitana-v1\/CLAUDE\.md\]\] does not resolve/);
  fs.writeFileSync(path.join(ws, 'vitana-v1', 'CLAUDE.md'), '# v1\n#[[file:other.md]]\n');
  assert.match(run(ws, '--check').out, /vitana-v1\/CLAUDE\.md itself links other\.md/);
  fs.writeFileSync(path.join(ws, 'vitana-v1', 'CLAUDE.md'), '# v1 rules\n');

  fs.writeFileSync(path.join(ws, '.kiro', 'steering', 'vitana-v1--old.md'), `${gen.MARKER} from x @ y; do not edit -->\n`);
  const r = run(ws, '--check');
  assert.equal(r.code, 1);
  assert.match(r.out, /vitana-v1--old\.md: stale generated file/);
});

test('case 6: the real checkout(s) generate a clean set', () => {
  // The CI checkout has only vitana-platform; a Kiro Web workspace has both. Copy into a temp workspace so the test
  // never writes next to the real checkout.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kws-real-'));
  const real = gen.findRepos(gen.defaultWorkspace());
  const platformDir = execFileSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const sources = real.length ? real : [{ prefix: 'vitana-platform', dir: platformDir }];
  for (const r of sources) {
    const dst = path.join(ws, r.prefix);
    // The steering, the pipeline runbooks, and every file a steering file links (a missing one stays missing).
    const subs = ['.kiro/steering', '.kiro/pipeline'];
    for (const f of fs.readdirSync(path.join(r.dir, '.kiro', 'steering'))) {
      subs.push(...gen.linksOf(fs.readFileSync(path.join(r.dir, '.kiro', 'steering', f), 'utf8')));
    }
    for (const sub of subs) {
      const src = path.join(r.dir, sub);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(dst, sub), { recursive: true });
    }
    execFileSync('git', ['-C', dst, 'init', '-q']);
    execFileSync('git', ['-C', dst, 'remote', 'add', 'origin', `https://github.com/${r.slug || gen.PLATFORM}.git`]);
  }
  const first = run(ws, '--json');
  const res = JSON.parse(first.out);
  assert.deepEqual(res.problems, [], res.problems.join('\n'));
  assert.equal(run(ws, '--check').code, 0);
  assert.ok(res.files.some((f) => f.file === `vitana-platform--${gen.DRIVER_FILE}`));
  assert.ok(res.files.some((f) => f.file === 'vitana-platform--vitana-load-project-rules.md'));
});

test('R2-F1: a known Vitana checkout without .kiro/steering is skipped with a note, not an error', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kws-skip-'));
  repo(ws, 'vitana-platform', 'exafyltd/vitana-platform', {
    'CLAUDE.md': '# rules\n',
    '.kiro/steering/vitana-standing-rules.md': '---\ninclusion: always\n---\n#[[file:CLAUDE.md]]\n',
    ...PIPELINE_FILES,
  });
  repo(ws, 'vitana-v1', 'exafyltd/vitana-v1', { 'README.md': '# no steering\n' });
  const r = run(ws, '--json');
  assert.equal(r.code, 0);
  const res = JSON.parse(r.out);
  assert.deepEqual(res.skipped, ['vitana-v1 (exafyltd/vitana-v1): no .kiro/steering/']);
  assert.ok(!res.files.some((f) => f.file.startsWith('vitana-v1--')));
});

// quality-checks-followup/steering-quality-checks: a Kiro Web session gets the per-change-type quality checks inlined.
test('quality-checks: the driver file inlines .kiro/pipeline/quality-checks.md, after the runbook files', () => {
  assert.ok(gen.DRIVER_LINKS.includes('.kiro/pipeline/quality-checks.md'), 'DRIVER_LINKS lacks quality-checks.md');
  assert.equal(gen.DRIVER_LINKS.at(-1), '.kiro/pipeline/quality-checks.md', 'quality-checks.md is the last link');
  for (const l of ['.kiro/pipeline/driver.md', '.kiro/pipeline/common-rules.md', '.kiro/pipeline/planning.md']) {
    assert.ok(gen.DRIVER_LINKS.includes(l), `${l} is still linked`);
  }
  assert.ok(fs.existsSync(path.join(HERE, '..', '..', '.kiro', 'pipeline', 'quality-checks.md')), 'the linked file exists in this repo');
});
