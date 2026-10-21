// VTID-05271 (kiro-autonomy-fallback/exceptions-seat) — checks for the Kiro Web automation files, the exceptions seat,
// the retired Claude Routine and the Kiro Web plan driver. Run: node --test scripts/collab/automations.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const AUTOMATIONS = '.kiro/automations';
const RERUN_ALLOWLIST = ['PLAN-SPAR.yml', 'PR-GATE.yml', 'STAGING-VERIFY.yml'];
const NEVER_ONLY = ['gh workflow run', 'gh pr merge', '--admin', 'AWS-PROD', 'publish-to-prod', 'RUN-MIGRATION', 'apply_migration'];
const SHARED_SECTIONS = ['### Wake a driver (W)', '### Planner (A)', '### Reviewer (B)', '### Builder (C)'];
const CRON = '0 * * * *';

/** The `seats:` map and top-level scalars of docs/programs/areas.yaml (same line rules as queue.mjs loadSeats). */
function loadAreas() {
  const seats = {};
  const top = {};
  let inSeats = false;
  for (const line of read('docs/programs/areas.yaml').split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (/^\S/.test(line)) {
      inSeats = /^seats:\s*(#.*)?$/.test(line);
      const s = /^([a-z_]+):\s*([^#\s][^#]*?)\s*(#.*)?$/.exec(line);
      if (s) top[s[1]] = s[2];
      continue;
    }
    const m = inSeats && /^ {2}([a-z]{1,12}):\s*\{(.*)\}/.exec(line);
    if (m) {
      seats[m[1]] = Object.fromEntries(m[2].split(',').map((kv) => kv.split(':').map((x) => x.trim())).filter((kv) => kv[0]));
    }
  }
  return { seats, top };
}

const automationFiles = () => readdirSync(path.join(ROOT, AUTOMATIONS)).filter((f) => f.endsWith('.md')).sort();

/** Body of a `### ` section up to the next `### ` / `## ` heading. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const end = rest.slice(heading.length).search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, heading.length + end + 1);
}

/** The sentence an index sits in: back to the previous sentence end, blank line or list item start. */
function sentenceBefore(text, idx) {
  const before = text.slice(0, idx);
  let start = 0;
  const re = /(\.\s|\n\s*\n|\n\s*(?:[-*]|\d+\.)\s)/g;
  let m;
  while ((m = re.exec(before))) start = m.index + m[0].length;
  return before.slice(start);
}

test('every seat automation exists and every automation file is referenced by a seat', () => {
  const { seats } = loadAreas();
  const referenced = new Set();
  for (const [seat, s] of Object.entries(seats)) {
    if (!s.automation) continue;
    assert.ok(existsSync(path.join(ROOT, s.automation)), `seat ${seat}: ${s.automation} missing`);
    assert.equal(s.automation, `${AUTOMATIONS}/${seat}.md`, `seat ${seat}: automation file must be named after the seat`);
    referenced.add(path.basename(s.automation));
  }
  for (const f of automationFiles()) assert.ok(referenced.has(f), `${AUTOMATIONS}/${f} is not referenced by any seat`);
});

test('exceptions_seat names a kiro-web seat and only its file has the Exceptions section', () => {
  const { seats, top } = loadAreas();
  const ex = top.exceptions_seat;
  assert.equal(ex, 'exafyltd', 'docs/programs/areas.yaml must set top-level exceptions_seat: exafyltd');
  assert.ok(seats[ex], `exceptions_seat ${ex} is not a seat`);
  assert.equal(seats[ex].surface, 'kiro-web', `exceptions_seat ${ex} must be a kiro-web seat`);
  for (const f of automationFiles()) {
    const has = read(`${AUTOMATIONS}/${f}`).includes('\n### Exceptions (E1–E6)\n');
    assert.equal(has, f === `${ex}.md`, `${f}: ### Exceptions (E1–E6) belongs only to the exceptions seat's file`);
  }
});

test('one item per run, and the item order line', () => {
  const { top } = loadAreas();
  for (const f of automationFiles()) {
    const t = read(`${AUTOMATIONS}/${f}`);
    assert.equal(t.split('Do at most ONE item').length - 1, 1, `${f}: "Do at most ONE item" exactly once`);
    const orders = [...t.matchAll(/^\s*Order: (.+?)\.?$/gm)];
    assert.equal(orders.length, 1, `${f}: exactly one "Order:" line`);
    const order = orders[0][1].split(/,\s*/);
    const expected = f === `${top.exceptions_seat}.md`
      ? ['E1', 'W', 'E2', 'E3', 'E4', 'E5', 'E6', 'A', 'B', 'C']
      : ['W', 'A', 'B', 'C'];
    assert.deepEqual(order, expected, `${f}: item order`);
  }
});

test('gh run rerun appears only beside the allowlist; merge/deploy/dispatch/migration words only in never sentences', () => {
  for (const f of automationFiles()) {
    const t = read(`${AUTOMATIONS}/${f}`);
    for (const line of t.split('\n').filter((l) => l.includes('gh run rerun'))) {
      const ymls = line.match(/[A-Za-z0-9_-]+\.yml/g) || [];
      for (const y of ymls) assert.ok(RERUN_ALLOWLIST.includes(y), `${f}: "${y}" next to gh run rerun is not allowlisted`);
    }
    for (const word of NEVER_ONLY) {
      let i = t.indexOf(word);
      while (i >= 0) {
        assert.match(sentenceBefore(t, i), /\bnever\b/i, `${f}: "${word}" outside a "never" sentence`);
        i = t.indexOf(word, i + word.length);
      }
    }
  }
  const ex = read(`${AUTOMATIONS}/exafyltd.md`);
  for (const y of RERUN_ALLOWLIST) assert.ok(ex.includes(`.github/workflows/${y}`), `exafyltd.md: allowlist names ${y} by path`);
  for (const f of automationFiles().filter((x) => x !== 'exafyltd.md')) {
    assert.ok(!read(`${AUTOMATIONS}/${f}`).includes('gh run rerun'), `${f}: only the exceptions seat re-runs workflows`);
  }
});

test('no automation hands work to next_actor: claude (only the legacy executor: claude sentence names it)', () => {
  for (const f of automationFiles()) {
    for (const line of read(`${AUTOMATIONS}/${f}`).split('\n').filter((l) => l.includes('next_actor: claude'))) {
      assert.ok(/legacy/i.test(line) && line.includes('executor: claude'), `${f}: "${line.trim()}" hands work to Claude`);
    }
  }
});

test('shared sections are identical across the three files after seat normalisation', () => {
  const files = automationFiles();
  assert.ok(files.length >= 2);
  // The seat name as a whole word becomes <seat>; the GitHub org `exafyltd/vitana-…` is not a seat name.
  const norm = (f) => read(`${AUTOMATIONS}/${f}`).replace(/exafyltd\/vitana-/g, '\u0000ORG\u0000')
    .replace(new RegExp(`\\b${path.basename(f, '.md')}\\b`, 'g'), '<seat>').replace(/\u0000ORG\u0000/g, 'exafyltd/vitana-');
  const steps = (t) => t.slice(t.indexOf('## Every run, in this order'), t.indexOf('\n4. '));
  const base = norm(files[0]);
  for (const f of files.slice(1)) {
    const t = norm(f);
    assert.equal(steps(t), steps(base), `${f}: steps 0-3 differ from ${files[0]}`);
    for (const h of SHARED_SECTIONS) {
      assert.ok(section(base, h), `${files[0]}: missing ${h}`);
      assert.equal(section(t, h), section(base, h), `${f}: ${h} differs from ${files[0]}`);
    }
  }
});

test('owner setup cron: 5 fields, hourly every day', () => {
  for (const f of automationFiles()) {
    const setup = read(`${AUTOMATIONS}/${f}`).split('## Owner setup')[1] || '';
    const m = /cron\s+`([^`]+)`/.exec(setup);
    assert.ok(m, `${f}: no cron in the owner setup`);
    assert.equal(m[1].trim().split(/\s+/).length, 5, `${f}: cron must have 5 fields`);
    assert.equal(m[1], CRON, `${f}: cron must be ${CRON}`);
  }
});

test('routine-prompt.md carries the retired header', () => {
  const lines = read('scripts/collab/routine-prompt.md').split('\n').filter((l) => l.trim());
  assert.match(lines[0], /^# Routine prompt/);
  assert.match(lines[1], /Retired as primary 2026-10-20 \(kiro-autonomy-fallback\): runs only while Claude is available; the jobs moved to `\.kiro\/automations\/exafyltd\.md` E1–E6/);
});

test('driver.md exists, names the heartbeat command and contract, and needs no subagents', () => {
  const p = '.kiro/pipeline/driver.md';
  assert.ok(existsSync(path.join(ROOT, p)), `${p} missing`);
  const t = read(p);
  assert.ok(t.includes('plan-driver.mjs heartbeat --slug'), 'names the heartbeat command');
  assert.ok(t.includes('refs/heads/collab-driver/<slug>'), 'names the heartbeat ref');
  assert.ok(/45 min/.test(t) && /15 min/.test(t), 'names the alive window and the interval');
  let i = t.toLowerCase().indexOf('subagent');
  while (i >= 0) {
    assert.match(sentenceBefore(t.toLowerCase(), i), /\b(no|never|not)\b/, 'subagents only named as not needed');
    i = t.toLowerCase().indexOf('subagent', i + 1);
  }
});
