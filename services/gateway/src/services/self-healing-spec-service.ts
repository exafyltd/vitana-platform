/**
 * Self-Healing Spec Service
 *
 * Generates fix specifications for the Vitana self-healing system.
 * Takes a Diagnosis and produces a spec following the VTID-01188 template format.
 * Uses Gemini AI with deterministic fallback when AI is unavailable.
 */

import { createHash } from 'crypto';
import { VertexAI } from '@google-cloud/vertexai';
import { GoogleAuth } from 'google-auth-library';
import { Diagnosis, FailureClass } from '../types/self-healing';
import { emitOasisEvent } from './oasis-event-service';
import { runFullQualityCheck } from './spec-quality-agent';

const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const SPEC_MODEL_PRIMARY = 'gemini-2.5-pro';

let googleAuth: GoogleAuth | null = null;
let vertexAI: VertexAI | null = null;
try {
  googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  vertexAI = new VertexAI({ project: VERTEX_PROJECT, location: 'us-central1' });
  console.log(`[SelfHealingSpec] Vertex AI initialized: model=${SPEC_MODEL_PRIMARY}, project=${VERTEX_PROJECT}`);
} catch (err: any) {
  console.warn(`[SelfHealingSpec] Failed to init Vertex AI: ${err.message}`);
}

const REQUIRED_SECTIONS = [
  'Goal',
  'Non-negotiable Governance Rules Touched',
  'Scope',
  'Changes',
  'Files to Modify',
  'Acceptance Criteria',
  'Verification Steps',
  'Rollback Plan',
  'Risk Level',
];

// ---------------------------------------------------------------------------
// Context Assembly
// ---------------------------------------------------------------------------

