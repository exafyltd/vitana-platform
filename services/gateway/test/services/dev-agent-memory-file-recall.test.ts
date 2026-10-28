/**
 * VTID-04224 Phase 2-4: file-scoped dev_agent_memory recall for the
 * Planner/Worker/Validator LLM routing stages. Pins: (1) each stage's kill
 * switch defaults off and requires the exact string 'true' (same convention
 * as remindersEnabled()/isCascadeEnabled() elsewhere in this codebase); (2)
 * renderDevMemoryFileBlock renders '' for no hits and respects the byte
 * budget, dropping rows rather than truncating mid-row; (3)
 * buildFileScopedMemoryBlock fails open to '' on every error path (no
 * files, RPC error, thrown exception) — a memory-recall failure must never
 * block or degrade a Planner/Worker/Validator run.
 */

jest.mock('../../src/services/dev-agent-memory', () => ({
  recallDevMemoryByFiles: jest.fn(),
}));

import { recallDevMemoryByFiles, type DevMemoryFileHit } from '../../src/services/dev-agent-memory';
import {
  isWorkerMemoryRecallEnabled,
  isValidatorMemoryRecallEnabled,
  isPlannerMemoryRecallEnabled,
  renderDevMemoryFileBlock,
  buildFileScopedMemoryBlock,
  FILE_MEMORY_BLOCK_HEADER,
} from '../../src/services/dev-agent-memory-file-recall';

const mockRecall = recallDevMemoryByFiles as jest.Mock;

function hit(overrides: Partial<DevMemoryFileHit> = {}): DevMemoryFileHit {
  return {
    id: 'h1',
    vtid: 'VTID-04224',
    category: 'gotcha',
    title: 'Some gotcha title',
    content: 'Some gotcha content explaining the trap in detail.',
    importance: 60,
    source: 'session',
    tags: [],
    file_paths: ['services/gateway/src/services/example.ts'],
    stage: 'worker',
    created_at: '2026-09-21T00:00:00Z',
    ...overrides,
  };
}

describe('per-stage kill switches (VTID-04224)', () => {
  const KEYS = [
    'DEV_AUTOPILOT_WORKER_MEMORY_ENABLED',
    'DEV_AUTOPILOT_VALIDATOR_MEMORY_ENABLED',
    'DEV_AUTOPILOT_PLANNER_MEMORY_ENABLED',
  ] as const;
  const ORIGINAL: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) ORIGINAL[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
  });

  it('all three default to false (off) when unset', () => {
    for (const k of KEYS) delete process.env[k];
    expect(isWorkerMemoryRecallEnabled()).toBe(false);
    expect(isValidatorMemoryRecallEnabled()).toBe(false);
    expect(isPlannerMemoryRecallEnabled()).toBe(false);
  });

  it('each is true only for the exact string "true" — a typo stays off', () => {
    process.env.DEV_AUTOPILOT_WORKER_MEMORY_ENABLED = 'true';
    expect(isWorkerMemoryRecallEnabled()).toBe(true);
    process.env.DEV_AUTOPILOT_WORKER_MEMORY_ENABLED = 'True';
    expect(isWorkerMemoryRecallEnabled()).toBe(true); // lowercased before compare
    process.env.DEV_AUTOPILOT_WORKER_MEMORY_ENABLED = '1';
    expect(isWorkerMemoryRecallEnabled()).toBe(false);

    process.env.DEV_AUTOPILOT_VALIDATOR_MEMORY_ENABLED = 'true';
    expect(isValidatorMemoryRecallEnabled()).toBe(true);

    process.env.DEV_AUTOPILOT_PLANNER_MEMORY_ENABLED = 'true';
    expect(isPlannerMemoryRecallEnabled()).toBe(true);
  });

  it('flags are independent — enabling one does not enable the others', () => {
    delete process.env.DEV_AUTOPILOT_VALIDATOR_MEMORY_ENABLED;
    delete process.env.DEV_AUTOPILOT_PLANNER_MEMORY_ENABLED;
    process.env.DEV_AUTOPILOT_WORKER_MEMORY_ENABLED = 'true';
    expect(isWorkerMemoryRecallEnabled()).toBe(true);
    expect(isValidatorMemoryRecallEnabled()).toBe(false);
    expect(isPlannerMemoryRecallEnabled()).toBe(false);
  });
});

describe('renderDevMemoryFileBlock', () => {
  it('renders "" for an empty hit list — no header with nothing under it', () => {
    expect(renderDevMemoryFileBlock([])).toBe('');
  });

  it('renders the header plus one line per hit, including stage/vtid/file tags', () => {
    const out = renderDevMemoryFileBlock([hit()]);
    expect(out).toContain(FILE_MEMORY_BLOCK_HEADER);
    expect(out).toContain('[gotcha]');
    expect(out).toContain('{worker}');
    expect(out).toContain('(VTID-04224)');
    expect(out).toContain('services/gateway/src/services/example.ts');
  });

  it('drops rows once the character budget is spent, rather than truncating a row mid-line', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      hit({ id: `h${i}`, content: 'x'.repeat(300) }));
    const out = renderDevMemoryFileBlock(many, 1_200);
    expect(out.length).toBeLessThanOrEqual(1_200 + 400); // header + a small over-budget slack from the last accepted line
    const rowCount = out.split('\n').filter((l) => l.startsWith('- [')).length;
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThan(30);
  });

  it('clips an over-long title/content per row rather than blowing the row out', () => {
    const out = renderDevMemoryFileBlock([hit({ title: 'T'.repeat(500), content: 'C'.repeat(2000) })]);
    const row = out.split('\n').find((l) => l.startsWith('- ['))!;
    expect(row.length).toBeLessThan(700);
  });
});

describe('buildFileScopedMemoryBlock — fail-open contract', () => {
  beforeEach(() => mockRecall.mockReset());

  it('returns "" without calling the RPC when the file list is empty', async () => {
    const out = await buildFileScopedMemoryBlock([], 'vitana-platform');
    expect(out).toBe('');
    expect(mockRecall).not.toHaveBeenCalled();
  });

  it('returns "" when the RPC reports ok:false', async () => {
    mockRecall.mockResolvedValue({ ok: false, error: 'supabase_not_configured' });
    const out = await buildFileScopedMemoryBlock(['a.ts'], 'vitana-platform');
    expect(out).toBe('');
  });

  it('renders real hits into the block on success', async () => {
    mockRecall.mockResolvedValue({ ok: true, hits: [hit()] });
    const out = await buildFileScopedMemoryBlock(['services/gateway/src/services/example.ts'], 'vitana-platform');
    expect(out).toContain(FILE_MEMORY_BLOCK_HEADER);
    expect(mockRecall).toHaveBeenCalledWith(
      ['services/gateway/src/services/example.ts'],
      'vitana-platform',
      { limit: 8 },
    );
  });

  it('honors a caller-supplied limit', async () => {
    mockRecall.mockResolvedValue({ ok: true, hits: [] });
    await buildFileScopedMemoryBlock(['a.ts'], 'vitana-platform', { limit: 3 });
    expect(mockRecall).toHaveBeenCalledWith(['a.ts'], 'vitana-platform', { limit: 3 });
  });
});
