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

  it('should return a system control by key', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    const mockSingle = jest.fn().mockResolvedValue({ data: mockData, error: null });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('vitana_did_you_know_enabled');
    
    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(mockSingle).toHaveBeenCalled();
    expect(result).toEqual(mockData);
  });

  it('should return null if not found (PGRST116)', async () => {
    const mockError = { code: 'PGRST116', message: 'Not found' };
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: mockError });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('missing_key');
    
    expect(result).toBeNull();
  });

  it('should throw an error for other Supabase errors', async () => {
    const mockError = { code: 'UNKNOWN', message: 'Database error' };
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: mockError });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    await expect(getSystemControl('some_key')).rejects.toThrow('Error fetching system control some_key: Database error');
  });
});