function assembleSpecContext(diagnosis: Diagnosis): string {
  const lines: string[] = [];

  lines.push('=== FAILURE SUMMARY ===');
  lines.push(`Service: ${diagnosis.service_name}`);
  lines.push(`Endpoint: ${diagnosis.endpoint}`);
  lines.push(`VTID: ${diagnosis.vtid}`);
  lines.push(`Failure class: ${diagnosis.failure_class}`);
  lines.push(`Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%`);
  lines.push(`Root cause: ${diagnosis.root_cause}`);
  lines.push(`Suggested fix: ${diagnosis.suggested_fix}`);
  lines.push(`Auto-fixable: ${diagnosis.auto_fixable}`);
  lines.push('');

  if (diagnosis.codebase_analysis) {
    const ca = diagnosis.codebase_analysis;
    lines.push('=== CODEBASE ANALYSIS ===');
    lines.push(`Route file: ${ca.route_file ?? 'unknown'} (exists: ${ca.route_file_exists})`);
    lines.push(`Health handler exists: ${ca.health_handler_exists}`);
    lines.push(`Handler has errors: ${ca.handler_has_errors}`);
    if (ca.error_description) lines.push(`Error description: ${ca.error_description}`);
    if (ca.router_export_name) lines.push(`Router export: ${ca.router_export_name}`);
    if (ca.imports.length > 0) lines.push(`Imports: ${ca.imports.join(', ')}`);
    if (ca.env_vars_used.length > 0) lines.push(`Env vars used: ${ca.env_vars_used.join(', ')}`);
    if (ca.supabase_tables_used.length > 0) lines.push(`Supabase tables: ${ca.supabase_tables_used.join(', ')}`);
    if (ca.related_service_files.length > 0) lines.push(`Related files: ${ca.related_service_files.join(', ')}`);
    for (const e of ca.evidence) lines.push(`  Evidence: ${e}`);
    lines.push('');
  }

  if (diagnosis.git_analysis) {
    const ga = diagnosis.git_analysis;
    lines.push('=== GIT HISTORY ===');
    if (ga.latest_commit) lines.push(`Latest commit: ${ga.latest_commit}`);
    if (ga.last_modified) lines.push(`Last modified: ${ga.last_modified}`);
    if (ga.code_exists_but_not_deployed) lines.push('WARNING: Code exists but is NOT deployed');
    if (ga.deployed_sha) lines.push(`Deployed SHA: ${ga.deployed_sha}`);
    if (ga.breaking_commit) {
      lines.push(`BREAKING COMMIT: ${ga.breaking_commit.sha} — ${ga.breaking_commit.message} (${ga.breaking_commit.author}, ${ga.breaking_commit.date})`);
      if (ga.breaking_commit.diff_summary) lines.push(`  Diff: ${ga.breaking_commit.diff_summary}`);
    }
    for (const c of ga.recent_commits) {
      lines.push(`  Commit: ${c.sha.slice(0, 8)} ${c.message} (${c.author}, ${c.date})`);
    }
    for (const e of ga.evidence) lines.push(`  Evidence: ${e}`);
    lines.push('');
  }

  if (diagnosis.dependency_analysis) {
    const da = diagnosis.dependency_analysis;
    lines.push('=== DEPENDENCY ANALYSIS ===');
    if (da.missing_import) lines.push(`Missing import: ${da.missing_import}`);
    if (da.missing_env_vars.length > 0) lines.push(`Missing env vars: ${da.missing_env_vars.join(', ')}`);
    if (da.missing_db_table) lines.push(`Missing DB table: ${da.missing_db_table}`);
    for (const e of da.evidence) lines.push(`  Evidence: ${e}`);
    lines.push('');
  }

  if (diagnosis.workflow_analysis) {
    const wa = diagnosis.workflow_analysis;
    lines.push('=== WORKFLOW ANALYSIS ===');
    lines.push(`Route mounted in index.ts: ${wa.route_mounted_in_index}`);
    if (wa.mount_path) lines.push(`Mount path: ${wa.mount_path}`);
    if (wa.middleware_chain.length > 0) lines.push(`Middleware chain: ${wa.middleware_chain.join(' → ')}`);
    lines.push(`Middleware blocking: ${wa.middleware_blocking}`);
    if (wa.blocking_middleware) lines.push(`Blocking middleware: ${wa.blocking_middleware}`);
    lines.push(`Auth required: ${wa.auth_required}`);
    lines.push(`Health exempt from auth: ${wa.health_exempt_from_auth}`);
    for (const e of wa.evidence) lines.push(`  Evidence: ${e}`);
    lines.push('');
  }

  if (diagnosis.evidence.length > 0) {
    lines.push('=== COLLECTED EVIDENCE ===');
    for (const e of diagnosis.evidence) lines.push(`- ${e}`);
    lines.push('');
  }

  if (diagnosis.files_to_modify.length > 0) {
    lines.push('=== FILES IDENTIFIED FOR MODIFICATION ===');
    for (const f of diagnosis.files_to_modify) lines.push(`- ${f}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// AI Spec Generation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior Vitana platform engineer writing a fix specification.

Architecture context:
- Express gateway with routes at services/gateway/src/routes/
- Supabase PostgreSQL database (tables accessed via REST API with service role key)
- OASIS event system for audit/observability (emitOasisEvent → oasis_events table)
- Cloud Run deployment (single service: vitana-gateway)
- Frontend: Lovable-managed SPA (temp_vitana_v1/src/) + Command Hub (services/gateway/src/frontend/command-hub/)

Write a complete fix spec following the VTID-01188 template with ALL 9 required sections:
1. Goal
2. Non-negotiable Governance Rules Touched
3. Scope (IN/OUT)
4. Changes (DB/API/UI subsections)
5. Files to Modify
6. Acceptance Criteria
7. Verification Steps (include curl commands)
8. Rollback Plan
9. Risk Level

Be specific and actionable. No placeholders or TBD items. Every section must have real content derived from the diagnosis.`;

async function generateSpecWithAI(diagnosis: Diagnosis, context: string): Promise<string> {
  const userPrompt = `Generate a complete fix specification for the following diagnosed failure.

${context}

Produce the spec in markdown with a title line "# Fix: ${diagnosis.root_cause}" and VTID "${diagnosis.vtid}".
Include ALL 9 required sections with real, actionable content. Every curl verification step must use the actual endpoint.`;

  if (vertexAI) {
    try {
      const model = vertexAI.getGenerativeModel({
        model: SPEC_MODEL_PRIMARY,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          topP: 0.9,
        },
        systemInstruction: { role: 'system', parts: [{ text: SYSTEM_PROMPT }] },
      });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      });

      const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.length > 200) {
        console.log(`[SelfHealingSpec] AI spec generated (${text.length} chars) for ${diagnosis.vtid}`);
        return text;
      }
      console.warn(`[SelfHealingSpec] AI returned empty/short response for ${diagnosis.vtid}, using fallback`);
    } catch (err: any) {
      console.warn(`[SelfHealingSpec] AI generation failed for ${diagnosis.vtid}: ${err.message}, using fallback`);
    }
  }

  return buildDeterministicSpec(diagnosis);
}

