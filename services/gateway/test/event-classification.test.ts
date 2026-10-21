/**
 * VTID-01004: Event Classification Tests
 * VT_LAYER: DEV
 * VT_MODULE: OASIS
 *
 * Tests for the event classification system that prevents telemetry
 * from entering OASIS Events while allowing operational, decision,
 * and governance events through.
 */

import { classifyEventType, isOasisAllowed, EventClassification } from '../src/services/operator-service';

describe('VTID-01004: Event Classification', () => {
  describe('classifyEventType', () => {
    // Telemetry events (should be blocked)
    describe('telemetry classification', () => {
      const telemetryTypes = [
        'operator.heartbeat.started',
        'operator.heartbeat.stopped',
        'operator.heartbeat.snapshot',
        'operator.heartbeat',
        'gateway.health.ping',
        'system.keepalive',
        'diagnostics.metrics',
        'diagnostics.health',
      ];

      telemetryTypes.forEach((eventType) => {
        it(`should classify "${eventType}" as telemetry`, () => {
          expect(classifyEventType(eventType)).toBe('telemetry');
        });
      });
    });

    // Governance events
    describe('governance classification', () => {
      const governanceTypes = [
        'governance.deploy.blocked',
        'governance.deploy.allowed',
        'governance.evaluation',
        'governance.rule.created',
        'governance.rule.updated',
        'governance.violated',
      ];

      governanceTypes.forEach((eventType) => {
        it(`should classify "${eventType}" as governance`, () => {
          expect(classifyEventType(eventType)).toBe('governance');
        });
      });
    });

    // Decision events
    describe('decision classification', () => {
      const decisionTypes = [
        'cicd.approval.approved',
        'cicd.approval.rejected',
        'cicd.merge.blocked',
        'autopilot.validation.completed',
        'deploy.decision.made',
      ];

      decisionTypes.forEach((eventType) => {
        it(`should classify "${eventType}" as decision`, () => {
          expect(classifyEventType(eventType)).toBe('decision');
        });
      });
    });

    // Operational events (default)
    describe('operational classification', () => {
      const operationalTypes = [
        'operator.chat.message',
        'operator.upload',
        'deploy.gateway.success',
        'deploy.gateway.failed',
        'cicd.deploy.started',
        'cicd.merge.success',
        'autopilot.task.spec.created',
        'autopilot.plan.created',
        'autopilot.work.started',
        'autopilot.work.completed',
      ];

      operationalTypes.forEach((eventType) => {
        it(`should classify "${eventType}" as operational`, () => {
          expect(classifyEventType(eventType)).toBe('operational');
        });
      });
    });
  });

  describe('isOasisAllowed', () => {
    // Telemetry should be blocked
    it('should block operator.heartbeat.snapshot from OASIS', () => {
      expect(isOasisAllowed('operator.heartbeat.snapshot')).toBe(false);
    });

    it('should block operator.heartbeat.started from OASIS', () => {
      expect(isOasisAllowed('operator.heartbeat.started')).toBe(false);
    });

    it('should block operator.heartbeat.stopped from OASIS', () => {
      expect(isOasisAllowed('operator.heartbeat.stopped')).toBe(false);
    });

    it('should block gateway.health.ping from OASIS', () => {
      expect(isOasisAllowed('gateway.health.ping')).toBe(false);
    });

    it('should block diagnostics.metrics from OASIS', () => {
      expect(isOasisAllowed('diagnostics.metrics')).toBe(false);
    });

    // Operational should be allowed
    it('should allow operator.chat.message to OASIS', () => {
      expect(isOasisAllowed('operator.chat.message')).toBe(true);
    });

    it('should allow deploy.gateway.success to OASIS', () => {
      expect(isOasisAllowed('deploy.gateway.success')).toBe(true);
    });

    it('should allow cicd.deploy.started to OASIS', () => {
      expect(isOasisAllowed('cicd.deploy.started')).toBe(true);
    });

    // Governance should be allowed
    it('should allow governance.deploy.blocked to OASIS', () => {
      expect(isOasisAllowed('governance.deploy.blocked')).toBe(true);
    });

    it('should allow governance.evaluation to OASIS', () => {
      expect(isOasisAllowed('governance.evaluation')).toBe(true);
    });

    // Decision should be allowed
    it('should allow cicd.approval.approved to OASIS', () => {
      expect(isOasisAllowed('cicd.approval.approved')).toBe(true);
    });

    it('should allow autopilot.validation.completed to OASIS', () => {
      expect(isOasisAllowed('autopilot.validation.completed')).toBe(true);
    });
  });

  describe('OASIS Events Protection', () => {
    it('should ensure heartbeat never enters OASIS', () => {
      const heartbeatTypes = [
        'operator.heartbeat',
        'operator.heartbeat.started',
        'operator.heartbeat.stopped',
        'operator.heartbeat.snapshot',
      ];

      heartbeatTypes.forEach((type) => {
        expect(isOasisAllowed(type)).toBe(false);
        expect(classifyEventType(type)).toBe('telemetry');
      });
    });

    it('should ensure real operational events still enter OASIS', () => {
      const operationalTypes = [
        'deploy.gateway.success',
        'cicd.merge.success',
        'operator.chat.message',
        'autopilot.task.spec.created',
      ];

      operationalTypes.forEach((type) => {
        expect(isOasisAllowed(type)).toBe(true);
        expect(classifyEventType(type)).not.toBe('telemetry');
      });
    });
  });
});
