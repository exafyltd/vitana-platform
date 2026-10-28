/**
 * VTID-01114: Domain & Topic Routing Engine Types
 *
 * Core types for the deterministic Domain & Topic Routing Engine (D22).
 * This is the "traffic control layer" of Full Intelligence v1.
 *
 * Position in Intelligence Stack:
 * D20 Context -> D21 Intent -> D22 Domain Routing -> D23+ Intelligence
 *
 * All routing is deterministic: same inputs -> same outputs.
 */

// =============================================================================
// VTID-01114: Domain Definitions (Canon)
// =============================================================================

/**
 * Supported intelligence domains.
 * Domains are exclusive unless explicitly marked as 'mixed'.
 */
export const INTELLIGENCE_DOMAINS = [
  'health',
  'relationships',      // Relationships / Community
  'learning',           // Learning / Knowledge
  'business',           // Business / Professional
  'commerce',           // Commerce / Marketplace
  'system',             // System / Governance
  'reflection',         // Reflection / Memory
  'mixed'               // Multi-domain (requires explicit confidence)
] as const;

export type IntelligenceDomain = typeof INTELLIGENCE_DOMAINS[number];

/**
 * Domain metadata for routing decisions
 */
export interface DomainMetadata {
  domain: IntelligenceDomain;
  display_name: string;
  description: string;
  /** Domains that cannot be activated together with this one */
  exclusive_with: IntelligenceDomain[];
  /** Whether this domain can trigger commerce recommendations */
  allows_commerce: boolean;
  /** Whether this domain can trigger medical safety flags */
  triggers_medical_safety: boolean;
  /** Whether this domain can trigger financial safety flags */
  triggers_financial_safety: boolean;
  /** Default autonomy level for this domain (0-100) */
  default_autonomy: number;
}

/**
 * Canon domain metadata definitions
 */
export const DOMAIN_METADATA: Record<IntelligenceDomain, DomainMetadata> = {
  health: {
    domain: 'health',
    display_name: 'Health & Wellness',
    description: 'Physical health, biomarkers, sleep, nutrition, fitness',
    exclusive_with: [],
    allows_commerce: false, // Hard constraint: health -> no commerce directly
    triggers_medical_safety: true,
    triggers_financial_safety: false,
    default_autonomy: 60
  },
  relationships: {
    domain: 'relationships',
    display_name: 'Relationships & Community',
    description: 'People, groups, social connections, events',
    exclusive_with: [],
    allows_commerce: true,
    triggers_medical_safety: false,
    triggers_financial_safety: false,
    default_autonomy: 80
  },
  learning: {
    domain: 'learning',
    display_name: 'Learning & Knowledge',
    description: 'Skills, concepts, progress, education',
    exclusive_with: [],
    allows_commerce: true,
    triggers_medical_safety: false,
    triggers_financial_safety: false,
    default_autonomy: 85
  },
  business: {
    domain: 'business',
    display_name: 'Business & Professional',
    description: 'Work, career, professional development',
    exclusive_with: [],
    allows_commerce: true,
    triggers_medical_safety: false,
    triggers_financial_safety: true,
    default_autonomy: 70
  },
  commerce: {
    domain: 'commerce',
    display_name: 'Commerce & Marketplace',
    description: 'Products, services, pricing, transactions',
    exclusive_with: [],
    allows_commerce: true,
    triggers_medical_safety: false,
    triggers_financial_safety: true,
    default_autonomy: 50
  },
  system: {
    domain: 'system',
    display_name: 'System & Governance',
    description: 'Settings, permissions, platform governance',
    exclusive_with: [],
    allows_commerce: false,
    triggers_medical_safety: false,
    triggers_financial_safety: false,
    default_autonomy: 20 // Hard constraint: system blocks autonomy by default
  },
  reflection: {
    domain: 'reflection',
    display_name: 'Reflection & Memory',
    description: 'Personal reflection, memory recall, journaling',
    exclusive_with: [],
    allows_commerce: false,
    triggers_medical_safety: false,
    triggers_financial_safety: false,
    default_autonomy: 90
  },
  mixed: {
    domain: 'mixed',
    display_name: 'Mixed (Multi-Domain)',
    description: 'Conversation spans multiple domains',
    exclusive_with: [],
    allows_commerce: true,
    triggers_medical_safety: false, // Inherits from constituent domains
    triggers_financial_safety: false, // Inherits from constituent domains
    default_autonomy: 70
  }
};

