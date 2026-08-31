/**
 * services/marketplace-sync/admitad-sync.ts — previously zero test coverage
 * (per its own repository file's "impact-allow-no-test" note).
 *
 * Focused on one fix: loadSourceConfigs()'s fetchActiveMarketplaceSourceConfigs
 * call previously ignored `error`, silently treating a real DB failure the
 * same as "no feeds configured" — runAdmitadSync would report ok:true,
 * feeds_synced:0 for a tenant with real feeds configured, and the scheduled
 * catalog sync would quietly no-op with nothing logged.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockFetchActiveMarketplaceSourceConfigs = jest.fn();
jest.mock('../../src/services/marketplace-sync/admitad-sync-repository', () => ({
  fetchActiveMarketplaceSourceConfigs: (...args: unknown[]) => mockFetchActiveMarketplaceSourceConfigs(...args),
}));

import { runAdmitadSync } from '../../src/services/marketplace-sync/admitad-sync';

describe('runAdmitadSync — source-config lookup error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue({});
  });

  it('rejects (not a silent "no feeds configured" no-op) when the source-config lookup errors', async () => {
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });

    await expect(runAdmitadSync('scheduler')).rejects.toMatchObject({ message: 'connection reset' });
  });

  it('still reports ok:true with feeds_synced:0 when there are genuinely no configs (unchanged)', async () => {
    mockFetchActiveMarketplaceSourceConfigs.mockResolvedValue({ data: [], error: null });

    const result = await runAdmitadSync('scheduler');

    expect(result).toMatchObject({ ok: true, feeds_synced: 0 });
  });
});
