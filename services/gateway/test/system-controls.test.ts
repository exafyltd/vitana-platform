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
    const mockControl = { key: 'test_key', enabled: true };
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: mockControl, error: null })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('test_key');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'test_key');
    expect(result).toEqual(mockControl);
  });

  it('should return null when control is not found (PGRST116)', async () => {
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('missing_key');

    expect(result).toBeNull();
  });

  it('should throw an error on other supabase errors', async () => {
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: { code: 'OTHER', message: 'Something went wrong' } })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    await expect(getSystemControl('error_key')).rejects.toThrow('Failed to fetch system control: Something went wrong');
  });
});