import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

/**
 * Fetches a single system control by its key.
 * Returns null if the control does not exist.
 */
export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // PGRST116 means zero rows returned (not found)
    if (error.code === 'PGRST116') {
      return null;
    }
    throw error;
  }

  return data as SystemControl;
}