/**
 * VTID-05072 (Phase 0): guard tests for the Command Hub bundle manifest.
 *
 * These prove the five Phase 0 invariants without moving any code:
 *   1. index.html's <script src="/command-hub/*.js"> list == modules.json
 *      "bundle" (same files, same order; ?v= ignored).
 *   2. No top-level function name is declared in two bundle files.
 *   3. Every "extracted" file's Program.body is ONLY FunctionDeclarations;
 *      the same check rejects a const, an IIFE and an expression statement.
 *   4. Every "extracted"/"module" file is <= 350 KB; app.js is exempt.
 *   5. The symbol-index generator's file list is a superset of the 11 files
 *      indexed before this change, plus pipeline-tree.js and kiro-console.js.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  COMMAND_HUB_DIR,
  readManifest,
  readBundleFile,
  bundleFilePath,
  functionDeclarations,
  topLevelFunctionNames,
  programBody,
} from './bundle';

const INDEX_HTML = fs.readFileSync(path.join(COMMAND_HUB_DIR, 'index.html'), 'utf8');

/** The command-hub script srcs in index.html, in order, with ?v= stripped. */
function indexHtmlScriptFiles(): string[] {
  const files: string[] = [];
  const re = /<script\s+src="\/command-hub\/([^"?]+\.js)(?:\?[^"]*)?"\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(INDEX_HTML)) !== null) {
    files.push(m[1]);
  }
  return files;
}

describe('VTID-05072 case 1: index.html script list equals the manifest bundle', () => {
  it('same files in the same order (ignoring ?v=)', () => {
    const fromHtml = indexHtmlScriptFiles();
    const fromManifest = readManifest().bundle.map((entry) => entry.file);
    expect(fromHtml).toEqual(fromManifest);
  });
});

describe('VTID-05072 case 2: no top-level function name in two bundle files', () => {
  // KNOWN, FROZEN duplicate. `escapeHtml` is declared top-level in BOTH app.js
  // and intelligence-panels.js today. It is NOT removed in Phase 0 (plan 1.6:
  // no app.js edit, no served-file behaviour change, no ?v= bump). It is a
  // real security bug — the intelligence-panels.js copy does NOT escape single
  // or double quotes and, loading AFTER app.js, overrides app.js's correct
  // copy page-wide — whose fix is deferred to its own security-fix VTID
  // (follow-up to VTID-05072). This allowlist can only SHRINK: a test below
  // fails if the duplicate disappears while this entry remains, and another
  // fails if any OTHER name is duplicated or the file set changes.
  const KNOWN_DUPLICATES: Record<string, string[]> = {
    escapeHtml: ['app.js', 'intelligence-panels.js'],
  };

  const sortedSet = (files: string[]): string[] => [...files].sort();
  const sameSet = (a: string[], b: string[]): boolean => {
    const sa = sortedSet(a);
    const sb = sortedSet(b);
    return sa.length === sb.length && sa.every((f, i) => f === sb[i]);
  };

  /** Duplicate top-level names in the live bundle: name -> files declaring it. */
  function liveDuplicates(): Map<string, string[]> {
    const byName = functionDeclarations();
    return new Map([...byName.entries()].filter(([, files]) => files.length > 1));
  }

  it('no UNEXPECTED top-level function name is declared in two bundle files', () => {
    const dups = liveDuplicates();
    const unexpected = [...dups.entries()].filter(
      ([name, files]) => !(name in KNOWN_DUPLICATES && sameSet(files, KNOWN_DUPLICATES[name])),
    );
    // Any new duplicate, or a known one appearing in a different file set, fails.
    expect(unexpected).toEqual([]);
  });

  it('every known duplicate STILL exists in exactly its allowlisted file set (list can only shrink)', () => {
    const dups = liveDuplicates();
    for (const [name, files] of Object.entries(KNOWN_DUPLICATES)) {
      const live = dups.get(name);
      // Fails if the duplicate disappeared (remove the allowlist entry then),
      // or if it now spans a different set of files than allowlisted.
      expect(live).toBeDefined();
      expect(sameSet(live as string[], files)).toBe(true);
    }
  });

  it('the escapeHtml duplicate is exactly {app.js, intelligence-panels.js}', () => {
    const dups = liveDuplicates();
    expect(dups.get('escapeHtml')).toBeDefined();
    expect(sortedSet(dups.get('escapeHtml') as string[])).toEqual([
      'app.js',
      'intelligence-panels.js',
    ]);
  });

  it('the guard still catches a NEW duplicate (inline-string proof, not a real file)', () => {
    // Simulate two bundle files that both declare `renderThing` at top level.
    const fileA = 'function renderThing() { return 1; }\nfunction onlyA() {}';
    const fileB = 'function renderThing() { return 2; }\nfunction onlyB() {}';
    const byName = new Map<string, string[]>();
    for (const [file, src] of [['a.js', fileA], ['b.js', fileB]] as const) {
      for (const name of topLevelFunctionNames(src)) {
        const files = byName.get(name);
        if (files) files.push(file);
        else byName.set(name, [file]);
      }
    }
    const dups = [...byName.entries()].filter(([, files]) => files.length > 1);
    const unexpected = dups.filter(
      ([name, files]) => !(name in KNOWN_DUPLICATES && sameSet(files, KNOWN_DUPLICATES[name])),
    );
    expect(unexpected.map(([name]) => name)).toEqual(['renderThing']);
  });
});

