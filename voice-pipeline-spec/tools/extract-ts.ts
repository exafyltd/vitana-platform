/**
 * Extracts the actual feature surface of services/gateway/src/routes/orb-live.ts
 * via ts-morph AST walk. Output: extracted/vertex.json
 *
 * What it extracts:
 *   - tools: every `case 'tool_name':` whose nearest enclosing
 *            SwitchStatement discriminates on `toolName`. This avoids picking
 *            up navigate_to_screen sub-routes and SSE message-type cases.
 *   - oasis_topics: every literal string passed as `type:` to `emitOasisEvent({ ... })`.
 *                   Peels through `as any` / `as const` AsExpression wrappers.
 *   - watchdogs: every module-level `const FOO_MS = 12345` / `MAX_FOO = 10` constant.
 *
 * Run: npm run extract:ts
 */
import { Project, Node, SyntaxKind, type CaseClause, type SwitchStatement } from 'ts-morph';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const ORB_LIVE = resolve(REPO_ROOT, 'services', 'gateway', 'src', 'routes', 'orb-live.ts');
const ORB_TOOLS_SHARED = resolve(REPO_ROOT, 'services', 'gateway', 'src', 'services', 'orb-tools-shared.ts');
const OUT_PATH = resolve(__dirname, '..', 'extracted', 'vertex.json');

// Only switch statements with these discriminants count as tool dispatchers.
const TOOL_DISPATCHER_DISCRIMINANTS = new Set(['toolName', 'tool_name', 'name']);

interface ExtractedSurface {
  source: string;
  extracted_at: string;
  tools: { name: string; line: number }[];
  oasis_topics: { topic: string; line: number }[];
  watchdogs: { name: string; value: number; line: number }[];
  system_instruction_signatures: {
    authenticated: string[] | null;
    anonymous: string[] | null;
  };
}

