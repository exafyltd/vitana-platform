import { getSystemControl } from '../src/services/system-controls';
import { supabase } from '../src/lib/supabase';

// Mock the Supabase client
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
  },
}));

describe('SystemControls Service', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns a system control when found', async () => {
    const mockData = {
      key: 'vitana_did_you_know_enabled',
      enabled: true,
      updated_at: '2023-10-01T00:00:00Z',
    };

    const mockEq = jest.fn().mockReturnThis();
    const mockSingle = jest.fn().mockResolvedValue({ data: mockData, error: null });

    (supabase.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: mockEq,
        single: mockSingle,
      }),
    });

    const result = await getSystemControl('vitana_did_you_know_enabled');

    expect(supabase.from).toHaveBeenCalledWith('system_controls');
    expect(mockEq).toHaveBeenCalledWith('key', 'vitana_did_you_know_enabled');
    expect(result).toEqual(mockData);
  });

  it('returns null when system control is not found (PGRST116)', async () => {
    const mockEq = jest.fn().mockReturnThis();
    const mockSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
    });

    (supabase.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: mockEq,
        single: mockSingle,
      }),
    });

    const result = await getSystemControl('missing_key');

    expect(result).toBeNull();
  });

  it('throws an error on other database errors', async () => {
    const mockEq = jest.fn().mockReturnThis();
    const mockSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { code: '500', message: 'Internal Server Error' },
    });

    (supabase.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: mockEq,
        single: mockSingle,
      }),
    });

    await expect(getSystemControl('broken_key')).rejects.toEqual({
      code: '500',
      message: 'Internal Server Error',
    });
  });
});