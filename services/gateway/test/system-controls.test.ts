import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

describe('System Controls Service', () => {
  let fromMock: jest.Mock;
  let selectMock: jest.Mock;
  let eqMock: jest.Mock;
  let singleMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    singleMock = jest.fn();
    eqMock = jest.fn().mockReturnValue({ single: singleMock });
    selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    fromMock = jest.fn().mockReturnValue({ select: selectMock });

    (supabase.from as jest.Mock) = fromMock;
  });

  describe('getSystemControl', () => {
    it('should return a system control if found', async () => {
      const mockControl = { key: 'test_flag', enabled: true };
      singleMock.mockResolvedValue({ data: mockControl, error: null });

      const result = await getSystemControl('test_flag');

      expect(fromMock).toHaveBeenCalledWith('system_controls');
      expect(selectMock).toHaveBeenCalledWith('*');
      expect(eqMock).toHaveBeenCalledWith('key', 'test_flag');
      expect(result).toEqual(mockControl);
    });

    it('should return null if not found (PGRST116)', async () => {
      singleMock.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

      const result = await getSystemControl('missing_flag');

      expect(result).toBeNull();
    });

    it('should throw on other errors', async () => {
      singleMock.mockResolvedValue({ data: null, error: { message: 'DB Error' } });

      await expect(getSystemControl('test_flag')).rejects.toEqual({ message: 'DB Error' });
    });
  });
});