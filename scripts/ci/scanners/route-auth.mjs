/**
 * route-auth-scanner-v1
 *
 * Walks services/gateway/src/routes/ and flags any router.{get,post,put,patch,delete}
 * whose handler chain doesn't include an auth middleware. Middleware names we
 * recognise as auth: requireAuth, requireAdmin, requireDevRole, requirePlatformAdmin,
 * optionalAuth, requireTenant, requireAuthOptional.
 *
 * Opt-out: a handler preceded by `// public-route` (or `// public` on the line
 * itself) is skipped. For routes that are truly public (e.g. /alive, /public/*)
 * this sentinel keeps the scanner from nagging forever.
 *
 * Heuristic — produces false positives for routers that apply middleware at
 * the app-mount level rather than per-handler. We accept that tradeoff; a
 * reviewer can add `// public-route` or refactor to per-handler auth.
 */

import fs from 'node:fs';
import path from 'node:path';
import { walk, readFileSafe, relFromRepo } from './_shared.mjs';

export const meta = {
  scanner: 'route-auth-scanner-v1',
  signal_type: 'missing_auth',
};

const AUTH_NAMES = new Set([
  'requireAuth', 'requireAdmin', 'requireDevRole', 'requirePlatformAdmin',
  'optionalAuth', 'requireTenant', 'requireAuthOptional', 'requireServiceRole',
  'requireApiKey', 'requireScanToken',
]);

const ROUTE_RE = /router\.(get|post|put|patch|delete|use)\s*\(/g;

function extractHandlerArgs(src, callStart) {
  // callStart is the offset of `router.METHOD(`. Walk forward collecting args
  // at depth 0 until the matching `)`. Returns the raw string between the
  // outer parens.
  const openParen = src.indexOf('(', callStart);
  if (openParen < 0) return null;
  let depth = 1;
  let i = openParen + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '"' || c === "'" || c === '`') {
      // Skip to end of string literal (naive — no escape handling beyond \)
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    }
    if (depth === 0) return src.slice(openParen + 1, i);
    i++;
  }
  return null;
}

function hasPublicSentinel(src, callStart) {
  // Look back up to 5 lines before the call for a `// public-route` or `// public` comment.
  const lineStart = src.lastIndexOf('\n', callStart) + 1;
  const windowStart = src.lastIndexOf('\n', Math.max(0, lineStart - 1));
  const lookBack = 5;
  let back = lineStart;
  for (let i = 0; i < lookBack; i++) {
    const prev = src.lastIndexOf('\n', back - 2);
    const line = src.slice(prev + 1, back);
    if (/\/\/\s*public[-\s]?route\b/i.test(line)) return true;
    if (prev < 0) break;
    back = prev + 1;
  }
  return false;
}

export async function run({ repoRoot }) {
  const routesDir = path.join(repoRoot, 'services', 'gateway', 'src', 'routes');
  if (!fs.existsSync(routesDir)) return [];
  const files = walk(routesDir).filter(f => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\./.test(f));

  const signals = [];
  for (const file of files) {
    const src = readFileSafe(file);
    if (!src) continue;
    // File-level auth: if the router applies an auth middleware once at the top
    // (e.g. `router.use(requireAuth)` or `router.use(requireAdmin)`), every
    // handler below inherits it. Skip the whole file in that case.
    const fileLevelAuth = /router\.use\(\s*(?:requireAuth|requireAdmin|requireDevRole|requirePlatformAdmin|requireTenant|requireServiceRole|requireApiKey|requireScanToken)\b/.test(src);
    if (fileLevelAuth) continue;

    // Bundle all unauthenticated handlers in a file into ONE signal. A full
    // route file without auth is a single unit of work for the autopilot;
    // flagging each handler separately explodes the queue without adding
    // signal.
    const unauthed = [];
    let m;
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src)) !== null) {
      const method = m[1];
      if (method === 'use') continue;
      const callStart = m.index;
      if (hasPublicSentinel(src, callStart)) continue;
      const args = extractHandlerArgs(src, callStart);
      if (!args) continue;
      const hasAuth = Array.from(AUTH_NAMES).some(n => new RegExp(`\\b${n}\\b`).test(args));
      if (hasAuth) continue;
      const pathMatch = /^\s*[`'"]([^`'"]+)[`'"]/.exec(args);
      const routePath = pathMatch ? pathMatch[1] : '(unknown path)';
      const lineNumber = src.slice(0, callStart).split('\n').length;
      unauthed.push({ method: method.toUpperCase(), route: routePath, line: lineNumber });
    }
    if (unauthed.length === 0) continue;

    const rel = relFromRepo(repoRoot, file);
    const preview = unauthed.slice(0, 5).map(u => `${u.method} ${u.route}`).join(', ');
    const moreNote = unauthed.length > 5 ? ` (+${unauthed.length - 5} more)` : '';
    signals.push({
      type: 'missing_auth',
      severity: 'high',
      file_path: rel,
      line_number: unauthed[0].line,
      message: `${rel} has ${unauthed.length} handler(s) with no auth middleware: ${preview}${moreNote}.`,
      suggested_action: `Add per-handler auth (requireAuth / requireAdmin / requireDevRole / requireTenant) OR add \`router.use(requireXxx)\` at the top of the file for file-level auth. For intentionally public handlers, add \`// public-route\` above the line.`,
      scanner: 'route-auth-scanner-v1',
      raw: { handlers: unauthed, count: unauthed.length },
    });
  }
  return signals;
}
