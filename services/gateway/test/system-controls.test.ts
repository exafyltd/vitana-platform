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
    const mockData = {
      key: 'vitana_did_you_know_enabled',
      enabled: true,
      updated_at: '2023-01-01T00:00:00.000Z'
    };

    const eqMock = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: mockData, error: null })
    });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(result).toEqual(mockData);
  });

  it('should return null when not found', async () => {
    const eqMock = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } })
    });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('missing_key');

    expect(result).toBeNull();
  });

  it('should return null on other errors and log to console', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const eqMock = jest.fn().mockReturnValue({
      single: jest.fn().mockResolvedValue({ data: null, error: { message: 'Some database error' } })
    });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('error_key');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});