import { createClient, SupabaseClient } from '@supabase/supabase-js';

// These tests require a running Supabase instance.
// The environment variables SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY
// must be set in the test environment (e.g., via a .env file loaded by the test runner).

describe('Integration: RLS on oasis_events table', () => {
  let anonClient: SupabaseClient;
  let serviceClient: SupabaseClient;

  beforeAll(() => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error(
        'SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set for integration tests.'
      );
    }

    anonClient = createClient(supabaseUrl, anonKey);
    serviceClient = createClient(supabaseUrl, serviceRoleKey);
  });

  describe('as an unauthenticated (anon) user', () => {
    it('should be denied from inserting a new event', async () => {
      const { data, error } = await anonClient.from('oasis_events').insert({
        vtid: 'rls-test-anon-insert',
        kind: 'test',
        title: 'This should fail',
      });

      expect(data).toBeNull();
      expect(error).not.toBeNull();
      // The error code for RLS violation on insert is '42501' (insufficient_privilege)
      // and the message contains 'new row violates row-level security policy'.
      expect(error?.code).toBe('42501');
      expect(error?.message).toContain(
        'new row violates row-level security policy for table "oasis_events"'
      );
    });

    it('should receive an empty array when selecting events', async () => {
      // With RLS enabled and no SELECT policy for the anon role, Supabase
      // returns an empty array and no error, which is the correct and secure behavior.
      const { data, error } = await anonClient.from('oasis_events').select('*');

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe('as a privileged (service_role) user', () => {
    const testEvent = {
      vtid: `rls-test-service-role-${Date.now()}`,
      kind: 'test',
      title: 'This should succeed',
    };

    // Clean up any potential leftovers after tests
    afterAll(async () => {
      const { error } = await serviceClient
        .from('oasis_events')
        .delete()
        .eq('vtid', testEvent.vtid);
      if (error) {
        console.error('Error cleaning up test event:', error.message);
      }
    });

    it('should be able to insert and select events', async () => {
      // 1. Insert an event
      const { error: insertError } = await serviceClient
        .from('oasis_events')
        .insert(testEvent);

      expect(insertError).toBeNull();

      // 2. Select the event back
      const { data, error: selectError } = await serviceClient
        .from('oasis_events')
        .select('*')
        .eq('vtid', testEvent.vtid);

      expect(selectError).toBeNull();
      expect(data).toHaveLength(1);
      expect(data?.[0].vtid).toBe(testEvent.vtid);
    });
  });
});