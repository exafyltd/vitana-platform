/**
 * VTID-04540 (Codex review on #3697): a forced extraction is not skipped for
 * length — "I'm vegan" with a short reply is under the 50-char dedup minimum.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || 'test';

const mockPersist = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/inline-fact-extractor', () => ({
  extractAndPersistFacts: (...a: unknown[]) => mockPersist(...a),
  isInlineExtractionAvailable: () => true,
}));

import { deduplicatedExtract } from '../src/services/extraction-dedup-manager';

const SHORT = "User: I'm vegan\nAssistant: Noted."; // 33 chars

describe('deduplicatedExtract length gate', () => {
  beforeEach(() => mockPersist.mockClear());

  it('still skips short text on the unforced (voice, per-turn) path', () => {
    const r = deduplicatedExtract({ conversationText: SHORT, tenant_id: 't', user_id: 'u', session_id: 's-unforced' });
    expect(r).toEqual({ extracted: false, skip_reason: 'content_too_short' });
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('extracts short text when forced', () => {
    const r = deduplicatedExtract({ conversationText: SHORT, tenant_id: 't', user_id: 'u', session_id: 's-forced', force: true });
    expect(r.extracted).toBe(true);
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });
});
