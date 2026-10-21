// VTID-05301 — tests for the CI-health report producer.
// Run: node --test scripts/ci/health/report.test.mjs (also enforced by UNIT.yml which runs all scripts/**/*.test.*)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runDurationMs,
  percentiles,
  buildReport,
  normalizeCoverageGap,
  renderMarkdown,
  DEFAULT_COVERAGE_GAP,
} from './report.mjs';

const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

test('runDurationMs: createdAt→updatedAt wall time; null when a timestamp is missing or reversed', () => {
  const t0 = Date.parse('2026-10-21T10:00:00Z');
  assert.equal(runDurationMs({ createdAt: iso(t0), updatedAt: iso(t0 + 5 * 60000) }), 5 * 60000);
  assert.equal(runDurationMs({ createdAt: iso(t0) }), null);
  assert.equal(runDurationMs({ createdAt: iso(t0 + 1), updatedAt: iso(t0) }), null);
  assert.equal(runDurationMs(null), null);
});

test('percentiles: median and nearest-rank p90; empty list is null', () => {
  assert.deepEqual(percentiles([]), { median: null, p90: null, count: 0 });
  const r = percentiles([10, 20, 30, 40]);
  assert.equal(r.median, 25);
  assert.equal(r.count, 4);
  const p = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(p.p90, 9);
});

test('buildReport: flake rate counts a head SHA that both failed and succeeded', () => {
  const base = Date.parse('2026-10-20T00:00:00Z');
  const runs = [
    // sha-A: failed then re-run succeeded => flaky
    { name: 'TEST-SUITE', headSha: 'A', headBranch: 'pr', conclusion: 'failure', createdAt: iso(base), updatedAt: iso(base + 60000) },
    { name: 'TEST-SUITE', headSha: 'A', headBranch: 'pr', conclusion: 'success', createdAt: iso(base + HOUR), updatedAt: iso(base + HOUR + 60000) },
    // sha-B: failed only => a failure but not flaky
    { name: 'TEST-SUITE', headSha: 'B', headBranch: 'pr', conclusion: 'failure', createdAt: iso(base), updatedAt: iso(base + 60000) },
  ];
  const rep = buildReport(runs, { nowMs: base + 2 * HOUR });
  const w = rep.workflows.find((x) => x.name === 'TEST-SUITE');
  assert.equal(w.flakyHeads, 1);
  assert.equal(w.flakeRate, 0.5); // 1 flaky of 2 heads that had a failure
});

test('buildReport: red-on-main age spans the oldest consecutive failing main run', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const runs = [
    { name: 'PR-GATE', headSha: 'x1', headBranch: 'main', conclusion: 'failure', createdAt: iso(now - 10 * HOUR), updatedAt: iso(now - 10 * HOUR + 60000) },
    { name: 'PR-GATE', headSha: 'x2', headBranch: 'main', conclusion: 'failure', createdAt: iso(now - 4 * HOUR), updatedAt: iso(now - 4 * HOUR + 60000) },
    // a success before the red streak started — must not extend the age past x1
    { name: 'PR-GATE', headSha: 'x0', headBranch: 'main', conclusion: 'success', createdAt: iso(now - 20 * HOUR), updatedAt: iso(now - 20 * HOUR + 60000) },
  ];
  const rep = buildReport(runs, { nowMs: now });
  const w = rep.workflows.find((x) => x.name === 'PR-GATE');
  assert.equal(w.redOnMain, true);
  assert.equal(w.redAgeHours, 10);
});

test('buildReport: a green latest main run is not red on main', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const runs = [
    { name: 'UNIT', headSha: 'y1', headBranch: 'main', conclusion: 'failure', createdAt: iso(now - 8 * HOUR), updatedAt: iso(now - 8 * HOUR + 60000) },
    { name: 'UNIT', headSha: 'y2', headBranch: 'main', conclusion: 'success', createdAt: iso(now - 1 * HOUR), updatedAt: iso(now - 1 * HOUR + 60000) },
  ];
  const w = buildReport(runs, { nowMs: now }).workflows.find((x) => x.name === 'UNIT');
  assert.equal(w.redOnMain, false);
  assert.equal(w.redAgeHours, null);
});

test('buildReport: per-check median/p90 duration is reported per workflow', () => {
  const t = Date.parse('2026-10-21T00:00:00Z');
  const mk = (sha, mins) => ({ name: 'CICDL', headSha: sha, headBranch: 'pr', conclusion: 'success', createdAt: iso(t), updatedAt: iso(t + mins * 60000) });
  const rep = buildReport([mk('a', 2), mk('b', 4), mk('c', 6), mk('d', 8)]);
  const w = rep.workflows.find((x) => x.name === 'CICDL');
  assert.equal(w.medianMs, 5 * 60000);
  assert.equal(w.durationCount, 4);
});

test('buildReport: empty input yields a well-formed report with the coverage gap', () => {
  const rep = buildReport([]);
  assert.equal(rep.schema, 'vitana.ci-health/v1');
  assert.deepEqual(rep.workflows, []);
  assert.ok(rep.coverageGap.length >= 3);
  assert.ok(rep.coverageGap.some((g) => g.kind === 'playwright-e2e'));
  assert.ok(rep.coverageGap.some((g) => g.kind === 'shell-test'));
});

test('normalizeCoverageGap: caller list overrides defaults; shape is fixed', () => {
  assert.deepEqual(normalizeCoverageGap(null), normalizeCoverageGap(DEFAULT_COVERAGE_GAP));
  const custom = normalizeCoverageGap([{ kind: 'k', glob: 'g/**', approxCount: 3 }]);
  assert.equal(custom.length, 1);
  assert.deepEqual(custom[0], { kind: 'k', glob: 'g/**', approxCount: 3, note: '' });
});

test('renderMarkdown: reports flake rate, red-on-main age, duration and coverage gap', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const runs = [
    { name: 'PR-GATE', headSha: 'm', headBranch: 'main', conclusion: 'failure', createdAt: iso(now - 3 * HOUR), updatedAt: iso(now - 3 * HOUR + 60000) },
    { name: 'TEST-SUITE', headSha: 'A', headBranch: 'pr', conclusion: 'failure', createdAt: iso(now - HOUR), updatedAt: iso(now - HOUR + 60000) },
    { name: 'TEST-SUITE', headSha: 'A', headBranch: 'pr', conclusion: 'success', createdAt: iso(now), updatedAt: iso(now + 60000) },
  ];
  const md = renderMarkdown(buildReport(runs, { nowMs: now }));
  assert.match(md, /Red on main/);
  assert.match(md, /red 3h/);
  assert.match(md, /Flaky/);
  assert.match(md, /Per-check duration/);
  assert.match(md, /Coverage gap/);
  assert.match(md, /playwright-e2e/);
});
