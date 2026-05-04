import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

// Mock Supabase client
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('System Controls Service', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return a system control when found', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    const mockSingle = jest.fn().mockResolvedValue({ data: mockData, error: null });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(result).toEqual(mockData);
  });

  it('should return null when system control is not found', async () => {
    // Supabase returns PGRST116 for zero rows on single()
    const mockSingle = jest.fn().mockResolvedValue({ 
      data: null, 
      error: { code: 'PGRST116', message: 'Not found' } 
    });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('missing_key');

    expect(result).toBeNull();
  });

  it('should throw an error on database failure', async () => {
    const mockSingle = jest.fn().mockResolvedValue({ 
      data: null, 
      error: { code: '500', message: 'DB Error' } 
    });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    await expect(getSystemControl('some_key')).rejects.toThrow('Failed to fetch system control: DB Error');
  });
});