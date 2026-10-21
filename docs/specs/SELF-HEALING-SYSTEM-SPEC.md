# VTID-012XX: Autonomous Self-Healing System

**Status**: DRAFT  
**Layer**: INFRA  
**Module**: OASIS / AUTOPILOT  
**Author**: Claude (specification), dstev (review)  
**Date**: 2026-04-02  

---

## 1. Goal

Build an autonomous self-healing pipeline that detects unhealthy services from the daily status check (currently `collect-status.py` → Google Chat), automatically creates VTID tasks with generated fix specifications, and injects them into the Command Hub in-progress pipeline for autonomous execution — so that broken services are repaired without human intervention.

**Vision**: The system moves from "alert a human" to "diagnose, prescribe, and execute a fix" — turning the health status report from a notification into a trigger for autonomous repair.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      SELF-HEALING PIPELINE                              │
│                                                                          │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────────────────────┐  │
│  │  DETECT  │───▶│ ALLOCATE VTID │───▶│  DEEP DIAGNOSE               │  │
│  │          │    │               │    │                              │  │
│  │ Health   │    │ Register in   │    │  Layer 1: HTTP response     │  │
│  │ Monitor  │    │ OASIS ledger  │    │  Layer 2: Codebase deep dive│  │
│  │ (54 eps) │    │ (VTID-0542)   │    │  Layer 3: Git history       │  │
│  └──────────┘    └───────────────┘    │  Layer 4: Dependencies      │  │
│                         │             │  Layer 5: Workflow/routing   │  │
│                         │             │  Layer 6: OASIS correlation  │  │
│                    Every fix gets     └──────────┬───────────────────┘  │
│                    a unique VTID                 │                       │
│                    BEFORE analysis               ▼                       │
│                                          ┌─────────────┐                │
│                                          │  PRESCRIBE  │                │
│                                          │             │                │
│                                          │ AI spec gen │                │
│                                          │ with FULL   │                │
│                                          │ code context│                │
│                                          │ + quality   │                │
│                                          │   gate      │                │
│                                          └──────┬──────┘                │
│                                                 │                       │
│                                                 ▼                       │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────┐                   │
│  │  VERIFY  │◀───│  EXECUTE     │◀───│  INJECT     │                   │
│  │          │    │              │    │             │                   │
│  │ Re-check │    │ Planner →    │    │ Update VTID │                   │
│  │ health   │    │ Worker →     │    │ + emit      │                   │
│  │ endpoint │    │ Validator →  │    │ spec.created│                   │
│  │ post-fix │    │ Deploy       │    │ → autopilot │                   │
│  └──────────┘    └──────────────┘    └─────────────┘                   │
│       │                                                                 │
│       ▼                                                                 │
│  ┌──────────┐                                                           │
│  │ REPORT   │  Full OASIS trail on the VTID, Google Chat notifications  │
│  └──────────┘                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Non-Negotiable Governance Rules Touched

| Rule | Impact |
|------|--------|
| VTID Allocation (VTID-0542) | Auto-created VTIDs must use the global allocator — no special sequence |
| Spec Approval Gate (VTID-01188) | Self-healing specs bypass human approval ONLY for pre-approved fix patterns (Level 1). Novel fixes require human approval |
| Validator Hard Gate (VTID-0535) | All fixes must pass deterministic validation before deploy |
| Deploy Governance (VTID-0416) | All deploys go through EXEC-DEPLOY.yml — no shortcuts |
| OASIS Authority (VTID-01005) | All state transitions recorded as OASIS events |

---

## 4. Scope

### IN_SCOPE

- **Detection**: Enhance `collect-status.py` to emit structured failure events to the Gateway API (not just Google Chat)
- **Diagnosis Engine**: New service that classifies failures and determines root cause from health endpoint responses, recent OASIS events, and deployment history
- **Fix Catalog**: Pre-approved fix patterns for common failure modes (route not registered, missing env var, service crash loop, dependency timeout)
- **Auto-Spec Generator**: Generate fix specifications from diagnosis results using the existing spec template
- **Pipeline Injection**: Create VTIDs and inject them into the autopilot pipeline with `priority: critical` and `source: self-healing`
- **Verification Loop**: Post-fix health re-check to confirm the fix worked
- **Circuit Breaker**: Prevent infinite fix loops (max 2 auto-fix attempts per service per 24h)
- **OASIS Events**: Full event trail for every self-healing action
- **Escalation**: Auto-escalate to human when diagnosis is uncertain or fix fails

### OUT_OF_SCOPE

- Monitoring frequency changes (stays daily unless explicitly changed later)
- Fixing issues in external dependencies (Supabase, Vertex AI, etc.)
- Performance optimization (slow but healthy services)
- Feature development (only restoring existing functionality)
- Changes to the Lovable frontend project

---

## 5. Detailed Design

### 5.1 Phase 1: Detection — Enhanced Health Monitor

**Current state**: `collect-status.py` runs daily at 08:00 UTC, pings 54 endpoints, posts summary to Google Chat.

**Enhancement**: After collecting status, the script POSTs structured failure data to a new Gateway endpoint.

#### New endpoint: `POST /api/v1/self-healing/report`

```typescript
// Request body
interface HealthReport {
  timestamp: string;                    // ISO 8601
  total: number;                        // 54
  live: number;                         // 52
  services: ServiceStatus[];
}

interface ServiceStatus {
  name: string;                         // "Health Capacity"
  endpoint: string;                     // "/api/v1/capacity/health"
  status: 'live' | 'down' | 'timeout'; 
  http_status?: number;                 // 404, 500, null for timeout
  response_body?: string;              // First 500 chars of response
  response_time_ms?: number;
  error_message?: string;              // Connection error details
}
```

**Changes to `collect-status.py`**:
```python
# After collecting all statuses, POST failures to Gateway
if down_services:
    report = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "total": total,
        "live": live_count,
        "services": [
            {
                "name": svc["name"],
                "endpoint": svc["endpoint"],
                "status": svc["result"],
                "http_status": svc.get("http_status"),
                "response_body": svc.get("body", "")[:500],
                "response_time_ms": svc.get("elapsed_ms"),
                "error_message": svc.get("error")
            }
            for svc in all_services
        ]
    }
    requests.post(
        f"{GATEWAY_URL}/api/v1/self-healing/report",
        json=report,
        headers={"Authorization": f"Bearer {SERVICE_TOKEN}"},
        timeout=30
    )
```

**Optional future enhancement**: Increase monitoring frequency to every 15 minutes using a GitHub Actions cron schedule or a Cloud Scheduler job. The pipeline handles idempotency via dedup (see §5.5).

---

### 5.2 Phase 2: Deep Diagnosis Engine

**New file**: `services/gateway/src/services/self-healing-diagnosis-service.ts`

The diagnosis engine performs a **multi-layer investigation** before producing a diagnosis. This is not a simple HTTP-status classifier — it behaves like a senior engineer triaging an outage: read the code, check git history, trace dependencies, correlate events, and only then determine root cause.

#### 5.2.1 VTID Registration (First Action)

**Every diagnosis attempt gets its own VTID immediately** — before any analysis begins. This ensures full traceability even if the diagnosis itself fails or is inconclusive.

```typescript
async function beginDiagnosis(failure: ServiceStatus): Promise<{ vtid: string; diagnosis: Diagnosis }> {
  // ── Step 0: Allocate a unique VTID via the global allocator (VTID-0542) ──
  // This VTID is the permanent identity of this self-healing attempt.
  // It is registered in OASIS before any analysis starts.
  const { vtid } = await allocateVtid();  // calls /rest/v1/rpc/allocate_global_vtid

  // Register shell entry in vtid_ledger
  await supabase.from('vtid_ledger').update({
    title: `SELF-HEAL: Investigating ${failure.name}`,
    status: 'allocated',
    layer: 'INFRA',
    module: mapServiceToModule(failure.name),
    metadata: {
      source: 'self-healing',
      phase: 'diagnosis',
      endpoint: failure.endpoint,
      http_status: failure.http_status,
      triggered_at: new Date().toISOString()
    }
  }).eq('vtid', vtid);

  // Emit OASIS event: diagnosis started
  await emitOasisEvent({
    type: 'self-healing.diagnosis.started',
    vtid,
    payload: {
      service: failure.name,
      endpoint: failure.endpoint,
      http_status: failure.http_status,
      status: failure.status
    }
  });

  // ── Now run the full diagnosis pipeline ──
  const diagnosis = await runDeepDiagnosis(failure, vtid);

  // Update the VTID with diagnosis results
  await supabase.from('vtid_ledger').update({
    title: `SELF-HEAL: ${failure.name} — ${diagnosis.failure_class}`,
    description: diagnosis.root_cause,
    metadata: {
      source: 'self-healing',
      phase: 'diagnosed',
      endpoint: failure.endpoint,
      failure_class: diagnosis.failure_class,
      confidence: diagnosis.confidence,
      auto_fixable: diagnosis.auto_fixable,
      evidence_count: diagnosis.evidence.length,
      files_analyzed: diagnosis.codebase_analysis?.files_read?.length || 0
    }
  }).eq('vtid', vtid);

  // Emit OASIS event: diagnosis completed
  await emitOasisEvent({
    type: 'self-healing.diagnosis.completed',
    vtid,
    payload: {
      failure_class: diagnosis.failure_class,
      confidence: diagnosis.confidence,
      auto_fixable: diagnosis.auto_fixable,
      root_cause: diagnosis.root_cause
    }
  });

  return { vtid, diagnosis };
}
```

#### 5.2.2 Failure Classification Taxonomy

```typescript
enum FailureClass {
  // Level 1: Auto-fixable with high confidence
  ROUTE_NOT_REGISTERED = 'route_not_registered',       // 404 — route missing from Express router
  HANDLER_CRASH = 'handler_crash',                       // 500 — uncaught error in handler
  MISSING_ENV_VAR = 'missing_env_var',                   // 500 — undefined config value
  IMPORT_ERROR = 'import_error',                         // 500 — broken import/require
  DEPENDENCY_TIMEOUT = 'dependency_timeout',             // timeout on external call
  STALE_DEPLOYMENT = 'stale_deployment',                 // code fixed in repo but not deployed
  REGRESSION = 'regression',                             // recent commit broke it

  // Level 2: Auto-fixable with medium confidence (requires human approval)
  DATABASE_SCHEMA_DRIFT = 'database_schema_drift',       // missing table/column
  INTEGRATION_FAILURE = 'integration_failure',           // third-party API changed
  RESOURCE_EXHAUSTION = 'resource_exhaustion',           // memory/CPU limits
  MIDDLEWARE_REJECTION = 'middleware_rejection',          // auth/CORS/rate-limit blocking

  // Level 3: Human required
  UNKNOWN = 'unknown',
  EXTERNAL_DEPENDENCY = 'external_dependency',           // Supabase/GCP/Vertex outage
  DATA_CORRUPTION = 'data_corruption',                   // inconsistent state
}
```

#### 5.2.3 The Deep Diagnosis Pipeline (6 Layers)

