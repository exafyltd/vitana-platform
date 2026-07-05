/**
 * BOOTSTRAP-OFFER-INTEGRITY — anti-regression wall for the "offer-then-fail"
 * fix (CONVERSATION_DEFECTS_FIX_PLAN.md defect 4a / Layer 1).
 *
 * Symptom fixed: Vitana proposed "let's do a breathing exercise together",
 * the user said yes, and she replied "sorry, I can't do that right now."
 * The instruction now forces a TALK / TOOL / GUIDE classification BEFORE
 * any proposal is spoken, and forbids ever refusing an offer once accepted.
 *
 * This is a source-level wall (same style as the get_social_context suite):
 * it pins that the contract text exists in the shared system-instruction
 * builder that BOTH Vertex (orb-live.ts) and LiveKit (orb-livekit.ts) call,
 * so a future edit can't silently drop it from one transport.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const INSTRUCTION_FILE = path.join(
  SRC,
  'orb',
  'live',
  'instruction',
  'live-system-instruction.ts',
);

describe('offer-integrity contract — source-level wall', () => {
  const src = fs.readFileSync(INSTRUCTION_FILE, 'utf8');

  it('declares the OFFER INTEGRITY rule', () => {
    expect(src).toContain('OFFER INTEGRITY');
  });

  it('defines all three fulfillment classes', () => {
    expect(src).toMatch(/•\s*TALK\s*—/);
    expect(src).toMatch(/•\s*TOOL\s*—/);
    expect(src).toMatch(/•\s*GUIDE\s*—/);
  });

  it('names breathing/meditation/reflection/plan-drafting as TALK-fulfillable', () => {
    const talkIdx = src.indexOf('TALK —');
    expect(talkIdx).toBeGreaterThan(-1);
    const window = src.slice(talkIdx, talkIdx + 600);
    expect(window).toContain('breathing exercise');
    expect(window).toContain('meditation');
    expect(window).toContain('reflection');
    expect(window.toLowerCase()).toContain('meal plan');
  });

  it('forbids proposing something that fits none of the three classes', () => {
    expect(src).toContain('DO NOT MAKE THE OFFER');
  });

  it('forbids refusing an already-accepted offer', () => {
    expect(src).toMatch(/NEVER respond to an accepted offer|once the user accepts an offer.*MUST fulfill/s);
    expect(src).toContain("I can't do that");
  });

  it('gives the breathing-exercise case as the canonical worked example', () => {
    expect(src).toContain('lass uns eine Atemübung machen');
    // The instruction explicitly tells the model NOT to go looking for a
    // tool for this — the phrase appears only inside that negation.
    expect(src).toContain('not by looking for a breathing-exercise tool');
  });

  it('the contract lives in the module BOTH orb-live.ts (Vertex) and orb-livekit.ts import', () => {
    const orbLive = fs.readFileSync(path.join(SRC, 'routes', 'orb-live.ts'), 'utf8');
    const orbLivekit = fs.readFileSync(path.join(SRC, 'routes', 'orb-livekit.ts'), 'utf8');
    expect(orbLive).toContain('buildLiveSystemInstruction');
    expect(orbLivekit).toContain('buildLiveSystemInstruction');
  });
});

describe('offer-integrity contract — reaches the composed instruction', () => {
  it('buildLiveSystemInstruction output carries the contract (Vertex path)', () => {
    const { buildLiveSystemInstruction } = require('../../../src/routes/orb-live');
    const instruction = buildLiveSystemInstruction(
      'de', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x',
    );
    expect(instruction).toContain('OFFER INTEGRITY');
    expect(instruction).toContain('DO NOT MAKE THE OFFER');
  });

  it('carries the contract with omitGreetingPolicy=true (LiveKit path)', () => {
    const { buildLiveSystemInstruction } = require('../../../src/routes/orb-live');
    const instruction = buildLiveSystemInstruction(
      'de', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x', true,
    );
    expect(instruction).toContain('OFFER INTEGRITY');
  });
});
