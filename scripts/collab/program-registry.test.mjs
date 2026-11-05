// VTID-05364 (collab-handoff-check-fix/program-registry) — every spec the plan names is listed by its programme.
// Run: node --test scripts/collab/program-registry.test.mjs
// Slugs come from the trees (origin/main or the plan PR heads), recorded in docs/validation/VTID-05364/commands.log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrograms, validatePrograms, programIndex } from './queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// plan.md item 5: spec → programme.
const EXPECTED = {
  'native-app': [
    'native-wave2-ai-pages', 'native-wave2-discover-commerce', 'native-wave2-events-calendar',
    'native-wave2-health-biology', 'native-wave2-home-feed-news', 'native-wave2-inbox-chat-calls',
    'native-wave2-journey-autopilot', 'native-wave2-memory-diary', 'native-wave2-profile-settings',
    'native-wave2-public-auth-onboarding', 'native-wave2-role-modes', 'native-wave2-sharing-business',
    'native-wave2-wallet',
  ],
  'desktop-redesign': ['desktop-spotlight-finish'],
  standalone: ['i18n-propagate-stale-write', 'sparring-floor-retry'],
};

const programs = loadPrograms(ROOT, 'HEAD');

test('each spec of plan item 5 belongs to its programme', () => {
  const idx = programIndex(programs);
  for (const [id, slugs] of Object.entries(EXPECTED)) {
    for (const slug of slugs) assert.equal(idx.get(`vitana-platform:${slug}`), id, `vitana-platform:${slug} → ${id}`);
  }
});

test('each added slug matches the spec slug pattern and is listed exactly once', () => {
  const all = programs.flatMap((p) => (Array.isArray(p.fm?.specs) ? p.fm.specs : []));
  for (const slug of Object.values(EXPECTED).flat()) {
    assert.match(slug, SLUG_RE);
    assert.equal(all.filter((s) => s === `vitana-platform:${slug}`).length, 1, slug);
  }
});

test('each programme lists the repo of every spec it holds (R2-F1)', () => {
  for (const id of Object.keys(EXPECTED)) {
    const p = programs.find((x) => x.id === id);
    assert.ok(p, id);
    const repos = Array.isArray(p.fm.repos) ? p.fm.repos : [p.fm.repos];
    for (const sp of p.fm.specs || []) assert.ok(repos.includes(sp.split(':')[0]), `${id}: repos lacks ${sp.split(':')[0]}`);
  }
});

test('validatePrograms is clean', () => {
  assert.deepEqual(validatePrograms(programs), []);
});
