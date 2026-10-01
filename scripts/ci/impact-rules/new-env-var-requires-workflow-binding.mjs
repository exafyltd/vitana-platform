/**
 * new-env-var-requires-workflow-binding
 *
 * When a diff ADDS a `process.env.X` reference (not just reads an existing
 * var in a line that got moved), X should exist in at least one of:
 *   - .github/workflows/*.yml (env: or secrets:)
 *   - .env.example / .env.template
 *   - services/<svc>/.env.example
 *   - any Cloud Run deploy config (EXEC-DEPLOY.yml args)
 *   - a defensive fallback at the call site: `process.env.X ?? 'default'`
 *
 * Otherwise the var reads as undefined in production and the code path
 * silently no-ops. This has happened repeatedly (GCP_PROJECT_ID incident,
 * Appilix push config incident, etc.).
 *
 * VTID-04287: the last bullet is the suggested_action this rule has always
 * printed ("if it's truly optional, add a defensive `process.env.X ?? 'default'`
 * at the call site") but the check never looked at the call site — it only
 * grepped workflow/.env.example/deploy-config text for the var name. So a diff
 * whose every added line already had a defensive fallback (HARNESS_URL,
 * OUT_DIR, TABS in the VTID-04282 harness-shoot output script) still got
 * reported, and could never be cleared by the remedy the rule itself
 * recommends. An unsatisfiable gate is worse than no gate (VTID-03696): the
 * finding was re-executed 461 times over 12.5 hours (VTID-04368).
 *
 * A same-line `||`/`??` fallback now counts as a binding, but only when the
 * right-hand side can never itself be undefined:
 *   bound:   process.env.X ?? 'default'      process.env.X || __dirname
 *            process.env.X ?? `./out/${id}`  process.env.X || 0
 *   still reported:
 *            process.env.X                   (bare read)
 *            process.env.X || undefined      (fallback is undefined)
 *            process.env.X ?? process.env.Y  (Y may itself be unset)
 *
 * The check is per ADDED LINE, not per var: a var bound on one line and read
 * bare on another is still reported.
 */

import { extractAddedLines, readFileSafe } from './_shared.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const meta = {
  rule: 'new-env-var-requires-workflow-binding',
  category: 'companion',
  severity: 'warning',
};

const ENV_VAR_RE = /process\.env\.([A-Z][A-Z0-9_]+)/g;

// Vars everyone knows are set by the platform — skip these.
const ALWAYS_BOUND = new Set([
  'NODE_ENV', 'PORT', 'HOME', 'PATH', 'PWD', 'USER', 'TZ', 'LANG',
  'NODE_VERSION', 'HOSTNAME',
  // GitHub Actions built-ins
  'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID',
  'GITHUB_ACTOR', 'GITHUB_WORKFLOW', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH',
  'GITHUB_HEAD_REF', 'GITHUB_BASE_REF', 'GITHUB_REF_NAME',
  'CI', 'RUNNER_OS', 'RUNNER_NAME',
  // Cloud Run built-ins
  'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION', 'GOOGLE_CLOUD_PROJECT',
  // Optional operator knobs with sensible defaults — safe to read as undefined.
  'IMPACT_RULE_ALLOWLIST', 'IMPACT_RULE_DENYLIST', 'IMPACT_SCAN_BASE', 'IMPACT_SCAN_DRY_RUN',
  'SCANNER_ALLOWLIST', 'SCANNER_DENYLIST',
  'MISSING_TESTS_MIN_LOC', 'MISSING_TESTS_FILENAME_DENYLIST',
  'STALE_FLAG_DAYS', 'PRODUCT_GAP_INTERVAL_HOURS',
]);

// RHS shapes that are treated as total (never undefined): string / template
// literal, number, boolean, null, or a plain identifier or member path such as
// `__dirname`. Matched as the LEADING token of the right-hand side, so
// `process.env.TABS || 'live,scanners'.split(',')` counts on its `'live,scanners'`
// and not on whatever trailing expression follows. `undefined` and any
// `process.env.*` RHS are rejected before this runs — those are the two shapes
// that only move the undefined around.
const SAFE_FALLBACK_LEAD_RE =
  /^(?:'[^']*'|"[^"]*"|`[^`]*`|-?\d+(?:\.\d+)?|true|false|null|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*)/;

// Operators that turn a read into a bound read. `??` is the canonical remedy
// and `||` is the older form used all over docs/validation/*/outputs/*.js.
const FALLBACK_OP = String.raw`(?:\?\?|\|\|)`;

