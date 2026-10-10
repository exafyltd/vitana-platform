// VTID-04948/04950 — PR-GATE shared helpers (vitana-platform copy of vitana-v1's;
// only ALWAYS_ALLOWED differs). Pure functions are exported for the
// node:test suite in ./__tests__; git helpers shell out and are kept thin.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_PATH = 'scripts/ci/pr-gate/config.json';

export function loadConfig(root = '.') {
  const p = join(root, CONFIG_PATH);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { enforce: false };
}

export function vtidsFromTitle(title) {
  return [...new Set(String(title || '').match(/VTID-\d{4,5}/g) || [])];
}

// Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}

// Files any VTID may touch without declaring them (plan B1 + F14).
export const ALWAYS_ALLOWED = [
  // vitana-platform copy (VTID-04950): lockfiles, the built gateway bundle the
  // Command Hub golden-fingerprint guard requires next to src, generated docs.
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'services/gateway/package.json',
  'services/gateway/package-lock.json',
  'services/gateway/dist/**',
  'docs/SCREEN_INVENTORY.md',
]

export function allowedForVtids(vtids) {
  return [...ALWAYS_ALLOWED, ...vtids.map((v) => `docs/validation/${v}/**`)];
}

/**
 * Scope decision. `scopes` = parsed scope.json objects (one per VTID).
 * `botOnly` = files touched only by bot-authored commits (exempt).
 */
export function evaluateScope({ vtids, scopes, changed, botOnly = [] }) {
  if (vtids.length === 0) return { ok: true, skipped: 'no VTID in the PR title', outside: [] };
  const missing = vtids.filter((v) => !scopes[v]);
  if (missing.length) return { ok: false, missing, outside: [] };
  const globs = [...allowedForVtids(vtids), ...vtids.flatMap((v) => scopes[v].paths || [])];
  const bot = new Set(botOnly);
  const outside = changed.filter((f) => !bot.has(f) && !matchesAny(f, globs));
  return { ok: outside.length === 0, outside, missing: [] };
}

export function validateScope(obj, vtid) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return ['not an object'];
  if (obj.vtid !== vtid) errors.push(`vtid must be "${vtid}"`);
  if (!['fix', 'feature', 'refactor', 'infra', 'docs'].includes(obj.kind)) errors.push('kind must be fix|feature|refactor|infra|docs');
  if (!Array.isArray(obj.paths) || obj.paths.length === 0 || obj.paths.some((p) => typeof p !== 'string' || !p)) errors.push('paths must be a non-empty array of globs');
  for (const k of ['weakens_tests', 'red_green_exempt']) {
    const a = obj[k];
    if (a === undefined) continue;
    if (!Array.isArray(a) || a.some((e) => !e || typeof e.file !== 'string' || typeof e.reason !== 'string' || e.reason.length < 10)) {
      errors.push(`${k} must be [{file, reason (>=10 chars)}]`);
    }
  }
  if (obj.non_transactional !== undefined && (!Array.isArray(obj.non_transactional) || obj.non_transactional.some((f) => typeof f !== 'string'))) {
    errors.push('non_transactional must be an array of file paths');
  }
  return errors;
}

