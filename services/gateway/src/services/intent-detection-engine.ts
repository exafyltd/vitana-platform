/**
 * VTID-01113: Intent Detection & Classification Engine (D21)
 *
 * Core Intelligence layer that identifies user intent BEFORE ORB responds.
 * This engine provides direction for downstream intelligence operations.
 *
 * Key principles:
 * - Deterministic: Same inputs → same classification (no generative creativity)
 * - Multi-signal: Combines input text, conversation history, context, role, mode
 * - Traceable: Every intent bundle is logged for explainability
 * - Safety-aware: Low confidence intents reduce downstream autonomy
 *
 * Position in stack:
 *   Memory → D20 Context → D21 Intent → Intelligence
 *
 * Dependencies:
 * - D20 Context Assembly (orb-memory-bridge.ts)
 * - OASIS Event Service (oasis-event-service.ts)
 */

import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// VTID-01113: Constants & Configuration
// =============================================================================

/**
 * Intent Detection Configuration
 * Tunable thresholds for confidence and safety
 */
export const INTENT_CONFIG = {
  // Minimum confidence to consider an intent valid (below = ambiguous)
  CONFIDENCE_THRESHOLD: 0.6,
  // Maximum number of secondary intents to track
  MAX_SECONDARY_INTENTS: 3,
  // Weight factors for multi-signal scoring
  SIGNAL_WEIGHTS: {
    current_input: 0.5,       // Current user input is primary signal
    conversation_history: 0.2, // Recent turns provide context
    memory_context: 0.15,      // D20 context informs long-term patterns
    role_mode: 0.1,            // Active role/mode influences classification
    temporal: 0.05             // Time/situational signals (lightweight)
  },
  // Keywords that trigger safety flags for specific domains
  SAFETY_DOMAINS: ['health', 'commerce'] as const
};

// =============================================================================
// VTID-01113: Canonical Intent Classes
// =============================================================================

/**
 * Canonical Intent Classes (per spec section 4)
 * These are mutually exclusive primary categories
 */
export const INTENT_CLASSES = [
  'information',  // Learn, understand, ask questions
  'action',       // Do something now, execute task
  'reflection',   // Analyze past, diary, memory review
  'decision',     // Choose between options
  'connection',   // People, groups, events, community
  'health',       // Body, mind, habits, wellness
  'commerce',     // Buy, sell, promote, affiliate
  'system'        // Settings, permissions, configuration
] as const;

export type IntentClass = typeof INTENT_CLASSES[number];

/**
 * Urgency levels for intent prioritization
 */
export const URGENCY_LEVELS = ['low', 'normal', 'high', 'critical'] as const;
export type UrgencyLevel = typeof URGENCY_LEVELS[number];

/**
 * Domain tags for cross-cutting concerns
 */
export const DOMAIN_TAGS = [
  'personal',      // Personal identity, preferences
  'professional',  // Work, career, business
  'social',        // Relationships, community
  'wellness',      // Health, fitness, mental health
  'productivity',  // Tasks, planning, organization
  'learning',      // Education, skill development
  'financial',     // Money, investments, commerce
  'technical'      // System, settings, technical
] as const;

export type DomainTag = typeof DOMAIN_TAGS[number];

// =============================================================================
// VTID-01113: Intent Bundle Type (Canonical Output)
// =============================================================================

/**
 * Intent Bundle - Immutable output per turn (spec section 5)
 * This structure is attached to context_bundle and logged
 */
export interface IntentBundle {
  /** Primary detected intent */
  primary_intent: IntentClass;
  /** Ranked secondary intents (max 3) */
  secondary_intents: IntentClass[];
  /** Confidence score 0.0-1.0 */
  confidence_score: number;
  /** Urgency level for prioritization */
  urgency_level: UrgencyLevel;
  /** Cross-cutting domain tags */
  domain_tags: DomainTag[];
  /** Whether intent is ambiguous (confidence < threshold) */
  is_ambiguous: boolean;
  /** Safety flag for medical/financial intents */
  requires_safety_review: boolean;
  /** Classification timestamp */
  classified_at: string;
  /** Unique ID for this intent bundle (for logging) */
  bundle_id: string;
}

// =============================================================================
// VTID-01113: Input Signal Types
// =============================================================================

