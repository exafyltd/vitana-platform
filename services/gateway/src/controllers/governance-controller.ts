import { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { RuleMatcher, EvaluationEngine, EnforcementExecutor, ViolationGenerator, OasisPipeline } from '../validator-core';
import { RuleDTO, EvaluationDTO, ViolationDTO, ProposalDTO, FeedEntry, EvaluationSummary, ProposalTimelineEvent } from '../types/governance';

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

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - categories fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }
            const { data: categories, error } = await supabase
                .from('governance_categories')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('name', { ascending: true });

            if (error) {
                console.error('Error fetching categories:', error);
                return res.status(500).json({ error: error.message });
            }

            // Transform to simple DTO
            const categoryDTOs = (categories || []).map((cat: any) => ({
                id: cat.id,
                category_name: cat.name,
                description: cat.description || null,
                governance_area: cat.name.replace('_GOVERNANCE', '').toLowerCase(),
                severity: cat.severity || null
            }));

            res.json(categoryDTOs);
        } catch (error: any) {
            console.error('Error in getCategories:', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /api/v1/governance/rules
     * Query params: category?, status?, level?, search?
     *
     * VTID-0401: Returns rules in catalog format for the Governance Rules UI.
     * Response shape:
     * {
     *   "ok": true,
     *   "vtid": "VTID-0401",
     *   "count": 35,
     *   "data": [...]
     * }
     */
    async getRules(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);
            const { category, status, level, search } = req.query;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - rules fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    vtid: 'VTID-0401',
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }

            let query = supabase
                .from('governance_rules')
                .select(`
                    *,
                    governance_categories (
                        name,
                        code
                    )
                `)
                .eq('tenant_id', tenantId)
                .order('rule_id', { ascending: true });

            // Apply level filter at DB level if provided
            if (level) {
                query = query.eq('level', level as string);
            }

            const { data: rules, error } = await query;

            if (error) {
                console.error('Error fetching rules:', error);
                return res.status(500).json({
                    ok: false,
                    vtid: 'VTID-0401',
                    error: error.message
                });
            }

            // Transform to catalog format
            let catalogRules = (rules || []).map((rule: any) => {
                const categoryData = rule.governance_categories as any;
                const categoryName = categoryData?.name || 'Uncategorized';
                const domain = categoryData?.code || categoryName.replace(' Governance', '').toUpperCase();

                // Determine status
                let ruleStatus: string;
                if (rule.is_active) {
                    ruleStatus = 'active';
                } else if (rule.logic?.status === 'draft') {
                    ruleStatus = 'draft';
                } else if (rule.logic?.status === 'deprecated') {
                    ruleStatus = 'deprecated';
                } else {
                    ruleStatus = 'proposal';
                }

                // VTID-0405: Determine source (SYSTEM or CATALOG) from rule metadata
                // Rules with is_system_rule flag or logic.source='SYSTEM' are SYSTEM rules
                const ruleSource = rule.is_system_rule || rule.logic?.source === 'SYSTEM'
                    ? 'SYSTEM'
                    : (rule.logic?.source || 'CATALOG');

                return {
                    id: rule.rule_id || rule.logic?.rule_code || rule.id,
                    domain: domain,
                    level: rule.level || 'L2',
                    title: rule.name,
                    description: rule.description || '',
                    status: ruleStatus,
                    category: categoryName,
                    source: ruleSource,
                    vtids: rule.vtids || [],
                    sources: rule.sources || [],
                    enforcement: rule.enforcement || [],
                    created_at: rule.created_at,
                    updated_at: rule.updated_at || rule.created_at
                };
            });

            // Apply category filter (client-side for flexibility)
            if (category) {
                const categoryLower = (category as string).toLowerCase();
                catalogRules = catalogRules.filter(r =>
                    r.category.toLowerCase().includes(categoryLower) ||
                    r.domain.toLowerCase().includes(categoryLower)
                );
            }

            // Apply status filter (client-side for flexibility)
            if (status) {
                const statusLower = (status as string).toLowerCase();
                catalogRules = catalogRules.filter(r => r.status.toLowerCase() === statusLower);
            }

            // Apply search filter (searches id, title, description)
            if (search) {
                const searchLower = (search as string).toLowerCase();
                catalogRules = catalogRules.filter(r =>
                    r.id.toLowerCase().includes(searchLower) ||
                    r.title.toLowerCase().includes(searchLower) ||
                    r.description.toLowerCase().includes(searchLower)
                );
            }

            res.json({
                ok: true,
                vtid: 'VTID-0401',
                count: catalogRules.length,
                data: catalogRules
            });
        } catch (error: any) {
            console.error('Error in getRules:', error);
            res.status(500).json({
                ok: false,
                vtid: 'VTID-0401',
                error: error.message
            });
        }
    }

    /**
     * GET /api/v1/governance/rules/:ruleCode
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
     * Query params: status?, ruleCode?, limit?, offset?
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
     * Body: { type, ruleCode?, proposedRule, rationale?, source? }
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
     * Body: { status }
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
     * VTID-0406: Query OASIS events for governance.evaluate events
     * Query params: action?, service?, environment?, result?, from?, to?, limit?, offset?
     */
    async getEvaluations(req: Request, res: Response) {
        try {
            const { action, service, environment, result, from, to, limit, offset } = req.query;

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - evaluations fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    vtid: 'VTID-0406',
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }

            // VTID-0406: Query oasis_events for governance.evaluate events
            let query = supabase
                .from('oasis_events')
                .select('*')
                .eq('topic', 'governance.evaluate')
                .order('created_at', { ascending: false });

            // Apply filters
            if (from) {
                query = query.gte('created_at', from as string);
            }
            if (to) {
                query = query.lte('created_at', to as string);
            }
            if (limit) {
                query = query.limit(parseInt(limit as string));
            } else {
                query = query.limit(50);
            }
            if (offset) {
                query = query.range(parseInt(offset as string), parseInt(offset as string) + (parseInt(limit as string || '50') - 1));
            }

            const { data: events, error } = await query;

            if (error) {
                console.error('[VTID-0406] Error fetching governance evaluations:', error);
                return res.status(500).json({
                    ok: false,
                    vtid: 'VTID-0406',
                    error: error.message
                });
            }

            // VTID-0406: Transform OASIS events to evaluation DTOs
            let evaluationData = (events || []).map((ev: any) => {
                const metadata = ev.metadata || {};
                return {
                    id: ev.id,
                    created_at: ev.created_at,
                    action: metadata.action || ev.message || 'Unknown',
                    service: metadata.service || ev.service || 'Unknown',
                    environment: metadata.environment || 'Unknown',
                    allow: metadata.allow !== undefined ? metadata.allow : (ev.status === 'success'),
                    violated_rules: (metadata.violated_rules || []).map((rule: any) => ({
                        rule_id: rule.rule_id || rule.ruleId || rule.id || 'Unknown',
                        level: rule.level || 'L2',
                        domain: rule.domain || 'Unknown'
                    }))
                };
            });

            // Apply client-side filters for metadata fields
            if (action) {
                const actionLower = (action as string).toLowerCase();
                evaluationData = evaluationData.filter((ev: any) =>
                    ev.action.toLowerCase().includes(actionLower)
                );
            }
            if (service) {
                const serviceLower = (service as string).toLowerCase();
                evaluationData = evaluationData.filter((ev: any) =>
                    ev.service.toLowerCase().includes(serviceLower)
                );
            }
            if (environment) {
                const envLower = (environment as string).toLowerCase();
                evaluationData = evaluationData.filter((ev: any) =>
                    ev.environment.toLowerCase().includes(envLower)
                );
            }
            if (result) {
                const isAllow = result === 'allow' || result === 'Allow';
                evaluationData = evaluationData.filter((ev: any) => ev.allow === isAllow);
            }

            res.json({
                ok: true,
                vtid: 'VTID-0406',
                count: evaluationData.length,
                data: evaluationData
            });
        } catch (error: any) {
            console.error('[VTID-0406] Error in getEvaluations:', error);
            res.status(500).json({
                ok: false,
                vtid: 'VTID-0406',
                error: error.message
            });
        }
    }

    /**
     * GET /api/v1/governance/violations
     */
    async getViolations(req: Request, res: Response) {
        try {
            const tenantId = this.getTenantId(req);

            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - violations fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            }
            const { data: violations, error } = await supabase
                .from('governance_violations')
                .select(`
                    *,
                    governance_rules (
                        logic
                    )
                `)
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false });

            if (error) {
                console.error('Error fetching violations:', error);
                return res.status(500).json({ error: error.message });
            }

            // Transform to ViolationDTO
            const violationDTOs: ViolationDTO[] = (violations || []).map((v: any) => {
                let severityLabel: 'Low' | 'Medium' | 'High' | 'Critical';
                if (v.severity <= 1) severityLabel = 'Low';
                else if (v.severity === 2) severityLabel = 'Medium';
                else if (v.severity === 3) severityLabel = 'High';
                else severityLabel = 'Critical';

                let statusLabel: 'Open' | 'In Progress' | 'Resolved';
                if (v.status === 'OPEN') statusLabel = 'Open';
                else if (v.status === 'RESOLVED') statusLabel = 'Resolved';
                else statusLabel = 'In Progress';

                return {
                    violationId: v.id,
                    ruleCode: (v.governance_rules as any)?.logic?.rule_code || 'Unknown',
                    severity: severityLabel,
                    status: statusLabel,
                    detectedAt: v.created_at,
                    description: `Violation of governance rule`,
                    impact: `Severity level ${v.severity}`
                };
            });

            res.json(violationDTOs);
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
            // Query oasis_events_v1 for governance-related events
            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - feed fetch unavailable');
                return res.status(503).json({
                    ok: false,
                    error: 'SUPABASE_CONFIG_ERROR',
                    message: 'Governance storage is temporarily unavailable'
                });
            } const { data: events, error } = await supabase
                .from('oasis_events_v1')
                .select('*')
                .eq('tenant', 'SYSTEM')
                .or('task_type.like.%governance%,notes.like.%governance%')
                .order('created_at', { ascending: false })
                .limit(50);

            if (error) {
                console.error('Error fetching feed:', error);
                return res.status(500).json({ error: error.message });
            }

            // Transform to FeedEntry
            const feedEntries: FeedEntry[] = (events || []).map((ev: any) => {
                let message = ev.notes || ev.task_type || 'Governance event';
                let link: string | undefined;

                // Try to parse governance events from metadata
                const metadata = ev.metadata || {};

                if (metadata.proposalId) {
                    message = `Proposal ${metadata.proposalId} ${metadata.newStatus ? `changed to ${metadata.newStatus}` : 'created'}`;
                    link = `/dev/governance/proposals`;
                } else if (metadata.ruleCode) {
                    message = `Rule ${metadata.ruleCode} activity`;
                    link = `/dev/governance/rules/${metadata.ruleCode}`;
                }

                return {
                    id: ev.id.toString(),
                    message,
                    timestamp: ev.created_at,
                    link
                };
            });

            res.json(feedEntries);
        } catch (error: any) {
            console.error('Error in getFeed:', error);
            res.status(500).json({ error: error.message });
        }
    }

    async getEnforcements(req: Request, res: Response) {
        const tenantId = this.getTenantId(req);

        const supabase = getSupabase();
        if (!supabase) {
            console.warn('[GovernanceController] Supabase not configured - enforcements fetch unavailable');
            return res.status(503).json({
                ok: false,
                error: 'SUPABASE_CONFIG_ERROR',
                message: 'Governance storage is temporarily unavailable'
            });
        }

        const { data, error } = await supabase
            .from('governance_enforcements')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('executed_at', { ascending: false })
            .limit(50);

        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    }

    async getLogs(req: Request, res: Response) {
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
