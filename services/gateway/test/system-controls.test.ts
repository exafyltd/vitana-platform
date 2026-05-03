import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('getSystemControl', () => {
  let selectMock: jest.Mock;
  let eqMock: jest.Mock;
  let singleMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    
    singleMock = jest.fn();
    eqMock = jest.fn().mockReturnValue({ single: singleMock });
    selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });
  });

  it('returns the system control if found', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    singleMock.mockResolvedValue({ data: mockData, error: null });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual(mockData);
  });

  it('returns null if system control is not found (PGRST116)', async () => {
    singleMock.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const result = await getSystemControl('missing_key');

    expect(result).toBeNull();
  });

  it('throws an error if there is an unexpected error', async () => {
    const mockError = new Error('Database error');
    singleMock.mockResolvedValue({ data: null, error: mockError });

    await expect(getSystemControl('some_key')).rejects.toThrow('Database error');
  });
});