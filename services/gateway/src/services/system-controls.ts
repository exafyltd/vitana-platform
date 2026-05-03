import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

export async function getSystemControl(key: string): Promise<SystemControl | null> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error || !data) {
    // PostgREST returns PGRST116 when no rows are found on a single() query
    if (error && error.code !== 'PGRST116') {
      console.error(`Error fetching system control ${key}:`, error);
    }
    return null;
  }

  return data as SystemControl;
}