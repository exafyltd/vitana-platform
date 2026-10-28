/**
 * VTID-03687 — the zero-turn-recovery override (VTID-03634) must also fire
 * when the greeting was NEVER dispatched, not only when it was dispatched
 * to a connection that then died.
 *
 * VTID-03634's fix gated `resendGreetingIfStuckAtZeroTurns` on
 * `session.turn_count === 0 && session.greetingSent` — correct for the
 * incident it fixed, where Nova's content filter rejected the FULL system
 * instruction only after the greeting prompt had already been dispatched to
 * that (now-dead) connection, so greetingSent was true by the time the
 * retry fired.
 *
 * Reproduced live 2026-08-20 via a real WS session against staging (topics
 * T254 and T252, 4/4 attempts): nova_validation rejected the connection
 * during Nova's OWN setup/validation phase — `greeting_sent: false` on both
 * upstream_error diag events, meaning sendGreetingPromptToLiveAPI was never
 * even reached. The old guard's `&& session.greetingSent` half was
 * therefore always false, the recovery override never engaged, and the
 * reconnect fell through to the default opening decision, which — because
 * this was technically the session's 2nd/3rd internal upstream attempt —
 * classified it as `isReconnect: true` and produced `wake_opener:
 * "silent_reconnect"`, `prompt_len: 0`. The user got total silence: no
 * guided-topic content, no error, nothing.
 *
 * Fix: drop the `&& session.greetingSent` condition. What actually matters
 * is `turn_count === 0` ("has this user heard anything at all") — whether a
 * PRIOR attempt happened to get far enough to flip greetingSent is not a
 * meaningful signal for whether THIS reconnect needs to speak.
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

describe('VTID-03687 — zero-turn recovery fires even when the greeting was never dispatched', () => {
  const fnBody = functionBody(orbLive, 'function resendGreetingIfStuckAtZeroTurns(');

  it('gates only on turn_count === 0, not on greetingSent', () => {
    expect(fnBody).toMatch(/if \(session\.turn_count === 0\) \{/);
    // The old, too-narrow condition must be gone.
    expect(fnBody).not.toMatch(/if \(session\.turn_count === 0 && session\.greetingSent\)/);
  });

  it('still sets the one-shot fresh-open override before resending (VTID-03634 mechanism intact)', () => {
    expect(fnBody).toMatch(/_freshOpenAfterZeroTurnRecovery\s*=\s*true/);
    const flagIdx = fnBody.indexOf('_freshOpenAfterZeroTurnRecovery');
    const resendIdx = fnBody.indexOf('sendGreetingPromptToLiveAPI(session.upstreamWs, session)');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(resendIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(resendIdx);
  });

  it('all three call sites (guided-topic fallback, same-provider retry, generic fallback) still reach this function', () => {
    expect(orbLive).toMatch(/resendGreetingIfStuckAtZeroTurns\(session, 'VTID-03647-guided-topic-fallback'\)/);
    expect(orbLive).toMatch(/resendGreetingIfStuckAtZeroTurns\(session, 'VTID-03557-retry'\)/);
    expect(orbLive).toMatch(/resendGreetingIfStuckAtZeroTurns\(session, 'VTID-03502-fallback'\)/);
  });
});