/**
 * Active role types in the system
 */
export type ActiveRole = 'patient' | 'community' | 'professional' | 'admin' | 'developer';

/**
 * Interaction mode types
 */
export type InteractionMode = 'chat' | 'orb' | 'autopilot' | 'system';

/**
 * Context from D20 Context Assembly (orb-memory-bridge)
 * Simplified interface for intent detection purposes
 */
export interface ContextBundleSignal {
  /** User ID for this context */
  user_id: string;
  /** Categories present in memory context */
  memory_categories: string[];
  /** Number of memory items available */
  memory_item_count: number;
  /** Key personal facts extracted */
  personal_facts: string[];
  /** Recent topics from conversation history */
  recent_topics: string[];
}

/**
 * Conversation history signal
 */
export interface ConversationSignal {
  /** Recent conversation turns (last N) */
  recent_turns: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
  }>;
  /** Total turns in conversation */
  turn_count: number;
}

/**
 * Temporal/situational signal (lightweight)
 */
export interface TemporalSignal {
  /** Current hour of day (0-23) */
  hour_of_day: number;
  /** Day of week (0-6, Sunday=0) */
  day_of_week: number;
  /** Is within business hours */
  is_business_hours: boolean;
}

/**
 * Complete input for intent detection
 * Combines all signals per spec section 3
 */
export interface IntentDetectionInput {
  /** Current user input text (primary signal) */
  current_input: string;
  /** Conversation context */
  conversation: ConversationSignal;
  /** D20 context bundle (optional - may not be available) */
  context_bundle?: ContextBundleSignal;
  /** Active user role */
  active_role: ActiveRole;
  /** Interaction mode */
  mode: InteractionMode;
  /** Temporal signal (optional - derived if not provided) */
  temporal?: TemporalSignal;
}

// =============================================================================
// VTID-01113: Intent Classification Keywords
// =============================================================================

/**
 * Keyword patterns for deterministic classification
 * These are checked in priority order (first match wins for primary)
 * Multiple matches contribute to secondary intents
 */
const INTENT_KEYWORDS: Record<IntentClass, RegExp[]> = {
  // System intents (highest priority - safety critical)
  system: [
    /\b(settings?|config(ure)?|permissions?|privacy|account|password|security|logout|login|sign out|sign in)\b/i,
    /\b(enable|disable|turn (on|off)|toggle|activate|deactivate)\b/i,
    /\b(notification|alert|reminder|preference)\s*(settings?|config)?\b/i,
    /\b(einstellungen|konfiguration|passwort|konto|datenschutz|abmelden|anmelden)\b/i
  ],

  // Health intents (safety flagged)
  health: [
    /\b(health|fitness|exercise|workout|sleep|diet|nutrition|weight|bmi)\b/i,
    /\b(symptom|pain|headache|fever|sick|illness|doctor|medicine|medication)\b/i,
    /\b(blood|heart|pulse|hrv|glucose|insulin|cholesterol|vitamin|supplement)\b/i,
    /\b(mental|anxiety|stress|depression|mood|therapy|meditation|mindful)\b/i,
    /\b(gesundheit|fitness|schlaf|ern[aä]hrung|gewicht|symptom|schmerz|arzt|medikament)\b/i,
    /\b(habit|routine|daily|morning|evening|night)\s*(routine|habit|practice)?\b/i
  ],

  // Commerce intents (safety flagged)
  commerce: [
    /\b(buy|purchase|order|shop|cart|checkout|pay|payment)\b/i,
    /\b(sell|product|service|pricing|price|cost|discount|deal|offer)\b/i,
    /\b(affiliate|promote|marketing|advertise|sponsor)\b/i,
    /\b(subscription|plan|upgrade|premium|trial|cancel)\b/i,
    /\b(kaufen|bestellen|preis|kosten|rabatt|angebot|bezahlen)\b/i
  ],

  // Connection intents (people, community, events)
  connection: [
    /\b(friend|family|partner|wife|husband|child|parent|colleague)\b/i,
    /\b(meet|meetup|event|gathering|party|celebration|conference)\b/i,
    /\b(community|group|club|member|network|social)\b/i,
    /\b(relationship|dating|match|connect|introduce)\b/i,
    /\b(freund|familie|partner|kind|eltern|kollege|treffen|veranstaltung|gemeinschaft)\b/i
  ],

  // Decision intents
  decision: [
    /\b(should i|which|choose|decide|decision|option|alternative|compare)\b/i,
    /\b(better|best|worse|worst|pros?|cons?|trade.?off)\b/i,
    /\b(recommend|suggest|advice|opinion|think about)\b/i,
    /\b(soll ich|welche|entscheiden|entscheidung|option|vergleich|empfehl)\b/i
  ],

  // Reflection intents
  reflection: [
    /\b(remember|memory|recall|past|yesterday|last (week|month|year))\b/i,
    /\b(diary|journal|log|reflect|review|summary|summarize)\b/i,
    /\b(what did (i|we)|how did|when did|looking back)\b/i,
    /\b(erinnern|erinnerung|gestern|letzte|tagebuch|zusammenfassung)\b/i
  ],

  // Action intents
  action: [
    /\b(do|make|create|add|remove|delete|update|change|edit|send|submit)\b/i,
    /\b(schedule|book|reserve|cancel|reschedule|set up|arrange)\b/i,
    /\b(start|begin|stop|end|pause|resume|continue)\b/i,
    /\b(call|email|message|notify|remind|alert)\b/i,
    /\b(machen|erstellen|hinzuf[uü]gen|l[oö]schen|[aä]ndern|senden|buchen)\b/i
  ],

  // Information intents (catch-all for questions)
  information: [
    /\b(what|who|where|when|why|how|which|tell me|explain|describe)\b/i,
    /\b(is|are|can|does|do|will|would|could|should)\s+(it|there|this|that|i|you|we|they)\b/i,
    /\b(learn|understand|know|find out|look up|search|information)\b/i,
    /\b(was|wer|wo|wann|warum|wie|welche|erkl[aä]r|beschreib|informati)\b/i,
    /\?$/  // Questions ending with ?
  ]
};

