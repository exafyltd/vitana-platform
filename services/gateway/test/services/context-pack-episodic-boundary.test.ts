// VTID-03156 — anti-regression for CPB-1/2 (episodic fallback boundary).
//
// PR 4 moves the legacy episodic memory fallbacks (`memory_semantic_search`
// RPC + `memory_items` REST select) out of `context-pack-builder.ts` and
// into the memory-broker. The full fallback ladder now lives in the
// broker's `fetchEpisodicBlock`. CPB just asks the broker for the
// EPISODIC block.
//
// Contract:
//   - `context-pack-builder.ts` does not name `memory_semantic_search` or
//     `memory_items` anywhere in its source.
//   - The episodic-fetch path inside `fetchMemoryHits` does not read
//     Supabase credential env vars. Other unrelated paths in this file
//     (VTID ledger, OASIS, tool-health) are explicitly out of scope and
//     may still use those env vars.

import * as fs from 'fs';
import * as path from 'path';

const CPB_PATH = path.resolve(
  __dirname,
  '../../src/services/context-pack-builder.ts',
);

/** Extract a top-level `async function NAME(...): ReturnType { ... }`
 *  body from the source. Walks both parens (to skip the parameter list
 *  AND any inline object types in the return signature) and braces (to
 *  find the matching `}`). Returns the function body without signature. */
function extractFunctionBody(src: string, name: string): string {
  const sigRegex = new RegExp(`async function ${name}\\s*\\(`);
  const sigMatch = sigRegex.exec(src);
  if (!sigMatch) {
    throw new Error(`function ${name} not found in source`);
  }
  // Cursor sits at the open-paren of the parameter list. Walk parens to
  // skip to the close-paren of the params.
  let i = sigMatch.index + sigMatch[0].length - 1; // points at the '('
  let parens = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') parens++;
    else if (c === ')') {
      parens--;
      if (parens === 0) { i++; break; }
    }
    i++;
  }
  // Now skip the return-type annotation (may itself contain `{...}`).
  // We use the heuristic: the *first* `{` we see AFTER reaching depth-0
  // parens AND outside any `<>` generics is the body opener IFF it's
  // preceded by a return-type or whitespace and is at brace-depth 0.
  // Practical approach: scan tokens, ignore `{` that appears in a return
  // type annotation by detecting the `): ... {` pattern — once we see a
  // colon at depth 0 we enter "return type" mode and the matching close
  // brace returns us. Simpler: count nested braces from the very next
  // `{`; the body starts at the LAST `{` before the next non-whitespace
  // line that doesn't contain `;`.
  //
  // The clean implementation: walk forward, tracking brace AND angle
  // depth. The body `{` is the brace at depth-0 immediately followed by
  // either a newline or non-`:` content (return-type braces always sit
  // inside `: ... {` until the body `{` after `Promise<...>`).
  let braceDepth = 0;
  let bodyStart = -1;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      if (braceDepth === 0) {
        // Peek backward to find whether this is a return-type brace
        // (preceded by `:` after the close-paren) or the body brace
        // (preceded by `>` from a generic or directly the close paren).
        let k = i - 1;
        while (k >= 0 && /\s/.test(src[k])) k--;
        // If the previous non-whitespace char is `>` then it's the end
        // of a generic like `Promise<...>` — this is the body brace.
        // If it's `:` then we're inside a type literal — keep walking.
        if (src[k] === '>' || src[k] === ')') {
          bodyStart = i + 1;
          braceDepth = 1;
          i++;
          break;
        }
      }
      braceDepth++;
    } else if (c === '}') {
      braceDepth--;
    }
    i++;
  }
  if (bodyStart < 0) throw new Error(`body brace not found for ${name}`);
  // Now walk braces from bodyStart to find the matching `}`.
  while (i < src.length && braceDepth > 0) {
    const c = src[i];
    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth--;
    i++;
  }
  return src.slice(bodyStart, i - 1);
}

describe('VTID-03156 CPB-1/2 episodic fallback boundary — anti-regression', () => {
  let src: string;
  beforeAll(() => {
    src = fs.readFileSync(CPB_PATH, 'utf8');
  });

  describe('no direct references to legacy episodic storage', () => {
    const FORBIDDEN: string[] = [
      'memory_semantic_search',
      'memory_items',
    ];
    for (const term of FORBIDDEN) {
      it(`does not mention "${term}"`, () => {
        expect(src).not.toMatch(new RegExp(term));
      });
    }
  });

  describe('episodic-fetch path does not read Supabase credential env vars', () => {
    // The directive is "for this path" — other unrelated CPB paths
    // (VTID ledger, OASIS events) are out of scope and may still use
    // these env vars. We assert the boundary at function granularity.
    let fetchMemoryHitsBody: string;
    beforeAll(() => {
      fetchMemoryHitsBody = extractFunctionBody(src, 'fetchMemoryHits');
    });

    it('fetchMemoryHits body does not read SUPABASE_URL', () => {
      expect(fetchMemoryHitsBody).not.toMatch(/SUPABASE_URL/);
    });

    it('fetchMemoryHits body does not read SUPABASE_SERVICE_ROLE', () => {
      expect(fetchMemoryHitsBody).not.toMatch(/SUPABASE_SERVICE_ROLE/);
    });

    it('fetchMemoryHits body does not construct fetch() requests directly', () => {
      // Indirect signal: the broker call is now the only data acquisition;
      // a stray `fetch(` inside this function means someone re-added a raw
      // Supabase REST/RPC call.
      expect(fetchMemoryHitsBody).not.toMatch(/\bfetch\s*\(/);
    });
  });

  describe('positive contract — episodic goes through the broker', () => {
    it('fetchMemoryHits delegates to fetchMemoryHitsViaBroker', () => {
      const body = extractFunctionBody(src, 'fetchMemoryHits');
      expect(body).toMatch(/fetchMemoryHitsViaBroker\s*\(\s*lens\s*,\s*query\s*,\s*limit\s*\)/);
    });

    it('fetchMemoryHitsViaBroker calls getMemoryContext with EPISODIC block', () => {
      const body = extractFunctionBody(src, 'fetchMemoryHitsViaBroker');
      expect(body).toMatch(/getMemoryContext/);
      expect(body).toMatch(/required_blocks\s*:\s*\[\s*['"]EPISODIC['"]\s*\]/);
    });
  });
});
