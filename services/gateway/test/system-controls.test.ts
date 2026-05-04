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

    (supabase.from as jest.Mock).mockReturnValue({
      select: selectMock
    });
  });

  it('should return system control if found', async () => {
    const mockControl = { key: 'test_key', enabled: true };
    singleMock.mockResolvedValue({ data: mockControl, error: null });

    const result = await getSystemControl('test_key');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'test_key');
    expect(result).toEqual(mockControl);
  });

  it('should return null if no rows found (PGRST116)', async () => {
    singleMock.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

    const result = await getSystemControl('test_key');

    expect(result).toBeNull();
  });

  it('should throw on other errors', async () => {
    const mockError = new Error('Database error');
    singleMock.mockResolvedValue({ data: null, error: mockError });

    await expect(getSystemControl('test_key')).rejects.toThrow('Database error');
  });
});