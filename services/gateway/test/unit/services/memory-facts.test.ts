import { SupabaseClient } from '@supabase/supabase-js';
import { writeMemoryFact } from '../../../src/services/memory-facts';

describe('writeMemoryFact', () => {
  let mockSupabase: any;
  let mockUpsert: any;

  beforeEach(() => {
    mockUpsert = jest.fn().mockResolvedValue({ error: null });
    mockSupabase = {
      from: jest.fn().mockReturnValue({
        upsert: mockUpsert
      })
    };
  });

  it('writes a memory fact with default provenance_source', async () => {
    const result = await writeMemoryFact(mockSupabase as unknown as SupabaseClient, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      factKey: 'user_first_name',
      factValue: 'Alice',
    });

    expect(result.ok).toBe(true);
    expect(mockSupabase.from).toHaveBeenCalledWith('memory_facts');
    expect(mockUpsert).toHaveBeenCalledWith({
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      fact_key: 'user_first_name',
      fact_value: 'Alice',
      provenance_source: 'user_stated'
    }, { onConflict: 'user_id, fact_key' });
  });

  it('writes a memory fact with explicit provenance_source', async () => {
    const result = await writeMemoryFact(mockSupabase as unknown as SupabaseClient, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      factKey: 'user_first_name',
      factValue: 'Alice',
      provenanceSource: 'user_stated_via_settings'
    });

    expect(result.ok).toBe(true);
    expect(mockUpsert).toHaveBeenCalledWith({
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      fact_key: 'user_first_name',
      fact_value: 'Alice',
      provenance_source: 'user_stated_via_settings'
    }, { onConflict: 'user_id, fact_key' });
  });

  it('handles errors from Supabase', async () => {
    mockUpsert.mockResolvedValueOnce({ error: { message: 'db error' } });
    const result = await writeMemoryFact(mockSupabase as unknown as SupabaseClient, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      factKey: 'user_first_name',
      factValue: 'Alice',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('db error');
  });
});