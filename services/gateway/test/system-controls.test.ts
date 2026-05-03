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

  it('should return a system control if found', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    const singleMock = jest.fn().mockResolvedValue({ data: mockData, error: null });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('vitana_did_you_know_enabled');
    
    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(result).toEqual(mockData);
  });

  it('should return null if not found (PGRST116)', async () => {
    const singleMock = jest.fn().mockResolvedValue({ 
      data: null, 
      error: { code: 'PGRST116', message: 'Not found' } 
    });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('missing_flag');
    
    expect(result).toBeNull();
  });

  it('should throw an error for other supabase errors', async () => {
    const singleMock = jest.fn().mockResolvedValue({ 
      data: null, 
      error: { code: '500', message: 'Internal Server Error' } 
    });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    await expect(getSystemControl('some_flag')).rejects.toThrow(
      'Failed to fetch system control: Internal Server Error'
    );
  });
});