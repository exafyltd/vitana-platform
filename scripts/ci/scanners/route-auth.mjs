/**
 * route-auth-scanner-v1 (v2: mount-layer tracing + heuristic fallback + rollup)
 *
 * Walks services/gateway/src/routes/ and flags router handlers whose chain
 * doesn't include an auth middleware. Three detection layers, cheapest
 * first:
 *
 *   1. Named-middleware match — exact match against the curated AUTH_NAMES
 *      set (requireAuth, requireTenantAdmin, requireDevRole, requireIngestAuth,
 *      requireAdminAuth, etc.).
 *   2. Heuristic regex — catches project-specific naming (requireFoo,
 *      fooAuth, verifyToken, checkAuth) without needing to enumerate every
 *      variant. False-positive rate is low because route-middleware naming
 *      in this codebase is consistent.
 *   3. Mount-layer tracing — parses services/gateway/src/index.ts, resolves
 *      routers back to their source files via imports, and marks files
 *      that are mount-protected so per-handler analysis skips them.
 *
 * Opt-out sentinel: `// public-route` on the line above a handler (or at
 * the top of the file as the first line) explicitly marks a public handler.
 *
 * Rollup emission: when ≥ROLLUP_THRESHOLD real findings remain after
 * filtering, emit ONE summary finding listing every file instead of one
 * finding per file. Same class of fix belongs in one PR, not N.
 */

import fs from 'node:fs';
import path from 'node:path';
import { walk, readFileSafe, relFromRepo } from './_shared.mjs';

export const meta = {
  scanner: 'route-auth-scanner-v1',
  signal_type: 'missing_auth',
};

// Curated allowlist — projects' actual auth middleware names. Sources:
//   grep -rhEo 'router\.(get|post|...)\([^,]+,\s*([a-zA-Z_]+)' services/gateway/src/routes
//   + git log naming conventions.
const KNOWN_AUTH_NAMES = new Set([
  'requireAuth',
  'requireAdmin',
  'requireAdminAuth',
  'requireDevRole',
  'requirePlatformAdmin',
  'requireTenantAdmin',
  'requireTenant',
  'requireServiceRole',
  'requireApiKey',
  'requireScanToken',
  'requireIngestAuth',
  'optionalAuth',
  'requireAuthOptional',
]);

// Heuristic fallback — catches project-specific auth middleware names that
// aren't in the curated set. Matches `require<CapitalLetter>Name`,
// `*Auth[|orize|entication]`, `verifyAuth|Token|Session|Jwt|Bearer`,
// `checkAuth`, `assertAuth`. Low false-positive rate; operators can add
// `// public-route` to silence any wrongly-matched handler.
const AUTH_NAME_HEURISTIC = /\b(?:require[A-Z][A-Za-z0-9]*|[a-zA-Z]*[Aa]uth(?:orize|orization|enticated|entication)?\b|verify(?:Auth|Token|Session|Jwt|Bearer)|checkAuth|assertAuth)\b/;

const ROUTE_RE = /router\.(get|post|put|patch|delete|use)\s*\(/g;
const ROLLUP_THRESHOLD = 5;

function hasAuthInArgs(args) {
  for (const n of KNOWN_AUTH_NAMES) {
    if (new RegExp(`\\b${n}\\b`).test(args)) return true;
  }
  return AUTH_NAME_HEURISTIC.test(args);
}

function extractHandlerArgs(src, callStart) {
  const openParen = src.indexOf('(', callStart);
  if (openParen < 0) return null;
  let depth = 1;
  let i = openParen + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '"' || c === "'" || c === '`') {
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
  const lineStart = src.lastIndexOf('\n', callStart) + 1;
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

/**
 * Mount-layer tracing. Parses services/gateway/src/index.ts, finds every
 * mountRouterSync / app.use call that binds a router variable to a path,
 * resolves the variable back to its source file via imports, and marks
 * that file as mount-protected if any auth middleware appears in the
 * mount call's middleware chain.
 *
 * Returns a Set of repo-relative file paths (e.g. "services/gateway/src/routes/foo.ts")
 * that the per-handler scanner should skip entirely.
 */
function collectMountProtected(repoRoot) {
  const idxPath = path.join(repoRoot, 'services', 'gateway', 'src', 'index.ts');
  const src = readFileSafe(idxPath);
  const out = new Set();
  if (!src) return out;

  // Step 1: build routerVariable → import-spec map.
  const importMap = new Map();
  for (const m of src.matchAll(/import\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+from\s+['"]([^'"]+)['"]/g)) {
    importMap.set(m[1], m[2]);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*require\(['"]([^'"]+)['"]\)/g)) {
    importMap.set(m[1], m[2]);
  }

  // Step 2: normalize import specifier to repo-relative path.
  const idxDir = path.dirname(idxPath);
  function resolveToRepoRel(importSpec) {
    if (!importSpec.startsWith('.')) return null;
    const abs = path.resolve(idxDir, importSpec);
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
      if (fs.existsSync(abs + ext)) return relFromRepo(repoRoot, abs + ext);
    }
    for (const suffix of ['/index.ts', '/index.tsx', '/index.js']) {
      if (fs.existsSync(abs + suffix)) return relFromRepo(repoRoot, abs + suffix);
    }
    return null;
  }

  // Step 3: scan mount calls for auth middleware preceding the router variable.
  // Covers:
  //   app.use('/path', middleware1, middleware2, routerVariable)
  //   app.use('/path', routerVariable)
  //   mountRouterSync(app, '/path', routerVariable, { owner: 'x' })
  const mountCallPatterns = [
    /\bapp\.use\s*\(([\s\S]*?)\)/g,
    /\bmountRouterSync\s*\(([\s\S]*?)\)/g,
  ];
  for (const pattern of mountCallPatterns) {
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(src)) !== null) {
      const args = m[1];
      const referencedRouters = [];
      for (const [varName, importSpec] of importMap) {
        if (new RegExp(`\\b${varName}\\b`).test(args)) {
          referencedRouters.push({ varName, importSpec });
        }
      }
      if (referencedRouters.length === 0) continue;
      if (!hasAuthInArgs(args)) continue;
      for (const r of referencedRouters) {
        const rel = resolveToRepoRel(r.importSpec);
        if (rel) out.add(rel);
      }
    }
  }

  return out;
}

