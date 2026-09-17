/**
 * VTID-04026 — byte budget for the tool catalog the Vertex Serbian bridge
 * declares. Pure helper → network-free coverage; plus one test against the
 * REAL authenticated catalog so the default budget is checked against what
 * production actually declares, not a synthetic fixture.
 */
import {
  enforceToolCatalogBudget,
  resolveVertexToolCatalogByteBudget,
  toolCatalogDeclarationBytes,
  toolCatalogDeclarationCount,
  VERTEX_BRIDGE_PRIORITY_TOOLS,
  VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT,
  VERTEX_TOOL_CATALOG_BYTE_BUDGET_ENV,
} from '../../../../src/orb/live/tools/vertex-tool-catalog-budget';
import { buildLiveApiTools } from '../../../../src/orb/live/tools/live-tool-catalog';
import { readFileSync } from 'fs';
import { join } from 'path';

const decl = (name: string, pad = 0) => ({
  name,
  description: 'x'.repeat(pad),
  parameters: { type: 'object', properties: {} },
});
const names = (tools: object[]): string[] =>
  (tools as Array<{ function_declarations?: Array<{ name: string }> }>).flatMap((g) =>
    Array.isArray(g.function_declarations) ? g.function_declarations.map((d) => d.name) : [],
  );
const realBytes = (tools: object[]): number =>
  (tools as Array<{ function_declarations?: unknown }>).reduce(
    (n, g) => n + (Array.isArray(g.function_declarations) ? Buffer.byteLength(JSON.stringify(g.function_declarations)) : 0),
    0,
  );

