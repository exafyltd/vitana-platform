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