function main(): void {
  const project = new Project({
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
    skipLoadingLibFiles: true,
  });
  const sf = project.addSourceFileAtPath(ORB_LIVE);

  const tools: { name: string; line: number }[] = [];
  const oasisTopics: { topic: string; line: number }[] = [];
  const watchdogs: { name: string; value: number; line: number }[] = [];
  let authSig: string[] | null = null;
  let anonSig: string[] | null = null;

  sf.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.CaseClause) {
      const cc = node as CaseClause;
      if (!isInsideToolDispatcher(cc)) return;
      const expr = cc.getExpression();
      if (Node.isStringLiteral(expr)) {
        const name = expr.getLiteralValue();
        if (/^[a-z][a-z0-9_]*$/.test(name)) {
          tools.push({ name, line: cc.getStartLineNumber() });
        }
      }
    }

    // Some tools are dispatched via an `if (toolName === 'navigate') { ... }`
    // chain rather than a switch — e.g. the unified Navigator tools
    // (navigate / get_current_screen / navigate_to_screen). Match ONLY the
    // exact `<dispatcher> === '<literal>'` idiom where the identifier on one
    // side is a known tool dispatcher (toolName / tool_name / name), so we
    // don't pick up unrelated string comparisons elsewhere in the file.
    if (node.getKind() === SyntaxKind.BinaryExpression) {
      const bin = node.asKindOrThrow(SyntaxKind.BinaryExpression);
      const op = bin.getOperatorToken().getKind();
      if (op === SyntaxKind.EqualsEqualsEqualsToken || op === SyntaxKind.EqualsEqualsToken) {
        const left = bin.getLeft();
        const right = bin.getRight();
        const idSide = Node.isIdentifier(left) ? left : Node.isIdentifier(right) ? right : null;
        const litSide = Node.isStringLiteral(left) ? left : Node.isStringLiteral(right) ? right : null;
        if (idSide && litSide && TOOL_DISPATCHER_DISCRIMINANTS.has(idSide.getText())) {
          const name = litSide.getLiteralValue();
          if (/^[a-z][a-z0-9_]*$/.test(name)) {
            tools.push({ name, line: bin.getStartLineNumber() });
          }
        }
      }
    }

    if (node.getKind() === SyntaxKind.CallExpression) {
      const call = node.asKindOrThrow(SyntaxKind.CallExpression);
      const callee = call.getExpression().getText();
      if (callee !== 'emitOasisEvent' && !callee.endsWith('.emitOasisEvent')) return;
      const args = call.getArguments();
      if (!args[0] || !Node.isObjectLiteralExpression(args[0])) return;
      for (const prop of args[0].getProperties()) {
        if (!Node.isPropertyAssignment(prop) || prop.getName() !== 'type') continue;
        const init = prop.getInitializer();
        if (!init) continue;
        const literal = unwrapToStringLiteral(init);
        if (!literal) continue;
        const topic = literal.getLiteralValue();
        if (/^[a-z][a-z0-9_]+(\.[a-z0-9_]+)+$/.test(topic)) {
          oasisTopics.push({ topic, line: literal.getStartLineNumber() });
        }
      }
    }

    if (node.getKind() === SyntaxKind.VariableDeclaration) {
      const decl = node.asKindOrThrow(SyntaxKind.VariableDeclaration);
      const name = decl.getName();
      if (!isWatchdogName(name)) return;
      const init = decl.getInitializer();
      if (!init) return;
      const evaluated = tryEvalNumeric(init);
      if (evaluated === null) return;
      watchdogs.push({
        name: name.toLowerCase(),
        value: evaluated,
        line: decl.getStartLineNumber(),
      });
    }
  });

  for (const fn of sf.getFunctions()) {
    const fnName = fn.getName();
    if (fnName === 'buildLiveSystemInstruction') {
      authSig = fn.getParameters().map((p) => p.getName());
    } else if (fnName === 'buildAnonymousSystemInstruction') {
      anonSig = fn.getParameters().map((p) => p.getName());
    }
  }

  // BOOTSTRAP-VOICE-CATALOG-COMPLETE: orb-live.ts's default case has a
  // generic dispatch fallback — `if (ORB_TOOL_NAMES.includes(toolName))
  // { … dispatchOrbToolForVertex … }` — so every tool in the shared
  // ORB_TOOL_REGISTRY is Vertex-reachable even without its own `case` arm
  // or `toolName === '...'` comparison. Without this, every tool added via
  // the shared registry (the intended pattern going forward) shows up as a
  // false-positive `missing_in_vertex` drift on every PR. Detect the idiom
  // and, when present, count every shared-registry tool as covered.
  if (/ORB_TOOL_NAMES\.includes\(\s*toolName\s*\)/.test(sf.getFullText())) {
    for (const name of extractSharedRegistryNames(readSharedSource())) {
      tools.push({ name, line: 0 });
    }
  }

  const out: ExtractedSurface = {
    source: 'services/gateway/src/routes/orb-live.ts',
    extracted_at: new Date().toISOString(),
    tools: dedupeBy(tools, (t) => t.name),
    oasis_topics: dedupeBy(oasisTopics, (t) => t.topic),
    watchdogs: dedupeBy(watchdogs, (w) => w.name),
    system_instruction_signatures: { authenticated: authSig, anonymous: anonSig },
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(
    `extracted vertex surface: ${out.tools.length} tools, ${out.oasis_topics.length} topics, ${out.watchdogs.length} watchdogs → ${OUT_PATH}`,
  );
}

function isInsideToolDispatcher(cc: CaseClause): boolean {
  let parent: Node | undefined = cc.getParent();
  while (parent) {
    if (parent.getKind() === SyntaxKind.SwitchStatement) {
      const sw = parent as SwitchStatement;
      const discriminantText = sw.getExpression().getText();
      return TOOL_DISPATCHER_DISCRIMINANTS.has(discriminantText);
    }
    parent = parent.getParent();
  }
  return false;
}

