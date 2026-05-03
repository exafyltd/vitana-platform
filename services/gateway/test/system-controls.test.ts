import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

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
    const selectMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ data: mockData, error: null })
      })
    });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('vitana_did_you_know_enabled');
    
    expect(result).toEqual(mockData);
    expect(supabase.from).toHaveBeenCalledWith('system_controls');
  });

  it('should return null when not found (PGRST116)', async () => {
    const selectMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ 
          data: null, 
          error: { code: 'PGRST116', message: 'Not found' } 
        })
      })
    });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('missing_key');
    expect(result).toBeNull();
  });

  it('should throw an error on other supabase errors', async () => {
    const selectMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({ 
          data: null, 
          error: { code: 'OTHER_CODE', message: 'Database error' } 
        })
      })
    });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    await expect(getSystemControl('test_key'))
      .rejects
      .toThrow('Failed to fetch system control test_key: Database error');
  });
});