/**
 * Domain tag patterns for cross-cutting classification
 */
const DOMAIN_TAG_KEYWORDS: Record<DomainTag, RegExp[]> = {
  personal: [
    /\b(my|mine|i|me|myself|personal|private)\b/i,
    /\b(mein|mir|ich|pers[oö]nlich|privat)\b/i
  ],
  professional: [
    /\b(work|job|career|business|office|meeting|project|deadline)\b/i,
    /\b(arbeit|beruf|gesch[aä]ft|b[uü]ro|projekt)\b/i
  ],
  social: [
    /\b(friend|family|people|social|community|group|relationship)\b/i,
    /\b(freund|familie|leute|sozial|beziehung)\b/i
  ],
  wellness: [
    /\b(health|wellness|fitness|mental|stress|sleep|exercise)\b/i,
    /\b(gesundheit|wohlbefinden|fitness|mental|stress|schlaf)\b/i
  ],
  productivity: [
    /\b(task|todo|plan|schedule|organize|priority|goal|deadline)\b/i,
    /\b(aufgabe|plan|zeitplan|organisieren|priorit[aä]t|ziel)\b/i
  ],
  learning: [
    /\b(learn|study|course|tutorial|practice|skill|education)\b/i,
    /\b(lernen|studieren|kurs|[uü]bung|f[aä]higkeit|bildung)\b/i
  ],
  financial: [
    /\b(money|budget|invest|saving|expense|income|finance|bank)\b/i,
    /\b(geld|budget|investieren|sparen|ausgaben|einkommen|finanzen|bank)\b/i
  ],
  technical: [
    /\b(setting|config|system|app|software|device|technical|bug|error)\b/i,
    /\b(einstellung|system|app|software|ger[aä]t|technisch|fehler)\b/i
  ]
};

/**
 * Urgency detection patterns
 */
const URGENCY_PATTERNS: Record<UrgencyLevel, RegExp[]> = {
  critical: [
    /\b(emergency|urgent|critical|immediately|asap|right now|help!)\b/i,
    /\b(notfall|dringend|sofort|hilfe!)\b/i
  ],
  high: [
    /\b(soon|quickly|hurry|important|priority|today)\b/i,
    /\b(bald|schnell|wichtig|priorit[aä]t|heute)\b/i
  ],
  normal: [],  // Default
  low: [
    /\b(sometime|eventually|whenever|no rush|just curious|just wondering)\b/i,
    /\b(irgendwann|keine eile|nur neugierig)\b/i
  ]
};

