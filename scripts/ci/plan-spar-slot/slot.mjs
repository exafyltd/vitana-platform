#!/usr/bin/env node
// VTID-05272 (plan kiro-autonomy-fallback §5 H, §7 rule 2) — at most 2 PLAN-SPAR sessions in flight repo-wide.
//
//   node scripts/ci/plan-spar-slot/slot.mjs --repo <owner/name> --run-id <id> [--cap 2] [--poll-s 20] [--max-wait-min 90]
//
// The Bedrock quota is shared with production; 6 sparring sessions at once all failed `deadline_exceeded`. A GitHub
// `concurrency` group cannot express "2 at a time" (it keeps 1 running + 1 pending and cancels older pending runs),
// so the PLAN-SPAR job waits in the step "Wait for a sparring slot" before `Spar`, FIFO by run id:
// - a run whose `Spar` step is in progress holds a slot (whatever its age);
// - an older run (lower run id) waiting in the slot step is ahead of this one; younger waiting runs are ignored;
// - a run that skipped the slot step (its own commit) or has not reached it holds nothing.
// This run starts when holders + older waiters < cap. Poll every 20 s; after 90 min (or 5 API errors in a row) it
// stops waiting and proceeds, logged — the cap protects the quota, it never blocks a plan for good. Read-only
// (`actions: read`): it lists runs and jobs and changes nothing.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SLOT_STEP = 'Wait for a sparring slot';
export const SPAR_STEP = 'Spar';
export const DEFAULT_CAP = 2;

/** What one PLAN-SPAR run is doing, from its jobs' steps: 'sparring' | 'waiting' | 'idle'. */
export function runPhase(jobs) {
  const steps = (jobs || []).flatMap((j) => j.steps || []);
  const st = (name) => steps.find((s) => s.name === name);
  const spar = st(SPAR_STEP);
  if (spar && spar.status === 'in_progress') return 'sparring';
  const slot = st(SLOT_STEP);
  if (slot && slot.status === 'in_progress') return 'waiting';
  return 'idle';
}

/** May run `me` start sparring? `runs` = [{ id, phase }] of the other in-progress PLAN-SPAR runs. */
export function mayStart(me, runs, cap = DEFAULT_CAP) {
  const myId = Number(me);
  const ahead = (runs || []).filter((r) => Number(r.id) !== myId)
    .filter((r) => r.phase === 'sparring' || (r.phase === 'waiting' && Number(r.id) < myId));
  return { start: ahead.length < cap, ahead: ahead.map((r) => Number(r.id)).sort((a, b) => a - b) };
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }));
}
function observe(repo, me) {
  const list = gh(['api', `repos/${repo}/actions/workflows/PLAN-SPAR.yml/runs?status=in_progress&per_page=50`]);
  const runs = [];
  for (const r of list.workflow_runs || []) {
    if (Number(r.id) === Number(me)) continue;
    const jobs = gh(['api', `repos/${repo}/actions/runs/${r.id}/jobs?per_page=20`]).jobs || [];
    runs.push({ id: r.id, phase: runPhase(jobs) });
  }
  return runs;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  const me = String(args['run-id'] || process.env.GITHUB_RUN_ID || '');
  const cap = Math.max(1, Number(args.cap || DEFAULT_CAP));
  const pollMs = Math.max(1, Number(args['poll-s'] || 20)) * 1000;
  const maxMs = Math.max(1, Number(args['max-wait-min'] || 90)) * 60 * 1000;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(me)) { console.error('usage: --repo <owner/name> --run-id <id> [--cap 2]'); return 2; }
  const report = (line) => { console.log(line); if (args.summary) appendFileSync(args.summary, `${line}\n`); };
  const t0 = Date.now();
  let errors = 0;
  for (;;) {
    let d = null;
    try { d = mayStart(me, observe(repo, me), cap); errors = 0; } catch (e) {
      errors++;
      console.log(`slot check failed (${errors}/5): ${String(e.stderr || e.message).trim().slice(0, 300)}`);
      if (errors >= 5) { report(`⚠️ sparring slot: 5 API errors in a row — proceeding without the cap (run ${me})`); return 0; }
    }
    if (d && d.start) { report(`✅ sparring slot: run ${me} starts (${d.ahead.length} of ${cap} slots taken${d.ahead.length ? `: ${d.ahead.join(', ')}` : ''}, waited ${Math.round((Date.now() - t0) / 1000)} s)`); return 0; }
    if (d) console.log(`waiting for a sparring slot: ahead ${d.ahead.join(', ')} (cap ${cap})`);
    if (Date.now() - t0 >= maxMs) { report(`⚠️ sparring slot: waited ${Math.round(maxMs / 60000)} min — proceeding (run ${me})`); return 0; }
    await sleep(pollMs);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`slot.mjs: ${e.message}`); process.exitCode = 0; });
}