// =============================================================================
// VTID-01114: Topic Definitions
// =============================================================================

/**
 * Topic within a domain, extracted and normalized
 */
export interface RoutingTopic {
  /** Normalized topic key (lowercase, underscored) */
  topic_key: string;
  /** Display name for the topic */
  display_name: string;
  /** Parent domain */
  domain: IntelligenceDomain;
  /** Confidence score (0-100) */
  confidence: number;
  /** Source of topic detection */
  source: 'intent' | 'context' | 'keyword' | 'memory' | 'explicit';
  /** Whether this topic triggers safety flags */
  is_sensitive: boolean;
}

/**
 * Domain-specific topic keywords for extraction
 */
export const DOMAIN_TOPIC_KEYWORDS: Record<IntelligenceDomain, Record<string, string[]>> = {
  health: {
    sleep: ['sleep', 'insomnia', 'rest', 'tired', 'fatigue', 'schlaf', 'müde', 'nap', 'bedtime'],
    nutrition: ['nutrition', 'diet', 'food', 'eating', 'meal', 'ernährung', 'essen', 'calories'],
    biomarkers: ['biomarker', 'blood', 'glucose', 'cholesterol', 'blut', 'vitals', 'lab', 'test'],
    fitness: ['fitness', 'exercise', 'workout', 'gym', 'training', 'sport', 'bewegung', 'steps'],
    mental_health: ['stress', 'anxiety', 'depression', 'mental', 'therapy', 'counseling', 'psyche'],
    medication: ['medication', 'medicine', 'pill', 'drug', 'prescription', 'medikament', 'rezept'],
    symptoms: ['symptom', 'pain', 'ache', 'fever', 'sick', 'illness', 'schmerz', 'krank', 'weh']
  },
  relationships: {
    people: ['friend', 'family', 'partner', 'spouse', 'colleague', 'freund', 'familie', 'kollege'],
    groups: ['group', 'team', 'community', 'club', 'organization', 'verein', 'gruppe', 'mitglied'],
    events: ['event', 'meetup', 'gathering', 'party', 'celebration', 'treffen', 'veranstaltung'],
    communication: ['call', 'message', 'email', 'chat', 'talk', 'anruf', 'nachricht', 'gespräch']
  },
  learning: {
    skills: ['skill', 'learn', 'practice', 'improve', 'fähigkeit', 'lernen', 'üben', 'kurs'],
    concepts: ['concept', 'understand', 'theory', 'knowledge', 'konzept', 'verstehen', 'wissen'],
    progress: ['progress', 'achievement', 'milestone', 'goal', 'fortschritt', 'ziel', 'erfolg'],
    resources: ['book', 'course', 'tutorial', 'guide', 'buch', 'kurs', 'anleitung', 'video']
  },
  business: {
    work: ['work', 'job', 'career', 'office', 'arbeit', 'beruf', 'büro', 'projekt'],
    meetings: ['meeting', 'call', 'presentation', 'besprechung', 'termin', 'konferenz'],
    productivity: ['productivity', 'efficiency', 'deadline', 'task', 'produktivität', 'aufgabe'],
    networking: ['network', 'contact', 'connection', 'linkedin', 'netzwerk', 'kontakt']
  },
  commerce: {
    products: ['product', 'item', 'buy', 'purchase', 'produkt', 'kaufen', 'artikel', 'bestellung'],
    services: ['service', 'subscription', 'plan', 'dienstleistung', 'abonnement', 'abo'],
    pricing: ['price', 'cost', 'discount', 'deal', 'preis', 'kosten', 'rabatt', 'angebot'],
    transactions: ['order', 'payment', 'checkout', 'cart', 'zahlung', 'warenkorb', 'bestellen']
  },
  system: {
    settings: ['setting', 'preference', 'config', 'einstellung', 'konfiguration', 'option'],
    permissions: ['permission', 'access', 'privacy', 'berechtigung', 'zugang', 'datenschutz'],
    account: ['account', 'profile', 'login', 'konto', 'profil', 'anmelden', 'passwort'],
    support: ['help', 'support', 'issue', 'bug', 'hilfe', 'problem', 'fehler', 'kontakt']
  },
  reflection: {
    memory: ['remember', 'recall', 'memory', 'erinnern', 'erinnerung', 'gedächtnis', 'früher'],
    journal: ['journal', 'diary', 'entry', 'write', 'tagebuch', 'notiz', 'aufschreiben'],
    feelings: ['feel', 'feeling', 'emotion', 'mood', 'gefühl', 'stimmung', 'emotion'],
    gratitude: ['grateful', 'thankful', 'appreciate', 'dankbar', 'schätzen', 'wertschätzen']
  },
  mixed: {} // Mixed domain inherits from constituent domains
};

