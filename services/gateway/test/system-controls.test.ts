import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('getSystemControl', () => {
  let mockSelect: jest.Mock;
  let mockEq: jest.Mock;
  let mockSingle: jest.Mock;

  beforeEach(() => {
    mockSingle = jest.fn();
    mockEq = jest.fn().mockReturnValue({ single: mockSingle });
    mockSelect = jest.fn().mockReturnValue({ eq: mockEq });

    (supabase.from as jest.Mock).mockReturnValue({
      select: mockSelect
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns the system control if found', async () => {
    const mockData = {
      key: 'vitana_did_you_know_enabled',
      enabled: true
    };
    mockSingle.mockResolvedValue({ data: mockData, error: null });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockSelect).toHaveBeenCalledWith('*');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(result).toEqual(mockData);
  });

  it('returns null if not found (PGRST116)', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const result = await getSystemControl('non_existent_key');
    expect(result).toBeNull();
  });

  it('throws an error for other supabase errors', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { code: 'OTHER', message: 'DB Error' } });

    await expect(getSystemControl('some_key')).rejects.toThrow('Failed to fetch system control: DB Error');
  });
});