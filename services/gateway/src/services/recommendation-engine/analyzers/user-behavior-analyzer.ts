/**
 * User Behavior Analyzer - VTID-01185
 *
 * Learns from user interactions with recommendations and the platform:
 * - Which recommendations users accept vs dismiss (preference learning)
 * - Conversation topics that recur (unmet needs)
 * - Feature usage patterns from OASIS events (underused/overused)
 * - Recommendation feedback ratings
 */

import { createHash } from 'crypto';

const LOG_PREFIX = '[VTID-01185:UserBehavior]';

// =============================================================================
// Types
// =============================================================================

export interface UserBehaviorSignal {
  type: 'unmet_need' | 'feature_gap' | 'high_dismiss_rate' | 'recurring_topic' | 'low_engagement';
  severity: 'low' | 'medium' | 'high';
  source: string;
  message: string;
  details: Record<string, unknown>;
  suggested_action: string;
}

export interface UserBehaviorAnalysisResult {
  ok: boolean;
  signals: UserBehaviorSignal[];
  summary: {
    interactions_analyzed: number;
    conversations_analyzed: number;
    signals_generated: number;
    duration_ms: number;
  };
  error?: string;
}

// =============================================================================
// Supabase Helper
// =============================================================================

async function querySupabase(table: string, query: string): Promise<any[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) return [];

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) return [];
    return (await response.json()) as any[];
  } catch {
    return [];
  }
}

// =============================================================================
// Recommendation Interaction Analysis
// =============================================================================

/**
 * Analyze recommendation accept/dismiss patterns to learn user preferences.
 */
async function analyzeRecommendationFeedback(): Promise<UserBehaviorSignal[]> {
  const signals: UserBehaviorSignal[] = [];

  try {
    // Get recommendation status distribution
    const recommendations = await querySupabase(
      'autopilot_recommendations',
      'select=status,domain,impact_score,effort_score&limit=500'
    );

    if (recommendations.length === 0) return signals;

    // Group by domain and calculate accept/reject ratios
    const domainStats: Record<string, { total: number; activated: number; rejected: number; new: number }> = {};

    for (const rec of recommendations) {
      const domain = rec.domain || 'general';
      if (!domainStats[domain]) {
        domainStats[domain] = { total: 0, activated: 0, rejected: 0, new: 0 };
      }
      domainStats[domain].total++;
      if (rec.status === 'activated') domainStats[domain].activated++;
      else if (rec.status === 'rejected') domainStats[domain].rejected++;
      else if (rec.status === 'new') domainStats[domain].new++;
    }

    // Find domains with high dismiss rates
    for (const [domain, stats] of Object.entries(domainStats)) {
      if (stats.total < 3) continue; // Not enough data

      const dismissRate = stats.rejected / stats.total;
      if (dismissRate > 0.7) {
        signals.push({
          type: 'high_dismiss_rate',
          severity: 'medium',
          source: `domain:${domain}`,
          message: `${Math.round(dismissRate * 100)}% of ${domain} recommendations are dismissed (${stats.rejected}/${stats.total}). Consider adjusting recommendation criteria for this domain.`,
          details: { domain, ...stats, dismiss_rate: dismissRate },
          suggested_action: `Review and improve ${domain} recommendation quality — ${Math.round(dismissRate * 100)}% dismiss rate suggests low relevance`,
        });
      }

      // Find domains with high activation rates (positive signal — generate more)
      const activateRate = stats.activated / stats.total;
      if (activateRate > 0.5 && stats.activated >= 3) {
        signals.push({
          type: 'unmet_need',
          severity: 'low',
          source: `domain:${domain}`,
          message: `High activation rate for ${domain} recommendations (${Math.round(activateRate * 100)}%). Users want more improvements in this area.`,
          details: { domain, ...stats, activate_rate: activateRate },
          suggested_action: `Increase recommendation generation frequency for ${domain} domain — users consistently activate these`,
        });
      }
    }

    // Check for stale recommendations (sitting in 'new' for too long)
    const staleCount = recommendations.filter(r => r.status === 'new').length;
    if (staleCount > 10) {
      signals.push({
        type: 'low_engagement',
        severity: 'medium',
        source: 'recommendation_inbox',
        message: `${staleCount} recommendations sitting unread in inbox. Users may not be checking the recommendation panel.`,
        details: { stale_count: staleCount },
        suggested_action: 'Improve recommendation visibility — consider push notifications or surfacing in conversation context',
      });
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Recommendation feedback analysis error:`, error);
  }

  return signals;
}

// =============================================================================
// Conversation Topic Analysis
// =============================================================================

/**
 * Analyze conversation topics to find recurring unmet needs.
 */
async function analyzeConversationTopics(): Promise<UserBehaviorSignal[]> {
  const signals: UserBehaviorSignal[] = [];

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Get recent conversation events
    const conversations = await querySupabase(
      'oasis_events',
      `topic=like.conversation.*&created_at=gte.${sevenDaysAgo}&select=message,metadata&limit=200`
    );

    if (conversations.length < 10) return signals;

    // Extract categories from conversation metadata
    const categoryCount: Record<string, number> = {};
    for (const conv of conversations) {
      const category = conv.metadata?.category || conv.metadata?.domain || 'general';
      categoryCount[category] = (categoryCount[category] || 0) + 1;
    }

    // Find topics with high frequency (potential unmet needs)
    const sortedCategories = Object.entries(categoryCount)
      .sort(([, a], [, b]) => b - a);

    for (const [category, count] of sortedCategories.slice(0, 3)) {
      if (count >= 10) {
        signals.push({
          type: 'recurring_topic',
          severity: 'low',
          source: `conversation:${category}`,
          message: `Users frequently discuss "${category}" (${count} conversations in 7 days). Consider building dedicated features or improving existing capabilities in this area.`,
          details: { category, count, period_days: 7 },
          suggested_action: `Investigate user needs around "${category}" — ${count} conversations suggest demand for better support`,
        });
      }
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Conversation topic analysis error:`, error);
  }

  return signals;
}

