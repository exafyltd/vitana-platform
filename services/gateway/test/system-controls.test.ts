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

  it('should return a system control by key', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    const singleMock = jest.fn().mockResolvedValue({ data: mockControl, error: null });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('vitana_did_you_know_enabled');
    
    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(result).toEqual(mockControl);
  });

  it('should return null if control is not found (PGRST116)', async () => {
    const singleMock = jest.fn().mockResolvedValue({ 
      data: null, 
      error: { code: 'PGRST116', message: 'Not Found' } 
    });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('missing_key');
    expect(result).toBeNull();
  });

  it('should throw an error on database failure', async () => {
    const dbError = new Error('Database connection failed');
    const singleMock = jest.fn().mockResolvedValue({ data: null, error: dbError });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    await expect(getSystemControl('error_key')).rejects.toThrow('Database connection failed');
  });
});