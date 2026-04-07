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
    _isOffline: false         // VTID-OFFLINE: Track network offline state
  };

  // VTID-OFFLINE: Instant offline/online detection via browser events
  window.addEventListener('offline', function () {
    console.warn('[VTOrb] Browser went offline');
    _s._isOffline = true;
    if (_s.active || _s.overlayVisible) {
      _stopWatchdog();
      _setOrbState('offline');
      _setStatus(_cfg.lang.startsWith('de') ? 'Du bist offline. Bitte prüfe deine Internetverbindung.' : 'You seem to be offline. Please check your internet connection.');
      _playErrorTone();
    }
  });

  window.addEventListener('online', function () {
    console.log('[VTOrb] Browser back online');
    _s._isOffline = false;
    if (_s.active || _s.overlayVisible) {
      _setStatus(_cfg.lang.startsWith('de') ? 'Wieder online — Verbindung wird wiederhergestellt...' : 'Back online — reconnecting...');
      _setOrbState('connecting');
      // Reset reconnect count so we get fresh attempts after coming back online
      _s._reconnectCount = 0;
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

    // Resume if suspended (mobile)
    if (ctx.state === 'suspended') {
      ctx.resume().then(function () { setTimeout(_processQueue, 50); }).catch(function () {});
      return;
    }

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
    _s._audioSendErrorLogged = false;
    _s._inputTranscriptBuffer = '';
    _s._outputTranscriptBuffer = '';

    // Create playback AudioContext in user gesture (critical for mobile)
    if (!_s.playbackCtx || _s.playbackCtx.state === 'closed') {
      _s.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_s.playbackCtx.state === 'suspended') {
      _s.playbackCtx.resume().catch(function () {});
    }

    // Play activation chime immediately
    _playChime(_s.playbackCtx);

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

      var resp = await fetch(_cfg.gw + '/api/v1/orb/live/session/start', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          lang: _cfg.lang,
          voice_style: 'friendly, calm, empathetic',
          response_modalities: ['audio', 'text'],
          vad_silence_ms: 1200
        })
      });

      var data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Failed to start session');

      _s.sessionId = data.session_id;
      _s.active = true;
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
          // VTID-RECONNECT: Try auto-reconnect instead of just dying
          if (_s._reconnectCount < MAX_WIDGET_RECONNECTS) {
            _attemptReconnect();
          } else {
            _s.liveError = 'Connection lost.';
            _setOrbState('error');
            _playErrorTone();
            _updateUI();
            setTimeout(_sessionStop, 3000);
          }
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

    // Stop mic
    if (_s.captureStream) {
      _s.captureStream.getTracks().forEach(function (t) { t.stop(); });
      _s.captureStream = null;
    }
    if (_s.captureProcessor) { _s.captureProcessor.disconnect(); _s.captureProcessor = null; }
    if (_s.captureCtx) { _s.captureCtx.close().catch(function () {}); _s.captureCtx = null; }

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
        // Cancel pending thinking timer and progress — response arrived
        clearTimeout(_s.thinkingDelayTimer);
        clearInterval(_s.thinkingProgressTimer);
        _s.thinkingProgressTimer = null;
        if (msg.data_b64) {
          // Clear stuck guard on first audio
          if (!_s.greetingAudioReceived) {
            _s.greetingAudioReceived = true;
            clearTimeout(_s.stuckGuardTimer);
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
            _updateUI();
          }
          _playAudio(msg.data_b64, msg.mime || 'audio/pcm;rate=24000');
        }
        break;

      case 'turn_complete':
        _s.lastScheduledEnd = 0;
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
            var stillPlaying = _s.audioPlaying ||
              (_s.scheduledSources && _s.scheduledSources.length > 0) ||
              (_s.audioQueue && _s.audioQueue.length > 0);
            if (stillPlaying) {
              _waitForAudioEnd(); // Still playing — check again in 300ms
              return;
            }
            // Start mic on first turn_complete (greeting done) — not before.
            if (!_s.greetingComplete) {
              _s.greetingComplete = true;
              _startAudioCapture().catch(function (err) {
                console.error('[VTOrb] Mic capture failed after greeting:', err);
              });
            }
            if (_s.voiceState === 'MUTED') {
              // Muted — don't change visual state, but update what unmute restores to
              _s.preMuteState = 'LISTENING';
            } else {
              _setOrbState('listening');
              _s.voiceState = 'LISTENING';
              _setStatus(_cfg.lang.startsWith('de') ? 'Ich höre zu...' : 'Listening...');
              _playReadyBeep();
              _updateUI();
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

      case 'connection_issue':
      case 'live_api_disconnected':
        // VTID-RECONNECT: Try auto-reconnect before giving up
        if (_s._reconnectCount < MAX_WIDGET_RECONNECTS) {
          console.warn('[VTOrb] Connection issue — attempting reconnect');
          _attemptReconnect();
        } else {
          _s.liveError = msg.message || 'Connection lost.';
          _setOrbState('error');
          _setStatus(_cfg.lang.startsWith('de') ? 'Verbindung verloren.' : 'Connection lost.');
          _playErrorTone();
          _updateUI();
          setTimeout(_sessionStop, 3000);
        }
        break;

      case 'session_ended':
        _sessionStop();
        break;

      case 'session_limit_reached':
        // VTID-ANON-NUDGE: Anonymous session hit turn limit — show registration prompt
        console.log('[VTOrb] Session limit reached — prompting registration');
        _setStatus(_cfg.lang.startsWith('de')
          ? 'Registriere dich kostenlos, um das Gespräch fortzusetzen!'
          : 'Register for free to continue the conversation!');
        _setOrbState('paused');
        setTimeout(_sessionStop, 8000);
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
      if (!r.ok && !_s._audioSendErrorLogged) {
        _s._audioSendErrorLogged = true;
        console.error('[VTOrb] Audio send failed: HTTP ' + r.status);
      }
    }).catch(function (err) {
      if (!_s._audioSendErrorLogged) {
        _s._audioSendErrorLogged = true;
        console.error('[VTOrb] Audio send error:', err.message);
      }
    });
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
        // VTID-RECONNECT: Try auto-reconnect before giving up
        if (_s._reconnectCount < MAX_WIDGET_RECONNECTS) {
          console.warn('[VTOrb] Watchdog fired — attempting reconnect');
          _attemptReconnect();
        } else {
          _s.liveError = 'Connection lost.';
          _setOrbState('error');
          _setStatus(_cfg.lang.startsWith('de') ? 'Keine Antwort vom Server.' : 'No response from server.');
          _playErrorTone();
          _updateUI();
          setTimeout(_sessionStop, 3000);
        }
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
    orb.style.cssText = 'width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 35% 35%,#7c8db5,#5a6a8a 50%,#3a4a6a 100%);box-shadow:inset -8px -8px 24px rgba(0,0,0,0.4),inset 4px 4px 12px rgba(255,255,255,0.08),0 0 60px rgba(90,110,150,0.3);position:relative;z-index:1;';
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

  // 12. (Transcript UI removed — unified widget is voice-only, no chat bubbles)

  // ============================================================
  // 13. AUTO-RECONNECT
  // ============================================================

  var MAX_WIDGET_RECONNECTS = 3;
  var RECONNECT_DELAYS = [2000, 4000, 8000]; // Exponential backoff

  async function _attemptReconnect() {
    // VTID-OFFLINE: Don't try reconnecting if browser is offline — wait for 'online' event
    if (_s._isOffline) {
      console.log('[VTOrb] Skipping reconnect — browser is offline. Will retry when online.');
      _setOrbState('offline');
      _setStatus(_cfg.lang.startsWith('de') ? 'Du bist offline. Bitte prüfe deine Internetverbindung.' : 'You seem to be offline. Please check your internet connection.');
      return;
    }

    if (_s._reconnectCount >= MAX_WIDGET_RECONNECTS) {
      console.warn('[VTOrb] Max reconnection attempts reached');
      _setStatus(_cfg.lang.startsWith('de') ? 'Verbindung verloren. Bitte erneut starten.' : 'Connection lost. Please restart.');
      _setOrbState('error');
      return;
    }

    var delay = RECONNECT_DELAYS[_s._reconnectCount] || 8000;
    _s._reconnectCount++;
    console.log('[VTOrb] Reconnecting in ' + delay + 'ms (attempt ' + _s._reconnectCount + '/' + MAX_WIDGET_RECONNECTS + ')');
    _setStatus(_cfg.lang.startsWith('de') ? 'Verbindung wird wiederhergestellt...' : 'Reconnecting...');
    _setOrbState('connecting');

    setTimeout(async function () {
      if (!_s.overlayVisible) return; // User closed overlay

      try {
        // Clean up old session resources
        if (_s.captureStream) {
          _s.captureStream.getTracks().forEach(function (t) { t.stop(); });
          _s.captureStream = null;
        }
        if (_s.captureProcessor) { _s.captureProcessor.disconnect(); _s.captureProcessor = null; }
        if (_s.captureCtx) { _s.captureCtx.close().catch(function () {}); _s.captureCtx = null; }
        if (_s.eventSource) { _s.eventSource.close(); _s.eventSource = null; }

        // Keep playback context and transcript history alive
        _s.sessionId = null;
        _s.active = false;
        _s.liveError = null;
        _s._audioSendErrorLogged = false;
        _s.greetingAudioReceived = false;

        // Restart session
        await _sessionStart();
        if (_s.active) {
          _s._reconnectCount = 0; // Reset on successful reconnect
          console.log('[VTOrb] Reconnected successfully');
        }
      } catch (err) {
        console.error('[VTOrb] Reconnection failed:', err);
        _attemptReconnect(); // Try again
      }
    }, delay);
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

      _injectStyles();
      _renderOverlay();
      if (_cfg.showFab) _renderFab();
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
