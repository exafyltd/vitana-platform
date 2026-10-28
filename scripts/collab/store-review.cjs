#!/usr/bin/env node
/**
 * Reviewer output store for the Kiro pipeline recipe (.kiro/workflows/vitana-pipeline.workflow.json).
 *
 * Each lane slot runs its three pinned `vitana-lane-reviewer` steps (one per chain model) as the branches of one
 * `parallel` with `joinPolicy: "any"`, so an unavailable model never blocks the slot. Every branch is
 * `[review step, command watch]`; this program is that watch's command. It runs once, right after its own review
 * step completed, and copies that step's output into the run folder, because the land step cannot read the branch
 * outputs directly (a `{{<id>.output}}` of a failed or aborted branch has no captured value and fails the step).
 *
 * The reviewer agent stays read-only: this program, not the agent, writes the file.
 *
 * stdin (Kiro command watch): {"cursor":…,"config":{"run":"<setup output>","model":"<pinned id>","slot":"<N>",
 *   "output":"<the review step's output>"},"workspacePath":"…"}
 * stdout: one watch poll result, always `terminal-state`, so the watch ends after one poll on every platform.
 * Writes RUN/reviews/<LANE>-<head7>.out-<model>.md only when the output holds a verdict JSON line; never overwrites.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** RUN path from the setup step's output: a line `RUN=<absolute path>`, else the first `…/.agents/tasks/pipeline-…` path. */
function runDirFrom(text) {
  const s = String(text || '');
  const line = /^\s*RUN=(.+?)\s*$/m.exec(s);
  if (line) return line[1].replace(/[\\/]+$/, '');
  const any = /([A-Za-z]:)?[\\/][^\s`'"<>|]*?[\\/]\.agents[\\/]tasks[\\/]pipeline-[\w-]+/.exec(s);
  return any ? any[0] : null;
}

/** The verdict JSON (block 1): the first line that parses as an object with a `verdict` key. */
function verdictFrom(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{') || !line.includes('"verdict"')) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && typeof v.verdict === 'string') return v;
    } catch { /* not this line */ }
  }
  return null;
}

/** Lane id from the entry's `Collab-Review: <slug>/<lane-id>` trailer, else RUN/slots.json slots[<slot>]. */
function laneFrom(text, runDir, slot) {
  const m = /^\s*Collab-Review:\s*\S+\/([A-Za-z0-9._-]+)\s*$/m.exec(String(text || ''));
  if (m) return m[1];
  try {
    const slots = JSON.parse(fs.readFileSync(path.join(runDir, 'slots.json'), 'utf8'));
    const lane = slots && slots.slots ? slots.slots[String(slot)] : null;
    return typeof lane === 'string' && /^[A-Za-z0-9._-]+$/.test(lane) ? lane : null;
  } catch {
    return null;
  }
}

/** Pure decision + write. Returns a short human note (the watch payload). */
function store(input) {
  const config = (input && input.config) || {};
  const output = String(config.output || '');
  const model = String(config.model || '');
  if (!/^claude-[a-z0-9.-]+$/.test(model)) return `not stored: model ${JSON.stringify(model)} is not a Claude model id`;
  const runDir = runDirFrom(config.run);
  if (!runDir || !fs.existsSync(runDir)) return `not stored: RUN folder not found (${runDir || 'no RUN= line in the setup output'})`;
  const verdict = verdictFrom(output);
  if (!verdict) return `not stored: no verdict in the ${model} output (${output.trim().slice(0, 80) || 'empty'})`;
  const head = String(verdict.head_sha || '');
  if (!/^[0-9a-f]{40}$/.test(head)) return `not stored: verdict head_sha is not 40 hex`;
  const lane = laneFrom(output, runDir, config.slot);
  if (!lane) return 'not stored: lane id not found (no Collab-Review trailer, no RUN/slots.json entry)';
  const dir = path.join(runDir, 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${lane}-${head.slice(0, 7)}.out-${model}.md`);
  try {
    fs.writeFileSync(file, output.endsWith('\n') ? output : output + '\n', { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') return `kept existing ${file}`;
    throw e;
  }
  return `stored ${file}`;
}

function main() {
  let note;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    note = store(raw.trim() ? JSON.parse(raw) : {});
  } catch (e) {
    note = `not stored: ${e && e.message ? e.message : String(e)}`;
  }
  // Always a valid terminal result (exit 0): the watch ends after this one poll, also on Windows PowerShell.
  process.stdout.write(JSON.stringify({ outcome: 'terminal-state', cursor: null, payload: note }) + '\n');
}

module.exports = { store, runDirFrom, verdictFrom, laneFrom };

if (require.main === module) main();
