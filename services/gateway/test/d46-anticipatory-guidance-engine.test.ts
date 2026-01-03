/**
 * VTID-01140: D46 Anticipatory Guidance & Pre-emptive Coaching Layer Tests
 *
 * Tests for the Anticipatory Guidance system that translates predictive windows
 * into gentle, pre-emptive guidance for users.
 */

import {
  validateGuidanceLanguage,
  checkWindowEligibility,
  calculateRelevanceScore,
  selectGuidanceMode,
  selectTimingHint,
  generateGuidanceText,
  generateGuidanceFromWindow,
  generateGuidance,
  GUIDANCE_THRESHOLDS,
  GENERATION_RULES_VERSION
} from '../src/services/d46-anticipatory-guidance-engine';

import {
  SignalDomain,
  GuidanceMode,
  TimingHint,
  WindowType,
  PatternSignal,
  PredictiveWindow,
  D44SignalBundle,
  D45WindowBundle,
  UserGuidanceContext,
  GuidancePreferences,
  FORBIDDEN_PHRASES,
  OPTIONAL_PHRASING_PATTERNS
} from '../src/types/anticipatory-guidance';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockSignal(overrides: Partial<PatternSignal> = {}): PatternSignal {
  return {
    signal_id: '11111111-1111-1111-1111-111111111111',
    domain: 'health',
    pattern_type: 'stress_spike',
    intensity: 60,
    confidence: 75,
    trend: 'increasing',
    detected_at: new Date().toISOString(),
    decay_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    evidence_summary: 'Test signal evidence',
    ...overrides
  };
}

