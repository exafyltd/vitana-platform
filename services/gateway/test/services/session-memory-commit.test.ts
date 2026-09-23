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
const mockCallViaRouter = jest.fn();
jest.mock('../../src/services/llm-router', () => ({
  callViaRouter: (...args: any[]) => mockCallViaRouter(...args),
}));
const mockWriteMemoryItem = jest.fn();
jest.mock('../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: (...args: any[]) => mockWriteMemoryItem(...args),
}));
const mockEmitOasisEvent = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import {
  commitSessionMemory,
  cleanSummary,
  countUserTurns,
  isSummaryEligible,
  renderTranscript,
  resetSessionCommitState,
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_INPUT_CHARS,
  MIN_COMMIT_TRANSCRIPT_CHARS,
  type CommitSessionMemoryArgs,
} from '../../src/services/session-memory-commit';

const flush = () => new Promise((r) => setImmediate(r));

const CONVERSATION = [
  'User: I slept badly again, maybe five hours.',
  'Assistant: That sounds tiring. What kept you up?',
  'User: Work stress mostly. I want to try going to bed at ten this week.',
  'Assistant: Good plan. I can remind you at half past nine.',
].join('\n');

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
  resetSessionCommitState();
  mockDeduplicatedExtract.mockReset();
  mockCallViaRouter.mockReset();
  mockWriteMemoryItem.mockReset();
  mockEmitOasisEvent.mockReset();
  mockCallViaRouter.mockResolvedValue({ ok: true, text: 'The user slept about five hours.', provider: 'bedrock' });
  mockWriteMemoryItem.mockResolvedValue({ ok: true, id: 'mi-1' });
  mockEmitOasisEvent.mockResolvedValue(undefined);
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

    expect(result).toEqual({ committed: true, summary_queued: false });
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

    expect(result).toEqual({ committed: true, summary_queued: false });
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

// ---------------------------------------------------------------------------
// VTID-04365 — one commit per session, plus a session-summary episode
// ---------------------------------------------------------------------------

describe('commitSessionMemory — idempotency (VTID-04365)', () => {
  it('a second commit for the same session is reported as already_committed and extracts nothing', () => {
    expect(commitSessionMemory(baseArgs()).committed).toBe(true);
    expect(commitSessionMemory(baseArgs())).toEqual({ committed: false, reason: 'already_committed' });
    expect(mockDeduplicatedExtract).toHaveBeenCalledTimes(1);
  });

  it('a different session for the same user still commits', () => {
    commitSessionMemory(baseArgs({ sessionId: 's-1' }));
    expect(commitSessionMemory(baseArgs({ sessionId: 's-2' })).committed).toBe(true);
  });

  it('refuses a commit without a session id', () => {
    expect(commitSessionMemory(baseArgs({ sessionId: '' }))).toEqual({
      committed: false,
      reason: 'missing_session_id',
    });
  });
});

describe('session summary eligibility', () => {
  it('needs at least two user turns and 200 characters', () => {
    expect(countUserTurns(CONVERSATION)).toBe(2);
    expect(isSummaryEligible(CONVERSATION)).toBe(true);
    expect(isSummaryEligible('User: hi\nAssistant: hello')).toBe(false);
    expect(isSummaryEligible('User: ' + 'a'.repeat(300))).toBe(false);
  });

  it('renderTranscript produces the User:/Assistant: shape and drops empty turns', () => {
    expect(
      renderTranscript([
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello' },
        { role: 'user', text: '  ' },
      ]),
    ).toBe('User: hi\nAssistant: hello');
  });

  it('cleanSummary drops NONE and caps the length', () => {
    expect(cleanSummary('NONE')).toBeNull();
    expect(cleanSummary(' none. ')).toBeNull();
    expect(cleanSummary('')).toBeNull();
    expect(cleanSummary('"The user likes tea."')).toBe('The user likes tea.');
    expect(cleanSummary('x'.repeat(2000))!.length).toBe(MAX_SUMMARY_CHARS);
  });
});

describe('session summary write', () => {
  it('summarises through the memory stage and writes one session_summary episode', async () => {
    const r = commitSessionMemory(baseArgs({ transcript: CONVERSATION, channel: 'orb_voice', trigger: 'sse_stop' }));
    expect(r).toEqual({ committed: true, summary_queued: true });
    await flush();

    expect(mockCallViaRouter).toHaveBeenCalledWith(
      'memory',
      CONVERSATION,
      expect.objectContaining({ service: 'session-memory-commit', maxTokens: 300 }),
    );
    expect(mockWriteMemoryItem).toHaveBeenCalledTimes(1);
    const [identity, item] = mockWriteMemoryItem.mock.calls[0];
    expect(identity).toEqual({ tenant_id: 'tenant-aaa', user_id: 'user-bbb', active_role: 'community' });
    expect(item.importance).toBeLessThanOrEqual(50); // trg_notify_memory_garden fires above 50
    expect(item).toMatchObject({
      source: 'system',
      category_key: 'session_summary',
      content: 'The user slept about five hours.',
      content_json: expect.objectContaining({ kind: 'session_summary', session_id: 'session-ccc', channel: 'orb_voice', user_turns: 2 }),
    });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.session.summarized' }));
  });

  it('sends only the tail of a very long transcript', async () => {
    const long = CONVERSATION + '\n' + 'User: ' + 'b'.repeat(MAX_SUMMARY_INPUT_CHARS * 2);
    commitSessionMemory(baseArgs({ transcript: long }));
    await flush();
    expect(mockCallViaRouter.mock.calls[0][1].length).toBe(MAX_SUMMARY_INPUT_CHARS);
  });

  it('writes nothing when the model says there is nothing worth remembering', async () => {
    mockCallViaRouter.mockResolvedValue({ ok: true, text: 'NONE' });
    commitSessionMemory(baseArgs({ transcript: CONVERSATION }));
    await flush();
    expect(mockWriteMemoryItem).not.toHaveBeenCalled();
  });

  it('writes nothing and never throws when the router fails', async () => {
    mockCallViaRouter.mockResolvedValue({ ok: false, error: 'both providers down' });
    commitSessionMemory(baseArgs({ transcript: CONVERSATION }));
    await flush();
    expect(mockWriteMemoryItem).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('session summary failed'));
  });

  it('treats a duplicate-key insert as already committed by another instance (no warning, no event)', async () => {
    mockWriteMemoryItem.mockResolvedValue({ ok: false, error: 'duplicate key value violates unique constraint "uq_memory_items_session_summary"' });
    commitSessionMemory(baseArgs({ transcript: CONVERSATION }));
    await flush();
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('write failed'));
  });

  it('a short one-turn session gets facts but no summary', async () => {
    const r = commitSessionMemory(baseArgs());
    expect(r.summary_queued).toBe(false);
    await flush();
    expect(mockCallViaRouter).not.toHaveBeenCalled();
  });
});
