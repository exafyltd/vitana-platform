#!/usr/bin/env node
/**
 * VTID-05338 (plan pipeline-speed, lane slot-sizing) — skip gate for the Kiro pipeline recipe
 * (.kiro/workflows/vitana-pipeline.workflow.json).
 *
 * The engine has no condition key and a `repeat` always runs its first iteration, so an empty lane slot or a planning
 * step a resumed run has already finished still spawned agent sessions that then did nothing. Each gated node now sits
 * in a `parallel` with `joinPolicy: "any"`: branch 1 is the command watch `<id>-skip`, branch 2 is the work, which
 * starts with the command watch `<id>-go`. Both run this program. Watches cost no agent session and no step budget.
 *
 *   - nothing to do  → `-skip` returns `terminal-state` at its first poll, `-go` stays `idle`: the race completes and
 *                      no agent step starts.
 *   - work to do     → `-go` returns `new-activity`, the work runs; `-skip` returns `idle` and pins
 *                      `cursor.decided = "run"`, so it can never abort a running step for the slot's state again
 *                      (a null slot stays null for the whole `lanes` step; plan section 2.3).
 *   - work failed    → `any` would wait for the idle `-skip` forever, so on later polls `-skip` reads the run's own
 *                      engine state read-only (terminal rule below), appends one line to RUN/blockers.md and returns
 *                      `terminal-state`. `paused` is never terminal (the engine can still resume the step).
 *   - missing data   → `-skip` stays `idle`, `-go` lets the work run: fail open to the behaviour before this gate.
 *
 * stdin (Kiro command watch): {"cursor":…,"config":{"run":"<setup output>","role":"skip"|"go","gatedNodeId":"<id>",
 *   "gatedStepIds":[…] (lane slots),"slot":"<N>" (lane slots)},"workspacePath":"…"}
 * stdout: exactly one poll result {"outcome":"idle"|"new-activity"|"terminal-state","cursor":…,"payload":"…"};
 *   always exit 0 (exit codes are unreliable through Windows PowerShell). Writes nothing but RUN/blockers.md.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runDirFrom } = require('./store-review.cjs');

/** Planning / approval steps and the RUN facts that make each one already done (plan D4 b, c). */
const PLANNING = Object.freeze(['investigate', 'spec', 'plan-pr']);
const APPROVAL = Object.freeze(['spar-loop', 'merge-plan']);
const TERMINAL = new Set(['failed', 'cancelled', 'aborted']);
const ACTIVE = new Set(['running', 'paused']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/**
 * Skip decision for one gated node: true = nothing to do, false = work to do, null = cannot tell (RUN unreadable).
 * Lane slot: RUN/slots.json slots[N] is null. investigate / spec / plan-pr: the id is in run.json steps_done, or
 * plan_pr is set, or slots.json exists. spar-loop / merge-plan: the id is in steps_done or slots.json exists.
 */
function skipDecision(runDir, config) {
  if (!runDir || !fs.existsSync(runDir)) return null;
  const id = String(config.gatedNodeId || '');
  const slotsFile = path.join(runDir, 'slots.json');
  if (config.slot !== undefined && config.slot !== null && String(config.slot) !== '') {
    const slots = readJson(slotsFile);
    if (!slots || typeof slots !== 'object' || !slots.slots || typeof slots.slots !== 'object') return null;
    const key = String(config.slot);
    if (!Object.prototype.hasOwnProperty.call(slots.slots, key)) return null;
    return slots.slots[key] === null;
  }
  if (!PLANNING.includes(id) && !APPROVAL.includes(id)) return null;
  // slots.json counts only when it parses with a slots map (merge-plan finished); a torn file never skips work.
  const slotsDoc = readJson(slotsFile);
  const hasSlots = !!(slotsDoc && typeof slotsDoc === 'object' && slotsDoc.slots && typeof slotsDoc.slots === 'object');
  const run = readJson(path.join(runDir, 'run.json'));
  if (run === undefined && !hasSlots) return null;
  const done = run && Array.isArray(run.steps_done) ? run.steps_done : [];
  if (done.includes(id) || hasSlots) return true;
  if (PLANNING.includes(id) && run && run.plan_pr !== null && run.plan_pr !== undefined) return true;
  return false;
}

/** The workflow id of a RUN folder `…/pipeline-<wf id>`. */
function workflowIdFrom(runDir) {
  const m = /pipeline-([\w-]+)$/.exec(path.basename(String(runDir || '')));
  return m ? m[1] : null;
}

/**
 * The run's engine state `<home>/.kiro/sessions/<dir>/workflows/<wf id>/workflow-state.json`, found by enumerating
 * the sessions folder (node fs has no glob). Read-only. undefined when absent or unreadable.
 */
function readEngineState(home, wfId) {
  if (!wfId) return undefined;
  const base = path.join(home, '.kiro', 'sessions');
  let dirs;
  try { dirs = fs.readdirSync(base); } catch { return undefined; }
  for (const d of dirs) {
    const f = path.join(base, d, 'workflows', wfId, 'workflow-state.json');
    if (fs.existsSync(f)) return readJson(f);
  }
  return undefined;
}

/** Every instance of node `id` in the state tree (`root` → `children`), with its ancestor chain (outermost first). */
function instances(tree, id) {
  const out = [];
  const walk = (n, chain) => {
    if (!n || typeof n !== 'object') return;
    if (n.nodeId === id) out.push({ node: n, chain });
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c, [...chain, n]);
  };
  walk(tree, []);
  return out;
}