function createMockWindow(overrides: Partial<PredictiveWindow> = {}): PredictiveWindow {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  return {
    window_id: '22222222-2222-2222-2222-222222222222',
    type: 'risk',
    domain: 'health',
    title: 'Test Window',
    description: 'A test predictive window for unit testing.',
    confidence: 75,
    starts_at: tomorrow.toISOString(),
    ends_at: new Date(tomorrow.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    duration_hours: 4,
    contributing_signals: ['11111111-1111-1111-1111-111111111111'],
    impact_level: 'medium',
    predicted_at: now.toISOString(),
    ...overrides
  };
}

function createMockUserContext(overrides: Partial<UserGuidanceContext> = {}): UserGuidanceContext {
  return {
    user_id: '33333333-3333-3333-3333-333333333333',
    tenant_id: '44444444-4444-4444-4444-444444444444',
    preferences: {
      preferred_tone: 'conversational',
      preferred_timing: 'proactive',
      enabled_domains: ['health', 'behavior', 'social', 'cognitive', 'routine'],
      sensitivity_level: 'medium',
      max_daily_guidance: 3
    },
    recent_interactions: [],
    current_cognitive_load: 40,
    guidance_today_count: 0,
    ...overrides
  };
}

function createMockSignalBundle(overrides: Partial<D44SignalBundle> = {}): D44SignalBundle {
  return {
    user_id: '33333333-3333-3333-3333-333333333333',
    tenant_id: '44444444-4444-4444-4444-444444444444',
    signals: [createMockSignal()],
    cognitive_load: 40,
    cognitive_load_trend: 'stable',
    computed_at: new Date().toISOString(),
    ...overrides
  };
}

function createMockWindowBundle(overrides: Partial<D45WindowBundle> = {}): D45WindowBundle {
  return {
    user_id: '33333333-3333-3333-3333-333333333333',
    tenant_id: '44444444-4444-4444-4444-444444444444',
    windows: [createMockWindow()],
    forecast_horizon_hours: 72,
    computed_at: new Date().toISOString(),
    ...overrides
  };
}

// =============================================================================
// Language Validation Tests
// =============================================================================

describe('D46 Language Validation', () => {
  describe('Forbidden Phrases', () => {
    it('should detect forbidden "must" phrase', () => {
      const result = validateGuidanceLanguage('You must take a break now.');
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.phrase === 'must')).toBe(true);
    });

    it('should detect forbidden "should" phrase', () => {
      const result = validateGuidanceLanguage('You should exercise today.');
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.phrase === 'should')).toBe(true);
    });

    it('should detect forbidden "urgent" phrase', () => {
      const result = validateGuidanceLanguage('This is urgent! Act now.');
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.phrase === 'urgent')).toBe(true);
    });

    it('should detect all forbidden phrases', () => {
      for (const phrase of FORBIDDEN_PHRASES) {
        const text = `Test text with ${phrase} included.`;
        const result = validateGuidanceLanguage(text);
        expect(result.issues.some(i => i.type === 'forbidden_phrase')).toBe(true);
      }
    });
  });

  describe('Imperative Tone Detection', () => {
    it('should detect imperative starting with "Do"', () => {
      const result = validateGuidanceLanguage('Do this exercise now.');
      expect(result.issues.some(i => i.type === 'too_direct')).toBe(true);
    });

    it('should detect imperative starting with "Make sure"', () => {
      const result = validateGuidanceLanguage('Make sure you sleep early.');
      expect(result.issues.some(i => i.type === 'too_direct')).toBe(true);
    });

    it('should detect imperative starting with "Remember to"', () => {
      const result = validateGuidanceLanguage('Remember to take your medication.');
      expect(result.issues.some(i => i.type === 'too_direct')).toBe(true);
    });
  });

  describe('Alarmist Wording Detection', () => {
    it('should detect alarmist "danger" wording', () => {
      const result = validateGuidanceLanguage('There is danger ahead if you continue.');
      expect(result.issues.some(i => i.type === 'alarmist')).toBe(true);
    });

    it('should detect alarmist "if you don\'t" wording', () => {
      const result = validateGuidanceLanguage('If you don\'t rest, things will get worse.');
      expect(result.issues.some(i => i.type === 'alarmist')).toBe(true);
    });
  });

  describe('Valid Guidance Text', () => {
    it('should pass validation for optional phrasing', () => {
      const result = validateGuidanceLanguage(
        'You might consider taking a short break when you have a moment.'
      );
      expect(result.valid).toBe(true);
    });

    it('should pass validation for reflection questions', () => {
      const result = validateGuidanceLanguage(
        'What might help you feel more prepared for tomorrow?'
      );
      expect(result.valid).toBe(true);
    });

    it('should pass validation for multiple optional phrases', () => {
      for (const pattern of OPTIONAL_PHRASING_PATTERNS) {
        const text = `${pattern} taking some time to rest.`;
        const result = validateGuidanceLanguage(text);
        expect(result.valid).toBe(true);
      }
    });

    it('should warn about missing optional phrasing but still be valid', () => {
      const result = validateGuidanceLanguage('Your energy levels seem stable.');
      // Valid because no forbidden phrases, but may have warning
      expect(result.issues.some(i => i.type === 'missing_optional_phrasing')).toBe(true);
      // The text should still be marked valid as missing_optional_phrasing is soft
      expect(result.valid).toBe(true);
    });
  });
});

// =============================================================================
// Eligibility Checking Tests
// =============================================================================

