// DEV-CICDL-0207 – Auto-Merge Controller for Autonomous Safe Merge Layer
import { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { validatePR, quickEligibilityCheck, detectModule } from '../validator-core/pr-validator';
import {
  PREntity,
  PREvent,
  PRValidationInput,
  AutoMergeEligibility,
  AutoMergeRulesDTO,
  AUTO_MERGE_ALLOWED_MODULES,
  AUTO_MERGE_FORBIDDEN_PATHS,
  PREventType,
} from '../types/auto-merge';

export class AutoMergeController {
  private getTenantId(req: Request): string {
    const tenantId = (req.headers['x-tenant-id'] as string) || (req.query.tenantId as string) || 'SYSTEM';
    return tenantId;
  }

  /**
   * GET /api/v1/governance/rules/auto-merge
   * Returns all auto-merge governance rules
   */
  async getAutoMergeRules(req: Request, res: Response) {
    try {
      const tenantId = this.getTenantId(req);
      const supabase = getSupabase();

      if (!supabase) {
        console.warn('[AutoMergeController] Supabase not configured');
        return res.status(503).json({
          ok: false,
          error: 'SUPABASE_CONFIG_ERROR',
          message: 'Auto-merge governance is temporarily unavailable',
        });
      }

      // Fetch AUTO_MERGE_GOVERNANCE rules
      const { data: rules, error } = await supabase
        .from('governance_rules')
        .select(`
          *,
          governance_categories!inner (
            name
          )
        `)
        .eq('tenant_id', tenantId)
        .eq('governance_categories.name', 'AUTO_MERGE_GOVERNANCE')
        .eq('is_active', true);

      if (error) {
        console.error('[AutoMergeController] Error fetching rules:', error);
        return res.status(500).json({ error: error.message });
      }

      const dto: AutoMergeRulesDTO = {
        category: 'AUTO_MERGE_GOVERNANCE',
        rules: (rules || []).map((rule: any) => ({
          rule_code: rule.logic?.rule_code || rule.id,
          name: rule.name,
          description: rule.description || '',
          is_active: rule.is_active,
          logic: rule.logic,
        })),
        allowed_modules: [...AUTO_MERGE_ALLOWED_MODULES],
        forbidden_paths: [...AUTO_MERGE_FORBIDDEN_PATHS],
      };

      res.json(dto);
    } catch (error: any) {
      console.error('[AutoMergeController] Error in getAutoMergeRules:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/v1/auto-merge/validate
   * Validates a PR for auto-merge eligibility
   * Body: PRValidationInput
   */
  async validatePRForAutoMerge(req: Request, res: Response) {
    try {
      const tenantId = this.getTenantId(req);
      const input: PRValidationInput = req.body;

      // Validate required fields
      if (!input.pr_number || !input.branch || !input.title || !input.files) {
        return res.status(400).json({
          ok: false,
          error: 'Missing required fields: pr_number, branch, title, files',
        });
      }

      // Run validation
      const result = validatePR(input);

      // Store evaluation in database
      const supabase = getSupabase();
      if (supabase) {
        await this.storeValidationResult(supabase, tenantId, result, input);
      }

      res.json({
        ok: true,
        data: result,
      });
    } catch (error: any) {
      console.error('[AutoMergeController] Error in validatePRForAutoMerge:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  }

  /**
   * POST /api/v1/auto-merge/pr
   * Creates or updates a PR entity
   */
  async upsertPREntity(req: Request, res: Response) {
    try {
      const tenantId = this.getTenantId(req);
      const supabase = getSupabase();

      if (!supabase) {
        return res.status(503).json({
          ok: false,
          error: 'SUPABASE_CONFIG_ERROR',
        });
      }

      const {
        pr_number,
        repo = 'exafyltd/vitana-platform',
        branch,
        base_branch = 'main',
        module,
        title,
        author,
        vtid,
        ci_status,
        validator_status,
        override_flag,
        metadata,
      } = req.body;

      if (!pr_number || !branch || !title) {
        return res.status(400).json({
          ok: false,
          error: 'Missing required fields: pr_number, branch, title',
        });
      }

      // Determine module if not provided
      const detectedModule = module || detectModule(metadata?.files || []);

      const prEntity: Partial<PREntity> = {
        tenant_id: tenantId,
        pr_number,
        repo,
        branch,
        base_branch,
        module: detectedModule,
        title,
        author,
        vtid,
        ci_status: ci_status || 'pending',
        validator_status: validator_status || 'pending',
        override_flag: override_flag || false,
        metadata: metadata || {},
      };

      // Upsert PR entity
      const { data, error } = await supabase
        .from('oasis_pr_entities')
        .upsert(prEntity, {
          onConflict: 'repo,pr_number',
          ignoreDuplicates: false,
        })
        .select()
        .single();

      if (error) {
        console.error('[AutoMergeController] Error upserting PR:', error);
        return res.status(500).json({ ok: false, error: error.message });
      }

      res.json({ ok: true, data });
    } catch (error: any) {
      console.error('[AutoMergeController] Error in upsertPREntity:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  }

  /**
   * GET /api/v1/auto-merge/pr/:pr_number
   * Gets a PR entity by number
   */
  async getPREntity(req: Request, res: Response) {
    try {
      const { pr_number } = req.params;
      const repo = (req.query.repo as string) || 'exafyltd/vitana-platform';
      const supabase = getSupabase();

      if (!supabase) {
        return res.status(503).json({
          ok: false,
          error: 'SUPABASE_CONFIG_ERROR',
        });
      }

      const { data, error } = await supabase
        .from('oasis_pr_entities')
        .select('*, oasis_pr_events(*)')
        .eq('repo', repo)
        .eq('pr_number', parseInt(pr_number))
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ ok: false, error: 'PR not found' });
        }
        return res.status(500).json({ ok: false, error: error.message });
      }

      res.json({ ok: true, data });
    } catch (error: any) {
      console.error('[AutoMergeController] Error in getPREntity:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  }

  /**
   * POST /api/v1/auto-merge/pr/:pr_number/event
   * Adds an event to a PR entity
   */
  async addPREvent(req: Request, res: Response) {
    try {
      const tenantId = this.getTenantId(req);
      const { pr_number } = req.params;
      const repo = (req.query.repo as string) || 'exafyltd/vitana-platform';
      const supabase = getSupabase();

      if (!supabase) {
        return res.status(503).json({
          ok: false,
          error: 'SUPABASE_CONFIG_ERROR',
        });
      }

      const { event_type, status = 'success', message, actor, vtid, metadata } = req.body;

      if (!event_type) {
        return res.status(400).json({
          ok: false,
          error: 'Missing required field: event_type',
        });
      }

      // Find PR entity
      const { data: prEntity, error: prError } = await supabase
        .from('oasis_pr_entities')
        .select('id')
        .eq('repo', repo)
        .eq('pr_number', parseInt(pr_number))
        .single();

      if (prError || !prEntity) {
        return res.status(404).json({
          ok: false,
          error: `PR #${pr_number} not found`,
        });
      }

      // Insert event
      const prEvent: Partial<PREvent> = {
        tenant_id: tenantId,
        pr_entity_id: prEntity.id,
        event_type: event_type as PREventType,
        status,
        message,
        actor,
        vtid,
        metadata: metadata || {},
      };

      const { data, error } = await supabase
        .from('oasis_pr_events')
        .insert(prEvent)
        .select()
        .single();

      if (error) {
        console.error('[AutoMergeController] Error adding PR event:', error);
        return res.status(500).json({ ok: false, error: error.message });
      }

      // Update PR entity status based on event type
      await this.updatePRStatusFromEvent(supabase, prEntity.id, event_type as PREventType);

      res.json({ ok: true, data });
    } catch (error: any) {
      console.error('[AutoMergeController] Error in addPREvent:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  }

  /**
   * GET /api/v1/auto-merge/pr/:pr_number/eligibility
   * Checks if a PR is eligible for auto-merge
   */
  async checkEligibility(req: Request, res: Response) {
    try {
      const { pr_number } = req.params;
      const repo = (req.query.repo as string) || 'exafyltd/vitana-platform';
      const supabase = getSupabase();

      if (!supabase) {
        return res.status(503).json({
          ok: false,
          error: 'SUPABASE_CONFIG_ERROR',
        });
      }

      // Fetch PR entity with events
      const { data: prEntity, error } = await supabase
        .from('oasis_pr_entities')
        .select('*')
        .eq('repo', repo)
        .eq('pr_number', parseInt(pr_number))
        .single();

      if (error || !prEntity) {
        return res.status(404).json({
          ok: false,
          error: `PR #${pr_number} not found`,
        });
      }

      // Check eligibility
      const blockedReasons: string[] = [];

      // Check module
      if (!AUTO_MERGE_ALLOWED_MODULES.includes(prEntity.module as any)) {
        blockedReasons.push(`Module ${prEntity.module} not allowed for auto-merge`);
      }

      // Check CI status
      if (prEntity.ci_status !== 'success') {
        blockedReasons.push(`CI status is ${prEntity.ci_status}, not success`);
      }

      // Check validator status
      if (prEntity.validator_status !== 'success') {
        blockedReasons.push(`Validator status is ${prEntity.validator_status}, not success`);
      }

      // Check OASIS tracking
      if (!prEntity.oasis_tracking) {
        blockedReasons.push('Required OASIS events not found');
      }

      // Check override flag
      if (prEntity.override_flag) {
        blockedReasons.push('Human override flag is set');
      }

      // Check if already merged
      if (prEntity.merged) {
        blockedReasons.push('PR is already merged');
      }

      const eligible = blockedReasons.length === 0;
      const canMerge = eligible && !prEntity.merged;

      const eligibility: AutoMergeEligibility = {
        eligible,
        pr_number: prEntity.pr_number,
        module: prEntity.module,
        ci_status: prEntity.ci_status,
        validator_status: prEntity.validator_status,
        oasis_tracking: prEntity.oasis_tracking,
        override_flag: prEntity.override_flag,
        blocked_reasons: blockedReasons,
        can_merge: canMerge,
        recommendation: canMerge ? 'AUTO_MERGE' : (eligible ? 'MANUAL_REVIEW' : 'BLOCKED'),
      };

      res.json({ ok: true, data: eligibility });
    } catch (error: any) {
      console.error('[AutoMergeController] Error in checkEligibility:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  }

  /**
   * GET /api/v1/auto-merge/prs
   * Lists all PR entities with optional filters
   */
  async listPRs(req: Request, res: Response) {
    try {
      const tenantId = this.getTenantId(req);
      const supabase = getSupabase();

      if (!supabase) {
        return res.status(503).json({
          ok: false,
          error: 'SUPABASE_CONFIG_ERROR',
        });
      }

      const {
        repo = 'exafyltd/vitana-platform',
        module,
        merged,
        merge_eligible,
        limit = '50',
        offset = '0',
      } = req.query;

      let query = supabase
        .from('oasis_pr_entities')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('repo', repo as string)
        .order('created_at', { ascending: false })
        .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1);

      if (module) {
        query = query.eq('module', module as string);
      }
      if (merged !== undefined) {
        query = query.eq('merged', merged === 'true');
      }
      if (merge_eligible !== undefined) {
        query = query.eq('merge_eligible', merge_eligible === 'true');
      }

      const { data, error } = await query;

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      res.json({ ok: true, data });
    } catch (error: any) {
      console.error('[AutoMergeController] Error in listPRs:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  }

  /**
   * PATCH /api/v1/auto-merge/pr/:pr_number/status
   * Updates PR entity status fields
   */
  async updatePRStatus(req: Request, res: Response) {
    try {
      const { pr_number } = req.params;
      const repo = (req.query.repo as string) || 'exafyltd/vitana-platform';
      const supabase = getSupabase();

      if (!supabase) {
        return res.status(503).json({
          ok: false,
          error: 'SUPABASE_CONFIG_ERROR',
        });
      }

      const { ci_status, validator_status, merge_eligible, merged, override_flag, blocked_reason } = req.body;

      const updates: Record<string, any> = {};
      if (ci_status !== undefined) updates.ci_status = ci_status;
      if (validator_status !== undefined) updates.validator_status = validator_status;
      if (merge_eligible !== undefined) updates.merge_eligible = merge_eligible;
      if (merged !== undefined) updates.merged = merged;
      if (override_flag !== undefined) updates.override_flag = override_flag;
      if (blocked_reason !== undefined) updates.blocked_reason = blocked_reason;

      const { data, error } = await supabase
        .from('oasis_pr_entities')
        .update(updates)
        .eq('repo', repo)
        .eq('pr_number', parseInt(pr_number))
        .select()
        .single();

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      res.json({ ok: true, data });
    } catch (error: any) {
      console.error('[AutoMergeController] Error in updatePRStatus:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  }

  /**
   * Helper to store validation result
   */
  private async storeValidationResult(supabase: any, tenantId: string, result: any, input: PRValidationInput) {
    try {
      // Store evaluations
      for (const evaluation of result.evaluations) {
        // Find rule ID
        const { data: rule } = await supabase
          .from('governance_rules')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('logic->>rule_code', evaluation.rule_code)
          .single();

        if (rule) {
          await supabase.from('governance_evaluations').insert({
            tenant_id: tenantId,
            rule_id: rule.id,
            entity_id: `PR-${input.pr_number}`,
            status: evaluation.status,
            metadata: {
              executor: 'validator-core',
              pr_number: input.pr_number,
              branch: input.branch,
              reason: evaluation.reason,
              vtid: input.vtid,
            },
          });
        }
      }

      // Store violations
      for (const violation of result.violations) {
        const { data: rule } = await supabase
          .from('governance_rules')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('logic->>rule_code', violation.rule_code)
          .single();

        if (rule) {
          const severityMap: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
          await supabase.from('governance_violations').insert({
            tenant_id: tenantId,
            rule_id: rule.id,
            entity_id: `PR-${input.pr_number}`,
            severity: severityMap[violation.severity] || 1,
            status: 'OPEN',
          });
        }
      }
    } catch (error) {
      console.error('[AutoMergeController] Error storing validation result:', error);
    }
  }

  /**
   * Helper to update PR status based on event type
   */
  private async updatePRStatusFromEvent(supabase: any, prEntityId: string, eventType: PREventType) {
    const updates: Record<string, any> = {};

    switch (eventType) {
      case 'PR_VALIDATED':
        updates.validator_status = 'success';
        break;
      case 'PR_CI_PASSED':
        updates.ci_status = 'success';
        break;
      case 'PR_CI_FAILED':
        updates.ci_status = 'failed';
        break;
      case 'PR_READY_TO_MERGE':
        updates.merge_eligible = true;
        break;
      case 'PR_MERGED':
        updates.merged = true;
        updates.merge_eligible = false;
        break;
      case 'PR_BLOCKED':
        updates.merge_eligible = false;
        break;
      case 'PR_OVERRIDE_SET':
        updates.override_flag = true;
        break;
      case 'PR_OVERRIDE_CLEARED':
        updates.override_flag = false;
        break;
    }

    if (Object.keys(updates).length > 0) {
      await supabase
        .from('oasis_pr_entities')
        .update(updates)
        .eq('id', prEntityId);
    }
  }
}
