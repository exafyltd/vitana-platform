/**
 * Unit tests for auth-supabase-jwt middleware
 */
import { resolveVitanaId, invalidateVitanaIdCache } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/lib/supabase');

const mockSupabase = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn(),
};

(getSupabase as jest.Mock).mockReturnValue(mockSupabase);

describe('resolveVitanaId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateVitanaIdCache('test-user'); // clear cache between tests
  });

  it('returns null for empty userId', async () => {
    const result = await resolveVitanaId('');
    expect(result).toBeNull();
  });

  it('returns null when supabase is not available', async () => {
    (getSupabase as jest.Mock).mockReturnValueOnce(null);
    const result = await resolveVitanaId('user-1');
    expect(result).toBeNull();
  });

  it('returns vuid when user exists', async () => {
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { vuid: 'VIT-123' },
      error: null,
    });

    const result = await resolveVitanaId('user-1');
    expect(result).toBe('VIT-123');
    expect(mockSupabase.from).toHaveBeenCalledWith('app_users');
    expect(mockSupabase.select).toHaveBeenCalledWith('vuid');
    expect(mockSupabase.eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('returns null when no row found', async () => {
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const result = await resolveVitanaId('user-1');
    expect(result).toBeNull();
  });

  it('uses cache on subsequent calls', async () => {
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { vuid: 'VIT-456' },
      error: null,
    });

    await resolveVitanaId('user-2');
    // Reset mock to simulate no DB call
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { vuid: 'SHOULD_NOT_BE_CALLED' },
      error: null,
    });

    const result = await resolveVitanaId('user-2');
    expect(result).toBe('VIT-456');
    // maybeSingle should have been called only once
    expect(mockSupabase.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('invalidates cache when called', async () => {
    mockSupabase.maybeSingle.mockResolvedValue({
      data: { vuid: 'old-vuid' },
      error: null,
    });

    await resolveVitanaId('user-3');
    invalidateVitanaIdCache('user-3');
    await resolveVitanaId('user-3');

    // Should have called maybeSingle twice (once per DB fetch)
    expect(mockSupabase.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('returns null on DB error (catch)', async () => {
    mockSupabase.maybeSingle.mockRejectedValueOnce(new Error('DB error'));

    const result = await resolveVitanaId('user-4');
    expect(result).toBeNull();
  });
});