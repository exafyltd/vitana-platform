/**
 * VTID-04426 (Plan v1 WS-3.4) — tool choice per session: a context-aware fill
 * order for the catalog budget, and find_tool / use_tool to reach what the
 * budget dropped (the tool list is fixed per Nova stream — VTID-04424).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { buildLiveApiTools } from '../../../../src/orb/live/tools/live-tool-catalog';
import {
  enforceToolCatalogBudget,
  FLAG_GATED_PRIORITY_TOOLS,
  NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT,
  VERTEX_BRIDGE_PRIORITY_TOOLS,
  VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT,
} from '../../../../src/orb/live/tools/vertex-tool-catalog-budget';
import {
  buildSessionToolPriority,
  deferredDeclarationMap,
  FIND_TOOL_NAME,
  isToolSelectionEnabled,
  resolveUseTool,
  routeToolGroups,
  runFindTool,
  searchDeferredTools,
  USE_TOOL_NAME,
  withMetaTools,
} from '../../../../src/orb/live/tools/session-tool-selection';

const BASE = [...VERTEX_BRIDGE_PRIORITY_TOOLS, ...FLAG_GATED_PRIORITY_TOOLS];
const names = (tools: object[]) =>
  (tools as Array<{ function_declarations?: Array<{ name: string }> }>).flatMap((g) => (g.function_declarations ?? []).map((d) => d.name));

function select(route: string, budget = NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT) {
  const catalog = buildLiveApiTools('authenticated', route, 'community', null) as object[];
  const sel = buildSessionToolPriority(catalog, BASE, route);
  const result = enforceToolCatalogBudget(withMetaTools(catalog), budget, sel.priority);
  return { catalog, sel, result, declared: new Set(names(result.tools)), deferred: deferredDeclarationMap(catalog, result.dropped) };
}

describe('the flag', () => {
  it('is on only for the exact string true', () => {
    expect(isToolSelectionEnabled({ ORB_TOOL_SELECTION_ENABLED: 'true' })).toBe(true);
    for (const v of [undefined, '', 'TRUE', '1', 'yes', 'false']) expect(isToolSelectionEnabled({ ORB_TOOL_SELECTION_ENABLED: v })).toBe(false);
  });
});

describe('routeToolGroups', () => {
  it('maps the screen to tool groups by its first segments', () => {
    expect(routeToolGroups('/wallet/transactions')).toEqual(['wallet']);
    expect(routeToolGroups('/health?tab=labs')).toEqual(['health']);
    expect(routeToolGroups('/events')).toEqual(['events']);
    expect(routeToolGroups('/')).toEqual([]);
    expect(routeToolGroups(null)).toEqual([]);
  });
});

describe('selection against the real signed-in catalog and the Nova budget', () => {
  it('keeps the meta tools, every base priority tool and get_next_best_action, within the same budget', () => {
    const { catalog, result, declared } = select('/community');
    expect(result.trimmed).toBe(true);
    expect(result.bytesAfter).toBeLessThanOrEqual(NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    expect(declared.has(FIND_TOOL_NAME) && declared.has(USE_TOOL_NAME)).toBe(true);
    const inCatalog = new Set(names(catalog));
    for (const n of VERTEX_BRIDGE_PRIORITY_TOOLS) if (inCatalog.has(n)) expect(declared).toContain(n);
    expect(declared).toContain('get_next_best_action');
  });

  it("puts the current screen's tools in", () => {
    const wallet = select('/wallet');
    expect(wallet.sel.groups).toEqual(['wallet']);
    for (const n of ['get_wallet_balance', 'get_wallet_summary', 'list_wallet_transactions']) expect(wallet.declared).toContain(n);
    const community = select('/community');
    expect(community.declared.has('get_wallet_balance')).toBe(false);
    const health = select('/health');
    for (const n of ['log_meal', 'log_mood', 'get_lab_results']) expect(health.declared).toContain(n);
  });

  it('every dropped tool stays reachable, and declared + deferred cover the whole catalog', () => {
    const { catalog, declared, deferred } = select('/wallet');
    const all = names(catalog);
    for (const n of all) expect(declared.has(n) || deferred.has(n)).toBe(true);
    for (const n of deferred.keys()) expect(declared.has(n)).toBe(false);
    expect(deferred.size).toBeGreaterThan(100);
  });

  it('also fits the Vertex bridge budget with the meta tools declared', () => {
    const { result, declared } = select('/community', VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    expect(result.bytesAfter).toBeLessThanOrEqual(VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    expect(declared.has(FIND_TOOL_NAME) && declared.has(USE_TOOL_NAME)).toBe(true);
  });
});

describe('find_tool', () => {
  const { deferred } = select('/community');

  it('finds the right tool for plain English queries', () => {
    expect(searchDeferredTools(deferred, 'wallet balance')[0].name).toBe('get_wallet_balance');
    expect(searchDeferredTools(deferred, 'log a meal')[0].name).toBe('log_meal');
    expect(searchDeferredTools(deferred, 'diary streak')[0].name).toBe('get_diary_streak');
  });

  it('returns names, bounded descriptions and parameters; handles no match and nothing deferred', () => {
    const r = JSON.parse(runFindTool(deferred, { query: 'order status' }).result);
    expect(r.tools.length).toBeGreaterThan(0);
    expect(r.tools.length).toBeLessThanOrEqual(6);
    expect(r.tools[0]).toEqual(expect.objectContaining({ name: expect.any(String), description: expect.any(String), parameters: expect.anything() }));
    expect(r.tools.every((t: { description: string }) => t.description.length <= 300)).toBe(true);
    expect(JSON.parse(runFindTool(deferred, { query: 'zzzz qqqq' }).result).tools).toEqual([]);
    expect(JSON.parse(runFindTool(new Map(), { query: 'wallet' }).result).tools).toEqual([]);
  });
});

describe('use_tool', () => {
  const { deferred, declared } = select('/community');

  it('resolves a deferred tool with parsed arguments', () => {
    expect(resolveUseTool(deferred, declared, { name: 'get_wallet_balance', arguments_json: '{"currency":"EUR"}' }))
      .toEqual({ ok: true, name: 'get_wallet_balance', args: { currency: 'EUR' } });
    expect(resolveUseTool(deferred, declared, { name: 'get_wallet_balance' })).toEqual({ ok: true, name: 'get_wallet_balance', args: {} });
  });

  it('refuses directly declared tools, unknown tools, itself, and bad arguments', () => {
    const err = (a: Record<string, unknown>) => {
      const r = resolveUseTool(deferred, declared, a);
      return r.ok ? null : r.result.error;
    };
    expect(err({ name: 'navigate' })).toMatch(/call navigate directly/);
    expect(err({ name: 'drop_database' })).toMatch(/not available/);
    expect(err({ name: 'use_tool' })).toMatch(/cannot run/);
    expect(err({})).toMatch(/exact tool name/);
    expect(err({ name: 'get_wallet_balance', arguments_json: '[1]' })).toMatch(/JSON object/);
    expect(err({ name: 'get_wallet_balance', arguments_json: '{bad' })).toMatch(/not valid JSON/);
  });
});

describe('wiring', () => {
  const src = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

  it('selection runs only when the budget trims and the flag is on, and never loses the meta tools', () => {
    expect(src).toMatch(/if \(toolResult\.trimmed && isToolSelectionEnabled\(\)\) \{/);
    expect(src).toMatch(/if \(declared\.has\(FIND_TOOL_NAME\) && declared\.has\(USE_TOOL_NAME\)\) \{/);
    expect(src).toMatch(/session\.deferredTools = deferredDeclarationMap\(toolsIn, selected\.dropped\)/);
  });

  it('find_tool and use_tool are handled first, and use_tool re-enters the normal dispatcher', () => {
    const i = src.indexOf('if (toolName === FIND_TOOL_NAME) {');
    const j = src.indexOf("markVoiceLatency(session, 'tool_dispatch'");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
    expect(src).toMatch(/return executeLiveApiTool\(session, u\.name, u\.args\);/);
  });

  it('is pinned on staging only', () => {
    const wf = (f: string) => readFileSync(join(__dirname, '../../../../../../.github/workflows', f), 'utf8');
    expect(wf('AWS-STAGE-DEPLOY-GATEWAY.yml')).toMatch(/\{name:"ORB_TOOL_SELECTION_ENABLED", value:"true"\}/);
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toMatch(/ORB_TOOL_SELECTION_ENABLED/);
  });
});

describe('the brain inspector', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { summarizeSessionEvents } = require('../../../../src/services/conversation/session-brain-inspector');
  const SID = 'live-4426';
  const row = (stage: string, extra: Record<string, unknown>, s = 1) => ({
    topic: 'orb.live.diag', created_at: new Date(Date.UTC(2026, 8, 23, 12, 0, s)).toISOString(), metadata: { session_id: SID, stage, ...extra },
  });

  it('shows the selection and the tools reached through find_tool / use_tool', () => {
    const s = summarizeSessionEvents(SID, [
      row('tool_catalog_trimmed', { bytes_before: 226803, bytes_after: 65400, dropped_count: 240, provider: 'nova_sonic', selection: 'context', route_groups: ['wallet'], contextual_kept: 4, deferred_reachable: 240 }, 1),
      row('deferred_tool_search', { results: 3 }, 2),
      row('deferred_tool_used', { tool: 'get_wallet_balance' }, 3),
    ]);
    expect(s.tools).toMatchObject({
      bytes_after: 65400, provider: 'nova_sonic', route_groups: ['wallet'], contextual_kept: 4, deferred_reachable: 240,
      searches: 1, deferred_used: ['get_wallet_balance'],
    });
  });

  it('without selection the tools summary is unchanged', () => {
    const s = summarizeSessionEvents(SID, [row('tool_catalog_trimmed', { bytes_before: 10, bytes_after: 5, dropped_count: 1, provider: 'vertex' })]);
    expect(s.tools).toEqual({ bytes_before: 10, bytes_after: 5, dropped_count: 1, provider: 'vertex' });
  });
});

describe('find_tool relevance', () => {
  it('one incidental word is not a match', () => {
    const { deferred } = select('/wallet');
    expect(searchDeferredTools(deferred, 'wallet transactions last week').map((t) => t.name)).not.toContain('reorder_last_order');
    expect(searchDeferredTools(deferred, 'log a meal')[0].name).toBe('log_meal');
  });
});
