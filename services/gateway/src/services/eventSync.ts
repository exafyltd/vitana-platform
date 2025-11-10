import { supabase } from '../lib/supabase';

const STATUS_PRIORITY = {
  active: 1,
  blocked: 2,
  review: 3,
  completed: 4,
  cancelled: 5
};

export async function syncVtidFromEvent(event: any): Promise<void> {
  if (!event.vtid || !event.status) {
    return;
  }

  try {
    // Check if VTID exists
    const { data: existing, error: fetchError } = await supabase
      .from('VtidLedger')
      .select('vtid, status')
      .eq('vtid', event.vtid)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('[EventSync] Error fetching VTID:', fetchError);
      return;
    }

    if (!existing) {
      // Create new VTID
      const { error: insertError } = await supabase
        .from('VtidLedger')
        .insert({
          vtid: event.vtid,
          layer: event.layer || 'UNKNOWN',
          module: event.module || 'UNKNOWN',
          description: event.title || 'Auto-created from event',
          status: event.status,
          is_test: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (insertError) {
        console.error('[EventSync] Error creating VTID:', insertError);
      } else {
        console.log(`[EventSync] Created VTID ${event.vtid} with status ${event.status}`);
      }
      return;
    }

    // Update status if priority is higher
    const currentPriority = STATUS_PRIORITY[existing.status as keyof typeof STATUS_PRIORITY];
    const newPriority = STATUS_PRIORITY[event.status as keyof typeof STATUS_PRIORITY];

    if (newPriority > currentPriority) {
      const { error: updateError } = await supabase
        .from('VtidLedger')
        .update({
          status: event.status,
          updated_at: new Date().toISOString()
        })
        .eq('vtid', event.vtid);

      if (!updateError) {
        console.log(`[EventSync] Updated VTID ${event.vtid}: ${existing.status} → ${event.status}`);
      }
    }
  } catch (error) {
    console.error('[EventSync] Unexpected error:', error);
  }
}
