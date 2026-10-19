#!/usr/bin/env node
/**
 * VTID-05073 (Phase 1): deterministic selection of the functions to extract
 * from the Command Hub bundle into a new `extracted` file.
 *
 * Algorithm (over the WHOLE bundle, read exactly as `test/command-hub/bundle.ts`
 * `readCommandHubBundle()` concatenates it — manifest `bundle` order, joined by
 * "\n"):
 *   1. Parse each bundle file with acorn as a classic script and collect every
 *      TOP-LEVEL FunctionDeclaration with its name, source file and 1-based
 *      start line within that file.
 *   2. Seeds = top-level functions whose name starts with `--seed-prefix`
 *      (default `renderOperator`).
 *   3. Fixpoint: add a top-level function F to the set when EVERY identifier
 *      reference to F anywhere in the bundle sits inside a top-level function
 *      already in the set. A reference at module scope, or inside a top-level
 *      function not in the set, keeps F out. Shared helpers therefore stay put.
 *   4. Exclusion: drop any function whose name also appears inside ANY string
 *      literal (string `Literal` or any `TemplateLiteral` quasi) anywhere in
 *      the bundle — conservative guard against dynamic lookup.
 *   5. Only functions declared in `app.js` are eligible to move.
 *
 * Output: docs/validation/VTID-05073/moved-functions.json, sorted by original
 * app.js line ascending. Deterministic: re-running yields byte-identical output
 * except for `generated_at`.
 *
 * Usage: node scripts/dev/select-extraction.mjs [--seed-prefix=renderOperator]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as acorn from '../../services/gateway/node_modules/acorn/dist/acorn.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMMAND_HUB_DIR = path.join(
  REPO_ROOT,
  'services', 'gateway', 'src', 'frontend', 'command-hub',
);
const MANIFEST_PATH = path.join(COMMAND_HUB_DIR, 'modules.json');
const OUTPUT_PATH = path.join(
  REPO_ROOT,
  'docs', 'validation', 'VTID-05073', 'moved-functions.json',
);
const ELIGIBLE_FILE = 'app.js';

function parseArgs(argv) {
  let seedPrefix = 'renderOperator';
  for (const arg of argv.slice(2)) {
    const m = /^--seed-prefix=(.*)$/.exec(arg);
    if (m) seedPrefix = m[1];
  }
  return { seedPrefix };
}

function parse(src) {
  return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
}

/** Walk every node in an AST, calling `visit(node, parent)` pre-order. */
function walk(node, parent, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walk(child, node, visit);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, node, visit);
    }
  }
}

