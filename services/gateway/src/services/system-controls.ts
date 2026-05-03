import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

/**
 * Fetches a single system control by its key from the public.system_controls table.
 * 
 * @param key - The unique string key for the system control.
 * @returns The SystemControl object if found, otherwise null.
 */
export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // PGRST116 is the Supabase/PostgREST error code for a missing row when using .single()
    if (error.code === 'PGRST116') {
      return null;
    }
    throw error;
  }

  return data as SystemControl;
}