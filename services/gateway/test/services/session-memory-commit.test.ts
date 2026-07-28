// Session-end memory commit — unit tests for commitSessionMemory(), the
// single chokepoint both voice transports (Vertex orb-live + LiveKit
// orb-agent via /api/v1/orb/session/commit-memory) route through so
// extraction can never fork again.
//
// Scope:
//   1. Guard clauses — transcript-too-short and missing-identity paths
//      never fire either extractor.
//   2. The commit path — both extractors are invoked with the right
//      tenant/user/session scoping when cogneeExtractorClient is enabled.
//   3. Partial-failure handling — a throw from either extractor is
//      swallowed (non-fatal) and never prevents the other extractor from
//      running or the function from returning a normal result.
//   4. Tenant/user scoping — args are never swapped/merged across calls.

const mockIsEnabled = jest.fn();
const mockExtractAsync = jest.fn();
jest.mock('../../src/services/cognee-extractor-client', () => ({
  cogneeExtractorClient: {
    isEnabled: (...args: any[]) => mockIsEnabled(...args),
    extractAsync: (...args: any[]) => mockExtractAsync(...args),
  },
}));

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
  mockIsEnabled.mockReset();
  mockExtractAsync.mockReset();
  mockDeduplicatedExtract.mockReset();
  mockIsEnabled.mockReturnValue(true);
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

    expect(result).toEqual({ committed: false, cognee_queued: false, reason: 'transcript_too_short' });
    expect(mockIsEnabled).not.toHaveBeenCalled();
    expect(mockExtractAsync).not.toHaveBeenCalled();
    expect(mockDeduplicatedExtract).not.toHaveBeenCalled();
  });

  it('skips extraction for an empty/whitespace-only transcript', () => {
    const result = commitSessionMemory(baseArgs({ transcript: '   ' }));
    expect(result).toEqual({ committed: false, cognee_queued: false, reason: 'transcript_too_short' });
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
    expect(result).toEqual({ committed: false, cognee_queued: false, reason: 'transcript_too_short' });
  });

  it('skips extraction when tenantId is missing, even with a long transcript', () => {
    const result = commitSessionMemory(baseArgs({ tenantId: '' }));

    expect(result).toEqual({ committed: false, cognee_queued: false, reason: 'missing_identity' });
    expect(mockExtractAsync).not.toHaveBeenCalled();
    expect(mockDeduplicatedExtract).not.toHaveBeenCalled();
  });

  it('skips extraction when userId is missing', () => {
    const result = commitSessionMemory(baseArgs({ userId: '' }));
    expect(result).toEqual({ committed: false, cognee_queued: false, reason: 'missing_identity' });
  });
});

// ---------------------------------------------------------------------------
// Commit path — both extractors fired with correct args
// ---------------------------------------------------------------------------

describe('commitSessionMemory — commit path', () => {
  it('fires both extractors and reports cognee_queued=true when cognee is enabled', () => {
    const result = commitSessionMemory(baseArgs());

    expect(result).toEqual({ committed: true, cognee_queued: true });
    expect(mockExtractAsync).toHaveBeenCalledTimes(1);
    expect(mockDeduplicatedExtract).toHaveBeenCalledTimes(1);
  });

  it('maps args to cogneeExtractorClient.extractAsync with correct tenant/user/session scoping', () => {
    commitSessionMemory(baseArgs({
      tenantId: 'tenant-X',
      userId: 'user-Y',
      sessionId: 'session-Z',
      activeRole: 'developer',
    }));

    expect(mockExtractAsync).toHaveBeenCalledWith({
      transcript: LONG_TRANSCRIPT,
      tenant_id: 'tenant-X',
      user_id: 'user-Y',
      session_id: 'session-Z',
      active_role: 'developer',
    });
  });

  it('defaults active_role to "community" when not provided', () => {
    const { activeRole, ...rest } = baseArgs();
    commitSessionMemory(rest as CommitSessionMemoryArgs);

    expect(mockExtractAsync).toHaveBeenCalledWith(expect.objectContaining({ active_role: 'community' }));
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

  it('reports cognee_queued=false and skips extractAsync when cognee is disabled, but still runs the deduplicated extractor', () => {
    mockIsEnabled.mockReturnValue(false);

    const result = commitSessionMemory(baseArgs());

    expect(result).toEqual({ committed: true, cognee_queued: false });
    expect(mockExtractAsync).not.toHaveBeenCalled();
    expect(mockDeduplicatedExtract).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Partial-failure handling — neither extractor throwing should ever
// propagate out of commitSessionMemory or block the other extractor.
// ---------------------------------------------------------------------------

describe('commitSessionMemory — partial-failure handling', () => {
  it('swallows a synchronous throw from cogneeExtractorClient.isEnabled() and still runs deduplicatedExtract', () => {
    mockIsEnabled.mockImplementation(() => {
      throw new Error('flag check blew up');
    });

    const result = commitSessionMemory(baseArgs());

    expect(result).toEqual({ committed: true, cognee_queued: false });
    expect(mockDeduplicatedExtract).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cognee extractAsync threw (non-fatal)'));
  });

  it('swallows a synchronous throw from cogneeExtractorClient.extractAsync() and still runs deduplicatedExtract', () => {
    mockExtractAsync.mockImplementation(() => {
      throw new Error('extractAsync blew up');
    });

    const result = commitSessionMemory(baseArgs());

    // extractAsync throwing means the `cogneeQueued = true` assignment right
    // after it never runs, so cognee_queued must stay false — but the
    // function itself must not throw, and deduplicatedExtract must still run.
    expect(result).toEqual({ committed: true, cognee_queued: false });
    expect(mockDeduplicatedExtract).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cognee extractAsync threw (non-fatal)'));
  });

  it('swallows a synchronous throw from deduplicatedExtract without affecting the reported result', () => {
    mockDeduplicatedExtract.mockImplementation(() => {
      throw new Error('dedup extractor blew up');
    });

    const result = commitSessionMemory(baseArgs());

    expect(result).toEqual({ committed: true, cognee_queued: true });
    expect(mockExtractAsync).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deduplicatedExtract threw (non-fatal)'));
  });

  it('swallows failures in BOTH extractors simultaneously and still returns committed:true', () => {
    mockExtractAsync.mockImplementation(() => {
      throw new Error('cognee blew up');
    });
    mockDeduplicatedExtract.mockImplementation(() => {
      throw new Error('dedup blew up');
    });

    const result = commitSessionMemory(baseArgs());

    expect(result.committed).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tenant / user scoping across repeated calls
// ---------------------------------------------------------------------------

describe('commitSessionMemory — tenant/user isolation', () => {
  it('never mixes identity fields across two sequential commits for different users', () => {
    commitSessionMemory(baseArgs({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1' }));
    commitSessionMemory(baseArgs({ tenantId: 'tenant-2', userId: 'user-2', sessionId: 'session-2' }));

    const cogneeCalls = mockExtractAsync.mock.calls.map((c) => c[0]);
    const dedupCalls = mockDeduplicatedExtract.mock.calls.map((c) => c[0]);

    expect(cogneeCalls[0]).toMatchObject({ tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1' });
    expect(cogneeCalls[1]).toMatchObject({ tenant_id: 'tenant-2', user_id: 'user-2', session_id: 'session-2' });
    expect(dedupCalls[0]).toMatchObject({ tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1' });
    expect(dedupCalls[1]).toMatchObject({ tenant_id: 'tenant-2', user_id: 'user-2', session_id: 'session-2' });
  });
});
