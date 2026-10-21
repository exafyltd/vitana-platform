/**
 * Roadmap Analyzer - VTID-01185
 *
 * Analyzes roadmap and planning artifacts:
 * - Unimplemented specs in docs/specs/
 * - Stalled VTIDs in the ledger
 * - Open GitHub issues
 */

import { createHash } from 'crypto';

const LOG_PREFIX = '[VTID-01185:Roadmap]';

// =============================================================================
// Types
// =============================================================================

export interface RoadmapSignal {
  type: 'unimplemented_spec' | 'stalled_vtid' | 'open_issue';
  severity: 'low' | 'medium' | 'high';
  reference: string;
  title: string;
  message: string;
  days_pending?: number;
  suggested_action: string;
}

export interface RoadmapAnalysisResult {
  ok: boolean;
  signals: RoadmapSignal[];
  summary: {
    specs_found: number;
    unimplemented_specs: number;
    stalled_vtids: number;
    open_issues: number;
    duration_ms: number;
  };
  error?: string;
}

export interface RoadmapAnalyzerConfig {
  spec_paths: string[];
  stale_days: number;
  check_github_issues: boolean;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: RoadmapAnalyzerConfig = {
  spec_paths: ['docs/specs/'],
  stale_days: 30,
  check_github_issues: false, // Disabled by default (requires GitHub API)
};

// =============================================================================
// Spec File Scanner
// =============================================================================

interface SpecFile {
  path: string;
  vtid: string;
  title: string;
  status: 'specified' | 'in_progress' | 'completed' | 'unknown';
  created_date?: string;
}

async function scanSpecFiles(basePath: string, config: RoadmapAnalyzerConfig): Promise<SpecFile[]> {
  const specs: SpecFile[] = [];

  try {
    const { execSync } = await import('child_process');
    const { readFileSync } = await import('fs');

    for (const specPath of config.spec_paths) {
      try {
        const fullPath = `${basePath}/${specPath}`;
        const cmd = `find ${fullPath} -name "*.md" -type f 2>/dev/null || true`;
        const result = execSync(cmd, { maxBuffer: 10 * 1024 * 1024 }).toString();

        for (const filePath of result.split('\n')) {
          if (!filePath.trim()) continue;

          try {
            const content = readFileSync(filePath, 'utf-8');

            // Extract VTID from filename or content
            const vtidMatch =
              filePath.match(/VTID[_-]?(\d{4,5})/i) || content.match(/VTID[:\s]*(\d{4,5})/i);
            const vtid = vtidMatch ? `VTID-${vtidMatch[1]}` : null;

            if (!vtid) continue;

            // Extract title from first heading
            const titleMatch = content.match(/^#\s+(.+)$/m);
            const title = titleMatch ? titleMatch[1].replace(/VTID[_-]?\d{4,5}:?\s*/i, '') : filePath;

            // Extract status
            let status: SpecFile['status'] = 'unknown';
            if (/status[:\s]*specified/i.test(content)) status = 'specified';
            else if (/status[:\s]*(in[_\s]?progress|implementing)/i.test(content))
              status = 'in_progress';
            else if (/status[:\s]*(complete|done|implemented)/i.test(content)) status = 'completed';

            // Extract created date
            const dateMatch = content.match(/created[:\s]*(\d{4}-\d{2}-\d{2})/i);

            specs.push({
              path: filePath.replace(basePath + '/', ''),
              vtid,
              title: title.trim(),
              status,
              created_date: dateMatch ? dateMatch[1] : undefined,
            });
          } catch {
            // Failed to read file, skip
          }
        }
      } catch {
        // Path doesn't exist, continue
      }
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error scanning spec files:`, error);
  }

  return specs;
}

// =============================================================================
// Stalled VTID Scanner
// =============================================================================

interface StalledVtid {
  vtid: string;
  title: string;
  status: string;
  days_stalled: number;
  last_event_at: string;
}

/**
 * VTID-04666: ledger statuses that are never "stalled work". Terminal or
 * abandoned rows (voided / deleted / rejected / cancelled), finished rows,
 * and bare `allocated` shells nobody approved.
 */
export const NON_STALLABLE_VTID_STATUSES = [
  'completed',
  'archived',
  'voided',
  'deleted',
  'rejected',
  'cancelled',
  'allocated',
] as const;

/** VTID-04666: a VTID untouched for longer than this is dead, not stalled. */
export const STALLED_VTID_MAX_AGE_DAYS = 365;

export interface LedgerRowForStall {
  vtid: string;
  title?: string | null;
  status?: string | null;
  spec_status?: string | null;
  is_terminal?: boolean | null;
  updated_at: string;
}

/**
 * VTID-04666: pure predicate mirroring the PostgREST filter, applied again
 * in JS so a row the query let through (or a future query change) can never
 * surface terminal / unapproved / ancient work as "stalled".
 */
export function isStalledVtidCandidate(
  row: LedgerRowForStall,
  nowMs: number,
  staleDays: number,
  maxAgeDays: number = STALLED_VTID_MAX_AGE_DAYS,
): boolean {
  if (!row || !row.vtid || !row.updated_at) return false;
  if (row.is_terminal === true) return false;
  const status = String(row.status || '').toLowerCase();
  if ((NON_STALLABLE_VTID_STATUSES as readonly string[]).includes(status)) return false;
  if (String(row.spec_status || '').toLowerCase() !== 'approved') return false;
  const updatedMs = new Date(row.updated_at).getTime();
  if (!Number.isFinite(updatedMs)) return false;
  const ageDays = (nowMs - updatedMs) / 86400000;
  return ageDays >= staleDays && ageDays <= maxAgeDays;
}

/** VTID-04666: the PostgREST query for stalled VTIDs (exported for tests). */
export function buildStalledVtidQuery(nowMs: number, staleDays: number, maxAgeDays: number = STALLED_VTID_MAX_AGE_DAYS): string {
  const staleDate = new Date(nowMs - staleDays * 86400000).toISOString();
  const maxAgeDate = new Date(nowMs - maxAgeDays * 86400000).toISOString();
  return (
    'select=vtid,title,status,spec_status,is_terminal,updated_at' +
    `&status=not.in.(${NON_STALLABLE_VTID_STATUSES.join(',')})` +
    '&is_terminal=not.is.true' +
    '&spec_status=eq.approved' +
    `&updated_at=lt.${staleDate}` +
    `&updated_at=gt.${maxAgeDate}` +
    // Newest-stalled first: the most recently active approved work is the
    // most likely to still matter.
    '&order=updated_at.desc&limit=50'
  );
}

async function scanStalledVtids(config: RoadmapAnalyzerConfig): Promise<StalledVtid[]> {
  const stalled: StalledVtid[] = [];

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
      console.warn(`${LOG_PREFIX} Missing Supabase credentials for VTID scan`);
      return stalled;
    }

    const nowMs = Date.now();

    // VTID-04666: only approved, non-terminal work that went quiet between
    // stale_days and STALLED_VTID_MAX_AGE_DAYS ago. The old query excluded
    // only completed/archived, so voided / deleted / terminal VTIDs were
    // recommended ("stalled in voided — no activity for 9765 days").
    const response = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?${buildStalledVtidQuery(nowMs, config.stale_days)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!response.ok) {
      console.warn(`${LOG_PREFIX} Failed to query VTID ledger:`, response.status);
      return stalled;
    }

    const vtids = (await response.json()) as LedgerRowForStall[];

    for (const vtid of vtids) {
      if (!isStalledVtidCandidate(vtid, nowMs, config.stale_days)) continue;
      const lastUpdate = new Date(vtid.updated_at);
      const daysSince = Math.floor((nowMs - lastUpdate.getTime()) / (1000 * 60 * 60 * 24));

      stalled.push({
        vtid: vtid.vtid,
        title: vtid.title || 'Untitled',
        status: String(vtid.status || ''),
        days_stalled: daysSince,
        last_event_at: vtid.updated_at,
      });
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error scanning stalled VTIDs:`, error);
  }

  // VTID-04666: newest-stalled first (was oldest first).
  return stalled.sort((a, b) => a.days_stalled - b.days_stalled);
}

// =============================================================================
// GitHub Issues Scanner (Optional)
// =============================================================================

interface GitHubIssue {
  number: number;
  title: string;
  labels: string[];
  created_at: string;
  days_open: number;
}

async function scanGitHubIssues(): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];

