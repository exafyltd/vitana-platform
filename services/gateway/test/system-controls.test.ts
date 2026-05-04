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

  it('returns null when not found', async () => {
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('missing_key');
    expect(result).toBeNull();
  });

  it('returns null on database error', async () => {
    const mockEq = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: new Error('DB Error') })
    });
    const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
    (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

    const result = await getSystemControl('error_key');
    expect(result).toBeNull();
  });
});