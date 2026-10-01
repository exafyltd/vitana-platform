/*
 * Voice Supervisor — Command Hub → Voice (VTID-04777, VTID-04778, VTID-04780)
 *
 * The screens a voice supervisor uses to answer "is voice working, for whom,
 * and is it getting better?":
 *
 *   Overview         window.renderVoiceSupervisorOverview()  — verdict banner
 *                    (system-wide vs one segment), KPI tiles with delta vs the
 *                    previous window, live sessions now, quick links.
 *   Tenants & Roles  window.renderVoiceSupervisorSegments()  — row x column
 *                    heatmap (default tenant x assistant), coloured by health.
 *   Sessions         window.renderVoiceSupervisorSessions()  — one live +
 *                    historical session list; a row opens the existing
 *                    session drawer (window.openVoiceLabSessionDrawer, app.js).
 *   Fix Impact       window.renderVoiceFixImpact()           — before/after
 *                    KPIs per shipped fix (Issues & Healing sub-tab).
 *
 * Data: GET /api/v1/voice/supervisor/{meta,overview,segments,sessions,fixes,
 * fixes/:id/impact}. Every read sends the Command Hub's auth headers
 * (window.buildContextHeaders). Filters (window, tenant, assistant/surface,
 * role, provider, language, plus per-screen ones) live in the URL query
 * string so a supervisor can share a link. A non-platform-admin sees a fixed
 * "Tenant: <name>" chip instead of the tenant picker (VTID-04780) — the
 * server scopes the data; the chip only tells the viewer what they see.
 *
 * Overview / Tenants & Roles / Sessions poll every 10 s while their node is
 * on screen and the page is visible, and stop once the node is detached
 * (the tab was left). Errors are shown, never swallowed.
 *
 * CSP: no inline scripts or styles — all styling via voice-supervisor.css.
 */
