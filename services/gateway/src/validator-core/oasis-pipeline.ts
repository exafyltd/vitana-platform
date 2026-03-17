import { getSupabase } from '../lib/supabase';

export class OasisPipeline {
    async logEvent(eventType: string, payload: any): Promise<void> {
        const supabase = getSupabase();

        if (!supabase) {
            console.warn('[OasisPipeline] Supabase not configured - event not logged to DB');
            console.log(`[OASIS] Emitted event (local only): ${payload.eventType}`, payload);
            return;
        }

        const { error } = await supabase.from('oasis_events_v1').insert({
            task_type: eventType,
            metadata: payload.data,
            vtid: 'VTID-00000' // System governance events (no specific task)
        });

        if (error) console.error('Failed to log governance event to OASIS:', error);

        console.log(`[OASIS] Emitted event: ${payload.eventType}`, payload);
    }
}
