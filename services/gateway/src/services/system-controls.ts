import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // PGRST116 indicates multiple (or no) rows returned when single() is used
      return null;
    }
    throw new Error(`Error fetching system control ${key}: ${error.message}`);
  }

  return data as SystemControl;
}