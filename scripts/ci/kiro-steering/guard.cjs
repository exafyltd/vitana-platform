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
  return errors;
}

/*
 * VTID-05275: reviewer agent + pipeline recipe (plan kiro-autonomy-fallback, sections 4.1, 4.2, 5 G).
 * The agent's accept unlocks merges, so its definition is pinned here: a change that widens its tools, swaps its
 * model or drops the fail-loudly / protected-file rules is a red test, not a quiet edit.
 */
const REVIEWER = '.kiro/agents/vitana-lane-reviewer.md';
const REVIEWER_MODEL = 'claude-sonnet-5.5';
const WORKFLOW = '.kiro/workflows/vitana-pipeline.workflow.json';
const HOOK = '.kiro/hooks/vitana-pipeline-start.json';
const PIPELINE_DIR = '.kiro/pipeline';
const PIPELINE_STEERING = '.kiro/steering/vitana-pipeline.md';
// Named as text only and owned by another lane (plan section 7, "text-only cross references"); not required to exist.
const TEXT_ONLY_REFS = new Set(['.kiro/pipeline/driver.md']);
const ALLOWED_TOOLS = new Set(['read', 'shell']);
const REQUIRED_EXCLUDED = ['fs_write', 'fs_append', 'str_replace', 'delete_file'];
const REQUIRED_BODY = [
  'model_unavailable',
  '"verdict"', '"head_sha"', '"findings"', '"severity"', '"model"', '"agent"',
  'Collab-Session:', 'Collab-Review:', 'Collab-Verdict:',
  `Collab-Reviewer: agent:vitana-lane-reviewer (${REVIEWER_MODEL})`, 'Collab-Reviewed-Head:',
  'protected-gate-files.json',
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
    if (fm.model !== REVIEWER_MODEL) errors.push(`${REVIEWER}: model must be ${REVIEWER_MODEL}`);
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
    for (const s of reviewSteps) if (s.modelId !== REVIEWER_MODEL) errors.push(`${WORKFLOW}: review step ${s.id} must pin modelId ${REVIEWER_MODEL}`);
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
  let stepCount = 0;
  const collect = (at, text) => { for (const m of text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) templates.push([at, m[1]]); };
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
    else ids.add(n.id);
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
        for (const c of n.branches || []) node(c, depth + 1, true);
        break;
      case 'watch':
        if (typeof n.handler !== 'string' || !n.handler) errors.push(`${where}: handler required`);
        break;
      default:
        errors.push(`unknown node type ${n.type}`);
    }
  }
  for (const n of wf.steps) node(n, 1, false);
  if (stepCount > 50) errors.push(`more than 50 step nodes (${stepCount})`);
  for (const [at, expr] of templates) {
    const out = /^([\w-]+)\.output$/.exec(expr);
    const ok = Object.prototype.hasOwnProperty.call(inputs, expr) || expr === 'previous.output' || (out && ids.has(out[1]));
    if (!ok) errors.push(`${at}: unknown template {{${expr}}}`);
  }
  return errors;
}

module.exports = { check, checkAgents, validateWorkflow, parseFrontMatter, frontMatter, fileLinks };

if (require.main === module) {
  const errors = check(path.resolve(process.argv[2] || '.'));
  if (errors.length) {
    for (const e of errors) console.error(`kiro-steering: ${e}`);
    process.exit(1);
  }
  console.log('kiro-steering: OK');
}
