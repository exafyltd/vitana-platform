'use strict';
// VTID-05059 — self-test for the Kiro steering guard. Run: node --test scripts/ci/kiro-steering/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, checkAgents, validateWorkflow, gateErrors, parseFrontMatter, frontMatter, REVIEWER_MODELS, REVIEW_MODEL_LABEL, STORE_COMMAND, GATE_COMMAND, GATED_STEPS } = require('./guard.cjs');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-steer-'));
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  }
  return root;
}
const RULE = '---\npaths:\n  - src/**\n  - "**/Dockerfile*"\n---\n# r\n';
const ALWAYS = '---\ninclusion: always\n---\n#[[file:CLAUDE.md]]\n';
const TWIN = '---\ninclusion: fileMatch\nfileMatchPattern:\n  - "**/Dockerfile*"\n  - "src/**"\n---\n#[[file:.claude/rules/b.md]]\n';

test('a matching layout passes', () => {
  assert.deepStrictEqual(check(repo({ 'CLAUDE.md': 'x', '.claude/rules/b.md': RULE, '.kiro/steering/a.md': ALWAYS, '.kiro/steering/b.md': TWIN })), []);
});
test('a rules file without a twin fails', () => {
  const e = check(repo({ 'CLAUDE.md': 'x', '.claude/rules/b.md': RULE, '.kiro/steering/a.md': ALWAYS }));
  assert.match(e.join('\n'), /has no \.kiro\/steering twin/);
});
test('globs that differ from paths fail', () => {
  const e = check(repo({ 'CLAUDE.md': 'x', '.claude/rules/b.md': RULE, '.kiro/steering/a.md': ALWAYS, '.kiro/steering/b.md': TWIN.replace('src/**', 'lib/**') }));
  assert.match(e.join('\n'), /fileMatchPattern/);
});
test('a link to a missing file fails', () => {
  const e = check(repo({ 'CLAUDE.md': 'x', '.kiro/steering/a.md': ALWAYS + '#[[file:gone.md]]\n' }));
  assert.match(e.join('\n'), /gone\.md\]\] does not exist/);
});
test('no always file linking CLAUDE.md fails', () => {
  const e = check(repo({ 'CLAUDE.md': 'x', '.kiro/steering/a.md': '---\ninclusion: manual\n---\n#[[file:CLAUDE.md]]\n' }));
  assert.match(e.join('\n'), /always-included/);
});
test('the twin must be fileMatch', () => {
  const e = check(repo({ 'CLAUDE.md': 'x', '.claude/rules/b.md': RULE, '.kiro/steering/a.md': ALWAYS, '.kiro/steering/b.md': TWIN.replace('inclusion: fileMatch', 'inclusion: always') }));
  assert.match(e.join('\n'), /not fileMatch/);
});
test('this repository passes', () => {
  assert.deepStrictEqual(check(path.resolve(__dirname, '..', '..', '..')), []);
});
test('the Kiro notes say plan sparring is never skipped and how to load context', () => {
  const notes = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '.kiro', 'steering', 'vitana-kiro-notes.md'), 'utf8');
  assert.match(notes, /^---\ninclusion: always\n---/);
  assert.match(notes, /Plan sparring is never skipped/);
  assert.match(notes, /resume-vtid\.sh/);
});

