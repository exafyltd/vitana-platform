import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('System Controls Service', () => {
  const mockSupabaseFrom = supabase.from as jest.Mock;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns a system control when found', async () => {
    const mockData = {
      key: 'vitana_did_you_know_enabled',
      enabled: true
    };

    const singleMock = jest.fn().mockResolvedValue({ data: mockData, error: null });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    mockSupabaseFrom.mockReturnValue({ select: selectMock });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(mockSupabaseFrom).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual(mockData);
  });

  it('returns null when system control is not found (PGRST116)', async () => {
    const singleMock = jest.fn().mockResolvedValue({ 
      data: null, 
      error: { code: 'PGRST116' } 
    });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    mockSupabaseFrom.mockReturnValue({ select: selectMock });

    const result = await getSystemControl('non_existent_key');

    expect(result).toBeNull();
  });

  it('throws an error for other supabase errors', async () => {
    const mockError = new Error('Database connection error');
    const singleMock = jest.fn().mockResolvedValue({ data: null, error: mockError });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    mockSupabaseFrom.mockReturnValue({ select: selectMock });

    await expect(getSystemControl('some_key')).rejects.toThrow('Database connection error');
  });
});