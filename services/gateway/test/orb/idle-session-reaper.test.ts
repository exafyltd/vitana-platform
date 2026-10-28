/**
 * VTID-03510 — reap ORB live sessions on idle, not on age.
 *
 * `liveSessions` owns the upstream Gemini Live WebSocket, which bills per
 * second of open stream. The old sweep purged purely on `createdAt > 30min`,
 * so an abandoned session billed for the full half hour.
 *
 * Measured over 7 days (2026-08-06), 97.5% of ALL billed Live minutes were
 * `expired_ttl` sessions with avg_turns = 0.0 and avg length 32.4 min. Real
 * conversation was 12 minutes a week.
 *
 * These tests pin the boundaries. Both failure directions are expensive:
 * too aggressive cuts a user off mid-thought, too lax keeps paying for silence.
 */

import { classifyIdleSession } from '../../src/routes/orb-live';

const MIN = 60 * 1000;

// A healthy, actively-used session: young, recently active, real conversation.
const active = { ageMs: 2 * MIN, idleMs: 5_000, turnCount: 3, audioInChunks: 400 };

describe('VTID-03510 classifyIdleSession', () => {
  it('keeps an actively-used session', () => {
    expect(classifyIdleSession(active)).toBeNull();
  });

  it('keeps a brand-new session that has not spoken yet', () => {
    // A session is created with lastActivity = now. It must survive the
    // greeting and the user's first few seconds of deciding to talk.
    expect(classifyIdleSession({
      ageMs: 3_000, idleMs: 3_000, turnCount: 0, audioInChunks: 0,
    })).toBeNull();
  });

  it('reaps the measured failure: no engagement ever, idle past the budget', () => {
    // This is the 97.5% case — user opened ORB and walked away.
    expect(classifyIdleSession({
      ageMs: 6 * MIN, idleMs: 6 * MIN, turnCount: 0, audioInChunks: 0,
    })).toBe('idle_no_engagement');
  });

  it('does NOT reap an unengaged session before its budget elapses', () => {
    expect(classifyIdleSession({
      ageMs: 4 * MIN, idleMs: 4 * MIN, turnCount: 0, audioInChunks: 0,
    })).toBeNull();
  });

  it('treats inbound audio alone as engagement, even with no completed turns', () => {
    // The user is talking but no turn has closed yet. Reaping here would cut
    // someone off mid-sentence, so they get the generous budget, not the
    // 5-minute one.
    expect(classifyIdleSession({
      ageMs: 8 * MIN, idleMs: 6 * MIN, turnCount: 0, audioInChunks: 12,
    })).toBeNull();
  });

  it('reaps an engaged session only after the longer idle budget', () => {
    expect(classifyIdleSession({
      ageMs: 15 * MIN, idleMs: 9 * MIN, turnCount: 4, audioInChunks: 900,
    })).toBeNull();
    expect(classifyIdleSession({
      ageMs: 15 * MIN, idleMs: 11 * MIN, turnCount: 4, audioInChunks: 900,
    })).toBe('idle_timeout');
  });

  it('keeps the 30-minute absolute backstop under its original reason', () => {
    // Reason string is deliberately unchanged so dashboards filtering on
    // `expired_ttl` still mean what they meant before this VTID.
    expect(classifyIdleSession({
      ageMs: 31 * MIN, idleMs: 1_000, turnCount: 9, audioInChunks: 5_000,
    })).toBe('expired_ttl');
  });

  it('lets the absolute cap win over the idle reasons', () => {
    // An old AND idle session must report the backstop, not an idle reason —
    // otherwise the two buckets double-count in the cost analysis.
    expect(classifyIdleSession({
      ageMs: 45 * MIN, idleMs: 40 * MIN, turnCount: 0, audioInChunks: 0,
    })).toBe('expired_ttl');
  });

  it('does not reap on audio-out alone — a monologue to nobody still gets reaped', () => {
    // VTID-03480's signature is the model speaking while the user hears
    // nothing (audio_out climbing, audio_in flat). Keeping such a session
    // alive burns money AND hides the fault, so audio-out deliberately does
    // not count as engagement — there is no audioOutChunks input at all.
    expect(classifyIdleSession({
      ageMs: 7 * MIN, idleMs: 7 * MIN, turnCount: 0, audioInChunks: 0,
    })).toBe('idle_no_engagement');
  });
});
