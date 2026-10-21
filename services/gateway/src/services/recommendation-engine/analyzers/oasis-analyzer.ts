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
import { isRecommendationNoiseTopic } from '../../oasis-noise-topics';

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

export interface ErrorCluster {
  /** Cluster identity: `topic:service`, or `provider:<provider>:<error class>` (VTID-04666). */
  key: string;
  topic: string;
  service: string;
  count: number;
  recent_messages: string[];
  event_ids: string[];
  /** VTID-04666: set when the cluster is one provider failure root cause. */
  root_cause?: { provider: string; error_class: string; services: string[]; topics: string[] };
}

/** Minimal shape of an oasis_events row as read by this analyzer. */
export interface OasisErrorEventRow {
  id?: string;
  topic?: string | null;
  service?: string | null;
  status?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * VTID-04666: error class of a provider failure, from the event itself.
 * Order: an explicit error code, an HTTP status (field, then message), a
 * known AWS/network/provider error token, else 'unknown'. Deterministic so
 * the same outage always yields the same fingerprint.
 */
export function classifyProviderErrorClass(event: OasisErrorEventRow): string {
  const md = (event.metadata || {}) as Record<string, unknown>;
  const code = str(md.error_code) || str(md.errorCode) || str(md.code);
  if (code) return code.toLowerCase();

  const statusField = md.status_code ?? md.http_status ?? md.statusCode;
  if (typeof statusField === 'number' && statusField >= 400 && statusField < 600) return String(statusField);
  if (typeof statusField === 'string' && /^[45]\d\d$/.test(statusField)) return statusField;

  const text = [str(md.error_message), str(md.error), str(event.message)].filter(Boolean).join(' ');
  const http = text.match(/\b([45]\d\d)\b/);
  if (http) return http[1];

  const token = text.match(
    /(AccessDenied\w*|Throttling\w*|ValidationException|ServiceUnavailable\w*|ModelNotReady\w*|invoke_failed|timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|rate.?limit|insufficient.?balance|credit balance)/i,
  );
  if (token) return token[1].toLowerCase().replace(/\s+/g, '_');
  return 'unknown';
}

/**
 * VTID-04666: is this error event a provider (LLM / voice / TTS) call that
 * failed? Those are clustered by root cause, not per service, so one outage
 * becomes one recommendation instead of one per calling service.
 */
export function providerOfFailure(event: OasisErrorEventRow): string | null {
  const provider = str((event.metadata || {})['provider']);
  if (!provider) return null;
  const topic = event.topic || '';
  if (topic.startsWith('llm.') || /fail|error/.test(topic)) {
    return provider.toLowerCase();
  }
  return null;
}

/**
 * Pure clustering of error events (VTID-04666: extracted so it is testable).
 *  - noise topics (bookkeeping, telemetry — see oasis-noise-topics.ts) never cluster;
 *  - provider failures cluster by provider + error class across services;
 *  - everything else clusters by topic + service, as before;
 *  - only clusters with count >= threshold are returned, largest first.
 */
export function clusterErrorEvents(events: OasisErrorEventRow[], threshold: number): ErrorCluster[] {
  const grouped = new Map<string, { events: OasisErrorEventRow[]; provider?: string; errorClass?: string }>();
  for (const event of events) {
    const topic = event.topic || 'unknown';
    if (isRecommendationNoiseTopic(topic)) continue;
    const provider = providerOfFailure(event);
    let key: string;
    let entry: { events: OasisErrorEventRow[]; provider?: string; errorClass?: string } | undefined;
    if (provider) {
      const errorClass = classifyProviderErrorClass(event);
      key = `provider:${provider}:${errorClass}`;
      entry = grouped.get(key) || { events: [], provider, errorClass };
    } else {
      key = `${topic}:${event.service || 'unknown'}`;
      entry = grouped.get(key) || { events: [] };
    }
    entry.events.push(event);
    grouped.set(key, entry);
  }

  const clusters: ErrorCluster[] = [];
  for (const [key, g] of grouped) {
    if (g.events.length < threshold) continue;
    const first = g.events[0];
    const services = Array.from(new Set(g.events.map((e) => e.service || 'unknown')));
    const topics = Array.from(new Set(g.events.map((e) => e.topic || 'unknown')));
    clusters.push({
      key,
      topic: first.topic || 'unknown',
      service: g.provider ? services.join(',') : first.service || 'unknown',
      count: g.events.length,
      recent_messages: g.events.slice(0, 5).map((e) => e.message || 'No message'),
      event_ids: g.events.slice(0, 10).map((e) => e.id).filter((id): id is string => typeof id === 'string'),
      ...(g.provider
        ? { root_cause: { provider: g.provider, error_class: g.errorClass || 'unknown', services, topics } }
        : {}),
    });
  }
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

async function analyzeErrorPatterns(config: OasisAnalyzerConfig): Promise<ErrorCluster[]> {
  try {
    const lookbackTime = new Date(Date.now() - config.lookback_hours * 60 * 60 * 1000).toISOString();

    // Query error events. VTID-04666: voice.latency.* is high-volume telemetry
    // written with status=error — exclude it server-side so it cannot eat the
    // 1000-row page; every other noise topic is dropped in clusterErrorEvents.
    const query =
      `status=eq.error&created_at=gte.${lookbackTime}` +
      `&topic=not.like.voice.latency.*` +
      `&select=id,topic,service,status,message,metadata` +
      `&order=created_at.desc&limit=1000`;
    const result = await queryOasisEvents(query);

    if (!result.ok || !result.data) {
      console.warn(`${LOG_PREFIX} Failed to fetch error events:`, result.error);
      return [];
    }

    return clusterErrorEvents(result.data as OasisErrorEventRow[], config.error_threshold);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error analyzing error patterns:`, error);
    return [];
  }
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
    // VTID-04666: the AWS deploy workflows write staging.deploy.failed /
    // prod.deploy.failed; the three older topics are GCP-era and no longer
    // emitted. The error clustering treats all deploy topics as noise, so this
    // pass is the only place deploy failures become recommendations.
    const query = `or=(topic.eq.deploy.failed,topic.eq.cicd.deploy.service.failed,topic.eq.deploy.gateway.failed,topic.eq.staging.deploy.failed,topic.eq.prod.deploy.failed)&created_at=gte.${lookbackTime}&order=created_at.desc&limit=500`;
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

      if (cluster.root_cause) {
        // VTID-04666: one provider outage = one signal. The source (and so
        // the fingerprint) is the root cause, not the calling service.
        const rc = cluster.root_cause;
        signals.push({
          type: 'error_pattern',
          severity,
          source: cluster.key,
          message:
            `Provider failure: ${rc.provider} ${rc.error_class} (${cluster.count} occurrences in ` +
            `${fullConfig.lookback_hours}h across ${rc.services.join(', ')}; topics: ${rc.topics.join(', ')})`,
          count: cluster.count,
          suggested_action: `Investigate ${rc.provider} ${rc.error_class} failures (provider outage or configuration)`,
          event_ids: cluster.event_ids,
        });
        continue;
      }

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