// ---------------------------------------------------------------------------
// Deterministic Fallback Template
// ---------------------------------------------------------------------------

function buildDeterministicSpec(diagnosis: Diagnosis): string {
  const d = diagnosis;
  const ca = d.codebase_analysis;
  const ga = d.git_analysis;
  const da = d.dependency_analysis;
  const wa = d.workflow_analysis;

  const riskLevel = deriveRiskLevel(d);
  const governanceRules = deriveGovernanceRules(d);
  const dbChanges = deriveDatabaseChanges(d);
  const apiChanges = deriveApiChanges(d);
  const uiChanges = deriveUiChanges(d);

  const filesSection = d.files_to_modify.length > 0
    ? d.files_to_modify.map(f => `- \`${f}\``).join('\n')
    : `- \`${ca?.route_file ?? 'services/gateway/src/routes/' + d.service_name.toLowerCase().replace(/\s+/g, '-') + '.ts'}\``;

  const curlEndpoint = d.endpoint.startsWith('http')
    ? d.endpoint
    : `https://vitana-gateway-<hash>-uc.a.run.app${d.endpoint}`;

  const breakingCommitInfo = ga?.breaking_commit
    ? `\n\nIf fix causes regression, revert to commit \`${ga.breaking_commit.sha.slice(0, 8)}\` (pre-breaking state).`
    : '';

  const spec = `# Fix: ${d.root_cause}

**VTID:** ${d.vtid}

---

## 1. Goal

Resolve ${d.failure_class.replace(/_/g, ' ')} failure on \`${d.endpoint}\` in the ${d.service_name} service. The endpoint is currently returning errors, diagnosed with ${(d.confidence * 100).toFixed(0)}% confidence as: ${d.root_cause}. The fix will restore the endpoint to healthy status and ensure it passes health checks.

---

## 2. Non-negotiable Governance Rules Touched

${governanceRules}

---

## 3. Scope

### IN SCOPE
- Fix the root cause: ${d.root_cause}
- Verify \`${d.endpoint}\` returns 200 OK after fix
${da?.missing_env_vars && da.missing_env_vars.length > 0 ? `- Add missing environment variables: ${da.missing_env_vars.join(', ')}\n` : ''}${da?.missing_import ? `- Add missing import: \`${da.missing_import}\`\n` : ''}${wa && !wa.route_mounted_in_index ? `- Mount route in index.ts at path \`${wa.mount_path ?? d.endpoint.split('/').slice(0, -1).join('/')}\`\n` : ''}${ga?.code_exists_but_not_deployed ? '- Trigger redeployment to sync code with running revision\n' : ''}- Emit OASIS events for audit trail

### OUT OF SCOPE
- Refactoring unrelated routes or services
- Database schema migrations beyond what is required for this fix
- UI/frontend changes unless directly caused by this failure
- Performance optimization of unrelated endpoints

---

## 4. Changes

### 4.1 Database Migrations (SQL)
${dbChanges}

### 4.2 APIs (Routes, Request/Response)
${apiChanges}

### 4.3 UI Changes (Screens, States)
${uiChanges}

---

## 5. Files to Modify

${filesSection}

---

## 6. Acceptance Criteria

