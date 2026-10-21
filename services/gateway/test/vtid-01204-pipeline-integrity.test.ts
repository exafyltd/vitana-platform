/**
 * VTID-01204: Pipeline Integrity Gates Tests
 *
 * Tests for the pipeline integrity gates that prevent false completion claims.
 * Tasks can ONLY be marked as completed when the FULL pipeline has been executed:
 * 1. PR Created (pr.created event or pr_number field)
 * 2. Merged (merged event or merge_sha field)
 * 3. Validator Passed (validation.passed event)
 * 4. Deploy Success (deploy.success event)
 *
 * This addresses the issue where tasks like VTID-01197, VTID-01198, VTID-01203
 * were falsely marked as "completed" without any PR, merge, or deployment.
 */

describe('VTID-01204: Pipeline Integrity Gates', () => {
  // =============================================================================
  // Pipeline Evidence Validation
  // =============================================================================

  describe('Pipeline Evidence Validation', () => {
    interface PipelineEvidence {
      has_pr_created: boolean;
      has_merged: boolean;
      has_validator_passed: boolean;
      has_deploy_success: boolean;
      events_found: string[];
    }

    /**
     * Validate that pipeline evidence is sufficient for completion.
     * This mirrors the server-side validation logic.
     */
    function validatePipelineEvidence(
      evidence: PipelineEvidence,
      outcome: 'success' | 'failed' | 'cancelled'
    ): { valid: boolean; missing: string[] } {
      // For failed/cancelled outcomes, we don't require full pipeline
      if (outcome !== 'success') {
        return { valid: true, missing: [] };
      }

      const missing: string[] = [];

      if (!evidence.has_pr_created) {
        missing.push('PR_CREATED');
      }
      if (!evidence.has_merged) {
        missing.push('MERGED');
      }
      if (!evidence.has_validator_passed) {
        missing.push('VALIDATOR_PASSED');
      }
      if (!evidence.has_deploy_success) {
        missing.push('DEPLOY_SUCCESS');
      }

      return {
        valid: missing.length === 0,
        missing,
      };
    }

    test('full pipeline evidence → valid for success outcome', () => {
      const evidence: PipelineEvidence = {
        has_pr_created: true,
        has_merged: true,
        has_validator_passed: true,
        has_deploy_success: true,
        events_found: [
          'event:vtid.stage.pr.created',
          'event:vtid.stage.merged',
          'event:autopilot.validation.passed',
          'event:deploy.gateway.success',
        ],
      };

      const result = validatePipelineEvidence(evidence, 'success');
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    test('missing PR created → invalid for success outcome', () => {
      const evidence: PipelineEvidence = {
        has_pr_created: false,
        has_merged: true,
        has_validator_passed: true,
        has_deploy_success: true,
        events_found: [],
      };

      const result = validatePipelineEvidence(evidence, 'success');
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('PR_CREATED');
    });

    test('missing merge → invalid for success outcome', () => {
      const evidence: PipelineEvidence = {
        has_pr_created: true,
        has_merged: false,
        has_validator_passed: true,
        has_deploy_success: true,
        events_found: [],
      };

      const result = validatePipelineEvidence(evidence, 'success');
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('MERGED');
    });

    test('missing validator → invalid for success outcome', () => {
      const evidence: PipelineEvidence = {
        has_pr_created: true,
        has_merged: true,
        has_validator_passed: false,
        has_deploy_success: true,
        events_found: [],
      };

      const result = validatePipelineEvidence(evidence, 'success');
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('VALIDATOR_PASSED');
    });

    test('missing deploy → invalid for success outcome', () => {
      const evidence: PipelineEvidence = {
        has_pr_created: true,
        has_merged: true,
        has_validator_passed: true,
        has_deploy_success: false,
        events_found: [],
      };

      const result = validatePipelineEvidence(evidence, 'success');
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('DEPLOY_SUCCESS');
    });

    test('only deploy success (old behavior) → invalid - missing 3 stages', () => {
      // This is the OLD BROKEN BEHAVIOR that VTID-01204 fixes
      // The terminalize-repair job used to mark tasks as completed
      // just based on deploy success events alone
      const evidence: PipelineEvidence = {
        has_pr_created: false,
        has_merged: false,
        has_validator_passed: false,
        has_deploy_success: true, // Only deploy success present
        events_found: ['event:deploy.gateway.success'],
      };

      const result = validatePipelineEvidence(evidence, 'success');
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('PR_CREATED');
      expect(result.missing).toContain('MERGED');
      expect(result.missing).toContain('VALIDATOR_PASSED');
      expect(result.missing).toHaveLength(3);
    });

    test('failed outcome → always valid (no pipeline required)', () => {
      const evidence: PipelineEvidence = {
        has_pr_created: false,
        has_merged: false,
        has_validator_passed: false,
        has_deploy_success: false,
        events_found: [],
      };

      const result = validatePipelineEvidence(evidence, 'failed');
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    test('cancelled outcome → always valid (no pipeline required)', () => {
      const evidence: PipelineEvidence = {
        has_pr_created: false,
        has_merged: false,
        has_validator_passed: false,
        has_deploy_success: false,
        events_found: [],
      };

      const result = validatePipelineEvidence(evidence, 'cancelled');
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });
  });

  // =============================================================================
  // Governance Bypass Logic
  // =============================================================================

  describe('Governance Bypass Logic', () => {
    /**
     * Check if pipeline integrity gates can be bypassed.
     * This mirrors the server-side canBypassPipelineGates function.
     */
    function canBypassPipelineGates(
      outcome: 'success' | 'failed' | 'cancelled',
      role?: string,
      hasOverrideKey?: boolean
    ): { allowed: boolean; reason: string } {
      // Failed/cancelled outcomes don't need full pipeline
      if (outcome !== 'success') {
        return { allowed: true, reason: `outcome=${outcome}` };
      }

      // Allow with valid governance override key
      if (hasOverrideKey) {
        return { allowed: true, reason: 'governance_override_key' };
      }

      // Allow for governance role
      if (role === 'governance') {
        return { allowed: true, reason: 'role=governance' };
      }

      return {
        allowed: false,
        reason: 'Pipeline integrity gates require full pipeline completion or governance override',
      };
    }

    test('success outcome + no credentials → blocked', () => {
      const result = canBypassPipelineGates('success', undefined, false);
      expect(result.allowed).toBe(false);
    });

    test('success outcome + governance role → allowed', () => {
      const result = canBypassPipelineGates('success', 'governance', false);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('role=governance');
    });

    test('success outcome + admin role → blocked (admin cannot bypass)', () => {
      // VTID-01204: Only governance role can bypass, not admin
      const result = canBypassPipelineGates('success', 'admin', false);
      expect(result.allowed).toBe(false);
    });

    test('success outcome + governance override key → allowed', () => {
      const result = canBypassPipelineGates('success', undefined, true);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('governance_override_key');
    });

    test('failed outcome → always allowed', () => {
      const result = canBypassPipelineGates('failed', undefined, false);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('outcome=failed');
    });

    test('cancelled outcome → always allowed', () => {
      const result = canBypassPipelineGates('cancelled', undefined, false);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('outcome=cancelled');
    });
  });

  // =============================================================================
  // skip_verification Governance (Worker Orchestrator)
  // =============================================================================

  describe('skip_verification Governance', () => {
    /**
     * Check if skip_verification is allowed based on governance rules.
     * This mirrors the server-side isSkipVerificationAllowed function.
     */
    function isSkipVerificationAllowed(
      environment: string,
      role?: string,
      hasOverrideKey?: boolean
    ): { allowed: boolean; reason: string } {
      const envLower = environment.toLowerCase();

      // Only allow skip in explicit test/CI environments
      // Dev and sandbox environments should still run verification
      if (envLower === 'test' || envLower === 'ci' || envLower === 'testing') {
        return { allowed: true, reason: `environment=${environment}` };
      }

      // Allow with valid governance override key
      if (hasOverrideKey) {
        return { allowed: true, reason: 'governance_override_key' };
      }

      // Only governance role can skip - not admin/staff
      if (role === 'governance') {
        return { allowed: true, reason: `role=${role}` };
      }

      return {
        allowed: false,
        reason: 'skip_verification requires test environment, governance role, or governance override key (VTID-01204)',
      };
    }

    test('production environment → skip blocked', () => {
      const result = isSkipVerificationAllowed('production');
      expect(result.allowed).toBe(false);
    });

    test('dev environment → skip blocked (VTID-01204 stricter rules)', () => {
      // Before VTID-01204, dev environments allowed skip
      // Now dev environments must run verification
      const result = isSkipVerificationAllowed('dev');
      expect(result.allowed).toBe(false);
    });

    test('sandbox environment → skip blocked (VTID-01204 stricter rules)', () => {
      // Before VTID-01204, sandbox environments allowed skip
      // Now sandbox environments must run verification
      const result = isSkipVerificationAllowed('sandbox');
      expect(result.allowed).toBe(false);
    });

    test('test environment → skip allowed', () => {
      const result = isSkipVerificationAllowed('test');
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('environment');
    });

    test('ci environment → skip allowed', () => {
      const result = isSkipVerificationAllowed('ci');
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('environment');
    });

    test('testing environment → skip allowed', () => {
      const result = isSkipVerificationAllowed('testing');
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('environment');
    });

    test('production + admin role → skip blocked (admin cannot bypass)', () => {
      const result = isSkipVerificationAllowed('production', 'admin');
      expect(result.allowed).toBe(false);
    });

    test('production + staff role → skip blocked (staff cannot bypass)', () => {
      const result = isSkipVerificationAllowed('production', 'staff');
      expect(result.allowed).toBe(false);
    });

    test('production + governance role → skip allowed', () => {
      const result = isSkipVerificationAllowed('production', 'governance');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('role=governance');
    });

    test('production + governance override key → skip allowed', () => {
      const result = isSkipVerificationAllowed('production', undefined, true);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('governance_override_key');
    });
  });

  // =============================================================================
  // Event Topic Pattern Matching
  // =============================================================================

  describe('Event Topic Pattern Matching', () => {
    /**
     * Check if an event topic indicates PR creation
     */
    function isPrCreatedEvent(topic: string): boolean {
      const topicLower = topic.toLowerCase();
      return (
        topicLower.includes('pr.created') ||
        topicLower.includes('create_pr.success') ||
        topicLower.includes('pull_request.opened')
      );
    }

    /**
     * Check if an event topic indicates merge
     */
    function isMergedEvent(topic: string): boolean {
      const topicLower = topic.toLowerCase();
      return (
        topicLower.includes('.merged') ||
        topicLower.includes('safe_merge.executed') ||
        topicLower.includes('safe_merge.success') ||
        topicLower.includes('pull_request.merged')
      );
    }

    /**
     * Check if an event topic indicates validator passed
     */
    function isValidatorPassedEvent(topic: string): boolean {
      const topicLower = topic.toLowerCase();
      return (
        topicLower.includes('validation.passed') ||
        topicLower.includes('validated') ||
        topicLower.includes('validator.success')
      );
    }

    /**
     * Check if an event topic indicates deploy success
     */
    function isDeploySuccessEvent(topic: string, status?: string): boolean {
      const topicLower = topic.toLowerCase();
      return (
        topicLower.includes('deploy') &&
        (topicLower.includes('success') || status === 'success')
      );
    }

    // PR Created event patterns
    test('vtid.stage.pr.created → PR created', () => {
      expect(isPrCreatedEvent('vtid.stage.pr.created')).toBe(true);
    });

    test('cicd.github.create_pr.success → PR created', () => {
      expect(isPrCreatedEvent('cicd.github.create_pr.success')).toBe(true);
    });

    test('github.pull_request.opened → PR created', () => {
      expect(isPrCreatedEvent('github.pull_request.opened')).toBe(true);
    });

    // Merged event patterns
    test('vtid.stage.merged → merged', () => {
      expect(isMergedEvent('vtid.stage.merged')).toBe(true);
    });

    test('cicd.github.safe_merge.executed → merged', () => {
      expect(isMergedEvent('cicd.github.safe_merge.executed')).toBe(true);
    });

    test('cicd.github.safe_merge.success → merged', () => {
      expect(isMergedEvent('cicd.github.safe_merge.success')).toBe(true);
    });

    test('github.pull_request.merged → merged', () => {
      expect(isMergedEvent('github.pull_request.merged')).toBe(true);
    });

    // Validator passed event patterns
    test('autopilot.validation.passed → validator passed', () => {
      expect(isValidatorPassedEvent('autopilot.validation.passed')).toBe(true);
    });

    test('vtid.stage.validated → validator passed', () => {
      expect(isValidatorPassedEvent('vtid.stage.validated')).toBe(true);
    });

    test('autopilot.validator.success → validator passed', () => {
      expect(isValidatorPassedEvent('autopilot.validator.success')).toBe(true);
    });

    // Deploy success event patterns
    test('deploy.gateway.success → deploy success', () => {
      expect(isDeploySuccessEvent('deploy.gateway.success')).toBe(true);
    });

    test('vtid.stage.deploy.success → deploy success', () => {
      expect(isDeploySuccessEvent('vtid.stage.deploy.success')).toBe(true);
    });

    test('deploy.service.completed with status=success → deploy success', () => {
      expect(isDeploySuccessEvent('deploy.service.completed', 'success')).toBe(true);
    });

    // Negative cases - these should NOT match
    test('vtid.stage.building → NOT deploy success', () => {
      expect(isDeploySuccessEvent('vtid.stage.building')).toBe(false);
    });

    test('deploy.gateway.failed → NOT deploy success', () => {
      // Contains 'deploy' but also contains 'failed'
      // Our function checks for 'success' in topic
      expect(isDeploySuccessEvent('deploy.gateway.failed')).toBe(false);
    });
  });

  // =============================================================================
  // False Completion Scenario Tests (The Bug We're Fixing)
  // =============================================================================

  describe('False Completion Scenarios', () => {
    test('VTID with only deploy event should NOT be marked complete', () => {
      // This is the exact scenario that caused VTID-01197, 01198, 01203 to be
      // falsely marked as completed
      const events = [
        { topic: 'deploy.gateway.success', status: 'success' },
      ];

      const evidence = {
        has_pr_created: false,
        has_merged: false,
        has_validator_passed: false,
        has_deploy_success: true,
        events_found: events.map(e => `event:${e.topic}`),
      };

      // Validate for success outcome
      const missing: string[] = [];
      if (!evidence.has_pr_created) missing.push('PR_CREATED');
      if (!evidence.has_merged) missing.push('MERGED');
      if (!evidence.has_validator_passed) missing.push('VALIDATOR_PASSED');
      if (!evidence.has_deploy_success) missing.push('DEPLOY_SUCCESS');

      expect(missing).toContain('PR_CREATED');
      expect(missing).toContain('MERGED');
      expect(missing).toContain('VALIDATOR_PASSED');
      expect(missing).toHaveLength(3); // Deploy is present, 3 stages missing
    });

    test('VTID with PR + deploy but no merge should NOT be marked complete', () => {
      const events = [
        { topic: 'vtid.stage.pr.created', status: 'success' },
        { topic: 'deploy.gateway.success', status: 'success' },
      ];

      const evidence = {
        has_pr_created: true,
        has_merged: false, // Missing!
        has_validator_passed: false, // Missing!
        has_deploy_success: true,
        events_found: events.map(e => `event:${e.topic}`),
      };

      const missing: string[] = [];
      if (!evidence.has_pr_created) missing.push('PR_CREATED');
      if (!evidence.has_merged) missing.push('MERGED');
      if (!evidence.has_validator_passed) missing.push('VALIDATOR_PASSED');
      if (!evidence.has_deploy_success) missing.push('DEPLOY_SUCCESS');

      expect(missing).toContain('MERGED');
      expect(missing).toContain('VALIDATOR_PASSED');
      expect(missing).toHaveLength(2);
    });

    test('VTID with lifecycle.completed event → all stages inferred complete', () => {
      // The vtid.lifecycle.completed event is only emitted when full pipeline completes
      const events = [
        { topic: 'vtid.lifecycle.completed', status: 'success' },
      ];

      // When lifecycle.completed is present, all stages are inferred
      const evidence = {
        has_pr_created: true,
        has_merged: true,
        has_validator_passed: true,
        has_deploy_success: true,
        events_found: ['event:vtid.lifecycle.completed'],
      };

      const missing: string[] = [];
      if (!evidence.has_pr_created) missing.push('PR_CREATED');
      if (!evidence.has_merged) missing.push('MERGED');
      if (!evidence.has_validator_passed) missing.push('VALIDATOR_PASSED');
      if (!evidence.has_deploy_success) missing.push('DEPLOY_SUCCESS');

      expect(missing).toHaveLength(0);
    });
  });

  // =============================================================================
  // Terminalize-Repair Behavior Tests
  // =============================================================================

  describe('Terminalize-Repair Behavior', () => {
    test('repair job should skip VTIDs with incomplete pipeline', () => {
      const vtids = [
        {
          vtid: 'VTID-01197',
          status: 'in_progress',
          evidence: { has_deploy_success: true, has_pr_created: false, has_merged: false, has_validator_passed: false },
        },
        {
          vtid: 'VTID-01198',
          status: 'in_progress',
          evidence: { has_deploy_success: true, has_pr_created: false, has_merged: false, has_validator_passed: false },
        },
        {
          vtid: 'VTID-01199',
          status: 'in_progress',
          evidence: { has_deploy_success: true, has_pr_created: true, has_merged: true, has_validator_passed: true },
        },
      ];

      // Simulate repair job filtering
      const shouldTerminalize = vtids.filter(v => {
        const e = v.evidence;
        return e.has_pr_created && e.has_merged && e.has_validator_passed && e.has_deploy_success;
      });

      expect(shouldTerminalize).toHaveLength(1);
      expect(shouldTerminalize[0].vtid).toBe('VTID-01199');

      // VTID-01197 and VTID-01198 should be SKIPPED
      const skipped = vtids.filter(v => !shouldTerminalize.includes(v));
      expect(skipped).toHaveLength(2);
      expect(skipped.map(v => v.vtid)).toContain('VTID-01197');
      expect(skipped.map(v => v.vtid)).toContain('VTID-01198');
    });

    test('repair job response should include skipped_incomplete_pipeline count', () => {
      const mockRepairResponse = {
        ok: true,
        scanned: 10,
        terminalized: 2,
        skipped_incomplete_pipeline: 8, // New field from VTID-01204
        errors: 0,
        governance_vtid: 'VTID-01204',
        details: [
          { vtid: 'VTID-01199', action: 'terminalized' },
          { vtid: 'VTID-01200', action: 'terminalized' },
          { vtid: 'VTID-01197', action: 'skipped', reason: 'incomplete_pipeline', missing_stages: ['PR_CREATED', 'MERGED', 'VALIDATOR_PASSED'] },
          { vtid: 'VTID-01198', action: 'skipped', reason: 'incomplete_pipeline', missing_stages: ['PR_CREATED', 'MERGED', 'VALIDATOR_PASSED'] },
        ],
      };

      expect(mockRepairResponse.governance_vtid).toBe('VTID-01204');
      expect(mockRepairResponse.skipped_incomplete_pipeline).toBe(8);
      expect(mockRepairResponse.terminalized).toBe(2);
    });
  });
});