// =============================================================================
// VTID-01114: Safety Flags
// =============================================================================

/**
 * Safety flag types that can be triggered by domains/topics
 */
export type SafetyFlagType =
  | 'medical_advice'
  | 'medical_emergency'
  | 'financial_advice'
  | 'financial_transaction'
  | 'personal_crisis'
  | 'legal_advice'
  | 'minor_involved'
  | 'sensitive_content';

/**
 * Safety flag with metadata
 */
export interface SafetyFlag {
  type: SafetyFlagType;
  triggered_by: string; // Topic or domain that triggered it
  severity: 'low' | 'medium' | 'high' | 'critical';
  requires_human_review: boolean;
  message: string;
}

/**
 * Topic keywords that trigger safety flags
 */
export const SAFETY_TRIGGER_KEYWORDS: Record<SafetyFlagType, string[]> = {
  medical_advice: [
    'diagnose', 'diagnosis', 'treatment', 'symptom', 'medication', 'dosage',
    'prescribe', 'prescription', 'diagnose', 'behandlung', 'medikament', 'dosis'
  ],
  medical_emergency: [
    'emergency', 'chest pain', 'can\'t breathe', 'suicide', 'overdose',
    'notfall', 'brustschmerz', 'atemnot', 'selbstmord', 'überdosis'
  ],
  financial_advice: [
    'invest', 'stock', 'crypto', 'trading', 'retirement', 'portfolio',
    'investieren', 'aktie', 'rente', 'anlage', 'vermögen'
  ],
  financial_transaction: [
    'transfer', 'payment', 'send money', 'withdraw', 'wire',
    'überweisen', 'zahlung', 'geld senden', 'abheben'
  ],
  personal_crisis: [
    'depressed', 'hopeless', 'ending it', 'self-harm', 'abuse',
    'deprimiert', 'hoffnungslos', 'selbstverletzung', 'missbrauch'
  ],
  legal_advice: [
    'sue', 'lawsuit', 'legal action', 'attorney', 'court',
    'verklagen', 'klage', 'anwalt', 'gericht', 'rechtsberatung'
  ],
  minor_involved: [
    'child', 'kid', 'minor', 'underage', 'teen', 'kind', 'minderjährig'
  ],
  sensitive_content: [
    'explicit', 'adult', 'nsfw', 'violent', 'graphic'
  ]
};

// =============================================================================
// VTID-01114: Routing Input Bundle (from D20 + D21)
// =============================================================================

/**
 * Unified input bundle for routing decisions.
 * Combines context_bundle (D20) and intent_bundle (D21).
 */
