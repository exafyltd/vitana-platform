/**
 * VTID-03685 — the "reconnecting" TTS announcement must stay silent before
 * the user has ever heard anything.
 *
 * Live report (session pair T252/T253, guided-topic taps): "First, it says
 * 'einen Moment, ich verbinde mich neu' [...] before it starts." Traced live
 * via oasis_events: BOTH sessions hit `nova_validation` on their very FIRST
 * connection attempt (turn_count still 0, nothing ever spoken), which
 * `attemptTransparentReconnect()` already treats as an ordinary reconnect —
 * sending the client a `{type:'reconnecting'}` message the widget renders as
 * a LOUD, spoken cue ("Give the user a loud, spoken cue to stop talking
 * until the connection is back", per this function's own comment). That
 * framing assumes an ongoing conversation the user needs to be told to pause
 * — there is none yet on a first-attempt failure, so the cue reads as "this
 * is already broken" before the session has even started.
 *
 * The persona-swap case already carved out this exact class of bug for a
 * different trigger ("just makes the widget speak 'Einen Moment, ich
 * verbinde mich neu' on top of her") — this extends the same suppression to
 * a session that has heard nothing at all (turn_count === 0), rather than
 * one where something is already playing.
 *
 * Source characterization test, matching this codebase's established
 * pattern for orb-live.ts (see the sibling
 * zero-turn-greeting-recovery-not-silenced.characterization.test.ts).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLive = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const openIdx = source.indexOf('{', start);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

describe('VTID-03685 — reconnecting announcement silenced when nothing has been heard yet', () => {
  const body = functionBody(orbLive, 'async function attemptTransparentReconnect(');

  it('computes a turn_count===0 signal alongside the existing persona-swap/rotation gates', () => {
    expect(body).toMatch(
      /const hasHeardNothingYet = \(session\.turn_count \|\| 0\) === 0;/,
    );
  });

  it('the reconnecting message is gated on all three suppression signals', () => {
    expect(body).toMatch(
      /if \(!isPersonaSwap && !isNovaRotation && !hasHeardNothingYet\) \{/,
    );
  });

  it('does not touch MAX_RECONNECTS / _reconnectCount bookkeeping', () => {
    // The fix must be scoped to the client-facing announcement only — the
    // reconnect attempt itself, and its budget, are unaffected.
    expect(body).toMatch(/if \(reconnectCount >= MAX_RECONNECTS\)/);
    expect(body).toMatch(/\(session as any\)\._reconnectCount = reconnectCount \+ 1;/);
  });

  it('resendGreetingIfStuckAtZeroTurns (the actual recovery) still gates on turn_count===0', () => {
    // Silencing the announcement must not silence the recovery itself.
    // VTID-03687 dropped the `&& session.greetingSent` half of this guard
    // (a content-filter block during Nova's own setup phase can kill the
    // connection before greetingSent ever flips true — see that VTID's own
    // test file for the full story) but the turn_count===0 check — "has
    // this user heard anything at all" — is still the load-bearing signal.
    const recoveryFn = functionBody(orbLive, 'function resendGreetingIfStuckAtZeroTurns(');
    expect(recoveryFn).toMatch(/if \(session\.turn_count === 0\) \{/);
  });
});
