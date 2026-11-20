// quality-checks/pipeline-quality — structure and links of the proportional quality checks.
// Run: node --test scripts/collab/quality-checks.test.mjs (PR-GATE "Collab tests" runs scripts/collab/*.test.mjs).
// Asserts headings, fields and links, never whole sentences, so rewording the guidance does not break it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const QC = '.kiro/pipeline/quality-checks.md';
const headings = (md) => md.split('\n').filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#+ /, '').trim());

test('quality-checks.md exists', () => {
  assert.ok(existsSync(path.join(ROOT, QC)), `${QC} is missing`);
});

test('quality-checks.md has one section per change type', () => {
  const h = headings(read(QC));
  for (const type of ['UI', 'Backend', 'Database', 'Integration', 'Infrastructure/CI', 'Tooling/docs']) {
    assert.ok(h.some((x) => x === type || x.startsWith(`${type} `) || x.startsWith(`${type}:`)), `no section for ${type}; headings: ${h.join(' | ')}`);
  }
});

test('quality-checks.md defines the Change types line, the seven Acceptance fields and what "verified" means', () => {
  const md = read(QC);
  for (const field of ['Change types', 'Outcome', 'States', 'Surfaces', 'Locales', 'Accessibility', 'Contract', 'Staging proof']) {
    assert.match(md, new RegExp(`\\*\\*${field}\\*\\*`), `Acceptance field ${field} missing`);
  }
  assert.ok(headings(md).some((x) => /verified/i.test(x)), 'no section defining "verified"');
});

test('planning, coding and review steps link quality-checks.md', () => {
  for (const f of ['.kiro/pipeline/planning.md', '.kiro/pipeline/lane-code.md', '.kiro/pipeline/lane-review.md']) {
    assert.match(read(f), /quality-checks\.md/, `${f} does not link quality-checks.md`);
  }
});

test('the review step reads the lane\'s change types from tasks.md', () => {
  assert.match(read('.kiro/pipeline/lane-review.md'), /`Change types:`/);
  assert.match(read('.kiro/pipeline/planning.md'), /`Change types: <list>`/);
});

test('the land step merges with squash so the subject keeps the VTID', () => {
  assert.match(read('.kiro/pipeline/lane-land.md'), /squash/i);
});

test('the PR template has a Verification section and no extra VALIDATOR-CHECK marker', () => {
  const t = read('.github/pull_request_template.md');
  assert.match(t, /^## Verification$/m);
  for (const marker of ['VALIDATION_PROFILE:', 'SCOPE_ALLOWLIST:', 'ACCEPTANCE:', 'MERGE_PAYLOAD_PREVIEW:', 'OASIS_IMPACT:']) {
    assert.equal(t.split(marker).length - 1, 1, `${marker} must appear exactly once (VALIDATOR-CHECK reads the first match)`);
  }
});

// quality-checks-followup/merge-policy-text: the Merge section agrees with the policy actually in force.
test('the Merge section cites the PM squash strategy, and the PM really merges with squash', () => {
  const md = read(QC);
  const merge = md.slice(md.indexOf('\n## Merge'));
  assert.match(merge, /services\/gateway\/src\/services\/project-manager\/act\.ts/, 'Merge section must cite the PM act.ts');
  assert.match(merge, /planRange/, 'Merge section must cite where STAGING-VERIFY decides (lib.cjs planRange)');
  const act = read('services/gateway/src/services/project-manager/act.ts');
  const strategies = [...act.matchAll(/merge_strategy:\s*'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(strategies.length > 0, 'act.ts names no merge_strategy');
  assert.deepEqual([...new Set(strategies)], ['squash'], `PM merge strategies: ${strategies.join(', ')}`);
});

test('DEPLOYMENT-PIPELINE.md does not present a default merge commit as carrying the VTID', () => {
  const doc = read('docs/DEPLOYMENT-PIPELINE.md');
  const para = doc.slice(doc.indexOf('**How the range is read (VTID-05076):**'));
  assert.match(para.slice(0, 1200), /Merge pull request #/, 'the range paragraph must name GitHub\'s default merge subject');
});
