#!/usr/bin/env node
/**
 * T8 (VTID-04085): generate services/gateway/specs/command-hub-symbol-index.json
 * — a function-name -> line-range index for the large Command Hub frontend
 * scripts, so a session (or an agent, or a person) can jump straight to a
 * function instead of reading the whole file.
 *
 * app.js alone is 55K+ lines. Real cost measured live (VTID-04037's Run #6
 * transcript, CLAUDE.md CHANGE LOG): an agent spent ~40 of its 60 turns just
 * locating code in this file via repeated read_file/search_text calls before
 * a 2 MB read-size cap made even that fail outright (VTID-04042). An index
 * mapping every function to its exact line range turns "find
 * renderDevAutopilotStepsView" into one lookup instead of a multi-turn
 * search-and-scroll.
 *
 * Sources (every *.js file directly under command-hub/, the whole surface
 * this task named, not just app.js):
 *   app.js, orb-widget.js, command-hub-staging.js, intelligence-panels.js,
 *   orb-voice-bench.js, watcher.js, intent-engine.js, intelligence-cockpit-nav.js,
 *   intent-moderation.js, voice-budget.js, navigation-config.js
 *
 * Finds `[async ]function name(...)` declarations AT ANY NESTING DEPTH — not
 * just top level. A first version of this scanner jumped straight past a
 * matched function's whole body once it had computed that function's end
 * line, which silently skipped every nested helper defined inside it (e.g.
 * `installAuthFetchInterceptor`'s own `getActiveRole`/`getRefreshToken`/
 * `performRefresh`) — found by comparing against a naive whole-file grep of
 * unique `function name(` names, which returned MORE names than the
 * body-skipping scanner did. Fixed by separating "find declaration start
 * positions" (a single forward walk that is never skipped over) from
 * "compute one declaration's end line" (an independent nested scan that
 * does not perturb the outer walk's position).
 *
 * Usage:
 *   node services/gateway/scripts/generate-command-hub-symbol-index.mjs            # write
 *   node services/gateway/scripts/generate-command-hub-symbol-index.mjs --check    # exit 1 if regen would change the index
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_ROOT = path.resolve(__dirname, '..');
const COMMAND_HUB_DIR = path.join(GATEWAY_ROOT, 'src/frontend/command-hub');
const OUTPUT_PATH = path.join(GATEWAY_ROOT, 'specs/command-hub-symbol-index.json');

const SOURCE_FILES = [
  'app.js',
  'orb-widget.js',
  'command-hub-staging.js',
  'intelligence-panels.js',
  'orb-voice-bench.js',
  'watcher.js',
  'intent-engine.js',
  'intelligence-cockpit-nav.js',
  'intent-moderation.js',
  'voice-budget.js',
  'navigation-config.js',
];

const CHECK_MODE = process.argv.includes('--check');

function bail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const FUNCTION_DEF_RE = /(\(\s*)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/y;

/**
 * Given the index right after a matched `function name(`'s opening paren
 * area (i.e. positioned to scan the parameter list and body), returns the
 * 1-based end line of that function's closing `}`, tracking string/
 * template-literal/comment state independently of the caller's own scan
 * position — so this never advances the caller's cursor.
 */
function computeFunctionEndLine(src, fromIndex, fromLine) {
  const n = src.length;
  let j = fromIndex;
  let line = fromLine;
  let parenDepth = 1;
  while (j < n && parenDepth > 0) {
    const c = src[j];
    if (c === '\n') line++;
    if (c === '(') parenDepth++;
    else if (c === ')') parenDepth--;
    j++;
  }
  while (j < n && src[j] !== '{') {
    if (src[j] === '\n') line++;
    j++;
  }
  const bodyStartLine = line;
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let lineComment = false;
  let blockComment = false;
  let templateDepth = 0;
  while (j < n) {
    const c = src[j];
    if (lineComment) {
      if (c === '\n') { lineComment = false; line++; }
      j++;
      continue;
    }
    if (blockComment) {
      if (c === '*' && src[j + 1] === '/') { blockComment = false; j += 2; continue; }
      if (c === '\n') line++;
      j++;
      continue;
    }
    if (inStr) {
      if (c === '\\') { j += 2; continue; }
      if (strCh === '`' && c === '$' && src[j + 1] === '{') { templateDepth++; inStr = false; j += 2; continue; }
      if (c === strCh) { inStr = false; j++; continue; }
      if (c === '\n') line++;
      j++;
      continue;
    }
    if (c === '/' && src[j + 1] === '/') { lineComment = true; j += 2; continue; }
    if (c === '/' && src[j + 1] === '*') { blockComment = true; j += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; j++; continue; }
    if (c === '{' && templateDepth > 0) { templateDepth++; j++; continue; }
    if (c === '}' && templateDepth > 0) { templateDepth--; if (templateDepth === 0) { inStr = true; strCh = '`'; } j++; continue; }
    if (c === '\n') line++;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { endLine: line, bodyStartLine };
    }
    j++;
  }
  return { endLine: -1, bodyStartLine };
}

