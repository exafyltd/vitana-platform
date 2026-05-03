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

  it('returns a system control if found', async () => {
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

  it('returns null if not found (PGRST116)', async () => {
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('missing_flag');
    expect(result).toBeNull();
  });

  it('throws on other database errors', async () => {
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: { message: 'DB Error' } })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    await expect(getSystemControl('some_flag')).rejects.toEqual({ message: 'DB Error' });
  });
});