// VTID-05765 (plan autonomous-to-staging, lane machine-gate-protected) — the mechanical gate invariants.
//
// PROTECTED GATE FILE. It backs the two-model rule for protected gate files with a check that does not depend on a
// model: the protected list still names every gate file (this file included), the merge guards still refuse zero, one
// or two same-model accepts, and the staging production-reference guard still lists every production identifier.
//
//   node --test scripts/collab/gate-invariants.test.mjs        (Collab tests in PR-GATE; GATE-INVARIANTS.yml on main)
//
// The first test loads THIS file from origin/main and runs its checkInvariants against the checkout, so a PR cannot
// weaken the gate and its check together; no baseline on origin/main → bootstrap note, pass. The tests are skipped when
// GATE_INVARIANTS_LIBRARY=1 (set while the baseline copy is imported, so it does not register a second test set).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';


/** Every gate file the protected list must keep (the list may grow, never lose one of these). */
export const REQUIRED_PROTECTED = Object.freeze([
  'CLAUDE.md',
  'scripts/collab/plan-spar.mjs',
  'scripts/collab/queue.mjs',
  'scripts/collab/protected-gate-files.json',
  'services/gateway/src/services/plan-sparring/**',
  'services/gateway/src/services/project-manager/governance.ts',
  '.github/workflows/PLAN-SPAR.yml',
  '.github/workflows/PR-GATE.yml',
  '.github/workflows/AWS-PROD-*.yml',
  '.kiro/agents/vitana-lane-reviewer.md',
  'supabase/migrations/*vtid_ledger*.sql',
  'supabase/migrations/*plan_sparring*.sql',
  '.github/workflows/VTID-ALLOCATE.yml',
  'scripts/collab/gate-invariants.test.mjs',
  // VTID-05780 (plan autonomous-to-staging-r2, lane protect-gate-workflow): the post-merge workflow, its static test
  // and the post-merge audit.
  '.github/workflows/GATE-INVARIANTS.yml',
  'scripts/ci/workflow-trigger-check.test.mjs',
  'scripts/collab/gate-audit.mjs',
]);
/** Production identifiers the staging guard must keep refusing (lane staging-db-isolation). */
export const REQUIRED_PROD_REFS = Object.freeze([
  'inmkhvwdcuyhnxkgfvsb',
  'vitana-aurora-prod',
  'AWS_PROD_ROLE_ARN',
  'vitana/aurora/prod/postgrest-authenticator-uri',
]);
const MODELS = ['claude-sonnet-5.5', 'claude-opus-5.5'];

const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };

