/**
 * new-env-var-requires-workflow-binding
 *
 * When a diff ADDS a `process.env.X` reference (not just reads an existing
 * var in a line that got moved), X should exist in at least one of:
 *   - .github/workflows/*.yml (env: or secrets:)
 *   - .env.example / .env.template
 *   - services/<svc>/.env.example
 *   - any Cloud Run deploy config (EXEC-DEPLOY.yml args)
 *
 * Otherwise the var reads as undefined in production and the code path
 * silently no-ops. This has happened repeatedly (GCP_PROJECT_ID incident,
 * Appilix push config incident, etc.).
 *
 * VTID-04287 — a same-line defensive fallback IS a binding. The rule's own
 * suggested_action (c) tells people to write `process.env.X ?? 'default'`,
 * yet the checker only ever looked for the var name in workflow/.env.example
 * text. A call site that already cannot read as `undefined` was therefore
 * rejected by the evidence the rule itself asks for — an unsatisfiable gate,
 * which is exactly the false-positive class that fired the finding this rule
 * is named in (`HARNESS_URL`, `OUT_DIR`, `TABS` in
 * docs/validation/VTID-04282/outputs/harness-shoot.js, all three already
 * written as `process.env.X || '<default>'`).
 *
 * So: for each ADDED `process.env.X` reference, X is considered bound when
 * the same line carries `|| <value>` or `?? <value>` (SAFE_FALLBACK_VALUE
 * lists what counts as a value). Anything else — including
 * `process.env.A || process.env.B`, where B may be unset too — is still
 * reported. A var that appears anywhere in the diff without such a fallback
 * is still reported, so this cannot become a blanket exemption.
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

// The operator that starts a defensive fallback: `a || b` / `a ?? b`.
const FALLBACK_OP = '(?:\\|\\||\\?\\?)';

// A fallback value that can never be `undefined`: a string/template literal,
// a number, a boolean, or a plain identifier / member path.
const SAFE_FALLBACK_VALUE = [
  "'(?:[^'\\\\]|\\\\.)*'",
  '"(?:[^"\\\\]|\\\\.)*"',
  '`(?:[^`\\\\]|\\\\.)*`',
  '-?\\d+(?:\\.\\d+)?',
  '(?:true|false)',
  '[A-Za-z_$][\\w$]*(?:\\.[\\w$]+)*',
].join('|');

const SAFE_FALLBACK_RE = new RegExp(`^\\s*${FALLBACK_OP}\\s*(?:${SAFE_FALLBACK_VALUE})`);

/**
 * True when `rest` (everything after a `process.env.X` match on the line)
 * starts with a defensive fallback for X, i.e. that read can never yield
 * `undefined`.
 *
 * Deliberately NOT a fallback: another `process.env.X` read (X may be unset
 * too), `undefined` itself, a call (`|| someGetter()`, which may itself return
 * undefined), a parenthesised expression, and anything else unrecognised —
 * those stay reported rather than being waved through.
 */
export function hasDefensiveFallback(rest) {
  const m = SAFE_FALLBACK_RE.exec(rest);
  if (!m) return false;
  // `|| foo(...)` is a call, not a guaranteed value.
  if (/^\s*\(/.test(rest.slice(m[0].length))) return false;
  const value = m[0].replace(new RegExp(`^\\s*${FALLBACK_OP}\\s*`), '').trim();
  if (value === 'undefined') return false;
  if (value === 'process.env' || value.startsWith('process.env.')) return false;
  return true;
}

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
  // X -> true once ANY added reference to X has no same-line fallback. A var is
  // only exempt when EVERY reference to it is defensively defaulted, so one
  // guarded line elsewhere cannot launder an unguarded read.
  const unguardedVars = new Map();
  for (const l of added) {
    if (/\/(test|tests|__tests__|__mocks__|fixtures)\//.test(l.file)) continue;
    if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(l.file)) continue;
    let m;
    ENV_VAR_RE.lastIndex = 0;
    while ((m = ENV_VAR_RE.exec(l.text)) !== null) {
      const v = m[1];
      if (ALWAYS_BOUND.has(v)) continue;
      const rest = l.text.slice(m.index + m[0].length);
      const guarded = hasDefensiveFallback(rest);
      if (!guarded) unguardedVars.set(v, true);
      else if (!unguardedVars.has(v)) unguardedVars.set(v, false);
    }
  }
  const newVars = new Set(
    [...unguardedVars.entries()].filter(([, unguarded]) => unguarded).map(([v]) => v),
  );
  if (newVars.size === 0) return [];

  const configText = collectConfigFiles(repoRoot);
  const missing = [...newVars].filter(v => !new RegExp(`\\b${v}\\b`).test(configText));
  if (missing.length === 0) return [];

  return [{
    rule: meta.rule,
    severity: meta.severity,
    file_path: null,
    line_number: null,
    message: `${missing.length} new process.env reference(s) with no binding in any workflow / deploy config / .env.example: ${missing.join(', ')}.`,
    suggested_action: `For each var, either (a) bind it in the relevant deploy workflow (e.g. EXEC-DEPLOY.yml service env), (b) add it to the service's .env.example with a documented default, or (c) if it's truly optional, add a defensive \`process.env.X ?? 'default'\` at the call site.`,
    raw: { missing_env_vars: missing },
  }];
}
