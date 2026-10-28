import { getSystemControl } from '../src/services/system-controls';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('System Controls Service', () => {
  it('returns a system control when found', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: mockData, error: null })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    const mockFrom = jest.fn().mockReturnValue({ select: mockSelect });
    const mockSupabase = { from: mockFrom } as unknown as SupabaseClient;

    const result = await getSystemControl(mockSupabase, 'vitana_did_you_know_enabled');
    
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(mockData);
    expect(mockFrom).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
  });

  it('returns an error when not found (PGRST116)', async () => {
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'Not found' } })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    const mockFrom = jest.fn().mockReturnValue({ select: mockSelect });
    const mockSupabase = { from: mockFrom } as unknown as SupabaseClient;

    const result = await getSystemControl(mockSupabase, 'missing_key');
    
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Not found');
    expect(result.data).toBeUndefined();
  });

  it('returns an error on other DB errors', async () => {
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: { code: '500', message: 'DB error' } })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    const mockFrom = jest.fn().mockReturnValue({ select: mockSelect });
    const mockSupabase = { from: mockFrom } as unknown as SupabaseClient;

    const result = await getSystemControl(mockSupabase, 'err_key');
    
    expect(result.ok).toBe(false);
    expect(result.error).toBe('DB error');
  });
});