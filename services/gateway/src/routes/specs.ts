/**
 * VTID-01188: Unified "Generate Spec" Pipeline API Routes
 *
 * Endpoints:
 * - POST /generate - Generate spec from seed notes
 * - POST /validate - Validate current spec against governance rules
 * - POST /approve - Approve validated spec for activation
 * - GET / - Get spec status and content
 *
 * All endpoints operate on vtid_ledger as the board truth.
 */

import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { emitOasisEvent } from '../services/oasis-event-service';
import { runFullQualityCheck } from '../services/spec-quality-agent';

const router = Router();

// ===========================================================================
// VTID-01188: Spec Template (Mandatory Output Format)
// ===========================================================================

const SPEC_TEMPLATE = `# {TITLE}

**VTID:** {VTID}

---

## 1. Goal

{GOAL}

---

## 2. Non-negotiable Governance Rules Touched

{GOVERNANCE_RULES}

---

## 3. Scope

### IN SCOPE
{IN_SCOPE}

### OUT OF SCOPE
{OUT_SCOPE}

---

## 4. Changes

### 4.1 Database Migrations (SQL)
{DB_MIGRATIONS}

### 4.2 APIs (Routes, Request/Response)
{API_CHANGES}

### 4.3 UI Changes (Screens, States)
{UI_CHANGES}

---

## 5. Files to Modify

{FILES_TO_MODIFY}

---

## 6. Acceptance Criteria

{ACCEPTANCE_CRITERIA}

---

## 7. Verification Steps

### 7.1 curl Calls
{CURL_VERIFICATION}

### 7.2 UI Checks
{UI_VERIFICATION}

---

## 8. Rollback Plan

{ROLLBACK_PLAN}

---

## 9. Risk Level

{RISK_LEVEL}
`;

// Required sections for validation
const REQUIRED_SECTIONS = [
  'Goal',
  'Non-negotiable Governance Rules Touched',
  'Scope',
  'Changes',
  'Files to Modify',
  'Acceptance Criteria',
  'Verification Steps',
  'Rollback Plan',
  'Risk Level'
];

// ===========================================================================
// Helper Functions
// ===========================================================================

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !svcKey) throw new Error('Supabase not configured');
  return { supabaseUrl, svcKey };
}

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function validateVtidFormat(vtid: string): boolean {
  return /^VTID-\d{4,5}(-[A-Za-z0-9]+)?$/.test(vtid);
}

/**
 * Validate spec content against required sections
 */
