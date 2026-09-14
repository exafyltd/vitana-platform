/**
 * VTID-03843 — a self-heal child execution inherits the parent's on-ramp
 * LLM override.
 *
 * Background: VTID-03820 stamps `metadata.llm_on_ramp` +
 * `metadata.llm_on_ramp_override` onto an operator-triggered execution so
 * runExecutionSession() routes the worker call at the requested
 * provider/model. When that execution fails and the bridge spawns a retry
 * child (spawnChildExecution), the child row was inserted with a fresh
 * metadata object that carried none of the parent's override — so the retry
 * silently ran on the worker policy model instead. Observed live on staging
 * 2026-09-13 (child fb3d86f8 of on-ramp execution beeb2c55).
 *
 * These tests drive the REAL spawnChildExecution() through a fetch mock and
 * inspect the exact INSERT body, so a regression in what is copied (or a
 * future "just spread the whole parent metadata" change that would leak the
 * parent's `source`) fails here.
 */

import {
  spawnChildExecution,
  inheritedOnRampMetadata,
} from '../src/services/dev-autopilot-bridge';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event' }),
}));

jest.mock('../src/services/self-healing-triage-service', () => ({
  spawnTriageAgent: jest.fn(),
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const SUPA = { url: 'https://supa.test', key: 'service-role-key' };

const REPORT = {
  session_id: 'triage-sess-1',
  confidence: 'high',
  confidence_numeric: 0.9,
  root_cause: 'x',
  summary: 'y',
} as unknown as Parameters<typeof spawnChildExecution>[2];

function parentRow(metadata: Record<string, unknown> | null | undefined) {
  return {
    id: 'beeb2c55-0000-4000-8000-000000000001',
    finding_id: 'finding-0000-4000-8000-000000000001',
    plan_version: 1,
    status: 'failed',
    auto_fix_depth: 0,
    metadata,
  } as unknown as Parameters<typeof spawnChildExecution>[1];
}

async function captureInsertBody(metadata: Record<string, unknown> | null | undefined) {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 201,
    text: async () => '',
    json: async () => null,
  } as Response);

  const res = await spawnChildExecution(SUPA, parentRow(metadata), REPORT, 5);
  expect(res.ok).toBe(true);

  const insert = fetchMock.mock.calls.find(
    ([url, init]) =>
      typeof url === 'string' &&
      url.includes('/rest/v1/dev_autopilot_executions') &&
      (init as RequestInit)?.method === 'POST',
  );
  expect(insert).toBeDefined();
  return JSON.parse(String((insert![1] as RequestInit).body)) as Record<string, unknown>;
}

const ON_RAMP_OVERRIDE = { provider: 'deepseek', model: 'deepseek-flash' };

describe('VTID-03843 — spawnChildExecution inherits on-ramp override', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = SUPA.url;
    process.env.SUPABASE_SERVICE_ROLE = SUPA.key;
  });

  it('copies llm_on_ramp and llm_on_ramp_override from the parent metadata verbatim', async () => {
    const body = await captureInsertBody({
      llm_on_ramp: 'deepseek',
      llm_on_ramp_override: ON_RAMP_OVERRIDE,
      triggered_by: 'operator-chat:thread-1',
      source: 'operator-onramp',
    });
    const meta = body.metadata as Record<string, unknown>;
    expect(meta.llm_on_ramp).toBe('deepseek');
    expect(meta.llm_on_ramp_override).toEqual(ON_RAMP_OVERRIDE);
  });

  it('keeps the bridge identity fields — the parent source never leaks into the child', async () => {
    const body = await captureInsertBody({
      llm_on_ramp: 'deepseek',
      llm_on_ramp_override: ON_RAMP_OVERRIDE,
      source: 'operator-onramp',
      triggered_by: 'operator-chat:thread-1',
      bridge_stage: 'ci',
      merge_sha: 'deadbeef',
    });
    const meta = body.metadata as Record<string, unknown>;
    expect(meta.source).toBe('dev-autopilot-bridge');
    expect(meta.parent_execution_id).toBe('beeb2c55-0000-4000-8000-000000000001');
    expect(meta.triage_session_id).toBe('triage-sess-1');
    expect(meta.triage_confidence).toBe('high');
    // Only the two on-ramp keys are inherited — nothing else from the parent.
    expect(meta).not.toHaveProperty('triggered_by');
    expect(meta).not.toHaveProperty('bridge_stage');
    expect(meta).not.toHaveProperty('merge_sha');
    expect(Object.keys(meta).sort()).toEqual([
      'llm_on_ramp',
      'llm_on_ramp_override',
      'parent_execution_id',
      'source',
      'triage_confidence',
      'triage_session_id',
    ]);
  });

  it('a child of an autonomous (non-on-ramp) parent carries no override keys — self-healing path byte-identical', async () => {
    const body = await captureInsertBody({ source: 'dev-autopilot', scanner: 'x' });
    const meta = body.metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty('llm_on_ramp');
    expect(meta).not.toHaveProperty('llm_on_ramp_override');
    expect(Object.keys(meta).sort()).toEqual([
      'parent_execution_id',
      'source',
      'triage_confidence',
      'triage_session_id',
    ]);
  });

  it('a parent with null metadata still spawns cleanly', async () => {
    const body = await captureInsertBody(null);
    const meta = body.metadata as Record<string, unknown>;
    expect(meta.source).toBe('dev-autopilot-bridge');
    expect(meta).not.toHaveProperty('llm_on_ramp_override');
  });
});

describe('VTID-03843 — inheritedOnRampMetadata (pure)', () => {
  it('returns {} for null/undefined/non-object input', () => {
    expect(inheritedOnRampMetadata(null)).toEqual({});
    expect(inheritedOnRampMetadata(undefined)).toEqual({});
    expect(inheritedOnRampMetadata('nope' as unknown as Record<string, unknown>)).toEqual({});
  });

  it('drops a malformed override (array / string / empty on-ramp) instead of forwarding junk', () => {
    expect(inheritedOnRampMetadata({ llm_on_ramp_override: ['deepseek'] })).toEqual({});
    expect(inheritedOnRampMetadata({ llm_on_ramp_override: 'deepseek' })).toEqual({});
    expect(inheritedOnRampMetadata({ llm_on_ramp: '' })).toEqual({});
    expect(inheritedOnRampMetadata({ llm_on_ramp: 42 })).toEqual({});
  });

  it('forwards a well-formed override object as-is (extractLlmOnRampOverride validates the shape downstream)', () => {
    expect(
      inheritedOnRampMetadata({ llm_on_ramp: 'deepseek', llm_on_ramp_override: ON_RAMP_OVERRIDE, other: 1 }),
    ).toEqual({ llm_on_ramp: 'deepseek', llm_on_ramp_override: ON_RAMP_OVERRIDE });
  });
});
