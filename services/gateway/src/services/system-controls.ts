import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

/**
 * Fetches a system control flag by its unique key.
 * Returns null if the control key is not found.
 */
export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // PGRST116 is the error code Supabase/PostgREST returns when no rows are found
    // on a .single() query.
    if (error.code === 'PGRST116') {
      return null;
    }
    throw error;
  }

  return data as SystemControl;
}