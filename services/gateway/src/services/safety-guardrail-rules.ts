/**
 * VTID-01122: Safety Guardrail Rules - Deterministic Domain Rules
 *
 * This file contains the canonical guardrail rules for each safety domain.
 * All rules are:
 * - Deterministic (same inputs → same decision)
 * - Versioned (for audit trail)
 * - Non-probabilistic (no random overrides)
 *
 * Rule Priority: Lower number = higher priority (evaluated first)
 * Action Priority: block > redirect > restrict > allow
 */

import {
  SafetyDomain,
  GuardrailAction,
  GuardrailRule,
  SafetyUserMessage
} from '../types/safety-guardrails';

// =============================================================================
// RULE VERSION - Increment on any rule change
// =============================================================================

export const GUARDRAIL_RULE_VERSION = '1.0.0';

// =============================================================================
// DOMAIN: MEDICAL / HEALTH
// =============================================================================

const MEDICAL_RULES: GuardrailRule[] = [
  // BLOCK: Direct medical diagnosis requests
  {
    rule_id: 'MED-001',
    domain: 'medical',
    action: 'block',
    priority: 10,
    conditions: [
      { field: 'intent_bundle.primary_intent', operator: 'in', value: ['diagnose', 'prescribe', 'treat'] },
      { field: 'user_role', operator: 'neq', value: 'professional' }
    ],
    explanation_code: 'MEDICAL_DIAGNOSIS_BLOCKED',
    explanation_template: 'Direct medical diagnosis is outside my scope.',
    user_message_template: 'I can\'t provide medical diagnoses. For health concerns, please consult a healthcare professional who can properly evaluate your situation.',
    alternatives_template: [
      'I can help you understand general health concepts',
      'I can help you prepare questions for your doctor',
      'I can explain what symptoms might mean in general terms'
    ],
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // BLOCK: Prescription or medication dosage requests
  {
    rule_id: 'MED-002',
    domain: 'medical',
    action: 'block',
    priority: 10,
    conditions: [
      { field: 'intent_bundle.primary_intent', operator: 'in', value: ['prescribe', 'medication_dose', 'drug_interaction'] },
      { field: 'user_role', operator: 'neq', value: 'professional' }
    ],
    explanation_code: 'PRESCRIPTION_BLOCKED',
    explanation_template: 'Medication prescriptions and dosages require professional oversight.',
    user_message_template: 'Medication decisions need to be made with your healthcare provider. They know your complete health picture and can make safe recommendations.',
    alternatives_template: [
      'I can help you understand how medications generally work',
      'I can help you prepare questions about your medications for your doctor'
    ],
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // RESTRICT: Health advice should be high-level only
  {
    rule_id: 'MED-003',
    domain: 'medical',
    action: 'restrict',
    priority: 50,
    conditions: [
      { field: 'intent_bundle.intent_category', operator: 'eq', value: 'health_advice' },
      { field: 'user_role', operator: 'neq', value: 'professional' }
    ],
    explanation_code: 'MEDICAL_ADVICE_RESTRICTED',
    explanation_template: 'Health advice is limited to general wellness guidance.',
    user_message_template: 'I can share general wellness information, but specific health decisions should be discussed with your healthcare provider.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // REDIRECT: Urgent symptoms - redirect to emergency
  {
    rule_id: 'MED-004',
    domain: 'medical',
    action: 'redirect',
    priority: 5,
    conditions: [
      { field: 'intent_bundle.extracted_entities.urgency', operator: 'eq', value: 'emergency' }
    ],
    explanation_code: 'EMERGENCY_REDIRECT',
    explanation_template: 'Detected potential emergency situation.',
    user_message_template: 'This sounds like it could be urgent. If you\'re experiencing a medical emergency, please call emergency services (911) or go to the nearest emergency room immediately.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  }
];

// =============================================================================
// DOMAIN: MENTAL & EMOTIONAL
// =============================================================================

const MENTAL_RULES: GuardrailRule[] = [
  // BLOCK: Crisis situations - must redirect
  {
    rule_id: 'MNT-001',
    domain: 'mental',
    action: 'redirect',
    priority: 1,
    conditions: [
      { field: 'emotional_signals.vulnerability_indicators', operator: 'eq', value: true },
      { field: 'intent_bundle.extracted_entities.crisis_indicators', operator: 'eq', value: true }
    ],
    explanation_code: 'CRISIS_REDIRECT',
    explanation_template: 'Detected potential crisis situation.',
    user_message_template: 'I hear that you\'re going through something really difficult. Your feelings matter, and there are people who can help. Would you like me to share some resources? If you\'re in immediate danger, please reach out to a crisis helpline.',
    alternatives_template: [
      'I can share crisis support resources',
      'I\'m here to listen if you want to talk about what\'s happening'
    ],
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // RESTRICT: Mental health advice
  {
    rule_id: 'MNT-002',
    domain: 'mental',
    action: 'restrict',
    priority: 40,
    conditions: [
      { field: 'intent_bundle.intent_category', operator: 'eq', value: 'mental_health_advice' },
      { field: 'user_role', operator: 'neq', value: 'professional' }
    ],
    explanation_code: 'MENTAL_HEALTH_RESTRICTED',
    explanation_template: 'Mental health guidance is limited to general support.',
    user_message_template: 'I can offer general support and wellness tips, but for mental health concerns, a qualified professional can provide the personalized care you deserve.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // REDIRECT: High stress detected
  {
    rule_id: 'MNT-003',
    domain: 'mental',
    action: 'redirect',
    priority: 30,
    conditions: [
      { field: 'emotional_signals.stress_indicators', operator: 'eq', value: true },
      { field: 'emotional_signals.primary_emotion', operator: 'in', value: ['distress', 'anxiety', 'despair'] }
    ],
    explanation_code: 'STRESS_DETECTED_REDIRECT',
    explanation_template: 'Detected elevated stress or distress signals.',
    user_message_template: 'I notice you might be feeling overwhelmed right now. Would you like to talk about what\'s on your mind, or would it help to explore some calming techniques together?',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  }
];

// =============================================================================
// DOMAIN: FINANCIAL / ECONOMIC
// =============================================================================

const FINANCIAL_RULES: GuardrailRule[] = [
  // BLOCK: Specific investment recommendations
  {
    rule_id: 'FIN-001',
    domain: 'financial',
    action: 'block',
    priority: 10,
    conditions: [
      { field: 'intent_bundle.primary_intent', operator: 'in', value: ['invest', 'buy_stock', 'trade', 'bet'] },
      { field: 'intent_bundle.is_request', operator: 'eq', value: true }
    ],
    explanation_code: 'INVESTMENT_ADVICE_BLOCKED',
    explanation_template: 'Specific investment advice requires licensed professionals.',
    user_message_template: 'I can\'t recommend specific investments. Financial decisions depend on your complete situation, risk tolerance, and goals - a licensed financial advisor can help you make informed choices.',
    alternatives_template: [
      'I can explain general investment concepts',
      'I can help you understand financial terminology',
      'I can discuss general principles of financial planning'
    ],
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // RESTRICT: Financial planning
  {
    rule_id: 'FIN-002',
    domain: 'financial',
    action: 'restrict',
    priority: 50,
    conditions: [
      { field: 'intent_bundle.intent_category', operator: 'eq', value: 'financial_planning' }
    ],
    explanation_code: 'FINANCIAL_PLANNING_RESTRICTED',
    explanation_template: 'Financial planning advice is limited to general principles.',
    user_message_template: 'I can share general financial concepts and principles. For personalized financial planning, consider consulting with a certified financial planner.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // BLOCK: Tax advice
  {
    rule_id: 'FIN-003',
    domain: 'financial',
    action: 'block',
    priority: 15,
    conditions: [
      { field: 'intent_bundle.primary_intent', operator: 'in', value: ['tax_advice', 'tax_strategy', 'tax_optimization'] },
      { field: 'intent_bundle.is_request', operator: 'eq', value: true }
    ],
    explanation_code: 'TAX_ADVICE_BLOCKED',
    explanation_template: 'Tax advice requires qualified tax professionals.',
    user_message_template: 'Tax situations are highly individual and depend on many factors. A tax professional or CPA can provide advice specific to your situation.',
    alternatives_template: [
      'I can explain general tax concepts',
      'I can help you understand common tax terms'
    ],
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  }
];

// =============================================================================
// DOMAIN: SOCIAL & RELATIONSHIP
// =============================================================================

const SOCIAL_RULES: GuardrailRule[] = [
  // REDIRECT: Relationship crisis
  {
    rule_id: 'SOC-001',
    domain: 'social',
    action: 'redirect',
    priority: 20,
    conditions: [
      { field: 'intent_bundle.extracted_entities.relationship_crisis', operator: 'eq', value: true },
      { field: 'emotional_signals.vulnerability_indicators', operator: 'eq', value: true }
    ],
    explanation_code: 'RELATIONSHIP_CRISIS_REDIRECT',
    explanation_template: 'Detected relationship distress.',
    user_message_template: 'Relationship challenges can be really hard. Would you like to talk more about what\'s happening? If you\'re dealing with something serious, a counselor or therapist could offer valuable support.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // RESTRICT: Relationship advice
  {
    rule_id: 'SOC-002',
    domain: 'social',
    action: 'restrict',
    priority: 60,
    conditions: [
      { field: 'intent_bundle.intent_category', operator: 'eq', value: 'relationship_advice' }
    ],
    explanation_code: 'RELATIONSHIP_ADVICE_RESTRICTED',
    explanation_template: 'Relationship advice is limited to general communication principles.',
    user_message_template: 'I can share general communication and relationship principles. Remember that every relationship is unique, and what matters most is finding what works for you.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // BLOCK: Facilitating harmful social behaviors
  {
    rule_id: 'SOC-003',
    domain: 'social',
    action: 'block',
    priority: 5,
    conditions: [
      { field: 'intent_bundle.primary_intent', operator: 'in', value: ['manipulate', 'deceive', 'stalk', 'harass'] }
    ],
    explanation_code: 'HARMFUL_BEHAVIOR_BLOCKED',
    explanation_template: 'Cannot assist with potentially harmful social behaviors.',
    user_message_template: 'I\'m not able to help with that request. Healthy relationships are built on mutual respect and honest communication.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  }
];

// =============================================================================
// DOMAIN: LEGAL / COMPLIANCE
// =============================================================================

const LEGAL_RULES: GuardrailRule[] = [
  // BLOCK: Specific legal advice
  {
    rule_id: 'LEG-001',
    domain: 'legal',
    action: 'block',
    priority: 10,
    conditions: [
      { field: 'intent_bundle.primary_intent', operator: 'in', value: ['legal_advice', 'legal_strategy', 'lawsuit'] },
      { field: 'intent_bundle.is_request', operator: 'eq', value: true },
      { field: 'user_role', operator: 'neq', value: 'professional' }
    ],
    explanation_code: 'LEGAL_ADVICE_BLOCKED',
    explanation_template: 'Specific legal advice requires licensed attorneys.',
    user_message_template: 'Legal matters can be complex and the stakes are often high. I can\'t provide legal advice, but a qualified attorney can help you understand your options and rights.',
    alternatives_template: [
      'I can explain general legal concepts',
      'I can help you understand common legal terms',
      'I can help you prepare questions for a lawyer'
    ],
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // RESTRICT: General legal questions
  {
    rule_id: 'LEG-002',
    domain: 'legal',
    action: 'restrict',
    priority: 50,
    conditions: [
      { field: 'intent_bundle.intent_category', operator: 'eq', value: 'legal_question' }
    ],
    explanation_code: 'LEGAL_QUESTION_RESTRICTED',
    explanation_template: 'Legal information is limited to general educational content.',
    user_message_template: 'I can share general legal information for educational purposes. For your specific situation, consulting with a legal professional is the safest approach.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // BLOCK: Assistance with illegal activities
  {
    rule_id: 'LEG-003',
    domain: 'legal',
    action: 'block',
    priority: 1,
    conditions: [
      { field: 'intent_bundle.extracted_entities.illegal_activity', operator: 'eq', value: true }
    ],
    explanation_code: 'ILLEGAL_ACTIVITY_BLOCKED',
    explanation_template: 'Cannot assist with potentially illegal activities.',
    user_message_template: 'I\'m not able to help with that request.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  }
];

// =============================================================================
// DOMAIN: SYSTEM / GOVERNANCE
// =============================================================================

const SYSTEM_RULES: GuardrailRule[] = [
  // BLOCK: Autonomy under block action
  {
    rule_id: 'SYS-001',
    domain: 'system',
    action: 'block',
    priority: 1,
    conditions: [
      { field: 'autonomy_intent.autonomy_requested', operator: 'eq', value: true },
      { field: 'autonomy_intent.autonomy_level', operator: 'in', value: ['act_with_confirmation', 'act_autonomously'] },
      { field: '_evaluation.has_block', operator: 'eq', value: true }
    ],
    explanation_code: 'AUTONOMY_BLOCKED_UNSAFE',
    explanation_template: 'Autonomous action blocked due to safety constraints.',
    user_message_template: 'I can\'t take autonomous action in this area because it involves topics that need human oversight. Let me explain what I can help with instead.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // BLOCK: Autonomy under restrict action
  {
    rule_id: 'SYS-002',
    domain: 'system',
    action: 'block',
    priority: 2,
    conditions: [
      { field: 'autonomy_intent.autonomy_requested', operator: 'eq', value: true },
      { field: 'autonomy_intent.autonomy_level', operator: 'eq', value: 'act_autonomously' },
      { field: '_evaluation.has_restrict', operator: 'eq', value: true }
    ],
    explanation_code: 'AUTONOMY_BLOCKED_RESTRICTED',
    explanation_template: 'Autonomous action blocked in restricted domain.',
    user_message_template: 'This topic requires more care, so I can\'t act autonomously here. I\'ll provide guidance and let you make the decisions.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // BLOCK: Guardrail bypass attempts
  {
    rule_id: 'SYS-003',
    domain: 'system',
    action: 'block',
    priority: 1,
    conditions: [
      { field: 'intent_bundle.extracted_entities.bypass_attempt', operator: 'eq', value: true }
    ],
    explanation_code: 'BYPASS_ATTEMPT_BLOCKED',
    explanation_template: 'Guardrail bypass is not permitted.',
    user_message_template: 'My safety guidelines help me be genuinely helpful while avoiding potential harm. Let me help you find another approach to what you\'re trying to accomplish.',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  },
  // RESTRICT: Low confidence responses
  {
    rule_id: 'SYS-004',
    domain: 'system',
    action: 'restrict',
    priority: 70,
    conditions: [
      { field: '_evaluation.min_confidence', operator: 'lt', value: 0.4 }
    ],
    explanation_code: 'LOW_CONFIDENCE_RESTRICTED',
    explanation_template: 'Response restricted due to low confidence in understanding.',
    user_message_template: 'I want to make sure I understand you correctly. Could you tell me more about what you\'re looking for?',
    created_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    is_active: true
  }
];

// =============================================================================
// COMBINED RULES BY DOMAIN
// =============================================================================

export const GUARDRAIL_RULES_BY_DOMAIN: Record<SafetyDomain, GuardrailRule[]> = {
  medical: MEDICAL_RULES,
  mental: MENTAL_RULES,
  financial: FINANCIAL_RULES,
  social: SOCIAL_RULES,
  legal: LEGAL_RULES,
  system: SYSTEM_RULES
};

/**
 * Get all rules flattened and sorted by priority.
 */
export function getAllRulesSorted(): GuardrailRule[] {
  const allRules: GuardrailRule[] = [];

  for (const domain of Object.keys(GUARDRAIL_RULES_BY_DOMAIN) as SafetyDomain[]) {
    allRules.push(...GUARDRAIL_RULES_BY_DOMAIN[domain]);
  }

  // Sort by priority (lower = higher priority)
  return allRules.sort((a, b) => a.priority - b.priority);
}

/**
 * Get active rules for a specific domain.
 */
export function getActiveRulesForDomain(domain: SafetyDomain): GuardrailRule[] {
  return GUARDRAIL_RULES_BY_DOMAIN[domain]
    .filter(rule => rule.is_active)
    .sort((a, b) => a.priority - b.priority);
}

// =============================================================================
// USER MESSAGES BY DOMAIN AND ACTION
// =============================================================================

/**
 * Default user messages for each domain/action combination.
 * These are used when a specific rule doesn't provide a message.
 */
export const DEFAULT_USER_MESSAGES: Record<SafetyDomain, Record<GuardrailAction, SafetyUserMessage>> = {
  medical: {
    block: {
      domain: 'medical',
      action: 'block',
      title: 'Health Boundary',
      message: 'This is outside what I can safely help with. For medical questions, please consult a healthcare professional.',
      tone: 'supportive',
      includes_why: true,
      alternatives: ['I can help with general wellness information', 'I can help you prepare questions for your doctor']
    },
    restrict: {
      domain: 'medical',
      action: 'restrict',
      title: 'General Guidance Only',
      message: 'I can provide general health information, but specific medical decisions should involve your healthcare provider.',
      tone: 'informative',
      includes_why: true
    },
    redirect: {
      domain: 'medical',
      action: 'redirect',
      title: 'Let Me Check',
      message: 'Before I respond, I want to make sure I understand your needs correctly and can help appropriately.',
      tone: 'calm',
      includes_why: false
    },
    allow: {
      domain: 'medical',
      action: 'allow',
      title: '',
      message: '',
      tone: 'calm',
      includes_why: false
    }
  },
  mental: {
    block: {
      domain: 'mental',
      action: 'block',
      title: 'Support Available',
      message: 'What you\'re going through matters. For immediate support, please reach out to a mental health professional or crisis line.',
      tone: 'supportive',
      includes_why: true,
      alternatives: ['I\'m here to listen', 'I can share crisis resources']
    },
    restrict: {
      domain: 'mental',
      action: 'restrict',
      title: 'Here to Support',
      message: 'I can offer general support and wellness suggestions. For deeper mental health support, a qualified professional can provide more comprehensive care.',
      tone: 'supportive',
      includes_why: true
    },
    redirect: {
      domain: 'mental',
      action: 'redirect',
      title: 'Checking In',
      message: 'I want to make sure I\'m supporting you in the right way. Can you tell me more about how you\'re feeling?',
      tone: 'supportive',
      includes_why: false
    },
    allow: {
      domain: 'mental',
      action: 'allow',
      title: '',
      message: '',
      tone: 'calm',
      includes_why: false
    }
  },
  financial: {
    block: {
      domain: 'financial',
      action: 'block',
      title: 'Financial Boundary',
      message: 'Financial decisions can have significant impact. A licensed financial advisor can provide personalized guidance.',
      tone: 'informative',
      includes_why: true,
      alternatives: ['I can explain general financial concepts', 'I can help you understand common terms']
    },
    restrict: {
      domain: 'financial',
      action: 'restrict',
      title: 'General Information',
      message: 'I can share general financial principles for educational purposes. For decisions about your money, professional advice is recommended.',
      tone: 'informative',
      includes_why: true
    },
    redirect: {
      domain: 'financial',
      action: 'redirect',
      title: 'Understanding Your Needs',
      message: 'Financial topics can be nuanced. Let me understand what you\'re trying to learn or accomplish.',
      tone: 'calm',
      includes_why: false
    },
    allow: {
      domain: 'financial',
      action: 'allow',
      title: '',
      message: '',
      tone: 'calm',
      includes_why: false
    }
  },
  social: {
    block: {
      domain: 'social',
      action: 'block',
      title: 'Relationship Boundary',
      message: 'I\'m not able to help with that particular request. Healthy relationships are built on mutual respect.',
      tone: 'calm',
      includes_why: false
    },
    restrict: {
      domain: 'social',
      action: 'restrict',
      title: 'General Guidance',
      message: 'I can share general communication principles. Every relationship is unique, so trust your judgment about what feels right.',
      tone: 'informative',
      includes_why: true
    },
    redirect: {
      domain: 'social',
      action: 'redirect',
      title: 'Tell Me More',
      message: 'Relationships can be complex. Help me understand the situation better so I can be more helpful.',
      tone: 'supportive',
      includes_why: false
    },
    allow: {
      domain: 'social',
      action: 'allow',
      title: '',
      message: '',
      tone: 'calm',
      includes_why: false
    }
  },
  legal: {
    block: {
      domain: 'legal',
      action: 'block',
      title: 'Legal Boundary',
      message: 'Legal matters require professional expertise. An attorney can help you understand your rights and options.',
      tone: 'informative',
      includes_why: true,
      alternatives: ['I can explain general legal concepts', 'I can help you prepare questions for a lawyer']
    },
    restrict: {
      domain: 'legal',
      action: 'restrict',
      title: 'General Information',
      message: 'I can share general legal information for educational purposes. For your specific situation, legal counsel is advisable.',
      tone: 'informative',
      includes_why: true
    },
    redirect: {
      domain: 'legal',
      action: 'redirect',
      title: 'Understanding Your Question',
      message: 'Legal questions can have many nuances. Can you help me understand what you\'re trying to learn?',
      tone: 'calm',
      includes_why: false
    },
    allow: {
      domain: 'legal',
      action: 'allow',
      title: '',
      message: '',
      tone: 'calm',
      includes_why: false
    }
  },
  system: {
    block: {
      domain: 'system',
      action: 'block',
      title: 'Safety Limit',
      message: 'I have guidelines that help me be genuinely helpful. Let me help you find another approach.',
      tone: 'calm',
      includes_why: false
    },
    restrict: {
      domain: 'system',
      action: 'restrict',
      title: 'Proceeding Carefully',
      message: 'I\'m being careful with how I respond here. Let me provide what I can.',
      tone: 'calm',
      includes_why: false
    },
    redirect: {
      domain: 'system',
      action: 'redirect',
      title: 'Clarifying',
      message: 'I want to make sure I understand correctly. Could you tell me more?',
      tone: 'calm',
      includes_why: false
    },
    allow: {
      domain: 'system',
      action: 'allow',
      title: '',
      message: '',
      tone: 'calm',
      includes_why: false
    }
  }
};

// =============================================================================
// KEYWORD PATTERNS FOR DOMAIN DETECTION
// =============================================================================

/**
 * Keyword patterns for detecting relevant domains from input.
 * Used for initial domain classification before rule evaluation.
 */
export const DOMAIN_DETECTION_PATTERNS: Record<SafetyDomain, {
  high_signal: string[];
  medium_signal: string[];
}> = {
  medical: {
    high_signal: [
      'diagnose', 'diagnosis', 'prescribe', 'prescription', 'medication', 'medicine',
      'symptom', 'treatment', 'disease', 'illness', 'doctor', 'hospital', 'surgery',
      'dosage', 'drug', 'therapy', 'condition', 'prognosis'
    ],
    medium_signal: [
      'health', 'pain', 'ache', 'sick', 'fever', 'headache', 'nausea', 'fatigue',
      'allergy', 'infection', 'vitamin', 'supplement', 'diet', 'exercise'
    ]
  },
  mental: {
    high_signal: [
      'suicide', 'suicidal', 'kill myself', 'end my life', 'self-harm', 'cutting',
      'depression', 'depressed', 'anxiety', 'panic attack', 'trauma', 'ptsd',
      'eating disorder', 'anorexia', 'bulimia', 'bipolar', 'schizophrenia'
    ],
    medium_signal: [
      'sad', 'lonely', 'stressed', 'anxious', 'worried', 'overwhelmed', 'hopeless',
      'worthless', 'therapy', 'therapist', 'counselor', 'mental health', 'emotion'
    ]
  },
  financial: {
    high_signal: [
      'invest', 'investment', 'stock', 'crypto', 'cryptocurrency', 'trade', 'trading',
      'portfolio', 'financial advisor', 'tax advice', 'tax strategy', 'retirement',
      'mortgage', 'loan advice'
    ],
    medium_signal: [
      'money', 'savings', 'budget', 'debt', 'credit', 'bank', 'interest rate',
      'insurance', 'estate planning', 'financial planning', 'wealth'
    ]
  },
  social: {
    high_signal: [
      'divorce', 'abuse', 'abusive', 'domestic violence', 'harassment', 'stalking',
      'manipulation', 'toxic relationship', 'breakup', 'separation'
    ],
    medium_signal: [
      'relationship', 'marriage', 'partner', 'spouse', 'dating', 'family',
      'friend', 'conflict', 'communication', 'trust issues'
    ]
  },
  legal: {
    high_signal: [
      'lawyer', 'attorney', 'lawsuit', 'sue', 'legal advice', 'court', 'judge',
      'custody', 'criminal', 'arrest', 'contract', 'liability', 'negligence'
    ],
    medium_signal: [
      'legal', 'law', 'rights', 'regulation', 'compliance', 'policy', 'terms',
      'agreement', 'dispute', 'claim'
    ]
  },
  system: {
    high_signal: [
      'ignore your rules', 'bypass', 'jailbreak', 'pretend you', 'act as if',
      'forget your instructions', 'override safety', 'disable guardrails'
    ],
    medium_signal: [
      'system prompt', 'your rules', 'your guidelines', 'your instructions'
    ]
  }
};

export default {
  GUARDRAIL_RULE_VERSION,
  GUARDRAIL_RULES_BY_DOMAIN,
  getAllRulesSorted,
  getActiveRulesForDomain,
  DEFAULT_USER_MESSAGES,
  DOMAIN_DETECTION_PATTERNS
};
