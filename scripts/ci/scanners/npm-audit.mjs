/**
 * npm-audit-scanner-v1
 *
 * Runs `npm audit --json` per service directory that has a package-lock.json,
 * and emits one finding per advisory at severity high/critical. Moderate and
 * low advisories are counted in the raw payload but not emitted (too noisy
 * for an auto-approval pipeline).
 *
 * Requires network access on the scanner runner and node installed.
 *
 * npm audit exit code: non-zero when vulnerabilities are found — we read
 * stdout regardless, since that's where the JSON report lives.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { relFromRepo } from './_shared.mjs';

const execFileP = promisify(execFile);

export const meta = {
  scanner: 'npm-audit-scanner-v1',
  signal_type: 'cve',
};

// Only audit top-level services — each has its own package-lock.
const AUDIT_TARGETS = [
  'services/gateway',
  'services/autopilot-worker',
  'services/oasis-operator',
  'services/oasis-projector',
  'services/agents/vitana-orchestrator',
  'services/worker-runner',
  'services/data-sync',
];

async function runAudit(dir) {
  try {
    const { stdout } = await execFileP('npm', ['audit', '--json', '--omit=dev'], {
      cwd: dir,
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err) {
    // npm audit exits 1 when vulns are found; the JSON is still on stdout.
    if (err && typeof err === 'object' && 'stdout' in err && err.stdout) {
      try { return JSON.parse(String(err.stdout)); } catch { /* fall through */ }
    }
    return { error: String(err && err.message || err) };
  }
}

function extractAdvisories(report) {
  // npm v7+ format: report.vulnerabilities is a map of package -> { severity, via: [...] }
  if (!report || typeof report !== 'object') return [];
  const out = [];
  const seen = new Set();
  const vulns = report.vulnerabilities || {};
  for (const [pkg, info] of Object.entries(vulns)) {
    if (!info || !['high', 'critical'].includes(info.severity)) continue;
    const via = Array.isArray(info.via) ? info.via : [];
    for (const v of via) {
      if (typeof v !== 'object' || !v) continue;
      const key = `${pkg}|${v.source || v.name || v.title || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        package: pkg,
        severity: info.severity,
        title: v.title || `${v.name || pkg} vulnerability`,
        cve: (v.cve && v.cve[0]) || null,
        cwe: (v.cwe && v.cwe[0]) || null,
        url: v.url || null,
        range: v.range || null,
      });
    }
    if (via.length === 0) {
      // Transitive-only — still worth flagging at critical.
      if (!seen.has(pkg)) {
        seen.add(pkg);
        out.push({
          package: pkg,
          severity: info.severity,
          title: `${info.severity} vulnerability in ${pkg} (transitive)`,
          cve: null, cwe: null, url: null, range: null,
        });
      }
    }
  }
  return out;
}

export async function run({ repoRoot }) {
  const signals = [];
  for (const target of AUDIT_TARGETS) {
    const dir = path.join(repoRoot, target);
    if (!fs.existsSync(path.join(dir, 'package-lock.json'))) continue;

    const report = await runAudit(dir);
    if (report.error) {
      // Scanner error is not a scan-finding — log and move on.
      console.warn(`[npm-audit] ${target}: ${report.error.slice(0, 160)}`);
      continue;
    }
    const advisories = extractAdvisories(report);
    for (const a of advisories) {
      const rel = relFromRepo(repoRoot, path.join(dir, 'package.json'));
      signals.push({
        type: 'cve',
        severity: a.severity === 'critical' ? 'high' : 'high', // both map to high in our taxonomy
        file_path: rel,
        line_number: 1,
        message: `[${a.severity}] ${a.package}: ${a.title}${a.cve ? ` (${a.cve})` : ''}`,
        suggested_action: a.range
          ? `Bump ${a.package} past ${a.range}. If it's a transitive dep, check \`npm why ${a.package}\` and nudge the parent.`
          : `Review ${a.package} — run \`npm why ${a.package}\` in ${target} to see the dependency path.`,
        scanner: 'npm-audit-scanner-v1',
        raw: { service: target, ...a },
      });
    }
  }
  return signals;
}
