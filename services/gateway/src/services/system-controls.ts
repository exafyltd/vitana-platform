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
      // Postgres error code for "Row not found"
      return null;
    }
    throw new Error(`Failed to fetch system control: ${error.message}`);
  }

  return data as SystemControl;
}