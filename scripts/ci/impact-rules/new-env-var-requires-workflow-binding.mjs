/**
 * new-env-var-requires-workflow-binding
 *
 * When a diff ADDS a `process.env.<VAR>` reference (not just reads an existing
 * var in a line that got moved), that var should exist in at least one of:
 *   - .github/workflows/*.yml (env: or secrets:)
 *   - .env.example / .env.template
 *   - services/<svc>/.env.example
 *   - any Cloud Run deploy config (EXEC-DEPLOY.yml args)
 *   - OR the added code itself handles the unset case with a defensive
 *     fallback / guard (the third remedy this rule's suggested_action has
 *     always advertised, but which the implementation could not detect).
 *
 * Otherwise the var reads as undefined in production and the code path
 * silently no-ops. This has happened repeatedly (GCP_PROJECT_ID incident,
 * Appilix push config incident, etc.).
 *
 * VTID-04287 — remedy (c) was unimplementable.
 *
 * Live finding: 3 vars (`HARNESS_URL`, `OUT_DIR`, `TABS`) reported as having
 * "no binding in any workflow / deploy config / .env.example". Read each one
 * at its call site — `docs/validation/VTID-04282/outputs/harness-shoot.js`:
 *
 *     const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18482';
 *     const OUT  = process.env.OUT_DIR      || __dirname;
 *     const TABS = (process.env.TABS        || 'live,scanners,...').split(',');
 *
 * All three are already handled at the call site, exactly as this rule's own
 * suggested_action says ("if it's truly optional, add a defensive
 * `process.env.<VAR> ?? 'default'` at the call site"). The rule could not see
 * that: it only ever tested the config blob, so the remedy it recommended was
 * a path to a permanent warning. A finding that cannot be cleared by doing
 * what it says is how a gate gets laundered — VTID-03696 already established
 * that an unsatisfiable gate is worse than no gate.
 *
 * Fix: an added read is considered handled when its own line carries a
 * fallback, or when it binds a local that the added lines then null-check
 * (the `services/gateway/src/env.ts` shape). Detection is occurrence-level and
 * diff-scoped: a bare read is still flagged even if the same var has a
 * defensive read elsewhere in the diff, and a guard that predates this PR
 * cannot satisfy it.
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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `text` handle a missing value for `varName`?
 *
 * Covers the defensive shapes this rule's suggested_action names:
 *   process.env.<VAR> ?? 'default'       nullish default
 *   process.env.<VAR> || 'default'       falsy default
 *   process.env.<VAR> && x.y             short-circuit before use
 *   !process.env.<VAR>                   explicit null check
 *   process.env.<VAR> === undefined      explicit null check (also == null,
 *   process.env.<VAR> !== undefined       !== undefined, either operand order)
 */
export function hasDefensiveDefault(text, varName) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const read = `process\\.env\\.${escapeRe(varName)}`;
  return [
    // Same-statement fallback / short-circuit. Horizontal whitespace only, so
    // a read at the end of one line cannot match a fallback on the next.
    new RegExp(`${read}[ \\t]*(?:\\?\\?|\\|\\||&&)`),
    // Explicit null-check guard, in either order.
    new RegExp(`![ \\t]*${read}`),
    new RegExp(`${read}[ \\t]*(?:={2,3}|!==?)[ \\t]*(?:undefined|null)\\b`),
    new RegExp(`(?:undefined|null)[ \\t]*(?:={2,3}|!==?)[ \\t]*${read}`),
  ].some(re => re.test(text));
}

/**
 * The multi-line guard shape, which is the canonical defensive read in this
 * codebase (`services/gateway/src/env.ts`):
 *
 *     const url = process.env.SUPABASE_URL;
 *     if (!url) return null;
 *
 * The fallback is not on the read's line, so `hasDefensiveDefault` cannot see
 * it. Rather than scanning the whole block for any `??` — which would let a
 * bare `process.env.X` ride on an unrelated `process.env.X ?? 'y'` elsewhere
 * in the same diff — bind the read to its local name and require a null check
 * on THAT name.
 */
export function bindingLocalName(line, varName) {
  if (typeof line !== 'string' || line.length === 0) return null;
  const re = new RegExp(
    `(?:const|let|var)[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*=[ \\t]*process\\.env\\.${escapeRe(varName)}\\b`,
  );
  return re.exec(line)?.[1] ?? null;
}

/** Is `name` explicitly null-checked on any of `lines`? */
export function isGuardedByName(lines, name) {
  if (!Array.isArray(lines) || typeof name !== 'string' || name.length === 0) return false;
  const n = escapeRe(name);
  const guards = [
    new RegExp(`![ \\t]*${n}\\b`),
    new RegExp(`\\b${n}\\b[ \\t]*(?:={2,3}|!==?)[ \\t]*(?:undefined|null)\\b`),
    new RegExp(`(?:undefined|null)[ \\t]*(?:={2,3}|!==?)[ \\t]*\\b${n}\\b`),
  ];
  return lines.some(l => guards.some(re => re.test(l)));
}

/**
 * Does the added block read `varName` in the multi-line guarded shape?
 * True when a read of the var is bound to a local that is then null-checked.
 */
export function hasGuardedBinding(lines, varName) {
  if (!Array.isArray(lines)) return false;
  for (const line of lines) {
    const name = bindingLocalName(line, varName);
    if (name && isGuardedByName(lines, name)) return true;
  }
  return false;
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
  /** file -> { readLines: {text, vars}[], lines: string[] } */
  const byFile = new Map();

  for (const l of added) {
    if (/\/(test|tests|__tests__|__mocks__|fixtures)\//.test(l.file)) continue;
    if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(l.file)) continue;
    if (!byFile.has(l.file)) byFile.set(l.file, { readLines: [], lines: [] });
    const entry = byFile.get(l.file);
    // Every added line is kept: a guard may sit on a line that does not itself
    // read the var (`const raw = process.env.X;` then `if (!raw) ...`).
    entry.lines.push(l.text);
    const vars = [];
    let m;
    ENV_VAR_RE.lastIndex = 0;
    while ((m = ENV_VAR_RE.exec(l.text)) !== null) {
      if (!ALWAYS_BOUND.has(m[1])) vars.push(m[1]);
    }
    if (vars.length > 0) entry.readLines.push({ text: l.text, vars });
  }

  const newVars = new Set();
  for (const { readLines, lines } of byFile.values()) {
    // Occurrence-level, not var-level: each added read must be defensive on its
    // own. A var handled on one line does not excuse a bare read of the same
    // var on another — that bare read is exactly the silent-undefined bug this
    // rule exists to catch.
    for (const { text, vars } of readLines) {
      for (const v of vars) {
        const handled = hasDefensiveDefault(text, v) || hasGuardedBinding(lines, v);
        if (!handled) newVars.add(v);
      }
    }
  }
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
