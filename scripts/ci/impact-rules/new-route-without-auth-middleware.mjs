/**
 * new-route-without-auth-middleware
 *
 * Diff-aware version of route-auth-scanner-v1: checks ONLY the new handlers
 * added in this PR, not the baseline. Prevents regressions without
 * re-flagging long-standing gaps.
 *
 * Heuristic: a handler added in this PR (`router.METHOD(...)` appearing in
 * the diff as an added line) that doesn't reference any known auth
 * middleware in its argument chain. File-level `router.use(requireXxx)`
 * at the top of the file is honored, matching the baseline scanner's
 * semantics.
 */

import { extractAddedLines, readFileAtRepo } from './_shared.mjs';

export const meta = {
  rule: 'new-route-without-auth-middleware',
  category: 'semantic',
  severity: 'warning',
};

const AUTH_NAMES = [
  'requireAuth', 'requireAdmin', 'requireDevRole', 'requirePlatformAdmin',
  'optionalAuth', 'requireTenant', 'requireAuthOptional', 'requireServiceRole',
  'requireApiKey', 'requireScanToken',
];
const ROUTE_PREFIX_RE = /^\s*router\.(get|post|put|patch|delete)\s*\(/;

export async function check({ diff, repoRoot }) {
  const added = extractAddedLines(diff, /^services\/gateway\/src\/routes\/.+\.(ts|tsx)$/);
  const byFile = new Map();
  for (const l of added) {
    if (!ROUTE_PREFIX_RE.test(l.text)) continue;
    if (!byFile.has(l.file)) byFile.set(l.file, []);
    byFile.get(l.file).push(l.text);
  }
  if (byFile.size === 0) return [];

  const findings = [];
  for (const [file, lines] of byFile) {
    const src = readFileAtRepo(repoRoot, file);
    if (!src) continue;
    // File-level auth short-circuit — mirrors baseline scanner.
    const fileLevelAuth = new RegExp(`router\\.use\\(\\s*(?:${AUTH_NAMES.join('|')})\\b`).test(src);
    if (fileLevelAuth) continue;
    // Line-level: added handler that DOES include an auth name is fine.
    const authRe = new RegExp(`\\b(?:${AUTH_NAMES.join('|')})\\b`);
    const unauthedLines = lines.filter(t => !authRe.test(t));
    if (unauthedLines.length === 0) continue;
    // Public-route sentinel on the added line itself
    const trulyUnauth = unauthedLines.filter(t => !/\/\/\s*public[-\s]?route\b/i.test(t));
    if (trulyUnauth.length === 0) continue;

    findings.push({
      rule: meta.rule,
      severity: meta.severity,
      file_path: file,
      line_number: null,
      message: `${file} has ${trulyUnauth.length} newly-added handler(s) without auth middleware and no file-level router.use(requireXxx).`,
      suggested_action: `For each new handler, either wrap with requireAuth / requireAdmin / requireDevRole / requireTenant, apply \`router.use(requireXxx)\` at the top of the file, or add \`// public-route\` above the line if the handler is intentionally anonymous.`,
      raw: { handler_count: trulyUnauth.length },
    });
  }
  return findings;
}
