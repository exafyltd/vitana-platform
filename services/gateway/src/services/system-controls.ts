import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // PGRST116 indicates no rows returned from a .single() query
    if (error.code === 'PGRST116') {
      return null;
    }
    console.error(`Error fetching system control ${key}:`, error);
    return null;
  }

  if (!data) {
    return null;
  }

  return data as SystemControl;
}