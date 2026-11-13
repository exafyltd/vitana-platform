#!/usr/bin/env node
// VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover, task T4; design.md §9): what an isolated staging data
// plane does to the rest of the system. Read-only, no network.
//
//   node scripts/ci/staging-db/impact.mjs [--root <repo>] [--json] [--check]
//
// 1. Workflows: every .github/workflows/*.yml that names the staging gateway host is looked up in
//    impact-classification.json. Unclassified = flip-blocking. A classified entry with blocks_flip=true blocks until its
//    resolved_when variable holds or (acceptable=true) the owner lists the file in STAGING_CUTOVER_IMPACT_ACCEPTED.
//    Variables are read from the environment (the cutover workflow maps the repository variables).
// 2. Change suites: every docs/validation/*/staging-tests.json is classified per test as plane-neutral (static asset,
//    auth refusal, CI-only `existing` test), schema-dependent (a /health route: needs tables, which the schema bundle
//    proves) or needs-review (reads data rows that synthetic staging data may not have). A suite of an active lane
//    (lane state executing, in-review or verified) that needs review blocks the flip.
// --check exits 1 when the flip would be blocked (unclassified workflow, unresolved blocker, active needs-review suite).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const STAGING_HOST = 'preview-aws-gateway.vitanaland.com';
export const PRODUCTION_GATEWAY = 'https://gateway.vitanaland.com';
const CLASSIFICATION = 'scripts/ci/staging-db/impact-classification.json';

export function loadClassification(root = REPO_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, CLASSIFICATION), 'utf8'));
}

/** Workflow files that name the staging gateway host. */
export function stagingCallers(root = REPO_ROOT) {
  const dir = path.join(root, '.github/workflows');
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(STAGING_HOST));
}

export function classifyWorkflows(callers, classification, env = process.env) {
  const accepted = new Set(String(env.STAGING_CUTOVER_IMPACT_ACCEPTED || '').split(',').map((s) => s.trim()).filter(Boolean));
  const rows = [];
  for (const f of callers) {
    const c = classification.workflows[f];
    if (!c) { rows.push({ file: f, class: null, blocking: true, reason: 'unclassified' }); continue; }
    if (!classification.classes[c.class]) { rows.push({ file: f, class: c.class, blocking: true, reason: `unknown class ${c.class}` }); continue; }
    let blocking = c.blocks_flip === true;
    let reason = blocking ? 'blocks the flip' : 'does not block';
    if (blocking && c.resolved_when && env[c.resolved_when.var] === c.resolved_when.equals) { blocking = false; reason = `resolved: ${c.resolved_when.var}`; }
    if (blocking && c.acceptable === true && accepted.has(f)) { blocking = false; reason = 'accepted by the owner (STAGING_CUTOVER_IMPACT_ACCEPTED)'; }
    if (blocking && c.resolved_when) reason = `blocks until ${c.resolved_when.var}=${c.resolved_when.equals}`;
    else if (blocking && c.acceptable) reason = 'blocks until the owner lists it in STAGING_CUTOVER_IMPACT_ACCEPTED';
    rows.push({ file: f, class: c.class, blocking, reason });
  }
  const stale = Object.keys(classification.workflows).filter((f) => !callers.includes(f)).sort();
  return { rows, stale };
}

