import { upsertMemoryFact } from '../../../src/services/memory-facts';
import { getSupabase } from '../../../src/lib/supabase';

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

describe('Memory Facts Service', () => {
  let mockUpsert: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsert = jest.fn().mockResolvedValue({ error: null });
    
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue({
        upsert: mockUpsert
      })
    });
  });

  it('should upsert memory fact with default provenance source', async () => {
    const result = await upsertMemoryFact('user-1', 'test_key', 'test_val');
    
    expect(result.ok).toBe(true);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        fact_key: 'test_key',
        fact_value: 'test_val',
        provenance_source: 'user_stated'
      }),
      expect.any(Object)
    );
  });

  it('should upsert memory fact with explicit provenance source', async () => {
    const result = await upsertMemoryFact(
      'user-1',
      'user_first_name',
      'Alice',
      'user_stated_via_settings'
    );
    
    expect(result.ok).toBe(true);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        fact_key: 'user_first_name',
        fact_value: 'Alice',
        provenance_source: 'user_stated_via_settings'
      }),
      expect.any(Object)
    );
  });

  it('should handle supabase error gracefully', async () => {
    mockUpsert.mockResolvedValueOnce({ error: { message: 'db error' } });
    const result = await upsertMemoryFact('user-1', 'test_key', 'test_val');
    
    expect(result.ok).toBe(false);
    expect(result.error).toBe('db error');
  });

  it('should handle missing supabase client', async () => {
    (getSupabase as jest.Mock).mockReturnValue(null);
    const result = await upsertMemoryFact('user-1', 'test_key', 'test_val');
    
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no supabase');
  });
});