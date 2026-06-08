// VTID-03158 — anti-regression for CPB-7 / CPB-8 / CPB-9.
//
// PR 5 moves the direct Supabase reads against `vtid_ledger`,
// `oasis_events`, and `autopilot_recommendations` out of
// `context-pack-builder.ts` into two typed readers:
//
//   - services/gateway/src/services/vtid-ledger-reader.ts
//       getActiveVTIDs / getDeveloperActiveTasks
//   - services/gateway/src/services/oasis-context-reader.ts
//       getDeveloperOasisContext / getCommunityOasisContext
//
// This test asserts the structural contract: CPB does not name any
// of the three tables anywhere in its source. Re-introducing any
// substring means a direct Supabase REST call slipped back in.
//
// Companion positive contract: CPB imports + calls the typed
// readers via their canonical entrypoints.

import * as fs from 'fs';
import * as path from 'path';

const CPB_PATH = path.resolve(
  __dirname,
  '../../src/services/context-pack-builder.ts',
);

describe('VTID-03158 CPB-7/8/9 OASIS + vtid-ledger boundary — anti-regression', () => {
  let src: string;
  beforeAll(() => {
    src = fs.readFileSync(CPB_PATH, 'utf8');
  });

  describe('no direct references to OASIS / ledger / autopilot tables', () => {
    const FORBIDDEN: string[] = [
      'vtid_ledger',
      'oasis_events',
      'autopilot_recommendations',
    ];
    for (const term of FORBIDDEN) {
      it(`does not mention "${term}"`, () => {
        expect(src).not.toMatch(new RegExp(term));
      });
    }
  });

  describe('positive contract — typed readers are the only path', () => {
    it('imports getActiveVTIDs from vtid-ledger-reader', () => {
      expect(src).toMatch(/from\s+['"]\.\/vtid-ledger-reader['"]/);
      expect(src).toMatch(/getActiveVTIDs/);
    });

    it('imports getDeveloperOasisContext from oasis-context-reader', () => {
      expect(src).toMatch(/from\s+['"]\.\/oasis-context-reader['"]/);
      expect(src).toMatch(/getDeveloperOasisContext/);
    });

    it('imports getCommunityOasisContext from oasis-context-reader', () => {
      expect(src).toMatch(/getCommunityOasisContext/);
    });

    it('developer branch calls getDeveloperOasisContext with the tenantId', () => {
      expect(src).toMatch(/getDeveloperOasisContext\s*\(\s*\{\s*[\s\S]*?tenantId\s*:\s*input\.lens\.tenant_id/);
    });

    it('community branch calls getCommunityOasisContext with the user_id', () => {
      expect(src).toMatch(/getCommunityOasisContext\s*\(\s*input\.lens\.user_id\s*\)/);
    });
  });
});
