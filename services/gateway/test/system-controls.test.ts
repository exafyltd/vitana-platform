import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('System Controls Service', () => {
  let selectMock: jest.Mock;
  let eqMock: jest.Mock;
  let singleMock: jest.Mock;

  beforeEach(() => {
    singleMock = jest.fn();
    eqMock = jest.fn().mockReturnValue({ single: singleMock });
    selectMock = jest.fn().mockReturnValue({ eq: eqMock });

    (supabase.from as jest.Mock).mockReturnValue({
      select: selectMock
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return a system control if found', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    singleMock.mockResolvedValue({ data: mockControl, error: null });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual(mockControl);
  });

  it('should return null if not found (PGRST116)', async () => {
    singleMock.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const result = await getSystemControl('missing_flag');
    expect(result).toBeNull();
  });

  it('should throw on other errors', async () => {
    const dbError = new Error('Database connection failed');
    singleMock.mockResolvedValue({ data: null, error: dbError });

    await expect(getSystemControl('test_flag')).rejects.toThrow('Database connection failed');
  });
});