#!/usr/bin/env node
/**
 * VTID-05059 — Kiro steering guard.
 *
 * Kiro IDE reads `.kiro/steering/*.md`; Claude Code reads `CLAUDE.md` and
 * `.claude/rules/*.md`. The steering files link to those files instead of
 * copying them. This guard keeps the two in step:
 *   1. every `.claude/rules/<x>.md` has a steering file that links it, with
 *      `inclusion: fileMatch` and `fileMatchPattern` equal to its `paths:`;
 *   2. every `#[[file:…]]` link in a steering file points at a file that exists;
 *   3. an always-included steering file links `CLAUDE.md`.
 * Usage: node scripts/ci/kiro-steering/guard.cjs [repoRoot]
 */
'use strict';
const fs = require('fs');
const path = require('path');

function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : '';
}

/** Minimal YAML for the two shapes used here: `key: value` and `key:` + `  - item` lists. */
function parseFrontMatter(fm) {
  const out = {};
  let listKey = null;
  for (const raw of fm.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) { out[listKey].push(unquote(item[1].trim())); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    if (kv[2] === '') { listKey = kv[1]; out[listKey] = []; } else { listKey = null; out[kv[1]] = unquote(kv[2].trim()); }
  }
  return out;
}

function unquote(s) {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

function asList(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function fileLinks(text) {
  return [...text.matchAll(/#\[\[file:([^\]]+)\]\]/g)].map((m) => m[1].trim());
}

function check(root) {
  const errors = [];
  const rulesDir = path.join(root, '.claude', 'rules');
  const steerDir = path.join(root, '.kiro', 'steering');
  const rules = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md')) : [];
  const steering = fs.existsSync(steerDir) ? fs.readdirSync(steerDir).filter((f) => f.endsWith('.md')) : [];
  if (steering.length === 0) return ['no .kiro/steering/*.md files'];

  const parsed = steering.map((f) => {
    const text = fs.readFileSync(path.join(steerDir, f), 'utf8');
    return { file: f, text, fm: parseFrontMatter(frontMatter(text)), links: fileLinks(text) };
  });

  for (const s of parsed) {
    for (const link of s.links) {
      if (!fs.existsSync(path.join(root, link))) errors.push(`.kiro/steering/${s.file}: #[[file:${link}]] does not exist`);
    }
  }

  if (!parsed.some((s) => (s.fm.inclusion ?? 'always') === 'always' && s.links.includes('CLAUDE.md'))) {
    errors.push('no always-included steering file links CLAUDE.md');
  }

  for (const r of rules) {
    const rel = `.claude/rules/${r}`;
    const paths = asList(parseFrontMatter(frontMatter(fs.readFileSync(path.join(rulesDir, r), 'utf8'))).paths);
    const twins = parsed.filter((s) => s.links.includes(rel));
    if (twins.length === 0) { errors.push(`${rel} has no .kiro/steering twin linking it`); continue; }
    for (const t of twins) {
      if (t.fm.inclusion !== 'fileMatch') errors.push(`.kiro/steering/${t.file}: links ${rel} but inclusion is not fileMatch`);
      const globs = asList(t.fm.fileMatchPattern);
      if (JSON.stringify([...globs].sort()) !== JSON.stringify([...paths].sort())) {
        errors.push(`.kiro/steering/${t.file}: fileMatchPattern ${JSON.stringify(globs)} != ${rel} paths ${JSON.stringify(paths)}`);
      }
    }
  }
  // VTID-05275: the reviewer agent and the pipeline recipe live only in vitana-platform (the repo with
  // scripts/collab/queue.mjs); vitana-v1 ships the same guard without them and stays green.
  if (fs.existsSync(path.join(root, 'scripts', 'collab', 'queue.mjs'))) errors.push(...checkAgents(root));
  // Plan owner-autonomy: the standing owner instruction and its complete stop table.
  errors.push(...checkOwnerAutonomy(root));
  return errors;
}

/*
 * VTID-05275: reviewer agent + pipeline recipe (plan kiro-autonomy-fallback, sections 4.1, 4.2, 5 G).
 * The agent's accept unlocks merges, so its definition is pinned here: a change that widens its tools, swaps its
 * model or drops the fail-loudly / protected-file rules is a red test, not a quiet edit.
 */
const REVIEWER = '.kiro/agents/vitana-lane-reviewer.md';
// Ordered reviewer model fallback chain. MIRROR of services/gateway/src/services/project-manager/governance.ts
// REVIEWER_AGENT_MODELS (guard.test.cjs pins both to the same values). The engine takes one modelId per step and fails
// a step whose pinned model cannot be served, so each repeat that reviews holds ONE `parallel` with joinPolicy `any`
// whose branches are `[review step pinned to chain model i, store watch]`, in chain order: the first branch to finish
// wins, a failed branch is tolerated, the parallel fails only when all three fail. The agent's front matter may be
// unset or a chain model.
const REVIEWER_MODELS = Object.freeze(['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-sonnet-4.5']);
// The watch command that copies a finished review step's output to RUN/reviews/ (the reviewer agent stays read-only).
const STORE_COMMAND = 'node scripts/collab/store-review.cjs';
const WORKFLOW = '.kiro/workflows/vitana-pipeline.workflow.json';
const HOOK = '.kiro/hooks/vitana-pipeline-start.json';
const PIPELINE_DIR = '.kiro/pipeline';
const PIPELINE_STEERING = '.kiro/steering/vitana-pipeline.md';
// Named as text only and owned by another lane (plan section 7, "text-only cross references"); not required to exist.
// VTID-05359: driver.md left this set; it is a required runbook with required content (RUNBOOK_REQUIRED below).
const TEXT_ONLY_REFS = new Set([]);
// VTID-05359 (plan reviewer-step-model D1-D3): every pinned review step's prompt starts with exactly
// `Reviewer chain model for this step: <its modelId>. `; the agent's self-check keys on that line.
const REVIEW_MODEL_LABEL = 'Reviewer chain model for this step: ';
// Runbooks that must exist and carry these strings (a missing file or string is a `missing` error).
const RUNBOOK_REQUIRED = Object.freeze({
  '.kiro/pipeline/lane-review.md': [REVIEW_MODEL_LABEL],
  '.kiro/pipeline/driver.md': [REVIEW_MODEL_LABEL],
});
const ALLOWED_TOOLS = new Set(['read', 'shell']);
const REQUIRED_EXCLUDED = ['fs_write', 'fs_append', 'str_replace', 'delete_file'];
const REQUIRED_BODY = [
  'model_unavailable',
  '"verdict"', '"head_sha"', '"findings"', '"severity"', '"model"', '"agent"',
  'Collab-Session:', 'Collab-Review:', 'Collab-Verdict:',
  'Collab-Reviewer: agent:vitana-lane-reviewer (<model>)', 'Collab-Reviewed-Head:',
  'protected-gate-files.json',
  `Model chain: ${REVIEWER_MODELS.map((m) => '`' + m + '`').join(' → ')}`,
  REVIEW_MODEL_LABEL,
];
// Bundled Kiro workflow agents a recipe may use; workspace agents come from .kiro/agents/*.md.
const BUNDLED_AGENTS = ['wf-coder', 'wf-planner', 'wf-code-reviewer', 'wf-design', 'wf-design-reviewer'];
const MAX_PARALLEL_LANES = 6;

function readText(root, rel) {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
function pipelineRefs(text) {
  return [...new Set([...text.matchAll(/\.kiro\/pipeline\/[\w.-]+\.md/g)].map((m) => m[0]))];
}
function walkNodes(nodes, fn) {
  for (const n of nodes || []) {
    if (!n || typeof n !== 'object') continue;
    fn(n);
    walkNodes(n.steps, fn);
    walkNodes(n.branches, fn);
  }
}

function checkAgents(root) {
  const errors = [];
  const agentsDir = path.join(root, '.kiro', 'agents');
  const agentNames = new Set();
  if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir).filter((x) => x.endsWith('.md'))) {
      const fm = parseFrontMatter(frontMatter(fs.readFileSync(path.join(agentsDir, f), 'utf8')));
      if (!fm.name) errors.push(`.kiro/agents/${f}: no front matter name`);
      else agentNames.add(fm.name);
    }
  }
  const agent = readText(root, REVIEWER);
  if (agent === null) {
    errors.push(`${REVIEWER} missing`);
  } else {
    const fm = parseFrontMatter(frontMatter(agent));
    if (fm.name !== 'vitana-lane-reviewer') errors.push(`${REVIEWER}: name must be vitana-lane-reviewer`);
    if (fm.model !== undefined && !REVIEWER_MODELS.includes(fm.model)) {
      errors.push(`${REVIEWER}: model must be unset (the review step pins it) or one of ${REVIEWER_MODELS.join(', ')}`);
    }
    const tools = asList(fm.tools);
    const extra = tools.filter((t) => !ALLOWED_TOOLS.has(t));
    if (tools.length === 0 || extra.length) {
      errors.push(`${REVIEWER}: tools must be a subset of read, shell (got ${JSON.stringify(tools)}; not allowed: ${extra.join(', ')})`);
    }
    const excluded = asList(fm.excludedTools);
    for (const t of REQUIRED_EXCLUDED) if (!excluded.includes(t)) errors.push(`${REVIEWER}: excludedTools must contain ${t}`);
    if (fm.includeMcpJson === 'true') errors.push(`${REVIEWER}: includeMcpJson must not be true`);
    if (fm.includePowers === 'true') errors.push(`${REVIEWER}: includePowers must not be true`);
    for (const s of REQUIRED_BODY) if (!agent.includes(s)) errors.push(`${REVIEWER}: prompt is missing ${s}`);
  }
  let wf = null;
  const wfText = readText(root, WORKFLOW);
  if (wfText === null) errors.push(`${WORKFLOW} missing`);
  else {
    try { wf = JSON.parse(wfText); } catch (e) { errors.push(`${WORKFLOW}: does not parse (${e.message})`); }
  }
  if (wf) {
    for (const e of validateWorkflow(wf, agentNames)) errors.push(`${WORKFLOW}: ${e}`);
    const reviewSteps = [];
    walkNodes(wf.steps, (n) => { if (n.type === 'step' && n.agent === 'vitana-lane-reviewer') reviewSteps.push(n); });
    if (reviewSteps.length === 0) errors.push(`${WORKFLOW}: no step uses agent vitana-lane-reviewer`);
    for (const s of reviewSteps) {
      if (!REVIEWER_MODELS.includes(s.modelId)) {
        errors.push(`${WORKFLOW}: review step ${s.id} modelId must be one of ${REVIEWER_MODELS.join(', ')}`);
      }
      const line = REVIEW_MODEL_LABEL + s.modelId + '. ';
      const p = typeof s.prompt === 'string' ? s.prompt : '';
      if (!p.startsWith(line) || p.split(REVIEW_MODEL_LABEL).length !== 2) {
        errors.push(`${WORKFLOW}: review step ${s.id} prompt must start with "${line}"`);
      }
    }
    const raced = new Set();
    walkNodes(wf.steps, (n) => {
      if (n.type !== 'repeat') return;
      if (!JSON.stringify(n.steps || []).includes('"vitana-lane-reviewer"')) return;
      for (const e of reviewRace(n)) errors.push(`${WORKFLOW}: ${n.id} ${e}`);
      for (const p of (n.steps || []).filter((s) => s && s.type === 'parallel')) {
        walkNodes([p], (s) => { if (s.type === 'step' && s.agent === 'vitana-lane-reviewer') raced.add(s.id); });
      }
    });
    for (const s of reviewSteps) {
      if (!raced.has(s.id)) errors.push(`${WORKFLOW}: review step ${s.id} must be a branch of a lane slot's joinPolicy any review race`);
    }
    // VTID-05338 item 3: a pinned model outside the reviewer race is a single model that can stall the pipeline.
    walkNodes(wf.steps, (n) => {
      if (n.type !== 'step' || n.modelId === undefined) return;
      if (!raced.has(n.id) || !REVIEWER_MODELS.includes(n.modelId)) {
        errors.push(`${WORKFLOW}: step ${n.id} pins modelId ${n.modelId}; only reviewer race steps pin a model, and only a chain model (${REVIEWER_MODELS.join(', ')})`);
      }
    });
    for (const e of gateErrors(wf)) errors.push(`${WORKFLOW}: ${e}`);
    walkNodes(wf.steps, (n) => {
      if (n.type === 'parallel' && JSON.stringify(n).includes('"vitana-lane-reviewer"') && (n.branches || []).length > MAX_PARALLEL_LANES) {
        errors.push(`${WORKFLOW}: ${n.id} has more than ${MAX_PARALLEL_LANES} parallel lane branches`);
      }
    });
    if (!wfText.includes('merge.lock')) errors.push(`${WORKFLOW}: lane landing must take the merge.lock (one merge at a time)`);
    for (const ref of pipelineRefs(wfText)) {
      if (!TEXT_ONLY_REFS.has(ref) && !fs.existsSync(path.join(root, ref))) errors.push(`${WORKFLOW}: ${ref} does not exist`);
    }
  }
  const steer = readText(root, PIPELINE_STEERING);
  if (steer !== null) {
    for (const ref of pipelineRefs(steer)) {
      if (!TEXT_ONLY_REFS.has(ref) && !fs.existsSync(path.join(root, ref))) errors.push(`${PIPELINE_STEERING} names ${ref}, which does not exist`);
    }
  }
  const hookText = readText(root, HOOK);
  if (hookText === null) errors.push(`${HOOK} missing`);
  else {
    let h = null;
    try { h = JSON.parse(hookText); } catch (e) { errors.push(`${HOOK}: does not parse (${e.message})`); }
    const first = h && Array.isArray(h.hooks) ? h.hooks[0] : null;
    if (h && (h.version !== 'v1' || !first || first.trigger !== 'SessionStart' || !first.action || first.action.type !== 'agent'
      || typeof first.action.prompt !== 'string' || !first.action.prompt.includes(PIPELINE_STEERING))) {
      errors.push(`${HOOK}: must be version v1 with a SessionStart hook whose agent action prompt loads ${PIPELINE_STEERING}`);
    }
  }
  for (const [rel, required] of Object.entries(RUNBOOK_REQUIRED)) {
    const text = readText(root, rel);
    if (text === null) { errors.push(`${rel} missing`); continue; }
    for (const s of required) if (!text.includes(s)) errors.push(`${rel}: is missing ${s}`);
  }
  const pipeDir = path.join(root, PIPELINE_DIR);
  const runbooks = fs.existsSync(pipeDir) ? fs.readdirSync(pipeDir).filter((f) => f.endsWith('.md')) : [];
  for (const f of runbooks) {
    const text = fs.readFileSync(path.join(pipeDir, f), 'utf8');
    if (/kiro-autonomy-fallback/.test(text)) errors.push(`${PIPELINE_DIR}/${f}: slug-specific text (kiro-autonomy-fallback); runbooks are generic`);
    if (/[a-z]:[\\/]users[\\/]/i.test(text)) errors.push(`${PIPELINE_DIR}/${f}: machine-specific path; use <vitana-platform> / <vitana-v1>`);
    for (const line of text.split(/\r?\n/)) {
      const asks = /(do you want me to|shall i\b|ask the owner (before|for|whether|if)\b|wait for (the )?owner('s)? approval)/i.test(line);
      if (asks && !/\b(never|not|no)\b/i.test(line)) errors.push(`${PIPELINE_DIR}/${f}: owner question outside Gate 2: ${line.trim().slice(0, 80)}`);
    }
  }
  return errors;
}

/**
 * The review race of one lane slot (repeat `slot`): exactly one direct `parallel` child with joinPolicy `any` holds
 * every reviewer step; its branches are, in chain order, `sequence [review step pinned to REVIEWER_MODELS[i], command
 * watch STORE_COMMAND with config.model = that model and config.output = {{<review step id>.output}}]`.
 */
function reviewRace(slot) {
  const errors = [];
  const races = (slot.steps || []).filter((s) => s && s.type === 'parallel' && JSON.stringify(s).includes('"vitana-lane-reviewer"'));
  if (races.length !== 1) return [`must hold its review steps in exactly one parallel review race (got ${races.length})`];
  const race = races[0];
  if (race.joinPolicy !== 'any') errors.push(`review race ${race.id} must use joinPolicy any (an unavailable model must not fail the slot)`);
  const branches = race.branches || [];
  const models = branches.map((b) => (b && b.type === 'sequence' && b.steps && b.steps[0] ? b.steps[0].modelId : undefined));
  if (JSON.stringify(models) !== JSON.stringify(REVIEWER_MODELS)) {
    errors.push(`review race ${race.id} must have one branch per chain model in order ${REVIEWER_MODELS.join(' -> ')} (got ${models.map(String).join(' -> ')})`);
  }
  branches.forEach((b, i) => {
    const [rv, st, ...rest] = (b && b.steps) || [];
    const okReview = b && b.type === 'sequence' && rv && rv.type === 'step' && rv.agent === 'vitana-lane-reviewer';
    const c = st && st.config;
    const okStore = st && st.type === 'watch' && st.handler === 'command' && c && c.command === STORE_COMMAND
      && c.model === (rv && rv.modelId) && okReview && c.output === `{{${rv.id}.output}}` && rest.length === 0;
    if (!okReview || !okStore) {
      errors.push(`review race ${race.id} branch ${i + 1} must be a sequence [vitana-lane-reviewer step, command watch '${STORE_COMMAND}' storing that step's output for its model]`);
    }
  });
  return errors;
}

/*
 * VTID-05338 (plan pipeline-speed D1-D4, D3a): skip gates. Every lane slot and each planning / approval step sits in
 * its own `parallel` joinPolicy `any` race `[watch <x>-skip, <work>]`; the work is the lane slot repeat with the
 * `-go` watch as its first child, or a `sequence [watch <x>-go, <step>]`. Both watches run GATE_COMMAND with the
 * same recipe, so an empty slot or an already finished step starts no agent session.
 */
const GATE_COMMAND = 'node scripts/collab/run-gate.cjs';
const GATED_STEPS = Object.freeze(['investigate', 'spec', 'plan-pr', 'spar-loop', 'merge-plan']);
const GATE_POLL_SEC = 30;
const GATE_COMMAND_TIMEOUT_SEC = 30;
const GATE_IDLE_TIMEOUT_SEC = 86400;

function isGateWatch(n) {
  return !!(n && n.type === 'watch' && n.config && n.config.command === GATE_COMMAND);
}
function stepIdsOf(n, out = []) {
  if (!n || typeof n !== 'object') return out;
  if (n.type === 'step') out.push(n.id);
  for (const c of [...(n.steps || []), ...(n.branches || [])]) stepIdsOf(c, out);
  return out;
}
/** The D3a recipe of one gate watch; `slot` = the lane slot's repeat node, or null for a planning / approval step. */
function gateWatchErrors(w, target, role, slot) {
  const where = `gate watch ${w && w.id} of ${target}`;
  const c = (w && w.config) || {};
  const errors = [];
  if (!w || w.type !== 'watch' || w.handler !== 'command' || c.command !== GATE_COMMAND) return [`${where} must be a command watch running '${GATE_COMMAND}'`];
  if (c.role !== role) errors.push(`${where}: config.role must be ${role}`);
  if (c.gatedNodeId !== target) errors.push(`${where}: config.gatedNodeId must be ${target}`);
  if (c.run !== '{{setup.output}}') errors.push(`${where}: config.run must be {{setup.output}}`);
  if (c.pollIntervalSec !== GATE_POLL_SEC || c.commandTimeoutSec !== GATE_COMMAND_TIMEOUT_SEC) {
    errors.push(`${where}: pollIntervalSec and commandTimeoutSec must be ${GATE_POLL_SEC}`);
  }
  if (typeof w.idleTimeoutSec !== 'number' || w.idleTimeoutSec < GATE_IDLE_TIMEOUT_SEC) errors.push(`${where}: idleTimeoutSec must be at least ${GATE_IDLE_TIMEOUT_SEC}`);
  if (slot) {
    if (JSON.stringify(c.gatedStepIds) !== JSON.stringify(stepIdsOf(slot))) errors.push(`${where}: config.gatedStepIds must list the slot's step ids ${JSON.stringify(stepIdsOf(slot))}`);
    const n = /^lane-slot-(\d+)$/.exec(target);
    if (typeof c.slot !== 'string' || (n && c.slot !== n[1])) errors.push(`${where}: config.slot must be the slot number as a string`);
  } else if (c.gatedStepIds !== undefined || c.slot !== undefined) {
    errors.push(`${where}: gatedStepIds and slot are for lane slots only`);
  }
  return errors;
}
/** Every lane slot (a repeat holding the reviewer) and every GATED_STEPS node is gated by exactly one skip/go pair. */
function gateErrors(wf) {
  const errors = [];
  const nodes = new Map();
  const slots = [];
  const gates = new Map();
  walkNodes(wf.steps, (n) => {
    if (typeof n.id === 'string') nodes.set(n.id, n);
    if (n.type === 'repeat' && JSON.stringify(n.steps || []).includes('"vitana-lane-reviewer"')) slots.push(n.id);
    if (isGateWatch(n)) {
      const t = String(n.config.gatedNodeId);
      gates.set(t, [...(gates.get(t) || []), n]);
    }
  });
  const targets = [...GATED_STEPS, ...slots];
  for (const t of gates.keys()) if (!targets.includes(t)) errors.push(`gate watches name ${t}, which is not a lane slot or a gated step`);
  const races = [];
  walkNodes(wf.steps, (n) => { if (n.type === 'parallel' && (n.branches || []).some(isGateWatch)) races.push(n); });
  for (const t of targets) {
    const target = nodes.get(t);
    if (!target) { errors.push(`gated node ${t} missing`); continue; }
    const slot = slots.includes(t) ? target : null;
    const pair = gates.get(t) || [];
    if (pair.length !== 2) { errors.push(`${t} must be gated by exactly one ${GATE_COMMAND} skip/go pair (got ${pair.length} gate watches)`); continue; }
    const race = races.find((r) => (r.branches || []).includes(target) || (r.branches || []).some((b) => b && b.type === 'sequence' && (b.steps || []).includes(target)));
    const [skip, work, ...rest] = (race && race.branches) || [];
    if (!race || race.joinPolicy !== 'any' || rest.length || !isGateWatch(skip)) {
      errors.push(`${t} must sit in a parallel joinPolicy any [watch ${t}-skip, work] gate race`);
      continue;
    }
    const go = slot ? (work === target ? (target.steps || [])[0] : null)
      : (work && work.type === 'sequence' && (work.steps || []).length === 2 && work.steps[1] === target ? work.steps[0] : null);
    if (!isGateWatch(go)) {
      errors.push(slot ? `${t}: the gate race's work branch must be the slot repeat with its go watch as first child`
        : `${t}: the gate race's work branch must be a sequence [go watch, ${t}]`);
      continue;
    }
    errors.push(...gateWatchErrors(skip, t, 'skip', slot), ...gateWatchErrors(go, t, 'go', slot));
  }
  return errors;
}

/**
 * Structural validation of a Kiro workflow recipe, mirroring the Kiro workflow schema: node types step / sequence /
 * repeat / parallel / watch with their required keys and enums, unique ids, at most 50 steps, nesting depth at most 8,
 * a repeat has exactly one of stopCondition / stopWhen, fileCheck is strict, every agent is known, and every
 * {{template}} names an input, previous.output or <node id>.output. `workspaceAgents` = names from .kiro/agents/*.md.
 */
function validateWorkflow(wf, workspaceAgents) {
  const errors = [];
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return ['workflow must be a JSON object'];
  const ROOT_KEYS = new Set(['name', 'description', 'inputs', 'steps', 'modelId', 'effortLevel', 'injectOriginalUserRequest', 'planRevision']);
  for (const k of Object.keys(wf)) if (!ROOT_KEYS.has(k)) errors.push(`unknown root key ${k}`);
  if (typeof wf.name !== 'string' || !wf.name) errors.push('name must be a non-empty string');
  const inputs = wf.inputs === undefined ? {} : wf.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.values(inputs).some((v) => typeof v !== 'string')) {
    errors.push('inputs must map names to type hints');
  }
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) return errors.concat('steps must be a non-empty array');
  const agents = new Set([...BUNDLED_AGENTS, ...(workspaceAgents || [])]);
  const STEP_KEYS = new Set(['type', 'id', 'agent', 'prompt', 'artifacts', 'captureOutput', 'completion', 'modelId', 'effortLevel']);
  const ids = new Set();
  const templates = [];
  // node id -> the joinPolicy any branches it sits in ("<parallel id>#<branch index>"): a failed or aborted branch of
  // such a parallel has no captured output, and a template naming it from outside that branch fails at run time.
  const anyPath = new Map();
  let curAny = [];
  let stepCount = 0;
  const collect = (at, text) => { for (const m of text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) templates.push([at, m[1], curAny]); };
  function stop(sc, where) {
    if (!sc || typeof sc !== 'object') { errors.push(`${where}: stopCondition must be an object`); return; }
    const known = ['containsText', 'fileCheck', 'completionSignal'];
    for (const k of Object.keys(sc)) if (!known.includes(k)) errors.push(`${where}: unknown stopCondition key ${k}`);
    if (!known.some((k) => sc[k] !== undefined)) errors.push(`${where}: stopCondition needs containsText, fileCheck or completionSignal`);
    if (sc.completionSignal !== undefined && !['success', 'need_input', 'error'].includes(sc.completionSignal)) errors.push(`${where}: bad completionSignal`);
    if (sc.fileCheck !== undefined) {
      const fc = sc.fileCheck;
      const keys = fc && typeof fc === 'object' ? Object.keys(fc) : [];
      if (keys.some((k) => !['path', 'jsonPath', 'value'].includes(k)) || typeof fc.path !== 'string' || typeof fc.jsonPath !== 'string' || !('value' in fc)) {
        errors.push(`${where}: fileCheck allows exactly path, jsonPath, value`);
      }
    }
  }
  function node(n, depth, inParallel) {
    if (!n || typeof n !== 'object') { errors.push('node must be an object'); return; }
    const where = `node ${n.id || '?'}`;
    if (depth > 8) errors.push(`${where}: nesting deeper than 8`);
    if (typeof n.id !== 'string' || !n.id) errors.push(`${where}: id required`);
    else if (ids.has(n.id)) errors.push(`duplicate id ${n.id}`);
    else { ids.add(n.id); anyPath.set(n.id, curAny); }
    switch (n.type) {
      case 'step':
        stepCount++;
        for (const k of Object.keys(n)) if (!STEP_KEYS.has(k)) errors.push(`${where}: unknown step key ${k}`);
        if (typeof n.agent !== 'string' || !n.agent) errors.push(`${where}: agent required`);
        else if (!agents.has(n.agent)) errors.push(`${where}: unknown agent ${n.agent}`);
        if (typeof n.prompt !== 'string' || !n.prompt) errors.push(`${where}: prompt required`);
        else collect(n.id, n.prompt);
        if (n.completion !== undefined) {
          if (inParallel) errors.push(`${where}: completion is not allowed inside parallel`);
          stop(n.completion, where);
        }
        if (n.artifacts !== undefined && (!n.artifacts || typeof n.artifacts !== 'object' || Object.values(n.artifacts).some((v) => typeof v !== 'string'))) {
          errors.push(`${where}: artifacts must map keys to paths`);
        }
        break;
      case 'sequence':
        if (!Array.isArray(n.steps)) errors.push(`${where}: steps required`);
        for (const c of n.steps || []) node(c, depth + 1, inParallel);
        break;
      case 'repeat':
        if (!Number.isInteger(n.maxIterations) || n.maxIterations < 1 || n.maxIterations > 1000) errors.push(`${where}: maxIterations must be an integer 1-1000`);
        if (!['abort', 'continue', 'pause'].includes(n.onMaxIterations)) errors.push(`${where}: onMaxIterations must be abort, continue or pause`);
        if ((n.stopCondition === undefined) === (n.stopWhen === undefined)) errors.push(`${where}: exactly one of stopCondition or stopWhen`);
        if (n.stopCondition !== undefined) stop(n.stopCondition, where);
        if (n.stopWhen !== undefined) {
          if (typeof n.stopWhen !== 'string') errors.push(`${where}: stopWhen must be a string`);
          else collect(n.id, n.stopWhen);
        }
        if (!Array.isArray(n.steps) || n.steps.length === 0) errors.push(`${where}: steps required`);
        for (const c of n.steps || []) node(c, depth + 1, inParallel);
        break;
      case 'parallel':
        if (!['all', 'allSettled', 'any'].includes(n.joinPolicy)) errors.push(`${where}: joinPolicy must be all, allSettled or any`);
        if (!Array.isArray(n.branches) || n.branches.length === 0) errors.push(`${where}: branches required`);
        (n.branches || []).forEach((c, i) => {
          const outer = curAny;
          if (n.joinPolicy === 'any') curAny = [...outer, `${n.id}#${i}`];
          node(c, depth + 1, true);
          curAny = outer;
        });
        break;
      case 'watch':
        if (typeof n.handler !== 'string' || !n.handler) errors.push(`${where}: handler required`);
        if (n.config !== undefined) {
          if (!n.config || typeof n.config !== 'object' || Array.isArray(n.config)) errors.push(`${where}: config must be an object`);
          else {
            if (typeof n.config.command === 'string' && /\{\{/.test(n.config.command)) errors.push(`${where}: a command watch's command must be static (no {{template}})`);
            for (const v of Object.values(n.config)) if (typeof v === 'string') collect(n.id, v);
          }
        }
        break;
      default:
        errors.push(`unknown node type ${n.type}`);
    }
  }
  for (const n of wf.steps) node(n, 1, false);
  if (stepCount > 50) errors.push(`more than 50 step nodes (${stepCount})`);
  for (const [at, expr, from] of templates) {
    const out = /^([\w-]+)\.output$/.exec(expr);
    const ok = Object.prototype.hasOwnProperty.call(inputs, expr) || expr === 'previous.output' || (out && ids.has(out[1]));
    if (!ok) { errors.push(`${at}: unknown template {{${expr}}}`); continue; }
    const inside = out ? anyPath.get(out[1]) || [] : [];
    const outsideOf = inside.find((b) => !from.includes(b));
    if (outsideOf) {
      errors.push(`${at}: {{${expr}}} reads a node of joinPolicy any branch ${outsideOf} from outside that branch (a failed or aborted branch has no output)`);
    }
  }
  return errors;
}

/*
 * Plan owner-autonomy: the standing owner instruction and its complete stop table live in one always-included steering
 * file, identical in vitana-platform and vitana-v1. A later edit that drops the file, makes it optional, or removes a
 * stop from its table is a red check, not a quiet change. Runs where the pipeline steering exists.
 */
const OWNER_AUTONOMY = '.kiro/steering/vitana-owner-autonomy.md';
// One anchor per stop row of the table. Each must occur in a table row (a line starting with `| <n> |`), so deleting a
// row cannot stay green because the same words appear elsewhere in the file.
const OWNER_AUTONOMY_ROW_ANCHORS = Object.freeze([
  ['target database', 'stop: migration apply needs owner approval of the file(s) and the target database (§7d)'],
  ['§7c', 'stop: production'],
  ['§3a', 'stop: protected gate files'],
  ['data-loss', 'stop: security or data-loss risk'],
  ['3 fix-forward attempts', 'stop: the same failure after 3 attempts'],
  ['escalated sparring verdict', 'stop: escalated sparring'],
  ['IF–THEN 31–32', 'stop: verification needing a live write'],
  ['AGENTS.md', 'stop: another repository'],
  ['Commerce UX contract', 'stop: Commerce onboarding friction'],
  ['design.md', 'stop: design-contract change'],
  ['§4.1', 'stop: VTID allocator down'],
  ['Gate 1', 'stop: Gate 1 for Claude-local sparring'],
  ['NEVER 34', 'stop: turning on product autonomy'],
]);
// The end point, the stop message and the no-trailing-question rule, anywhere in the file.
const OWNER_AUTONOMY_TEXT_ANCHORS = Object.freeze([
  ['STAGING-VERIFY', 'the default end point'],
  ['five-part', 'the stop message'],
  ['Never end a reply with an offer', 'the no-trailing-question rule'],
]);
const OWNER_AUTONOMY_ANCHORS = Object.freeze([...OWNER_AUTONOMY_ROW_ANCHORS, ...OWNER_AUTONOMY_TEXT_ANCHORS]);

function checkOwnerAutonomy(root) {
  const errors = [];
  const pipeline = path.join(root, '.kiro', 'steering', 'vitana-pipeline.md');
  if (!fs.existsSync(pipeline)) return errors;
  const file = path.join(root, OWNER_AUTONOMY);
  if (!fs.existsSync(file)) return [`${OWNER_AUTONOMY} missing (the standing owner instruction and its stop table)`];
  const text = fs.readFileSync(file, 'utf8');
  if (parseFrontMatter(frontMatter(text)).inclusion !== 'always') errors.push(`${OWNER_AUTONOMY}: inclusion must be always`);
  const rows = text.split(/\r?\n/).filter((l) => /^\|\s*\d+\s*\|/.test(l)).join('\n');
  for (const [anchor, what] of OWNER_AUTONOMY_ROW_ANCHORS) {
    if (!rows.includes(anchor)) errors.push(`${OWNER_AUTONOMY}: no longer names ${anchor} in a stop-table row (${what})`);
  }
  for (const [anchor, what] of OWNER_AUTONOMY_TEXT_ANCHORS) {
    if (!text.includes(anchor)) errors.push(`${OWNER_AUTONOMY}: no longer names ${anchor} (${what})`);
  }
  if (!fs.readFileSync(pipeline, 'utf8').includes('vitana-owner-autonomy.md')) {
    errors.push('.kiro/steering/vitana-pipeline.md must point to vitana-owner-autonomy.md (the complete stop table)');
  }
  return errors;
}

module.exports = {
  check, checkAgents, checkOwnerAutonomy, OWNER_AUTONOMY_ANCHORS, validateWorkflow, gateErrors, parseFrontMatter, frontMatter, fileLinks,
  REVIEWER_MODELS, REVIEW_MODEL_LABEL, STORE_COMMAND, GATE_COMMAND, GATED_STEPS, GATE_IDLE_TIMEOUT_SEC,
};

if (require.main === module) {
  const errors = check(path.resolve(process.argv[2] || '.'));
  if (errors.length) {
    for (const e of errors) console.error(`kiro-steering: ${e}`);
    process.exit(1);
  }
  console.log('kiro-steering: OK');
}