```typescript
async function runDeepDiagnosis(failure: ServiceStatus, vtid: string): Promise<Diagnosis> {
  const diagnosis: Diagnosis = {
    service_name: failure.name,
    endpoint: failure.endpoint,
    vtid, // ← every diagnosis is permanently linked to its VTID
    failure_class: FailureClass.UNKNOWN,
    confidence: 0,
    root_cause: '',
    suggested_fix: '',
    auto_fixable: false,
    evidence: [],
    codebase_analysis: null,
    git_analysis: null,
    dependency_analysis: null,
    workflow_analysis: null
  };

  // ════════════════════════════════════════════════════════════════════
  // LAYER 1: HTTP Response Analysis
  // What did the endpoint actually return? Parse status, headers, body.
  // ════════════════════════════════════════════════════════════════════

  const httpAnalysis = analyzeHttpResponse(failure);
  diagnosis.evidence.push(...httpAnalysis.evidence);
  diagnosis.failure_class = httpAnalysis.initial_class;
  diagnosis.confidence = httpAnalysis.initial_confidence;

  // ════════════════════════════════════════════════════════════════════
  // LAYER 2: Codebase Deep Dive
  // Read the actual source files. Understand how the route is wired,
  // what the handler does, what it imports, what can fail.
  // ════════════════════════════════════════════════════════════════════

  const codeAnalysis = await analyzeCodebase(failure.endpoint);
  diagnosis.codebase_analysis = codeAnalysis;
  diagnosis.evidence.push(...codeAnalysis.evidence);

  // Did we find the route file? Does it have a health handler?
  if (!codeAnalysis.route_file_exists) {
    diagnosis.failure_class = FailureClass.ROUTE_NOT_REGISTERED;
    diagnosis.confidence = 0.95;
    diagnosis.root_cause = `Route file for ${failure.endpoint} does not exist — the service was never implemented or the file was deleted`;
    diagnosis.suggested_fix = 'Create route file with health endpoint and register it in index.ts';
  } else if (!codeAnalysis.health_handler_exists) {
    diagnosis.failure_class = FailureClass.ROUTE_NOT_REGISTERED;
    diagnosis.confidence = 0.9;
    diagnosis.root_cause = `Route file ${codeAnalysis.route_file} exists but has no /health handler`;
    diagnosis.suggested_fix = 'Add GET /health handler to existing route file';
  } else if (codeAnalysis.handler_has_errors) {
    diagnosis.failure_class = FailureClass.HANDLER_CRASH;
    diagnosis.confidence = 0.8;
    diagnosis.root_cause = `Health handler in ${codeAnalysis.route_file} has code that throws: ${codeAnalysis.error_description}`;
  }

  // ════════════════════════════════════════════════════════════════════
  // LAYER 3: Git History Analysis
  // When did this endpoint last work? What changed since then?
  // Was there a recent commit that could have broken it?
  // ════════════════════════════════════════════════════════════════════

  const gitAnalysis = await analyzeGitHistory(codeAnalysis.route_file, failure.endpoint);
  diagnosis.git_analysis = gitAnalysis;
  diagnosis.evidence.push(...gitAnalysis.evidence);

  if (gitAnalysis.breaking_commit) {
    diagnosis.failure_class = FailureClass.REGRESSION;
    diagnosis.confidence = Math.max(diagnosis.confidence, 0.85);
    diagnosis.root_cause = `Broken by commit ${gitAnalysis.breaking_commit.sha.slice(0, 8)} ` +
      `("${gitAnalysis.breaking_commit.message}") on ${gitAnalysis.breaking_commit.date} — ` +
      `${gitAnalysis.breaking_commit.diff_summary}`;
    diagnosis.suggested_fix = `Revert or fix the changes from commit ${gitAnalysis.breaking_commit.sha.slice(0, 8)}`;
  }

  if (gitAnalysis.code_exists_but_not_deployed) {
    diagnosis.failure_class = FailureClass.STALE_DEPLOYMENT;
    diagnosis.confidence = Math.max(diagnosis.confidence, 0.9);
    diagnosis.root_cause = `Fix exists in repo (commit ${gitAnalysis.latest_commit.slice(0, 8)}) but Cloud Run is running an older version`;
    diagnosis.suggested_fix = 'Redeploy gateway via EXEC-DEPLOY.yml — no code changes needed';
  }

  // ════════════════════════════════════════════════════════════════════
  // LAYER 4: Dependency & Import Chain Analysis
  // Does the route file import something that's broken?
  // Does it depend on an env var, a Supabase table, or a service
  // that doesn't exist?
  // ════════════════════════════════════════════════════════════════════

  const depAnalysis = await analyzeDependencies(codeAnalysis);
  diagnosis.dependency_analysis = depAnalysis;
  diagnosis.evidence.push(...depAnalysis.evidence);

  if (depAnalysis.missing_import) {
    diagnosis.failure_class = FailureClass.IMPORT_ERROR;
    diagnosis.confidence = Math.max(diagnosis.confidence, 0.85);
    diagnosis.root_cause = `Route imports ${depAnalysis.missing_import} which does not exist`;
  }
  if (depAnalysis.missing_env_vars.length > 0) {
    diagnosis.failure_class = FailureClass.MISSING_ENV_VAR;
    diagnosis.confidence = Math.max(diagnosis.confidence, 0.8);
    diagnosis.root_cause = `Handler uses env vars that may be unset: ${depAnalysis.missing_env_vars.join(', ')}`;
  }
  if (depAnalysis.missing_db_table) {
    diagnosis.failure_class = FailureClass.DATABASE_SCHEMA_DRIFT;
    diagnosis.confidence = Math.max(diagnosis.confidence, 0.7);
    diagnosis.auto_fixable = false; // needs human for schema changes
  }

  // ════════════════════════════════════════════════════════════════════
  // LAYER 5: Workflow & Registration Analysis
  // Is the route mounted in index.ts? Is middleware blocking it?
  // Is there a CORS, auth, or rate-limit issue?
  // ════════════════════════════════════════════════════════════════════

  const workflowAnalysis = await analyzeWorkflow(failure.endpoint, codeAnalysis);
  diagnosis.workflow_analysis = workflowAnalysis;
  diagnosis.evidence.push(...workflowAnalysis.evidence);

  if (!workflowAnalysis.route_mounted_in_index) {
    diagnosis.failure_class = FailureClass.ROUTE_NOT_REGISTERED;
    diagnosis.confidence = Math.max(diagnosis.confidence, 0.95);
    diagnosis.root_cause = `Route file exists at ${codeAnalysis.route_file} but is not mounted in index.ts — app.use() call missing`;
    diagnosis.suggested_fix = `Add app.use('${failure.endpoint.replace('/health', '')}', ${codeAnalysis.router_export_name}) to index.ts`;
  }
  if (workflowAnalysis.middleware_blocking) {
    diagnosis.failure_class = FailureClass.MIDDLEWARE_REJECTION;
    diagnosis.confidence = Math.max(diagnosis.confidence, 0.75);
    diagnosis.root_cause = `Middleware ${workflowAnalysis.blocking_middleware} rejects requests to ${failure.endpoint}`;
  }

  // ════════════════════════════════════════════════════════════════════
  // LAYER 6: OASIS Event Correlation & Prior Fix History
  // Check recent events, prior self-healing attempts, and deployment
  // history for temporal patterns.
  // ════════════════════════════════════════════════════════════════════

  const oasisAnalysis = await analyzeOasisHistory(failure, vtid);
  diagnosis.evidence.push(...oasisAnalysis.evidence);

  if (oasisAnalysis.prior_fix_attempts >= 2) {
    diagnosis.auto_fixable = false;
    diagnosis.evidence.push(`Circuit breaker: ${oasisAnalysis.prior_fix_attempts} prior fix attempts in 48h`);
  }
  if (oasisAnalysis.correlated_failures.length > 0) {
    diagnosis.evidence.push(`Correlated failures: ${oasisAnalysis.correlated_failures.join(', ')} — possible shared root cause`);
  }

  // ════════════════════════════════════════════════════════════════════
  // FINAL: If confidence is still low, invoke AI-assisted deep analysis
  // Feed ALL gathered evidence to Gemini for a synthesis diagnosis.
  // ════════════════════════════════════════════════════════════════════

  if (diagnosis.confidence < 0.6) {
    const aiDiagnosis = await runAIDiagnosis(failure, diagnosis, codeAnalysis, gitAnalysis);
    diagnosis.root_cause = aiDiagnosis.root_cause || diagnosis.root_cause;
    diagnosis.suggested_fix = aiDiagnosis.suggested_fix || diagnosis.suggested_fix;
    diagnosis.confidence = Math.max(diagnosis.confidence, Math.min(aiDiagnosis.confidence, 0.75));
    diagnosis.evidence.push(`AI analysis: ${aiDiagnosis.summary}`);
  }

  // Set auto_fixable based on final confidence + class
  if (diagnosis.confidence >= 0.8 && !diagnosis.auto_fixable) {
    diagnosis.auto_fixable = [
      FailureClass.ROUTE_NOT_REGISTERED,
      FailureClass.HANDLER_CRASH,
      FailureClass.MISSING_ENV_VAR,
      FailureClass.IMPORT_ERROR,
      FailureClass.STALE_DEPLOYMENT,
      FailureClass.REGRESSION
    ].includes(diagnosis.failure_class);
  }

  return diagnosis;
}
```

#### 5.2.4 Layer 2 Detail: Codebase Deep Dive

This is the critical layer that reads actual source code to understand what's broken.

