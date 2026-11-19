'use strict';
// VTID-05602 (staging-verify-manifest-repair/drift-guard) — CI reads every manifest against the tree it describes.
// Run: node --test scripts/ci/staging-verify/manifest-drift.test.cjs
// Five checks (plan §3, lane drift-guard). Manifests without `service` + `tests` are skipped by construction;
// community-app manifests skip checks 2 and 4 (their files live in the other repo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'docs', 'validation');
const COMMAND_HUB = path.join(ROOT, 'services', 'gateway', 'src', 'frontend', 'command-hub');
const INDEX_HTML = path.join(COMMAND_HUB, 'index.html');
// The closed key set of an http probe (plan §3, check 5). Union of all http probe keys on origin/main.
const HTTP_KEYS = new Set(['kind', 'name', 'target', 'method', 'path', 'expect_status', 'expect_content_type',
  'expect_json', 'expect_json_in', 'expect_body_contains', 'rejected_probe', 'reason']);

function loadAll() {
  const out = [];
  for (const vtid of fs.readdirSync(DIR).sort()) {
    const f = path.join(DIR, vtid, 'staging-tests.json');
    if (!fs.existsSync(f)) continue;
    let m;
    try { m = lib.parseJsonText(fs.readFileSync(f, 'utf8')); } catch (e) { out.push({ vtid, f, error: e.message }); continue; }
    out.push({ vtid, f, m });
  }
  return out;
}

const strings = (v) => (v == null ? [] : [].concat(v));
const isCheckable = (m) => m && typeof m.service === 'string' && Array.isArray(m.tests);
const hubFile = (p) => {
  const mm = /^\/command-hub\/([^?]+)/.exec(p || '');
  return mm ? mm[1] : null;
};

const manifests = loadAll();

test('every manifest parses as JSON', () => {
  const bad = manifests.filter((x) => x.error).map((x) => `${x.vtid}: ${x.error}`);
  assert.deepEqual(bad, []);
});

test('check 1: gateway and community-app manifests pass lib.validateManifest', () => {
  const bad = [];
  for (const { vtid, m } of manifests) {
    if (!m || !isCheckable(m) || !['gateway', 'community-app'].includes(m.service)) continue;
    const r = lib.validateManifest(m, { vtid: m.vtid, service: m.service });
    if (!r.ok) bad.push(`${vtid}: ${JSON.stringify(r.errors || r).slice(0, 240)}`);
  }
  assert.deepEqual(bad, [], 'manifest rejected by validateManifest');
});

test('check 2: served command-hub files contain every expected string', () => {
  const bad = [];
  for (const { vtid, m } of manifests) {
    if (!m || !isCheckable(m) || m.service !== 'gateway') continue;
    m.tests.forEach((t, i) => {
      if (t.kind !== 'http') return;
      const file = hubFile(t.path);
      if (!file || !/\.(js|css)$/.test(file)) return; // check 2 is /command-hub/<file>.js|.css only; routes and index are not files
      const body = fs.existsSync(path.join(COMMAND_HUB, file)) ? fs.readFileSync(path.join(COMMAND_HUB, file), 'utf8') : null;
      for (const s of strings(t.expect_body_contains)) {
        if (body === null || !body.includes(s)) bad.push(`${vtid} tests[${i}] ${t.path}: ${JSON.stringify(s)} not in ${file}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test('check 3: /command-hub/ index probes match index.html', () => {
  const bad = [];
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  for (const { vtid, m } of manifests) {
    if (!m || !isCheckable(m) || m.service !== 'gateway') continue;
    m.tests.forEach((t, i) => {
      if (t.kind !== 'http' || t.path !== '/command-hub/') return;
      for (const s of strings(t.expect_body_contains)) {
        if (!html.includes(s)) bad.push(`${vtid} tests[${i}] /command-hub/: ${JSON.stringify(s)} not in index.html`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test('check 4: existing jest/vitest refs point at files that exist', () => {
  const bad = [];
  for (const { vtid, m } of manifests) {
    if (!m || !isCheckable(m) || m.service !== 'gateway') continue;
    m.tests.forEach((t, i) => {
      if (t.kind !== 'existing' || typeof t.ref !== 'string') return;
      if (!/^npx (jest|vitest run)\b/.test(t.ref)) return;
      const cwd = path.join(ROOT, t.cwd || '.');
      for (const tok of t.ref.split(/\s+/).slice(2)) {
        if (tok.startsWith('-') || tok.includes('=') || tok.endsWith('/')) continue; // flags, dir prefixes
        if (!/\.(ts|tsx|js|cjs|mjs|jsx)$/.test(tok)) continue; // file-like tokens only
        if (!fs.existsSync(path.join(cwd, tok))) bad.push(`${vtid} tests[${i}] ref: ${tok} missing under ${t.cwd || '.'}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test('check 5: http probes use only the closed key set', () => {
  const bad = [];
  for (const { vtid, m } of manifests) {
    if (!m || !isCheckable(m)) continue;
    m.tests.forEach((t, i) => {
      if (t.kind !== 'http') return;
      for (const k of Object.keys(t)) if (!HTTP_KEYS.has(k)) bad.push(`${vtid} tests[${i}]: unknown key ${JSON.stringify(k)}`);
    });
  }
  assert.deepEqual(bad, []);
});
