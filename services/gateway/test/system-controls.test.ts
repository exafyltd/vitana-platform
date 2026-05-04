import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('system-controls service', () => {
  const mockFrom = supabase.from as jest.Mock;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return a system control when found', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: mockData, error: null })
        })
      })
    });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(mockFrom).toHaveBeenCalledWith('system_controls');
    expect(result).toEqual(mockData);
  });

  it('should return null when not found', async () => {
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } })
        })
      })
    });

    const result = await getSystemControl('missing_key');

    expect(result).toBeNull();
  });
});