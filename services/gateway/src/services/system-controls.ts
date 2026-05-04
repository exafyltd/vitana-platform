import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

/**
 * Fetches a single system control by its key from the database.
 * 
 * @param key The unique key of the system control flag
 * @returns The SystemControl object or null if not found
 */
export const getSystemControl = async (key: string): Promise<SystemControl | null> => {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // PGRST116 is the standard PostgREST error code when .single() yields no rows
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to fetch system control ${key}: ${error.message}`);
  }

  return data as SystemControl;
};