/**
 * Plan D3 terminal rule, on the engine's observed layout (nodes `{nodeId, type, status, iteration?, children?}`,
 * repeat iterations as `<repeat id>#<i>` sequences; recorded in docs/validation/VTID-05338/commands.log).
 * Terminal when the gated node itself is failed / cancelled / aborted, or when a gated inner step is, none of the
 * gated steps is running or paused, and the failure was not absorbed on the way up: no ancestor between the gated
 * node and the step is `completed` (an earlier iteration, or a race that another branch won) or a still running
 * `parallel` (a race branch that failed while the others go on). Returns the reason text, or null.
 */
function terminalReason(state, config) {
  const root = state && state.root;
  if (!root) return null;
  const gated = instances(root, String(config.gatedNodeId || ''));
  if (gated.length === 0) return null;
  for (const g of gated) {
    if (TERMINAL.has(g.node.status)) return `${g.node.nodeId} ${g.node.status}${g.node.failureReason ? ` (${g.node.failureReason})` : ''}`;
  }
  const ids = Array.isArray(config.gatedStepIds) ? config.gatedStepIds.map(String) : [];
  if (ids.length === 0) return null;
  const found = [];
  for (const g of gated) {
    for (const id of ids) {
      for (const hit of instances(g.node, id)) {
        if (hit.node === g.node) continue;
        found.push({ ...hit, chain: hit.chain.slice(hit.chain.indexOf(g.node) + 1) });
      }
    }
  }
  if (found.some((h) => ACTIVE.has(h.node.status))) return null;
  for (const h of found) {
    if (!TERMINAL.has(h.node.status)) continue;
    const absorbed = h.chain.some((a) => a.status === 'completed' || (a.type === 'parallel' && a.status === 'running'));
    if (!absorbed) return `${h.node.nodeId} ${h.node.status}${h.node.failureReason ? ` (${h.node.failureReason})` : ''}`;
  }
  return null;
}

function appendBlocker(runDir, line) {
  try { fs.appendFileSync(path.join(runDir, 'blockers.md'), line + '\n'); } catch { /* RUN not writable: the result still ends the race */ }
}

/** Pure poll decision (plus the one blockers line). opts: {home, now} for tests. */
function poll(input, opts = {}) {
  const config = (input && input.config) || {};
  const cursor = input && input.cursor && typeof input.cursor === 'object' ? input.cursor : null;
  const role = config.role === 'go' ? 'go' : config.role === 'skip' ? 'skip' : null;
  const id = String(config.gatedNodeId || '?');
  if (!role) return { outcome: 'idle', cursor, payload: `run-gate ${id}: unknown role ${JSON.stringify(config.role)}` };
  const runDir = runDirFrom(config.run);
  if (role === 'go') {
    const skip = skipDecision(runDir, config);
    if (skip === true) return { outcome: 'idle', cursor: { decided: 'skip' }, payload: `run-gate ${id}: nothing to do, waiting for ${id}-skip` };
    return { outcome: 'new-activity', cursor: { decided: 'run' }, payload: `run-gate ${id}: ${skip === null ? 'RUN unreadable, running (fail open)' : 'work to do'}` };
  }
  if (!cursor || !cursor.decided) {
    const skip = skipDecision(runDir, config);
    if (skip === true) return { outcome: 'terminal-state', cursor: { decided: 'skip' }, payload: `run-gate ${id}: skipped, nothing to do` };
    // Unreadable RUN pins "run" too: data that appears later must never abort work the go watch already started.
    if (skip === null) return { outcome: 'idle', cursor: { decided: 'run' }, payload: `run-gate ${id}: RUN unreadable, not skipping` };
    return { outcome: 'idle', cursor: { decided: 'run' }, payload: `run-gate ${id}: work to do, watching for a failed run` };
  }
  const home = opts.home || os.homedir();
  const reason = terminalReason(readEngineState(home, workflowIdFrom(runDir)), config);
  if (!reason) return { outcome: 'idle', cursor, payload: `run-gate ${id}: running` };
  const at = (opts.now ? new Date(opts.now) : new Date()).toISOString();
  appendBlocker(runDir, `- ${at} run-gate: ${reason}; the ${id}-skip watch completed the gate race so the run goes on (a failed branch would otherwise wait on it forever); state files keep done:false for the later steps to report.`);
  return { outcome: 'terminal-state', cursor: { ...cursor, ended: reason }, payload: `run-gate ${id}: ${reason}` };
}

function main() {
  let result;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    result = poll(raw.trim() ? JSON.parse(raw) : {});
  } catch (e) {
    result = { outcome: 'idle', cursor: null, payload: `run-gate: ${e && e.message ? e.message : String(e)}` };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { poll, skipDecision, terminalReason, readEngineState, workflowIdFrom, PLANNING, APPROVAL };

if (require.main === module) main();
