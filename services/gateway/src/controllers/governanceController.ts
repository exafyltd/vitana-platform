import { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { RuleMatcher, EvaluationEngine, EnforcementExecutor, ViolationGenerator, OasisPipeline } from '../validator-core';
import {
    GovernanceCategoryResponse,
    GovernanceRuleResponse,
    GovernanceViolationResponse,
    GovernanceEnforcementResponse,
    GovernanceEvaluationResponse,
    GovernanceFeedItemResponse,
    GovernanceSummaryResponse,
    RuleDTO,
    EvaluationDTO,
    ViolationDTO,
    ProposalDTO,
    FeedEntry,
    EvaluationSummary,
    ProposalTimelineEvent
} from '../types/governance';

// Removed unsafe module-load createClient - now using getSupabase() in methods

const ruleMatcher = new RuleMatcher();
const evaluationEngine = new EvaluationEngine();
const enforcementExecutor = new EnforcementExecutor();
const violationGenerator = new ViolationGenerator();
const oasisPipeline = new OasisPipeline();

export class GovernanceController {
    private getTenantId(req: Request): string {
        // Enforce tenantId from header or query, default to 'SYSTEM' for governance
        const tenantId = (req.headers['x-tenant-id'] as string) || (req.query.tenantId as string) || 'SYSTEM';
        return tenantId;
    }

    /**
     * GET /api/v1/governance/categories
     * Returns all governance categories
     */
    async getCategories(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - categories fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }

            const { data: categories, count, error } = await supabase
                .from('governance_categories')
                .select('*', { count: 'exact' })
                .eq('tenant_id', tenantId)
                .order('name', { ascending: true })
                .range(offset, offset + limit - 1);

            if (error) {
                console.error('Error fetching categories:', error);
                return res.status(500).json({ error: error.message });
            }

            const categoryDTOs: GovernanceCategoryResponse[] = (categories || []).map((cat: any) => ({
                id: cat.id,
                categoryName: cat.name,
                description: cat.description || '',
                governanceArea: cat.name.replace('_GOVERNANCE', '').toLowerCase(),
                severity: cat.severity || 0
            }));

            res.json({
                ok: true,
                data: categoryDTOs,
                count: count || 0
            });
        } catch (error: any) {
            console.error('Error in getCategories:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/rules
     * Query params: category?, status?, ruleCode?
     */
    async getRules(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const { category, status, ruleCode } = req.query;
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - rules fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }

            let query = supabase
                .from('governance_rules')
                .select('*, governance_categories(name)', { count: 'exact' })
                .eq('tenant_id', tenantId);

            if (category) {
                query = query.eq('governance_categories.name', category);
            }
            if (status) query = query.eq('is_active', status === 'Active');
            if (ruleCode) query = query.eq('logic->>rule_code', ruleCode);

            const { data: rules, count, error } = await query
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (error) {
                console.error('Error fetching rules:', error);
                return res.status(500).json({ error: error.message });
            }

            const ruleDTOs: GovernanceRuleResponse[] = (rules || []).map((rule: any) => ({
                ruleCode: rule.logic?.rule_code || rule.id,
                name: rule.name,
                category: rule.governance_categories?.name || 'Uncategorized',
                status: rule.is_active ? 'Active' : 'Deprecated',
                severity: 0, // Placeholder
                description: rule.description || '',
                createdAt: rule.created_at,
                updatedAt: rule.created_at
            }));

            res.json({
                ok: true,
                data: ruleDTOs,
                count: count || 0
            });
        } catch (error: any) {
            console.error('Error in getRules:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/rules/:ruleCode
     * Legacy endpoint - keeping for compatibility
     */
    async getRuleByCode(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const { ruleCode } = req.params;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - rule fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }
            const { data: rules, error } = await supabase
                .from('governance_rules')
                .select(`
                    *,
                    governance_categories (
                        name
                    )
                `)
                .eq('tenant_id', tenantId)
                .eq('logic->>rule_code', ruleCode)
                .limit(1);

            if (error) {
                console.error('Error fetching rule:', error);
                return res.status(500).json({ error: error.message });
            }

            if (!rules || rules.length === 0) {
                return res.status(404).json({ error: `Rule ${ruleCode} not found` });
            }

            const rule = rules[0];
            const categoryName = (rule.governance_categories as any)?.name || 'Uncategorized';

            // Determine status
            let ruleStatus: 'Active' | 'Draft' | 'Deprecated' | 'Proposal';
            if (rule.is_active) {
                ruleStatus = 'Active';
            } else if (rule.logic?.status === 'draft') {
                ruleStatus = 'Draft';
            } else if (rule.logic?.status === 'deprecated') {
                ruleStatus = 'Deprecated';
            } else {
                ruleStatus = 'Proposal';
            }

            // Fetch recent evaluations
            const { data: evaluations } = await supabase
                .from('governance_evaluations')
                .select('*')
                .eq('rule_id', rule.id)
                .order('evaluated_at', { ascending: false })
                .limit(5);

            const lastEvaluations: EvaluationSummary[] = (evaluations || []).map((ev: any) => ({
                timestamp: ev.evaluated_at,
                result: ev.status === 'PASS' ? 'Pass' as const : 'Fail' as const,
                executor: ev.metadata?.executor || 'System'
            }));

            const ruleDTO: RuleDTO = {
                ruleCode: rule.logic?.rule_code || rule.id,
                name: rule.name,
                category: categoryName,
                status: ruleStatus,
                description: rule.description || '',
                logic: rule.logic,
                updatedAt: rule.created_at,
                relatedServices: rule.logic?.relatedServices || [],
                lastEvaluations
            };

            res.json(ruleDTO);
        } catch (error: any) {
            console.error('Error in getRuleByCode:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/proposals
     * Legacy endpoint
     */
    async getProposals(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const { status, ruleCode, limit, offset } = req.query;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - proposals fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }
            let query = supabase
                .from('governance_proposals')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false });

            if (status) {
                query = query.eq('status', status as string);
            }
            if (ruleCode) {
                query = query.eq('rule_code', ruleCode as string);
            }
            if (limit) {
                query = query.limit(parseInt(limit as string));
            }
            if (offset) {
                query = query.range(parseInt(offset as string), parseInt(offset as string) + (parseInt(limit as string || '50') - 1));
            }

            const { data: proposals, error } = await query;

            if (error) {
                console.error('Error fetching proposals:', error);
                return res.status(500).json({ error: error.message });
            }

            // Transform to ProposalDTO
            const proposalDTOs: ProposalDTO[] = (proposals || []).map((p: any) => ({
                proposalId: p.proposal_id,
                type: p.type,
                ruleCode: p.rule_code || '(new)',
                status: p.status,
                createdBy: p.created_by,
                updatedAt: p.updated_at,
                originalRule: p.original_rule || null,
                proposedRule: p.proposed_rule,
                rationale: p.rationale || null,
                timeline: p.timeline || []
            }));

            res.json(proposalDTOs);
        } catch (error: any) {
            console.error('Error in getProposals:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * POST /api/v1/governance/proposals
     * Legacy endpoint
     */
    async createProposal(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const { type, ruleCode, proposedRule, rationale, source } = req.body;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - proposal creation unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }
            if (!type || !proposedRule) {
                return res.status(400).json({ error: 'type and proposedRule are required' });
            }

            // Generate proposal ID: PROP-YYYYMMDDHHMMSS-XXXX
            const now = new Date();
            const timestamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
            const random = Math.random().toString(36).substring(2, 6).toUpperCase();
            const proposalId = `PROP-${timestamp}-${random}`;

            const createdBy = source || 'User';
            const initialStatus = createdBy === 'User' ? 'Draft' : 'Under Review';

            // Initialize timeline
            const timeline: ProposalTimelineEvent[] = [
                {
                    event: 'Created',
                    timestamp: now.toISOString(),
                    actor: createdBy
                }
            ];

            // Fetch original rule if ruleCode provided and type is Change/Deprecate
            let originalRule = null;
            if (ruleCode && (type === 'Change Rule' || type === 'Deprecate Rule')) {
                const { data: rules } = await supabase
                    .from('governance_rules')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .eq('logic->>rule_code', ruleCode)
                    .limit(1);

                if (rules && rules.length > 0) {
                    const rule = rules[0];
                    originalRule = {
                        ruleCode: rule.logic?.rule_code || rule.id,
                        name: rule.name,
                        description: rule.description,
                        logic: rule.logic
                    };
                }
            }

            // Insert proposal
            const { data: proposal, error } = await supabase
                .from('governance_proposals')
                .insert({
                    tenant_id: tenantId,
                    proposal_id: proposalId,
                    type,
                    rule_code: ruleCode || null,
                    status: initialStatus,
                    created_by: createdBy,
                    original_rule: originalRule,
                    proposed_rule: proposedRule,
                    rationale,
                    timeline
                })
                .select()
                .single();

            if (error) {
                console.error('Error creating proposal:', error);
                return res.status(500).json({ error: error.message });
            }

            // Emit OASIS event
            await this.emitOasisEvent(tenantId, 'governance.proposal.created', {
                proposalId,
                ruleCode: ruleCode || '(new)',
                type,
                createdBy,
                status: initialStatus
            });

            // Return DTO
            const proposalDTO: ProposalDTO = {
                proposalId: proposal.proposal_id,
                type: proposal.type,
                ruleCode: proposal.rule_code || '(new)',
                status: proposal.status,
                createdBy: proposal.created_by,
                updatedAt: proposal.updated_at,
                originalRule: proposal.original_rule,
                proposedRule: proposal.proposed_rule,
                rationale: proposal.rationale,
                timeline: proposal.timeline
            };

            res.status(201).json(proposalDTO);
        } catch (error: any) {
            console.error('Error in createProposal:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * PATCH /api/v1/governance/proposals/:proposalId/status
     * Legacy endpoint
     */
    async updateProposalStatus(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const { proposalId } = req.params;
            const { status } = req.body;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - proposal status update unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }
            if (!status) {
                return res.status(400).json({ error: 'status is required' });
            }

            // Validate status transitions
            const validStatuses = ['Draft', 'Under Review', 'Approved', 'Rejected', 'Implemented'];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
            }

            // Fetch current proposal
            const { data: currentProposal, error: fetchError } = await supabase
                .from('governance_proposals')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('proposal_id', proposalId)
                .single();

            if (fetchError || !currentProposal) {
                return res.status(404).json({ error: `Proposal ${proposalId} not found` });
            }

            // Validate transition
            const currentStatus = currentProposal.status;
            const validTransitions: Record<string, string[]> = {
                'Draft': ['Under Review', 'Rejected'],
                'Under Review': ['Approved', 'Rejected'],
                'Approved': ['Implemented'],
                'Rejected': [],
                'Implemented': []
            };

            if (!validTransitions[currentStatus]?.includes(status)) {
                return res.status(400).json({
                    error: `Invalid transition from ${currentStatus} to ${status}`
                });
            }

            // Update timeline
            const newTimeline = [
                ...(currentProposal.timeline || []),
                {
                    event: `Status changed to ${status}`,
                    timestamp: new Date().toISOString(),
                    actor: 'System'
                }
            ];

            // Update proposal
            const { data: updatedProposal, error: updateError } = await supabase
                .from('governance_proposals')
                .update({
                    status,
                    timeline: newTimeline
                })
                .eq('proposal_id', proposalId)
                .select()
                .single();

            if (updateError) {
                console.error('Error updating proposal:', updateError);
                return res.status(500).json({ error: updateError.message });
            }

            // Emit OASIS event
            await this.emitOasisEvent(tenantId, 'governance.proposal.status_changed', {
                proposalId,
                ruleCode: updatedProposal.rule_code || '(new)',
                oldStatus: currentStatus,
                newStatus: status
            });

            // Return DTO
            const proposalDTO: ProposalDTO = {
                proposalId: updatedProposal.proposal_id,
                type: updatedProposal.type,
                ruleCode: updatedProposal.rule_code || '(new)',
                status: updatedProposal.status,
                createdBy: updatedProposal.created_by,
                updatedAt: updatedProposal.updated_at,
                originalRule: updatedProposal.original_rule,
                proposedRule: updatedProposal.proposed_rule,
                rationale: updatedProposal.rationale,
                timeline: updatedProposal.timeline
            };

            res.json(proposalDTO);
        } catch (error: any) {
            console.error('Error in updateProposalStatus:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/evaluations
     * Query params: ruleCode?, result?, from?, to?, limit?, offset?
     */
    async getEvaluations(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const { ruleCode, result, from, to } = req.query;
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - evaluations fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }
            let query = supabase
                .from('governance_evaluations')
                .select(`
                    *,
                    governance_rules!inner (
                        logic
                    )
                `, { count: 'exact' })
                .eq('tenant_id', tenantId)
                .order('evaluated_at', { ascending: false });

            if (result) {
                query = query.eq('status', result === 'pass' ? 'PASS' : 'FAIL');
            }
            if (from) {
                query = query.gte('evaluated_at', from as string);
            }
            if (to) {
                query = query.lte('evaluated_at', to as string);
            }
            if (ruleCode) {
                // Filter logic handled in memory or via join if possible
            }

            const { data: evaluations, count, error } = await query
                .range(offset, offset + limit - 1);

            if (error) {
                console.error('Error fetching evaluations:', error);
                return res.status(500).json({ error: error.message });
            }

            // Transform to GovernanceEvaluationResponse
            let evaluationDTOs: GovernanceEvaluationResponse[] = (evaluations || []).map((ev: any) => ({
                id: ev.id,
                ruleCode: (ev.governance_rules as any)?.logic?.rule_code || 'Unknown',
                evaluationResult: ev.status === 'PASS' ? 'pass' : 'fail',
                evaluatedAt: ev.evaluated_at,
                details: ev.metadata || {}
            }));

            // Filter by ruleCode if provided (in memory fallback)
            if (ruleCode) {
                evaluationDTOs = evaluationDTOs.filter(ev => ev.ruleCode === ruleCode);
            }

            res.json({
                ok: true,
                data: evaluationDTOs,
                count: count || 0
            });
        } catch (error: any) {
            console.error('Error in getEvaluations:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/violations
     */
    async getViolations(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;
            const { ruleCode, severity, source } = req.query;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - violations fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }
            let query = supabase
                .from('governance_violations')
                .select(`
                    *,
                    governance_rules (
                        logic
                    )
                `, { count: 'exact' })
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false });

            if (severity) query = query.eq('severity', severity);

            const { data: violations, count, error } = await query
                .range(offset, offset + limit - 1);

            if (error) {
                console.error('Error fetching violations:', error);
                return res.status(500).json({ error: error.message });
            }

            // Transform to GovernanceViolationResponse
            let violationDTOs: GovernanceViolationResponse[] = (violations || []).map((v: any) => ({
                id: v.id,
                ruleCode: (v.governance_rules as any)?.logic?.rule_code || 'Unknown',
                description: `Violation of governance rule`,
                severity: v.severity,
                detectedAt: v.created_at,
                source: 'System', // Placeholder
                metadata: { status: v.status }
            }));

            if (ruleCode) {
                violationDTOs = violationDTOs.filter(v => v.ruleCode === ruleCode);
            }

            res.json({
                ok: true,
                data: violationDTOs,
                count: count || 0
            });
        } catch (error: any) {
            console.error('Error in getViolations:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/feed
     */
    async getFeed(req: Request, res: Response) {
        try {
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - feed fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }

            const { data: events, count, error } = await supabase
                .from('oasis_events_v1')
                .select('*', { count: 'exact' })
                .eq('tenant', 'SYSTEM')
                .or('task_type.like.%governance%,notes.like.%governance%')
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (error) {
                console.error('Error fetching feed:', error);
                return res.status(500).json({ error: error.message });
            }

            // Transform to GovernanceFeedItemResponse
            const feedEntries: GovernanceFeedItemResponse[] = (events || []).map((ev: any) => {
                let summary = ev.notes || ev.task_type || 'Governance event';

                // Try to parse governance events from metadata
                const metadata = ev.metadata || {};

                if (metadata.proposalId) {
                    summary = `Proposal ${metadata.proposalId} ${metadata.newStatus ? `changed to ${metadata.newStatus}` : 'created'}`;
                } else if (metadata.ruleCode) {
                    summary = `Rule ${metadata.ruleCode} activity`;
                }

                return {
                    id: ev.id.toString(),
                    type: 'event',
                    summary,
                    createdAt: ev.created_at,
                    payload: metadata
                };
            });

            res.json({
                ok: true,
                data: feedEntries,
                count: count || 0
            });
        } catch (error: any) {
            console.error('Error in getFeed:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/enforcements
     */
    async getEnforcements(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;
            const { ruleCode, status } = req.query;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - enforcements fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }

            let query = supabase
                .from('governance_enforcements')
                .select('*', { count: 'exact' })
                .eq('tenant_id', tenantId)
                .order('executed_at', { ascending: false });

            if (status) query = query.eq('status', status);

            const { data: enforcements, count, error } = await query
                .range(offset, offset + limit - 1);

            if (error) {
                return res.status(500).json({ error: error.message });
            }

            const enforcementDTOs: GovernanceEnforcementResponse[] = (enforcements || []).map((e: any) => ({
                id: e.id,
                ruleCode: e.rule_id, // Assuming rule_id is the code or we need to join. For now using rule_id
                action: e.action,
                status: e.status === 'SUCCESS' ? 'Completed' : (e.status === 'FAILURE' ? 'Failed' : 'Pending'),
                createdAt: e.executed_at,
                updatedAt: e.executed_at
            }));

            res.json({
                ok: true,
                data: enforcementDTOs,
                count: count || 0
            });
        } catch (error: any) {
            console.error('Error in getEnforcements:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/logs
     * Legacy endpoint
     */
    async getLogs(req: Request, res: Response) {
        try {
            // Query canonical oasis_events table
            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - logs fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }

            const { data, error } = await supabase
                .from('oasis_events')
                .select('*')
                .eq('service', 'governance') // Filter by service
                .order('created_at', { ascending: false })
                .limit(100);

            if (error) return res.status(500).json({ error: error.message });
            res.json(data);
        } catch (error: any) {
            console.error('Error in getLogs:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/summary
     * Returns governance dashboard summary statistics
     */
    async getSummary(req: Request, res: Response) {
        try {
            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - summary unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }

            // Query 1: Total and active rules
            const { data: rules } = await supabase
                .from('governance_rules')
                .select('is_active');

            const totalRules = rules?.length || 0;
            const activeRules = rules?.filter(r => r.is_active).length || 0;

            // Query 2: Violations this week
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

            const { count: violationsThisWeek } = await supabase
                .from('governance_violations')
                .select('*', { count: 'exact', head: true })
                .gte('created_at', oneWeekAgo.toISOString());

            // Query 3: Pending enforcements
            const { count: pendingEnforcements } = await supabase
                .from('governance_enforcements')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'PENDING');

            // Query 4: Events in last 24 hours
            const oneDayAgo = new Date();
            oneDayAgo.setDate(oneDayAgo.getDate() - 1);

            const { count: events24h } = await supabase
                .from('oasis_events_v1')
                .select('*', { count: 'exact', head: true })
                .gte('created_at', oneDayAgo.toISOString());

            // Query 5: Most active category (by violation count)
            // This is complex to do efficiently in one query without aggregation support in client
            // We'll fetch recent violations and aggregate in memory for now
            const { data: categoryViolations } = await supabase
                .from('governance_violations')
                .select('governance_rules(category_id)')
                .limit(100);

            // Count violations per category
            const categoryCounts: Record<string, number> = {};
            categoryViolations?.forEach((v: any) => {
                const category = v.governance_rules?.category_id || 'UNKNOWN';
                categoryCounts[category] = (categoryCounts[category] || 0) + 1;
            });

            const mostActiveCategory = Object.keys(categoryCounts).reduce((a, b) =>
                categoryCounts[a] > categoryCounts[b] ? a : b, 'N/A');

            const summary: GovernanceSummaryResponse = {
                totalRules,
                activeRules,
                violationsThisWeek: violationsThisWeek || 0,
                pendingEnforcements: pendingEnforcements || 0,
                events24h: events24h || 0,
                mostActiveCategory
            };

            res.json({
                ok: true,
                data: summary
            });
        } catch (error: any) {
            console.error('Error in getSummary:', error);
            res.status(500).json({
                ok: false,
                error: error.message
            });
        }
    }

    /**
     * Helper to emit OASIS events
     */
    private async emitOasisEvent(tenant: string, eventType: string, data: any) {
        try {
            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - OASIS event not persisted');
                return;
            }

            await supabase.from('oasis_events_v1').insert({
                rid: `GOV-${Date.now()}`,
                tenant,
                task_type: eventType,
                assignee_ai: 'Gemini',
                status: 'success',
                notes: `Governance event: ${eventType}`,
                metadata: data,
                schema_version: 1
            });
        } catch (error) {
            console.error('Failed to emit OASIS event:', error);
        }
    }
}
