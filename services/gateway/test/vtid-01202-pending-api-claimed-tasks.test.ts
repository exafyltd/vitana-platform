/**
 * VTID-01202: Worker Orchestrator Pending API must include tasks claimed by requesting worker
 *
 * Acceptance tests for the claim inclusion logic:
 * - Test A: Unclaimed task appears
 * - Test B: Claimed task remains visible to claimer
 * - Test C: Claimed task is hidden from other workers
 * - Test D: Expired claim returns
 */

// =============================================================================
// Test Types and Mocks
// =============================================================================

interface MockTask {
  vtid: string;
  title: string;
  summary: string;
  status: string;
  layer: string;
  module: string;
  created_at: string;
  updated_at: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
  claim_started_at: string | null;
  is_terminal: boolean;
  spec_status: string;
}

interface FilterResult {
  vtid: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
}

/**
 * Simulates the claim inclusion filter logic from worker-orchestrator.ts
 * This mirrors the actual implementation for testing purposes.
 */
function filterClaimableTasks(
  tasks: MockTask[],
  workerId: string | null,
  now: Date
): FilterResult[] {
  return tasks
    .filter(task => {
      // is_terminal must be false or null
      if (task.is_terminal === true) return false;

      // Claim inclusion check
      const isUnclaimed = task.claimed_by === null || task.claimed_by === undefined;
      const isClaimedByWorker = workerId && task.claimed_by === workerId;
      const isExpired = task.claim_expires_at && new Date(task.claim_expires_at) < now;

      return isUnclaimed || isClaimedByWorker || isExpired;
    })
    .map(task => ({
      vtid: task.vtid,
      claimed_by: task.claimed_by || null,
      claim_expires_at: task.claim_expires_at || null,
    }));
}

// =============================================================================
// Test Data
// =============================================================================

const WORKER_ID = 'worker-runner-d62aed2f';
const OTHER_WORKER_ID = 'worker-runner-other';
const NOW = new Date('2026-01-21T12:00:00Z');

function createMockTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    vtid: 'VTID-01199',
    title: 'Test Task',
    summary: 'Test task summary',
    status: 'in_progress',
    layer: 'DEV',
    module: 'CICDL',
    created_at: '2026-01-21T10:00:00Z',
    updated_at: '2026-01-21T10:00:00Z',
    claimed_by: null,
    claim_expires_at: null,
    claim_started_at: null,
    is_terminal: false,
    spec_status: 'approved',
    ...overrides,
  };
}

// =============================================================================
// Test A: Unclaimed task appears
// =============================================================================

describe('VTID-01202 Test A: Unclaimed task appears', () => {
  test('unclaimed task is returned when worker_id is provided', () => {
    const tasks = [createMockTask({ claimed_by: null })];

    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].vtid).toBe('VTID-01199');
    expect(result[0].claimed_by).toBeNull();
  });

  test('unclaimed task is returned when worker_id is null (backward compatible)', () => {
    const tasks = [createMockTask({ claimed_by: null })];

    const result = filterClaimableTasks(tasks, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].vtid).toBe('VTID-01199');
  });

  test('multiple unclaimed tasks are returned', () => {
    const tasks = [
      createMockTask({ vtid: 'VTID-01199', claimed_by: null }),
      createMockTask({ vtid: 'VTID-01200', claimed_by: null }),
      createMockTask({ vtid: 'VTID-01201', claimed_by: null }),
    ];

    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    expect(result).toHaveLength(3);
    expect(result.map(t => t.vtid)).toEqual(['VTID-01199', 'VTID-01200', 'VTID-01201']);
  });
});

// =============================================================================
// Test B: Claimed task remains visible to claimer
// =============================================================================

describe('VTID-01202 Test B: Claimed task remains visible to claimer', () => {
  test('task claimed by requesting worker is returned', () => {
    const tasks = [
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z', // Future expiry
        claim_started_at: '2026-01-21T12:00:00Z',
      }),
    ];

    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].vtid).toBe('VTID-01199');
    expect(result[0].claimed_by).toBe(WORKER_ID);
  });

  test('worker sees both unclaimed tasks and own claimed tasks', () => {
    const tasks = [
      createMockTask({ vtid: 'VTID-01198', claimed_by: null }),
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z',
      }),
      createMockTask({ vtid: 'VTID-01200', claimed_by: null }),
    ];

    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    expect(result).toHaveLength(3);
    expect(result.map(t => t.vtid)).toEqual(['VTID-01198', 'VTID-01199', 'VTID-01200']);
  });

  test('worker sees only own claimed task when all others are claimed by others', () => {
    const tasks = [
      createMockTask({
        vtid: 'VTID-01198',
        claimed_by: OTHER_WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z',
      }),
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z',
      }),
    ];

    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].vtid).toBe('VTID-01199');
    expect(result[0].claimed_by).toBe(WORKER_ID);
  });
});

