/**
 * Recommendation Generator - VTID-01185
 *
 * Orchestrates analyzers and generates recommendations using Claude AI.
 * Handles deduplication, scoring, and persistence.
 */

import { createHash } from 'crypto';
import {
  analyzeCodebase,
  CodebaseSignal,
  generateFingerprint as codebaseFingerprint,
} from './analyzers/codebase-analyzer';
import {
  analyzeOasisEvents,
  OasisSignal,
  generateFingerprint as oasisFingerprint,
} from './analyzers/oasis-analyzer';
import {
  analyzeSystemHealth,
  HealthSignal,
  generateFingerprint as healthFingerprint,
} from './analyzers/health-analyzer';
import {
  analyzeRoadmap,
  RoadmapSignal,
  generateFingerprint as roadmapFingerprint,
} from './analyzers/roadmap-analyzer';

const LOG_PREFIX = '[VTID-01185:Generator]';

// =============================================================================
// Types
// =============================================================================

export type SourceType = 'codebase' | 'oasis' | 'health' | 'roadmap';

export interface GeneratedRecommendation {
  title: string;
  summary: string;
  domain: string;
  impact_score: number;
  effort_score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  source_type: SourceType;
  source_ref: string;
  fingerprint: string;
  suggested_files: string[];
  suggested_endpoints: string[];
  suggested_tests: string[];
}

export interface GenerationResult {
  ok: boolean;
  run_id: string;
  generated: number;
  duplicates_skipped: number;
  errors: Array<{ source: string; error: string }>;
  duration_ms: number;
  analysis_summary: Record<string, unknown>;
}