describe('D46 Eligibility Checking', () => {
  describe('Window Confidence Threshold', () => {
    it('should fail eligibility when window confidence below 70%', () => {
      const window = createMockWindow({ confidence: 60 });
      const context = createMockUserContext();

      const result = checkWindowEligibility(window, context, []);

      expect(result.eligible).toBe(false);
      expect(result.checks.window_confidence_met).toBe(false);
      expect(result.reason).toContain('confidence');
    });

    it('should pass eligibility when window confidence at 70%', () => {
      const window = createMockWindow({ confidence: 70 });
      const context = createMockUserContext();

      const result = checkWindowEligibility(window, context, []);

      expect(result.checks.window_confidence_met).toBe(true);
    });

    it('should pass eligibility when window confidence above 70%', () => {
      const window = createMockWindow({ confidence: 85 });
      const context = createMockUserContext();

      const result = checkWindowEligibility(window, context, []);

      expect(result.checks.window_confidence_met).toBe(true);
    });
  });

  describe('Cognitive Load Threshold', () => {
    it('should fail eligibility when cognitive load above 70', () => {
      const window = createMockWindow();
      const context = createMockUserContext({ current_cognitive_load: 80 });

      const result = checkWindowEligibility(window, context, []);

      expect(result.eligible).toBe(false);
      expect(result.checks.cognitive_load_acceptable).toBe(false);
      expect(result.reason).toContain('cognitive load');
    });

    it('should pass eligibility when cognitive load at 70', () => {
      const window = createMockWindow();
      const context = createMockUserContext({ current_cognitive_load: 70 });

      const result = checkWindowEligibility(window, context, []);

      expect(result.checks.cognitive_load_acceptable).toBe(true);
    });

    it('should pass eligibility when cognitive load below 70', () => {
      const window = createMockWindow();
      const context = createMockUserContext({ current_cognitive_load: 40 });

      const result = checkWindowEligibility(window, context, []);

      expect(result.checks.cognitive_load_acceptable).toBe(true);
    });
  });

  describe('Cooldown Period (14 Days)', () => {
    it('should fail eligibility when similar guidance shown recently', () => {
      const window = createMockWindow({ domain: 'health' });
      const context = createMockUserContext();
      const recentInteractions = [
        {
          guidance_id: '55555555-5555-5555-5555-555555555555',
          domain: 'health' as SignalDomain,
          mode: 'awareness' as GuidanceMode,
          pattern_type: 'stress_spike',
          interaction: 'surfaced' as const,
          interacted_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days ago
        }
      ];

      const result = checkWindowEligibility(window, context, recentInteractions);

      expect(result.eligible).toBe(false);
      expect(result.checks.cooldown_passed).toBe(false);
      expect(result.reason).toContain('14 days');
    });

    it('should pass eligibility when similar guidance shown over 14 days ago', () => {
      const window = createMockWindow({ domain: 'health' });
      const context = createMockUserContext();
      const recentInteractions = [
        {
          guidance_id: '55555555-5555-5555-5555-555555555555',
          domain: 'health' as SignalDomain,
          mode: 'awareness' as GuidanceMode,
          pattern_type: 'stress_spike',
          interaction: 'surfaced' as const,
          interacted_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString() // 20 days ago
        }
      ];

      const result = checkWindowEligibility(window, context, recentInteractions);

      expect(result.checks.cooldown_passed).toBe(true);
    });

    it('should pass eligibility when different domain guidance shown recently', () => {
      const window = createMockWindow({ domain: 'health' });
      const context = createMockUserContext();
      const recentInteractions = [
        {
          guidance_id: '55555555-5555-5555-5555-555555555555',
          domain: 'social' as SignalDomain, // Different domain
          mode: 'awareness' as GuidanceMode,
          pattern_type: 'social_withdrawal',
          interaction: 'surfaced' as const,
          interacted_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() // 3 days ago
        }
      ];

      const result = checkWindowEligibility(window, context, recentInteractions);

      expect(result.checks.cooldown_passed).toBe(true);
    });
  });

  describe('Domain Enabled Check', () => {
    it('should fail eligibility when domain not enabled in preferences', () => {
      const window = createMockWindow({ domain: 'financial' });
      const context = createMockUserContext({
        preferences: {
          preferred_tone: 'conversational',
          preferred_timing: 'proactive',
          enabled_domains: ['health', 'behavior'], // financial not included
          sensitivity_level: 'medium',
          max_daily_guidance: 3
        }
      });

      const result = checkWindowEligibility(window, context, []);

      expect(result.eligible).toBe(false);
      expect(result.checks.relevance_score_met).toBe(false);
    });
  });

  describe('Daily Limit', () => {
    it('should fail eligibility when daily limit reached', () => {
      const window = createMockWindow();
      const context = createMockUserContext({
        guidance_today_count: 3,
        preferences: {
          preferred_tone: 'conversational',
          preferred_timing: 'proactive',
          enabled_domains: ['health', 'behavior', 'social', 'cognitive', 'routine'],
          sensitivity_level: 'medium',
          max_daily_guidance: 3
        }
      });

      const result = checkWindowEligibility(window, context, []);

      expect(result.eligible).toBe(false);
      expect(result.checks.relevance_score_met).toBe(false);
    });
  });

  describe('All Checks Pass', () => {
    it('should be eligible when all checks pass', () => {
      const window = createMockWindow({ confidence: 80 });
      const context = createMockUserContext({ current_cognitive_load: 40 });

      const result = checkWindowEligibility(window, context, []);

      expect(result.eligible).toBe(true);
      expect(result.checks.window_confidence_met).toBe(true);
      expect(result.checks.relevance_score_met).toBe(true);
      expect(result.checks.cooldown_passed).toBe(true);
      expect(result.checks.cognitive_load_acceptable).toBe(true);
    });
  });
});