// VTID-05275 (kiro-autonomy-fallback/reviewer-agent): the reviewer agent and the pipeline recipe.
// Fixtures are built from the real files of this repository, so every test below exercises the shipped files.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const AGENT = '.kiro/agents/vitana-lane-reviewer.md';
const WORKFLOW = '.kiro/workflows/vitana-pipeline.workflow.json';
const HOOK = '.kiro/hooks/vitana-pipeline-start.json';
const RUNBOOKS = ['README.md', 'common-rules.md', 'planning.md', 'lane-code.md', 'lane-review.md', 'lane-land.md', 'driver.md'].map((f) => `.kiro/pipeline/${f}`);
function real(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function pipelineRepo(over = {}) {
  const files = { 'CLAUDE.md': 'x', '.kiro/steering/a.md': ALWAYS, 'scripts/collab/queue.mjs': '// marker\n' };
  for (const p of [AGENT, WORKFLOW, HOOK, ...RUNBOOKS]) files[p] = real(p);
  for (const [p, c] of Object.entries(over)) { if (c === null) delete files[p]; else files[p] = c; }
  return repo(files);
}
function errs(over) { return checkAgents(pipelineRepo(over)).join('\n'); }
function wf() { return JSON.parse(real(WORKFLOW)); }
function walk(nodes, fn) { for (const n of nodes) { fn(n); walk(n.steps || n.branches || [], fn); } }

test('agents: the shipped reviewer agent, workflow, hook and runbooks pass', () => {
  assert.deepStrictEqual(checkAgents(pipelineRepo()), []);
});
test('agents: check() runs the agent checks only where scripts/collab/queue.mjs exists (vitana-v1 stays green)', () => {
  assert.deepStrictEqual(check(repo({ 'CLAUDE.md': 'x', '.kiro/steering/a.md': ALWAYS })), []);
  const e = check(repo({ 'CLAUDE.md': 'x', '.kiro/steering/a.md': ALWAYS, 'scripts/collab/queue.mjs': '//\n' })).join('\n');
  assert.match(e, /vitana-lane-reviewer\.md missing/);
});
test('agents: a missing reviewer agent fails', () => {
  assert.match(errs({ [AGENT]: null }), /vitana-lane-reviewer\.md missing/);
});
test('agents: the reviewer front matter pins no model (the review step pins it) or a chain model only', () => {
  assert.strictEqual(parseFrontMatter(frontMatter(real(AGENT))).model, undefined);
  const withModel = (m) => real(AGENT).replace('\ntools:\n', `\nmodel: ${m}\ntools:\n`);
  for (const ok of REVIEWER_MODELS) assert.doesNotMatch(errs({ [AGENT]: withModel(ok) }), /model must be/, ok);
  for (const bad of ['claude-opus-4.8', 'auto', 'gemini-2.5-pro']) {
    assert.match(errs({ [AGENT]: withModel(bad) }), /model must be unset \(the review step pins it\) or one of claude-sonnet-5\.5, claude-opus-5\.5, claude-sonnet-4\.5/, bad);
  }
});
test('agents: the reviewer model chain mirrors governance.ts REVIEWER_AGENT_MODELS (Claude only)', () => {
  assert.deepStrictEqual([...REVIEWER_MODELS], ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-sonnet-4.5']);
  const gov = real('services/gateway/src/services/project-manager/governance.ts');
  const m = gov.match(/REVIEWER_AGENT_MODELS: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(m, 'REVIEWER_AGENT_MODELS literal not found in governance.ts');
  assert.deepStrictEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), [...REVIEWER_MODELS]);
  assert.ok(REVIEWER_MODELS.every((x) => x.startsWith('claude-')));
});
test('agents: the reviewer names the full model chain', () => {
  assert.match(errs({ [AGENT]: real(AGENT).split('`claude-opus-5.5`').join('`claude-x`') }), /Model chain/);
});
test('agents: the reviewer name is fixed', () => {
  assert.match(errs({ [AGENT]: real(AGENT).replace('name: vitana-lane-reviewer', 'name: other') }), /name must be vitana-lane-reviewer/);
});
test('agents: the reviewer may only have the read and shell tools', () => {
  assert.match(errs({ [AGENT]: real(AGENT).replace('  - shell\n', '  - shell\n  - write\n') }), /tools .*write/);
  assert.match(errs({ [AGENT]: real(AGENT).replace('  - shell\n', '  - shell\n  - web\n') }), /tools .*web/);
});
test('agents: the reviewer must exclude every write tool', () => {
  assert.match(errs({ [AGENT]: real(AGENT).replace('  - str_replace\n', '') }), /excludedTools must contain str_replace/);
  assert.match(errs({ [AGENT]: real(AGENT).replace('  - fs_write\n', '') }), /excludedTools must contain fs_write/);
  assert.match(errs({ [AGENT]: real(AGENT).replace('  - delete_file\n', '') }), /excludedTools must contain delete_file/);
});
test('agents: the reviewer gets no MCP servers', () => {
  assert.match(errs({ [AGENT]: real(AGENT).replace('includeMcpJson: false', 'includeMcpJson: true') }), /includeMcpJson/);
});
test('agents: the reviewer fails loudly when its model is unavailable', () => {
  assert.match(errs({ [AGENT]: real(AGENT).split('model_unavailable').join('model_gone') }), /model_unavailable/);
});
test('agents: the reviewer prompt carries the verdict keys and every review-entry trailer', () => {
  for (const t of ['Collab-Verdict:', 'Collab-Reviewed-Head:', 'Collab-Reviewer: agent:vitana-lane-reviewer (<model>)', 'Collab-Review:']) {
    assert.match(errs({ [AGENT]: real(AGENT).split(t).join('X-Gone:') }), /missing/, t);
  }
  assert.match(errs({ [AGENT]: real(AGENT).split('"head_sha"').join('"head"') }), /"head_sha"/);
});
test('agents: the reviewer treats protected gate files as blocking', () => {
  assert.match(errs({ [AGENT]: real(AGENT).split('protected-gate-files.json').join('list') }), /protected-gate-files\.json/);
});
test('agents: every agent file needs front matter with a name', () => {
  assert.match(errs({ '.kiro/agents/other.md': '# no front matter\n' }), /other\.md: no front matter name/);
  assert.match(errs({ '.kiro/agents/other.md': '---\ndescription: x\n---\nbody\n' }), /other\.md: no front matter name/);
});
test('workflow: the shipped recipe passes the workflow schema checks', () => {
  assert.deepStrictEqual(validateWorkflow(wf(), new Set(['vitana-lane-reviewer'])), []);
});
test('workflow: input is the owner task text only', () => {
  assert.deepStrictEqual(wf().inputs, { task: 'prompt' });
});
test('workflow: a recipe that does not parse fails', () => {
  assert.match(errs({ [WORKFLOW]: '{ nope' }), /does not parse/);
});
test('workflow: every lane slot races one pinned vitana-lane-reviewer step per chain model in a joinPolicy any parallel', () => {
  const w = wf();
  let slots = 0;
  walk(w.steps, (n) => {
    if (n.type !== 'repeat' || !JSON.stringify(n.steps).includes('"vitana-lane-reviewer"')) return;
    slots++;
    const race = n.steps.filter((s) => s.type === 'parallel');
    assert.strictEqual(race.length, 1, n.id);
    assert.strictEqual(race[0].joinPolicy, 'any', n.id);
    assert.deepStrictEqual(race[0].branches.map((b) => b.steps[0].modelId), [...REVIEWER_MODELS], n.id);
    for (const b of race[0].branches) {
      assert.strictEqual(b.steps[1].type, 'watch');
      assert.strictEqual(b.steps[1].config.command, STORE_COMMAND);
      assert.strictEqual(b.steps[1].config.model, b.steps[0].modelId);
      assert.strictEqual(b.steps[1].config.output, `{{${b.steps[0].id}.output}}`);
    }
    assert.ok(!n.steps.some((s) => s.agent === 'vitana-lane-reviewer'), `${n.id}: no review step outside the race`);
  });
  assert.strictEqual(slots, 6);
  for (const bad of [undefined, 'auto', 'claude-opus-4.8', 'gemini-2.5-pro']) {
    const wBad = wf();
    walk(wBad.steps, (s) => { if (s.agent === 'vitana-lane-reviewer') s.modelId = bad; });
    assert.match(errs({ [WORKFLOW]: JSON.stringify(wBad) }), /modelId must be one of claude-sonnet-5\.5, claude-opus-5\.5, claude-sonnet-4\.5/, String(bad));
  }
  const race = (w0, n) => { let r = null; walk(w0.steps, (s) => { if (s.id === `reviews-${n}`) r = s; }); return r; };
  const wJoin = wf(); race(wJoin, 1).joinPolicy = 'allSettled';
  assert.match(errs({ [WORKFLOW]: JSON.stringify(wJoin) }), /review race reviews-1 must use joinPolicy any/);
  const wDrop = wf(); race(wDrop, 1).branches.pop();
  assert.match(errs({ [WORKFLOW]: JSON.stringify(wDrop) }), /review race reviews-1 must have one branch per chain model/);
  const wSwap = wf(); const r2 = race(wSwap, 2); r2.branches.reverse();
  assert.match(errs({ [WORKFLOW]: JSON.stringify(wSwap) }), /review race reviews-2 must have one branch per chain model/);
  const wStore = wf(); race(wStore, 3).branches[1].steps[1].config.model = 'claude-sonnet-5.5';
  assert.match(errs({ [WORKFLOW]: JSON.stringify(wStore) }), /reviews-3 branch 2 must be a sequence/);
  const wNoStore = wf(); race(wNoStore, 4).branches[0].steps.pop();
  assert.match(errs({ [WORKFLOW]: JSON.stringify(wNoStore) }), /reviews-4 branch 1 must be a sequence/);
  const wSeq = wf();
  walk(wSeq.steps, (n) => {
    if (n.id !== 'lane-slot-5') return;
    const r = n.steps.find((s) => s.type === 'parallel');
    n.steps.splice(n.steps.indexOf(r), 1, ...r.branches.map((b) => b.steps[0]));
  });
  assert.match(errs({ [WORKFLOW]: JSON.stringify(wSeq) }), /lane-slot-5 must hold its review steps in exactly one parallel review race/);
  assert.match(errs({ [WORKFLOW]: JSON.stringify(wSeq) }), /review step review-5 must be a branch of a lane slot's joinPolicy any review race/);
  const w2 = wf();
  walk(w2.steps, (s) => { if (s.agent === 'vitana-lane-reviewer') s.agent = 'wf-code-reviewer'; });
  assert.match(errs({ [WORKFLOW]: JSON.stringify(w2) }), /no step uses agent vitana-lane-reviewer/);
});
test('workflow: nothing outside a review race branch reads a review output (a failed or aborted branch has none)', () => {
  const w = wf();
  walk(w.steps, (s) => { if (s.id === 'land-1') s.prompt += '\n{{review-1-b.output}}'; });
  assert.match(validateWorkflow(w, new Set(['vitana-lane-reviewer'])).join('\n'), /land-1: \{\{review-1-b\.output\}\} reads a node of joinPolicy any branch reviews-1#1/);
  const w2 = wf();
  walk(w2.steps, (s) => { if (s.id === 'store-2') s.config.output = '{{review-2-c.output}}'; });
  assert.match(validateWorkflow(w2, new Set(['vitana-lane-reviewer'])).join('\n'), /store-2: \{\{review-2-c\.output\}\} reads a node of joinPolicy any branch reviews-2#2/);
  const w3 = wf();
  walk(w3.steps, (s) => { if (s.id === 'store-3') s.config.command = 'node x.cjs {{review-3.output}}'; });
  assert.match(validateWorkflow(w3, new Set(['vitana-lane-reviewer'])).join('\n'), /command must be static/);
});
// VTID-05338 (plan pipeline-speed, lane slot-sizing): skip gates and the model-pin regression guard.
function node(w0, id) { let r = null; walk(w0.steps, (s) => { if (s.id === id) r = s; }); return r; }
test('workflow: every lane slot and each planning / approval step is gated by one run-gate skip/go pair', () => {
  const w = wf();
  assert.deepStrictEqual(gateErrors(w), []);
  const gated = [];
  walk(w.steps, (n) => { if (n.type === 'watch' && n.config.command === GATE_COMMAND) gated.push(`${n.config.gatedNodeId}:${n.config.role}`); });
  const want = [...GATED_STEPS, ...[1, 2, 3, 4, 5, 6].map((n) => `lane-slot-${n}`)];
  assert.deepStrictEqual([...gated].sort(), want.flatMap((t) => [`${t}:go`, `${t}:skip`]).sort());
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const race = node(w, `slot-${n}`);
    assert.strictEqual(race.joinPolicy, 'any');
    assert.strictEqual(race.branches[0].id, `slot-${n}-skip`);
    assert.strictEqual(race.branches[1].id, `lane-slot-${n}`);
    assert.strictEqual(race.branches[1].steps[0].id, `slot-${n}-go`);
    assert.strictEqual(race.branches[1].stopWhen, `{{land-${n}.output}} contains VITANA_SLOT_DONE`);
    assert.deepStrictEqual(race.branches[0].config.gatedStepIds, [`code-${n}`, `review-${n}`, `review-${n}-b`, `review-${n}-c`, `land-${n}`]);
  }
  for (const id of GATED_STEPS) {
    const race = node(w, `${id}-gate`);
    assert.strictEqual(race.joinPolicy, 'any', id);
    assert.deepStrictEqual(race.branches[1].steps.map((s) => s.id), [`${id}-go`, id]);
  }
  assert.match(node(w, 'setup').prompt, /`plan_pr`/);
  assert.match(node(w, 'setup').prompt, /`steps_done`/);
  // Removing a gate fails.
  const wBare = wf(); const i = wBare.steps.findIndex((s) => s.id === 'spec-gate'); wBare.steps[i] = node(wBare, 'spec');
  assert.match(errs({ [WORKFLOW]: JSON.stringify(wBare) }), /spec must be gated by exactly one node scripts\/collab\/run-gate\.cjs skip\/go pair \(got 0/);
  const wGo = wf(); node(wGo, 'lane-slot-2').steps.shift();
  assert.match(errs({ [WORKFLOW]: JSON.stringify(wGo) }), /lane-slot-2 must be gated by exactly one .* \(got 1/);
});
test('workflow: a gate race in the wrong shape or with the wrong watch recipe fails', () => {
  const e = (mut) => { const w = wf(); mut(w); return gateErrors(w).join('\n'); };
  assert.match(e((w) => { node(w, 'slot-3').branches.reverse(); }), /lane-slot-3 must sit in a parallel joinPolicy any \[watch lane-slot-3-skip, work\] gate race/);
  assert.match(e((w) => { node(w, 'investigate-gate').joinPolicy = 'allSettled'; }), /investigate must sit in a parallel joinPolicy any/);
  assert.match(e((w) => { node(w, 'plan-pr-gate').branches.push({ type: 'step', id: 'zz', agent: 'wf-coder', prompt: 'p' }); }), /plan-pr must sit in a parallel joinPolicy any/);
  assert.match(e((w) => { const s = node(w, 'merge-plan-work').steps; s.reverse(); }), /merge-plan: the gate race's work branch must be a sequence \[go watch, merge-plan\]/);
  assert.match(e((w) => { const r = node(w, 'lane-slot-4'); r.steps.push(r.steps.shift()); }), /lane-slot-4: the gate race's work branch must be the slot repeat with its go watch as first child/);
  assert.match(e((w) => { node(w, 'slot-1-skip').idleTimeoutSec = 120; }), /slot-1-skip of lane-slot-1: idleTimeoutSec must be at least 86400/);
  assert.match(e((w) => { node(w, 'spec-go').config.role = 'skip'; }), /spec-go of spec: config\.role must be go/);
  assert.match(e((w) => { node(w, 'spar-loop-skip').config.gatedNodeId = 'spar'; }), /gate watches name spar/);
  assert.match(e((w) => { node(w, 'slot-5-go').config.gatedStepIds = ['code-5']; }), /slot-5-go of lane-slot-5: config\.gatedStepIds must list/);
  assert.match(e((w) => { node(w, 'slot-6-skip').config.slot = '1'; }), /slot-6-skip of lane-slot-6: config\.slot must be the slot number/);
  assert.match(e((w) => { node(w, 'investigate-skip').config.pollIntervalSec = 10; }), /pollIntervalSec and commandTimeoutSec must be 30/);
  assert.match(e((w) => { node(w, 'spec-skip').config.slot = '1'; }), /gatedStepIds and slot are for lane slots only/);
  assert.match(e((w) => { node(w, 'plan-pr-go').config.run = '{{task}}'; }), /config\.run must be \{\{setup\.output\}\}/);
  const wTmpl = wf(); node(wTmpl, 'spec-skip').config.command = 'node scripts/collab/run-gate.cjs {{task}}';
  assert.match(validateWorkflow(wTmpl, new Set(['vitana-lane-reviewer'])).join('\n'), /command must be static/);
});
test('workflow: no step outside a reviewer race pins a modelId, and every pin is a chain model (regression guard)', () => {
  assert.doesNotMatch(errs({}), /pins modelId/);
  for (const id of ['setup', 'code-1', 'spar', 'land-6', 'staging-verify', 'inv-code']) {
    const w = wf(); node(w, id).modelId = 'claude-sonnet-5.5';
    assert.match(errs({ [WORKFLOW]: JSON.stringify(w) }), new RegExp(`step ${id} pins modelId claude-sonnet-5\\.5; only reviewer race steps pin a model`), id);
  }
  const w = wf(); node(w, 'review-2-b').modelId = 'claude-opus-4.8';
  assert.match(errs({ [WORKFLOW]: JSON.stringify(w) }), /step review-2-b pins modelId claude-opus-4\.8/);
});
// VTID-05359 (plan reviewer-step-model D1-D4): every pinned review step's prompt opens with its own chain model.
const MODEL_LINE = (m) => `${REVIEW_MODEL_LABEL}${m}. `;
test('review prompts: every shipped reviewer step opens with "Reviewer chain model for this step: <its modelId>. " once (T-E)', () => {
  assert.strictEqual(REVIEW_MODEL_LABEL, 'Reviewer chain model for this step: ');
  let n = 0;
  walk(wf().steps, (s) => {
    if (s.type !== 'step' || s.agent !== 'vitana-lane-reviewer') return;
    n++;
    assert.ok(s.prompt.startsWith(MODEL_LINE(s.modelId)), s.id);
    assert.strictEqual(s.prompt.split(REVIEW_MODEL_LABEL).length, 2, `${s.id}: label once`);
  });
  assert.strictEqual(n, 18);
  assert.doesNotMatch(errs({}), /prompt must start with/);
});
test('review prompts: a model line naming another chain model fails (T-B)', () => {
  assert.doesNotMatch(errs({}), /review step review-2-b prompt must start with/);
  const w = wf(); const s = node(w, 'review-2-b');
  assert.strictEqual(s.modelId, 'claude-opus-5.5');
  s.prompt = MODEL_LINE('claude-sonnet-5.5') + s.prompt.slice(MODEL_LINE(s.modelId).length);
  assert.match(errs({ [WORKFLOW]: JSON.stringify(w) }), /review step review-2-b prompt must start with "Reviewer chain model for this step: claude-opus-5\.5\. "/);
});
test('review prompts: a prompt without the model line fails (T-C)', () => {
  assert.doesNotMatch(errs({}), /review step review-4 prompt must start with/);
  const w = wf(); const s = node(w, 'review-4');
  s.prompt = s.prompt.split(MODEL_LINE(s.modelId)).join('');
  assert.match(errs({ [WORKFLOW]: JSON.stringify(w) }), /review step review-4 prompt must start with "Reviewer chain model for this step: claude-sonnet-5\.5\. "/);
});
test('review prompts: a prompt carrying the label twice fails (T-D)', () => {
  assert.doesNotMatch(errs({}), /review step review-3-c prompt must start with/);
  const w = wf(); const s = node(w, 'review-3-c');
  s.prompt = s.prompt + ' ' + MODEL_LINE(s.modelId);
  assert.match(errs({ [WORKFLOW]: JSON.stringify(w) }), /review step review-3-c prompt must start with/);
});
test('review prompts: the agent, lane-review.md and driver.md keep the label; driver.md is required (T-F)', () => {
  assert.doesNotMatch(errs({}), /missing/);
  const drop = (p) => real(p).split(REVIEW_MODEL_LABEL).join('Model for this step: ');
  assert.match(errs({ [AGENT]: drop(AGENT) }), /vitana-lane-reviewer\.md: prompt is missing Reviewer chain model for this step: /);
  assert.match(errs({ '.kiro/pipeline/lane-review.md': drop('.kiro/pipeline/lane-review.md') }), /lane-review\.md: is missing Reviewer chain model for this step: /);
  assert.match(errs({ '.kiro/pipeline/driver.md': drop('.kiro/pipeline/driver.md') }), /driver\.md: is missing Reviewer chain model for this step: /);
  assert.match(errs({ '.kiro/pipeline/driver.md': null }), /\.kiro\/pipeline\/driver\.md missing/);
});
test('workflow: at most 6 lanes build in parallel', () => {
  const w = wf();
  let lanes = null;
  walk(w.steps, (s) => { if (s.type === 'parallel' && JSON.stringify(s).includes('vitana-lane-reviewer')) lanes = s; });
  assert.ok(lanes && lanes.branches.length <= 6 && lanes.branches.length >= 1);
  lanes.branches.push(JSON.parse(JSON.stringify(lanes.branches[0]).replace(/"id":"([^"]+)"/g, '"id":"$1-x"').replace(/\{\{([\w-]+)\.output\}\}/g, '{{$1-x.output}}')));
  while (lanes.branches.length <= 6) lanes.branches.push(JSON.parse(JSON.stringify(lanes.branches[0]).replace(/"id":"([^"]+)"/g, `"id":"$1-${lanes.branches.length}"`).replace(/\{\{([\w-]+)\.output\}\}/g, `{{$1-${lanes.branches.length}.output}}`)));
  assert.match(errs({ [WORKFLOW]: JSON.stringify(w) }), /more than 6 parallel lane branches/);
});
test('workflow: lane landing is serialized by the merge lock', () => {
  const t = real(WORKFLOW).split('merge.lock').join('lockfile');
  assert.match(errs({ [WORKFLOW]: t }), /merge\.lock/);
});
test('workflow: schema errors are reported', () => {
  const dup = wf(); dup.steps.push(JSON.parse(JSON.stringify(dup.steps[0])));
  assert.match(validateWorkflow(dup, new Set(['vitana-lane-reviewer'])).join('\n'), /duplicate id/);
  const both = wf(); let rep = null; walk(both.steps, (s) => { if (s.type === 'repeat' && !rep) rep = s; });
  rep.stopCondition = { containsText: 'x' };
  assert.match(validateWorkflow(both, new Set(['vitana-lane-reviewer'])).join('\n'), /exactly one of stopCondition or stopWhen/);
  const kind = wf(); kind.steps.push({ type: 'loop', id: 'zz' });
  assert.match(validateWorkflow(kind, new Set(['vitana-lane-reviewer'])).join('\n'), /unknown node type loop/);
  const agent = wf(); agent.steps.push({ type: 'step', id: 'zz', agent: 'nobody', prompt: 'p' });
  assert.match(validateWorkflow(agent, new Set(['vitana-lane-reviewer'])).join('\n'), /unknown agent nobody/);
  const tmpl = wf(); tmpl.steps.push({ type: 'step', id: 'zz', agent: 'wf-coder', prompt: '{{nothing.output}} {{who}}' });
  assert.match(validateWorkflow(tmpl, new Set(['vitana-lane-reviewer'])).join('\n'), /unknown template \{\{who\}\}/);
  const fc = wf(); fc.steps.push({ type: 'repeat', id: 'zz', maxIterations: 2, onMaxIterations: 'pause', stopCondition: { fileCheck: { path: 'a', jsonPath: 'b', equals: 1 } }, steps: [{ type: 'step', id: 'zz1', agent: 'wf-coder', prompt: 'p' }] });
  assert.match(validateWorkflow(fc, new Set(['vitana-lane-reviewer'])).join('\n'), /fileCheck/);
  const max = wf(); max.steps.push({ type: 'repeat', id: 'zz', maxIterations: 1001, onMaxIterations: 'pause', stopWhen: '{{task}} contains x', steps: [{ type: 'step', id: 'zz1', agent: 'wf-coder', prompt: 'p' }] });
  assert.match(validateWorkflow(max, new Set(['vitana-lane-reviewer'])).join('\n'), /maxIterations/);
});
test('workflow: every .kiro/pipeline file the recipe names exists', () => {
  assert.match(errs({ '.kiro/pipeline/lane-land.md': null }), /lane-land\.md does not exist/);
});
test('workflow: the steering entry point may only name pipeline files that exist (driver.md exists)', () => {
  const steer = '# p\nKiro IDE: `.kiro/workflows/vitana-pipeline.workflow.json`. Kiro Web: `.kiro/pipeline/driver.md`. See `.kiro/pipeline/gone.md`.\n';
  const e = errs({ '.kiro/steering/vitana-pipeline.md': steer });
  assert.match(e, /vitana-pipeline\.md names \.kiro\/pipeline\/gone\.md/);
  assert.doesNotMatch(e, /driver\.md/);
});
test('hook: SessionStart agent action that loads the pipeline steering and resumes stale drivers', () => {
  const h = JSON.parse(real(HOOK));
  assert.strictEqual(h.version, 'v1');
  assert.strictEqual(h.hooks[0].trigger, 'SessionStart');
  assert.strictEqual(h.hooks[0].action.type, 'agent');
  assert.match(h.hooks[0].action.prompt, /\.kiro\/steering\/vitana-pipeline\.md/);
  assert.match(errs({ [HOOK]: JSON.stringify({ version: 'v1', hooks: [{ name: 'x', trigger: 'Stop', action: { type: 'agent', prompt: 'p' } }] }) }), /SessionStart/);
  assert.match(errs({ [HOOK]: null }), /vitana-pipeline-start\.json missing/);
});
test('runbooks: no slug-specific text, no machine paths, no owner questions outside Gate 2', () => {
  assert.match(errs({ '.kiro/pipeline/lane-code.md': real('.kiro/pipeline/lane-code.md') + '\nplan kiro-autonomy-fallback\n' }), /slug-specific/);
  assert.match(errs({ '.kiro/pipeline/lane-code.md': real('.kiro/pipeline/lane-code.md') + '\nc:/Users/someone/x\n' }), /machine-specific path/);
  assert.match(errs({ '.kiro/pipeline/lane-code.md': real('.kiro/pipeline/lane-code.md') + '\nAsk the owner before you push.\n' }), /owner question/);
  assert.match(errs({ '.kiro/pipeline/lane-code.md': real('.kiro/pipeline/lane-code.md') + '\nDo you want me to merge?\n' }), /owner question/);
});

// plan session-title-stable: the owner's session-title rule ships as an always-included steering file in this repo
// (byte-identical in vitana-platform and vitana-v1).
test('steering: the session title is set once and never renamed (vitana-session-title.md)', () => {
  const file = path.join(__dirname, '..', '..', '..', '.kiro', 'steering', 'vitana-session-title.md');
  assert.ok(fs.existsSync(file), '.kiro/steering/vitana-session-title.md is missing');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^---\r?\ninclusion: always\r?\n---\r?\n/);
  assert.match(text, /Set the session title once, at the start, from the owner's original request/);
  assert.match(text, /Never change it later/);
  assert.match(text, /Never put a state in the title: no "Blocked:"/);
  assert.match(text, /Change the title only when the owner explicitly asks/);
  assert.doesNotMatch(text, /#\[\[file:/);
});

// Plan owner-autonomy: the standing owner instruction and its stop table stay in place.
{
  const { checkOwnerAutonomy } = require('./guard.cjs');
  const REAL = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.kiro', 'steering', 'vitana-owner-autonomy.md'), 'utf8');
  const PIPE = '# pipeline\nSee `vitana-owner-autonomy.md`.\n';
  const withRule = (rule, pipe = PIPE) => repo({ '.kiro/steering/vitana-pipeline.md': pipe, ...(rule === null ? {} : { '.kiro/steering/vitana-owner-autonomy.md': rule }) });

  test('owner-autonomy: the shipped rule file passes', () => {
    assert.deepStrictEqual(checkOwnerAutonomy(withRule(REAL)), []);
  });
  test('owner-autonomy: a missing rule file fails', () => {
    assert.match(checkOwnerAutonomy(withRule(null)).join('\n'), /vitana-owner-autonomy\.md missing/);
  });
  const { OWNER_AUTONOMY_ANCHORS } = require('./guard.cjs');
  test('owner-autonomy: one anchor per stop row (13) plus end point, stop message and no-trailing-question rule', () => {
    assert.strictEqual(OWNER_AUTONOMY_ANCHORS.length, 16);
    const rows = REAL.split(/\r?\n/).filter((l) => /^\|\s*\d+\s*\|/.test(l));
    assert.strictEqual(rows.length, 13);
  });
  test('owner-autonomy: deleting the migration row fails even though §7d appears elsewhere', () => {
    const noRow = REAL.split('\n').filter((l) => !/^\|\s*1\s*\|/.test(l)).join('\n');
    assert.ok(noRow.includes('§7d'));
    assert.match(checkOwnerAutonomy(withRule(noRow)).join('\n'), /target database in a stop-table row/);
  });
  for (const [anchor] of OWNER_AUTONOMY_ANCHORS) {
    test(`owner-autonomy: dropping "${anchor}" fails`, () => {
      const e = checkOwnerAutonomy(withRule(REAL.split(anchor).join('x'))).join('\n');
      assert.ok(e.includes(`no longer names ${anchor}`), e);
    });
  }
  test('owner-autonomy: a rule file that is not always-included fails', () => {
    assert.match(checkOwnerAutonomy(withRule(REAL.replace('inclusion: always', 'inclusion: manual'))).join('\n'), /inclusion must be always/);
  });
  test('owner-autonomy: vitana-pipeline.md without the pointer fails', () => {
    assert.match(checkOwnerAutonomy(withRule(REAL, '# pipeline\n')).join('\n'), /must point to vitana-owner-autonomy\.md/);
  });
  test('owner-autonomy: a repo without the pipeline steering is not checked (fixtures stay green)', () => {
    assert.deepStrictEqual(checkOwnerAutonomy(repo({ 'CLAUDE.md': 'x' })), []);
  });
  test('owner-autonomy: check() runs it', () => {
    const e = check(repo({ 'CLAUDE.md': 'x', '.kiro/steering/a.md': ALWAYS, '.kiro/steering/vitana-pipeline.md': '# p\n' }));
    assert.match(e.join('\n'), /vitana-owner-autonomy\.md missing/);
  });
}
