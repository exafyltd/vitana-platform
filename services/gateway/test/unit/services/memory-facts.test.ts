import { upsertMemoryFact } from '../../../src/services/memory-facts';

describe('Memory Facts Service', () => {
  const mockSingle = jest.fn();
  const mockSelect = jest.fn(() => ({ single: mockSingle }));
  const mockUpsert = jest.fn(() => ({ select: mockSelect }));
  const mockFrom = jest.fn(() => ({ upsert: mockUpsert }));

  const mockSupabase = {
    from: mockFrom
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should use default provenance source if not provided', async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: '1' }, error: null });

    const result = await upsertMemoryFact('user_1', 'key', 'val', undefined, mockSupabase);

    expect(result.ok).toBe(true);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ provenance_source: 'user_stated' }),
      expect.anything()
    );
  });

  it('should use provided provenance source', async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: '1' }, error: null });

    const result = await upsertMemoryFact('user_1', 'key', 'val', 'user_stated_via_settings', mockSupabase);

    expect(result.ok).toBe(true);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ provenance_source: 'user_stated_via_settings' }),
      expect.anything()
    );
  });

  it('should return error on database failure', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'db error' } });

    const result = await upsertMemoryFact('user_1', 'key', 'val', 'user_stated_via_settings', mockSupabase);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('db error');
  });
});