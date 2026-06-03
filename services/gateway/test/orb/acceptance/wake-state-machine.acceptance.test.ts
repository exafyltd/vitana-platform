/**
 * VTID-03253 (R9) — wake-decision state-machine acceptance gate.
 *
 * The reconciliation plan's regression contract: every turn-1 outcome must
 * trace to a defined state. This locks the CADENCE half of that machine —
 * the area we churned most this session (reconnect silence, same-day
 * greet-once, and the VTID-03226 decay-floor that fixed dragan1's silent
 * reopen). Pure decision-layer (no DB): drives the shared
 * decideWakeBriefForSession that BOTH Vertex and LiveKit call, so a pass here
 * is a pass for both transports.
 *
 * Provider-winner cases that need DB fixtures (new_day_return, teacher) and
 * the not-yet-built providers (R6 first-time-welcome, R7 goal-completion) are
 * declared as `todo` so the suite grows with the plan instead of pretending
 * coverage it doesn't have.
 */

import { decideWakeBriefForSession } from '../../../src/services/wake-brief-wiring';
import { createWakeTimelineRecorder } from '../../../src/services/wake-timeline/wake-timeline-recorder';

function recorder() {
  return createWakeTimelineRecorder({
    now: (() => { let t = 1_700_000_000_000; return () => new Date((t += 5)); })(),
    getDb: () => null,
  });
}

// Minimal driver — no supabase, so DB-backed providers (next-action, teacher,
// new-day) skip and the cadence/greeting-policy outcome is isolated.
function decide(args: Record<string, unknown>) {
  return decideWakeBriefForSession(
    { sessionId: 'acc', tenantId: 't1', userId: 'u1', lang: 'en', isReconnect: false, ...args } as never,
    { recorder: recorder() },
  );
}

describe('R9 — wake state machine (cadence half, Vertex+LiveKit shared decider)', () => {
  it('CASE: fresh authenticated open (bucket=first, no cadence) → speaks a greeting', async () => {
    const d = await decide({ bucket: 'first' });
    expect(d.selectedContinuation?.kind).toBe('wake_brief');
    expect((d.selectedContinuation?.userFacingLine.length ?? 0)).toBeGreaterThan(0);
  });

  it('CASE: transparent reconnect → SILENT (no continuation)', async () => {
    const d = await decide({ bucket: 'recent', isReconnect: true });
    expect(d.selectedContinuation).toBeNull();
  });

  it('CASE: same-day reopen, greeted <15min ago → SILENT (greet-once cap)', async () => {
    const d = await decide({
      bucket: 'recent',
      cadenceSignals: { time_since_last_greeting_today_ms: 2 * 60 * 1000 },
    });
    expect(d.selectedContinuation).toBeNull();
  });

  it('CASE (locks VTID-03226 dragan1 fix): heavy day + repeated brief_resume style, >15min → speaks a light line, NOT silence', async () => {
    const d = await decide({
      bucket: 'first',
      cadenceSignals: {
        sessions_today_count: 12,
        greeting_style_last_used: 'brief_resume',
        time_since_last_greeting_today_ms: 4 * 60 * 60 * 1000, // past the 15-min cap
      },
    });
    // The decay layer must FLOOR at a spoken line, never collapse to skip.
    expect(d.selectedContinuation).not.toBeNull();
    expect(d.selectedContinuation?.kind).toBe('wake_brief');
    expect((d.selectedContinuation?.userFacingLine.length ?? 0)).toBeGreaterThan(0);
  });

  it('CASE: locale honored (de → German line)', async () => {
    const d = await decide({ bucket: 'first', lang: 'de' });
    expect(d.selectedContinuation?.userFacingLine).toMatch(/[Hh]allo|helfen|dir/);
  });

  it('CASE: every provider invoked produces an observable result row (no silent provider)', async () => {
    const d = await decide({ bucket: 'first' });
    expect(d.sourceProviderResults.length).toBeGreaterThan(0);
    for (const r of d.sourceProviderResults) {
      expect(['returned', 'skipped', 'suppressed', 'errored']).toContain(r.status);
      if (r.status !== 'returned') expect(typeof r.reason).toBe('string');
    }
  });

  // ---- DB-fixture cases (need a supabase mock harness) — next R9 slice ----
  it.todo('CASE: new local day, on_personalized_goal → new_day_return names the goal');
  it.todo('CASE: new local day, default_finished_no_goal → new_day_return invites first goal');
  it.todo('CASE: same-day ≥15min, teacher has eligible capability → feature_discovery_teacher fires WITH content');
  it.todo('CASE: same-day, teacher exhausted → falls through to voice_wake_brief');
  // ---- Cases blocked on not-yet-built providers ----
  it.todo('CASE: first-ever session (is_first_session) → first-time-welcome (R6, not yet built)');
  it.todo('CASE: goal target_date in past → goal-completion-inquiry (R7, not yet built)');
});
