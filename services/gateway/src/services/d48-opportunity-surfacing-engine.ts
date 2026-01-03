/**
 * VTID-01142: D48 Context-Aware Opportunity & Experience Surfacing Engine
 *
 * Deterministic intelligence aggregation layer that surfaces timely, relevant
 * opportunities and experiences that fit the user's current life context
 * and predictive windows.
 *
 * This engine answers:
 * "Given who I am and where I am now, what might meaningfully enrich my life?"
 *
 * Hard Governance (Non-Negotiable):
 *   1. Memory-first
 *   2. Context-aware, not promotional
 *   3. User-benefit > monetization
 *   4. Explainability mandatory
 *   5. No dark patterns
 *   6. No forced actions
 *   7. All outputs logged to OASIS
 *   8. No schema-breaking changes
 *
 * What this engine MUST NOT do:
 *   - No auto-purchase
 *   - No push notifications
 *   - No hidden sponsorship bias
 *   - No recommendation without explanation
 *
 * Ethical Constraints:
 *   - No urgency manipulation
 *   - No scarcity framing
 *   - No pressure language
 *   - Clear separation between value and offer
 *
 * Position in Intelligence Stack:
 * D20-D28 (Core) -> D32-D43 (Deep Context) -> D48 (Opportunity Surfacing)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  OpportunitySurfacingInput,
  OpportunitySurfacingResponse,
  ContextualOpportunity,
  OpportunityCandidate,
  OpportunityType,
  RelevanceFactor,
  OpportunitySuggestedAction,
  SurfacingRules,
  DEFAULT_SURFACING_RULES,
  PredictiveWindowsContext,
  AnticipatoryGuidanceContext,
  SocialAlignmentContext,
  getDefaultPredictiveWindowsContext,
  getDefaultAnticipatoryGuidanceContext,
  getDefaultSocialAlignmentContext,
  calculateOpportunityScore,
  generateWhyNow,
  getOpportunityTypePriority,
  OPPORTUNITY_OASIS_EVENT,
  ContextualOpportunityRecord
} from '../types/opportunity-surfacing';
import { PriorityDomain, getDefaultFusionContext, FusionContext } from '../types/context-fusion';

// =============================================================================
// Constants
// =============================================================================

const VTID = 'VTID-01142';
const LOG_PREFIX = '[D48-OpportunitySurfacing]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

/**
 * Priority domain to opportunity type mapping
 */
const DOMAIN_TO_OPPORTUNITY_TYPES: Record<PriorityDomain, OpportunityType[]> = {
  health_wellbeing: ['activity', 'service', 'place'],
  social_relationships: ['experience', 'place', 'activity'],
  learning_growth: ['content', 'experience', 'service'],
  commerce_monetization: ['offer', 'service'],
  exploration_discovery: ['experience', 'place', 'content']
};

/**
 * Opportunity type to priority domain mapping
 */
const OPPORTUNITY_TYPE_TO_DOMAIN: Record<OpportunityType, PriorityDomain> = {
  activity: 'health_wellbeing',
  place: 'social_relationships',
  experience: 'learning_growth',
  content: 'learning_growth',
  service: 'health_wellbeing',
  offer: 'commerce_monetization'
};

// =============================================================================
// Environment Detection
// =============================================================================

function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  return env === 'dev-sandbox' ||
         env === 'dev' ||
         env === 'development' ||
         env === 'sandbox' ||
         env.includes('dev') ||
         env.includes('sandbox');
}

// =============================================================================
// Supabase Client
// =============================================================================

function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function createUserClient(token: string): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_ANON_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// =============================================================================
// Candidate Generation
// =============================================================================

/**
 * Generate opportunity candidates from services catalog
 */