- [ ] \`GET ${d.endpoint}\` returns HTTP 200 with \`{ "ok": true }\`
- [ ] No other endpoints regress (run full health check suite)
- [ ] OASIS event \`self-healing.fix.applied\` emitted with VTID ${d.vtid}
${da?.missing_env_vars && da.missing_env_vars.length > 0 ? `- [ ] Environment variables present in Cloud Run revision: ${da.missing_env_vars.join(', ')}\n` : ''}${wa && !wa.route_mounted_in_index ? `- [ ] Route mounted in index.ts and accessible\n` : ''}${ca?.handler_has_errors ? `- [ ] Handler error resolved: ${ca.error_description ?? 'handler crash fixed'}\n` : ''}- [ ] Spec quality score >= 0.7

---

## 7. Verification Steps

### 7.1 curl Calls
\`\`\`bash
# Verify endpoint health
curl -s ${curlEndpoint} | jq .

# Expected response:
# { "ok": true, ... }

# Verify no blast radius — check gateway root health
curl -s https://vitana-gateway-<hash>-uc.a.run.app/health | jq .

# Check OASIS event was recorded
curl -s "${SUPABASE_URL ?? 'https://<project>.supabase.co'}/rest/v1/oasis_events?vtid=eq.${d.vtid}&topic=eq.self-healing.fix.applied&order=created_at.desc&limit=1" \\
  -H "apikey: \$SUPABASE_SERVICE_ROLE" \\
  -H "Authorization: Bearer \$SUPABASE_SERVICE_ROLE" | jq .
\`\`\`

### 7.2 UI Checks
- Command Hub task board shows ${d.vtid} with status "fixed"
- OASIS event log displays the fix event with correct metadata

---

## 8. Rollback Plan

1. Revert the commit that applied this fix using \`git revert <sha>\`
2. Push to main and let CI/CD redeploy
3. Verify \`/health\` still returns 200 (gateway overall health)
4. Mark ${d.vtid} as \`rollback\` in vtid_ledger${breakingCommitInfo}

---

## 9. Risk Level

**${riskLevel.level}**

Justification:
${riskLevel.reasons.map(r => `- ${r}`).join('\n')}
`;

  return spec;
}

function deriveRiskLevel(diagnosis: Diagnosis): { level: string; reasons: string[] } {
  const reasons: string[] = [];
  let level = 'LOW';

  if (diagnosis.files_to_modify.length > 3) {
    level = 'MEDIUM';
    reasons.push(`${diagnosis.files_to_modify.length} files require modification`);
  }

  const highRiskClasses: FailureClass[] = [
    FailureClass.DATABASE_SCHEMA_DRIFT,
    FailureClass.DATA_CORRUPTION,
    FailureClass.REGRESSION,
  ];
  if (highRiskClasses.includes(diagnosis.failure_class)) {
    level = 'HIGH';
    reasons.push(`Failure class "${diagnosis.failure_class}" carries inherent risk`);
  }

  const mediumRiskClasses: FailureClass[] = [
    FailureClass.MIDDLEWARE_REJECTION,
    FailureClass.INTEGRATION_FAILURE,
    FailureClass.DEPENDENCY_TIMEOUT,
  ];
  if (mediumRiskClasses.includes(diagnosis.failure_class) && level !== 'HIGH') {
    level = 'MEDIUM';
    reasons.push(`Failure class "${diagnosis.failure_class}" may affect dependent services`);
  }

  if (diagnosis.codebase_analysis?.supabase_tables_used && diagnosis.codebase_analysis.supabase_tables_used.length > 0) {
    if (level === 'LOW') level = 'MEDIUM';
    reasons.push(`Touches Supabase tables: ${diagnosis.codebase_analysis.supabase_tables_used.join(', ')}`);
  }

  if (diagnosis.workflow_analysis?.auth_required && !diagnosis.workflow_analysis.health_exempt_from_auth) {
    reasons.push('Auth middleware applies to this route — changes may affect authenticated flows');
  }

  if (reasons.length === 0) {
    reasons.push('Single-file fix with no database or auth impact');
    reasons.push(`Failure class "${diagnosis.failure_class}" is straightforward to resolve`);
  }

  return { level, reasons };
}

