import { supabase } from '../lib/supabase';
import { SystemControl } from '../types/system-controls';

export const getSystemControl = async (key: string): Promise<SystemControl | null> => {
  const { data, error } = await supabase
    .from('system_controls')
    .select('*')
    .eq('key', key)
    .single();

  if (error) {
    // Supabase returns PGRST116 when `.single()` finds exactly 0 rows
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to fetch system control: ${error.message}`);
  }

  return data as SystemControl;
};