async function generateServiceCandidates(
  supabase: SupabaseClient,
  input: OpportunitySurfacingInput,
  fusionContext: FusionContext
): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  try {
    // Query services catalog
    const { data: services, error } = await supabase
      .from('services_catalog')
      .select('id, name, service_type, topic_keys, provider_name, metadata')
      .eq('tenant_id', input.tenant_id)
      .limit(50);

    if (error) {
      console.warn(`${LOG_PREFIX} Error fetching services:`, error.message);
      return candidates;
    }

    if (!services || services.length === 0) {
      return candidates;
    }

    // Score each service
    for (const service of services) {
      const candidate = scoreServiceCandidate(service, input, fusionContext);
      if (candidate && candidate.context_match >= 50) {
        candidates.push(candidate);
      }
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error generating service candidates:`, error);
  }

  return candidates;
}

/**
 * Score a service as an opportunity candidate
 */
function scoreServiceCandidate(
  service: any,
  input: OpportunitySurfacingInput,
  fusionContext: FusionContext
): OpportunityCandidate | null {
  const topicKeys = service.topic_keys || [];
  const serviceType = service.service_type || 'other';

  // Determine opportunity type based on service type
  let opportunityType: OpportunityType = 'service';
  if (['coach', 'therapy', 'wellness'].includes(serviceType)) {
    opportunityType = 'service';
  } else if (['lab', 'medical'].includes(serviceType)) {
    opportunityType = 'service';
  } else if (['fitness', 'nutrition'].includes(serviceType)) {
    opportunityType = 'activity';
  }

  // Calculate match scores
  const contextMatch = calculateContextMatchScore(topicKeys, fusionContext, input);
  const timingMatch = calculateTimingMatchScore(input.predictive_windows);
  const preferenceMatch = calculatePreferenceMatchScore(topicKeys, fusionContext);
  const socialMatch = calculateSocialMatchScore(input.social_alignment);

  // Check domain consent
  const priorityDomain = OPPORTUNITY_TYPE_TO_DOMAIN[opportunityType];
  if (!fusionContext.boundaries_consent.domain_consent[priorityDomain]) {
    return null;
  }

  // Build why_now fragments
  const whyNowFragments: string[] = [];
  if (input.predictive_windows.active_windows?.length) {
    const relevantWindow = input.predictive_windows.active_windows.find(
      w => w.applicable_domains.includes(priorityDomain)
    );
    if (relevantWindow) {
      whyNowFragments.push(relevantWindow.explanation);
    }
  }
  if (contextMatch > 70) {
    whyNowFragments.push('Aligns well with your current context.');
  }

  // Get matched factors
  const matchedFactors: RelevanceFactor[] = [];
  if (contextMatch > 60) matchedFactors.push('goal_match');
  if (timingMatch > 60) matchedFactors.push('timing_match');
  if (preferenceMatch > 60) matchedFactors.push('preference_match');
  if (socialMatch > 50) matchedFactors.push('social_match');

  return {
    source: 'service',
    source_id: service.id,
    opportunity_type: opportunityType,
    title: service.name,
    description: service.provider_name
      ? `${serviceType} by ${service.provider_name}`
      : `${serviceType} service`,
    base_score: 50,
    context_match: contextMatch,
    timing_match: timingMatch,
    preference_match: preferenceMatch,
    social_match: socialMatch,
    matched_factors: matchedFactors,
    window_ids: [],
    guidance_ids: [],
    signal_ids: [],
    why_now_fragments: whyNowFragments,
    priority_domain: priorityDomain
  };
}

/**
 * Generate opportunity candidates from products catalog
 */
async function generateProductCandidates(
  supabase: SupabaseClient,
  input: OpportunitySurfacingInput,
  fusionContext: FusionContext
): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  // GOVERNANCE: Commerce must be opted in
  if (fusionContext.boundaries_consent.commerce_opted_out) {
    return candidates;
  }

  // GOVERNANCE: User must have commerce consent
  if (!fusionContext.boundaries_consent.domain_consent.commerce_monetization) {
    return candidates;
  }

  try {
    // Query products catalog
    const { data: products, error } = await supabase
      .from('products_catalog')
      .select('id, name, product_type, topic_keys, metadata')
      .eq('tenant_id', input.tenant_id)
      .limit(30);

    if (error) {
      console.warn(`${LOG_PREFIX} Error fetching products:`, error.message);
      return candidates;
    }

    if (!products || products.length === 0) {
      return candidates;
    }

    // Score each product
    for (const product of products) {
      const candidate = scoreProductCandidate(product, input, fusionContext);
      if (candidate && candidate.context_match >= 60) {
        candidates.push(candidate);
      }
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error generating product candidates:`, error);
  }

  return candidates;
}

/**
 * Score a product as an opportunity candidate
 */
