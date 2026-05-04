import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

/**
 * Fetch a single system control record by its key.
 * Returns null if the control does not exist.
 *
 * @param key The unique identifier of the system control (e.g., 'vitana_did_you_know_enabled')
 * @returns SystemControl object or null
 */
export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // PGRST116 is the PostgREST error code for "JSON object requested, multiple (or no) rows returned"
    if (error.code === 'PGRST116') {
      return null;
    }
    throw error;
  }

  return data as SystemControl;
}