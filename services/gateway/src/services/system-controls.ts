import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

/**
 * Fetches a single system control configuration by its unique key.
 * @param key The string identifier of the system control.
 * @returns The SystemControl object if found, otherwise null.
 */
export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // PGRST116 is the PostgREST error code for a query returning zero rows
    // when exactly one row was expected via .single()
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to fetch system control ${key}: ${error.message}`);
  }

  return data as SystemControl;
}