/** → { failures: string[], notes: string[] } for the checkout at `root`. */
export async function checkInvariants(root) {
  const failures = [];
  const notes = [];
  // 1. The protected list.
  let globs = [];
  try { globs = JSON.parse(read(root, 'scripts/collab/protected-gate-files.json') || '{}').globs || []; } catch (e) { failures.push(`protected-gate-files.json unreadable: ${e.message}`); }
  if (!Array.isArray(globs) || globs.length === 0) failures.push('protected-gate-files.json: "globs" is empty');
  for (const g of REQUIRED_PROTECTED) if (!globs.includes(g)) failures.push(`protected-gate-files.json no longer lists ${g}`);
  const gov = read(root, 'services/gateway/src/services/project-manager/governance.ts') || '';
  for (const g of REQUIRED_PROTECTED) if (!gov.includes(`'${g}'`)) failures.push(`governance.ts PROTECTED_GATE_GLOBS no longer lists ${g}`);
  // 1b. VTID-05780: this file's own REQUIRED_PROTECTED in the checkout still names every required glob (so the list
  // checked here cannot shrink in the same PR that shrinks the others).
  const self = read(root, 'scripts/collab/gate-invariants.test.mjs') || '';
  const block = (/REQUIRED_PROTECTED = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(self) || [])[1] || '';
  for (const g of REQUIRED_PROTECTED) if (!block.includes(`'${g}'`)) failures.push(`gate-invariants.test.mjs REQUIRED_PROTECTED no longer lists ${g}`);
  // 2. queue.mjs: compiled-in list, and scope-check semantics.
  try {
    const q = await import(pathToFileURL(path.join(root, 'scripts/collab/queue.mjs')).href);
    for (const g of REQUIRED_PROTECTED) if (!q.PROTECTED_GATE_BUILTIN.includes(g)) failures.push(`queue.mjs PROTECTED_GATE_BUILTIN no longer lists ${g}`);
    if (q.isTwoModelLane({ executor: 'kiro', protected_gate: 'two-model' })) failures.push('queue.mjs isTwoModelLane accepts a lane without the reviewer agent');
    if (q.isTwoModelLane({ executor: 'claude', protected_gate: 'two-model', reviewer_seat: 'agent:vitana-lane-reviewer' })) failures.push('queue.mjs isTwoModelLane accepts a non-kiro executor');
  } catch (e) { failures.push(`queue.mjs could not be loaded: ${e.message}`); }
  // 3. land-guard.mjs: the merge guard refuses fewer than two distinct models.
  try {
    const lg = await import(pathToFileURL(path.join(root, 'scripts/collab/land-guard.mjs')).href);
    const base = { review: { ok: true, reason: 'x' }, checks: { state: 'pass', detail: 'x' }, behindBy: 0, protectedFiles: ['CLAUDE.md'] };
    for (const [label, models] of [['zero accepts', []], ['one accept', [MODELS[0]]], ['two accepts of one model', [MODELS[0], MODELS[0]]]]) {
      if (lg.mergeDecision({ ...base, protectedModels: models }).ok) failures.push(`land-guard.mjs merges a protected gate file with ${label}`);
    }
    if (!lg.mergeDecision({ ...base, protectedModels: MODELS }).ok) failures.push('land-guard.mjs refuses two accepts from different models (rule not in force)');
    if (lg.protectedAcceptModels([{ verdict: 'accept', reviewer: 'agent:vitana-lane-reviewer (gpt-x)', current: true }]).length) failures.push('land-guard.mjs counts a model outside the chain');
    if (lg.protectedAcceptModels([{ verdict: 'accept', reviewer: `agent:vitana-lane-reviewer (${MODELS[0]})`, current: false }]).length) failures.push('land-guard.mjs counts an accept that is not on the current head');
    // VTID-05780: the exact-head rule — a merge of main after the accepts voids them; one session or a builder session
    // never makes the second accept.
    if (typeof lg.protectedReviewCurrent !== 'function') failures.push('land-guard.mjs has no protectedReviewCurrent (exact-head rule missing)');
    else {
      const R = 'a'.repeat(40);
      const H = 'b'.repeat(40);
      const merge = { sha: H, session: 'x', files: ['.kiro/specs/s/lanes/l.md'], merge: { parents: ['c'.repeat(40), 'd'.repeat(40)], secondParentOnMain: true, autoMergeTree: 't', commitTree: 't', protectedFiles: [] } };
      if (lg.protectedReviewCurrent(R, H, [merge], 's/l', { prDiffSame: true, protectedSame: true }).ok) failures.push('land-guard.mjs keeps a protected accept across a merge of main');
      if (lg.protectedReviewCurrent(R, H, [{ sha: H, session: 'x', files: ['scripts/collab/queue.mjs'] }], 's/l', { prDiffSame: true, protectedSame: true }).ok) failures.push('land-guard.mjs keeps a protected accept across a code commit');
    }
    const acc = (m, session) => ({ verdict: 'accept', reviewer: `agent:vitana-lane-reviewer (${m})`, current: true, session });
    if (lg.protectedAcceptModels([acc(MODELS[0], 's1'), acc(MODELS[1], 's1')]).length >= 2) failures.push('land-guard.mjs counts two accepts from one session');
    if (lg.protectedAcceptModels([acc(MODELS[0], 's1'), acc(MODELS[1], 'b1')], { builders: ['b1'] }).length >= 2) failures.push('land-guard.mjs counts a builder self-review');
  } catch (e) { failures.push(`land-guard.mjs could not be loaded: ${e.message}`); }
  // 4. The staging production-reference guard (lane staging-db-isolation) — conditional until it exists.
  const guard = read(root, 'scripts/ci/staging-prod-ref-guard.mjs');
  if (guard === null) notes.push('staging-prod-ref-guard: not yet present, invariant deferred');
  else for (const ref of REQUIRED_PROD_REFS) if (!guard.includes(ref)) failures.push(`staging-prod-ref-guard.mjs no longer lists ${ref}`);
  // 5. The post-merge workflow (lane gate-invariants-ci) — conditional until it exists.
  const wf = read(root, '.github/workflows/GATE-INVARIANTS.yml');
  if (wf === null) notes.push('GATE-INVARIANTS.yml: not yet present, invariant deferred');
  else {
    if (!/\bpush:\s*\n\s*branches:\s*\[\s*main\s*\]/.test(wf)) failures.push('GATE-INVARIANTS.yml no longer runs on push to main');
    // VTID-05780: the post-merge audit of protected merges on main.
    if (!/node scripts\/collab\/gate-audit\.mjs/.test(wf)) failures.push('GATE-INVARIANTS.yml no longer runs scripts/collab/gate-audit.mjs');
  }
  return { failures, notes };
}


