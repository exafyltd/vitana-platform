/**
 * VTID-04224 Phase 2-4: each prompt builder in the Worker (agentic +
 * single-shot — the single-shot one is covered in
 * dev-autopilot-execute.test.ts), Validator and Planner stages accepts a
 * pre-rendered file-scoped dev_agent_memory block and splices it in when
 * present, and stays byte-identical to before this phase when the block is
 * '' or omitted (the flag-off / no-hits case). These builders stay pure and
 * synchronous by design — the async recall lives in
 * dev-agent-memory-file-recall.ts and is fetched by each stage's caller,
 * not by the builder itself.
 */

import { buildAgentTaskPrompt, buildFixModeTaskPrompt } from '../src/services/autopilot-agent/agent-prompt';
import { buildReviewPrompt } from '../src/services/dev-autopilot-llm-review';
import { buildPlanningPrompt } from '../src/services/dev-autopilot-planning';
import type { FindingForPlanning } from '../src/services/dev-autopilot-planning';

const MEMORY_BLOCK = '**Engineering memory for these specific files**\n\n- [gotcha] (VTID-01111) a prior trap: do not repeat it';

describe('buildAgentTaskPrompt — dev_agent_memory splice (Worker, agentic)', () => {
  const base = { vtid: 'VTID-09999', planMarkdown: '## Plan\nDo the thing.', filesReferenced: ['services/gateway/src/services/example.ts'] };

  it('includes the block when passed, on the plan-driven path', () => {
    const p = buildAgentTaskPrompt({ ...base, devMemoryBlock: MEMORY_BLOCK });
    expect(p).toContain('Engineering memory for these specific files');
    expect(p).toContain('a prior trap');
  });

  it('includes the block when passed, on the open-ended path', () => {
    const p = buildAgentTaskPrompt({ ...base, openEnded: true, devMemoryBlock: MEMORY_BLOCK });
    expect(p).toContain('Engineering memory for these specific files');
  });

  it('is byte-identical to before this phase when the block is omitted', () => {
    const withUndefined = buildAgentTaskPrompt(base);
    const withEmpty = buildAgentTaskPrompt({ ...base, devMemoryBlock: '' });
    expect(withUndefined).toBe(withEmpty);
    expect(withUndefined).not.toContain('Engineering memory for these specific files');
  });
});

describe('buildFixModeTaskPrompt — dev_agent_memory splice (Worker, agentic fix mode)', () => {
  const base = {
    vtid: 'VTID-09999', planMarkdown: '## Plan\nDo the thing.', prUrl: 'https://github.com/exafyltd/vitana-platform/pull/1',
    branch: 'dev-autopilot/abc12345', prFiles: ['services/gateway/src/services/example.ts'],
    ciEvidence: 'tsc failed: TS2345', attempt: 1, maxAttempts: 4,
  };

  it('includes the block when passed', () => {
    const p = buildFixModeTaskPrompt({ ...base, devMemoryBlock: MEMORY_BLOCK });
    expect(p).toContain('Engineering memory for these specific files');
  });

  it('is byte-identical to before this phase when the block is omitted', () => {
    const withUndefined = buildFixModeTaskPrompt(base);
    const withEmpty = buildFixModeTaskPrompt({ ...base, devMemoryBlock: '' });
    expect(withUndefined).toBe(withEmpty);
  });
});

describe('buildReviewPrompt — dev_agent_memory splice (Validator)', () => {
  it('includes the block when passed, independent of the toolsAvailable arg', () => {
    const p = buildReviewPrompt('VTID-09999', '### a.ts (modified)\n```diff\n+x\n```', false, MEMORY_BLOCK);
    expect(p).toContain('Engineering memory for these specific files');
    const withTools = buildReviewPrompt('VTID-09999', 'diff', true, MEMORY_BLOCK);
    expect(withTools).toContain('Engineering memory for these specific files');
  });

  it('is byte-identical to before this phase when the block is omitted', () => {
    const withUndefined = buildReviewPrompt('VTID-09999', 'diff', false);
    const withEmpty = buildReviewPrompt('VTID-09999', 'diff', false, '');
    expect(withUndefined).toBe(withEmpty);
    expect(withUndefined).not.toContain('Engineering memory for these specific files');
  });
});

describe('buildPlanningPrompt — dev_agent_memory splice (Planner)', () => {
  const finding: FindingForPlanning = {
    id: 'finding-1',
    title: 'Example finding',
    summary: 'Something to fix',
    domain: 'gateway',
    risk_class: 'low',
    spec_snapshot: { file_path: 'services/gateway/src/services/example.ts' },
  } as unknown as FindingForPlanning;

  it('includes the block when passed', () => {
    const p = buildPlanningPrompt(finding, undefined, undefined, undefined, undefined, undefined, undefined, MEMORY_BLOCK);
    expect(p).toContain('Engineering memory for these specific files');
  });

  it('is byte-identical to before this phase when the block is omitted', () => {
    const withUndefined = buildPlanningPrompt(finding, undefined, undefined, undefined, undefined, undefined, undefined);
    const withEmpty = buildPlanningPrompt(finding, undefined, undefined, undefined, undefined, undefined, undefined, '');
    expect(withUndefined).toBe(withEmpty);
    expect(withUndefined).not.toContain('Engineering memory for these specific files');
  });
});