/** 1-based line number of a character offset in `src`. */
function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function main() {
  const { seedPrefix } = parseArgs(process.argv);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const bundleFiles = manifest.bundle.map((e) => e.file);

  // Per-file: source, AST, and the list of top-level FunctionDeclarations.
  const files = new Map();
  // name -> { file, line } for the single declaration we will consider.
  // (Top-level names are unique across the bundle — a Phase 0 guard enforces it.)
  const topLevelByName = new Map();
  // name -> set of top-level function names it is NOT allowed to be a seed of,
  // used only for membership tests below.

  for (const file of bundleFiles) {
    const src = fs.readFileSync(path.join(COMMAND_HUB_DIR, file), 'utf8');
    const ast = parse(src);
    const topLevel = [];
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' && node.id) {
        const line = lineOf(src, node.start);
        topLevel.push({ name: node.id.name, start: node.start, end: node.end, line });
        if (!topLevelByName.has(node.id.name)) {
          topLevelByName.set(node.id.name, { file, line });
        }
      }
    }
    files.set(file, { src, ast, topLevel });
  }

  const topLevelNames = new Set(topLevelByName.keys());

  // Collect, per top-level function name, the set of enclosing-top-level-function
  // identities of every identifier reference to that name anywhere in the bundle.
  // "module" means a reference at module (program) scope. We only track references
  // to names that are themselves top-level functions (candidates for moving).
  //
  // enclosers.get(name) = Set of enclosing identities ("module" | <top fn name>).
  const enclosers = new Map();
  for (const name of topLevelNames) enclosers.set(name, new Set());

  // Also collect the set of top-level function names that appear inside any
  // string literal / template quasi anywhere in the bundle.
  const inStringLiteral = new Set();

  for (const file of bundleFiles) {
    const { src, ast, topLevel } = files.get(file);
    // Build an interval list of top-level function ranges to resolve the
    // enclosing top-level function of any offset in this file.
    const ranges = topLevel.map((t) => ({ name: t.name, start: t.start, end: t.end }));
    const enclosingTop = (offset) => {
      for (const r of ranges) {
        if (offset >= r.start && offset < r.end) return r.name;
      }
      return 'module';
    };

    walk(ast, null, (node, parent) => {
      // Reference collection: an Identifier used as a value reference (not as a
      // declaration name, not as a non-computed property key, not a label).
      if (node.type === 'Identifier' && topLevelNames.has(node.name)) {
        if (!isReferenceIdentifier(node, parent)) return;
        // Skip the declaration's own id (the `function NAME` token).
        enclosers.get(node.name).add(enclosingTop(node.start));
      }
      // String-literal name occurrences.
      if (node.type === 'Literal' && typeof node.value === 'string') {
        if (topLevelNames.has(node.value)) inStringLiteral.add(node.value);
      }
      if (node.type === 'TemplateLiteral') {
        for (const quasi of node.quasis) {
          const text = quasi.value.cooked != null ? quasi.value.cooked : quasi.value.raw;
          if (typeof text !== 'string') continue;
          for (const candidate of topLevelNames) {
            if (text.includes(candidate)) inStringLiteral.add(candidate);
          }
        }
      }
    });
  }

  // Also scan every string literal for substrings that are top-level names
  // (handles names embedded in larger strings, e.g. a message mentioning the fn).
  for (const file of bundleFiles) {
    const { ast } = files.get(file);
    walk(ast, null, (node) => {
      if (node.type === 'Literal' && typeof node.value === 'string') {
        for (const candidate of topLevelNames) {
          if (node.value.includes(candidate)) inStringLiteral.add(candidate);
        }
      }
    });
  }

  // Seeds.
  const inSet = new Set();
  for (const name of topLevelNames) {
    if (name.startsWith(seedPrefix) && topLevelByName.get(name).file === ELIGIBLE_FILE) {
      inSet.add(name);
    }
  }

  // Fixpoint: add F when every reference to F is enclosed by a function in the set.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of topLevelNames) {
      if (inSet.has(name)) continue;
      if (topLevelByName.get(name).file !== ELIGIBLE_FILE) continue;
      const refs = enclosers.get(name);
      // A function with NO references at all is not pulled in by the fixpoint
      // (seeds are the only zero-reference members, handled above).
      if (refs.size === 0) continue;
      let allInside = true;
      for (const encl of refs) {
        if (encl === 'module' || !inSet.has(encl)) { allInside = false; break; }
      }
      if (allInside) { inSet.add(name); changed = true; }
    }
  }

  // Exclusion: drop any name that appears inside a string literal.
  for (const name of [...inSet]) {
    if (inStringLiteral.has(name)) inSet.delete(name);
  }

  // Only app.js functions are eligible (seeds already enforced; fixpoint guarded).
  const moved = [...inSet]
    .filter((name) => topLevelByName.get(name).file === ELIGIBLE_FILE)
    .map((name) => ({ name, file: ELIGIBLE_FILE, line: topLevelByName.get(name).line }))
    .sort((a, b) => a.line - b.line);

  const output = {
    generated_at: new Date().toISOString().slice(0, 10),
    seed_prefix: seedPrefix,
    functions: moved,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  process.stdout.write(`select-extraction: ${moved.length} functions selected (seed prefix "${seedPrefix}")\n`);
  for (const fn of moved) process.stdout.write(`  ${fn.name}  (app.js:${fn.line})\n`);
}

/**
 * True when `node` (an Identifier whose name is a top-level function) is a real
 * value/callee reference, not a binding name or a non-computed property/key.
 */
function isReferenceIdentifier(node, parent) {
  if (!parent) return true;
  switch (parent.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      // The function's own name id, or one of its params.
      if (parent.id === node) return false;
      if (parent.params && parent.params.includes(node)) return false;
      return true;
    case 'MemberExpression':
      // `obj.name` — the property is not a reference unless computed (`obj[name]`).
      if (parent.property === node && !parent.computed) return false;
      return true;
    case 'Property':
      // `{ name: ... }` — a non-computed key is not a reference. A shorthand or
      // value position IS a reference.
      if (parent.key === node && !parent.computed && parent.value !== node) return false;
      return true;
    case 'MethodDefinition':
      if (parent.key === node && !parent.computed) return false;
      return true;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      if (parent.label === node) return false;
      return true;
    case 'VariableDeclarator':
      // `var name = ...` binding position.
      if (parent.id === node) return false;
      return true;
    default:
      return true;
  }
}

main();
