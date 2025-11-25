import { getSupabase } from '../lib/supabase';
import { GovernanceRule, GovernanceViolation } from '../types/governance';

export class ViolationGenerator {
    async createViolation(rule: GovernanceRule, violation: GovernanceViolation): Promise<GovernanceViolation> {
        const supabase = getSupabase();

        if (supabase) {
            const { error } = await supabase.from('governance_violations').insert(violation);
            if (error) console.error('Failed to save violation:', error);
        } else {
            console.warn('[ViolationGenerator] Supabase not configured - violation not persisted');
        }

        return violation;
    }
}
