// Session-end memory commit — unit tests for commitSessionMemory(), the
// single chokepoint both voice transports (Vertex orb-live + LiveKit
// orb-agent via /api/v1/orb/session/commit-memory) route through so
// extraction can never fork again.
//
// VTID-04344: the Cognee extractor that used to run alongside the
// deduplicated inline extractor was retired; deduplicatedExtract is the sole
// extraction path and the result no longer carries `cognee_queued`.
//
// Scope:
//   1. Guard clauses — transcript-too-short and missing-identity paths
//      never fire the extractor.
//   2. The commit path — deduplicatedExtract is invoked with the right
//      tenant/user/session scoping.
//   3. Failure handling — a throw from the extractor is swallowed
//      (non-fatal) and never escapes the function.
//   4. Tenant/user scoping — args are never swapped/merged across calls.

const mockDeduplicatedExtract = jest.fn();
jest.mock('../../src/services/extraction-dedup-manager', () => ({
  deduplicatedExtract: (...args: any[]) => mockDeduplicatedExtract(...args),
}));

import {
  commitSessionMemory,
  MIN_COMMIT_TRANSCRIPT_CHARS,
  type CommitSessionMemoryArgs,
} from '../../src/services/session-memory-commit';

const LONG_TRANSCRIPT =
  'a'.repeat(MIN_COMMIT_TRANSCRIPT_CHARS + 1); // strictly over the threshold

function baseArgs(overrides: Partial<CommitSessionMemoryArgs> = {}): CommitSessionMemoryArgs {
  return {
    transcript: LONG_TRANSCRIPT,
    tenantId: 'tenant-aaa',
    userId: 'user-bbb',
    sessionId: 'session-ccc',
    activeRole: 'community',
    ...overrides,
  };
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  mockDeduplicatedExtract.mockReset();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Guard clauses
// ---------------------------------------------------------------------------

describe('commitSessionMemory — guard clauses', () => {
  it('skips extraction when the transcript is exactly at the minimum length (boundary is exclusive)', () => {
    const result = commitSessionMemory(baseArgs({ transcript: 'a'.repeat(MIN_COMMIT_TRANSCRIPT_CHARS) }));

    expect(result).toEqual({ committed: false, reason: 'transcript_too_short' });
    expect(mockDeduplicatedExtract).not.toHaveBeenCalled();
  });

  it('skips extraction for an empty/whitespace-only transcript', () => {
    const result = commitSessionMemory(baseArgs({ transcript: '   ' }));
    expect(result).toEqual({ committed: false, reason: 'transcript_too_short' });
  });

  it('proceeds when the transcript is one character over the minimum', () => {
    const result = commitSessionMemory(baseArgs({ transcript: 'a'.repeat(MIN_COMMIT_TRANSCRIPT_CHARS + 1) }));
    expect(result.committed).toBe(true);
  });

  it('trims the transcript before measuring length', () => {
    // Padding with whitespace outside the meaningful content must not count
    // toward clearing the threshold.
    const padded = '  ' + 'a'.repeat(MIN_COMMIT_TRANSCRIPT_CHARS - 1) + '  ';
    const result = commitSessionMemory(baseArgs({ transcript: padded }));
    expect(result).toEqual({ committed: false, reason: 'transcript_too_short' });
  });

  it('skips extraction when tenantId is missing, even with a long transcript', () => {
    const result = commitSessionMemory(baseArgs({ tenantId: '' }));

    expect(result).toEqual({ committed: false, reason: 'missing_identity' });
    expect(mockDeduplicatedExtract).not.toHaveBeenCalled();
  });

  it('skips extraction when userId is missing', () => {
    const result = commitSessionMemory(baseArgs({ userId: '' }));
    expect(result).toEqual({ committed: false, reason: 'missing_identity' });
  });
});

// ---------------------------------------------------------------------------
// Commit path
// ---------------------------------------------------------------------------

describe('commitSessionMemory — commit path', () => {
  it('fires the deduplicated extractor and reports committed=true', () => {
    const result = commitSessionMemory(baseArgs());

    expect(result).toEqual({ committed: true });
    expect(mockDeduplicatedExtract).toHaveBeenCalledTimes(1);
  });

  it('maps args to deduplicatedExtract with force:true (always, on session end)', () => {
    commitSessionMemory(baseArgs({ tenantId: 'tenant-X', userId: 'user-Y', sessionId: 'session-Z' }));

    expect(mockDeduplicatedExtract).toHaveBeenCalledWith({
      conversationText: LONG_TRANSCRIPT,
      tenant_id: 'tenant-X',
      user_id: 'user-Y',
      session_id: 'session-Z',
      force: true,
    });
  });

  it('no longer reports a cognee_queued field (Cognee retired, VTID-04344)', () => {
    const result = commitSessionMemory(baseArgs()) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty('cognee_queued');
  });
});

// ---------------------------------------------------------------------------
// Failure handling — an extractor throw must never propagate.
// ---------------------------------------------------------------------------

describe('commitSessionMemory — failure handling', () => {
  it('swallows a synchronous throw from deduplicatedExtract without affecting the reported result', () => {
    mockDeduplicatedExtract.mockImplementation(() => {
      throw new Error('dedup extractor blew up');
    });

    const result = commitSessionMemory(baseArgs());

    expect(result).toEqual({ committed: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deduplicatedExtract threw (non-fatal)'));
  });
});

// ---------------------------------------------------------------------------
// Tenant / user scoping across repeated calls
// ---------------------------------------------------------------------------

describe('commitSessionMemory — tenant/user isolation', () => {
  it('never mixes identity fields across two sequential commits for different users', () => {
    commitSessionMemory(baseArgs({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1' }));
    commitSessionMemory(baseArgs({ tenantId: 'tenant-2', userId: 'user-2', sessionId: 'session-2' }));

    const dedupCalls = mockDeduplicatedExtract.mock.calls.map((c) => c[0]);

    expect(dedupCalls[0]).toMatchObject({ tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1' });
    expect(dedupCalls[1]).toMatchObject({ tenant_id: 'tenant-2', user_id: 'user-2', session_id: 'session-2' });
  });
});