function scoreProductCandidate(
  product: any,
  input: OpportunitySurfacingInput,
  fusionContext: FusionContext
): OpportunityCandidate | null {
  const topicKeys = product.topic_keys || [];

  // Calculate match scores
  const contextMatch = calculateContextMatchScore(topicKeys, fusionContext, input);
  const timingMatch = calculateTimingMatchScore(input.predictive_windows);
  const preferenceMatch = calculatePreferenceMatchScore(topicKeys, fusionContext);
  const socialMatch = calculateSocialMatchScore(input.social_alignment);
  const budgetMatch = calculateBudgetMatchScore(input.budget_sensitivity, fusionContext);

  // Build why_now fragments
  const whyNowFragments: string[] = [];
  if (socialMatch > 70) {
    whyNowFragments.push('Others in your community have found this helpful.');
  }
  if (contextMatch > 70) {
    whyNowFragments.push('Matches your current needs.');
  }

  // Get matched factors
  const matchedFactors: RelevanceFactor[] = [];
  if (contextMatch > 60) matchedFactors.push('preference_match');
  if (timingMatch > 60) matchedFactors.push('timing_match');
  if (budgetMatch > 70) matchedFactors.push('budget_match');
  if (socialMatch > 50) matchedFactors.push('social_match');

  return {
    source: 'product',
    source_id: product.id,
    opportunity_type: 'offer' as OpportunityType,
    title: product.name,
    description: `${product.product_type} product`,
    base_score: 30, // Lower base score for commerce
    context_match: contextMatch,
    timing_match: timingMatch,
    preference_match: preferenceMatch,
    social_match: socialMatch,
    budget_match: budgetMatch,
    matched_factors: matchedFactors,
    window_ids: [],
    guidance_ids: [],
    signal_ids: [],
    why_now_fragments: whyNowFragments,
    priority_domain: 'commerce_monetization'
  };
}

/**
 * Generate activity-based opportunity candidates from user context
 */
function generateActivityCandidates(
  input: OpportunitySurfacingInput,
  fusionContext: FusionContext
): OpportunityCandidate[] {
  const candidates: OpportunityCandidate[] = [];

  // Check health domain consent
  if (!fusionContext.boundaries_consent.domain_consent.health_wellbeing) {
    return candidates;
  }

  // Generate activity suggestions based on predictive windows
  const healthWindows = (input.predictive_windows.active_windows || []).filter(
    w => w.applicable_domains.includes('health_wellbeing')
  );

  for (const window of healthWindows) {
    if (window.type === 'recovery_window') {
      candidates.push({
        source: 'activity',
        source_id: `recovery-${window.id}`,
        opportunity_type: 'activity',
        title: 'Recovery Routine',
        description: 'A gentle routine to support your recovery',
        base_score: 80,
        context_match: 85,
        timing_match: 90,
        preference_match: 70,
        social_match: 30,
        matched_factors: ['timing_match', 'health_match', 'goal_match'],
        window_ids: [window.id],
        guidance_ids: [],
        signal_ids: [],
        why_now_fragments: [window.explanation, 'Now is a good time for recovery.'],
        priority_domain: 'health_wellbeing'
      });
    }

    if (window.type === 'health_opportunity') {
      candidates.push({
        source: 'activity',
        source_id: `health-${window.id}`,
        opportunity_type: 'activity',
        title: 'Wellness Check-in',
        description: 'A moment to check in with your wellbeing',
        base_score: 75,
        context_match: 80,
        timing_match: 85,
        preference_match: 65,
        social_match: 40,
        matched_factors: ['timing_match', 'health_match'],
        window_ids: [window.id],
        guidance_ids: [],
        signal_ids: [],
        why_now_fragments: [window.explanation],
        priority_domain: 'health_wellbeing'
      });
    }
  }

  // Generate based on anticipatory guidance
  const healthGuidance = (input.anticipatory_guidance.active_guidance || []).filter(
    g => g.domain === 'health_wellbeing'
  );

  for (const guidance of healthGuidance) {
    if (guidance.type === 'reinforcement_prompt') {
      candidates.push({
        source: 'activity',
        source_id: `guidance-${guidance.id}`,
        opportunity_type: 'activity',
        title: 'Continue Your Progress',
        description: guidance.message,
        base_score: 70,
        context_match: 75,
        timing_match: 80,
        preference_match: 70,
        social_match: 35,
        matched_factors: ['timing_match', 'goal_match'],
        window_ids: guidance.window_id ? [guidance.window_id] : [],
        guidance_ids: [guidance.id],
        signal_ids: [],
        why_now_fragments: [guidance.why_now],
        priority_domain: 'health_wellbeing'
      });
    }
  }

  return candidates;
}

/**
 * Generate social/experience opportunity candidates
 */
