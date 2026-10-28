/*
 * Operator Console — live pipeline tree (VTID-05069)
 *
 * Inside an Operator thread, every VTID the thread works on is shown as a
 * collapsible run card:
 *   Plan → Repositories (vitana-platform, vitana-v1: Implement → Pull request →
 *   CI → Fix forward → Merge) → Staging deploy → STAGING-VERIFY → Gate 2 → Production
 * with a status icon per node, a "now:" line under the step Kiro is on and a
 * red line under a failed node. The thread list gets a status dot per thread.
 *
 * Data (read-only, server-side — services/operator-runs/run-view.ts):
 *   GET /api/v1/operator/runs/by-thread/:threadId   linked VTIDs + their views
 *   GET /api/v1/operator/runs/:vtid/stream          SSE `view` frames (changes only)
 * The stream is read with fetch() so the Command Hub's Authorization header is
 * sent (an EventSource cannot send headers); one stream per visible, expanded,
 * unfinished card, closed when the thread is left or the card collapses, and
 * re-opened on window focus.
 *
 * Stop calls the EXISTING cancel routes (Kiro run cancel, Dev Autopilot
 * execution cancel). "Yes, publish" opens the EXISTING PUBLISH flow (the
 * header PUBLISH button) for the gateway, and links to the existing
 * vitana-v1 production deploy workflow for the community app.
 *
 * Hooks used by app.js (the only coupling):
 *   window.PipelineTree.renderThreadCards(threadId) → element (bottom of the thread)
 *   window.PipelineTree.threadDot(threadId)         → element (thread list row)
 *
 * CSP: no inline scripts or styles; DOM built with createElement/textContent
 * only (pipeline-tree.css holds every style). Admin console, English by design.
 */
