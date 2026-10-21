/**
 * VTID-01132: D38 Learning Style Engine Tests
 *
 * Tests for the Learning Style, Adaptation & Knowledge Absorption Engine
 */

import {
  computeLearningStyle,
  getDefaultLearningStyle,
  formatLearningStyleForPrompt,
  describeLearningStyle,
  INFERENCE_CONFIDENCE_CAP,
} from '../src/services/d38-learning-style-engine';
import {
  LearningStyleInputBundle,
  DEFAULT_LEARNING_STYLE_PROFILE,
} from '../src/types/learning-style';

describe('D38 Learning Style Engine', () => {
  // ==========================================================================
  // Determinism Tests
  // ==========================================================================

  describe('Determinism', () => {
    it('should produce identical output for identical input', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          avg_message_length: 150,
          follow_up_question_count: 2,
          interaction_count: 5,
        },
      };

      const result1 = computeLearningStyle(input);
      const result2 = computeLearningStyle(input);

      expect(result1.profile).toEqual(result2.profile);
      expect(result1.confidence).toEqual(result2.confidence);
      expect(result1.response_plan).toEqual(result2.response_plan);
      expect(result1.rules_applied).toEqual(result2.rules_applied);
    });
  });

  // ==========================================================================
  // Brevity Preference Tests
  // ==========================================================================

  describe('Brevity Preference Inference', () => {
    it('should infer concise preference from short messages', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          avg_message_length: 50,
          interaction_count: 5,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.brevity_preference).toBe('concise');
    });

    it('should infer detailed preference from long messages', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          avg_message_length: 300,
          interaction_count: 5,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.brevity_preference).toBe('detailed');
    });

    it('should respect explicit length preference', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          avg_message_length: 50, // Would normally infer concise
        },
        explicit_preferences: {
          preferred_length: 'detailed',
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.brevity_preference).toBe('detailed');
      expect(result.confidence.brevity_preference).toBe(100);
    });

    it('should infer concise from brevity feedback', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          brevity_feedback_count: 2,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.brevity_preference).toBe('concise');
    });

    it('should infer detailed from detail requests', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          detail_request_count: 3,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.brevity_preference).toBe('detailed');
    });

    it('should force concise when time constrained', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        availability: {
          time_constrained: true,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.brevity_preference).toBe('concise');
    });

    it('should force concise when cognitive load is high', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        availability: {
          cognitive_load: 80,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.brevity_preference).toBe('concise');
    });
  });

  // ==========================================================================
  // Absorption Rate Tests
  // ==========================================================================

  describe('Absorption Rate Inference', () => {
    it('should infer fast absorption from low follow-ups', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          follow_up_question_count: 0,
          interaction_count: 5,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.absorption_rate).toBe('fast');
    });

    it('should infer slow absorption from many follow-ups', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          follow_up_question_count: 5,
          interaction_count: 5,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.absorption_rate).toBe('slow');
    });

    it('should use historical absorption rate when available', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        historical: {
          historical_absorption_rate: 'fast',
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.absorption_rate).toBe('fast');
    });

    it('should infer from high guidance uptake rate', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        historical: {
          guidance_uptake_rate: 0.9,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.absorption_rate).toBe('fast');
    });
  });

  // ==========================================================================
  // Example Orientation Tests
  // ==========================================================================

  describe('Example Orientation Inference', () => {
    it('should infer examples_first from example requests', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          example_request_count: 2,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.example_orientation).toBe('examples_first');
    });

    it('should infer examples_first for beginners', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        explicit_preferences: {
          expertise_level: 'beginner',
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.example_orientation).toBe('examples_first');
    });

    it('should infer principles_first for experts', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        explicit_preferences: {
          expertise_level: 'expert',
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.example_orientation).toBe('principles_first');
    });

    it('should respect explicit example preference', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        explicit_preferences: {
          prefers_examples: false,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.example_orientation).toBe('principles_first');
      expect(result.confidence.example_orientation).toBe(100);
    });
  });

  // ==========================================================================
  // Terminology Comfort Tests
  // ==========================================================================

  describe('Terminology Comfort Inference', () => {
    it('should infer avoid_jargon from many clarification requests', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          clarification_request_count: 4,
          interaction_count: 6,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.terminology_comfort).toBe('avoid_jargon');
    });

    it('should infer intermediate from technical vocabulary usage', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          uses_technical_vocabulary: true,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.terminology_comfort).toBe('intermediate');
    });

    it('should respect explicit expertise level', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        explicit_preferences: {
          expertise_level: 'expert',
        },
      };

      const result = computeLearningStyle(input);
      expect(result.profile.terminology_comfort).toBe('expert');
      expect(result.confidence.terminology_comfort).toBe(90);
    });
  });

  // ==========================================================================
  // Response Plan Tests
  // ==========================================================================

  describe('Response Plan Generation', () => {
    it('should generate step_by_step tag for step structure preference', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          follow_up_question_count: 4,
        },
        availability: {
          cognitive_load: 70,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.response_plan.learning_tags).toContain('step_by_step');
    });

    it('should include avoid_jargon tag when terminology comfort is low', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          clarification_request_count: 5,
          interaction_count: 6,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.response_plan.learning_tags).toContain('avoid_jargon');
    });

    it('should set reinforcement_needed for slow absorbers', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          follow_up_question_count: 6,
          interaction_count: 5,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.response_plan.reinforcement_needed).toBe(true);
    });

    it('should set check_understanding for high cognitive load', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        availability: {
          cognitive_load: 75,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.response_plan.check_understanding).toBe(true);
    });

    it('should suggest short max length for concise preference', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        explicit_preferences: {
          preferred_length: 'brief',
        },
      };

      const result = computeLearningStyle(input);
      expect(result.response_plan.suggested_max_length).toBe(500);
    });
  });

  // ==========================================================================
  // Confidence Tests
  // ==========================================================================

  describe('Confidence Scoring', () => {
    it('should never exceed INFERENCE_CONFIDENCE_CAP for inferred values', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          avg_message_length: 50,
          brevity_feedback_count: 5,
          detail_request_count: 5, // Conflicting signals
          follow_up_question_count: 10,
          interaction_count: 10,
        },
      };

      const result = computeLearningStyle(input);

      // Check all confidence values are capped
      Object.values(result.confidence).forEach(conf => {
        expect(conf).toBeLessThanOrEqual(INFERENCE_CONFIDENCE_CAP);
      });
    });

    it('should allow 100% confidence for explicit preferences', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        explicit_preferences: {
          preferred_length: 'brief',
          prefers_examples: true,
        },
      };

      const result = computeLearningStyle(input);
      expect(result.confidence.brevity_preference).toBe(100);
      expect(result.confidence.example_orientation).toBe(100);
    });

    it('should calculate overall confidence as average', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
      };

      const result = computeLearningStyle(input);
      const values = Object.values(result.confidence);
      const expectedAvg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      expect(result.overall_confidence).toBe(expectedAvg);
    });
  });

  // ==========================================================================
  // Default Values Tests
  // ==========================================================================

  describe('Default Values', () => {
    it('should return sensible defaults with no input', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
      };

      const result = computeLearningStyle(input);
      expect(result.profile.brevity_preference).toBe('moderate');
      expect(result.profile.absorption_rate).toBe('unknown');
    });

    it('should return default learning style bundle', () => {
      const result = getDefaultLearningStyle();
      expect(result.profile).toEqual(DEFAULT_LEARNING_STYLE_PROFILE);
      expect(result.rules_applied).toContain('default_profile_applied');
    });
  });

  // ==========================================================================
  // Utility Function Tests
  // ==========================================================================

  describe('Utility Functions', () => {
    it('should format learning style for prompt correctly', () => {
      const input: LearningStyleInputBundle = {
        conversation: {},
        explicit_preferences: {
          preferred_length: 'brief',
          prefers_examples: true,
        },
      };

      const result = computeLearningStyle(input);
      const prompt = formatLearningStyleForPrompt(result);

      expect(prompt).toContain('Learning Style Adaptation Guidelines');
      expect(prompt).toContain('brief');
      expect(prompt).toContain('example');
    });

    it('should describe learning style in human-readable format', () => {
      const result = computeLearningStyle({ conversation: {} });
      const description = describeLearningStyle(result.profile);

      expect(description).toContain('moderate responses');
      expect(description.endsWith('.')).toBe(true);
    });
  });

  // ==========================================================================
  // Evidence Trail Tests
  // ==========================================================================

  describe('Evidence Trail', () => {
    it('should include evidence for inferred dimensions', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          avg_message_length: 50,
          example_request_count: 2,
        },
      };

      const result = computeLearningStyle(input);

      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence.some(e => e.signal === 'avg_message_length')).toBe(true);
      expect(result.evidence.some(e => e.signal === 'example_request_count')).toBe(true);
    });

    it('should track applied rules', () => {
      const input: LearningStyleInputBundle = {
        conversation: {
          avg_message_length: 50,
        },
        availability: {
          time_constrained: true,
        },
      };

      const result = computeLearningStyle(input);

      expect(result.rules_applied).toContain('short_messages_infer_concise');
      expect(result.rules_applied).toContain('time_constraint_brevity');
    });
  });

  // ==========================================================================
  // Disclaimer Tests
  // ==========================================================================

  describe('Disclaimer', () => {
    it('should include disclaimer in bundle', () => {
      const result = computeLearningStyle({ conversation: {} });
      expect(result.disclaimer).toBeTruthy();
      expect(result.disclaimer).toContain('inference');
    });
  });
});
