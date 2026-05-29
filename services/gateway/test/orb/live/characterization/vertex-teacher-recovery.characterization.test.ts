/**
 * VTID-03128 — Teacher-aware reconnect recovery.
 *
 * Without this branch, sendReconnectRecoveryPromptToLiveAPI sends the
 * generic VTID-02020 recovery prompt ("Sorry, we got disconnected. What
 * were you asking?"). That prompt is fine for a freeform chat session
 * but disastrous for a Teacher Mode session: Vitana was halfway through
 * offering / introducing a capability when the connection blipped, and
 * the generic prompt makes her lose the thread entirely.
 *
 * This file locks the structural contract of the new branch so a future
 * refactor cannot silently remove the Teacher-aware path:
 *   - Reads session.teacherModeContent
 *   - Branches BEFORE the generic recovery prompt is built
 *   - References the active_capability_key + active_display_name in the
 *     prompt so Gemini knows what was being taught
 *   - Tells Gemini to resume the Teacher flow, not restart it
 *   - Emits the [VTID-03128] diagnostic log so production grep can
 *     confirm the right branch fired
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let orbLiveSource: string;

beforeAll(() => {
  orbLiveSource = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
});

function extractRecoveryFn(): string {
  const startIdx = orbLiveSource.indexOf(
    'function sendReconnectRecoveryPromptToLiveAPI(',
  );
  if (startIdx === -1) {
    throw new Error('sendReconnectRecoveryPromptToLiveAPI not found in orb-live.ts');
  }
  const afterStart = orbLiveSource.slice(startIdx + 1);
  const nextFnRel = afterStart.search(/\nfunction\s+\w/);
  return nextFnRel === -1
    ? orbLiveSource.slice(startIdx)
    : orbLiveSource.slice(startIdx, startIdx + 1 + nextFnRel);
}

describe('VTID-03128: Teacher-aware reconnect recovery branch', () => {
  let fn: string;
  beforeAll(() => {
    fn = extractRecoveryFn();
  });

  it('reads session.teacherModeContent before composing the recovery prompt', () => {
    expect(fn).toMatch(/session as any\)\.teacherModeContent/);
  });

  it('Teacher branch references the active capability by display name AND key', () => {
    // Both name + key must appear so production logs / Gemini's prompt
    // have a clear identifier of what was being taught.
    expect(fn).toMatch(/teacherMode\.active_display_name/);
    expect(fn).toMatch(/teacherMode\.active_capability_key/);
  });

  it('Teacher branch tells Gemini to RESUME, not restart', () => {
    // Capture only the teacher branch (between the teacherMode guard
    // and the next `}` block boundary).
    const branchStart = fn.indexOf('teacherMode && teacherMode.active_capability_key');
    expect(branchStart).toBeGreaterThan(-1);
    const window = fn.slice(branchStart, branchStart + 4500);
    // Resume language present.
    expect(window).toMatch(/RESUME the Teacher flow/i);
    expect(window).toMatch(/Do NOT start the intro over/);
    // Don't-greet rules.
    expect(window).toMatch(/Do NOT say "Hello"/);
    expect(window).toMatch(/Do NOT restart/);
    // No generic "what would you like to talk about" trap.
    expect(window).toMatch(/Do NOT ask generic "What would you like to talk about\?"/);
  });

  it('Teacher branch emits the VTID-03128 diagnostic log + diag event', () => {
    expect(fn).toMatch(/\[VTID-03128\] Teacher-aware recovery sent/);
    expect(fn).toMatch(/recovery_mode: 'teacher_resume'/);
  });

  it('Teacher branch returns before the legacy generic recovery code runs', () => {
    // The branch must end with `return true;` so the legacy prompt
    // builder below cannot also fire and double-send.
    const branchMatch = fn.match(
      /if\s*\(teacherMode\s*&&\s*teacherMode\.active_capability_key\)\s*\{[\s\S]+?return true;\s*\n\s\s\}/,
    );
    expect(branchMatch).not.toBeNull();
  });

  it('Teacher branch sets greetingSent so stall-recovery does not re-send', () => {
    const branchStart = fn.indexOf('teacherMode && teacherMode.active_capability_key');
    const window = fn.slice(branchStart, branchStart + 4500);
    expect(window).toMatch(/session\.greetingSent\s*=\s*true/);
  });

  it('legacy VTID-02020 recovery path still exists for non-Teacher sessions', () => {
    // The generic recovery prompt MUST still be intact further down so
    // freeform chat reconnects (anonymous, non-Teacher) keep working.
    expect(fn).toMatch(/VTID-02715/);
    expect(fn).toMatch(/RECONNECT_STAGE = /);
  });
});
