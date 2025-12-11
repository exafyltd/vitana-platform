/**
 * VTID-0530: Stage Timeline Status Mapping Tests
 *
 * Tests the buildStageTimeline function with various event scenarios.
 * The function maps OASIS events to stage statuses: PENDING, RUNNING, SUCCESS, ERROR.
 */

import {
  buildStageTimeline,
  defaultStageTimeline,
  type TimelineEvent,
  type StageTimelineEntry,
  type TaskStage,
  type StageStatus,
} from '../src/lib/stage-mapping';

describe('Stage Timeline Status Mapping (VTID-0530)', () => {
  describe('defaultStageTimeline', () => {
    it('should return 4 stages all with PENDING status', () => {
      const timeline = defaultStageTimeline();

      expect(timeline).toHaveLength(4);
      expect(timeline[0]).toEqual({ stage: 'PLANNER', status: 'PENDING', startedAt: null, completedAt: null, errorAt: null });
      expect(timeline[1]).toEqual({ stage: 'WORKER', status: 'PENDING', startedAt: null, completedAt: null, errorAt: null });
      expect(timeline[2]).toEqual({ stage: 'VALIDATOR', status: 'PENDING', startedAt: null, completedAt: null, errorAt: null });
      expect(timeline[3]).toEqual({ stage: 'DEPLOY', status: 'PENDING', startedAt: null, completedAt: null, errorAt: null });
    });
  });

  describe('buildStageTimeline', () => {
    const vtid = 'VTID-0530-TEST';

    // Helper to create test events
    function createEvent(
      task_stage: TaskStage | null,
      status: string,
      opts: { vtid?: string; kind?: string; title?: string; created_at?: string } = {}
    ): TimelineEvent {
      return {
        id: Math.random().toString(36).substring(7),
        vtid: opts.vtid ?? vtid,
        task_stage,
        status,
        kind: opts.kind ?? 'test.event',
        title: opts.title ?? 'Test Event',
        created_at: opts.created_at ?? new Date().toISOString(),
      };
    }

    it('should return all PENDING when no events exist', () => {
      const timeline = buildStageTimeline([]);

      expect(timeline).toHaveLength(4);
      timeline.forEach((entry) => {
        expect(entry.status).toBe('PENDING');
      });
    });

    it('should return all PENDING for events without task_stage', () => {
      const events: TimelineEvent[] = [
        createEvent(null, 'info', { title: 'Generic event' }),
        createEvent(null, 'success', { title: 'Another event' }),
      ];

      const timeline = buildStageTimeline(events);

      expect(timeline).toHaveLength(4);
      timeline.forEach((entry) => {
        expect(entry.status).toBe('PENDING');
      });
    });

    // Scenario 1: Happy path - all 4 stages end in SUCCESS
    describe('Happy path: all stages SUCCESS', () => {
      it('should mark all 4 stages as SUCCESS when all have success events', () => {
        const baseTime = new Date('2025-12-11T10:00:00Z');
        const events: TimelineEvent[] = [
          // PLANNER events
          createEvent('PLANNER', 'running', { created_at: new Date(baseTime.getTime()).toISOString() }),
          createEvent('PLANNER', 'success', { created_at: new Date(baseTime.getTime() + 60000).toISOString() }),
          // WORKER events
          createEvent('WORKER', 'running', { created_at: new Date(baseTime.getTime() + 120000).toISOString() }),
          createEvent('WORKER', 'success', { created_at: new Date(baseTime.getTime() + 180000).toISOString() }),
          // VALIDATOR events
          createEvent('VALIDATOR', 'running', { created_at: new Date(baseTime.getTime() + 240000).toISOString() }),
          createEvent('VALIDATOR', 'success', { created_at: new Date(baseTime.getTime() + 300000).toISOString() }),
          // DEPLOY events
          createEvent('DEPLOY', 'running', { created_at: new Date(baseTime.getTime() + 360000).toISOString() }),
          createEvent('DEPLOY', 'success', { created_at: new Date(baseTime.getTime() + 420000).toISOString() }),
        ];

        const timeline = buildStageTimeline(events);

        expect(timeline).toHaveLength(4);
        expect(timeline[0].stage).toBe('PLANNER');
        expect(timeline[0].status).toBe('SUCCESS');
        expect(timeline[0].startedAt).toBeDefined();
        expect(timeline[0].completedAt).toBeDefined();

        expect(timeline[1].stage).toBe('WORKER');
        expect(timeline[1].status).toBe('SUCCESS');

        expect(timeline[2].stage).toBe('VALIDATOR');
        expect(timeline[2].status).toBe('SUCCESS');

        expect(timeline[3].stage).toBe('DEPLOY');
        expect(timeline[3].status).toBe('SUCCESS');
      });

      it('should detect SUCCESS from kind field patterns', () => {
        const events: TimelineEvent[] = [
          createEvent('PLANNER', 'info', { kind: 'planner.completed' }),
          createEvent('WORKER', 'info', { kind: 'build.finished' }),
          createEvent('VALIDATOR', 'info', { kind: 'tests.done' }),
          createEvent('DEPLOY', 'info', { kind: 'deploy.success' }),
        ];

        const timeline = buildStageTimeline(events);

        expect(timeline[0].status).toBe('SUCCESS');
        expect(timeline[1].status).toBe('SUCCESS');
        expect(timeline[2].status).toBe('SUCCESS');
        expect(timeline[3].status).toBe('SUCCESS');
      });

      it('should detect SUCCESS from title field patterns', () => {
        const events: TimelineEvent[] = [
          createEvent('PLANNER', 'info', { title: 'Planning completed successfully' }),
          createEvent('WORKER', 'info', { title: 'Build finished' }),
          createEvent('VALIDATOR', 'info', { title: 'All tests done' }),
          createEvent('DEPLOY', 'info', { title: 'Deployment success' }),
        ];

        const timeline = buildStageTimeline(events);

        expect(timeline[0].status).toBe('SUCCESS');
        expect(timeline[1].status).toBe('SUCCESS');
        expect(timeline[2].status).toBe('SUCCESS');
        expect(timeline[3].status).toBe('SUCCESS');
      });
    });

    // Scenario 2: Error path - one stage ends in ERROR, later stages remain PENDING
    describe('Error path: stage ERROR blocks later stages', () => {
      it('should mark WORKER as ERROR and later stages as PENDING', () => {
        const baseTime = new Date('2025-12-11T10:00:00Z');
        const events: TimelineEvent[] = [
          // PLANNER completes
          createEvent('PLANNER', 'running', { created_at: new Date(baseTime.getTime()).toISOString() }),
          createEvent('PLANNER', 'success', { created_at: new Date(baseTime.getTime() + 60000).toISOString() }),
          // WORKER starts but fails
          createEvent('WORKER', 'running', { created_at: new Date(baseTime.getTime() + 120000).toISOString() }),
          createEvent('WORKER', 'error', {
            created_at: new Date(baseTime.getTime() + 180000).toISOString(),
            title: 'Build failed: compilation error',
          }),
        ];

        const timeline = buildStageTimeline(events);

        expect(timeline[0].stage).toBe('PLANNER');
        expect(timeline[0].status).toBe('SUCCESS');

        expect(timeline[1].stage).toBe('WORKER');
        expect(timeline[1].status).toBe('ERROR');
        expect(timeline[1].errorAt).toBeDefined();

        expect(timeline[2].stage).toBe('VALIDATOR');
        expect(timeline[2].status).toBe('PENDING');

        expect(timeline[3].stage).toBe('DEPLOY');
        expect(timeline[3].status).toBe('PENDING');
      });

      it('should detect ERROR from status=failure', () => {
        const events: TimelineEvent[] = [
          createEvent('PLANNER', 'success'),
          createEvent('WORKER', 'failure', { title: 'Build failed' }),
        ];

        const timeline = buildStageTimeline(events);

        expect(timeline[0].status).toBe('SUCCESS');
        expect(timeline[1].status).toBe('ERROR');
      });

      it('should detect ERROR from title containing fail/error/exception', () => {
        const events: TimelineEvent[] = [
          createEvent('VALIDATOR', 'info', { title: 'Test suite failed: 3 tests' }),
        ];

        const timeline = buildStageTimeline(events);

        expect(timeline[2].status).toBe('ERROR');
        expect(timeline[2].errorAt).toBeDefined();
      });

      it('should prioritize ERROR over SUCCESS (error after success)', () => {
        const baseTime = new Date('2025-12-11T10:00:00Z');
        const events: TimelineEvent[] = [
          createEvent('WORKER', 'success', { created_at: new Date(baseTime.getTime()).toISOString() }),
          createEvent('WORKER', 'error', { created_at: new Date(baseTime.getTime() + 60000).toISOString() }),
        ];

        const timeline = buildStageTimeline(events);

        // ERROR should take priority over SUCCESS
        expect(timeline[1].status).toBe('ERROR');
      });
    });

    // Scenario 3: In-progress path - mixed SUCCESS, RUNNING, PENDING
    describe('In-progress path: mixed statuses', () => {
      it('should show PLANNER SUCCESS, WORKER RUNNING, others PENDING', () => {
        const baseTime = new Date('2025-12-11T10:00:00Z');
        const events: TimelineEvent[] = [
          // PLANNER completed
          createEvent('PLANNER', 'running', { created_at: new Date(baseTime.getTime()).toISOString() }),
          createEvent('PLANNER', 'success', { created_at: new Date(baseTime.getTime() + 60000).toISOString() }),
          // WORKER started but not completed
          createEvent('WORKER', 'running', {
            created_at: new Date(baseTime.getTime() + 120000).toISOString(),
            kind: 'build.started',
          }),
        ];

        const timeline = buildStageTimeline(events);

        expect(timeline[0].stage).toBe('PLANNER');
        expect(timeline[0].status).toBe('SUCCESS');
        expect(timeline[0].startedAt).toBeDefined();
        expect(timeline[0].completedAt).toBeDefined();

        expect(timeline[1].stage).toBe('WORKER');
        expect(timeline[1].status).toBe('RUNNING');
        expect(timeline[1].startedAt).toBeDefined();
        expect(timeline[1].completedAt).toBeUndefined();

        expect(timeline[2].stage).toBe('VALIDATOR');
        expect(timeline[2].status).toBe('PENDING');

        expect(timeline[3].stage).toBe('DEPLOY');
        expect(timeline[3].status).toBe('PENDING');
      });

      it('should detect RUNNING from status=in_progress', () => {
        const events: TimelineEvent[] = [createEvent('VALIDATOR', 'in_progress')];

        const timeline = buildStageTimeline(events);

        expect(timeline[2].status).toBe('RUNNING');
      });

      it('should detect RUNNING from kind patterns (started, processing, executing)', () => {
        const events: TimelineEvent[] = [
          createEvent('DEPLOY', 'info', { kind: 'deploy.started' }),
        ];

        const timeline = buildStageTimeline(events);

        expect(timeline[3].status).toBe('RUNNING');
      });

      it('should mark stage as RUNNING if events exist but no completion/error', () => {
        const events: TimelineEvent[] = [
          createEvent('PLANNER', 'info', { title: 'Task received' }),
        ];

        const timeline = buildStageTimeline(events);

        // Any event without completion/error signals RUNNING
        expect(timeline[0].status).toBe('RUNNING');
      });
    });

    describe('VTID filtering', () => {
      it('should filter events by VTID when specified', () => {
        const events: TimelineEvent[] = [
          createEvent('PLANNER', 'success', { vtid: 'VTID-0530-TEST' }),
          createEvent('WORKER', 'success', { vtid: 'VTID-OTHER' }), // Different VTID
          createEvent('WORKER', 'running', { vtid: 'VTID-0530-TEST' }),
        ];

        const timeline = buildStageTimeline(events, 'VTID-0530-TEST');

        expect(timeline[0].status).toBe('SUCCESS'); // PLANNER from target VTID
        expect(timeline[1].status).toBe('RUNNING'); // WORKER from target VTID (not success from OTHER)
        expect(timeline[2].status).toBe('PENDING'); // VALIDATOR - no events
        expect(timeline[3].status).toBe('PENDING'); // DEPLOY - no events
      });
    });

    describe('Timestamp handling', () => {
      it('should use earliest event timestamp as startedAt', () => {
        const baseTime = new Date('2025-12-11T10:00:00Z');
        const events: TimelineEvent[] = [
          createEvent('PLANNER', 'info', { created_at: new Date(baseTime.getTime() + 60000).toISOString() }),
          createEvent('PLANNER', 'running', { created_at: new Date(baseTime.getTime()).toISOString() }),
          createEvent('PLANNER', 'success', { created_at: new Date(baseTime.getTime() + 120000).toISOString() }),
        ];

        const timeline = buildStageTimeline(events);

        // startedAt should be the earliest timestamp
        expect(timeline[0].startedAt).toBe(new Date(baseTime.getTime()).toISOString());
      });

      it('should capture errorAt timestamp for ERROR status', () => {
        const errorTime = '2025-12-11T10:05:00Z';
        const events: TimelineEvent[] = [
          createEvent('WORKER', 'error', { created_at: errorTime }),
        ];

        const timeline = buildStageTimeline(events);

        expect(timeline[1].status).toBe('ERROR');
        expect(timeline[1].errorAt).toBe(errorTime);
      });
    });
  });
});