// =============================================================================
// Feature Usage Analysis
// =============================================================================

/**
 * Analyze OASIS events to find underused features.
 */
async function analyzeFeatureUsage(): Promise<UserBehaviorSignal[]> {
  const signals: UserBehaviorSignal[] = [];

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Count events per service/module
    const events = await querySupabase(
      'oasis_events',
      `created_at=gte.${sevenDaysAgo}&select=service,topic&limit=2000`
    );

    if (events.length < 50) return signals;

    const serviceUsage: Record<string, number> = {};
    for (const event of events) {
      const service = event.service || 'unknown';
      serviceUsage[service] = (serviceUsage[service] || 0) + 1;
    }

    // Find services with very low usage relative to others
    const avgUsage = Object.values(serviceUsage).reduce((a, b) => a + b, 0) / Object.keys(serviceUsage).length;

    for (const [service, count] of Object.entries(serviceUsage)) {
      if (count < avgUsage * 0.1 && count < 5) {
        signals.push({
          type: 'feature_gap',
          severity: 'low',
          source: `service:${service}`,
          message: `Service "${service}" has very low usage (${count} events vs avg ${Math.round(avgUsage)}). May indicate a feature gap or usability issue.`,
          details: { service, count, average_usage: Math.round(avgUsage) },
          suggested_action: `Review "${service}" — very low usage may indicate poor discoverability or usability issues`,
        });
      }
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Feature usage analysis error:`, error);
  }

  return signals;
}

// =============================================================================
// Main Analyzer
// =============================================================================

export async function analyzeUserBehavior(): Promise<UserBehaviorAnalysisResult> {
  const startTime = Date.now();
  console.log(`${LOG_PREFIX} Starting user behavior analysis...`);

  try {
    const [feedbackSignals, topicSignals, usageSignals] = await Promise.all([
      analyzeRecommendationFeedback(),
      analyzeConversationTopics(),
      analyzeFeatureUsage(),
    ]);

    const allSignals = [...feedbackSignals, ...topicSignals, ...usageSignals];
    const duration = Date.now() - startTime;

    console.log(`${LOG_PREFIX} Analysis complete: ${allSignals.length} signals in ${duration}ms`);

    return {
      ok: true,
      signals: allSignals,
      summary: {
        interactions_analyzed: feedbackSignals.length,
        conversations_analyzed: topicSignals.length,
        signals_generated: allSignals.length,
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
        interactions_analyzed: 0,
        conversations_analyzed: 0,
        signals_generated: 0,
        duration_ms: Date.now() - startTime,
      },
      error: errorMessage,
    };
  }
}

// =============================================================================
// Fingerprint
// =============================================================================

export function generateUserBehaviorFingerprint(signal: UserBehaviorSignal): string {
  const data = `behavior:${signal.type}:${signal.source}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}
