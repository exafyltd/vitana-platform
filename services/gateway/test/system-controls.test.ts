import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('System Controls Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a system control when found', async () => {
    const mockData = {
      key: 'vitana_did_you_know_enabled',
      enabled: true,
      updated_at: '2023-10-01T00:00:00.000Z'
    };

    const mockSingle = jest.fn().mockResolvedValue({ data: mockData, error: null });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('vitana_did_you_know_enabled');
    
    expect(result).toEqual(mockData);
    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
  });

  it('returns null when the control is not found', async () => {
    const mockError = { code: 'PGRST116', message: 'Row not found' };
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: mockError });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('unknown_flag');
    
    expect(result).toBeNull();
  });

  it('throws an error for unhandled database errors', async () => {
    const mockError = { code: '500', message: 'Internal Server Error' };
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: mockError });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    await expect(getSystemControl('some_flag')).rejects.toEqual(mockError);
  });
});