const NEUTRAL_STATUS = new Set([401, 403, 404, 405]);
/** plane-neutral | schema-dependent | needs-review for one staging test. */
export function classifyTest(t) {
  if (t.kind === 'existing') return 'plane-neutral';
  if (t.kind !== 'http') return 'needs-review';
  const p = String(t.path || '').split('?')[0];
  if (t.rejected_probe || NEUTRAL_STATUS.has(Number(t.expect_status))) return 'plane-neutral';
  if (p === '/alive' || /^\/command-hub(\/|$)/.test(p) || /^\/\.well-known\//.test(p) || p === '/api/v1/admin/build-info') return 'plane-neutral';
  if (/\/health(-[a-z]+)?$/.test(p) || /\/health\//.test(p) || p === '/api/v1/admin/health') return 'schema-dependent';
  return 'needs-review';
}

export function classifySuites(root = REPO_ROOT) {
  const dir = path.join(root, 'docs/validation');
  const out = [];
  for (const v of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, v, 'staging-tests.json');
    if (!fs.existsSync(f)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { out.push({ vtid: v, service: null, verdict: 'needs-review', reason: 'unreadable' }); continue; }
    const kinds = (j.tests || []).map(classifyTest);
    const verdict = kinds.includes('needs-review') ? 'needs-review' : kinds.includes('schema-dependent') ? 'schema-dependent' : 'plane-neutral';
    out.push({ vtid: j.vtid || v, service: j.service ?? null, verdict, tests: kinds.length });
  }
  return out;
}

/** In-flight lane states: built or being built, not yet done (a lane between merge and STAGING-VERIFY is among them). */
export const IN_FLIGHT = Object.freeze(['executing', 'in-review', 'verified']);
/** VTIDs of in-flight lanes (front matter of .kiro/specs/*\/lanes/*.md). */
export function activeLaneVtids(root = REPO_ROOT) {
  const specs = path.join(root, '.kiro/specs');
  const out = new Set();
  if (!fs.existsSync(specs)) return out;
  for (const s of fs.readdirSync(specs)) {
    const ld = path.join(specs, s, 'lanes');
    if (!fs.existsSync(ld)) continue;
    for (const f of fs.readdirSync(ld).filter((x) => x.endsWith('.md'))) {
      const fm = (fs.readFileSync(path.join(ld, f), 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
      const state = (fm.match(/^state:\s*(\S+)/m) || [])[1];
      const vtid = (fm.match(/^vtid:\s*(VTID-\d{5})/m) || [])[1];
      if (vtid && IN_FLIGHT.includes(state)) out.add(vtid);
    }
  }
  return out;
}

export function report({ root = REPO_ROOT, env = process.env } = {}) {
  const wf = classifyWorkflows(stagingCallers(root), loadClassification(root), env);
  const suites = classifySuites(root);
  const active = activeLaneVtids(root);
  const activeNeedsReview = suites.filter((s) => s.verdict === 'needs-review' && active.has(s.vtid)).map((s) => s.vtid);
  const blockers = [
    ...wf.rows.filter((r) => r.blocking).map((r) => `${r.file}: ${r.reason}`),
    ...activeNeedsReview.map((v) => `${v}: staging-tests.json of an active lane reads data rows (needs-review); seed it or let the lane finish first`),
  ];
  const count = (k) => suites.filter((s) => s.verdict === k).length;
  return {
    workflows: wf.rows, stale_classifications: wf.stale,
    suites: { total: suites.length, plane_neutral: count('plane-neutral'), schema_dependent: count('schema-dependent'), needs_review: count('needs-review'),
      needs_review_vtids: suites.filter((s) => s.verdict === 'needs-review').map((s) => s.vtid) },
    active_lanes: [...active].sort(), active_needs_review: activeNeedsReview,
    blockers, flip_allowed: blockers.length === 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--root');
  const r = report({ root: i >= 0 ? path.resolve(argv[i + 1]) : REPO_ROOT });
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const w of r.workflows) console.log(`${w.blocking ? 'BLOCK' : 'ok   '} ${w.file} [${w.class ?? 'unclassified'}] ${w.reason}`);
    for (const s of r.stale_classifications) console.log(`stale classification (no longer names the host): ${s}`);
    console.log(`suites: ${r.suites.total} (plane-neutral ${r.suites.plane_neutral}, schema-dependent ${r.suites.schema_dependent}, needs-review ${r.suites.needs_review}); active lanes ${r.active_lanes.length}, active needs-review ${r.active_needs_review.length}`);
    console.log(`flip ${r.flip_allowed ? 'allowed by the impact check' : `BLOCKED (${r.blockers.length})`}`);
  }
  if (argv.includes('--check') && !r.flip_allowed) process.exitCode = 1;
}
