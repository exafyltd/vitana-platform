import type { SupabaseClient } from '@supabase/supabase-js';
import { SystemControl } from '../types/system-controls';

export async function getSystemControl(
  supabase: SupabaseClient,
  key: string
): Promise<{ ok: boolean; data?: SystemControl; error?: string }> {
  try {
    const { data, error } = await supabase
      .from('system_controls')
      .select('*')
      .eq('key', key)
      .single();

    if (error) {
      // PGRST116 indicates 0 rows returned on a .single() query
      if (error.code === 'PGRST116') {
        return { ok: false, error: 'Not found' };
      }
      return { ok: false, error: error.message };
    }

    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Unknown error' };
  }
}