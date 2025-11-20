import { createClient } from '@supabase/supabase-js';
import { GovernanceRule, GovernanceViolation } from '../types/governance';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

export class ViolationGenerator {
    async createViolation(rule: GovernanceRule, entityId: string): Promise<GovernanceViolation> {
        const violation: GovernanceViolation = {
            id: crypto.randomUUID(),
            tenant_id: rule.tenant_id,
            rule_id: rule.id,
            entity_id: entityId,
            severity: rule.logic?.severity || 1,
            status: 'OPEN',
            created_at: new Date().toISOString()
        };

        const { error } = await supabase.from('governance_violations').insert(violation);
        if (error) console.error('Failed to save violation:', error);

        return violation;
    }
}
