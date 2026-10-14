/**
 * VTID-05072 (Phase 0): shared helpers for the Command Hub bundle manifest.
 *
 * `src/frontend/command-hub/modules.json` is the single source of truth for
 * which scripts `index.html` loads, in load order, and which extra files the
 * symbol index covers. These helpers read that manifest and the bundle files
 * so the guard tests (and future phases) never hard-code the file list.
 *
 * `app.js` is a plain classic script (no bundler). `functionDeclarations()`
 * parses each bundle file with acorn as a script (not a module) and maps every
 * TOP-LEVEL `FunctionDeclaration` name to the file(s) that declare it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as acorn from 'acorn';

export const COMMAND_HUB_DIR = path.resolve(__dirname, '../../src/frontend/command-hub');
export const MANIFEST_PATH = path.join(COMMAND_HUB_DIR, 'modules.json');

export type BundleKind = 'module' | 'app' | 'post_app' | 'extracted';

export interface BundleEntry {
  file: string;
  kind: BundleKind;
}

export interface Manifest {
  bundle: BundleEntry[];
  indexed_only: string[];
}

/** Reads and parses `modules.json`. */
export function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

/** The absolute path of a bundle file. */
export function bundleFilePath(file: string): string {
  return path.join(COMMAND_HUB_DIR, file);
}

/** The source of one bundle file. */
export function readBundleFile(file: string): string {
  return fs.readFileSync(bundleFilePath(file), 'utf8');
}

/** Every bundle file's contents, concatenated in manifest order. */
export function readCommandHubBundle(): string {
  const { bundle } = readManifest();
  return bundle.map((entry) => readBundleFile(entry.file)).join('\n');
}

/**
 * A Map from each top-level `FunctionDeclaration` name to the file(s) that
 * declare it. A name declared in two bundle files maps to both.
 */
export function functionDeclarations(): Map<string, string[]> {
  const { bundle } = readManifest();
  const byName = new Map<string, string[]>();
  for (const entry of bundle) {
    for (const name of topLevelFunctionNames(readBundleFile(entry.file))) {
      const files = byName.get(name);
      if (files) files.push(entry.file);
      else byName.set(name, [entry.file]);
    }
  }
  return byName;
}

/** The names of every top-level `FunctionDeclaration` in one source string. */
export function topLevelFunctionNames(src: string): string[] {
  const program = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  const names: string[] = [];
  for (const node of program.body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      names.push(node.id.name);
    }
  }
  return names;
}

/** The parsed top-level statements (Program.body) of one source string. */
export function programBody(src: string): acorn.Node[] {
  return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' }).body as acorn.Node[];
}
// VTID-05072: Phase 0 bundle helper (manifest, acorn parse, function declarations).

/**
 * VTID-05073: reconstruct the executable source for the eval-based Operator pin
 * tests after the extraction.
 *
 * Several Phase-0-era pins slice a contiguous region out of `app.js` between
 * two function signatures and `new Function(BLOCK + 'return {...}')` it. The
 * extraction moved the FUNCTION DECLARATIONS in that region into
 * `operator-console.js`, but left the interleaved top-level `var`/`let`/`const`
 * module state (e.g. `_kiroKeyRequested`) in `app.js`. Re-slicing either file
 * alone therefore loses half the region.
 *
 * This helper returns a source string that is behaviourally identical to the
 * original contiguous slice: the extracted function block from
 * `operator-console.js` between `startSig` and `endSig`, PREFIXED with every
 * top-level `var`/`let`/`const` declaration in `app.js` whose name the block
 * references but does not itself declare. No function body is modified; only
 * the module state those functions close over is restored to the eval scope.
 */
export function extractedOperatorBlock(
  startSig: string,
  endSig: string,
  provided: string[] = [],
  alsoInclude: string[] = [],
): string {
  const op = readBundleFile('operator-console.js');
  const start = op.indexOf(startSig);
  const end = op.indexOf(endSig);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`extractedOperatorBlock: signatures not found in operator-console.js: ${startSig} .. ${endSig}`);
  }
  const block = op.slice(start, end);

  // Names the block declares itself (top-level function declarations) and names
  // the eval already supplies as `new Function` parameters (e.g. `state`,
  // `document`, `fetch`). The original app.js slice did not contain these
  // either — they are injected — so they must NOT be re-declared here.
  const alreadyBound = new Set<string>([...topLevelFunctionNames(block), ...provided]);

  // Names the block references, plus names the caller's eval `return { ... }`
  // list names but the block body never calls (so they are not in the AST). A
  // sibling helper that stayed in app.js and is only surfaced via the return
  // list is restored through `alsoInclude`.
  const referenced = new Set<string>(alsoInclude);
  const blockAst = acorn.parse(block, { ecmaVersion: 'latest', sourceType: 'script' });
  collectIdentifiers(blockAst as unknown as AcornNode, referenced);

  // Top-level declarations in app.js whose binding the block uses and that are
  // not already bound in the eval scope. These are the interleaved module state
  // (var/let/const) and the sibling helper functions that stayed in app.js when
  // the block's functions were extracted (e.g. a helper still called from
  // outside the extracted set). Restoring them reproduces the original
  // contiguous slice's eval scope. Only simple, fully-referenced bindings are
  // pulled in, so a multi-binding global or an eval-provided name is never
  // re-declared.
  const app = readBundleFile('app.js');
  const appAst = acorn.parse(app, { ecmaVersion: 'latest', sourceType: 'script' });
  const prefixDecls: string[] = [];
  for (const node of (appAst as unknown as { body: AcornNode[] }).body) {
    if (node.type === 'VariableDeclaration') {
      const names = variableDeclaratorNames(node);
      if (names.length && names.every((n) => referenced.has(n) && !alreadyBound.has(n))) {
        prefixDecls.push(app.slice(node.start as number, node.end as number));
      }
    } else if (node.type === 'FunctionDeclaration') {
      const name = ((node.id as AcornNode) || {}).name as string | undefined;
      if (name && referenced.has(name) && !alreadyBound.has(name)) {
        prefixDecls.push(app.slice(node.start as number, node.end as number));
      }
    }
  }
  return prefixDecls.join('\n') + (prefixDecls.length ? '\n' : '') + block;
}

interface AcornNode {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

/** The bound names of a VariableDeclaration (simple identifier patterns). */
function variableDeclaratorNames(node: AcornNode): string[] {
  const names: string[] = [];
  const decls = (node.declarations as AcornNode[]) || [];
  for (const d of decls) {
    const id = d.id as AcornNode;
    if (id && id.type === 'Identifier') names.push(id.name as string);
  }
  return names;
}

/** Collect every Identifier name used anywhere in an AST subtree. */
function collectIdentifiers(node: AcornNode | null, out: Set<string>): void {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'Identifier') out.add(node.name as string);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof (child as AcornNode).type === 'string') collectIdentifiers(child as AcornNode, out);
      }
    } else if (value && typeof (value as AcornNode).type === 'string') {
      collectIdentifiers(value as AcornNode, out);
    }
  }
}
