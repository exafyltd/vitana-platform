/**
 * VTID-03254 (R8) — cross-provider wake parity gate.
 *
 * The reconciliation plan requires the wake decision + its observability to be
 * IDENTICAL across Vertex and LiveKit. This locks three invariants so a future
 * change can't let one transport drift:
 *   1. Both transports invoke the SHARED decideWakeBriefForSession (neither
 *      forks its own wake logic).
 *   2. Both emit the SAME logWakeDecisionSnapshot observability.
 *   3. The decision + snapshot are transport-agnostic: identical inputs yield
 *      identical decisions, and the snapshot shape matches across transports.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decideWakeBriefForSession } from '../../../src/services/wake-brief-wiring';
import { createWakeTimelineRecorder } from '../../../src/services/wake-timeline/wake-timeline-recorder';
import { buildWakeDecisionSnapshot } from '../../../src/orb/live/instruction/wake-decision-snapshot';

const GW = path.resolve(__dirname, '../../../src');
const VERTEX = fs.readFileSync(path.join(GW, 'orb/live/session/live-session-controller.ts'), 'utf8');
const LIVEKIT = fs.readFileSync(path.join(GW, 'routes/orb-livekit.ts'), 'utf8');

describe('R8 — cross-provider wake parity', () => {
  describe('1. shared decider (neither transport forks wake logic)', () => {
    it('Vertex (live-session-controller) calls decideWakeBriefForSession', () => {
      expect(VERTEX).toMatch(/decideWakeBriefForSession\(/);
    });
    it('LiveKit (orb-livekit) calls decideWakeBriefForSession', () => {
      expect(LIVEKIT).toMatch(/decideWakeBriefForSession\(/);
    });
  });

  describe('2. both transports emit the wake-decision snapshot', () => {
    it('Vertex emits logWakeDecisionSnapshot', () => {
      expect(VERTEX).toMatch(/logWakeDecisionSnapshot\(/);
      expect(VERTEX).toMatch(/transport:\s*'vertex'/);
    });
    it('LiveKit emits logWakeDecisionSnapshot', () => {
      expect(LIVEKIT).toMatch(/logWakeDecisionSnapshot\(/);
      expect(LIVEKIT).toMatch(/transport:\s*'livekit'/);
    });
  });

  describe('3. transport-agnostic decision + snapshot', () => {
    function recorder() {
      return createWakeTimelineRecorder({
        now: (() => { let t = 1_700_000_000_000; return () => new Date((t += 5)); })(),
        getDb: () => null,
      });
    }

    it('identical inputs yield an identical decision (no transport-dependent branching)', async () => {
      const args = { sessionId: 's', tenantId: 't1', userId: 'u1', bucket: 'first', isReconnect: false, lang: 'en' } as never;
      const a = await decideWakeBriefForSession(args, { recorder: recorder() });
      const b = await decideWakeBriefForSession(args, { recorder: recorder() });
      expect(a.selectedContinuation?.kind).toBe(b.selectedContinuation?.kind);
      expect(a.selectedContinuation?.userFacingLine).toBe(b.selectedContinuation?.userFacingLine);
      expect(a.sourceProviderResults.map((r) => r.providerKey).sort())
        .toEqual(b.sourceProviderResults.map((r) => r.providerKey).sort());
    });

    it('the snapshot has the SAME shape on both transports for the same decision', async () => {
      const decision = await decideWakeBriefForSession(
        { sessionId: 's', tenantId: 't1', userId: 'u1', bucket: 'first', isReconnect: false, lang: 'en' } as never,
        { recorder: recorder() },
      );
      const common = {
        sessionId: 's',
        decision,
        blocks: { wakeBriefOverride: true, teacherModeContent: false, journeyGreeting: false },
        firstName: { value: 'Dragan', source: 'app_users' as const },
        lang: 'en',
      };
      const vertex = buildWakeDecisionSnapshot({ ...common, transport: 'vertex' });
      const livekit = buildWakeDecisionSnapshot({ ...common, transport: 'livekit' });
      expect(Object.keys(vertex).sort()).toEqual(Object.keys(livekit).sort());
      expect(vertex.winner).toEqual(livekit.winner);
      expect(vertex.suppression_reason).toEqual(livekit.suppression_reason);
      // Only the transport label differs.
      expect(vertex.transport).toBe('vertex');
      expect(livekit.transport).toBe('livekit');
    });
  });
});
