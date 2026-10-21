/**
 * A0.1 — Characterization test for buildLiveApiTools.
 *
 * Purpose: lock the current tool-catalog output as a contract before
 * step A5 extracts it into orb/live/tools/live-tool-catalog.ts.
 *
 * What this test does:
 * - Snapshots the full tool definitions for four representative
 *   (mode × currentRoute × activeRole) combinations.
 * - Asserts the *names* of registered tools per combination so a regression
 *   shows up immediately in test output, not just inside a giant snapshot.
 *
 * What this test does NOT do:
 * - Execute any tool. That is A0.1 part 2 (top-5 dispatcher shells, deferred
 *   to a follow-up commit).
 * - Verify tool descriptions for "correctness" — only stability across the
 *   refactor.
 */

import { buildLiveApiTools } from '../../../../src/routes/orb-live';

type ToolGroup = { function_declarations?: Array<{ name: string }> } | { google_search: Record<string, unknown> } | unknown;

function listToolNames(catalog: unknown[]): string[] {
  const names: string[] = [];
  for (const group of catalog as ToolGroup[]) {
    if (group && typeof group === 'object' && 'function_declarations' in group) {
      const decls = (group as { function_declarations?: Array<{ name: string }> }).function_declarations ?? [];
      for (const decl of decls) {
        if (decl && typeof decl.name === 'string') {
          names.push(decl.name);
        }
      }
    } else if (group && typeof group === 'object' && 'google_search' in group) {
      names.push('__google_search__');
    }
  }
  return names;
}

describe('A0.1 characterization: buildLiveApiTools', () => {
  describe('mode/role matrix', () => {
    it('anonymous on landing route returns no tools', () => {
      const tools = buildLiveApiTools('anonymous', '/', undefined);
      expect(tools).toEqual([]);
      expect(listToolNames(tools)).toEqual([]);
    });

    it('anonymous on /maxina (also a landing route) returns no tools', () => {
      const tools = buildLiveApiTools('anonymous', '/maxina', undefined);
      expect(tools).toEqual([]);
    });

    it('anonymous on a community route gets navigator tools only (token-expired path)', () => {
      const tools = buildLiveApiTools('anonymous', '/health', undefined);
      const names = listToolNames(tools);
      // Navigator tools must include get_current_screen + navigate at minimum.
      expect(names).toEqual(expect.arrayContaining(['get_current_screen', 'navigate']));
      // No memory / diary / health-pillar tools for an anonymous (likely
      // token-expired) session.
      expect(names).not.toContain('search_memory');
      expect(names).not.toContain('save_diary_entry');
    });

    it('authenticated community user gets the full community tool set', () => {
      const tools = buildLiveApiTools('authenticated', '/health', 'community');
      const names = listToolNames(tools);
      expect(names).toEqual(expect.arrayContaining([
        'get_current_screen',
        'navigate',
        'search_memory',
      ]));
      // google_search grounding is appended at the end.
      expect(names).toContain('__google_search__');
    });

    it('authenticated admin user gets community tools PLUS admin tools', () => {
      const community = buildLiveApiTools('authenticated', '/health', 'community');
      const admin = buildLiveApiTools('authenticated', '/health', 'admin');
      const communityNames = new Set(listToolNames(community));
      const adminNames = new Set(listToolNames(admin));

      // Every community-mode tool must still be present for admin.
      for (const name of communityNames) {
        expect(adminNames.has(name)).toBe(true);
      }
      // Admin must have AT LEAST one tool the community mode does not.
      const adminOnly = [...adminNames].filter((n) => !communityNames.has(n));
      expect(adminOnly.length).toBeGreaterThan(0);
    });
  });

  describe('snapshots', () => {
    it.each([
      { name: 'anonymous-landing', mode: 'anonymous' as const, route: '/', role: undefined },
      { name: 'anonymous-community-route', mode: 'anonymous' as const, route: '/health', role: undefined },
      { name: 'authenticated-community', mode: 'authenticated' as const, route: '/health', role: 'community' },
      { name: 'authenticated-admin', mode: 'authenticated' as const, route: '/health', role: 'admin' },
    ])('snapshots full catalog for $name', ({ name, mode, route, role }) => {
      const tools = buildLiveApiTools(mode, route, role);
      // Snapshot the full structure. The snapshot becomes the contract that
      // A5 (tool-catalog extraction) must preserve.
      expect(tools).toMatchSnapshot(`catalog:${name}`);
    });
  });
});
