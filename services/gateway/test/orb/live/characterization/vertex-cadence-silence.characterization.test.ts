/**
 * VTID-03108 (Item 5) — structural lock for cadence-suppressed silence.
 *
 * When wake-brief explicitly returned `none_with_reason` AND the rolled-
 * up cause is one of the cadence-class skips emitted by greeting-policy.ts
 * (transparent reconnect, recent-turn-continues-thread, greeted-recently-
 * within-window, isReconnect, bucket=reconnect), `sendGreetingPromptToLiveAPI`
 * MUST NOT fire the legacy menu. The orb stays silent; the next turn is
 * gated on user audio.
 *
 * Audio safety carry-overs (VTID-03103 lesson):
 *   - Anonymous sessions never enter this branch.
 *   - greetingSent=true is set so stall-recovery doesn't later substitute
 *     the legacy menu.
 *   - The response watchdog is NOT armed (silence is intended).
 *   - A kill-switch env (`ORB_GREETING_SILENCE_ON_SKIP_ENABLED=false`)
 *     reverts to legacy behavior in case this introduces a regression.
 *   - The voice-wake-brief provider's `greeting_policy_skip` reason
 *     ALSO matches so the silencing works even when the rolled-up
 *     reason at the orchestrator level is the generic "all_providers_*"
 *     family.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let orbLiveSource: string;

beforeAll(() => {
  orbLiveSource = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
});

function extractSendGreetingFn(): string {
  const startIdx = orbLiveSource.indexOf('function sendGreetingPromptToLiveAPI(');
  if (startIdx === -1) {
    throw new Error('sendGreetingPromptToLiveAPI not found in orb-live.ts');
  }
  const afterStart = orbLiveSource.slice(startIdx + 1);
  const nextFnRel = afterStart.search(/\nfunction\s+\w/);
  return nextFnRel === -1
    ? orbLiveSource.slice(startIdx)
    : orbLiveSource.slice(startIdx, startIdx + 1 + nextFnRel);
}

describe('VTID-03108 Item 5: cadence-skip silences the Vertex legacy menu', () => {
  let fn: string;
  beforeAll(() => {
    fn = extractSendGreetingFn();
  });

  it('reads the ORB_GREETING_SILENCE_ON_SKIP_ENABLED kill-switch env var', () => {
    expect(fn).toMatch(/process\.env\.ORB_GREETING_SILENCE_ON_SKIP_ENABLED/);
    // Defaults to enabled when the env is NOT explicitly 'false'.
    expect(fn).toMatch(/process\.env\.ORB_GREETING_SILENCE_ON_SKIP_ENABLED\s*!==\s*'false'/);
  });

  it('whitelist mirrors greeting-policy.ts emitted skip reasons', () => {
    // These five strings are the explicit reason values
    // `decideGreetingPolicyWithEvidence` emits when policy=skip.
    expect(fn).toMatch(/'isReconnect_forces_skip'/);
    expect(fn).toMatch(/'transparent_reconnect_forces_skip'/);
    expect(fn).toMatch(/'bucket_reconnect_forces_skip'/);
    expect(fn).toMatch(/'recent_turn_continues_thread'/);
    expect(fn).toMatch(/'greeted_recently_within_window'/);
    // voice-wake-brief's coarser `greeting_policy_skip` reason also matches.
    expect(fn).toMatch(/voiceWakeBriefReason === 'greeting_policy_skip'/);
  });

  it('reads voice_wake_brief provider result reason for the source-of-truth', () => {
    expect(fn).toMatch(/sourceProviderResults/);
    expect(fn).toMatch(/providerKey === 'voice_wake_brief'/);
  });

  it('silent branch never calls ws.send AND never arms the watchdog', () => {
    // Capture the cadence-silence block (between `if (silenceOnSkipEnabled` and
    // the matching closing `}`).
    const blockStart = fn.indexOf('if (silenceOnSkipEnabled');
    expect(blockStart).toBeGreaterThan(-1);
    // We capture a generous window and stop when we hit the NAV-TIMEJOURNEY
    // comment that begins the legacy menu block.
    const blockEnd = fn.indexOf('VTID-NAV-TIMEJOURNEY', blockStart);
    const branch = fn.slice(blockStart, blockEnd > -1 ? blockEnd : blockStart + 4000);

    // No legacy ws.send — orb stays silent.
    expect(branch).not.toMatch(/ws\.send\(/);
    // No watchdog arming — silence is intended, not a stall.
    expect(branch).not.toMatch(/startResponseWatchdog\(/);
    // But greetingSent IS marked so stall-recovery doesn't later inject
    // the legacy menu.
    expect(branch).toMatch(/session\.greetingSent\s*=\s*true/);
    // Diagnostic log fires so production grep can confirm the silencing
    // happened intentionally.
    expect(branch).toMatch(/path=vertex override_active=false suppressed=true reason=cadence_skip/);
    expect(branch).toMatch(/prompt_sent=<skipped>/);
    // Diag event tagged with the new label so OASIS can count this branch.
    expect(branch).toMatch(/wake_opener:\s*'silenced_on_cadence'/);
  });

  it('anonymous sessions are NOT silenced (the anon intro must still fire)', () => {
    // The guard requires !session.isAnonymous so the landing-page anon
    // intro speech is never affected by this silencing.
    expect(fn).toMatch(/silenceOnSkipEnabled && !session\.isAnonymous/);
  });

  it('non-cadence suppressions fall through to the legacy menu (no silent-by-default)', () => {
    // The branch must require isCadenceSkip to be true. A generic
    // `all_providers_suppressed` without a cadence reason should let
    // the legacy menu fire as before — preserves audio for the
    // sessions where wake-brief was empty for any non-skip reason.
    expect(fn).toMatch(/if\s*\(isCadenceSkip\)\s*\{/);
  });
});
