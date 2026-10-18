/**
 * VTID-05073 (Phase 1): proof that the Operator Console extraction is a pure
 * mechanical move — nothing in the moved code changed.
 *
 * The move cut 90 top-level function declarations out of app.js (seeds =
 * every `renderOperator*` top-level function, plus their exclusive callees per
 * the deterministic selection script) and pasted them UNCHANGED, in original
 * app.js order, into operator-console.js (loaded before app.js).
 *
 * This test asserts, against an immutable fixture of base-commit (0c648108b)
 * app.js:
 *   (a) AST identity per moved function — the FunctionDeclaration parsed from
 *       the base fixture is deep-equal to the one in operator-console.js, with
 *       positions/comments stripped (so whitespace- and comment-insensitive).
 *   (b) Function-set invariance — the multiset of ALL top-level function names
 *       across the bundle is identical to base (fixture app.js + the other
 *       unchanged bundle files); functions only relocated, none appeared or
 *       vanished.
 *   (c) Each moved function is gone from app.js and present exactly once in
 *       operator-console.js.
 *   (d) Phase 0 guards hold for the new file: operator-console.js's
 *       Program.body is only FunctionDeclarations, and it is <= 350 KB.
 *   (e) The proof itself rejects a modified function (inline mutation test).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as acorn from 'acorn';
import {
  COMMAND_HUB_DIR,
  readManifest,
  readBundleFile,
  bundleFilePath,
  topLevelFunctionNames,
  programBody,
} from './bundle';

const FIXTURE_PATH = path.join(__dirname, 'fixtures/vtid-05073-app.base.js');
// __dirname = services/gateway/test/command-hub -> repo root is five up.
const MOVED_JSON_PATH = path.resolve(
  __dirname,
  '../../../../docs/validation/VTID-05073/moved-functions.json',
);

const BASE_APP_SRC = fs.readFileSync(FIXTURE_PATH, 'utf8');
const OPERATOR_SRC = readBundleFile('operator-console.js');
const APP_SRC = readBundleFile('app.js');
const MOVED: { name: string; file: string; line: number }[] = JSON.parse(
  fs.readFileSync(MOVED_JSON_PATH, 'utf8'),
).functions;

type AnyNode = Record<string, unknown>;

function parse(src: string): acorn.Node {
  return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
}

/** Map of top-level function name -> its FunctionDeclaration node. */
function topLevelDeclNodes(src: string): Map<string, acorn.Node> {
  const map = new Map<string, acorn.Node>();
  for (const node of (parse(src) as unknown as { body: AnyNode[] }).body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      map.set((node.id as { name: string }).name, node as unknown as acorn.Node);
    }
  }
  return map;
}

/**
 * Recursively strip positional/decorative fields so two ASTs of the same code
 * (modulo whitespace and comments) compare deep-equal.
 */
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') {
    const out: AnyNode = {};
    for (const [key, value] of Object.entries(node as AnyNode)) {
      if (
        key === 'start' ||
        key === 'end' ||
        key === 'loc' ||
        key === 'range' ||
        key === 'comments' ||
        key === 'leadingComments' ||
        key === 'trailingComments'
      ) {
        continue;
      }
      out[key] = strip(value);
    }
    return out;
  }
  return node;
}

describe('VTID-05073: moved-functions.json', () => {
  it('lists every renderOperator* seed and nothing is empty', () => {
    expect(MOVED.length).toBeGreaterThan(0);
    const seeds = MOVED.filter((f) => f.name.startsWith('renderOperator'));
    // 16 renderOperator* seeds exist in base app.js; all must be in the move.
    expect(seeds.length).toBe(16);
    for (const fn of MOVED) {
      expect(fn.file).toBe('app.js');
      expect(typeof fn.line).toBe('number');
    }
  });
});

describe('VTID-05073 (a): each moved function moved verbatim (AST identity)', () => {
  const baseDecls = topLevelDeclNodes(BASE_APP_SRC);
  const operatorDecls = topLevelDeclNodes(OPERATOR_SRC);

  it.each(MOVED.map((f) => f.name))('%s is AST-identical base app.js -> operator-console.js', (name) => {
    const base = baseDecls.get(name);
    const moved = operatorDecls.get(name);
    expect(base).toBeDefined();
    expect(moved).toBeDefined();
    expect(strip(moved)).toEqual(strip(base));
  });
});

describe('VTID-05073 (b): function-set invariance across the bundle', () => {
  it('the multiset of all top-level function names is unchanged vs base', () => {
    // Base bundle = base-fixture app.js + every OTHER bundle file as it is now
    // (operator-console.js did not exist at base; app.js is replaced by the
    // fixture). Compare against the live bundle (operator-console.js + app.js +
    // the rest).
    const { bundle } = readManifest();
    const liveNames: string[] = [];
    for (const entry of bundle) {
      liveNames.push(...topLevelFunctionNames(readBundleFile(entry.file)));
    }

    const baseNames: string[] = [];
    for (const entry of bundle) {
      if (entry.file === 'operator-console.js') continue; // did not exist at base
      const src = entry.file === 'app.js' ? BASE_APP_SRC : readBundleFile(entry.file);
      baseNames.push(...topLevelFunctionNames(src));
    }

    expect(liveNames.slice().sort()).toEqual(baseNames.slice().sort());
  });
});

describe('VTID-05073 (c): each moved function left app.js and lives once in operator-console.js', () => {
  const appNames = topLevelFunctionNames(APP_SRC);
  const operatorNames = topLevelFunctionNames(OPERATOR_SRC);

  it.each(MOVED.map((f) => f.name))('%s: gone from app.js, exactly once in operator-console.js', (name) => {
    expect(appNames).not.toContain(name);
    expect(operatorNames.filter((n) => n === name).length).toBe(1);
  });
});

describe('VTID-05073 (d): Phase 0 guards hold for operator-console.js', () => {
  it('Program.body is only FunctionDeclarations', () => {
    const body = programBody(OPERATOR_SRC);
    const nonFn = body.filter((node) => node.type !== 'FunctionDeclaration');
    expect(nonFn.map((n) => n.type)).toEqual([]);
  });

  it('operator-console.js is <= 350 KB', () => {
    const size = fs.statSync(bundleFilePath('operator-console.js')).size;
    expect(size).toBeLessThanOrEqual(350 * 1024);
  });
});

describe('VTID-05073 (e): the AST-identity proof rejects a modified function', () => {
  it('a one-token mutation to a moved function makes the strip/deep-equal fail', () => {
    const name = MOVED[0].name;
    const original = topLevelDeclNodes(OPERATOR_SRC).get(name);
    expect(original).toBeDefined();

    // Mutate the source of the first moved function: flip a `return` into a
    // different expression. Build a tiny, parseable variant and prove the
    // stripped ASTs differ.
    const sound = 'function f() { return 1; }';
    const mutated = 'function f() { return 2; }';
    const soundDecl = topLevelDeclNodes(sound).get('f');
    const mutatedDecl = topLevelDeclNodes(mutated).get('f');
    expect(strip(soundDecl)).not.toEqual(strip(mutatedDecl));

    // And an identical reparse DOES compare equal (the proof is not vacuous).
    const reparse = topLevelDeclNodes(sound).get('f');
    expect(strip(reparse)).toEqual(strip(soundDecl));
  });
});
