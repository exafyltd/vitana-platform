// The spec of the rehearsal repository: twelve lanes and the lane `seed`, each a file with its own front matter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANES = path.join(ROOT, '.kiro', 'specs', 'rehearsal', 'lanes');
const frontMatter = (text) => Object.fromEntries([...(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').matchAll(/^([a-z_]+): (.+)$/gm)].map((m) => [m[1], m[2]]));

test('the spec has the lane seed and lane-01 to lane-12, each with its own name in the front matter', () => {
  const ids = ['seed', ...Array.from({ length: 12 }, (_, i) => `lane-${String(i + 1).padStart(2, '0')}`)];
  assert.deepEqual(fs.readdirSync(LANES).filter((f) => ids.includes(f.replace(/\.md$/, ''))).map((f) => f.replace(/\.md$/, '')).sort(), [...ids].sort());
  for (const id of ids) {
    const fm = frontMatter(fs.readFileSync(path.join(LANES, `${id}.md`), 'utf8'));
    assert.equal(fm.lane, id, `${id}.md names its lane`);
  }
});

test('the package runs its tests with no install', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/ci-test.mjs');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
