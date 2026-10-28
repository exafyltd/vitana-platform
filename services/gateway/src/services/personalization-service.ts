/**
 * VTID-01096: Cross-Domain Personalization v1 (Health <-> Community <-> Offers <-> Locations)
 *
 * Deterministic read-time personalization service.
 * No AI - all rules are template-based and explainable.
 *
 * Core Rules (Hard):
 * - Personalization only if allow_location_personalization = true (for locations)
 * - Role must be patient (or explicit grant for professional view)
 * - No cross-user personalization leakage
 *
 * Weakness-based boosting rules:
 * - Movement low -> walking meetups, nearby parks, movement services
 * - Sleep declining -> sleep community group, evening routine, recovery products
 * - Stress high -> mindfulness meetups, therapy/wellness, calm locations
 * - Nutrition low / low_sodium -> nutrition groups, coaches, compliant products
 * - Social low -> small-group meetups, 1:1 people matches
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { CicdEventType } from '../types/cicd';

// =============================================================================
// VTID-01096: Types & Constants
// =============================================================================

/**
 * Longevity weakness categories
 */
export type WeaknessType =
  | 'movement_low'
  | 'sleep_declining'
  | 'stress_high'
  | 'nutrition_low'
  | 'low_sodium_constraint'
  | 'social_low';

/**
 * Topic profile entry
 */
export interface TopicScore {
  topic_key: string;
  score: number; // 0-100
}

/**
 * Recommended action with explanation
 */
export interface RecommendedAction {
  type: 'meetup' | 'location' | 'service' | 'product' | 'person' | 'group';
  id: string;
  title?: string;
  why: WhyExplanation[];
}

/**
 * Explanation for why something was recommended
 */
export interface WhyExplanation {
  reason_type: 'weakness_trigger' | 'topic_match' | 'relationship_proximity' | 'location_radius';
  weakness?: WeaknessType;
  topic?: string;
  relationship_edge?: string;
  distance_km?: number;
  template: string; // Human-readable template
}

/**
 * Personalization snapshot response
 */
export interface PersonalizationSnapshot {
  ok: boolean;
  snapshot_id: string;
  top_topics: TopicScore[];
  weaknesses: WeaknessType[];
  recommended_next_actions: RecommendedAction[];
  explanations: Record<string, string>;
  generated_at: string;
}

/**
 * Personalization context attached to endpoint responses
 */
export interface PersonalizationContext {
  applied: boolean;
  why: WhyExplanation[];
  snapshot_ref: string;
}

/**
 * User health scores from vitana_index_scores
 */
export interface HealthScores {
  score_total: number;
  score_physical: number;
  score_mental: number;
  score_nutritional: number;
  score_social: number;
  score_environmental: number;
}

/**
 * User preferences for personalization
 */
export interface UserPersonalizationPrefs {
  allow_location_personalization: boolean;
  role: 'patient' | 'professional' | 'admin';
}

// =============================================================================
// VTID-01096: Template Explanations (Deterministic, No AI)
// =============================================================================

/**
 * Template explanations for each weakness type.
 * These are deterministic and safe - no AI generation.
 */
export const WEAKNESS_EXPLANATIONS: Record<WeaknessType, string> = {
  movement_low: 'Your recent movement activity has been lower than your typical pattern. Consider activities that promote gentle, consistent movement.',
  sleep_declining: 'Your sleep quality has shown a declining trend. Focus on evening routines and recovery-focused activities.',
  stress_high: 'Your stress indicators are elevated. Mindfulness and calm environments may help.',
  nutrition_low: 'Your nutrition scores suggest room for improvement. Consider consulting with nutrition specialists.',
  low_sodium_constraint: 'Based on your health profile, low-sodium options are being prioritized.',
  social_low: 'Your social engagement has been lower than usual. Small-group activities may help you reconnect.'
};

/**
 * Boost rules for each weakness type.
 * Defines which types of recommendations to boost.
 */