describe('resolveVertexToolCatalogByteBudget', () => {
  test('unset → default', () => {
    expect(resolveVertexToolCatalogByteBudget({})).toBe(VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
  });
  test('garbage → default (a typo must not silently disable the guard)', () => {
    expect(resolveVertexToolCatalogByteBudget({ [VERTEX_TOOL_CATALOG_BYTE_BUDGET_ENV]: 'lots' })).toBe(
      VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT,
    );
  });
  test('explicit number wins; 0 / negative disable', () => {
    expect(resolveVertexToolCatalogByteBudget({ [VERTEX_TOOL_CATALOG_BYTE_BUDGET_ENV]: '65536' })).toBe(65536);
    expect(resolveVertexToolCatalogByteBudget({ [VERTEX_TOOL_CATALOG_BYTE_BUDGET_ENV]: '0' })).toBe(0);
    expect(resolveVertexToolCatalogByteBudget({ [VERTEX_TOOL_CATALOG_BYTE_BUDGET_ENV]: '-5' })).toBe(0);
  });
});

describe('enforceToolCatalogBudget', () => {
  test('under budget → same array instance, nothing dropped', () => {
    const tools = [{ function_declarations: [decl('a'), decl('b')] }, { google_search: {} }];
    const r = enforceToolCatalogBudget(tools, 10_000);
    expect(r.trimmed).toBe(false);
    expect(r.tools).toBe(tools);
    expect(r.dropped).toEqual([]);
    expect(r.bytesAfter).toBe(r.bytesBefore);
  });
  test('budget 0 disables — input returned untouched even when huge', () => {
    const tools = [{ function_declarations: [decl('a', 5000)] }];
    expect(enforceToolCatalogBudget(tools, 0).tools).toBe(tools);
  });
  test('over budget: priority tools kept first, remainder first-fit in catalog order, real JSON ≤ budget', () => {
    const tools = [
      { function_declarations: [decl('z_big', 900), decl('nav', 100), decl('m1', 100), decl('m2', 100), decl('end', 100), decl('m3', 100)] },
      { google_search: {} },
    ];
    const budget = 800;
    const r = enforceToolCatalogBudget(tools, budget, ['end', 'nav']);
    expect(r.trimmed).toBe(true);
    const kept = names(r.tools);
    expect(kept).toEqual(expect.arrayContaining(['nav', 'end']));
    expect(kept).not.toContain('z_big');
    // catalog order preserved for what survives
    expect(kept).toEqual(kept.slice().sort((a, b) => names(tools).indexOf(a) - names(tools).indexOf(b)));
    expect(r.bytesAfter).toBe(realBytes(r.tools));
    expect(r.bytesAfter).toBeLessThanOrEqual(budget);
    expect(r.dropped).toContain('z_big');
    expect(r.declarationsAfter).toBe(kept.length);
    // grounding group untouched
    expect(r.tools[r.tools.length - 1]).toEqual({ google_search: {} });
  });
  test('never mutates the input', () => {
    const tools = [{ function_declarations: [decl('a', 600), decl('b', 600)] }];
    const snapshot = JSON.stringify(tools);
    enforceToolCatalogBudget(tools, 700);
    expect(JSON.stringify(tools)).toBe(snapshot);
  });
  test('accounting helpers agree with real JSON size', () => {
    const tools = [{ function_declarations: [decl('a', 10), decl('b', 20)] }, { google_search: {} }];
    expect(toolCatalogDeclarationBytes(tools)).toBe(realBytes(tools));
    expect(toolCatalogDeclarationCount(tools)).toBe(2);
  });
});

describe('against the real catalog', () => {
  test('anonymous catalog is already under budget — untouched', () => {
    const tools = buildLiveApiTools('anonymous', '/community', undefined, null);
    const r = enforceToolCatalogBudget(tools, VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    expect(r.trimmed).toBe(false);
    expect(r.tools).toBe(tools);
  });
  test('authenticated community catalog is far over budget and is trimmed to fit, keeping the essentials', () => {
    const tools = buildLiveApiTools('authenticated', '/community', 'community', null);
    const before = toolCatalogDeclarationBytes(tools);
    expect(before).toBeGreaterThan(VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT * 3); // the measured 226 KB shape
    const r = enforceToolCatalogBudget(tools, VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    expect(r.trimmed).toBe(true);
    expect(realBytes(r.tools)).toBeLessThanOrEqual(VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    const kept = names(r.tools);
    for (const essential of ['get_current_screen', 'navigate', 'navigate_to_screen', 'end_conversation', 'search_knowledge', 'search_memory', 'narrate_guided_session', 'end_guided_topic_teaching', 'set_reminder', 'save_diary_entry']) {
      expect(kept).toContain(essential);
    }
    expect(r.declarationsAfter).toBeGreaterThanOrEqual(20);
    expect(r.declarationsAfter).toBeLessThan(r.declarationsBefore);
    // grounding survives
    expect((r.tools as Array<Record<string, unknown>>).some((g) => 'google_search' in g)).toBe(true);
  });
  test('every priority name exists in the real authenticated catalog (a rename would silently demote it)', () => {
    const all = names(buildLiveApiTools('authenticated', '/community', 'community', null));
    for (const n of VERTEX_BRIDGE_PRIORITY_TOOLS) expect(all).toContain(n);
  });
});

describe('wiring (source contract)', () => {
  const src = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
  test('the guard is applied in the envelope builder ONLY for the vertex provider — never keyed on language', () => {
    const i = src.indexOf('enforceToolCatalogBudget(toolsIn, toolBudget)');
    expect(i).toBeGreaterThan(0);
    const window = src.slice(Math.max(0, i - 1500), i);
    expect(window).toContain("session.upstreamProvider === 'vertex'");
    expect(window).not.toMatch(/isVertexSerbianBridgeLanguage|lang === 'sr'/);
  });
  test('a trim is observable as an OASIS diag, not console-only', () => {
    expect(src).toContain("emitDiag(session, 'vertex_tool_catalog_trimmed'");
  });
  test('the guard runs before the NAV-DIAG tool inventory log, so that log reports what is actually sent', () => {
    expect(src.indexOf('enforceToolCatalogBudget(toolsIn, toolBudget)')).toBeLessThan(src.indexOf('[VTID-NAV-DIAG] Session'));
  });
});