(function (root) {
  'use strict';

  var API = '/api/v1/operator/runs';
  var THREAD_TTL_MS = 60000;
  var MAX_LOADS_PER_MIN = 12;
  var TICK_MS = 10000;
  var DOT_THREADS_MAX = 8;
  var DOT_TTL_MS = 120000;

  var STATUS_TEXT = {
    pending: 'waiting to start',
    running: 'running now',
    passed: 'passed',
    failed: 'failed',
    waiting: 'waiting for you',
    skipped: 'not needed',
    unknown: 'unknown (source unavailable)'
  };
  var ICON_GLYPH = { passed: '✓', failed: '✕', waiting: '⏸', unknown: '?' };
  var VIEW_STATUS_DOT = { running: 'running', failed: 'failed', waiting: 'waiting', done: 'done' };
  var DOT_TEXT = { running: 'Work running', failed: 'A step failed', waiting: 'Waiting for you', done: 'Done' };

  // ---- module state (survives renderApp(), which rebuilds the DOM) --------
  var threads = {};   // threadId -> { at, loading, vtids, error }
  var views = {};     // vtid -> RunView
  var updatedAt = {}; // vtid -> ms of the last view received
  var ui = {};        // vtid -> { collapsed?: bool, nodes: { id: bool }, showCommits: bool, note: string }
  var streams = {};   // vtid -> { controller, threadId }
  var loadTimes = [];
  var queue = [];
  var inFlight = 0;
  var activeThread = null;
  var ticker = null;
  var dotThreads = [];

  function nowMs() { return Date.now(); }

  function uiOf(vtid) {
    if (!ui[vtid]) ui[vtid] = { nodes: {}, showCommits: false, note: '' };
    return ui[vtid];
  }

  function headers() {
    var h = { Accept: 'application/json' };
    if (typeof root.buildContextHeaders === 'function') {
      try { h = root.buildContextHeaders(h) || h; } catch (e) { /* keep defaults */ }
    }
    return h;
  }

  // ---- formatting ---------------------------------------------------------
  function hhmm(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var h = d.getHours(); var m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function duration(ms) {
    if (!(ms >= 0)) return '';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    var h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  function ago(ms) {
    if (!(ms >= 0)) return '';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.round(m / 60) + 'h ago';
  }

  // ---- DOM helpers (document injectable for tests) -------------------------
  function mk(doc, tag, cls, text) {
    var el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null && text !== '') el.textContent = String(text);
    return el;
  }

  function statusIcon(doc, status) {
    var s = STATUS_TEXT[status] ? status : 'unknown';
    var el = mk(doc, 'span', 'pt-ic pt-ic--' + s, ICON_GLYPH[s] || '');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', STATUS_TEXT[s]);
    el.setAttribute('title', STATUS_TEXT[s]);
    return el;
  }

  function link(doc, href, label, cls) {
    var a = mk(doc, 'a', cls || 'pt-link', label);
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    return a;
  }

  function button(doc, cls, label, onClick, attrs) {
    var b = mk(doc, 'button', 'pt-btn' + (cls ? ' ' + cls : ''), label);
    b.setAttribute('type', 'button');
    if (attrs) Object.keys(attrs).forEach(function (k) { b.setAttribute(k, attrs[k]); });
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // ---- the card -----------------------------------------------------------
  /**
   * Render one run card. Pure apart from the callbacks in `opts`:
   *   opts.doc, opts.now (ms), opts.state (the per-VTID ui state), opts.live (bool),
   *   opts.updatedAt (ms), opts.onToggleCard(), opts.onToggleNode(id),
   *   opts.onToggleCommits(), opts.onStop(), opts.onPublish(service)
   */
  function renderCard(view, opts) {
    var doc = opts.doc || root.document;
    var st = opts.state || { nodes: {}, showCommits: false, note: '' };
    var now = opts.now || nowMs();
    var collapsed = st.collapsed !== undefined ? st.collapsed : !!view.terminal;

    var card = mk(doc, 'section', 'pt-run pt-run--' + view.status + (collapsed ? ' pt-run--collapsed' : ''));
    card.setAttribute('aria-label', 'Pipeline ' + view.vtid);
    card.setAttribute('data-vtid', view.vtid);

    // Header
    var head = mk(doc, 'div', 'pt-run-h');
    var headStatus = view.status === 'done' ? 'passed' : view.status;
    head.appendChild(statusIcon(doc, headStatus));
    head.appendChild(mk(doc, 'span', 'pt-ttl', view.vtid + (view.title ? ' · ' + view.title : '')));
    var sum = mk(doc, 'span', 'pt-sum', view.summary);
    sum.setAttribute('aria-live', 'polite');
    head.appendChild(sum);
    head.appendChild(mk(doc, 'span', 'pt-sp'));
    if (view.started_at) {
      var started = Date.parse(view.started_at);
      var end = view.terminal && view.generated_at ? Date.parse(view.generated_at) : now;
      head.appendChild(mk(doc, 'span', 'pt-meta pt-run-time', 'started ' + hhmm(view.started_at) + ' · ' + duration(end - started)));
    }
    head.appendChild(button(doc, '', collapsed ? 'Expand' : 'Collapse', opts.onToggleCard, { 'aria-expanded': collapsed ? 'false' : 'true' }));
    var act = view.actions || {};
    if (!view.terminal && (act.kiro_run_id || act.autopilot_execution_id)) {
      head.appendChild(button(doc, 'pt-btn--danger', 'Stop', opts.onStop, { 'aria-label': 'Stop the running work for ' + view.vtid }));
    }
    card.appendChild(head);

    if (!collapsed) {
      var tree = mk(doc, 'div', 'pt-tree');
      tree.setAttribute('role', 'list');
      // The plan heads the tree; every later stage is drawn one step in (as in the mockups).
      (view.nodes || []).forEach(function (n, i) { renderNode(doc, tree, n, i === 0 ? 0 : 1, view, st, opts); });
      card.appendChild(tree);
    }

    // Footer
    var foot = mk(doc, 'div', 'pt-foot');
    var upd = opts.updatedAt ? ago(now - opts.updatedAt) : '';
    var updated = mk(doc, 'span', 'pt-updated', (opts.live ? 'Live' : 'Not live') + (upd ? ' · updated ' + upd : ''));
    updated.setAttribute('data-updated', String(opts.updatedAt || ''));
    updated.setAttribute('data-live', opts.live ? '1' : '0');
    foot.appendChild(updated);
    foot.appendChild(mk(doc, 'span', '', 'Events: OASIS ' + view.vtid));
    if (view.stale) foot.appendChild(mk(doc, 'span', 'pt-warn', 'GitHub search budget reached — showing the last result'));
    if (view.unavailable && view.unavailable.length) {
      var un = mk(doc, 'span', 'pt-warn', 'Unavailable: ' + view.unavailable.join('; '));
      foot.appendChild(un);
    }
    if (st.note) foot.appendChild(mk(doc, 'span', 'pt-note', st.note));
    card.appendChild(foot);
    return card;
  }

  function renderNode(doc, tree, n, depth, view, st, opts) {
    var hasKids = n.children && n.children.length > 0;
    var open = hasKids && (st.nodes[n.id] !== undefined ? st.nodes[n.id] : !n.collapsed);
    var row = mk(doc, 'div', 'pt-row pt-lvl' + Math.min(depth, 3) + ' pt-row--' + n.status);
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-node', n.id);
    var node = mk(doc, 'div', 'pt-node');
    if (hasKids) {
      node.appendChild(button(doc, 'pt-car', open ? '▾' : '▸', function () { if (opts.onToggleNode) opts.onToggleNode(n.id, !open); }, {
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': (open ? 'Collapse ' : 'Expand ') + n.label
      }));
    } else {
      node.appendChild(mk(doc, 'span', 'pt-car pt-car--none'));
    }
    node.appendChild(statusIcon(doc, n.status));
    node.appendChild(mk(doc, 'span', 'pt-nm', n.label));
    if (n.chip) node.appendChild(mk(doc, 'span', 'pt-chip pt-chip--' + n.chip.kind, n.chip.text));
    if (n.detail) {
      var det = mk(doc, 'span', 'pt-det', n.detail);
      det.setAttribute('title', n.detail); // the full text where the line is cut short
      node.appendChild(det);
    }
    row.appendChild(node);

    var meta = mk(doc, 'div', 'pt-meta');
    (n.links || []).forEach(function (l) { meta.appendChild(link(doc, l.href, l.label)); });
    var metaText = [];
    if (n.meta) metaText.push(n.meta);
    if (n.at) {
      if (n.id === 'gate2' && n.status === 'waiting') metaText.push('waiting ' + duration((opts.now || nowMs()) - Date.parse(n.at)));
      else metaText.push(hhmm(n.at));
    }
    if (metaText.length) meta.appendChild(mk(doc, 'span', 'pt-meta-t', metaText.join(' · ')));
    row.appendChild(meta);
    tree.appendChild(row);

    if (n.error) tree.appendChild(mk(doc, 'div', 'pt-err pt-lvl' + Math.min(depth, 3), n.error));
    if (n.live) {
      var live = mk(doc, 'div', 'pt-live pt-lvl' + Math.min(depth, 3));
      live.appendChild(mk(doc, 'span', 'pt-live-l', 'now: '));
      live.appendChild(mk(doc, 'span', '', n.live));
      tree.appendChild(live);
    }
    if (n.id === 'gate2' && view.gate2 && n.status === 'waiting') tree.appendChild(renderGate2(doc, view, st, opts));
    if (open) n.children.forEach(function (c) { renderNode(doc, tree, c, depth + 1, view, st, opts); });
  }

  function renderGate2(doc, view, st, opts) {
    var g = view.gate2;
    var box = mk(doc, 'div', 'pt-gate');
    box.appendChild(mk(doc, 'span', 'pt-gate-q', g.question));
    var n = (g.commits || []).length;
    box.appendChild(button(doc, '', (st.showCommits ? 'Hide ' : 'Show ') + n + ' commit' + (n === 1 ? '' : 's'), opts.onToggleCommits, { 'aria-expanded': st.showCommits ? 'true' : 'false' }));
    (g.publish || []).forEach(function (p) {
      if (p.kind === 'publish_flow') {
        box.appendChild(button(doc, 'pt-btn--primary', (g.publish.length > 1 ? 'Yes, publish ' + p.service : 'Yes, publish'), function () { if (opts.onPublish) opts.onPublish(p.service); }));
      } else if (p.href) {
        box.appendChild(link(doc, p.href, 'Publish ' + p.service + ' ↗', 'pt-btn pt-btn--primary pt-btn--link'));
      }
    });
    if (st.showCommits) {
      var list = mk(doc, 'ul', 'pt-commits');
      list.setAttribute('aria-label', 'Commits a PUBLISH would ship');
      (g.commits || []).forEach(function (c) {
        var li = mk(doc, 'li', 'pt-commit' + (c.mine ? ' pt-commit--mine' : ''));
        li.appendChild(mk(doc, 'code', 'pt-sha', String(c.sha || '').slice(0, 7)));
        li.appendChild(mk(doc, 'span', 'pt-commit-msg', c.message));
        li.appendChild(mk(doc, 'span', 'pt-commit-tag', c.mine ? 'this VTID' : 'also ships'));
        list.appendChild(li);
      });
      if (g.commits_unavailable) list.appendChild(mk(doc, 'li', 'pt-commit pt-commit--na', 'Commit list unavailable — see the STAGING-VERIFY run.'));
      box.appendChild(list);
    }
    return box;
  }

  // ---- SSE parsing (fetch stream) -------------------------------------------
  /** Split an SSE text buffer into complete events; returns { events, rest }. */
  function parseSse(buffer) {
    var events = [];
    var parts = String(buffer).split(/\r?\n\r?\n/);
    var rest = parts.pop();
    parts.forEach(function (block) {
      var ev = 'message'; var data = [];
      block.split(/\r?\n/).forEach(function (line) {
        if (!line || line.charAt(0) === ':') return;
        var i = line.indexOf(':');
        var k = i < 0 ? line : line.slice(0, i);
        var v = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (k === 'event') ev = v; else if (k === 'data') data.push(v);
      });
      if (data.length) events.push({ event: ev, data: data.join('\n') });
    });
    return { events: events, rest: rest };
  }

  // ---- loading --------------------------------------------------------------
  function scheduleLoad(threadId, force, ttl) {
    var t = threads[threadId];
    if (t && (t.loading || t.queued)) return;
    if (!force && t && nowMs() - t.at < (ttl || THREAD_TTL_MS)) return;
    threads[threadId] = t || { at: 0, vtids: [], error: null };
    threads[threadId].queued = true;
    if (force) queue.unshift(threadId); else queue.push(threadId);
    pump();
  }

  function pump() {
    while (inFlight < 2 && queue.length) {
      var n = nowMs();
      while (loadTimes.length && n - loadTimes[0] > 60000) loadTimes.shift();
      if (loadTimes.length >= MAX_LOADS_PER_MIN) { setTimeout(pump, 5000); return; }
      loadTimes.push(n);
      var id = queue.shift();
      inFlight++;
      loadThread(id).then(done, done);
    }
    function done() { inFlight--; pump(); }
  }

  function loadThread(threadId) {
    var t = threads[threadId];
    t.queued = false;
    t.loading = true;
    if (typeof root.fetch !== 'function') { t.loading = false; return Promise.resolve(); }
    return root.fetch(API + '/by-thread/' + encodeURIComponent(threadId), { headers: headers() })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
      .then(function (body) {
        t.loading = false;
        t.at = nowMs();
        if (!body || !body.ok) { t.error = (body && body.error) || 'unavailable'; refreshDom(threadId); return; }
        t.error = null;
        t.vtids = body.vtids || [];
        (body.views || []).forEach(function (v) { views[v.vtid] = v; updatedAt[v.vtid] = nowMs(); });
        refreshDom(threadId);
        if (threadId === activeThread) syncStreams();
      })
      .catch(function (e) { t.loading = false; t.at = nowMs(); t.error = String(e && e.message || e); refreshDom(threadId); });
  }

  function threadViews(threadId) {
    var t = threads[threadId];
    if (!t) return [];
    return (t.vtids || []).map(function (v) { return views[v]; }).filter(Boolean);
  }

  // ---- streams --------------------------------------------------------------
  function wantsStream(v) {
    var st = uiOf(v.vtid);
    var collapsed = st.collapsed !== undefined ? st.collapsed : !!v.terminal;
    return !v.terminal && !collapsed;
  }

  function syncStreams() {
    var wanted = {};
    if (activeThread && (!root.document || !root.document.hidden)) {
      threadViews(activeThread).forEach(function (v) { if (wantsStream(v)) wanted[v.vtid] = true; });
    }
    Object.keys(streams).forEach(function (vtid) {
      if (!wanted[vtid] || streams[vtid].threadId !== activeThread) stopStream(vtid);
    });
    Object.keys(wanted).forEach(function (vtid) { if (!streams[vtid]) startStream(vtid, activeThread); });
  }

  function stopStream(vtid) {
    var s = streams[vtid];
    if (!s) return;
    delete streams[vtid];
    try { s.controller.abort(); } catch (e) { /* already closed */ }
  }

  function startStream(vtid, threadId) {
    if (typeof root.fetch !== 'function' || typeof root.AbortController !== 'function') return;
    var controller = new root.AbortController();
    var entry = { controller: controller, threadId: threadId };
    streams[vtid] = entry;
    var url = API + '/' + encodeURIComponent(vtid) + '/stream' + (threadId ? '?thread_id=' + encodeURIComponent(threadId) : '');
    root.fetch(url, { headers: headers(), signal: controller.signal }).then(function (res) {
      if (!res.ok || !res.body || !res.body.getReader) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var decoder = new root.TextDecoder();
      var buf = '';
      function read() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buf += decoder.decode(chunk.value, { stream: true });
          var parsed = parseSse(buf);
          buf = parsed.rest;
          parsed.events.forEach(function (e) {
            if (e.event !== 'view') return;
            try {
              var v = JSON.parse(e.data);
              views[v.vtid] = v;
              updatedAt[v.vtid] = nowMs();
              refreshDom(threadId);
            } catch (err) { /* ignore a malformed frame */ }
          });
          return read();
        });
      }
      return read();
    }).catch(function () { /* closed, aborted or failed: reconnects on focus */ })
      .then(function () {
        if (streams[vtid] === entry) delete streams[vtid];
        refreshDom(threadId);
      });
  }

  // ---- actions --------------------------------------------------------------
  function post(url, body) {
    var h = headers();
    h['Content-Type'] = 'application/json';
    return root.fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.ok; }, function () { return false; });
  }

  function stopRun(view, threadId) {
    var act = view.actions || {};
    if (typeof root.confirm === 'function' && !root.confirm('Stop the running work for ' + view.vtid + '?')) return;
    var calls = [];
    if (act.kiro_run_id) calls.push(post('/api/v1/operator/kiro/runs/' + encodeURIComponent(act.kiro_run_id) + '/cancel', {}));
    if (act.autopilot_execution_id) calls.push(post('/api/v1/dev-autopilot/executions/' + encodeURIComponent(act.autopilot_execution_id) + '/cancel', { reason: 'Stopped from the Operator run card' }));
    var st = uiOf(view.vtid);
    st.note = 'Stopping…';
    refreshDom(threadId);
    Promise.all(calls).then(function (oks) {
      st.note = oks.every(Boolean) ? 'Stop sent.' : 'Stop failed — try again.';
      scheduleLoad(threadId, true);
    });
  }

  function openPublish(service, vtid, threadId) {
    var doc = root.document;
    var btn = null;
    if (doc) {
      var all = doc.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) if ((all[i].textContent || '').trim() === 'PUBLISH') { btn = all[i]; break; }
    }
    if (btn) { btn.click(); return; }
    uiOf(vtid).note = 'Open PUBLISH in the header to promote the verified staging build.';
    refreshDom(threadId);
  }

  // ---- mounting -------------------------------------------------------------
  function cardFor(v, threadId) {
    var st = uiOf(v.vtid);
    return renderCard(v, {
      doc: root.document,
      state: st,
      now: nowMs(),
      live: !!streams[v.vtid],
      updatedAt: updatedAt[v.vtid],
      onToggleCard: function () {
        var collapsed = st.collapsed !== undefined ? st.collapsed : !!v.terminal;
        st.collapsed = !collapsed;
        if (threadId === activeThread) syncStreams();
        refreshDom(threadId);
      },
      onToggleNode: function (id, open) { st.nodes[id] = open; refreshDom(threadId); },
      onToggleCommits: function () { st.showCommits = !st.showCommits; refreshDom(threadId); },
      onStop: function () { stopRun(views[v.vtid] || v, threadId); },
      onPublish: function (service) { openPublish(service, v.vtid, threadId); }
    });
  }

  function fillCards(container, threadId) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var list = threadViews(threadId);
    container.hidden = list.length === 0;
    list.forEach(function (v) { container.appendChild(cardFor(v, threadId)); });
  }

  /** The run cards of a thread (newest VTID first); empty and hidden when none is linked. */
  function renderThreadCards(threadId) {
    var doc = root.document;
    var el = mk(doc, 'div', 'pt-runs');
    el.setAttribute('data-thread', threadId || '');
    if (!threadId) { el.hidden = true; return el; }
    if (activeThread !== threadId) { activeThread = threadId; }
    scheduleLoad(threadId, false);
    fillCards(el, threadId);
    ensureTicker();
    // The thread on screen changed or the DOM was rebuilt: streams follow it.
    setTimeout(syncStreams, 0);
    return el;
  }

  function dotStatus(threadId) {
    var v = threadViews(threadId)[0];
    return v ? (VIEW_STATUS_DOT[v.status] || null) : null;
  }

  function paintDot(el, threadId) {
    var s = dotStatus(threadId);
    el.className = 'pt-thread-dot' + (s ? ' pt-thread-dot--' + s : '');
    el.hidden = !s;
    if (s) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', DOT_TEXT[s]); el.setAttribute('title', DOT_TEXT[s]); }
  }

  /** A status dot for the thread list row (filled in once the thread's runs are known). */
  function threadDot(threadId) {
    var el = mk(root.document, 'span', 'pt-thread-dot');
    el.setAttribute('data-thread', threadId || '');
    if (!threadId) { el.hidden = true; return el; }
    // Only the most recent threads (the sidebar lists newest first) are polled for a dot.
    if (dotThreads.indexOf(threadId) < 0 && dotThreads.length < DOT_THREADS_MAX) dotThreads.push(threadId);
    if (dotThreads.indexOf(threadId) >= 0 || threadId === activeThread) scheduleLoad(threadId, false, threadId === activeThread ? THREAD_TTL_MS : DOT_TTL_MS);
    paintDot(el, threadId);
    return el;
  }

  function refreshDom(threadId) {
    var doc = root.document;
    if (!doc || !doc.querySelectorAll) return;
    var boxes = doc.querySelectorAll('.pt-runs');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].getAttribute('data-thread') === threadId) fillCards(boxes[i], threadId);
    var dots = doc.querySelectorAll('.pt-thread-dot');
    for (var j = 0; j < dots.length; j++) if (dots[j].getAttribute('data-thread') === threadId) paintDot(dots[j], threadId);
  }

  function ensureTicker() {
    if (ticker || typeof root.setInterval !== 'function') return;
    ticker = root.setInterval(function () {
      var doc = root.document;
      if (!doc || !doc.querySelector) return;
      var mounted = doc.querySelector('.pt-runs[data-thread]');
      if (!mounted) { Object.keys(streams).forEach(stopStream); activeThread = null; return; }
      var threadId = mounted.getAttribute('data-thread');
      if (threadId !== activeThread) { activeThread = threadId; syncStreams(); }
      if (threadId) scheduleLoad(threadId, false);
      var labels = doc.querySelectorAll('.pt-updated');
      for (var i = 0; i < labels.length; i++) {
        var at = Number(labels[i].getAttribute('data-updated'));
        if (at) labels[i].textContent = (labels[i].getAttribute('data-live') === '1' ? 'Live' : 'Not live') + ' · updated ' + ago(nowMs() - at);
      }
    }, TICK_MS);
  }

  if (typeof root.addEventListener === 'function') {
    root.addEventListener('focus', function () { if (activeThread) { scheduleLoad(activeThread, true); syncStreams(); } });
  }

  var api = {
    renderThreadCards: renderThreadCards,
    threadDot: threadDot,
    renderCard: renderCard,
    parseSse: parseSse,
    _format: { hhmm: hhmm, duration: duration, ago: ago }
  };
  root.PipelineTree = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
