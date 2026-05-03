import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('System Controls Service', () => {
  const mockSupabase = supabase as jest.Mocked<typeof supabase>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return a system control when found', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    const selectMock = jest.fn().mockReturnThis();
    const eqMock = jest.fn().mockReturnThis();
    const singleMock = jest.fn().mockResolvedValue({ data: mockData, error: null });

    mockSupabase.from.mockReturnValue({
      select: selectMock,
      eq: eqMock,
      single: singleMock,
    } as any);

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(mockSupabase.from).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual(mockData);
  });

  it('should return null when not found (PGRST116)', async () => {
    const selectMock = jest.fn().mockReturnThis();
    const eqMock = jest.fn().mockReturnThis();
    const singleMock = jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    mockSupabase.from.mockReturnValue({
      select: selectMock,
      eq: eqMock,
      single: singleMock,
    } as any);

    const result = await getSystemControl('non_existent');
    expect(result).toBeNull();
  });

  it('should throw on unexpected database errors', async () => {
    const selectMock = jest.fn().mockReturnThis();
    const eqMock = jest.fn().mockReturnThis();
    const singleMock = jest.fn().mockResolvedValue({ data: null, error: { code: 'OTHER', message: 'DB Error' } });

    mockSupabase.from.mockReturnValue({
      select: selectMock,
      eq: eqMock,
      single: singleMock,
    } as any);

    await expect(getSystemControl('error_key')).rejects.toEqual({ code: 'OTHER', message: 'DB Error' });
  });
});