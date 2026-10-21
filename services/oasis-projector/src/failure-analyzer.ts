/**
 * VTID-01234: Failure Analyzer — Self-Improvement Foundation
 *
 * Queries OASIS events for failure patterns and emits system insights.
 * Runs on a configurable schedule (default: every 6 hours).
 *
 * This is NOT AI-powered introspection. It's data analysis:
 * - What VTIDs fail most?
 * - Which error patterns recur?
 * - Which models/domains have the highest failure rates?
 * - What's the average execution time by domain?
 *
 * Insights are written to oasis_events with topic='system.insight'
 * so they're visible in the OASIS console and can inform future routing.
 */

import { Database } from './database';
import { logger } from './logger';

interface FailurePattern {
  pattern: string;
  count: number;
  vtids: string[];
  lastSeen: Date;
}

interface DomainStats {
  domain: string;
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationMs: number;
}

interface AnalysisResult {
  period: { from: Date; to: Date };
  totalEvents: number;
  totalFailures: number;
  failureRate: number;
  topFailurePatterns: FailurePattern[];
  domainStats: DomainStats[];
  recommendations: string[];
}

export class FailureAnalyzer {
  private isRunning = false;
  private readonly ANALYSIS_INTERVAL = parseInt(process.env.FAILURE_ANALYSIS_INTERVAL_MS || '21600000', 10); // 6 hours
  private readonly LOOKBACK_HOURS = parseInt(process.env.FAILURE_LOOKBACK_HOURS || '24', 10);

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[VTID-01234] Failure analyzer already running');
      return;
    }

    this.isRunning = true;
    logger.info('[VTID-01234] Starting failure analyzer');

    // Run initial analysis after a short delay
    setTimeout(() => this.analysisLoop(), 30000);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    logger.info('[VTID-01234] Stopping failure analyzer');
  }

  private async analysisLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const result = await this.analyze();
        await this.emitInsights(result);
      } catch (error) {
        logger.error('[VTID-01234] Analysis loop error', error);
      }

      await this.sleep(this.ANALYSIS_INTERVAL);
    }
  }

  /**
   * Run failure analysis over the lookback window
   */
  async analyze(): Promise<AnalysisResult> {
    const db = Database.getInstance();
    const now = new Date();
    const from = new Date(now.getTime() - this.LOOKBACK_HOURS * 60 * 60 * 1000);

    logger.info(`[VTID-01234] Analyzing failures from ${from.toISOString()} to ${now.toISOString()}`);

    // Query execution events in the window
    const events = await db.oasisEvent.findMany({
      where: {
        createdAt: { gte: from, lte: now },
        service: 'worker-runner',
        topic: {
          in: [
            'worker_runner.exec_completed',
            'worker_runner.error',
            'worker_runner.terminalized',
            'worker_runner.claim_failed',
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    const totalEvents = events.length;

    // Separate failures
    const failures = events.filter(
      (e) => e.status === 'error' || e.status === 'warning'
    );
    const successes = events.filter((e) => e.status === 'success');

    // Extract failure patterns from error messages
    const patternMap = new Map<string, FailurePattern>();
    for (const event of failures) {
      const meta = event.metadata as Record<string, any> | null;
      const errorMsg = meta?.error || event.message || 'unknown error';
      // Normalize: strip VTID-specific info to find patterns
      const pattern = this.normalizeError(errorMsg);

      const existing = patternMap.get(pattern);
      if (existing) {
        existing.count++;
        if (event.vtid && !existing.vtids.includes(event.vtid)) {
          existing.vtids.push(event.vtid);
        }
        if (event.createdAt > existing.lastSeen) {
          existing.lastSeen = event.createdAt;
        }
      } else {
        patternMap.set(pattern, {
          pattern,
          count: 1,
          vtids: event.vtid ? [event.vtid] : [],
          lastSeen: event.createdAt,
        });
      }
    }

    const topFailurePatterns = Array.from(patternMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Domain stats
    const domainMap = new Map<string, { total: number; succeeded: number; failed: number; totalDuration: number }>();
    for (const event of events) {
      const meta = event.metadata as Record<string, any> | null;
      const domain = meta?.domain || 'unknown';
      const duration = meta?.duration_ms || 0;
      const isSuccess = event.status === 'success';

      const existing = domainMap.get(domain) || { total: 0, succeeded: 0, failed: 0, totalDuration: 0 };
      existing.total++;
      if (isSuccess) existing.succeeded++;
      else existing.failed++;
      existing.totalDuration += duration;
      domainMap.set(domain, existing);
    }

    const domainStats: DomainStats[] = Array.from(domainMap.entries()).map(([domain, stats]) => ({
      domain,
      total: stats.total,
      succeeded: stats.succeeded,
      failed: stats.failed,
      successRate: stats.total > 0 ? Math.round((stats.succeeded / stats.total) * 100) : 0,
      avgDurationMs: stats.total > 0 ? Math.round(stats.totalDuration / stats.total) : 0,
    }));

    // Generate recommendations
    const recommendations = this.generateRecommendations(topFailurePatterns, domainStats, totalEvents, failures.length);

    const result: AnalysisResult = {
      period: { from, to: now },
      totalEvents,
      totalFailures: failures.length,
      failureRate: totalEvents > 0 ? Math.round((failures.length / totalEvents) * 100) : 0,
      topFailurePatterns,
      domainStats,
      recommendations,
    };

    logger.info(`[VTID-01234] Analysis complete: ${totalEvents} events, ${failures.length} failures (${result.failureRate}%)`);
    return result;
  }

  /**
   * Normalize error messages to find recurring patterns
   */
  private normalizeError(error: string): string {
    return error
      // Strip VTID references
      .replace(/VTID-\d{4,5}/g, 'VTID-XXXXX')
      // Strip UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
      // Strip run IDs
      .replace(/run_[a-f0-9]+/g, 'run_XXX')
      // Strip timestamps
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, 'TIMESTAMP')
      // Strip numbers that are likely instance-specific
      .replace(/\d{5,}/g, 'NNNNN')
      // Trim and truncate
      .trim()
      .substring(0, 200);
  }

  /**
   * Generate actionable recommendations from analysis
   */
  private generateRecommendations(
    patterns: FailurePattern[],
    domainStats: DomainStats[],
    total: number,
    failures: number
  ): string[] {
    const recs: string[] = [];

    // High failure rate
    const failureRate = total > 0 ? failures / total : 0;
    if (failureRate > 0.3 && total > 10) {
      recs.push(`HIGH_FAILURE_RATE: ${Math.round(failureRate * 100)}% failure rate across ${total} events. Investigate systemic issues.`);
    }

    // Recurring patterns
    for (const pattern of patterns.slice(0, 3)) {
      if (pattern.count >= 3) {
        recs.push(`RECURRING_FAILURE: "${pattern.pattern}" occurred ${pattern.count} times across ${pattern.vtids.length} VTIDs. Consider adding specific handling.`);
      }
    }

    // Domain-specific issues
    for (const stats of domainStats) {
      if (stats.total >= 5 && stats.successRate < 50) {
        recs.push(`DOMAIN_ISSUE: ${stats.domain} domain has ${stats.successRate}% success rate (${stats.failed}/${stats.total} failed). Review domain prompts and guardrails.`);
      }
      if (stats.avgDurationMs > 120000) {
        recs.push(`SLOW_DOMAIN: ${stats.domain} domain averaging ${Math.round(stats.avgDurationMs / 1000)}s per execution. Consider timeout tuning or task decomposition.`);
      }
    }

    // Contract validation failures
    const contractFailures = patterns.filter((p) => p.pattern.includes('Contract validation'));
    if (contractFailures.length > 0) {
      const totalContractFails = contractFailures.reduce((sum, p) => sum + p.count, 0);
      recs.push(`CONTRACT_FAILURES: ${totalContractFails} contract validation failures. LLM outputs not conforming to required JSON schema. Consider prompt refinement.`);
    }

    if (recs.length === 0 && total > 0) {
      recs.push(`HEALTHY: ${Math.round((1 - failureRate) * 100)}% success rate across ${total} events. No action needed.`);
    }

    return recs;
  }

  /**
   * Emit analysis results as OASIS events
   */
  private async emitInsights(result: AnalysisResult): Promise<void> {
    const db = Database.getInstance();

    try {
      await db.oasisEvent.create({
        data: {
          service: 'oasis-projector',
          event: 'system.insight',
          topic: 'system.insight.failure_analysis',
          tenant: 'system',
          role: 'SYSTEM',
          model: 'failure-analyzer',
          status: result.failureRate > 30 ? 'warning' : 'info',
          message: `Failure analysis: ${result.totalEvents} events, ${result.totalFailures} failures (${result.failureRate}%), ${result.recommendations.length} recommendations`,
          vtid: 'VTID-01234',
          metadata: {
            period_from: result.period.from.toISOString(),
            period_to: result.period.to.toISOString(),
            total_events: result.totalEvents,
            total_failures: result.totalFailures,
            failure_rate: result.failureRate,
            top_patterns: result.topFailurePatterns.map((p) => ({
              pattern: p.pattern,
              count: p.count,
              vtid_count: p.vtids.length,
            })),
            domain_stats: result.domainStats,
            recommendations: result.recommendations,
          },
        },
      });

      logger.info(`[VTID-01234] Emitted failure analysis insight (${result.recommendations.length} recommendations)`);
    } catch (error) {
      logger.error('[VTID-01234] Failed to emit insight event', error);
    }
  }

  /**
   * Manual analysis trigger
   */
  async analyzeNow(): Promise<AnalysisResult> {
    const result = await this.analyze();
    await this.emitInsights(result);
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
