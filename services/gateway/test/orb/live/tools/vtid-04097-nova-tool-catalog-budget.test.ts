/**
 * VTID-04097 — the tool-catalog byte budget now applies to Nova Sonic too.
 *
 * VTID-04026 introduced the guard for the Vertex Serbian bridge only, where an
 * oversized catalog was a correctness bug (1007 on the first generation
 * request). Nova accepts the full catalog, so it was explicitly left out.
 * Measured on staging 2026-09-19 (authenticated `de`, 10 trials per arm, only
 * the ORB surface — and therefore the declared catalog — changed):
 *
 *   290 decls / 221.5 KB → first model audio p50 3033 ms, p90 7502 ms
 *   134 decls /  44.5 KB → p50 2513 ms, p90 3081 ms
 *
 * i.e. on Nova it is a TAIL-LATENCY guard. These tests pin the per-provider
 * resolution and the call-site wiring, because the whole defect class here is
 * "the guard exists but is gated to one provider".
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveToolCatalogByteBudgetFor,
  resolveVertexToolCatalogByteBudget,
  enforceToolCatalogBudget,
  NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT,
  VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT,
  VERTEX_BRIDGE_PRIORITY_TOOLS,
} from '../../../../src/orb/live/tools/vertex-tool-catalog-budget';
import { buildLiveApiTools } from '../../../../src/orb/live/tools/live-tool-catalog';

const realBytes = (tools: object[]) =>
  (tools as Array<{ function_declarations?: unknown[] }>).reduce(
    (n, g) => n + (Array.isArray(g.function_declarations) ? Buffer.byteLength(JSON.stringify(g.function_declarations)) : 0),
    0,
  );
const declNames = (tools: object[]) =>
  (tools as Array<{ function_declarations?: Array<{ name?: string }> }>)
    .flatMap((g) => (Array.isArray(g.function_declarations) ? g.function_declarations : []))
    .map((d) => d.name);

describe('resolveToolCatalogByteBudgetFor', () => {
  it('gives Nova its own default budget, not zero and not the bridge env var', () => {
    const r = resolveToolCatalogByteBudgetFor('nova_sonic', {});
    expect(r.budgetBytes).toBe(NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    expect(r.envVar).toBe('NOVA_TOOL_CATALOG_BYTE_BUDGET');
  });

  it('reads NOVA_TOOL_CATALOG_BYTE_BUDGET when set', () => {
    expect(resolveToolCatalogByteBudgetFor('nova_sonic', { NOVA_TOOL_CATALOG_BYTE_BUDGET: '65536' }).budgetBytes).toBe(65536);
  });

  it('treats 0 as "disable the guard" so rollback is one env change', () => {
    expect(resolveToolCatalogByteBudgetFor('nova_sonic', { NOVA_TOOL_CATALOG_BYTE_BUDGET: '0' }).budgetBytes).toBe(0);
  });

  it('falls back to the default on a garbage value rather than disabling the guard', () => {
    expect(resolveToolCatalogByteBudgetFor('nova_sonic', { NOVA_TOOL_CATALOG_BYTE_BUDGET: 'lots' }).budgetBytes).toBe(
      NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT,
    );
  });

  it('does not let the Nova var leak into the bridge, or vice versa', () => {
    const env = { NOVA_TOOL_CATALOG_BYTE_BUDGET: '1024', VERTEX_TOOL_CATALOG_BYTE_BUDGET: '2048' };
    expect(resolveToolCatalogByteBudgetFor('nova_sonic', env).budgetBytes).toBe(1024);
    expect(resolveToolCatalogByteBudgetFor('vertex', env).budgetBytes).toBe(2048);
  });

  it('leaves the bridge resolution byte-identical to VTID-04026', () => {
    expect(resolveToolCatalogByteBudgetFor('vertex', {}).budgetBytes).toBe(VERTEX_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    expect(resolveToolCatalogByteBudgetFor('vertex', {}).budgetBytes).toBe(resolveVertexToolCatalogByteBudget({}));
  });

  it('returns no guard for the cascade and for an unresolved provider — opt-in per provider', () => {
    expect(resolveToolCatalogByteBudgetFor('cascaded', {}).budgetBytes).toBe(0);
    expect(resolveToolCatalogByteBudgetFor(null, {}).budgetBytes).toBe(0);
    expect(resolveToolCatalogByteBudgetFor(undefined, {}).budgetBytes).toBe(0);
  });
});

describe('against the real authenticated catalog, under the Nova budget', () => {
  const tools = buildLiveApiTools('authenticated', '/community', 'community', null);

  it('is over budget before trimming — the condition this VTID exists for', () => {
    expect(realBytes(tools)).toBeGreaterThan(NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
  });

  it('fits the budget after trimming', () => {
    const r = enforceToolCatalogBudget(tools, NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    expect(r.trimmed).toBe(true);
    expect(realBytes(r.tools)).toBeLessThanOrEqual(NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT);
    expect(r.declarationsAfter).toBeLessThan(r.declarationsBefore);
  });

  it('keeps navigation and end_conversation — losing those would break the session, not just slow it', () => {
    const kept = new Set(declNames(enforceToolCatalogBudget(tools, NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT).tools));
    const present = new Set(declNames(tools));
    for (const name of ['navigate', 'get_current_screen', 'end_conversation']) {
      if (present.has(name)) expect(kept.has(name)).toBe(true);
    }
  });

  it('keeps every priority tool the untrimmed catalog actually had', () => {
    const present = new Set(declNames(tools));
    const kept = new Set(declNames(enforceToolCatalogBudget(tools, NOVA_TOOL_CATALOG_BYTE_BUDGET_DEFAULT).tools));
    for (const name of VERTEX_BRIDGE_PRIORITY_TOOLS) {
      if (present.has(name)) expect(kept.has(name)).toBe(true);
    }
  });
});

describe('orb-live.ts wiring', () => {
  const src = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

  it('no longer gates the budget block on the Vertex provider', () => {
    expect(src).not.toContain("if (session.upstreamProvider === 'vertex') {\n        try {\n          const toolBudget");
    expect(src).toContain('resolveToolCatalogByteBudgetFor(session.upstreamProvider)');
  });

  it('runs the trim BEFORE the Nova branch reads setup.tools — otherwise Nova gets the untrimmed array', () => {
    const trimAt = src.indexOf('enforceToolCatalogBudget(toolsIn, toolBudget)');
    const novaReadAt = src.indexOf('novaTools = Array.isArray(setup.tools)');
    expect(trimAt).toBeGreaterThan(-1);
    expect(novaReadAt).toBeGreaterThan(-1);
    expect(trimAt).toBeLessThan(novaReadAt);
  });

  it('resolves the provider before the trim runs', () => {
    const assignAt = src.indexOf('session.upstreamProvider = __upstreamDecision.provider');
    const trimAt = src.indexOf('resolveToolCatalogByteBudgetFor(session.upstreamProvider)');
    expect(assignAt).toBeGreaterThan(-1);
    expect(assignAt).toBeLessThan(trimAt);
  });

  it('emits a provider-neutral trim diag and keeps the bridge one for existing queries', () => {
    expect(src).toContain("emitDiag(session, 'tool_catalog_trimmed'");
    expect(src).toContain("emitDiag(session, 'vertex_tool_catalog_trimmed', _budgetDiag)");
  });
});
