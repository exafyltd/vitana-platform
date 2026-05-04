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
    const mockEq = jest.fn().mockReturnValue({ 
      single: jest.fn().mockResolvedValue({ data: mockData, error: null }) 
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('vitana_did_you_know_enabled');
    
    expect(result).toEqual(mockData);
    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
  });

  it('should return null when the control is not found (PGRST116)', async () => {
    const mockEq = jest.fn().mockReturnValue({ 
      single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }) 
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('missing_key');
    expect(result).toBeNull();
  });

  it('should throw an error for unexpected database errors', async () => {
    const mockError = { code: '500', message: 'Internal DB Error' };
    const mockEq = jest.fn().mockReturnValue({ 
      single: jest.fn().mockResolvedValue({ data: null, error: mockError }) 
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    await expect(getSystemControl('error_key')).rejects.toEqual(mockError);
  });
});