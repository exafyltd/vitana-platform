/**
 * VTID-WAKE-OPENER — structural lock for the Vertex greeting-trigger fix.
 *
 * Background:
 *   VTID-03101 fixed the race that wiped the wake-brief override block out
 *   of the system_instruction. After that fix the system prompt correctly
 *   contained the SPOKEN FIRST UTTERANCE block. But Gemini still spoke a
 *   generic "How can I help?" / "Hallo, wie kann ich helfen?" greeting on
 *   Vertex Android + desktop because `sendGreetingPromptToLiveAPI` then
 *   sent a SECOND, contradictory instruction as a `client_content` user
 *   turn AFTER setup_complete. That trigger prompt told Gemini to pick a
 *   menu entry — and being the most recent input it won over the system
 *   instruction. The Teacher line was authored into the prompt but never
 *   spoken.
 *
 *   This fix branches sendGreetingPromptToLiveAPI on the wake-brief state
 *   carried on the session:
 *     1. wakeBriefOverrideBlock set → minimal trigger that defers to the
 *        system_instruction. No menuList. No bucket switch.
 *     2. Decision exists but suppressed (B1 cadence, greeted-recently, …)
 *        → do NOT send any trigger prompt; mark greetingSent=true so the
 *        stall-recovery re-send path does not later inject the menu.
 *     3. No decision at all → legacy menu path (unchanged).
 *
 *   Three diagnostic logs (`[VTID-WAKE-OPENER]`) prove which branch fired
 *   in production: override_active, selected_line, prompt_sent.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let orbLiveSource: string;

beforeAll(() => {
  orbLiveSource = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
});

function extractSendGreetingFn(): string {
  // Capture from the function signature through to the next top-level
  // `function ` declaration so assertions are scoped only to
  // sendGreetingPromptToLiveAPI and not to other helpers in the file.
  const startIdx = orbLiveSource.indexOf(
    'function sendGreetingPromptToLiveAPI(',
  );
  if (startIdx === -1) {
    throw new Error('sendGreetingPromptToLiveAPI not found in orb-live.ts');
  }
  const afterStart = orbLiveSource.slice(startIdx + 1);
  const nextFnRel = afterStart.search(/\nfunction\s+\w/);
  return nextFnRel === -1
    ? orbLiveSource.slice(startIdx)
    : orbLiveSource.slice(startIdx, startIdx + 1 + nextFnRel);
}

describe('VTID-WAKE-OPENER: sendGreetingPromptToLiveAPI branches on wake-brief state', () => {
  let fn: string;

  beforeAll(() => {
    fn = extractSendGreetingFn();
  });

  it('reads session.wakeBriefOverrideBlock and session.wakeBriefDecision', () => {
    expect(fn).toMatch(/session as any\)\.wakeBriefOverrideBlock/);
    expect(fn).toMatch(/session as any\)\.wakeBriefDecision/);
  });

  it('defines an overrideActive guard derived from the block being a non-empty string', () => {
    expect(fn).toMatch(/overrideActive\s*=[\s\S]{0,200}wakeBriefOverrideBlock[\s\S]{0,200}length\s*>\s*0/);
  });

  it('defines a wakeBriefSuppressed guard distinct from overrideActive', () => {
    expect(fn).toMatch(/wakeBriefSuppressed\s*=/);
    // The suppressed branch must require !overrideActive so the two branches
    // are mutually exclusive — both being true would be a logic error.
    expect(fn).toMatch(/wakeBriefSuppressed\s*=[\s\S]{0,400}!overrideActive/);
  });

  it('override branch sends a minimal trigger and does NOT contain any menuList interpolation', () => {
    const overrideBranchMatch = fn.match(/if\s*\(\s*overrideActive\s*\)\s*\{[\s\S]*?\n\s\s\}/);
    expect(overrideBranchMatch).not.toBeNull();
    const overrideBranch = overrideBranchMatch![0];
    // Trigger must reference SPOKEN FIRST UTTERANCE so Gemini knows where to look.
    expect(overrideBranch).toMatch(/SPOKEN FIRST UTTERANCE/);
    // Trigger must NOT include the legacy menu phrasings.
    expect(overrideBranch).not.toMatch(/How can I help\?/);
    expect(overrideBranch).not.toMatch(/I am listening\./);
    expect(overrideBranch).not.toMatch(/What's on your mind\?/);
    expect(overrideBranch).not.toMatch(/Womit kann ich helfen\?/);
    expect(overrideBranch).not.toMatch(/Ich höre dir zu\./);
    // Trigger must NOT reference the bucket / menuList / OPENING SHAPE MATRIX
    // dispatch — those are the legacy paths whose output contradicts the override.
    expect(overrideBranch).not.toMatch(/menuList/);
    expect(overrideBranch).not.toMatch(/OPENING SHAPE MATRIX/);
    // greetingSent must be set so stall-recovery does not later re-send a legacy menu.
    expect(overrideBranch).toMatch(/session\.greetingSent\s*=\s*true/);
    // Watchdog should still arm in the override branch — we ARE waiting on the model.
    expect(overrideBranch).toMatch(/startResponseWatchdog\(/);
  });

  it('suppressed branch does NOT send any client_content prompt and does NOT arm the watchdog', () => {
    const suppressedMatch = fn.match(
      /if\s*\(\s*wakeBriefSuppressed\s*\)\s*\{[\s\S]*?\n\s\s\}/,
    );
    expect(suppressedMatch).not.toBeNull();
    const suppressedBranch = suppressedMatch![0];
    // No outgoing message in the suppressed branch.
    expect(suppressedBranch).not.toMatch(/ws\.send\(/);
    // No watchdog arming — case is silence-by-design.
    expect(suppressedBranch).not.toMatch(/startResponseWatchdog\(/);
    // Must still mark greeting as handled so it isn't re-injected later.
    expect(suppressedBranch).toMatch(/session\.greetingSent\s*=\s*true/);
    // Must log a suppression_reason so production logs prove the branch fired.
    expect(suppressedBranch).toMatch(/suppression_reason/);
  });

  it('legacy menu path remains intact when no wake-brief decision is present', () => {
    // The legacy menu must still be wired so anonymous + pre-VTID-03052
    // callers continue to receive a greeting trigger. We assert that the
    // existing prompts table is still defined inside the function.
    expect(fn).toMatch(/pick ONE of: "How can I help\?"/);
    // The legacy ws.send call site must still exist.
    expect(fn).toMatch(/ws\.send\(JSON\.stringify\(message\)\)/);
  });

  it('emits the three diagnostic [VTID-WAKE-OPENER] logs in every branch', () => {
    const logLines = fn.match(/\[VTID-WAKE-OPENER\]/g) || [];
    // Three lines per branch × three branches = 9 occurrences.
    expect(logLines.length).toBeGreaterThanOrEqual(9);
    // Each log triplet must appear: override + suppressed + selected_line + prompt_sent.
    expect(fn).toMatch(/path=vertex override_active=true/);
    expect(fn).toMatch(/path=vertex override_active=false suppressed=true/);
    expect(fn).toMatch(/path=vertex override_active=false suppressed=false/);
    expect(fn).toMatch(/prompt_sent="?\$\{?promptPreview/);
    expect(fn).toMatch(/prompt_sent=<skipped>/);
  });
});
