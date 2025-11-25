import { getSupabase } from '../lib/supabase';
import { GovernanceRule, GovernanceEnforcement } from '../types/governance';

// Removed top-level createClient


export class EnforcementExecutor {
    async executeEnforcement(rule: GovernanceRule, entityId: string, context: any): Promise<GovernanceEnforcement> {
        const action = rule.logic?.action || 'LOG';
        let status = 'EXECUTED';
        let details = {};

        try {
            console.log(`Executing enforcement: ${action} for rule ${rule.id} on entity ${entityId} (Tenant: ${rule.tenant_id})`);
            details = { action_executed: true, context };
        } catch (error: any) {
            status = 'FAILED';
            details = { error: error.message };
        }

        const enforcement: GovernanceEnforcement = {
            id: crypto.randomUUID(),
            tenant_id: rule.tenant_id,
            rule_id: rule.id,
            action,
            status,
            executed_at: new Date().toISOString(),
            details
        };

        const supabase = getSupabase();

        if (supabase) {
            const { error } = await supabase.from('governance_enforcements').insert(enforcement);
            if (error) console.error('Failed to save enforcement:', error);
        } else {
            console.warn('[EnforcementExecutor] Supabase not configured - enforcement not persisted');
        }

        return enforcement;
    }
}