  try {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      console.warn(`${LOG_PREFIX} GitHub token not configured, skipping issue scan`);
      return issues;
    }

    // This would query GitHub API for open issues
    // Skipping actual implementation to avoid rate limits
  } catch (error) {
    console.error(`${LOG_PREFIX} Error scanning GitHub issues:`, error);
  }

  return issues;
}

// =============================================================================
// Main Analyzer Function
// =============================================================================

export async function analyzeRoadmap(
  basePath: string,
  config: Partial<RoadmapAnalyzerConfig> = {}
): Promise<RoadmapAnalysisResult> {
  const startTime = Date.now();
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const signals: RoadmapSignal[] = [];

  console.log(`${LOG_PREFIX} Starting roadmap analysis...`);

  try {
    // Check if basePath exists (it won't on Cloud Run)
    const { existsSync } = await import('fs');
    const specPathExists = fullConfig.spec_paths.some(p => {
      try { return existsSync(`${basePath}/${p}`); } catch { return false; }
    });

    // Scan spec files (skip if path doesn't exist)
    const specs = specPathExists ? await scanSpecFiles(basePath, fullConfig) : [];
    const unimplementedSpecs = specs.filter((s) => s.status === 'specified');

    // Convert to signals
    for (const spec of unimplementedSpecs) {
      const daysPending = spec.created_date
        ? Math.floor((Date.now() - new Date(spec.created_date).getTime()) / (1000 * 60 * 60 * 24))
        : undefined;

      const severity =
        daysPending && daysPending > 60 ? 'high' : daysPending && daysPending > 30 ? 'medium' : 'low';

      signals.push({
        type: 'unimplemented_spec',
        severity,
        reference: spec.vtid,
        title: spec.title,
        message: `Unimplemented spec: ${spec.vtid} - ${spec.title}${
          daysPending ? ` (pending ${daysPending} days)` : ''
        }`,
        days_pending: daysPending,
        suggested_action: `Implement ${spec.vtid}: ${spec.title}`,
      });
    }

    // Scan stalled VTIDs
    const stalledVtids = await scanStalledVtids(fullConfig);

    for (const vtid of stalledVtids) {
      const severity = vtid.days_stalled > 60 ? 'high' : vtid.days_stalled > 30 ? 'medium' : 'low';

      signals.push({
        type: 'stalled_vtid',
        severity,
        reference: vtid.vtid,
        title: vtid.title,
        message: `Stalled task: ${vtid.vtid} (${vtid.status}) - no activity for ${vtid.days_stalled} days`,
        days_pending: vtid.days_stalled,
        suggested_action: `Unblock ${vtid.vtid}: ${vtid.title} (stalled in ${vtid.status})`,
      });
    }

    // Optionally scan GitHub issues
    if (fullConfig.check_github_issues) {
      const issues = await scanGitHubIssues();

      for (const issue of issues) {
        const severity = issue.days_open > 90 ? 'high' : issue.days_open > 30 ? 'medium' : 'low';

        signals.push({
          type: 'open_issue',
          severity,
          reference: `#${issue.number}`,
          title: issue.title,
          message: `Open GitHub issue #${issue.number}: ${issue.title} (${issue.days_open} days)`,
          days_pending: issue.days_open,
          suggested_action: `Address GitHub issue #${issue.number}: ${issue.title}`,
        });
      }
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Analysis complete: ${signals.length} items found in ${duration}ms`);

    return {
      ok: true,
      signals,
      summary: {
        specs_found: specs.length,
        unimplemented_specs: unimplementedSpecs.length,
        stalled_vtids: stalledVtids.length,
        open_issues: 0,
        duration_ms: duration,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Analysis failed:`, errorMessage);

    return {
      ok: false,
      signals: [],
      summary: {
        specs_found: 0,
        unimplemented_specs: 0,
        stalled_vtids: 0,
        open_issues: 0,
        duration_ms: Date.now() - startTime,
      },
      error: errorMessage,
    };
  }
}

// =============================================================================
// Fingerprint Generator
// =============================================================================

export function generateRoadmapFingerprint(signal: RoadmapSignal): string {
  const data = `roadmap:${signal.type}:${signal.reference}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}
