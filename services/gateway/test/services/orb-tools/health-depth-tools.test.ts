/**
 * services/orb-tools/health-depth-tools.ts — previously zero test coverage.
 *
 * Focused on two fixes:
 *   1. resolveHealthTenantId() previously caught its own thrown errors and
 *      silently fell back to DEFAULT_TENANT_ID — identical to "user
 *      genuinely has no tenant row yet" — so a transient DB error on the
 *      write path (log_meal/log_mood/log_vitals/log_biomarker) could
 *      silently upsert real health data under the wrong (zero-UUID) tenant.
 *   2. tool_log_meal's read-modify-write meal-count accumulator ignored a
 *      real error on its read, resetting the day's meal count to 1 instead
 *      of accumulating on a transient failure.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const mockFetchTenantIdForUser = jest.fn();
const mockFetchHealthFeatureValue = jest.fn();
jest.mock('../../../src/services/orb-tools/health-depth-tools-repository', () => ({
  fetchTenantIdForUser: (...args: unknown[]) => mockFetchTenantIdForUser(...args),
  fetchHealthFeatureValue: (...args: unknown[]) => mockFetchHealthFeatureValue(...args),
}));

import { tool_log_meal } from '../../../src/services/orb-tools/health-depth-tools';

const identity = { user_id: 'user-1', tenant_id: null, role: 'community' };
const sb = {} as SupabaseClient;

describe('health-depth-tools — tenant resolution error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('tool_log_meal fails loudly (not a silent wrong-tenant write) when the tenant lookup errors', async () => {
    mockFetchTenantIdForUser.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const result = await tool_log_meal({ description: 'oatmeal' }, identity, sb);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('log_meal failed');
    // Must not have proceeded to read/write health_features_daily under a
    // fabricated DEFAULT_TENANT_ID.
    expect(mockFetchHealthFeatureValue).not.toHaveBeenCalled();
  });

  it('tool_log_meal fails loudly (not silently resetting the day\'s count) when the meal-count read errors', async () => {
    mockFetchTenantIdForUser.mockResolvedValue({ data: { tenant_id: 'tenant-1' }, error: null });
    mockFetchHealthFeatureValue.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const result = await tool_log_meal({ description: 'oatmeal' }, identity, sb);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('log_meal failed');
  });
});
