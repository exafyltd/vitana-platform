/**
 * services/marketplace-sync/awin-sync.ts — source-config lookup error
 * handling (previously no coverage of runAwinSync itself; the existing
 * test/routes/awin-sync.test.ts only covers pure helpers).
 *
 * Focused on one fix: loadSourceConfigs()'s fetchActiveMarketplaceSourceConfigs
 * call previously ignored `error`, silently treating a real DB failure the
 * same as "no feeds configured" — the scheduled catalog sync would quietly
 * no-op with nothing logged.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockFetchActiveMarketplaceSourceConfigs = jest.fn();
jest.mock('../../src/services/marketplace-sync/awin-sync-repository', () => ({
  fetchActiveMarketplaceSourceConfigs: (...args: unknown[]) => mockFetchActiveMarketplaceSourceConfigs(...args),
}));

import { runAwinSync } from '../../src/services/marketplace-sync/awin-sync';

describe('runAwinSync — source-config lookup error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue({});
  });

  it('rejects (not a silent "no feeds configured" no-op) when the source-config lookup errors', async () => {
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });

    await expect(runAwinSync('scheduler')).rejects.toMatchObject({ message: 'connection reset' });
  });

  it('still reports ok:true with feeds_synced:0 when there are genuinely no configs (unchanged)', async () => {
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({ data: [], error: null });

    const result = await runAwinSync('scheduler');

    expect(result).toMatchObject({ ok: true, feeds_synced: 0 });
  });
});