export async function run({ repoRoot }) {
  const routesDir = path.join(repoRoot, 'services', 'gateway', 'src', 'routes');
  if (!fs.existsSync(routesDir)) return [];
  const files = walk(routesDir).filter(f => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\./.test(f));

  const mountProtected = collectMountProtected(repoRoot);
  const unauthedFiles = []; // Array of { file, handlers, firstLine }

  for (const file of files) {
    const src = readFileSafe(file);
    if (!src) continue;

    const rel = relFromRepo(repoRoot, file);
    if (mountProtected.has(rel)) continue;

    // File-level auth at the top of the router?
    if (/router\.use\(\s*(?:requireAuth|requireAdmin|requireAdminAuth|requireDevRole|requirePlatformAdmin|requireTenantAdmin|requireTenant|requireServiceRole|requireApiKey|requireScanToken|requireIngestAuth|optionalAuth|requireAuthOptional)\b/.test(src)) continue;
    // Heuristic fallback for file-level auth
    if (/router\.use\([^)]*(?:require[A-Z][A-Za-z0-9]*|verifyAuth|verifyToken|verifySession|checkAuth|assertAuth)/.test(src)) continue;
    // File-level public-route sentinel (whole file is intentionally public)
    if (/^\s*\/\/\s*public-route\b/m.test(src.split('\n').slice(0, 6).join('\n'))) continue;

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
      if (hasAuthInArgs(args)) continue;
      const pathMatch = /^\s*[`'"]([^`'"]+)[`'"]/.exec(args);
      const routePath = pathMatch ? pathMatch[1] : '(unknown path)';
      const lineNumber = src.slice(0, callStart).split('\n').length;
      unauthed.push({ method: method.toUpperCase(), route: routePath, line: lineNumber });
    }
    if (unauthed.length === 0) continue;

    unauthedFiles.push({ file: rel, handlers: unauthed, firstLine: unauthed[0].line });
  }

  if (unauthedFiles.length === 0) return [];

  // ROLLUP — when enough files share the same fix class, emit ONE finding
  // that batches them. Operators fix the whole class in one PR instead of N.
  if (unauthedFiles.length >= ROLLUP_THRESHOLD) {
    const total = unauthedFiles.length;
    const totalHandlers = unauthedFiles.reduce((s, f) => s + f.handlers.length, 0);
    const preview = unauthedFiles.slice(0, 6).map(f => f.file).join(', ');
    const moreNote = total > 6 ? ` (+${total - 6} more)` : '';
    return [{
      type: 'missing_auth',
      severity: 'high',
      file_path: unauthedFiles[0].file,
      line_number: unauthedFiles[0].firstLine,
      message: `${total} route files have handlers without auth middleware (${totalHandlers} handlers total). Files: ${preview}${moreNote}.`,
      suggested_action: `Either (a) add an auth middleware to the mount call in services/gateway/src/index.ts (one line per router — covers all handlers in that file), OR (b) add \`router.use(requireAuth)\` (or the right variant — requireTenantAdmin, requireDevRole, etc.) at the top of each file. For intentionally public handlers, add \`// public-route\` on the line above. See raw.affected_files for the full list.`,
      scanner: 'route-auth-scanner-v1',
      raw: {
        rollup: true,
        total_files: total,
        total_unauthed_handlers: totalHandlers,
        affected_files: unauthedFiles.map(f => ({ file: f.file, handler_count: f.handlers.length, handlers: f.handlers })),
      },
    }];
  }

  // Under threshold — emit per-file findings.
  return unauthedFiles.map(f => {
    const preview = f.handlers.slice(0, 5).map(h => `${h.method} ${h.route}`).join(', ');
    const moreNote = f.handlers.length > 5 ? ` (+${f.handlers.length - 5} more)` : '';
    return {
      type: 'missing_auth',
      severity: 'high',
      file_path: f.file,
      line_number: f.firstLine,
      message: `${f.file} has ${f.handlers.length} handler(s) with no auth middleware: ${preview}${moreNote}.`,
      suggested_action: `Add per-handler auth (requireAuth / requireAdmin / requireDevRole / requireTenant / requireTenantAdmin) OR add \`router.use(...)\` at the top of the file for file-level auth. For intentionally public handlers, add \`// public-route\` above the line.`,
      scanner: 'route-auth-scanner-v1',
      raw: { handlers: f.handlers, count: f.handlers.length },
    };
  });
}
