import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // PGRST116 indicates that the query returned no rows
    if (error.code === 'PGRST116') {
      return null;
    }
    throw error;
  }

  return data as SystemControl;
}