import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

/**
 * Fetches a single system control configuration by its key.
 *
 * @param key The unique key of the system control (e.g., 'vitana_did_you_know_enabled')
 * @returns The SystemControl record or null if not found
 */
export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // Supabase returns PGRST116 when .single() finds no rows
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to fetch system control: ${error.message}`);
  }

  return data as SystemControl;
}