export const WEAKNESS_BOOST_RULES: Record<WeaknessType, {
  boost_meetup_tags: string[];
  boost_location_tags: string[];
  boost_service_tags: string[];
  boost_product_tags: string[];
}> = {
  movement_low: {
    boost_meetup_tags: ['walking', 'hiking', 'fitness', 'yoga', 'movement', 'exercise'],
    boost_location_tags: ['park', 'trail', 'gym', 'outdoor', 'nature'],
    boost_service_tags: ['fitness', 'physical_therapy', 'personal_training'],
    boost_product_tags: ['fitness_tracker', 'walking_shoes', 'exercise_equipment']
  },
  sleep_declining: {
    boost_meetup_tags: ['meditation', 'relaxation', 'evening', 'sleep_hygiene'],
    boost_location_tags: ['spa', 'quiet', 'retreat', 'wellness_center'],
    boost_service_tags: ['sleep_specialist', 'massage', 'acupuncture', 'recovery'],
    boost_product_tags: ['sleep_aid', 'mattress', 'aromatherapy', 'blackout_curtains']
  },
  stress_high: {
    boost_meetup_tags: ['mindfulness', 'meditation', 'yoga', 'stress_relief', 'breathing'],
    boost_location_tags: ['spa', 'garden', 'quiet', 'nature', 'retreat'],
    boost_service_tags: ['therapy', 'counseling', 'wellness', 'massage'],
    boost_product_tags: ['meditation_app', 'stress_relief', 'aromatherapy']
  },
  nutrition_low: {
    boost_meetup_tags: ['nutrition', 'cooking', 'healthy_eating', 'meal_prep'],
    boost_location_tags: ['health_food', 'farmers_market', 'organic'],
    boost_service_tags: ['nutritionist', 'dietitian', 'nutrition_coach'],
    boost_product_tags: ['supplements', 'meal_kit', 'healthy_snacks']
  },
  low_sodium_constraint: {
    boost_meetup_tags: ['nutrition', 'low_sodium', 'heart_healthy'],
    boost_location_tags: ['health_food', 'organic'],
    boost_service_tags: ['nutritionist', 'dietitian', 'cardiac_care'],
    boost_product_tags: ['low_sodium', 'heart_healthy', 'salt_substitute']
  },
  social_low: {
    boost_meetup_tags: ['small_group', 'social', 'community', 'networking', 'book_club'],
    boost_location_tags: ['cafe', 'community_center', 'library', 'social'],
    boost_service_tags: ['group_therapy', 'community_programs'],
    boost_product_tags: []
  }
};

// =============================================================================
// VTID-01096: Weakness Detection Logic
// =============================================================================

/**
 * Thresholds for detecting weaknesses from health scores.
 * All thresholds are deterministic.
 */
const WEAKNESS_THRESHOLDS = {
  movement_low: { score: 'score_physical', threshold: 40 },
  sleep_declining: { score: 'score_physical', threshold: 45, requiresTrend: true },
  stress_high: { score: 'score_mental', threshold: 40 },
  nutrition_low: { score: 'score_nutritional', threshold: 40 },
  social_low: { score: 'score_social', threshold: 35 }
};

/**
 * Detect weaknesses from health scores.
 * Pure deterministic logic - no AI involved.
 */
export function detectWeaknesses(
  currentScores: HealthScores | null,
  previousScores?: HealthScores | null,
  userConstraints?: { low_sodium?: boolean }
): WeaknessType[] {
  const weaknesses: WeaknessType[] = [];

  if (!currentScores) {
    return weaknesses;
  }

  // Physical/movement check
  if (currentScores.score_physical < WEAKNESS_THRESHOLDS.movement_low.threshold) {
    weaknesses.push('movement_low');
  }

  // Sleep declining check (requires trend comparison)
  if (previousScores) {
    const sleepDelta = currentScores.score_physical - previousScores.score_physical;
    if (sleepDelta < -5 || currentScores.score_physical < 45) {
      weaknesses.push('sleep_declining');
    }
  }

  // Stress/mental check
  if (currentScores.score_mental < WEAKNESS_THRESHOLDS.stress_high.threshold) {
    weaknesses.push('stress_high');
  }

  // Nutrition check
  if (currentScores.score_nutritional < WEAKNESS_THRESHOLDS.nutrition_low.threshold) {
    weaknesses.push('nutrition_low');
  }

  // Low sodium constraint (explicit user flag)
  if (userConstraints?.low_sodium) {
    weaknesses.push('low_sodium_constraint');
  }

  // Social check
  if (currentScores.score_social < WEAKNESS_THRESHOLDS.social_low.threshold) {
    weaknesses.push('social_low');
  }

  return weaknesses;
}

