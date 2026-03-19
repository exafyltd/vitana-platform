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
import { VertexAI } from '@google-cloud/vertexai';
import { emitOasisEvent } from '../services/oasis-event-service';
import { runFullQualityCheck } from '../services/spec-quality-agent';

const router = Router();

// ===========================================================================
// Vertex AI for LLM-powered spec generation
// ===========================================================================
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
// Gemini 3.1 Pro requires the global endpoint, not regional (us-central1)
const SPEC_GEN_LOCATION = 'global';
const SPEC_GEN_MODEL = 'gemini-3.1-pro-preview';

let vertexAI: VertexAI | null = null;
try {
  if (VERTEX_PROJECT) {
    vertexAI = new VertexAI({ project: VERTEX_PROJECT, location: SPEC_GEN_LOCATION });
    console.log(`[VTID-01188] Vertex AI initialized for spec generation: project=${VERTEX_PROJECT}, location=${SPEC_GEN_LOCATION}, model=${SPEC_GEN_MODEL}`);
  }
} catch (err: any) {
  console.warn(`[VTID-01188] Failed to init Vertex AI for spec gen: ${err.message}`);
}

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
  // Allow both numeric VTIDs (VTID-01217) and hex VTIDs from autopilot (VTID-B95E9)
  return /^VTID-[A-Za-z0-9]{4,6}(-[A-Za-z0-9]+)?$/.test(vtid);
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
 * Gather deep system context for spec generation — scans vtid_ledger,
 * oasis_events, existing specs, and related tasks to give the LLM
 * real knowledge about the current system state.
 */
