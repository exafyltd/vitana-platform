/**
 * Self-Healing Diagnosis Service
 * 6-layer deep diagnosis engine for autonomous failure analysis.
 *
 * Layers:
 *   1. HTTP Response Analysis — classify by status code + response body
 *   2. Codebase Deep Dive — find route file, inspect handler, imports, env vars
 *   3. Git History — recent commits, breaking changes, deploy drift
 *   4. Dependency Analysis — missing imports, env vars, DB tables
 *   5. Workflow Analysis — route mounting, middleware chain, auth
 *   6. OASIS Correlation — recent events, prior self-healing attempts
 *
 * All file/git operations are best-effort and gracefully degrade on Cloud Run.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  ServiceStatus,
  Diagnosis,
  FailureClass,
  CodebaseAnalysis,
  GitAnalysis,
  DependencyAnalysis,
  WorkflowAnalysis,
  CommitInfo,
  ENDPOINT_FILE_MAP,
} from '../types/self-healing';
import { emitOasisEvent } from './oasis-event-service';
import { allocateVtid } from './operator-service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const INDEX_PATH = path.join(REPO_ROOT, 'services/gateway/src/index.ts');

// PR-C (VTID-02916): GitHub Contents API fallback for source-tree visibility.
// Cloud Run revisions don't carry the full source tree under REPO_ROOT, so
// fs.existsSync()/fs.readFileSync() return ENOENT and diagnosis falsely
// reports "route file does not exist". We fall back to GitHub at the SHA the
// running container was built from (BUILD_INFO.sha) and only as last resort
// to ref=main, which may have drifted ahead of the deployed revision.
// Env reads at module load are brittle — tests + operators can override
// at runtime via DEPLOYED_GIT_SHA / BUILD_SHA / GITHUB_SAFE_MERGE_TOKEN,
// and the values must be honored even if they're set AFTER imports.
function githubAuthEnv(): { owner: string; repo: string; token: string } {
  return {
    owner: process.env.GITHUB_REPO_OWNER || 'exafyltd',
    repo: process.env.GITHUB_REPO_NAME || 'vitana-platform',
    token: process.env.GITHUB_SAFE_MERGE_TOKEN || process.env.GITHUB_TOKEN || '',
  };
}

// Read every call so tests + operators can override at runtime; the work
// is cheap (env read + at most one fs.readFileSync of a tiny JSON file).
function getDeployedSha(): string | null {
  // 1. Explicit env override (set by EXEC-DEPLOY.yml when known).
  if (process.env.DEPLOYED_GIT_SHA) return process.env.DEPLOYED_GIT_SHA;
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA;
  // 2. Cloud Run sets K_REVISION but the value is a revision name, not a
  //    commit SHA — skip it. Fall through to BUILD_INFO file.
  // 3. Read BUILD_INFO written at container build time.
  try {
    const buildInfoPath = path.join(__dirname, '..', '..', 'BUILD_INFO');
    if (fs.existsSync(buildInfoPath)) {
      const raw = fs.readFileSync(buildInfoPath, 'utf-8').trim();
      try {
        const parsed = JSON.parse(raw) as { sha?: string };
        return parsed?.sha || null;
      } catch {
        return raw || null;
      }
    }
  } catch {
    // Ignore — fall through.
  }
  return null;
}

interface LoadedSource {
  found: boolean;
  content?: string;
  sha?: string | null;
  source: 'fs' | 'github_deployed_sha' | 'github_main';
}

async function fetchFromGithub(
  relativeFile: string,
  ref: string,
): Promise<{ ok: boolean; content?: string; sha?: string }> {
  const { owner, repo, token } = githubAuthEnv();
  if (!token) {
    return { ok: false };
  }
  const encoded = relativeFile.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { content?: string; encoding?: string; sha?: string };
    if (!body?.content || body.encoding !== 'base64') return { ok: false };
    const content = Buffer.from(body.content, 'base64').toString('utf-8');
    return { ok: true, content, sha: body.sha };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve a repo-relative file path to its current source. Tries the local
 * filesystem first, then GitHub at the deployed SHA, then GitHub at main.
 * The cache is request-scoped so we don't refetch the same file twice in
 * one diagnosis run.
 */
export async function loadSourceFile(
  relativeFile: string,
  cache?: Map<string, LoadedSource>,
): Promise<LoadedSource> {
  if (cache?.has(relativeFile)) return cache.get(relativeFile)!;

  // 1. Local filesystem (fastest, no network).
  try {
    const absolutePath = path.join(REPO_ROOT, relativeFile);
    if (fs.existsSync(absolutePath)) {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      const result: LoadedSource = { found: true, content, sha: null, source: 'fs' };
      cache?.set(relativeFile, result);
      return result;
    }
  } catch {
    // Fall through to GitHub fallbacks.
  }

  // 2. GitHub at the deployed SHA, when available.
  const deployedSha = getDeployedSha();
  if (deployedSha) {
    const gh = await fetchFromGithub(relativeFile, deployedSha);
    if (gh.ok && gh.content !== undefined) {
      const result: LoadedSource = {
        found: true,
        content: gh.content,
        sha: gh.sha ?? null,
        source: 'github_deployed_sha',
      };
      cache?.set(relativeFile, result);
      return result;
    }
  }

  // 3. Last resort: GitHub at ref=main. May be drifted ahead of the
  // running revision — log so operators see when this path is taken.
  const ghMain = await fetchFromGithub(relativeFile, 'main');
  if (ghMain.ok && ghMain.content !== undefined) {
    console.warn(
      `[self-healing-diagnosis] loadSourceFile fell back to ref=main for ${relativeFile} ` +
        `(deployed_sha=${deployedSha || 'unknown'} unavailable). Diagnosis may be against a ` +
        `newer source than what is deployed.`,
    );
    const result: LoadedSource = {
      found: true,
      content: ghMain.content,
      sha: ghMain.sha ?? null,
      source: 'github_main',
    };
    cache?.set(relativeFile, result);
    return result;
  }

  const miss: LoadedSource = { found: false, source: 'fs' };
  cache?.set(relativeFile, miss);
  return miss;
}

