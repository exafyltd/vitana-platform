#!/usr/bin/env node
// VTID-05337 — Kiro workflow restart watchdog (plan pipeline-speed, lane restart-watchdog, D7).
//
// Runs as a Kiro command hook on SessionStart and UserPromptSubmit (.kiro/hooks/vitana-workflow-watchdog.json).
// Reads the hook's stdin {session_id, hook_event_name, cwd}, scans the workflow engine's run folders read-only
// (<home>/.kiro/sessions/<dir>/workflows/<wf id>/workflow-state.json + run.beat) and prints one loud block naming every
// run of this workspace that is paused, or running with a heartbeat older than 10 minutes, with what to do about it.
// Only the owning parent session can resume a run (update_workflow), so the script reports and instructs; it never
// writes a file, never calls the network, prints nothing when there is nothing to report and always exits 0 (a hook's
// stdout reaches the agent only on exit 0).
//
// Fallback: when the engine's sessions folder cannot be read, the run ids recorded in
// <cwd>/.agents/tasks/pipeline-*/run.json are listed for a manual inspect_workflow check (SessionStart only — a bare
// run id says nothing about whose run it is).
//
// Test overrides: VITANA_WATCHDOG_HOME (instead of os.homedir()), VITANA_WATCHDOG_NOW (ISO time instead of now).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STALE_BEAT_MS = 10 * 60 * 1000;
export const RESTART_REASON = 'Interrupted by agent restart; the previously running step was paused for resume.';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
}

/** Normalised workspace key: separators unified, trailing separator dropped, case folded on win32. */
export function workspaceKey(p, platform = process.platform) {
  if (typeof p !== 'string' || !p) return '';
  let k = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32') k = k.toLowerCase();
  return k;
}

/** Every engine run: {id, state, beat}. Returns null when the sessions folder itself cannot be read. */
export function engineRuns(home) {
  const sessions = path.join(home, '.kiro', 'sessions');
  const dirs = listDirs(sessions);
  if (dirs === null) return null;
  const runs = [];
  for (const d of dirs) {
    const wfDir = path.join(sessions, d, 'workflows');
    for (const id of listDirs(wfDir) || []) {
      const stateFile = path.join(wfDir, id, 'workflow-state.json');
      if (!fs.existsSync(stateFile)) continue;
      const state = readJson(stateFile);
      if (!state || typeof state !== 'object') continue;
      const beat = readJson(path.join(wfDir, id, 'run.beat'));
      runs.push({ id: state.workflowId || id, state, beat: beat && typeof beat === 'object' ? beat : null });
    }
  }
  return runs;
}

/** Run ids recorded locally by the pipeline (fallback source). */
export function localRunIds(cwd) {
  const tasks = path.join(cwd, '.agents', 'tasks');
  const ids = [];
  for (const d of listDirs(tasks) || []) {
    if (!d.startsWith('pipeline-')) continue;
    const rj = readJson(path.join(tasks, d, 'run.json'));
    if (rj && typeof rj.run_id === 'string' && rj.run_id) ids.push(rj.run_id);
  }
  return [...new Set(ids)].sort();
}

/** Classify one run; null when it needs no attention. */
export function classify(run, now) {
  const s = run.state;
  if (s.status === 'paused') {
    if (s.stopInitiator === 'user') return 'user-paused';
    return s.pauseReason === RESTART_REASON ? 'restart-paused' : 'paused';
  }
  if (s.status === 'running') {
    const at = run.beat && typeof run.beat.stampedAt === 'string' ? Date.parse(run.beat.stampedAt) : NaN;
    if (Number.isFinite(at) && now - at > STALE_BEAT_MS) return 'stale';
  }
  return null;
}

/** Findings for this workspace (and, on UserPromptSubmit, this session only). */
export function scan({ home, cwd, sessionId, event, now, platform = process.platform }) {
  const runs = engineRuns(home);
  if (runs === null) {
    if (event === 'UserPromptSubmit') return { findings: [], fallback: [] };
    return { findings: [], fallback: localRunIds(cwd) };
  }
  const ws = workspaceKey(cwd, platform);
  const findings = [];
  for (const r of runs) {
    if (!ws || workspaceKey(r.state.workspacePath, platform) !== ws) continue;
    const kind = classify(r, now);
    if (!kind) continue;
    const own = Boolean(sessionId) && r.state.parentSessionId === sessionId;
    if (event === 'UserPromptSubmit' && !own) continue;
    findings.push({ id: r.id, kind, own, name: r.state.workflowName || '', label: r.state.runLabel || '',
      parent: r.state.parentSessionId || 'unknown', createdAt: r.state.createdAt || 'unknown',
      pauseReason: r.state.pauseReason || '', beatAt: r.beat && r.beat.stampedAt ? r.beat.stampedAt : '' });
  }
  findings.sort((a, b) => (a.own === b.own ? a.id.localeCompare(b.id) : a.own ? -1 : 1));
  return { findings, fallback: [] };
}

function instruction(f) {
  if (f.kind === 'user-paused') return 'paused by user — not resumed; leave it unless the owner resumes it.';
  if (f.own) return `this session owns it: call inspect_workflow ${f.id}, then update_workflow update_status running.`;
  return `owned by session ${f.parent}: open that session (the engine resumes the run when it loads) or press Resume in the workflow panel.`;
}

function describe(f) {
  const what = f.kind === 'restart-paused' ? 'PAUSED by agent restart'
    : f.kind === 'user-paused' ? 'PAUSED by user'
      : f.kind === 'stale' ? `RUNNING with a stale heartbeat (last ${f.beatAt}, > 10 min)`
        : `PAUSED: ${f.pauseReason || 'no reason recorded'}`;
  const name = [f.name, f.label].filter(Boolean).join(' / ');
  return `- ${f.id}${name ? ` (${name})` : ''}: ${what} · created ${f.createdAt} · parent ${f.parent}${f.own ? ' (this session)' : ''}`;
}

export function format({ findings, fallback }) {
  if (findings.length) {
    const lines = [`=== VITANA WORKFLOW WATCHDOG: ${findings.length} workflow run(s) of this workspace need attention ===`];
    for (const f of findings) { lines.push(describe(f)); lines.push(`  -> ${instruction(f)}`); }
    lines.push('=== end of watchdog report (read-only; engine state is the authority) ===');
    return lines.join('\n') + '\n';
  }
  if (fallback.length) {
    const lines = ['=== VITANA WORKFLOW WATCHDOG: engine run state not readable; run ids recorded in .agents/tasks ===',
      ...fallback.map((id) => `- ${id}\n  -> check it: call inspect_workflow ${id}; resume it only if this session owns it.`),
      '=== end of watchdog report ==='];
    return lines.join('\n') + '\n';
  }
  return '';
}

export function main(stdinText, env = process.env) {
  let input = {};
  try { input = JSON.parse(stdinText || '{}') || {}; } catch { input = {}; }
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const nowEnv = env.VITANA_WATCHDOG_NOW ? Date.parse(env.VITANA_WATCHDOG_NOW) : NaN;
  return format(scan({ home: env.VITANA_WATCHDOG_HOME || os.homedir(), cwd, sessionId: input.session_id,
    event: input.hook_event_name, now: Number.isFinite(nowEnv) ? nowEnv : Date.now() }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let stdin = '';
    if (!process.stdin.isTTY) { try { stdin = fs.readFileSync(0, 'utf8'); } catch { stdin = ''; } }
    const out = main(stdin);
    if (out) process.stdout.write(out);
  } catch { /* never fail the hook */ }
  process.exitCode = 0;
}
