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

  it('returns a system control if found', async () => {
    const mockData = {
      key: 'vitana_did_you_know_enabled',
      enabled: true,
    };

    const singleMock = jest.fn().mockResolvedValue({ data: mockData, error: null });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual(mockData);
  });

  it('returns null if not found (PGRST116)', async () => {
    const singleMock = jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('missing_key');
    expect(result).toBeNull();
  });

  it('throws on other errors', async () => {
    const singleMock = jest.fn().mockResolvedValue({ data: null, error: { message: 'Database error' } });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    await expect(getSystemControl('missing_key')).rejects.toThrow('Failed to fetch system control: Database error');
  });
});