/**
 * Build a short excerpt around the first occurrence of a regex match (or the
 * top of the file if no match). Bounded to 500 chars so it is safe to
 * persist in self_healing_log.diagnosis.
 */
function buildSourceExcerpt(content: string, matcher?: RegExp): string {
  if (!content) return '';
  if (matcher) {
    const m = matcher.exec(content);
    if (m && typeof m.index === 'number') {
      const start = Math.max(0, m.index - 100);
      const end = Math.min(content.length, m.index + 400);
      return content.substring(start, end);
    }
  }
  return content.substring(0, 500);
}

/**
 * Strip large/unsafe fields off a Diagnosis before persisting it. Keeps
 * route_file_source / route_file_sha / route_file_excerpt for forensics
 * but drops the full route_file_content (which can be tens of KB and may
 * contain secrets like inline API keys).
 */
export function redactDiagnosisForPersistence(diagnosis: Diagnosis): Diagnosis {
  if (!diagnosis.codebase_analysis) return diagnosis;
  const codebase = diagnosis.codebase_analysis;
  return {
    ...diagnosis,
    codebase_analysis: {
      ...codebase,
      route_file_content: null,
    },
  };
}

const AUTO_FIXABLE_CLASSES: Set<FailureClass> = new Set([
  FailureClass.ROUTE_NOT_REGISTERED,
  FailureClass.HANDLER_CRASH,
  FailureClass.MISSING_ENV_VAR,
  FailureClass.IMPORT_ERROR,
  FailureClass.STALE_DEPLOYMENT,
  FailureClass.REGRESSION,
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Top-level entry: allocate a VTID, run 6-layer diagnosis, emit OASIS events.
 */
export async function beginDiagnosis(
  failure: ServiceStatus,
): Promise<{ vtid: string; diagnosis: Diagnosis }> {
  const vtidResult = await allocateVtid('self-healing-diagnosis', 'OASIS', 'GATEWAY');
  const vtid = vtidResult.vtid ?? `SH-FALLBACK-${Date.now()}`;

  await emitOasisEvent({
    vtid,
    type: 'vtid.execute.started' as any,
    source: 'self-healing-diagnosis',
    status: 'info',
    message: `Diagnosis started for ${failure.name} (${failure.endpoint})`,
    payload: {
      phase: 'diagnosis',
      service_name: failure.name,
      endpoint: failure.endpoint,
      http_status: failure.http_status,
      service_status: failure.status,
    },
  });

  const diagnosis = await runDeepDiagnosis(failure, vtid);

  await emitOasisEvent({
    vtid,
    type: 'vtid.execute.completed' as any,
    source: 'self-healing-diagnosis',
    status: diagnosis.confidence >= 0.6 ? 'success' : 'warning',
    message: `Diagnosis complete: ${diagnosis.failure_class} (confidence ${diagnosis.confidence})`,
    payload: {
      phase: 'diagnosis',
      failure_class: diagnosis.failure_class,
      confidence: diagnosis.confidence,
      root_cause: diagnosis.root_cause,
      auto_fixable: diagnosis.auto_fixable,
      files_to_modify: diagnosis.files_to_modify,
    },
  });

  return { vtid, diagnosis };
}

/**
 * Internal 6-layer diagnosis pipeline.
 */
export async function runDeepDiagnosis(
  failure: ServiceStatus,
  vtid: string,
): Promise<Diagnosis> {
  const evidence: string[] = [];
  const filesRead: string[] = [];
  const filesToModify: string[] = [];
  // Request-scoped cache so the same source isn't fetched twice from GitHub
  // within one diagnosis run.
  const sourceCache = new Map<string, LoadedSource>();

  // Layer 1 — HTTP Response Analysis
  const { failureClass: httpClass, confidence: httpConf, rootCause: httpCause, fix: httpFix } =
    analyzeHttpResponse(failure, evidence);

  // Layer 2 — Codebase Deep Dive
  const codebaseAnalysis = await analyzeCodebase(failure, evidence, filesRead, sourceCache);

  // Layer 3 — Git History
  const gitAnalysis = analyzeGitHistory(failure, codebaseAnalysis, evidence);

  // Layer 4 — Dependency Analysis
  const dependencyAnalysis = analyzeDependencies(codebaseAnalysis, evidence);

  // Layer 5 — Workflow Analysis (PR-F: GitHub-fallback aware so Cloud Run
  // can see whether routes are mounted in index.ts even without the source
  // tree on disk; shares the same sourceCache as Layer 2).
  const workflowAnalysis = await analyzeWorkflow(failure, codebaseAnalysis, evidence, filesRead, sourceCache);

  // Layer 6 — OASIS Correlation
  const { oasisEvidence, priorAttempts } = await correlateOasis(failure, vtid, evidence);

  // --- Synthesis: pick best failure class and compute final confidence ---
  const {
    finalClass,
    finalConfidence,
    finalCause,
    finalFix,
  } = synthesize(
    failure,
    httpClass,
    httpConf,
    httpCause,
    httpFix,
    codebaseAnalysis,
    gitAnalysis,
    dependencyAnalysis,
    workflowAnalysis,
    evidence,
    filesToModify,
    priorAttempts,
  );

  if (finalConfidence < 0.6) {
    evidence.push('AI-assisted diagnosis recommended');
  }

  const autoFixable =
    finalConfidence >= 0.8 && AUTO_FIXABLE_CLASSES.has(finalClass);

  return {
    service_name: failure.name,
    endpoint: failure.endpoint,
    vtid,
    failure_class: finalClass,
    confidence: Math.round(finalConfidence * 100) / 100,
    root_cause: finalCause,
    suggested_fix: finalFix,
    auto_fixable: autoFixable,
    evidence,
    codebase_analysis: codebaseAnalysis,
    git_analysis: gitAnalysis,
    dependency_analysis: dependencyAnalysis,
    workflow_analysis: workflowAnalysis,
    files_to_modify: filesToModify,
    files_read: filesRead,
  };
}

// ---------------------------------------------------------------------------
// Layer 1: HTTP Response Analysis
// ---------------------------------------------------------------------------

function analyzeHttpResponse(
  failure: ServiceStatus,
  evidence: string[],
): { failureClass: FailureClass; confidence: number; rootCause: string; fix: string } {
  const { http_status, response_body, status, error_message, endpoint } = failure;

  evidence.push(`HTTP status: ${http_status ?? 'null'}, service status: ${status}`);

  if (response_body) {
    evidence.push(`Response body (first 500 chars): ${response_body.substring(0, 500)}`);
  }
  if (error_message) {
    evidence.push(`Error message: ${error_message}`);
  }

  // Timeout
  if (status === 'timeout') {
    return {
      failureClass: FailureClass.DEPENDENCY_TIMEOUT,
      confidence: 0.6,
      rootCause: `Endpoint ${endpoint} timed out — likely an upstream dependency or resource exhaustion`,
      fix: 'Check upstream service health and increase timeout if appropriate',
    };
  }

  // 404 — route not registered
  if (http_status === 404) {
    return {
      failureClass: FailureClass.ROUTE_NOT_REGISTERED,
      confidence: 0.7,
      rootCause: `Endpoint ${endpoint} returned 404 — route may not be registered in index.ts`,
      fix: 'Register the route in index.ts using mountRouterSync',
    };
  }

  // 500 — handler crash
  if (http_status !== null && http_status >= 500 && http_status < 600) {
    let rootCause = `Endpoint ${endpoint} returned ${http_status} — handler crash or unhandled exception`;
    let fc = FailureClass.HANDLER_CRASH;
    const conf = 0.5;

    // Refine from response body
    const body = (response_body || '').toLowerCase();
    if (body.includes('cannot find module') || body.includes('module not found')) {
      fc = FailureClass.IMPORT_ERROR;
      rootCause = `Import error in handler: ${extractQuotedString(response_body)}`;
    } else if (body.includes('env') || body.includes('not configured') || body.includes('missing')) {
      fc = FailureClass.MISSING_ENV_VAR;
      rootCause = `Possible missing environment variable in handler for ${endpoint}`;
    } else if (body.includes('relation') && body.includes('does not exist')) {
      fc = FailureClass.DATABASE_SCHEMA_DRIFT;
      rootCause = `Database table referenced by ${endpoint} does not exist`;
    } else if (body.includes('econnrefused') || body.includes('enotfound')) {
      fc = FailureClass.EXTERNAL_DEPENDENCY;
      rootCause = `External dependency unreachable from ${endpoint}`;
    }

    return { failureClass: fc, confidence: conf, rootCause, fix: suggestFixForClass(fc, endpoint) };
  }

  // 401/403 — middleware rejection
  if (http_status === 401 || http_status === 403) {
    return {
      failureClass: FailureClass.MIDDLEWARE_REJECTION,
      confidence: 0.65,
      rootCause: `Endpoint ${endpoint} returned ${http_status} — auth middleware may be blocking unauthenticated health checks`,
      fix: 'Ensure /health endpoint is exempt from auth middleware',
    };
  }

  // Connection refused / no response
  if (http_status === null || http_status === 0) {
    return {
      failureClass: FailureClass.STALE_DEPLOYMENT,
      confidence: 0.4,
      rootCause: `No HTTP response from ${endpoint} — service may not be running or deployed`,
      fix: 'Check Cloud Run deployment status and logs',
    };
  }

  return {
    failureClass: FailureClass.UNKNOWN,
    confidence: 0.3,
    rootCause: `Endpoint ${endpoint} returned unexpected status ${http_status}`,
    fix: 'Manual investigation required',
  };
}

// ---------------------------------------------------------------------------
// Layer 2: Codebase Deep Dive
// ---------------------------------------------------------------------------

async function analyzeCodebase(
  failure: ServiceStatus,
  evidence: string[],
  filesRead: string[],
  sourceCache?: Map<string, LoadedSource>,
): Promise<CodebaseAnalysis> {
  const result: CodebaseAnalysis = {
    route_file: null,
    route_file_exists: false,
    route_file_content: null,
    health_handler_exists: false,
    handler_has_errors: false,
    error_description: null,
    router_export_name: null,
    imports: [],
    env_vars_used: [],
    supabase_tables_used: [],
    related_service_files: [],
    files_read: [],
    evidence: [],
  };

  // Resolve route file from ENDPOINT_FILE_MAP
  const relativeFile = ENDPOINT_FILE_MAP[failure.endpoint];
  if (!relativeFile) {
    result.evidence.push(`No entry in ENDPOINT_FILE_MAP for ${failure.endpoint}`);
    evidence.push(`No known route file mapping for ${failure.endpoint}`);
    return result;
  }

  result.route_file = relativeFile;

  try {
    // PR-C (VTID-02916): try local fs, then GitHub at deployed SHA, then
    // GitHub at main. Cloud Run revisions don't carry the source tree, so
    // the legacy fs.existsSync()-only check was producing false negatives.
    const loaded = await loadSourceFile(relativeFile, sourceCache);
    result.route_file_source = loaded.source;
    result.route_file_sha = loaded.sha ?? null;

    if (!loaded.found) {
      result.route_file_exists = false;
      result.evidence.push(
        `Route file ${relativeFile} not found via fs OR GitHub (deployed_sha=${getDeployedSha() || 'unknown'})`,
      );
      evidence.push(`Route file missing: ${relativeFile}`);
      return result;
    }

    result.route_file_exists = true;
    const content = loaded.content!;
    result.route_file_content = content;
    result.files_read.push(relativeFile);
    filesRead.push(relativeFile);
    if (loaded.source !== 'fs') {
      result.evidence.push(
        `Route file ${relativeFile} loaded via ${loaded.source}` +
          (loaded.sha ? ` (sha=${loaded.sha.substring(0, 7)})` : ''),
      );
    }

    // Check for health handler
    const healthEndpoint = failure.endpoint.split('/').pop();
    const healthPattern = new RegExp(
      `\\.(get|all)\\s*\\(\\s*['\`"]\\/?${escapeRegex(healthEndpoint || 'health')}['\`"]`,
      'i',
    );
    result.health_handler_exists = healthPattern.test(content);
    // Persist a short, safe excerpt around the match site (or top of the
    // file when no match). The full content stays in-memory only.
    result.route_file_excerpt = buildSourceExcerpt(content, healthPattern);
    if (!result.health_handler_exists) {
      result.evidence.push(`No handler found matching /${healthEndpoint} in ${relativeFile}`);
      evidence.push(`Health handler not found in ${relativeFile}`);
    } else {
      result.evidence.push(`Health handler found in ${relativeFile}`);
    }

    // Extract imports
    const importMatches = content.match(/(?:import|require)\s*\(?['"](\.\/[^'"]+|\.\.\/[^'"]+)['"]\)?/g) || [];
    result.imports = importMatches.map((m) => {
      const match = m.match(/['"]([^'"]+)['"]/);
      return match ? match[1] : m;
    });

    // Extract env vars
    const envMatches = content.match(/process\.env\.([A-Z_][A-Z0-9_]*)/g) || [];
    result.env_vars_used = Array.from(new Set(envMatches.map((m) => m.replace('process.env.', ''))));
    if (result.env_vars_used.length > 0) {
      result.evidence.push(`Env vars used: ${result.env_vars_used.join(', ')}`);
    }

    // Extract Supabase table references
    const tableMatches = content.match(/from\s*\(\s*['"]([a-z_]+)['"]\s*\)/g) || [];
    const restTableMatches = content.match(/\/rest\/v1\/([a-z_]+)/g) || [];
    const allTables = new Set<string>();
    for (const m of tableMatches) {
      const t = m.match(/['"]([a-z_]+)['"]/);
      if (t) allTables.add(t[1]);
    }
    for (const m of restTableMatches) {
      const t = m.match(/\/rest\/v1\/([a-z_]+)/);
      if (t) allTables.add(t[1]);
    }
    result.supabase_tables_used = Array.from(allTables);

    // Extract router export name
    const routerExport = content.match(/export\s+(?:const|let|default)\s+(\w*[Rr]outer\w*)/);
    if (routerExport) {
      result.router_export_name = routerExport[1];
    }

    // Check for obvious error patterns
    const errorPatterns = [
      { pattern: /throw\s+new\s+Error/g, desc: 'explicit throw' },
      { pattern: /JSON\.parse\s*\(/g, desc: 'JSON.parse without try/catch' },
      { pattern: /\.body\s*!/g, desc: 'non-null assertion on body' },
    ];
    for (const { pattern, desc } of errorPatterns) {
      if (pattern.test(content)) {
        result.handler_has_errors = true;
        result.error_description = (result.error_description || '') + `; ${desc} detected`;
      }
    }

    // Find related service files from imports
    const serviceImports = result.imports.filter(
      (i) => i.includes('service') || i.includes('Service'),
    );
    // Anchor resolution to the route file's location under REPO_ROOT.
    // resolveImportPath is filesystem-based, so it can only find files that
    // also live in the local container. Imports that resolve to paths absent
    // from disk just don't get added — preferable to a stale guess.
    const anchorAbs = path.join(REPO_ROOT, relativeFile);
    for (const imp of serviceImports) {
      const resolved = resolveImportPath(anchorAbs, imp);
      if (resolved) {
        result.related_service_files.push(path.relative(REPO_ROOT, resolved));
      }
    }
  } catch (err: any) {
    result.evidence.push(`Failed to read route file: ${err.message}`);
    evidence.push(`Codebase analysis degraded: ${err.message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Layer 3: Git History
// ---------------------------------------------------------------------------

function analyzeGitHistory(
  failure: ServiceStatus,
  codebase: CodebaseAnalysis,
  evidence: string[],
): GitAnalysis {
  const result: GitAnalysis = {
    latest_commit: null,
    last_modified: null,
    recent_commits: [],
    breaking_commit: null,
    code_exists_but_not_deployed: false,
    deployed_sha: null,
    evidence: [],
  };

  if (!codebase.route_file) {
    result.evidence.push('No route file known — skipping git analysis');
    return result;
  }

  try {
    // Latest commit on the repo
    const headSha = gitExec('git rev-parse --short HEAD');
    result.latest_commit = headSha;

    // Last modified date of the route file
    const lastMod = gitExec(`git log -1 --format=%ci -- ${codebase.route_file}`);
    result.last_modified = lastMod || null;

    // Recent commits touching the route file
    const logLines = gitExec(
      `git log --oneline --format="%H|%s|%ci|%an" -10 -- ${codebase.route_file}`,
    );
    if (logLines) {
      for (const line of logLines.split('\n').filter(Boolean)) {
        const [sha, message, date, author] = line.split('|');
        if (sha) {
          result.recent_commits.push({ sha, message: message || '', date: date || '', author: author || '' });
        }
      }
    }

    // Check for potential breaking commit (look for keywords)
    for (const commit of result.recent_commits) {
      const msg = commit.message.toLowerCase();
      if (
        msg.includes('refactor') ||
        msg.includes('remove') ||
        msg.includes('delete') ||
        msg.includes('rename') ||
        msg.includes('breaking') ||
        msg.includes('migrate')
      ) {
        result.breaking_commit = commit;
        result.evidence.push(`Potential breaking commit: ${commit.sha} "${commit.message}"`);
        evidence.push(`Suspect commit: ${commit.sha} — ${commit.message}`);

        // Get diff summary for the breaking commit
        const diffSummary = gitExec(`git diff --stat ${commit.sha}^..${commit.sha} -- ${codebase.route_file}`);
        if (diffSummary) {
          commit.diff_summary = diffSummary;
        }
        break;
      }
    }

    // Deploy drift detection: check if deployed SHA differs
    const deployedSha = process.env.DEPLOY_SHA || process.env.K_REVISION || null;
    if (deployedSha) {
      result.deployed_sha = deployedSha;
      if (headSha && deployedSha !== headSha) {
        result.code_exists_but_not_deployed = true;
        result.evidence.push(`Deploy drift detected: HEAD=${headSha}, deployed=${deployedSha}`);
        evidence.push(`Stale deployment: code at ${headSha} but deployed revision is ${deployedSha}`);
      }
    }

    if (result.recent_commits.length > 0) {
      result.evidence.push(
        `${result.recent_commits.length} recent commits found for ${codebase.route_file}`,
      );
    }
  } catch (err: any) {
    result.evidence.push(`Git analysis unavailable: ${err.message}`);
    evidence.push('Git history unavailable (expected on Cloud Run)');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Layer 4: Dependency Analysis
// ---------------------------------------------------------------------------

function analyzeDependencies(
  codebase: CodebaseAnalysis,
  evidence: string[],
): DependencyAnalysis {
  const result: DependencyAnalysis = {
    missing_import: null,
    missing_env_vars: [],
    missing_db_table: null,
    evidence: [],
  };

  if (!codebase.route_file || !codebase.route_file_exists) {
    result.evidence.push('No route file available — skipping dependency analysis');
    return result;
  }

  const routeDir = path.dirname(path.join(REPO_ROOT, codebase.route_file));

  // Check if imported files exist
  for (const imp of codebase.imports) {
    const resolved = resolveImportPath(path.join(REPO_ROOT, codebase.route_file), imp);
    if (resolved === null) {
      result.missing_import = imp;
      result.evidence.push(`Missing import: ${imp} (file not found)`);
      evidence.push(`Import "${imp}" resolves to a file that does not exist`);
      break;
    }
  }

  // Check env vars that are likely required but may be missing at runtime
  const criticalEnvVars = codebase.env_vars_used.filter((v) => {
    // Skip vars that have well-known defaults or are optional
    const optional = ['NODE_ENV', 'PORT', 'LOG_LEVEL', 'DEBUG'];
    return !optional.includes(v);
  });

  for (const envVar of criticalEnvVars) {
    if (!process.env[envVar]) {
      result.missing_env_vars.push(envVar);
    }
  }

  if (result.missing_env_vars.length > 0) {
    result.evidence.push(`Missing env vars at runtime: ${result.missing_env_vars.join(', ')}`);
    evidence.push(`${result.missing_env_vars.length} env var(s) used but not set: ${result.missing_env_vars.join(', ')}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Layer 5: Workflow Analysis
// ---------------------------------------------------------------------------

async function analyzeWorkflow(
  failure: ServiceStatus,
  codebase: CodebaseAnalysis,
  evidence: string[],
  filesRead: string[],
  sourceCache?: Map<string, LoadedSource>,
): Promise<WorkflowAnalysis> {
  const result: WorkflowAnalysis = {
    route_mounted_in_index: false,
    mount_path: null,
    middleware_chain: [],
    middleware_blocking: false,
    blocking_middleware: null,
    auth_required: false,
    health_exempt_from_auth: false,
    evidence: [],
  };

  // PR-F (VTID-02933, Gap 2): Cloud Run revisions don't carry the source
  // tree under REPO_ROOT, so the old fs-only read of index.ts ENOENT-failed
  // on every live diagnosis. That falsely synthesized route_mounted_in_index
  // = false on EVERY endpoint and tipped the synthesizer into proposing
  // `files_to_modify=['services/gateway/src/index.ts']`. The autopilot
  // safety gate then (correctly) blocked edits to that high-blast-radius
  // file at "safety gate blocked approval", which surfaced as Gap 1 in the
  // VTID-02928 smoke run. Routing the same loadSourceFile() PR-C uses
  // fixes it: fs → deployed SHA → ref=main, with the same redaction
  // contract.
  let indexContent: string | null = null;
  try {
    const loaded = await loadSourceFile('services/gateway/src/index.ts', sourceCache);
    if (loaded.found && loaded.content) {
      indexContent = loaded.content;
      filesRead.push('services/gateway/src/index.ts');
      if (loaded.source !== 'fs') {
        result.evidence.push(
          `index.ts loaded via ${loaded.source}` +
            (loaded.sha ? ` (sha=${loaded.sha.substring(0, 7)})` : ''),
        );
      }
    }
  } catch (err: any) {
    result.evidence.push(`Cannot read index.ts: ${err.message}`);
    evidence.push('Workflow analysis degraded: index.ts unreadable');
    return result;
  }

  if (!indexContent) {
    result.evidence.push('index.ts not found via fs OR GitHub — cannot verify route mounting');
    return result;
  }

  // Derive the mount path from the endpoint
  // e.g., /api/v1/capacity/health → mount path is /api/v1/capacity
  const endpointParts = failure.endpoint.split('/');
  endpointParts.pop(); // remove "health"
  const expectedMountPath = endpointParts.join('/') || '/';

  // Check for mountRouterSync or app.use with this path
  const mountPattern = new RegExp(
    `(?:mountRouterSync|app\\.use)\\s*\\(\\s*(?:app\\s*,\\s*)?['\`"]${escapeRegex(expectedMountPath)}['\`"]`,
  );
  result.route_mounted_in_index = mountPattern.test(indexContent);
  if (result.route_mounted_in_index) {
    result.mount_path = expectedMountPath;
    result.evidence.push(`Route mounted at ${expectedMountPath} in index.ts`);
  } else {
    result.evidence.push(`Route NOT mounted at ${expectedMountPath} in index.ts`);
    evidence.push(`Route ${expectedMountPath} not found in index.ts mount statements`);
  }

  // Check for auth middleware
  if (codebase.route_file_content) {
    const hasAuthMiddleware =
      codebase.route_file_content.includes('authMiddleware') ||
      codebase.route_file_content.includes('requireAuth') ||
      codebase.route_file_content.includes('verifyToken') ||
      codebase.route_file_content.includes('auth-supabase-jwt');
    result.auth_required = hasAuthMiddleware;

    if (hasAuthMiddleware) {
      result.middleware_chain.push('auth');

      // Check if health endpoint is exempt
      const healthExemptPatterns = [
        /health.*(?:no\s*auth|skip\s*auth|exempt)/i,
        /(?:get|all)\s*\(\s*['"]\/health['"]\s*,\s*\(/,
        /\/health.*(?:public|open)/i,
      ];
      result.health_exempt_from_auth = healthExemptPatterns.some((p) =>
        p.test(codebase.route_file_content!),
      );

      if (!result.health_exempt_from_auth) {
        result.evidence.push('Health endpoint may require auth — could block health checks');
        result.middleware_blocking = true;
        result.blocking_middleware = 'auth';
      }
    }
  }

  // Check for CORS, rate-limiting, or other middleware in index.ts
  if (indexContent.includes('cors')) result.middleware_chain.push('cors');
  if (indexContent.includes('rateLimit') || indexContent.includes('rate-limit'))
    result.middleware_chain.push('rate-limit');
  if (indexContent.includes('helmet')) result.middleware_chain.push('helmet');

  return result;
}

// ---------------------------------------------------------------------------
// Layer 6: OASIS Correlation
// ---------------------------------------------------------------------------

async function correlateOasis(
  failure: ServiceStatus,
  vtid: string,
  evidence: string[],
): Promise<{ oasisEvidence: string[]; priorAttempts: number }> {
  const oasisEvidence: string[] = [];
  let priorAttempts = 0;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    evidence.push('OASIS correlation skipped: Supabase not configured');
    return { oasisEvidence, priorAttempts };
  }

  try {
    // Query recent OASIS events related to this service
    const serviceName = failure.name.toLowerCase().replace(/\s+/g, '-');
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const eventsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?` +
        `or=(message.ilike.*${encodeURIComponent(serviceName)}*,topic.ilike.*${encodeURIComponent(serviceName)}*)` +
        `&created_at=gte.${oneHourAgo}` +
        `&order=created_at.desc` +
        `&limit=10`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      },
    );

    if (eventsResp.ok) {
      const events = (await eventsResp.json()) as Array<{
        topic: string;
        status: string;
        message: string;
        created_at: string;
        vtid: string;
      }>;

      if (events.length > 0) {
        oasisEvidence.push(`${events.length} recent OASIS events found for ${serviceName}`);
        evidence.push(`OASIS: ${events.length} events in last hour for ${serviceName}`);

        // Look for error events
        const errorEvents = events.filter((e) => e.status === 'error');
        if (errorEvents.length > 0) {
          evidence.push(
            `OASIS: ${errorEvents.length} error events — latest: "${errorEvents[0].message}"`,
          );
        }
      } else {
        oasisEvidence.push(`No recent OASIS events for ${serviceName}`);
      }
    }

    // Check vtid_ledger for prior self-healing attempts on this endpoint
    const ledgerResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?` +
        `source=eq.self-healing-diagnosis` +
        `&order=created_at.desc` +
        `&limit=5`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      },
    );

    if (ledgerResp.ok) {
      const ledgerEntries = (await ledgerResp.json()) as Array<{
        vtid: string;
        source: string;
        created_at: string;
        status: string;
      }>;

      priorAttempts = ledgerEntries.length;
      if (priorAttempts > 0) {
        evidence.push(
          `${priorAttempts} prior self-healing attempt(s) found in vtid_ledger`,
        );
        oasisEvidence.push(`Prior VTIDs: ${ledgerEntries.map((e) => e.vtid).join(', ')}`);
      }
    }
  } catch (err: any) {
    evidence.push(`OASIS correlation failed: ${err.message}`);
  }

  return { oasisEvidence, priorAttempts };
}

// ---------------------------------------------------------------------------
// Synthesis: combine all 6 layers into a final verdict
// ---------------------------------------------------------------------------

function synthesize(
  failure: ServiceStatus,
  httpClass: FailureClass,
  httpConf: number,
  httpCause: string,
  httpFix: string,
  codebase: CodebaseAnalysis,
  git: GitAnalysis,
  deps: DependencyAnalysis,
  workflow: WorkflowAnalysis,
  evidence: string[],
  filesToModify: string[],
  priorAttempts: number,
): {
  finalClass: FailureClass;
  finalConfidence: number;
  finalCause: string;
  finalFix: string;
} {
  let finalClass = httpClass;
  let finalConfidence = httpConf;
  let finalCause = httpCause;
  let finalFix = httpFix;

  // --- Override: route not mounted takes precedence ---
  if (
    codebase.route_file_exists &&
    !workflow.route_mounted_in_index &&
    codebase.route_file !== 'services/gateway/src/index.ts'
  ) {
    finalClass = FailureClass.ROUTE_NOT_REGISTERED;
    finalConfidence = 0.9;
    finalCause = `Route file exists at ${codebase.route_file} but is not mounted in index.ts`;
    finalFix = `Add mountRouterSync(app, '${workflow.mount_path || failure.endpoint.replace(/\/health$/, '')}', router) to index.ts`;
    if (codebase.route_file) filesToModify.push('services/gateway/src/index.ts');
    return { finalClass, finalConfidence, finalCause, finalFix };
  }

  // --- Override: route file missing entirely ---
  if (codebase.route_file && !codebase.route_file_exists) {
    finalClass = FailureClass.IMPORT_ERROR;
    finalConfidence = 0.85;
    finalCause = `Route file ${codebase.route_file} does not exist on disk`;
    finalFix = `Create the route file ${codebase.route_file} with a health endpoint`;
    filesToModify.push(codebase.route_file);
    return { finalClass, finalConfidence, finalCause, finalFix };
  }

  // --- Override: missing import ---
  if (deps.missing_import) {
    finalClass = FailureClass.IMPORT_ERROR;
    finalConfidence = Math.max(finalConfidence, 0.85);
    finalCause = `Import "${deps.missing_import}" in ${codebase.route_file} resolves to a missing file`;
    finalFix = `Create or fix the import "${deps.missing_import}"`;
    if (codebase.route_file) filesToModify.push(codebase.route_file);
    return { finalClass, finalConfidence, finalCause, finalFix };
  }

  // --- Override: missing env var with high-signal body ---
  if (
    deps.missing_env_vars.length > 0 &&
    (httpClass === FailureClass.MISSING_ENV_VAR || httpClass === FailureClass.HANDLER_CRASH)
  ) {
    finalClass = FailureClass.MISSING_ENV_VAR;
    finalConfidence = Math.max(finalConfidence, 0.8);
    finalCause = `Missing environment variable(s): ${deps.missing_env_vars.join(', ')}`;
    finalFix = `Set ${deps.missing_env_vars.join(', ')} in Cloud Run environment`;
    return { finalClass, finalConfidence, finalCause, finalFix };
  }

  // --- Override: health handler missing ---
  if (codebase.route_file_exists && !codebase.health_handler_exists) {
    finalClass = FailureClass.HANDLER_CRASH;
    finalConfidence = Math.max(finalConfidence, 0.75);
    finalCause = `No health handler found in ${codebase.route_file}`;
    finalFix = `Add a GET /health handler to ${codebase.route_file}`;
    if (codebase.route_file) filesToModify.push(codebase.route_file);
    return { finalClass, finalConfidence, finalCause, finalFix };
  }

  // --- Override: stale deployment from git ---
  if (git.code_exists_but_not_deployed) {
    finalClass = FailureClass.STALE_DEPLOYMENT;
    finalConfidence = Math.max(finalConfidence, 0.75);
    finalCause = `Code at HEAD (${git.latest_commit}) differs from deployed revision (${git.deployed_sha})`;
    finalFix = 'Trigger a new deployment to sync code with deployed version';
    return { finalClass, finalConfidence, finalCause, finalFix };
  }

  // --- Override: regression from git ---
  if (git.breaking_commit) {
    if (finalClass === FailureClass.HANDLER_CRASH || finalClass === FailureClass.UNKNOWN) {
      finalClass = FailureClass.REGRESSION;
      finalConfidence = Math.max(finalConfidence, 0.7);
      finalCause = `Potential regression from commit ${git.breaking_commit.sha}: "${git.breaking_commit.message}"`;
      finalFix = `Review commit ${git.breaking_commit.sha} and revert if necessary`;
      if (codebase.route_file) filesToModify.push(codebase.route_file);
    }
  }

  // --- Override: middleware blocking ---
  if (workflow.middleware_blocking && httpClass === FailureClass.MIDDLEWARE_REJECTION) {
    finalConfidence = Math.max(finalConfidence, 0.8);
    finalCause = `Auth middleware (${workflow.blocking_middleware}) is blocking health endpoint`;
    finalFix = 'Exempt the /health endpoint from auth middleware';
    if (codebase.route_file) filesToModify.push(codebase.route_file);
  }

  // --- Confidence adjustments ---

  // E2E test failures: cap confidence at 0.6 to FORCE triage agent investigation.
  // The deterministic classifier matches against the health endpoint, but E2E
  // failures are about frontend rendering (CSS, DOM, widget lifecycle) — a
  // fundamentally different failure surface. Letting the classifier auto-approve
  // at 0.85 produces wrong fixes that pass health checks but don't fix the
  // actual test failures, creating an infinite loop.
  const errorStr = ((failure as any).error_message || '') + ((failure as any).response_body || '');
  const isE2eSource = /e2e|playwright|E2E|Playwright|orb.widget.test/i.test(errorStr);
  if (isE2eSource) {
    finalConfidence = Math.min(finalConfidence, 0.6);
    evidence.push('E2E test failure detected — confidence capped at 0.6 to force triage agent deep analysis');
  }

  // Boost if codebase evidence confirms
  if (codebase.route_file_exists && codebase.health_handler_exists && !isE2eSource) {
    finalConfidence = Math.min(finalConfidence + 0.05, 1.0);
  }

  // Penalize if prior attempts exist (recurring issue) — scales with attempts
  if (priorAttempts > 0) {
    const penalty = Math.min(priorAttempts * 0.08, 0.4);
    finalConfidence = Math.max(finalConfidence - penalty, 0.1);
    evidence.push(`Recurring issue: ${priorAttempts} prior attempt(s) — confidence reduced by ${(penalty * 100).toFixed(0)}%`);
  }

  // Populate files to modify if not yet set
  if (filesToModify.length === 0 && codebase.route_file) {
    filesToModify.push(codebase.route_file);
  }

  return { finalClass, finalConfidence, finalCause, finalFix };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function suggestFixForClass(fc: FailureClass, endpoint: string): string {
  switch (fc) {
    case FailureClass.HANDLER_CRASH:
      return `Fix the unhandled exception in the handler for ${endpoint}`;
    case FailureClass.IMPORT_ERROR:
      return `Fix the broken import in the route file for ${endpoint}`;
    case FailureClass.MISSING_ENV_VAR:
      return `Set the required environment variable in Cloud Run config`;
    case FailureClass.DATABASE_SCHEMA_DRIFT:
      return `Run database migration or fix table reference for ${endpoint}`;
    case FailureClass.EXTERNAL_DEPENDENCY:
      return `Check external service connectivity and add retry/fallback`;
    case FailureClass.ROUTE_NOT_REGISTERED:
      return `Register the route in index.ts`;
    default:
      return `Investigate and fix the issue at ${endpoint}`;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractQuotedString(text: string | null): string {
  if (!text) return 'unknown module';
  const match = text.match(/['"]([^'"]+)['"]/);
  return match ? match[1] : 'unknown module';
}

function gitExec(cmd: string): string {
  try {
    return execSync(cmd, { cwd: REPO_ROOT, timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function resolveImportPath(fromFile: string, importPath: string): string | null {
  const dir = path.dirname(fromFile);
  const candidates = [
    path.resolve(dir, importPath + '.ts'),
    path.resolve(dir, importPath + '.js'),
    path.resolve(dir, importPath, 'index.ts'),
    path.resolve(dir, importPath, 'index.js'),
    path.resolve(dir, importPath),
  ];
  try {
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // fs.existsSync can throw in restricted environments
  }
  return null;
}
