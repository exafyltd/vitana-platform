import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('getSystemControl service', () => {
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
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    mockSingle.mockResolvedValue({ data: mockData, error: null });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(mockSingle).toHaveBeenCalled();
    expect(result).toEqual(mockData);
  });

  it('should return null when the record is not found (PGRST116)', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'Not found' }
    });

    const result = await getSystemControl('non_existent');

    expect(result).toBeNull();
  });

  it('should throw an error on other database errors', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: '500', message: 'Database Error' }
    });

    await expect(getSystemControl('error_key')).rejects.toThrow(
      'Failed to fetch system control: Database Error'
    );
  });
});