export interface RoutingInput {
  /** Context bundle from D20 (Memory Bridge) */
  context: {
    user_id: string;
    tenant_id: string;
    memory_items: Array<{
      category_key: string;
      content: string;
      importance: number;
    }>;
    formatted_context: string;
  };
  /** Intent bundle from D21 (Personalization) */
  intent: {
    top_topics: Array<{
      topic_key: string;
      score: number;
    }>;
    weaknesses: string[];
    recommended_actions: Array<{
      type: string;
      id: string;
      why: Array<{ template: string }>;
    }>;
  };
  /** Current user message/query */
  current_message: string;
  /** Active user role */
  active_role: 'patient' | 'professional' | 'admin' | 'developer';
  /** Session metadata */
  session: {
    session_id: string;
    turn_number: number;
    previous_domains?: IntelligenceDomain[];
  };
}

// =============================================================================
// VTID-01114: Routing Output Bundle (Canon)
// =============================================================================

/**
 * Routing bundle output - immutable per turn.
 * Constrains downstream intelligence.
 */
export interface RoutingBundle {
  /** Primary domain for this turn */
  primary_domain: IntelligenceDomain;
  /** Secondary domains that may be relevant */
  secondary_domains: IntelligenceDomain[];
  /** Active topics within routed domains */
  active_topics: RoutingTopic[];
  /** Domains explicitly excluded from this turn */
  excluded_domains: IntelligenceDomain[];
  /** Overall routing confidence (0-100) */
  routing_confidence: number;
  /** Safety flags triggered by routing */
  safety_flags: SafetyFlag[];
  /** Autonomy level for downstream intelligence (0-100) */
  autonomy_level: number;
  /** Whether this routing allows commerce recommendations */
  allows_commerce: boolean;
  /** Metadata for logging/audit */
  metadata: {
    routing_version: string;
    computed_at: string;
    input_hash: string;
    determinism_key: string;
  };
}

// =============================================================================
// VTID-01114: Routing Configuration
// =============================================================================

/**
 * Configuration thresholds for routing decisions
 */
export interface RoutingConfig {
  /** Minimum confidence to activate a domain (0-100) */
  domain_confidence_threshold: number;
  /** Minimum confidence for mixed domain activation (0-100) */
  mixed_domain_threshold: number;
  /** Minimum confidence to extract a topic (0-100) */
  topic_confidence_threshold: number;
  /** Maximum number of secondary domains */
  max_secondary_domains: number;
  /** Maximum number of active topics */
  max_active_topics: number;
  /** Default autonomy level when not specified */
  default_autonomy: number;
}

/**
 * Default routing configuration
 * Note: Thresholds are tuned for keyword-based detection without context/intent
 */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  domain_confidence_threshold: 15, // Lower threshold for keyword-only detection
  mixed_domain_threshold: 40, // Higher threshold for mixed domain
  topic_confidence_threshold: 20, // Lower threshold for topic extraction
  max_secondary_domains: 2,
  max_active_topics: 5,
  default_autonomy: 70
};

// =============================================================================
// VTID-01114: Routing Audit Entry
// =============================================================================

/**
 * Audit entry for routing decisions (D59 compliance)
 */
export interface RoutingAuditEntry {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  turn_number: number;
  routing_bundle: RoutingBundle;
  input_summary: {
    message_length: number;
    context_items_count: number;
    intent_topics_count: number;
    active_role: string;
  };
  created_at: string;
}

// =============================================================================
// VTID-01114: Export Helpers
// =============================================================================

/**
 * Check if a domain is valid
 */
export function isValidDomain(domain: string): domain is IntelligenceDomain {
  return INTELLIGENCE_DOMAINS.includes(domain as IntelligenceDomain);
}

/**
 * Get domain metadata
 */
export function getDomainMetadata(domain: IntelligenceDomain): DomainMetadata {
  return DOMAIN_METADATA[domain];
}

/**
 * Check if domain allows commerce
 */
export function domainAllowsCommerce(domain: IntelligenceDomain): boolean {
  return DOMAIN_METADATA[domain].allows_commerce;
}

/**
 * Get default autonomy for domain
 */
export function getDomainAutonomy(domain: IntelligenceDomain): number {
  return DOMAIN_METADATA[domain].default_autonomy;
}
