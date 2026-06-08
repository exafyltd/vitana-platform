// VTID-03153 — anti-regression closeout for VTID-03145 (PR #2313),
// which routed the DIARY and NETWORK blocks in context-pack-builder.ts
// through the memory-broker boundary instead of raw Supabase fetches.
//
// This test asserts the structural contract for CPB-4 + CPB-5:
// `context-pack-builder.ts` may not name the four canonical broker-
// owned tables anywhere in its source (code OR comments). Even in
// comments, those strings are a tripwire for someone copy-pasting an
// old direct-read block back in. Adding them must be an explicit
// audit decision, not an accident.
//
// Forbidden substrings:
//   - memory_diary_entries
//   - diary_entries
//   - relationship_nodes
//   - relationship_edges
//
// Companion positive contract: the file must continue to use
// `getMemoryContext({ required_blocks: ['DIARY' | 'NETWORK'] })` for
// these blocks. That import + call shape is the broker boundary.

import * as fs from 'fs';
import * as path from 'path';

const CPB_PATH = path.resolve(
  __dirname,
  '../../src/services/context-pack-builder.ts',
);

describe('VTID-03153 CPB-4/5 broker boundary — anti-regression', () => {
  let src: string;
  beforeAll(() => {
    src = fs.readFileSync(CPB_PATH, 'utf8');
  });

  describe('no direct references to broker-owned tables', () => {
    // These are the four substrings the audit (2026-05-22) flagged.
    // Re-introducing any of them in context-pack-builder.ts means the
    // file is reading a table the memory-broker owns — i.e. the
    // boundary has been re-broken.
    const FORBIDDEN: string[] = [
      'memory_diary_entries',
      'diary_entries',
      'relationship_nodes',
      'relationship_edges',
    ];

    for (const term of FORBIDDEN) {
      it(`does not mention "${term}"`, () => {
        expect(src).not.toMatch(new RegExp(term));
      });
    }
  });

  describe('positive contract — DIARY and NETWORK go through getMemoryContext', () => {
    it('imports getMemoryContext from memory-broker', () => {
      expect(src).toMatch(/from\s+['"]\.\/memory-broker['"]/);
      expect(src).toMatch(/getMemoryContext/);
    });

    it('requests the DIARY block via required_blocks', () => {
      expect(src).toMatch(/required_blocks\s*:\s*\[\s*['"]DIARY['"]\s*\]/);
    });

    it('requests the NETWORK block via required_blocks', () => {
      expect(src).toMatch(/required_blocks\s*:\s*\[\s*['"]NETWORK['"]\s*\]/);
    });

    it('imports DiaryBlock and NetworkBlock types', () => {
      expect(src).toMatch(/DiaryBlock/);
      expect(src).toMatch(/NetworkBlock/);
    });
  });
});
