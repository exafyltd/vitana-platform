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

  var _WIDGET_VERSION = '2026-03-30-v2';
  console.log('[VTOrb] Widget version: ' + _WIDGET_VERSION);

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
    onSessionEnd: null    // Callback when voice session ends
  };

  var _s = {
    // Session
    sessionId: null,
    active: false,
    eventSource: null,

    // Audio capture (16kHz mic)
    captureCtx: null,
    captureStream: null,
    captureProcessor: null,

    // Audio playback (speaker)
    playbackCtx: null,
    audioQueue: [],
    audioPlaying: false,
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
    stuckGuardTimer: null,
    thinkingDelayTimer: null, // Delayed thinking state — only show if response takes > 1.5s
    thinkingProgressTimer: null, // Progress updates during long thinking
    thinkingStartTime: 0,    // When thinking started — for elapsed time display
    greetingAudioReceived: false,
    greetingComplete: false,  // True after first turn_complete — mic opens only after this

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
    _disconnectStuck: false,
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
      '.vtorb-btn-close {',
      '  background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7);',
      '}',
      '.vtorb-btn-close:hover { background: rgba(239,68,68,0.3); color: #fca5a5; }',

      // --- Status text ---
      '.vtorb-status {',
      '  margin-top: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-size: 14px; color: rgba(255,255,255,0.6); text-align: center;',
      '  min-height: 20px; transition: opacity 0.3s;',
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

  // Display-only labels for the visible status text under the orb. The audio
  // is rendered separately from these MP3 clips, but the wording matches.
  var _DISCONNECT_LABELS = {
    mic: {
      en: "One moment, I can't hear your microphone.",
      de: "Einen Moment, Mikrofon-Problem."
    },
    network: {
      en: "One moment, we have internet issues.",
      de: "Einen Moment, Internet-Problem."
    },
    connection: {
      en: "Hold on, I'm reconnecting. Please wait.",
      de: "Einen Moment, ich verbinde mich neu."
    },
    offline: {
      en: "You're offline. Please wait, don't talk yet.",
      de: "Du bist offline. Bitte warte mit Sprechen."
    }
  };

  var _RECOVERY_LABELS = {
    mic: {
      en: "Okay, the microphone is working again. Let's continue.",
      de: "Okay, das Mikrofon funktioniert wieder. Wir können weitermachen."
    },
    network: {
      en: "Okay, we're back online. I'm listening.",
      de: "Okay, das Netz ist wieder da. Ich höre zu."
    },
    offline: {
      en: "Okay, we're back online. I'm listening.",
      de: "Okay, das Netz ist wieder da. Ich höre zu."
    },
    connection: {
      en: "Okay, sorry for the interruption. I'm listening.",
      de: "Okay, entschuldige die Unterbrechung. Ich höre zu."
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

    // Gate mic immediately — _sendAudio checks `active` and `voiceState === 'MUTED'`
    // at the VAD processor (line ~1191), so setting MUTED stops outbound audio.
    _s.voiceState = 'MUTED';
    _s._audioSendErrorLogged = true; // suppress fetch-error spam during outage
    clearTimeout(_s._listeningIdleTimer);
    clearTimeout(_s.thinkingDelayTimer);

    // Tone first — guaranteed <50ms even if the clip buffer is missing
    _playErrorTone();

    var lang = _pickLang();
    var labelBucket = _DISCONNECT_LABELS[reason] || _DISCONNECT_LABELS.connection;
    var label = labelBucket[lang] || labelBucket.en;

    _setOrbState('paused');
    _setStatus(label);
    _updateUI();

    _playAlert('disconnect-' + reason + '-' + lang);

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

    var lang = _pickLang();
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
    _setStatus(lang === 'de' ? 'Ich höre zu...' : 'Listening...');
  }

  // BOOTSTRAP-ORB-MODERN-RECOVERY: full session teardown + fresh start. Used
  // by the orb-tap handler when the user taps an orb that's stuck on the
  // disconnect display, and by the 60s watchdog as a last-resort recovery.
  function _resetAndReconnect() {
    console.log('[VTOrb] _resetAndReconnect: forcing full session restart');
    _stopWatchdog();
    if (_s.captureStream) {
      try { _s.captureStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
      _s.captureStream = null;
    }
    if (_s.captureProcessor) { try { _s.captureProcessor.disconnect(); } catch (e) {} _s.captureProcessor = null; }
    if (_s.captureCtx) { try { _s.captureCtx.close().catch(function () {}); } catch (e) {} _s.captureCtx = null; }
    if (_s.eventSource) { try { _s.eventSource.close(); } catch (e) {} _s.eventSource = null; }

    _s.sessionId = null;
    _s.active = false;
    _s.liveError = null;
    _s.greetingAudioReceived = false;
    // VTID-01988 (mic restart fix): reset greetingComplete so the new session's
    // turn_complete handler will re-trigger _startAudioCapture(). Without this,
    // recovery only updated the display — the mic stream stayed torn down.
    _s.greetingComplete = false;
    _s._reconnectCount = 0;
    _s._isReconnecting = false;
    _s._disconnectStuck = false;
    // Keep _disconnectActive true so the UI doesn't flash to a usable state
    // before the new session lands; _clearDisconnect on success will undo it.

    var lang = _pickLang();
    _setOrbState('connecting');
    _setStatus(lang === 'de' ? 'Verbindung wird wiederhergestellt...' : 'Reconnecting...');

    _sessionStart().then(function () {
      if (_s.active && _s._disconnectActive) _clearDisconnect();
    }).catch(function (err) {
      console.error('[VTOrb] _resetAndReconnect: _sessionStart failed:', err && err.message);
      // Hand back to the normal scheduled reconnect loop
      _attemptReconnect();
    });
  }

  // ============================================================
  // 5. AUDIO PLAYBACK PIPELINE
  // ============================================================

  function _playAudio(base64Data, mimeType) {
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
        return;
      }
      ctx.resume().then(function () {
        _s._resumeRetryStartedAt = 0;
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

        var buf = ctx.createBuffer(1, floats.length, 24000);
        buf.copyToChannel(floats, 0);

        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);

        var now = ctx.currentTime;
        if (_s.lastScheduledEnd < now) {
          var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
          _s.lastScheduledEnd = (isFirstChunk && isMobile) ? now + 0.3 : now;
        }

        src.start(_s.lastScheduledEnd);

        _s.scheduledSources.push(src);
        src.onended = function () {
          var idx = _s.scheduledSources.indexOf(src);
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

        _s.lastScheduledEnd += buf.duration;
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
    console.log('[VTOrb] Starting Gemini Live session...');

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

    // BOOTSTRAP-ORB-IOS-UNLOCK: Create playback AudioContext inside the user
    // gesture (critical for iOS — creating later or resuming later is
    // unreliable across awaits). Also play a 1-sample silent buffer
    // immediately: this is the canonical iOS unlock primitive. The chime
    // below used to be the de-facto unlock but it fires *after* the fetch
    // below on slower devices, losing the gesture window.
    if (!_s.playbackCtx || _s.playbackCtx.state === 'closed') {
      _s.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    try {
      var _silent = _s.playbackCtx.createBuffer(1, 1, 22050);
      var _silentSrc = _s.playbackCtx.createBufferSource();
      _silentSrc.buffer = _silent;
      _silentSrc.connect(_s.playbackCtx.destination);
      _silentSrc.start(0);
    } catch (e) {
      console.warn('[VTOrb] silent-buffer iOS unlock failed:', e && e.message);
    }
    if (_s.playbackCtx.state === 'suspended') {
      _s.playbackCtx.resume().catch(function (e) {
        console.warn('[VTOrb] playbackCtx resume rejected at session start:', e && e.message);
      });
    }

    // Play activation chime immediately
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
        vad_silence_ms: 1200
      };
      if (_s.currentRoute) startPayload.current_route = _s.currentRoute;
      if (_s.recentRoutes && _s.recentRoutes.length) startPayload.recent_routes = _s.recentRoutes.slice(0, 5);

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

      var data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Failed to start session');

      _s.sessionId = data.session_id;
      _s.active = true;
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
      _updateUI();
    }
  }

  async function _sessionStop() {
    console.log('[VTOrb] Stopping session...');
    _stopWatchdog();
    clearTimeout(_s._listeningIdleTimer);

    // Cancel any pending disconnect alert silently — session is ending, so no
    // "we're back" phrase. (Alert clips are short BufferSources that finish
    // on their own; we don't track them for explicit cancellation.)
    if (_s._disconnectActive) {
      _s._disconnectActive = false;
      _s._disconnectReason = null;
      _s._preDisconnectVoiceState = null;
      _s._disconnectStuck = false;
      _s._isReconnecting = false;
      clearInterval(_s._recoveryWatchdog);
      _s._recoveryWatchdog = null;
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

    // Stop playback
    if (_s.playbackCtx) { _s.playbackCtx.close().catch(function () {}); _s.playbackCtx = null; }

    // Clear stuck guard
    clearTimeout(_s.stuckGuardTimer);
    _s.stuckGuardTimer = null;
    _s.greetingAudioReceived = false;
    _s.lastScheduledEnd = 0;

    // Close SSE
    if (_s.eventSource) { _s.eventSource.close(); _s.eventSource = null; }

    // Stop backend session
    if (_s.sessionId) {
      try {
        var headers = { 'Content-Type': 'application/json' };
        if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;
        await fetch(_cfg.gw + '/api/v1/orb/live/session/stop', {
          method: 'POST', headers: headers,
          body: JSON.stringify({ session_id: _s.sessionId })
        });
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
        _setStatus(_cfg.lang.startsWith('de') ? 'Denkt nach...' : 'Thinking...');
        // Stuck guard: 15s timeout
        clearTimeout(_s.stuckGuardTimer);
        _s.stuckGuardTimer = setTimeout(function () {
          if (!_s.greetingAudioReceived && _s.active) {
            _setOrbState('listening');
            _s.voiceState = 'LISTENING';
            _setStatus(_cfg.lang.startsWith('de') ? 'Ich höre zu...' : 'Listening...');
            _updateUI();
          }
        }, 15000);
        _updateUI();
        break;

      case 'live_api_ready':
        // Full voice conversation active
        break;

      case 'thinking':
        // Server signals model is processing (user speech detected or tool call running).
        // 300ms delay — just enough to skip if audio arrives almost immediately.
        // Previous 1.5s was too long: combined with Vertex VAD silence detection (~2s),
        // total delay was ~4-5s before user saw "Thinking..." — felt broken.
        _s.thinkingStartTime = Date.now();
        if (_s.voiceState === 'LISTENING' || _s.voiceState === 'IDLE') {
          clearTimeout(_s.thinkingDelayTimer);
          _s.thinkingDelayTimer = setTimeout(function () {
            if (_s.voiceState === 'LISTENING' || _s.voiceState === 'IDLE') {
              _setOrbState('thinking');
              _s.voiceState = 'THINKING';
              _setStatus(_cfg.lang.startsWith('de') ? 'Denkt nach...' : 'Thinking...');
              _updateUI();
              _startThinkingProgress();
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
            _setStatus(_cfg.lang.startsWith('de') ? 'Vitana spricht...' : 'Vitana speaking...');
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
        (function _waitForAudioEnd() {
          setTimeout(function () {
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
              _setOrbState('listening');
              _s.voiceState = 'LISTENING';
              _setStatus(_cfg.lang.startsWith('de') ? 'Ich höre zu...' : 'Listening...');
              _playReadyBeep();
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
                  _setStatus(_cfg.lang.startsWith('de')
                    ? 'Ich höre noch zu. Sag mir, was ich tun soll!'
                    : "I'm still listening. Tell me what you'd like to do!");
                  _playReadyBeep();
                  _updateUI();
                }, delay);
              })(15000);
            }
          }, 300);
        })();
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
        _setStatus('Error: ' + (msg.message || 'Unknown'));
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
          _setStatus(_cfg.lang.startsWith('de') ? 'Ich höre zu...' : 'Listening...');
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
        _sessionStop();
        break;

      case 'session_limit_reached':
        if (msg.reason === 'signup_intent' || msg.reason === 'login_intent') {
          // VTID-ANON-SIGNUP: Wait for Vitana's goodbye audio to finish fully before
          // closing + redirecting — don't cut her off mid-sentence. Block listening.
          console.log('[VTOrb] ' + msg.reason + ' — waiting for goodbye audio to finish, then redirecting to ' + (msg.redirect || 'none'));
          _s.signupClosing = true;
          var redirectUrl = msg.redirect || null;
          var _signupCloseAttempts = 0;
          (function _waitForGoodbyeEnd() {
            setTimeout(function () {
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
        } else {
          // VTID-ANON-NUDGE: Turn limit — show registration prompt
          console.log('[VTOrb] Session limit reached — prompting registration');
          _setStatus(_cfg.lang.startsWith('de')
            ? 'Registriere dich kostenlos, um das Gespräch fortzusetzen!'
            : 'Register for free to continue the conversation!');
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
          (function _waitForNavReady() {
            setTimeout(function () {
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

                _hide();
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
      if (modelPlaying) {
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
            _sendInterrupt();
          }
        } else {
          vadFrames = 0;
        }
        return; // Don't send audio while model speaking
      } else {
        vadFrames = 0;
        vadInterruptSent = false;
        // Record real user speech so the listening-idle nudge timer can
        // defer itself instead of beeping over the user mid-sentence.
        if (rms > vadThreshold) {
          _s._lastSpeechAt = Date.now();
        }
      }

      // Post-turn cooldown (500ms) — server-side turn_complete
      if (_s.turnCompleteAt > 0 && (Date.now() - _s.turnCompleteAt) < 500) return;

      // Client-side echo cooldown (500ms) — after audio playback actually ends.
      // The server's POST_TURN_COOLDOWN_MS (2s) starts when Vertex sends turn_complete,
      // but the client may still be playing buffered audio 1-3s later. This cooldown
      // starts when the LAST audio source actually finishes playing on the client.
      if (_s.lastAudioEndTime > 0 && (Date.now() - _s.lastAudioEndTime) < 500) return;

      // Convert Float32 → Int16 PCM → base64
      var pcm = new Int16Array(input.length);
      for (var n = 0; n < input.length; n++) {
        var s = Math.max(-1, Math.min(1, input[n]));
        pcm[n] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      var u8 = new Uint8Array(pcm.buffer);
      var b64 = btoa(String.fromCharCode.apply(null, u8));
      _sendAudio(b64);
    };

    source.connect(processor);
    processor.connect(ctx.destination);
    _s.captureProcessor = processor;
  }

  function _sendAudio(b64) {
    if (!_s.sessionId || !_s.active) return;
    var headers = { 'Content-Type': 'application/json' };
    if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;
    fetch(_cfg.gw + '/api/v1/orb/live/stream/send?session_id=' + _s.sessionId, {
      method: 'POST', headers: headers,
      body: JSON.stringify({ type: 'audio', data_b64: b64, mime: 'audio/pcm;rate=16000' })
    }).then(function (r) {
      if (r.ok) {
        _s._audioSendFailCount = 0;
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
    if (!_s.sessionId || !_s.active) return;
    var headers = { 'Content-Type': 'application/json' };
    if (_cfg.token) headers['Authorization'] = 'Bearer ' + _cfg.token;
    fetch(_cfg.gw + '/api/v1/orb/live/stream/send?session_id=' + _s.sessionId, {
      method: 'POST', headers: headers,
      body: JSON.stringify({ type: 'interrupt' })
    }).catch(function () {});
  }

  // ============================================================
  // 9. WATCHDOGS
  // ============================================================

  // Thinking progress: reassure user during long processing (memory search, slow network).
  // Shows elapsed time and rotating messages so user knows it's still working.
  function _startThinkingProgress() {
    clearInterval(_s.thinkingProgressTimer);
    var messages_en = [
      'Searching memory...',
      'Still working on it...',
      'Processing your request...',
      'Almost there...',
      'Taking a bit longer than usual...'
    ];
    var messages_de = [
      'Durchsuche Erinnerungen...',
      'Arbeite noch daran...',
      'Verarbeite deine Anfrage...',
      'Fast fertig...',
      'Dauert etwas länger als üblich...'
    ];
    var msgIndex = 0;
    _s.thinkingProgressTimer = setInterval(function () {
      if (_s.voiceState !== 'THINKING') {
        clearInterval(_s.thinkingProgressTimer);
        _s.thinkingProgressTimer = null;
        return;
      }
      var elapsed = Math.floor((Date.now() - _s.thinkingStartTime) / 1000);
      var msgs = _cfg.lang.startsWith('de') ? messages_de : messages_en;
      // Cycle through messages every 5 seconds
      if (elapsed >= 5) msgIndex = Math.min(Math.floor((elapsed - 5) / 5) + 1, msgs.length - 1);
      var text = msgs[msgIndex];
      if (elapsed >= 10) text += ' (' + elapsed + 's)';
      _setStatus(text);
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
    status.style.cssText = 'margin-top:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;color:rgba(255,255,255,0.6);text-align:center;min-height:20px;';
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
        _setStatus(_cfg.lang.startsWith('de') ? 'Vitana spricht...' : 'Vitana speaking...');
      } else {
        _setOrbState('listening');
        _setStatus(_cfg.lang.startsWith('de') ? 'Ich höre zu...' : 'Listening...');
      }
    } else {
      // Mute — remember current state so we can restore it
      _s.preMuteState = _s.voiceState;
      _s.voiceState = 'MUTED';
      _setOrbState('paused');
      _setStatus(_cfg.lang.startsWith('de') ? 'Stummgeschaltet' : 'Muted');
    }
    _updateUI();
  }

  // Refresh auth token from localStorage — ALWAYS re-read on every _show().
  // User may have logged in, logged out, or switched accounts since last session.
  // Only skip if init() explicitly passed authToken (tracked by _tokenSetByInit).
  var _tokenSetByInit = false;

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
    _setStatus(_cfg.lang.startsWith('de') ? 'Verbinden...' : 'Connecting...');
    _updateUI();
    _sessionStart();
  }

  function _hide() {
    _sessionStop();
    _s.overlayVisible = false;
    if (_root) {
      _root.classList.remove('vtorb-visible');
      _root.style.display = 'none';
    }
    _updateUI();
    if (_cfg.onClose) try { _cfg.onClose(); } catch (e) { /* ignore */ }
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
      _setStatus(_cfg.lang.startsWith('de') ? 'Du bist offline. Bitte prüfe deine Internetverbindung.' : 'You seem to be offline. Please check your internet connection.');
      return;
    }

    if (_s._isReconnecting) {
      console.log('[VTOrb] _attemptReconnect: already in-flight, ignoring');
      return;
    }

    if (_s._reconnectCount >= MAX_WIDGET_RECONNECTS) {
      _enterStuckState();
      return;
    }

    var delay = RECONNECT_DELAYS[_s._reconnectCount] || 8000;
    _s._reconnectCount++;
    _s._isReconnecting = true;
    console.log('[VTOrb] _attemptReconnect: scheduled in ' + delay + 'ms (attempt ' + _s._reconnectCount + '/' + MAX_WIDGET_RECONNECTS + ')');
    _setStatus(_cfg.lang.startsWith('de') ? 'Verbindung wird wiederhergestellt...' : 'Reconnecting...');
    _setOrbState('connecting');

    setTimeout(function () {
      if (!_s.overlayVisible) {
        _s._isReconnecting = false;
        return; // User closed overlay
      }

      // Clean up old session resources before retry
      if (_s.captureStream) {
        try { _s.captureStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        _s.captureStream = null;
      }
      if (_s.captureProcessor) { try { _s.captureProcessor.disconnect(); } catch (e) {} _s.captureProcessor = null; }
      if (_s.captureCtx) { try { _s.captureCtx.close().catch(function () {}); } catch (e) {} _s.captureCtx = null; }
      if (_s.eventSource) { try { _s.eventSource.close(); } catch (e) {} _s.eventSource = null; }

      _s.sessionId = null;
      _s.active = false;
      _s.liveError = null;
      _s._audioSendErrorLogged = false;
      _s.greetingAudioReceived = false;
      // VTID-01988 (mic restart fix): see _resetAndReconnect for context.
      _s.greetingComplete = false;

      _sessionStart().then(function () {
        _s._isReconnecting = false;
        if (_s.active) {
          _s._reconnectCount = 0;
          console.log('[VTOrb] _attemptReconnect: succeeded');
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
    var lang = _pickLang();
    _setOrbState('error');
    _setStatus(lang === 'de' ? 'Tippen zum Neu verbinden' : 'Tap the orb to reconnect');
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
    _setStatus(_cfg.lang.startsWith('de') ? 'Textmodus aktiv' : 'Text mode active');
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
          _setStatus(_cfg.lang.startsWith('de') ? 'Ich höre zu...' : 'Listening...');
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
      } else {
        // No authToken passed → anonymous. Clear any auto-detected token.
        // Also lock anonymous mode — setAuth() calls will be ignored until
        // init() is called again with an explicit authToken.
        _cfg.token = '';
        _cfg.forceAnonymous = true;
      }

      if (opts.lang) _cfg.lang = opts.lang;
      if (opts.showFab !== undefined) _cfg.showFab = !!opts.showFab;
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
      }

      _injectStyles();
      _renderOverlay();
      if (_cfg.showFab) _renderFab();
      // BOOTSTRAP-ORB-MODERN-RECOVERY: preload alert clips eagerly while the
      // network is fine, so they're in memory if/when the network drops.
      _preloadAlertClips();
      console.log('[VTOrb] Initialized — gateway: ' + _cfg.gw + ', lang: ' + _cfg.lang + ', showFab: ' + _cfg.showFab + ', hasToken: ' + !!_cfg.token + ', forceAnonymous: ' + _cfg.forceAnonymous);
    },

    // Update auth token after login/logout — call this when auth state changes.
    // Ignored if init() was called without authToken (forceAnonymous mode).
    // To switch from anonymous to authenticated, call init() again with authToken.
    setAuth: function (token) {
      if (_cfg.forceAnonymous) {
        console.log('[VTOrb] setAuth ignored — forceAnonymous mode. Call init({ authToken }) to authenticate.');
        return;
      }
      _cfg.token = token || '';
      _tokenSetByInit = true;
      console.log('[VTOrb] setAuth: hasToken=' + !!_cfg.token);
    },

    show: _show,
    hide: _hide,

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
    },

    destroy: function () {
      _sessionStop();
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

})(window);