// =============================================================================
// Relevance Score Tests
// =============================================================================

describe('D46 Relevance Score Calculation', () => {
  it('should start with base score of 50', () => {
    const window = createMockWindow({ confidence: 70, impact_level: 'low' });
    const signals: PatternSignal[] = [];
    const context = createMockUserContext();

    const score = calculateRelevanceScore(window, signals, context);

    // Base 50, no boosts from low confidence/impact/signals
    expect(score).toBeGreaterThanOrEqual(50);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('should boost score for high confidence windows (>=85)', () => {
    const window = createMockWindow({ confidence: 90, impact_level: 'low' });
    const signals: PatternSignal[] = [];
    const context = createMockUserContext();

    const score = calculateRelevanceScore(window, signals, context);

    // Base 50 + 15 for high confidence = 65
    expect(score).toBeGreaterThanOrEqual(65);
  });

  it('should boost score for high impact windows', () => {
    const window = createMockWindow({ confidence: 70, impact_level: 'high' });
    const signals: PatternSignal[] = [];
    const context = createMockUserContext();

    const score = calculateRelevanceScore(window, signals, context);

    // Base 50 + 20 for high impact = 70
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('should boost score for strong domain signals', () => {
    const window = createMockWindow({ confidence: 70, impact_level: 'low', domain: 'health' });
    const signals = [createMockSignal({ intensity: 80, domain: 'health' })];
    const context = createMockUserContext();

    const score = calculateRelevanceScore(window, signals, context);

    // Should include boost for high intensity signals
    expect(score).toBeGreaterThanOrEqual(65);
  });

  it('should reduce score for many dismissals', () => {
    const window = createMockWindow({ domain: 'health' });
    const signals: PatternSignal[] = [];
    const context = createMockUserContext({
      recent_interactions: [
        { guidance_id: 'a', domain: 'health', mode: 'awareness', pattern_type: 'x', interaction: 'dismissed', interacted_at: new Date().toISOString() },
        { guidance_id: 'b', domain: 'health', mode: 'awareness', pattern_type: 'x', interaction: 'dismissed', interacted_at: new Date().toISOString() },
        { guidance_id: 'c', domain: 'health', mode: 'awareness', pattern_type: 'x', interaction: 'dismissed', interacted_at: new Date().toISOString() }
      ]
    });

    const scoreWithDismissals = calculateRelevanceScore(window, signals, context);

    const contextWithoutDismissals = createMockUserContext();
    const scoreWithoutDismissals = calculateRelevanceScore(window, signals, contextWithoutDismissals);

    expect(scoreWithDismissals).toBeLessThan(scoreWithoutDismissals);
  });

  it('should boost score for past engagements in domain', () => {
    const window = createMockWindow({ domain: 'health' });
    const signals: PatternSignal[] = [];
    const context = createMockUserContext({
      recent_interactions: [
        { guidance_id: 'a', domain: 'health', mode: 'awareness', pattern_type: 'x', interaction: 'engaged', interacted_at: new Date().toISOString() },
        { guidance_id: 'b', domain: 'health', mode: 'awareness', pattern_type: 'x', interaction: 'engaged', interacted_at: new Date().toISOString() }
      ]
    });

    const scoreWithEngagements = calculateRelevanceScore(window, signals, context);

    const contextWithoutEngagements = createMockUserContext();
    const scoreWithoutEngagements = calculateRelevanceScore(window, signals, contextWithoutEngagements);

    expect(scoreWithEngagements).toBeGreaterThan(scoreWithoutEngagements);
  });

  it('should clamp score between 0 and 100', () => {
    // Test upper bound
    const highWindow = createMockWindow({ confidence: 95, impact_level: 'high' });
    const highSignals = [createMockSignal({ intensity: 95 })];
    const engagedContext = createMockUserContext({
      recent_interactions: [
        { guidance_id: 'a', domain: 'health', mode: 'awareness', pattern_type: 'x', interaction: 'engaged', interacted_at: new Date().toISOString() },
        { guidance_id: 'b', domain: 'health', mode: 'awareness', pattern_type: 'x', interaction: 'engaged', interacted_at: new Date().toISOString() }
      ]
    });

    const highScore = calculateRelevanceScore(highWindow, highSignals, engagedContext);
    expect(highScore).toBeLessThanOrEqual(100);
    expect(highScore).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Guidance Mode Selection Tests
// =============================================================================

describe('D46 Guidance Mode Selection', () => {
  describe('Reinforcement Mode', () => {
    it('should select reinforcement for peak windows with positive momentum', () => {
      const window = createMockWindow({ type: 'peak', domain: 'health' });
      const signals = [createMockSignal({ domain: 'health', trend: 'increasing', intensity: 70 })];
      const prefs: GuidancePreferences = {
        preferred_tone: 'conversational',
        preferred_timing: 'proactive',
        enabled_domains: ['health'],
        sensitivity_level: 'medium',
        max_daily_guidance: 3
      };

      const mode = selectGuidanceMode(window, signals, prefs);

      expect(mode).toBe('reinforcement');
    });

    it('should select reinforcement for recovery windows with positive signals', () => {
      const window = createMockWindow({ type: 'recovery', domain: 'health' });
      const signals = [createMockSignal({ domain: 'health', trend: 'increasing', intensity: 65 })];
      const prefs: GuidancePreferences = {
        preferred_tone: 'conversational',
        preferred_timing: 'proactive',
        enabled_domains: ['health'],
        sensitivity_level: 'medium',
        max_daily_guidance: 3
      };

      const mode = selectGuidanceMode(window, signals, prefs);

      expect(mode).toBe('reinforcement');
    });
  });

  describe('Preparation Mode', () => {
    it('should select preparation for risk window 24-72 hours away', () => {
      const futureStart = new Date(Date.now() + 36 * 60 * 60 * 1000); // 36 hours from now
      const window = createMockWindow({
        type: 'risk',
        starts_at: futureStart.toISOString()
      });
      const signals: PatternSignal[] = [];
      const prefs: GuidancePreferences = {
        preferred_tone: 'brief',
        preferred_timing: 'proactive',
        enabled_domains: ['health'],
        sensitivity_level: 'medium',
        max_daily_guidance: 3
      };

      const mode = selectGuidanceMode(window, signals, prefs);

      expect(mode).toBe('preparation');
    });

    it('should select preparation for opportunity window 24-72 hours away', () => {
      const futureStart = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours from now
      const window = createMockWindow({
        type: 'opportunity',
        starts_at: futureStart.toISOString()
      });
      const signals: PatternSignal[] = [];
      const prefs: GuidancePreferences = {
        preferred_tone: 'brief',
        preferred_timing: 'proactive',
        enabled_domains: ['health'],
        sensitivity_level: 'medium',
        max_daily_guidance: 3
      };

      const mode = selectGuidanceMode(window, signals, prefs);

      expect(mode).toBe('preparation');
    });
  });

  describe('Reflection Mode', () => {
    it('should select reflection for transition windows', () => {
      const window = createMockWindow({ type: 'transition' });
      const signals: PatternSignal[] = [];
      const prefs: GuidancePreferences = {
        preferred_tone: 'brief',
        preferred_timing: 'proactive',
        enabled_domains: ['health'],
        sensitivity_level: 'medium',
        max_daily_guidance: 3
      };

      const mode = selectGuidanceMode(window, signals, prefs);

      expect(mode).toBe('reflection');
    });

    it('should select reflection for conversational tone when not in preparation window', () => {
      // Window starting soon (within 6 hours), so not in 24-72h preparation window
      const soon = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours from now
      const window = createMockWindow({ type: 'risk', starts_at: soon.toISOString() });
      const signals: PatternSignal[] = [];
      const prefs: GuidancePreferences = {
        preferred_tone: 'conversational',
        preferred_timing: 'proactive',
        enabled_domains: ['health'],
        sensitivity_level: 'medium',
        max_daily_guidance: 3
      };

      const mode = selectGuidanceMode(window, signals, prefs);

      expect(mode).toBe('reflection');
    });
  });

  describe('Awareness Mode', () => {
    it('should default to awareness mode', () => {
      const window = createMockWindow({ type: 'low' });
      const signals: PatternSignal[] = [];
      const prefs: GuidancePreferences = {
        preferred_tone: 'brief',
        preferred_timing: 'proactive',
        enabled_domains: ['health'],
        sensitivity_level: 'medium',
        max_daily_guidance: 3
      };

      const mode = selectGuidanceMode(window, signals, prefs);

      expect(mode).toBe('awareness');
    });
  });
});

// =============================================================================
// Timing Hint Selection Tests
// =============================================================================

describe('D46 Timing Hint Selection', () => {
  it('should select "now" for windows starting within 6 hours', () => {
    const soon = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours from now
    const window = createMockWindow({ starts_at: soon.toISOString() });

    const hint = selectTimingHint(window);

    expect(hint).toBe('now');
  });

  it('should select "next_24h" for windows starting 6-24 hours away', () => {
    const tomorrow = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours from now
    const window = createMockWindow({ starts_at: tomorrow.toISOString() });

    const hint = selectTimingHint(window);

    expect(hint).toBe('next_24h');
  });

  it('should select "before_window" for windows starting >24 hours away', () => {
    const farFuture = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours from now
    const window = createMockWindow({ starts_at: farFuture.toISOString() });

    const hint = selectTimingHint(window);

    expect(hint).toBe('before_window');
  });
});

// =============================================================================
// Guidance Text Generation Tests
// =============================================================================

describe('D46 Guidance Text Generation', () => {
  it('should generate awareness text', () => {
    const window = createMockWindow({ domain: 'health', description: 'Energy levels may dip.' });
    const signals = [createMockSignal({ domain: 'health', pattern_type: 'energy_decline' })];

    const { text, why } = generateGuidanceText('awareness', window, signals);

    expect(text).toBeTruthy();
    expect(text.length).toBeGreaterThan(0);
    expect(why).toBeTruthy();
    expect(text).toContain('energy levels');
  });

  it('should generate reflection text with question', () => {
    const window = createMockWindow({ type: 'transition', domain: 'social' });
    const signals: PatternSignal[] = [];

    const { text } = generateGuidanceText('reflection', window, signals);

    expect(text).toContain('?');
  });

  it('should generate preparation text with optional phrasing', () => {
    const window = createMockWindow({ domain: 'health' });
    const signals: PatternSignal[] = [];

    const { text } = generateGuidanceText('preparation', window, signals);

    expect(text.toLowerCase()).toMatch(/might|could|may|consider/);
  });

  it('should generate reinforcement text with positive framing', () => {
    const window = createMockWindow({ type: 'peak', domain: 'behavior' });
    const signals: PatternSignal[] = [];

    const { text } = generateGuidanceText('reinforcement', window, signals);

    // Check for positive framing patterns (pattern|cultivating|taking hold|seem)
    expect(text.toLowerCase()).toMatch(/pattern|cultivating|taking|seem|appear/);
  });

  it('should include window description in why_this_matters', () => {
    const description = 'Your sleep patterns indicate fatigue.';
    const window = createMockWindow({ description });
    const signals = [createMockSignal({ domain: 'health', pattern_type: 'fatigue_detected' })];

    const { why } = generateGuidanceText('awareness', window, signals);

    // The why text should mention patterns and include relevant context
    expect(why.toLowerCase()).toMatch(/pattern|based|observation|detected/);
  });
});

// =============================================================================
// Determinism Tests
// =============================================================================

describe('D46 Determinism', () => {
  it('should produce identical output for identical eligibility input', () => {
    const window = createMockWindow();
    const context = createMockUserContext();

    const result1 = checkWindowEligibility(window, context, []);
    const result2 = checkWindowEligibility(window, context, []);

    expect(result1.eligible).toBe(result2.eligible);
    expect(result1.reason).toBe(result2.reason);
    expect(result1.checks).toEqual(result2.checks);
  });

  it('should produce identical relevance scores for identical input', () => {
    const window = createMockWindow();
    const signals = [createMockSignal()];
    const context = createMockUserContext();

    const score1 = calculateRelevanceScore(window, signals, context);
    const score2 = calculateRelevanceScore(window, signals, context);

    expect(score1).toBe(score2);
  });

  it('should produce identical guidance mode for identical input', () => {
    const window = createMockWindow();
    const signals = [createMockSignal()];
    const prefs: GuidancePreferences = {
      preferred_tone: 'conversational',
      preferred_timing: 'proactive',
      enabled_domains: ['health'],
      sensitivity_level: 'medium',
      max_daily_guidance: 3
    };

    const mode1 = selectGuidanceMode(window, signals, prefs);
    const mode2 = selectGuidanceMode(window, signals, prefs);

    expect(mode1).toBe(mode2);
  });

  it('should produce identical language validation for identical input', () => {
    const text = 'You might consider taking a break.';

    const result1 = validateGuidanceLanguage(text);
    const result2 = validateGuidanceLanguage(text);

    expect(result1.valid).toBe(result2.valid);
    expect(result1.issues).toEqual(result2.issues);
  });
});

// =============================================================================
// Guidance Generation Integration Tests
// =============================================================================

describe('D46 Guidance Generation Integration', () => {
  it('should generate guidance from valid window bundle', async () => {
    const signalBundle = createMockSignalBundle({ cognitive_load: 40 });
    const windowBundle = createMockWindowBundle({
      windows: [createMockWindow({ confidence: 80, domain: 'health' })]
    });

    const result = await generateGuidance({
      signal_bundle: signalBundle,
      window_bundle: windowBundle,
      max_items: 5
    });

    expect(result.ok).toBe(true);
    expect(result.guidance_items).toBeDefined();
    expect(result.generation_summary).toBeDefined();
    expect(result.generation_summary?.windows_evaluated).toBe(1);
  });

  it('should skip windows that fail eligibility', async () => {
    const signalBundle = createMockSignalBundle({ cognitive_load: 90 }); // High cognitive load
    const windowBundle = createMockWindowBundle({
      windows: [createMockWindow({ confidence: 80 })]
    });

    const result = await generateGuidance({
      signal_bundle: signalBundle,
      window_bundle: windowBundle,
      user_context: createMockUserContext({ current_cognitive_load: 90 }),
      max_items: 5
    });

    expect(result.ok).toBe(true);
    expect(result.skipped_windows).toBeDefined();
    expect(result.skipped_windows?.length).toBe(1);
    expect(result.skipped_windows?.[0].reason).toContain('cognitive load');
  });

  it('should skip windows with low confidence', async () => {
    const signalBundle = createMockSignalBundle();
    const windowBundle = createMockWindowBundle({
      windows: [createMockWindow({ confidence: 50 })] // Below 70% threshold
    });

    const result = await generateGuidance({
      signal_bundle: signalBundle,
      window_bundle: windowBundle,
      max_items: 5
    });

    expect(result.ok).toBe(true);
    expect(result.skipped_windows?.length).toBe(1);
    expect(result.skipped_windows?.[0].reason).toContain('confidence');
  });

  it('should respect max_items limit', async () => {
    const signalBundle = createMockSignalBundle();
    const windowBundle = createMockWindowBundle({
      windows: [
        createMockWindow({ window_id: 'a', confidence: 80, domain: 'health' }),
        createMockWindow({ window_id: 'b', confidence: 80, domain: 'behavior' }),
        createMockWindow({ window_id: 'c', confidence: 80, domain: 'social' }),
        createMockWindow({ window_id: 'd', confidence: 80, domain: 'cognitive' }),
        createMockWindow({ window_id: 'e', confidence: 80, domain: 'routine' })
      ]
    });

    const result = await generateGuidance({
      signal_bundle: signalBundle,
      window_bundle: windowBundle,
      max_items: 2
    });

    expect(result.ok).toBe(true);
    expect(result.guidance_items?.length).toBeLessThanOrEqual(2);
  });

  it('should include generation summary', async () => {
    const signalBundle = createMockSignalBundle();
    const windowBundle = createMockWindowBundle({
      windows: [
        createMockWindow({ confidence: 80 }),
        createMockWindow({ window_id: 'b', confidence: 50 }) // Will be skipped
      ]
    });

    const result = await generateGuidance({
      signal_bundle: signalBundle,
      window_bundle: windowBundle,
      max_items: 5
    });

    expect(result.ok).toBe(true);
    expect(result.generation_summary?.windows_evaluated).toBe(2);
    expect(result.generation_summary?.cognitive_load_at_generation).toBe(40);
  });
});

// =============================================================================
// Thresholds Tests
// =============================================================================

describe('D46 Thresholds', () => {
  it('should export correct threshold values', () => {
    expect(GUIDANCE_THRESHOLDS.MIN_WINDOW_CONFIDENCE).toBe(70);
    expect(GUIDANCE_THRESHOLDS.MIN_RELEVANCE_SCORE).toBe(75);
    expect(GUIDANCE_THRESHOLDS.COOLDOWN_DAYS).toBe(14);
    expect(GUIDANCE_THRESHOLDS.MAX_COGNITIVE_LOAD).toBe(70);
    expect(GUIDANCE_THRESHOLDS.MAX_GUIDANCE_PER_BUNDLE).toBe(5);
    expect(GUIDANCE_THRESHOLDS.MAX_GUIDANCE_PER_DAY).toBe(3);
  });

  it('should have valid generation rules version', () => {
    expect(GENERATION_RULES_VERSION).toBeTruthy();
    expect(GENERATION_RULES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// =============================================================================
// Output Structure Tests
// =============================================================================

describe('D46 Output Structure', () => {
  it('should generate guidance with all required fields', () => {
    const window = createMockWindow({ confidence: 80, domain: 'health' });
    const signals = [createMockSignal({ domain: 'health' })];
    const context = createMockUserContext();

    const guidance = generateGuidanceFromWindow(window, signals, context, 80);

    expect(guidance).not.toBeNull();
    expect(guidance?.guidance_id).toBeTruthy();
    expect(guidance?.source_window_id).toBe(window.window_id);
    expect(['awareness', 'reflection', 'preparation', 'reinforcement']).toContain(guidance?.guidance_mode);
    expect(guidance?.domain).toBe('health');
    expect(guidance?.confidence).toBeGreaterThanOrEqual(0);
    expect(guidance?.confidence).toBeLessThanOrEqual(100);
    expect(['now', 'next_24h', 'before_window']).toContain(guidance?.timing_hint);
    expect(guidance?.guidance_text).toBeTruthy();
    expect(guidance?.why_this_matters).toBeTruthy();
    expect(guidance?.dismissible).toBe(true);
  });

  it('should always set dismissible to true', () => {
    const window = createMockWindow();
    const signals = [createMockSignal()];
    const context = createMockUserContext();

    const guidance = generateGuidanceFromWindow(window, signals, context, 80);

    expect(guidance?.dismissible).toBe(true);
  });
});

// =============================================================================
// Domain-specific Tests
// =============================================================================

describe('D46 Domain-specific Behavior', () => {
  const domains: SignalDomain[] = ['health', 'behavior', 'social', 'cognitive', 'routine', 'emotional', 'financial'];

  for (const domain of domains) {
    it(`should generate guidance for ${domain} domain`, () => {
      const window = createMockWindow({ domain, confidence: 80 });
      const signals = [createMockSignal({ domain })];
      const context = createMockUserContext({
        preferences: {
          preferred_tone: 'conversational',
          preferred_timing: 'proactive',
          enabled_domains: [domain],
          sensitivity_level: 'medium',
          max_daily_guidance: 3
        }
      });

      const guidance = generateGuidanceFromWindow(window, signals, context, 80);

      expect(guidance).not.toBeNull();
      expect(guidance?.domain).toBe(domain);
      expect(guidance?.guidance_text.length).toBeGreaterThan(0);
    });
  }
});

// =============================================================================
// Window Type Tests
// =============================================================================

describe('D46 Window Type Handling', () => {
  const windowTypes: WindowType[] = ['risk', 'opportunity', 'transition', 'recovery', 'peak', 'low'];

  for (const type of windowTypes) {
    it(`should handle ${type} window type`, () => {
      const window = createMockWindow({ type, confidence: 80 });
      const signals = [createMockSignal()];
      const context = createMockUserContext();

      const guidance = generateGuidanceFromWindow(window, signals, context, 80);

      expect(guidance).not.toBeNull();
      expect(guidance?.guidance_text).toBeTruthy();
      expect(guidance?.why_this_matters).toBeTruthy();
    });
  }
});
