import { GovernanceRule, GovernanceEvaluation } from '../types/governance';

export class EvaluationEngine {
    evaluate(rule: GovernanceRule, entityId: string, context: any): GovernanceEvaluation {
        const logic = rule.logic;
        const isPass = this.executeLogic(logic, context);

        return {
            id: crypto.randomUUID(),
            tenant_id: rule.tenant_id,
            rule_id: rule.id,
            entity_id: entityId,
            status: isPass ? 'PASS' : 'FAIL',
            evaluated_at: new Date().toISOString(),
            metadata: { context, logic_result: isPass }
        };
    }

    private executeLogic(logic: any, data: any): boolean {
        if (!logic || !logic.op) return true;

        const value = data[logic.field];
        const target = logic.value;

        switch (logic.op) {
            case 'eq': return value === target;
            case 'neq': return value !== target;
            case 'gt': return value > target;
            case 'lt': return value < target;
            case 'gte': return value >= target;
            case 'lte': return value <= target;
            case 'contains': return Array.isArray(value) && value.includes(target);
            default: return false;
        }
    }
}