function generateSocialCandidates(
  input: OpportunitySurfacingInput,
  fusionContext: FusionContext
): OpportunityCandidate[] {
  const candidates: OpportunityCandidate[] = [];

  // Check social domain consent
  if (!fusionContext.boundaries_consent.domain_consent.social_relationships) {
    return candidates;
  }

  // Generate based on social alignment signals
  const socialSignals = input.social_alignment.signals || [];

  for (const signal of socialSignals) {
    if (signal.type === 'connection_opportunity' && signal.strength > 60) {
      candidates.push({
        source: 'activity',
        source_id: `social-${signal.id}`,
        opportunity_type: 'experience',
        title: 'Connect with Your Community',
        description: signal.description,
        base_score: 70,
        context_match: 75,
        timing_match: 70,
        preference_match: 65,
        social_match: signal.strength,
        matched_factors: ['social_match', 'timing_match'],
        window_ids: [],
        guidance_ids: [],
        signal_ids: [signal.id],
        why_now_fragments: [signal.description],
        priority_domain: 'social_relationships'
      });
    }

    if (signal.type === 'group_event' && signal.strength > 50) {
      candidates.push({
        source: 'activity',
        source_id: `event-${signal.id}`,
        opportunity_type: 'experience',
        title: 'Community Event',
        description: signal.description,
        base_score: 65,
        context_match: 70,
        timing_match: 75,
        preference_match: 60,
        social_match: signal.strength,
        matched_factors: ['social_match', 'timing_match'],
        window_ids: [],
        guidance_ids: [],
        signal_ids: [signal.id],
        why_now_fragments: [`${signal.peer_count || 'Several'} peers are interested.`],
        priority_domain: 'social_relationships'
      });
    }
  }

  // Generate based on social windows
  const socialWindows = (input.predictive_windows.active_windows || []).filter(
    w => w.applicable_domains.includes('social_relationships')
  );

  for (const window of socialWindows) {
    if (window.type === 'social_opportunity') {
      candidates.push({
        source: 'activity',
        source_id: `window-${window.id}`,
        opportunity_type: 'place',
        title: 'Social Opportunity',
        description: 'A good time to connect with others',
        base_score: 65,
        context_match: 70,
        timing_match: window.strength,
        preference_match: 60,
        social_match: 70,
        matched_factors: ['timing_match', 'social_match'],
        window_ids: [window.id],
        guidance_ids: [],
        signal_ids: [],
        why_now_fragments: [window.explanation],
        priority_domain: 'social_relationships'
      });
    }
  }

  return candidates;
}

// =============================================================================
// Scoring Functions
// =============================================================================

/**
 * Calculate context match score
 */