// =============================================================================
// VTID-01113: Core Classification Functions
// =============================================================================

/**
 * Generate a unique bundle ID
 */
function generateBundleId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `intent-${timestamp}-${random}`;
}

/**
 * Generate temporal signal from current time
 */
function generateTemporalSignal(): TemporalSignal {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  // Business hours: 9-17 on weekdays
  const isBusinessHours = hour >= 9 && hour < 17 && day > 0 && day < 6;

  return {
    hour_of_day: hour,
    day_of_week: day,
    is_business_hours: isBusinessHours
  };
}

/**
 * Calculate match score for a text against keyword patterns
 * Returns score 0.0-1.0 based on number of matches
 */
function calculateKeywordScore(text: string, patterns: RegExp[]): number {
  if (patterns.length === 0) return 0;

  let matches = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      matches++;
    }
  }

  // Score is ratio of matches to total patterns, capped at 1.0
  return Math.min(matches / Math.max(patterns.length * 0.5, 1), 1.0);
}

/**
 * Classify intent from text using keyword matching
 * Returns ranked list of (intent, score) pairs
 */
function classifyFromText(text: string): Array<{ intent: IntentClass; score: number }> {
  const scores: Array<{ intent: IntentClass; score: number }> = [];

  for (const intentClass of INTENT_CLASSES) {
    const patterns = INTENT_KEYWORDS[intentClass];
    const score = calculateKeywordScore(text, patterns);
    if (score > 0) {
      scores.push({ intent: intentClass, score });
    }
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  return scores;
}

/**
 * Extract domain tags from text
 */
function extractDomainTags(text: string): DomainTag[] {
  const tags: DomainTag[] = [];

  for (const [tag, patterns] of Object.entries(DOMAIN_TAG_KEYWORDS)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        tags.push(tag as DomainTag);
        break; // One match per domain is enough
      }
    }
  }

  return tags;
}

/**
 * Detect urgency level from text
 */
function detectUrgency(text: string): UrgencyLevel {
  // Check in priority order (critical → high → low)
  for (const pattern of URGENCY_PATTERNS.critical) {
    if (pattern.test(text)) return 'critical';
  }
  for (const pattern of URGENCY_PATTERNS.high) {
    if (pattern.test(text)) return 'high';
  }
  for (const pattern of URGENCY_PATTERNS.low) {
    if (pattern.test(text)) return 'low';
  }
  return 'normal';
}

/**
 * Combine conversation history into context string
 */
function getConversationContext(conversation: ConversationSignal): string {
  // Take last 3 turns for context
  const recentTurns = conversation.recent_turns.slice(-3);
  return recentTurns.map(t => t.content).join(' ');
}

/**
 * Apply role/mode weighting to intent scores
 * Certain roles naturally bias toward certain intents
 */
function applyRoleModeWeighting(
  scores: Array<{ intent: IntentClass; score: number }>,
  role: ActiveRole,
  mode: InteractionMode
): Array<{ intent: IntentClass; score: number }> {
  const roleBoosts: Record<ActiveRole, Partial<Record<IntentClass, number>>> = {
    patient: { health: 0.15, reflection: 0.1 },
    community: { connection: 0.15, commerce: 0.05 },
    professional: { action: 0.1, decision: 0.1 },
    admin: { system: 0.2, action: 0.1 },
    developer: { system: 0.15, action: 0.1 }
  };

  const modeBoosts: Record<InteractionMode, Partial<Record<IntentClass, number>>> = {
    chat: { information: 0.1 },
    orb: { reflection: 0.1, connection: 0.05 },
    autopilot: { action: 0.2 },
    system: { system: 0.2 }
  };

  return scores.map(({ intent, score }) => {
    let adjusted = score;
    adjusted += roleBoosts[role]?.[intent] || 0;
    adjusted += modeBoosts[mode]?.[intent] || 0;
    return { intent, score: Math.min(adjusted, 1.0) };
  }).sort((a, b) => b.score - a.score);
}