function deriveGovernanceRules(diagnosis: Diagnosis): string {
  const rules: string[] = [];

  if (diagnosis.workflow_analysis?.auth_required) {
    rules.push('- **AUTH-01**: Route requires authentication — any handler changes must preserve JWT validation');
  }
  if (diagnosis.codebase_analysis?.supabase_tables_used && diagnosis.codebase_analysis.supabase_tables_used.length > 0) {
    rules.push('- **DATA-01**: Supabase table access — must use service role key server-side only, never expose to client');
  }
  if (diagnosis.failure_class === FailureClass.DATABASE_SCHEMA_DRIFT) {
    rules.push('- **MIGRATION-01**: Database schema changes require a migration file and rollback SQL');
  }
  if (diagnosis.endpoint.includes('/health')) {
    rules.push('- **HEALTH-01**: Health endpoints must return `{ "ok": true }` with HTTP 200 and must not require authentication');
  }

  rules.push('- **DEPLOY-01**: All changes must pass CI checks before merge to main');
  rules.push('- **OASIS-01**: Fix events must be emitted to OASIS for audit trail');

  return rules.join('\n');
}

function deriveDatabaseChanges(diagnosis: Diagnosis): string {
  if (diagnosis.failure_class === FailureClass.DATABASE_SCHEMA_DRIFT && diagnosis.dependency_analysis?.missing_db_table) {
    return `- Create missing table \`${diagnosis.dependency_analysis.missing_db_table}\` if it does not exist\n- Verify RLS policies are applied`;
  }
  return 'No database migrations required for this fix.';
}

function deriveApiChanges(diagnosis: Diagnosis): string {
  const changes: string[] = [];

  switch (diagnosis.failure_class) {
    case FailureClass.ROUTE_NOT_REGISTERED:
      changes.push(`- Register route handler for \`${diagnosis.endpoint}\` in the route file`);
      if (diagnosis.workflow_analysis && !diagnosis.workflow_analysis.route_mounted_in_index) {
        changes.push(`- Mount router in \`index.ts\` at path \`${diagnosis.workflow_analysis.mount_path ?? diagnosis.endpoint}\``);
      }
      break;
    case FailureClass.HANDLER_CRASH:
      changes.push(`- Fix crash in handler for \`${diagnosis.endpoint}\`: ${diagnosis.root_cause}`);
      changes.push('- Add proper error handling with try/catch to prevent unhandled exceptions');
      break;
    case FailureClass.MISSING_ENV_VAR:
      changes.push(`- Add fallback handling for missing environment variables in the route handler`);
      if (diagnosis.dependency_analysis?.missing_env_vars) {
        for (const v of diagnosis.dependency_analysis.missing_env_vars) {
          changes.push(`- Ensure \`${v}\` is set in Cloud Run environment or provide a safe default`);
        }
      }
      break;
    case FailureClass.IMPORT_ERROR:
      changes.push(`- Fix broken import: \`${diagnosis.dependency_analysis?.missing_import ?? 'see diagnosis'}\``);
      changes.push('- Verify all imported modules are installed and paths are correct');
      break;
    case FailureClass.MIDDLEWARE_REJECTION:
      changes.push(`- Fix middleware rejection: ${diagnosis.root_cause}`);
      if (diagnosis.workflow_analysis?.blocking_middleware) {
        changes.push(`- Adjust \`${diagnosis.workflow_analysis.blocking_middleware}\` middleware to allow this route`);
      }
      break;
    default:
      changes.push(`- Apply fix for \`${diagnosis.endpoint}\`: ${diagnosis.suggested_fix}`);
      break;
  }

  return changes.join('\n');
}

function deriveUiChanges(diagnosis: Diagnosis): string {
  if (diagnosis.endpoint.includes('/command-hub')) {
    return '- Command Hub UI may need update if the endpoint contract changes. Verify app.js references after fix.';
  }
  return 'No UI changes required — this is a backend/API fix.';
}

// ---------------------------------------------------------------------------
// Section Validation
// ---------------------------------------------------------------------------

