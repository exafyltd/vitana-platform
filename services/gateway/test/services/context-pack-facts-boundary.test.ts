// VTID-03155 — anti-regression for CPB-3 (fact-tier boundary).
//
// PR 3 moved ContextPackBuilder's direct fact-table / RPC reads into
// `memory-facts-service.ts`. The two new fetchers are
// `searchFactsSemantic` (RPC) and `listFactsByConfidence` (REST select).
//
// This test asserts the structural contract for CPB-3:
//   - `context-pack-builder.ts` must not name `memory_facts_semantic_search`
//     or `memory_facts` anywhere in its source (code OR comments). Re-
//     introducing either substring means a direct fact-tier read was
//     re-added; the audit (2026-05-22) called that boundary closed.
//   - The companion positive contract: the file must import + call the
//     two new service functions from `memory-facts-service`.

import * as fs from 'fs';
import * as path from 'path';

const CPB_PATH = path.resolve(
  __dirname,
  '../../src/services/context-pack-builder.ts',
);

describe('VTID-03155 CPB-3 fact-tier boundary — anti-regression', () => {
  let src: string;
  beforeAll(() => {
    src = fs.readFileSync(CPB_PATH, 'utf8');
  });

  describe('no direct references to fact-tier storage', () => {
    const FORBIDDEN: string[] = [
      'memory_facts_semantic_search',
      'memory_facts',
    ];
    for (const term of FORBIDDEN) {
      it(`does not mention "${term}"`, () => {
        expect(src).not.toMatch(new RegExp(term));
      });
    }
  });

  describe('positive contract — fact tiers go through memory-facts-service', () => {
    it('imports searchFactsSemantic from memory-facts-service', () => {
      expect(src).toMatch(/searchFactsSemantic/);
      expect(src).toMatch(/from\s+['"]\.\/memory-facts-service['"]/);
    });

    it('imports listFactsByConfidence from memory-facts-service', () => {
      expect(src).toMatch(/listFactsByConfidence/);
    });

    it('calls searchFactsSemantic with the lens + query', () => {
      expect(src).toMatch(/searchFactsSemantic\s*\(\s*lens\s*,\s*query/);
    });

    it('calls listFactsByConfidence with the lens + limit option', () => {
      expect(src).toMatch(/listFactsByConfidence\s*\(\s*lens\s*,\s*\{\s*limit/);
    });
  });
});
