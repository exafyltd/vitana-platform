/**
 * VTID-03706 — ORB Voice Bench: TTS output + full-duplex/barge-in, on a real
 * device, with real audio.
 *
 * WHY THIS EXISTS
 * ---------------
 * Opening the mic during playback is only safe if the browser's echo
 * canceller keeps speaker bleed BELOW the gate's open threshold. The widget
 * carries measured evidence that this is a real risk: a previous 0.015
 * threshold "triggered on echo, causing constant interruptions" — Nova
 * interrupting itself in a loop.
 *
 * That property cannot be established by a unit test (there is no acoustic
 * path) or by viewport emulation (Playwright renders pixels, not sound). It
 * needs a real speaker, a real microphone, and a real room. This page is
 * that test, and it is deliberately self-contained: no gateway call, no ORB
 * session, no Supabase, no writes anywhere. It is safe to open against any
 * host, including production, because it touches nothing.
 *
 * The gate maths below MIRRORS `evaluateDuplexGateFrame` in
 * `services/gateway/src/orb/live/duplex/full-duplex-gate.ts`. Keeping a
 * third copy is a real cost; the alternative — testing a gate that is not
 * the gate — would make a green result meaningless.
 */
(function () {
  'use strict';

  // MIRRORS DUPLEX_GATE (full-duplex-gate.ts) and orb-widget.js.
  var GATE = {
    openRms: 0.05,
    closeRms: 0.025,
    hangoverMs: 400,
    aecWarmupMs: 250,
    bargeConfirmFrames: 2,
  };

  var FRAME_SAMPLES = 1024;
  var SAMPLE_RATE = 16000;

  var el = {};
  [
    'btn-echo', 'btn-speech', 'btn-stop', 'status', 'bar-rms', 'val-rms',
    'stat-gate', 'stat-playing', 'stat-peak',
    'stat-frames', 'stat-silent', 'stat-barge', 'verdict', 'log',
    'cfg-open', 'cfg-close', 'cfg-hangover', 'cfg-warmup', 'cfg-confirm',
    'note-open', 'note-close',
    // TTS bench + tabs
    'tab-tts', 'tab-duplex', 'pane-tts', 'pane-duplex',
    'tts-base', 'tts-text', 'tts-lang', 'tts-status', 'tts-rows', 'tts-verdict',
    'btn-tts-all', 'btn-tts-one',
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  // RMS is displayed on a 0..0.3 scale — conversational speech tops out
  // around 0.3, so a 0..1 bar would render every real signal as a sliver.
  var BAR_MAX = 0.3;

  var state = null;

  function log(line) {
    var t = new Date().toISOString().slice(11, 23);
    el.log.textContent += '[' + t + '] ' + line + '\n';
    el.log.scrollTop = el.log.scrollHeight;
  }

  function setVerdict(kind, text) {
    el.verdict.className = 'verdict verdict-' + kind;
    el.verdict.textContent = text;
  }

  function renderConfig() {
    el['cfg-open'].textContent = GATE.openRms;
    el['cfg-close'].textContent = GATE.closeRms;
    el['cfg-hangover'].textContent = GATE.hangoverMs + ' ms';
    el['cfg-warmup'].textContent = GATE.aecWarmupMs + ' ms';
    el['cfg-confirm'].textContent =
      GATE.bargeConfirmFrames + ' (~' +
      Math.round(GATE.bargeConfirmFrames * (FRAME_SAMPLES / SAMPLE_RATE) * 1000) + ' ms)';
    el['note-open'].textContent = String(GATE.openRms);
    el['note-close'].textContent = String(GATE.closeRms);
    el['bar-rms'].max = BAR_MAX;
  }

  /**
   * The gate, frame by frame. Same decisions, same order, same reasons as
   * the widget — see full-duplex-gate.ts for the rationale behind each
   * branch (warm-up, hysteresis, voiced-only confirmation).
   */
  function evaluateFrame(rms, nowMs) {
    var s = state;

    if (s.playbackStartedAt > 0 && (nowMs - s.playbackStartedAt) < GATE.aecWarmupMs) {
      s.gateOpen = false;
      s.openFrames = 0;
      return { passthrough: false, barge: false, warmup: true };
    }

    if (s.gateOpen) {
      if (rms > GATE.closeRms) {
        s.lastVoiceAt = nowMs;
      } else if (nowMs - s.lastVoiceAt >= GATE.hangoverMs) {
        s.gateOpen = false;
      }
    } else if (rms > GATE.openRms) {
      s.gateOpen = true;
      s.lastVoiceAt = nowMs;
    }

    if (!s.gateOpen) {
      s.openFrames = 0;
      return { passthrough: false, barge: false, warmup: false };
    }

    // Voiced frames only — the hangover must not tick a transient up to the
    // confirmation threshold in silence.
    if (rms > GATE.closeRms) s.openFrames++;

    var barge = !s.bargeSent && s.openFrames >= GATE.bargeConfirmFrames;
    if (barge) s.bargeSent = true;
    return { passthrough: true, barge: barge, warmup: false };
  }

  function render(rms) {
    // `value` is a property, not a style — no inline CSS, nothing for a
    // strict `style-src` to reject.
    el['bar-rms'].value = Math.min(BAR_MAX, rms);
    var band = rms > GATE.openRms ? ' bar-hot' : (rms > GATE.closeRms ? ' bar-warm' : '');
    el['bar-rms'].className = 'bar' + band;
    el['val-rms'].textContent = rms.toFixed(3);
    el['stat-gate'].textContent = state.gateOpen ? 'OPEN' : 'shut';
    el['stat-gate'].className = 'pill ' + (state.gateOpen ? 'pill-open' : '');
    el['stat-playing'].textContent = state.playing ? 'yes' : 'no';
    el['stat-playing'].className = 'pill ' + (state.playing ? 'pill-on' : '');
    el['stat-peak'].textContent = state.peakRms.toFixed(3);
    el['stat-frames'].textContent = String(state.framesReal);
    el['stat-silent'].textContent = String(state.framesSilent);
    el['stat-barge'].textContent = String(state.bargeCount);
  }

  /**
   * A speech-band test signal. A pure sine is an unrealistically easy target
   * for an echo canceller; AEC performance on a narrowband tone tells you
   * little about how it copes with a voice. This stacks a few harmonics in
   * the vocal range with a slow amplitude wobble so the canceller has
   * something closer to speech to track.
   */
  function startTone(ctx) {
    var master = ctx.createGain();
    master.gain.value = 0.28;
    master.connect(ctx.destination);

    var wobble = ctx.createGain();
    wobble.gain.value = 1;
    wobble.connect(master);

    var lfo = ctx.createOscillator();
    var lfoGain = ctx.createGain();
    lfo.frequency.value = 3.1; // syllable-rate amplitude variation
    lfoGain.gain.value = 0.45;
    lfo.connect(lfoGain);
    lfoGain.connect(wobble.gain);
    lfo.start();

    var oscs = [180, 340, 700, 1250].map(function (f, i) {
      var o = ctx.createOscillator();
      o.type = i === 0 ? 'sawtooth' : 'sine';
      o.frequency.value = f;
      var g = ctx.createGain();
      g.gain.value = 0.5 / (i + 1);
      o.connect(g);
      g.connect(wobble);
      o.start();
      return o;
    });

    return function stop() {
      oscs.forEach(function (o) { try { o.stop(); } catch (e) { /* ok */ } });
      try { lfo.stop(); } catch (e) { /* ok */ }
      try { master.disconnect(); } catch (e) { /* ok */ }
    };
  }

  async function run(mode) {
    if (state) return;

    el['btn-echo'].disabled = true;
    el['btn-speech'].disabled = true;
    el['btn-stop'].disabled = false;
    setVerdict('idle', 'Running…');

    var stream;
    try {
      // IDENTICAL constraints to orb-widget.js `_startAudioCapture` — testing
      // with different constraints would test a different echo canceller.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: SAMPLE_RATE,
        },
      });
    } catch (err) {
      el.status.textContent = 'Microphone denied or unavailable: ' + (err && err.message);
      setVerdict('fail', 'Cannot run — no microphone access.');
      el['btn-echo'].disabled = false;
      el['btn-speech'].disabled = false;
      el['btn-stop'].disabled = true;
      return;
    }

    var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    if (ctx.state === 'suspended') await ctx.resume();

    state = {
      mode: mode,
      ctx: ctx,
      stream: stream,
      gateOpen: false,
      lastVoiceAt: 0,
      openFrames: 0,
      bargeSent: false,
      bargeCount: 0,
      playing: false,
      playbackStartedAt: 0,
      peakRms: 0,
      peakDuringPlayback: 0,
      framesReal: 0,
      framesSilent: 0,
      openingsDuringPlayback: 0,
      stopTone: null,
      processor: null,
      source: null,
    };

    var source = ctx.createMediaStreamSource(stream);
    var processor = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
    state.source = source;
    state.processor = processor;

    processor.onaudioprocess = function (e) {
      if (!state) return;
      var input = e.inputBuffer.getChannelData(0);
      var sum = 0;
      for (var i = 0; i < input.length; i++) sum += input[i] * input[i];
      var rms = Math.sqrt(sum / input.length);

      if (rms > state.peakRms) state.peakRms = rms;

      if (!state.playing) {
        // Outside playback the gate does not apply — frames always flow.
        state.framesReal++;
        render(rms);
        return;
      }

      if (rms > state.peakDuringPlayback) state.peakDuringPlayback = rms;

      var wasOpen = state.gateOpen;
      var d = evaluateFrame(rms, Date.now());

      if (d.passthrough) state.framesReal++; else state.framesSilent++;

      if (!wasOpen && state.gateOpen) {
        state.openingsDuringPlayback++;
        log('gate OPEN at rms=' + rms.toFixed(3));
      }
      if (d.barge) {
        state.bargeCount++;
        log('BARGE confirmed at rms=' + rms.toFixed(3));
      }
      render(rms);
    };

    source.connect(processor);
    // ScriptProcessorNode only fires onaudioprocess while connected to a
    // destination. Route through a muted gain so the mic is NOT looped back
    // into the speaker — that would be a feedback path, not an echo test.
    var sink = ctx.createGain();
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(ctx.destination);

    el.log.textContent = '';
    log('mode=' + mode + ' sampleRate=' + ctx.sampleRate);

    // Short baseline before the speaker starts, so the room's own noise
    // floor is on record and a noisy environment is not mistaken for echo.
    el.status.textContent = 'Measuring room noise floor — stay silent…';
    await new Promise(function (r) { setTimeout(r, 1200); });
    log('room noise floor peak rms=' + state.peakRms.toFixed(3));
    if (state.peakRms > GATE.closeRms) {
      log('WARNING: ambient noise already exceeds closeRms — results will be pessimistic.');
    }

    state.playing = true;
    state.playbackStartedAt = Date.now();
    state.stopTone = startTone(ctx);
    el.status.textContent = mode === 'echo'
      ? 'Playing — STAY SILENT. Any gate opening is echo.'
      : 'Playing — TALK OVER IT now, at normal volume.';
    log('playback started');

    await new Promise(function (r) { setTimeout(r, 8000); });
    if (state) finish();
  }

  function finish() {
    if (!state) return;
    var s = state;

    if (s.stopTone) s.stopTone();
    try { s.processor.disconnect(); } catch (e) { /* ok */ }
    try { s.source.disconnect(); } catch (e) { /* ok */ }
    try { s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ok */ }
    try { s.ctx.close(); } catch (e) { /* ok */ }

    log('playback stopped — peak rms during playback = ' + s.peakDuringPlayback.toFixed(3));
    log('gate openings during playback = ' + s.openingsDuringPlayback);

    if (s.mode === 'echo') {
      if (s.openingsDuringPlayback === 0) {
        var headroom = GATE.openRms - s.peakDuringPlayback;
        setVerdict('pass',
          'PASS — echo never opened the gate. Peak echo ' +
          s.peakDuringPlayback.toFixed(3) + ' vs openRms ' + GATE.openRms +
          ' (headroom ' + headroom.toFixed(3) + '). Full duplex is safe on this device.');
      } else {
        setVerdict('fail',
          'FAIL — echo opened the gate ' + s.openingsDuringPlayback + ' time(s), peak ' +
          s.peakDuringPlayback.toFixed(3) + ' ≥ openRms ' + GATE.openRms +
          '. Vitana would interrupt herself here. Do NOT enable full duplex for this ' +
          'device class until AEC improves or openRms is raised above the measured peak.');
      }
    } else {
      if (s.bargeCount > 0) {
        setVerdict('pass',
          'PASS — speech opened the gate and barge-in fired ' + s.bargeCount +
          ' time(s). Peak ' + s.peakDuringPlayback.toFixed(3) + '.');
      } else {
        setVerdict('fail',
          'FAIL — speech never confirmed barge-in. Peak during playback was ' +
          s.peakDuringPlayback.toFixed(3) + ' vs openRms ' + GATE.openRms +
          '. Either you stayed silent, or this mic is too quiet and openRms is too high.');
      }
    }

    // Repaint the live panel to its resting state BEFORE dropping `state`.
    // Without this the run ends with GATE reading OPEN and PLAYING reading
    // yes — frozen at whatever the last processed frame happened to be —
    // which reads as "the gate is still open right now" and directly
    // contradicts the verdict sitting under it.
    s.gateOpen = false;
    s.playing = false;
    state = s;
    render(0);

    state = null;
    el['btn-echo'].disabled = false;
    el['btn-speech'].disabled = false;
    el['btn-stop'].disabled = true;
    el.status.textContent = 'Done.';
  }

  el['btn-echo'].addEventListener('click', function () { run('echo'); });
  el['btn-speech'].addEventListener('click', function () { run('speech'); });
  el['btn-stop'].addEventListener('click', finish);

  // ==================================================================
  // TTS BENCH
  // ==================================================================
  //
  // WHY THIS IS NOT COVERED ELSEWHERE
  // ---------------------------------
  // `/api/v1/voice-lab/nova/tests/run` checks Nova config, the selector
  // table, codecs and stream latency. `/tests/eval` checks which tools the
  // model would call. `runVoiceProbe()` GETs `/api/v1/orb/health` and asserts
  // some booleans — its own comment records that the audio-path probe was
  // never built. None of them produce a sound.
  //
  // So the failure mode none of them can see is the one that actually reaches
  // a user: a 200 OK carrying audio that is silent, truncated, or spoken by
  // the wrong voice. This decodes what the gateway returns and measures it.

  // Every locale the gateway's TTS layer claims to serve. `sr` is included
  // deliberately even though it is expected to fail — a bench that only lists
  // the languages known to work cannot tell you when one stops working.
  var TTS_LANGS = ['de', 'en', 'es', 'fr', 'pt', 'pl', 'ru', 'zh', 'ar', 'sr'];

  // Known gap, asserted rather than hidden: Polly has no Serbian voice in any
  // engine. Verified against the live API — 106 voices, 42 language codes,
  // nothing matching sr/hr/bs/sh. A failure here is EXPECTED; a success is
  // news (someone added a provider) and the verdict says so.
  var TTS_EXPECTED_FAIL = { sr: 'no Polly voice for sr in any engine' };

  // Below this peak amplitude the decoded audio is silence for practical
  // purposes. This is the check that a status code cannot make: TTS can
  // return a well-formed, correctly-sized, completely inaudible buffer.
  var TTS_SILENCE_PEAK = 0.01;

  var ttsRunning = false;

  function ttsBase() {
    var v = (el['tts-base'].value || '').trim().replace(/\/+$/, '');
    return v; // '' => same origin, which is the normal case (served by the gateway)
  }

  function initTts() {
    var sel = el['tts-lang'];
    TTS_LANGS.forEach(function (l) {
      var o = document.createElement('option');
      o.value = l;
      o.textContent = l + (TTS_EXPECTED_FAIL[l] ? ' (expected fail)' : '');
      sel.appendChild(o);
    });
    el['btn-tts-all'].addEventListener('click', function () { runTtsSweep(TTS_LANGS); });
    el['btn-tts-one'].addEventListener('click', function () { runTtsSweep([sel.value]); });
  }

  function initTabs() {
    function show(which) {
      var tts = which === 'tts';
      el['pane-tts'].className = tts ? '' : 'hidden';
      el['pane-duplex'].className = tts ? 'hidden' : '';
      el['tab-tts'].className = 'tab' + (tts ? ' tab-on' : '');
      el['tab-duplex'].className = 'tab' + (tts ? '' : ' tab-on');
      el['tab-tts'].setAttribute('aria-selected', String(tts));
      el['tab-duplex'].setAttribute('aria-selected', String(!tts));
    }
    el['tab-tts'].addEventListener('click', function () { show('tts'); });
    el['tab-duplex'].addEventListener('click', function () { show('duplex'); });
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Decode and PLAY the returned audio, and report what it actually contains.
   *
   * Web Audio rather than an <audio> element on purpose: decodeAudioData both
   * proves the bytes are really decodable audio (not an error body with an
   * audio mime) and hands back the samples, so peak amplitude and true
   * duration can be measured. An <audio> element would happily "play" silence
   * and report success.
   */
  async function decodeAndPlay(bytes) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      // decodeAudioData detaches the buffer, so hand it a copy — the caller
      // still needs `bytes.length` for the size column afterwards.
      var buf = await ctx.decodeAudioData(bytes.slice().buffer);
      var peak = 0;
      for (var c = 0; c < buf.numberOfChannels; c++) {
        var d = buf.getChannelData(c);
        for (var i = 0; i < d.length; i += 16) {   // stride: peak, not an average
          var a = Math.abs(d[i]);
          if (a > peak) peak = a;
        }
      }
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      await new Promise(function (r) { src.onended = r; setTimeout(r, (buf.duration + 0.5) * 1000); });
      return { seconds: buf.duration, peak: peak };
    } finally {
      try { ctx.close(); } catch (e) { /* ok */ }
    }
  }

  function ttsRow(lang) {
    var tr = document.createElement('tr');
    for (var i = 0; i < 9; i++) tr.appendChild(document.createElement('td'));
    tr.children[0].textContent = lang;
    tr.children[1].textContent = '…';
    el['tts-rows'].appendChild(tr);
    return tr;
  }

  function fillRow(tr, cells, cls) {
    for (var i = 0; i < cells.length; i++) tr.children[i + 1].textContent = cells[i];
    if (cls) tr.className = cls;
  }

  async function runOneTts(lang, text) {
    var tr = ttsRow(lang);
    var t0 = Date.now();
    var res, body;
    try {
      res = await fetch(ttsBase() + '/api/v1/orb/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, lang: lang }),
      });
    } catch (err) {
      fillRow(tr, ['network', '—', '—', String(Date.now() - t0), '—', '—', '—', 'FAIL ' + (err && err.message)], 'row-bad');
      return { lang: lang, ok: false, reason: 'network' };
    }
    var ms = Date.now() - t0;

    try { body = await res.json(); } catch (e) { body = null; }

    if (!res.ok || !body || !body.ok || !body.audio_b64) {
      var why = (body && (body.error || body.message)) || ('HTTP ' + res.status);
      var expected = TTS_EXPECTED_FAIL[lang];
      fillRow(tr,
        [String(res.status), body && body.voice_type || '—', body && body.voice || '—',
         String(ms), '—', '—', '—',
         expected ? 'EXPECTED FAIL — ' + expected : 'FAIL ' + why],
        expected ? 'row-warn' : 'row-bad');
      return { lang: lang, ok: false, expected: !!expected, reason: why };
    }

    var bytes = b64ToBytes(body.audio_b64);
    var kb = (bytes.length / 1024).toFixed(1);

    var played;
    try {
      played = await decodeAndPlay(bytes);
    } catch (err) {
      // 200 + audio_b64 that will not decode is a real failure, and one no
      // status-code check would ever surface.
      fillRow(tr, [String(res.status), body.voice_type || '—', body.voice || '—', String(ms), kb, '—', '—',
        'FAIL undecodable: ' + (err && err.message)], 'row-bad');
      return { lang: lang, ok: false, reason: 'undecodable' };
    }

    var silent = played.peak < TTS_SILENCE_PEAK;
    // The gateway echoes back the lang it actually served. If that is not the
    // lang asked for, a user gets fluent audio in the wrong language — which
    // sounds like a working system and is not.
    var langMismatch = body.lang && body.lang !== lang;

    var verdict = silent ? 'FAIL silent (peak ' + played.peak.toFixed(3) + ')'
      : langMismatch ? 'FAIL served lang=' + body.lang
      : 'PASS';

    fillRow(tr, [String(res.status), body.voice_type || '—', body.voice || '—', String(ms), kb,
      played.seconds.toFixed(2), played.peak.toFixed(3), verdict],
      verdict === 'PASS' ? 'row-ok' : 'row-bad');

    return { lang: lang, ok: verdict === 'PASS', reason: verdict };
  }

  async function runTtsSweep(langs) {
    if (ttsRunning) return;
    ttsRunning = true;
    el['btn-tts-all'].disabled = true;
    el['btn-tts-one'].disabled = true;
    el['tts-rows'].textContent = '';
    el['tts-verdict'].className = 'verdict verdict-idle';
    el['tts-verdict'].textContent = 'Running…';

    var text = el['tts-text'].value || 'Vitana voice check.';
    var results = [];
    for (var i = 0; i < langs.length; i++) {
      el['tts-status'].textContent = 'Synthesizing + playing ' + langs[i] +
        ' (' + (i + 1) + '/' + langs.length + ')…';
      // Serial on purpose: they play out loud, and overlapping audio would
      // make the peak/duration numbers meaningless.
      results.push(await runOneTts(langs[i], text));
    }

    var unexpectedFails = results.filter(function (r) { return !r.ok && !r.expected; });
    var expectedFails = results.filter(function (r) { return !r.ok && r.expected; });
    var surprises = results.filter(function (r) { return r.ok && TTS_EXPECTED_FAIL[r.lang]; });
    var passed = results.filter(function (r) { return r.ok; }).length;

    var msg = passed + '/' + results.length + ' spoke audible, correct-language audio.';
    if (expectedFails.length) {
      msg += ' Known gaps (not regressions): ' +
        expectedFails.map(function (r) { return r.lang; }).join(', ') + '.';
    }
    if (surprises.length) {
      msg += ' NEW: ' + surprises.map(function (r) { return r.lang; }).join(', ') +
        ' now works — a provider was added; update TTS_EXPECTED_FAIL.';
    }
    if (unexpectedFails.length) {
      el['tts-verdict'].className = 'verdict verdict-fail';
      el['tts-verdict'].textContent = 'FAIL — ' +
        unexpectedFails.map(function (r) { return r.lang + ': ' + r.reason; }).join(' · ') +
        '. ' + msg;
    } else {
      el['tts-verdict'].className = 'verdict verdict-pass';
      el['tts-verdict'].textContent = 'PASS — ' + msg;
    }

    el['tts-status'].textContent = 'Done.';
    el['btn-tts-all'].disabled = false;
    el['btn-tts-one'].disabled = false;
    ttsRunning = false;
  }

  renderConfig();
  initTts();
  initTabs();
})();