// =============================================================================
// VTID-01113: Main Classification Function
// =============================================================================

/**
 * Detect intent from multi-signal input
 * This is the primary entry point for the Intent Detection Engine
 *
 * DETERMINISTIC: Same inputs will always produce same outputs
 * NO GENERATIVE CREATIVITY: Classification only, no response generation
 *
 * @param input - Multi-signal input (current text, conversation, context, role, mode)
 * @returns Immutable IntentBundle for this turn
 */
export function detectIntent(input: IntentDetectionInput): IntentBundle {
  const bundleId = generateBundleId();
  const classifiedAt = new Date().toISOString();

  // Generate temporal signal if not provided
  const temporal = input.temporal || generateTemporalSignal();

  // =========================================================================
  // Step 1: Classify from current input (primary signal - weight 0.5)
  // =========================================================================
  const currentInputScores = classifyFromText(input.current_input);

  // =========================================================================
  // Step 2: Classify from conversation history (weight 0.2)
  // =========================================================================
  const conversationContext = getConversationContext(input.conversation);
  const conversationScores = classifyFromText(conversationContext);

  // =========================================================================
  // Step 3: Extract context bundle signals (weight 0.15)
  // =========================================================================
  let contextScores: Array<{ intent: IntentClass; score: number }> = [];
  if (input.context_bundle) {
    // Personal/relationship memory presence boosts reflection and connection
    const hasPersonalMemory = input.context_bundle.memory_categories.includes('personal');
    const hasRelationshipMemory = input.context_bundle.memory_categories.includes('relationships');
    const hasHealthMemory = input.context_bundle.memory_categories.includes('health');

    if (hasPersonalMemory) {
      contextScores.push({ intent: 'reflection', score: 0.5 });
    }
    if (hasRelationshipMemory) {
      contextScores.push({ intent: 'connection', score: 0.5 });
    }
    if (hasHealthMemory) {
      contextScores.push({ intent: 'health', score: 0.3 });
    }
  }

  // =========================================================================
  // Step 4: Combine all signals with weighted scoring
  // =========================================================================
  const { SIGNAL_WEIGHTS } = INTENT_CONFIG;
  const combinedScores: Map<IntentClass, number> = new Map();

  // Initialize all intents
  for (const intent of INTENT_CLASSES) {
    combinedScores.set(intent, 0);
  }

  // Add current input scores (weight 0.5)
  for (const { intent, score } of currentInputScores) {
    const current = combinedScores.get(intent) || 0;
    combinedScores.set(intent, current + score * SIGNAL_WEIGHTS.current_input);
  }

  // Add conversation scores (weight 0.2)
  for (const { intent, score } of conversationScores) {
    const current = combinedScores.get(intent) || 0;
    combinedScores.set(intent, current + score * SIGNAL_WEIGHTS.conversation_history);
  }

  // Add context bundle scores (weight 0.15)
  for (const { intent, score } of contextScores) {
    const current = combinedScores.get(intent) || 0;
    combinedScores.set(intent, current + score * SIGNAL_WEIGHTS.memory_context);
  }

  // =========================================================================
  // Step 5: Apply role/mode weighting (weight 0.1)
  // =========================================================================
  const sortedScores = Array.from(combinedScores.entries())
    .map(([intent, score]) => ({ intent, score }))
    .filter(s => s.score > 0);

  const weightedScores = applyRoleModeWeighting(sortedScores, input.active_role, input.mode);

  // =========================================================================
  // Step 6: Determine primary and secondary intents
  // =========================================================================
  let primaryIntent: IntentClass = 'information'; // Default fallback
  let confidenceScore = 0;
  const secondaryIntents: IntentClass[] = [];

  if (weightedScores.length > 0) {
    primaryIntent = weightedScores[0].intent;
    confidenceScore = Math.min(weightedScores[0].score, 1.0);

    // Add secondary intents (up to MAX_SECONDARY_INTENTS)
    for (let i = 1; i < Math.min(weightedScores.length, INTENT_CONFIG.MAX_SECONDARY_INTENTS + 1); i++) {
      if (weightedScores[i].score > 0.1) { // Only include if reasonably confident
        secondaryIntents.push(weightedScores[i].intent);
      }
    }
  } else {
    // No matches found - low confidence default to information
    confidenceScore = 0.3;
  }

  // =========================================================================
  // Step 7: Extract domain tags and urgency
  // =========================================================================
  const domainTags = extractDomainTags(input.current_input);
  const urgencyLevel = detectUrgency(input.current_input);

  // =========================================================================
  // Step 8: Apply safety constraints (spec section 8)
  // =========================================================================
  const isAmbiguous = confidenceScore < INTENT_CONFIG.CONFIDENCE_THRESHOLD;
  const requiresSafetyReview = INTENT_CONFIG.SAFETY_DOMAINS.includes(primaryIntent as any) ||
    secondaryIntents.some(i => INTENT_CONFIG.SAFETY_DOMAINS.includes(i as any));

  // =========================================================================
  // Step 9: Construct immutable intent bundle
  // =========================================================================
  const intentBundle: IntentBundle = {
    primary_intent: primaryIntent,
    secondary_intents: secondaryIntents,
    confidence_score: Math.round(confidenceScore * 100) / 100, // 2 decimal places
    urgency_level: urgencyLevel,
    domain_tags: domainTags,
    is_ambiguous: isAmbiguous,
    requires_safety_review: requiresSafetyReview,
    classified_at: classifiedAt,
    bundle_id: bundleId
  };

  return intentBundle;
}