function calculateContextMatchScore(
  topicKeys: string[],
  fusionContext: FusionContext,
  input: OpportunitySurfacingInput
): number {
  let score = 50; // Base score

  // Match against active goals
  const activeGoals = fusionContext.goals_trajectory.active_goals || [];
  for (const goal of activeGoals) {
    // Simple string matching for now
    if (topicKeys.some(key => goal.description.toLowerCase().includes(key.toLowerCase()))) {
      score += 20;
    }
  }

  // Match against taste/lifestyle preferences
  const preferences = fusionContext.taste_lifestyle.active_preferences || [];
  for (const pref of preferences) {
    if (topicKeys.some(key => pref.toLowerCase().includes(key.toLowerCase()))) {
      score += 15;
    }
  }

  // Adjust for health concerns
  const healthConcerns = fusionContext.health_capacity.active_health_concerns || [];
  for (const concern of healthConcerns) {
    if (topicKeys.some(key => concern.toLowerCase().includes(key.toLowerCase()))) {
      score += 10;
    }
  }

  // Adjust for availability
  if (fusionContext.health_capacity.availability === 'high') {
    score += 10;
  } else if (fusionContext.health_capacity.availability === 'minimal') {
    score -= 20;
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Calculate timing match score
 */
function calculateTimingMatchScore(
  windows: Partial<PredictiveWindowsContext>
): number {
  let score = 50; // Base score

  const activeWindows = windows.active_windows || [];
  const imminentWindows = windows.imminent_windows || [];

  // Active windows boost score
  if (activeWindows.length > 0) {
    score += 20;
    // Higher boost for higher confidence windows
    const maxConfidence = Math.max(...activeWindows.map(w => w.confidence));
    score += (maxConfidence / 10);
  }

  // Imminent windows provide moderate boost
  if (imminentWindows.length > 0) {
    score += 10;
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Calculate preference match score
 */
function calculatePreferenceMatchScore(
  topicKeys: string[],
  fusionContext: FusionContext
): number {
  let score = 50; // Base score

  const preferences = fusionContext.taste_lifestyle.active_preferences || [];
  const styleSignals = fusionContext.taste_lifestyle.style_signals || {};

  // Match topic keys against preferences
  for (const pref of preferences) {
    if (topicKeys.some(key => pref.toLowerCase().includes(key.toLowerCase()))) {
      score += 15;
    }
  }

  // Check style signals
  for (const [, value] of Object.entries(styleSignals)) {
    if (topicKeys.some(key => value.toLowerCase().includes(key.toLowerCase()))) {
      score += 10;
    }
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Calculate social match score
 */
function calculateSocialMatchScore(
  socialContext: Partial<SocialAlignmentContext>
): number {
  let score = 40; // Base score

  const signals = socialContext.signals || [];

  // Social proof signals boost score
  const socialProofSignals = signals.filter(s => s.type === 'social_proof');
  score += socialProofSignals.length * 10;

  // Community engagement level
  const engagement = socialContext.community_engagement || 50;
  score += (engagement - 50) / 5;

  // Peer activity level
  const peerActivity = socialContext.peer_activity_level || 50;
  score += (peerActivity - 50) / 5;

  // Social mode affects score
  if (socialContext.social_mode === 'seeking') {
    score += 15;
  } else if (socialContext.social_mode === 'private') {
    score -= 20;
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Calculate budget match score
 */
function calculateBudgetMatchScore(
  sensitivity: OpportunitySurfacingInput['budget_sensitivity'],
  fusionContext: FusionContext
): number {
  // Use input sensitivity or infer from fusion context
  const budgetSensitivity = sensitivity || fusionContext.financial.budget_sensitivity;

  switch (budgetSensitivity) {
    case 'low':
      return 90; // Low sensitivity = good budget match
    case 'medium':
      return 70;
    case 'high':
      return 40; // High sensitivity = poor match for commerce
    default:
      return 50;
  }
}

// =============================================================================
// Filtering Functions
// =============================================================================

/**
 * Filter candidates based on surfacing rules
 */
async function filterCandidates(
  candidates: OpportunityCandidate[],
  input: OpportunitySurfacingInput,
  rules: SurfacingRules,
  supabase: SupabaseClient | null
): Promise<{ filtered: OpportunityCandidate[]; reasons: Record<string, number> }> {
  const filtered: OpportunityCandidate[] = [];
  const reasons: Record<string, number> = {};

  // Get dismissed opportunities for cooldown check
  let dismissedIds: Set<string> = new Set();
  if (supabase) {
    const cooldownDate = new Date();
    cooldownDate.setDate(cooldownDate.getDate() - rules.similar_opportunity_cooldown_days);

    const { data: dismissed } = await supabase
      .from('contextual_opportunities')
      .select('external_id')
      .eq('tenant_id', input.tenant_id)
      .eq('user_id', input.user_id)
      .eq('status', 'dismissed')
      .gte('dismissed_at', cooldownDate.toISOString());

    if (dismissed) {
      dismissedIds = new Set(dismissed.map(d => d.external_id).filter(Boolean));
    }
  }

  for (const candidate of candidates) {
    // Check context match threshold
    if (candidate.context_match < rules.min_context_match) {
      reasons['context_match_low'] = (reasons['context_match_low'] || 0) + 1;
      continue;
    }

    // Check timing relevance
    if (candidate.timing_match < 50) {
      reasons['timing_not_relevant'] = (reasons['timing_not_relevant'] || 0) + 1;
      continue;
    }

    // Check cooldown
    if (dismissedIds.has(candidate.source_id)) {
      reasons['in_cooldown'] = (reasons['in_cooldown'] || 0) + 1;
      continue;
    }

    // Check exclusions
    if (input.exclude_ids?.includes(candidate.source_id)) {
      reasons['excluded'] = (reasons['excluded'] || 0) + 1;
      continue;
    }

    // Check type filter
    if (input.requested_types && !input.requested_types.includes(candidate.opportunity_type)) {
      reasons['type_not_requested'] = (reasons['type_not_requested'] || 0) + 1;
      continue;
    }

    filtered.push(candidate);
  }

  return { filtered, reasons };
}

/**
 * Check user fatigue level
 */
async function checkUserFatigue(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient | null
): Promise<'none' | 'low' | 'medium' | 'high'> {
  if (!supabase) return 'none';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    const { count } = await supabase
      .from('contextual_opportunities')
      .select('id', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .gte('created_at', today.toISOString());

    const opportunitiesToday = count || 0;

    if (opportunitiesToday >= 15) return 'high';
    if (opportunitiesToday >= 10) return 'medium';
    if (opportunitiesToday >= 5) return 'low';
    return 'none';
  } catch (error) {
    console.warn(`${LOG_PREFIX} Error checking fatigue:`, error);
    return 'none';
  }
}

// =============================================================================
// Opportunity Conversion
// =============================================================================

/**
 * Convert candidate to contextual opportunity
 */
function convertToOpportunity(
  candidate: OpportunityCandidate
): ContextualOpportunity {
  const score = calculateOpportunityScore(candidate);
  const whyNow = generateWhyNow(candidate.why_now_fragments);

  // Determine suggested action based on type and score
  let suggestedAction: OpportunitySuggestedAction = 'view';
  if (score > 85) {
    suggestedAction = 'view';
  } else if (score > 70) {
    suggestedAction = 'save';
  }

  return {
    opportunity_id: randomUUID(),
    opportunity_type: candidate.opportunity_type,
    confidence: score,
    why_now: whyNow,
    relevance_factors: candidate.matched_factors,
    suggested_action: suggestedAction,
    dismissible: true,
    title: candidate.title,
    description: candidate.description,
    external_id: candidate.source_id,
    external_type: candidate.source as any,
    priority_domain: candidate.priority_domain,
    window_id: candidate.window_ids[0],
    guidance_id: candidate.guidance_ids[0],
    alignment_signal_ids: candidate.signal_ids.length > 0 ? candidate.signal_ids : undefined,
    computed_at: new Date().toISOString()
  };
}

/**
 * Sort opportunities by priority order
 */
function sortOpportunities(opportunities: ContextualOpportunity[]): ContextualOpportunity[] {
  return [...opportunities].sort((a, b) => {
    // First by type priority
    const priorityA = getOpportunityTypePriority(a.opportunity_type);
    const priorityB = getOpportunityTypePriority(b.opportunity_type);

    if (priorityA !== priorityB) {
      return priorityB - priorityA; // Higher priority first
    }

    // Then by confidence score
    return b.confidence - a.confidence;
  });
}

// =============================================================================
// Storage Functions
// =============================================================================

/**
 * Store surfaced opportunities
 */
async function storeOpportunities(
  opportunities: ContextualOpportunity[],
  input: OpportunitySurfacingInput,
  supabase: SupabaseClient | null
): Promise<void> {
  if (!supabase || opportunities.length === 0) return;

  try {
    const records: Partial<ContextualOpportunityRecord>[] = opportunities.map(opp => ({
      id: opp.opportunity_id,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      session_id: input.session_id,
      opportunity_type: opp.opportunity_type,
      title: opp.title,
      description: opp.description,
      confidence: opp.confidence,
      why_now: opp.why_now,
      relevance_factors: opp.relevance_factors,
      suggested_action: opp.suggested_action,
      dismissible: opp.dismissible,
      priority_domain: opp.priority_domain,
      external_id: opp.external_id,
      external_type: opp.external_type,
      window_id: opp.window_id,
      guidance_id: opp.guidance_id,
      alignment_signal_ids: opp.alignment_signal_ids,
      status: 'active' as const,
      expires_at: opp.expires_at,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));

    const { error } = await supabase
      .from('contextual_opportunities')
      .insert(records);

    if (error) {
      console.warn(`${LOG_PREFIX} Error storing opportunities:`, error.message);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error storing opportunities:`, error);
  }
}

// =============================================================================
// Main Engine Functions
// =============================================================================

/**
 * Surface contextual opportunities
 *
 * Main entry point for D48 opportunity surfacing.
 *
 * @param input - Opportunity surfacing input
 * @param authToken - Optional JWT token for authenticated requests
 * @returns Opportunity surfacing response
 */
export async function surfaceOpportunities(
  input: OpportunitySurfacingInput,
  authToken?: string
): Promise<OpportunitySurfacingResponse> {
  const startTime = Date.now();
  const rulesApplied: string[] = [];

  try {
    // Initialize contexts with defaults
    const predictiveWindows: PredictiveWindowsContext = {
      ...getDefaultPredictiveWindowsContext(),
      ...input.predictive_windows
    };

    const anticipatoryGuidance: AnticipatoryGuidanceContext = {
      ...getDefaultAnticipatoryGuidanceContext(),
      ...input.anticipatory_guidance
    };

    const socialAlignment: SocialAlignmentContext = {
      ...getDefaultSocialAlignmentContext(),
      ...input.social_alignment
    };

    const fusionContext: FusionContext = {
      ...getDefaultFusionContext(),
      ...input.fusion_context
    };

    const rules: SurfacingRules = {
      ...DEFAULT_SURFACING_RULES,
      ...input.surfacing_rules
    };

    // Get Supabase client
    let supabase: SupabaseClient | null = null;
    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    }

    // Check user fatigue
    const fatigueLevel = await checkUserFatigue(input.user_id, input.tenant_id, supabase);
    rulesApplied.push('fatigue_check');

    // GOVERNANCE: High fatigue = no new opportunities
    if (fatigueLevel === 'high') {
      console.log(`${LOG_PREFIX} User fatigue high, skipping opportunity surfacing`);

      await emitOasisEvent({
        vtid: VTID,
        type: OPPORTUNITY_OASIS_EVENT,
        source: 'gateway-d48',
        status: 'info',
        message: 'Opportunity surfacing skipped due to high user fatigue',
        payload: {
          user_id: input.user_id,
          fatigue_level: fatigueLevel,
          reason: 'fatigue_high'
        }
      });

      return {
        ok: true,
        opportunities: [],
        total_considered: 0,
        filtered_count: 0,
        user_fatigue_level: fatigueLevel,
        refresh_after_seconds: 3600, // Wait 1 hour
        metadata: {
          vtid: VTID,
          computed_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          rules_applied: rulesApplied,
          windows_active: predictiveWindows.active_windows.length,
          guidance_active: anticipatoryGuidance.active_guidance.length,
          signals_active: socialAlignment.signals.length
        }
      };
    }

    // Generate candidates
    const allCandidates: OpportunityCandidate[] = [];

    // 1. Activity candidates (health & wellness)
    const activityCandidates = generateActivityCandidates(
      { ...input, predictive_windows: predictiveWindows, anticipatory_guidance: anticipatoryGuidance },
      fusionContext
    );
    allCandidates.push(...activityCandidates);
    rulesApplied.push('generate_activity_candidates');

    // 2. Social/experience candidates
    const socialCandidates = generateSocialCandidates(
      { ...input, predictive_windows: predictiveWindows, social_alignment: socialAlignment },
      fusionContext
    );
    allCandidates.push(...socialCandidates);
    rulesApplied.push('generate_social_candidates');

    // 3. Service candidates (from catalog)
    if (supabase) {
      const serviceCandidates = await generateServiceCandidates(
        supabase,
        { ...input, predictive_windows: predictiveWindows },
        fusionContext
      );
      allCandidates.push(...serviceCandidates);
      rulesApplied.push('generate_service_candidates');

      // 4. Product candidates (commerce - only if opted in)
      const productCandidates = await generateProductCandidates(
        supabase,
        { ...input, predictive_windows: predictiveWindows },
        fusionContext
      );
      allCandidates.push(...productCandidates);
      rulesApplied.push('generate_product_candidates');
    }

    // Filter candidates
    const { filtered: filteredCandidates, reasons: filterReasons } = await filterCandidates(
      allCandidates,
      input,
      rules,
      supabase
    );
    rulesApplied.push('filter_candidates');

    // Convert to opportunities
    const opportunities = filteredCandidates.map(convertToOpportunity);
    rulesApplied.push('convert_opportunities');

    // Sort by priority
    const sortedOpportunities = sortOpportunities(opportunities);
    rulesApplied.push('sort_opportunities');

    // Apply limits
    const limitedOpportunities = sortedOpportunities.slice(0, rules.max_opportunities_per_session);
    rulesApplied.push('apply_limits');

    // Store opportunities
    await storeOpportunities(limitedOpportunities, input, supabase);
    rulesApplied.push('store_opportunities');

    const duration = Date.now() - startTime;

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: OPPORTUNITY_OASIS_EVENT,
      source: 'gateway-d48',
      status: 'success',
      message: `Surfaced ${limitedOpportunities.length} opportunities`,
      payload: {
        user_id: input.user_id,
        session_id: input.session_id,
        opportunities_surfaced: limitedOpportunities.length,
        opportunities_considered: allCandidates.length,
        opportunities_filtered: allCandidates.length - filteredCandidates.length,
        fatigue_level: fatigueLevel,
        duration_ms: duration
      }
    });

    console.log(
      `${LOG_PREFIX} Surfaced ${limitedOpportunities.length} opportunities in ${duration}ms ` +
      `(considered=${allCandidates.length}, filtered=${allCandidates.length - filteredCandidates.length})`
    );

    return {
      ok: true,
      opportunities: limitedOpportunities,
      total_considered: allCandidates.length,
      filtered_count: allCandidates.length - filteredCandidates.length,
      filter_reasons: filterReasons,
      user_fatigue_level: fatigueLevel,
      refresh_after_seconds: 300, // Refresh after 5 minutes
      metadata: {
        vtid: VTID,
        computed_at: new Date().toISOString(),
        duration_ms: duration,
        rules_applied: rulesApplied,
        windows_active: predictiveWindows.active_windows.length,
        guidance_active: anticipatoryGuidance.active_guidance.length,
        signals_active: socialAlignment.signals.length
      }
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error surfacing opportunities:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: `${OPPORTUNITY_OASIS_EVENT}.failed`,
      source: 'gateway-d48',
      status: 'error',
      message: `Opportunity surfacing failed: ${errorMessage}`,
      payload: {
        user_id: input.user_id,
        session_id: input.session_id,
        error: errorMessage
      }
    });

    return {
      ok: false,
      error: 'SURFACING_FAILED',
      message: errorMessage
    };
  }
}

/**
 * Dismiss an opportunity
 */
export async function dismissOpportunity(
  opportunityId: string,
  userId: string,
  tenantId: string,
  reason?: 'not_interested' | 'not_relevant' | 'already_done' | 'too_soon' | 'other',
  authToken?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    let supabase: SupabaseClient | null = null;
    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    }

    if (!supabase) {
      return { ok: false, error: 'NO_DATABASE_CONNECTION' };
    }

    const { error } = await supabase
      .from('contextual_opportunities')
      .update({
        status: 'dismissed',
        dismissed_at: new Date().toISOString(),
        dismissed_reason: reason || 'not_interested',
        updated_at: new Date().toISOString()
      })
      .eq('id', opportunityId)
      .eq('user_id', userId)
      .eq('tenant_id', tenantId);

    if (error) {
      console.warn(`${LOG_PREFIX} Error dismissing opportunity:`, error.message);
      return { ok: false, error: error.message };
    }

    await emitOasisEvent({
      vtid: VTID,
      type: 'opportunity.dismissed',
      source: 'gateway-d48',
      status: 'success',
      message: `Opportunity ${opportunityId} dismissed`,
      payload: {
        opportunity_id: opportunityId,
        user_id: userId,
        reason
      }
    });

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

/**
 * Record engagement with an opportunity
 */
export async function recordEngagement(
  opportunityId: string,
  userId: string,
  tenantId: string,
  engagementType: 'viewed' | 'saved' | 'clicked' | 'completed',
  authToken?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    let supabase: SupabaseClient | null = null;
    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    }

    if (!supabase) {
      return { ok: false, error: 'NO_DATABASE_CONNECTION' };
    }

    const { error } = await supabase
      .from('contextual_opportunities')
      .update({
        status: engagementType === 'completed' ? 'engaged' : 'active',
        engaged_at: new Date().toISOString(),
        engagement_type: engagementType,
        updated_at: new Date().toISOString()
      })
      .eq('id', opportunityId)
      .eq('user_id', userId)
      .eq('tenant_id', tenantId);

    if (error) {
      console.warn(`${LOG_PREFIX} Error recording engagement:`, error.message);
      return { ok: false, error: error.message };
    }

    await emitOasisEvent({
      vtid: VTID,
      type: 'opportunity.engaged',
      source: 'gateway-d48',
      status: 'success',
      message: `Opportunity ${opportunityId} engaged: ${engagementType}`,
      payload: {
        opportunity_id: opportunityId,
        user_id: userId,
        engagement_type: engagementType
      }
    });

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get active opportunities for user
 */
export async function getActiveOpportunities(
  userId: string,
  tenantId: string,
  limit: number = 10,
  authToken?: string
): Promise<{ ok: boolean; opportunities?: ContextualOpportunity[]; error?: string }> {
  try {
    let supabase: SupabaseClient | null = null;
    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
    }

    if (!supabase) {
      return { ok: false, error: 'NO_DATABASE_CONNECTION' };
    }

    const { data, error } = await supabase
      .from('contextual_opportunities')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn(`${LOG_PREFIX} Error fetching opportunities:`, error.message);
      return { ok: false, error: error.message };
    }

    // Convert records to opportunities
    const opportunities: ContextualOpportunity[] = (data || []).map(record => ({
      opportunity_id: record.id,
      opportunity_type: record.opportunity_type,
      confidence: record.confidence,
      why_now: record.why_now,
      relevance_factors: record.relevance_factors,
      suggested_action: record.suggested_action,
      dismissible: record.dismissible,
      title: record.title,
      description: record.description,
      external_id: record.external_id,
      external_type: record.external_type,
      priority_domain: record.priority_domain,
      window_id: record.window_id,
      guidance_id: record.guidance_id,
      alignment_signal_ids: record.alignment_signal_ids,
      computed_at: record.created_at,
      expires_at: record.expires_at
    }));

    return { ok: true, opportunities };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  DEFAULT_SURFACING_RULES
};

export type {
  OpportunitySurfacingInput,
  OpportunitySurfacingResponse,
  ContextualOpportunity,
  OpportunityType,
  SurfacingRules
};