describe('VTID-05072 case 3: extracted files are function declarations only', () => {
  it('every "extracted" bundle file has a Program.body of only FunctionDeclarations', () => {
    const extracted = readManifest().bundle.filter((entry) => entry.kind === 'extracted');
    // Phase 0 has no extracted files; this still runs clean (and does nothing
    // unsafe), while cases below prove the check itself is sound.
    for (const entry of extracted) {
      const body = programBody(readBundleFile(entry.file));
      const nonFn = body.filter((node) => node.type !== 'FunctionDeclaration');
      expect(nonFn.map((n) => n.type)).toEqual([]);
    }
  });

  const declarationsOnly = (src: string): boolean =>
    programBody(src).every((node) => node.type === 'FunctionDeclaration');

  it('accepts a body of only function declarations', () => {
    expect(declarationsOnly('function a() { return 1; }\nfunction b() { return 2; }')).toBe(true);
  });

  it('rejects a body containing a const', () => {
    expect(declarationsOnly('function a() {}\nconst x = 1;')).toBe(false);
  });

  it('rejects a body containing an IIFE', () => {
    expect(declarationsOnly('function a() {}\n(function () { doThing(); })();')).toBe(false);
  });

  it('rejects a body containing an expression statement', () => {
    expect(declarationsOnly('function a() {}\nwindow.foo = 1;')).toBe(false);
  });
});

describe('VTID-05072 case 4: extracted/module files are <= 350 KB (app.js exempt)', () => {
  const LIMIT_BYTES = 350 * 1024;

  it('every extracted/module bundle file is within the limit; app.js is exempt', () => {
    for (const entry of readManifest().bundle) {
      if (entry.kind !== 'extracted' && entry.kind !== 'module') continue;
      if (entry.file === 'app.js') continue;
      const size = fs.statSync(bundleFilePath(entry.file)).size;
      expect(size).toBeLessThanOrEqual(LIMIT_BYTES);
    }
  });

  it('app.js (kind "app") is not subject to the size limit', () => {
    const app = readManifest().bundle.find((entry) => entry.file === 'app.js');
    expect(app?.kind).toBe('app');
  });
});

describe('VTID-05072 case 5: generator file list is a superset of the pre-change index', () => {
  // The 11 files the symbol index covered BEFORE VTID-05072 (hard-coded here so
  // a regression that drops one from the manifest fails this test).
  const PRE_CHANGE_INDEXED = [
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

  /** The file list the generator now scans: bundle files + indexed_only. */
  function generatorFileList(): string[] {
    const manifest = readManifest();
    return [...manifest.bundle.map((entry) => entry.file), ...manifest.indexed_only];
  }

  it('keeps every file indexed before this change', () => {
    const current = new Set(generatorFileList());
    for (const file of PRE_CHANGE_INDEXED) {
      expect(current.has(file)).toBe(true);
    }
  });

  it('adds pipeline-tree.js and kiro-console.js', () => {
    const current = new Set(generatorFileList());
    expect(current.has('pipeline-tree.js')).toBe(true);
    expect(current.has('kiro-console.js')).toBe(true);
  });

  it('the regenerated symbol index also contains pipeline-tree.js and kiro-console.js', () => {
    const index = JSON.parse(
      fs.readFileSync(path.join(COMMAND_HUB_DIR, '../../../specs/command-hub-symbol-index.json'), 'utf8'),
    );
    const files = Object.keys(index.files);
    expect(files).toContain('pipeline-tree.js');
    expect(files).toContain('kiro-console.js');
    for (const file of PRE_CHANGE_INDEXED) {
      expect(files).toContain(file);
    }
  });
});

describe('VTID-05072: helper sanity', () => {
  it('topLevelFunctionNames finds only top-level declarations', () => {
    const names = topLevelFunctionNames(
      'function outer() { function inner() {} }\nfunction sibling() {}',
    );
    expect(names).toEqual(['outer', 'sibling']);
  });
});
