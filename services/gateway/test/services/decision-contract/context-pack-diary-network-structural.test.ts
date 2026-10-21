// VTID-03145 (PR 2) — structural anti-regression for the
// context-pack-builder DIARY + NETWORK Supabase boundary.
//
// PR 2 of the Decision-Contract Supabase Boundary Hardening sequence
// routes the DIARY and NETWORK reads through `getMemoryContext` instead
// of raw REST fetches. This test locks the outcome: the four table
// names (memory_diary_entries, diary_entries, relationship_nodes,
// relationship_edges) must no longer appear as table references inside
// context-pack-builder.ts source code. Comment references are allowed
// (they document why the rewrite happened); raw fetch URLs and
// `.from('<table>')` SDK calls are not.
//
// If a future change reintroduces ANY of the four tables as a direct
// read inside context-pack-builder.ts, this test fails.

import * as fs from 'fs';
import * as path from 'path';

const CPB_PATH = path.resolve(
  __dirname,
  '../../../src/services/context-pack-builder.ts',
);

const cpbSrc = fs.readFileSync(CPB_PATH, 'utf8');

// Strip ONLY line comments (`// ...`) and block comments (`/* ... */`),
// being careful not to chew real code:
//   - Block comments are matched lazily (`/\*[\s\S]*?\*\//`) so we don't
//     eat across the file.
//   - Line comments are anchored to the start-of-line or preceded by
//     whitespace (`(^|\s)//[^\n]*`) so `://` inside URL string literals
//     (`https://...`) and forward slashes inside import paths
//     (`../../lib/x`) are NOT consumed.
function stripCommentsSafely(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

const cpbCode = stripCommentsSafely(cpbSrc);

describe('VTID-03145 PR 2 ContextPackBuilder DIARY + NETWORK boundary', () => {
  describe('context-pack-builder.ts has no direct reads to the four migrated tables', () => {
    it('does not fetch from /rest/v1/memory_diary_entries', () => {
      // Catches both `${SUPABASE_URL}/rest/v1/memory_diary_entries?...`
      // and any `rest/v1/memory_diary_entries` variant.
      expect(cpbCode).not.toMatch(/rest\/v1\/memory_diary_entries/);
    });

    it('does not fetch from /rest/v1/diary_entries', () => {
      // Word-boundary-anchored so `memory_diary_entries` doesn't match.
      expect(cpbCode).not.toMatch(/rest\/v1\/diary_entries\b/);
    });

    it('does not fetch from /rest/v1/relationship_nodes', () => {
      expect(cpbCode).not.toMatch(/rest\/v1\/relationship_nodes/);
    });

    it('does not fetch from /rest/v1/relationship_edges', () => {
      expect(cpbCode).not.toMatch(/rest\/v1\/relationship_edges/);
    });

    it('does not call .from("memory_diary_entries")', () => {
      expect(cpbCode).not.toMatch(/\.from\s*\(\s*['"]memory_diary_entries['"]/);
    });

    it('does not call .from("diary_entries")', () => {
      // Distinct from memory_diary_entries.
      expect(cpbCode).not.toMatch(/\.from\s*\(\s*['"]diary_entries['"]/);
    });

    it('does not call .from("relationship_nodes")', () => {
      expect(cpbCode).not.toMatch(/\.from\s*\(\s*['"]relationship_nodes['"]/);
    });

    it('does not call .from("relationship_edges")', () => {
      expect(cpbCode).not.toMatch(/\.from\s*\(\s*['"]relationship_edges['"]/);
    });
  });

  describe('context-pack-builder.ts routes DIARY + NETWORK through memory-broker', () => {
    it('imports getMemoryContext from memory-broker', () => {
      // Either the existing dynamic import inside fetchMemoryHitsViaBroker
      // OR the new top-level import — at least one must be present.
      expect(cpbCode).toMatch(
        /(import\s*\{[^}]*\bgetMemoryContext\b[^}]*\}\s*from\s*['"]\.\/memory-broker['"]|await\s+import\s*\(\s*['"]\.\/memory-broker['"]\s*\))/,
      );
    });

    it('passes required_blocks: [\'DIARY\'] for the diary fetcher', () => {
      // The broker is the only diary source after PR 2.
      expect(cpbCode).toMatch(/required_blocks:\s*\[\s*['"]DIARY['"]\s*\]/);
    });

    it('passes required_blocks: [\'NETWORK\'] for the relationship fetcher', () => {
      expect(cpbCode).toMatch(/required_blocks:\s*\[\s*['"]NETWORK['"]\s*\]/);
    });

    it('fetchDiaryHits + fetchRelationshipContext are still exported under the same names', () => {
      expect(cpbCode).toMatch(/async\s+function\s+fetchDiaryHits\s*\(/);
      expect(cpbCode).toMatch(/async\s+function\s+fetchRelationshipContext\s*\(/);
    });
  });
});
