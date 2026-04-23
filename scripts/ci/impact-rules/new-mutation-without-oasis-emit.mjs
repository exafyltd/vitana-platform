/**
 * new-mutation-without-oasis-emit
 *
 * CLAUDE.md invariant: "Always emit OASIS events for real state transitions."
 * This rule flags newly-added state-mutating handlers (POST/PUT/PATCH/DELETE)
 * in route files that do not call emitOasisEvent within the handler body.
 *
 * Logic:
 *   - Find route files touched by the PR.
 *   - Parse each such file's HEAD state; for every router.METHOD(path, ...)
 *     handler where METHOD ∈ {post,put,patch,delete}, extract the handler
 *     body block (between the first `=>` or `function () {` and its matching
 *     closing brace).
 *   - If the handler body doesn't contain emitOasisEvent, AND the handler's
 *     opening `router.METHOD(` line appears in the diff as an added line,
 *     flag it.
 *
 * Opt-out: add `// impact-allow-no-oasis` anywhere in the handler body.
 */

import { extractAddedLines, readFileAtRepo } from './_shared.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const meta = {
  rule: 'new-mutation-without-oasis-emit',
  category: 'semantic',
  severity: 'warning',
};

const MUTATION_METHODS = new Set(['post', 'put', 'patch', 'delete']);

function extractHandlerBody(src, callStart) {
  // Walk forward from `router.METHOD(` to the matching `)`, then find the
  // last `=>` or `function()` marker before it, capture the body between
  // the opening `{` and its matching `}`.
  const openParen = src.indexOf('(', callStart);
  if (openParen < 0) return null;
  let depth = 1;
  let i = openParen + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    }
    if (depth === 0) break;
    i++;
  }
  const callEnd = i;
  // Extract the argument region, find the LAST handler function.
  const args = src.slice(openParen + 1, callEnd);
  // The handler is the last arg — find the last `=>` and grab until the end.
  const arrow = args.lastIndexOf('=>');
  if (arrow >= 0) return args.slice(arrow + 2);
  const fnKeyword = args.lastIndexOf('function');
  if (fnKeyword >= 0) return args.slice(fnKeyword);
  return args;
}

export async function check({ diff, repoRoot }) {
  const added = extractAddedLines(diff, /^services\/gateway\/src\/routes\/.+\.(ts|tsx)$/);
  // Group the added lines by file and mark which files saw an added
  // router.METHOD(... where METHOD is a mutation.
  const byFile = new Map();
  for (const l of added) {
    for (const method of MUTATION_METHODS) {
      const re = new RegExp(`^\\s*router\\.${method}\\s*\\(`);
      if (re.test(l.text)) {
        if (!byFile.has(l.file)) byFile.set(l.file, []);
        byFile.get(l.file).push({ method: method.toUpperCase(), text: l.text });
      }
    }
  }
  if (byFile.size === 0) return [];

  const findings = [];
  for (const [file, mutations] of byFile) {
    // Read the HEAD file so we can inspect handler bodies.
    const src = readFileAtRepo(repoRoot, file);
    if (!src) continue;

    for (const m of mutations) {
      // Find the position of this added handler in the HEAD source.
      const methodRe = new RegExp(`router\\.${m.method.toLowerCase()}\\s*\\([^)]*`, 'g');
      let match;
      while ((match = methodRe.exec(src)) !== null) {
        // Match the first handler whose argument starts similarly to the added line.
        const addedPathMatch = /[`'"]([^`'"]+)[`'"]/.exec(m.text);
        const expectPath = addedPathMatch ? addedPathMatch[1] : null;
        const thisPath = /[`'"]([^`'"]+)[`'"]/.exec(match[0])?.[1] || null;
        if (expectPath && thisPath && expectPath !== thisPath) continue;
        const body = extractHandlerBody(src, match.index);
        if (!body) continue;
        if (/\/\/\s*impact-allow-no-oasis/i.test(body)) break;
        if (/\bemitOasisEvent\s*\(/.test(body)) break;
        const lineNumber = src.slice(0, match.index).split('\n').length;
        findings.push({
          rule: meta.rule,
          severity: meta.severity,
          file_path: file,
          line_number: lineNumber,
          message: `${file}:${lineNumber} added ${m.method} handler for \`${thisPath || '?'}\` but the handler body does not call emitOasisEvent.`,
          suggested_action: `Add an emitOasisEvent call inside the handler to record the state transition, or add \`// impact-allow-no-oasis\` inside the handler body if the operation truly has no state change worth recording (rare for mutations).`,
          raw: { method: m.method, route: thisPath },
        });
        break;
      }
    }
  }
  return findings;
}