function validateSpecSections(spec: string): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    const patterns = [
      new RegExp(`^##?\\s*\\d*\\.?\\s*${section}`, 'im'),
      new RegExp(`^##?\\s*${section}`, 'im'),
    ];
    if (!patterns.some(p => p.test(spec))) {
      missing.push(section);
    }
  }
  return { valid: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Supabase Helpers
// ---------------------------------------------------------------------------

function getSupabaseConfig(): { supabaseUrl: string; svcKey: string } {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('Supabase not configured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
  }
  return { supabaseUrl: SUPABASE_URL, svcKey: SUPABASE_SERVICE_ROLE };
}

async function storeSpec(
  vtid: string,
  specMarkdown: string,
  specHash: string,
  qualityScore: number,
  supabaseUrl: string,
  svcKey: string
): Promise<void> {
  const headers = {
    'Content-Type': 'application/json',
    apikey: svcKey,
    Authorization: `Bearer ${svcKey}`,
    Prefer: 'return=minimal',
  };

  const specPayload = {
    vtid,
    version: 1,
    spec_markdown: specMarkdown,
    spec_hash: specHash,
    status: 'validated',
    source: 'self-healing',
    quality_score: qualityScore,
  };

  const storeRes = await fetch(`${supabaseUrl}/rest/v1/oasis_specs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(specPayload),
  });

  if (!storeRes.ok) {
    const body = await storeRes.text();
    throw new Error(`Failed to store spec in oasis_specs: ${storeRes.status} ${body}`);
  }
}

async function updateLedgerSpecStatus(
  vtid: string,
  supabaseUrl: string,
  svcKey: string
): Promise<void> {
  const headers = {
    'Content-Type': 'application/json',
    apikey: svcKey,
    Authorization: `Bearer ${svcKey}`,
    Prefer: 'return=minimal',
  };

  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ spec_status: 'validated' }),
    }
  );

  if (!patchRes.ok) {
    const body = await patchRes.text();
    console.warn(`[SelfHealingSpec] Failed to update vtid_ledger spec_status for ${vtid}: ${patchRes.status} ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

export async function generateAndStoreFixSpec(
  diagnosis: Diagnosis
): Promise<{ spec: string; spec_hash: string; quality_score: number }> {
  console.log(`[SelfHealingSpec] Generating fix spec for ${diagnosis.vtid} (${diagnosis.failure_class})`);

  const context = assembleSpecContext(diagnosis);
  let spec = await generateSpecWithAI(diagnosis, context);

  const sectionCheck = validateSpecSections(spec);
  if (!sectionCheck.valid) {
    console.warn(
      `[SelfHealingSpec] AI spec missing sections: ${sectionCheck.missing.join(', ')}. Falling back to deterministic template.`
    );
    spec = buildDeterministicSpec(diagnosis);
  }

  const specHash = createHash('sha256').update(spec).digest('hex');

  let qualityScore = 0.5;
  const { supabaseUrl, svcKey } = getSupabaseConfig();

  try {
    const qualityReport = await runFullQualityCheck(diagnosis.vtid, spec, specHash, supabaseUrl, svcKey);
    qualityScore = qualityReport.overall_score;
    console.log(
      `[SelfHealingSpec] Quality check for ${diagnosis.vtid}: score=${qualityScore}, result=${qualityReport.overall_result}`
    );
  } catch (err: any) {
    console.warn(`[SelfHealingSpec] Quality check failed for ${diagnosis.vtid}: ${err.message}. Using default score 0.5`);
  }

  await storeSpec(diagnosis.vtid, spec, specHash, qualityScore, supabaseUrl, svcKey);
  await updateLedgerSpecStatus(diagnosis.vtid, supabaseUrl, svcKey);

  await emitOasisEvent({
    vtid: diagnosis.vtid,
    type: 'self-healing.spec.generated',
    source: 'self-healing-spec-service',
    status: 'success',
    message: `Fix spec generated for ${diagnosis.service_name} (quality: ${qualityScore.toFixed(2)})`,
    payload: {
      spec_hash: specHash,
      quality_score: qualityScore,
      failure_class: diagnosis.failure_class,
      endpoint: diagnosis.endpoint,
      service: diagnosis.service_name,
      auto_fixable: diagnosis.auto_fixable,
    },
  });

  console.log(
    `[SelfHealingSpec] Spec stored and event emitted for ${diagnosis.vtid} (hash=${specHash.slice(0, 12)}…, quality=${qualityScore})`
  );

  return { spec, spec_hash: specHash, quality_score: qualityScore };
}
