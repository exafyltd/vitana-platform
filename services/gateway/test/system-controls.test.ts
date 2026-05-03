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
    (supabase.from as jest.Mock).mockReturnValue({
      select: mockSelect
    });
    mockSelect.mockReturnValue({
      eq: mockEq
    });
    mockEq.mockReturnValue({
      single: mockSingle
    });
  });

  it('should return a system control if found', async () => {
    const mockData = { key: 'test_key', enabled: true };
    mockSingle.mockResolvedValue({ data: mockData, error: null });

    const result = await getSystemControl('test_key');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'test_key');
    expect(result).toEqual(mockData);
  });

  it('should return null if system control is not found', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'Not found' }
    });

    const result = await getSystemControl('missing_key');

    expect(result).toBeNull();
  });

  it('should throw an error on database failure', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: 'OTHER_CODE', message: 'Database error' }
    });

    await expect(getSystemControl('error_key')).rejects.toThrow('Failed to fetch system control: Database error');
  });
});