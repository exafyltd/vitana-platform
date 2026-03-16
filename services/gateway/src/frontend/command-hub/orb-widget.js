/**
 * Vitana ORB Voice Widget — Standalone Gemini Live voice-to-voice
 * Self-contained IIFE — no external dependencies.
 * Load via <script src="gateway/command-hub/orb-widget.js"></script>
 * Then call: VitanaOrb.init({ gatewayUrl, authToken, lang })
 *
 * VTID-WIDGET: Extracted from command-hub app.js
 */
(function (window) {
  'use strict';

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
    return '';
  })();

  var _cfg = {
    gw: _autoGw,  // Gateway URL — auto-detected from script src, overridden by init()
    token: '',    // Supabase JWT
    lang: 'en-US'
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

    // Barge-in / echo
    interruptPending: false,
    turnCompleteAt: 0,

    // Watchdogs
    clientWatchdogInterval: null,
    clientLastActivityAt: 0,
    stuckGuardTimer: null,
    greetingAudioReceived: false,

    // UI state
    voiceState: 'IDLE', // IDLE | LISTENING | THINKING | SPEAKING | MUTED
    overlayVisible: false,
    liveError: null,
    _audioSendErrorLogged: false
  };

  var _root = null; // Widget DOM root
  var _fab = null;  // FAB button element

  // ============================================================
  // 2. CSS INJECTION
  // ============================================================

  function _injectStyles() {
    if (document.getElementById('vtorb-css')) return;
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
          if (_s.scheduledSources.length === 0) _s.audioPlaying = false;
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
          _s.liveError = 'Connection lost.';
          _setOrbState('error');
          _playErrorTone();
          _updateUI();
          setTimeout(_sessionStop, 3000);
        }
      };
      _s.eventSource = es;

      // Start mic capture
      await _startAudioCapture();

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

    _s.sessionId = null;
    _s.active = false;
    _s.audioQueue = [];
    _s.audioPlaying = false;
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
        _setStatus(_cfg.lang.startsWith('de') ? 'Verbindung hergestellt...' : 'Connected...');
        // Stuck guard: 15s timeout
        clearTimeout(_s.stuckGuardTimer);
        _s.stuckGuardTimer = setTimeout(function () {
          if (!_s.greetingAudioReceived && _s.active) {
            _setOrbState('listening');
            _s.voiceState = 'LISTENING';
            _setStatus(_cfg.lang.startsWith('de') ? 'Du kannst sprechen.' : 'You can speak.');
            _updateUI();
          }
        }, 15000);
        _updateUI();
        break;

      case 'live_api_ready':
        // Full voice conversation active
        break;

      case 'audio':
      case 'audio_out':
        if (_s.interruptPending) break;
        if (msg.data_b64) {
          if (!_s.greetingAudioReceived) {
            _s.greetingAudioReceived = true;
            clearTimeout(_s.stuckGuardTimer);
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
        setTimeout(function () {
          if (!_s.audioPlaying) {
            _setOrbState('listening');
            _s.voiceState = 'LISTENING';
            _setStatus(_cfg.lang.startsWith('de') ? 'Ich höre zu...' : 'Listening...');
            _playReadyBeep();
            _updateUI();
          }
        }, 250);
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
        _s.interruptPending = false;
        break;

      case 'error':
        _setStatus('Error: ' + (msg.message || 'Unknown'));
        break;

      case 'connection_issue':
      case 'live_api_disconnected':
        _s.liveError = msg.message || 'Connection lost.';
        _setOrbState('error');
        _setStatus(_cfg.lang.startsWith('de') ? 'Verbindung verloren.' : 'Connection lost.');
        _playErrorTone();
        _updateUI();
        setTimeout(_sessionStop, 3000);
        break;

      case 'session_ended':
        _sessionStop();
        break;

      // audio_ack, video_ack, text, transcript, input_transcript, output_transcript — ignore in minimal UI
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
    var vadThreshold = 0.015;
    var vadFrames = 0;
    var vadConfirm = 3;
    var vadInterruptSent = false;

    processor.onaudioprocess = function (e) {
      if (!_s.active) return;
      if (_s.voiceState === 'MUTED') return;

      var input = e.inputBuffer.getChannelData(0);

      // Compute RMS energy
      var sum = 0;
      for (var k = 0; k < input.length; k++) sum += input[k] * input[k];
      var rms = Math.sqrt(sum / input.length);

      // Barge-in detection
      var modelPlaying = _s.audioPlaying && _s.scheduledSources && _s.scheduledSources.length > 0;
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

      // Post-turn cooldown (500ms)
      if (_s.turnCompleteAt > 0 && (Date.now() - _s.turnCompleteAt) < 500) return;

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

  var WATCHDOG_TIMEOUT = 12000;

  function _startWatchdog() {
    _stopWatchdog();
    _s.clientLastActivityAt = Date.now();
    _s.clientWatchdogInterval = setInterval(function () {
      if (!_s.active) { _stopWatchdog(); return; }
      if (Date.now() - _s.clientLastActivityAt > WATCHDOG_TIMEOUT) {
        _stopWatchdog();
        _s.liveError = 'Connection lost.';
        _setOrbState('error');
        _setStatus(_cfg.lang.startsWith('de') ? 'Keine Antwort vom Server.' : 'No response from server.');
        _playErrorTone();
        _updateUI();
        setTimeout(_sessionStop, 3000);
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
    if (_root) return;
    _root = document.createElement('div');
    _root.className = 'vtorb-overlay';
    _root.setAttribute('role', 'dialog');
    _root.setAttribute('aria-modal', 'true');

    // ORB shell
    var shell = document.createElement('div');
    shell.className = 'vtorb-shell vtorb-st-connecting';
    var orb = document.createElement('div');
    orb.className = 'vtorb-large vtorb-large-idle';
    shell.appendChild(orb);
    _root.appendChild(shell);

    // Status
    var status = document.createElement('div');
    status.className = 'vtorb-status';
    _root.appendChild(status);

    // Controls
    var controls = document.createElement('div');
    controls.className = 'vtorb-controls';

    var micBtn = document.createElement('button');
    micBtn.className = 'vtorb-btn vtorb-btn-mic';
    micBtn.innerHTML = _ICONS.mic;
    micBtn.setAttribute('aria-label', 'Toggle microphone');
    micBtn.addEventListener('click', _toggleMute);
    controls.appendChild(micBtn);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'vtorb-btn vtorb-btn-close';
    closeBtn.innerHTML = _ICONS.close;
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', _hide);
    controls.appendChild(closeBtn);

    _root.appendChild(controls);
    document.body.appendChild(_root);
  }

  function _setOrbState(state) {
    if (!_root) return;
    var shell = _root.querySelector('.vtorb-shell');
    if (!shell) return;
    var states = ['ready', 'listening', 'thinking', 'speaking', 'paused', 'connecting', 'error'];
    states.forEach(function (s) { shell.classList.remove('vtorb-st-' + s); });
    shell.classList.add('vtorb-st-' + state);

    // Update large ORB animation class
    var orb = shell.querySelector('.vtorb-large');
    if (orb) {
      orb.className = 'vtorb-large';
      var map = { listening: 'listening', thinking: 'thinking', speaking: 'speaking', paused: 'muted', connecting: 'idle', ready: 'idle', error: 'idle' };
      orb.classList.add('vtorb-large-' + (map[state] || 'idle'));
    }
  }

  function _setStatus(text) {
    if (!_root) return;
    var el = _root.querySelector('.vtorb-status');
    if (!el) return;
    el.textContent = text || '';
    // Apply color class
    el.className = 'vtorb-status';
    if (_s.voiceState === 'LISTENING') el.classList.add('vtorb-status-listening');
    else if (_s.voiceState === 'THINKING') el.classList.add('vtorb-status-thinking');
    else if (_s.voiceState === 'SPEAKING') el.classList.add('vtorb-status-speaking');
    else if (_s.liveError) el.classList.add('vtorb-status-error');
  }

  function _updateUI() {
    // Update mic button
    if (!_root) return;
    var micBtn = _root.querySelector('.vtorb-btn-mic');
    if (micBtn) {
      var muted = _s.voiceState === 'MUTED';
      micBtn.innerHTML = muted ? _ICONS.micOff : _ICONS.mic;
      micBtn.classList.toggle('vtorb-muted', muted);
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
      _s.voiceState = 'LISTENING';
      _setOrbState('listening');
      _setStatus(_cfg.lang.startsWith('de') ? 'Ich höre zu...' : 'Listening...');
    } else {
      _s.voiceState = 'MUTED';
      _setOrbState('paused');
      _setStatus(_cfg.lang.startsWith('de') ? 'Mikrofon stumm' : 'Microphone muted');
    }
    _updateUI();
  }

  function _show() {
    if (!_cfg.gw) {
      console.error('[VTOrb] No gateway URL — call VitanaOrb.init({gatewayUrl}) or load this script from the gateway.');
      return;
    }
    _injectStyles();
    _renderOverlay();
    _renderFab();
    _s.overlayVisible = true;
    _root.classList.add('vtorb-visible');
    _updateUI();
    _sessionStart();
  }

  function _hide() {
    _sessionStop();
    _s.overlayVisible = false;
    if (_root) _root.classList.remove('vtorb-visible');
    _updateUI();
  }

  // ============================================================
  // 12. PUBLIC API
  // ============================================================

  window.VitanaOrb = {
    _loaded: true,

    init: function (opts) {
      opts = opts || {};
      _cfg.gw = (opts.gatewayUrl || '').replace(/\/$/, '');
      _cfg.token = opts.authToken || '';
      _cfg.lang = opts.lang || 'en-US';

      _injectStyles();
      _renderOverlay();
      _renderFab();
      console.log('[VTOrb] Initialized — gateway: ' + _cfg.gw + ', lang: ' + _cfg.lang);
    },

    show: _show,
    hide: _hide,

    toggle: function () {
      if (_s.overlayVisible) _hide(); else _show();
    },

    setAuth: function (token) {
      _cfg.token = token || '';
    },

    setLang: function (lang) {
      _cfg.lang = lang || 'en-US';
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
    }
  };

})(window);
