#!/usr/bin/env node
// VTID-05445 (G2, G3): run the five DB lints and the bare-policy counter.
//   node scripts/mt/lint/run.mjs              # rebuild the PGlite stack, lint it, print the report (exit 0)
//   node scripts/mt/lint/run.mjs --committed  # lint the committed scripts/mt/inventory/data/*.json instead
//   node scripts/mt/lint/run.mjs --json       # the full report as JSON
//   node scripts/mt/lint/run.mjs --strict     # exit 1 on a finding outside the allowlist or a stale allowlist entry
// The bare-policy count is reported only: it is not asserted 0 (N3 is a WS1 gate). Unverified tables are listed, never passing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStack } from '../stack/stack.mjs';
import { buildRepoInventories, DATA_DIR, INVENTORY_FILES } from '../inventory/generate.mjs';
import { runLints, loadAllowlist, LINTS } from './lints.mjs';

export function formatReport(r) {
  const out = [];
  for (const l of LINTS) out.push(`${l}: ${r.summary.per_lint[l]} finding(s)`);
  out.push(`bare policies (reported, not asserted 0): ${r.bare_policies.count} (allowlisted ${r.bare_policies.allowed}, ${r.bare_policies.unverified_tables} unverified table(s) not counted)`);
  out.push(`allowlisted: ${r.summary.allowed}; stale allowlist entries: ${r.summary.stale_allowlist}`);
  out.push(`UNVERIFIED (not passing): ${r.summary.unverified}`);
  for (const u of r.unverified) out.push(`  UNVERIFIED ${u.lint} ${u.subject}: ${u.reason}`);
  for (const f of r.findings) out.push(`  FINDING ${f.lint} ${f.subject}: ${f.detail}`);
  for (const e of r.stale_allowlist) out.push(`  STALE ${e.lint} ${e.subject} (owner ${e.owner})`);
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  const allowlist = loadAllowlist();
  let inv;
  if (args.has('--committed')) {
    inv = Object.fromEntries(Object.entries(INVENTORY_FILES).map(([k, f]) => [k, JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'))]));
  } else {
    const { db } = await createStack({ fixtures: false, shim: false });
    try { inv = await buildRepoInventories(db); } finally { await db.close(); }
  }
  const report = runLints(inv, allowlist);
  console.log(args.has('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
  if (args.has('--strict') && (report.summary.findings > 0 || report.summary.stale_allowlist > 0)) process.exitCode = 1;
}
