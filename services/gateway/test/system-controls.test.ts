import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

// Mock supabase client
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
    const mockControl = {
      key: 'vitana_did_you_know_enabled',
      enabled: true,
      updated_at: '2023-01-01T00:00:00Z',
      updated_by: 'admin',
      reason: 'Launch rollout'
    };

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

  it('should return null when the control is not found (PGRST116 error)', async () => {
    const singleMock = jest.fn().mockResolvedValue({ 
      data: null, 
      error: { code: 'PGRST116', message: 'Not found' } 
    });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    const result = await getSystemControl('non_existent_key');

    expect(result).toBeNull();
  });

  it('should throw an error if the database query fails with a different error', async () => {
    const mockError = new Error('Database connection failed');
    const singleMock = jest.fn().mockResolvedValue({ data: null, error: mockError });
    const eqMock = jest.fn().mockReturnValue({ single: singleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

    await expect(getSystemControl('some_key')).rejects.toThrow('Database connection failed');
  });
});