/**
 * services/marketplace-sync/amazon-sync.ts — previously zero test coverage.
 *
 * Focused on one fix: loadSourceConfigs()'s fetchActiveMarketplaceSourceConfigs
 * call previously ignored `error`, silently treating a real DB failure the
 * same as "no marketplaces configured" — the scheduled catalog sync would
 * quietly no-op with nothing logged.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockFetchActiveMarketplaceSourceConfigs = jest.fn();
jest.mock('../../src/services/marketplace-sync/amazon-sync-repository', () => ({
  fetchActiveMarketplaceSourceConfigs: (...args: unknown[]) => mockFetchActiveMarketplaceSourceConfigs(...args),
}));

import { runAmazonSync } from '../../src/services/marketplace-sync/amazon-sync';

describe('runAmazonSync — source-config lookup error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue({});
  });

  it('rejects (not a silent "no marketplaces configured" no-op) when the source-config lookup errors', async () => {
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });

    await expect(runAmazonSync('scheduler')).rejects.toMatchObject({ message: 'connection reset' });
  });

  it('still reports ok:true with marketplaces_synced:0 when there are genuinely no configs (unchanged)', async () => {
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({ data: [], error: null });

    const result = await runAmazonSync('scheduler');

    expect(result).toMatchObject({ ok: true, marketplaces_synced: 0 });
  });
});
