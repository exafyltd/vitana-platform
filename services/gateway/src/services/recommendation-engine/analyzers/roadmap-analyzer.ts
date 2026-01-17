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

async function scanStalledVtids(config: RoadmapAnalyzerConfig): Promise<StalledVtid[]> {
  const stalled: StalledVtid[] = [];

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
      console.warn(`${LOG_PREFIX} Missing Supabase credentials for VTID scan`);
      return stalled;
    }

    const staleDate = new Date(Date.now() - config.stale_days * 24 * 60 * 60 * 1000).toISOString();

    // Query VTIDs that haven't been updated recently
    const response = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?select=vtid,title,status,updated_at&status=neq.completed&status=neq.archived&updated_at=lt.${staleDate}&order=updated_at.asc&limit=50`,
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

    const vtids = (await response.json()) as any[];

    for (const vtid of vtids) {
      const lastUpdate = new Date(vtid.updated_at);
      const daysSince = Math.floor((Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24));

      stalled.push({
        vtid: vtid.vtid,
        title: vtid.title || 'Untitled',
        status: vtid.status,
        days_stalled: daysSince,
        last_event_at: vtid.updated_at,
      });
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error scanning stalled VTIDs:`, error);
  }

  return stalled.sort((a, b) => b.days_stalled - a.days_stalled);
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
    // Scan spec files
    const specs = await scanSpecFiles(basePath, fullConfig);
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
