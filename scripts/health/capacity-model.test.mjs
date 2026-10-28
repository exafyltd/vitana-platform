// VTID-05158 — pins the published capacity tables to the script output.
// Runs in UNIT.yml (node:test, no install): node --test scripts/health/capacity-model.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, computeModel, renderMarkdown } from './capacity-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = join(ROOT, 'docs', 'programs', 'health-hub', 'P1A-CAPACITY-AND-PLACEMENT.md');

function publishedBlock() {
  const doc = readFileSync(DOC, 'utf8');
  const m = doc.match(/<!-- capacity-model:begin -->\n([\s\S]*?)\n<!-- capacity-model:end -->/);
  assert.ok(m, 'the capacity-model:begin/end markers are missing from P1A-CAPACITY-AND-PLACEMENT.md');
  return m[1];
}

test('the published tables equal the script output (regenerate: node scripts/health/capacity-model.mjs)', () => {
  assert.equal(publishedBlock(), renderMarkdown(computeModel()));
});

test('owner-confirmed inputs: S/M/L at 40% connected and the four placement triggers', () => {
  assert.equal(DEFAULT_PARAMS.connected_share, 0.4);
  assert.deepEqual(DEFAULT_PARAMS.scenarios.map((s) => [s.id, s.members]), [['S', 450], ['M', 10_000], ['L', 100_000]]);
  assert.deepEqual(DEFAULT_PARAMS.triggers, {
    tier_5m_gb: 150,
    upserts_per_sec_sustained_1h: 1_000,
    write_io_share: 0.4,
    connected_members: 15_000,
  });
});

test('headline figures match the sparred plan (Change 4)', () => {
  const m = computeModel();
  const [S, M, L] = m.scenarios;
  assert.equal(m.per_member.rows_5m_steady, 31_000);
  assert.equal(m.per_member.backfill.rows, 43_000);
  assert.deepEqual([S.connected, M.connected, L.connected], [180, 4_000, 40_000]);
  assert.equal(Math.round(S.tier_5m_bytes / 1e8) / 10, 1.1); // 1.1 GB
  assert.equal(Math.round(M.tier_5m_bytes / 1e9), 25); // 25 GB
  assert.equal(Math.round(M.lifetime_bytes_per_year / 1e9), 55); // 55 GB/yr
  assert.equal(Math.round(M.year_one_bytes / 1e10) * 10, 80); // ≈ 80 GB
  assert.equal(Math.round(M.upserts_per_sec_avg), 74);
  assert.equal(Math.round(L.upserts_per_sec_avg), 741);
  assert.equal(M.backfill_wave_rows, 172_000_000);
  // Placement: S and M stay inside every trigger; L crosses them (re-evaluate before L).
  assert.deepEqual(S.triggers_crossed, []);
  assert.deepEqual(M.triggers_crossed, []);
  assert.ok(L.triggers_crossed.length > 0);
});

test('parameters in, tables out: doubling the 5-minute rows doubles that tier only', () => {
  const p = structuredClone(DEFAULT_PARAMS);
  p.tiers.series_5m.rows_per_day *= 2;
  const a = computeModel().scenarios[1];
  const b = computeModel(p).scenarios[1];
  assert.equal(b.tier_5m_bytes, 2 * a.tier_5m_bytes);
  assert.equal(b.lifetime_bytes_per_year, a.lifetime_bytes_per_year);
});