export interface GenerationConfig {
  sources: SourceType[];
  limit: number;
  force: boolean;
  triggered_by?: string;
  trigger_type?: 'manual' | 'scheduled' | 'pr_merge' | 'webhook';
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: GenerationConfig = {
  sources: ['codebase', 'oasis', 'health', 'roadmap'],
  limit: 20,
  force: false,
  trigger_type: 'manual',
};

// =============================================================================
// Supabase RPC Helpers
// =============================================================================

async function callRpc<T>(
  functionName: string,
  params: Record<string, unknown>
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Signal to Recommendation Converter
// =============================================================================

function convertCodebaseSignal(signal: CodebaseSignal): GeneratedRecommendation {
  const domainMap: Record<string, string> = {
    todo: 'dev',
    large_file: 'dev',
    missing_tests: 'dev',
    dead_code: 'dev',
    duplication: 'dev',
    missing_docs: 'dev',
  };

  const impactMap: Record<string, number> = {
    todo: 5,
    large_file: 6,
    missing_tests: 7,
    dead_code: 4,
    duplication: 5,
    missing_docs: 3,
  };

  const effortMap: Record<string, number> = {
    todo: 3,
    large_file: 7,
    missing_tests: 5,
    dead_code: 4,
    duplication: 6,
    missing_docs: 2,
  };

  const severityToRisk: Record<string, 'low' | 'medium' | 'high'> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
  };

  return {
    title: signal.suggested_action.substring(0, 100),
    summary: signal.message,
    domain: domainMap[signal.type] || 'dev',
    impact_score: impactMap[signal.type] || 5,
    effort_score: effortMap[signal.type] || 5,
    risk_level: severityToRisk[signal.severity] || 'low',
    source_type: 'codebase',
    source_ref: `${signal.file_path}${signal.line_number ? ':' + signal.line_number : ''}`,
    fingerprint: codebaseFingerprint(signal),
    suggested_files: [signal.file_path],
    suggested_endpoints: [],
    suggested_tests: signal.type === 'missing_tests' ? ['unit'] : [],
  };
}

function convertOasisSignal(signal: OasisSignal): GeneratedRecommendation {
  const typeToTitle: Record<string, string> = {
    error_pattern: 'Fix recurring error',
    slow_endpoint: 'Optimize slow endpoint',
    failed_deploy: 'Investigate deploy failure',
    anomaly: 'Investigate anomaly',
    underused_feature: 'Review underused feature',
  };

  const impactMap: Record<string, number> = {
    error_pattern: 8,
    slow_endpoint: 7,
    failed_deploy: 9,
    anomaly: 6,
    underused_feature: 4,
  };

  return {
    title: `${typeToTitle[signal.type] || 'Address issue'}: ${signal.source.substring(0, 50)}`,
    summary: signal.message,
    domain: signal.type === 'failed_deploy' ? 'infra' : 'dev',
    impact_score: impactMap[signal.type] || 6,
    effort_score: signal.type === 'slow_endpoint' ? 6 : 5,
    risk_level: signal.severity === 'critical' ? 'critical' : signal.severity as 'low' | 'medium' | 'high',
    source_type: 'oasis',
    source_ref: signal.source,
    fingerprint: oasisFingerprint(signal),
    suggested_files: [],
    suggested_endpoints: signal.type === 'slow_endpoint' ? [signal.source] : [],
    suggested_tests: ['integration'],
  };
}

function convertHealthSignal(signal: HealthSignal): GeneratedRecommendation {
  const typeToTitle: Record<string, string> = {
    missing_index: 'Add database index',
    large_table: 'Implement data archival',
    missing_rls: 'Add RLS policy',
    env_gap: 'Configure environment variable',
    stale_migration: 'Apply pending migration',
  };

  const impactMap: Record<string, number> = {
    missing_index: 7,
    large_table: 6,
    missing_rls: 9,
    env_gap: 8,
    stale_migration: 5,
  };

  return {
    title: `${typeToTitle[signal.type] || 'Fix issue'}: ${signal.resource}`,
    summary: signal.message,
    domain: signal.type === 'missing_rls' ? 'security' : 'infra',
    impact_score: impactMap[signal.type] || 6,
    effort_score: signal.type === 'large_table' ? 8 : 4,
    risk_level: signal.severity === 'critical' ? 'critical' : signal.severity as 'low' | 'medium' | 'high',
    source_type: 'health',
    source_ref: signal.resource,
    fingerprint: healthFingerprint(signal),
    suggested_files: [],
    suggested_endpoints: [],
    suggested_tests: [],
  };
}

function convertRoadmapSignal(signal: RoadmapSignal): GeneratedRecommendation {
  return {
    title: signal.suggested_action.substring(0, 100),
    summary: signal.message,
    domain: 'dev',
    impact_score: signal.days_pending && signal.days_pending > 60 ? 8 : 6,
    effort_score: signal.type === 'unimplemented_spec' ? 7 : 5,
    risk_level: signal.severity as 'low' | 'medium' | 'high',
    source_type: 'roadmap',
    source_ref: signal.reference,
    fingerprint: roadmapFingerprint(signal),
    suggested_files: [],
    suggested_endpoints: [],
    suggested_tests: [],
  };
}

// =============================================================================
// Main Generator Function
// =============================================================================

export async function generateRecommendations(
  basePath: string,
  config: Partial<GenerationConfig> = {}
): Promise<GenerationResult> {
  const startTime = Date.now();
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const errors: Array<{ source: string; error: string }> = [];
  const recommendations: GeneratedRecommendation[] = [];
  const analysisSummary: Record<string, unknown> = {};

  console.log(`${LOG_PREFIX} Starting recommendation generation...`);
  console.log(`${LOG_PREFIX} Sources: ${fullConfig.sources.join(', ')}`);

  // Create run record
  const runResult = await callRpc<{ run_id: string }>('create_autopilot_recommendation_run', {
    p_sources: fullConfig.sources,
    p_trigger_type: fullConfig.trigger_type,
    p_triggered_by: fullConfig.triggered_by || null,
  });

  if (!runResult.ok || !runResult.data?.run_id) {
    console.error(`${LOG_PREFIX} Failed to create run record:`, runResult.error);
    return {
      ok: false,
      run_id: 'unknown',
      generated: 0,
      duplicates_skipped: 0,
      errors: [{ source: 'system', error: runResult.error || 'Failed to create run' }],
      duration_ms: Date.now() - startTime,
      analysis_summary: {},
    };
  }

  const runId = runResult.data.run_id;
  console.log(`${LOG_PREFIX} Run ID: ${runId}`);

  try {
    // Run analyzers for selected sources
    const analyzerPromises: Promise<void>[] = [];

    if (fullConfig.sources.includes('codebase')) {
      analyzerPromises.push(
        (async () => {
          await callRpc('update_autopilot_analyzer_source', {
            p_source_type: 'codebase',
            p_status: 'scanning',
          });

          const result = await analyzeCodebase(basePath);
          analysisSummary.codebase = result.summary;

          if (result.ok) {
            for (const signal of result.signals.slice(0, Math.ceil(fullConfig.limit / 4))) {
              recommendations.push(convertCodebaseSignal(signal));
            }
            await callRpc('update_autopilot_analyzer_source', {
              p_source_type: 'codebase',
              p_status: 'ready',
              p_items_scanned: result.summary.files_scanned,
              p_items_found: result.signals.length,
              p_last_scan_run_id: runId,
              p_last_scan_duration_ms: result.summary.duration_ms,
            });
          } else {
            errors.push({ source: 'codebase', error: result.error || 'Unknown error' });
            await callRpc('update_autopilot_analyzer_source', {
              p_source_type: 'codebase',
              p_status: 'error',
              p_last_error: result.error,
            });
          }
        })()
      );
    }

    if (fullConfig.sources.includes('oasis')) {
      analyzerPromises.push(
        (async () => {
          await callRpc('update_autopilot_analyzer_source', {
            p_source_type: 'oasis',
            p_status: 'scanning',
          });

          const result = await analyzeOasisEvents();
          analysisSummary.oasis = result.summary;

          if (result.ok) {
            for (const signal of result.signals.slice(0, Math.ceil(fullConfig.limit / 4))) {
              recommendations.push(convertOasisSignal(signal));
            }
            await callRpc('update_autopilot_analyzer_source', {
              p_source_type: 'oasis',
              p_status: 'ready',
              p_items_scanned: result.summary.events_analyzed,
              p_items_found: result.signals.length,
              p_last_scan_run_id: runId,
              p_last_scan_duration_ms: result.summary.duration_ms,
            });
          } else {
            errors.push({ source: 'oasis', error: result.error || 'Unknown error' });
            await callRpc('update_autopilot_analyzer_source', {
              p_source_type: 'oasis',
              p_status: 'error',
              p_last_error: result.error,
            });
          }
        })()
      );
    }

    if (fullConfig.sources.includes('health')) {
      analyzerPromises.push(
        (async () => {
          await callRpc('update_autopilot_analyzer_source', {
            p_source_type: 'health',
            p_status: 'scanning',
          });

          const result = await analyzeSystemHealth();
          analysisSummary.health = result.summary;

          if (result.ok) {
            for (const signal of result.signals.slice(0, Math.ceil(fullConfig.limit / 4))) {
              recommendations.push(convertHealthSignal(signal));
            }
            await callRpc('update_autopilot_analyzer_source', {
              p_source_type: 'health',
              p_status: 'ready',
              p_items_scanned: result.summary.checks_run,
              p_items_found: result.summary.issues_found,
              p_last_scan_run_id: runId,
              p_last_scan_duration_ms: result.summary.duration_ms,
            });
          } else {
            errors.push({ source: 'health', error: result.error || 'Unknown error' });
            await callRpc('update_autopilot_analyzer_source', {
              p_source_type: 'health',
              p_status: 'error',
              p_last_error: result.error,
            });
          }
        })()
      );
    }

    if (fullConfig.sources.includes('roadmap')) {
      analyzerPromises.push(
        (async () => {
          await callRpc('update_autopilot_analyzer_source', {
            p_source_type: 'roadmap',
            p_status: 'scanning',
          });

          const result = await analyzeRoadmap(basePath);
          analysisSummary.roadmap = result.summary;

          if (result.ok) {
            for (const signal of result.signals.slice(0, Math.ceil(fullConfig.limit / 4))) {
              recommendations.push(convertRoadmapSignal(signal));
            }
            await callRpc('update_autopilot_analyzer_source', {
              p_source_type: 'roadmap',
              p_status: 'ready',
              p_items_scanned: result.summary.specs_found,
              p_items_found: result.signals.length,
              p_last_scan_run_id: runId,
              p_last_scan_duration_ms: result.summary.duration_ms,
            });
          } else {
            errors.push({ source: 'roadmap', error: result.error || 'Unknown error' });
            await callRpc('update_autopilot_analyzer_source', {
              p_source_type: 'roadmap',
              p_status: 'error',
              p_last_error: result.error,
            });
          }
        })()
      );
    }

    // Wait for all analyzers
    await Promise.all(analyzerPromises);

    console.log(`${LOG_PREFIX} Analysis complete. ${recommendations.length} raw recommendations.`);

    // Insert recommendations with deduplication
    let generated = 0;
    let duplicatesSkipped = 0;

    for (const rec of recommendations.slice(0, fullConfig.limit)) {
      const insertResult = await callRpc<{ duplicate?: boolean }>('insert_autopilot_recommendation', {
        p_title: rec.title,
        p_summary: rec.summary,
        p_domain: rec.domain,
        p_risk_level: rec.risk_level,
        p_impact_score: rec.impact_score,
        p_effort_score: rec.effort_score,
        p_source_type: rec.source_type,
        p_source_ref: rec.source_ref,
        p_fingerprint: rec.fingerprint,
        p_run_id: runId,
        p_suggested_files: rec.suggested_files,
        p_suggested_endpoints: rec.suggested_endpoints,
        p_suggested_tests: rec.suggested_tests,
        p_expires_days: 30,
      });

      if (insertResult.ok) {
        if (insertResult.data?.duplicate) {
          duplicatesSkipped++;
        } else {
          generated++;
        }
      } else {
        errors.push({ source: rec.source_type, error: insertResult.error || 'Insert failed' });
      }
    }

    // Complete the run
    const duration = Date.now() - startTime;
    await callRpc('complete_autopilot_recommendation_run', {
      p_run_id: runId,
      p_status: errors.length > 0 ? 'completed' : 'completed',
      p_recommendations_generated: generated,
      p_duplicates_skipped: duplicatesSkipped,
      p_errors: JSON.stringify(errors),
      p_analysis_summary: JSON.stringify(analysisSummary),
    });

    console.log(
      `${LOG_PREFIX} Generation complete. Generated: ${generated}, Duplicates: ${duplicatesSkipped}, Duration: ${duration}ms`
    );

    return {
      ok: true,
      run_id: runId,
      generated,
      duplicates_skipped: duplicatesSkipped,
      errors,
      duration_ms: duration,
      analysis_summary: analysisSummary,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Generation failed:`, errorMessage);

    // Mark run as failed
    await callRpc('complete_autopilot_recommendation_run', {
      p_run_id: runId,
      p_status: 'failed',
      p_recommendations_generated: 0,
      p_duplicates_skipped: 0,
      p_errors: JSON.stringify([{ source: 'system', error: errorMessage }]),
      p_analysis_summary: JSON.stringify(analysisSummary),
    });

    return {
      ok: false,
      run_id: runId,
      generated: 0,
      duplicates_skipped: 0,
      errors: [{ source: 'system', error: errorMessage }],
      duration_ms: Date.now() - startTime,
      analysis_summary: analysisSummary,
    };
  }
}
