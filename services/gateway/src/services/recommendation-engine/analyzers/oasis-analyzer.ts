/**
 * OASIS Event Analyzer - VTID-01185
 *
 * Analyzes OASIS events for patterns:
 * - Error clustering (frequent errors)
 * - Slow endpoints (response time > threshold)
 * - Failed deployments
 * - Event anomalies (spikes)
 */

import { createHash } from 'crypto';

const LOG_PREFIX = '[VTID-01185:OASIS]';

// =============================================================================
// Types
// =============================================================================

export interface OasisSignal {
  type: 'error_pattern' | 'slow_endpoint' | 'failed_deploy' | 'anomaly' | 'underused_feature';
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  message: string;
  count?: number;
  avg_duration_ms?: number;
  suggested_action: string;
  event_ids?: string[];
}

export interface OasisAnalysisResult {
  ok: boolean;
  signals: OasisSignal[];
  summary: {
    events_analyzed: number;
    error_patterns_found: number;
    slow_endpoints_found: number;
    failed_deploys_found: number;
    duration_ms: number;
  };
  error?: string;
}

export interface OasisAnalyzerConfig {
  lookback_hours: number;
  error_threshold: number;
  slow_endpoint_ms: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: OasisAnalyzerConfig = {
  lookback_hours: 24,
  error_threshold: 10,
  slow_endpoint_ms: 2000,
};

// =============================================================================
// Supabase RPC Helper
// =============================================================================

async function queryOasisEvents(
  query: string,
  params: Record<string, unknown> = {}
): Promise<{ ok: boolean; data?: any[]; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/oasis_events?${query}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = (await response.json()) as any[];
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Error Pattern Analyzer
// =============================================================================

interface ErrorCluster {
  topic: string;
  service: string;
  count: number;
  recent_messages: string[];
  event_ids: string[];
}

async function analyzeErrorPatterns(config: OasisAnalyzerConfig): Promise<ErrorCluster[]> {
  const clusters: ErrorCluster[] = [];

  try {
    const lookbackTime = new Date(Date.now() - config.lookback_hours * 60 * 60 * 1000).toISOString();

    // Query error events
    const query = `status=eq.error&created_at=gte.${lookbackTime}&order=created_at.desc&limit=1000`;
    const result = await queryOasisEvents(query);

    if (!result.ok || !result.data) {
      console.warn(`${LOG_PREFIX} Failed to fetch error events:`, result.error);
      return clusters;
    }

    // Group by topic + service
    const grouped = new Map<string, any[]>();
    for (const event of result.data) {
      const key = `${event.topic || 'unknown'}:${event.service || 'unknown'}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(event);
    }

    // Filter clusters with count >= threshold
    for (const [key, events] of grouped) {
      if (events.length >= config.error_threshold) {
        const [topic, service] = key.split(':');
        clusters.push({
          topic,
          service,
          count: events.length,
          recent_messages: events.slice(0, 5).map((e) => e.message || 'No message'),
          event_ids: events.slice(0, 10).map((e) => e.id),
        });
      }
    }

    // Sort by count descending
    clusters.sort((a, b) => b.count - a.count);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error analyzing error patterns:`, error);
  }

  return clusters;
}

// =============================================================================
// Slow Endpoint Analyzer
// =============================================================================

interface SlowEndpoint {
  endpoint: string;
  avg_duration_ms: number;
  count: number;
  max_duration_ms: number;
}

async function analyzeSlowEndpoints(config: OasisAnalyzerConfig): Promise<SlowEndpoint[]> {
  const endpoints: SlowEndpoint[] = [];

  try {
    const lookbackTime = new Date(Date.now() - config.lookback_hours * 60 * 60 * 1000).toISOString();

    // Query API events with duration metadata
    const query = `topic=like.api.*&created_at=gte.${lookbackTime}&order=created_at.desc&limit=2000`;
    const result = await queryOasisEvents(query);

    if (!result.ok || !result.data) {
      console.warn(`${LOG_PREFIX} Failed to fetch API events:`, result.error);
      return endpoints;
    }

    // Group by endpoint and calculate stats
    const grouped = new Map<string, number[]>();
    for (const event of result.data) {
      const duration = event.metadata?.duration_ms || event.metadata?.latency_ms;
      if (typeof duration === 'number') {
        const endpoint = event.metadata?.endpoint || event.topic || 'unknown';
        if (!grouped.has(endpoint)) {
          grouped.set(endpoint, []);
        }
        grouped.get(endpoint)!.push(duration);
      }
    }

    // Calculate averages and filter slow endpoints
    for (const [endpoint, durations] of grouped) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const max = Math.max(...durations);

      if (avg > config.slow_endpoint_ms || max > config.slow_endpoint_ms * 2) {
        endpoints.push({
          endpoint,
          avg_duration_ms: Math.round(avg),
          count: durations.length,
          max_duration_ms: max,
        });
      }
    }

    // Sort by avg duration descending
    endpoints.sort((a, b) => b.avg_duration_ms - a.avg_duration_ms);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error analyzing slow endpoints:`, error);
  }

  return endpoints;
}

// =============================================================================
// Failed Deploy Analyzer
// =============================================================================

interface FailedDeploy {
  service: string;
  count: number;
  recent_errors: string[];
  last_failed_at: string;
}

async function analyzeFailedDeploys(config: OasisAnalyzerConfig): Promise<FailedDeploy[]> {
  const failures: FailedDeploy[] = [];

  try {
    const lookbackTime = new Date(Date.now() - config.lookback_hours * 60 * 60 * 1000).toISOString();

    // Query deploy failure events
    const query = `or=(topic.eq.deploy.failed,topic.eq.cicd.deploy.service.failed,topic.eq.deploy.gateway.failed)&created_at=gte.${lookbackTime}&order=created_at.desc&limit=500`;
    const result = await queryOasisEvents(query);

    if (!result.ok || !result.data) {
      console.warn(`${LOG_PREFIX} Failed to fetch deploy events:`, result.error);
      return failures;
    }

    // Group by service
    const grouped = new Map<string, any[]>();
    for (const event of result.data) {
      const service = event.metadata?.service || event.service || 'unknown';
      if (!grouped.has(service)) {
        grouped.set(service, []);
      }
      grouped.get(service)!.push(event);
    }

    // Build failure list
    for (const [service, events] of grouped) {
      if (events.length > 0) {
        failures.push({
          service,
          count: events.length,
          recent_errors: events.slice(0, 3).map((e) => e.message || e.metadata?.error || 'Unknown error'),
          last_failed_at: events[0].created_at,
        });
      }
    }

    // Sort by count descending
    failures.sort((a, b) => b.count - a.count);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error analyzing failed deploys:`, error);
  }

