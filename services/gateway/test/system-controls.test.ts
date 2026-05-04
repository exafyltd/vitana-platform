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
    const mockEq = jest.fn().mockReturnThis();
    const mockSingle = jest.fn().mockResolvedValue({ data: mockData, error: null });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq, single: mockSingle });

    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(result).toEqual(mockData);
  });

  it('should return null when not found (PGRST116)', async () => {
    const mockEq = jest.fn().mockReturnThis();
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq, single: mockSingle });

    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(result).toBeNull();
  });

  it('should throw an error on other errors', async () => {
    const mockEq = jest.fn().mockReturnThis();
    const mockSingle = jest.fn().mockResolvedValue({ data: null, error: { message: 'DB Error' } });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq, single: mockSingle });

    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    await expect(getSystemControl('vitana_did_you_know_enabled')).rejects.toThrow('Failed to fetch system control: DB Error');
  });
});