```typescript
interface CodebaseAnalysis {
  route_file: string | null;           // e.g. 'services/gateway/src/routes/capacity.ts'
  route_file_exists: boolean;
  route_file_content: string | null;   // full file content for AI analysis
  health_handler_exists: boolean;      // does the file have router.get('/health', ...)
  handler_has_errors: boolean;         // does the handler reference undefined vars, broken imports
  error_description: string | null;
  imports: string[];                   // all imports in the file
  env_vars_used: string[];             // all process.env.* references
  supabase_tables_used: string[];      // all table references in Supabase calls
  related_service_files: string[];     // imported service files
  files_read: string[];               // all files we actually read (audit trail)
  evidence: string[];
}

async function analyzeCodebase(endpoint: string): Promise<CodebaseAnalysis> {
  const analysis: CodebaseAnalysis = { /* ... init ... */ };

  // Step 1: Resolve endpoint → route file
  // Use the endpoint-to-file map AND scan index.ts for app.use() registrations
  const routeFile = resolveRouteFile(endpoint);
  analysis.route_file = routeFile;

  if (!routeFile) {
    // Try to find it by scanning index.ts for the mount path
    const indexContent = await readFile('services/gateway/src/index.ts');
    analysis.files_read.push('services/gateway/src/index.ts');
    const mountPath = endpoint.replace('/health', '');
    const mountLine = indexContent?.match(new RegExp(`app\\.use\\(['"]${escapeRegex(mountPath)}['"].*?([\\w-]+)`));
    if (mountLine) {
      analysis.evidence.push(`Found mount in index.ts: ${mountLine[0]}`);
      // Trace the import to find the actual file
    } else {
      analysis.evidence.push(`No mount found in index.ts for path ${mountPath}`);
      analysis.route_file_exists = false;
      return analysis;
    }
  }

  // Step 2: Read the route file
  const content = await readFile(routeFile);
  analysis.files_read.push(routeFile);

  if (!content) {
    analysis.route_file_exists = false;
    analysis.evidence.push(`Route file ${routeFile} does not exist on disk`);
    return analysis;
  }

  analysis.route_file_exists = true;
  analysis.route_file_content = content;

  // Step 3: Check for health handler
  const healthPattern = /router\.(get|all)\s*\(\s*['"]\/health['"]/;
  analysis.health_handler_exists = healthPattern.test(content);
  if (!analysis.health_handler_exists) {
    analysis.evidence.push(`File ${routeFile} has no /health handler`);
  }

  // Step 4: Extract all imports
  const importMatches = content.matchAll(/import\s+.*?from\s+['"](.*?)['"]/g);
  for (const match of importMatches) {
    analysis.imports.push(match[1]);
  }

  // Step 5: Check if imported files exist (detect broken imports)
  for (const imp of analysis.imports) {
    if (imp.startsWith('.')) {
      const resolvedPath = resolveImportPath(routeFile, imp);
      const exists = await fileExists(resolvedPath);
      if (!exists) {
        analysis.handler_has_errors = true;
        analysis.error_description = `Broken import: ${imp} resolves to ${resolvedPath} which does not exist`;
        analysis.evidence.push(`BROKEN IMPORT: ${imp} → ${resolvedPath}`);
      } else {
        analysis.related_service_files.push(resolvedPath);
      }
    }
  }

  // Step 6: Extract env var references
  const envMatches = content.matchAll(/process\.env\.(\w+)/g);
  for (const match of envMatches) {
    analysis.env_vars_used.push(match[1]);
  }

  // Step 7: Extract Supabase table references
  const tableMatches = content.matchAll(/\.from\s*\(\s*['"](\w+)['"]\s*\)/g);
  for (const match of tableMatches) {
    analysis.supabase_tables_used.push(match[1]);
  }

  // Step 8: If health handler exists, read the handler body for potential crash points
  if (analysis.health_handler_exists) {
    // Extract the handler function body
    const handlerMatch = content.match(/router\.get\s*\(\s*['"]\/health['"][\s\S]*?\}\s*\)/);
    if (handlerMatch) {
      const handlerBody = handlerMatch[0];
      // Check for common crash patterns
      if (handlerBody.includes('await') && !handlerBody.includes('try')) {
        analysis.evidence.push('Health handler has unguarded await — can throw on service errors');
      }
      if (handlerBody.match(/\.\w+\.\w+/) && handlerBody.includes('undefined')) {
        analysis.evidence.push('Health handler accesses nested properties that could be undefined');
      }
    }
  }

  // Step 9: Read key imported service files (1 level deep) to understand dependencies
  for (const svcFile of analysis.related_service_files.slice(0, 5)) {
    const svcContent = await readFile(svcFile);
    analysis.files_read.push(svcFile);
    if (svcContent) {
      // Check for env vars in service files too
      const svcEnvs = svcContent.matchAll(/process\.env\.(\w+)/g);
      for (const m of svcEnvs) analysis.env_vars_used.push(m[1]);
    }
  }

  analysis.env_vars_used = [...new Set(analysis.env_vars_used)]; // deduplicate
  return analysis;
}
```

#### 5.2.5 Layer 3 Detail: Git History Analysis

```typescript
interface GitAnalysis {
  latest_commit: string;               // HEAD sha for the route file
  last_modified: string;               // when the route file was last changed
  recent_commits: CommitInfo[];        // last 10 commits touching this file
  breaking_commit: CommitInfo | null;  // the commit that likely broke it
  code_exists_but_not_deployed: boolean;
  deployed_sha: string | null;         // what's actually running on Cloud Run
  evidence: string[];
}

async function analyzeGitHistory(routeFile: string | null, endpoint: string): Promise<GitAnalysis> {
  const analysis: GitAnalysis = { /* ... init ... */ };

  if (!routeFile) return analysis;

  // Step 1: Get recent commits for this file
  // git log --oneline -10 -- <file>
  analysis.recent_commits = await getGitLog(routeFile, 10);

  // Step 2: Get the currently deployed commit (from deployment records or Cloud Run metadata)
  const lastDeploy = await getLastDeployment('gateway');
  if (lastDeploy) {
    analysis.deployed_sha = lastDeploy.git_commit;
    analysis.evidence.push(`Last deploy: ${lastDeploy.git_commit?.slice(0, 8)} on ${lastDeploy.deployed_at}`);

    // Step 3: Compare deployed SHA with latest commit on this file
    // If the file was changed AFTER the last deploy, the fix might already exist
    const fileChangedAfterDeploy = analysis.recent_commits.some(
      c => new Date(c.date) > new Date(lastDeploy.deployed_at)
    );
    if (fileChangedAfterDeploy) {
      analysis.code_exists_but_not_deployed = true;
      analysis.evidence.push(`File ${routeFile} was modified after last deploy — redeployment may fix the issue`);
    }
  }

  // Step 4: Look for a "breaking commit"
  // Check: was the endpoint healthy before? When did it start failing?
  // Cross-reference with the daily status history (docs/STATUS.md or self_healing_log)
  const lastHealthy = await getLastHealthyDate(endpoint);
  if (lastHealthy) {
    // Find commits between last healthy date and now
    const commitsSinceHealthy = analysis.recent_commits.filter(
      c => new Date(c.date) > new Date(lastHealthy)
    );
    if (commitsSinceHealthy.length > 0) {
      // The most recent commit that changed the route file is the likely culprit
      analysis.breaking_commit = commitsSinceHealthy[0];
      analysis.evidence.push(
        `Endpoint was healthy on ${lastHealthy}. ` +
        `${commitsSinceHealthy.length} commits since then. ` +
        `Most likely: ${commitsSinceHealthy[0].sha.slice(0, 8)} "${commitsSinceHealthy[0].message}"`
      );
    }
  }

  // Step 5: Get the diff of the breaking commit to understand what changed
  if (analysis.breaking_commit) {
    const diff = await getGitDiff(analysis.breaking_commit.sha, routeFile);
    analysis.breaking_commit.diff_summary = summarizeDiff(diff);
    analysis.evidence.push(`Breaking commit diff: ${analysis.breaking_commit.diff_summary}`);
  }

  return analysis;
}
```

#### 5.2.6 Layer 5 Detail: Workflow & Registration Analysis

```typescript
interface WorkflowAnalysis {
  route_mounted_in_index: boolean;     // is there an app.use() for this route?
  mount_path: string | null;           // the path prefix used in app.use()
  middleware_chain: string[];          // middleware applied to this route
  middleware_blocking: boolean;        // is any middleware rejecting requests?
  blocking_middleware: string | null;
  auth_required: boolean;             // does the route require auth?
  health_exempt_from_auth: boolean;   // is /health excluded from auth middleware?
  evidence: string[];
}

async function analyzeWorkflow(endpoint: string, codeAnalysis: CodebaseAnalysis): Promise<WorkflowAnalysis> {
  const analysis: WorkflowAnalysis = { /* ... init ... */ };

  // Read index.ts to check route registration
  const indexContent = await readFile('services/gateway/src/index.ts');
  const basePath = endpoint.replace(/\/health$/, '');

  // Check for app.use(basePath, router)
  const mountPattern = new RegExp(`app\\.use\\s*\\(\\s*['"]${escapeRegex(basePath)}['"]`);
  analysis.route_mounted_in_index = mountPattern.test(indexContent || '');

  if (analysis.route_mounted_in_index) {
    // Extract the full mount line to see middleware
    const mountLine = indexContent?.match(new RegExp(`app\\.use\\s*\\(\\s*['"]${escapeRegex(basePath)}['"][^)]*\\)`))?.[0];
    analysis.evidence.push(`Mount found: ${mountLine}`);

    // Check if auth middleware is applied
    if (mountLine?.includes('auth') || mountLine?.includes('jwt')) {
      analysis.auth_required = true;
      // Check if /health is excluded from auth
      // Many routes do: router.get('/health', handler) BEFORE auth middleware
      if (codeAnalysis.route_file_content) {
        const healthBeforeAuth = /router\.get\s*\(\s*['"]\/health['"][\s\S]*?auth/;
        analysis.health_exempt_from_auth = !healthBeforeAuth.test(codeAnalysis.route_file_content);
      }
    }
  } else {
    analysis.evidence.push(`NO mount found in index.ts for path ${basePath} — this is likely the root cause of 404`);
  }

  return analysis;
}
```

#### 5.2.7 Diagnosis Output (Enhanced)

```typescript
interface Diagnosis {
  service_name: string;
  endpoint: string;
  vtid: string;                        // ← unique VTID for this diagnosis
  failure_class: FailureClass;
  confidence: number;                  // 0.0 - 1.0
  root_cause: string;                  // detailed human-readable explanation
  suggested_fix: string;               // what specifically needs to change
  auto_fixable: boolean;               // can autopilot handle this?
  evidence: string[];                  // all observations from all 6 layers
  codebase_analysis: CodebaseAnalysis | null;  // Layer 2 results
  git_analysis: GitAnalysis | null;            // Layer 3 results
  dependency_analysis: DependencyAnalysis | null; // Layer 4 results
  workflow_analysis: WorkflowAnalysis | null;     // Layer 5 results
  related_vtids?: string[];            // previous VTIDs for this service
  files_to_modify: string[];           // exact files that need changes
  files_read: string[];                // all files read during diagnosis (audit trail)
}
```

---

### 5.3 Phase 3: Deep-Dive Spec Generation (Prescribe)

**New file**: `services/gateway/src/services/self-healing-spec-service.ts`

The spec generation is NOT a template fill-in. It uses the full diagnosis (code analysis, git history, dependency tree, workflow analysis) to produce a spec that a worker agent can execute with precision. It follows the same VTID-01188 spec template and quality standards as human-authored specs.

#### 5.3.1 Spec Generation Pipeline

```typescript
async function generateFixSpec(diagnosis: Diagnosis): Promise<string> {
  // ── Step 1: Gather ALL context from the diagnosis layers ──
  const context = assembleSpecContext(diagnosis);

  // ── Step 2: Generate spec via the SAME Gemini pipeline used for normal specs ──
  // This ensures self-healing specs meet the same quality bar.
  // We pass the full diagnosis evidence, code analysis, git history, etc.
  const spec = await generateSpecWithAI(diagnosis, context);

  // ── Step 3: Validate the generated spec against required sections (VTID-01188) ──
  const validation = validateSpecSections(spec);
  if (!validation.valid) {
    throw new Error(`Generated spec missing sections: ${validation.missing.join(', ')}`);
  }

  // ── Step 4: Run spec quality check (same as human specs) ──
  const qualityReport = await runFullQualityCheck(diagnosis.vtid, spec);
  if (qualityReport.score < 0.7) {
    // Regenerate with quality feedback
    const improvedSpec = await regenerateWithFeedback(diagnosis, context, spec, qualityReport);
    return improvedSpec;
  }

  return spec;
}
```

#### 5.3.2 Context Assembly for AI Spec Generator

The AI doesn't get a superficial summary — it gets the raw evidence from every layer of diagnosis.

```typescript
function assembleSpecContext(diagnosis: Diagnosis): string {
  const sections: string[] = [];

  // ── FAILURE SUMMARY ──
  sections.push(`## Failure Summary
- Service: ${diagnosis.service_name}
- Endpoint: ${diagnosis.endpoint}
- VTID: ${diagnosis.vtid}
- HTTP Status: ${diagnosis.codebase_analysis ? 'See analysis' : 'Unknown'}
- Failure Class: ${diagnosis.failure_class}
- Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%
- Root Cause: ${diagnosis.root_cause}
- Suggested Fix: ${diagnosis.suggested_fix}`);

  // ── CODEBASE ANALYSIS (Layer 2) ──
  if (diagnosis.codebase_analysis) {
    const ca = diagnosis.codebase_analysis;
    sections.push(`## Codebase Analysis
- Route file: ${ca.route_file || 'NOT FOUND'}
- Route file exists: ${ca.route_file_exists}
- Health handler exists: ${ca.health_handler_exists}
- Handler has errors: ${ca.handler_has_errors}${ca.error_description ? ` — ${ca.error_description}` : ''}
- Imports: ${ca.imports.join(', ') || 'none'}
- Environment variables used: ${ca.env_vars_used.join(', ') || 'none'}
- Supabase tables used: ${ca.supabase_tables_used.join(', ') || 'none'}
- Related service files: ${ca.related_service_files.join(', ') || 'none'}
- Files read during analysis: ${ca.files_read.join(', ')}`);

    // Include the ACTUAL source code so the AI can write precise fixes
    if (ca.route_file_content) {
      sections.push(`## Current Source Code (${ca.route_file})
\`\`\`typescript
${ca.route_file_content}
\`\`\``);
    }
  }

  // ── GIT HISTORY (Layer 3) ──
  if (diagnosis.git_analysis) {
    const ga = diagnosis.git_analysis;
    sections.push(`## Git History
- Latest commit on file: ${ga.latest_commit}
- Last modified: ${ga.last_modified}
- Deployed SHA: ${ga.deployed_sha || 'unknown'}
- Code exists but not deployed: ${ga.code_exists_but_not_deployed}
${ga.breaking_commit ? `- **Breaking commit**: ${ga.breaking_commit.sha.slice(0, 8)} "${ga.breaking_commit.message}" (${ga.breaking_commit.date})
- Breaking diff: ${ga.breaking_commit.diff_summary}` : '- No breaking commit identified'}
- Recent commits:
${ga.recent_commits.map(c => `  - ${c.sha.slice(0, 8)} ${c.message} (${c.date})`).join('\n')}`);
  }

  // ── DEPENDENCY ANALYSIS (Layer 4) ──
  if (diagnosis.dependency_analysis) {
    const da = diagnosis.dependency_analysis;
    sections.push(`## Dependency Analysis
- Missing imports: ${da.missing_import || 'none'}
- Missing env vars: ${da.missing_env_vars.join(', ') || 'none (all appear set)'}
- Missing DB tables: ${da.missing_db_table || 'none'}`);
  }

  // ── WORKFLOW ANALYSIS (Layer 5) ──
  if (diagnosis.workflow_analysis) {
    const wa = diagnosis.workflow_analysis;
    sections.push(`## Workflow & Registration Analysis
- Route mounted in index.ts: ${wa.route_mounted_in_index}
- Mount path: ${wa.mount_path || 'N/A'}
- Auth required: ${wa.auth_required}
- Health exempt from auth: ${wa.health_exempt_from_auth}
- Middleware blocking: ${wa.middleware_blocking}${wa.blocking_middleware ? ` (${wa.blocking_middleware})` : ''}`);
  }

  // ── ALL EVIDENCE ──
  sections.push(`## Collected Evidence (${diagnosis.evidence.length} items)
${diagnosis.evidence.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);

  // ── FILES TO MODIFY ──
  sections.push(`## Files Identified for Modification
${diagnosis.files_to_modify.map(f => `- ${f}`).join('\n') || '- To be determined by analysis'}`);

  return sections.join('\n\n');
}
```

#### 5.3.3 AI Spec Generator Prompt

```typescript
const SELF_HEALING_SPEC_SYSTEM_PROMPT = `You are a senior Vitana platform engineer writing a fix specification.

You are given a COMPLETE diagnosis of a failing health endpoint, including:
- The actual source code of the failing route
- Git history showing what changed
- Dependency analysis showing broken imports or missing env vars
- Workflow analysis showing route registration status

Your job: Write a PRECISE, ACTIONABLE specification that a worker agent can execute
to fix this specific failure. This is NOT a template — you must reference the actual
code, the actual files, and the actual changes needed.

RULES:
1. Reference exact file paths, line numbers, and function names from the code analysis
2. If a breaking commit was identified, reference the specific changes that need to be reverted or fixed
3. If the route file doesn't exist, specify exactly what code to write (using existing route files as examples)
4. If the route isn't mounted, specify the exact app.use() line to add to index.ts
5. Every acceptance criterion must be verifiable with a curl command or code assertion
6. The spec must include regression checks — verify that fixing this doesn't break adjacent endpoints
7. Use the standard Vitana spec template (9 sections)
8. This is a RESTORATION fix — no new features, no scope creep, just get the endpoint healthy again

${/* Include the standard SPEC_GEN_SYSTEM_PROMPT architecture knowledge here */}
`;
```

#### 5.3.4 Spec Quality Gate

Every self-healing spec goes through the SAME quality validation as human-authored specs:

```typescript
async function validateAndFinalizeSpec(vtid: string, spec: string): Promise<void> {
  // 1. Section validation (VTID-01188 required sections)
  const sectionCheck = validateSpecSections(spec);
  if (!sectionCheck.valid) {
    throw new Error(`Spec ${vtid} missing required sections: ${sectionCheck.missing.join(', ')}`);
  }

  // 2. Full quality check via spec-quality-agent.ts
  const qualityReport = await runFullQualityCheck(vtid, spec);

  // 3. Compute SHA-256 hash for integrity (immutable snapshot)
  const specHash = computeHash(spec);

  // 4. Store spec in oasis_specs table
  await supabase.from('oasis_specs').upsert({
    vtid,
    version: 1,
    spec_markdown: spec,
    spec_hash: specHash,
    status: 'validated',
    source: 'self-healing',
    quality_score: qualityReport.score,
    created_at: new Date().toISOString()
  });

  // 5. Update vtid_ledger spec_status
  await supabase.from('vtid_ledger').update({
    spec_status: 'validated',
    metadata: {
      spec_hash: specHash,
      quality_score: qualityReport.score
    }
  }).eq('vtid', vtid);

  // 6. Emit OASIS event
  await emitOasisEvent({
    type: 'self-healing.spec.generated',
    vtid,
    payload: {
      spec_hash: specHash,
      quality_score: qualityReport.score,
      sections_present: sectionCheck.report.found_sections,
      source_code_included: spec.includes('```typescript')
    }
  });
}
```

#### 5.3.5 Endpoint-to-File Mapping (Auto-Discovery)

Rather than maintaining a static map, the system discovers routes dynamically:

```typescript
async function resolveRouteFile(endpoint: string): Promise<string | null> {
  // Strategy 1: Parse index.ts for app.use() registrations
  const indexContent = await readFile('services/gateway/src/index.ts');
  const basePath = endpoint.replace(/\/health$/, '');

  // Find: app.use('/api/v1/capacity', capacityRouter);
  const mountRegex = new RegExp(
    `app\\.use\\s*\\(\\s*['"]${escapeRegex(basePath)}['"]\\s*,\\s*(\\w+)`,
  );
  const mountMatch = indexContent?.match(mountRegex);

  if (mountMatch) {
    const routerVarName = mountMatch[1];
    // Find the import: import capacityRouter from './routes/capacity';
    const importRegex = new RegExp(
      `import\\s+${routerVarName}\\s+from\\s+['"]\\.\\/(routes\\/[\\w-]+)['"]`
    );
    const importMatch = indexContent?.match(importRegex);
    if (importMatch) {
      return `services/gateway/src/${importMatch[1]}.ts`;
    }
  }

  // Strategy 2: Derive from endpoint pattern
  // /api/v1/capacity/health → routes/capacity.ts
  const pathParts = basePath.split('/').filter(Boolean);
  const routeName = pathParts[pathParts.length - 1]; // 'capacity'
  const candidatePaths = [
    `services/gateway/src/routes/${routeName}.ts`,
    `services/gateway/src/routes/${routeName.replace(/-/g, '_')}.ts`,
    `services/gateway/src/routes/${routeName}-service.ts`,
  ];

  for (const candidate of candidatePaths) {
    if (await fileExists(candidate)) return candidate;
  }

  // Strategy 3: Glob scan for the endpoint string in route files
  const files = await globFiles('services/gateway/src/routes/*.ts');
  for (const file of files) {
    const content = await readFile(file);
    if (content?.includes(basePath) || content?.includes(`'${routeName}'`)) {
      return file;
    }
  }

  return null;
}
```

---

### 5.4 Phase 4: Pipeline Injection

**New file**: `services/gateway/src/services/self-healing-injector-service.ts`

The VTID was already allocated in Phase 2 (Diagnosis). This phase transitions the VTID from `diagnosed` to `pending` in the autopilot pipeline and attaches the validated spec.

```typescript
async function injectIntoAutopilotPipeline(
  vtid: string,             // ← VTID already exists from diagnosis phase
  diagnosis: Diagnosis,
  spec: string
): Promise<{ success: boolean }> {
  
  // Step 1: Update the existing VTID entry (allocated in Phase 2)
  // Transition: allocated → pending (ready for autopilot pickup)
  await supabase.from('vtid_ledger').update({
    title: `SELF-HEAL: ${diagnosis.service_name} — ${diagnosis.failure_class}`,
    description: diagnosis.root_cause,
    summary: spec.substring(0, 2000), // summary field for quick display
    layer: 'INFRA',
    module: mapServiceToModule(diagnosis.service_name),
    status: 'pending',
    spec_status: 'validated',
    assigned_to: 'autopilot',
    metadata: {
      source: 'self-healing',
      phase: 'injected',
      failure_class: diagnosis.failure_class,
      confidence: diagnosis.confidence,
      endpoint: diagnosis.endpoint,
      priority: 'critical',
      auto_approved: diagnosis.confidence >= 0.8,
      files_to_modify: diagnosis.files_to_modify,
      files_analyzed: diagnosis.files_read.length,
      evidence_count: diagnosis.evidence.length,
      max_attempts: 2,
      spec_hash: computeHash(spec)
    }
  }).eq('vtid', vtid);

  // Step 2: Emit injection event (linked to the SAME VTID)
  await emitOasisEvent({
    type: 'self-healing.task.injected',
    vtid,
    payload: {
      service: diagnosis.service_name,
      endpoint: diagnosis.endpoint,
      failure_class: diagnosis.failure_class,
      confidence: diagnosis.confidence,
      auto_approved: diagnosis.confidence >= 0.8,
      files_to_modify: diagnosis.files_to_modify
    }
  });

  // Step 3: Approval gate
  if (diagnosis.confidence >= 0.8) {
    // Level 1: Auto-approved — emit spec-created to trigger autopilot pickup
    await emitOasisEvent({
      type: 'autopilot.task.spec.created',
      vtid,
      payload: { auto_approved: true, source: 'self-healing' }
    });
  } else {
    // Level 2: Requires human approval — task appears in Command Hub approvals
    await supabase.from('vtid_ledger').update({
      spec_status: 'pending_approval'
    }).eq('vtid', vtid);

    await notifyForApproval(vtid, diagnosis, spec);
  }

  // Step 4: Notify Google Chat with full context
  await notifyGChat({
    text: `🔧 *Self-Healing Initiated*\n` +
          `Task: ${vtid}\n` +
          `Service: ${diagnosis.service_name}\n` +
          `Issue: ${diagnosis.failure_class}\n` +
          `Root cause: ${diagnosis.root_cause.substring(0, 200)}\n` +
          `Files: ${diagnosis.files_to_modify.join(', ')}\n` +
          `Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%\n` +
          `Evidence: ${diagnosis.evidence.length} items from 6-layer analysis\n` +
          `Auto-fix: ${diagnosis.confidence >= 0.8 ? '✅ Autopilot executing' : '⏳ Awaiting human approval'}`
  });

  return { success: true };
}
```

---

### 5.5 Phase 5: Deduplication & Circuit Breaker

Dedup and circuit-breaker checks run **before** VTID allocation. We don't waste a VTID if the task would be skipped.

```typescript
// Called BEFORE allocateVtid() — prevents wasting VTID numbers
async function shouldBeginDiagnosis(endpoint: string): Promise<{ proceed: boolean; reason?: string }> {
  // Check 1: Is there already an active self-healing VTID for this endpoint?
  // This catches VTIDs in ANY phase: diagnosis, spec generation, pipeline execution
  const { data: existing } = await supabase
    .from('vtid_ledger')
    .select('vtid, status, metadata')
    .eq('metadata->>source', 'self-healing')
    .eq('metadata->>endpoint', endpoint)
    .in('status', ['allocated', 'pending', 'scheduled', 'in_progress'])
    .limit(1);

  if (existing && existing.length > 0) {
    return {
      proceed: false,
      reason: `Active self-healing VTID ${existing[0].vtid} (status=${existing[0].status}) already exists for ${endpoint}`
    };
  }

  // Check 2: Circuit breaker — max 2 completed/failed attempts per endpoint per 24h
  const { count } = await supabase
    .from('vtid_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('metadata->>source', 'self-healing')
    .eq('metadata->>endpoint', endpoint)
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  if ((count ?? 0) >= 2) {
    await escalateToHuman(endpoint, `Circuit breaker: ${count} self-healing attempts in 24h — requires human investigation`);
    return {
      proceed: false,
      reason: `Circuit breaker triggered: ${count} attempts in 24h for ${endpoint}`
    };
  }

  return { proceed: true };
}

// Full orchestration flow per failing service:
async function processFailingService(failure: ServiceStatus): Promise<void> {
  // 1. Dedup + circuit breaker (BEFORE allocating VTID)
  const check = await shouldBeginDiagnosis(failure.endpoint);
  if (!check.proceed) {
    await emitOasisEvent({
      type: 'self-healing.task.skipped',
      vtid: 'SYSTEM',
      payload: { endpoint: failure.endpoint, reason: check.reason }
    });
    return;
  }

  // 2. Allocate VTID + run deep diagnosis (Phase 2)
  const { vtid, diagnosis } = await beginDiagnosis(failure);

  // 3. If not auto-fixable and not worth a spec, mark as escalated
  if (!diagnosis.auto_fixable && diagnosis.confidence < 0.5) {
    await escalateToHuman(failure.endpoint, diagnosis.root_cause);
    await supabase.from('vtid_ledger').update({
      status: 'failed',
      metadata: { ...diagnosis, phase: 'escalated' }
    }).eq('vtid', vtid);
    return;
  }

  // 4. Generate deep-dive spec (Phase 3)
  const spec = await generateFixSpec(diagnosis);
  await validateAndFinalizeSpec(vtid, spec);

  // 5. Inject into autopilot pipeline (Phase 4)
  await injectIntoAutopilotPipeline(vtid, diagnosis, spec);
}
```

---

### 5.6 Phase 6: Post-Fix Verification

After the autopilot pipeline deploys a self-healing fix, verify that the service is actually healthy.

**Addition to autopilot-event-loop.ts**:

```typescript
// When a self-healing VTID reaches deploy.success, trigger verification
async function verifySelfHealingFix(vtid: string, metadata: any): Promise<void> {
  const endpoint = metadata.endpoint;
  const gatewayUrl = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
  
  // Wait 30s for Cloud Run to stabilize after deploy
  await delay(30_000);

  // Re-check health endpoint
  try {
    const response = await fetch(`${gatewayUrl}${endpoint}`, { 
      signal: AbortSignal.timeout(8000) 
    });
    
    if (response.ok) {
      await emitOasisEvent({
        type: 'self-healing.verification.success',
        vtid,
        payload: { endpoint, http_status: response.status }
      });
      
      await notifyGChat({
        text: `✅ *Self-Healing Success*\n` +
              `Task: ${vtid}\n` +
              `Service restored: ${endpoint}\n` +
              `Status: HTTP ${response.status}`
      });
    } else {
      await emitOasisEvent({
        type: 'self-healing.verification.failed',
        vtid,
        payload: { endpoint, http_status: response.status }
      });

      // Check if we can retry
      const attempts = metadata.attempt || 1;
      if (attempts < metadata.max_attempts) {
        await createRetryTask(vtid, metadata, attempts + 1);
      } else {
        await escalateToHuman(endpoint, `Fix deployed but endpoint still returns ${response.status}`);
      }
    }
  } catch (error) {
    await escalateToHuman(endpoint, `Post-fix verification failed: ${error.message}`);
  }
}
```

---

### 5.7 Phase 7: Escalation & Reporting

```typescript
async function escalateToHuman(endpoint: string, reason: string): Promise<void> {
  await notifyGChat({
    text: `🚨 *Self-Healing Escalation*\n` +
          `Endpoint: ${endpoint}\n` +
          `Reason: ${reason}\n` +
          `Action required: Manual investigation needed\n` +
          `Command Hub: ${COMMAND_HUB_URL}/tasks?filter=self-healing`
  });

  await emitOasisEvent({
    type: 'self-healing.escalated',
    vtid: 'SYSTEM',
    payload: { endpoint, reason }
  });
}
```

---

## 6. New OASIS Event Types

Every event is linked to the VTID allocated for that specific self-healing attempt.

| Event Topic | When Emitted | VTID | Payload |
|-------------|-------------|------|---------|
| `self-healing.report.received` | Health report ingested | SYSTEM | `{ total, live, down_count }` |
| `self-healing.diagnosis.started` | VTID allocated, diagnosis begins | Fix VTID | `{ service, endpoint, http_status }` |
| `self-healing.diagnosis.completed` | All 6 diagnosis layers done | Fix VTID | `{ failure_class, confidence, auto_fixable, root_cause }` |
| `self-healing.spec.generated` | Spec written & quality-checked | Fix VTID | `{ spec_hash, quality_score, sections_present }` |
| `self-healing.task.injected` | Task pushed into autopilot pipeline | Fix VTID | `{ auto_approved, priority }` |
| `self-healing.task.skipped` | Dedup or circuit breaker | Fix VTID | `{ reason }` |
| `self-healing.verification.success` | Post-deploy health confirmed | Fix VTID | `{ endpoint, http_status }` |
| `self-healing.verification.failed` | Fix deployed but still broken | Fix VTID | `{ endpoint, http_status, attempt }` |
| `self-healing.escalated` | Human intervention needed | Fix VTID | `{ endpoint, reason }` |
| `self-healing.circuit_breaker` | Max retries reached | Fix VTID | `{ endpoint, attempts }` |

---

## 7. Database Changes

### New table: `self_healing_log`

```sql
CREATE TABLE IF NOT EXISTS self_healing_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL,
  diagnosis JSONB NOT NULL,
  vtid TEXT REFERENCES vtid_ledger(vtid),
  outcome TEXT DEFAULT 'pending',  -- pending, fixed, failed, escalated, skipped
  attempt_number INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  
  CONSTRAINT valid_outcome CHECK (outcome IN ('pending', 'fixed', 'failed', 'escalated', 'skipped'))
);

CREATE INDEX idx_self_healing_endpoint ON self_healing_log(endpoint, created_at DESC);
CREATE INDEX idx_self_healing_outcome ON self_healing_log(outcome) WHERE outcome = 'pending';

-- RLS: only service account can write, operators can read
ALTER TABLE self_healing_log ENABLE ROW LEVEL SECURITY;
```

### New column on `vtid_ledger.metadata`

No schema change needed — `metadata` is already JSONB. Self-healing tasks are identified by:
```json
{
  "source": "self-healing",
  "failure_class": "route_not_registered",
  "confidence": 0.9,
  "endpoint": "/api/v1/capacity/health",
  "priority": "critical",
  "auto_approved": true,
  "max_attempts": 2
}
```

---

## 8. New Files to Create

| File | Purpose |
|------|---------|
| `services/gateway/src/routes/self-healing.ts` | API route: receive health reports, trigger pipeline |
| `services/gateway/src/services/self-healing-diagnosis-service.ts` | Failure classification & root cause analysis |
| `services/gateway/src/services/self-healing-spec-service.ts` | Fix spec generation from diagnosis |
| `services/gateway/src/services/self-healing-injector-service.ts` | VTID creation & autopilot pipeline injection |
| `services/gateway/src/services/self-healing-verifier-service.ts` | Post-deploy health verification |
| `services/gateway/src/types/self-healing.ts` | TypeScript interfaces |
| `supabase/migrations/202604XX_self_healing_log.sql` | Database migration |

### Existing files to modify

| File | Change |
|------|--------|
| `scripts/ci/collect-status.py` | POST structured failure data to Gateway after collection |
| `services/gateway/src/index.ts` | Register `/api/v1/self-healing` route |
| `services/gateway/src/services/autopilot-event-loop.ts` | Add self-healing verification hook on deploy success |
| `services/gateway/src/services/gchat-notifier.ts` | Add self-healing event topics to notification filter |
| `services/gateway/src/types/cicd.ts` | Add self-healing event type definitions |
| `.github/workflows/DAILY-STATUS-UPDATE.yml` | Add `GATEWAY_URL` and `SERVICE_TOKEN` env vars |

---

## 9. End-to-End Flow (Example)

**Scenario**: Health Capacity endpoint returns 404, Visual Interactive returns 500.

```
08:00 UTC — DAILY-STATUS-UPDATE.yml triggers
  │
  ├─ collect-status.py pings 54 endpoints
  │   ├─ /api/v1/capacity/health    → 404 ❌
  │   └─ /api/v1/visual/health      → 500 ❌
  │
  ├─ Posts to Google Chat: "Vitana: 52/54 live ⚠️ Down: Health Capacity, Visual Interactive"
  │
  └─ POSTs structured report to POST /api/v1/self-healing/report
      │
      │ ═══════════════════════════════════════════════════════
      │ FOR EACH DOWN SERVICE (processed sequentially):
      │ ═══════════════════════════════════════════════════════
      │
      │ ── Health Capacity (404) ──────────────────────────────
      │
      ├─ DEDUP CHECK: No active self-healing VTID for /api/v1/capacity/health ✅
      ├─ CIRCUIT BREAKER: 0 attempts in 24h ✅
      │
      ├─ ALLOCATE VTID:
      │   ├─ Call allocate_global_vtid() → VTID-01287
      │   ├─ Insert shell entry in vtid_ledger: status=allocated, source=self-healing
      │   └─ Emit: self-healing.diagnosis.started (VTID-01287)
      │
      ├─ DEEP DIAGNOSE (6 layers, all events linked to VTID-01287):
      │   │
      │   ├─ Layer 1 — HTTP Response:
      │   │   └─ 404 Not Found → initial_class: ROUTE_NOT_REGISTERED, confidence: 0.6
      │   │
      │   ├─ Layer 2 — Codebase Deep Dive:
      │   │   ├─ Read index.ts → search for app.use('/api/v1/capacity', ...)
      │   │   ├─ FOUND: app.use('/api/v1/capacity', capacityRouter)
      │   │   ├─ Trace import → services/gateway/src/routes/capacity.ts
      │   │   ├─ Read capacity.ts (247 lines)
      │   │   ├─ Search for router.get('/health') → NOT FOUND
      │   │   ├─ File exists, has other routes, but /health handler is missing
      │   │   ├─ Read 2 imported service files for dependency check
      │   │   └─ Evidence: "Route file exists, mounted in index.ts, but no /health handler"
      │   │   └─ Confidence → 0.9
      │   │
      │   ├─ Layer 3 — Git History:
      │   │   ├─ git log -10 -- capacity.ts → last changed 5 days ago
      │   │   ├─ Commit abc1234: "refactor: consolidate capacity routes"
      │   │   ├─ git diff abc1234 -- capacity.ts → /health handler was REMOVED in refactor
      │   │   ├─ Last healthy: 6 days ago (from STATUS.md history)
      │   │   └─ Evidence: "Breaking commit abc1234 removed /health handler during refactor"
      │   │   └─ failure_class → REGRESSION, confidence → 0.95
      │   │
      │   ├─ Layer 4 — Dependencies:
      │   │   ├─ All imports resolve ✅
      │   │   ├─ Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE (both in Cloud Run) ✅
      │   │   └─ Evidence: "No dependency issues — problem is the missing handler"
      │   │
      │   ├─ Layer 5 — Workflow:
      │   │   ├─ Route IS mounted in index.ts ✅
      │   │   ├─ No auth middleware on health path ✅
      │   │   └─ Evidence: "Route registration is correct, only the handler is missing"
      │   │
      │   └─ Layer 6 — OASIS Correlation:
      │       ├─ deploy.gateway.success 5 days ago (same day as breaking commit)
      │       ├─ No prior self-healing attempts for this endpoint
      │       └─ Evidence: "Failure started with deploy 5 days ago"
      │
      │   DIAGNOSIS RESULT (VTID-01287):
      │   ├─ failure_class: REGRESSION
      │   ├─ confidence: 0.95
      │   ├─ root_cause: "Commit abc1234 removed /health handler from capacity.ts during refactor"
      │   ├─ suggested_fix: "Re-add router.get('/health', ...) handler to capacity.ts"
      │   ├─ files_to_modify: ["services/gateway/src/routes/capacity.ts"]
      │   ├─ auto_fixable: true (Level 1)
      │   └─ Emit: self-healing.diagnosis.completed (VTID-01287)
      │
      ├─ PRESCRIBE (VTID-01287):
      │   ├─ Feed ALL diagnosis context to Gemini 3.1 Pro:
      │   │   ├─ Full source code of capacity.ts (247 lines)
      │   │   ├─ Git diff showing what was removed
      │   │   ├─ Example /health handlers from other route files
      │   │   ├─ All 18 evidence items from 6 layers
      │   │   └─ Breaking commit details
      │   │
      │   ├─ Gemini generates spec with:
      │   │   ├─ Goal: "Restore /health endpoint removed in commit abc1234"
      │   │   ├─ Files to Modify: capacity.ts (add handler after line 12)
      │   │   ├─ Exact code to add (based on pattern from other routes)
      │   │   ├─ Acceptance: curl returns 200 with { ok: true }
      │   │   ├─ Regression check: verify /api/v1/capacity/scores still works
      │   │   └─ Rollback: revert commit, redeploy
      │   │
      │   ├─ Validate spec: 9/9 required sections present ✅
      │   ├─ Quality check: score 0.89 ✅
      │   ├─ Store in oasis_specs with SHA-256 hash
      │   └─ Emit: self-healing.spec.generated (VTID-01287)
      │
      ├─ INJECT (VTID-01287):
      │   ├─ Update vtid_ledger: status=pending, spec_status=validated
      │   ├─ Auto-approved (confidence 0.95 ≥ 0.8 threshold)
      │   ├─ Emit: autopilot.task.spec.created → autopilot event loop picks it up
      │   ├─ Emit: self-healing.task.injected (VTID-01287)
      │   └─ Notify GChat: "🔧 Self-Healing: VTID-01287 — Restoring Health Capacity (95% confidence)"
      │
      ├─ EXECUTE (Autopilot Pipeline, standard 4-stage):
      │   ├─ PLANNER: Reads spec → plans: "Add health handler to capacity.ts"
      │   ├─ WORKER (worker-backend): Reads spec + source code, adds handler
      │   ├─ VALIDATOR: VAL-RULE-001 through VAL-RULE-006 ✅
      │   └─ DEPLOY: EXEC-DEPLOY.yml → Cloud Run → smoke tests pass
      │
      ├─ VERIFY (30s after deploy):
      │   ├─ GET /api/v1/capacity/health → 200 { ok: true } ✅
      │   ├─ GET /api/v1/capacity/scores → still works (regression check) ✅
      │   ├─ Emit: self-healing.verification.success (VTID-01287)
      │   └─ Notify GChat: "✅ VTID-01287 — Health Capacity restored"
      │
      └─ REPORT:
          ├─ self_healing_log: outcome=fixed, resolved_at=now()
          ├─ VTID-01287 marked terminal: completed
          └─ Full OASIS trail: 8 events from diagnosis.started → verification.success
```

---

## 10. Confidence Tiers & Approval Gates

| Tier | Confidence | Approval | Example |
|------|-----------|----------|---------|
| **Level 1** (Auto-fix) | ≥ 0.8 | No human needed | 404 on health endpoint, known crash pattern |
| **Level 2** (Assisted fix) | 0.5 – 0.8 | Human approves spec | 500 with unknown error, schema-related |
| **Level 3** (Escalate) | < 0.5 | Human investigates | Unknown failure, external dependency |

**Level 1 auto-fix is safe because**:
- Only restores existing functionality (no new features)
- Deterministic spec from known fix patterns
- Full validator checks before deploy
- Post-deploy verification confirms fix
- Circuit breaker limits to 2 attempts
- Full OASIS event trail for audit

---

## 11. Self-Healing Dashboard (Command Hub UI)

### 11.1 Placement Decision

**Not in Autopilot. Not a standalone module. In Infrastructure → new "Self-Healing" tab.**

Rationale:
- Autopilot is about **feature development** — planning, building, shipping new work
- Self-healing is about **operational resilience** — keeping live systems alive
- These are fundamentally different concerns. Mixing them creates noise in both directions
- The Infrastructure module already has `Services`, `Health`, `Deployments`, `Logs`, `Config` — self-healing is the natural next tab
- An operator investigating a down service goes to Infrastructure first, not Autopilot

**Navigation change** in `navigation-config.js`:

```javascript
{
  module: 'infrastructure',
  label: 'Infrastructure',
  tabs: [
    { key: 'services', label: 'Services' },
    { key: 'health', label: 'Health' },
    { key: 'self-healing', label: 'Self-Healing' },  // ← NEW TAB
    { key: 'deployments', label: 'Deployments' },
    { key: 'logs', label: 'Logs' },
    { key: 'config', label: 'Config' }
  ]
}
```

URL: `/command-hub/infrastructure/self-healing/`

### 11.2 Dashboard Layout

The self-healing screen has **4 zones**, designed so an operator can answer these questions at a glance:

```
┌─────────────────────────────────────────────────────────────────────┐
│ INFRASTRUCTURE > SELF-HEALING                          🔴 KILL SWITCH │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ZONE 1: LIVE STATUS BAR                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ 52/54 HEALTHY │ 1 FIX IN PROGRESS │ 1 AWAITING APPROVAL     │  │
│  │               │ VTID-01287 (cap.) │ VTID-01288 (visual)     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ZONE 2: ACTIVE REPAIRS (Pipeline Tracker)                         │
│  ┌────────┐ ┌────────┐ ┌──────────┐ ┌────────┐ ┌────────┐        │
│  │DIAGNOSE│→│  SPEC  │→│  INJECT  │→│EXECUTE │→│ VERIFY │        │
│  │  ✅    │ │  ✅    │ │   ✅     │ │ ⏳ 67% │ │  ─     │        │
│  └────────┘ └────────┘ └──────────┘ └────────┘ └────────┘        │
│  VTID-01287: Health Capacity — REGRESSION (95% confidence)         │
│  Root cause: Commit abc1234 removed /health handler during refactor │
│  Files: capacity.ts │ Worker: worker-backend │ ETA: deploying...   │
│  [View Spec] [View Diagnosis] [View OASIS Trail] [⏸ PAUSE] [↩ ROLLBACK] │
│                                                                     │
│  ┌────────┐ ┌────────┐ ┌──────────┐ ┌────────┐ ┌────────┐        │
│  │DIAGNOSE│→│  SPEC  │→│APPROVAL  │→│EXECUTE │→│ VERIFY │        │
│  │  ✅    │ │  ✅    │ │ ⏳ WAIT  │ │  ─     │ │  ─     │        │
│  └────────┘ └────────┘ └──────────┘ └────────┘ └────────┘        │
│  VTID-01288: Visual Interactive — HANDLER_CRASH (65% confidence)   │
│  Root cause: 500 error — unhandled promise rejection in handler     │
│  [View Spec] [View Diagnosis] [✅ APPROVE] [❌ REJECT]             │
│                                                                     │
│  ZONE 3: BLAST RADIUS MONITOR                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Before Fix: 52/54 healthy                                    │  │
│  │ After Fix:  ██████████████████████████████████████████ 53/54  │  │
│  │ Delta: +1 (Health Capacity restored) │ No regressions ✅     │  │
│  │                                                               │  │
│  │ ⚠️ If delta is NEGATIVE → auto-rollback triggers             │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ZONE 4: HISTORY TABLE                                             │
│  ┌──────────┬───────────────────┬──────────┬──────┬──────┬───────┐ │
│  │ VTID     │ Service           │ Class    │ Conf │ Result│ Time │ │
│  ├──────────┼───────────────────┼──────────┼──────┼──────┼───────┤ │
│  │ 01287    │ Health Capacity   │REGRESSION│ 95%  │ ✅   │ 12min│ │
│  │ 01288    │ Visual Interactive│CRASH     │ 65%  │ ⏳   │ -    │ │
│  │ 01245    │ ORB Live          │ENV_VAR   │ 80%  │ ✅   │ 8min │ │
│  │ 01201    │ Voice Lab         │TIMEOUT   │ 45%  │ 🚨↑  │ -    │ │
│  │ 01199    │ Scheduler         │ROUTE_404 │ 92%  │ ✅   │ 6min │ │
│  │ 01150    │ Memory            │CRASH     │ 70%  │ ❌↩  │ 15min│ │
│  └──────────┴───────────────────┴──────────┴──────┴──────┴───────┘ │
│  Legend: ✅ Fixed  ❌↩ Rolled back  🚨↑ Escalated  ⏳ In progress  │
│                                                                     │
│  [Export CSV] [Filter by outcome] [Filter by date range]            │
└─────────────────────────────────────────────────────────────────────┘
```

### 11.3 Zone Details

**Zone 1 — Live Status Bar**: Pulls from `vtid_ledger WHERE metadata->>source = 'self-healing'`. Shows counts for each state. One-line summary.

**Zone 2 — Active Repairs**: One card per active self-healing VTID. Shows the 5-stage pipeline (Diagnose → Spec → Inject → Execute → Verify) with real-time status from OASIS events. Each card has action buttons:
- **View Spec**: Opens the generated fix spec in a drawer (read-only)
- **View Diagnosis**: Shows all 6 layers of evidence in an expandable tree
- **View OASIS Trail**: Timeline of all events for this VTID
- **PAUSE**: Halts the pipeline at current stage (sets `status: paused`)
- **ROLLBACK**: Triggers immediate rollback (see §12)
- **APPROVE/REJECT**: For Level 2 fixes awaiting human approval

**Zone 3 — Blast Radius Monitor**: The most critical zone (see §12). Shows before/after health counts for every fix. Visual bar chart comparing system health before vs after deployment.

**Zone 4 — History Table**: All self-healing attempts from `self_healing_log`, sortable by date, outcome, confidence, service. Expandable rows show diagnosis evidence and spec summary. Export for auditing.

### 11.4 Cross-Links

Self-healing VTIDs also appear in:
- **Command Hub → Tasks**: With a wrench badge and "SELF-HEAL" tag, so they're visible in the normal task board
- **Infrastructure → Health**: The health grid shows a "Fix in progress" indicator next to any service with an active self-healing VTID
- **OASIS → Events**: All `self-healing.*` events appear in the standard event stream

---

## 12. Damage Prevention, Blast Radius Detection & Rollback

**This is the most critical section of the entire spec.** An autonomous system that can deploy code changes must have ironclad safeguards against making things worse.

### 12.1 The Core Problem

A self-healing fix targets ONE endpoint. But a code change can break OTHER endpoints. Example:
- Visual Interactive returns 500 due to a broken import
- Self-healing adds a try/catch around the handler
- But the import was shared — the "fix" accidentally removes a side effect that 3 other routes depend on
- Result: Fixed 1 endpoint, broke 3 others. Net damage: **worse**.

### 12.2 Pre-Fix Health Snapshot

**Before ANY self-healing deploy**, capture the FULL system state by pinging ALL 54 endpoints.

```typescript
interface HealthSnapshot {
  id: string;                          // UUID
  vtid: string;                        // the self-healing VTID that triggered this
  phase: 'pre_fix' | 'post_fix';
  timestamp: string;
  total: number;
  healthy: number;
  endpoints: EndpointState[];
  git_sha: string;                     // Cloud Run deployed revision
  cloud_run_revision: string;          // exact revision name for rollback
}

interface EndpointState {
  endpoint: string;
  status: 'healthy' | 'down' | 'timeout';
  http_status: number | null;
  response_time_ms: number;
}

async function captureHealthSnapshot(vtid: string, phase: 'pre_fix' | 'post_fix'): Promise<HealthSnapshot> {
  // Ping ALL 54 endpoints in parallel (same logic as collect-status.py)
  const results = await Promise.allSettled(
    ALL_HEALTH_ENDPOINTS.map(ep => checkEndpoint(ep))
  );

  const snapshot: HealthSnapshot = {
    id: crypto.randomUUID(),
    vtid,
    phase,
    timestamp: new Date().toISOString(),
    total: ALL_HEALTH_ENDPOINTS.length,
    healthy: results.filter(r => r.status === 'fulfilled' && r.value.healthy).length,
    endpoints: results.map((r, i) => ({
      endpoint: ALL_HEALTH_ENDPOINTS[i],
      status: r.status === 'fulfilled' ? (r.value.healthy ? 'healthy' : 'down') : 'timeout',
      http_status: r.status === 'fulfilled' ? r.value.http_status : null,
      response_time_ms: r.status === 'fulfilled' ? r.value.elapsed_ms : -1
    })),
    git_sha: await getCurrentDeployedSha(),
    cloud_run_revision: await getCurrentCloudRunRevision()
  };

  // Store in Supabase
  await supabase.from('self_healing_snapshots').insert(snapshot);

  // Emit OASIS event
  await emitOasisEvent({
    type: `self-healing.snapshot.${phase}`,
    vtid,
    payload: { healthy: snapshot.healthy, total: snapshot.total, revision: snapshot.cloud_run_revision }
  });

  return snapshot;
}
```

### 12.3 Post-Fix Blast Radius Check

After deploying a fix, don't just check the ONE endpoint that was broken. Check ALL of them and compare to the pre-fix snapshot.

```typescript
async function verifyFixWithBlastRadiusCheck(vtid: string): Promise<VerificationResult> {
  // Get the pre-fix snapshot
  const preFix = await supabase
    .from('self_healing_snapshots')
    .select('*')
    .eq('vtid', vtid)
    .eq('phase', 'pre_fix')
    .single();

  // Wait for Cloud Run to stabilize
  await delay(30_000);

  // Capture post-fix snapshot (ALL 54 endpoints)
  const postFix = await captureHealthSnapshot(vtid, 'post_fix');

  // ═══════════════════════════════════════════════════════
  // BLAST RADIUS ANALYSIS
  // ═══════════════════════════════════════════════════════

  const result: VerificationResult = {
    vtid,
    target_endpoint_fixed: false,
    blast_radius: 'none',
    newly_broken: [],
    newly_fixed: [],
    net_health_delta: postFix.healthy - preFix.data.healthy,
    action: 'none',
    pre_fix_snapshot_id: preFix.data.id,
    post_fix_snapshot_id: postFix.id
  };

  // Check 1: Did the target endpoint actually get fixed?
  const targetEndpoint = (await getVtidMetadata(vtid)).endpoint;
  const targetPostState = postFix.endpoints.find(e => e.endpoint === targetEndpoint);
  result.target_endpoint_fixed = targetPostState?.status === 'healthy';

  // Check 2: Did we break anything that was previously healthy?
  for (const postEp of postFix.endpoints) {
    const preEp = preFix.data.endpoints.find((e: any) => e.endpoint === postEp.endpoint);
    if (!preEp) continue;

    if (preEp.status === 'healthy' && postEp.status !== 'healthy') {
      result.newly_broken.push(postEp.endpoint);
    }
    if (preEp.status !== 'healthy' && postEp.status === 'healthy') {
      result.newly_fixed.push(postEp.endpoint);
    }
  }

  // ═══════════════════════════════════════════════════════
  // DECISION: KEEP, ROLLBACK, OR ESCALATE
  // ═══════════════════════════════════════════════════════

  if (result.newly_broken.length === 0 && result.target_endpoint_fixed) {
    // ✅ BEST CASE: Target fixed, nothing else broken
    result.blast_radius = 'none';
    result.action = 'keep';
    await emitOasisEvent({
      type: 'self-healing.verification.success',
      vtid,
      payload: {
        target_fixed: true,
        newly_broken: 0,
        net_delta: result.net_health_delta
      }
    });
  }
  else if (result.newly_broken.length > 0) {
    // 🚨 DAMAGE DETECTED: Fix broke other endpoints
    result.blast_radius = result.newly_broken.length <= 2 ? 'contained' : 'critical';
    result.action = 'rollback';  // ALWAYS rollback if we broke something

    await emitOasisEvent({
      type: 'self-healing.blast_radius.detected',
      vtid,
      payload: {
        newly_broken: result.newly_broken,
        blast_radius: result.blast_radius,
        action: 'auto_rollback'
      }
    });

    // ═══ AUTOMATIC ROLLBACK ═══
    await executeRollback(vtid, preFix.data);

    await notifyGChat({
      text: `🚨 *Self-Healing ROLLBACK*\n` +
            `Task: ${vtid}\n` +
            `Reason: Fix caused collateral damage\n` +
            `Target fixed: ${result.target_endpoint_fixed ? 'Yes' : 'No'}\n` +
            `Newly broken: ${result.newly_broken.join(', ')}\n` +
            `Action: Auto-rolled back to revision ${preFix.data.cloud_run_revision}\n` +
            `⚠️ Human investigation required`
    });
  }
  else if (!result.target_endpoint_fixed && result.newly_broken.length === 0) {
    // ⚠️ FIX DIDN'T WORK: Target still down, but nothing else broken
    result.blast_radius = 'none';
    result.action = 'escalate';

    // Don't rollback — the fix didn't help but it also didn't hurt
    // Leave it deployed and escalate
    await escalateToHuman(targetEndpoint,
      `Fix deployed but target still returning ${targetPostState?.http_status}. ` +
      `No collateral damage. Manual investigation needed.`
    );
  }

  // Store result
  await supabase.from('self_healing_log').update({
    outcome: result.action === 'keep' ? 'fixed' :
             result.action === 'rollback' ? 'rolled_back' :
             'escalated',
    blast_radius: result.blast_radius,
    newly_broken: result.newly_broken,
    net_health_delta: result.net_health_delta,
    resolved_at: new Date().toISOString()
  }).eq('vtid', vtid);

  return result;
}
```

### 12.4 Automatic Rollback Mechanism

When blast radius is detected, rollback to the exact Cloud Run revision that was running before the fix.

```typescript
async function executeRollback(vtid: string, preFixSnapshot: HealthSnapshot): Promise<void> {
  // ── Step 1: Rollback Cloud Run to previous revision ──
  // Cloud Run keeps previous revisions — we route traffic back to the pre-fix one.
  // This is INSTANT (no rebuild needed) and SAFE (it's the revision that was running before).

  await emitOasisEvent({
    type: 'self-healing.rollback.started',
    vtid,
    payload: {
      target_revision: preFixSnapshot.cloud_run_revision,
      reason: 'blast_radius_detected'
    }
  });

  // Use gcloud to route 100% traffic to the pre-fix revision
  // This is done via GitHub Actions dispatch for governance compliance
  await triggerRollbackWorkflow(vtid, preFixSnapshot.cloud_run_revision);

  // ── Step 2: Verify rollback restored previous state ──
  await delay(15_000); // Cloud Run traffic shift is fast

  const postRollback = await captureHealthSnapshot(vtid, 'post_fix');

  if (postRollback.healthy >= preFixSnapshot.healthy) {
    await emitOasisEvent({
      type: 'self-healing.rollback.success',
      vtid,
      payload: {
        restored_to: preFixSnapshot.cloud_run_revision,
        healthy_before: preFixSnapshot.healthy,
        healthy_after: postRollback.healthy
      }
    });
  } else {
    // Rollback didn't fully restore — this is a critical escalation
    await emitOasisEvent({
      type: 'self-healing.rollback.degraded',
      vtid,
      payload: {
        expected_healthy: preFixSnapshot.healthy,
        actual_healthy: postRollback.healthy,
        still_broken: postRollback.endpoints.filter(e => e.status !== 'healthy').map(e => e.endpoint)
      }
    });

    await notifyGChat({
      text: `🔴 *CRITICAL: Rollback incomplete*\n` +
            `Task: ${vtid}\n` +
            `Expected ${preFixSnapshot.healthy}/54 healthy after rollback\n` +
            `Got ${postRollback.healthy}/54\n` +
            `⚠️ Immediate human intervention required`
    });
  }

  // ── Step 3: Mark the VTID as rolled back ──
  await supabase.from('vtid_ledger').update({
    status: 'failed',
    terminal_outcome: 'rolled_back',
    metadata: {
      rolled_back_at: new Date().toISOString(),
      rolled_back_to: preFixSnapshot.cloud_run_revision,
      reason: 'blast_radius_detected'
    }
  }).eq('vtid', vtid);

  // ── Step 4: Revert the git commit (if one was created) ──
  // Create a revert commit so the bad fix doesn't get re-deployed
  // in the next normal deploy cycle
  await triggerGitRevertWorkflow(vtid);
}
```

### 12.5 The Kill Switch

A manual emergency stop that halts ALL self-healing activity system-wide.

**UI**: Big red button in the top-right of the Self-Healing dashboard (Zone 1).

**API**: `POST /api/v1/self-healing/kill-switch`

```typescript
// The kill switch sets a flag that ALL self-healing code checks before acting
router.post('/kill-switch', async (req: Request, res: Response) => {
  const action = req.body.action; // 'activate' or 'deactivate'

  if (action === 'activate') {
    // Set global flag — stored in a simple config table
    await supabase.from('system_config').upsert({
      key: 'self_healing_enabled',
      value: false,
      updated_by: req.body.operator || 'manual',
      updated_at: new Date().toISOString()
    });

    // Pause ALL active self-healing VTIDs
    await supabase.from('vtid_ledger')
      .update({ status: 'paused' })
      .eq('metadata->>source', 'self-healing')
      .in('status', ['allocated', 'pending', 'in_progress']);

    await emitOasisEvent({
      type: 'self-healing.kill_switch.activated',
      vtid: 'SYSTEM',
      payload: { operator: req.body.operator, reason: req.body.reason }
    });

    await notifyGChat({
      text: `🔴 *Self-Healing KILL SWITCH activated*\n` +
            `By: ${req.body.operator || 'manual'}\n` +
            `Reason: ${req.body.reason || 'not specified'}\n` +
            `All active self-healing tasks paused.\n` +
            `New reports will be logged but NOT acted on.`
    });

    return res.json({ status: 'killed', paused_tasks: 'all' });
  }

  if (action === 'deactivate') {
    await supabase.from('system_config').upsert({
      key: 'self_healing_enabled',
      value: true,
      updated_by: req.body.operator || 'manual',
      updated_at: new Date().toISOString()
    });

    await emitOasisEvent({
      type: 'self-healing.kill_switch.deactivated',
      vtid: 'SYSTEM',
      payload: { operator: req.body.operator }
    });

    return res.json({ status: 'active' });
  }
});

// Every self-healing function checks this before proceeding
async function isSelfHealingEnabled(): Promise<boolean> {
  const { data } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'self_healing_enabled')
    .single();

  return data?.value !== false; // default: enabled
}
```

### 12.6 Graduated Autonomy Levels

The kill switch is binary. For finer control, the system supports **autonomy levels** that determine how much it can do without asking:

```typescript
enum AutonomyLevel {
  // Level 0: OFF — log only, no action
  OBSERVE_ONLY = 0,

  // Level 1: DIAGNOSE — allocate VTID, run diagnosis, but stop before spec gen
  DIAGNOSE_ONLY = 1,

  // Level 2: SPEC — diagnose + generate spec, but always require human approval
  SPEC_AND_WAIT = 2,

  // Level 3: AUTO-FIX SIMPLE — auto-approve Level 1 (high confidence) fixes only
  AUTO_FIX_SIMPLE = 3,

  // Level 4: FULL AUTO — auto-approve Level 1 + Level 2 fixes
  FULL_AUTO = 4,
}
```

**Default**: `AUTO_FIX_SIMPLE` (Level 3) — only high-confidence, simple fixes execute without human approval.

**Config**: `POST /api/v1/self-healing/config` + visible as a dropdown in the dashboard.

### 12.7 Rollback History & Forensics

When a self-healing fix fails or is rolled back, the dashboard shows a forensics view:

```
┌──────────────────────────────────────────────────────────────────┐
│ VTID-01288 — ROLLED BACK                                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Timeline:                                                       │
│  08:00:00  Detected: Visual Interactive returning 500            │
│  08:00:02  VTID-01288 allocated                                  │
│  08:00:03  Diagnosis started (6-layer analysis)                  │
│  08:00:18  Diagnosis complete: HANDLER_CRASH, 65% confidence     │
│  08:00:20  Spec generated (quality: 0.72)                        │
│  08:00:21  Injected into pipeline (awaiting approval)            │
│  08:15:00  Human approved                                        │
│  08:15:01  Planner started                                       │
│  08:16:30  Worker completed: modified visual-interactive.ts      │
│  08:17:00  Validator passed                                      │
│  08:18:45  Deploy completed (revision: gateway-00042-abc)        │
│  08:19:15  ❌ PRE-FIX SNAPSHOT: 52/54 healthy                   │
│  08:19:45  ❌ POST-FIX SNAPSHOT: 50/54 healthy                  │
│  08:19:46  🚨 BLAST RADIUS: -2 (Domain Routing, Personalization)│
│  08:19:47  ↩ ROLLBACK initiated to revision gateway-00041-xyz   │
│  08:20:02  ↩ ROLLBACK complete: 52/54 healthy restored          │
│  08:20:03  Git revert commit created                             │
│                                                                  │
│  Pre-Fix State:           Post-Fix State:          After Rollback:│
│  ██████████████░░ 52/54   ██████████████░░░░ 50/54  ██████████████░░ 52/54 │
│                                                                  │
│  Collateral Damage:                                              │
│  ├─ /api/v1/routing/health  — was 200, became 500               │
│  └─ /api/v1/personalization/health — was 200, became 500        │
│                                                                  │
│  Root Cause of Failure:                                          │
│  The fix modified a shared import (visual-verification.ts) that  │
│  Domain Routing and Personalization also depend on.              │
│                                                                  │
│  Diagnosis Evidence (18 items):  [Expand ▼]                      │
│  Generated Spec:                 [View ▼]                        │
│  Worker Diff:                    [View ▼]                        │
│  OASIS Events (12):              [View ▼]                        │
│                                                                  │
│  Actions:                                                        │
│  [🔄 Retry with different approach]  [📋 Create manual task]     │
│  [📤 Export forensics report]                                    │
└──────────────────────────────────────────────────────────────────┘
```

### 12.8 Safety Summary

| Scenario | What Happens | Automatic? |
|----------|-------------|-----------|
| Fix works, nothing else breaks | Keep deployment, mark VTID completed | Yes |
| Fix works, but 1-2 other endpoints break | **Auto-rollback** + escalate + git revert | Yes |
| Fix works, 3+ other endpoints break | **Auto-rollback** + escalate + kill switch consideration | Yes |
| Fix doesn't work, nothing else breaks | Keep (harmless), escalate to human | Yes |
| Fix doesn't work AND breaks other things | **Auto-rollback** + escalate + circuit breaker | Yes |
| Two rollbacks in 24h for same service | **Circuit breaker** + escalate | Yes |
| Operator doesn't trust the system | **Kill switch** pauses everything | Manual |
| Rollback itself fails | **Critical alert** to Google Chat + all channels | Yes |

**The cardinal rule**: If the system health count goes DOWN after a self-healing deploy, **always rollback, no exceptions**. The only acceptable outcome of a self-healing fix is net-zero or net-positive health.

---

## 13. Database Changes (Updated)

### New table: `self_healing_log`

```sql
CREATE TABLE IF NOT EXISTS self_healing_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vtid TEXT NOT NULL REFERENCES vtid_ledger(vtid),
  endpoint TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL,
  diagnosis JSONB NOT NULL,
  spec_hash TEXT,
  outcome TEXT DEFAULT 'pending',
  blast_radius TEXT DEFAULT 'none',
  newly_broken TEXT[] DEFAULT '{}',
  net_health_delta INT DEFAULT 0,
  attempt_number INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,

  CONSTRAINT valid_outcome CHECK (outcome IN (
    'pending', 'fixed', 'failed', 'rolled_back', 'escalated', 'skipped', 'paused'
  )),
  CONSTRAINT valid_blast_radius CHECK (blast_radius IN ('none', 'contained', 'critical'))
);

CREATE INDEX idx_self_healing_endpoint ON self_healing_log(endpoint, created_at DESC);
CREATE INDEX idx_self_healing_outcome ON self_healing_log(outcome) WHERE outcome = 'pending';
CREATE INDEX idx_self_healing_vtid ON self_healing_log(vtid);
```

### New table: `self_healing_snapshots`

```sql
CREATE TABLE IF NOT EXISTS self_healing_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vtid TEXT NOT NULL REFERENCES vtid_ledger(vtid),
  phase TEXT NOT NULL CHECK (phase IN ('pre_fix', 'post_fix')),
  timestamp TIMESTAMPTZ DEFAULT now(),
  total INT NOT NULL,
  healthy INT NOT NULL,
  endpoints JSONB NOT NULL,           -- array of { endpoint, status, http_status, response_time_ms }
  git_sha TEXT,
  cloud_run_revision TEXT,

  UNIQUE(vtid, phase)                 -- one pre and one post per VTID
);

CREATE INDEX idx_snapshots_vtid ON self_healing_snapshots(vtid);
```

### New table: `system_config` (if not exists)

```sql
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Default: self-healing enabled at AUTO_FIX_SIMPLE level
INSERT INTO system_config (key, value) VALUES
  ('self_healing_enabled', 'true'),
  ('self_healing_autonomy_level', '3')
ON CONFLICT (key) DO NOTHING;
```

---

## 14. Acceptance Criteria

### Core Pipeline
- [ ] `collect-status.py` POSTs structured failure data to Gateway when services are down
- [ ] Each failing service gets a unique VTID allocated BEFORE diagnosis starts
- [ ] VTID is registered in OASIS with `self-healing.diagnosis.started` event
- [ ] Diagnosis engine performs all 6 layers (HTTP, codebase, git, dependencies, workflow, OASIS)
- [ ] Diagnosis reads actual source files and git history — not just HTTP status codes
- [ ] Fix spec is generated using the standard VTID-01188 template with full code context
- [ ] Spec passes `runFullQualityCheck()` with score ≥ 0.7
- [ ] Level 1 fixes (confidence ≥ 0.8) proceed through autopilot without human approval
- [ ] Level 2 fixes appear in the Self-Healing dashboard for human approval
- [ ] Level 3 failures escalate to Google Chat with diagnosis evidence

### Safety & Rollback
- [ ] Pre-fix snapshot captures ALL 54 endpoint states before deploy
- [ ] Post-fix snapshot captures ALL 54 endpoint states after deploy
- [ ] If ANY previously-healthy endpoint becomes unhealthy → auto-rollback triggers
- [ ] Rollback uses Cloud Run revision routing (instant, no rebuild)
- [ ] Rollback is followed by a git revert commit
- [ ] Post-rollback verification confirms system returned to pre-fix state
- [ ] Circuit breaker prevents more than 2 attempts per endpoint per 24h
- [ ] Kill switch pauses ALL active self-healing tasks immediately
- [ ] Kill switch is accessible from the dashboard UI and API

### Dashboard
- [ ] Self-Healing tab appears in Infrastructure module
- [ ] Live status bar shows healthy/active/pending counts
- [ ] Pipeline tracker shows 5-stage progress per active VTID
- [ ] Blast radius monitor shows before/after comparison
- [ ] History table shows all past self-healing attempts with outcomes
- [ ] Rolled-back VTIDs show full forensics (timeline, snapshots, collateral damage)
- [ ] APPROVE/REJECT buttons work for Level 2 fixes
- [ ] PAUSE and ROLLBACK buttons work for active fixes

---

## 15. Verification Steps

```bash
# 1. Simulate a health report with a down service
curl -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/report \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -d '{
    "timestamp": "2026-04-02T08:00:00Z",
    "total": 54,
    "live": 53,
    "services": [{
      "name": "Test Service",
      "endpoint": "/api/v1/test-heal/health",
      "status": "down",
      "http_status": 404
    }]
  }'
# Expected: { "processed": 1, "vtids": ["VTID-01XXX"], "phase": "diagnosis_started" }

# 2. Verify VTID was created with diagnosis
curl https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/vtid/VTID-01XXX
# Expected: status=pending, metadata.source="self-healing", metadata.failure_class="..."

# 3. Verify OASIS events trail
curl "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/oasis/events?vtid=VTID-01XXX"
# Expected: self-healing.diagnosis.started, .completed, .spec.generated, .task.injected

# 4. Verify pre-fix snapshot was captured
curl "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/snapshots/VTID-01XXX"
# Expected: { pre_fix: { healthy: 53, total: 54, ... }, post_fix: null }

# 5. Test dedup
curl -X POST .../api/v1/self-healing/report ...  # same report again
# Expected: { "processed": 1, "vtids": [], "skipped": ["Test Service (active VTID-01XXX)"] }

# 6. Test kill switch
curl -X POST .../api/v1/self-healing/kill-switch \
  -d '{"action": "activate", "operator": "dstev", "reason": "testing"}'
# Expected: { "status": "killed" }
# All active self-healing VTIDs should be paused

# 7. Verify blast radius detection (manual test after deploy)
curl "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/snapshots/VTID-01XXX"
# Expected: { pre_fix: { healthy: 53 }, post_fix: { healthy: 54 }, delta: +1, blast_radius: "none" }
```

---

## 16. Rollback Plan (for the self-healing system itself)

1. **Kill switch**: `POST /api/v1/self-healing/kill-switch` → pauses everything immediately
2. **Remove route**: Delete self-healing route from `index.ts` and redeploy
3. **Revert `collect-status.py`**: Remove the POST-to-Gateway code — daily notifications continue as before
4. **VTIDs are permanent**: Self-healing VTIDs remain in the ledger as historical records
5. **Snapshots are read-only**: Health snapshots are valuable diagnostic data even without the system
6. **Drop tables if needed**: `self_healing_log`, `self_healing_snapshots` contain no user data

---

## 17. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Auto-fix breaks other endpoints | Medium | **Critical** | Pre/post snapshot comparison + **auto-rollback on any regression** |
| Rollback itself fails | Very Low | Critical | Cloud Run revision routing is atomic; alert on failure |
| Infinite fix-rollback loop | Low | Medium | Circuit breaker (2/24h) + kill switch |
| Wrong diagnosis → wrong fix | Medium | High | 6-layer deep diagnosis + confidence tiers + human approval for uncertain fixes |
| Fix deployed during peak traffic | Low | High | Can restrict self-healing to maintenance windows via config |
| Git revert conflicts with in-progress work | Low | Medium | Revert goes to a branch, not direct to main |
| Self-healing overwhelms deploy pipeline | Low | Medium | Sequential processing, max 1 deploy at a time |
| Attacker triggers false health failures | Very Low | High | Service token auth on report endpoint |

---

## 18. Implementation Order

| Phase | Description | Complexity |
|-------|-------------|-----------|
| **Phase 1** | Enhanced health monitor (`collect-status.py` → Gateway POST) | Small |
| **Phase 2** | VTID allocation + 6-layer deep diagnosis engine | Large |
| **Phase 3** | AI-powered spec generation with full code context | Medium |
| **Phase 4** | Pipeline injection (into existing autopilot) | Medium |
| **Phase 5** | Dedup + circuit breaker | Small |
| **Phase 6** | Pre/post health snapshots + blast radius detection | Medium |
| **Phase 7** | Auto-rollback via Cloud Run revision routing | Medium |
| **Phase 8** | Kill switch + autonomy levels | Small |
| **Phase 9** | Self-Healing dashboard in Command Hub | Large |
| **Phase 10** | Forensics view + history export | Medium |

**Recommended build order**: Phases 1–5 (core pipeline), then **Phase 6–8 (safety — must ship before any auto-deploys)**, then Phase 9–10 (dashboard).

**Critical rule**: Phases 6–8 (blast radius + rollback + kill switch) must be implemented and tested BEFORE the system is allowed to auto-deploy any fix. Without blast radius detection, the system is too dangerous to run autonomously.

---

## 19. Future Enhancements (Out of Current Scope)

- **Predictive healing**: Detect degradation trends (response time increasing, error rate climbing) before complete failure
- **Continuous monitoring**: Move from daily cron to 15-minute intervals or real-time Cloud Run health checks
- **Fix pattern learning**: Build a knowledge base of successful fixes → improve diagnosis confidence over time
- **Cross-service correlation**: Detect cascading failures (Service A down because Service B timeout)
- **Canary deployment**: Deploy fix to a canary revision (10% traffic) before full rollout
- **Self-healing metrics**: MTTD (mean time to detect), MTTR (mean time to repair), fix success rate, rollback rate
- **Dependency-aware blast radius**: Before deploying, statically analyze which OTHER routes import the modified files → predict blast radius before it happens
- **Staged rollout**: Instead of full deploy, route 10% traffic to new revision, check health, then scale to 100%
