import { upsertMemoryFact } from '../../../src/services/memory-facts';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('Memory Facts Service', () => {
  let mockSupabase: any;

  beforeEach(() => {
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn()
    };
  });

  it('upserts a memory fact with default provenance_source if not provided', async () => {
    mockSupabase.single.mockResolvedValue({
      data: { id: '123', provenance_source: 'user_stated' },
      error: null
    });

    const result = await upsertMemoryFact(mockSupabase as unknown as SupabaseClient, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      factType: 'user_first_name',
      factValue: 'Alice'
    });

    expect(result.ok).toBe(true);
    expect(mockSupabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        tenant_id: 'tenant-1',
        fact_type: 'user_first_name',
        fact_value: 'Alice',
        provenance_source: 'user_stated'
      }),
      expect.any(Object)
    );
  });

  it('upserts a memory fact with provided provenance_source', async () => {
    mockSupabase.single.mockResolvedValue({
      data: { id: '123', provenance_source: 'user_stated_via_settings' },
      error: null
    });

    const result = await upsertMemoryFact(mockSupabase as unknown as SupabaseClient, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      factType: 'user_first_name',
      factValue: 'Alice',
      provenanceSource: 'user_stated_via_settings'
    });

    expect(result.ok).toBe(true);
    expect(mockSupabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance_source: 'user_stated_via_settings'
      }),
      expect.any(Object)
    );
  });

  it('returns error if supabase fails', async () => {
    mockSupabase.single.mockResolvedValue({
      data: null,
      error: { message: 'Database error' }
    });

    const result = await upsertMemoryFact(mockSupabase as unknown as SupabaseClient, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      factType: 'user_first_name',
      factValue: 'Alice'
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Database error');
  });
});