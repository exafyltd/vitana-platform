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
      // PGRST116 indicates 0 rows returned
      return null;
    }
    throw new Error(`Failed to fetch system control: ${error.message}`);
  }

  return data as SystemControl;
}