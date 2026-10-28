/**
 * Tests for Autopilot Event Mapper - VTID-01179
 *
 * Tests the canonical event → transition mapping logic
 */

import {
  mapEventToTransition,
  isAutopilotRelevantEvent,
  normalizeEventType,
  getValidNextStates,
  getAutopilotEventTypes,
  OasisEvent,
  EVENT_MAPPING_RULES,
} from '../src/services/autopilot-event-mapper';

describe('Autopilot Event Mapper - VTID-01179', () => {
  // Helper to create test events
  const createEvent = (overrides: Partial<OasisEvent>): OasisEvent => ({
    id: 'test-event-' + Math.random().toString(36).slice(2),
    created_at: new Date().toISOString(),
    vtid: 'VTID-01000',
    topic: 'test.event',
    status: 'info',
    ...overrides,
  });

  describe('normalizeEventType', () => {
    it('should prefer topic over kind', () => {
      const event = createEvent({ topic: 'topic.value', kind: 'kind.value' });
      expect(normalizeEventType(event)).toBe('topic.value');
    });

    it('should fall back to kind when topic is missing', () => {
      const event = createEvent({ topic: undefined, kind: 'kind.value' });
      expect(normalizeEventType(event)).toBe('kind.value');
    });

    it('should return unknown when both are missing', () => {
      const event = createEvent({ topic: undefined, kind: undefined });
      expect(normalizeEventType(event)).toBe('unknown');
    });
  });

  describe('isAutopilotRelevantEvent', () => {
    it('should return false for events without VTID', () => {
      const event = createEvent({ vtid: undefined });
      expect(isAutopilotRelevantEvent(event)).toBe(false);
    });

    it('should return true for worker.dispatch.accepted events', () => {
      const event = createEvent({ topic: 'worker.dispatch.accepted' });
      expect(isAutopilotRelevantEvent(event)).toBe(true);
    });

    it('should return true for autopilot.validation.passed events', () => {
      const event = createEvent({ topic: 'autopilot.validation.passed' });
      expect(isAutopilotRelevantEvent(event)).toBe(true);
    });

    it('should return false for irrelevant events', () => {
      const event = createEvent({ topic: 'unrelated.event.type' });
      expect(isAutopilotRelevantEvent(event)).toBe(false);
    });
  });

  describe('mapEventToTransition', () => {
    describe('ALLOCATED → IN_PROGRESS', () => {
      it('should transition on worker.dispatch.accepted', () => {
        const event = createEvent({ topic: 'worker.dispatch.accepted' });
        const result = mapEventToTransition(event, 'allocated');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('in_progress');
      });

      it('should transition on worker.execution.started', () => {
        const event = createEvent({ topic: 'worker.execution.started' });
        const result = mapEventToTransition(event, 'allocated');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('in_progress');
      });

      it('should trigger dispatch action on vtid.lifecycle.allocated', () => {
        const event = createEvent({ topic: 'vtid.lifecycle.allocated' });
        const result = mapEventToTransition(event, 'allocated');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('in_progress');
        expect(result.triggerAction).toBe('dispatch');
      });
    });

    describe('IN_PROGRESS → BUILDING', () => {
      it('should transition on worker.building', () => {
        const event = createEvent({ topic: 'worker.building' });
        const result = mapEventToTransition(event, 'in_progress');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('building');
      });
    });

    describe('BUILDING → PR_CREATED', () => {
      it('should transition on worker.execution.completed', () => {
        const event = createEvent({
          topic: 'worker.execution.completed',
          metadata: { pr_number: 123, pr_url: 'https://github.com/...' },
        });
        const result = mapEventToTransition(event, 'building');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('pr_created');
      });

      it('should transition on cicd.github.create_pr.succeeded', () => {
        const event = createEvent({ topic: 'cicd.github.create_pr.succeeded' });
        const result = mapEventToTransition(event, 'building');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('pr_created');
      });
    });

    describe('PR_CREATED → REVIEWING', () => {
      it('should transition on cicd.ci.passed and trigger validation', () => {
        const event = createEvent({ topic: 'cicd.ci.passed' });
        const result = mapEventToTransition(event, 'pr_created');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('reviewing');
        expect(result.triggerAction).toBe('validate');
      });
    });

    describe('REVIEWING → VALIDATED', () => {
      it('should transition on autopilot.validation.passed and trigger merge', () => {
        const event = createEvent({ topic: 'autopilot.validation.passed' });
        const result = mapEventToTransition(event, 'reviewing');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('validated');
        expect(result.triggerAction).toBe('merge');
      });

      it('should transition to failed on autopilot.validation.failed', () => {
        const event = createEvent({ topic: 'autopilot.validation.failed' });
        const result = mapEventToTransition(event, 'reviewing');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('failed');
      });
    });

    describe('VALIDATED → MERGED', () => {
      it('should transition on cicd.github.safe_merge.executed', () => {
        const event = createEvent({ topic: 'cicd.github.safe_merge.executed' });
        const result = mapEventToTransition(event, 'validated');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('merged');
      });

      it('should NOT transition from non-validated state (hard gate)', () => {
        const event = createEvent({ topic: 'cicd.github.safe_merge.executed' });
        const result = mapEventToTransition(event, 'reviewing');

        // Should not match because merge requires validated state
        expect(result.matched).toBe(false);
      });
    });

    describe('MERGED → DEPLOYING', () => {
      it('should transition on cicd.deploy.service.started', () => {
        const event = createEvent({ topic: 'cicd.deploy.service.started' });
        const result = mapEventToTransition(event, 'merged');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('deploying');
      });
    });

    describe('DEPLOYING → VERIFYING', () => {
      it('should transition on cicd.deploy.service.succeeded and trigger verify', () => {
        const event = createEvent({ topic: 'cicd.deploy.service.succeeded' });
        const result = mapEventToTransition(event, 'deploying');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('verifying');
        expect(result.triggerAction).toBe('verify');
      });
    });

    describe('VERIFYING → COMPLETED', () => {
      it('should transition on autopilot.verification.passed', () => {
        const event = createEvent({ topic: 'autopilot.verification.passed' });
        const result = mapEventToTransition(event, 'verifying');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('completed');
      });

      it('should transition to failed on autopilot.verification.failed', () => {
        const event = createEvent({ topic: 'autopilot.verification.failed' });
        const result = mapEventToTransition(event, 'verifying');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('failed');
      });
    });

    describe('Terminal states', () => {
      it('should not match events when state is completed', () => {
        const event = createEvent({ topic: 'worker.dispatch.accepted' });
        const result = mapEventToTransition(event, 'completed');

        expect(result.matched).toBe(false);
        expect(result.reason).toContain('terminal state');
      });

      it('should not match events when state is failed', () => {
        const event = createEvent({ topic: 'worker.dispatch.accepted' });
        const result = mapEventToTransition(event, 'failed');

        expect(result.matched).toBe(false);
        expect(result.reason).toContain('terminal state');
      });
    });

    describe('Failure events', () => {
      it('should transition to failed on worker.execution.failed from in_progress', () => {
        const event = createEvent({ topic: 'worker.execution.failed' });
        const result = mapEventToTransition(event, 'in_progress');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('failed');
      });

      it('should transition to failed on cicd.deploy.service.failed from deploying', () => {
        const event = createEvent({ topic: 'cicd.deploy.service.failed' });
        const result = mapEventToTransition(event, 'deploying');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('failed');
      });
    });

    describe('Forward-only transitions', () => {
      it('should not allow backward transitions', () => {
        // Try to transition from pr_created back to in_progress
        const event = createEvent({ topic: 'worker.dispatch.accepted' });
        const result = mapEventToTransition(event, 'pr_created');

        // This should not match because it would be a backward transition
        expect(result.matched).toBe(false);
      });
    });

    describe('Event type aliases', () => {
      it('should handle deploy.gateway.success alias', () => {
        const event = createEvent({ topic: 'deploy.gateway.success' });
        const result = mapEventToTransition(event, 'deploying');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('verifying');
      });

      it('should handle github.merge.success alias', () => {
        const event = createEvent({ topic: 'github.merge.success' });
        const result = mapEventToTransition(event, 'validated');

        expect(result.matched).toBe(true);
        expect(result.toState).toBe('merged');
      });
    });
  });

  describe('getValidNextStates', () => {
    it('should return valid next states from allocated', () => {
      const nextStates = getValidNextStates('allocated');
      expect(nextStates).toContain('in_progress');
      expect(nextStates).toContain('failed');
    });

    it('should return valid next states from validated', () => {
      const nextStates = getValidNextStates('validated');
      expect(nextStates).toContain('merged');
      expect(nextStates).toContain('failed');
    });

    it('should return empty array for terminal states', () => {
      expect(getValidNextStates('completed')).toEqual([]);
      // VTID-01208: 'failed' can now transition to 'completed' on terminalization success
      expect(getValidNextStates('failed')).toEqual(['completed']);
    });
  });

  describe('getAutopilotEventTypes', () => {
    it('should return all event types from mapping rules', () => {
      const types = getAutopilotEventTypes();

      expect(types).toContain('worker.dispatch.accepted');
      expect(types).toContain('autopilot.validation.passed');
      expect(types).toContain('cicd.deploy.service.succeeded');
      expect(types.length).toBeGreaterThan(20); // We have many event types
    });

    it('should return sorted array', () => {
      const types = getAutopilotEventTypes();
      const sorted = [...types].sort();
      expect(types).toEqual(sorted);
    });
  });

  describe('EVENT_MAPPING_RULES', () => {
    it('should have rules for all state transitions', () => {
      // Check that we have rules covering the main state flow
      const rulesWithToState = (state: string) =>
        EVENT_MAPPING_RULES.filter(r => r.toState === state);

      expect(rulesWithToState('in_progress').length).toBeGreaterThan(0);
      expect(rulesWithToState('building').length).toBeGreaterThan(0);
      expect(rulesWithToState('pr_created').length).toBeGreaterThan(0);
      expect(rulesWithToState('reviewing').length).toBeGreaterThan(0);
      expect(rulesWithToState('validated').length).toBeGreaterThan(0);
      expect(rulesWithToState('merged').length).toBeGreaterThan(0);
      expect(rulesWithToState('deploying').length).toBeGreaterThan(0);
      expect(rulesWithToState('verifying').length).toBeGreaterThan(0);
      expect(rulesWithToState('completed').length).toBeGreaterThan(0);
      expect(rulesWithToState('failed').length).toBeGreaterThan(0);
    });

    it('should have descriptions for all rules', () => {
      for (const rule of EVENT_MAPPING_RULES) {
        expect(rule.description).toBeTruthy();
        expect(typeof rule.description).toBe('string');
      }
    });

    it('should have non-empty eventTypes for all rules', () => {
      for (const rule of EVENT_MAPPING_RULES) {
        expect(rule.eventTypes.length).toBeGreaterThan(0);
      }
    });

    it('should have non-empty fromStates for all rules', () => {
      for (const rule of EVENT_MAPPING_RULES) {
        expect(rule.fromStates.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Idempotency', () => {
    it('should return consistent results for same event and state', () => {
      const event = createEvent({ topic: 'worker.dispatch.accepted' });

      const result1 = mapEventToTransition(event, 'allocated');
      const result2 = mapEventToTransition(event, 'allocated');

      expect(result1.matched).toBe(result2.matched);
      expect(result1.toState).toBe(result2.toState);
      expect(result1.triggerAction).toBe(result2.triggerAction);
    });

    it('should be safe to call multiple times', () => {
      const event = createEvent({ topic: 'autopilot.validation.passed' });

      // Multiple calls should not cause issues
      for (let i = 0; i < 10; i++) {
        const result = mapEventToTransition(event, 'reviewing');
        expect(result.matched).toBe(true);
        expect(result.toState).toBe('validated');
      }
    });
  });
});
