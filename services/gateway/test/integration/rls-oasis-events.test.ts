import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config';

// Set a longer timeout for integration tests that hit an external service
jest.setTimeout(30000);

describe('Integration: RLS on oasis_events table', () => {
  let anonClient: SupabaseClient;
  let serviceClient: SupabaseClient;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set in the environment for integration tests.',
    );
  }

  beforeAll(() => {
    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  });

  const testEventPayload = {
    vtid: `vtid-rls-test-${uuidv4()}`,
    kind: 'test.event',
    status: 'running',
    title: 'RLS Policy Test Event',
  };

  describe('as anonymous user (anon role)', () => {
    it('should be denied from inserting into oasis_events', async () => {
      const { data, error } = await anonClient
        .from('oasis_events')
        .insert(testEventPayload);

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      // PostgREST error code for RLS violation on insert/update
      expect(error?.code).toBe('42501');
      expect(error?.message).toContain(
        'new row violates row-level security policy for table "oasis_events"',
      );
    });

    it('should be denied from reading from oasis_events', async () => {
      // First, ensure a record exists using the service client
      const { data: insertedData, error: insertError } = await serviceClient
        .from('oasis_events')
        .insert(testEventPayload)
        .select()
        .single();

      expect(insertError).toBeNull();
      expect(insertedData).not.toBeNull();

      // Now, try to read it as the anonymous user
      const { data: selectData, error: selectError } = await anonClient
        .from('oasis_events')
        .select('*')
        .eq('id', insertedData.id);

      // A select that finds no rows due to RLS is not an error. It returns an empty array.
      expect(selectError).toBeNull();
      expect(selectData).toEqual([]);

      // Cleanup the record with the service client
      const { error: deleteError } = await serviceClient
        .from('oasis_events')
        .delete()
        .eq('id', insertedData.id);

      expect(deleteError).toBeNull();
    });
  });

  describe('as privileged user (service_role)', () => {
    it('should be able to perform CRUD operations on oasis_events', async () => {
      const testId = uuidv4();
      const eventData = {
        id: testId,
        vtid: `vtid-crud-test-${uuidv4()}`,
        kind: 'crud.test',
        title: 'CRUD Test',
      };

      // 1. INSERT
      const { error: insertError } = await serviceClient
        .from('oasis_events')
        .insert(eventData);
      expect(insertError).toBeNull();

      // 2. SELECT
      const { data: selectData, error: selectError } = await serviceClient
        .from('oasis_events')
        .select('*')
        .eq('id', testId)
        .single();

      expect(selectError).toBeNull();
      expect(selectData).not.toBeNull();
      expect(selectData?.title).toBe('CRUD Test');

      // 3. UPDATE
      const { data: updateData, error: updateError } = await serviceClient
        .from('oasis_events')
        .update({ title: 'CRUD Test Updated' })
        .eq('id', testId)
        .select()
        .single();

      expect(updateError).toBeNull();
      expect(updateData).not.toBeNull();
      expect(updateData?.title).toBe('CRUD Test Updated');

      // 4. DELETE
      const { error: deleteError } = await serviceClient
        .from('oasis_events')
        .delete()
        .eq('id', testId);
      expect(deleteError).toBeNull();

      // 5. VERIFY DELETE
      const { data: verifyData, error: verifyError } = await serviceClient
        .from('oasis_events')
        .select('*')
        .eq('id', testId)
        .single();

      expect(verifyData).toBeNull();
      expect(verifyError).not.toBeNull(); // .single() causes an error on 0 rows
      expect(verifyError?.message).toContain(
        'JSON object requested, multiple (or no) rows returned',
      );
    });
  });
});