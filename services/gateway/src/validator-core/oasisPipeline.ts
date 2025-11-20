import { createClient } from '@supabase/supabase-js';
import { OasisGovernanceEventPayload } from '../types/governance';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

export class OasisPipeline {
    async emitEvent(payload: OasisGovernanceEventPayload): Promise<void> {
        // Use canonical oasis_events table
        // Mapping: 
        // - topic = eventType
        // - service = 'governance'
        // - status = 'info' (or 'warning' for violations)
        // - metadata = payload.data

        const status = payload.eventType === 'GOVERNANCE_VIOLATION' ? 'warning' : 'info';

        const { error } = await supabase.from('oasis_events').insert({
            id: payload.eventId,
            created_at: payload.timestamp,
            topic: payload.eventType,
            service: 'governance',
            status: status,
            message: `Governance event: ${payload.eventType}`,
            metadata: payload.data,
            vtid: 'DEV-OASIS-GOV-0101' // Tag with current task ID
        });

        if (error) console.error('Failed to log governance event to OASIS:', error);

        console.log(`[OASIS] Emitted event: ${payload.eventType}`, payload);
    }
}