async function gatherSystemContext(vtid: string, title: string): Promise<string> {
  const { supabaseUrl, svcKey } = getSupabaseConfig();
  const headers = { apikey: svcKey, Authorization: `Bearer ${svcKey}` };
  const contextParts: string[] = [];

  try {
    // 1. Get related tasks (same domain keywords) for conflict/dependency awareness
    const keywords = title.split(/[\s\-_]+/).filter(w => w.length > 3).slice(0, 3);
    if (keywords.length > 0) {
      const searchTerm = keywords.join(' ');
      const relatedResp = await fetch(
        `${supabaseUrl}/rest/v1/vtid_ledger?or=(title.ilike.*${encodeURIComponent(keywords[0])}*,summary.ilike.*${encodeURIComponent(keywords[0])}*)&vtid=neq.${vtid}&select=vtid,title,status,spec_status,layer,module&limit=10&order=updated_at.desc`,
        { headers }
      );
      if (relatedResp.ok) {
        const related = await relatedResp.json() as any[];
        if (related.length > 0) {
          contextParts.push('## Related/Similar Tasks in System');
          related.forEach((t: any) => {
            contextParts.push(`- ${t.vtid}: "${t.title}" (status=${t.status}, spec=${t.spec_status || 'missing'}, layer=${t.layer || 'unknown'})`);
          });
        }
      }
    }

    // 2. Get recent OASIS events related to this VTID or its domain
    const eventsResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?vtid=eq.${vtid}&select=topic,message,created_at&limit=10&order=created_at.desc`,
      { headers }
    );
    if (eventsResp.ok) {
      const events = await eventsResp.json() as any[];
      if (events.length > 0) {
        contextParts.push('## OASIS Events for This VTID');
        events.forEach((e: any) => {
          contextParts.push(`- [${e.topic}] ${e.message} (${e.created_at})`);
        });
      }
    }

    // 3. Get system health summary — active tasks, blocked tasks
    const statsResp = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?select=status,spec_status&limit=200`,
      { headers }
    );
    if (statsResp.ok) {
      const allTasks = await statsResp.json() as any[];
      const statusCounts: Record<string, number> = {};
      const specCounts: Record<string, number> = {};
      allTasks.forEach((t: any) => {
        statusCounts[t.status || 'unknown'] = (statusCounts[t.status || 'unknown'] || 0) + 1;
        specCounts[t.spec_status || 'missing'] = (specCounts[t.spec_status || 'missing'] || 0) + 1;
      });
      contextParts.push('## Current System State');
      contextParts.push(`Total tasks: ${allTasks.length}`);
      contextParts.push(`Status breakdown: ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      contextParts.push(`Spec status breakdown: ${Object.entries(specCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    // 4. Get existing specs for reference (what good specs look like)
    const recentSpecResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_specs?status=eq.approved&select=vtid,title,spec_markdown&limit=2&order=created_at.desc`,
      { headers }
    );
    if (recentSpecResp.ok) {
      const recentSpecs = await recentSpecResp.json() as any[];
      if (recentSpecs.length > 0) {
        contextParts.push('## Example of Approved Spec Structure (for reference)');
        const example = recentSpecs[0];
        // Include just the first 500 chars as a structural reference
        contextParts.push(`Approved spec "${example.title}" (${example.vtid}):`);
        contextParts.push(example.spec_markdown?.substring(0, 500) + '...');
      }
    }
  } catch (err: any) {
    console.warn(`[VTID-01188] Context gathering error (non-fatal): ${err.message}`);
  }

  return contextParts.join('\n');
}

/**
 * Generate a spec using Gemini 2.5 Pro with deep system context analysis.
 * Falls back to a minimal template if LLM is unavailable.
 */
async function generateSpecWithLLM(vtid: string, title: string, summary: string, seedNotes: string, source: string): Promise<string> {
  // Try LLM generation with deep context
  if (vertexAI) {
    try {
      // Gather system context in parallel with model init
      const systemContext = await gatherSystemContext(vtid, title);

      const model = vertexAI.getGenerativeModel({
        model: SPEC_GEN_MODEL,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 16384,
          topP: 0.9,
        },
        systemInstruction: {
          role: 'system',
          parts: [{ text: SPEC_GEN_SYSTEM_PROMPT }],
        },
      });

      // Build rich prompt with all available context
      const promptParts = [
        `Generate a complete, high-quality implementation specification for the following task.`,
        ``,
        `VTID: ${vtid}`,
        `Task Title: ${title}`,
        summary ? `Task Summary: ${summary}` : '',
        seedNotes && seedNotes.trim() !== title.trim() ? `Additional Context:\n${seedNotes}` : '',
        ``,
        systemContext ? `--- SYSTEM CONTEXT (use this to make the spec specific and accurate) ---\n${systemContext}` : '',
        ``,
        `INSTRUCTIONS:`,
        `- Use the EXACT markdown template format from your system instructions`,
        `- Fill EVERY section with specific, actionable, concrete content`,
        `- Reference actual Vitana file paths (services/gateway/src/..., supabase/migrations/...)`,
        `- Reference actual API patterns (POST /api/v1/..., Supabase RPC calls)`,
        `- Identify real database tables that may need changes (vtid_ledger, oasis_events, etc.)`,
        `- Consider conflicts with related tasks listed in the system context`,
        `- Be specific about risk level based on the scope of changes`,
        `- NEVER use placeholder text like "TBD", "to be determined", or "None identified"`,
      ].filter(Boolean).join('\n');

      console.log(`[VTID-01188] Generating spec with ${SPEC_GEN_MODEL} for ${vtid}: "${title}" (context: ${systemContext.length} chars)`);
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: promptParts }] }],
      });

      const candidate = response.response?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;

      if (text && text.length > 200) {
        console.log(`[VTID-01188] LLM spec generated for ${vtid}: ${text.length} chars`);
        return text;
      }
      console.warn(`[VTID-01188] LLM returned insufficient content (${text?.length || 0} chars), falling back to template`);
    } catch (err: any) {
      console.error(`[VTID-01188] LLM spec generation failed for ${vtid}: ${err.message}`);
    }
  }

  // Fallback: minimal template (clearly marked as needing manual editing)
  console.log(`[VTID-01188] Using template fallback for ${vtid} (Vertex AI unavailable)`);
  return SPEC_TEMPLATE
    .replace('{TITLE}', title || `Task ${vtid}`)
    .replace('{VTID}', vtid)
    .replace('{GOAL}', summary || title || 'Define the goal for this task')
    .replace('{GOVERNANCE_RULES}', '- Review governance rules that this task touches')
    .replace('{IN_SCOPE}', `- ${title}\n- Implementation and testing`)
    .replace('{OUT_SCOPE}', '- Items not explicitly mentioned in acceptance criteria')
    .replace('{DB_MIGRATIONS}', '- Identify required database changes')
    .replace('{API_CHANGES}', '- Identify required API changes')
    .replace('{UI_CHANGES}', '- Identify required UI changes')
    .replace('{FILES_TO_MODIFY}', '- Identify files that need modification')
    .replace('{ACCEPTANCE_CRITERIA}', `1. ${title} is implemented and working\n2. All tests pass\n3. Documentation updated`)
    .replace('{CURL_VERIFICATION}', '```bash\n# Add verification commands\n```')
    .replace('{UI_VERIFICATION}', '- [ ] Verify UI changes work correctly')
    .replace('{ROLLBACK_PLAN}', '- Revert commit if issues detected\n- No database rollback required (additive changes only)')
    .replace('{RISK_LEVEL}', `**Risk:** MEDIUM\n\n**Source:** ${source} (template fallback — LLM unavailable)`);
}

// ===========================================================================
// LLM System Prompt for Spec Generation
// ===========================================================================
const SPEC_GEN_SYSTEM_PROMPT = `You are a senior software architect generating implementation specifications for the Vitana platform. You have deep knowledge of the system architecture and produce production-ready specs.

## Vitana Platform Architecture

### Services
- **Gateway** (Node.js/Express, TypeScript): Main backend API on Cloud Run
  - Routes: services/gateway/src/routes/ (auth.ts, orb-live.ts, specs.ts, autopilot.ts, vtid.ts, board-adapter.ts, etc.)
  - Services: services/gateway/src/services/ (oasis-event-service.ts, gemini-operator.ts, spec-quality-agent.ts, etc.)
  - Frontend: services/gateway/src/frontend/command-hub/app.js (vanilla JS, ~30k lines)
  - Middleware: services/gateway/src/middleware/auth-supabase-jwt.ts
  - Entry: services/gateway/src/index.ts

### Database (Supabase/PostgreSQL)
- **vtid_ledger**: Master task table (vtid, title, summary, status, spec_status, layer, module, is_terminal, terminal_outcome)
- **oasis_events**: Event log (topic, vtid, message, metadata, status, created_at)
- **oasis_specs**: Generated specs (vtid, version, spec_markdown, spec_hash, status)
- **oasis_spec_validations**: Validation records
- **oasis_spec_approvals**: Approval records
- **oasis_spec_quality_reports**: Quality check results
- **autopilot_recommendations**: Auto-generated improvement recommendations
- **app_users**, **user_tenants**, **tenants**: User/tenant management
- **memory_facts**: Conversation memory facts
- Migrations: supabase/migrations/

### Key Patterns
- All DB access via Supabase REST API (PostgREST): fetch(\`\${supabaseUrl}/rest/v1/table_name\`)
- OASIS events emitted via emitOasisEvent() for observability
- VTID format: VTID-XXXXX (numeric) or VTID-XXXXX (hex from autopilot)
- Spec pipeline: missing → draft → validated → quality_checked → approved
- Task lifecycle: scheduled → in_progress → completed/failed
- Frontend uses showToast() for notifications, renderApp() rebuilds entire DOM
- Deploy via GitHub Actions EXEC-DEPLOY.yml → Cloud Run source deploy
- Auth: Supabase JWT tokens, auth middleware validates on every request

### API Patterns
- Base URL: /api/v1/
- Board data: GET /api/v1/commandhub/board
- Task detail: GET /api/v1/vtid/:vtid
- Spec operations: /api/v1/specs/:vtid/generate|validate|quality-check|approve
- OASIS events: /api/v1/oasis/events
- All endpoints return { ok: boolean, ...data } or { ok: false, error: string }

## Output Rules
1. Output ONLY the markdown spec — no preamble, no explanation, no wrapping code fences
2. Use the EXACT section structure below — do not add or remove sections
3. Fill EVERY section with specific, actionable content based on the task and system context
4. NEVER use placeholder text like "TBD", "to be determined", "None identified", or "to be updated"
5. Reference actual Vitana file paths, table names, API endpoints, and patterns
6. Consider dependencies and conflicts with other tasks mentioned in the context
7. Be concrete about risk based on what the task actually touches

## Required Spec Structure

# {Title}

**VTID:** {VTID}

---

## 1. Goal
(Clear 1-3 sentence description of what this task achieves and why it matters)

---

## 2. Non-negotiable Governance Rules Touched
(List specific rules: OASIS event logging, auth requirements, VTID tracking, deploy gates, etc.)

---

## 3. Scope

### IN SCOPE
(Specific deliverables as bullet points)

### OUT OF SCOPE
(Specific exclusions — what this task does NOT do)

---

## 4. Changes

### 4.1 Database Migrations (SQL)
(Specific tables, columns, indexes, RPC functions, constraints)

### 4.2 APIs (Routes, Request/Response)
(Specific endpoints with HTTP methods, request/response shapes)

### 4.3 UI Changes (Screens, States)
(Specific Command Hub components, state changes, user flows)

---

## 5. Files to Modify
(Specific file paths: services/gateway/src/routes/..., services/gateway/src/frontend/..., supabase/migrations/..., etc.)

---

## 6. Acceptance Criteria
(Numbered, testable criteria — each must be verifiable)

---

## 7. Verification Steps

### 7.1 curl Calls
(Actual curl commands against the gateway API to verify the implementation)

### 7.2 UI Checks
(Specific UI verification steps in the Command Hub)

---

## 8. Rollback Plan
(Specific rollback steps: revert commit, drop migration, restore data)

---

## 9. Risk Level
(LOW/MEDIUM/HIGH/CRITICAL with specific justification based on blast radius)`;


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

    // Step 4: Generate spec content using LLM (falls back to template if unavailable)
    const specMarkdown = await generateSpecWithLLM(vtid, ledgerRow.title, ledgerRow.summary || '', seed_notes, source);
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

    const statusPatchResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec_status: newStatus, updated_at: new Date().toISOString() }),
    });

    if (!statusPatchResp.ok) {
      const patchErr = await statusPatchResp.text().catch(() => 'unknown');
      console.error(`[spec-quality] CRITICAL: Failed to update spec_status to ${newStatus} for ${vtid}: ${patchErr}`);
      return res.status(502).json({
        ok: false,
        error: 'spec_status_update_failed',
        message: `Quality check completed (${report.overall_result}) but failed to update spec_status. Check database constraints.`,
        report,
      });
    }

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
