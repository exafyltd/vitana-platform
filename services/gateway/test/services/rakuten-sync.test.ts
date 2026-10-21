/**
 * services/marketplace-sync/rakuten-sync.ts — previously zero test coverage.
 *
 * Focused on one fix: loadSourceConfigs()'s fetchActiveMarketplaceSourceConfigs
 * call previously ignored `error`, silently treating a real DB failure the
 * same as "no publishers configured" — the scheduled catalog sync would
 * quietly no-op with nothing logged.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockFetchActiveMarketplaceSourceConfigs = jest.fn();
jest.mock('../../src/services/marketplace-sync/rakuten-sync-repository', () => ({
  fetchActiveMarketplaceSourceConfigs: (...args: unknown[]) => mockFetchActiveMarketplaceSourceConfigs(...args),
}));

import { runRakutenSync } from '../../src/services/marketplace-sync/rakuten-sync';

describe('runRakutenSync — source-config lookup error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue({});
  });

  it('rejects (not a silent "no publishers configured" no-op) when the source-config lookup errors', async () => {
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });

    await expect(runRakutenSync('scheduler')).rejects.toMatchObject({ message: 'connection reset' });
  });

  it('still reports ok:true with zero fetched when there are genuinely no configs (unchanged)', async () => {
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({ data: [], error: null });

    const result = await runRakutenSync('scheduler');

    expect(result).toMatchObject({ ok: true, totals: expect.objectContaining({ fetched: 0 }) });
  });
});
