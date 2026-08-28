/**
 * Vitana ORB Voice Widget — Standalone Gemini Live voice-to-voice
 * Self-contained IIFE — no external dependencies.
 *
 * ZERO-CONFIG: Just load the script. No init() call needed.
 *   <script src="https://gateway-xxx.a.run.app/command-hub/orb-widget.js"></script>
 *
 * The widget auto-detects:
 *   - gatewayUrl: from <script src> origin
 *   - authToken: from localStorage (vitana.authToken or Supabase native key)
 *   - lang: from navigator.language (server overrides with stored preference)
 *
 * Optional: call VitanaOrb.init({ ... }) to override any auto-detected value.
 *
 * VTID-WIDGET: Extracted from command-hub app.js
 */
(function (window) {
  'use strict';

  var _WIDGET_VERSION = '2026-08-25-sse-full-duplex-fix';
  console.log('[VTOrb] Widget version: ' + _WIDGET_VERSION);

  // BOOTSTRAP-NOVA-SONIC-VOICE: user live-test feedback 2026-07-28 — the
  // model's natural speaking pace reads as "too slow" in playback. Applied
  // uniformly to every streamed PCM chunk (all providers — Vertex, Nova),
  // not a provider-specific TTS parameter (neither exposes one over the
  // live bidirectional stream — Nova 2 Sonic's session/prompt-start events
  // carry no speech-rate field at all). +5% speed carries a proportional
  // pitch rise via AudioBufferSourceNode.playbackRate — the same trick
  // podcast apps use at 1.05x, imperceptible as "chipmunk" at this
  // magnitude.
  var _AUDIO_PLAYBACK_RATE = 1.05;

  // VTID-03606: German-language feedback specifically called Nova Sonic
  // voice-to-voice "too slow" even at the +5% baseline above — bump German
  // an additional 10% over normal speed (1.1x flat, not stacked on the
  // 1.05x baseline) while every other language keeps 1.05x. Read at
  // schedule-time via _currentPlaybackRate() so a language change mid-
  // session (rare, but _cfg.lang can be updated post-connect) picks up
  // immediately rather than needing a reconnect.
  var _AUDIO_PLAYBACK_RATE_DE = 1.1;

  function _currentPlaybackRate() {
    return (_cfg.lang && _cfg.lang.startsWith('de'))
      ? _AUDIO_PLAYBACK_RATE_DE
      : _AUDIO_PLAYBACK_RATE;
  }

  // VTID-03711: every PCM chunk's mime carries its ACTUAL encoding rate
  // (server-side: 'audio/pcm;rate=24000' for Nova, 'audio/pcm;rate=16000'
  // for Polly — greeting bridge, guided-topic narration, and the cascade
  // voice client all set this correctly). The playback path used to ignore
  // it entirely and hardcode 24000 into createBuffer() regardless, so any
  // 16kHz Polly audio decoded as if it were 24kHz played back at 1.5x
  // speed/pitch — a "chipmunk" voice. Falls back to 24000 (Nova's rate,
  // the historical default) only when the mime is missing or unparseable.
  function _pcmRateFromMime(mime) {
    var m = /rate=(\d+)/.exec(mime || '');
    var rate = m ? parseInt(m[1], 10) : NaN;
    return (rate > 0) ? rate : 24000;
  }

  // Prevent double-load
  if (window.VitanaOrb && window.VitanaOrb._loaded) return;

  // ============================================================
  // 1. CONFIG & STATE
  // ============================================================

  // Auto-detect gateway URL from the <script src> that loaded this file
  var _autoGw = (function () {
    try {
      var scripts = document.querySelectorAll('script[src*="orb-widget"]');
      if (scripts.length) {
        var u = new URL(scripts[scripts.length - 1].src);
        return u.origin; // e.g. https://gateway-q74ibpv6ia-uc.a.run.app
      }
    } catch (e) { /* ignore */ }
    return 'https://gateway-q74ibpv6ia-uc.a.run.app'; // hardcoded fallback
  })();

  // VTID-ANON-FIX: Check if a JWT is expired OR stale (issued > 5 min ago).
  // The 5-minute staleness rule catches tokens left behind after logout —
  // Supabase keeps valid JWTs in localStorage even after signOut.
  // This only affects auto-detect mode (landing page). Command Hub uses init()
  // with explicit tokens, which bypasses _isTokenExpired entirely.
  var TOKEN_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
  function _isTokenExpired(token) {
    try {
      var parts = token.split('.');
      if (parts.length !== 3) return true;
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      // Check actual expiry
      if (payload.exp && payload.exp * 1000 < Date.now()) return true;
      // Check staleness — if issued more than 5 min ago, treat as stale
      if (payload.iat && (Date.now() - payload.iat * 1000) > TOKEN_MAX_AGE_MS) return true;
      return false;
    } catch (e) { return true; } // Can't decode — treat as expired
  }

  // DEV-COMHU-0502 (review fix): extract the JWT subject (user id) so setAuth
  // can detect an ACCOUNT SWITCH (sub changes) versus a same-user silent
  // refresh (sub unchanged). Returns null when unparseable/absent.
  function _jwtSub(token) {
    try {
      if (!token) return null;
      var parts = token.split('.');
      if (parts.length !== 3) return null;
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload && payload.sub ? String(payload.sub) : null;
    } catch (e) { return null; }
  }

  // Auto-detect auth token from localStorage (read-only, never writes/deletes)
  // Priority: Supabase native key (managed by auth SDK) > vitana.authToken (legacy)
  var _autoToken = (function () {
    try {
      // 1. Supabase native key (Lovable — always reflects current logged-in user)
      var sbKey = Object.keys(localStorage).find(function (k) {
        return k.startsWith('sb-') && k.endsWith('-auth-token');
      });
      if (sbKey) {
        var sbData = localStorage.getItem(sbKey);
        if (sbData) {
          try {
            var parsed = JSON.parse(sbData);
            // Supabase session check: user must exist and session must not be expired
            if (!parsed.user || !parsed.user.id) {
              console.log('[VTOrb] Auto-detect: Supabase key has no user — logged out');
              return '';
            }
            if (parsed.expires_at && parsed.expires_at * 1000 < Date.now()) {
              console.log('[VTOrb] Auto-detect: Supabase session expired (expires_at)');
              return '';
            }
            var token = parsed.access_token || parsed.token || '';
            if (token && !_isTokenExpired(token)) return token;
            if (token) console.log('[VTOrb] Auto-detect: Supabase token expired — treating as anonymous');
            return '';
          } catch (_) {
            // Not JSON — might be raw token, check expiry
            if (sbData && !_isTokenExpired(sbData)) return sbData;
            return '';
          }
        }
      }
      // 2. Command Hub custom key (fallback)
      var t = localStorage.getItem('vitana.authToken');
      if (t && !_isTokenExpired(t)) return t;
    } catch (e) { /* localStorage may be blocked */ }
    return '';
  })();

  // Auto-detect language: localStorage vitana.lang > navigator.language > 'en'
  // vitana.lang is set by the Lovable language selector on all screens.
  var _autoLang = (function () {
    try {
      var stored = localStorage.getItem('vitana.lang');
      if (stored) return stored.split('-')[0];
      return (navigator.language || navigator.userLanguage || 'en').split('-')[0];
    } catch (e) { return 'en'; }
  })();

  console.log('[VTOrb] Auto-detect: token=' + (_autoToken ? 'YES(' + _autoToken.substring(0, 20) + '...)' : 'NONE') + ', lang=' + _autoLang + ', gw=' + _autoGw);

  var _cfg = {
    gw: _autoGw,       // Gateway URL — auto-detected, overridden by init()
    token: _autoToken,  // Supabase JWT — auto-detected from localStorage, overridden by init()
    lang: _autoLang,    // Language — auto-detected from browser, server resolves stored preference
    showFab: true,       // Show floating action button (false when parent app has its own trigger)
    onClose: null,       // Callback when overlay closes
    onSessionStart: null, // Callback when voice session starts
    onSessionEnd: null,   // Callback when voice session ends
    // VTID-03292 (#4): fires when a turn's audio finishes playing, with
    // { was_greeting } (true for the first turn = the teaching/opener turn).
    // The host uses this to auto-close the overlay after the guided-topic
    // teaching turn so the underlying drawer's next-step buttons are usable.
    onTurnComplete: null,
    // VTID-03471 (L-04/L-05): transport selector. 'ws' (DEFAULT since
    // VTID-03471: single bidirectional WebSocket to /api/v1/orb/live/ws —
    // one connection, JSON both ways, no per-chunk HTTP overhead, no
    // cross-instance 404 class) or 'sse' (the legacy path: SSE down +
    // one authenticated POST per 64ms audio chunk, ~15.6 requests/sec).
    //
    // Resolution order, highest first (see _useWsTransport):
    //   1. localStorage 'vtorb.transport' — 'ws'/'sse', a developer override
    //   2. the per-tab fallback latch — set when a WS start actually failed
    //   3. the server's answer from GET /api/v1/orb/live/transport
    //      (FEATURE_ORB_WS_TRANSPORT_ENV) — the operator kill switch
    //   4. this compiled default
    transport: 'ws'
  };

  var _s = {
    // Session
    sessionId: null,
    active: false,
    // VTID-03763: bumped every time a session actually starts (SSE or WS,
    // including a reconnect's fresh start) — see both `_s.active = true`
    // sites. A polling loop spawned by a PRIOR session (e.g.
    // _waitForAudioEnd's setTimeout chain) captures this value at creation
    // and bails before touching any _s.* state if it no longer matches,
    // instead of relying on `_s.active` — which the NEW session has already
    // flipped back to true by the time the stale poll's next tick fires, so
    // it can't tell "my session ended" from "a session is active" on its own.
    _sessionGeneration: 0,
    eventSource: null,
    // BOOTSTRAP-ORB-LATENCY-PHASE3: WebSocket transport handle (null on SSE)
    ws: null,

    // Audio capture (16kHz mic)
    captureCtx: null,
    captureStream: null,
    captureProcessor: null,

    // Audio playback (speaker)
    playbackCtx: null,
    audioQueue: [],
    audioPlaying: false,
    // VTID-03706: server-declared per session (see the session_started
    // handler). Default false ⇒ legacy barge-in, so an older gateway or a
    // flag-off environment behaves exactly as before.
    fullDuplex: false,
    // VTID-03706: start of the current playback burst, for the AEC warm-up
    // window in the capture handler. 0 ⇒ not currently playing.
    audioPlayStartedAt: 0,
    scheduledSources: [],
    lastScheduledEnd: 0,
    audioEndGraceTimer: null, // Grace timer to prevent audioPlaying flicker
    lastAudioEndTime: 0,     // Timestamp of last audio source end — for client-side echo cooldown

    // Barge-in / echo
    interruptPending: false,
    turnCompleteAt: 0,

    // Watchdogs
    clientWatchdogInterval: null,
    clientLastActivityAt: 0,
    // DEV-COMHU-0501 — ORB Recovery 0.1: cross-provider speaking-state watchdog.
    // lastAudioReceivedAt is stamped on every inbound audio frame (any source);
    // the watchdog clears a stuck audioPlaying when frames stop arriving AND
    // nothing is scheduled/queued, regardless of transport (Vertex SSE today,
    // LiveKit WebRTC on the community surface tomorrow).
    lastAudioReceivedAt: 0,
    speakingWatchdogInterval: null,
    stuckGuardTimer: null,
    thinkingDelayTimer: null, // Delayed thinking state — only show if response takes > 1.5s
    thinkingProgressTimer: null, // Progress updates during long thinking
    thinkingStartTime: 0,    // When thinking started — for elapsed time display
    greetingAudioReceived: false,
    greetingComplete: false,  // True after first turn_complete — mic opens only after this
    // VTID-03727 (Codex review fix): greetingComplete is deliberately reset to
    // false on every reconnect (VTID-01988 mic-restart fix, several call
    // sites) so the mic-capture gate re-arms correctly — but that makes it
    // the WRONG signal for "has this overlay session ever produced audio",
    // which _attemptReconnect's caption needs. A second/later reconnect
    // attempt within the same overlay open would otherwise show 'connecting'
    // even though the user genuinely heard Vitana speak earlier. This flag
    // is set once true and only cleared by _hide() (a real close), never by
    // any reconnect path.
    _audioEverHeardThisOpen: false,
    _audioReadySignaled: false, // DEV-COMHU-0504: audio-ready ack posted once per session

    // VTID-03469: page-level audio unlock state. _gestureUnlockInstalled guards
    // the one-time listener install; _audioUnlockedByGesture records that the
    // playback context has been STARTED from a real user gesture at least once
    // (iOS only permits later programmatic resume() after that has happened);
    // _audioBlocked is true while chunks are being dropped because the context
    // never unlocked, so the UI stops claiming Vitana is speaking.
    _gestureUnlockInstalled: false,
    _audioUnlockedByGesture: false,
    _audioBlocked: false,
    _audioBlockedTapHandler: null,

    // UI state
    voiceState: 'IDLE', // IDLE | LISTENING | THINKING | SPEAKING | MUTED
    preMuteState: null, // Remembers state before mute so we can restore correctly
    overlayVisible: false,
    liveError: null,
    _audioSendErrorLogged: false,

    // VTID-TRANSCRIPT-FIX: Transcript buffering and display
    _inputTranscriptBuffer: '',
    _outputTranscriptBuffer: '',
    _transcriptHistory: [],  // Array of { role: 'user'|'assistant', text: string }
    _reconnectCount: 0,      // Track reconnection attempts
    _isOffline: false,        // VTID-OFFLINE: Track network offline state

    // BOOTSTRAP-ORB-DISCONNECT-ALERT: loud, immediate cue when session drops
    _disconnectActive: false,        // true between _announceDisconnect and _clearDisconnect
    _disconnectReason: null,         // 'mic' | 'network' | 'connection' | 'offline'
    _preDisconnectVoiceState: null,  // voiceState captured before we force-muted for the alert
    _audioSendFailCount: 0,          // consecutive _sendAudio failures
    _audioSendFailWindowStart: 0,    // timestamp of first fail in current window

    // VTID-02034b: silent re-register budget for cross-instance 404s on
    // /live/stream/send. The gateway holds liveSessions in an in-memory
    // per-instance Map; Cloud Run round-robins, so an audio POST may land
    // on an instance that doesn't have our session and respond 404. That
    // is NOT a network outage — _handleStaleSessionInstance re-registers
    // silently up to SILENT_REREGISTER_MAX times in
    // SILENT_REREGISTER_WINDOW_MS before falling through to the real
    // disconnect alert.
    _silentReregisterCount: 0,
    _silentReregisterWindowStart: 0,
    _silentReregisterPending: false,

    // BOOTSTRAP-ORB-MODERN-RECOVERY: cached neural-voice MP3 alert clips +
    // hardened reconnect state. _alertBuffers holds AudioBuffers preloaded
    // at widget init so they play even when the network is dead.
    // _isReconnecting is distinct from _disconnectActive: an alert can be
    // up while no reconnect is currently scheduled, and vice versa.
    // _disconnectStuck means the auto-retry budget is exhausted and the
    // overlay is showing "Tap the orb to reconnect".
    _alertBuffers: {},               // clip id → AudioBuffer
    _alertBuffersLoaded: false,
    _isReconnecting: false,
    _recoveryWatchdog: null,         // VTID-01987: setInterval handle for the 5s health probe
    _bgWatchdogTimer: null,          // background/idle watchdog — see _startBackgroundWatchdog
    _disconnectStuck: false,
    // VTID-03098: user-initiated stop guard. Set true at the top of
    // _sessionStop (X button / VitanaOrb.hide() / signup-close), cleared at
    // the top of _sessionStart. While true, _announceDisconnect and
    // _resetAndReconnect both short-circuit so a spurious onerror from the
    // manually-closed EventSource (Android WebView fires it; spec is murky)
    // never spawns a fresh session in the background.
    _userInitiatedStop: false,
    // VTID-03292 (#3 X-close): hard "the user closed the overlay" flag. Unlike
    // _userInitiatedStop (which _sessionStart clears on every start, so an
    // in-flight reconnect wipes it and re-opens), this is cleared ONLY by an
    // explicit user re-open (_show). Every reconnect/session-start path checks
    // it and bails, so pressing X always tears down and nothing re-opens.
    _userRequestedClose: false,
    // VTID-03294 (#4): when true, the overlay auto-closes after the first
    // (teaching) turn finishes — set by focusGuidedTopic, one-shot.
    guidedAutoClose: false,
    // VTID-03746: remembers the guided topic for THIS overlay-open, surviving
    // past the point where the turn-complete handler nulls _s.guidedTopic
    // (which happens as soon as the FIRST turn finishes, on the assumption
    // "delivered, don't re-offer" — VTID-03675). That assumption breaks when
    // the session dies mid-lesson: live-reproduced (staging, VTID-03746) —
    // a session taught T007 for 44 real seconds (497 audio chunks), then
    // disconnected, and the reconnect had nothing to resume, falling through
    // to a generic greeting instead of continuing the SAME topic. Read only
    // by _attemptReconnect()'s retry (an unexpected-disconnect path only —
    // a clean _hide()/_sessionStop() never reaches it) to re-arm
    // _s.guidedTopic for that one retry. Cleared only by _hide(), same
    // lifecycle as guidedTopic itself.
    _guidedTopicInFlight: null,
    // VTID-03774 (Codex review follow-up on VTID-03774's own reconnect fix):
    // true once turn-1 audio (opener + narration bridge) has actually been
    // delivered for the CURRENT _guidedTopicInFlight. Distinguishes "resend
    // guided_topic_id to RESUME a lesson already in progress" from "resend
    // it because a genuine zero-turn retry never got to speak at all"
    // (VTID-03771's nova_validation case) — the server reads this as
    // guided_topic_resume and skips re-synthesizing/replaying the narration
    // audio + re-injecting the verbatim opener instruction when true, so a
    // reconnect after real teaching has happened doesn't restart the lesson
    // from the beginning. Same lifecycle as _guidedTopicInFlight: armed
    // false on a fresh tap (focusGuidedTopic), flipped true at the same
    // turn-complete point that nulls _s.guidedTopic, cleared by _hide().
    _guidedTopicAudioDelivered: false,
    // VTID-03762: wall-clock timestamp (Date.now()) of when a guided topic
    // was tapped, and the interval handle checking it. Backstop only — see
    // GUIDED_TOPIC_BACKSTOP_MS below for why this exists: the model is
    // instructed to call end_guided_topic_teaching once it's done, but
    // live staging evidence (VTID-03762 follow-up) showed the model can
    // simply never call it and drift into unrelated general conversation
    // ("Good afternoon! Glad to have you back", proposing an unrelated
    // Vitana Index plan) with no natural end. Cleared only by _hide(),
    // same lifecycle as guidedTopic/_guidedTopicInFlight.
    _guidedTopicOpenedAt: null,
    _guidedTopicBackstopInterval: null,
    // VTID-03776: counts consecutive reconnect attempts, while a guided topic
    // is in flight, that produced NO audible turn at all this overlay-open
    // (_audioEverHeardThisOpen still false). VTID-03774's own fixes made
    // guided_topic_id correctly persist and resend across every reconnect —
    // but when Nova's nova_validation content filter deterministically
    // rejects that specific topic's wake-brief opener (live-reproduced:
    // ~30 consecutive fresh sessions, ~3.4s apart, every one blocked before
    // any turn completed), every reconnect re-requests the SAME topic,
    // re-synthesizes/replays the full Polly narration, and gets blocked
    // again — an audible infinite repeat with no natural exit. See
    // _attemptReconnect() for where this increments and trips the breaker.
    // Reset on a fresh tap (focusGuidedTopic) and on close (_hide), same
    // lifecycle as _guidedTopicInFlight.
    _guidedTopicZeroAudioFailCount: 0,
    // VTID-03781: idempotency guard. Teaching-complete has TWO independent
    // signals — the model calling end_guided_topic_teaching, and the
    // GUIDED_TOPIC_BACKSTOP_MS timeout — and nothing previously stopped
    // both from firing for the same teaching session (e.g. the model calls
    // the tool right as the backstop's periodic check also trips, or the
    // directive arrives twice over a flaky transport). Each firing runs
    // _endGuidedTopicTeaching(), which drains audio then calls _hide() and
    // the onGuidedTopicTeachingEnd host callback — a second concurrent run
    // would fire that callback (-> completePractice()) a second time for
    // the same topic. Set true the instant _endGuidedTopicTeaching() is
    // entered (before any async work), so every signal after the first
    // becomes a no-op. Reset on a fresh tap (focusGuidedTopic) — a new
    // teaching session gets its own single completion — same lifecycle as
    // _guidedTopicInFlight.
    _guidedTopicTeachingEnded: false,
    // VTID-02020: contextual recovery state. _preDisconnectStage captures what
    // the user was doing when the network dropped (idle / listening_user_speaking
    // / thinking / speaking) so the backend's recovery prompt can decide
    // whether to answer / ask-to-repeat / resume. conversationId is pinned by
    // the backend on first /live/session/start and reused across reconnects.
    _preDisconnectStage: null,
    conversationId: null
  };

  // VTID-OFFLINE: Instant offline/online detection via browser events
  window.addEventListener('offline', function () {
    console.warn('[VTOrb] Browser went offline');
    _s._isOffline = true;
    if (_s.active || _s.overlayVisible) {
      _stopWatchdog();
      _announceDisconnect('offline');
    }
  });

  window.addEventListener('online', function () {
    console.log('[VTOrb] Browser back online');
    _s._isOffline = false;
    if (_s.active || _s.overlayVisible) {
      // BOOTSTRAP-ORB-MODERN-RECOVERY: a real `online` event is the strongest
      // signal we have that the user's connectivity is back. Treat it as a
      // full reset: zero the retry budget AND clear any "stuck" state so the
      // next _attemptReconnect cycle can run without inheriting a spent
      // budget from earlier offline-period failures.
      _s._reconnectCount = 0;
      _s._isReconnecting = false;
      _s._disconnectStuck = false;
      _attemptReconnect();
    }
  });

  var _root = null; // Widget DOM root
  var _fab = null;  // FAB button element

  // ============================================================
  // 2. CSS INJECTION
  // ============================================================

  function _injectStyles() {
    if (document.getElementById('vtorb-css')) {
      console.log('[VTOrb] _injectStyles: vtorb-css already exists');
      return;
    }
    console.log('[VTOrb] _injectStyles: creating vtorb-css style tag');
    var style = document.createElement('style');
    style.id = 'vtorb-css';
    style.textContent = [
      // --- FAB ---
      '.vtorb-fab {',
      '  position: fixed; bottom: 24px; right: 24px; z-index: 9000;',
      '  width: 64px; height: 64px; border-radius: 50%; border: none; cursor: pointer;',
      '  background: radial-gradient(circle at 35% 35%, #7c8db5, #5a6a8a 50%, #3a4a6a 100%);',
      '  box-shadow: 0 4px 24px rgba(90,110,150,0.5), inset 0 1px 2px rgba(255,255,255,0.15);',
      '  transition: transform 0.2s, box-shadow 0.2s;',
      '  animation: vtorb-fab-pulse 4s ease-in-out infinite;',
      '}',
      '.vtorb-fab:hover { transform: scale(1.08); box-shadow: 0 6px 32px rgba(90,110,150,0.7); }',
      '.vtorb-fab:active { transform: scale(0.95); }',
      '.vtorb-fab.vtorb-hidden { display: none; }',
      '@keyframes vtorb-fab-pulse {',
      '  0%, 100% { box-shadow: 0 4px 24px rgba(90,110,150,0.5); }',
      '  50% { box-shadow: 0 6px 36px rgba(90,110,150,0.8); }',
      '}',

      // --- Overlay ---
      '.vtorb-overlay {',
      '  position: fixed; inset: 0; z-index: 9500;',
      '  display: none; align-items: center; justify-content: center; flex-direction: column;',
      '  background: rgba(10, 12, 20, 0.92); backdrop-filter: blur(24px);',
      '}',
      '.vtorb-overlay.vtorb-visible { display: flex; }',

      // --- ORB Shell (aura wrapper) ---
      '.vtorb-shell {',
      '  position: relative; width: 50vmin; height: 50vmin; max-width: 320px; max-height: 320px;',
      '  display: flex; align-items: center; justify-content: center;',
      '}',
      '.vtorb-shell::before, .vtorb-shell::after {',
      '  content: ""; position: absolute; inset: -20%; border-radius: 50%;',
      '  opacity: 0; transition: opacity 0.6s;',
      '}',

      // -- Ready state --
      '.vtorb-shell.vtorb-st-ready::before {',
      '  background: radial-gradient(circle, rgba(20,184,166,0.5) 0%, transparent 70%);',
      '  opacity: 0.4; animation: vtorb-breathe 4s ease-in-out infinite;',
      '}',
      '@keyframes vtorb-breathe { 0%,100%{transform:scale(0.9);opacity:0.3} 50%{transform:scale(1.1);opacity:0.5} }',

      // -- Listening state --
      '.vtorb-shell.vtorb-st-listening::before {',
      '  background: radial-gradient(circle, rgba(59,130,246,0.5) 0%, transparent 70%);',
      '  opacity: 0.5; animation: vtorb-ripple 2s ease-in-out infinite;',
      '}',
      '.vtorb-shell.vtorb-st-listening::after {',
      '  background: radial-gradient(circle, rgba(59,130,246,0.3) 0%, transparent 70%);',
      '  opacity: 0.4; animation: vtorb-ripple 2s ease-in-out infinite 0.5s;',
      '}',
      '@keyframes vtorb-ripple { 0%,100%{transform:scale(0.95);opacity:0.4} 50%{transform:scale(1.15);opacity:0.6} }',

      // -- Thinking state --
      '.vtorb-shell.vtorb-st-thinking::before {',
      '  background: radial-gradient(circle, rgba(139,92,246,0.5) 0%, transparent 70%);',
      '  opacity: 0.5; animation: vtorb-swirl 3s linear infinite;',
      '}',
      '.vtorb-shell.vtorb-st-thinking::after {',
      '  background: radial-gradient(circle, rgba(139,92,246,0.3) 0%, transparent 70%);',
      '  opacity: 0.4; animation: vtorb-swirl 3s linear infinite reverse;',
      '}',
      '@keyframes vtorb-swirl { 0%{transform:rotate(0deg) scale(1)} 50%{transform:rotate(180deg) scale(1.1)} 100%{transform:rotate(360deg) scale(1)} }',

      // -- Speaking state --
      '.vtorb-shell.vtorb-st-speaking::before {',
      '  background: radial-gradient(circle, rgba(245,158,11,0.5) 0%, transparent 70%);',
      '  opacity: 0.6; animation: vtorb-pulse 1s ease-in-out infinite;',
      '}',
      '.vtorb-shell.vtorb-st-speaking::after {',
      '  background: radial-gradient(circle, rgba(245,158,11,0.3) 0%, transparent 70%);',
      '  opacity: 0.4; animation: vtorb-pulse 1s ease-in-out infinite 0.3s;',
      '}',
      '@keyframes vtorb-pulse { 0%,100%{transform:scale(0.95);opacity:0.5} 50%{transform:scale(1.2);opacity:0.7} }',

      // -- Paused (muted) state --
      '.vtorb-shell.vtorb-st-paused::before {',
      '  background: radial-gradient(circle, rgba(107,114,128,0.3) 0%, transparent 70%);',
      '  opacity: 0.3;',
      '}',

      // -- Connecting state --
      '.vtorb-shell.vtorb-st-connecting::before {',
      '  background: radial-gradient(circle, rgba(226,232,240,0.4) 0%, transparent 70%);',
      '  opacity: 0.4; animation: vtorb-fade 2s ease-in-out infinite;',
      '}',
      '@keyframes vtorb-fade { 0%,100%{opacity:0.2} 50%{opacity:0.5} }',

      // -- Error state --
      '.vtorb-shell.vtorb-st-error::before {',
      '  background: radial-gradient(circle, rgba(239,68,68,0.4) 0%, transparent 70%);',
      '  opacity: 0.5;',
      '}',

      // --- Large ORB sphere ---
      '.vtorb-large {',
      '  width: 100%; height: 100%; border-radius: 50%;',
      '  background: radial-gradient(circle at 35% 35%, #7c8db5, #5a6a8a 50%, #3a4a6a 100%);',
      '  box-shadow: inset -8px -8px 24px rgba(0,0,0,0.4), inset 4px 4px 12px rgba(255,255,255,0.08),',
      '    0 0 60px rgba(90,110,150,0.3);',
      '  position: relative;',
      '}',
      '.vtorb-large::before {',
      '  content: ""; position: absolute; width: 40%; height: 30%; top: 15%; left: 20%;',
      '  background: radial-gradient(ellipse, rgba(200,210,230,0.35), transparent 70%);',
      '  border-radius: 50%; filter: blur(6px);',
      '}',
      // Sphere state animations
      '.vtorb-large-idle { animation: vtorb-lg-idle 5s ease-in-out infinite; }',
      '.vtorb-large-thinking { animation: vtorb-lg-think 1.5s ease-in-out infinite; }',
      '.vtorb-large-listening { animation: vtorb-lg-listen 2s ease-in-out infinite; }',
      '.vtorb-large-speaking { animation: vtorb-lg-speak 1s ease-in-out infinite; }',
      '.vtorb-large-muted { opacity: 0.6; filter: grayscale(40%); }',
      '@keyframes vtorb-lg-idle { 0%,100%{transform:scale(1);box-shadow:inset -8px -8px 24px rgba(0,0,0,0.4),0 0 60px rgba(90,110,150,0.3)} 50%{transform:scale(1.02);box-shadow:inset -8px -8px 24px rgba(0,0,0,0.4),0 0 80px rgba(90,110,150,0.45)} }',
      '@keyframes vtorb-lg-think { 0%,100%{transform:scale(1)} 25%{transform:scale(1.02) translateX(2px)} 75%{transform:scale(0.98) translateX(-2px)} }',
      '@keyframes vtorb-lg-listen { 0%,100%{transform:scale(1);box-shadow:inset -8px -8px 24px rgba(0,0,0,0.4),0 0 50px rgba(59,130,246,0.25)} 50%{transform:scale(1.03);box-shadow:inset -8px -8px 24px rgba(0,0,0,0.4),0 0 80px rgba(59,130,246,0.4)} }',
      '@keyframes vtorb-lg-speak { 0%,100%{transform:scale(1)} 50%{transform:scale(1.04)} }',

      // --- Controls bar ---
      '.vtorb-controls {',
      '  display: flex; gap: 20px; margin-top: 40px; align-items: center; justify-content: center;',
      '}',
      '.vtorb-btn {',
      '  width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;',
      '  display: flex; align-items: center; justify-content: center;',
      '  transition: transform 0.15s, background 0.2s;',
      '}',
      '.vtorb-btn:hover { transform: scale(1.08); }',
      '.vtorb-btn:active { transform: scale(0.95); }',
      '.vtorb-btn svg { width: 24px; height: 24px; }',
      '.vtorb-btn-mic {',
      '  background: rgba(59,130,246,0.2); color: #93c5fd;',
      '}',
      '.vtorb-btn-mic.vtorb-muted {',
      '  background: rgba(239,68,68,0.2); color: #fca5a5;',
      '}',
      // VTID-03745: the .vtorb-mic-live class (still toggled by full-duplex
      // state, see _updateUI) intentionally carries no visual style any
      // more — the ring it used to draw around the mic button while Vitana
      // spoke was reported as an unwanted visual distraction.
      '.vtorb-btn-close {',
      '  background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7);',
      '}',
      '.vtorb-btn-close:hover { background: rgba(239,68,68,0.3); color: #fca5a5; }',

      // --- Status text ---
      // BOOTSTRAP-ORB-CAPTION-I18N: bumped 14px->17px (min-height 20px->24px
      // to match) for legibility — there's a lot of empty space around the
      // orb on mobile. Deliberately NOT overridden inside the @media block
      // below: the inline cssText set once in _renderOverlay() has higher
      // specificity than any stylesheet rule, including a media-scoped one,
      // and is never updated afterward, so a mobile-only override here would
      // silently never apply. One shared value covers mobile and desktop.
      '.vtorb-status {',
      '  margin-top: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-size: 19px; color: rgba(255,255,255,0.6); text-align: center;',
      '  min-height: 26px; transition: opacity 0.3s;',
      '}',
      '.vtorb-status.vtorb-status-listening { color: rgba(59,130,246,0.8); }',
      '.vtorb-status.vtorb-status-thinking { color: rgba(139,92,246,0.8); }',
      '.vtorb-status.vtorb-status-speaking { color: rgba(245,158,11,0.8); }',
      '.vtorb-status.vtorb-status-error { color: rgba(239,68,68,0.8); }',

      // --- Mobile responsive ---
      '@media (max-width: 600px) {',
      '  .vtorb-shell { width: 60vmin; height: 60vmin; max-width: 260px; max-height: 260px; }',
      '  .vtorb-fab { width: 56px; height: 56px; bottom: 20px; right: 20px; }',
      '  .vtorb-btn { width: 48px; height: 48px; }',
      '  .vtorb-btn svg { width: 20px; height: 20px; }',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ============================================================
  // 3. ICONS (only what we need)
  // ============================================================

  var _ICONS = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
  };

  // ============================================================
  // 4. AUDIO FEEDBACK
  // ============================================================

  function _playChime(ctx) {
    if (!ctx || ctx.state === 'closed') return;
    try {
      var now = ctx.currentTime;
      var g = ctx.createGain();
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.15, now + 0.02);
      g.gain.setValueAtTime(0.15, now + 0.08);
      g.gain.linearRampToValueAtTime(0.0, now + 0.15);
      g.gain.linearRampToValueAtTime(0.15, now + 0.15);
      g.gain.setValueAtTime(0.15, now + 0.25);
      g.gain.linearRampToValueAtTime(0.0, now + 0.40);
      var o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.setValueAtTime(523.25, now);
      o1.connect(g); o1.start(now); o1.stop(now + 0.15);
      var o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.setValueAtTime(659.25, now + 0.15);
      o2.connect(g); o2.start(now + 0.15); o2.stop(now + 0.40);
    } catch (e) { /* ignore */ }
  }

  function _playReadyBeep() {
    try {
      var ctx = _s.playbackCtx;
      if (!ctx || ctx.state === 'closed') return;
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 800;
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
      o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.2);
    } catch (e) { /* ignore */ }
  }

  function _playErrorTone() {
    try {
      var ctx = _s.playbackCtx;
      if (!ctx || ctx.state === 'closed') return;
      var now = ctx.currentTime;
      var g1 = ctx.createGain(); g1.connect(ctx.destination);
      g1.gain.setValueAtTime(0, now); g1.gain.linearRampToValueAtTime(0.12, now + 0.03); g1.gain.linearRampToValueAtTime(0, now + 0.2);
      var o1 = ctx.createOscillator(); o1.frequency.value = 500; o1.connect(g1); o1.start(now); o1.stop(now + 0.2);
      var g2 = ctx.createGain(); g2.connect(ctx.destination);
      g2.gain.setValueAtTime(0, now + 0.25); g2.gain.linearRampToValueAtTime(0.12, now + 0.28); g2.gain.linearRampToValueAtTime(0, now + 0.5);
      var o2 = ctx.createOscillator(); o2.frequency.value = 350; o2.connect(g2); o2.start(now + 0.25); o2.stop(now + 0.5);
    } catch (e) { /* ignore */ }
  }

  // VTID-02710: Keep playbackCtx warm during the 2-5s wait between session
  // start and first Gemini audio chunk. iOS Safari/WKWebView auto-suspends an
  // idle AudioContext after a few hundred ms of silence, and ctx.resume()
  // outside a user gesture is unreliable on iOS — chunks drop into a dead
  // queue (line ~810 in _processQueue) and the user hears nothing through the
  // entire greeting. A looping inaudible BufferSource counts as "audio
  // playing" to iOS, so the ctx stays in the running state until the first
  // real chunk arrives. Caller is responsible for stopping it (on first
  // audio_out chunk and on session teardown).
  function _startCtxKeepAlive() {
    var ctx = _s.playbackCtx;
    if (!ctx || ctx.state === 'closed') return;
    if (_s._ctxKeepAliveSrc) return;
    try {
      var buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.5)), ctx.sampleRate);
      var src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(ctx.destination);
      src.start(0);
      _s._ctxKeepAliveSrc = src;
    } catch (e) {
      console.warn('[VTOrb] _startCtxKeepAlive failed:', e && e.message);
    }
  }

  function _stopCtxKeepAlive() {
    var src = _s._ctxKeepAliveSrc;
    if (!src) return;
    try { src.stop(0); src.disconnect(); } catch (e) { /* ignore */ }
    _s._ctxKeepAliveSrc = null;
  }

  // ============================================================
  // 4a-bis. PAGE-LEVEL FIRST-GESTURE AUDIO UNLOCK (VTID-03469)
  // ============================================================
  //
  // Until this existed, the ONLY place the playback AudioContext was unlocked
  // was inside _sessionStart(), which works only when _sessionStart is reached
  // synchronously from a real user gesture (the FAB tap path:
  // click → _show() → _sessionStart(), no await in between).
  //
  // The host does NOT always get there from a tap. vitana-v1's voice-first
  // front door (useOrbFrontDoor) calls VitanaOrb.show() from a React useEffect
  // right after login — zero user activation. On iPhone (Safari / WKWebView /
  // Appilix) that context is created suspended, resume() outside a gesture is
  // refused, _processQueue burns its 3s retry budget and DROPS the greeting,
  // and yet the overlay still reads "Vitana spricht..." because the SPEAKING
  // state is set when an audio_out message ARRIVES, not when it plays. Net
  // effect reported from the field: "after login the orb shows Vitana talking
  // but there is no speech; close it, start a new session, and audio works" —
  // the second session works precisely because that one came from a tap.
  //
  // Fix: arm the context on the FIRST user interaction anywhere on the page,
  // long before the front door fires. A password login is itself a tap in this
  // same document, so by the time the overlay auto-opens the context has
  // already been started once and later resume() calls are permitted.
  //
  // Note _preloadAlertClips() (called from init()) already creates
  // _s.playbackCtx outside any gesture, so the context usually EXISTS and is
  // merely suspended — the 1-sample silent buffer + resume() below is what
  // actually starts it. Re-running on every gesture is deliberate and cheap:
  // it also re-arms the context after an iOS auto-suspend.
  var _GESTURE_EVENTS = ['pointerdown', 'touchend', 'mousedown', 'keydown'];

  function _unlockPlaybackCtxFromGesture() {
    try {
      if (!_s.playbackCtx || _s.playbackCtx.state === 'closed') {
        _s.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      var ctx = _s.playbackCtx;
      // A 1-sample silent buffer is the canonical WebKit unlock: starting a
      // BufferSource inside the gesture is what flips the context out of the
      // "never started" state. resume() alone is not reliable on iOS.
      var buf = ctx.createBuffer(1, 1, 22050);
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      if (ctx.state === 'suspended' && ctx.resume) {
        ctx.resume().then(function () {
          if (!_s._audioUnlockedByGesture) {
            _s._audioUnlockedByGesture = true;
            console.log('[VTOrb] playback AudioContext unlocked by user gesture');
          }
        }).catch(function (e) {
          console.warn('[VTOrb] gesture unlock resume rejected:', e && e.message);
        });
      } else if (ctx.state === 'running') {
        _s._audioUnlockedByGesture = true;
      }
    } catch (e) {
      console.warn('[VTOrb] gesture unlock failed:', e && e.message);
    }
  }

  // Installed once at script load — NOT at init() — so a tap on the login
  // screen counts even though init() only runs once auth has resolved.
  // Listeners stay attached for the lifetime of the page (capture phase,
  // passive where allowed) so every gesture re-arms the context; the handler
  // is a no-op-cheap resume once the context is already running.
  function _installGestureAudioUnlock() {
    if (_s._gestureUnlockInstalled) return;
    _s._gestureUnlockInstalled = true;
    var handler = function () {
      // Already running and previously gesture-started → nothing to do.
      if (_s._audioUnlockedByGesture && _s.playbackCtx && _s.playbackCtx.state === 'running') return;
      _unlockPlaybackCtxFromGesture();
    };
    _GESTURE_EVENTS.forEach(function (evt) {
      try {
        document.addEventListener(evt, handler, { capture: true, passive: true });
      } catch (e) {
        // Older WebViews without options-object support.
        document.addEventListener(evt, handler, true);
      }
    });
  }

  // VTID-03469: the context never unlocked and we are throwing chunks away.
  // Replace the false "Vitana spricht..." with the truth plus the single
  // gesture that repairs it. Any tap re-enters _unlockPlaybackCtxFromGesture
  // via the page-level listener above; this extra one-shot handler exists to
  // drain the pipeline and restore the UI in the same turn.
  function _announceAudioBlocked() {
    if (_s._audioBlocked) return;
    _s._audioBlocked = true;
    _setOrbState('paused');
    _setStatus(_caption('tapToHear'));
    _updateUI();
    var onTap = function () {
      _unlockPlaybackCtxFromGesture();
      // Give the resume() promise a tick, then re-enter the pipeline.
      setTimeout(function () {
        _clearAudioBlocked();
        _signalAudioReady();
        _processQueue();
      }, 0);
    };
    _s._audioBlockedTapHandler = onTap;
    try {
      document.addEventListener('pointerdown', onTap, { capture: true, passive: true, once: true });
    } catch (e) {
      document.addEventListener('pointerdown', onTap, true);
    }
  }

  function _clearAudioBlocked(skipUi) {
    if (!_s._audioBlocked) return;
    _s._audioBlocked = false;
    var h = _s._audioBlockedTapHandler;
    if (h) {
      try { document.removeEventListener('pointerdown', h, true); } catch (e) { /* ignore */ }
      _s._audioBlockedTapHandler = null;
    }
    if (skipUi) return; // teardown path — _show() will paint the next state
    // voiceState was never changed by _announceAudioBlocked (only the visual
    // state was), so it still describes where the session actually is.
    var st = (_s.voiceState || 'LISTENING').toLowerCase();
    if (st === 'muted') return; // mute owns the display
    _setOrbState(st === 'speaking' ? 'speaking' : 'listening');
    if (st === 'speaking') {
      _setStatus(_caption('speaking'));
    } else {
      _setStatus(_caption('listening'));
    }
    _updateUI();
  }

  // ============================================================
  // 4b. DISCONNECT ALERT (BOOTSTRAP-ORB-DISCONNECT-ALERT
  //                       + BOOTSTRAP-ORB-MODERN-RECOVERY)
  //
  // When a session silently drops (mic denied, SSE closed, upstream WS dead,
  // network blip), the UI used to keep showing "Listening..." while the user
  // talked into a void. _announceDisconnect gives them an immediate, unmissable
  // cue — tone + spoken phrase + visual state + mic gate — so they stop talking.
  // _clearDisconnect reverses it on successful reconnect and speaks a short
  // "we're back" phrase so the user knows it's safe to continue.
  //
  // The phrases are pre-rendered MP3 clips in Chirp3-HD voices (modern neural
  // family — same one vitana-v1 uses for non-Live TTS). They're eagerly
  // preloaded into AudioBuffers when the widget initializes, so they play
  // instantly even when the network is dead. We deliberately do NOT fall back
  // to window.speechSynthesis: the OS default robotic voice (Hazel/David/etc)
  // is worse than silence, so missing-clip means tone + visible status only.
  // ============================================================

  // BOOTSTRAP-ORB-CAPTION-I18N: the visible .vtorb-status caption used to
  // only ever localize to German or English (every call site branched on
  // _cfg.lang.startsWith('de') ? de : en), even though _cfg.lang legitimately
  // carries any of the gateway's supported locales (services/gateway/src/
  // i18n/catalog.ts GATEWAY_LOCALES) and the session's actual spoken voice
  // already speaks in that real language. This dictionary + resolver
  // originally mirrored that same 10-locale set so the caption layer never
  // again silently collapses to English.
  //
  // VTID-03733: `tr` was added HERE, one language ahead of GATEWAY_LOCALES
  // (which still doesn't have it — that type drives push/email/notification
  // text via tt(), a separate, much larger initiative, deliberately out of
  // scope for the ORB voice work that added Turkish). Reported live:
  // "Turkish still has English subtitles/captions under the orb unlike
  // other languages" — VTID-03730 widened SUPPORTED_LIVE_LANGUAGES and every
  // voice-selection table for `tr`, but this caption dictionary is a
  // SEPARATE table this widget owns, and it was never touched — the exact
  // same "one more table missing the language" shape as
  // VTID-03578/03681/03719. `_CAPTION_LOCALES` and `GATEWAY_LOCALES` are
  // therefore no longer identical sets on purpose; do not "fix" that by
  // removing `tr` from here.
  var _CAPTION_LOCALES = ['de', 'en', 'es', 'sr', 'fr', 'pt', 'ru', 'pl', 'zh', 'ar', 'tr'];

  // Resolves _cfg.lang (may be a full tag like "de-DE" or "pt-BR") to one of
  // the 10 supported caption locales via prefix match before the first '-',
  // falling back to 'en'. Deliberately separate from _pickLang() below,
  // which stays de/en-only — see the comment on _pickLang() for why the two
  // must not be merged.
  function _resolveCaptionLocale() {
    var raw = ((_cfg.lang || 'en') + '').toLowerCase().split('-')[0];
    for (var i = 0; i < _CAPTION_LOCALES.length; i++) {
      if (_CAPTION_LOCALES[i] === raw) return raw;
    }
    return 'en';
  }

  // Picks the current-locale value out of a {en, de, es, ...} phrase object,
  // falling back to English if a translation is somehow missing.
  function _loc(entry) {
    if (!entry) return '';
    var lc = _resolveCaptionLocale();
    return entry[lc] || entry.en || '';
  }

  // Semantic-key caption dictionary — one row per UI status phrase shown in
  // .vtorb-status. Read via _caption(key) below.
  var _CAPTIONS = {
    speaking: {
      en: 'Vitana speaking...', de: 'Vitana spricht...', es: 'Vitana está hablando…',
      sr: 'Vitana priča…', fr: 'Vitana parle…', pt: 'A Vitana está a falar…',
      ru: 'Витана говорит…', pl: 'Vitana mówi…', zh: 'Vitana 正在说话…', ar: 'فيتانا تتحدث...', tr: 'Vitana konuşuyor...'
    },
    listening: {
      en: 'Listening...', de: 'Ich höre zu...', es: 'Escuchando…',
      sr: 'Slušam…', fr: "J'écoute…", pt: 'A ouvir…',
      ru: 'Слушаю…', pl: 'Słucham…', zh: '正在聆听…', ar: 'أستمع...', tr: 'Dinliyorum...'
    },
    connecting: {
      en: 'Connecting...', de: 'Verbinden...', es: 'Conectando…',
      sr: 'Povezujem se…', fr: 'Connexion…', pt: 'A ligar…',
      ru: 'Подключение…', pl: 'Łączenie…', zh: '正在连接…', ar: 'جارٍ الاتصال...', tr: 'Bağlanıyor...'
    },
    reconnecting: {
      en: 'Reconnecting...', de: 'Verbindung wird wiederhergestellt...', es: 'Reconectando…',
      sr: 'Ponovo se povezujem…', fr: 'Reconnexion…', pt: 'A restabelecer a ligação…',
      ru: 'Переподключение…', pl: 'Ponowne łączenie…', zh: '正在重新连接…', ar: 'إعادة الاتصال...', tr: 'Yeniden bağlanıyor...'
    },
    muted: {
      en: 'Muted', de: 'Stummgeschaltet', es: 'Silenciado',
      sr: 'Isključen zvuk', fr: 'Muet', pt: 'Silenciado',
      ru: 'Микрофон выключен', pl: 'Wyciszono', zh: '已静音', ar: 'مكتوم الصوت', tr: 'Sessize alındı'
    },
    tapToHear: {
      en: 'Tap anywhere to hear Vitana', de: 'Tippe, um Vitana zu hören',
      es: 'Toca en cualquier lugar para escuchar a Vitana', sr: 'Dodirni bilo gde da čuješ Vitanu',
      fr: "Touche n'importe où pour entendre Vitana", pt: 'Toca em qualquer lugar para ouvir a Vitana',
      ru: 'Коснись экрана, чтобы услышать Витану', pl: 'Dotknij gdziekolwiek, aby usłyszeć Vitanę',
      zh: '点击任意位置即可听到 Vitana 的声音', ar: 'اضغط في أي مكان لسماع فيتانا', tr: 'Vitana\'yı duymak için herhangi bir yere dokun'
    },
    idleNudge: {
      en: "I'm still listening. Tell me what you'd like to do!",
      de: 'Ich höre noch zu. Sag mir, was ich tun soll!',
      es: '¡Sigo escuchando. Dime qué te gustaría hacer!',
      sr: 'Još uvek slušam. Reci mi šta želiš da uradim!',
      fr: 'Je t’écoute toujours. Dis-moi ce que tu veux faire !',
      pt: 'Continuo a ouvir. Diz-me o que gostarias de fazer!',
      ru: 'Я всё ещё слушаю. Скажи, что бы ты хотел сделать!',
      pl: 'Wciąż słucham. Powiedz mi, co chciałbyś zrobić!',
      zh: '我还在听哦，告诉我你想做什么吧！',
      ar: 'ما زلت أستمع. أخبرني بما تريد فعله!', tr: 'Hâlâ dinliyorum. Ne yapmak istediğini söyle!'
    },
    connectFailedRetrying: {
      en: "Couldn't connect. Retrying...", de: 'Verbindung fehlgeschlagen. Neuer Versuch...',
      es: 'No se pudo conectar. Reintentando…', sr: 'Povezivanje nije uspelo. Pokušavam ponovo…',
      fr: 'Échec de la connexion. Nouvelle tentative…', pt: 'Não foi possível ligar. A tentar de novo…',
      ru: 'Не удалось подключиться. Повторная попытка…', pl: 'Nie udało się połączyć. Ponawiam próbę…',
      zh: '连接失败，正在重试…', ar: 'تعذر الاتصال. جارٍ إعادة المحاولة...', tr: 'Bağlanılamadı. Yeniden deneniyor...'
    },
    offline: {
      en: 'You seem to be offline. Please check your internet connection.',
      de: 'Du bist offline. Bitte prüfe deine Internetverbindung.',
      es: 'Parece que estás sin conexión. Comprueba tu conexión a internet.',
      sr: 'Izgleda da si offline. Proveri internet konekciju.',
      fr: 'Il semble que tu sois hors ligne. Vérifie ta connexion internet.',
      pt: 'Parece que estás offline. Verifica a tua ligação à internet.',
      ru: 'Похоже, ты офлайн. Проверь подключение к интернету.',
      pl: 'Wygląda na to, że jesteś offline. Sprawdź połączenie z internetem.',
      zh: '你似乎已离线，请检查网络连接。',
      ar: 'يبدو أنك غير متصل بالإنترنت. يرجى التحقق من اتصالك بالإنترنت.', tr: 'Çevrimdışı gibi görünüyorsun. Lütfen internet bağlantını kontrol et.'
    },
    sessionEndedBackground: {
      en: 'Session ended — app was in the background.',
      de: 'Sitzung beendet — App war im Hintergrund.',
      es: 'Sesión finalizada: la app estaba en segundo plano.',
      sr: 'Sesija je završena — aplikacija je bila u pozadini.',
      fr: "Session terminée — l'appli était en arrière-plan.",
      pt: 'Sessão terminada — a app estava em segundo plano.',
      ru: 'Сессия завершена — приложение было в фоне.',
      pl: 'Sesja zakończona — aplikacja działała w tle.',
      zh: '会话已结束 — 应用在后台运行。',
      ar: 'انتهت الجلسة — كان التطبيق يعمل في الخلفية.', tr: 'Oturum sona erdi — uygulama arka plandaydı.'
    },
    tapToReconnect: {
      en: 'Tap the orb to reconnect', de: 'Tippen zum Neu verbinden',
      es: 'Toca la esfera para reconectar', sr: 'Dodirni orb da se ponovo povežeš',
      fr: "Touche l'orbe pour te reconnecter", pt: 'Toca na esfera para reconectar',
      ru: 'Коснись сферы, чтобы переподключиться', pl: 'Dotknij kuli, aby połączyć się ponownie',
      zh: '点击光球即可重新连接', ar: 'اضغط على الكرة لإعادة الاتصال', tr: 'Yeniden bağlanmak için küreye dokun'
    },
    textModeActive: {
      en: 'Text mode active', de: 'Textmodus aktiv', es: 'Modo texto activo',
      sr: 'Tekstualni režim aktivan', fr: 'Mode texte activé', pt: 'Modo de texto ativo',
      ru: 'Активен текстовый режим', pl: 'Tryb tekstowy aktywny', zh: '文本模式已启用', ar: 'وضع النص مفعّل', tr: 'Metin modu etkin'
    },
    registerFree: {
      en: 'Register for free to continue the conversation!',
      de: 'Registriere dich kostenlos, um das Gespräch fortzusetzen!',
      es: '¡Regístrate gratis para seguir la conversación!',
      sr: 'Registruj se besplatno da nastaviš razgovor!',
      fr: 'Inscris-toi gratuitement pour continuer la conversation !',
      pt: 'Regista-te gratuitamente para continuar a conversa!',
      ru: 'Зарегистрируйся бесплатно, чтобы продолжить разговор!',
      pl: 'Zarejestruj się za darmo, aby kontynuować rozmowę!',
      zh: '免费注册即可继续对话！',
      ar: 'سجّل مجانًا لمتابعة المحادثة!', tr: 'Sohbete devam etmek için ücretsiz kaydol!'
    }
  };
  function _caption(key) { return _loc(_CAPTIONS[key]); }

  // Display-only labels for the visible status text under the orb. The audio
  // is rendered separately from these MP3 clips, but the wording matches —
  // ONLY for en/de, since _ALERT_CLIPS below has no other-locale MP3s (see
  // _pickLang()'s comment). The label text itself is read via
  // _resolveCaptionLocale() (all 10 locales); the MP3 clip id stays en/de.
  var _DISCONNECT_LABELS = {
    mic: {
      en: "One moment, I can't hear your microphone.",
      de: "Einen Moment, Mikrofon-Problem.",
      es: 'Un momento, no puedo oír tu micrófono.',
      sr: 'Trenutak, ne čujem tvoj mikrofon.',
      fr: "Un instant, je n'entends pas ton micro.",
      pt: 'Um momento, não consigo ouvir o teu microfone.',
      ru: 'Секунду, я не слышу твой микрофон.',
      pl: 'Chwilkę, nie słyszę Twojego mikrofonu.',
      zh: '稍等，我听不到你的麦克风。',
      ar: 'لحظة، لا أستطيع سماع الميكروفون الخاص بك.', tr: 'Bir saniye, mikrofonunu duyamıyorum.'
    },
    network: {
      en: "One moment, we have internet issues.",
      de: "Einen Moment, Internet-Problem.",
      es: 'Un momento, tenemos problemas de conexión.',
      sr: 'Trenutak, imamo problem sa internetom.',
      fr: 'Un instant, on a un souci de connexion.',
      pt: 'Um momento, temos problemas de ligação.',
      ru: 'Секунду, у нас проблемы с интернетом.',
      pl: 'Chwilkę, mamy problem z internetem.',
      zh: '稍等，网络出了点问题。',
      ar: 'لحظة، لدينا مشكلة في الإنترنت.', tr: 'Bir saniye, internet sorunu yaşıyoruz.'
    },
    connection: {
      en: "Hold on, I'm reconnecting. Please wait.",
      de: "Einen Moment, ich verbinde mich neu.",
      es: 'Espera, me estoy reconectando.',
      sr: 'Sačekaj, ponovo se povezujem.',
      fr: 'Patiente, je me reconnecte.',
      pt: 'Aguarda, estou a reconectar-me.',
      ru: 'Подожди, я переподключаюсь.',
      pl: 'Poczekaj, łączę się ponownie.',
      zh: '请稍等，我正在重新连接。',
      ar: 'لحظة من فضلك، أنا أعيد الاتصال.', tr: 'Bekle, yeniden bağlanıyorum. Lütfen bekle.'
    },
    offline: {
      en: "You're offline. Please wait, don't talk yet.",
      de: "Du bist offline. Bitte warte mit Sprechen.",
      es: 'Estás sin conexión. Espera, no hables todavía.',
      sr: 'Nisi na mreži. Sačekaj, još ne pričaj.',
      fr: 'Tu es hors ligne. Attends, ne parle pas encore.',
      pt: 'Estás offline. Aguarda, ainda não fales.',
      ru: 'Ты офлайн. Подожди, пока не говори.',
      pl: 'Jesteś offline. Poczekaj, jeszcze nie mów.',
      zh: '你已离线，请稍等，先别说话。',
      ar: 'أنت غير متصل. من فضلك انتظر ولا تتحدث بعد.', tr: 'Çevrimdışısın. Lütfen bekle, henüz konuşma.'
    }
  };

  var _RECOVERY_LABELS = {
    mic: {
      en: "Okay, the microphone is working again. Let's continue.",
      de: "Okay, das Mikrofon funktioniert wieder. Wir können weitermachen.",
      es: 'Listo, el micrófono ya funciona de nuevo. Sigamos.',
      sr: 'Dobro, mikrofon opet radi. Nastavimo.',
      fr: 'Voilà, le micro refonctionne. On continue.',
      pt: 'Pronto, o microfone voltou a funcionar. Vamos continuar.',
      ru: 'Готово, микрофон снова работает. Продолжим.',
      pl: 'Gotowe, mikrofon znów działa. Kontynuujmy.',
      zh: '好了，麦克风又能用了，我们继续吧。',
      ar: 'تمام، الميكروفون يعمل مجددًا. لنكمل.', tr: 'Tamam, mikrofon tekrar çalışıyor. Devam edelim.'
    },
    network: {
      en: "Okay, we're back online. I'm listening.",
      de: "Okay, das Netz ist wieder da. Ich höre zu.",
      es: 'Listo, ya estamos en línea otra vez. Te escucho.',
      sr: 'Dobro, opet smo na mreži. Slušam te.',
      fr: 'Voilà, on est de nouveau en ligne. Je t’écoute.',
      pt: 'Pronto, já estamos online outra vez. Estou a ouvir-te.',
      ru: 'Готово, мы снова онлайн. Я слушаю.',
      pl: 'Gotowe, znów jesteśmy online. Słucham Cię.',
      zh: '好了，我们又上线了，我在听。',
      ar: 'تمام، نحن متصلون مجددًا. أنا أستمع.', tr: 'Tamam, tekrar çevrimiçiyiz. Dinliyorum.'
    },
    offline: {
      en: "Okay, we're back online. I'm listening.",
      de: "Okay, das Netz ist wieder da. Ich höre zu.",
      es: 'Listo, ya estamos en línea otra vez. Te escucho.',
      sr: 'Dobro, opet smo na mreži. Slušam te.',
      fr: 'Voilà, on est de nouveau en ligne. Je t’écoute.',
      pt: 'Pronto, já estamos online outra vez. Estou a ouvir-te.',
      ru: 'Готово, мы снова онлайн. Я слушаю.',
      pl: 'Gotowe, znów jesteśmy online. Słucham Cię.',
      zh: '好了，我们又上线了，我在听。',
      ar: 'تمام، نحن متصلون مجددًا. أنا أستمع.', tr: 'Tamam, tekrar çevrimiçiyiz. Dinliyorum.'
    },
    connection: {
      en: "Okay, sorry for the interruption. I'm listening.",
      de: "Okay, entschuldige die Unterbrechung. Ich höre zu.",
      es: 'Listo, disculpa la interrupción. Te escucho.',
      sr: 'Dobro, izvini zbog prekida. Slušam te.',
      fr: 'Voilà, désolé pour l’interruption. Je t’écoute.',
      pt: 'Pronto, desculpa a interrupção. Estou a ouvir-te.',
      ru: 'Готово, извини за перерыв. Я слушаю.',
      pl: 'Gotowe, przepraszam za przerwę. Słucham Cię.',
      zh: '好了，抱歉打断了，我在听。',
      ar: 'تمام، آسفة على المقاطعة. أنا أستمع.', tr: 'Tamam, kesinti için üzgünüm. Dinliyorum.'
    }
  };

  // Catalog of MP3 clips rendered by services/gateway/scripts/render-orb-alert-clips.ts.
  // Re-render that script if you change the wording of any label above.
  var _ALERT_CLIPS = [
    'disconnect-mic-en', 'disconnect-mic-de',
    'disconnect-network-en', 'disconnect-network-de',
    'disconnect-connection-en', 'disconnect-connection-de',
    'disconnect-offline-en', 'disconnect-offline-de',
    'recovery-mic-en', 'recovery-mic-de',
    'recovery-network-en', 'recovery-network-de',
    'recovery-connection-en', 'recovery-connection-de'
  ];

  // _pickLang() is used for EXACTLY ONE thing: selecting which pre-rendered
  // disconnect/recovery-alert MP3 to play (_ALERT_CLIPS above only has
  // -en/-de clips). Do NOT use this for caption text — use
  // _resolveCaptionLocale()/_loc()/_caption() instead, which cover all 10
  // supported locales. Widening this function itself would silently request
  // a nonexistent MP3 (e.g. 'disconnect-mic-es.mp3') for 8 of 10 locales.
  function _pickLang() { return (_cfg.lang || 'en').startsWith('de') ? 'de' : 'en'; }

  function _alertClipBaseUrl() {
    // Gateway mounts the command-hub static dir at /command-hub (see
    // src/index.ts: app.use('/command-hub', express.static(...))), so the
    // clips committed under src/frontend/command-hub/sounds/orb-alert/ are
    // served at {gw}/command-hub/sounds/orb-alert/<id>.mp3.
    return (_cfg.gw || '') + '/command-hub/sounds/orb-alert/';
  }

  // Eager-decode all 14 alert clips into AudioBuffers up front. Called from
  // init() before any network can drop, so they're guaranteed to be in memory
  // when an alert needs to fire. Best-effort — failed clips just mean that
  // alert plays the error tone without a voice line. No SpeechSynthesis fallback.
  function _preloadAlertClips() {
    if (_s._alertBuffersLoaded) return;
    _s._alertBuffersLoaded = true; // prevent overlapping calls

    if (!_s.playbackCtx || _s.playbackCtx.state === 'closed') {
      try {
        _s.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.warn('[VTOrb] _preloadAlertClips: cannot create AudioContext, skipping');
        _s._alertBuffersLoaded = false;
        return;
      }
    }

    var base = _alertClipBaseUrl();
    var loaded = 0;
    _ALERT_CLIPS.forEach(function (id) {
      fetch(base + id + '.mp3', { cache: 'force-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (ab) { return _s.playbackCtx.decodeAudioData(ab.slice(0)); })
        .then(function (buf) {
          _s._alertBuffers[id] = buf;
          loaded++;
          if (loaded === _ALERT_CLIPS.length) {
            console.log('[VTOrb] Alert clips preloaded: ' + loaded + '/' + _ALERT_CLIPS.length);
          }
        })
        .catch(function (e) {
          console.warn('[VTOrb] Failed to preload alert clip ' + id + ':', e && e.message);
        });
    });
  }

  // VTID-03471: the server's answer from GET /live/transport, or null until
  // it arrives (or if it never does — the fetch is best-effort and the
  // compiled default covers its absence).
  var _serverTransport = null;

  // VTID-03471: per-tab latch. Set when a WS session start FAILED and we fell
  // back to SSE, so the rest of the tab's sessions don't each pay the 8s WS
  // start budget before failing the same way. Deliberately sessionStorage
  // (not localStorage): a network that blocks WebSocket upgrades is a
  // property of where the user is right now, not a permanent verdict on
  // their browser.
  var _WS_FALLBACK_KEY = 'vtorb.wsFallback';

  function _wsFallbackLatched() {
    try {
      return !!(window.sessionStorage && sessionStorage.getItem(_WS_FALLBACK_KEY));
    } catch (e) { return _s._wsFallbackLatched === true; }
  }

  function _latchWsFallback(reason) {
    _s._wsFallbackLatched = true;
    try {
      if (window.sessionStorage) sessionStorage.setItem(_WS_FALLBACK_KEY, reason || '1');
    } catch (e) { /* storage blocked — the in-memory flag still holds for this page */ }
    console.warn('[VTOrb] WS transport unavailable (' + reason + ') — falling back to SSE for this tab');
  }

  // VTID-03471: true when the WS transport should be used for the NEXT start.
  // See the `transport` config comment for the resolution order.
  function _useWsTransport() {
    try {
      var o = window.localStorage && localStorage.getItem('vtorb.transport');
      if (o === 'ws') return true;   // developer override wins over everything
      if (o === 'sse') return false;
    } catch (e) { /* storage blocked — fall through */ }
    if (_wsFallbackLatched()) return false;
    if (_serverTransport === 'ws') return true;
    if (_serverTransport === 'sse') return false;
    return _cfg.transport === 'ws';
  }

  // VTID-03471: ask the gateway which transport it wants. Best-effort and
  // non-blocking — if it fails or is slow, the compiled default stands and
  // the user's first tap is not delayed by it.
  function _fetchServerTransport() {
    try {
      fetch(_cfg.gw + '/api/v1/orb/live/transport', { method: 'GET' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          if (j.transport === 'ws' || j.transport === 'sse') {
            _serverTransport = j.transport;
            console.log('[VTOrb] Server transport preference: ' + _serverTransport);
          }
        })
        .catch(function () { /* best-effort — compiled default stands */ });
    } catch (e) { /* no fetch — compiled default stands */ }
  }

  // BOOTSTRAP-ORB-LATENCY-PHASE3: tear down the WS transport (idempotent).
  // sendStop=true also asks the gateway to release the upstream Live session.
  function _closeWs(sendStop) {
    var w = _s.ws;
    if (!w) return;
    _s.ws = null;
    try { w.onopen = null; w.onmessage = null; w.onerror = null; w.onclose = null; } catch (e) { /* noop */ }
    try { if (sendStop && w.readyState === 1) w.send(JSON.stringify({ type: 'stop' })); } catch (e) { /* noop */ }
    try { w.close(); } catch (e) { /* noop */ }
  }

  // BOOTSTRAP-ORB-LATENCY-PHASE2: fire-and-forget gateway bootstrap pre-warm.
  // Builds the user's context pack server-side BEFORE the first orb tap so
  // /live/session/start hits the gateway's 5-min bootstrap cache instead of
  // paying 400-800ms of Supabase fetches on the click-to-first-audio path.
  // Safe to call repeatedly (server cache absorbs it); anonymous = no-op.
  function _prewarmBootstrap() {
    if (!_cfg.token) return; // anonymous — server would no-op anyway
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _cfg.token };
    fetch(_cfg.gw + '/api/v1/orb/live/session/prewarm', { method: 'POST', headers: headers, body: '{}' })
      .then(function (r) { if (r.ok) console.log('[VTOrb] Bootstrap prewarm requested'); })
      .catch(function () { /* best-effort — never surfaces */ });
  }

  // Play a cached alert clip. Returns the BufferSource so the caller can chain
  // an onended handler (used by _clearDisconnect to ring the ready beep after
  // the recovery phrase). Returns null if the clip is missing — caller is
  // responsible for handling silence (we never speak via the OS robot voice).
  function _playAlert(id) {
    var buf = _s._alertBuffers[id];
    if (!buf || !_s.playbackCtx) {
      console.warn('[VTOrb] _playAlert: clip not loaded yet:', id);
      return null;
    }
    try {
      if (_s.playbackCtx.state === 'suspended') {
        _s.playbackCtx.resume().catch(function () {});
      }
      var src = _s.playbackCtx.createBufferSource();
      src.buffer = buf;
      src.connect(_s.playbackCtx.destination);
      src.start(0);
      return src;
    } catch (e) {
      console.warn('[VTOrb] _playAlert failed for ' + id + ':', e && e.message);
      return null;
    }
  }

  function _announceDisconnect(reason) {
    // VTID-03098: never announce a disconnect during user-initiated teardown
    // or when the overlay is already closed. Either condition means the
    // session is supposed to be ending; treating the close as a network
    // disconnect arms _recoveryWatchdog and spawns a fresh session in the
    // background ~5s after the X press.
    if (_s._userInitiatedStop) return;
    if (!_s.overlayVisible) return;
    if (_s._disconnectActive) return; // debounce
    _s._disconnectActive = true;
    _s._disconnectReason = reason;
    _s._preDisconnectVoiceState = _s.voiceState;

    // VTID-02020: capture WHAT the user was doing when the connection dropped.
    // Used by the backend's contextual recovery prompt to decide whether to
    // (A) acknowledge the disconnect + answer the in-flight question,
    // (B) ask the user to repeat (they were mid-utterance),
    // (C) resume mid-answer (the assistant was the one talking when cut off).
    var stage;
    if (_s.voiceState === 'LISTENING' && !_s.audioPlaying) {
      // user was actively talking — likely mid-question (case B)
      stage = 'listening_user_speaking';
    } else if (_s.voiceState === 'THINKING') {
      // user just finished, model hadn't started speaking yet (case A)
      stage = 'thinking';
    } else if (_s.voiceState === 'SPEAKING' || _s.audioPlaying) {
      // model was mid-answer (case C)
      stage = 'speaking';
    } else {
      stage = 'idle';
    }
    _s._preDisconnectStage = stage;

    console.warn('[VTOrb] _announceDisconnect: reason=' + reason + ', stage=' + stage);

    // DEV-COMHU-0503 follow-up: persist continuity to the gateway the MOMENT a
    // disconnect is detected — not only on graceful _hide(). Mobile WebViews
    // routinely RELOAD the page during an outage (network change, OS
    // backgrounding/kill, OOM, or a render-crash auto-reload), which wipes the
    // module-scoped _s — including _transcriptHistory and conversationId. When
    // that happened the next _sessionStart's continuity GET found nothing had
    // been persisted for the disconnect, so Vitana greeted "first-time" and the
    // user lost the entire conversation ("forgets what we talked about"). The
    // in-memory reconnect path (_resetAndReconnect/_attemptReconnect) already
    // carries history, but it only survives if the page stays alive. Persisting
    // here (short 5-min TTL, keepalive so it survives teardown) lets a
    // reload-during-outage rehydrate conversation_id + the last turns and
    // resume the same thread instead of starting over.
    _persistContinuity('connection', 5);

    // Gate mic immediately — _sendAudio checks `active` and `voiceState === 'MUTED'`
    // at the VAD processor (line ~1191), so setting MUTED stops outbound audio.
    _s.voiceState = 'MUTED';
    _s._audioSendErrorLogged = true; // suppress fetch-error spam during outage
    clearTimeout(_s._listeningIdleTimer);
    clearTimeout(_s.thinkingDelayTimer);

    // Tone first — guaranteed <50ms even if the clip buffer is missing
    _playErrorTone();

    var captionLang = _resolveCaptionLocale();
    var clipLang = _pickLang();
    var labelBucket = _DISCONNECT_LABELS[reason] || _DISCONNECT_LABELS.connection;
    var label = labelBucket[captionLang] || labelBucket.en;

    _setOrbState('paused');
    _setStatus(label);
    _updateUI();

    // VTID-03746: this call was unconditional — it plays a spoken alert clip
    // ("Einen Moment, ich verbinde mich neu...") on EVERY disconnect,
    // including one at turn_count 0 before anything has ever been heard.
    // VTID-03727 already gated the equivalent VISUAL caption in
    // _attemptReconnect() on _audioEverHeardThisOpen; this AUDIBLE alert
    // never got the same treatment, so a nova_validation-style early close
    // still spoke the reconnect line before Vitana had said a single word —
    // live-reproduced (staging, VTID-03746): "first thing i hear is: einen
    // moment die verbindung wird wieder hergestellt". Once real audio HAS
    // played, hearing this alert is correct — the user was mid-conversation
    // and got cut off, so "hold on, reconnecting" is exactly right.
    if (_s._audioEverHeardThisOpen) {
      _playAlert('disconnect-' + reason + '-' + clipLang);
    } else {
      console.log('[VTOrb] _announceDisconnect: suppressing spoken alert clip — nothing heard yet this open');
    }

    // VTID-01987: active 5-second health probe replaces the previous 60s
    // setTimeout. Mobile WebViews (Android Appilix, iOS WKWebView) fire
    // 'online'/'offline' events unreliably and EventSource.onerror often
    // never reports CLOSED — so we cannot trust passive signals. Instead,
    // every 5s while a disconnect alert is up, actively probe the gateway:
    // as soon as it answers, declare the connection back and reconnect in
    // place. setInterval is preferred over a single setTimeout because the
    // probe fetch itself may need to be retried under flaky mobile radio.
    clearInterval(_s._recoveryWatchdog);
    _s._recoveryWatchdog = setInterval(function () {
      if (!_s._disconnectActive) {
        clearInterval(_s._recoveryWatchdog);
        _s._recoveryWatchdog = null;
        return;
      }
      // If a reconnect is already in flight, let it finish — don't double up.
      if (_s._isReconnecting) return;
      // Probe the gateway with a short timeout. Any 2xx/3xx/4xx is a "we
      // can reach the network" signal — only fetch rejection (network
      // unreachable, abort) means we should keep waiting.
      var ctrl;
      try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
      var timer = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (e) {} }, 3000);
      fetch(_cfg.gw + '/api/v1/orb/health', {
        method: 'GET',
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (resp) {
        clearTimeout(timer);
        if (!_s._disconnectActive) return; // raced with manual recovery
        console.log('[VTOrb] health-probe OK (status=' + resp.status + ') — forcing _resetAndReconnect');
        _resetAndReconnect();
      }).catch(function (err) {
        clearTimeout(timer);
        // Stay quiet on the expected unreachable case; only log unexpected.
        if (err && err.name !== 'AbortError') {
          console.log('[VTOrb] health-probe still unreachable: ' + (err.message || err.name));
        }
      });
    }, 5000);
  }

  function _clearDisconnect() {
    if (!_s._disconnectActive) return;
    var reason = _s._disconnectReason || 'connection';
    _s._disconnectActive = false;
    _s._disconnectReason = null;
    _s._audioSendErrorLogged = false;
    _s._audioSendFailCount = 0;
    _s._audioSendFailWindowStart = 0;
    _s._disconnectStuck = false;
    clearInterval(_s._recoveryWatchdog);
    _s._recoveryWatchdog = null;

    console.log('[VTOrb] _clearDisconnect: recovering from reason=' + reason);

    // Restore voice state — but honor a user-initiated mute from before the outage.
    if (_s._preDisconnectVoiceState && _s._preDisconnectVoiceState !== 'MUTED') {
      _s.voiceState = _s._preDisconnectVoiceState;
    }
    _s._preDisconnectVoiceState = null;

    var lang = _resolveCaptionLocale();
    var labelBucket = _RECOVERY_LABELS[reason] || _RECOVERY_LABELS.connection;
    var label = labelBucket[lang] || labelBucket.en;

    _setOrbState('listening');
    _s.voiceState = (_s.voiceState === 'MUTED') ? _s.voiceState : 'LISTENING';
    _setStatus(label);
    _updateUI();

    // VTID-02020: NO client-side recovery voice. The backend's contextual
    // recovery prompt (sendReconnectRecoveryPromptToLiveAPI) is now the single
    // voice that acknowledges the disconnect — in the user's actual Vertex
    // Live voice, with knowledge of what they were saying when we got cut off.
    // We just play a brief non-voice ready beep + flip the status to
    // "Listening..." so the visual transition is unambiguous; the assistant
    // voice will speak shortly after.
    _playReadyBeep();
    _setStatus(_caption('listening'));
  }

  // BOOTSTRAP-ORB-MODERN-RECOVERY: full session teardown + fresh start. Used
  // by the orb-tap handler when the user taps an orb that's stuck on the
  // disconnect display, and by the 60s watchdog as a last-resort recovery.
  function _resetAndReconnect() {
    // VTID-03098: refuse to reconnect when the user has closed the overlay
    // or when _sessionStop has been initiated. This is the last line of
    // defense — both the SSE-handler detach in _sessionStop and the
    // _userInitiatedStop guard in _announceDisconnect should prevent us
    // from getting here, but if any future code path manages to call this
    // function after the user pressed X, fail closed instead of spawning a
    // background session.
    if (_s._userInitiatedStop || !_s.overlayVisible) {
      console.log('[VTOrb] _resetAndReconnect: skipped — overlay closed or stop in progress');
      return;
    }
    console.log('[VTOrb] _resetAndReconnect: forcing full session restart');
    _stopWatchdog();
    if (_s.captureStream) {
      try { _s.captureStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
      _s.captureStream = null;
    }
    if (_s.captureProcessor) { try { _s.captureProcessor.disconnect(); } catch (e) {} _s.captureProcessor = null; }
    if (_s.captureCtx) { try { _s.captureCtx.close().catch(function () {}); } catch (e) {} _s.captureCtx = null; }
    if (_s.eventSource) { try { _s.eventSource.close(); } catch (e) {} _s.eventSource = null; }
    _closeWs(false); // BOOTSTRAP-ORB-LATENCY-PHASE3: reset path — server cleans on close

    _s.sessionId = null;
    _s.active = false;
    _s.liveError = null;
    _s.greetingAudioReceived = false;
    // VTID-01988 (mic restart fix): reset greetingComplete so the new session's
    // turn_complete handler will re-trigger _startAudioCapture(). Without this,
    // recovery only updated the display — the mic stream stayed torn down.
    _s.greetingComplete = false;
    _s._reconnectCount = 0;
    // VTID-03770: this used to set _isReconnecting = FALSE here — the exact
    // opposite of a re-entrancy guard. The 5s health-probe (_recoveryWatchdog,
    // above) checks `if (_s._isReconnecting) return;` before every probe tick,
    // but since this function never actually set the flag true, that check
    // was inert: a SECOND probe tick landing while this function's own
    // _sessionStart() below was still in flight (plausible under the same
    // repeated-nova_validation-retry conditions VTID-03746/VTID-03763
    // measured taking multiple seconds) could fire a CONCURRENT
    // _resetAndReconnect(), racing session-start calls against each other.
    // Now mirrors _attemptReconnect()'s own mutex: true here, reset to false
    // once _sessionStart() actually settles (both branches below).
    _s._isReconnecting = true;
    _s._disconnectStuck = false;
    // Keep _disconnectActive true so the UI doesn't flash to a usable state
    // before the new session lands; _clearDisconnect on success will undo it.

    _setOrbState('connecting');
    _setStatus(_caption('reconnecting'));

    // VTID-03770: this reconnect path (the 5s health-probe watchdog, and the
    // tap-to-reconnect stuck-state button) rebuilt the session via a plain
    // _sessionStart() with NO restore of an in-progress guided topic — unlike
    // its sibling _attemptReconnect(), which got exactly this guard under
    // VTID-03746. Live-reproduced (staging, topic T005): a guided-topic
    // session delivered its opener, entered the conversational GUIDE-MODE
    // turn (turn_count:1, 37.7s, 335 audio chunks), then the underlying
    // connection dropped. The reconnect that followed carried no
    // guided_topic_id — every wake-brief candidate came back
    // "all_sources_skipped" — so the new session fell through to a generic
    // opener instead of resuming T005, sounding exactly like "Vitana
    // switches on again with a proactive/New-Day-style greeting" right after
    // a lesson was cut off. Same restore condition as _attemptReconnect:
    // only re-arm when the topic hasn't already been cleared by a genuine
    // close (_hide() nulls _guidedTopicInFlight; a later, unrelated reconnect
    // in the same overlay-open has nothing left to restore).
    if (_s._guidedTopicInFlight && !_s.guidedTopic) {
      console.log('[VTOrb] _resetAndReconnect: re-arming guided topic for resume: ' + _s._guidedTopicInFlight);
      _s.guidedTopic = _s._guidedTopicInFlight;
    }

    _sessionStart().then(function () {
      _s._isReconnecting = false;
      if (_s.active && _s._disconnectActive) _clearDisconnect();
    }).catch(function (err) {
      console.error('[VTOrb] _resetAndReconnect: _sessionStart failed:', err && err.message);
      _s._isReconnecting = false;
      // Hand back to the normal scheduled reconnect loop
      _attemptReconnect();
    });
  }

  // ============================================================
  // 5. AUDIO PLAYBACK PIPELINE
  // ============================================================

  // DEV-COMHU-0504 — ORB Recovery 4: audio-ready handshake.
  // POST once per session when the playback pipeline is genuinely ready
  // (AudioContext exists + running). The backend records the ack so it can
  // release the greeting on ack-or-3s. Idempotent + best-effort.
  function _signalAudioReady() {
    if (_s._audioReadySignaled) return;
    if (!_s.sessionId) return;
    // Ensure a playback context exists; if it's suspended, kick a resume so the
    // pipeline reaches 'running' (the canonical "ready" state).
    try {
      if (!_s.playbackCtx || _s.playbackCtx.state === 'closed') {
        _s.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      var ctx = _s.playbackCtx;
      if (ctx.state === 'suspended' && ctx.resume) {
        ctx.resume().catch(function () {});
      }
      if (ctx.state !== 'running') return; // not ready yet; will retry on resume
    } catch (e) {
      return; // no audio context available — let the server 3s timeout cover it
    }
    _s._audioReadySignaled = true;
    // BOOTSTRAP-ORB-LATENCY-PHASE3: WS transport sends the in-band
    // audio_ready message (the WS path defers the greeting on it).
    if (_s.ws && _s.ws.readyState === 1) {
      try {
        _s.ws.send(JSON.stringify({ type: 'audio_ready' }));
        console.log('[VTOrb] audio-ready signaled (ws) for session ' + _s.sessionId);
      } catch (e) { /* greeting falls back to the server timeout */ }
      return;
    }
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;
      fetch(_cfg.gw + '/api/v1/orb/session/' + encodeURIComponent(_s.sessionId) + '/audio-ready', {
        method: 'POST', headers: headers, cache: 'no-store', keepalive: true, body: '{}'
      }).catch(function () { /* greeting falls back to the 3s server timeout */ });
      console.log('[VTOrb] audio-ready signaled for session ' + _s.sessionId);
    } catch (e) { /* best-effort */ }
  }

  function _playAudio(base64Data, mimeType) {
    // Belt-and-suspenders: drop chunks that arrive after a user-initiated stop
    // or while the overlay is hidden. _processQueue auto-recreates a closed
    // playbackCtx, so without this guard any late SSE audio (e.g. from a racy
    // _sessionStart that resolved after _sessionStop) plays in the background.
    if (_s._userInitiatedStop || !_s.overlayVisible) return;
    // DEV-COMHU-0501: stamp the moment of the most recent inbound audio frame
    // (transport-agnostic — every provider funnels playback through here).
    _s.lastAudioReceivedAt = Date.now();
    _s.audioQueue.push({ data: base64Data, mime: mimeType });
    _processQueue();
  }

  function _processQueue() {
    // Create fallback playback context if needed
    if (!_s.playbackCtx || _s.playbackCtx.state === 'closed') {
      _s.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    var ctx = _s.playbackCtx;

    // BOOTSTRAP-ORB-IOS-UNLOCK: if the context is suspended (common on iOS
    // when audio arrives before the user has tapped, or after a route
    // change), attempt resume. Previously the .catch was silent and chunks
    // sat in the queue until _processQueue was called again. Now we log
    // visibly, retry up to 3s, and emit an error if the context never
    // unlocks so the client isn't left silent while UI says "listening".
    if (ctx.state === 'suspended') {
      if (!_s._resumeRetryStartedAt) _s._resumeRetryStartedAt = Date.now();
      var elapsed = Date.now() - _s._resumeRetryStartedAt;
      if (elapsed > 3000) {
        console.error('[VTOrb] AudioContext failed to resume after 3s — audio will not play. State:', ctx.state);
        _s._resumeRetryStartedAt = 0;
        // Drop queued audio rather than leaving UI in a stuck state.
        _s.audioQueue.length = 0;
        // VTID-03469: dropping chunks used to be entirely invisible — the
        // overlay carried on showing "Vitana spricht..." (set on audio_out
        // ARRIVAL, see the audio case in the message handler) while nothing
        // was rendered. Say what actually happened and give the user the one
        // gesture that fixes it.
        _announceAudioBlocked();
        return;
      }
      ctx.resume().then(function () {
        _s._resumeRetryStartedAt = 0;
        _clearAudioBlocked();
        // DEV-COMHU-0504: ctx just reached 'running' → pipeline now ready.
        _signalAudioReady();
        // Re-enter on next tick so any pending chunks drain.
        setTimeout(_processQueue, 0);
      }).catch(function (e) {
        console.warn('[VTOrb] AudioContext resume rejected (elapsed=' + elapsed + 'ms):', e && e.message);
        // Retry via the existing setTimeout cadence.
        setTimeout(_processQueue, 50);
      });
      return;
    }
    _s._resumeRetryStartedAt = 0;

    var isFirstChunk = _s.scheduledSources.length === 0;

    while (_s.audioQueue.length > 0) {
      var chunk = _s.audioQueue.shift();

      // Legacy WAV fallback
      if (chunk.mime && chunk.mime.includes('wav')) {
        var audio = new Audio('data:audio/wav;base64,' + chunk.data);
        audio.play().catch(function () {});
        continue;
      }

      // PCM scheduling
      try {
        var bin = atob(chunk.data);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        var int16 = new Int16Array(bytes.buffer);
        var floats = new Float32Array(int16.length);
        for (var j = 0; j < int16.length; j++) floats[j] = int16[j] / 32768.0;

        var pcmRate = _pcmRateFromMime(chunk.mime);
        var buf = ctx.createBuffer(1, floats.length, pcmRate);
        buf.copyToChannel(floats, 0);

        // Snapshot once per chunk so the schedule-gap compensation below
        // (_s.lastScheduledEnd +=) divides by the exact rate this chunk was
        // actually played at — using the wrong constant here would drift or
        // gap consecutive chunks the moment DE and non-DE rates diverge.
        var chunkRate = _currentPlaybackRate();

        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = chunkRate;
        src.connect(ctx.destination);

        var now = ctx.currentTime;
        if (_s.lastScheduledEnd < now) {
          var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
          _s.lastScheduledEnd = (isFirstChunk && isMobile) ? now + 0.3 : now;
        }

        src.start(_s.lastScheduledEnd);

        _s.scheduledSources.push(src);
        // VTID-03185 — Phase 0 of ORB Recovery: wrap onended in an IIFE that
        // captures the *specific* AudioBufferSource for this iteration. The
        // bug was that `src` is `var`-scoped (function-scoped, not block-
        // scoped), so every onended closure pointed at the LAST `src` the
        // loop assigned. Earlier chunks could not remove themselves from
        // _s.scheduledSources, leaving stale entries → the widget stayed in
        // "Vitana speaking..." after audio had ended, gating the mic.
        (function (endedSrc) {
          src.onended = function () {
            var idx = _s.scheduledSources.indexOf(endedSrc);
            if (idx !== -1) _s.scheduledSources.splice(idx, 1);
            if (_s.scheduledSources.length === 0) {
              // Grace period before clearing audioPlaying. Covers inter-chunk
              // scheduling gaps (~50-100ms). Previously 1000ms to prevent
              // greeting flicker, but mic is now off during greeting so 400ms
              // is enough. _waitForAudioEnd also checks scheduledSources +
              // audioQueue directly, so LISTENING only shows when truly done.
              clearTimeout(_s.audioEndGraceTimer);
              _s.audioEndGraceTimer = setTimeout(function () {
                if (_s.scheduledSources.length === 0 && _s.audioQueue.length === 0) {
                  _s.audioPlaying = false;
                  _s.lastAudioEndTime = Date.now();
                }
              }, 400);
            }
          };
        })(src);

        // buf.duration is the UNPLAYED-rate duration; at playbackRate>1 the
        // chunk actually finishes sooner, so scheduling by buf.duration
        // would leave audible gaps between chunks. Divide by the SAME rate
        // just assigned to this chunk's src.playbackRate (chunkRate) —
        // not the global constant — to keep back-to-back chunks gapless.
        _s.lastScheduledEnd += buf.duration / chunkRate;
        // VTID-03706: stamp the START of each playback burst so the capture
        // handler can hold the mic gate shut while browser AEC converges on
        // the newly-started render stream. Only on the false->true edge —
        // re-stamping on every chunk would slide the warm-up window forward
        // for the whole turn and make the user permanently uninterruptible.
        if (!_s.audioPlaying) {
          _s.audioPlayStartedAt = Date.now();
          _s.audioPlaying = true;
          // Repaint on the edge so the mic button switches to its
          // still-listening colour as Vitana starts talking, not a turn late.
          if (_s.fullDuplex) _updateUI();
        }
        _s.audioPlaying = true;
        isFirstChunk = false;
      } catch (e) {
        console.error('[VTOrb] Audio scheduling error:', e);
      }
    }
  }

  // ============================================================
  // 6. GEMINI LIVE SESSION
  // ============================================================

  async function _sessionStart() {
    if (_s.active) return;
    // VTID-03292 (#3): the user closed the overlay — do NOT (re)start a session.
    // A reconnect path that races the close lands here and bails, so the orb
    // stays closed instead of silently re-opening. Cleared only by _show().
    if (_s._userRequestedClose) {
      console.log('[VTOrb] _sessionStart: skipped — user requested close');
      return;
    }
    console.log('[VTOrb] Starting Gemini Live session...');

    // VTID-03098: clear the user-initiated-stop flag at the start of every
    // session so a fresh tap on the orb can connect normally. The flag is
    // only meant to guard the teardown window between _sessionStop and the
    // next intentional _sessionStart.
    _s._userInitiatedStop = false;
    // DEV-COMHU-0504 (review fix): re-arm the audio-ready ack for EVERY fresh
    // _sessionStart, including reconnect paths (_attemptReconnect /
    // _resetAndReconnect) that bypass _sessionStop. Without this, a recovered
    // session keeps the prior session's _audioReadySignaled=true and never
    // acks its new session_id, forcing the greeting gate to the 3s timeout.
    _s._audioReadySignaled = false;

    // DEV-COMHU-ORB-AUDIO-FIRST-GREETING: unlock the playback AudioContext
    // SYNCHRONOUSLY, before ANY await in this function. On mobile (iOS/Android)
    // the user-gesture activation token is consumed by the first await — and the
    // continuity fetch below awaited BEFORE this unlock, so the silent-buffer
    // unlock + resume() landed OUTSIDE the gesture window, the context stayed
    // suspended, and the FIRST greeting's PCM was dropped (the second press
    // worked because the context was already running). Creating + unlocking here,
    // ahead of the fetch, restores the in-gesture guarantee. Idempotent: reuses
    // an existing, non-closed context on later presses.
    if (!_s.playbackCtx || _s.playbackCtx.state === 'closed') {
      _s.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    try {
      var _silentUnlock = _s.playbackCtx.createBuffer(1, 1, 22050);
      var _silentUnlockSrc = _s.playbackCtx.createBufferSource();
      _silentUnlockSrc.buffer = _silentUnlock;
      _silentUnlockSrc.connect(_s.playbackCtx.destination);
      _silentUnlockSrc.start(0);
    } catch (e) {
      console.warn('[VTOrb] silent-buffer iOS unlock failed:', e && e.message);
    }
    if (_s.playbackCtx.state === 'suspended') {
      _s.playbackCtx.resume().catch(function (e) {
        console.warn('[VTOrb] playbackCtx resume rejected at session start:', e && e.message);
      });
    }

    // DEV-COMHU-0503 (review fix): hydrate persisted continuity on a fresh
    // reopen. _hide() persisted continuity then _sessionStop cleared the
    // in-memory fields, so without this the reconnect-context builder below
    // would start "first-time" even though a saved conversation exists. Only
    // hydrate when in-memory continuity is empty (don't clobber a live
    // reconnect that still has its transcript) and only for authed sessions.
    if (_cfg.token && (!_s._transcriptHistory || _s._transcriptHistory.length === 0) && !_s.conversationId) {
      try {
        var contHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _cfg.token };
        var contResp = await fetch(_cfg.gw + '/api/v1/orb/session/continuity', {
          method: 'GET', headers: contHeaders, cache: 'no-store'
        });
        if (contResp && contResp.ok) {
          var contData = await contResp.json();
          var c = contData && contData.continuity;
          if (c && typeof c === 'object') {
            if (c.conversation_id) _s.conversationId = c.conversation_id;
            if (Array.isArray(c.transcript_history) && c.transcript_history.length) {
              _s._transcriptHistory = c.transcript_history.slice(-20);
            }
            if (c.last_turn_at) _s._lastTurnAt = c.last_turn_at;
            if (c.last_greeting_at) _s._lastGreetingAt = c.last_greeting_at;
            console.log('[VTOrb] continuity hydrated: conversation_id=' + (_s.conversationId || '<none>')
              + ', transcript=' + ((_s._transcriptHistory && _s._transcriptHistory.length) || 0) + ' turns');
          }
        }
      } catch (e) { /* continuity is an optimization — never block session start */ }
    }

    _s.greetingAudioReceived = false;
    // VTID-01988: greetingComplete gates the post-greeting _startAudioCapture()
    // call. It used to only get reset in _sessionStop (full session teardown),
    // so reconnects via _resetAndReconnect / _attemptReconnect kept it as true
    // and the new session never re-acquired the mic. Reset it here so every
    // fresh _sessionStart correctly arms the post-greeting mic-startup path,
    // regardless of which caller invokes it.
    _s.greetingComplete = false;
    _s._audioSendErrorLogged = false;
    _s._inputTranscriptBuffer = '';
    _s._outputTranscriptBuffer = '';
    // VTID-NAV-HOTFIX2: Reset close-pending flags from any previous session.
    // The widget IIFE persists across SPA navigations (the script loads once
    // and _s is module-scoped), so if the previous session ended by firing
    // orb_directive or session_limit_reached, navigationPending/signupClosing
    // were set to true and never reset. On the next orb open, the 'audio'
    // case at the top of the message handler sees navigationPending === true
    // and drops EVERY audio chunk — effectively muting the orb permanently
    // after the first navigation. Reset here so each new session starts clean.
    _s.navigationPending = false;
    _s.signupClosing = false;

    // BOOTSTRAP-ORB-IOS-UNLOCK: the playback AudioContext create + 1-sample
    // silent-buffer unlock + resume() was MOVED UP to before the continuity
    // fetch above (DEV-COMHU-ORB-AUDIO-FIRST-GREETING) — it MUST run before any
    // await so the mobile gesture window is not lost. The ctx is already unlocked
    // by here; just play the activation chime into it.
    _playChime(_s.playbackCtx);

    // VTID-02710: keep the ctx warm until the first Gemini audio arrives.
    // The chime ends ~400 ms after this call; without an active source after
    // that, iOS auto-suspends the ctx during the 2-5 s wait for the SSE
    // greeting and the first chunks drop silently. Stopped in the audio_out
    // handler on first real chunk, and in _sessionStop on teardown.
    _startCtxKeepAlive();

    try {
      var headers = { 'Content-Type': 'application/json' };
      if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;

      // Final language refresh — read vitana.lang right before sending.
      // Covers edge case where language was changed after _show() but before session start.
      try {
        var freshLang = localStorage.getItem('vitana.lang');
        if (freshLang) _cfg.lang = freshLang.split('-')[0];
      } catch (e) { /* ignore */ }

      console.log('[VTOrb] _sessionStart: hasToken=' + !!_cfg.token + ', lang=' + _cfg.lang + ', tokenSetByInit=' + _tokenSetByInit);

      // VTID-NAV: Include current page + recent navigation history so the
      // backend Navigator service has context for screen recommendations.
      // Values are pushed via VTOrb.updateContext() by the host React Router.
      var startPayload = {
        lang: _cfg.lang,
        voice_style: 'friendly, calm, empathetic',
        response_modalities: ['audio', 'text'],
        vad_silence_ms: 600 // BOOTSTRAP-ORB-LATENCY-PHASE1: 1200→850→600 to trim end-of-turn latency; constants.ts mirrors
      };
      // VTID-03250: send the browser's OWN IANA timezone so the gateway has a
      // reliable local time even when geo-IP rate-limits (HTTP 429). Without
      // this the assistant lost the user's time and hallucinated it.
      try {
        var _tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (_tz) startPayload.client_timezone = _tz;
      } catch (e) { /* Intl unavailable — gateway falls back to geo-IP */ }
      if (_s.currentRoute) startPayload.current_route = _s.currentRoute;
      if (_s.recentRoutes && _s.recentRoutes.length) startPayload.recent_routes = _s.recentRoutes.slice(0, 5);

      // VTID-03300: "My Journey" next-step focus. When the host opens the orb
      // by tapping a specific Foundation step (VitanaOrb.focusJourneyStep), the
      // step key rides along so the journey-guide provider LEADS with THAT step
      // ("Let's improve your Profile…") instead of the sequentially-computed
      // next step. One-shot: consumed for this session only so the next normal
      // open reverts to the default next-step behaviour.
      if (_s.journeyFocus) {
        startPayload.journey_focus_step = _s.journeyFocus;
        _s.journeyFocus = null;
      }

      // VTID-03291 / DEV-COMHU-0507: Guided Journey catalog topic tap. When the
      // host opened the orb via VitanaOrb.focusGuidedTopic(topicId), the topicId
      // rides along so the guided-topic-narration provider LEADS turn-1 and
      // Vitana teaches that topic from the published KB.
      //
      // VTID-03675: deliberately NOT one-shot-consumed (nulled) here anymore.
      // This used to null _s.guidedTopic the instant it was read into the
      // payload, on the theory that "consumed for this session only" meant
      // "consumed by this _sessionStart call". But a FAILED first attempt
      // (Nova nova_validation-rejects the guided-topic prompt, the server
      // gives up retrying internally, the WS dies) still needs it: the
      // widget's OWN _attemptReconnect() then tears down and calls
      // _sessionStart() again from scratch, and with guidedTopic already
      // null that retry went out with no guided_topic_id at all — the new
      // session's wake-brief ladder never even considered teaching the
      // topic and fell back to a generic "let's continue" opener, while
      // guidedAutoClose (armed together with guidedTopic, below) still
      // fired on THAT turn's completion and auto-closed the overlay as if
      // the topic had been taught. Reproduced live 2026-08-18 (topic T017,
      // 3 distinct session_ids within 5s: the first got the guided-topic
      // candidate and was nova_validation-rejected twice, the next two
      // never requested one at all). guidedTopic now lives until the guided
      // turn actually completes (cleared alongside guidedAutoClose, see the
      // turn-complete handler) or the overlay is closed (_hide()) — both
      // already-existing lifecycle points for guidedAutoClose, so the two
      // flags now share one lifecycle instead of drifting apart.
      //
      // VTID-03774: restore from _guidedTopicInFlight HERE too, at the actual
      // read/send site — not only in each caller (_attemptReconnect /
      // _resetAndReconnect, VTID-03746/03770). Both callers already re-arm
      // _s.guidedTopic from _s._guidedTopicInFlight before calling this
      // function, and that should be sufficient — but a live staging trace
      // (topic T003, real account, SSE transport) showed a mid-lesson
      // reconnect still going out with NO guided_topic_id despite both flags
      // appearing correctly armed earlier in the flow: the wake-timeline for
      // the reconnected session recorded guided_topic_narration's own
      // decision as `reason:"no_topic_tapped"` — proof positive the field
      // never reached the server, from a session whose disconnect-stage also
      // came through as "idle" rather than the "speaking" the in-flight
      // narration audio should have produced, i.e. this reconnect did not
      // originate from the code path the earlier restore-guards were placed
      // in. Rather than keep chasing which caller has the gap, close it at
      // the one place that can never be bypassed: right before the field is
      // actually read into the outgoing payload, regardless of which
      // function got the widget here. This does not replace the two
      // existing restore-guards (harmless, redundant with this one) — it
      // makes this fallback structurally impossible to route around.
      if (!_s.guidedTopic && _s._guidedTopicInFlight) {
        console.log('[VTOrb] _sessionStart: guidedTopic was empty but _guidedTopicInFlight=' + _s._guidedTopicInFlight + ' — restoring at send site (VTID-03774)');
        _s.guidedTopic = _s._guidedTopicInFlight;
      }
      if (_s.guidedTopic) {
        startPayload.guided_topic_id = _s.guidedTopic;
        // VTID-03774 (Codex review follow-up): tell the server this is a
        // RESUME — turn-1 audio for this topic was already delivered before
        // now — so it bundles the topic context without re-synthesizing/
        // replaying the narration audio or re-injecting the verbatim opener
        // instruction. Without this, every qualifying reconnect restarted
        // the lesson from the beginning instead of continuing it.
        if (_s._guidedTopicAudioDelivered) {
          startPayload.guided_topic_resume = true;
        }
      }
      // VTID-03774: diagnostic-grade logging so a FUTURE loss (if this
      // fallback somehow isn't the whole story either) is traceable from
      // console logs alone instead of requiring another multi-hour live
      // oasis_events reconstruction. Cheap: one line, every _sessionStart.
      console.log('[VTOrb] _sessionStart: guidedTopic=' + (_s.guidedTopic || '<none>')
        + ', guidedTopicInFlight=' + (_s._guidedTopicInFlight || '<none>')
        + ', guidedTopicAudioDelivered=' + !!_s._guidedTopicAudioDelivered
        + ', preDisconnectStage=' + (_s._preDisconnectStage || '<none>')
        + ', isReconnectAttempt=' + !!(_s._transcriptHistory && _s._transcriptHistory.length));

      // VTID-02020: when this _sessionStart is happening as part of a reconnect
      // (NOT a first-time session), send the conversation history + the
      // pre-disconnect stage so the backend can route to the contextual
      // recovery prompt instead of the generic greeting. Detected via the
      // presence of accumulated transcript history OR an explicit pre-stage
      // flag — both survive _resetAndReconnect (kept in module-scoped _s).
      var hasHistory = _s._transcriptHistory && _s._transcriptHistory.length > 0;
      var hasStage = !!_s._preDisconnectStage;
      if (hasHistory || hasStage) {
        if (hasHistory) {
          startPayload.transcript_history = _s._transcriptHistory.slice(-20).map(function (t) {
            return { role: t.role, text: t.text };
          });
        }
        startPayload.reconnect_stage = _s._preDisconnectStage || 'idle';
        if (_s.conversationId) startPayload.conversation_id = _s.conversationId;
        console.log('[VTOrb] _sessionStart: reconnect context — stage=' + startPayload.reconnect_stage
          + ', transcript=' + (startPayload.transcript_history ? startPayload.transcript_history.length : 0) + ' turns'
          + ', conversation_id=' + (startPayload.conversation_id || '<new>'));
      }

      // VTID-03471 (L-04/L-05): WebSocket transport branch — now the DEFAULT.
      // One bidirectional connection replaces POST /session/start +
      // EventSource + a POST per 64ms audio chunk. Same start payload, same
      // downstream message shapes, same _handleMessage.
      //
      // If the WS start fails for a TRANSPORT reason (blocked upgrade,
      // captive portal, corporate proxy that eats 101s, socket closed before
      // the handshake completed), fall through to the SSE path rather than
      // failing the session: an environment where WebSockets don't work is
      // exactly where the legacy transport still does. The latch stops the
      // rest of this tab's sessions from re-paying the 8s WS start budget.
      //
      // A server-side REJECTION (401 AUTH_TOKEN_INVALID and friends) is NOT a
      // transport failure — SSE would be rejected identically — so those are
      // rethrown for the caller's error handling instead of retried.
      if (_useWsTransport()) {
        try {
          await _sessionStartWs(startPayload);
          return;
        } catch (wsErr) {
          if (wsErr && wsErr.__vtOrbServerRejected) throw wsErr;
          if (_s._userInitiatedStop || !_s.overlayVisible) throw wsErr;
          _latchWsFallback((wsErr && wsErr.message) || 'ws_start_failed');
          // fall through to the SSE path below, same startPayload
        }
      }

      // VTID-01987: explicit 8s timeout. On Android WebView a fetch over a
      // dead TCP connection can hang indefinitely, which used to leave the
      // reconnect promise pending forever and the orb stuck on the disconnect
      // screen. AbortSignal.timeout is supported on all WebViews we target;
      // if it's somehow missing, fall back to AbortController + setTimeout.
      var startSignal;
      var startTimer;
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        startSignal = AbortSignal.timeout(8000);
      } else {
        try {
          var ctrl = new AbortController();
          startTimer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 8000);
          startSignal = ctrl.signal;
        } catch (e) { startSignal = undefined; }
      }
      var resp = await fetch(_cfg.gw + '/api/v1/orb/live/session/start', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(startPayload),
        signal: startSignal
      });
      if (startTimer) clearTimeout(startTimer);

      // Bail out if the user pressed X (or the overlay was hidden) while the
      // session/start fetch was in flight. Without this, _sessionStart goes on
      // to attach SSE + play the greeting audio after the overlay is already
      // gone, which is the "Vitana keeps speaking in the background after the
      // first close" symptom. The gateway hasn't returned a session_id yet at
      // this point, so there's nothing to tear down upstream.
      if (_s._userInitiatedStop || !_s.overlayVisible) {
        console.log('[VTOrb] _sessionStart: aborted after fetch — overlay closed during start handshake');
        return;
      }

      var data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Failed to start session');

      // Same guard, after the response body is parsed. This is the load-bearing
      // check: we now have data.session_id, so we must POST /live/session/stop
      // to release the upstream Gemini Live session — otherwise the gateway
      // leaks it. Return BEFORE setting _s.sessionId / _s.active / opening SSE.
      if (_s._userInitiatedStop || !_s.overlayVisible) {
        console.log('[VTOrb] _sessionStart: aborted after json — cleaning up stranded session_id=' + (data && data.session_id));
        if (data && data.session_id) {
          try {
            fetch(_cfg.gw + '/api/v1/orb/live/session/stop', {
              method: 'POST',
              headers: headers,
              body: JSON.stringify({ session_id: data.session_id }),
              keepalive: true,
            }).catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
        }
        return;
      }

      _s.sessionId = data.session_id;
      _s.active = true;
      // VTID-03763: this is a fresh (or reconnected) session's connection —
      // any poll loop still ticking from a prior connection is now stale.
      _s._sessionGeneration++;
      // DEV-COMHU-0504 — ORB Recovery 4: as soon as we have a session id, try to
      // signal audio-pipeline readiness so the backend can release the greeting
      // the moment the client can actually play it (ack-or-3s gate server-side).
      _signalAudioReady();
      // VTID-02020: pin the conversation_id returned by the backend so future
      // reconnects can re-thread the same conversation. The backend will
      // either echo back the one we sent or mint a fresh UUID on first start.
      if (data.conversation_id) _s.conversationId = data.conversation_id;
      // VTID-02020: the pre-disconnect stage was now consumed by the new
      // session; clear it so a non-reconnect _sessionStart later doesn't
      // accidentally route to the recovery prompt. transcript_history and
      // conversation_id ARE preserved across the rest of the session lifetime.
      _s._preDisconnectStage = null;
      if (_cfg.onSessionStart) try { _cfg.onSessionStart(_s.sessionId); } catch (e) { /* ignore */ }

      // Connect SSE stream
      var sseUrl = _cfg.gw + '/api/v1/orb/live/stream?session_id=' + data.session_id;
      if (_cfg.token) sseUrl += '&token=' + encodeURIComponent(_cfg.token);

      var es = new EventSource(sseUrl);
      es.onopen = function () {
        console.log('[VTOrb] SSE connected');
        _startWatchdog();
        // DEV-COMHU-0501: arm the cross-provider speaking-state watchdog + emit
        // a one-line session-shape diagnostic so stuck-speaking reports are
        // debuggable from console logs alone.
        _startSpeakingWatchdog();
        console.log(
          '[VTOrb] session diagnostics: ACstate=' +
          (_s.playbackCtx ? _s.playbackCtx.state : 'none') +
          ', queueLen=' + _s.audioQueue.length +
          ', sourcesLen=' + _s.scheduledSources.length +
          ', audioPlaying=' + _s.audioPlaying
        );
      };
      es.onmessage = function (event) {
        try {
          var msg = JSON.parse(event.data);
          _resetWatchdog();
          _handleMessage(msg);
        } catch (e) { /* parse error */ }
      };
      es.onerror = function () {
        if (es.readyState === EventSource.CLOSED) {
          _stopWatchdog();
          // BOOTSTRAP-ORB-MODERN-RECOVERY: a real SSE-level CLOSED is the
          // signal that the upstream session is gone. Always announce the
          // disconnect and hand to _attemptReconnect — the reconnect loop
          // owns the budget logic and the eventual tap-to-reconnect fallback,
          // so we never call _sessionStop here (which would kill the orb).
          _announceDisconnect('connection');
          _attemptReconnect();
        }
      };
      _s.eventSource = es;

      // Mic capture starts AFTER greeting completes (first turn_complete).
      // Opening the mic during greeting causes echo-triggered interruptions
      // because browser AEC can't fully suppress the greeting audio.

      _updateUI();
    } catch (err) {
      console.error('[VTOrb] Failed to start session:', err);
      _s.active = false;
      _s.sessionId = null;
      _s.liveError = err.message;
      _setOrbState('error');

      // BOOTSTRAP-ORB-FASTSTART-DRIFT: this used to end here — state flipped to
      // 'error' (red aura) but the status text was never touched, so the label
      // _show() set stayed on screen and the orb read "Verbinden..." FOREVER
      // while nothing was in flight. Nothing retried either, so a start that
      // merely ran slow became permanently dead: the user's only recovery was
      // to close the overlay and reopen it (which worked, because the second
      // attempt hit warm caches).
      //
      // That is precisely how a server-side regression surfaced as an
      // "endlessly connecting" orb: cold authenticated session/start exceeded
      // the 8s abort above, and every symptom the user saw after that was this
      // handler lying about what was happening.
      //
      // Two fixes, both required: say something true, then actually recover.
      _setStatus(_caption('connectFailedRetrying'));
      _updateUI();

      // Hand to the existing recovery loop — it owns the retry budget, the
      // offline check, and the eventual tap-to-reconnect fallback. Skipped
      // when the user is deliberately leaving (X / overlay hidden), mirroring
      // _announceDisconnect's guards, and when a reconnect is already in
      // flight — _attemptReconnect's own _isReconnecting guard would drop the
      // call anyway, but this keeps the intent explicit at the call site
      // rather than resting on that ordering.
      if (!_s._userInitiatedStop && _s.overlayVisible && !_s._isReconnecting) {
        _attemptReconnect();
      }
    }
  }

  // BOOTSTRAP-ORB-LATENCY-PHASE3: WS-transport session start. Mirrors the
  // SSE path's bookkeeping exactly (abort guards, session id pin,
  // audio-ready signal, watchdogs) — only the wire changes. The gateway's
  // WS path sends the same message shapes the SSE stream does, so all
  // post-handshake traffic funnels into the shared _handleMessage.
  function _sessionStartWs(startPayload) {
    return new Promise(function (resolve, reject) {
      var url = _cfg.gw.replace(/^http/, 'ws') + '/api/v1/orb/live/ws';
      if (_cfg.token) url += '?token=' + encodeURIComponent(_cfg.token);
      var w;
      try { w = new WebSocket(url); } catch (e) { return reject(e); }
      var settled = false;
      // Same 8s start budget as the SSE fetch (VTID-01987 rationale).
      var startTimer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { w.close(); } catch (e) { /* noop */ }
        reject(new Error('WS session start timed out after 8s'));
      }, 8000);
      function bail(reason) {
        // User pressed X / overlay hidden mid-handshake — mirror the SSE
        // path's stranded-session cleanup (stop + close releases upstream).
        clearTimeout(startTimer);
        settled = true;
        _s.ws = w;
        _closeWs(true);
        console.log('[VTOrb] _sessionStartWs: aborted — ' + reason);
        resolve();
      }
      w.onmessage = function (event) {
        var msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (msg.type === 'connected') {
          if (_s._userInitiatedStop || !_s.overlayVisible) return bail('overlay closed during connect');
          try { w.send(JSON.stringify(Object.assign({ type: 'start' }, startPayload))); } catch (e) { /* onclose covers */ }
          return;
        }
        // VTID-03471: the gateway rejected the start (bad/expired JWT, origin
        // not allowed, quota). Distinguish it from a transport failure: SSE
        // would be rejected the same way, so the caller must NOT retry there.
        if (msg.type === 'error' && !settled) {
          clearTimeout(startTimer);
          settled = true;
          _s.ws = null;
          try { w.close(); } catch (e) { /* noop */ }
          var rejErr = new Error(msg.code || msg.message || 'WS session start rejected');
          rejErr.__vtOrbServerRejected = true;
          rejErr.code = msg.code || null;
          rejErr.status = msg.status || null;
          reject(rejErr);
          return;
        }
        if (msg.type === 'session_started' && !settled) {
          clearTimeout(startTimer);
          settled = true;
          if (_s._userInitiatedStop || !_s.overlayVisible) return bail('overlay closed during start handshake');
          _s.ws = w;
          _s.sessionId = msg.session_id;
          _s.active = true;
          // VTID-03763: this is a fresh (or reconnected) session's connection —
          // any poll loop still ticking from a prior connection is now stale.
          _s._sessionGeneration++;
          // VTID-03706: the SERVER decides whether this session runs full
          // duplex, so client and server can never disagree about whether
          // frames captured during playback are gated or forwarded. Absent
          // (older gateway, flag off) ⇒ falsy ⇒ legacy barge-in, unchanged.
          _s.fullDuplex = msg.full_duplex === true;
          _signalAudioReady();
          if (msg.conversation_id) _s.conversationId = msg.conversation_id;
          _s._preDisconnectStage = null;
          if (_cfg.onSessionStart) try { _cfg.onSessionStart(_s.sessionId); } catch (e) { /* ignore */ }
          _startWatchdog();
          _startSpeakingWatchdog();
          console.log('[VTOrb] WS transport connected — session ' + msg.session_id);
          _updateUI();
          resolve();
          return;
        }
        _resetWatchdog();
        _handleMessage(msg);
      };
      w.onclose = function () {
        if (!settled) {
          settled = true;
          clearTimeout(startTimer);
          _s.ws = null;
          reject(new Error('WS closed during session start'));
          return;
        }
        if (_s.ws !== w) return; // deliberate teardown already detached this socket
        // Unexpected close mid-session — same recovery path as SSE CLOSED.
        _s.ws = null;
        _stopWatchdog();
        _announceDisconnect('connection');
        _attemptReconnect();
      };
      w.onerror = function () { /* onclose carries the recovery decision */ };
    });
  }

  async function _sessionStop() {
    console.log('[VTOrb] Stopping session...');
    // VTID-03098: mark this as a user-initiated stop BEFORE any teardown.
    // Anything that fires synchronously as a result of the teardown (SSE
    // onerror on Android WebView, residual disconnect-recovery probes,
    // setTimeout reconnect callbacks) must see this flag and bail.
    _s._userInitiatedStop = true;
    _stopWatchdog();
    _stopBackgroundWatchdog();
    _stopSpeakingWatchdog(); // DEV-COMHU-0501
    clearTimeout(_s._listeningIdleTimer);

    // VTID-03098: always cancel the disconnect-recovery probe, even when
    // _disconnectActive is false. The probe is a 5s setInterval started by
    // _announceDisconnect; if any earlier onerror (manual close on Android,
    // half-open socket race) armed it without flipping _disconnectActive
    // back into the alert state we still observe, leaving it running would
    // wake a brand-new session in the background after the user pressed X.
    clearInterval(_s._recoveryWatchdog);
    _s._recoveryWatchdog = null;

    // Cancel any pending disconnect alert silently — session is ending, so no
    // "we're back" phrase. (Alert clips are short BufferSources that finish
    // on their own; we don't track them for explicit cancellation.)
    if (_s._disconnectActive) {
      _s._disconnectActive = false;
      _s._disconnectReason = null;
      _s._preDisconnectVoiceState = null;
      _s._disconnectStuck = false;
      _s._isReconnecting = false;
    }

    // Stop mic
    if (_s.captureStream) {
      _s.captureStream.getTracks().forEach(function (t) { t.stop(); });
      _s.captureStream = null;
    }
    if (_s.captureProcessor) { _s.captureProcessor.disconnect(); _s.captureProcessor = null; }
    if (_s.captureCtx) { _s.captureCtx.close().catch(function () {}); _s.captureCtx = null; }

    // VTID-02710: stop the iOS ctx keep-alive (if it was still running because
    // the session ended before any audio arrived) before closing the ctx.
    _stopCtxKeepAlive();
    // VTID-03469: drop the tap-to-unblock listener with the session. skipUi
    // because the overlay is being torn down — _show() paints the next state.
    _clearAudioBlocked(true);

    // Stop playback
    if (_s.playbackCtx) { _s.playbackCtx.close().catch(function () {}); _s.playbackCtx = null; }

    // Clear stuck guard
    clearTimeout(_s.stuckGuardTimer);
    _s.stuckGuardTimer = null;
    _s.greetingAudioReceived = false;
    _s._audioReadySignaled = false; // DEV-COMHU-0504: re-arm ack for next session
    _s.lastScheduledEnd = 0;

    // Close SSE — VTID-03098: detach handlers FIRST so the manual close
    // cannot trip the auto-reconnect cascade through es.onerror. The
    // EventSource spec does not require onerror to fire on close(), but
    // Android Appilix WebView observably does fire it, and the handler
    // bound below calls _announceDisconnect → _recoveryWatchdog (5s
    // health probe) → _resetAndReconnect → _sessionStart, which is
    // exactly the "background greeting after the X" symptom this fixes.
    if (_s.eventSource) {
      var __es = _s.eventSource;
      _s.eventSource = null;
      try { __es.onopen = null; } catch (e) { /* noop */ }
      try { __es.onmessage = null; } catch (e) { /* noop */ }
      try { __es.onerror = null; } catch (e) { /* noop */ }
      try { __es.close(); } catch (e) { /* noop */ }
    }
    // BOOTSTRAP-ORB-LATENCY-PHASE3: user-initiated stop — send the in-band
    // stop so the gateway releases the upstream Live session, then close.
    _closeWs(true);

    // Stop backend session — VTID-03295: FIRE-AND-FORGET (keepalive), never
    // `await`. Awaiting the network here stalled teardown behind a slow/hung
    // request while audio was still playing (the un-closeable-overlay bug). The
    // overlay + audio are already torn down synchronously in _hide; this is just
    // best-effort server cleanup.
    if (_s.sessionId) {
      try {
        var headers = { 'Content-Type': 'application/json' };
        if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;
        fetch(_cfg.gw + '/api/v1/orb/live/session/stop', {
          method: 'POST', headers: headers, keepalive: true,
          body: JSON.stringify({ session_id: _s.sessionId })
        }).catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }

    if (_cfg.onSessionEnd) try { _cfg.onSessionEnd(); } catch (e) { /* ignore */ }
    _s.sessionId = null;
    _s.active = false;
    _s.audioQueue = [];
    _s.audioPlaying = false;
    _s.greetingComplete = false;
    clearTimeout(_s.audioEndGraceTimer);
    clearTimeout(_s.thinkingDelayTimer);
    clearInterval(_s.thinkingProgressTimer);
    // Stop scheduled audio
    if (_s.scheduledSources) {
      for (var i = 0; i < _s.scheduledSources.length; i++) {
        try { _s.scheduledSources[i].stop(); } catch (e) { /* ok */ }
      }
      _s.scheduledSources = [];
    }
    _s.lastScheduledEnd = 0;
    _s.voiceState = 'IDLE';
    _s.liveError = null;
    _s.interruptPending = false;
    _s.turnCompleteAt = 0;
    _s._inputTranscriptBuffer = '';
    _s._outputTranscriptBuffer = '';
    _s._transcriptHistory = [];
    _s._reconnectCount = 0;
    // VTID-02020: clear conversation pin + stage on full close so the next
    // open is a true fresh start (greeting flow, not recovery flow).
    _s.conversationId = null;
    _s._preDisconnectStage = null;

    _updateUI();
  }

  // ============================================================
  // 7. SSE MESSAGE HANDLER
  // ============================================================

  function _handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        _setOrbState('thinking');
        _s.voiceState = 'THINKING';
        var readyMsg = _buildThinkingQueue()[0];
        _setStatus(_loc(readyMsg));
        // Stuck guard: 15s timeout
        clearTimeout(_s.stuckGuardTimer);
        _s.stuckGuardTimer = setTimeout(function () {
          if (!_s.greetingAudioReceived && _s.active) {
            _setOrbState('listening');
            _s.voiceState = 'LISTENING';
            _setStatus(_caption('listening'));
            _updateUI();
          }
        }, 15000);
        _updateUI();
        break;

      case 'live_api_ready':
        // Full voice conversation active.
        // VTID-03706 follow-up: the WS session_started handshake sets
        // _s.fullDuplex from msg.full_duplex, but this SSE handshake never
        // did — and SSE is this widget's DEFAULT transport (see
        // _sessionStart's transport preference), not a rare fallback.
        // _s.fullDuplex stayed at its false default for every SSE session,
        // so the mic-live UI and the full-duplex capture branch in
        // _startAudioCapture were both structurally unreachable over SSE
        // even with the server flag on. Mirrors the WS handler's line
        // exactly (msg.full_duplex === true; absent/false ⇒ legacy
        // half-duplex, unchanged).
        _s.fullDuplex = msg.full_duplex === true;
        _updateUI();
        break;

      case 'thinking':
        // Server signals model is processing (user speech detected or tool call running).
        // 300ms delay — just enough to skip if audio arrives almost immediately.
        // Previous 1.5s was too long: combined with Vertex VAD silence detection (~2s),
        // total delay was ~4-5s before user saw the opening status line — felt broken.
        _s.thinkingStartTime = Date.now();
        if (_s.voiceState === 'LISTENING' || _s.voiceState === 'IDLE') {
          clearTimeout(_s.thinkingDelayTimer);
          _s.thinkingDelayTimer = setTimeout(function () {
            if (_s.voiceState === 'LISTENING' || _s.voiceState === 'IDLE') {
              _setOrbState('thinking');
              _s.voiceState = 'THINKING';
              _updateUI();
              _startThinkingProgress(); // also sets the first status line immediately
            }
          }, 300);
        } else if (_s.voiceState === 'MUTED') {
          clearTimeout(_s.thinkingDelayTimer);
          _s.thinkingDelayTimer = setTimeout(function () {
            if (_s.voiceState === 'MUTED') {
              _s.preMuteState = 'THINKING';
            }
          }, 300);
        }
        break;

      case 'audio':
      case 'audio_out':
        if (_s.interruptPending) break;
        // VTID-NAV: Once a navigation is queued, drop all further audio
        // chunks. The model should have stopped speaking but late audio
        // chunks that were already in flight from the backend would
        // otherwise get scheduled and play for a few ms after the widget
        // hides — producing the "half word" tail fragment the user hears.
        if (_s.navigationPending) break;
        // Cancel pending thinking timer and progress — response arrived
        clearTimeout(_s.thinkingDelayTimer);
        clearInterval(_s.thinkingProgressTimer);
        _s.thinkingProgressTimer = null;
        if (msg.data_b64) {
          // Clear stuck guard on first audio
          if (!_s.greetingAudioReceived) {
            _s.greetingAudioReceived = true;
            clearTimeout(_s.stuckGuardTimer);
            // VTID-02710: real audio is taking over — release the keep-alive
            // pump so it doesn't quietly waste cycles for the rest of the
            // session.
            _stopCtxKeepAlive();
          }
          // Update to SPEAKING when audio arrives — but respect MUTED state.
          // If muted, keep visual state as muted but track that model is speaking
          // so unmute restores to SPEAKING (not LISTENING).
          if (_s.voiceState === 'MUTED') {
            _s.preMuteState = 'SPEAKING';
          } else if (_s.voiceState !== 'SPEAKING') {
            _setOrbState('speaking');
            _s.voiceState = 'SPEAKING';
            _setStatus(_caption('speaking'));
            clearTimeout(_s._listeningIdleTimer); // Cancel idle nudge — model is responding
            _updateUI();
          }
          _playAudio(msg.data_b64, msg.mime || 'audio/pcm;rate=24000');
        }
        break;

      case 'turn_complete':
        // VTID-NAV-HOTFIX: Only reset the scheduling cursor if no audio is
        // still scheduled. Otherwise next-turn chunks schedule at `now` via
        // _processQueue's `lastScheduledEnd < now` check and play on top of
        // in-flight current-turn audio. When all current-turn sources drain,
        // _processQueue's own check naturally resets the cursor on the next
        // chunk, so this guard has no impact on the happy path.
        if (!_s.scheduledSources || _s.scheduledSources.length === 0) {
          _s.lastScheduledEnd = 0;
        }
        _s.interruptPending = false;
        _s.turnCompleteAt = Date.now();
        // Clear thinking progress if running
        clearInterval(_s.thinkingProgressTimer);
        _s.thinkingProgressTimer = null;

        // VTID-TRANSCRIPT-FIX: Flush buffered transcripts as single entries
        if (_s._inputTranscriptBuffer.trim()) {
          _s._transcriptHistory.push({ role: 'user', text: _s._inputTranscriptBuffer.trim() });
          _s._inputTranscriptBuffer = '';
        }
        if (_s._outputTranscriptBuffer.trim()) {
          _s._transcriptHistory.push({ role: 'assistant', text: _s._outputTranscriptBuffer.trim() });
          _s._outputTranscriptBuffer = '';
        }
        // (transcript UI removed)

        // Wait for audio playback to finish, then switch to LISTENING
        // (unless user has muted — then stay muted, just update preMuteState)
        // Check all three signals: audioPlaying flag, scheduled sources, and queue.
        // audioPlaying has a 1s grace period, but we also directly check sources/queue
        // to catch edge cases where the flag lags behind reality.
        (function (myGen) {
          // VTID-03763: myGen pins the session generation this poll belongs
          // to (see _sessionGeneration on _s). A stale poll from a PRIOR
          // session can survive past that session's teardown — its only
          // other guard, `!_s.active`, is checked against shared state that
          // the NEXT session resets to true before this poll's next tick,
          // so it wrongly reads as "still my active session" and clobbers
          // the new session's freshly-armed _s.guidedTopic/_s.guidedAutoClose.
          (function _waitForAudioEnd() {
            setTimeout(function () {
              if (_s._sessionGeneration !== myGen) return; // stale poll from a prior session
              if (!_s.active) return; // Session ended
              // VTID-NAV: Any close-pending state suppresses the listening transition.
              // Covers signup close (legacy) AND navigator-driven navigation close.
              if (_isClosingForNav()) return;
              var stillPlaying = _s.audioPlaying ||
                (_s.scheduledSources && _s.scheduledSources.length > 0) ||
                (_s.audioQueue && _s.audioQueue.length > 0);
              if (stillPlaying) {
                _waitForAudioEnd(); // Still playing — check again in 300ms
                return;
              }
            // VTID-03292 (#4): audio for this turn has drained. Notify the host
            // BEFORE the listening transition so a guided-topic flow can close
            // the overlay (revealing the drawer) instead of dropping to mic.
            // was_greeting = the first turn (greetingComplete still false here).
            if (_cfg.onTurnComplete) {
              try { _cfg.onTurnComplete({ was_greeting: !_s.greetingComplete }); }
              catch (e) { /* host callback must never break the voice loop */ }
            }
            // VTID-03294 (#4) — SUPERSEDED by VTID-03685, do not restore.
            // This used to close the overlay the instant turn 1 finished
            // playing, on the theory that turn 1 WAS the whole lesson
            // (true under the original VTID-03293 design, where the model's
            // first turn spoke the complete voice_script verbatim). VTID-
            // 03650/03665 changed turn 1 into a SHORT opener line — the real
            // teaching moved to the conversational GUIDE-MODE block that
            // governs turns 2+ (guided-topic-narration-prompt.ts: "Keep it
            // conversational: short chunks, check understanding, answer
            // follow-ups") — and nobody updated this auto-close to match.
            // The result, confirmed live via oasis_events on two consecutive
            // guided-topic taps (T252 "Dein Plan", T253 "Dein erster
            // Schritt"): `upstream_closed reason:"user_stop"` at
            // `turn_count:1`, seconds after the opener's ~1s of audio
            // finished — THIS auto-close was the client sending that stop.
            // The multi-paragraph lesson content never had a chance to be
            // taught; the user's own report named it exactly: "what's
            // completely missing is reading the session."
            //
            // VTID-03675's guidedTopic clear still happens here — the topic
            // WAS delivered (a candidate won, the opener was spoken), so a
            // later unrelated reconnect must not resend guided_topic_id —
            // but the overlay itself now stays open and falls through to
            // the normal listening transition below, exactly like any other
            // ORB conversation, so the model's GUIDE-MODE turns can actually
            // run. Closing the overlay (and revealing the already-open
            // Topic Explanation drawer underneath) is now the user's own
            // action, same as ending any other ORB conversation — there is
            // no reliable signal yet for "the model decided teaching is
            // done" to auto-trigger it, and guessing at one here would
            // trade a definite bug for a fragile heuristic.
            if (_s.guidedAutoClose && !_s.greetingComplete) {
              _s.guidedAutoClose = false;
              _s.guidedTopic = null;
              // VTID-03774: turn-1 audio (opener + narration bridge) has now
              // actually been delivered — a later restored-and-resent topic
              // must tell the server it's a RESUME, not a fresh open, so
              // the lesson doesn't restart from the beginning.
              _s._guidedTopicAudioDelivered = true;
              console.log('[VTOrb] guided teaching opener complete — continuing conversation (no auto-close)');
            }
            // If the overlay was closed some other way while we were waiting
            // for audio to drain (user pressed X, session torn down), stop
            // here — don't beep / arm the mic on a torn-down session.
            if (!_s.active || _s._userRequestedClose || !_s.overlayVisible) return;
            // VTID-02035b: play the ready beep BEFORE starting mic capture.
            // On iOS / Appilix WebView, getUserMedia switches the audio
            // session to the "voiceChat"/"playAndRecord" category, which
            // ducks (or briefly cuts) any other audio playing through the
            // shared playback context. The beep was getting clipped because
            // _startAudioCapture() ran first and the audio-session switch
            // happened during the beep envelope. Play the beep, give it
            // ~250ms (its full audible window) to drain on the speaker,
            // THEN start mic capture.
            var _afterBeepStartMic = function () {
              if (!_s.greetingComplete) {
                _s.greetingComplete = true;
                _s._audioEverHeardThisOpen = true; // VTID-03727 — survives later reconnect resets
                _startAudioCapture().catch(function (err) {
                  console.error('[VTOrb] Mic capture failed after greeting:', err);
                  _announceDisconnect('mic');
                });
              }
            };
            if (_s.voiceState === 'MUTED') {
              // Muted — don't change visual state, but update what unmute restores to
              _s.preMuteState = 'LISTENING';
              _afterBeepStartMic();
            } else {
              _s.voiceState = 'LISTENING';
              // VTID-03469: while audio is blocked the overlay is showing the
              // tap-to-hear prompt. Overwriting it with "Listening..." here
              // would hide the only instruction that repairs playback, and the
              // beep below would be inaudible anyway — keep the prompt up.
              if (!_s._audioBlocked) {
                _setOrbState('listening');
                _setStatus(_caption('listening'));
                _playReadyBeep();
              }
              _updateUI();
              // The beep is 200ms; defer mic-arm by 250ms so the audio-session
              // switch happens after the speaker has finished rendering it.
              setTimeout(_afterBeepStartMic, 250);

              // VTID-NAV-IDLE: If the orb sits in LISTENING for 15 seconds
              // without the user speaking, nudge them. This catches the
              // "stuck/frozen" state where the user expected navigation but
              // Gemini just answered verbally, and both sides wait in silence.
              // The nudge updates the status text and plays the ready beep
              // again so the user knows the orb is still alive and waiting.
              // The check self-reschedules if the user actually IS talking
              // (VAD updates _s._lastSpeechAt) so we never beep mid-sentence.
              _s._lastSpeechAt = 0;
              clearTimeout(_s._listeningIdleTimer);
              (function _armIdleNudge(delay) {
                _s._listeningIdleTimer = setTimeout(function check() {
                  if (_s.voiceState !== 'LISTENING' || !_s.active) return;
                  var sinceSpeech = _s._lastSpeechAt
                    ? Date.now() - _s._lastSpeechAt
                    : Infinity;
                  if (sinceSpeech < 15000) {
                    _armIdleNudge(15000 - sinceSpeech + 200);
                    return;
                  }
                  _setStatus(_caption('idleNudge'));
                  _playReadyBeep();
                  _updateUI();
                }, delay);
              })(15000);
            }
          }, 300);
          })();
        })(_s._sessionGeneration);
        break;

      case 'interrupted':
        _s.audioQueue = [];
        if (_s.scheduledSources && _s.scheduledSources.length > 0) {
          for (var i = 0; i < _s.scheduledSources.length; i++) {
            try { _s.scheduledSources[i].stop(); } catch (e) { /* ok */ }
          }
          _s.scheduledSources = [];
        }
        _s.lastScheduledEnd = 0;
        _s.audioPlaying = false;
        clearTimeout(_s.audioEndGraceTimer);
        _s.interruptPending = false;
        break;

      case 'error':
        // VTID-03686: an upstream 'error' on the FIRST connection attempt
        // (e.g. Nova's nova_validation content filter) is followed by a
        // silent server-internal retry that usually succeeds within a few
        // seconds (resendGreetingIfStuckAtZeroTurns) — nothing has been
        // heard yet, so there is nothing for the user to be "in error"
        // from. Flashing a raw internal error string here reads as broken
        // even when the recovery is about to work; a genuinely terminal
        // failure is reported separately via 'connection_issue'/
        // 'live_api_disconnected', which _attemptReconnect handles with
        // its own status text. Once something has actually played
        // (greetingComplete), a real error is worth surfacing.
        if (_s.greetingComplete) {
          _setStatus('Error: ' + (msg.message || 'Unknown'));
        } else {
          console.warn('[VTOrb] Upstream error before first audio — suppressing status flash, awaiting server retry: ' + (msg.message || 'Unknown'));
        }
        break;

      case 'connection_alert':
      case 'reconnecting':
        // Backend is transparently reconnecting upstream (Vertex Live API).
        // Give the user a loud, spoken cue to stop talking until the
        // connection is back. Do NOT call _attemptReconnect here — the server
        // owns the upstream reconnect; we wait for either a 'reconnected'
        // message (success) or a real SSE-level CLOSED (genuine failure,
        // handled by the EventSource onerror path). This prevents the client
        // retry budget from being burned on every transparent server hiccup.
        console.warn('[VTOrb] Upstream ' + msg.type + ' — announcing disconnect (server-side reconnect in progress)');
        clearTimeout(_s._listeningIdleTimer);
        _s._preReconnectVoiceState = _s.voiceState;
        _announceDisconnect('connection');
        break;

      case 'persona_swap_reconnecting':
        // VTID-02047 voice channel-swap: the server is closing+reopening the
        // upstream WS to hand off from Vitana to a specialist (or back).
        // Vitana's bridge sentence has just played; the new persona is about
        // to greet in their distinct voice. We must NOT speak "Einen Moment,
        // ich verbinde mich neu" — that overlaps with the bridge and breaks
        // the illusion that a different colleague is picking up. Silently
        // pause mic + flip UI; the new voice is the cue.
        console.log('[VTOrb] Persona swap reconnecting — silent UI gate');
        clearTimeout(_s._listeningIdleTimer);
        _s._preReconnectVoiceState = _s.voiceState;
        _setOrbState('thinking');
        // Pause mic without TTS announcement
        if (_s.recorder && typeof _s.recorder.mute === 'function') {
          try { _s.recorder.mute(); } catch (_e) { /* ignore */ }
        }
        break;

      case 'persona_swap_reconnected':
        // Specialist (or returning Vitana) is now active. The model itself
        // will speak the greeting; we just resume the listening state.
        console.log('[VTOrb] Persona swap reconnected — resuming, persona=' + (msg.persona || 'unknown'));
        if (_s._preReconnectVoiceState === 'LISTENING') {
          _setOrbState('listening');
          _s.voiceState = 'LISTENING';
        }
        _s._preReconnectVoiceState = null;
        break;

      case 'reconnected':
        // Reconnect succeeded. _clearDisconnect handles the "we're back" TTS +
        // ready beep. If no disconnect was active (rare), fall through to the
        // silent restore so we don't play a bogus recovery phrase.
        console.log('[VTOrb] Upstream reconnected');
        if (_s._disconnectActive) {
          _clearDisconnect();
        } else if (_s.voiceState === 'THINKING' && _s._preReconnectVoiceState === 'LISTENING') {
          _setOrbState('listening');
          _s.voiceState = 'LISTENING';
          _setStatus(_caption('listening'));
          _updateUI();
        }
        _s._preReconnectVoiceState = null;
        break;

      case 'connection_issue':
      case 'live_api_disconnected':
        // BOOTSTRAP-ORB-MODERN-RECOVERY: server explicitly told us upstream
        // is dead. Hand to _attemptReconnect — it owns the budget logic and
        // the tap-to-reconnect fallback when the budget is spent. We never
        // auto-_sessionStop here; killing the orb forces a page refresh.
        console.warn('[VTOrb] Server reported connection issue — attempting reconnect');
        _announceDisconnect('connection');
        _attemptReconnect();
        break;

      case 'session_ended':
        // VTID-03778: this message is sent by exactly one live code path —
        // terminateExistingSessionsForUser (orb-live.ts) — when the server
        // supersedes THIS session because a newer one started for the same
        // user. The other two server-side emitters of 'session_ended' are
        // both echoes of a stop the CLIENT itself already POSTed via
        // /session/stop — by the time those arrive, _sessionStop() has
        // already detached this handler (see its own comment on why), so
        // they never reach here in practice.
        //
        // _sessionStop() was the original handler. Two bugs, live-reproduced
        // (staging, right after VTID-03776 shipped — a guided-topic session
        // fell back to generic conversation, ran for ~57s, then got
        // superseded): (1) _sessionStop() unconditionally sets
        // _s._userInitiatedStop = true at its very top — mislabeling a
        // SERVER-forced close as a user action, which then silently
        // suppresses every later reconnect guard in this file for the rest
        // of the overlay-open. (2) _sessionStop() only tears down session
        // internals (mic, audio contexts, WS) — it never touches overlay
        // visibility or the status caption. Together: the overlay froze on
        // its last caption ("Listening...") forever, with nothing left
        // running behind it and no code path left to recover — reported as
        // "you cannot close it... I need to refresh to exit." The very next
        // case above (connection_issue/live_api_disconnected) already
        // carries this exact lesson in its own comment: "We never auto-
        // _sessionStop here; killing the orb forces a page refresh."
        //
        // Fix: call _hide() instead — the same full, honest teardown a real
        // user-initiated close uses (stops audio synchronously, closes the
        // session, and — critically — actually hides the overlay). Reopening
        // is one tap away; freezing behind a stale caption is not.
        console.warn('[VTOrb] Server ended this session (superseded by a newer one) — closing overlay');
        _hide();
        break;

      case 'session_limit_reached':
        if (msg.reason === 'signup_intent' || msg.reason === 'login_intent') {
          // VTID-ANON-SIGNUP: Wait for Vitana's goodbye audio to finish fully before
          // closing + redirecting — don't cut her off mid-sentence. Block listening.
          console.log('[VTOrb] ' + msg.reason + ' — waiting for goodbye audio to finish, then redirecting to ' + (msg.redirect || 'none'));
          _s.signupClosing = true;
          var redirectUrl = msg.redirect || null;
          var _signupCloseAttempts = 0;
          (function (myGen) {
            // VTID-03763: see the identical guard on _waitForAudioEnd above —
            // a stale poll surviving into a later session must not call
            // _hide() (or redirect) on behalf of a session it no longer
            // belongs to.
            (function _waitForGoodbyeEnd() {
              setTimeout(function () {
                if (_s._sessionGeneration !== myGen) return; // stale poll from a prior session
                var stillPlaying = _s.audioPlaying ||
                  (_s.scheduledSources && _s.scheduledSources.length > 0) ||
                  (_s.audioQueue && _s.audioQueue.length > 0);
                // Hard safety cap: 30s (100 * 300ms) so we never get stuck waiting forever
                if (stillPlaying && _signupCloseAttempts++ < 100) {
                  _waitForGoodbyeEnd();
                  return;
                }
                // Small grace period so the very last audio sample plays out cleanly
                setTimeout(function () {
                  if (_s._sessionGeneration !== myGen) return; // stale poll from a prior session
                  _hide();
                  if (redirectUrl) {
                    if (typeof _cfg.onSignupRedirect === 'function') {
                      try { _cfg.onSignupRedirect(redirectUrl); } catch (e) { console.error('[VTOrb] onSignupRedirect failed:', e); }
                    } else {
                      // Fallback: hard navigation (works in Appilix WebView for same-origin URLs)
                      try { window.location.href = redirectUrl; } catch (e) { console.error('[VTOrb] redirect failed:', e); }
                    }
                  }
                }, 600);
              }, 300);
            })();
          })(_s._sessionGeneration);
        } else {
          // VTID-ANON-NUDGE: Turn limit — show registration prompt
          console.log('[VTOrb] Session limit reached — prompting registration');
          _setStatus(_caption('registerFree'));
          _setOrbState('paused');
          setTimeout(_sessionStop, 8000);
        }
        break;

      case 'orb_directive':
        // VTID-NAV-01: Vitana Navigator dispatch. Originally only 'navigate'
        // existed; new directives discriminate on msg.directive.
        // VTID-01941: 'open_url' added for music.play — opens the track's
        // provider URL (music.youtube.com etc.) in a new tab and keeps the
        // orb session alive so the user can keep talking.
        if (msg.directive === 'open_url') {
          if (!msg.url) {
            console.warn('[VTOrb] orb_directive open_url received without url — ignoring');
            break;
          }

          // VTID-01942: always use window.open on the plain HTTPS URL.
          // Android App Links (music.youtube.com, open.spotify.com, etc.)
          // and iOS Universal Links handle the native-app handoff via the
          // OS. An earlier attempt to switch to `location.href = intent://`
          // broke the Appilix WebView flow — location.href navigates the
          // WebView itself and not every wrapper forwards intent URLs to
          // the OS. window.open with target=_blank is the route the host
          // WebView already knows how to forward.
          console.log('[VTOrb] orb_directive open_url: ' + (msg.title || msg.url) + (msg.source ? ' (' + msg.source + ')' : ''));
          try {
            var _opened = window.open(msg.url, '_blank', 'noopener,noreferrer');
            if (!_opened) {
              // Popup blocked (or WebView returned null). Same-tab fallback
              // so the user at least reaches the player instead of silently
              // getting nothing.
              console.warn('[VTOrb] window.open returned null, falling back to location.href');
              window.location.href = msg.url;
            }
          } catch (_e) {
            console.error('[VTOrb] open_url failed:', _e);
          }
          break;
        }
        if (msg.directive === 'navigate') {
          var navRoute = msg.route;
          var navCtx = { screen_id: msg.screen_id, reason: msg.reason, title: msg.title };
          if (!navRoute) {
            console.warn('[VTOrb] orb_directive navigate received without route — ignoring');
            break;
          }
          console.log('[VTOrb] orb_directive navigate to ' + navRoute + ' (screen=' + msg.screen_id + ')');
          _s.navigationPending = true;
          var _navAttempts = 0;
          (function (myGen) {
            // VTID-03763: see the identical guard on _waitForAudioEnd above —
            // a stale poll surviving into a later session must not tear down
            // audio/navigate/hide on behalf of a session it no longer
            // belongs to.
            (function _waitForNavReady() {
              setTimeout(function () {
                if (_s._sessionGeneration !== myGen) return; // stale poll from a prior session
                var stillPlaying = _s.audioPlaying ||
                  (_s.scheduledSources && _s.scheduledSources.length > 0) ||
                  (_s.audioQueue && _s.audioQueue.length > 0);
                // Hard safety cap: 30s (100 * 300ms) so we never wait forever
                if (stillPlaying && _navAttempts++ < 100) {
                  _waitForNavReady();
                  return;
                }
                // VTID-NAV-FAST: Short grace period (200ms instead of 600ms).
                // The aggressive source cleanup below catches any late audio,
                // so 200ms is enough for the last buffer to finish cleanly.
                setTimeout(function () {
                  if (_s._sessionGeneration !== myGen) return; // stale poll from a prior session
                  // Kill any remaining scheduled sources before hide
                _s.audioQueue = [];
                if (_s.scheduledSources && _s.scheduledSources.length > 0) {
                  for (var _si = 0; _si < _s.scheduledSources.length; _si++) {
                    try { _s.scheduledSources[_si].stop(); } catch (_e) { /* ok */ }
                  }
                  _s.scheduledSources = [];
                }
                _s.lastScheduledEnd = 0;
                _s.audioPlaying = false;

                // BOOTSTRAP-ORB-UNREAD-MESSAGES-NAV: a deterministic
                // greeting-effect navigate (e.g. "you have new messages" ->
                // open the inbox) can ask the session to stay open instead
                // of tearing down, so a dictated reply can follow right
                // away. Without clearing navigationPending here, every
                // audio chunk from now on would be silently dropped (see
                // the 'audio'/'audio_out' case above) — the widget would
                // look alive but never speak again.
                if (msg.keep_orb_open === true) {
                  _s.navigationPending = false;
                } else {
                  _hide();
                }
                if (typeof _cfg.onNavigationRequest === 'function') {
                  try { _cfg.onNavigationRequest(navRoute, navCtx); }
                  catch (e) { console.error('[VTOrb] onNavigationRequest failed:', e); }
                } else {
                  try { window.location.href = navRoute; }
                  catch (e) { console.error('[VTOrb] navigation fallback failed:', e); }
                }
              }, 200);
              }, 300);
            })();
          })(_s._sessionGeneration);
        } else if (msg.directive === 'end_teaching_session') {
          // VTID-03112 (T2 / DEV-COMHU-03115): the LLM called `end_teaching_session` after
          // delivering its farewell line. Close the overlay gracefully —
          // give the audio queue a moment to finish playing the farewell
          // before the SSE/WS tear down. Mirrors the navigate directive's
          // teardown pattern so the closing chime + state cleanup behave
          // identically.
          console.log('[VTOrb] orb_directive end_teaching_session (reason=' + (msg.reason || '<none>') + ')');
          try {
            // Stop accepting new audio chunks but let the queued farewell
            // finish playing — _hide() is invoked after a short delay.
            _s.audioPlaying = false;
            setTimeout(function() {
              try { _hide(); }
              catch (e) { console.error('[VTOrb] _hide on end_teaching_session failed:', e); }
            }, 500);
            if (typeof _cfg.onTeachingSessionEnd === 'function') {
              try { _cfg.onTeachingSessionEnd(msg.reason || null); }
              catch (e) { console.error('[VTOrb] onTeachingSessionEnd handler failed:', e); }
            }
          } catch (e) {
            console.error('[VTOrb] end_teaching_session handling error:', e);
          }
        } else if (msg.directive === 'end_guided_topic_teaching') {
          // VTID-03762: the LLM called `end_guided_topic_teaching` after
          // finishing a "My Journey" guided-topic lesson (see
          // guided-topic-narration-prompt.ts for why this tool exists — the
          // GUIDE MODE block has no other exit condition). Closes the
          // overlay so the host page's already-mounted "Well done" drawer
          // (opened at tap time, underneath this overlay) is revealed.
          // Teardown itself lives in _endGuidedTopicTeaching (shared with
          // the backstop timer — see its own comment for why both exist).
          console.log('[VTOrb] orb_directive end_guided_topic_teaching (topic=' + (msg.topic_id || '<none>') + ', reason=' + (msg.reason || '<none>') + ')');
          try {
            _endGuidedTopicTeaching(msg.topic_id || null, msg.reason || null);
          } catch (e) {
            console.error('[VTOrb] end_guided_topic_teaching handling error:', e);
          }
        } else {
          console.warn('[VTOrb] Unknown orb_directive: ' + msg.directive);
        }
        break;

      case 'link':
        // Server extracted a URL from tool results — push to transcript so it
        // appears in chat as a tappable link. Vitana doesn't say URLs in voice.
        if (msg.url) {
          _s._transcriptHistory.push({ role: 'assistant', text: msg.url });
          // Notify parent app if it has a link handler
          if (_cfg.onLink) try { _cfg.onLink(msg.url, msg.tool); } catch (e) { /* ignore */ }
          console.log('[VTOrb] Link received: ' + msg.url);
        }
        break;

      case 'heartbeat':
        // VTID-HEARTBEAT-FIX: Server data heartbeat — watchdog already reset
        // by _resetWatchdog() in onmessage handler. Nothing else needed.
        break;

      case 'transcript':
      case 'output_transcript':
        // VTID-TRANSCRIPT-FIX: Buffer assistant transcript fragments, display on turn_complete
        if (msg.text) {
          _s._outputTranscriptBuffer = (_s._outputTranscriptBuffer || '') + msg.text;
          // (transcript UI removed)
        }
        break;

      case 'input_transcript':
        // VTID-TRANSCRIPT-FIX: Buffer user transcript fragments, display on turn_complete
        if (msg.text) {
          _s._inputTranscriptBuffer = (_s._inputTranscriptBuffer || '') + msg.text;
          // (transcript UI removed)
        }
        break;

      // audio_ack, video_ack — ignore
    }
  }

  // ============================================================
  // 8. AUDIO CAPTURE (getUserMedia + PCM + VAD + Barge-in)
  // ============================================================

  async function _startAudioCapture() {
    var stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 16000 }
    });
    _s.captureStream = stream;

    var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    _s.captureCtx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    var source = ctx.createMediaStreamSource(stream);
    var processor = ctx.createScriptProcessor(1024, 1, 1);

    // Client-side VAD for barge-in
    // Threshold must be high enough to ignore speaker echo leaking through AEC.
    // Typical speech RMS: 0.1-0.3. Echo through AEC: 0.01-0.04.
    // Previous 0.015 was too low — triggered on echo, causing constant interruptions.
    var vadThreshold = 0.06;
    var vadFrames = 0;
    // Require 6 consecutive frames (~384ms at 1024 samples/16kHz) to confirm real speech.
    // Previous 3 frames (~192ms) triggered on brief echo bursts.
    var vadConfirm = 6;
    var vadInterruptSent = false;

    // BOOTSTRAP-ORB-BARGEIN: pre-roll ring buffer (L-09 / C-09).
    //
    // THE BUG: while Vitana was speaking, this handler dropped every mic frame
    // on the floor (`return; // Don't send audio while model speaking`) and
    // only reacted after vadConfirm=6 frames — so the FIRST ~384ms of the
    // user's interruption was destroyed, never sent upstream, and Nova never
    // heard the beginning of what they said. Combined with the synthetic
    // silence the gateway streams during playback, Nova literally could not
    // hear the user, so its native barge-in never fired either.
    //
    // WHY NOT "just always forward the mic" (the audit's first suggestion):
    // this file carries MEASURED evidence against that — see the vadThreshold
    // comment above. Echo through AEC lands at 0.01-0.04 RMS, and a previous
    // 0.015 threshold "triggered on echo, causing constant interruptions".
    // Forwarding every frame during playback would feed that echo straight to
    // Nova's server-side VAD and risk it interrupting ITSELF continuously —
    // a worse regression than the bug being fixed. Validating that needs a
    // real echo test on device, which is a separate piece of work.
    //
    // THE FIX that is safe today: keep the energy gate (so echo is still not
    // forwarded), but stop DESTROYING the audio. Every frame captured during
    // playback goes into this ring buffer; the moment VAD confirms real
    // speech, the buffer is flushed upstream ahead of the live stream. The
    // user's opening words arrive intact instead of being swallowed.
    //
    // VTID-03706 SUPERSEDES the above for full-duplex sessions. The pre-roll
    // exists only to RECONSTRUCT audio the gate destroyed; when the gate
    // stops destroying anything there is nothing left to reconstruct. Under
    // full duplex a frame is emitted for EVERY capture callback — verbatim
    // above the echo floor, digital silence below it — so the user's opening
    // syllable reaches Nova in the frame it was spoken, with no confirmation
    // delay and no replay ordering to get wrong. The legacy path below is
    // kept byte-for-byte for flag-off sessions and is deleted once full
    // duplex graduates past staging.
    var preRollFrames = [];
    // 8 frames ≈ 512ms at 1024 samples/16kHz — covers vadConfirm (6 frames
    // ≈ 384ms) plus margin, and bounds memory to ~16KB of Int16 PCM.
    var PRE_ROLL_MAX_FRAMES = 8;

    // VTID-03706: echo-aware noise gate state. MIRRORS the constants in
    // services/gateway/src/orb/live/duplex/full-duplex-gate.ts (DUPLEX_GATE)
    // — that module is the source of truth and a parity test fails the build
    // if these literals drift from it. This file is a plain IIFE served as a
    // static asset, so it cannot import them.
    var DUPLEX_OPEN_RMS = 0.05;
    var DUPLEX_CLOSE_RMS = 0.025;
    var DUPLEX_HANGOVER_MS = 400;
    var DUPLEX_AEC_WARMUP_MS = 250;
    var DUPLEX_BARGE_CONFIRM_FRAMES = 2;
    var duplexGateOpen = false;
    var duplexLastVoiceAt = 0;
    var duplexOpenFrames = 0;

    processor.onaudioprocess = function (e) {
      if (!_s.active) return;
      if (_s.voiceState === 'MUTED') return;

      var input = e.inputBuffer.getChannelData(0);

      // Compute RMS energy
      var sum = 0;
      for (var k = 0; k < input.length; k++) sum += input[k] * input[k];
      var rms = Math.sqrt(sum / input.length);

      // Barge-in detection — gate mic while model audio is playing.
      // Use audioPlaying (has 1s grace period) instead of checking scheduledSources
      // directly, because scheduledSources can be briefly empty between chunks
      // even though more audio is coming. The grace timer covers these gaps.
      var modelPlaying = _s.audioPlaying;

      // ---- VTID-03706: full-duplex path — the mic never closes ----------
      // Every callback emits a frame. What the gate decides is CONTENT, not
      // whether to transmit: real audio when the user is speaking, digital
      // silence when only AEC residue is present. Nova therefore always has
      // a continuous, correctly-timed stream to run its own turn detection
      // (and its own barge-in) against, which the old drop-everything gate
      // made structurally impossible.
      if (modelPlaying && _s.fullDuplex) {
        var nowMs = Date.now();
        var startedAt = _s.audioPlayStartedAt || 0;

        if (startedAt > 0 && (nowMs - startedAt) < DUPLEX_AEC_WARMUP_MS) {
          // AEC has not converged on this playback burst yet. Residue here is
          // not evidence of speech; treating it as such is exactly the
          // self-interrupt loop the old 0.015 threshold produced. Hold shut
          // and do NOT accumulate confirmation — but still send a frame, so
          // the upstream stream stays continuous.
          duplexGateOpen = false;
          duplexOpenFrames = 0;
          _sendAudio(_silentFrame(input.length));
          return;
        }

        if (duplexGateOpen) {
          // Sustain on the LOW threshold, close only after the hangover.
          // A single threshold chatters across the amplitude dips inside a
          // word and shreds the utterance Nova is trying to transcribe.
          if (rms > DUPLEX_CLOSE_RMS) {
            duplexLastVoiceAt = nowMs;
          } else if (nowMs - duplexLastVoiceAt >= DUPLEX_HANGOVER_MS) {
            duplexGateOpen = false;
          }
        } else if (rms > DUPLEX_OPEN_RMS) {
          duplexGateOpen = true;
          duplexLastVoiceAt = nowMs;
        }

        if (!duplexGateOpen) {
          duplexOpenFrames = 0;
          _sendAudio(_silentFrame(input.length));
          return;
        }

        // Gate is open: this is real speech. Forward it verbatim FIRST, so
        // the audio reaches Nova from this very frame regardless of what the
        // local confirmation below decides.
        //
        // Confirmation counts VOICED frames only. The gate stays open through
        // the hangover with no energy in it; counting those would let a
        // single loud transient (cough, door slam) reach the threshold purely
        // by the hangover ticking over in silence. Hangover frames neither
        // add nor reset, so a mid-word dip does not restart confirmation.
        // MIRRORS evaluateDuplexGateFrame() in full-duplex-gate.ts.
        if (rms > DUPLEX_CLOSE_RMS) duplexOpenFrames++;
        _s._lastSpeechAt = nowMs;
        _sendAudio(_encodeFrame(input));

        // Local playback stop is a LATENCY optimization, not the authority.
        // Nova's own INTERRUPTED event is what actually yields the turn; this
        // just makes the interruption FEEL instant (~128ms) instead of
        // waiting for the upstream round trip. Two frames rejects a
        // single-frame cough without adding meaningful delay.
        if (!vadInterruptSent && duplexOpenFrames >= DUPLEX_BARGE_CONFIRM_FRAMES) {
          vadInterruptSent = true;
          _s.audioQueue = [];
          for (var dq = 0; dq < _s.scheduledSources.length; dq++) {
            try { _s.scheduledSources[dq].stop(); } catch (ex) { /* ok */ }
          }
          _s.scheduledSources = [];
          _s.lastScheduledEnd = 0;
          _s.audioPlaying = false;
          _s.audioPlayStartedAt = 0;
          clearTimeout(_s.audioEndGraceTimer);
          _s.interruptPending = true;
          _sendInterrupt();
          _updateUI();
        }
        return;
      }
      // ---- end full-duplex path ----------------------------------------

      if (modelPlaying) {
        // BOOTSTRAP-ORB-BARGEIN: capture, don't discard. Encoding happens here
        // so the flush below can replay the exact frames the user spoke.
        preRollFrames.push(_encodeFrame(input));
        if (preRollFrames.length > PRE_ROLL_MAX_FRAMES) preRollFrames.shift();

        if (rms > vadThreshold) {
          vadFrames++;
          if (vadFrames >= vadConfirm && !vadInterruptSent) {
            vadInterruptSent = true;
            // Clear audio immediately
            _s.audioQueue = [];
            for (var i = 0; i < _s.scheduledSources.length; i++) {
              try { _s.scheduledSources[i].stop(); } catch (ex) { /* ok */ }
            }
            _s.scheduledSources = [];
            _s.lastScheduledEnd = 0;
            _s.audioPlaying = false;
            clearTimeout(_s.audioEndGraceTimer);
            _s.interruptPending = true;
            var _interruptAck = _sendInterrupt();

            // BOOTSTRAP-ORB-BARGEIN: flush the buffered speech upstream. THIS
            // is the audio that used to be thrown away. It goes out ahead of
            // the live stream so Nova receives the interruption from its first
            // syllable — which is also what lets Nova's own barge-in engage,
            // since sendEndOfTurn() is a documented no-op for Nova and never
            // stopped it. audioPlaying is now false, so the next frame onward
            // flows through the normal live path below.
            _flushPreRollOrdered(preRollFrames, _interruptAck);
            preRollFrames = [];
          }
        } else {
          vadFrames = 0;
        }
        // Still gated while Vitana speaks — deliberate, see the PRE_ROLL
        // comment: forwarding sub-threshold frames would feed AEC echo to
        // Nova's VAD. The difference is the audio is now buffered, not lost.
        return;
      } else {
        vadFrames = 0;
        vadInterruptSent = false;
        preRollFrames = [];
        // VTID-03706: reset the duplex gate between playback bursts, so the
        // next turn starts closed and re-earns its open rather than
        // inheriting the tail of the previous utterance.
        duplexGateOpen = false;
        duplexOpenFrames = 0;
        duplexLastVoiceAt = 0;
        // Record real user speech so the listening-idle nudge timer can
        // defer itself instead of beeping over the user mid-sentence.
        if (rms > vadThreshold) {
          _s._lastSpeechAt = Date.now();
        }
      }

      // Post-turn cooldown (200ms) — server-side turn_complete.
      // BOOTSTRAP-ORB-LATENCY-PHASE1: 500→200ms — every ms here is dead air
      // where the user's speech is silently dropped; AEC + the playback-end
      // echo gate below carry the echo protection.
      //
      // VTID-03706: both cooldowns are skipped under full duplex. They are
      // blanket time windows that discard whatever the user says in them,
      // and their entire job — keeping draining playback echo out of the
      // upstream — is now done per-frame by the gate above, which can tell
      // echo and speech apart instead of muting both.
      if (!_s.fullDuplex && _s.turnCompleteAt > 0 && (Date.now() - _s.turnCompleteAt) < 200) return;

      // Client-side echo cooldown (200ms) — after audio playback actually ends.
      // The server's POST_TURN_COOLDOWN_MS starts when Vertex sends turn_complete,
      // but the client may still be playing buffered audio 1-3s later. This cooldown
      // starts when the LAST audio source actually finishes playing on the client.
      // BOOTSTRAP-ORB-LATENCY-PHASE1: 500→200ms (see above).
      if (!_s.fullDuplex && _s.lastAudioEndTime > 0 && (Date.now() - _s.lastAudioEndTime) < 200) return;

      _sendAudio(_encodeFrame(input));
    };

    source.connect(processor);
    processor.connect(ctx.destination);
    _s.captureProcessor = processor;
  }

  /**
   * Float32 mic frame → Int16 PCM → base64, the wire format the gateway
   * expects (audio/pcm;rate=16000).
   *
   * BOOTSTRAP-ORB-BARGEIN: extracted from the capture handler so the barge-in
   * pre-roll buffer stores already-encoded frames and can replay them
   * byte-identically. Encoding at capture time also means the buffer holds a
   * stable copy — `e.inputBuffer` is reused by the Web Audio graph, so
   * retaining the raw Float32Array would alias into the next callback's data.
   */
  /**
   * VTID-03706: a base64 Int16 PCM frame of pure silence, same length as a
   * real capture frame.
   *
   * This is what makes "the mic is always open" safe. During playback,
   * sub-threshold frames are replaced by this rather than dropped: Nova keeps
   * receiving a continuous, correctly-timed stream (so its turn detection and
   * native barge-in stay live) while the AEC residue that would make it
   * interrupt ITSELF never reaches it.
   *
   * Cached by length — frame size is fixed for a session, so this allocates
   * and base64-encodes once rather than on every 64ms callback.
   */
  var _silentFrameCache = {};
  function _silentFrame(sampleCount) {
    var hit = _silentFrameCache[sampleCount];
    if (hit) return hit;
    var u8 = new Uint8Array(sampleCount * 2); // Int16 zeros === digital silence
    var b64 = btoa(String.fromCharCode.apply(null, u8));
    _silentFrameCache[sampleCount] = b64;
    return b64;
  }

  function _encodeFrame(input) {
    var pcm = new Int16Array(input.length);
    for (var n = 0; n < input.length; n++) {
      var s = Math.max(-1, Math.min(1, input[n]));
      pcm[n] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    var u8 = new Uint8Array(pcm.buffer);
    return btoa(String.fromCharCode.apply(null, u8));
  }

  /**
   * BOOTSTRAP-ORB-BARGEIN (Codex review on #3006): ordered-send gate for the
   * HTTP/SSE transport.
   *
   * On the DEFAULT transport (transport:'sse', orb-widget.js:154) every frame
   * is its own fire-and-forget `fetch`, and so is the interrupt. There is no
   * ordering guarantee between them. That breaks the pre-roll flush two ways:
   *
   *  1. If a buffered frame reaches the gateway BEFORE the interrupt is
   *     processed, `session.isModelSpeaking` is still true and
   *     live-session-controller.ts:2270 returns
   *     `{dropped:true, reason:'model_speaking'}` — the exact audio this fix
   *     exists to preserve, silently discarded server-side.
   *  2. The burst of parallel POSTs has no mutual ordering, so surviving
   *     frames can arrive scrambled, and live frames (fired immediately once
   *     playback stops) can overtake the buffered ones entirely.
   *
   * While this is non-null, audio sends chain onto it instead of racing. It is
   * armed at barge-in with the interrupt's own promise, so nothing is sent
   * until the gateway has acknowledged the interrupt and ungated the mic, and
   * it is cleared once drained so steady-state sending returns to parallel
   * fire-and-forget (no added latency outside the barge-in window).
   *
   * The WS transport does not need this — a socket is ordered by definition.
   */
  var _httpSendChain = null;

  function _sendAudio(b64) {
    if (!_s.sessionId || !_s.active) return Promise.resolve();
    // Ordered window (HTTP only): append rather than race.
    if (!_s.ws && _httpSendChain) {
      _httpSendChain = _httpSendChain.then(function () {
        return _sendAudioNow(b64);
      });
      return _httpSendChain;
    }
    return _sendAudioNow(b64);
  }

  /**
   * BOOTSTRAP-ORB-BARGEIN: arm the ordered window. Buffered frames are sent
   * strictly after `gate` resolves (the interrupt round-trip) and strictly in
   * order; live frames captured meanwhile chain behind them via _sendAudio.
   */
  function _flushPreRollOrdered(frames, gate) {
    if (!frames.length) return;
    if (_s.ws) {
      // Socket preserves order and the gateway's WS interrupt handler runs
      // before subsequent frames — send directly.
      for (var i = 0; i < frames.length; i++) _sendAudioNow(frames[i]);
      return;
    }
    var chain = gate || Promise.resolve();
    frames.forEach(function (f) {
      chain = chain.then(function () { return _sendAudioNow(f); });
    });
    _httpSendChain = chain;
    // Release the ordered window once this burst has drained, so normal
    // parallel sending resumes. Guarded so a later barge-in that re-arms the
    // chain isn't torn down by an older burst finishing.
    var mine = chain;
    chain.then(function () {
      if (_httpSendChain === mine) _httpSendChain = null;
    }, function () {
      if (_httpSendChain === mine) _httpSendChain = null;
    });
  }

  function _sendAudioNow(b64) {
    if (!_s.sessionId || !_s.active) return Promise.resolve();
    // BOOTSTRAP-ORB-LATENCY-PHASE3: WS transport — one frame on the open
    // socket instead of a full HTTP request per 64ms chunk.
    if (_s.ws) {
      if (_s.ws.readyState === 1) {
        try {
          _s.ws.send(JSON.stringify({ type: 'audio', data_b64: b64, mime: 'audio/pcm;rate=16000' }));
          _s._audioSendFailCount = 0;
        } catch (e) { _registerAudioSendFailure(); }
      }
      // never fall through to HTTP while WS transport owns the session
      return Promise.resolve();
    }
    var headers = { 'Content-Type': 'application/json' };
    if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;
    // BOOTSTRAP-ORB-BARGEIN: the promise is RETURNED so the ordered-send gate
    // can chain on it. Steady-state callers still ignore it (fire-and-forget).
    return fetch(_cfg.gw + '/api/v1/orb/live/stream/send?session_id=' + _s.sessionId, {
      method: 'POST', headers: headers,
      body: JSON.stringify({ type: 'audio', data_b64: b64, mime: 'audio/pcm;rate=16000' })
    }).then(function (r) {
      if (r.ok) {
        _s._audioSendFailCount = 0;
        return;
      }
      // VTID-02034b: 404 means this Cloud Run instance doesn't hold our
      // session — the gateway's liveSessions Map is in-memory + per-instance
      // and Cloud Run round-robins. The network is fine; we just hit the
      // wrong instance. Trigger a silent re-register instead of firing the
      // user-visible "internet issues" disconnect alert. _handleStaleSessionInstance
      // bounds this so a degenerate 404-storm still surfaces normally.
      if (r.status === 404) {
        _handleStaleSessionInstance();
        return;
      }
      if (!_s._audioSendErrorLogged) {
        _s._audioSendErrorLogged = true;
        console.error('[VTOrb] Audio send failed: HTTP ' + r.status);
      }
      _registerAudioSendFailure();
    }).catch(function (err) {
      if (!_s._audioSendErrorLogged) {
        _s._audioSendErrorLogged = true;
        console.error('[VTOrb] Audio send error:', err.message);
      }
      _registerAudioSendFailure();
    });
  }

  // VTID-02034b: handle a 404 from /live/stream/send (the request landed
  // on a Cloud Run gateway instance that doesn't hold our session) by
  // silently re-registering the session on whatever instance answers next.
  // The widget's normal _registerAudioSendFailure path can't tell a stale-
  // instance 404 apart from a real network failure, so it would fire the
  // "internet issues" alert + tear down the conversation on every cross-
  // instance round-robin hop. This carve-out keeps the conversation alive
  // through the round-robin, while still falling through to the real
  // disconnect flow if every instance keeps returning 404 (the budget is
  // SILENT_REREGISTER_MAX in SILENT_REREGISTER_WINDOW_MS).
  //
  // The proper fix is a shared liveSessions store (Redis/Supabase) so any
  // gateway instance can serve any session — see the VTID-02036 revert
  // note. This client-side carve-out is the minimal change that stops
  // the user-visible loop until that lands.
  var SILENT_REREGISTER_MAX = 2;
  var SILENT_REREGISTER_WINDOW_MS = 30000;
  function _handleStaleSessionInstance() {
    if (_s._disconnectActive) return;
    if (_s._silentReregisterPending) return;
    var now = Date.now();
    if (now - _s._silentReregisterWindowStart > SILENT_REREGISTER_WINDOW_MS) {
      _s._silentReregisterWindowStart = now;
      _s._silentReregisterCount = 0;
    }
    if (_s._silentReregisterCount >= SILENT_REREGISTER_MAX) {
      // Budget exhausted — every instance is returning 404. Fall through to
      // the user-visible disconnect path so the user knows something is up.
      console.warn('[VTOrb] silent re-register budget exhausted ('
        + _s._silentReregisterCount + '/' + SILENT_REREGISTER_MAX
        + ') — surfacing as network disconnect');
      _announceDisconnect('network');
      return;
    }
    _s._silentReregisterCount++;
    _s._silentReregisterPending = true;
    console.warn('[VTOrb] /live/stream/send → 404 (cross-instance) — '
      + 'silent re-register #' + _s._silentReregisterCount
      + '/' + SILENT_REREGISTER_MAX);
    // Suppress audio-send error spam during the re-register so a burst of
    // in-flight 404s on already-queued chunks doesn't pollute the console.
    _s._audioSendErrorLogged = true;
    try { _resetAndReconnect(); } catch (e) {
      console.error('[VTOrb] _resetAndReconnect threw during silent re-register:', e && e.message);
    }
    // Clear the pending flag after a short cooldown so a follow-up 404
    // burst (very common while _resetAndReconnect is in flight) collapses
    // into a single re-register, but a genuinely stuck state can still
    // increment the counter and eventually exhaust the budget.
    setTimeout(function () { _s._silentReregisterPending = false; }, 5000);
  }

  // Debounced trigger: only alert on the 2nd failure within a 3s window to
  // avoid false positives from a single transient 5xx.
  function _registerAudioSendFailure() {
    if (_s._disconnectActive) return;
    var now = Date.now();
    if (now - _s._audioSendFailWindowStart > 3000) {
      _s._audioSendFailWindowStart = now;
      _s._audioSendFailCount = 1;
      return;
    }
    _s._audioSendFailCount++;
    if (_s._audioSendFailCount >= 2) {
      _announceDisconnect('network');
    }
  }

  function _sendInterrupt() {
    if (!_s.sessionId || !_s.active) return Promise.resolve();
    // BOOTSTRAP-ORB-LATENCY-PHASE3: WS transport branch.
    if (_s.ws) {
      try { if (_s.ws.readyState === 1) _s.ws.send(JSON.stringify({ type: 'interrupt' })); } catch (e) { /* noop */ }
      return Promise.resolve();
    }
    var headers = { 'Content-Type': 'application/json' };
    if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;
    // BOOTSTRAP-ORB-BARGEIN: RETURNED and resolved-on-settle so the pre-roll
    // flush can wait for the gateway to actually ungate the mic
    // (live-session-controller sets isModelSpeaking=false in this handler).
    // Resolves even on failure — a dropped interrupt must not wedge the queue.
    return fetch(_cfg.gw + '/api/v1/orb/live/stream/send?session_id=' + _s.sessionId, {
      method: 'POST', headers: headers,
      body: JSON.stringify({ type: 'interrupt' })
    }).then(function () {}, function () {});
  }

  // ============================================================
  // 9. WATCHDOGS
  // ============================================================

  // Thinking progress: reassure user during long processing (memory search, slow network).
  // Warm, casual copy (VTID-03449) instead of technical wording; no visible elapsed-time
  // counter — that drew attention to the wait instead of reassuring the user.
  //
  // VTID-03451 fix: a single fixed opener shown immediately on every turn (plus a
  // narrative-ordered rotation that mostly kept the same 2nd message) made most real
  // turns — which resolve well under the old 4s-to-first-rotation delay — show the
  // exact same 1-2 lines every single time ("Let me think... / Checking what I
  // remember..."). All lines now live in one pool, freshly shuffled per turn, with a
  // guard against repeating the previous turn's opening line back-to-back.
  var _THINKING_QUICK = [
    { en: 'Let me think…', de: 'Lass mich kurz überlegen…', es: 'Déjame pensar…', sr: 'Daj da razmislim…', fr: 'Laisse-moi réfléchir…', pt: 'Deixa-me pensar…', ru: 'Дай подумать…', pl: 'Daj mi się zastanowić…', zh: '让我想想…', ar: 'دعني أفكر…', tr: 'Bir düşüneyim…' },
    { en: 'Let me take a look…', de: 'Lass mich das kurz prüfen…', es: 'Déjame echar un vistazo…', sr: 'Daj da pogledam…', fr: 'Laisse-moi jeter un œil…', pt: 'Deixa-me dar uma vista de olhos…', ru: 'Дай взгляну…', pl: 'Daj mi rzucić okiem…', zh: '让我看看…', ar: 'دعني ألقي نظرة…', tr: 'Bir bakayım…' },
    { en: 'One sec…', de: 'Eine Sekunde…', es: 'Un segundo…', sr: 'Sekundu…', fr: 'Une seconde…', pt: 'Um segundo…', ru: 'Секунду…', pl: 'Sekundkę…', zh: '一秒钟…', ar: 'لحظة واحدة…', tr: 'Bir saniye…' },
    { en: 'Alright, hang on…', de: 'Alles klar, einen Moment…', es: 'Bien, espera un momento…', sr: 'Dobro, sačekaj malo…', fr: "D'accord, attends…", pt: 'Ok, espera aí…', ru: 'Хорошо, подожди…', pl: 'Dobrze, chwileczkę…', zh: '好的，稍等一下…', ar: 'حسنًا، لحظة من فضلك…', tr: 'Tamam, bekle…' },
    { en: 'Let’s see…', de: 'Mal sehen…', es: 'A ver…', sr: 'Da vidimo…', fr: 'Voyons voir…', pt: 'Vamos ver…', ru: 'Посмотрим…', pl: 'Zobaczmy…', zh: '让我看看情况…', ar: 'لنرَ…', tr: 'Bakalım…' },
    { en: 'Give me a beat…', de: 'Kurz einen Moment…', es: 'Dame un momento…', sr: 'Daj mi trenutak…', fr: 'Laisse-moi un instant…', pt: 'Dá-me só um instante…', ru: 'Дай мне момент…', pl: 'Daj mi chwilę…', zh: '给我一点时间…', ar: 'امنحني لحظة…', tr: 'Bana bir an ver…' }
  ];
  var _THINKING_PRIMARY = [
    { en: 'Checking what I remember…', de: 'Ich schau nach, was ich weiß…', es: 'Reviso lo que recuerdo…', sr: 'Proveravam šta se sećam…', fr: 'Je vérifie ce dont je me souviens…', pt: 'Estou a verificar o que sei…', ru: 'Проверяю, что я помню…', pl: 'Sprawdzam, co pamiętam…', zh: '我在回想一下…', ar: 'أتحقق مما أتذكره…', tr: 'Hatırladıklarımı kontrol ediyorum…' },
    { en: 'Connecting the dots…', de: 'Ich verbinde die Punkte…', es: 'Uniendo las piezas…', sr: 'Povezujem stvari…', fr: 'Je fais le lien…', pt: 'A juntar as peças…', ru: 'Соединяю всё вместе…', pl: 'Łączę fakty…', zh: '我在把线索串起来…', ar: 'أربط الأمور ببعضها…', tr: 'Noktaları birleştiriyorum…' },
    { en: 'Putting it all together…', de: 'Ich füg alles zusammen…', es: 'Poniendo todo junto…', sr: 'Slažem sve zajedno…', fr: 'Je mets tout en ordre…', pt: 'A juntar tudo…', ru: 'Собираю всё воедино…', pl: 'Składam to wszystko w całość…', zh: '我在整理一下…', ar: 'أجمّع كل شيء معًا…', tr: 'Her şeyi bir araya getiriyorum…' },
    { en: 'Just making sure I get it right…', de: 'Ich will sichergehen, dass es passt…', es: 'Solo quiero asegurarme de entenderlo bien…', sr: 'Samo hoću da budem siguran da je tačno…', fr: 'Je veux juste être sûr de bien comprendre…', pt: 'Só quero ter a certeza de que percebi bem…', ru: 'Просто хочу удостовериться, что всё правильно…', pl: 'Chcę się tylko upewnić, że dobrze rozumiem…', zh: '我想确认一下有没有理解对…', ar: 'أريد فقط التأكد من أنني فهمت الأمر بشكل صحيح…', tr: 'Doğru anladığımdan emin oluyorum…' },
    { en: 'Almost ready ✨', de: 'Gleich fertig ✨', es: 'Casi listo ✨', sr: 'Skoro gotovo ✨', fr: 'Presque prêt ✨', pt: 'Quase pronto ✨', ru: 'Почти готово ✨', pl: 'Prawie gotowe ✨', zh: '马上就好 ✨', ar: 'على وشك الانتهاء ✨', tr: 'Neredeyse hazır ✨' },
    { en: 'Still with you…', de: 'Bin noch dabei…', es: 'Sigo aquí…', sr: 'Još uvek sam tu…', fr: 'Toujours avec toi…', pt: 'Continuo aqui contigo…', ru: 'Я всё ещё здесь…', pl: 'Wciąż tu jestem…', zh: '我还在这里…', ar: 'ما زلت معك…', tr: 'Hâlâ seninleyim…' },
    { en: 'Got it — here we go!', de: 'Alles klar, es geht los!', es: 'Listo, ¡allá vamos!', sr: 'Evo ga, krećemo!', fr: "C'est bon, on y va !", pt: 'Pronto, cá vamos nós!', ru: 'Готово — поехали!', pl: 'Mam to — zaczynamy!', zh: '好了，我们开始吧！', ar: 'تمام، ها نحن ننطلق!', tr: 'Tamamdır — işte başlıyoruz!' }
  ];
  var _THINKING_ALTERNATES = [
    { en: 'On it…', de: 'Bin dran…', es: 'Voy con eso…', sr: 'Radim na tome…', fr: "Je m'en occupe…", pt: 'Estou nisso…', ru: 'Уже занимаюсь…', pl: 'Już się tym zajmuję…', zh: '我在处理了…', ar: 'أنا أعمل على ذلك…', tr: 'Hallediyorum…' },
    { en: 'Give me a tiny moment…', de: 'Gib mir einen kleinen Moment…', es: 'Dame un momentito…', sr: 'Daj mi mali trenutak…', fr: 'Laisse-moi un tout petit instant…', pt: 'Dá-me só um bocadinho…', ru: 'Дай мне буквально секунду…', pl: 'Daj mi malutką chwilkę…', zh: '再给我一小会儿…', ar: 'أمهلني لحظة صغيرة…', tr: 'Bana ufak bir an ver…' },
    { en: 'Let me look into that…', de: 'Ich schau mir das an…', es: 'Voy a revisar eso…', sr: 'Da to proverim…', fr: 'Je regarde ça…', pt: 'Vou verificar isso…', ru: 'Дай-ка я это проверю…', pl: 'Sprawdzę to…', zh: '我来看看这个…', ar: 'دعني أبحث في ذلك…', tr: 'Şuna bir bakayım…' },
    { en: 'Doing a little detective work…', de: 'Ich spiel kurz Detektiv…', es: 'Haciendo un poco de trabajo detectivesco…', sr: 'Malo detektivskog posla…', fr: 'Un peu de travail de détective…', pt: 'A fazer um pouco de trabalho de detetive…', ru: 'Провожу небольшое расследование…', pl: 'Trochę detektywistycznej roboty…', zh: '我在小小地侦查一下…', ar: 'أقوم ببعض العمل التحقيقي…', tr: 'Biraz dedektiflik yapıyorum…' },
    { en: 'Looking in the right places…', de: 'Ich schau an den richtigen Stellen…', es: 'Buscando en los lugares correctos…', sr: 'Tražim na pravim mestima…', fr: 'Je cherche au bon endroit…', pt: 'A procurar nos sítios certos…', ru: 'Ищу в нужных местах…', pl: 'Szukam we właściwych miejscach…', zh: '我在正确的地方找找看…', ar: 'أبحث في الأماكن الصحيحة…', tr: 'Doğru yerlere bakıyorum…' },
    { en: 'Still working my magic…', de: 'Ich zaubere noch…', es: 'Sigo haciendo mi magia…', sr: 'Još uvek čarolija u toku…', fr: 'Je fais encore ma petite magie…', pt: 'Ainda a fazer a minha magia…', ru: 'Всё ещё колдую…', pl: 'Wciąż czaruję…', zh: '我还在施展我的小魔法…', ar: 'ما زلت أصنع سحري…', tr: 'Hâlâ sihrimi konuşturuyorum…' },
    { en: 'One more moment…', de: 'Noch ein Moment…', es: 'Un momento más…', sr: 'Još jedan trenutak…', fr: 'Encore un instant…', pt: 'Mais um momentinho…', ru: 'Ещё чуть-чуть…', pl: 'Jeszcze chwilka…', zh: '再等一下下…', ar: 'لحظة أخرى فقط…', tr: 'Bir an daha…' },
    { en: 'Nearly there…', de: 'Fast geschafft…', es: 'Ya casi…', sr: 'Skoro sam stigao…', fr: 'Presque fini…', pt: 'Está quase…', ru: 'Почти готово…', pl: 'Już prawie…', zh: '马上就好了…', ar: 'أوشكت على الانتهاء…', tr: 'Neredeyse tamam…' }
  ];
  var _THINKING_ALL = _THINKING_QUICK.concat(_THINKING_PRIMARY, _THINKING_ALTERNATES);

  function _shuffled(arr) {
    var out = arr.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  // Builds this turn's rotation queue: every message shuffled fresh, with the
  // first slot swapped away if it repeats the previous turn's opening line.
  function _buildThinkingQueue() {
    var queue = _shuffled(_THINKING_ALL);
    if (queue.length > 1 && queue[0].en === _s.lastThinkingFirstMsg) {
      var tmp = queue[0]; queue[0] = queue[1]; queue[1] = tmp;
    }
    _s.lastThinkingFirstMsg = queue[0].en;
    return queue;
  }

  function _startThinkingProgress() {
    clearInterval(_s.thinkingProgressTimer);
    var queue = _buildThinkingQueue();
    // Show the first message immediately — most turns resolve before the first
    // rotation tick, so this (not the interval) is what users actually see.
    _setStatus(_loc(queue[0]));
    var msgIndex = 0;
    _s.thinkingProgressTimer = setInterval(function () {
      if (_s.voiceState !== 'THINKING') {
        clearInterval(_s.thinkingProgressTimer);
        _s.thinkingProgressTimer = null;
        return;
      }
      var elapsed = Math.floor((Date.now() - _s.thinkingStartTime) / 1000);
      // Cycle through messages every 4 seconds
      msgIndex = Math.min(Math.floor(elapsed / 4), queue.length - 1);
      var msg = queue[msgIndex];
      _setStatus(_loc(msg));
    }, 3000);
  }

  // VTID-HEARTBEAT-FIX: Increased from 12s to 30s. Server now sends data
  // heartbeats every 10s that trigger onmessage and reset this watchdog.
  var WATCHDOG_TIMEOUT = 30000;

  function _startWatchdog() {
    _stopWatchdog();
    _s.clientLastActivityAt = Date.now();
    _s.clientWatchdogInterval = setInterval(function () {
      if (!_s.active) { _stopWatchdog(); return; }
      if (Date.now() - _s.clientLastActivityAt > WATCHDOG_TIMEOUT) {
        _stopWatchdog();
        // BOOTSTRAP-ORB-MODERN-RECOVERY: 30s of SSE silence while session is
        // active. Hand to _attemptReconnect — it owns the budget logic and
        // tap-to-reconnect fallback, so we never auto-_sessionStop here.
        console.warn('[VTOrb] Watchdog fired — attempting reconnect');
        _announceDisconnect('connection');
        _attemptReconnect();
      }
    }, 5000);
  }

  function _stopWatchdog() {
    if (_s.clientWatchdogInterval) {
      clearInterval(_s.clientWatchdogInterval);
      _s.clientWatchdogInterval = null;
    }
  }

  function _resetWatchdog() {
    _s.clientLastActivityAt = Date.now();
  }

  // ============================================================
  // BACKGROUND/IDLE WATCHDOG — mobile overheating fix
  // ============================================================
  //
  // This widget has no Page Visibility handling anywhere (no
  // visibilitychange/pagehide listeners). On some Appilix/Android WebView
  // builds `document.visibilityState` misreports "visible" even while the
  // app is backgrounded, so that API can't be trusted anyway. Detect real
  // OS-level throttling instead: schedule a timer for BG_CHECK_MS and check
  // how late it actually fires. A timer that drifts by more than
  // BG_KILL_DRIFT_MS was frozen/deprioritized for that long — which only
  // happens when the app is genuinely backgrounded — and is a reliable
  // signal independent of what the visibility API claims. On detection,
  // fully stop the session so the mic + audio pipeline don't keep running
  // hot in the user's pocket.
  var BG_CHECK_MS = 5000;
  var BG_KILL_DRIFT_MS = 30000;

  function _startBackgroundWatchdog() {
    _stopBackgroundWatchdog();
    var scheduledAt = Date.now();
    _s._bgWatchdogTimer = setTimeout(function () {
      var drift = Date.now() - scheduledAt - BG_CHECK_MS;
      if (drift > BG_KILL_DRIFT_MS) {
        console.warn('[VTOrb] Background watchdog: timer drifted ' + drift + 'ms — app was backgrounded, ending session');
        _setStatus(_caption('sessionEndedBackground'));
        _sessionStop();
        return;
      }
      // VTID-CODEX-REVIEW: gate on overlayVisible, not _s.active. _sessionStart's
      // handshake can take up to 8s (longer than one BG_CHECK_MS tick) before
      // _s.active flips true, and _s.active also drops false transiently during
      // reconnect gaps. Gating the reschedule on _s.active let the watchdog die
      // on its very first tick for any slow-but-successful open, or during a
      // reconnect window — exactly when background protection matters most.
      // overlayVisible spans the whole _show()...(_hide()/_sessionStop) window
      // regardless of handshake/reconnect state, same as the guards elsewhere
      // in this file (e.g. line ~905, ~997, ~3092).
      if (_s.overlayVisible) _startBackgroundWatchdog();
    }, BG_CHECK_MS);
  }

  function _stopBackgroundWatchdog() {
    if (_s._bgWatchdogTimer) {
      clearTimeout(_s._bgWatchdogTimer);
      _s._bgWatchdogTimer = null;
    }
  }

  // ============================================================
  // DEV-COMHU-0501 — ORB Recovery 0.1: cross-provider speaking-state watchdog
  // ============================================================
  //
  // VTID-03185 fixed the Vertex-path closure bug in _processQueue that left
  // _s.scheduledSources with stale entries → "Vitana speaking..." stuck on,
  // mic gated. LiveKit (community surface) uses WebRTC tracks rather than
  // scheduled BufferSources — a different lifecycle, but the SAME end-user
  // symptom can still occur through different mechanics (e.g. a subscribed
  // track that stops delivering frames without firing onended).
  //
  // This watchdog is transport-agnostic. It ticks every 500ms while
  // audioPlaying is true, and force-clears the speaking state when:
  //   - it has been >= QUIET_MS since the last inbound audio frame, AND
  //   - no BufferSources are still scheduled, AND
  //   - the playback queue is empty.
  // Under healthy multi-chunk TTS, frames keep arriving (lastAudioReceivedAt
  // refreshes) or sources stay scheduled, so the watchdog does NOT fire.
  var SPEAKING_WATCHDOG_QUIET_MS = 2000;
  var SPEAKING_WATCHDOG_TICK_MS = 500;

  function _speakingStateWatchdog() {
    if (!_s.audioPlaying) return;
    var quietFor = Date.now() - (_s.lastAudioReceivedAt || 0);
    var nothingScheduled = _s.scheduledSources.length === 0;
    var queueEmpty = _s.audioQueue.length === 0;
    if (quietFor >= SPEAKING_WATCHDOG_QUIET_MS && nothingScheduled && queueEmpty) {
      console.warn(
        '[VTOrb] speaking-state watchdog: forcing audioPlaying=false ' +
        '(quietFor=' + quietFor + 'ms, scheduled=0, queue=0)'
      );
      clearTimeout(_s.audioEndGraceTimer);
      _s.audioPlaying = false;
      _s.lastAudioEndTime = Date.now();
      // VTID-03740: everything above this comment only ever cleared the
      // INTERNAL audioPlaying flag — it never touched .vtorb-status or the
      // orb glow. A session whose upstream stream dies mid-turn (delivers
      // at least one audio chunk, then goes silent before turn_complete)
      // never gets a server turn_complete, so _waitForAudioEnd() (the only
      // other place that resets the visible state) never runs either.
      // Reported live: the pre-login MAXINA Intro orb visibly "spoke"
      // (caption "Vitana priča..." + amber glow) but stayed silent, stuck
      // that way for the rest of the session. Restore the VISIBLE state to
      // LISTENING here too, and re-arm the mic the same way the normal
      // turn-complete path does on a session's first turn (mic capture is
      // started exactly once, gated on !greetingComplete, then stays open
      // for the rest of the session under full duplex) — so recovery is
      // actually usable, not just cosmetic. Deliberately does NOT invoke
      // the host's turn-completion callback: this turn never genuinely
      // completed, and telling the host it did would reproduce the
      // VTID-03685 bug where a guided-topic "completed" drawer appeared
      // for a lesson that was never actually delivered.
      if (_s.voiceState === 'SPEAKING' && _s.active && !_isClosingForNav() &&
          !_s._userRequestedClose && _s.overlayVisible) {
        _s.voiceState = 'LISTENING';
        // VTID-03469: while audio is blocked the overlay shows the
        // tap-to-hear prompt — don't overwrite it with "Listening...".
        if (!_s._audioBlocked) {
          _setOrbState('listening');
          _setStatus(_caption('listening'));
        }
        if (!_s.greetingComplete) {
          _s.greetingComplete = true;
          _s._audioEverHeardThisOpen = true;
          _startAudioCapture().catch(function (err) {
            console.error('[VTOrb] Mic capture failed after stuck-speaking recovery:', err);
            _announceDisconnect('mic');
          });
        }
      }
      try { _updateUI(); } catch (e) { /* UI optional during teardown */ }
    }
  }

  function _startSpeakingWatchdog() {
    _stopSpeakingWatchdog();
    _s.speakingWatchdogInterval = setInterval(_speakingStateWatchdog, SPEAKING_WATCHDOG_TICK_MS);
  }

  function _stopSpeakingWatchdog() {
    if (_s.speakingWatchdogInterval) {
      clearInterval(_s.speakingWatchdogInterval);
      _s.speakingWatchdogInterval = null;
    }
  }

  // ============================================================
  // 10. UI RENDERING
  // ============================================================

  function _renderFab() {
    if (_fab) return;
    _fab = document.createElement('button');
    _fab.className = 'vtorb-fab';
    _fab.setAttribute('aria-label', 'Open Vitana Voice');
    _fab.addEventListener('click', function () {
      if (_s.overlayVisible) {
        _hide();
      } else {
        _show();
      }
    });
    document.body.appendChild(_fab);
  }

  function _renderOverlay() {
    if (_root) {
      console.log('[VTOrb] _renderOverlay: _root already exists, inDOM=' + document.body.contains(_root));
      return;
    }
    console.log('[VTOrb] _renderOverlay: creating overlay DOM');
    _root = document.createElement('div');
    _root.className = 'vtorb-overlay';
    _root.setAttribute('role', 'dialog');
    _root.setAttribute('aria-modal', 'true');
    // CRITICAL: Inline styles guarantee overlay works even if CSS injection fails
    _root.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9500;display:none;align-items:center;justify-content:center;flex-direction:column;background:rgba(10,12,20,0.92);backdrop-filter:blur(24px);';

    // ORB shell
    var shell = document.createElement('div');
    shell.className = 'vtorb-shell';
    shell.style.cssText = 'position:relative;width:50vmin;height:50vmin;max-width:320px;max-height:320px;display:flex;align-items:center;justify-content:center;';

    // Aura glow elements (real DOM — pseudo-elements require CSS injection which can fail)
    var auraInner = document.createElement('div');
    auraInner.className = 'vtorb-aura-inner';
    auraInner.style.cssText = 'position:absolute;inset:-20%;border-radius:50%;opacity:0;transition:opacity 0.6s;pointer-events:none;';
    shell.appendChild(auraInner);

    var auraOuter = document.createElement('div');
    auraOuter.className = 'vtorb-aura-outer';
    auraOuter.style.cssText = 'position:absolute;inset:-20%;border-radius:50%;opacity:0;transition:opacity 0.6s;pointer-events:none;';
    shell.appendChild(auraOuter);

    // Sphere (on top of auras)
    var orb = document.createElement('div');
    orb.className = 'vtorb-large';
    orb.style.cssText = 'width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 35% 35%,#7c8db5,#5a6a8a 50%,#3a4a6a 100%);box-shadow:inset -8px -8px 24px rgba(0,0,0,0.4),inset 4px 4px 12px rgba(255,255,255,0.08),0 0 60px rgba(90,110,150,0.3);position:relative;z-index:1;cursor:pointer;';
    // VTID-01987: always-on tap-to-reconnect during ANY disconnect state, not
    // just budget-exhausted "stuck". On mobile, users tap the orb the moment
    // they see the "internet issues" message — making them wait for the 5s
    // health probe is bad UX. Any tap while _disconnectActive forces an
    // immediate fresh-session restart in place. We still gate this so taps
    // during a healthy session don't interrupt a live conversation.
    orb.addEventListener('click', function () {
      if (_s._disconnectActive || _s._disconnectStuck) _resetAndReconnect();
    });
    shell.appendChild(orb);
    _root.appendChild(shell);

    // Status
    var status = document.createElement('div');
    status.className = 'vtorb-status';
    status.style.cssText = 'margin-top:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:19px;color:rgba(255,255,255,0.6);text-align:center;min-height:26px;';
    _root.appendChild(status);

    // Controls
    var controls = document.createElement('div');
    controls.className = 'vtorb-controls';
    controls.style.cssText = 'display:flex;gap:20px;margin-top:40px;align-items:center;justify-content:center;';

    var micBtn = document.createElement('button');
    micBtn.className = 'vtorb-btn vtorb-btn-mic';
    micBtn.style.cssText = 'width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:rgba(59,130,246,0.2);color:#93c5fd;';
    micBtn.innerHTML = _ICONS.mic;
    micBtn.setAttribute('aria-label', 'Toggle microphone');
    micBtn.addEventListener('click', _toggleMute);
    controls.appendChild(micBtn);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'vtorb-btn vtorb-btn-close';
    closeBtn.style.cssText = 'width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7);';
    closeBtn.innerHTML = _ICONS.close;
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', _hide);
    controls.appendChild(closeBtn);

    _root.appendChild(controls);
    document.body.appendChild(_root);
  }

  // Aura color definitions — applied via inline styles on real DOM elements
  var _AURA = {
    connecting: { inner: 'rgba(226,232,240,0.4)', iOp: 0.4 },
    thinking:   { inner: 'rgba(139,92,246,0.5)',  iOp: 0.5, outer: 'rgba(139,92,246,0.3)', oOp: 0.4 },
    speaking:   { inner: 'rgba(245,158,11,0.5)',  iOp: 0.6, outer: 'rgba(245,158,11,0.3)', oOp: 0.4 },
    listening:  { inner: 'rgba(59,130,246,0.5)',   iOp: 0.5, outer: 'rgba(59,130,246,0.3)', oOp: 0.4 },
    paused:     { inner: 'rgba(107,114,128,0.3)',  iOp: 0.3 },
    error:      { inner: 'rgba(239,68,68,0.4)',    iOp: 0.5 },
    offline:    { inner: 'rgba(107,114,128,0.3)',  iOp: 0.3 }  // VTID-OFFLINE: Grey dimmed aura
  };

  function _setOrbState(state) {
    if (!_root) return;
    var shell = _root.querySelector('.vtorb-shell');
    if (!shell) return;

    // Apply aura colors via inline styles on real DOM elements
    var inner = shell.querySelector('.vtorb-aura-inner');
    var outer = shell.querySelector('.vtorb-aura-outer');
    var a = _AURA[state] || { inner: 'transparent', iOp: 0 };
    if (inner) {
      inner.style.background = 'radial-gradient(circle, ' + a.inner + ' 0%, transparent 70%)';
      inner.style.opacity = String(a.iOp);
    }
    if (outer) {
      if (a.outer) {
        outer.style.background = 'radial-gradient(circle, ' + a.outer + ' 0%, transparent 70%)';
        outer.style.opacity = String(a.oOp);
      } else {
        outer.style.background = 'none';
        outer.style.opacity = '0';
      }
    }

    // Keep CSS class toggle as enhancement (animations if CSS loads)
    var states = ['listening', 'thinking', 'speaking', 'paused', 'connecting', 'error', 'offline'];
    states.forEach(function (s) { shell.classList.remove('vtorb-st-' + s); });
    shell.classList.add('vtorb-st-' + state);

    // Update sphere appearance for muted state
    var orb = shell.querySelector('.vtorb-large');
    if (orb) {
      if (state === 'paused' || state === 'offline') {
        orb.style.opacity = '0.6';
        orb.style.filter = 'grayscale(40%)';
      } else {
        orb.style.opacity = '1';
        orb.style.filter = 'none';
      }
    }
  }

  // Status text color map — applied inline
  var _STATUS_COLOR = {
    LISTENING: 'rgba(59,130,246,0.8)',   // blue
    THINKING:  'rgba(139,92,246,0.8)',   // purple
    SPEAKING:  'rgba(245,158,11,0.8)',   // amber
  };

  function _setStatus(text) {
    if (!_root) return;
    var el = _root.querySelector('.vtorb-status');
    if (!el) return;
    el.textContent = text || '';
    // Apply color inline (no CSS dependency)
    el.style.color = _STATUS_COLOR[_s.voiceState] || (_s.liveError ? 'rgba(239,68,68,0.8)' : 'rgba(255,255,255,0.6)');
  }

  function _updateUI() {
    // Update mic button
    if (!_root) return;
    var micBtn = _root.querySelector('.vtorb-btn-mic');
    if (micBtn) {
      var muted = _s.voiceState === 'MUTED';
      micBtn.innerHTML = muted ? _ICONS.micOff : _ICONS.mic;
      // Apply muted style inline (no CSS dependency)
      micBtn.style.background = muted ? 'rgba(239,68,68,0.2)' : 'rgba(59,130,246,0.2)';
      micBtn.style.color = muted ? '#fca5a5' : '#93c5fd';
      // VTID-03706: under full duplex the mic is genuinely still open while
      // Vitana speaks. This class used to drive a visual ring (removed,
      // VTID-03745 — reported as an unwanted visual distraction); kept as a
      // hook (currently styleless) rather than deleted outright, so a state
      // consumer can still tell full-duplex-live apart from idle/muted
      // without re-deriving it from _s.fullDuplex/_s.audioPlaying.
      micBtn.classList.toggle('vtorb-mic-live', !muted && !!_s.fullDuplex && !!_s.audioPlaying);
    }
    // Update FAB visibility
    if (_fab) {
      _fab.classList.toggle('vtorb-hidden', _s.overlayVisible);
    }
  }

  // ============================================================
  // 11. CONTROLS
  // ============================================================

  function _toggleMute() {
    if (_s.voiceState === 'MUTED') {
      // Unmute — restore to the state we were in before muting.
      // If model is still playing audio, go back to SPEAKING (not LISTENING)
      // to avoid barge-in from speaker echo.
      var restoreTo = _s.preMuteState || 'LISTENING';
      // If audio is still playing, force SPEAKING regardless of saved state
      if (_s.audioPlaying) restoreTo = 'SPEAKING';
      _s.preMuteState = null;
      _s.voiceState = restoreTo;
      if (restoreTo === 'SPEAKING') {
        _setOrbState('speaking');
        _setStatus(_caption('speaking'));
      } else {
        _setOrbState('listening');
        _setStatus(_caption('listening'));
      }
    } else {
      // Mute — remember current state so we can restore it
      _s.preMuteState = _s.voiceState;
      _s.voiceState = 'MUTED';
      _setOrbState('paused');
      _setStatus(_caption('muted'));
    }
    _updateUI();
  }

  // Refresh auth token from localStorage — ALWAYS re-read on every _show().
  // User may have logged in, logged out, or switched accounts since last session.
  // Only skip if init() explicitly passed authToken (tracked by _tokenSetByInit).
  var _tokenSetByInit = false;

  // DEV-COMHU-0502 (review fix): last authenticated JWT subject seen by
  // setAuth, used to detect account switches. Null until first authed setAuth.
  var _lastAuthSub = null;

  // DEV-COMHU-0502 (review fix): wipe all identity-bound in-memory continuity
  // so it cannot leak across a logout or account switch. Shared by setAuth
  // (on detected identity change) and clearAuth (on logout).
  function _wipeIdentityBoundState() {
    _s._transcriptHistory = [];
    _s.conversationId = null;
    _s._preDisconnectStage = null;
    _s._reconnectCount = 0;
  }

  function _refreshToken() {
    if (_tokenSetByInit) return; // Explicit init() token — don't override
    try {
      // Priority: Supabase native key FIRST (managed by auth SDK, always current).
      // vitana.authToken is legacy Command Hub key — may be stale from a different user.

      // 1. Supabase native key (Lovable community app)
      var sbKey = Object.keys(localStorage).find(function (k) {
        return k.startsWith('sb-') && k.endsWith('-auth-token');
      });
      if (sbKey) {
        var sbData = localStorage.getItem(sbKey);
        if (sbData) {
          try {
            var parsed = JSON.parse(sbData);
            // Supabase session check: user must exist and session must not be expired
            if (!parsed.user || !parsed.user.id) {
              console.log('[VTOrb] Supabase key has no user — logged out, treating as anonymous');
              // Fall through to clear token below
            } else if (parsed.expires_at && parsed.expires_at * 1000 < Date.now()) {
              console.log('[VTOrb] Supabase session expired (expires_at) — treating as anonymous');
              // Fall through to clear token below
            } else {
              // Supabase v2 stores { access_token, refresh_token, user, ... }
              var token = parsed.access_token || parsed.token || '';
              if (token && !_isTokenExpired(token)) {
                _cfg.token = token;
                console.log('[VTOrb] Auth from Supabase key: ' + sbKey + ', user=' + (parsed.user?.id || 'unknown').substring(0, 8));
                return;
              }
              if (token) console.log('[VTOrb] Supabase token expired — treating as anonymous');
            }
          } catch (_) {
            // Not JSON — might be raw token
            if (sbData && !_isTokenExpired(sbData)) {
              _cfg.token = sbData;
              console.log('[VTOrb] Auth from Supabase key (raw): ' + sbKey);
              return;
            }
          }
        }
      }

      // 2. Command Hub custom key (fallback — only if no Supabase key found)
      var t = localStorage.getItem('vitana.authToken');
      if (t && !_isTokenExpired(t)) {
        _cfg.token = t;
        console.log('[VTOrb] Auth from vitana.authToken (Command Hub fallback)');
        return;
      }

      // No token found — anonymous session
      _cfg.token = '';
      console.log('[VTOrb] No auth token found — anonymous session');
    } catch (e) {
      console.warn('[VTOrb] Token refresh error:', e);
    }
  }

  function _show() {
    console.log('[VTOrb] _show() called — gw=' + _cfg.gw + ', _root=' + !!_root);
    // VTID-03292 (#3): an explicit user re-open clears the hard-close flag so the
    // session can start again. This is the ONLY place it is cleared.
    _s._userRequestedClose = false;
    _suppressSoundscape();
    // Refresh token and language on every show — picks up login/logout and language change
    _refreshToken();
    try {
      var storedLang = localStorage.getItem('vitana.lang');
      if (storedLang) _cfg.lang = storedLang.split('-')[0];
    } catch (e) { /* ignore */ }
    if (!_cfg.gw) {
      console.error('[VTOrb] No gateway URL — call VitanaOrb.init({gatewayUrl}) or load this script from the gateway.');
      return;
    }
    _injectStyles();
    var cssEl = document.getElementById('vtorb-css');
    console.log('[VTOrb] _show: styles injected, vtorb-css in DOM=' + !!cssEl);
    _renderOverlay();
    if (_cfg.showFab) _renderFab();
    _s.overlayVisible = true;
    _root.classList.add('vtorb-visible');
    _root.style.display = 'flex';
    console.log('[VTOrb] _show: overlay inDOM=' + document.body.contains(_root) + ', display=' + _root.style.display);
    _setOrbState('connecting');
    _s.voiceState = 'CONNECTING';
    _setStatus(_caption('connecting'));
    _updateUI();
    _startBackgroundWatchdog();
    _sessionStart();
  }

  // ============================================================
  // HOST SOUNDSCAPE SUPPRESSION
  // ============================================================
  // The host app (vitana-v1) plays ambient background music ("Soundscape")
  // through an <audio> element it exposes on window.__SOUNDSCAPE_AUDIO__.
  // Vitana's voice is rendered through this widget's OWN AudioContext, which
  // the host's media-precedence listeners can't observe — so without this the
  // music keeps playing while Vitana speaks. We duck it for the whole overlay
  // session (mirroring how Shorts/music/podcasts suppress it) and re-pause on
  // any mid-session resume (e.g. a route effect calling startFresh()) via a
  // one-shot 'play' guard. Self-contained: no host wiring required.
  function _suppressSoundscape() {
    try {
      var a = window.__SOUNDSCAPE_AUDIO__;
      if (!a || _s._soundscapeGuard) return; // already suppressing
      _s._soundscapeWasPlaying = !a.paused;
      _s._soundscapeGuard = function () {
        // Anything that tries to resume the music while the orb is open gets
        // immediately re-paused. Cleared by _restoreSoundscape().
        try { a.pause(); } catch (e) { /* ignore */ }
      };
      if (!a.paused) { try { a.pause(); } catch (e) { /* ignore */ } }
      a.addEventListener('play', _s._soundscapeGuard);
      console.log('[VTOrb] Soundscape ducked for orb session (wasPlaying=' + _s._soundscapeWasPlaying + ')');
    } catch (e) { /* host audio not present — nothing to suppress */ }
  }

  function _restoreSoundscape() {
    try {
      var a = window.__SOUNDSCAPE_AUDIO__;
      if (_s._soundscapeGuard && a) {
        a.removeEventListener('play', _s._soundscapeGuard);
        // Only resume music we actually paused, and never override a user who
        // muted or explicitly stopped it (muted => element stays paused+muted).
        if (_s._soundscapeWasPlaying && a.paused && !a.muted) {
          a.play().catch(function () { /* autoplay policy — leave paused */ });
          console.log('[VTOrb] Soundscape resumed after orb session');
        }
      }
    } catch (e) { /* ignore */ }
    _s._soundscapeGuard = null;
    _s._soundscapeWasPlaying = false;
  }

  // DEV-COMHU-0503 — ORB Recovery 2+3: persist short-lived continuity to the
  // gateway so a brief UI close / transient disconnect does not look
  // "first-time" on reopen. Fire-and-forget; authenticated sessions only
  // (anonymous has no durable identity — the gateway returns ok:false).
  function _persistContinuity(reason, ttlMinutes) {
    if (!_cfg.token) return; // anonymous → nothing durable to key on
    // DEV-COMHU-0503 (review fix): during an intentional forget (_reset), the
    // DELETE from _clearContinuity must NOT be raced by a _hide()-triggered
    // POST that recreates the row. _reset sets this flag before calling _hide.
    if (_s._suppressContinuityPersist) return;
    try {
      var headers = { 'Content-Type': 'application/json' };
      headers['Authorization'] = 'Bearer ' + _cfg.token;
      var transcript = (_s._transcriptHistory || []).slice(-10);
      fetch(_cfg.gw + '/api/v1/orb/session/continuity', {
        method: 'POST',
        headers: headers,
        cache: 'no-store',
        keepalive: true, // survive the overlay/page teardown
        body: JSON.stringify({
          reason: reason,
          ttl_minutes: ttlMinutes,
          value: {
            conversation_id: _s.conversationId || null,
            transcript_history: transcript,
            last_turn_at: _s._lastTurnAt || null,
            last_greeting_at: _s._lastGreetingAt || null
          }
        })
      }).catch(function () { /* continuity is best-effort */ });
    } catch (e) { /* never block close on continuity */ }
  }

  // DEV-COMHU-0503: clear durable continuity on intentional forget.
  function _clearContinuity() {
    if (!_cfg.token) return;
    try {
      var headers = { 'Content-Type': 'application/json' };
      headers['Authorization'] = 'Bearer ' + _cfg.token;
      fetch(_cfg.gw + '/api/v1/orb/session/continuity', {
        method: 'DELETE', headers: headers, cache: 'no-store', keepalive: true
      }).catch(function () {});
    } catch (e) { /* noop */ }
  }

  // VTID-03762: 5 minutes. A real narrated guided-topic lesson was measured
  // at ~44s end-to-end on staging (VTID-03746's own live trace, 497 audio
  // chunks); this is 6-7x that plus room for genuine follow-up Q&A and a
  // practice hand-off. It exists ONLY as a backstop for when the model
  // never calls end_guided_topic_teaching at all (confirmed happening live
  // on staging, VTID-03762 follow-up) — not as the primary "teaching is
  // done" signal. Deliberately NOT a short/turn-count heuristic: VTID-03685
  // already rejected guessing at completion early ("would trade a definite
  // bug for a fragile heuristic") — this only fires long after any
  // legitimate lesson+practice conversation would have finished on its own,
  // and only when nothing else has ended the guided-topic session by then.
  var GUIDED_TOPIC_BACKSTOP_MS = 5 * 60 * 1000;
  var GUIDED_TOPIC_BACKSTOP_CHECK_MS = 15000;

  // VTID-03762: shared teardown for both the model-driven
  // end_guided_topic_teaching directive and the backstop timer below —
  // same drain-then-hide shape the `navigate` directive already uses
  // elsewhere in this file (poll audioPlaying/scheduledSources/audioQueue
  // instead of guessing a fixed delay, so an in-flight closing line is
  // never truncated).
  function _endGuidedTopicTeaching(topicId, reason) {
    // VTID-03781: idempotency guard — see _guidedTopicTeachingEnded's own
    // declaration for why this is needed (tool-call + backstop can both
    // fire for the same teaching session). Must be the very first thing
    // this function does, synchronously, before any async poll starts, so
    // a second concurrent call can never race past this check.
    if (_s._guidedTopicTeachingEnded) {
      console.log('[VTOrb] _endGuidedTopicTeaching: already ended this teaching session, ignoring duplicate signal (reason=' + reason + ')');
      return;
    }
    _s._guidedTopicTeachingEnded = true;
    var attempts = 0;
    // VTID-03763: pin the session generation this poll belongs to at the
    // moment teaching-end was signalled — see the identical guard on
    // _waitForAudioEnd. Without it, a stale poll surviving into a later
    // session could _hide() / fire onGuidedTopicTeachingEnd for a topic
    // that isn't even the one the new session is teaching.
    var myGen = _s._sessionGeneration;
    (function _waitForGuidedTeachingAudioDrained() {
      setTimeout(function () {
        if (_s._sessionGeneration !== myGen) return; // stale poll from a prior session
        var stillPlaying = _s.audioPlaying ||
          (_s.scheduledSources && _s.scheduledSources.length > 0) ||
          (_s.audioQueue && _s.audioQueue.length > 0);
        // Hard safety cap: 30s (100 * 300ms), same as _waitForNavReady —
        // never wait forever on a stuck/misreported audio state.
        if (stillPlaying && attempts++ < 100) {
          _waitForGuidedTeachingAudioDrained();
          return;
        }
        // Short grace period for the last buffer to finish cleanly, same
        // 200ms the navigate directive uses.
        setTimeout(function () {
          if (_s._sessionGeneration !== myGen) return; // stale poll from a prior session
          try { _hide(); }
          catch (e) { console.error('[VTOrb] _hide on end_guided_topic_teaching failed:', e); }
          if (typeof _cfg.onGuidedTopicTeachingEnd === 'function') {
            try { _cfg.onGuidedTopicTeachingEnd(topicId, reason); }
            catch (e) { console.error('[VTOrb] onGuidedTopicTeachingEnd handler failed:', e); }
          }
        }, 200);
      }, 300);
    })();
  }

  function _hide() {
    // VTID-03292 (#3): mark a hard user-close FIRST so any racing reconnect /
    // _sessionStart bails (see _sessionStart guard) and the overlay can't
    // silently re-open. Cleared only on an explicit re-open in _show().
    _s._userRequestedClose = true;
    // VTID-03293 (#3 fix-2): kill the reconnect/disconnect machinery so a STALLED
    // session (e.g. stuck "connecting" with no audio) can ALWAYS be closed. The
    // recovery watchdog is a setInterval that re-fires _resetAndReconnect; without
    // stopping it + clearing these flags, the probe could keep the session alive
    // and the overlay effectively un-closeable. Belt-and-suspenders with the
    // _userRequestedClose guard above.
    _s._disconnectActive = false;
    _s._disconnectStuck = false;
    _s._isReconnecting = false;
    _s.guidedAutoClose = false; // VTID-03294 (#4): clear any pending guided auto-close
    _s.guidedTopic = null; // VTID-03675: don't let a never-delivered topic leak into a later, unrelated session
    _s._guidedTopicInFlight = null; // VTID-03746: same lifecycle — this overlay session is genuinely over
    _s._guidedTopicAudioDelivered = false; // VTID-03774: same lifecycle
    _s._guidedTopicZeroAudioFailCount = 0; // VTID-03776: same lifecycle
    _s._guidedTopicOpenedAt = null; // VTID-03762: same lifecycle — the backstop no longer applies
    try { clearInterval(_s._guidedTopicBackstopInterval); } catch (e) { /* noop */ }
    _s._guidedTopicBackstopInterval = null;
    _s._audioEverHeardThisOpen = false; // VTID-03727: this overlay session is genuinely over
    try { clearInterval(_s._recoveryWatchdog); } catch (e) { /* noop */ }
    _s._recoveryWatchdog = null;
    // VTID-03295 (X-close fix): STOP AUDIO + CLOSE THE OVERLAY SYNCHRONOUSLY, the
    // instant X is pressed — BEFORE the async/network teardown. The bug: the stop
    // routine awaited the /session/stop fetch BEFORE it stopped the scheduled audio
    // sources, so while Vitana was mid-lesson the audio kept playing and the
    // teardown stalled on the network → the overlay felt un-closeable. Here we kill
    // playback + mark the session dead first, so X always silences + closes now;
    // the network cleanup runs fire-and-forget afterwards.
    _s.active = false;
    if (_s.scheduledSources) {
      for (var _i = 0; _i < _s.scheduledSources.length; _i++) {
        try { _s.scheduledSources[_i].stop(); } catch (e) { /* ok */ }
      }
      _s.scheduledSources = [];
    }
    _s.audioQueue = [];
    _s.audioPlaying = false;
    _s.overlayVisible = false;
    if (_root) {
      _root.classList.remove('vtorb-visible');
      _root.style.display = 'none';
    }
    _updateUI();
    // DEV-COMHU-0503: UI close preserves short-lived continuity (15 min) BEFORE
    // teardown, so reopening within the window resumes instead of greeting
    // first-time. _sessionStop tears down media/SSE + fires /session/stop.
    _persistContinuity('hide', 15);
    _sessionStop();
    _restoreSoundscape();
    if (_cfg.onClose) try { _cfg.onClose(); } catch (e) { /* ignore */ }
  }

  // DEV-COMHU-0503: intentional forget — logout / account switch / "start over".
  // Clears durable continuity, wipes in-memory identity-bound state, and closes.
  function _reset() {
    // DEV-COMHU-0503 (review fix): suppress the _hide()-path continuity POST so
    // the DELETE below is not immediately raced by a fresh persist that would
    // recreate the row — the intentional-forget path must end with NO row.
    _s._suppressContinuityPersist = true;
    _s._transcriptHistory = [];
    _s.conversationId = null;
    _s._preDisconnectStage = null;
    _s._reconnectCount = 0;
    _hide();
    _clearContinuity(); // DELETE last, after _hide's (now-suppressed) persist
    _s._suppressContinuityPersist = false;
  }

  // VTID-NAV: Returns true when the widget is in any close-pending state.
  // Used by the turn_complete handler to suppress the listening transition
  // so we don't reactivate the orb while we are about to navigate away.
  function _isClosingForNav() {
    return _s.signupClosing === true || _s.navigationPending === true;
  }

  // 12. (Transcript UI removed — unified widget is voice-only, no chat bubbles)

  // ============================================================
  // 13. AUTO-RECONNECT
  // ============================================================

  // VTID-01987: bumped from 3 to 5 retries with shorter delays. Mobile WebViews
  // routinely produce 2-3 spurious failures during a WiFi/cellular handoff
  // before the new socket actually opens — 3 was too tight. The 5s health
  // probe (above) is the primary recovery path; this is the fallback.
  var MAX_WIDGET_RECONNECTS = 5;
  var RECONNECT_DELAYS = [1500, 3000, 5000, 8000, 12000];

  // BOOTSTRAP-ORB-MODERN-RECOVERY: scheduled-loop reconnect.
  //
  // Old behavior: recursive _attemptReconnect on failure burned the budget
  // in 3 attempts even when `online` kept firing, then exited without
  // clearing _disconnectActive — orb stuck in 'paused' aura forever.
  //
  // New behavior:
  //   - `online` event fully resets the budget AND clears _isReconnecting
  //   - one in-flight attempt at a time (gated by _isReconnecting)
  //   - failure schedules the NEXT attempt via setTimeout (not recursion)
  //   - on budget exhaustion, _enterStuckState() flips to a usable
  //     tap-to-reconnect display; the orb sphere becomes a button that
  //     calls _resetAndReconnect on tap
  //   - the 60s recovery watchdog (set by _announceDisconnect) is the
  //     belt-and-suspenders fallback for the user-reported "stuck forever"
  //     case — fires regardless of state if navigator.onLine is true
  function _attemptReconnect() {
    // Defensive: _isOffline can be stale on captive-portal recoveries where
    // the 'online' event doesn't always fire. Trust navigator.onLine here.
    if (navigator.onLine) _s._isOffline = false;

    if (_s._isOffline) {
      console.log('[VTOrb] _attemptReconnect: skipping — browser is offline. Will retry when online.');
      _setOrbState('offline');
      _setStatus(_caption('offline'));
      return;
    }

    if (_s._isReconnecting) {
      console.log('[VTOrb] _attemptReconnect: already in-flight, ignoring');
      return;
    }

    // VTID-03776: circuit breaker for a guided topic whose wake-brief opener
    // Nova's content filter (nova_validation) deterministically rejects.
    // Live-reproduced: ~30 consecutive fresh sessions, ~3.4s apart, EVERY one
    // blocked before any turn completed — because VTID-03774's own fixes
    // correctly persist/resend guided_topic_id across every reconnect, each
    // attempt re-synthesizes and replays the full Polly narration before
    // being blocked again, an audible infinite repeat with no natural exit.
    // A disconnect this soon after open, with a guided topic still armed and
    // NOTHING ever heard this overlay-open, counts as one such failure. After
    // 2 (this connection's attempt + one retry — the same budget the server's
    // own internal retry already gives a fresh topic), give up on THIS topic
    // for the rest of the overlay-open so the next attempt falls through to
    // safe generic conversation instead of repeating the doomed content.
    // Does NOT fire once real audio has played (_audioEverHeardThisOpen) —
    // a mid-lesson network blip must still resume the SAME topic (Fix 3,
    // VTID-03774's guided_topic_resume signal), never drop it.
    if (_s._guidedTopicInFlight && !_s._audioEverHeardThisOpen) {
      _s._guidedTopicZeroAudioFailCount = (_s._guidedTopicZeroAudioFailCount || 0) + 1;
      if (_s._guidedTopicZeroAudioFailCount >= 2) {
        console.warn('[VTOrb] _attemptReconnect: guided topic ' + _s._guidedTopicInFlight +
          ' failed ' + _s._guidedTopicZeroAudioFailCount + 'x with no audio ever heard — ' +
          'dropping it and stopping instead of silently opening unrelated conversation');
        _s.guidedTopic = null;
        _s._guidedTopicInFlight = null;
        // VTID-03782: used to fall through to the normal reconnect below,
        // which silently opened unrelated conversation with no end signal
        // possible (see this VTID's own test file for the live evidence).
        // Stop honestly via the same tap-to-reconnect state
        // MAX_WIDGET_RECONNECTS already uses, instead of degrading into an
        // unbounded chat the person can't distinguish from their lesson.
        _enterStuckState();
        return;
      }
    }

    if (_s._reconnectCount >= MAX_WIDGET_RECONNECTS) {
      _enterStuckState();
      return;
    }

    var delay = RECONNECT_DELAYS[_s._reconnectCount] || 8000;
    _s._reconnectCount++;
    _s._isReconnecting = true;
    console.log('[VTOrb] _attemptReconnect: scheduled in ' + delay + 'ms (attempt ' + _s._reconnectCount + '/' + MAX_WIDGET_RECONNECTS + ')');
    // VTID-03727: before anything has been heard (e.g. a guided-topic tap that
    // died to nova_validation before turn 1 ever played), "reconnecting" reads
    // as "already broken" rather than "hold on" — the exact defect VTID-03685
    // already fixed for the WS error-frame handler and the server-side
    // resendGreetingIfStuckAtZeroTurns retry cue (both gate on "has anything
    // actually played yet"). This call site was never covered by that fix: it
    // fires on every WS/SSE close this widget handles (nova_validation-driven
    // closes included), and used to show the reconnecting caption unconditionally.
    // Live-reported: "before it starts talking, the orb screen shows... 'One
    // moment, I will reconnect'". Once real audio has played, a genuine
    // reconnect cue is still correct and still shown.
    //
    // Codex review fix: gate on _audioEverHeardThisOpen, NOT _s.greetingComplete
    // directly — greetingComplete is deliberately reset to false on every
    // reconnect (VTID-01988, mic-restart) so a SECOND consecutive retry within
    // the same overlay open would otherwise misreport 'connecting' even though
    // the user genuinely heard Vitana speak earlier this session.
    _setStatus(_caption(_s._audioEverHeardThisOpen ? 'reconnecting' : 'connecting'));
    _setOrbState('connecting');

    setTimeout(function () {
      if (!_s.overlayVisible || _s._userInitiatedStop) {
        _s._isReconnecting = false;
        return; // User closed overlay / pressed X
      }

      // Clean up old session resources before retry
      if (_s.captureStream) {
        try { _s.captureStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        _s.captureStream = null;
      }
      if (_s.captureProcessor) { try { _s.captureProcessor.disconnect(); } catch (e) {} _s.captureProcessor = null; }
      if (_s.captureCtx) { try { _s.captureCtx.close().catch(function () {}); } catch (e) {} _s.captureCtx = null; }
      if (_s.eventSource) { try { _s.eventSource.close(); } catch (e) {} _s.eventSource = null; }
      _closeWs(false); // BOOTSTRAP-ORB-LATENCY-PHASE3

      _s.sessionId = null;
      _s.active = false;
      _s.liveError = null;
      _s._audioSendErrorLogged = false;
      _s.greetingAudioReceived = false;
      // VTID-01988 (mic restart fix): see _resetAndReconnect for context.
      _s.greetingComplete = false;

      // VTID-03746: this is an UNEXPECTED-disconnect retry (a clean X-close/
      // _sessionStop never reaches _attemptReconnect at all — see _hide()).
      // If a guided topic was in play THIS overlay-open but the turn-complete
      // handler had already nulled _s.guidedTopic (the lesson was mid-way
      // through being taught, not merely offered), restore it here so the
      // reconnected session resumes the SAME topic instead of falling
      // through to a generic/newday-style greeting. Live-reproduced
      // (staging): a 44-second, 497-audio-chunk T007 teaching session
      // disconnected mid-lesson and the reconnect had nothing to resume.
      if (_s._guidedTopicInFlight && !_s.guidedTopic) {
        console.log('[VTOrb] _attemptReconnect: re-arming guided topic for resume: ' + _s._guidedTopicInFlight);
        _s.guidedTopic = _s._guidedTopicInFlight;
      }

      _sessionStart().then(function () {
        _s._isReconnecting = false;
        if (_s.active) {
          // VTID-03776: only reset the backoff budget once real audio has
          // actually played THIS overlay-open (_audioEverHeardThisOpen) — a
          // bare transport-level connect that dies to something like
          // nova_validation within ~1s, before any turn completes, must NOT
          // reset it. Resetting on `_s.active` alone made the budget
          // meaningless for a doomed prompt: every reconnect "succeeded" at
          // the transport layer just long enough to zero the count before
          // the very next RECONNECT_DELAYS[0] fired, so MAX_WIDGET_RECONNECTS
          // never actually bound anything — live-reproduced as a genuinely
          // unbounded reconnect loop (~30+ sessions over 5+ minutes). Once
          // audio HAS played, resetting on every reconnect is still correct —
          // a long, healthy session shouldn't be punished for one hiccup.
          if (_s._audioEverHeardThisOpen) {
            _s._reconnectCount = 0;
          }
          console.log('[VTOrb] _attemptReconnect: succeeded (reconnectCount=' + _s._reconnectCount + ')');
          if (_s._disconnectActive) _clearDisconnect();
        } else {
          // _sessionStart returned without throwing but didn't set active
          console.warn('[VTOrb] _attemptReconnect: _sessionStart returned but session not active');
          _attemptReconnect();
        }
      }).catch(function (err) {
        console.error('[VTOrb] _attemptReconnect: _sessionStart failed:', err && err.message);
        _s._isReconnecting = false;
        _attemptReconnect(); // Schedule next attempt (NOT a recursion — this is from a setTimeout callback)
      });
    }, delay);
  }

  // BOOTSTRAP-ORB-MODERN-RECOVERY: terminal state when the auto-retry budget
  // is exhausted. The orb leaves the 'paused' aura (which is for transient
  // disconnects, not give-up state) and enters an 'error' aura with a clear
  // tap-to-reconnect call to action. The orb sphere itself becomes the
  // button (see _renderOverlay tap handler). The 60s watchdog still runs in
  // parallel as a true belt-and-suspenders auto-recovery.
  function _enterStuckState() {
    console.warn('[VTOrb] _enterStuckState: reconnect budget exhausted — switching to tap-to-reconnect');
    _s._isReconnecting = false;
    _s._disconnectStuck = true;
    _setOrbState('error');
    _setStatus(_caption('tapToReconnect'));
    _updateUI();
  }

  // ============================================================
  // 14. FALLBACK MODE (Text+TTS when Vertex Live API fails)
  // ============================================================

  var _fallbackMode = false;

  function _activateFallbackMode() {
    if (_fallbackMode) return;
    _fallbackMode = true;
    console.log('[VTOrb] Activating fallback text+TTS mode');
    _s._transcriptHistory.push({
      role: 'assistant',
      text: _cfg.lang.startsWith('de') ? 'Sprachverbindung umgestellt auf Textmodus.' : 'Voice connection switched to text mode.'
    });
    _setOrbState('listening');
    _s.voiceState = 'LISTENING';
    _setStatus(_caption('textModeActive'));
    _updateUI();
  }

  async function _sendFallbackMessage(text) {
    if (!text || !text.trim()) return;
    _s._transcriptHistory.push({ role: 'user', text: text.trim() });
    _setOrbState('thinking');
    _s.voiceState = 'THINKING';

    try {
      var headers = { 'Content-Type': 'application/json' };
      if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;

      var contextTurns = _s._transcriptHistory.slice(-10);
      var resp = await fetch(_cfg.gw + '/api/v1/orb/live/chat-tts', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ text: text.trim(), lang: _cfg.lang, context_turns: contextTurns })
      });

      var data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Fallback failed');

      if (data.text) {
        _s._transcriptHistory.push({ role: 'assistant', text: data.text });
      }

      if (data.audio_b64) {
        _setOrbState('speaking');
        _s.voiceState = 'SPEAKING';
        var audio = new Audio('data:' + (data.audio_mime || 'audio/mp3') + ';base64,' + data.audio_b64);
        audio.onended = function () {
          _setOrbState('listening');
          _s.voiceState = 'LISTENING';
          _setStatus(_caption('listening'));
          _playReadyBeep();
          _updateUI();
        };
        audio.play().catch(function () {});
      } else {
        _setOrbState('listening');
        _s.voiceState = 'LISTENING';
      }
      _updateUI();
    } catch (err) {
      console.error('[VTOrb] Fallback error:', err);
      _s._transcriptHistory.push({ role: 'assistant', text: 'Error: ' + err.message });
      _setOrbState('listening');
      _s.voiceState = 'LISTENING';
      _updateUI();
    }
  }

  // ============================================================
  // 15. PUBLIC API
  // ============================================================

  window.VitanaOrb = {
    _loaded: true,

    init: function (opts) {
      opts = opts || {};
      if (opts.gatewayUrl) _cfg.gw = opts.gatewayUrl.replace(/\/$/, '');

      // VTID-AUTH-FIX: Once init() is called, the CALLER owns auth.
      // Auto-detection is disabled. If authToken is not passed, the session
      // is anonymous. This prevents stale localStorage tokens from leaking
      // a previous user's identity (the "Hello Jovana/Dragan" bug).
      _tokenSetByInit = true;
      if (opts.authToken !== undefined && opts.authToken !== null) {
        _cfg.token = opts.authToken || '';
        _cfg.forceAnonymous = false;
        // DEV-COMHU-0502 (review fix): seed the identity baseline so the first
        // post-init setAuth (same user) is NOT misread as an account switch.
        _lastAuthSub = _jwtSub(_cfg.token);
      } else {
        // No authToken passed → anonymous. Clear any auto-detected token.
        // Also lock anonymous mode — setAuth() calls will be ignored until
        // init() is called again with an explicit authToken.
        _cfg.token = '';
        _cfg.forceAnonymous = true;
      }

      if (opts.lang) _cfg.lang = opts.lang;
      if (opts.showFab !== undefined) _cfg.showFab = !!opts.showFab;
      // BOOTSTRAP-ORB-LATENCY-PHASE3: opt-in WebSocket transport.
      if (opts.transport === 'ws' || opts.transport === 'sse') _cfg.transport = opts.transport;
      if (typeof opts.onClose === 'function') _cfg.onClose = opts.onClose;
      if (typeof opts.onSessionStart === 'function') _cfg.onSessionStart = opts.onSessionStart;
      if (typeof opts.onSessionEnd === 'function') _cfg.onSessionEnd = opts.onSessionEnd;
      if (typeof opts.onLink === 'function') _cfg.onLink = opts.onLink;
      if (typeof opts.onSignupRedirect === 'function') _cfg.onSignupRedirect = opts.onSignupRedirect;
      // VTID-NAV: Vitana Navigator close-and-navigate callback. Host React Router
      // hooks pass a function here that calls navigate(url) for SPA transitions.
      if (typeof opts.onNavigationRequest === 'function') _cfg.onNavigationRequest = opts.onNavigationRequest;
      // VTID-NAV: Optional initial context — current page + recent routes — so
      // the very first session has Navigator context even before any route
      // change has been observed by the React Router listener.
      if (opts.initialContext && typeof opts.initialContext === 'object') {
        if (typeof opts.initialContext.current_route === 'string') {
          _s.currentRoute = opts.initialContext.current_route;
        }
        if (Array.isArray(opts.initialContext.recent_routes)) {
          _s.recentRoutes = opts.initialContext.recent_routes
            .filter(function (r) { return typeof r === 'string'; })
            .slice(0, 5);
        }
        // VTID-03300: optional one-shot journey-step focus (see focusJourneyStep).
        if (typeof opts.initialContext.journey_focus_step === 'string') {
          _s.journeyFocus = opts.initialContext.journey_focus_step || null;
        }
      }

      _injectStyles();
      _renderOverlay();
      if (_cfg.showFab) _renderFab();
      // BOOTSTRAP-ORB-MODERN-RECOVERY: preload alert clips eagerly while the
      // network is fine, so they're in memory if/when the network drops.
      _preloadAlertClips();
      // BOOTSTRAP-ORB-LATENCY-PHASE2: pre-warm the gateway's bootstrap
      // context cache at page load (fire-and-forget) so the user's first
      // orb tap skips the 400-800ms context build on the
      // click-to-first-audio path. Anonymous = server-side no-op.
      _prewarmBootstrap();
      // VTID-03471: resolve the server's transport preference (kill switch)
      // in parallel with the prewarm. Unauthenticated, so anonymous sessions
      // get it too.
      _fetchServerTransport();
      console.log('[VTOrb] Initialized — gateway: ' + _cfg.gw + ', lang: ' + _cfg.lang + ', showFab: ' + _cfg.showFab + ', hasToken: ' + !!_cfg.token + ', forceAnonymous: ' + _cfg.forceAnonymous);
    },

    // Update auth token after login/logout — call this on EVERY token-state
    // change (login, silent refresh, account switch).
    //
    // DEV-COMHU-0502 — ORB Recovery 1 (auth contract): setAuth is now REACTIVE.
    // The previous implementation hard-ignored every setAuth call once init()
    // ran without a token (`forceAnonymous`), which meant a host that called
    // init() early (before login resolved) then setAuth(token) on login stayed
    // anonymous forever — skipping memory, cadence, last-session, and tools.
    // That single bug produced the "I have no access" + missing-memory +
    // "first-time greeting every reopen" cluster.
    //
    // A non-empty token always lifts the widget into authenticated mode and
    // clears the anonymous lock. setAuth('') / null is treated as a logout and
    // routed through clearAuth so identity-bound continuity is wiped
    // (preserving the VTID-AUTH-FIX anti-leak guarantee).
    setAuth: function (token) {
      if (!token) {
        VitanaOrb.clearAuth();
        return;
      }
      // DEV-COMHU-0502 (review fix): distinguish a same-user silent refresh
      // (sub unchanged — keep continuity, that's the whole point of ORB-1)
      // from an ACCOUNT SWITCH (sub changes — must NOT carry the prior user's
      // transcript/conversation into the new identity's session).
      var newSub = _jwtSub(token);
      var prevSub = _lastAuthSub;
      var identityChanged = !!prevSub && !!newSub && newSub !== prevSub;

      _cfg.token = token;
      _cfg.forceAnonymous = false; // a real token always lifts the anon lock
      _tokenSetByInit = true;      // caller now owns auth; stop localStorage auto-detect
      _lastAuthSub = newSub;

      if (identityChanged) {
        // Account switch: tear down the old-identity live session (if any) and
        // wipe identity-bound continuity BEFORE the next _sessionStart, so the
        // prior user's conversation/greeting state cannot leak under the new
        // token even if the host did not call clearAuth() first.
        _wipeIdentityBoundState();
        if (_s.active || _s.overlayVisible) {
          try { _sessionStop(); } catch (e) { /* best-effort teardown */ }
        }
        console.log('[VTOrb] setAuth: account switch detected — continuity wiped, prior session stopped');
      } else {
        console.log('[VTOrb] setAuth: hasToken=true (reactive)');
      }
      // BOOTSTRAP-ORB-LATENCY-PHASE2: warm the (possibly new) identity's
      // bootstrap context so the next orb tap starts fast.
      _prewarmBootstrap();
    },

    // DEV-COMHU-0502: explicit logout / account-switch / "start over". Tears
    // down the active live session (created under the OLD identity — otherwise
    // post-logout turns keep being handled/persisted against the prior
    // session.identity), then clears the token AND identity-bound continuity so
    // the next session cannot leak the previous user's state.
    clearAuth: function () {
      // Stop the backend/SSE session FIRST, while the old token is still set,
      // so the stop request authenticates as the departing identity.
      if (_s.active || _s.overlayVisible || _s.sessionId) {
        try { _sessionStop(); } catch (e) { /* best-effort teardown */ }
      }
      _cfg.token = '';
      _cfg.forceAnonymous = false; // not locked-anonymous; just unauthenticated now
      _tokenSetByInit = true;
      _lastAuthSub = null;
      _wipeIdentityBoundState();
      console.log('[VTOrb] clearAuth: live session stopped, token + identity-bound continuity cleared');
    },

    show: _show,
    hide: _hide,

    // VTID-03300: open the orb and start a session FOCUSED on a specific
    // "My Journey" Foundation step. The host calls this when the user taps a
    // step in the Next-Steps checklist; Vitana then leads with that exact step
    // ("Let's get your Profile set up…") instead of the default next step.
    // One-shot: the focus is consumed by the upcoming _sessionStart only.
    focusJourneyStep: function (stepKey) {
      _s.journeyFocus = (typeof stepKey === 'string' && stepKey) ? stepKey : null;
      _show();
    },

    // VTID-03291 / DEV-COMHU-0507: open the orb and start a session FOCUSED on a
    // specific Guided Journey catalog topic. The host (vitana-v1 My Journey)
    // calls this when the user taps a session/topic; the guided-topic-narration
    // provider then leads turn-1 and Vitana TEACHES that topic from the published
    // KB. One-shot: consumed by the upcoming _sessionStart only.
    focusGuidedTopic: function (topicId) {
      // VTID-03296 (replay fix): tear down ANY existing/in-flight session FIRST so
      // the new guided session starts from a CLEAN slate. Without this, tapping
      // Replay right after the teaching auto-close raced the just-closing session
      // (`if (_s.active) return` in _sessionStart, or a stale start consuming the
      // one-shot _s.guidedTopic), so the new session went out WITHOUT
      // guided_topic_id → it fell into the slow non-guided (admin) bootstrap path
      // and got stuck "Connecting...". _sessionStop is synchronous; _show() below
      // re-arms everything cleanly.
      try { _sessionStop(); } catch (e) { /* best-effort */ }
      _s.guidedTopic = (typeof topicId === 'string' && topicId) ? topicId : null;
      // VTID-03746: separate, longer-lived record of the same topic — see
      // its declaration for why _s.guidedTopic alone isn't enough anymore.
      _s._guidedTopicInFlight = _s.guidedTopic;
      // VTID-03774: a fresh tap means nothing has been delivered for THIS
      // topic yet — reset even if a previous topic's flag was left true.
      _s._guidedTopicAudioDelivered = false;
      // VTID-03776: a fresh tap is a clean slate for the zero-audio circuit
      // breaker too — a previous topic's failure count must not carry over.
      _s._guidedTopicZeroAudioFailCount = 0;
      // VTID-03781: a fresh tap is a brand-new teaching session — it must
      // get its own single completion, not inherit a previous topic's
      // already-fired idempotency guard (which would silently no-op this
      // topic's own, genuinely first, completion signal).
      _s._guidedTopicTeachingEnded = false;
      // VTID-03762: arm the backstop — see GUIDED_TOPIC_BACKSTOP_MS's own
      // comment for why this exists. Only for a real topic tap; a null
      // topicId (defensive fallback path) has nothing to backstop.
      try { clearInterval(_s._guidedTopicBackstopInterval); } catch (e) { /* noop */ }
      _s._guidedTopicBackstopInterval = null;
      if (_s.guidedTopic) {
        _s._guidedTopicOpenedAt = Date.now();
        _s._guidedTopicBackstopInterval = setInterval(function () {
          if (!_s._guidedTopicOpenedAt) {
            clearInterval(_s._guidedTopicBackstopInterval);
            _s._guidedTopicBackstopInterval = null;
            return;
          }
          if (Date.now() - _s._guidedTopicOpenedAt >= GUIDED_TOPIC_BACKSTOP_MS) {
            clearInterval(_s._guidedTopicBackstopInterval);
            _s._guidedTopicBackstopInterval = null;
            var _stuckTopicId = _s.guidedTopic || _s._guidedTopicInFlight || null;
            console.warn('[VTOrb] guided-topic backstop fired after ' + GUIDED_TOPIC_BACKSTOP_MS + 'ms with no end_guided_topic_teaching call (topic=' + _stuckTopicId + ') — closing overlay');
            _endGuidedTopicTeaching(_stuckTopicId, 'backstop_timeout');
          }
        }, GUIDED_TOPIC_BACKSTOP_CHECK_MS);
      } else {
        _s._guidedTopicOpenedAt = null;
      }
      // VTID-03294 (#4): a guided-topic open AUTO-CLOSES the overlay once Vitana
      // finishes the teaching turn (reveals the drawer's next-step buttons),
      // instead of dropping to listening. Set AFTER _s.guidedTopic; _show() does
      // not touch it. Consumed/reset on the first turn-complete or on _hide.
      _s.guidedAutoClose = true;
      _show();
    },
    // DEV-COMHU-0503: intentional forget (logout / account switch / start over).
    reset: _reset,

    toggle: function () {
      if (_s.overlayVisible) _hide(); else _show();
    },

    setLang: function (lang) {
      _cfg.lang = lang || 'en';
    },

    // VTID-NAV: Push current navigation context from the host app. Called by
    // useOrbWidget on every React Router route change so the next orb session
    // start payload includes fresh context for the Navigator service.
    // Safe to call as often as needed — does not trigger any I/O.
    updateContext: function (ctx) {
      if (!ctx || typeof ctx !== 'object') return;
      if (typeof ctx.current_route === 'string') {
        _s.currentRoute = ctx.current_route;
      }
      if (Array.isArray(ctx.recent_routes)) {
        _s.recentRoutes = ctx.recent_routes
          .filter(function (r) { return typeof r === 'string'; })
          .slice(0, 5);
      }
      // VTID-03300: pre-arm a one-shot journey-step focus from the host. Set
      // only when present, so the per-route updateContext stream (which never
      // carries this field) can't clobber a pending focus.
      if (typeof ctx.journey_focus_step === 'string') {
        _s.journeyFocus = ctx.journey_focus_step || null;
      }
      // VTID-03291 / DEV-COMHU-0507: pre-arm a one-shot guided-topic focus from
      // the host. Set only when present so the per-route updateContext stream
      // (which never carries this field) can't clobber a pending topic focus.
      if (typeof ctx.guided_topic_id === 'string') {
        _s.guidedTopic = ctx.guided_topic_id || null;
      }
    },

    destroy: function () {
      _sessionStop();
      _restoreSoundscape();
      if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
      if (_fab && _fab.parentNode) _fab.parentNode.removeChild(_fab);
      var css = document.getElementById('vtorb-css');
      if (css) css.parentNode.removeChild(css);
      _root = null;
      _fab = null;
      window.VitanaOrb._loaded = false;
    },

    // Test helper — allows Playwright to set state without a real voice session
    _test_setState: function (state, text) {
      _setOrbState(state);
      _s.voiceState = state.toUpperCase();
      _setStatus(text);
      _updateUI();
    },

    // Test helper — show overlay UI without starting a real voice session.
    // E2E tests must use this instead of show() to avoid creating Vertex AI
    // sessions that leak and exhaust upstream connection limits.
    _test_showOverlay: function () {
      _injectStyles();
      _renderOverlay();
      if (_cfg.showFab) _renderFab();
      _s.overlayVisible = true;
      _root.classList.add('vtorb-visible');
      _root.style.display = 'flex';
      _setOrbState('connecting');
      _s.voiceState = 'CONNECTING';
      _setStatus('Connecting...');
      _updateUI();
    }
  };

  // VTID-03469: arm the audio unlock at SCRIPT LOAD, not in init(). The host
  // only calls init() once auth has resolved, which on the login flow is after
  // the user has already tapped — and the auto-opening front door then starts a
  // session with no gesture of its own. Installing here means the login tap
  // itself starts the playback context.
  _installGestureAudioUnlock();

})(window);


// DEV-COMHU-0508: Path Ownership marker (guided-topic ORB fixes — focusGuidedTopic teaching turn, X-close, auto-close).
