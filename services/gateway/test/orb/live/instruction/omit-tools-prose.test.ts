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

describe('BOOTSTRAP-ORB-INSTRUCTION-BUDGET: raw-WS transports always omit the prose', () => {
  // Prod incident lock: with the full catalog (683 manifest / 500+ live
  // tools), the prose block alone pushes an authenticated instruction to
  // ~49k tokens — Gemini Live closes the session with code=1007 ("user
  // system instruction has 48787 tokens") and the ORB freezes at
  // "Verbinden…". The single Vertex/AI-Studio call site in routes/orb-live.ts
  // must therefore pass omitToolsProse=true UNCONDITIONALLY (it was
  // GEMINI_LIVE_USE_API_KEY-gated, which left Vertex prod exposed). The
  // structured function_declarations in the same setup envelope keep every
  // tool callable — the prose is redundant by construction on these
  // transports (renderAvailableToolsSection reads the same declarations).
  it('routes/orb-live.ts passes omitToolsProse=true unconditionally at the raw-WS call site', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs
      .readFileSync(path.join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    // The omitGreetingPolicy/surface/omitToolsProse positional tail of the
    // buildLiveSystemInstruction call. A revert to the transport-gated flag
    // (GEMINI_LIVE_USE_API_KEY) or to `undefined` re-opens the prod outage.
    const tail = /omitGreetingPolicy[^]*?surface — unchanged[^]*?\n\s*(true|GEMINI_LIVE_USE_API_KEY|undefined|false),\n\s*\)\)\) as string/;
    const m = src.match(tail);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('true');
  });

  it('the prose drop reclaims the bulk of the authenticated instruction budget', () => {
    const withBlock = build(false);
    const withoutBlock = build(true);
    // The block is the dominant cost: dropping it must reclaim well over
    // half of the assembled instruction on a full-catalog community build.
    expect(withoutBlock.length).toBeLessThan(withBlock.length / 2);
  });
});
