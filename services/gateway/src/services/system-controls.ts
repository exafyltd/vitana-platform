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
      // PGRST116 indicates no rows were returned from a .single() query
      return null;
    }
    throw error;
  }

  return data as SystemControl;
}