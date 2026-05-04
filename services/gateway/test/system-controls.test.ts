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
    jest.clearAllMocks();

    singleMock = jest.fn();
    eqMock = jest.fn().mockReturnValue({ single: singleMock });
    selectMock = jest.fn().mockReturnValue({ eq: eqMock });

    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });
  });

  it('returns a system control if found', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    singleMock.mockResolvedValue({ data: mockControl, error: null });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(result).toEqual(mockControl);
  });

  it('returns null if the system control is not found (PGRST116)', async () => {
    singleMock.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

    const result = await getSystemControl('missing_key');

    expect(result).toBeNull();
  });

  it('throws an error on other database errors', async () => {
    singleMock.mockResolvedValue({ 
      data: null, 
      error: { code: '500', message: 'Database connection failed' } 
    });

    await expect(getSystemControl('some_key'))
      .rejects
      .toThrow('Failed to fetch system control: Database connection failed');
  });
});