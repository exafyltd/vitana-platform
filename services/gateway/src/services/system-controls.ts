import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

export async function getSystemControl(key: string): Promise<SystemControl | null> {
  try {
    const { data, error } = await supabase
      .from('system_controls')
      .select('*')
      .eq('key', key)
      .single();

    if (error) {
      // PGRST116 is the PostgREST error code for "JSON object requested, multiple (or no) rows returned"
      // It occurs when .single() finds no rows. We return null in this case.
      if (error.code === 'PGRST116') {
        return null;
      }
      console.error(`Error fetching system control for key "${key}":`, error);
      return null;
    }

    return data as SystemControl;
  } catch (err) {
    console.error(`Unexpected error fetching system control for key "${key}":`, err);
    return null;
  }
}