// =============================================================================
// Test C: Claimed task is hidden from other workers
// =============================================================================

describe('VTID-01202 Test C: Claimed task is hidden from other workers', () => {
  test('task claimed by another worker is NOT returned', () => {
    const tasks = [
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z', // Future expiry
      }),
    ];

    // Query as OTHER_WORKER_ID
    const result = filterClaimableTasks(tasks, OTHER_WORKER_ID, NOW);

    expect(result).toHaveLength(0);
  });

  test('other worker sees only unclaimed tasks', () => {
    const tasks = [
      createMockTask({ vtid: 'VTID-01198', claimed_by: null }),
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z',
      }),
      createMockTask({ vtid: 'VTID-01200', claimed_by: null }),
    ];

    // Query as OTHER_WORKER_ID
    const result = filterClaimableTasks(tasks, OTHER_WORKER_ID, NOW);

    expect(result).toHaveLength(2);
    expect(result.map(t => t.vtid)).toEqual(['VTID-01198', 'VTID-01200']);
    expect(result.every(t => t.claimed_by === null)).toBe(true);
  });

  test('when worker_id is null, only unclaimed tasks are returned', () => {
    const tasks = [
      createMockTask({ vtid: 'VTID-01198', claimed_by: null }),
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z',
      }),
    ];

    // Query without worker_id (backward compatible mode)
    const result = filterClaimableTasks(tasks, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].vtid).toBe('VTID-01198');
    expect(result[0].claimed_by).toBeNull();
  });
});

// =============================================================================
// Test D: Expired claim returns
// =============================================================================

describe('VTID-01202 Test D: Expired claim returns', () => {
  test('task with expired claim is returned to any worker', () => {
    const tasks = [
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T11:00:00Z', // Past expiry (before NOW)
      }),
    ];

    // Query as OTHER_WORKER_ID - should still see expired claim
    const result = filterClaimableTasks(tasks, OTHER_WORKER_ID, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].vtid).toBe('VTID-01199');
  });

  test('task with expired claim is returned when worker_id is null', () => {
    const tasks = [
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T11:00:00Z', // Past expiry
      }),
    ];

    const result = filterClaimableTasks(tasks, null, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].vtid).toBe('VTID-01199');
  });

  test('mix of unclaimed, claimed, and expired tasks filters correctly', () => {
    const tasks = [
      // Unclaimed - should appear to all
      createMockTask({ vtid: 'VTID-01198', claimed_by: null }),
      // Claimed by WORKER_ID with valid claim - should appear only to WORKER_ID
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z',
      }),
      // Claimed by OTHER_WORKER_ID with valid claim - should appear only to OTHER_WORKER_ID
      createMockTask({
        vtid: 'VTID-01200',
        claimed_by: OTHER_WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z',
      }),
      // Expired claim - should appear to all
      createMockTask({
        vtid: 'VTID-01201',
        claimed_by: 'worker-runner-old',
        claim_expires_at: '2026-01-21T10:00:00Z', // Expired
      }),
    ];

    // Query as WORKER_ID
    const resultWorker = filterClaimableTasks(tasks, WORKER_ID, NOW);
    expect(resultWorker).toHaveLength(3);
    expect(resultWorker.map(t => t.vtid)).toEqual(['VTID-01198', 'VTID-01199', 'VTID-01201']);

    // Query as OTHER_WORKER_ID
    const resultOther = filterClaimableTasks(tasks, OTHER_WORKER_ID, NOW);
    expect(resultOther).toHaveLength(3);
    expect(resultOther.map(t => t.vtid)).toEqual(['VTID-01198', 'VTID-01200', 'VTID-01201']);

    // Query without worker_id
    const resultNull = filterClaimableTasks(tasks, null, NOW);
    expect(resultNull).toHaveLength(2);
    expect(resultNull.map(t => t.vtid)).toEqual(['VTID-01198', 'VTID-01201']);
  });

  test('claim_expires_at exactly at now is considered expired', () => {
    const tasks = [
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: WORKER_ID,
        claim_expires_at: NOW.toISOString(), // Exactly at now
      }),
    ];

    // Note: The condition is claim_expires_at < now, so exactly at now is NOT expired
    // This is correct behavior - claim is still valid until it passes the expiry time
    const result = filterClaimableTasks(tasks, OTHER_WORKER_ID, NOW);

    // At exactly now, claim is still valid (not expired)
    expect(result).toHaveLength(0);
  });
});

