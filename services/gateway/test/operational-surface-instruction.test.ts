/**
 * VTID-ASSISTANT-ROLES — conversation-flow pin for the operational-surface
 * instruction changes in live-system-instruction.ts.
 *
 * Pins the new flow behaviour:
 *   1. Command Hub (developer) surface: BRIEFING-FIRST OPENING protocol is
 *      emitted; community choreography (PROACTIVE LEADERSHIP RULE 0,
 *      GUIDED JOURNEY, PROACTIVE OPENER OVERRIDE) is NOT.
 *   2. Admin surface: admin_orb persona overlay applies (tenant-operations
 *      identity), plus the same briefing-first protocol.
 *   3. Community (vitanaland) surface: unchanged — community choreography
 *      present, briefing-first protocol absent. (Byte-level identity is
 *      additionally locked by the characterization snapshots.)
 *   4. The `## CURRENT BRIEFING` block injected via bootstrap context
 *      survives into the final instruction on operational surfaces.
 */

import { buildLiveSystemInstruction } from '../src/orb/live/instruction/live-system-instruction';

function build(surface: string | null, role: string, bootstrap?: string): string {
  return buildLiveSystemInstruction(
    'en',
    'neutral',
    bootstrap,
    role,
    undefined, // conversationSummary
    undefined, // conversationHistory
    false, // isReconnect
    null, // lastSessionInfo
    surface === 'command-hub' ? '/command-hub/overview' : surface === 'admin' ? '/admin/overview' : '/community',
    [],
    undefined, // clientContext
    '@tester',
    false,
    surface,
  );
}

describe('operational-surface system instruction (VTID-ASSISTANT-ROLES)', () => {
  describe('command-hub (developer) surface', () => {
    const instruction = build('command-hub', 'developer');

    it('emits the briefing-first opening protocol', () => {
      expect(instruction).toContain('BRIEFING-FIRST OPENING (OPERATIONAL SURFACE — ABSOLUTE)');
      expect(instruction).toContain('## CURRENT BRIEFING');
      expect(instruction).toContain('IMMEDIATE ATTENTION');
    });

    it('does NOT emit community choreography', () => {
      expect(instruction).not.toContain('PROACTIVE LEADERSHIP — RULE 0');
      expect(instruction).not.toContain('GUIDED JOURNEY — A COHERENT THROUGH-LINE');
      expect(instruction).not.toContain('PROACTIVE OPENER OVERRIDE');
    });

    it('speaks as the engineering co-pilot (dev_orb overlay)', () => {
      expect(instruction).toContain('engineering co-pilot');
      expect(instruction).toContain("The user's role RIGHT NOW is: DEVELOPER");
    });

    it('enforces action discipline (two-step confirm) in the protocol', () => {
      expect(instruction).toContain('ACTION DISCIPLINE');
      expect(instruction).toContain('confirm=true');
    });
  });

  describe('admin surface', () => {
    const instruction = build('admin', 'admin');

    it('applies the admin_orb persona overlay', () => {
      expect(instruction).toContain('operations co-pilot for the tenant administrator');
      expect(instruction).toContain('SCOPED TO THE ADMIN');
    });

    it('emits the briefing-first opening protocol and no community choreography', () => {
      expect(instruction).toContain('BRIEFING-FIRST OPENING (OPERATIONAL SURFACE — ABSOLUTE)');
      expect(instruction).not.toContain('PROACTIVE LEADERSHIP — RULE 0');
      expect(instruction).not.toContain('GUIDED JOURNEY — A COHERENT THROUGH-LINE');
    });
  });

  describe('community (vitanaland) surface — unchanged', () => {
    const instruction = build('vitanaland', 'community');

    it('keeps the community choreography', () => {
      expect(instruction).toContain('PROACTIVE LEADERSHIP — RULE 0');
      expect(instruction).toContain('GUIDED JOURNEY — A COHERENT THROUGH-LINE');
    });

    it('does NOT emit the operational briefing protocol', () => {
      expect(instruction).not.toContain('BRIEFING-FIRST OPENING');
    });
  });

  describe('briefing bootstrap injection', () => {
    it('the ## CURRENT BRIEFING block survives into the final instruction', () => {
      const briefingBlock = [
        '## CURRENT BRIEFING (DEVELOPER — generated at session start)',
        'STATUS: Platform is green — no critical items.',
        'RECOMMENDED NEXT STEP: check the autonomy pulse (tool: dev_get_autonomy_pulse)',
      ].join('\n');
      const instruction = build('command-hub', 'developer', briefingBlock);
      expect(instruction).toContain('## CURRENT BRIEFING (DEVELOPER — generated at session start)');
      expect(instruction).toContain('RECOMMENDED NEXT STEP: check the autonomy pulse');
    });
  });
});
