#!/usr/bin/env node
// VTID-05158 — Health Hub store capacity model (Phase 1 A1, program VTID-05020).
//
// Parameters in, tables out. The published tables in
// docs/programs/health-hub/P1A-CAPACITY-AND-PLACEMENT.md are this script's
// output between the `capacity-model:begin/end` markers; capacity-model.test.mjs
// fails when they drift apart.
//
//   node scripts/health/capacity-model.mjs              # markdown (the published block)
//   node scripts/health/capacity-model.mjs --json       # the computed model
//   node scripts/health/capacity-model.mjs --params p.json   # override parameters (shallow merge)
//
// Planning figures are per CONNECTED member per day, high case. HealthKit /
// Health Connect pre-aggregate per interval on the device (Health Sync v1, S1),
// so there are no per-sample rows. Sizes are decimal (1 GB = 1e9 bytes).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const DEFAULT_PARAMS = Object.freeze({
  connected_share: 0.4, // program §7 success target: 40% connected
  scenarios: [
    { id: 'S', label: 'S (today)', members: 450 },
    { id: 'M', label: 'M', members: 10_000 },
    { id: 'L', label: 'L', members: 100_000 },
  ],
  tiers: {
    series_5m: { rows_per_day: 1_000, bytes_per_row: 200, retention_days: 31 }, // ≈ 8 codes × active buckets × 1.5 sources; daily partitions, 30 days + today
    series_1h: { rows_per_day: 100, bytes_per_row: 200 },
    series_1d: { rows_per_day: 50, bytes_per_row: 200 }, // ≈ 30 codes × 1.5 sources
    records: { rows_per_day: 20, bytes_per_row: 400 }, // sleep session (one row with segments), workouts, weight, spot values
  },
  upserts_per_day: 1_600, // incl. hourly/daily recomputes, ≈ 24 syncs/day
  peak_factor: 10,
  syncs_per_day: 24,
  backfill: { days_5m: 31, days_1h: 60, days_1d: 90, days_records: 90, round_rows_to: 1_000, json_bytes_per_row: 80, gzip_ratio: 8.5 },
  store_call_items: 5_000, // writeHealthSamples limit (S3)
  wire_batch_records: 1_000, // Health Sync v1 limit (S1)
  s3_gzip_bytes_per_day: 12_000,
  s3_retention_days: 30,
  backfill_wave_days: 7, // connects spread over 7 days (M wave figure)
  triggers: {
    tier_5m_gb: 150,
    upserts_per_sec_sustained_1h: 1_000,
    write_io_share: 0.4,
    connected_members: 15_000,
  },
});

const GB = 1e9;
const MB = 1e6;

export function computeModel(params = DEFAULT_PARAMS) {
  const p = params;
  const t = p.tiers;
  const perMember = {
    rows_5m_steady: t.series_5m.rows_per_day * t.series_5m.retention_days,
    rows_1h_year: t.series_1h.rows_per_day * 365,
    rows_1d_year: t.series_1d.rows_per_day * 365,
    rows_records_year: t.records.rows_per_day * 365,
  };
  perMember.bytes_5m_steady = perMember.rows_5m_steady * t.series_5m.bytes_per_row;
  perMember.bytes_lifetime_year =
    perMember.rows_1h_year * t.series_1h.bytes_per_row +
    perMember.rows_1d_year * t.series_1d.bytes_per_row +
    perMember.rows_records_year * t.records.bytes_per_row;

  const b = p.backfill;
  const backfillExact =
    t.series_5m.rows_per_day * b.days_5m +
    t.series_1h.rows_per_day * b.days_1h +
    t.series_1d.rows_per_day * b.days_1d +
    t.records.rows_per_day * b.days_records;
  const backfillRows = Math.round(backfillExact / b.round_rows_to) * b.round_rows_to;
  const backfillJson = backfillRows * b.json_bytes_per_row;
  perMember.backfill = {
    rows_exact: backfillExact,
    rows: backfillRows,
    json_bytes: backfillJson,
    gzip_bytes: backfillJson / b.gzip_ratio,
    store_calls: Math.ceil(backfillRows / p.store_call_items),
    wire_batches: Math.ceil(backfillRows / p.wire_batch_records),
  };
  perMember.s3_bytes_30d = p.s3_gzip_bytes_per_day * p.s3_retention_days + perMember.backfill.gzip_bytes;
  perMember.s3_objects_30d = p.syncs_per_day * p.s3_retention_days + perMember.backfill.store_calls;

  const scenarios = p.scenarios.map((s) => {
    const connected = Math.round(s.members * p.connected_share);
    const tier5m = connected * perMember.bytes_5m_steady;
    const lifetimeYear = connected * perMember.bytes_lifetime_year;
    const upsertsDay = connected * p.upserts_per_day;
    const avgPerSec = upsertsDay / 86_400;
    const wave = connected * backfillRows;
    return {
      id: s.id,
      label: s.label,
      members: s.members,
      connected,
      tier_5m_bytes: tier5m,
      lifetime_bytes_per_year: lifetimeYear,
      year_one_bytes: tier5m + lifetimeYear,
      upserts_per_day: upsertsDay,
      upserts_per_sec_avg: avgPerSec,
      upserts_per_sec_peak: avgPerSec * p.peak_factor,
      backfill_wave_rows: wave,
      backfill_wave_rows_per_sec: wave / (p.backfill_wave_days * 86_400),
      s3_bytes_30d: connected * perMember.s3_bytes_30d,
      s3_objects_30d: connected * perMember.s3_objects_30d,
      triggers_crossed: [
        tier5m / GB > p.triggers.tier_5m_gb ? 'tier_5m_gb' : null,
        avgPerSec * p.peak_factor > p.triggers.upserts_per_sec_sustained_1h ? 'peak_upserts_per_sec' : null,
        connected > p.triggers.connected_members ? 'connected_members' : null,
      ].filter(Boolean),
    };
  });
  return { params: p, per_member: perMember, scenarios };
}

