import { getSupabase } from '../lib/supabase';
import { GovernanceRule, GovernanceViolation } from '../types/governance';
import * as repo from './violation-generator-repository';

export class ViolationGenerator {
    async createViolation(rule: GovernanceRule, violation: GovernanceViolation): Promise<GovernanceViolation> {
        const supabase = getSupabase();

        if (supabase) {
            const { error } = await repo.insertGovernanceViolation(supabase, violation);
            if (error) console.error('Failed to save violation:', error);
        } else {
            console.warn('[ViolationGenerator] Supabase not configured - violation not persisted');
        }

        return violation;
    }
}
