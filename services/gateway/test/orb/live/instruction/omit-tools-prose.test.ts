/**
 * BOOTSTRAP-AWS-STAGING-VALIDATION: omitToolsProse locks down the new 15th
 * positional param on buildLiveSystemInstruction.
 *
 * Context: the `## AVAILABLE TOOLS` prose directory duplicates every tool's
 * description as text (see live-system-instruction.ts's toolsBlock comment).
 * It exists ONLY for LiveKit (whose @function_tool decorators don't fully
 * serialize onto the wire). Vertex and AI Studio both always carry the
 * structured function_declarations, so the block is genuinely redundant on
 * those transports — and on a heavy-tool-catalog authenticated user it can
 * push the aggregate system_instruction well past 100 KB, which is what
 * caused AI Studio's Live API to close the connection with a code=1007
 * "invalid argument" on the first client_content send (setup itself is
 * accepted; see orb-live.ts's GEMINI_LIVE_USE_API_KEY call site).
 *
 * These tests lock: the block renders by default (existing Vertex/LiveKit
 * behavior, unchanged), and omitToolsProse=true removes ONLY that block while
 * leaving the rest of the prompt (identity lock, tone rules, etc.) intact.
 */

import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';

const H_TOOLS = '## AVAILABLE TOOLS';
const IDENTITY_LOCK = '=== IDENTITY LOCK ===';

/** Authenticated community-role call so renderAvailableToolsSection is non-empty. */
function build(omitToolsProse?: boolean): string {
  return buildLiveSystemInstruction(
    'en', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x',
    undefined, // omitGreetingPolicy
    undefined, // surface
    omitToolsProse,
  );
}

describe('BOOTSTRAP-AWS-STAGING-VALIDATION: omitToolsProse', () => {
  it('defaults to including the AVAILABLE TOOLS prose block (existing behavior)', () => {
    const out = build();
    expect(out).toContain(H_TOOLS);
  });

  it('explicit false still includes the block', () => {
    const out = build(false);
    expect(out).toContain(H_TOOLS);
  });

  it('true drops ONLY the AVAILABLE TOOLS block', () => {
    const withBlock = build(false);
    const withoutBlock = build(true);
    expect(withoutBlock).not.toContain(H_TOOLS);
    // Everything else is unaffected — same prompt minus the tools section.
    expect(withoutBlock).toContain(IDENTITY_LOCK);
    expect(withBlock.length).toBeGreaterThan(withoutBlock.length);
  });
});