// ── formatting ─────────────────────────────────────────────────────────────
const int = (n) => Math.round(n).toLocaleString('en-US');
function gb(bytes) {
  const v = bytes / GB;
  if (v >= 100) return `${int(v)} GB`;
  if (v >= 10) return `${v.toFixed(0)} GB`;
  return `${v.toFixed(1)} GB`;
}
function count(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} B`;
  if (n >= 1e6) return n >= 1e8 ? `${(n / 1e6).toFixed(0)} M` : `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)} M`;
  return int(n);
}
const perSec = (n) => `${int(n)}/s`;

export function renderMarkdown(model) {
  const { params: p, per_member: m } = model;
  const t = p.tiers;
  const lines = [];
  lines.push('Per connected member (high case):');
  lines.push('');
  lines.push('| Tier / item | Rows per connected member | Bytes/row incl. indexes | Retention |');
  lines.push('|---|---|---|---|');
  lines.push(`| 5-minute series | ${int(t.series_5m.rows_per_day)}/day → ${int(m.rows_5m_steady)} steady | ${t.series_5m.bytes_per_row} | 30 days (daily partitions dropped) |`);
  lines.push(`| Hourly series | ${int(t.series_1h.rows_per_day)}/day → ${int(m.rows_1h_year)}/year | ${t.series_1h.bytes_per_row} | lifetime |`);
  lines.push(`| Daily series | ${int(t.series_1d.rows_per_day)}/day → ${int(m.rows_1d_year)}/year | ${t.series_1d.bytes_per_row} | lifetime |`);
  lines.push(`| Records | ${int(t.records.rows_per_day)}/day → ${int(m.rows_records_year)}/year | ${t.records.bytes_per_row} | lifetime |`);
  lines.push(`| Upserts incl. hourly/daily recomputes (≈ ${p.syncs_per_day} syncs/day) | ≈ ${int(p.upserts_per_day)}/day | — | — |`);
  lines.push(
    `| Backfill at connect (${p.backfill.days_5m} d 5-minute, ${p.backfill.days_1h} d hourly, ${p.backfill.days_1d} d daily + records) | ` +
      `≈ ${int(m.backfill.rows)} rows, ≈ ${(m.backfill.json_bytes / MB).toFixed(1)} MB JSON, ≈ ${(m.backfill.gzip_bytes / MB).toFixed(1)} MB gzip, ` +
      `${m.backfill.store_calls} store calls (≤ ${int(p.store_call_items)} items) / ${m.backfill.wire_batches} wire batches (≤ ${int(p.wire_batch_records)} records) | — | — |`,
  );
  lines.push(`| S3 raw batches | ≈ ${int(p.s3_gzip_bytes_per_day / 1000)} KB gzip/day + backfill | — | ${p.s3_retention_days} days (lifecycle) |`);
  lines.push('');
  lines.push(`Scenarios at ${Math.round(p.connected_share * 100)}% connected:`);
  lines.push('');
  lines.push('| Scenario | Members → connected | 5-minute tier (steady) | Lifetime tiers growth | Year-one total | Upserts/day (avg; peak ×' + p.peak_factor + ') | Backfill wave | S3 (30 d) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const s of model.scenarios) {
    lines.push(
      `| ${s.label} | ${int(s.members)} → ${int(s.connected)} | ${gb(s.tier_5m_bytes)} | ${gb(s.lifetime_bytes_per_year)}/yr | ≈ ${gb(s.year_one_bytes)} | ` +
        `${count(s.upserts_per_day)} (${perSec(s.upserts_per_sec_avg)}; ${perSec(s.upserts_per_sec_peak)}) | ` +
        `${count(s.backfill_wave_rows)} rows (${perSec(s.backfill_wave_rows_per_sec)} over ${p.backfill_wave_days} days) | ` +
        `≈ ${gb(s.s3_bytes_30d)}, ≈ ${count(s.s3_objects_30d)} objects |`,
    );
  }
  lines.push('');
  lines.push('Re-evaluation triggers (alarmed by A2, Change 11):');
  lines.push('');
  lines.push(`- 5-minute tier > ${p.triggers.tier_5m_gb} GB`);
  lines.push(`- health upserts > ${int(p.triggers.upserts_per_sec_sustained_1h)}/s sustained for 1 h`);
  lines.push(`- health tables > ${Math.round(p.triggers.write_io_share * 100)}% of cluster write I/O for a week`);
  lines.push(`- > ${int(p.triggers.connected_members)} connected members`);
  lines.push('');
  lines.push(
    'Model scenarios crossing a trigger (peak upserts treated as sustained): ' +
      model.scenarios.map((s) => `${s.id}: ${s.triggers_crossed.length ? s.triggers_crossed.join(', ') : 'none'}`).join('; ') +
      '.',
  );
  return lines.join('\n');
}

function main(argv) {
  let params = DEFAULT_PARAMS;
  const i = argv.indexOf('--params');
  if (i !== -1) params = { ...DEFAULT_PARAMS, ...JSON.parse(readFileSync(argv[i + 1], 'utf8')) };
  const model = computeModel(params);
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(model, null, 2)}\n` : `${renderMarkdown(model)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
