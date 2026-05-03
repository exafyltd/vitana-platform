import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

/**
 * Fetches a single system control flag by its key.
 * Returns null if the control does not exist.
 *
 * @param key The unique key of the system control (e.g., 'vitana_did_you_know_enabled')
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
    throw new Error(`Failed to fetch system control: ${error.message}`);
  }

  return data as SystemControl;
}