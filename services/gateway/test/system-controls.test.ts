import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('System Controls Service', () => {
  const mockSelect = jest.fn();
  const mockEq = jest.fn();
  const mockSingle = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ single: mockSingle });
  });

  it('should return a system control when found', async () => {
    const mockControl = { 
      key: 'vitana_did_you_know_enabled', 
      enabled: true, 
      updated_at: '2023-01-01T00:00:00Z' 
    };
    mockSingle.mockResolvedValue({ data: mockControl, error: null });

    const result = await getSystemControl('vitana_did_you_know_enabled');
    expect(result).toEqual(mockControl);
    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
  });

  it('should return null when control is not found (PGRST116)', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const result = await getSystemControl('missing_flag');
    expect(result).toBeNull();
  });

  it('should throw an error on unexpected DB errors', async () => {
    mockSingle.mockResolvedValue({ 
      data: null, 
      error: { code: 'OTHER_CODE', message: 'Database failure' } 
    });

    await expect(getSystemControl('error_flag')).rejects.toThrow('Failed to fetch system control: Database failure');
  });
});