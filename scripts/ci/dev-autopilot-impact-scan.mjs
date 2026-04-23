#!/usr/bin/env node
/**
 * Dev Autopilot — Impact Scan driver.
 *
 * Runs at PR-time (on pull_request events via .github/workflows/DEV-AUTOPILOT-IMPACT.yml)
 * and on manual dispatch. Reads the PR's git diff (base...HEAD), classifies
 * every changed file, runs every enabled rule in scripts/ci/impact-rules/
 * against the diff, and writes the aggregated findings to a JSON file the
 * workflow then posts as an auto-updating PR comment.
 *
 * Env:
 *   GITHUB_BASE_REF     PR base ref, e.g. 'main'. CI fills this.
 *   IMPACT_SCAN_BASE    Override base ref (useful for local dry runs).
 *                       Defaults to 'origin/main' if GITHUB_BASE_REF unset.
 *   IMPACT_SCAN_DRY_RUN If 'true', print findings to stdout and exit 0
 *                       regardless of severity.
 *   IMPACT_RULE_ALLOWLIST  comma-separated rule ids; default: all enabled
 *   IMPACT_RULE_DENYLIST   comma-separated rule ids; default: empty
 *
 * Exit code:
 *   0 — no blocker findings (warnings may exist)
 *   1 — at least one blocker finding, OR the scanner itself threw
 *
 * Output:
 *   dev-autopilot-impact-findings.json (alongside the signals.json from the
 *   baseline scanner) with shape:
 *     { findings: ImpactFinding[], counts: { blocker, warning, info } }
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { groupByCategory } from './impact-rules/_shared.mjs';
import { IMPACT_RULES } from './impact-rules/registry.mjs';

const REPO_ROOT = process.cwd();
const DRY_RUN = (process.env.IMPACT_SCAN_DRY_RUN || '').toLowerCase() === 'true';
const baseRef = process.env.IMPACT_SCAN_BASE
  || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main');
const allowlist = new Set((process.env.IMPACT_RULE_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean));
const denylist  = new Set((process.env.IMPACT_RULE_DENYLIST  || '').split(',').map(s => s.trim()).filter(Boolean));

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
}

function resolveBase() {
  // Try the raw baseRef; if that fails, fall back to HEAD~1.
  try {
    git(['rev-parse', '--verify', baseRef]);
    return baseRef;
  } catch { /* fall through */ }
  try {
    git(['rev-parse', '--verify', 'HEAD~1']);
    console.warn(`[impact-scan] base ref ${baseRef} unresolved — falling back to HEAD~1`);
    return 'HEAD~1';
  } catch {
    console.warn(`[impact-scan] could not resolve any base ref — empty diff`);
    return null;
  }
}

function loadRuleModules() {
  const out = new Map();
  const dir = path.join(REPO_ROOT, 'scripts', 'ci', 'impact-rules');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'registry.mjs');
  return Promise.all(files.map(async f => {
    try {
      const mod = await import(`./impact-rules/${f}`);
      if (mod && mod.meta && typeof mod.check === 'function') {
        out.set(mod.meta.rule, mod);
      }
    } catch (err) {
      console.warn(`[impact-scan] failed to load ${f}: ${err.message}`);
    }
  })).then(() => out);
}

function isRuleEnabled(ruleId) {
  if (denylist.has(ruleId)) return false;
  if (allowlist.size > 0 && !allowlist.has(ruleId)) return false;
  const entry = IMPACT_RULES.find(r => r.rule === ruleId);
  return entry ? entry.enabled : true;
}

async function main() {
  const base = resolveBase();
  let diff = '';
  let changedFiles = [];
  if (base) {
    try { diff = git(['diff', '--unified=3', `${base}...HEAD`]); }
    catch (err) { console.warn(`[impact-scan] git diff failed: ${err.message}`); }
    try {
      const raw = git(['diff', '--name-status', `${base}...HEAD`]);
      changedFiles = raw.trim().split('\n').filter(Boolean).map(line => {
        const [status, ...rest] = line.split('\t');
        return { status: status.charAt(0), path: rest.join('\t') };
      });
    } catch (err) { console.warn(`[impact-scan] name-status failed: ${err.message}`); }
  }
  const byCategory = groupByCategory(changedFiles);
  console.log(`[impact-scan] base=${base || '(none)'} changed=${changedFiles.length}`);

  const rules = await loadRuleModules();
  const ctx = { diff, changedFiles, byCategory, repoRoot: REPO_ROOT, baseRef: base };
  const findings = [];
  for (const entry of IMPACT_RULES) {
    if (!isRuleEnabled(entry.rule)) continue;
    const mod = rules.get(entry.rule);
    if (!mod) {
      console.warn(`[impact-scan] registry lists '${entry.rule}' but no module loaded — skipping`);
      continue;
    }
    try {
      const out = await mod.check(ctx);
      if (Array.isArray(out)) {
        for (const f of out) {
          findings.push({ ...f, category: entry.category, rule_title: entry.rule });
        }
      }
    } catch (err) {
      console.warn(`[impact-scan] rule '${entry.rule}' threw: ${err.message}`);
    }
  }

  const counts = { blocker: 0, warning: 0, info: 0 };
  for (const f of findings) {
    if (f.severity === 'blocker') counts.blocker++;
    else if (f.severity === 'warning') counts.warning++;
    else counts.info++;
  }

  const outPath = path.join(REPO_ROOT, 'dev-autopilot-impact-findings.json');
  fs.writeFileSync(outPath, JSON.stringify({ findings, counts, base, head: 'HEAD' }, null, 2));

  console.log(`[impact-scan] findings: blocker=${counts.blocker} warning=${counts.warning} info=${counts.info} total=${findings.length}`);
  console.log(`[impact-scan] wrote ${outPath}`);

  if (DRY_RUN) return;
  if (counts.blocker > 0) {
    console.error(`[impact-scan] FAILING: ${counts.blocker} blocker finding(s). See ${outPath} for details.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`[impact-scan] unhandled error:`, err);
  process.exit(1);
});
