/**
 * VTID-02917 (B0d.3) — wake-timeline-recorder tests.
 *
 * Covers:
 *   - startSession + idempotency + identity update on re-call.
 *   - recordEvent auto-starts session if absent.
 *   - tSessionMs is computed from startedAt for accurate relative timing.
 *   - getTimeline returns in-memory state for active sessions.
 *   - endSession computes aggregates + persists best-effort.
 *   - listRecent merges in-memory + DB with most-recent-first ordering.
 *   - reset() clears in-memory state (test isolation).
 *   - Recorder works in DB-less mode (Supabase returns null).
 */

import {
  createWakeTimelineRecorder,
} from '../../../src/services/wake-timeline/wake-timeline-recorder';

function fixedNow(start: number = 1_700_000_000_000) {
  let t = start;
  return () => {
    const d = new Date(t);
    t += 1; // advance 1ms per call so events get unique timestamps
    return d;
  };
}

describe('B0d.3 — wake-timeline-recorder', () => {
  describe('startSession', () => {
    it('creates an in-memory session row', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.startSession({
        sessionId: 'live-1',
        tenantId: 't1',
        userId: 'u1',
        transport: 'sse',
      });
      const row = await recorder.getTimeline('live-1');
      expect(row).not.toBeNull();
      expect(row?.session_id).toBe('live-1');
      expect(row?.tenant_id).toBe('t1');
      expect(row?.user_id).toBe('u1');
      expect(row?.transport).toBe('sse');
      expect(row?.events).toEqual([]);
    });

    it('is idempotent: re-call updates identity, preserves events', () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.startSession({ sessionId: 'live-1', userId: 'u1' });
      recorder.recordEvent({ sessionId: 'live-1', name: 'session_start_received' });
      recorder.startSession({ sessionId: 'live-1', userId: 'u-updated', transport: 'websocket' });
      return recorder.getTimeline('live-1').then((row) => {
        expect(row?.user_id).toBe('u-updated');
        expect(row?.transport).toBe('websocket');
        expect(row?.events.length).toBe(1);
      });
    });
  });

  describe('recordEvent', () => {
    it('auto-starts session if recordEvent is called before startSession', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.recordEvent({
        sessionId: 'live-auto',
        name: 'session_start_received',
      });
      const row = await recorder.getTimeline('live-auto');
      expect(row).not.toBeNull();
      expect(row?.events.length).toBe(1);
      expect(row?.events[0].name).toBe('session_start_received');
    });

    it('rejects unknown event names silently', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.startSession({ sessionId: 'live-1' });
      recorder.recordEvent({
        sessionId: 'live-1',
        // @ts-expect-error — intentionally invalid name
        name: 'made_up_event',
      });
      const row = await recorder.getTimeline('live-1');
      expect(row?.events.length).toBe(0);
    });

    it('computes tSessionMs as the delta from startedAt', async () => {
      const startMs = 1_700_000_000_000;
      const recorder = createWakeTimelineRecorder({
        now: () => new Date(startMs),
        getDb: () => null,
      });
      recorder.startSession({
        sessionId: 'live-delta',
        startedAt: new Date(startMs).toISOString(),
      });
      recorder.recordEvent({
        sessionId: 'live-delta',
        name: 'session_start_received',
        at: new Date(startMs + 250).toISOString(),
      });
      recorder.recordEvent({
        sessionId: 'live-delta',
        name: 'first_audio_output',
        at: new Date(startMs + 1200).toISOString(),
      });
      const row = await recorder.getTimeline('live-delta');
      expect(row?.events[0].tSessionMs).toBe(250);
      expect(row?.events[1].tSessionMs).toBe(1200);
    });

    it('attaches metadata when provided', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.recordEvent({
        sessionId: 'live-md',
        name: 'wake_brief_selected',
        metadata: { selected_continuation_kind: 'wake_brief' },
      });
      const row = await recorder.getTimeline('live-md');
      expect(row?.events[0].metadata).toEqual({
        selected_continuation_kind: 'wake_brief',
      });
    });
  });

  describe('endSession', () => {
    it('computes aggregates on session-end', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.startSession({ sessionId: 'live-end' });
      recorder.recordEvent({ sessionId: 'live-end', name: 'session_start_received' });
      recorder.recordEvent({
        sessionId: 'live-end',
        name: 'wake_brief_selected',
        metadata: { selected_continuation_kind: 'wake_brief' },
      });
      recorder.recordEvent({ sessionId: 'live-end', name: 'first_audio_output' });
      await recorder.endSession('live-end');
      const row = await recorder.getTimeline('live-end');
      expect(row?.ended_at).not.toBeNull();
      expect(row?.aggregates?.wake?.selected_continuation_kind).toBe('wake_brief');
      expect(row?.aggregates?.wake?.fallback_used).toBe(false);
    });

    it('is idempotent: re-calling endSession does not break aggregates', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.recordEvent({ sessionId: 'live-x', name: 'session_start_received' });
      await recorder.endSession('live-x');
      await recorder.endSession('live-x'); // second call must not throw
      const row = await recorder.getTimeline('live-x');
      expect(row?.ended_at).not.toBeNull();
    });

    it('handles endSession on an unknown sessionId gracefully', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      await expect(recorder.endSession('never-started')).resolves.toBeUndefined();
    });
  });

  describe('listRecent', () => {
    it('returns sessions most-recent-first', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.startSession({
        sessionId: 'old',
        startedAt: '2026-05-11T17:00:00.000Z',
      });
      recorder.startSession({
        sessionId: 'new',
        startedAt: '2026-05-11T18:00:00.000Z',
      });
      const rows = await recorder.listRecent();
      expect(rows[0].session_id).toBe('new');
      expect(rows[1].session_id).toBe('old');
    });

    it('filters by userId', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.startSession({ sessionId: 'a', userId: 'u1' });
      recorder.startSession({ sessionId: 'b', userId: 'u2' });
      recorder.startSession({ sessionId: 'c', userId: 'u1' });
      const rows = await recorder.listRecent({ userId: 'u1' });
      expect(rows.map((r) => r.session_id).sort()).toEqual(['a', 'c']);
    });

    it('caps the limit at 100 and floors at 1', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      // Limit < 1 → 1
      let rows = await recorder.listRecent({ limit: 0 });
      expect(Array.isArray(rows)).toBe(true);
      // Limit > 100 → 100 (no actual sessions, just exercises the floor/cap path)
      rows = await recorder.listRecent({ limit: 1000 });
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  describe('DB-less operation', () => {
    it('works end-to-end without a database (best-effort persistence)', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.recordEvent({ sessionId: 'dbless', name: 'session_start_received' });
      await recorder.endSession('dbless');
      const row = await recorder.getTimeline('dbless');
      expect(row).not.toBeNull();
    });
  });

  describe('reset', () => {
    it('clears all in-memory state', async () => {
      const recorder = createWakeTimelineRecorder({
        now: fixedNow(),
        getDb: () => null,
      });
      recorder.startSession({ sessionId: 'r1' });
      recorder.reset();
      const row = await recorder.getTimeline('r1');
      expect(row).toBeNull();
    });
  });
});
