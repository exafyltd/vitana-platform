/**
 * dead-code-scanner-v1
 *
 * Hand-rolled symbol-graph over services/gateway/src:
 *   1. Scan every .ts/.tsx file, collect `export const|function|class|interface|type|enum X`.
 *   2. For each exported symbol X, grep the rest of the codebase for
 *      `\bX\b` appearing in an import, type annotation, or call site.
 *   3. Flag exports referenced ONLY by their own file.
 *
 * Marked `alpha` in the registry because this heuristic has known false
 * positives: dynamic imports, symbols referenced via string/template
 * literals, and re-exports that route usage around the direct import.
 * Humans should review before auto-approving these.
 *
 * Performance: ~2 seconds on the current gateway codebase. We short-circuit
 * when any cross-file reference is found, so the worst case is when an
 * export is truly unused (we have to scan every file once).
 */

import fs from 'node:fs';
import path from 'node:path';
import { walk, readFileSafe, relFromRepo } from './_shared.mjs';

export const meta = {
  scanner: 'dead-code-scanner-v1',
  signal_type: 'dead_code',
};

// Names we refuse to flag — these are typically dynamic or framework-discovered.
const NEVER_FLAG = new Set([
  'default', 'router', 'app', 'handler',
  // Express conventions
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH',
  // Common test/stub/factory names that tests dynamically reference
  'createApp', 'buildApp',
]);

const EXPORT_RE = /^\s*export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

// VTID-04291: the `// @public-api` escape hatch this scanner's own
// `suggested_action` tells humans to use — implemented here, because until
// now the advice pointed at a mechanism that did not exist in this file:
// annotating an export changed nothing and the identical finding came back
// on the next scan. It exists for exports that ARE reached, just not in a
// way a literal symbol grep can see — a barrel/namespace import
// (`repo.fetchX(...)`, `import * as repo from './x-repository'`), a dynamic
// dispatch, or a deliberate seam for a not-yet-landed workstream.
const PUBLIC_API_MARKER_RE = /@public-api\b/;

/**
 * Walks up from a 1-based declaration line over the CONTIGUOUS comment block
 * immediately above it and reports whether that block carries an
 * `@public-api` marker. A blank line or any non-comment line ends the walk —
 * deliberately, so an annotation on one export can never leak onto the next
 * export below it (e.g. `// @public-api` above `foo()` must not also silence
 * `bar()` two lines later).
 */
function isPublicApiAnnotated(lines, declLine) {
  for (let i = declLine - 2; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '') return false;
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
    if (!isComment) return false;
    if (PUBLIC_API_MARKER_RE.test(trimmed)) return true;
  }
  return false;
}

function collectExports(file, src) {
  const out = [];
  const lines = src.split('\n');
  let m;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(src)) !== null) {
    const name = m[1];
    if (NEVER_FLAG.has(name)) continue;
    if (name.startsWith('_')) continue; // convention: _-prefixed = internal
    const line = src.slice(0, m.index).split('\n').length;
    if (isPublicApiAnnotated(lines, line)) continue;
    out.push({ name, line });
  }
  return out;
}

export async function run({ repoRoot }) {
  const root = path.join(repoRoot, 'services', 'gateway', 'src');
  if (!fs.existsSync(root)) return [];
  const files = walk(root).filter(f =>
    /\.(ts|tsx)$/.test(f)
    && !/\.(test|spec)\.(ts|tsx)$/.test(f)
    // Barrel files re-export across module boundaries. Their exports are
    // almost always reached via other barrels or dynamic imports — flagging
    // them produces pure noise. Skip them entirely.
    && !/\/index\.(ts|tsx)$/.test(f)
    && !/\/types\.(ts|tsx)$/.test(f)
  );

  // Read all files once — ~150-200 files, fits easily in memory.
  const srcByFile = new Map();
  for (const f of files) {
    const s = readFileSafe(f);
    if (s) srcByFile.set(f, s);
  }

  const signals = [];
  for (const file of files) {
    const src = srcByFile.get(file);
    if (!src) continue;
    const exportList = collectExports(file, src);
    if (exportList.length === 0) continue;

    // Bundle unreferenced exports per-file so a single file with 20 unused
    // exports shows up as one finding, not 20.
    const unused = [];
    for (const exp of exportList) {
      const re = new RegExp(`\\b${exp.name}\\b`);
      let referenced = false;
      for (const [otherFile, otherSrc] of srcByFile) {
        if (otherFile === file) continue;
        if (re.test(otherSrc)) { referenced = true; break; }
      }
      if (!referenced) unused.push(exp);
    }
    if (unused.length === 0) continue;
    const rel = relFromRepo(repoRoot, file);
    const preview = unused.slice(0, 4).map(u => u.name).join(', ');
    const moreNote = unused.length > 4 ? ` (+${unused.length - 4} more)` : '';
    signals.push({
      type: 'dead_code',
      severity: 'low',
      file_path: rel,
      line_number: unused[0].line,
      message: `${rel} has ${unused.length} export(s) with no cross-file reference: ${preview}${moreNote}.`,
      suggested_action: `Either remove these exports (making them file-local or deleting them) or, for each that's used dynamically/via strings, add \`// @public-api\` above its declaration to silence this scanner.`,
      scanner: 'dead-code-scanner-v1',
      raw: { symbols: unused.map(u => u.name), count: unused.length },
    });
  }
  return signals;
}