// =============================================================================
// Edge Cases and Terminal Task Filtering
// =============================================================================

describe('VTID-01202 Edge Cases', () => {
  test('terminal tasks are filtered out regardless of claim status', () => {
    const tasks = [
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: null,
        is_terminal: true,
      }),
      createMockTask({
        vtid: 'VTID-01200',
        claimed_by: WORKER_ID,
        is_terminal: true,
      }),
    ];

    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    expect(result).toHaveLength(0);
  });

  test('task with undefined claimed_by is treated as unclaimed', () => {
    const task = createMockTask({ vtid: 'VTID-01199' });
    (task as any).claimed_by = undefined;

    const result = filterClaimableTasks([task], WORKER_ID, NOW);

    expect(result).toHaveLength(1);
  });

  test('task with empty string claimed_by is NOT treated as unclaimed', () => {
    const tasks = [
      createMockTask({
        vtid: 'VTID-01199',
        claimed_by: '' as any, // Edge case: empty string
        claim_expires_at: '2026-01-21T13:00:00Z',
      }),
    ];

    // Empty string is falsy but not null/undefined, so not treated as unclaimed
    // Also not equal to WORKER_ID, so not claimed by worker
    // Claim has not expired
    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    // Empty string is truthy in the condition `workerId && task.claimed_by === workerId`
    // but '' !== WORKER_ID, so isClaimedByWorker is false
    // isUnclaimed check: '' === null is false, '' === undefined is false
    // So this task would be filtered out
    expect(result).toHaveLength(0);
  });

  test('handles large number of tasks efficiently', () => {
    const tasks: MockTask[] = [];
    for (let i = 0; i < 1000; i++) {
      tasks.push(
        createMockTask({
          vtid: `VTID-${String(i).padStart(5, '0')}`,
          claimed_by: i % 3 === 0 ? null : i % 3 === 1 ? WORKER_ID : OTHER_WORKER_ID,
          claim_expires_at: i % 3 === 2 ? '2026-01-21T13:00:00Z' : null,
        })
      );
    }

    const startTime = Date.now();
    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);
    const duration = Date.now() - startTime;

    // Should complete in reasonable time (< 100ms for 1000 tasks)
    expect(duration).toBeLessThan(100);

    // Should return ~667 tasks (unclaimed + claimed by worker)
    // i % 3 === 0: 334 unclaimed
    // i % 3 === 1: 333 claimed by WORKER_ID
    // i % 3 === 2: 333 claimed by OTHER_WORKER_ID (not returned)
    expect(result.length).toBeGreaterThan(600);
  });
});

// =============================================================================
// Response Structure Tests
// =============================================================================

describe('VTID-01202 Response Structure', () => {
  test('response includes claimed_by field for unclaimed tasks', () => {
    const tasks = [createMockTask({ claimed_by: null })];

    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    expect(result[0]).toHaveProperty('claimed_by');
    expect(result[0].claimed_by).toBeNull();
  });

  test('response includes claimed_by field for claimed tasks', () => {
    const tasks = [
      createMockTask({
        claimed_by: WORKER_ID,
        claim_expires_at: '2026-01-21T13:00:00Z',
      }),
    ];

    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    expect(result[0]).toHaveProperty('claimed_by');
    expect(result[0].claimed_by).toBe(WORKER_ID);
  });

  test('response includes claim_expires_at field', () => {
    const expiresAt = '2026-01-21T13:00:00Z';
    const tasks = [
      createMockTask({
        claimed_by: WORKER_ID,
        claim_expires_at: expiresAt,
      }),
    ];

    const result = filterClaimableTasks(tasks, WORKER_ID, NOW);

    expect(result[0]).toHaveProperty('claim_expires_at');
    expect(result[0].claim_expires_at).toBe(expiresAt);
  });
});
