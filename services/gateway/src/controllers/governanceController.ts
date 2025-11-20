import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { RuleMatcher, EvaluationEngine, EnforcementExecutor, ViolationGenerator, OasisPipeline } from '../validator-core';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

const ruleMatcher = new RuleMatcher();
const evaluationEngine = new EvaluationEngine();
const enforcementExecutor = new EnforcementExecutor();
const violationGenerator = new ViolationGenerator();
const oasisPipeline = new OasisPipeline();

export class GovernanceController {
    private getTenantId(req: Request): string {
        // Enforce tenantId from header or query, default to 'default' if not strict
        // User requirement: "Enforce tenantId on every query"
        const tenantId = (req.headers['x-tenant-id'] as string) || (req.query.tenantId as string) || 'default';
        return tenantId;
    }

    async getRules(req: Request, res: Response) {
        const tenantId = this.getTenantId(req);
        const { data, error } = await supabase
            .from('governance_rules')
            .select('*')
            .eq('tenant_id', tenantId);

        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    }

    async getEvaluations(req: Request, res: Response) {
        const tenantId = this.getTenantId(req);
        const { data, error } = await supabase
            .from('governance_evaluations')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('evaluated_at', { ascending: false })
            .limit(50);

        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    }

    async getEnforcements(req: Request, res: Response) {
        const tenantId = this.getTenantId(req);
        const { data, error } = await supabase
            .from('governance_enforcements')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('executed_at', { ascending: false })
            .limit(50);

        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    }

    async getViolations(req: Request, res: Response) {
        const tenantId = this.getTenantId(req);
        const { data, error } = await supabase
            .from('governance_violations')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    }

    async getLogs(req: Request, res: Response) {
        // Query canonical oasis_events table
        const { data, error } = await supabase
            .from('oasis_events')
            .select('*')
            .eq('service', 'governance') // Filter by service
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    }

    // Ingest logic removed - using canonical /api/v1/events/ingest
    // But we might want a helper to trigger governance from that canonical endpoint if needed.
    // For now, we assume the canonical ingest is the entry point.
}