const T = process.env.GATE_INVARIANTS_LIBRARY === '1' ? () => {} : test;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

T('merge-base copy of gate-invariants.mjs holds on this checkout (bootstrap when absent)', async (t) => {
  let src = null;
  try { src = git('show', 'origin/main:scripts/collab/gate-invariants.test.mjs'); } catch { /* not on main yet */ }
  if (!src) { t.diagnostic('gate-invariants: no baseline on merge-base (bootstrap)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-inv-'));
  const file = path.join(dir, 'gate-invariants.baseline.mjs');
  fs.writeFileSync(file, src);
  process.env.GATE_INVARIANTS_LIBRARY = '1';
  const { checkInvariants: baseline } = await import(pathToFileURL(file).href);
  delete process.env.GATE_INVARIANTS_LIBRARY;
  const { failures, notes } = await baseline(ROOT);
  for (const n of notes) t.diagnostic(n);
  assert.deepEqual(failures, []);
});

T('working-tree invariants hold on this checkout', async () => {
  const { failures } = await checkInvariants(ROOT);
  assert.deepEqual(failures, []);
});

/** A copy of the files the check reads, so a fixture can be mutated without touching the repo. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fix-'));
  for (const rel of ['scripts/collab/protected-gate-files.json', 'scripts/collab/queue.mjs', 'scripts/collab/land-guard.mjs',
    'services/gateway/src/services/project-manager/governance.ts', 'scripts/collab/gate-invariants.test.mjs']) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  return dir;
}
const edit = (dir, rel, fn) => fs.writeFileSync(path.join(dir, rel), fn(fs.readFileSync(path.join(dir, rel), 'utf8')));

T('mutation: dropping a glob from the protected list fails', async () => {
  const dir = fixture();
  edit(dir, 'scripts/collab/protected-gate-files.json', (s) => s.replace('    "CLAUDE.md",\n', ''));
  const { failures } = await checkInvariants(dir);
  assert.ok(failures.some((f) => /no longer lists CLAUDE\.md/.test(f)), failures.join('\n'));
});

T('mutation: one accept unlocking a protected gate file fails', async () => {
  const dir = fixture();
  edit(dir, 'scripts/collab/land-guard.mjs', (s) => s.replace('export const PROTECTED_ACCEPTS_REQUIRED = 2;', 'export const PROTECTED_ACCEPTS_REQUIRED = 1;'));
  const { failures } = await checkInvariants(dir);
  assert.ok(failures.some((f) => /with one accept/.test(f)), failures.join('\n'));
});

T('mutation: governance.ts losing a protected glob fails', async () => {
  const dir = fixture();
  edit(dir, 'services/gateway/src/services/project-manager/governance.ts', (s) => s.replace("  '.github/workflows/VTID-ALLOCATE.yml',\n", ''));
  const { failures } = await checkInvariants(dir);
  assert.ok(failures.some((f) => /governance\.ts .*VTID-ALLOCATE/.test(f)), failures.join('\n'));
});

T('prod-reference guard and GATE-INVARIANTS.yml are deferred until present, then enforced', async () => {
  const dir = fixture();
  let r = await checkInvariants(dir);
  assert.ok(r.notes.some((n) => /staging-prod-ref-guard: not yet present/.test(n)));
  fs.mkdirSync(path.join(dir, 'scripts/ci'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts/ci/staging-prod-ref-guard.mjs'), "export const PROD = ['inmkhvwdcuyhnxkgfvsb'];\n");
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github/workflows/GATE-INVARIANTS.yml'), 'on:\n  schedule:\n    - cron: "0 3 * * *"\n');
  r = await checkInvariants(dir);
  assert.ok(r.failures.some((f) => /no longer lists vitana-aurora-prod/.test(f)), r.failures.join('\n'));
  assert.ok(r.failures.some((f) => /no longer runs on push to main/.test(f)), r.failures.join('\n'));
});

// VTID-05780 (plan autonomous-to-staging-r2, lane protect-gate-workflow): GATE-INVARIANTS.yml is on all four lists.
T('mutation: dropping GATE-INVARIANTS.yml from any of the four protected lists fails', async () => {
  const W = '.github/workflows/GATE-INVARIANTS.yml';
  const lists = [
    ['scripts/collab/protected-gate-files.json', (s) => s.replace(`    "${W}",\n`, ''), /protected-gate-files\.json no longer lists/],
    ['scripts/collab/queue.mjs', (s) => s.replace(`'${W}', `, ''), /queue\.mjs PROTECTED_GATE_BUILTIN no longer lists/],
    ['services/gateway/src/services/project-manager/governance.ts', (s) => s.replace(`  '${W}',\n`, ''), /governance\.ts PROTECTED_GATE_GLOBS no longer lists/],
    ['scripts/collab/gate-invariants.test.mjs', (s) => s.replace(`  '${W}',\n`, ''), /gate-invariants\.test\.mjs REQUIRED_PROTECTED no longer lists/],
  ];
  for (const [rel, fn, re] of lists) {
    const dir = fixture();
    const before = fs.readFileSync(path.join(dir, rel), 'utf8');
    edit(dir, rel, fn);
    assert.notEqual(fs.readFileSync(path.join(dir, rel), 'utf8'), before, `${rel}: the mutation did not apply`);
    const { failures } = await checkInvariants(dir);
    assert.ok(failures.some((f) => re.test(f) && f.includes(W)), `${rel}: ${failures.join('\n')}`);
  }
});

T('mutation: the exact-head rule weakened (merge of main, one session, builder) fails', async () => {
  const cases = [
    [(s) => s.replace("if (c.merge) return { ok: false", "if (false) return { ok: false"), /across a merge of main/],
    [(s) => s.replace('const PAIR_NEEDS_DISTINCT_SESSIONS = true;', 'const PAIR_NEEDS_DISTINCT_SESSIONS = false;'), /from one session/],
    [(s) => s.replace('const EXCLUDE_BUILDERS = true;', 'const EXCLUDE_BUILDERS = false;'), /builder self-review/],
  ];
  for (const [fn, re] of cases) {
    const dir = fixture();
    const rel = 'scripts/collab/land-guard.mjs';
    const before = fs.readFileSync(path.join(dir, rel), 'utf8');
    edit(dir, rel, fn);
    assert.notEqual(fs.readFileSync(path.join(dir, rel), 'utf8'), before, 'the mutation did not apply');
    const { failures } = await checkInvariants(dir);
    assert.ok(failures.some((f) => re.test(f)), failures.join('\n'));
  }
});
