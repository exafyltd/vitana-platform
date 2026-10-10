'use strict';
// VTID-05059 — self-test for the Kiro steering guard. Run: node --test scripts/ci/kiro-steering/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check } = require('./guard.cjs');

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