/**
 * Single forward walk over `src` that never skips past a matched function's
 * body — so nested function declarations are found too, at any depth.
 */
function findFunctionRanges(src) {
  const results = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let inStr = false;
  let strCh = '';
  let inLineComment = false;
  let inBlockComment = false;
  let templateDepth = 0;

  while (i < n) {
    const c = src[i];

    if (inLineComment) {
      if (c === '\n') { inLineComment = false; line++; }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && src[i + 1] === '/') { inBlockComment = false; i += 2; continue; }
      if (c === '\n') line++;
      i++;
      continue;
    }
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (strCh === '`' && c === '$' && src[i + 1] === '{') { templateDepth++; inStr = false; i += 2; continue; }
      if (c === strCh) { inStr = false; i++; continue; }
      if (c === '\n') line++;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { inLineComment = true; i += 2; continue; }
    if (c === '/' && src[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; i++; continue; }
    if (c === '{' && templateDepth > 0) { templateDepth++; i++; continue; }
    if (c === '}' && templateDepth > 0) { templateDepth--; if (templateDepth === 0) { inStr = true; strCh = '`'; } i++; continue; }

    if (c === '\n') { line++; i++; continue; }

    FUNCTION_DEF_RE.lastIndex = i;
    const m = FUNCTION_DEF_RE.exec(src);
    if (m && m.index === i) {
      const isIife = !!m[1];
      const isAsync = !!m[2];
      const name = m[3];
      const startLine = line;
      const { endLine, bodyStartLine } = computeFunctionEndLine(src, i + m[0].length, line);
      if (endLine !== -1) {
        results.push({
          name,
          kind: isIife ? 'iife' : (isAsync ? 'async function' : 'function'),
          startLine,
          bodyStartLine,
          endLine,
          lineCount: endLine - startLine + 1,
        });
      }
      // Advance past only the matched declarator text — the outer walk
      // continues through the parameter list and body character-by-character
      // so it can still find nested declarations inside this function.
      i += m[0].length;
      continue;
    }

    i++;
  }

  return results;
}

function main() {
  const perFile = {};
  let totalFunctions = 0;

  for (const fileName of SOURCE_FILES) {
    const filePath = path.join(COMMAND_HUB_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠ skipping missing file: ${fileName}`);
      continue;
    }
    const src = fs.readFileSync(filePath, 'utf8');
    const ranges = findFunctionRanges(src).sort((a, b) => a.startLine - b.startLine);
    perFile[fileName] = ranges;
    totalFunctions += ranges.length;
  }

  const generated = {
    generated_by: 'services/gateway/scripts/generate-command-hub-symbol-index.mjs',
    generated_at: new Date().toISOString().slice(0, 10),
    note: 'function name -> line range index for the Command Hub frontend *.js files, all nesting depths. Regenerate with the generator script; do not hand-edit.',
    total_functions: totalFunctions,
    files: perFile,
  };

  const generatedJson = JSON.stringify(generated, null, 2) + '\n';
  const existingJson = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';

  // Compare ignoring the generated_at timestamp so a same-day CI re-run
  // without content drift doesn't falsely report "out of sync".
  const stripDate = (s) => s.replace(/"generated_at":\s*"[^"]*"/, '"generated_at": ""');
  const changed = stripDate(generatedJson) !== stripDate(existingJson);

  if (CHECK_MODE) {
    if (changed) {
      console.error(`✗ out of sync (${totalFunctions} functions found vs. stored index). Run without --check to regenerate.`);
      process.exit(1);
    }
    console.log(`✓ in sync (${totalFunctions} functions across ${Object.keys(perFile).length} files)`);
    return;
  }

  if (!changed) {
    console.log(`✓ no changes (${totalFunctions} functions)`);
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, generatedJson);
  console.log(`✓ regenerated ${path.relative(GATEWAY_ROOT, OUTPUT_PATH)}`);
  console.log(`  ${totalFunctions} functions across ${Object.keys(perFile).length} files`);
}

main();
