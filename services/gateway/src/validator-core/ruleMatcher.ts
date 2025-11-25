import { getSupabase } from '../lib/supabase';

import { GovernanceRule } from '../types/governance';

// Removed top-level createClient


export class RuleMatcher {
    async getActiveRules(tenantId: string): Promise<GovernanceRule[]> {
        const supabase = getSupabase();

        if (!supabase) {
            console.error('[RuleMatcher] Supabase not configured - cannot fetch rules');
            return [];
        }

        const { data, error } = await supabase
            .from('governance_rules')
            .select('*')
            .eq('is_active', true)
            .eq('tenant_id', tenantId);

        if (error) {
            console.error('Error fetching rules:', error);
            throw new Error('Failed to fetch active rules');
        }

        return data as GovernanceRule[];
    }

    async matchRulesForEntity(tenantId: string, entityType: string, context: any): Promise<GovernanceRule[]> {
        return this.getActiveRules(tenantId);
    }
}