// ── Ratchet ──────────────────────────────────────────────────────────────
export function countTsc(output) {
  const counts = {};
  for (const line of String(output).split('\n')) {
    const m = line.match(/^(.+?)\(\d+,\d+\): error TS\d+/);
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}

export function countEslint(results, root) {
  const counts = {};
  const prefix = root.endsWith('/') ? root : `${root}/`;
  for (const r of results) {
    if (!r.errorCount) continue;
    const f = r.filePath.startsWith(prefix) ? r.filePath.slice(prefix.length) : r.filePath;
    counts[f] = r.errorCount;
  }
  return counts;
}

/** Fails when any file has more errors than its baseline (new files: baseline 0). */
export function compareRatchet(baseline, current) {
  const worse = [];
  const better = [];
  for (const [f, n] of Object.entries(current)) {
    const b = baseline[f] || 0;
    if (n > b) worse.push({ file: f, baseline: b, now: n });
    else if (n < b) better.push({ file: f, baseline: b, now: n });
  }
  for (const [f, b] of Object.entries(baseline)) if (!(f in current)) better.push({ file: f, baseline: b, now: 0 });
  return { ok: worse.length === 0, worse, better };
}

// ── Test weakening ───────────────────────────────────────────────────────
export const TEST_FILE = /(\.test\.(ts|tsx|js|mjs|cjs)|\.spec\.(ts|tsx)|-regression\.mjs)$/;

export function testStats(src) {
  const s = String(src || '');
  return {
    cases: (s.match(/(^|[^.\w])(it|test)(\.(skip|only|todo|concurrent)|\.each\([^)]*\))?\s*\(/g) || []).length,
    expects: (s.match(/\bexpect(\.soft)?\s*\(/g) || []).length,
    skips: (s.match(/\b(it|test|describe)\.(skip|only|todo)\s*\(|\bx(it|describe)\s*\(/g) || []).length,
  };
}

export function evaluateWeakening({ files, exempt = [] }) {
  // files: [{file, base: string|null, head: string|null}]
  const ex = new Set(exempt.map((e) => e.file));
  const findings = [];
  for (const { file, base, head } of files) {
    if (base == null) continue; // new test file
    if (head == null) { findings.push({ file, why: 'test file deleted' }); continue; }
    const b = testStats(base);
    const h = testStats(head);
    if (h.skips > b.skips) findings.push({ file, why: `.skip/.only/.todo added (${b.skips} → ${h.skips})` });
    if (h.cases < b.cases) findings.push({ file, why: `test cases dropped (${b.cases} → ${h.cases})` });
    else if (h.cases === b.cases && h.expects < b.expects) findings.push({ file, why: `assertions dropped (${b.expects} → ${h.expects})` });
  }
  const blocking = findings.filter((f) => !ex.has(f.file));
  return { ok: blocking.length === 0, findings, blocking };
}

// ── Sparring record ──────────────────────────────────────────────────────
export function evaluateSparringRecord(text) {
  const t = String(text || '');
  const problems = [];
  if (!/\b(CONVERGED|ESCALATED)\b/.test(t)) problems.push('no verdict (CONVERGED / ESCALATED)');
  if (!/owner approval/i.test(t)) problems.push('no owner-approval line');
  if (!/plan hash/i.test(t)) problems.push('no plan hash');
  return problems;
}

// ── Migrations (plan D2, used from Phase 3) ──────────────────────────────
const NON_TX = /\bCREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b|\bALTER\s+TYPE\b[^;]*\bADD\s+VALUE\b|\bVACUUM\b|\bCREATE\s+DATABASE\b/i;
const NON_IDEMPOTENT = [
  /\bCREATE\s+TABLE\s+(?!\s|IF\s+NOT\s+EXISTS)/i,
  /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!\s|IF\s+NOT\s+EXISTS|CONCURRENTLY)/i,
  /\bCREATE\s+FUNCTION\b/i,
  /\bCREATE\s+VIEW\b/i,
  /\bCREATE\s+SCHEMA\s+(?!\s|IF\s+NOT\s+EXISTS)/i,
  /\bDROP\s+(TABLE|INDEX|FUNCTION|VIEW|TRIGGER|POLICY|TYPE|SCHEMA)\s+(?!\s|IF\s+EXISTS)/i,
  /\bADD\s+COLUMN\s+(?!\s|IF\s+NOT\s+EXISTS)/i,
];

function stripSqlComments(sql) {
  return String(sql).replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Removes $tag$…$tag$ bodies so statements inside functions/DO blocks are not linted as top level.
function stripDollarBodies(sql) {
  return sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
}

export function lintMigration(sql, { nonTransactional = false } = {}) {
  const problems = [];
  const code = stripDollarBodies(stripSqlComments(sql)).trim();
  const wrapped = /^BEGIN\s*;/i.test(code) && /COMMIT\s*;\s*$/i.test(code);
  const needsNonTx = NON_TX.test(code);
  if (needsNonTx && !nonTransactional) problems.push('non-transactional statement (CONCURRENTLY / ALTER TYPE … ADD VALUE / VACUUM) — declare the file in scope.json "non_transactional"');
  if (nonTransactional && wrapped) problems.push('declared non_transactional but wrapped in BEGIN/COMMIT — remove the wrapper');
  if (!nonTransactional && !wrapped) problems.push('must be wrapped in a single BEGIN; … COMMIT;');
  for (const re of NON_IDEMPOTENT) {
    const m = code.match(re);
    if (m) problems.push(`not idempotent: "${m[0].trim()}" — use IF [NOT] EXISTS / CREATE OR REPLACE`);
  }
  return problems;
}

// ── git ──────────────────────────────────────────────────────────────────
export function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

export function changedFiles(base, head) {
  return git(['diff', '--name-only', '--diff-filter=ACMRD', `${base}...${head}`]).split('\n').filter(Boolean);
}

export function showFile(rev, file) {
  try {
    return git(['show', `${rev}:${file}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const BOT = /\[bot\]$|^github-actions$/;

/** Files whose every touching commit in base..head is bot-authored. */
export function botOnlyFiles(base, head) {
  const log = git(['log', '--format=@@%an', '--name-only', `${base}..${head}`]);
  const human = new Set();
  const bot = new Set();
  let isBot = false;
  for (const line of log.split('\n')) {
    if (line.startsWith('@@')) { isBot = BOT.test(line.slice(2)); continue; }
    if (!line.trim()) continue;
    (isBot ? bot : human).add(line.trim());
  }
  return [...bot].filter((f) => !human.has(f));
}

export function summary(md) {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (p) execFileSync('bash', ['-c', 'cat >> "$P"'], { input: `${md}\n`, env: { ...process.env, P: p } });
  else process.stdout.write(`${md}\n`);
}

// ── Migration dry run (plan D2 as re-sparred in round 4) ─────────────────
// The repo's migration history cannot be replayed (duplicate creates, objects
// owned by vitana-platform), so a changed migration is applied alone onto the
// Supabase stub inside a transaction that is always rolled back. A missing
// object only proves the stub lacks it: that is "unverifiable", not a failure.
export const UNVERIFIABLE_SQLSTATES = new Set(['42P01', '42883', '42704', '3F000', '42703', '42P07']);

/** The file's statements with its own outer BEGIN;/COMMIT; removed, wrapped to always roll back. */
export function dryRunScript(sql) {
  const body = String(sql).replace(/^\s*BEGIN\s*;/i, '').replace(/COMMIT\s*;\s*$/i, '');
  return `\\set ON_ERROR_STOP on\n\\set VERBOSITY verbose\nBEGIN;\n${body}\nROLLBACK;\n`;
}

/** Classify psql output from a failed dry run. */
export function classifyDryRun(output) {
  const m = String(output).match(/ERROR:\s+([0-9A-Z]{5}):\s*([^\n]*)/);
  if (!m) return { verdict: 'failed', sqlstate: null, message: String(output).trim().split('\n').slice(-3).join(' ') };
  const [, sqlstate, message] = m;
  // 42P07 (duplicate) only counts as unverifiable when the stub itself provides the object.
  if (sqlstate === '42P07') return { verdict: 'failed', sqlstate, message };
  return { verdict: UNVERIFIABLE_SQLSTATES.has(sqlstate) ? 'unverifiable' : 'failed', sqlstate, message };
}