function unwrapToStringLiteral(node: Node): import('ts-morph').StringLiteral | null {
  let cur: Node = node;
  while (Node.isAsExpression(cur) || Node.isParenthesizedExpression(cur) || Node.isTypeAssertion(cur)) {
    cur = cur.getExpression();
  }
  return Node.isStringLiteral(cur) ? cur : null;
}

function isWatchdogName(name: string): boolean {
  if (!/^[A-Z][A-Z0-9_]+$/.test(name)) return false;
  return (
    name.endsWith('_MS') ||
    name.endsWith('_THRESHOLD') ||
    name.endsWith('_TIMEOUT') ||
    name.endsWith('_BUCKET') ||
    name.startsWith('MAX_')
  );
}

function tryEvalNumeric(node: Node): number | null {
  const text = node.getText().replace(/_/g, '');
  if (/^[0-9*\s+]+$/.test(text)) {
    try {
      // eslint-disable-next-line no-new-func
      const v = Function(`"use strict"; return (${text});`)();
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    } catch {
      return null;
    }
  }
  if (/^[0-9]+$/.test(text)) {
    return Number(text);
  }
  return null;
}

function dedupeBy<T, K>(arr: T[], key: (x: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const x of arr) {
    const k = key(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function readSharedSource(): string {
  return readFileSync(ORB_TOOLS_SHARED, 'utf8');
}

// Regex-based extraction (not ts-morph) to match the sibling implementation
// in scripts/voice-tools-manifest-reconcile.mjs — same source, same logic,
// kept in sync deliberately. Pulls every literal key AND every
// `...FOO_TOOL_HANDLERS` spread's own keys (resolved via its import path)
// out of `export const ORB_TOOL_REGISTRY = { … }`.
function extractSharedRegistryNames(src: string): Set<string> {
  const idx = src.indexOf('export const ORB_TOOL_REGISTRY');
  if (idx < 0) return new Set();
  const open = src.indexOf('{', idx);
  if (open < 0) return new Set();
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return new Set();
  const body = src.slice(open + 1, close);
  const keys = new Set<string>();
  const pat = /^[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*[(a-zA-Z_]|,)/gm;
  let m: RegExpExecArray | null;
  while ((m = pat.exec(body)) !== null) keys.add(m[1]);

  const spreadPat = /^[ \t]*\.\.\.([A-Z][A-Z0-9_]*)\s*,/gm;
  const spreadNames = new Set<string>();
  let sm: RegExpExecArray | null;
  while ((sm = spreadPat.exec(body)) !== null) spreadNames.add(sm[1]);

  for (const spreadName of spreadNames) {
    const importRe = new RegExp(`import\\s*\\{[^}]*\\b${spreadName}\\b[^}]*\\}\\s*from\\s*'([^']+)'`);
    const importMatch = src.match(importRe);
    if (!importMatch) continue;
    const modPath = resolve(dirname(ORB_TOOLS_SHARED), importMatch[1].replace(/^\.\//, '') + '.ts');
    let modSrc: string;
    try {
      modSrc = readFileSync(modPath, 'utf8');
    } catch {
      continue;
    }
    const declIdx = modSrc.indexOf(`export const ${spreadName}`);
    if (declIdx < 0) continue;
    const modOpen = modSrc.indexOf('{', declIdx);
    if (modOpen < 0) continue;
    let modDepth = 0;
    let modClose = -1;
    for (let i = modOpen; i < modSrc.length; i++) {
      if (modSrc[i] === '{') modDepth++;
      else if (modSrc[i] === '}') {
        modDepth--;
        if (modDepth === 0) {
          modClose = i;
          break;
        }
      }
    }
    if (modClose < 0) continue;
    const modBody = modSrc.slice(modOpen + 1, modClose);
    let mm: RegExpExecArray | null;
    const modPat = /^[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*[(a-zA-Z_]|,)/gm;
    while ((mm = modPat.exec(modBody)) !== null) keys.add(mm[1]);
  }
  return keys;
}

main();
