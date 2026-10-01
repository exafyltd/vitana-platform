/**
 * VTID-04413: the cascade declares the orchestrator's specialist tools when
 * the session catalog carries them, and nothing else beyond its allowlist.
 */
import { CASCADE_TOOL_ALLOWLIST, extractCascadeTools } from '../../../../src/orb/live/upstream/cascaded-live-client';
import {
  ASK_COMMERCE_SPECIALIST_TOOL,
  ASK_SUPPORT_SPECIALIST_TOOL,
  DELEGATION_COMPANION_TOOLS,
} from '../../../../src/orb/live/tools/delegation-tools';

const HANDOFF = [
  { name: 'report_to_specialist', description: 'r', parameters: { type: 'object', properties: {} } },
  { name: 'switch_persona', description: 's', parameters: { type: 'object', properties: {} } },
];

describe('VTID-04413 cascade specialist delegation tools', () => {
  test('AC-1: the allowlist names exactly the hand-off tools plus the four delegation tools', () => {
    expect([...CASCADE_TOOL_ALLOWLIST].sort()).toEqual([
      'ask_commerce_specialist',
      'ask_support_specialist',
      'cancel_delegation',
      'get_delegation_result',
      'report_to_specialist',
      'switch_persona',
    ]);
  });

  test('AC-2: the allowlisted names match the real declarations (no drift)', () => {
    for (const t of [ASK_SUPPORT_SPECIALIST_TOOL, ASK_COMMERCE_SPECIALIST_TOOL, ...DELEGATION_COMPANION_TOOLS]) {
      expect(CASCADE_TOOL_ALLOWLIST.has((t as { name: string }).name)).toBe(true);
    }
  });

  test('AC-3: a member catalog with the support tool declares it with its schema; unrelated tools stay off', () => {
    const catalog = [{
      function_declarations: [
        ...HANDOFF,
        ASK_SUPPORT_SPECIALIST_TOOL,
        ...DELEGATION_COMPANION_TOOLS,
        { name: 'navigate', description: 'n', parameters: { type: 'object', properties: {} } },
        { name: 'log_water', description: 'w', parameters: { type: 'object', properties: {} } },
      ],
    }];
    const tools = extractCascadeTools(catalog as Array<Record<string, unknown>>);
    expect(tools.map((t) => t.name)).toEqual([
      'report_to_specialist', 'switch_persona', 'ask_support_specialist', 'get_delegation_result', 'cancel_delegation',
    ]);
    const support = tools.find((t) => t.name === 'ask_support_specialist')!;
    expect(support.inputSchema).toEqual((ASK_SUPPORT_SPECIALIST_TOOL as { parameters: unknown }).parameters);
  });

  test('AC-4: when the flags leave the tools out of the catalog, the cascade declares nothing new', () => {
    const tools = extractCascadeTools([{ function_declarations: HANDOFF }] as Array<Record<string, unknown>>);
    expect(tools.map((t) => t.name)).toEqual(['report_to_specialist', 'switch_persona']);
  });
});
