/**
 * VTID-03799 — the guided-topic lesson must play ONCE, and closing a
 * delivered lesson must credit it.
 *
 * Live-reproduced (staging, topic T005, 2026-08-31) via `oasis_events`:
 *
 *   10:20:34  guided_topic_audio_bridge_sent T005   <- lesson 1
 *   10:21:46  upstream_closed ws_session_cleanup
 *   10:21:48  guided_topic_audio_bridge_sent T005   <- lesson 2, 2s later
 *   10:22:25  upstream_closed ws_session_cleanup
 *   10:22:26  guided_topic_audio_bridge_sent T005   <- lesson 3
 *   10:23:05  greeting_sent + stamp_briefing_date_write  <- new-day greeting
 *
 * Three independent reconnect paths restore the topic from
 * `_guidedTopicInFlight`, each added by a different VTID, and NONE of them
 * consulted `_guidedTopicTeachingEnded` — which had existed since VTID-03781
 * for exactly this question. `_guidedTopicInFlight` is cleared only by
 * `_hide()`, so every close was followed ~2s later by a session that carried
 * the topic again: the lesson replayed and the overlay could not be closed.
 *
 * `end_guided_topic_teaching` never fired in the entire window, so the
 * "Well done!" drawer never opened and the step was never marked complete.
 *
 * The widget is a plain IIFE with no export surface, so these are
 * static-source checks — the same pattern as the sibling
 * `orb-widget-guided-topic-reconnect.test.ts` suite.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const WIDGET = readFileSync(
  join(__dirname, '../../src/frontend/command-hub/orb-widget.js'),
  'utf8',
);

describe('VTID-03799 guided-topic replay loop', () => {
  describe('one authority decides whether a topic may be resumed', () => {
    it('declares _shouldResumeGuidedTopic()', () => {
      expect(WIDGET).toMatch(/function _shouldResumeGuidedTopic\(\)/);
    });

    it('refuses to resume once teaching has ended', () => {
      const fn = WIDGET.slice(
        WIDGET.indexOf('function _shouldResumeGuidedTopic()'),
      ).slice(0, 700);
      expect(fn).toMatch(/if \(_s\._guidedTopicTeachingEnded\) return false;/);
    });

    it('still requires an in-flight topic that is not already armed', () => {
      const fn = WIDGET.slice(
        WIDGET.indexOf('function _shouldResumeGuidedTopic()'),
      ).slice(0, 700);
      expect(fn).toMatch(/if \(!_s\._guidedTopicInFlight\) return false;/);
      expect(fn).toMatch(/if \(_s\.guidedTopic\) return false;/);
    });
  });

  describe('every re-arm site goes through that one authority', () => {
    it('all three re-arm sites are guarded by it', () => {
      // Exactly the three restore sites: _resetAndReconnect (VTID-03770),
      // the _sessionStart send site (VTID-03774), _attemptReconnect
      // (VTID-03746). If a fourth is ever added it must use this too.
      const rearms = WIDGET.match(/_s\.guidedTopic = _s\._guidedTopicInFlight;/g) || [];
      expect(rearms).toHaveLength(3);

      const guards = WIDGET.match(/if \(_shouldResumeGuidedTopic\(\)\) \{/g) || [];
      expect(guards).toHaveLength(3);
    });

    it('no re-arm site still uses the old teaching-blind condition', () => {
      expect(WIDGET).not.toMatch(/if \(_s\._guidedTopicInFlight && !_s\.guidedTopic\) \{/);
      expect(WIDGET).not.toMatch(/if \(!_s\.guidedTopic && _s\._guidedTopicInFlight\) \{/);
    });
  });

  describe('the delivered-audio flag is not coupled to the one-shot auto-close', () => {
    it('is set on its own condition, not inside the guidedAutoClose branch', () => {
      // guidedAutoClose is cleared on the FIRST turn-complete and re-armed
      // only by a fresh tap, so anything nested inside it is a one-shot.
      // The resume flag must not be — that is what told the server "fresh
      // open" on the reconnect and replayed the whole lesson.
      expect(WIDGET).toMatch(
        /if \(_s\._guidedTopicInFlight && !_s\.greetingComplete\) \{\s*\n\s*_s\._guidedTopicAudioDelivered = true;\s*\n\s*\}/,
      );
    });

    it('the auto-close branch no longer sets it', () => {
      const idx = WIDGET.indexOf('if (_s.guidedAutoClose && !_s.greetingComplete) {');
      expect(idx).toBeGreaterThan(-1);
      const branch = WIDGET.slice(idx, idx + 400);
      expect(branch).not.toMatch(/_guidedTopicAudioDelivered = true/);
      // but it must still do its own job
      expect(branch).toMatch(/_s\.guidedAutoClose = false;/);
      expect(branch).toMatch(/_s\.guidedTopic = null;/);
    });
  });

  describe('closing a DELIVERED lesson credits it (the Well Done drawer)', () => {
    it('_hide captures a pending completion before clearing the flags', () => {
      const idx = WIDGET.indexOf('var _pendingGuidedCompletion = null;');
      expect(idx).toBeGreaterThan(-1);
      const block = WIDGET.slice(idx, idx + 700);
      // Pinned as the WHOLE condition, anchored on `if (` and `) {`, not as a
      // substring: a substring match still passes when the gate is neutered
      // (`if (false && …)`) or narrowed (`… && false)`), and a neutered gate
      // means a delivered lesson is silently never credited — the Well Done
      // drawer simply never opens, which is the user-visible half of this bug.
      // Caught by mutation C, which this assertion previously let through.
      expect(block).toMatch(
        /if \(_s\._guidedTopicInFlight && _s\._guidedTopicAudioDelivered && !_s\._guidedTopicTeachingEnded\) \{/,
      );
      // capture must happen BEFORE the clearing block, or there is nothing left to credit
      expect(idx).toBeLessThan(WIDGET.indexOf('_s._guidedTopicInFlight = null; // VTID-03746'));
    });

    it('marks teaching ended so the tool call and this path cannot double-fire', () => {
      const idx = WIDGET.indexOf('var _pendingGuidedCompletion = null;');
      const block = WIDGET.slice(idx, idx + 700);
      expect(block).toMatch(/_s\._guidedTopicTeachingEnded = true;/);
    });

    it('does NOT credit a lesson whose audio never played', () => {
      // The gate is _guidedTopicAudioDelivered — only true once turn-1 audio
      // finished. Removing it would reintroduce VTID-03784's false completion.
      const idx = WIDGET.indexOf('var _pendingGuidedCompletion = null;');
      const block = WIDGET.slice(idx, idx + 700);
      expect(block).toMatch(/_s\._guidedTopicAudioDelivered &&/);
    });

    it('fires onGuidedTopicTeachingEnd after teardown', () => {
      const idx = WIDGET.indexOf('if (_pendingGuidedCompletion && typeof _cfg.onGuidedTopicTeachingEnd');
      expect(idx).toBeGreaterThan(-1);
      const block = WIDGET.slice(idx, idx + 600);
      expect(block).toMatch(/onGuidedTopicTeachingEnd\(_completedTopicId, 'overlay_closed_after_delivery'\)/);
      // after _sessionStop/_restoreSoundscape, not mid-teardown
      expect(idx).toBeGreaterThan(WIDGET.indexOf('_restoreSoundscape();'));
      // and guarded so a throwing host handler cannot break close
      expect(block).toMatch(/catch \(e\)/);
    });
  });

  describe('pre-existing invariants still hold', () => {
    it('_endGuidedTopicTeaching still sets its flag before hiding (no double-fire)', () => {
      const idx = WIDGET.indexOf('function _endGuidedTopicTeaching(');
      const fn = WIDGET.slice(idx, idx + 1400);
      expect(fn.indexOf('_s._guidedTopicTeachingEnded = true;'))
        .toBeLessThan(fn.indexOf('_hide()'));
    });

    it('_hide still clears every guided flag', () => {
      expect(WIDGET).toMatch(/_s\.guidedTopic = null; \/\/ VTID-03675/);
      expect(WIDGET).toMatch(/_s\._guidedTopicInFlight = null; \/\/ VTID-03746/);
      expect(WIDGET).toMatch(/_s\._guidedTopicAudioDelivered = false; \/\/ VTID-03774/);
    });

    it('a fresh tap still resets teaching-ended (VTID-03781)', () => {
      expect(WIDGET).toMatch(/_s\._guidedTopicTeachingEnded = false;/);
    });
  });
});
