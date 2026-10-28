import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Creates a Supabase client authenticated with the user's Bearer token.
 * This allows RPC calls to execute with the user's RLS context.
 *
 * @param userToken - The user's JWT Bearer token (without 'Bearer ' prefix)
 * @returns SupabaseClient configured for user-context calls
 * @throws Error if SUPABASE_URL or SUPABASE_ANON_KEY is not configured
 */
export function createUserSupabaseClient(userToken: string): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      '[Supabase-User] Configuration missing: SUPABASE_URL or SUPABASE_ANON_KEY not set.'
    );
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${userToken}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