(function () {
  'use strict';

  var API = '/api/v1/voice/supervisor';
  var POLL_MS = 10000;
  var META_TTL_MS = 5 * 60 * 1000;
  var SESSIONS_PAGE = 50;
  var FRESH_MS = 5000; // a re-mount within this window reuses the data

  var WINDOWS = [
    { key: '1h', label: 'Last hour' },
    { key: '24h', label: 'Last 24 hours' },
    { key: '7d', label: 'Last 7 days' },
    { key: '30d', label: 'Last 30 days' },
  ];
  var COMMON_KEYS = ['window', 'tenant_id', 'surface', 'assistant', 'role', 'provider', 'lang'];
  var OUTCOMES = ['ok', 'silent', 'one_way', 'dropped', 'error', 'abandoned', 'active', 'no_end'];
  var ROW_DIMS = [
    { key: 'tenant', label: 'Tenant' },
    { key: 'surface', label: 'Assistant / surface' },
    { key: 'role', label: 'Role' },
    { key: 'provider', label: 'Provider' },
    { key: 'lang', label: 'Language' },
  ];
  var COL_DIMS = [
    { key: 'assistant', label: 'Assistant' },
    { key: 'provider', label: 'Provider' },
    { key: 'lang', label: 'Language' },
    { key: 'role', label: 'Role' },
    { key: 'surface', label: 'Surface' },
  ];
  // Which filter parameter a segment dimension maps to.
  var DIM_PARAM = { tenant: 'tenant_id', surface: 'surface', assistant: 'assistant', role: 'role', provider: 'provider', lang: 'lang' };
  var METRICS = [
    { key: 'ok_rate', label: 'OK rate', kind: 'rate', better: 'up' },
    { key: 'silent_rate', label: 'Silent rate', kind: 'rate', better: 'down' },
    { key: 'one_way_rate', label: 'One-way rate', kind: 'rate', better: 'down' },
    { key: 'drop_rate', label: 'Drop rate', kind: 'rate', better: 'down' },
    { key: 'p50_ttfa_ms', label: 'Time to first audio (p50)', kind: 'ms', better: 'down' },
  ];
  var KPI_TILES = [
    { key: 'sessions', label: 'Sessions', kind: 'count', better: 'none' },
    { key: 'ok_rate', label: 'OK', kind: 'rate', better: 'up', hint: 'Both sides spoke and the session ended normally' },
    { key: 'silent_rate', label: 'Silent', kind: 'rate', better: 'down', hint: 'Vitana never produced audio' },
    { key: 'one_way_rate', label: 'One-way', kind: 'rate', better: 'down', hint: 'Audio flowed in one direction only' },
    { key: 'drop_rate', label: 'Dropped', kind: 'rate', better: 'down', hint: 'Connection closed abnormally' },
    { key: 'error_rate', label: 'Errors', kind: 'rate', better: 'down' },
    { key: 'p50_ttfa_ms', label: 'First audio p50', kind: 'ms', better: 'down', hint: 'Time from session start to Vitana\'s first audio' },
    { key: 'p95_ttfa_ms', label: 'First audio p95', kind: 'ms', better: 'down' },
    { key: 'p50_turn_ms', label: 'Turn latency p50', kind: 'ms', better: 'down' },
    { key: 'avg_duration_ms', label: 'Avg duration', kind: 'duration', better: 'none' },
    // VTID-04776: sessions with no recorded end are a telemetry gap, not a
    // voice outcome — the rates above exclude them; this says how much of the
    // window they cover.
    { key: 'end_recorded_rate', label: 'Ends recorded', kind: 'rate', better: 'up', hint: 'Share of finished sessions whose end was recorded. The quality rates above only cover these.' },
  ];

  var S = {
    meta: null,
    metaError: null,
    metaLoading: false,
    metaAt: 0,
    timer: null,
    active: null, // 'overview' | 'segments' | 'sessions'
    overview: { data: null, error: null, loading: false, at: 0, key: '', root: null },
    segments: { data: null, error: null, loading: false, at: 0, key: '', root: null },
    sessions: { rows: [], next: null, error: null, loading: false, loadingMore: false, at: 0, key: '', root: null, paged: false },
    fixes: { list: null, error: null, loading: false, at: 0, root: null, selected: null, impact: null, impactError: null, impactLoading: false, impactKey: '' },
  };

  // ── helpers ──────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function authHeaders(extra) {
    var h = extra || {};
    if (typeof window.buildContextHeaders === 'function') return window.buildContextHeaders(h);
    if (typeof buildContextHeaders === 'function') return buildContextHeaders(h); // eslint-disable-line no-undef
    return h;
  }
  function getJson(path) {
    return fetch(API + path, { headers: authHeaders({}) }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok || !j || j.ok === false) {
          var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
          if (r.status === 401) msg = 'Your session has expired — sign in again.';
          if (r.status === 403) msg = 'You do not have access to voice supervision data (' + msg + ').';
          if (r.status === 404 && !(j && j.error)) msg = 'Voice supervisor API not available on this gateway (404).';
          var e = new Error(msg);
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }
  function btn(label, cls, onClick, opts) {
    opts = opts || {};
    var b = el('button', 'vsup-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.setAttribute('data-fk', 'btn-' + (opts.focusKey || label));
    if (opts.disabled) b.disabled = true;
    if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
    if (opts.title) b.title = opts.title;
    b.addEventListener('click', function (e) { e.preventDefault(); onClick(e); });
    return b;
  }
  function num(n) { return typeof n === 'number' && isFinite(n) ? n : null; }
  function fmtRate(r) { r = num(r); return r === null ? '—' : (r * 100 >= 10 || r === 0 ? Math.round(r * 100) : (r * 100).toFixed(1)) + '%'; }
  function fmtMs(n) {
    n = num(n);
    if (n === null) return '—';
    if (n >= 10000) return Math.round(n / 1000) + ' s';
    if (n >= 1000) return (n / 1000).toFixed(1) + ' s';
    return Math.round(n) + ' ms';
  }
  function fmtDuration(n) {
    n = num(n);
    if (n === null) return '—';
    var s = Math.round(n / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + ('0' + (s % 60)).slice(-2) + 's';
    return Math.floor(m / 60) + 'h ' + ('0' + (m % 60)).slice(-2) + 'm';
  }
  function fmtCount(n) { n = num(n); return n === null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtValue(kind, v) {
    if (kind === 'rate') return fmtRate(v);
    if (kind === 'ms') return fmtMs(v);
    if (kind === 'duration') return fmtDuration(v);
    return fmtCount(v);
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '—';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    if (sameDay) return hh;
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + hh.slice(0, 5);
  }
  function ago(ms) {
    if (!ms) return 'never';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    return Math.round(s / 60) + 'm ago';
  }
  function human(s) { return String(s === undefined || s === null ? '' : s).replace(/^voice\./, '').replace(/_/g, ' '); }
  function attached(node) { return !!(node && document.body.contains(node)); }

  // ── filters (URL query string) ───────────────────────────────────────────
  function readParams() {
    var p = {};
    try {
      var sp = new URLSearchParams(window.location.search);
      sp.forEach(function (v, k) { if (v !== '') p[k] = v; });
    } catch (_e) { /* old browser: no filters */ }
    if (!p.window || !WINDOWS.some(function (w) { return w.key === p.window; })) p.window = '24h';
    return p;
  }
  function toQuery(params, keys) {
    var sp = new URLSearchParams();
    (keys || Object.keys(params)).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') sp.set(k, params[k]);
    });
    var q = sp.toString();
    return q ? '?' + q : '';
  }
  function writeParams(params) {
    var url = window.location.pathname + toQuery(params);
    try { history.replaceState(null, '', url); } catch (_e) { /* ignore */ }
  }
  function setParam(key, value) {
    var p = readParams();
    if (value === '' || value === null || value === undefined) delete p[key];
    else p[key] = value;
    writeParams(p);
  }
  function commonParams(p) {
    var out = {};
    COMMON_KEYS.forEach(function (k) { if (p[k]) out[k] = p[k]; });
    // Non-platform admins are scoped by the server; never send a tenant they
    // cannot pick (a shared link from a platform admin may carry one).
    if (S.meta && S.meta.scope && S.meta.scope.is_platform_admin === false) delete out.tenant_id;
    return out;
  }
  // Move to another Voice tab carrying filters (pushState + app.js router).
  function goTo(tab, params) {
    var url = '/command-hub/voice/' + tab + '/' + toQuery(params || {});
    try { history.pushState(null, '', url); } catch (_e) { window.location.href = url; return; }
    /* global state, renderApp */
    if (typeof state !== 'undefined' && state) { // eslint-disable-line no-undef
      state.currentModuleKey = 'voice'; // eslint-disable-line no-undef
      state.currentTab = tab; // eslint-disable-line no-undef
      if (tab === 'issues-healing' && params && params.sub) {
        if (!state.voiceIssues) state.voiceIssues = {}; // eslint-disable-line no-undef
        state.voiceIssues.subTab = params.sub; // eslint-disable-line no-undef
      }
    }
    if (typeof renderApp === 'function') renderApp(); // eslint-disable-line no-undef
    else window.location.href = url;
  }

  // ── meta ─────────────────────────────────────────────────────────────────
  function loadMeta(onDone) {
    if (S.metaLoading) return;
    if (S.meta && Date.now() - S.metaAt < META_TTL_MS) { if (onDone) onDone(); return; }
    S.metaLoading = true;
    getJson('/meta').then(function (j) {
      S.meta = j;
      S.metaError = null;
      S.metaAt = Date.now();
    }).catch(function (e) {
      S.metaError = e.message;
    }).then(function () {
      S.metaLoading = false;
      if (onDone) onDone();
    });
  }
  function metaList(key) {
    var list = (S.meta && S.meta[key]) || [];
    return list.map(function (x) {
      if (x && typeof x === 'object') return { value: String(x.key || x.value || x.id || x.slug || ''), label: String(x.label || x.name || x.key || x.value || '') };
      return { value: String(x), label: human(x) };
    }).filter(function (x) { return x.value; });
  }
  function tenantName(id) {
    if (!id) return '';
    var t = ((S.meta && S.meta.tenants) || []).filter(function (x) { return x && x.tenant_id === id; })[0];
    return t ? (t.name || t.slug || id) : id;
  }
  function isPlatformAdmin() {
    return !(S.meta && S.meta.scope && S.meta.scope.is_platform_admin === false);
  }

  // ── shared UI pieces ─────────────────────────────────────────────────────
  function selectField(label, value, options, onChange, opts) {
    opts = opts || {};
    var wrap = el('label', 'vsup-field');
    wrap.appendChild(el('span', 'vsup-field-label', label));
    var sel = el('select', 'vsup-select');
    sel.setAttribute('data-fk', 'sel-' + label);
    if (opts.allLabel !== false) {
      var all = el('option', '', opts.allLabel || 'All');
      all.value = '';
      sel.appendChild(all);
    }
    var seen = {};
    options.forEach(function (o) {
      seen[o.value] = true;
      var opt = el('option', '', o.label);
      opt.value = o.value;
      sel.appendChild(opt);
    });
    // Keep a value from a shared link visible even if meta does not list it.
    if (value && !seen[value]) {
      var extra = el('option', '', human(value));
      extra.value = value;
      sel.appendChild(extra);
    }
    sel.value = value || '';
    sel.addEventListener('change', function () { onChange(sel.value); });
    wrap.appendChild(sel);
    return wrap;
  }

  function filterBar(p, onChange) {
    var bar = el('div', 'vsup-filters');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Filters');
    bar.appendChild(selectField('Window', p.window, WINDOWS.map(function (w) { return { value: w.key, label: w.label }; }), function (v) { onChange('window', v || '24h'); }, { allLabel: false }));
    if (S.meta && !isPlatformAdmin()) {
      var chip = el('div', 'vsup-field vsup-tenant-chip');
      chip.appendChild(el('span', 'vsup-field-label', 'Scope'));
      var tid = S.meta.scope && S.meta.scope.tenant_id;
      chip.appendChild(el('span', 'vsup-chip vsup-chip-scope', 'Tenant: ' + (tenantName(tid) || 'your tenant')));
      chip.title = 'You see voice data for your own tenant only.';
      bar.appendChild(chip);
    } else {
      var tenants = ((S.meta && S.meta.tenants) || []).map(function (t) { return { value: t.tenant_id, label: t.name || t.slug || t.tenant_id }; });
      bar.appendChild(selectField('Tenant', p.tenant_id, tenants, function (v) { onChange('tenant_id', v); }));
    }
    bar.appendChild(selectField('Assistant', p.surface, metaList('surfaces'), function (v) { onChange('surface', v); }));
    bar.appendChild(selectField('Role', p.role, metaList('roles'), function (v) { onChange('role', v); }));
    bar.appendChild(selectField('Provider', p.provider, metaList('providers'), function (v) { onChange('provider', v); }));
    bar.appendChild(selectField('Language', p.lang, metaList('langs'), function (v) { onChange('lang', v); }));
    var active = COMMON_KEYS.filter(function (k) { return k !== 'window' && p[k]; });
    if (active.length) {
      bar.appendChild(btn('Clear filters', 'vsup-btn-ghost vsup-btn-sm', function () {
        var np = readParams();
        active.forEach(function (k) { delete np[k]; });
        onChange(null, null, np);
      }));
    }
    return bar;
  }

  function header(title, subtitle, slot, onRefresh) {
    var h = el('div', 'vsup-head');
    var left = el('div', 'vsup-head-text');
    left.appendChild(el('h2', 'vsup-h2', title));
    if (subtitle) left.appendChild(el('p', 'vsup-muted', subtitle));
    h.appendChild(left);
    var right = el('div', 'vsup-head-right');
    var status = el('span', 'vsup-updated', slot.loading ? 'Refreshing…' : 'Updated ' + ago(slot.at));
    status.setAttribute('aria-live', 'polite');
    right.appendChild(status);
    right.appendChild(btn('Refresh', 'vsup-btn-ghost', onRefresh, { disabled: slot.loading }));
    h.appendChild(right);
    return h;
  }

  function errorBox(title, message, onRetry) {
    var e = el('div', 'vsup-alert vsup-alert-error');
    e.setAttribute('role', 'alert');
    e.appendChild(el('strong', '', title));
    e.appendChild(el('p', '', message));
    if (onRetry) e.appendChild(btn('Try again', 'vsup-btn-ghost vsup-btn-sm', onRetry));
    return e;
  }
  function metaNotice(root) {
    if (S.metaError) {
      var n = el('p', 'vsup-note-warn', 'Filter options could not be loaded (' + S.metaError + ') — showing every value.');
      n.setAttribute('role', 'status');
      root.appendChild(n);
    }
  }
  function outcomeBadge(o) {
    var key = o || 'unknown';
    var labels = { ok: 'OK', silent: 'Silent', one_way: 'One-way', dropped: 'Dropped', error: 'Error', abandoned: 'Abandoned', active: 'Live', no_end: 'End not recorded' };
    return el('span', 'vsup-badge vsup-outcome-' + key.replace(/[^a-z_]/g, ''), labels[key] || human(key) || '—');
  }

  // ── polling ──────────────────────────────────────────────────────────────
  function startPolling() {
    if (S.timer) return;
    S.timer = setInterval(function () {
      var slot = S.active && S[S.active];
      if (!slot || !attached(slot.root)) {
        clearInterval(S.timer);
        S.timer = null;
        S.active = null;
        return;
      }
      if (document.hidden) return;
      if (S.active === 'overview') loadOverview(false);
      else if (S.active === 'segments') loadSegments(false);
      else if (S.active === 'sessions' && !S.sessions.paged) loadSessions(false);
    }, POLL_MS);
  }
  function rerender(which) {
    var slot = S[which];
    if (!slot || !attached(slot.root)) return;
    // Don't yank the search box out from under someone who is typing; the
    // render runs when it loses focus.
    var ae = document.activeElement;
    var inside = ae && slot.root.contains(ae);
    if (inside && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && /^(search|text)$/.test(ae.type)))) {
      slot.pendingRender = true;
      return;
    }
    slot.pendingRender = false;
    var focusKey = inside ? ae.getAttribute('data-fk') : null;
    var builders = { overview: buildOverview, segments: buildSegments, sessions: buildSessions, fixes: buildFixes };
    var fresh = builders[which]();
    slot.root.parentNode.replaceChild(fresh, slot.root);
    slot.root = fresh;
    // Keep keyboard focus on the same control across the rebuild.
    if (focusKey) {
      var again = fresh.querySelector('[data-fk="' + focusKey.replace(/"/g, '') + '"]');
      if (again && !again.disabled) again.focus();
    }
  }
  function mount(which, build, load) {
    S.active = which === 'fixes' ? S.active : which;
    var slot = S[which];
    slot.root = build();
    loadMeta(function () { rerender(which); });
    // Defer the first load so the node is attached before it re-renders.
    // load(false) skips the fetch when the data is fresh for these filters
    // (app.js re-mounts the whole tree on every renderApp()).
    setTimeout(function () { load(false); }, 0);
    if (which !== 'fixes') startPolling();
    return slot.root;
  }
  function onFilterChange(which, load) {
    return function (key, value, whole) {
      if (whole) writeParams(whole);
      else setParam(key, value);
      load(true);
    };
  }

  // ═════════════════════════════ OVERVIEW ═════════════════════════════════
  function loadOverview(force) {
    var slot = S.overview;
    var p = readParams();
    var q = toQuery(commonParams(p));
    if (!force && slot.key === q && (slot.loading || Date.now() - slot.at < FRESH_MS)) return;
    slot.loading = true;
    slot.key = q;
    rerender('overview');
    getJson('/overview' + q).then(function (j) {
      if (slot.key !== q) return;
      slot.data = j;
      slot.error = null;
    }).catch(function (e) {
      if (slot.key !== q) return;
      slot.error = e.message;
    }).then(function () {
      if (slot.key !== q) return;
      slot.loading = false;
      slot.at = Date.now();
      rerender('overview');
    });
  }

  var VERDICT_COPY = {
    healthy: { cls: 'ok', title: 'Voice is healthy', body: 'No segment is degraded in this window.' },
    system_wide: { cls: 'bad', title: 'System-wide problem', body: 'The degradation shows across segments — start with providers and infrastructure, not one tenant or assistant.' },
    segment_specific: { cls: 'warn', title: 'Problem in specific segments', body: 'Only the segments below are degraded; the rest of the platform is healthy. Open one to see its sessions.' },
    insufficient_data: { cls: 'muted', title: 'Not enough sessions to judge', body: 'There are too few sessions in this window to tell — widen the window or clear filters.' },
  };

  function verdictSegmentParams(v, base) {
    var params = {};
    if (base.window) params.window = base.window;
    if (v.segment && typeof v.segment === 'object') {
      Object.keys(v.segment).forEach(function (k) {
        var param = DIM_PARAM[k] || (COMMON_KEYS.indexOf(k) !== -1 ? k : null);
        if (param && v.segment[k]) params[param] = v.segment[k];
      });
    } else if (v.scope && v.scope !== 'system' && v.key) {
      var param2 = DIM_PARAM[v.scope] || v.scope;
      params[param2] = v.key;
    }
    // Keep any filters the supervisor already applied.
    COMMON_KEYS.forEach(function (k) { if (!params[k] && base[k]) params[k] = base[k]; });
    return params;
  }

  function verdictBanner(d, p) {
    var summary = d.verdict_summary || 'insufficient_data';
    var copy = VERDICT_COPY[summary] || VERDICT_COPY.insufficient_data;
    var box = el('section', 'vsup-verdict vsup-verdict-' + copy.cls);
    box.setAttribute('aria-labelledby', 'vsup-verdict-title');
    var h = el('h3', 'vsup-verdict-title', copy.title);
    h.id = 'vsup-verdict-title';
    box.appendChild(h);
    box.appendChild(el('p', 'vsup-verdict-body', copy.body));
    var verdicts = Array.isArray(d.verdicts) ? d.verdicts.slice() : [];
    verdicts.sort(function (a, b) {
      var sa = a.severity === 'critical' ? 0 : 1;
      var sb = b.severity === 'critical' ? 0 : 1;
      return sa - sb || (num(b.sessions) || 0) - (num(a.sessions) || 0);
    });
    if (verdicts.length) {
      var list = el('ul', 'vsup-verdict-list');
      verdicts.slice(0, 8).forEach(function (v) {
        var li = el('li');
        var b = el('button', 'vsup-verdict-item');
        b.type = 'button';
        var sev = v.severity === 'critical' ? 'critical' : 'warning';
        b.appendChild(el('span', 'vsup-badge vsup-sev-' + sev, sev === 'critical' ? 'Critical' : 'Warning'));
        var main = el('span', 'vsup-verdict-main');
        var scopePrefix = v.scope && v.scope !== 'system' && !(v.segment && typeof v.segment === 'object') ? human(v.scope) + ': ' : '';
        main.appendChild(el('span', 'vsup-verdict-label', scopePrefix + (v.label || v.key || 'All voice')));
        if (v.message) main.appendChild(el('span', 'vsup-verdict-msg', v.message));
        var metric = METRICS.filter(function (m) { return m.key === v.metric; })[0];
        var kind = metric ? metric.kind : (String(v.metric || '').indexOf('_ms') !== -1 ? 'ms' : 'rate');
        var stat = (metric ? metric.label : human(v.metric || 'rate')) + ' ' + fmtValue(kind, v.segment_rate) + ' vs ' + fmtValue(kind, v.baseline_rate) + ' baseline · ' + fmtCount(v.sessions) + ' sessions';
        main.appendChild(el('span', 'vsup-verdict-stat', stat));
        b.appendChild(main);
        b.appendChild(el('span', 'vsup-verdict-go', 'View sessions →'));
        b.setAttribute('aria-label', (v.label || v.key || 'segment') + ': ' + stat + '. View sessions');
        b.addEventListener('click', function () { goTo('sessions', verdictSegmentParams(v, p)); });
        li.appendChild(b);
        list.appendChild(li);
      });
      box.appendChild(list);
      if (verdicts.length > 8) box.appendChild(el('p', 'vsup-muted', '+ ' + (verdicts.length - 8) + ' more — see Tenants & Roles.'));
    }
    return box;
  }

  function deltaInfo(tile, cur, prev) {
    cur = num(cur); prev = num(prev);
    if (cur === null || prev === null) return null;
    var diff = cur - prev;
    var text;
    var small;
    if (tile.kind === 'rate') {
      var pp = diff * 100;
      small = Math.abs(pp) < 0.5;
      text = (pp > 0 ? '+' : pp < 0 ? '−' : '±') + Math.abs(pp).toFixed(1) + ' pp';
    } else if (tile.kind === 'ms' || tile.kind === 'duration') {
      small = Math.abs(diff) < Math.max(50, Math.abs(prev) * 0.05);
      text = (diff > 0 ? '+' : diff < 0 ? '−' : '±') + (tile.kind === 'ms' ? fmtMs(Math.abs(diff)) : fmtDuration(Math.abs(diff)));
    } else {
      var rel = prev === 0 ? (cur === 0 ? 0 : 1) : diff / prev;
      small = Math.abs(rel) < 0.05;
      text = (diff > 0 ? '+' : diff < 0 ? '−' : '±') + Math.round(Math.abs(rel) * 100) + '%';
    }
    var dir = 'neutral';
    if (!small && tile.better !== 'none') {
      var improved = tile.better === 'up' ? diff > 0 : diff < 0;
      dir = improved ? 'good' : 'bad';
    }
    return { text: text, dir: dir };
  }

  function kpiTiles(d) {
    var k = d.kpis || {};
    var prev = d.previous_kpis || {};
    var grid = el('div', 'vsup-kpis');
    KPI_TILES.forEach(function (t) {
      var tile = el('div', 'vsup-kpi');
      if (t.hint) tile.title = t.hint;
      tile.appendChild(el('span', 'vsup-kpi-label', t.label));
      tile.appendChild(el('span', 'vsup-kpi-value', fmtValue(t.kind, k[t.key])));
      var di = deltaInfo(t, k[t.key], prev[t.key]);
      var delta = el('span', 'vsup-kpi-delta vsup-delta-' + (di ? di.dir : 'none'), di ? di.text + ' vs previous' : 'no previous window');
      if (di && di.dir !== 'neutral') delta.setAttribute('aria-label', di.text + ' versus previous window, ' + (di.dir === 'good' ? 'better' : 'worse'));
      tile.appendChild(delta);
      grid.appendChild(tile);
    });
    return grid;
  }

  function chipMap(title, map, onPick) {
    var wrap = el('div', 'vsup-live-group');
    wrap.appendChild(el('span', 'vsup-field-label', title));
    var keys = Object.keys(map || {}).sort(function (a, b) { return (map[b] || 0) - (map[a] || 0); });
    if (!keys.length) { wrap.appendChild(el('span', 'vsup-muted', 'none')); return wrap; }
    var chips = el('div', 'vsup-chips');
    keys.forEach(function (key) {
      var c = btn(human(key) + ' · ' + fmtCount(map[key]), 'vsup-chip vsup-chip-btn', function () { onPick(key); }, { ariaLabel: map[key] + ' live sessions on ' + human(key) + '. View them' });
      chips.appendChild(c);
    });
    wrap.appendChild(chips);
    return wrap;
  }

  function liveNow(d, p) {
    var live = d.live || {};
    var s = el('section', 'vsup-card vsup-live');
    s.setAttribute('aria-label', 'Live now');
    var top = el('div', 'vsup-live-top');
    var big = el('div', 'vsup-live-count');
    big.appendChild(el('span', 'vsup-live-dot' + (num(live.active_sessions) ? ' is-on' : '')));
    big.appendChild(el('span', 'vsup-live-num', fmtCount(live.active_sessions)));
    big.appendChild(el('span', 'vsup-muted', 'live sessions now'));
    top.appendChild(big);
    if (live.source) top.appendChild(el('span', 'vsup-small vsup-muted', 'source: ' + live.source));
    s.appendChild(top);
    var base = commonParams(p);
    base.outcome = 'active';
    s.appendChild(chipMap('By assistant / surface', live.by_surface, function (k) { var q = Object.assign({}, base); q.surface = k; goTo('sessions', q); }));
    s.appendChild(chipMap('By provider', live.by_provider, function (k) { var q = Object.assign({}, base); q.provider = k; goTo('sessions', q); }));
    return s;
  }

  function quickLinks(p) {
    var row = el('div', 'vsup-quick');
    var base = commonParams(p);
    row.appendChild(btn('Tenants & Roles matrix', 'vsup-btn-ghost', function () { goTo('segments', base); }));
    row.appendChild(btn('All sessions', 'vsup-btn-ghost', function () { goTo('sessions', base); }));
    row.appendChild(btn('Issues & Healing', 'vsup-btn-ghost', function () { goTo('issues-healing', { sub: 'action-queue' }); }));
    row.appendChild(btn('Fix Impact', 'vsup-btn-ghost', function () { goTo('issues-healing', { sub: 'fix-impact' }); }));
    return row;
  }

  function buildOverview() {
    var slot = S.overview;
    var p = readParams();
    var root = el('div', 'vsup');
    root.appendChild(header('Voice Overview', 'Is voice working right now — and if not, is it everyone or one tenant, assistant, role, provider or language?', slot, function () { loadOverview(true); }));
    root.appendChild(filterBar(p, onFilterChange('overview', loadOverview)));
    metaNotice(root);
    var d = slot.data;
    if (!d) {
      if (slot.error) root.appendChild(errorBox('Could not load the voice overview', slot.error, function () { loadOverview(true); }));
      else root.appendChild(el('p', 'vsup-empty', 'Loading…'));
      return root;
    }
    if (slot.error) root.appendChild(el('p', 'vsup-note-warn', 'Last refresh failed (' + slot.error + ') — showing data from ' + ago(slot.at) + '.'));
    var grid = el('div', 'vsup-overview-grid');
    var mainCol = el('div', 'vsup-overview-main');
    mainCol.appendChild(verdictBanner(d, p));
    mainCol.appendChild(kpiTiles(d));
    grid.appendChild(mainCol);
    var side = el('div', 'vsup-overview-side');
    side.appendChild(liveNow(d, p));
    side.appendChild(quickLinks(p));
    grid.appendChild(side);
    root.appendChild(grid);
    if (d.generated_at) root.appendChild(el('p', 'vsup-small vsup-muted', 'Computed ' + fmtTime(d.generated_at) + ' for window ' + (d.window || p.window) + '.'));
    return root;
  }

  // ═════════════════════════ TENANTS & ROLES ══════════════════════════════
  function segParams(p) {
    var row = ROW_DIMS.some(function (d) { return d.key === p.row; }) ? p.row : 'tenant';
    var col = COL_DIMS.some(function (d) { return d.key === p.col; }) ? p.col : 'assistant';
    var metric = METRICS.some(function (m) { return m.key === p.metric; }) ? p.metric : 'ok_rate';
    return { row: row, col: col, metric: metric };
  }
  function loadSegments(force) {
    var slot = S.segments;
    var p = readParams();
    var sp = segParams(p);
    var params = commonParams(p);
    params.row = sp.row;
    params.col = sp.col;
    var q = toQuery(params);
    if (!force && slot.key === q && (slot.loading || Date.now() - slot.at < FRESH_MS)) return;
    slot.loading = true;
    slot.key = q;
    rerender('segments');
    getJson('/segments' + q).then(function (j) {
      if (slot.key !== q) return;
      slot.data = j;
      slot.error = null;
    }).catch(function (e) {
      if (slot.key !== q) return;
      slot.error = e.message;
    }).then(function () {
      if (slot.key !== q) return;
      slot.loading = false;
      slot.at = Date.now();
      rerender('segments');
    });
  }

  function cellButton(cell, metric, label, onOpen) {
    var health = (cell && cell.health) || 'insufficient';
    var b = el('button', 'vsup-cell vsup-health-' + health);
    b.type = 'button';
    var value = cell ? fmtValue(metric.kind, cell[metric.key]) : '—';
    var n = cell ? num(cell.sessions) : null;
    b.appendChild(el('span', 'vsup-cell-value', health === 'insufficient' && (n === null || n === 0) ? '—' : value));
    b.appendChild(el('span', 'vsup-cell-n', n === null ? 'no data' : 'n=' + fmtCount(n)));
    var healthText = { ok: 'healthy', warn: 'warning', bad: 'degraded', insufficient: 'too few sessions' }[health] || health;
    b.setAttribute('aria-label', label + ': ' + metric.label + ' ' + value + ', ' + (n === null ? 'no' : n) + ' sessions, ' + healthText + '. View sessions');
    b.title = healthText;
    b.addEventListener('click', onOpen);
    return b;
  }

  function buildSegments() {
    var slot = S.segments;
    var p = readParams();
    var sp = segParams(p);
    var metric = METRICS.filter(function (m) { return m.key === sp.metric; })[0];
    var root = el('div', 'vsup');
    root.appendChild(header('Tenants & Roles', 'Every tenant against every assistant (or any two dimensions). Red cells are degraded, grey cells have too few sessions to judge. Click a cell to see its sessions.', slot, function () { loadSegments(true); }));
    root.appendChild(filterBar(p, onFilterChange('segments', loadSegments)));

    var pick = el('div', 'vsup-filters vsup-filters-secondary');
    pick.setAttribute('role', 'group');
    pick.setAttribute('aria-label', 'Matrix layout');
    pick.appendChild(selectField('Rows', sp.row, ROW_DIMS.map(function (d) { return { value: d.key, label: d.label }; }), function (v) { setParam('row', v); loadSegments(true); }, { allLabel: false }));
    pick.appendChild(selectField('Columns', sp.col, COL_DIMS.map(function (d) { return { value: d.key, label: d.label }; }), function (v) { setParam('col', v); loadSegments(true); }, { allLabel: false }));
    pick.appendChild(selectField('Metric', sp.metric, METRICS.map(function (m) { return { value: m.key, label: m.label }; }), function (v) { setParam('metric', v); rerender('segments'); }, { allLabel: false }));
    var legend = el('div', 'vsup-legend');
    legend.setAttribute('aria-label', 'Legend');
    [['ok', 'Healthy'], ['warn', 'Warning'], ['bad', 'Degraded'], ['insufficient', 'Too few sessions']].forEach(function (x) {
      var item = el('span', 'vsup-legend-item');
      item.appendChild(el('span', 'vsup-swatch vsup-health-' + x[0]));
      item.appendChild(document.createTextNode(x[1]));
      legend.appendChild(item);
    });
    pick.appendChild(legend);
    root.appendChild(pick);
    metaNotice(root);

    var d = slot.data;
    if (!d) {
      if (slot.error) root.appendChild(errorBox('Could not load the segment matrix', slot.error, function () { loadSegments(true); }));
      else root.appendChild(el('p', 'vsup-empty', 'Loading…'));
      return root;
    }
    if (slot.error) root.appendChild(el('p', 'vsup-note-warn', 'Last refresh failed (' + slot.error + ') — showing data from ' + ago(slot.at) + '.'));
    var rows = Array.isArray(d.rows) ? d.rows : [];
    var cols = Array.isArray(d.columns) ? d.columns : [];
    if (!rows.length) {
      root.appendChild(el('p', 'vsup-empty', 'No voice sessions match these filters in this window.'));
      return root;
    }
    var rowDim = d.row_dim || sp.row;
    var colDim = d.col_dim || sp.col;
    var rowParam = DIM_PARAM[rowDim] || rowDim;
    var colParam = DIM_PARAM[colDim] || colDim;
    var rowLabel = (ROW_DIMS.filter(function (x) { return x.key === rowDim; })[0] || { label: human(rowDim) }).label;

    var scroller = el('div', 'vsup-table-scroll');
    scroller.setAttribute('tabindex', '0');
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', 'Segment matrix (scrolls sideways)');
    var table = el('table', 'vsup-matrix');
    var cap = el('caption', 'vsup-sr-only', metric.label + ' by ' + rowLabel + ' and ' + human(colDim));
    table.appendChild(cap);
    var thead = el('thead');
    var htr = el('tr');
    var corner = el('th', 'vsup-matrix-corner', rowLabel);
    corner.setAttribute('scope', 'col');
    htr.appendChild(corner);
    cols.forEach(function (c) {
      var th = el('th', '', c.label || human(c.key));
      th.setAttribute('scope', 'col');
      htr.appendChild(th);
    });
    var tth = el('th', 'vsup-matrix-total', 'All');
    tth.setAttribute('scope', 'col');
    htr.appendChild(tth);
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el('tbody');
    var base = commonParams(p);
    rows.forEach(function (r) {
      var tr = el('tr');
      var th = el('th', 'vsup-matrix-rowhead', r.label || human(r.key));
      th.setAttribute('scope', 'row');
      tr.appendChild(th);
      cols.forEach(function (c) {
        var td = el('td');
        var cell = r.cells ? r.cells[c.key] : null;
        td.appendChild(cellButton(cell, metric, (r.label || r.key) + ' × ' + (c.label || c.key), function () {
          var q = Object.assign({}, base);
          q[rowParam] = r.key;
          q[colParam] = c.key;
          goTo('sessions', q);
        }));
        tr.appendChild(td);
      });
      var ttd = el('td', 'vsup-matrix-total');
      ttd.appendChild(cellButton(r.total, metric, (r.label || r.key) + ' (all)', function () {
        var q = Object.assign({}, base);
        q[rowParam] = r.key;
        goTo('sessions', q);
      }));
      tr.appendChild(ttd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    if (d.totals) {
      var tfoot = el('tfoot');
      var ftr = el('tr');
      var fth = el('th', 'vsup-matrix-rowhead', 'All');
      fth.setAttribute('scope', 'row');
      ftr.appendChild(fth);
      cols.forEach(function () { ftr.appendChild(el('td')); });
      var ftd = el('td', 'vsup-matrix-total');
      ftd.appendChild(cellButton(d.totals, metric, 'All segments', function () { goTo('sessions', base); }));
      ftr.appendChild(ftd);
      tfoot.appendChild(ftr);
      table.appendChild(tfoot);
    }
    scroller.appendChild(table);
    root.appendChild(scroller);
    return root;
  }

  // ═════════════════════════════ SESSIONS ═════════════════════════════════
  function sessionParams(p) {
    var params = commonParams(p);
    if (p.outcome) params.outcome = p.outcome;
    if (p.failure_class) params.failure_class = p.failure_class;
    if (p.q) params.q = p.q;
    params.limit = String(SESSIONS_PAGE);
    return params;
  }
  function loadSessions(force) {
    var slot = S.sessions;
    var q = toQuery(sessionParams(readParams()));
    if (!force && slot.key === q && (slot.loading || Date.now() - slot.at < FRESH_MS)) return;
    slot.loading = true;
    if (slot.key !== q) { slot.paged = false; }
    slot.key = q;
    rerender('sessions');
    getJson('/sessions' + q).then(function (j) {
      if (slot.key !== q) return;
      slot.rows = Array.isArray(j.sessions) ? j.sessions : [];
      slot.next = j.next_before || null;
      slot.paged = false;
      slot.error = null;
    }).catch(function (e) {
      if (slot.key !== q) return;
      slot.error = e.message;
    }).then(function () {
      if (slot.key !== q) return;
      slot.loading = false;
      slot.at = Date.now();
      rerender('sessions');
    });
  }
  function loadMoreSessions() {
    var slot = S.sessions;
    if (!slot.next || slot.loadingMore) return;
    var params = sessionParams(readParams());
    params.before = slot.next;
    var key = slot.key;
    slot.loadingMore = true;
    rerender('sessions');
    getJson('/sessions' + toQuery(params)).then(function (j) {
      if (slot.key !== key) return;
      slot.rows = slot.rows.concat(Array.isArray(j.sessions) ? j.sessions : []);
      slot.next = j.next_before || null;
      slot.paged = true; // polling would drop the older pages — pause it
      slot.moreError = null;
    }).catch(function (e) {
      slot.moreError = e.message;
    }).then(function () {
      slot.loadingMore = false;
      rerender('sessions');
    });
  }
  function openSession(id) {
    if (typeof window.openVoiceLabSessionDrawer === 'function') window.openVoiceLabSessionDrawer(id);
  }

  function sessionsTable(rows) {
    var scroller = el('div', 'vsup-table-scroll');
    scroller.setAttribute('tabindex', '0');
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', 'Voice sessions (scrolls sideways)');
    var table = el('table', 'vsup-table vsup-sessions');
    var thead = el('thead');
    var htr = el('tr');
    ['Started', 'Tenant', 'Assistant / surface', 'Role', 'Lang', 'Provider', 'Transport', 'Duration', 'Turns', 'First audio', 'Outcome', 'Close reason'].forEach(function (h, i) {
      var th = el('th', i >= 7 && i <= 9 ? 'vsup-num' : '', h);
      th.setAttribute('scope', 'col');
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (s) {
      var tr = el('tr', 'vsup-row');
      var startedTd = el('td', 'vsup-nowrap');
      var open = el('button', 'vsup-link-btn', fmtTime(s.started_at));
      open.type = 'button';
      open.setAttribute('aria-label', 'Open session ' + String(s.session_id || '').slice(0, 12) + ' started ' + fmtTime(s.started_at));
      open.addEventListener('click', function (e) { e.stopPropagation(); openSession(s.session_id); });
      startedTd.appendChild(open);
      tr.appendChild(startedTd);
      var tenantTd = el('td', 'vsup-trunc', s.tenant_name || tenantName(s.tenant_id) || '—');
      tenantTd.title = s.tenant_name || s.tenant_id || '';
      tr.appendChild(tenantTd);
      var surf = el('td');
      surf.appendChild(el('span', '', human(s.surface) || '—'));
      if (s.persona_key) surf.appendChild(el('span', 'vsup-sub', human(s.persona_key)));
      tr.appendChild(surf);
      var roleTd = el('td');
      roleTd.appendChild(el('span', '', human(s.role) || '—'));
      if (s.is_anonymous) roleTd.appendChild(el('span', 'vsup-sub', 'anonymous'));
      tr.appendChild(roleTd);
      tr.appendChild(el('td', 'vsup-mono', s.lang || '—'));
      var provTd = el('td');
      provTd.appendChild(el('span', '', human(s.provider) || '—'));
      if (s.selection_reason) provTd.appendChild(el('span', 'vsup-sub', human(s.selection_reason)));
      tr.appendChild(provTd);
      var trTd = el('td');
      trTd.appendChild(el('span', '', s.transport || '—'));
      if (s.is_mobile) trTd.appendChild(el('span', 'vsup-sub', 'mobile'));
      tr.appendChild(trTd);
      tr.appendChild(el('td', 'vsup-num vsup-nowrap', s.outcome === 'active' && !num(s.duration_ms) ? 'live' : fmtDuration(s.duration_ms)));
      tr.appendChild(el('td', 'vsup-num', fmtCount(s.turn_count)));
      tr.appendChild(el('td', 'vsup-num vsup-nowrap', fmtMs(s.ttfa_ms)));
      var outTd = el('td');
      outTd.appendChild(outcomeBadge(s.outcome));
      if (s.failure_class) outTd.appendChild(el('span', 'vsup-sub', human(s.failure_class)));
      tr.appendChild(outTd);
      var close = [s.close_reason ? human(s.close_reason) : '', s.close_code !== undefined && s.close_code !== null ? '(' + s.close_code + ')' : ''].join(' ').trim();
      tr.appendChild(el('td', 'vsup-trunc', close || '—'));
      tr.addEventListener('click', function () { openSession(s.session_id); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroller.appendChild(table);
    return scroller;
  }

  function buildSessions() {
    var slot = S.sessions;
    var p = readParams();
    var root = el('div', 'vsup');
    root.appendChild(header('Voice Sessions', 'Live and past voice sessions in one list. Click a session for its turns, audio and pipeline diagnostics.', slot, function () { loadSessions(true); }));
    root.appendChild(filterBar(p, onFilterChange('sessions', loadSessions)));

    var extra = el('form', 'vsup-filters vsup-filters-secondary');
    extra.setAttribute('role', 'search');
    extra.setAttribute('aria-label', 'Session search');
    extra.appendChild(selectField('Outcome', p.outcome, OUTCOMES.map(function (o) { return { value: o, label: o === 'active' ? 'Live now' : (o === 'no_end' ? 'End not recorded' : human(o)) }; }), function (v) { setParam('outcome', v); loadSessions(true); }));
    var classes = {};
    slot.rows.forEach(function (s) { if (s.failure_class) classes[s.failure_class] = true; });
    if (p.failure_class) classes[p.failure_class] = true;
    extra.appendChild(selectField('Failure class', p.failure_class, Object.keys(classes).sort().map(function (c) { return { value: c, label: human(c) }; }), function (v) { setParam('failure_class', v); loadSessions(true); }));
    var qWrap = el('label', 'vsup-field vsup-field-grow');
    qWrap.appendChild(el('span', 'vsup-field-label', 'Search'));
    var qIn = el('input', 'vsup-input');
    qIn.type = 'search';
    qIn.placeholder = 'Session id, user id or tenant';
    qIn.value = p.q || '';
    qIn.setAttribute('data-fk', 'search');
    qIn.addEventListener('blur', function () {
      if (S.sessions.pendingRender) setTimeout(function () { rerender('sessions'); }, 0);
    });
    qWrap.appendChild(qIn);
    extra.appendChild(qWrap);
    var go = el('button', 'vsup-btn vsup-btn-primary', 'Search');
    go.type = 'submit';
    extra.appendChild(go);
    extra.addEventListener('submit', function (e) {
      e.preventDefault();
      setParam('q', qIn.value.trim());
      if (document.activeElement) document.activeElement.blur();
      loadSessions(true);
    });
    root.appendChild(extra);
    metaNotice(root);

    if (!slot.rows.length) {
      if (slot.error) root.appendChild(errorBox('Could not load voice sessions', slot.error, function () { loadSessions(true); }));
      else if (slot.loading || !slot.at) root.appendChild(el('p', 'vsup-empty', 'Loading…'));
      else root.appendChild(el('p', 'vsup-empty', 'No voice sessions match these filters in this window.'));
      return root;
    }
    if (slot.error) root.appendChild(el('p', 'vsup-note-warn', 'Last refresh failed (' + slot.error + ') — showing data from ' + ago(slot.at) + '.'));
    var summary = el('p', 'vsup-small vsup-muted', slot.rows.length + ' session' + (slot.rows.length === 1 ? '' : 's') + ' shown' + (slot.paged ? ' · auto-refresh paused while older pages are loaded' : ' · refreshes every 10 s'));
    root.appendChild(summary);
    root.appendChild(sessionsTable(slot.rows));
    if (slot.moreError) root.appendChild(el('p', 'vsup-note-warn', 'Loading more failed: ' + slot.moreError));
    if (slot.next) {
      var more = el('div', 'vsup-more');
      more.appendChild(btn(slot.loadingMore ? 'Loading…' : 'Load more', 'vsup-btn-ghost', loadMoreSessions, { disabled: slot.loadingMore, focusKey: 'load-more' }));
      root.appendChild(more);
    }
    return root;
  }

  // ═════════════════════════════ FIX IMPACT ═══════════════════════════════
  function loadFixes(force) {
    var slot = S.fixes;
    if (slot.loading && !force) return;
    slot.loading = true;
    rerender('fixes');
    getJson('/fixes?days=30').then(function (j) {
      slot.list = Array.isArray(j.fixes) ? j.fixes : [];
      slot.error = null;
    }).catch(function (e) {
      slot.error = e.message;
    }).then(function () {
      slot.loading = false;
      slot.at = Date.now();
      var p = readParams();
      if (p.fix && slot.list && slot.list.some(function (f) { return f.fix_id === p.fix; }) && slot.selected !== p.fix) {
        selectFix(p.fix);
      } else {
        rerender('fixes');
      }
    });
  }
  function impactDays() {
    var d = readParams().impact_days;
    return ['3', '7', '14'].indexOf(d) !== -1 ? d : '7';
  }
  function selectFix(id) {
    var slot = S.fixes;
    slot.selected = id;
    setParam('fix', id);
    var key = id + '|' + impactDays();
    slot.impactKey = key;
    slot.impact = null;
    slot.impactError = null;
    slot.impactLoading = true;
    rerender('fixes');
    getJson('/fixes/' + encodeURIComponent(id) + '/impact?days=' + impactDays()).then(function (j) {
      if (slot.impactKey !== key) return;
      slot.impact = j;
    }).catch(function (e) {
      if (slot.impactKey !== key) return;
      slot.impactError = e.message;
    }).then(function () {
      if (slot.impactKey !== key) return;
      slot.impactLoading = false;
      rerender('fixes');
    });
  }

  function segmentChips(seg) {
    var chips = el('div', 'vsup-chips');
    if (!seg) return chips;
    Object.keys(seg).forEach(function (k) {
      if (!seg[k]) return;
      var v = k === 'tenant_id' ? tenantName(seg[k]) : human(seg[k]);
      chips.appendChild(el('span', 'vsup-chip', human(k.replace(/_id$/, '')) + ': ' + v));
    });
    return chips;
  }
  var VERDICT_BADGE = {
    improved: ['ok', 'Improved'],
    no_change: ['muted', 'No measurable change'],
    regressed: ['bad', 'Regressed'],
    insufficient_data: ['muted', 'Not enough data yet'],
  };
  function fixCard(f, selected) {
    var b = el('button', 'vsup-fix' + (selected ? ' is-selected' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    var top = el('span', 'vsup-fix-top');
    top.appendChild(el('span', 'vsup-fix-title', f.title || f.vtid || f.fix_id));
    if (f.status) top.appendChild(el('span', 'vsup-badge vsup-badge-muted', human(f.status)));
    b.appendChild(top);
    var meta = [f.vtid, f.source ? human(f.source) : '', f.fixed_at ? 'fixed ' + fmtTime(f.fixed_at) : ''].filter(Boolean).join(' · ');
    b.appendChild(el('span', 'vsup-fix-meta', meta));
    if (f.failure_class) b.appendChild(el('span', 'vsup-fix-meta', 'Targets: ' + human(f.failure_class)));
    b.addEventListener('click', function () { selectFix(f.fix_id); });
    return b;
  }
  function impactPanel(slot) {
    var box = el('section', 'vsup-card vsup-impact');
    box.setAttribute('aria-live', 'polite');
    if (!slot.selected) {
      box.appendChild(el('p', 'vsup-empty', 'Pick a fix to compare voice quality in its segment before and after it shipped.'));
      return box;
    }
    var top = el('div', 'vsup-impact-head');
    top.appendChild(selectField('Compare', impactDays(), [{ value: '3', label: '3 days either side' }, { value: '7', label: '7 days either side' }, { value: '14', label: '14 days either side' }], function (v) { setParam('impact_days', v); selectFix(slot.selected); }, { allLabel: false }));
    box.appendChild(top);
    if (slot.impactLoading) { box.appendChild(el('p', 'vsup-empty', 'Loading impact…')); return box; }
    if (slot.impactError) { box.appendChild(errorBox('Could not load the impact of this fix', slot.impactError, function () { selectFix(slot.selected); })); return box; }
    var d = slot.impact || {};
    var fix = d.fix || ((slot.list || []).filter(function (f) { return f.fix_id === slot.selected; })[0]) || {};
    var vb = VERDICT_BADGE[d.verdict] || VERDICT_BADGE.insufficient_data;
    var title = el('div', 'vsup-impact-title');
    title.appendChild(el('h3', 'vsup-h3', fix.title || fix.vtid || slot.selected));
    title.appendChild(el('span', 'vsup-badge vsup-badge-' + vb[0] + ' vsup-badge-lg', vb[1]));
    box.appendChild(title);
    var links = el('p', 'vsup-small');
    if (fix.vtid) links.appendChild(el('span', 'vsup-mono', fix.vtid));
    if (fix.pr_url && /^https:\/\//.test(fix.pr_url)) {
      if (fix.vtid) links.appendChild(document.createTextNode(' · '));
      var a = el('a', 'vsup-link', 'Pull request');
      a.href = fix.pr_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      links.appendChild(a);
    }
    if (fix.fixed_at) links.appendChild(document.createTextNode(' · shipped ' + fmtTime(fix.fixed_at)));
    box.appendChild(links);
    box.appendChild(segmentChips(d.segment || fix.segment));
    var before = d.before || {};
    var after = d.after || {};
    var bk = before.kpis || {};
    var ak = after.kpis || {};
    var delta = d.delta || {};
    var minSample = num(d.min_sample);
    var sample = el('p', 'vsup-small vsup-muted', 'Before: ' + fmtCount(bk.sessions) + ' sessions (' + fmtTime(before.window_start) + ' → ' + fmtTime(before.window_end) + ') · After: ' + fmtCount(ak.sessions) + ' sessions (' + fmtTime(after.window_start) + ' → ' + fmtTime(after.window_end) + ')' + (minSample !== null ? ' · verdict needs ≥ ' + minSample + ' sessions on each side' : ''));
    box.appendChild(sample);
    var scroller = el('div', 'vsup-table-scroll');
    var table = el('table', 'vsup-table vsup-impact-table');
    var thead = el('thead');
    var htr = el('tr');
    ['Metric', 'Before', 'After', 'Change'].forEach(function (h, i) {
      var th = el('th', i ? 'vsup-num' : '', h);
      th.setAttribute('scope', 'col');
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el('tbody');
    METRICS.forEach(function (m) {
      var tr = el('tr');
      var th = el('th', '', m.label);
      th.setAttribute('scope', 'row');
      tr.appendChild(th);
      tr.appendChild(el('td', 'vsup-num', fmtValue(m.kind, bk[m.key])));
      tr.appendChild(el('td', 'vsup-num', fmtValue(m.kind, ak[m.key])));
      var dv = num(delta[m.key]);
      if (dv === null && num(bk[m.key]) !== null && num(ak[m.key]) !== null) dv = ak[m.key] - bk[m.key];
      var di = dv === null ? null : deltaInfo(m, dv, 0);
      tr.appendChild(el('td', 'vsup-num vsup-delta-' + (di ? di.dir : 'none'), di ? di.text : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroller.appendChild(table);
    box.appendChild(scroller);
    return box;
  }
  function buildFixes() {
    var slot = S.fixes;
    var root = el('div', 'vsup');
    root.appendChild(header('Fix Impact', 'Did a shipped fix actually make voice better? Each fix compares its segment\'s quality before and after it went out.', slot, function () { loadFixes(true); }));
    if (!slot.list) {
      if (slot.error) root.appendChild(errorBox('Could not load recent fixes', slot.error, function () { loadFixes(true); }));
      else root.appendChild(el('p', 'vsup-empty', 'Loading…'));
      return root;
    }
    if (slot.error) root.appendChild(el('p', 'vsup-note-warn', 'Last refresh failed (' + slot.error + ').'));
    if (!slot.list.length) {
      root.appendChild(el('p', 'vsup-empty', 'No voice fixes shipped in the last 30 days.'));
      return root;
    }
    var grid = el('div', 'vsup-fix-grid');
    var list = el('div', 'vsup-fix-list');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Fixes in the last 30 days');
    slot.list.forEach(function (f) {
      var item = el('div', 'vsup-fix-item');
      item.setAttribute('role', 'listitem');
      item.appendChild(fixCard(f, f.fix_id === slot.selected));
      list.appendChild(item);
    });
    grid.appendChild(list);
    grid.appendChild(impactPanel(slot));
    root.appendChild(grid);
    return root;
  }

  // ── public entry points (app.js router) ──────────────────────────────────
  function withContainer(node, container) {
    if (container && typeof container.appendChild === 'function') container.appendChild(node);
    return node;
  }
  window.renderVoiceSupervisorOverview = function (container) {
    return withContainer(mount('overview', buildOverview, loadOverview), container);
  };
  window.renderVoiceSupervisorSegments = function (container) {
    return withContainer(mount('segments', buildSegments, loadSegments), container);
  };
  window.renderVoiceSupervisorSessions = function (container) {
    return withContainer(mount('sessions', buildSessions, loadSessions), container);
  };
  window.renderVoiceFixImpact = function (container) {
    var slot = S.fixes;
    slot.root = buildFixes();
    loadMeta(function () { rerender('fixes'); });
    if (!slot.list || Date.now() - slot.at > 60000) setTimeout(function () { loadFixes(true); }, 0);
    else {
      var p = readParams();
      if (p.fix && p.fix !== slot.selected) setTimeout(function () { selectFix(p.fix); }, 0);
    }
    return withContainer(slot.root, container);
  };
})();