  return failures;
}

// =============================================================================
// Main Analyzer Function
// =============================================================================

export async function analyzeOasisEvents(
  config: Partial<OasisAnalyzerConfig> = {}
): Promise<OasisAnalysisResult> {
  const startTime = Date.now();
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const signals: OasisSignal[] = [];

  console.log(`${LOG_PREFIX} Starting OASIS event analysis (lookback: ${fullConfig.lookback_hours}h)...`);

  try {
    // Run analyses in parallel
    const [errorClusters, slowEndpoints, failedDeploys] = await Promise.all([
      analyzeErrorPatterns(fullConfig),
      analyzeSlowEndpoints(fullConfig),
      analyzeFailedDeploys(fullConfig),
    ]);

    // Convert error clusters to signals
    for (const cluster of errorClusters) {
      const severity =
        cluster.count > 100 ? 'critical' : cluster.count > 50 ? 'high' : cluster.count > 20 ? 'medium' : 'low';

      signals.push({
        type: 'error_pattern',
        severity,
        source: `${cluster.service}:${cluster.topic}`,
        message: `Recurring error pattern: ${cluster.topic} (${cluster.count} occurrences in ${fullConfig.lookback_hours}h)`,
        count: cluster.count,
        suggested_action: `Investigate and fix ${cluster.topic} errors in ${cluster.service} service`,
        event_ids: cluster.event_ids,
      });
    }

    // Convert slow endpoints to signals
    for (const endpoint of slowEndpoints) {
      const severity =
        endpoint.avg_duration_ms > 5000
          ? 'high'
          : endpoint.avg_duration_ms > 3000
          ? 'medium'
          : 'low';

      signals.push({
        type: 'slow_endpoint',
        severity,
        source: endpoint.endpoint,
        message: `Slow endpoint detected: avg ${endpoint.avg_duration_ms}ms, max ${endpoint.max_duration_ms}ms`,
        count: endpoint.count,
        avg_duration_ms: endpoint.avg_duration_ms,
        suggested_action: `Optimize ${endpoint.endpoint} - consider caching, query optimization, or pagination`,
      });
    }

    // Convert failed deploys to signals
    for (const deploy of failedDeploys) {
      const severity = deploy.count > 3 ? 'critical' : deploy.count > 1 ? 'high' : 'medium';

      signals.push({
        type: 'failed_deploy',
        severity,
        source: deploy.service,
        message: `Deploy failures for ${deploy.service}: ${deploy.count} failure(s)`,
        count: deploy.count,
        suggested_action: `Investigate deploy failures for ${deploy.service}: ${deploy.recent_errors[0]}`,
      });
    }

    const duration = Date.now() - startTime;
    console.log(`${LOG_PREFIX} Analysis complete: ${signals.length} signals found in ${duration}ms`);

    return {
      ok: true,
      signals,
      summary: {
        events_analyzed: errorClusters.length + slowEndpoints.length + failedDeploys.length,
        error_patterns_found: errorClusters.length,
        slow_endpoints_found: slowEndpoints.length,
        failed_deploys_found: failedDeploys.length,
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
        events_analyzed: 0,
        error_patterns_found: 0,
        slow_endpoints_found: 0,
        failed_deploys_found: 0,
        duration_ms: Date.now() - startTime,
      },
      error: errorMessage,
    };
  }
}

// =============================================================================
// Fingerprint Generator
// =============================================================================

export function generateOasisFingerprint(signal: OasisSignal): string {
  const data = `oasis:${signal.type}:${signal.source}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}
