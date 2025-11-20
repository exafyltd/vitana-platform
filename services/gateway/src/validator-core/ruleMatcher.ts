import { createClient } from '@supabase/supabase-js';
import { GovernanceRule } from '../types/governance';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

export class RuleMatcher {
    async getActiveRules(tenantId: string): Promise<GovernanceRule[]> {
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