// =============================================================================
// VTID-01113: OASIS Event Logging (Traceability)
// =============================================================================

/**
 * Log intent bundle to OASIS for traceability (spec section 9)
 * Every ORB turn must have its intent bundle logged
 */
export async function logIntentToOasis(
  intentBundle: IntentBundle,
  input: IntentDetectionInput,
  userId?: string,
  conversationId?: string
): Promise<{ ok: boolean; event_id?: string; error?: string }> {
  return emitOasisEvent({
    vtid: 'VTID-01113',
    type: 'orb.intent.classified' as any, // VTID-01113: Custom event type
    source: 'intent-detection-engine',
    status: intentBundle.is_ambiguous ? 'warning' : 'success',
    message: `Intent classified: ${intentBundle.primary_intent} (confidence: ${intentBundle.confidence_score})`,
    payload: {
      bundle_id: intentBundle.bundle_id,
      primary_intent: intentBundle.primary_intent,
      secondary_intents: intentBundle.secondary_intents,
      confidence_score: intentBundle.confidence_score,
      urgency_level: intentBundle.urgency_level,
      domain_tags: intentBundle.domain_tags,
      is_ambiguous: intentBundle.is_ambiguous,
      requires_safety_review: intentBundle.requires_safety_review,
      input_preview: input.current_input.substring(0, 100),
      active_role: input.active_role,
      mode: input.mode,
      user_id: userId,
      conversation_id: conversationId,
      classified_at: intentBundle.classified_at
    }
  });
}

/**
 * Log ambiguous intent warning to OASIS
 * Used when intent detection cannot confidently classify user intent
 */
export async function logAmbiguousIntentWarning(
  intentBundle: IntentBundle,
  userId?: string,
  conversationId?: string
): Promise<{ ok: boolean; event_id?: string; error?: string }> {
  if (!intentBundle.is_ambiguous) {
    return { ok: true }; // Not ambiguous, no warning needed
  }

  return emitOasisEvent({
    vtid: 'VTID-01113',
    type: 'orb.intent.ambiguous' as any, // VTID-01113: Custom event type
    source: 'intent-detection-engine',
    status: 'warning',
    message: `Ambiguous intent detected (confidence: ${intentBundle.confidence_score})`,
    payload: {
      bundle_id: intentBundle.bundle_id,
      primary_intent: intentBundle.primary_intent,
      confidence_score: intentBundle.confidence_score,
      threshold: INTENT_CONFIG.CONFIDENCE_THRESHOLD,
      user_id: userId,
      conversation_id: conversationId,
      autonomy_reduction: true,
      classified_at: intentBundle.classified_at
    }
  });
}

/**
 * Log safety-flagged intent to OASIS
 * Used when medical/financial intents require additional review
 */
