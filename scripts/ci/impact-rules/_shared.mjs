/**
 * Shared helpers for Dev Autopilot impact rules.
 *
 * Impact rules are **diff-aware**: they get the PR's git diff (between base
 * and HEAD) as input and look for companion/conflict/pattern issues.
 *
 * Rule module contract:
 *   export const meta = {
 *     rule: 'kebab-case-id',         // unique, matches dev_autopilot_impact_rules.rule
 *     title: 'Short human title',
 *     description: 'What the rule checks, in one paragraph.',
 *     category: 'companion' | 'conflict' | 'semantic',
 *     severity: 'blocker' | 'warning' | 'info',
 *     enabled: true | false,
 *   };
 *   export async function check(ctx) -> ImpactFinding[];
 *
 * ctx shape:
 *   {
 *     diff:          string,           // full unified diff (git diff --unified=3 base...HEAD)
 *     changedFiles:  ChangedFile[],    // [{ path, status: 'A'|'M'|'D' }]
 *     byCategory:    Record<Category, string[]>, // classified paths
 *     repoRoot:      string,           // absolute path
 *     baseRef:       string,           // e.g. 'origin/main'
 *   }
 *
 * ImpactFinding shape:
 *   {
 *     rule:         string,           // meta.rule
 *     severity:     'blocker' | 'warning' | 'info',
 *     file_path:    string | null,    // closest file the finding is about, for context
 *     line_number:  number | null,
 *     message:      string,           // short, actionable
 *     suggested_action: string,       // what to do
 *     raw?:         Record<string, unknown>,
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';

export const FILE_CATEGORIES = [
  'migrations', 'routes', 'services', 'scanners', 'impactRules',
  'tests', 'workflows', 'types', 'frontend', 'docs', 'config',
  'worker', 'other',
];

export function classifyPath(p) {
  if (/^supabase\/migrations\//.test(p)) return 'migrations';
  if (/^scripts\/ci\/scanners\//.test(p)) return 'scanners';
  if (/^scripts\/ci\/impact-rules\//.test(p)) return 'impactRules';
  if (/^\.github\/workflows\//.test(p)) return 'workflows';
  if (/^services\/gateway\/src\/frontend\//.test(p)) return 'frontend';
  if (/^services\/gateway\/src\/routes\//.test(p)) return 'routes';
  if (/^services\/gateway\/src\/services\//.test(p)) return 'services';
  if (/^services\/gateway\/src\/types\//.test(p)) return 'types';
  if (/^services\/gateway\/(test|tests)\//.test(p)) return 'tests';
  if (/^services\/autopilot-worker\//.test(p)) return 'worker';
  if (/\.test\.(ts|tsx|js|mjs)$/.test(p) || /\.spec\.(ts|tsx|js|mjs)$/.test(p)) return 'tests';
  if (/\.(md|mdx)$/.test(p)) return 'docs';
  if (/\.(yml|yaml|json|toml|env)$/.test(p)) return 'config';
  return 'other';
}

export function groupByCategory(changedFiles) {
  const out = Object.fromEntries(FILE_CATEGORIES.map(c => [c, []]));
  for (const f of changedFiles) {
    out[classifyPath(f.path)].push(f.path);
  }
  return out;
}

export function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch { return null; }
}

export function readFileAtRepo(repoRoot, rel) {
  return readFileSafe(path.join(repoRoot, rel));
}

/**
 * Return lines that were ADDED in the diff (prefixed with `+`, excluding
 * the `+++` file header). Useful for rules that want to check what's new,
 * not what moved.
 */
export function extractAddedLines(diff, matchPathRegex) {
  const lines = diff.split('\n');
  const out = [];
  let currentFile = null;
  let inAddedBlock = false;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = /b\/(.+)$/.exec(line);
      currentFile = m ? m[1] : null;
      continue;
    }
    if (line.startsWith('+++')) continue;
    if (line.startsWith('---')) continue;
    if (!currentFile) continue;
    if (matchPathRegex && !matchPathRegex.test(currentFile)) continue;
    if (line.startsWith('+')) {
      out.push({ file: currentFile, text: line.slice(1) });
    }
  }
  return out;
}

export function fileExists(repoRoot, rel) {
  return fs.existsSync(path.join(repoRoot, rel));
}