// =============================================================================
// VTID-01096: Topic Scoring (Mock - would integrate with real topic system)
// =============================================================================

/**
 * Get top topics for a user.
 * In v1, this returns mock data - would integrate with VTID-01093 topics system.
 */
export function getTopTopics(userId: string): TopicScore[] {
  // v1: Return deterministic mock data based on user ID hash
  // This ensures consistent results for testing while being safe
  const hash = userId.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
  const topics = ['walking', 'meditation', 'nutrition', 'sleep', 'fitness', 'mindfulness'];

  return topics.slice(0, 3).map((topic, idx) => ({
    topic_key: topic,
    score: 90 - idx * 10 + (Math.abs(hash) % 10)
  }));
}

// =============================================================================
// VTID-01096: Recommendation Generation
// =============================================================================

/**
 * Generate recommendations based on weaknesses and topics.
 * All logic is deterministic and template-based.
 */
export function generateRecommendations(
  weaknesses: WeaknessType[],
  topTopics: TopicScore[]
): RecommendedAction[] {
  const recommendations: RecommendedAction[] = [];

  for (const weakness of weaknesses) {
    const rules = WEAKNESS_BOOST_RULES[weakness];

    // Generate meetup recommendation
    if (rules.boost_meetup_tags.length > 0) {
      recommendations.push({
        type: 'meetup',
        id: `meetup_${weakness}_${randomUUID().slice(0, 8)}`,
        title: `${formatWeaknessTitle(weakness)} Group`,
        why: [{
          reason_type: 'weakness_trigger',
          weakness,
          template: WEAKNESS_EXPLANATIONS[weakness]
        }]
      });
    }

    // Generate location recommendation
    if (rules.boost_location_tags.length > 0) {
      recommendations.push({
        type: 'location',
        id: `location_${weakness}_${randomUUID().slice(0, 8)}`,
        title: `Nearby ${rules.boost_location_tags[0]}`,
        why: [{
          reason_type: 'weakness_trigger',
          weakness,
          template: WEAKNESS_EXPLANATIONS[weakness]
        }]
      });
    }

    // Generate service recommendation
    if (rules.boost_service_tags.length > 0) {
      recommendations.push({
        type: 'service',
        id: `service_${weakness}_${randomUUID().slice(0, 8)}`,
        title: `${formatServiceTitle(rules.boost_service_tags[0])}`,
        why: [{
          reason_type: 'weakness_trigger',
          weakness,
          template: WEAKNESS_EXPLANATIONS[weakness]
        }]
      });
    }
  }

  // Add topic-based recommendations
  for (const topic of topTopics.slice(0, 2)) {
    recommendations.push({
      type: 'group',
      id: `group_topic_${topic.topic_key}_${randomUUID().slice(0, 8)}`,
      title: `${formatTopicTitle(topic.topic_key)} Community`,
      why: [{
        reason_type: 'topic_match',
        topic: topic.topic_key,
        template: `Based on your interest in ${topic.topic_key} (score: ${topic.score})`
      }]
    });
  }

  return recommendations;
}

// =============================================================================
// VTID-01096: Formatting Helpers
// =============================================================================

function formatWeaknessTitle(weakness: WeaknessType): string {
  const titles: Record<WeaknessType, string> = {
    movement_low: 'Movement & Walking',
    sleep_declining: 'Sleep & Recovery',
    stress_high: 'Mindfulness & Relaxation',
    nutrition_low: 'Nutrition & Healthy Eating',
    low_sodium_constraint: 'Heart-Healthy Nutrition',
    social_low: 'Social Connection'
  };
  return titles[weakness];
}