export async function logSafetyFlaggedIntent(
  intentBundle: IntentBundle,
  userId?: string,
  conversationId?: string
): Promise<{ ok: boolean; event_id?: string; error?: string }> {
  if (!intentBundle.requires_safety_review) {
    return { ok: true }; // No safety flag, no logging needed
  }

  return emitOasisEvent({
    vtid: 'VTID-01113',
    type: 'orb.intent.safety_flagged' as any, // VTID-01113: Custom event type
    source: 'intent-detection-engine',
    status: 'info',
    message: `Safety-flagged intent: ${intentBundle.primary_intent}`,
    payload: {
      bundle_id: intentBundle.bundle_id,
      primary_intent: intentBundle.primary_intent,
      secondary_intents: intentBundle.secondary_intents,
      domain_tags: intentBundle.domain_tags,
      user_id: userId,
      conversation_id: conversationId,
      requires_human_review: intentBundle.urgency_level === 'critical',
      classified_at: intentBundle.classified_at
    }
  });
}

// =============================================================================
// VTID-01113: Integration Helpers
// =============================================================================

/**
 * Build ContextBundleSignal from OrbMemoryContext
 * Converts D20 output to D21 input format
 */
export function buildContextSignalFromMemory(
  memoryContext: { ok: boolean; user_id: string; items: Array<{ category_key: string; content: string }> }
): ContextBundleSignal | undefined {
  if (!memoryContext.ok || !memoryContext.items?.length) {
    return undefined;
  }

  // Extract unique categories
  const categorySet = new Set<string>();
  const personalFacts: string[] = [];

  for (const item of memoryContext.items) {
    categorySet.add(item.category_key);
    if (item.category_key === 'personal' || item.category_key === 'relationships') {
      personalFacts.push(item.content.substring(0, 100));
    }
  }

  return {
    user_id: memoryContext.user_id,
    memory_categories: Array.from(categorySet),
    memory_item_count: memoryContext.items.length,
    personal_facts: personalFacts.slice(0, 5),
    recent_topics: [] // TODO: Could extract from conversation items
  };
}

/**
 * Build ConversationSignal from ORB conversation history
 */
export function buildConversationSignal(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTurns: number = 10
): ConversationSignal {
  const recentTurns = history.slice(-maxTurns);
  return {
    recent_turns: recentTurns,
    turn_count: history.length
  };
}

/**
 * Quick intent detection for simple cases
 * Shorthand when only text input is available
 */
export function detectIntentSimple(
  text: string,
  role: ActiveRole = 'patient',
  mode: InteractionMode = 'orb'
): IntentBundle {
  return detectIntent({
    current_input: text,
    conversation: { recent_turns: [], turn_count: 0 },
    active_role: role,
    mode: mode
  });
}

// =============================================================================
// VTID-01113: Debug & Export Helpers
// =============================================================================

/**
 * Get intent bundle as debug-friendly object
 * Includes all scores and signals for debugging
 */
export function getIntentDebugInfo(input: IntentDetectionInput): {
  bundle: IntentBundle;
  debug: {
    input_text_length: number;
    conversation_turn_count: number;
    has_context_bundle: boolean;
    active_role: string;
    mode: string;
    keyword_matches: Record<IntentClass, string[]>;
  };
} {
  const bundle = detectIntent(input);

  // Find matching keywords for debug purposes
  const keywordMatches: Record<IntentClass, string[]> = {} as any;
  for (const intentClass of INTENT_CLASSES) {
    const patterns = INTENT_KEYWORDS[intentClass];
    const matches: string[] = [];
    for (const pattern of patterns) {
      const match = input.current_input.match(pattern);
      if (match) {
        matches.push(match[0]);
      }
    }
    keywordMatches[intentClass] = matches;
  }

  return {
    bundle,
    debug: {
      input_text_length: input.current_input.length,
      conversation_turn_count: input.conversation.turn_count,
      has_context_bundle: !!input.context_bundle,
      active_role: input.active_role,
      mode: input.mode,
      keyword_matches: keywordMatches
    }
  };
}

/**
 * Export configuration for documentation/testing
 */
export const CONFIG = INTENT_CONFIG;
export const KEYWORDS = INTENT_KEYWORDS;
export const DOMAIN_KEYWORDS = DOMAIN_TAG_KEYWORDS;