function validateSpecSections(specMarkdown: string): { valid: boolean; missing: string[]; report: Record<string, unknown> } {
  const missing: string[] = [];
  const found: string[] = [];

  for (const section of REQUIRED_SECTIONS) {
    // Check for section header (## or # followed by section name or number + section name)
    const patterns = [
      new RegExp(`^##?\\s*\\d*\\.?\\s*${section}`, 'im'),
      new RegExp(`^##?\\s*${section}`, 'im'),
    ];

    const sectionFound = patterns.some(pattern => pattern.test(specMarkdown));
    if (sectionFound) {
      found.push(section);
    } else {
      missing.push(section);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    report: {
      required_sections: REQUIRED_SECTIONS.length,
      found_sections: found.length,
      missing_sections: missing,
      found: found,
      validation_time: new Date().toISOString()
    }
  };
}

/**
 * Generate a spec from seed notes
 * This is a deterministic template-based generation
 */
function generateSpecFromSeed(vtid: string, title: string, seedNotes: string, source: string): string {
  // Parse seed notes for structure hints
  const lines = seedNotes.split('\n').map(l => l.trim()).filter(l => l);

  // Default values based on seed notes
  const goal = lines[0] || 'Implement the requested functionality';
  const inScope = lines.slice(0, 3).map(l => `- ${l}`).join('\n') || '- TBD based on requirements';
  const outScope = '- Items not explicitly mentioned in acceptance criteria';

  const specContent = SPEC_TEMPLATE
    .replace('{TITLE}', title || `Task ${vtid}`)
    .replace('{VTID}', vtid)
    .replace('{GOAL}', goal)
    .replace('{GOVERNANCE_RULES}', '- To be determined during analysis')
    .replace('{IN_SCOPE}', inScope)
    .replace('{OUT_SCOPE}', outScope)
    .replace('{DB_MIGRATIONS}', '- None identified (to be updated)')
    .replace('{API_CHANGES}', '- None identified (to be updated)')
    .replace('{UI_CHANGES}', '- None identified (to be updated)')
    .replace('{FILES_TO_MODIFY}', '- To be determined during implementation planning')
    .replace('{ACCEPTANCE_CRITERIA}', lines.map((l, i) => `${i + 1}. ${l}`).join('\n') || '- [ ] Task completed successfully')
    .replace('{CURL_VERIFICATION}', '```bash\n# Verification commands TBD\n```')
    .replace('{UI_VERIFICATION}', '- [ ] UI verification steps TBD')
    .replace('{ROLLBACK_PLAN}', '- Revert commit if issues detected\n- No database rollback required (additive changes only)')
    .replace('{RISK_LEVEL}', `**Risk:** LOW\n\n**Source:** ${source}`);

  return specContent;
}

// ===========================================================================
// POST /:vtid/generate - Generate Spec
// ===========================================================================

router.post('/:vtid/generate', async (req: Request, res: Response) => {
  const { vtid } = req.params;
  const { seed_notes = '', source = 'commandhub' } = req.body || {};

  console.log(`[VTID-01188] Generate spec requested for ${vtid}, source=${source}`);

  // Validate VTID format
  if (!validateVtidFormat(vtid)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_vtid_format',
      message: 'VTID must match format VTID-XXXXX'
    });
  }

  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Step 1: Fetch the VTID from ledger
    const ledgerResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` }
    });

    if (!ledgerResp.ok) {
      return res.status(502).json({ ok: false, error: 'database_query_failed' });
    }

    const ledgerData = await ledgerResp.json() as any[];
    if (ledgerData.length === 0) {
      return res.status(404).json({ ok: false, error: 'vtid_not_found', vtid });
    }

    const ledgerRow = ledgerData[0];

    // Step 2: Set spec_status to 'generating'
    const updateGeneratingResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
      body: JSON.stringify({
        spec_status: 'generating',
        spec_last_error: null,
        updated_at: new Date().toISOString()
      })
    });

    if (!updateGeneratingResp.ok) {
      console.error(`[VTID-01188] Failed to set spec_status to generating`);
    }

    // Emit generate requested event
    await emitOasisEvent({
      vtid,
      type: 'vtid.spec.generate.requested',
      source: 'gateway-specs',
      status: 'info',
      message: `Spec generation requested for ${vtid}`,
      payload: { source, seed_notes_length: seed_notes.length }
    });

    // Step 3: Get next version number
    const versionResp = await fetch(`${supabaseUrl}/rest/v1/rpc/get_next_spec_version`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
      body: JSON.stringify({ p_vtid: vtid })
    });

    let version = 1;
    if (versionResp.ok) {
      const versionData = await versionResp.json();
      version = typeof versionData === 'number' ? versionData : 1;
    }

    // Step 4: Generate spec content
    const specMarkdown = generateSpecFromSeed(vtid, ledgerRow.title, seed_notes, source);
    const specHash = computeHash(specMarkdown);

    // Step 5: Insert new spec into oasis_specs
    const insertSpecResp = await fetch(`${supabaseUrl}/rest/v1/oasis_specs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        vtid,
        version,
        title: ledgerRow.title || `Spec for ${vtid}`,
        spec_markdown: specMarkdown,
        spec_hash: specHash,
        status: 'draft',
        created_by: source
      })
    });

    if (!insertSpecResp.ok) {
      const errText = await insertSpecResp.text();
      console.error(`[VTID-01188] Failed to insert spec: ${errText}`);

      // Update ledger with error
      await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`
        },
        body: JSON.stringify({
          spec_status: 'missing',
          spec_last_error: 'Failed to save generated spec',
          updated_at: new Date().toISOString()
        })
      });

      return res.status(502).json({ ok: false, error: 'spec_insert_failed', message: errText });
    }

    const specData = await insertSpecResp.json() as any[];
    const newSpec = specData[0];

    // Step 6: Update vtid_ledger with new spec reference
    const updateLedgerResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
      body: JSON.stringify({
        spec_status: 'draft',
        spec_current_id: newSpec.id,
        spec_current_hash: specHash,
        spec_last_error: null,
        updated_at: new Date().toISOString()
      })
    });

    if (!updateLedgerResp.ok) {
      console.error(`[VTID-01188] Failed to update ledger with spec reference`);
    }

    // Emit generate completed event
    await emitOasisEvent({
      vtid,
      type: 'vtid.spec.generate.completed',
      source: 'gateway-specs',
      status: 'success',
      message: `Spec generated for ${vtid} (version ${version})`,
      payload: { spec_id: newSpec.id, spec_hash: specHash, version }
    });

    console.log(`[VTID-01188] Spec generated for ${vtid}: version=${version}, hash=${specHash.substring(0, 8)}...`);

    return res.status(201).json({
      ok: true,
      vtid,
      spec_id: newSpec.id,
      version,
      spec_hash: specHash,
      spec_status: 'draft',
      message: 'Spec generated successfully'
    });

  } catch (e: any) {
    console.error(`[VTID-01188] Generate spec error:`, e);
    return res.status(500).json({ ok: false, error: 'internal_server_error', message: e.message });
  }
});

// ===========================================================================
// POST /:vtid/validate - Validate Spec
// ===========================================================================

router.post('/:vtid/validate', async (req: Request, res: Response) => {
  const { vtid } = req.params;

  console.log(`[VTID-01188] Validate spec requested for ${vtid}`);

  if (!validateVtidFormat(vtid)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_vtid_format',
      message: 'VTID must match format VTID-XXXXX'
    });
  }

  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Step 1: Fetch the VTID from ledger
    const ledgerResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` }
    });

    if (!ledgerResp.ok) {
      return res.status(502).json({ ok: false, error: 'database_query_failed' });
    }

    const ledgerData = await ledgerResp.json() as any[];
    if (ledgerData.length === 0) {
      return res.status(404).json({ ok: false, error: 'vtid_not_found', vtid });
    }

    const ledgerRow = ledgerData[0];

    // Check if there's a current spec to validate
    if (!ledgerRow.spec_current_id) {
      return res.status(400).json({
        ok: false,
        error: 'no_spec_to_validate',
        message: 'No spec exists for this VTID. Generate a spec first.'
      });
    }

    // Step 2: Set spec_status to 'validating'
    await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
      body: JSON.stringify({
        spec_status: 'validating',
        updated_at: new Date().toISOString()
      })
    });

    // Step 3: Fetch the current spec
    const specResp = await fetch(`${supabaseUrl}/rest/v1/oasis_specs?id=eq.${ledgerRow.spec_current_id}`, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` }
    });

    if (!specResp.ok) {
      return res.status(502).json({ ok: false, error: 'spec_fetch_failed' });
    }

    const specData = await specResp.json() as any[];
    if (specData.length === 0) {
      return res.status(404).json({ ok: false, error: 'spec_not_found' });
    }

    const spec = specData[0];

    // Step 4: Validate spec sections
    const validation = validateSpecSections(spec.spec_markdown);

    // Step 5: Insert validation record
    const validationRecord = {
      vtid,
      spec_id: spec.id,
      spec_hash: spec.spec_hash,
      validator_model: 'gateway-deterministic-v1',
      result: validation.valid ? 'pass' : 'fail',
      report_json: validation.report
    };

    const insertValidationResp = await fetch(`${supabaseUrl}/rest/v1/oasis_spec_validations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: 'return=representation'
      },
      body: JSON.stringify(validationRecord)
    });

    let validationId: string | undefined;
    if (insertValidationResp.ok) {
      const valData = await insertValidationResp.json() as any[];
      validationId = valData[0]?.id;
    }

    // Step 6: Update vtid_ledger and spec status based on validation result
    const newSpecStatus = validation.valid ? 'validated' : 'rejected';
    const errorMessage = validation.valid ? null : `Missing required sections: ${validation.missing.join(', ')}`;

    await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
      body: JSON.stringify({
        spec_status: newSpecStatus,
        spec_last_error: errorMessage,
        updated_at: new Date().toISOString()
      })
    });

    // Update spec status
    await fetch(`${supabaseUrl}/rest/v1/oasis_specs?id=eq.${spec.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
      body: JSON.stringify({ status: newSpecStatus })
    });

    // Emit validation completed event
    await emitOasisEvent({
      vtid,
      type: 'vtid.spec.validation.completed',
      source: 'gateway-specs',
      status: validation.valid ? 'success' : 'warning',
      message: `Spec validation ${validation.valid ? 'passed' : 'failed'} for ${vtid}`,
      payload: {
        spec_id: spec.id,
        validation_id: validationId,
        result: validation.valid ? 'pass' : 'fail',
        missing_sections: validation.missing
      }
    });

    console.log(`[VTID-01188] Spec validation ${validation.valid ? 'PASSED' : 'FAILED'} for ${vtid}`);

    return res.status(200).json({
      ok: true,
      vtid,
      spec_id: spec.id,
      result: validation.valid ? 'pass' : 'fail',
      spec_status: newSpecStatus,
      validation_id: validationId,
      report: validation.report,
      message: validation.valid
        ? 'Spec validation passed'
        : `Spec validation failed: ${validation.missing.length} required section(s) missing`
    });

  } catch (e: any) {
    console.error(`[VTID-01188] Validate spec error:`, e);
    return res.status(500).json({ ok: false, error: 'internal_server_error', message: e.message });
  }
});

// ===========================================================================
// POST /:vtid/quality-check - Spec Quality Agent Gate
// ===========================================================================

router.post('/:vtid/quality-check', async (req: Request, res: Response) => {
  const { vtid } = req.params;

  console.log(`[spec-quality] Quality check requested for ${vtid}`);

  if (!validateVtidFormat(vtid)) {
    return res.status(400).json({ ok: false, error: 'invalid_vtid_format', vtid });
  }

  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!svcKey || !supabaseUrl) {
    return res.status(500).json({ ok: false, error: 'gateway_misconfigured' });
  }

  try {
    const headers = { apikey: svcKey, Authorization: `Bearer ${svcKey}` };

    // Step 1: Get ledger row
    const ledgerResp = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}&select=vtid,spec_status,spec_current_id,spec_current_hash&limit=1`,
      { headers }
    );
    if (!ledgerResp.ok) return res.status(502).json({ ok: false, error: 'ledger_fetch_failed' });

    const ledgerData = await ledgerResp.json() as any[];
    if (ledgerData.length === 0) return res.status(404).json({ ok: false, error: 'vtid_not_found', vtid });

    const ledgerRow = ledgerData[0];

    // Must be 'validated' or 'quality_failed' (retry) to run quality check
    if (ledgerRow.spec_status !== 'validated' && ledgerRow.spec_status !== 'quality_failed') {
      return res.status(409).json({
        ok: false,
        error: 'spec_not_validated',
        message: `Spec must be validated before quality check. Current status: ${ledgerRow.spec_status}`,
        spec_status: ledgerRow.spec_status
      });
    }

    // Step 2: Get spec content
    if (!ledgerRow.spec_current_id) {
      return res.status(400).json({ ok: false, error: 'no_spec_exists', message: 'No spec generated for this VTID' });
    }

    const specResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_specs?id=eq.${ledgerRow.spec_current_id}&select=id,spec_markdown,spec_hash&limit=1`,
      { headers }
    );
    if (!specResp.ok) return res.status(502).json({ ok: false, error: 'spec_fetch_failed' });

    const specData = await specResp.json() as any[];
    if (specData.length === 0) return res.status(404).json({ ok: false, error: 'spec_not_found' });

    const spec = specData[0];

    // Step 3: Run full quality check
    const report = await runFullQualityCheck(
      vtid,
      spec.spec_markdown,
      spec.spec_hash || ledgerRow.spec_current_hash,
      supabaseUrl,
      svcKey
    );

    // Step 4: Store quality report (non-blocking)
    const reportPayload = {
      vtid,
      spec_id: spec.id,
      spec_hash: spec.spec_hash || ledgerRow.spec_current_hash,
      overall_result: report.overall_result,
      overall_score: report.overall_score,
      risk_level: report.risk_level,
      checks_json: report.checks,
      impact_json: report.impact_analysis,
      conflict_json: report.conflict_analysis,
      governance_json: report.governance_analysis,
    };

    await fetch(`${supabaseUrl}/rest/v1/oasis_spec_quality_reports`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(reportPayload),
    }).catch(err => console.warn(`[spec-quality] Failed to store report: ${err}`));

    // Step 5: Update spec_status based on result
    const newStatus = report.overall_result === 'fail' ? 'quality_failed' : 'quality_checked';

    await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec_status: newStatus, updated_at: new Date().toISOString() }),
    });

    // Step 6: Emit OASIS event
    await emitOasisEvent({
      vtid,
      type: report.overall_result === 'fail' ? 'vtid.spec.quality_check.failed' : 'vtid.spec.quality_check.passed',
      source: 'spec-quality-agent',
      status: report.overall_result === 'fail' ? 'error' : 'success',
      message: `Quality check ${report.overall_result}: score=${report.overall_score}, risk=${report.risk_level}`,
      payload: {
        overall_score: report.overall_score,
        risk_level: report.risk_level,
        risk_reasons: report.risk_reasons,
        failed_checks: report.checks.filter((c: any) => c.result === 'fail').map((c: any) => c.check_id),
        conflict_count: report.conflict_analysis.overlap_count,
        governance_gap: report.governance_analysis.governance_gap,
      },
    }).catch(err => console.warn(`[spec-quality] OASIS event error: ${err}`));

    console.log(`[spec-quality] ${vtid}: ${report.overall_result} (score=${report.overall_score}, risk=${report.risk_level})`);

    return res.status(200).json({
      ok: true,
      vtid,
      spec_status: newStatus,
      report,
    });

  } catch (e: any) {
    console.error(`[spec-quality] Quality check error:`, e);
    return res.status(500).json({ ok: false, error: 'internal_server_error', message: e.message });
  }
});

// ===========================================================================
// POST /:vtid/approve - Approve Spec
// ===========================================================================

router.post('/:vtid/approve', async (req: Request, res: Response) => {
  const { vtid } = req.params;
  const userId = req.headers['x-user-id'] as string || 'unknown';
  const userRole = req.headers['x-user-role'] as string || 'operator';

  console.log(`[VTID-01188] Approve spec requested for ${vtid} by ${userId} (${userRole})`);

  if (!validateVtidFormat(vtid)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_vtid_format',
      message: 'VTID must match format VTID-XXXXX'
    });
  }

  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Step 1: Fetch the VTID from ledger
    const ledgerResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` }
    });

    if (!ledgerResp.ok) {
      return res.status(502).json({ ok: false, error: 'database_query_failed' });
    }

    const ledgerData = await ledgerResp.json() as any[];
    if (ledgerData.length === 0) {
      return res.status(404).json({ ok: false, error: 'vtid_not_found', vtid });
    }

    const ledgerRow = ledgerData[0];

    // Step 2: Check if spec has passed quality check (or legacy validated)
    if (ledgerRow.spec_status === 'quality_checked') {
      // New flow: quality gate passed — proceed to approval
    } else if (ledgerRow.spec_status === 'validated') {
      // Legacy bypass: spec validated before quality agent existed — allow with warning
      console.warn(`[VTID-01188] Legacy approval bypass for ${vtid} (spec_status=validated, no quality check)`);
      emitOasisEvent({
        vtid,
        type: 'vtid.spec.approval.legacy_bypass',
        source: 'spec-quality-agent',
        status: 'warning',
        message: `Spec approved without quality check (legacy bypass)`,
        payload: { spec_status: 'validated', reason: 'pre_quality_agent_spec' },
      }).catch(() => {});
    } else {
      return res.status(409).json({
        ok: false,
        error: 'spec_not_quality_checked',
        code: 'SPEC_NOT_QUALITY_CHECKED',
        message: `Spec must pass quality check before approval. Current status: ${ledgerRow.spec_status}. Run POST /specs/${vtid}/quality-check first.`,
        spec_status: ledgerRow.spec_status
      });
    }

    // Step 3: Get the current spec
    if (!ledgerRow.spec_current_id) {
      return res.status(400).json({
        ok: false,
        error: 'no_spec_to_approve',
        message: 'No spec exists for this VTID.'
      });
    }

    // Step 4: Insert approval record
    const approvalResp = await fetch(`${supabaseUrl}/rest/v1/oasis_spec_approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        vtid,
        spec_id: ledgerRow.spec_current_id,
        spec_hash: ledgerRow.spec_current_hash,
        approved_by: userId,
        approved_role: userRole
      })
    });

    let approvalId: string | undefined;
    if (approvalResp.ok) {
      const approvalData = await approvalResp.json() as any[];
      approvalId = approvalData[0]?.id;
    }

    // Step 5: Update vtid_ledger with approval
    const now = new Date().toISOString();
    await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
      body: JSON.stringify({
        spec_status: 'approved',
        spec_approved_hash: ledgerRow.spec_current_hash,
        spec_approved_by: userId,
        spec_approved_at: now,
        spec_last_error: null,
        updated_at: now
      })
    });

    // Step 6: Update spec status to approved
    await fetch(`${supabaseUrl}/rest/v1/oasis_specs?id=eq.${ledgerRow.spec_current_id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
      body: JSON.stringify({ status: 'approved' })
    });

    // Emit approval event
    await emitOasisEvent({
      vtid,
      type: 'vtid.spec.approved',
      source: 'gateway-specs',
      status: 'success',
      message: `Spec approved for ${vtid} by ${userId}`,
      payload: {
        spec_id: ledgerRow.spec_current_id,
        spec_hash: ledgerRow.spec_current_hash,
        approval_id: approvalId,
        approved_by: userId,
        approved_role: userRole
      }
    });

    console.log(`[VTID-01188] Spec approved for ${vtid} by ${userId}`);

    return res.status(200).json({
      ok: true,
      vtid,
      spec_id: ledgerRow.spec_current_id,
      spec_status: 'approved',
      approval_id: approvalId,
      approved_by: userId,
      approved_role: userRole,
      approved_at: now,
      message: 'Spec approved. Activation is now allowed.'
    });

  } catch (e: any) {
    console.error(`[VTID-01188] Approve spec error:`, e);
    return res.status(500).json({ ok: false, error: 'internal_server_error', message: e.message });
  }
});