function formatServiceTitle(tag: string): string {
  return tag.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function formatTopicTitle(topic: string): string {
  return topic.charAt(0).toUpperCase() + topic.slice(1);
}

// =============================================================================
// VTID-01096: Snapshot Generation
// =============================================================================

/**
 * Generate a complete personalization snapshot.
 * This is the main entry point for the snapshot endpoint.
 */
export function generatePersonalizationSnapshot(
  userId: string,
  tenantId: string,
  currentScores: HealthScores | null,
  previousScores?: HealthScores | null,
  userConstraints?: { low_sodium?: boolean }
): PersonalizationSnapshot {
  const snapshotId = `ps_${randomUUID()}`;

  // Detect weaknesses
  const weaknesses = detectWeaknesses(currentScores, previousScores, userConstraints);

  // Get top topics
  const topTopics = getTopTopics(userId);

  // Generate recommendations
  const recommendations = generateRecommendations(weaknesses, topTopics);

  // Build explanations map
  const explanations: Record<string, string> = {};
  for (const weakness of weaknesses) {
    explanations[weakness] = WEAKNESS_EXPLANATIONS[weakness];
  }

  return {
    ok: true,
    snapshot_id: snapshotId,
    top_topics: topTopics,
    weaknesses,
    recommended_next_actions: recommendations,
    explanations,
    generated_at: new Date().toISOString()
  };
}

// =============================================================================
// VTID-01096: Personalization Context Builder
// =============================================================================

/**
 * Build personalization context to attach to endpoint responses.
 */
export function buildPersonalizationContext(
  snapshot: PersonalizationSnapshot,
  appliedWeaknesses: WeaknessType[],
  appliedTopics: string[]
): PersonalizationContext {
  const why: WhyExplanation[] = [];

  for (const weakness of appliedWeaknesses) {
    why.push({
      reason_type: 'weakness_trigger',
      weakness,
      template: WEAKNESS_EXPLANATIONS[weakness]
    });
  }

  for (const topic of appliedTopics) {
    why.push({
      reason_type: 'topic_match',
      topic,
      template: `Matched your interest in ${topic}`
    });
  }

  return {
    applied: why.length > 0,
    why,
    snapshot_ref: snapshot.snapshot_id
  };
}

// =============================================================================
// VTID-01096: OASIS Event Helpers
// =============================================================================

/**
 * Emit personalization-related OASIS event.
 */
export async function emitPersonalizationEvent(
  type: 'personalization.snapshot.read' | 'personalization.applied' | 'personalization.audit.written',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: {
    tenant_id?: string;
    user_id?: string;
    weaknesses?: WeaknessType[];
    top_topics?: TopicScore[];
    endpoint?: string;
    snapshot_id?: string;
    [key: string]: unknown;
  }
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: 'VTID-01096',
      type: type as CicdEventType,
      source: 'personalization-service',
      status,
      message,
      payload
    });
  } catch (err) {
    console.warn(`[VTID-01096] Failed to emit ${type}:`, err);
  }
}

// =============================================================================
// VTID-01096: Audit Helpers
// =============================================================================

/**
 * Write personalization audit entry to database.
 * Uses service role for audit writes.
 */
export async function writePersonalizationAudit(
  tenantId: string,
  userId: string,
  endpoint: string,
  snapshot: Omit<PersonalizationSnapshot, 'ok'>
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[VTID-01096] Cannot write audit: missing Supabase credentials');
    return { ok: false, error: 'Missing database credentials' };
  }

  const auditId = randomUUID();
  const auditEntry = {
    id: auditId,
    tenant_id: tenantId,
    user_id: userId,
    endpoint,
    snapshot: {
      snapshot_id: snapshot.snapshot_id,
      weaknesses: snapshot.weaknesses,
      top_topics: snapshot.top_topics.map(t => ({ topic_key: t.topic_key, score: t.score })),
      recommendation_count: snapshot.recommended_next_actions.length,
      generated_at: snapshot.generated_at
      // Note: No raw diary text or sensitive content
    },
    created_at: new Date().toISOString()
  };

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/personalization_audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(auditEntry)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[VTID-01096] Audit write failed:', response.status, errorText);
      return { ok: false, error: `Audit write failed: ${response.status}` };
    }

    // Emit audit written event
    await emitPersonalizationEvent(
      'personalization.audit.written',
      'success',
      `Personalization audit recorded for ${endpoint}`,
      {
        tenant_id: tenantId,
        user_id: userId,
        endpoint,
        snapshot_id: snapshot.snapshot_id
      }
    );

    return { ok: true, id: auditId };
  } catch (err: any) {
    console.error('[VTID-01096] Audit write error:', err.message);
    return { ok: false, error: err.message };
  }
}

export default {
  detectWeaknesses,
  getTopTopics,
  generateRecommendations,
  generatePersonalizationSnapshot,
  buildPersonalizationContext,
  emitPersonalizationEvent,
  writePersonalizationAudit,
  WEAKNESS_EXPLANATIONS,
  WEAKNESS_BOOST_RULES
};
