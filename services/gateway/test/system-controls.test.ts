import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
  },
}));

describe('System Controls Service', () => {
  const mockFrom = supabase.from as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return a system control if found', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    const mockSingle = jest.fn().mockResolvedValue({ data: mockData, error: null });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(mockFrom).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(result).toEqual(mockData);
  });

  it('should return null if control is not found (PGRST116)', async () => {
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('missing_key');

    expect(result).toBeNull();
  });

  it('should throw an error on other database errors', async () => {
    const mockError = { code: 'OTHER', message: 'DB Error' };
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: mockError });
    const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ select: mockSelect });

    await expect(getSystemControl('error_key')).rejects.toEqual(mockError);
  });
});