'use strict';
// VTID-05059 — self-test for the Kiro steering guard. Run: node --test scripts/ci/kiro-steering/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, checkAgents, validateWorkflow, parseFrontMatter, frontMatter, REVIEWER_MODELS, STORE_COMMAND } = require('./guard.cjs');

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
const RUNBOOKS = ['README.md', 'common-rules.md', 'planning.md', 'lane-code.md', 'lane-review.md', 'lane-land.md'].map((f) => `.kiro/pipeline/${f}`);
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
test('workflow: the steering entry point may only name pipeline files that exist (driver.md is text-only)', () => {
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