/**
 * Split a source line on the fallback operators, so the right-hand side can be
 * inspected without a regex that has to guess where an expression ends
 * (`process.env.OUT_DIR || __dirname` must NOT swallow a later `?? 1`).
 * Ternary `? :` never produces a `?` followed by another `?`, so `??` is
 * unambiguous to locate.
 */
function splitOnFallbackOperators(text) {
  return text.split(/\?\?|\|\|/);
}

/**
 * True when every reference to `varName` on this line is read through a
 * defensive fallback whose right-hand side is a total value.
 */
export function hasDefensiveFallback(text, varName) {
  const re = new RegExp(`process\\.env\\.${varName}\\b`);
  if (!re.test(text)) return false;

  // `?? undefined` / `|| undefined` is a read that is still undefined.
  if (new RegExp(`process\\.env\\.${varName}\\b\\s*${FALLBACK_OP}\\s*undefined\\b`).test(text)) {
    return false;
  }
  // `?? process.env.Y` just moves the undefined somewhere else.
  if (new RegExp(`process\\.env\\.${varName}\\b\\s*${FALLBACK_OP}\\s*process\\.env\\.`).test(text)) {
    return false;
  }

  const parts = splitOnFallbackOperators(text);
  const reads = parts
    .map((part, i) => ({ part, i }))
    .filter(({ part }) => re.test(part));
  if (reads.length === 0) return false;

  // The read must not be the trailing operand: `x || process.env.VAR` binds
  // nothing. The fallback for a read is whatever follows it.
  for (const { i } of reads) {
    if (i >= parts.length - 1) return false;
    const rhs = parts[i + 1].trim().replace(/^[([]+/, '');
    if (!SAFE_FALLBACK_LEAD_RE.test(rhs)) return false;
  }
  return true;
}

function collectConfigFiles(repoRoot) {
  const texts = [];
  const roots = [
    '.github/workflows',
    'services/gateway',
    'services/autopilot-worker',
    'services/oasis-operator',
    'services/oasis-projector',
  ];
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length > 0) {
      const cur = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (/\.(yml|yaml|json|sh)$/.test(e.name) || /\.env(\.example|\.template)?$/.test(e.name)) {
          const t = readFileSafe(full);
          if (t) texts.push(t);
        }
      }
    }
  }
  return texts.join('\n');
}

export async function check({ diff, repoRoot }) {
  // Only check added lines in source files (not config/test files).
  const added = extractAddedLines(diff, /\.(ts|tsx|mjs|js)$/);
  const newVars = new Set();
  const boundAtCallSite = new Set();
  // Vars with at least one ADDED line that reads them without a defensive
  // fallback. Tracking this per line — not per var — is what keeps a var that
  // is bound on one line and read bare on another reported.
  const bareReads = new Set();
  for (const l of added) {
    if (/\/(test|tests|__tests__|__mocks__|fixtures)\//.test(l.file)) continue;
    if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(l.file)) continue;
    let m;
    ENV_VAR_RE.lastIndex = 0;
    while ((m = ENV_VAR_RE.exec(l.text)) !== null) {
      const v = m[1];
      if (ALWAYS_BOUND.has(v)) continue;
      newVars.add(v);
      // VTID-04287: a defensive same-line fallback IS the binding the rule's
      // own suggested_action recommends — count it here, not in config text.
      if (hasDefensiveFallback(l.text, v)) boundAtCallSite.add(v);
      else bareReads.add(v);
    }
  }
  if (newVars.size === 0) return [];
  if (bareReads.size === 0) return [];

  const configText = collectConfigFiles(repoRoot);
  const missing = [...bareReads].filter(v => !new RegExp(`\\b${v}\\b`).test(configText));
  if (missing.length === 0) return [];

  return [{
    rule: meta.rule,
    severity: meta.severity,
    file_path: null,
    line_number: null,
    message: `${missing.length} new process.env reference(s) with no binding in any workflow / deploy config / .env.example and no defensive fallback at the call site: ${missing.join(', ')}.`,
    suggested_action: `For each var, either (a) bind it in the relevant deploy workflow (e.g. EXEC-DEPLOY.yml service env), (b) add it to the service's .env.example with a documented default, or (c) if it's truly optional, add a defensive \`process.env.X ?? 'default'\` at the call site. (c) is recognised on the same added line and clears this finding — the fallback must be a literal, template literal, number, boolean, null, or a plain identifier/member path that is never undefined.`,
    raw: {
      missing_env_vars: missing,
      // What the rule accepted as a binding on the same added line. A var that
      // was bound on one line and read bare on another is in `missing`, so it
      // is not listed here.
      bound_at_call_site: [...boundAtCallSite].filter(v => !missing.includes(v)),
    },
  }];
}
