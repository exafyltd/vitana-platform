/**
 * VTID-03634 — a server-internal Nova retry must not permanently silence a
 * user who has heard NOTHING yet.
 *
 * Live report: "not even connecting... then listening mode but not
 * listening at all" — every attempt. Root cause traced through real prod
 * telemetry (session live-a9dceaac...): the FIRST Nova connection attempt
 * gets blocked by Bedrock's content filter on the full system instruction
 * (`nova_validation`, ~9000 input tokens), the existing VTID-03557 retry
 * mechanism correctly reconnects Nova, but `attemptTransparentReconnect()`
 * bumps `_reconnectCount` BEFORE `resendGreetingIfStuckAtZeroTurns()` asks
 * `sendGreetingPromptToLiveAPI()` to speak again — and that function's
 * `decideOpening()` call reads `isReconnect: _reconnectCount > 0` and
 * returns `{mode:'silent', source:'reconnect_no_handle'}` (opening-
 * contract.ts's deliberate "a reconnect must not re-greet" rule). That rule
 * is correct for a genuine mid-conversation transport hiccup — it is wrong
 * here, because the user's FIRST attempt died before any audio ever
 * reached them (turn_count===0, greetingSent was true only because the
 * prompt was dispatched to the dead connection). Confirmed live:
 * `wake_opener: silent_reconnect`, `prompt_len: 0`, followed ~2s later by
 * `client_disconnect` — the user gave up on what looked like dead silence.
 *
 * Fix: a one-shot `_freshOpenAfterZeroTurnRecovery` flag, set only by
 * `resendGreetingIfStuckAtZeroTurns` (which already gates on
 * `turn_count === 0`, i.e. "the user has heard nothing"), makes the
 * recomputed opening decision treat this resend as a FRESH open rather
 * than a silenced reconnect — without touching `_reconnectCount` itself
 * (still used for MAX_RECONNECTS elsewhere).
 *
 * This file is a source characterization test, matching this codebase's
 * established pattern for orb-live.ts (too large/stateful to unit-test the
 * WebSocket harness directly — see vertex-wake-opener-v2.characterization
 * .test.ts and no-hardcoded-spoken-wording.test.ts for the same shape).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLive = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

describe('VTID-03634 — zero-turn-recovery resend is never silenced as a reconnect', () => {
  it('resendGreetingIfStuckAtZeroTurns sets the fresh-open override before resending', () => {
    const fnStart = orbLive.indexOf('function resendGreetingIfStuckAtZeroTurns');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = orbLive.indexOf('\n}', fnStart);
    const fnBody = orbLive.slice(fnStart, fnEnd);

    expect(fnBody).toMatch(/_freshOpenAfterZeroTurnRecovery\s*=\s*true/);

    // The flag must be set BEFORE the resend call, not after — setting it
    // after would have no effect on the decideOpening() call the resend
    // triggers synchronously.
    const flagIdx = fnBody.indexOf('_freshOpenAfterZeroTurnRecovery');
    const resendIdx = fnBody.indexOf('sendGreetingPromptToLiveAPI(session.upstreamWs, session)');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(resendIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(resendIdx);
  });

  it('the sync opening decision honours the fresh-open override and clears it (one-shot)', () => {
    const marker = '_freshOpenAfterZeroTurnRecovery = (session as any)._freshOpenAfterZeroTurnRecovery === true;';
    const idx = orbLive.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);

    // One-shot: immediately reset so a genuine SUBSEQUENT reconnect (one the
    // user actually experienced mid-conversation) is not also silenced.
    expect(orbLive).toMatch(/\(session as any\)\._freshOpenAfterZeroTurnRecovery = false;/);

    // isReconnect must be suppressed by the override, not just logged.
    const openDecisionStart = orbLive.indexOf('const _openDecision = decideOpening({', idx);
    expect(openDecisionStart).toBeGreaterThan(-1);
    const openDecisionBlock = orbLive.slice(openDecisionStart, openDecisionStart + 400);
    expect(openDecisionBlock).toMatch(
      /isReconnect:\s*!_freshOpenAfterZeroTurnRecovery\s*&&\s*\(\(session as any\)\._reconnectCount \|\| 0\) > 0/,
    );
  });

  it('_reconnectCount itself is untouched by the override (still used for MAX_RECONNECTS)', () => {
    // The fix must not zero or reset _reconnectCount — only the isReconnect
    // input to decideOpening changes. MAX_RECONNECTS enforcement in
    // attemptTransparentReconnect must keep seeing the real count.
    expect(orbLive).toMatch(/if \(reconnectCount >= MAX_RECONNECTS\)/);
    expect(orbLive).toMatch(/\(session as any\)\._reconnectCount = reconnectCount \+ 1;/);
  });
});

describe('VTID-03635 — the SAME override also disables rung 9 (silenced_on_cadence)', () => {
  // Live confirmation right after VTID-03634 shipped: wake_opener moved from
  // silent_reconnect to silenced_on_cadence for the identical zero-turn user —
  // a second, independent silencing mechanism fed by voiceWakeBriefReason
  // (computed from the wake-brief provider's own cadence verdict, untouched by
  // the isReconnect override alone). Both must be disabled by the same
  // one-shot flag for a zero-turn-recovery resend to actually speak.
  it('silenceOnSkipEnabled is gated by the same _freshOpenAfterZeroTurnRecovery flag', () => {
    expect(orbLive).toMatch(
      /silenceOnSkipEnabled:\s*\n?\s*!_freshOpenAfterZeroTurnRecovery && process\.env\.ORB_GREETING_SILENCE_ON_SKIP_ENABLED !== 'false',/,
    );
  });

  it('the flag capture happens before the reset, so both use sites read the SAME value', () => {
    // _freshOpenAfterZeroTurnRecovery must be a local const captured once
    // (before the one-shot reset), not re-read from the session a second time
    // — re-reading after the reset would always see false at the second site.
    const declIdx = orbLive.indexOf(
      "const _freshOpenAfterZeroTurnRecovery = (session as any)._freshOpenAfterZeroTurnRecovery === true;",
    );
    const resetIdx = orbLive.indexOf('(session as any)._freshOpenAfterZeroTurnRecovery = false;');
    const cadenceUseIdx = orbLive.indexOf('!_freshOpenAfterZeroTurnRecovery && process.env.ORB_GREETING_SILENCE_ON_SKIP_ENABLED');
    expect(declIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(-1);
    expect(cadenceUseIdx).toBeGreaterThan(-1);
    expect(declIdx).toBeLessThan(resetIdx);
    expect(resetIdx).toBeLessThan(cadenceUseIdx);
  });
});
