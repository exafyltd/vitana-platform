import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

/**
 * Fetches a single system control configuration by its unique key.
 * 
 * @param key The key of the system control (e.g., 'vitana_did_you_know_enabled')
 * @returns The SystemControl object if found, or null if it doesn't exist.
 */
export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // PGRST116 is the standard Supabase/PostgREST error code for "zero rows returned"
    // when using .single()
    if (error.code === 'PGRST116') {
      return null;
    }
    throw error;
  }

  return data as SystemControl;
}