// ===========================================================================
// GET /:vtid - Get Spec Status and Content
// ===========================================================================

router.get('/:vtid', async (req: Request, res: Response) => {
  const { vtid } = req.params;

  console.log(`[VTID-01188] Get spec requested for ${vtid}`);

  if (!validateVtidFormat(vtid)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_vtid_format',
      message: 'VTID must match format VTID-XXXXX'
    });
  }

  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Step 1: Fetch the VTID from ledger
    const ledgerResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` }
    });

    if (!ledgerResp.ok) {
      return res.status(502).json({ ok: false, error: 'database_query_failed' });
    }

    const ledgerData = await ledgerResp.json() as any[];
    if (ledgerData.length === 0) {
      return res.status(404).json({ ok: false, error: 'vtid_not_found', vtid });
    }

    const ledgerRow = ledgerData[0];

    // Step 2: Prepare response
    const response: Record<string, unknown> = {
      ok: true,
      vtid,
      spec_status: ledgerRow.spec_status || 'missing',
      spec_current_id: ledgerRow.spec_current_id || null,
      spec_current_hash: ledgerRow.spec_current_hash || null,
      spec_approved_hash: ledgerRow.spec_approved_hash || null,
      spec_approved_by: ledgerRow.spec_approved_by || null,
      spec_approved_at: ledgerRow.spec_approved_at || null,
      spec_last_error: ledgerRow.spec_last_error || null,
      can_activate: ledgerRow.spec_status === 'approved' &&
                    ledgerRow.spec_current_hash === ledgerRow.spec_approved_hash
    };

    // Step 3: Fetch current spec if exists
    if (ledgerRow.spec_current_id) {
      const specResp = await fetch(`${supabaseUrl}/rest/v1/oasis_specs?id=eq.${ledgerRow.spec_current_id}`, {
        headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` }
      });

      if (specResp.ok) {
        const specData = await specResp.json() as any[];
        if (specData.length > 0) {
          const spec = specData[0];
          response.spec = {
            id: spec.id,
            version: spec.version,
            title: spec.title,
            spec_markdown: spec.spec_markdown,
            spec_hash: spec.spec_hash,
            status: spec.status,
            created_by: spec.created_by,
            created_at: spec.created_at
          };
        }
      }

      // Step 4: Fetch latest validation report
      const validationResp = await fetch(
        `${supabaseUrl}/rest/v1/oasis_spec_validations?vtid=eq.${vtid}&order=created_at.desc&limit=1`,
        { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
      );

      if (validationResp.ok) {
        const validationData = await validationResp.json() as any[];
        if (validationData.length > 0) {
          const validation = validationData[0];
          response.latest_validation = {
            id: validation.id,
            result: validation.result,
            validator_model: validation.validator_model,
            report: validation.report_json,
            created_at: validation.created_at
          };
        }
      }

      // Step 5: Fetch approval metadata
      const approvalResp = await fetch(
        `${supabaseUrl}/rest/v1/oasis_spec_approvals?vtid=eq.${vtid}&order=approved_at.desc&limit=1`,
        { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
      );

      if (approvalResp.ok) {
        const approvalData = await approvalResp.json() as any[];
        if (approvalData.length > 0) {
          const approval = approvalData[0];
          response.latest_approval = {
            id: approval.id,
            spec_id: approval.spec_id,
            spec_hash: approval.spec_hash,
            approved_by: approval.approved_by,
            approved_role: approval.approved_role,
            approved_at: approval.approved_at
          };
        }
      }
    }

    return res.status(200).json(response);

  } catch (e: any) {
    console.error(`[VTID-01188] Get spec error:`, e);
    return res.status(500).json({ ok: false, error: 'internal_server_error', message: e.message });
  }
});

export { router as specsRouter };
