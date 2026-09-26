/*
 * Voice Self-Healing screen — Command Hub → Voice → Self-Healing (VTID-04626)
 *
 * Rebuilt from scratch. The previous panel fetched three of its five
 * endpoints without a login token (401 → the page stuck at "MODE: ..."),
 * rendered 17 empty investigator placeholders as "? ? confidence" reports,
 * and its Accept button created VTIDs nothing ever picked up.
 *
 * One read (GET /api/v1/voice-lab/healing/overview) drives the whole page:
 * loop health per stage with the real last error, alerts, reports split into
 * "needs a decision" / "failed investigations" / "decided", detections,
 * quarantine, the per-class table and the live session monitor.
 *
 * Exposes window.renderVoiceSelfHealingScreen() for app.js's router.
 * CSP: no inline scripts; all styling via voice-self-healing.css classes.
 */
(function () {
  'use strict';

  var API = '/api/v1/voice-lab/healing';
  var POLL_MS = 30000;

  var S = {
    data: null,
    loading: false,
    error: null,
    tab: 'open',
    busy: {},
    lastAt: 0,
    timer: null,
    root: null,
    progress: {},
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
  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind);
    else if (typeof showToast === 'function') showToast(msg, kind); // eslint-disable-line no-undef
  }
  function api(method, path, body) {
    var opts = { method: method, headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}) };
    if (body) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || (j && j.ok === false)) {
          var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
          if (r.status === 401) msg = 'Your session has expired — sign in again.';
          if (r.status === 403) msg = 'This action needs an exafy admin account.';
          var e = new Error(msg);
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }
  function ago(iso) {
    if (!iso) return '—';
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return '—';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isFinite(d.getTime()) ? d.toLocaleString() : '—';
  }
  function human(s) { return String(s || '').replace(/^voice\./, '').replace(/_/g, ' '); }
  function pct(n) { return typeof n === 'number' ? Math.round(n * 100) + '%' : '—'; }
  function btn(label, cls, onClick, disabled) {
    var b = el('button', 'vsh-btn ' + (cls || ''), label);
    b.type = 'button';
    if (disabled) b.disabled = true;
    b.addEventListener('click', function (e) { e.preventDefault(); onClick(e); });
    return b;
  }
  function section(title, subtitle, right) {
    var s = el('section', 'vsh-section');
    var h = el('div', 'vsh-section-head');
    var t = el('div');
    t.appendChild(el('h3', 'vsh-h3', title));
    if (subtitle) t.appendChild(el('p', 'vsh-muted', subtitle));
    h.appendChild(t);
    if (right) h.appendChild(right);
    s.appendChild(h);
    return s;
  }
  function table(headers, rows) {
    var wrap = el('div', 'vsh-table-wrap');
    var t = el('table', 'vsh-table');
    var thead = el('thead');
    var tr = el('tr');
    headers.forEach(function (h) { tr.appendChild(el('th', h.cls || '', h.label)); });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) { tb.appendChild(r); });
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }
  function td(text, cls) { return el('td', cls || '', text); }

  // ── data ─────────────────────────────────────────────────────────────────
  function load(force) {
    if (S.loading && !force) return;
    S.loading = true;
    rerender();
    api('GET', '/overview').then(function (j) {
      S.data = j;
      S.error = null;
    }).catch(function (e) {
      S.error = e.message;
    }).then(function () {
      S.loading = false;
      S.lastAt = Date.now();
      rerender();
    });
  }
  function startPolling() {
    if (S.timer) return;
    S.timer = setInterval(function () {
      if (!S.root || !document.body.contains(S.root)) {
        clearInterval(S.timer);
        S.timer = null;
        return;
      }
      if (!document.hidden) load(false);
    }, POLL_MS);
  }
  function rerender() {
    if (!S.root || !document.body.contains(S.root)) return;
    var fresh = build();
    S.root.parentNode.replaceChild(fresh, S.root);
    S.root = fresh;
  }

  // ── actions ──────────────────────────────────────────────────────────────
  function runAction(key, promise, okMsg) {
    S.busy[key] = true;
    rerender();
    return promise.then(function (j) {
      toast(typeof okMsg === 'function' ? okMsg(j) : okMsg, 'success');
      return j;
    }).catch(function (e) {
      toast(e.message, 'error');
    }).then(function (j) {
      delete S.busy[key];
      load(true);
      return j;
    });
  }
  function setMode(next) {
    var cur = S.data && S.data.mode;
    if (next === cur) return;
    var msg = {
      off: 'Turn error dispatch OFF? Quality failures are still investigated; error sessions are no longer classified.',
      shadow: 'Switch to SHADOW? Error sessions are classified and logged, nothing is dispatched.',
      live: 'Switch to LIVE? Classified error sessions are sent to the self-healing pipeline, which can open code changes.',
    }[next];
    if (!window.confirm(msg)) return;
    runAction('mode', api('POST', '/mode', { mode: next }), 'Mode set to ' + next.toUpperCase());
  }
  function accept(r) {
    if (r.stale_pipeline && !window.confirm(
      'This report was written for the retired Vertex Gemini Live pipeline. Voice now runs on Amazon Nova Sonic, ' +
      'so its steps likely target code that no longer runs voice.\n\nAccept it anyway?')) return;
    var notes = window.prompt(
      'Accept "' + human(r.class) + '" and hand it to Dev Autopilot?\n\n' +
      'One agent run will implement the recommendation. The change is held for your approval before any pull request opens.\n\n' +
      'Optional note for the agent:', '');
    if (notes === null) return;
    runAction('r:' + r.id, api('POST', '/reports/' + encodeURIComponent(r.id) + '/execute', { decision_notes: notes || undefined }),
      function (j) { return 'Queued for Dev Autopilot as ' + (j.execution && j.execution.vtid ? j.execution.vtid : 'a new task'); });
  }
  function dismiss(ids, label) {
    var reason = window.prompt('Dismiss ' + label + '? Optional reason:', '');
    if (reason === null) return;
    runAction('dismiss', api('POST', '/reports/dismiss', { ids: ids, reason: reason || undefined }), 'Dismissed');
  }
  function dismissAllFailed(n) {
    if (!window.confirm('Dismiss all ' + n + ' failed investigations? They contain no findings — only the error that stopped the report writer.')) return;
    runAction('dismiss', api('POST', '/reports/dismiss', { all_failed: true, reason: 'failed investigation (report writer error)' }),
      function (j) { return 'Dismissed ' + (j.dismissed || 0); });
  }
  function retry(r) {
    runAction('r:' + r.id, api('POST', '/reports/' + encodeURIComponent(r.id) + '/retry'),
      function (j) { return j.new_report_id ? 'New report written' : 'Retried'; });
  }
  function release(q) {
    if (!window.confirm('Release "' + human(q.class) + '" into 72h probation? New occurrences can start investigations again (max 1 per day).')) return;
    runAction('q:' + q.class + q.normalized_signature,
      api('POST', '/quarantine/release', { class: q.class, signature: q.normalized_signature, reason: 'released from Command Hub' }),
      'Released into probation');
  }
  function loadProgress(r) {
    S.progress[r.id] = { loading: true };
    rerender();
    api('GET', '/reports/' + encodeURIComponent(r.id) + '/execution').then(function (j) {
      S.progress[r.id] = { data: j };
    }).catch(function (e) {
      S.progress[r.id] = { error: e.message };
    }).then(rerender);
  }

  // ── drawer ───────────────────────────────────────────────────────────────
  function closeDrawer() {
    var d = document.getElementById('vsh-drawer');
    if (d) d.parentNode.removeChild(d);
  }
  function openDrawer(id) {
    closeDrawer();
    var root = el('div', 'vsh-drawer-root');
    root.id = 'vsh-drawer';
    var back = el('div', 'vsh-drawer-backdrop');
    back.addEventListener('click', closeDrawer);
    root.appendChild(back);
    var panel = el('aside', 'vsh-drawer');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Investigator report');
    panel.appendChild(el('p', 'vsh-muted', 'Loading report…'));
    root.appendChild(panel);
    document.body.appendChild(root);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { closeDrawer(); document.removeEventListener('keydown', esc); }
    });
    api('GET', '/reports/' + encodeURIComponent(id)).then(function (j) {
      panel.innerHTML = '';
      panel.appendChild(drawerContent(j.report));
    }).catch(function (e) {
      panel.innerHTML = '';
      panel.appendChild(el('p', 'vsh-error', 'Could not load the report: ' + e.message));
    });
  }
  function list(items) {
    var ul = el('ul', 'vsh-list');
    (items || []).forEach(function (i) { ul.appendChild(el('li', '', i)); });
    return ul;
  }
  function drawerContent(row) {
    var rep = row.report || {};
    var rec = rep.recommendation || {};
    var c = el('div', 'vsh-drawer-body');
    var head = el('div', 'vsh-drawer-head');
    var ht = el('div');
    ht.appendChild(el('h3', 'vsh-h3', human(row.class)));
    ht.appendChild(el('p', 'vsh-muted', 'Signature ' + (row.normalized_signature || '—') + ' · trigger ' + human(row.trigger_reason) + ' · ' + when(row.generated_at)));
    head.appendChild(ht);
    head.appendChild(btn('Close', 'vsh-btn-ghost', closeDrawer));
    c.appendChild(head);

    if (row.schema_version === 'v1-stub' || rep.investigator_status === 'failed') {
      c.appendChild(el('h4', 'vsh-h4', 'Investigation failed'));
      c.appendChild(el('p', '', 'The report writer could not produce a report. There are no findings in this row.'));
      c.appendChild(el('pre', 'vsh-pre', rep.failure_detail || rep.failure_reason || '(no detail)'));
      return c;
    }
    var chips = el('div', 'vsh-chips');
    chips.appendChild(el('span', 'vsh-chip vsh-chip-track', human(rec.track || 'unknown')));
    chips.appendChild(el('span', 'vsh-chip', 'confidence ' + pct(rec.confidence)));
    chips.appendChild(el('span', 'vsh-chip', row.status));
    if (rep._llm && rep._llm.model) chips.appendChild(el('span', 'vsh-chip', 'written by ' + rep._llm.model));
    c.appendChild(chips);
    if (typeof rec.confidence === 'number' && rec.confidence < 0.5) {
      c.appendChild(el('p', 'vsh-note-warn', 'Below 50% confidence — the investigator itself says this needs a human look before anyone acts on it.'));
    }
    c.appendChild(el('h4', 'vsh-h4', 'Recommendation'));
    c.appendChild(el('p', '', rec.summary || '—'));
    if (rec.rationale) { c.appendChild(el('h4', 'vsh-h4', 'Why')); c.appendChild(el('p', '', rec.rationale)); }
    if (rec.contradiction_check) { c.appendChild(el('h4', 'vsh-h4', 'What would prove it wrong')); c.appendChild(el('p', '', rec.contradiction_check)); }
    if (rec.proposed_next_steps && rec.proposed_next_steps.length) { c.appendChild(el('h4', 'vsh-h4', 'Proposed steps')); c.appendChild(list(rec.proposed_next_steps)); }
    if (rec.required_human_decisions && rec.required_human_decisions.length) { c.appendChild(el('h4', 'vsh-h4', 'Decisions for a human')); c.appendChild(list(rec.required_human_decisions)); }
    var hyps = (rep.internal_findings && rep.internal_findings.hypotheses) || [];
    if (hyps.length) {
      c.appendChild(el('h4', 'vsh-h4', 'Hypotheses'));
      hyps.forEach(function (h) {
        var b = el('div', 'vsh-hyp');
        b.appendChild(el('strong', '', h.hypothesis + ' (' + pct(h.confidence) + ')'));
        if (h.top_3_disconfirming_data_points && h.top_3_disconfirming_data_points.length) {
          b.appendChild(el('p', 'vsh-muted', 'Would change the conclusion:'));
          b.appendChild(list(h.top_3_disconfirming_data_points));
        }
        c.appendChild(b);
      });
    }
    if (rep._execution) {
      c.appendChild(el('h4', 'vsh-h4', 'Execution'));
      c.appendChild(el('p', '', 'Dev Autopilot ' + (rep._execution.vtid || '') + ' · execution ' + String(rep._execution.execution_id || '').slice(0, 8) + ' · accepted by ' + (rep._execution.accepted_by || '—')));
    }
    var det = el('details', 'vsh-details');
    det.appendChild(el('summary', '', 'Evidence the investigator saw'));
    det.appendChild(el('pre', 'vsh-pre', JSON.stringify(rep.evidence || {}, null, 2)));
    c.appendChild(det);
    if (row.status === 'open') {
      var acts = el('div', 'vsh-actions');
      acts.appendChild(btn('Accept → Dev Autopilot', 'vsh-btn-primary', function () { closeDrawer(); accept({ id: row.id, class: row.class }); }));
      acts.appendChild(btn('Dismiss', 'vsh-btn-danger', function () { closeDrawer(); dismiss([row.id], 'this report'); }));
      c.appendChild(acts);
    }
    return c;
  }

  // ── sections ─────────────────────────────────────────────────────────────
  function header() {
    var h = el('header', 'vsh-head');
    var t = el('div');
    t.appendChild(el('h2', 'vsh-h2', 'Voice Self-Healing'));
    t.appendChild(el('p', 'vsh-muted',
      'Watches every ORB voice session. Broken sessions are detected, an investigator writes a report, repeating patterns are quarantined, ' +
      'and you decide which reports Dev Autopilot should implement. Nothing changes code without your approval.'));
    h.appendChild(t);
    var r = el('div', 'vsh-head-right');
    r.appendChild(el('span', 'vsh-muted vsh-small', S.lastAt ? 'Updated ' + ago(new Date(S.lastAt).toISOString()) : ''));
    r.appendChild(btn(S.loading ? 'Refreshing…' : 'Refresh', 'vsh-btn-ghost', function () { load(true); }, S.loading));
    h.appendChild(r);
    return h;
  }

  function modeBar(d) {
    var wrap = el('div', 'vsh-mode');
    var label = el('div', 'vsh-mode-label');
    label.appendChild(el('strong', '', 'Error dispatch'));
    var expl = {
      off: 'Off — error sessions are not classified. Quality failures are still detected and investigated.',
      shadow: 'Shadow — error sessions are classified and logged, nothing is dispatched. Safe observation mode.',
      live: 'Live — classified error sessions are sent to the self-healing pipeline.',
    }[d.mode] || '';
    label.appendChild(el('span', 'vsh-muted', expl + (d.mode_updated_at ? ' Set ' + ago(d.mode_updated_at) + '.' : '')));
    wrap.appendChild(label);
    var seg = el('div', 'vsh-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Error dispatch mode');
    ['off', 'shadow', 'live'].forEach(function (m) {
      var b = btn(m.charAt(0).toUpperCase() + m.slice(1), 'vsh-seg-btn' + (d.mode === m ? ' is-active vsh-mode-' + m : ''), function () { setMode(m); }, !!S.busy.mode);
      b.setAttribute('aria-pressed', d.mode === m ? 'true' : 'false');
      seg.appendChild(b);
    });
    wrap.appendChild(seg);
    return wrap;
  }

  function alerts(d) {
    var box = el('div', 'vsh-alerts');
    (d.alerts || []).forEach(function (a) {
      var c = el('div', 'vsh-alert vsh-alert-' + a.level);
      c.setAttribute('role', a.level === 'error' ? 'alert' : 'status');
      c.appendChild(el('strong', '', a.title));
      c.appendChild(el('p', '', a.detail));
      box.appendChild(c);
    });
    return box;
  }

  function stageCard(num, title, status, big, bigLabel, lines) {
    var c = el('div', 'vsh-stage vsh-stage-' + status);
    var top = el('div', 'vsh-stage-top');
    top.appendChild(el('span', 'vsh-stage-num', num));
    top.appendChild(el('strong', '', title));
    var st = el('span', 'vsh-status vsh-status-' + status, {
      ok: 'working', failing: 'failing', idle: 'idle', no_traffic: 'no traffic', unknown: 'unknown',
    }[status] || status);
    top.appendChild(st);
    c.appendChild(top);
    var b = el('div', 'vsh-stage-big');
    b.appendChild(el('span', 'vsh-big', big));
    b.appendChild(el('span', 'vsh-muted', bigLabel));
    c.appendChild(b);
    lines.forEach(function (l) { if (l) c.appendChild(el('p', 'vsh-stage-line', l)); });
    return c;
  }

  function pipeline(d) {
    var p = d.pipeline;
    var g = el('div', 'vsh-pipeline');
    g.appendChild(stageCard('1', 'Detect', p.detector.status, p.detector.detections_7d, 'failures detected in 7 days', [
      p.detector.session_stops_24h + ' voice sessions ended in 24h',
      'Last session ' + ago(p.detector.last_session_stop_at),
      p.detector.last_detection_at ? 'Last detection ' + ago(p.detector.last_detection_at) : 'No detections in 7 days',
    ]));
    var inv = p.investigator;
    g.appendChild(stageCard('2', 'Investigate', inv.status, inv.successes_30d + '/' + inv.attempts_30d, 'reports written in 30 days', [
      'Last good report ' + ago(inv.last_success_at),
      inv.status === 'failing' ? inv.consecutive_failures + ' failures in a row' : (inv.failures_30d ? inv.failures_30d + ' failures in 30 days' : 'No failures in 30 days'),
      'Model: routing stage "' + inv.stage + '"',
    ]));
    g.appendChild(stageCard('3', 'Quarantine', p.sentinel.quarantined > 0 ? 'idle' : 'ok', p.sentinel.quarantined, 'patterns quarantined', [
      p.sentinel.probation + ' in probation',
      'Stops repeated investigations of the same pattern',
    ]));
    g.appendChild(stageCard('4', 'Execute', p.execution.status, p.execution.accepted_30d, 'reports accepted in 30 days', [
      'Accepted reports run as Dev Autopilot tasks',
      'Held for your approval before a PR opens',
    ]));
    return g;
  }

  function reportCard(r) {
    var busy = !!S.busy['r:' + r.id];
    var c = el('article', 'vsh-report' + (busy ? ' is-busy' : '') + (r.stale_pipeline ? ' is-stale' : ''));
    var top = el('div', 'vsh-report-top');
    top.appendChild(el('strong', 'vsh-report-class', human(r.class)));
    var chips = el('div', 'vsh-chips');
    if (r.stale_pipeline) chips.appendChild(el('span', 'vsh-chip vsh-chip-stale', 'old pipeline (Vertex)'));
    if (r.track) {
      var tr = human(r.track);
      var chip = el('span', 'vsh-chip vsh-chip-track', tr.length > 60 ? tr.slice(0, 57) + '…' : tr);
      chip.title = tr;
      chips.appendChild(chip);
    }
    if (typeof r.confidence === 'number') {
      chips.appendChild(el('span', 'vsh-chip' + (r.confidence < 0.5 ? ' vsh-chip-low' : ''), pct(r.confidence) + ' confidence'));
    }
    chips.appendChild(el('span', 'vsh-chip', human(r.trigger_reason)));
    top.appendChild(chips);
    c.appendChild(top);
    c.appendChild(el('p', 'vsh-report-summary', r.summary || '(no summary)'));
    c.appendChild(el('p', 'vsh-muted vsh-small', ago(r.generated_at) + ' · ' + r.step_count + ' proposed step' + (r.step_count === 1 ? '' : 's') + (r.normalized_signature ? ' · ' + r.normalized_signature : '')));
    var a = el('div', 'vsh-actions');
    a.appendChild(btn('View report', 'vsh-btn-ghost', function () { openDrawer(r.id); }));
    a.appendChild(btn('Accept → Dev Autopilot', 'vsh-btn-primary', function () { accept(r); }, busy));
    a.appendChild(btn('Dismiss', 'vsh-btn-danger', function () { dismiss([r.id], 'this report'); }, busy));
    c.appendChild(a);
    return c;
  }

  function failedRow(r) {
    var busy = !!S.busy['r:' + r.id];
    var tr = el('tr', busy ? 'is-busy' : '');
    tr.appendChild(td(human(r.class)));
    tr.appendChild(td(when(r.generated_at), 'vsh-nowrap'));
    tr.appendChild(td(r.failure_detail || r.failure_reason, 'vsh-err-cell'));
    var act = el('td', 'vsh-nowrap');
    act.appendChild(btn('Retry', 'vsh-btn-ghost vsh-btn-sm', function () { retry(r); }, busy));
    act.appendChild(btn('Dismiss', 'vsh-btn-danger vsh-btn-sm', function () { dismiss([r.id], 'this failed investigation'); }, busy));
    tr.appendChild(act);
    return tr;
  }

  function decidedRow(r) {
    var tr = el('tr');
    tr.appendChild(td(human(r.class)));
    tr.appendChild(td(r.status, 'vsh-status-text vsh-st-' + r.status));
    tr.appendChild(td((r.acknowledged_by || '—') + ' · ' + ago(r.acknowledged_at)));
    var cell = el('td');
    var ex = r.execution;
    var pr = S.progress[r.id];
    if (pr && pr.loading) cell.textContent = 'Loading…';
    else if (pr && pr.error) cell.appendChild(el('span', 'vsh-error', pr.error));
    else if (pr && pr.data) {
      if (pr.data.kind === 'dev_autopilot') {
        var e = pr.data.execution;
        cell.appendChild(el('span', '', (pr.data.ref && pr.data.ref.vtid ? pr.data.ref.vtid + ' · ' : '') + (e ? e.status : 'not found')));
        if (e && e.pr_url) {
          var a = el('a', 'vsh-link', ' PR');
          a.href = e.pr_url; a.target = '_blank'; a.rel = 'noopener';
          cell.appendChild(a);
        }
      } else {
        var v = pr.data.vtids || [];
        var done = v.filter(function (x) { return x.is_terminal; }).length;
        cell.textContent = v.length ? (done + '/' + v.length + ' legacy tasks closed') : 'No linked work';
      }
    } else if (r.status === 'accepted') {
      cell.appendChild(btn(ex && ex.vtid ? ex.vtid + ' — status' : 'Show work', 'vsh-btn-ghost vsh-btn-sm', function () { loadProgress(r); }));
    } else {
      cell.textContent = r.decision_notes ? r.decision_notes.slice(0, 80) : '—';
    }
    tr.appendChild(cell);
    var v2 = el('td');
    v2.appendChild(btn('View', 'vsh-btn-ghost vsh-btn-sm', function () { openDrawer(r.id); }));
    tr.appendChild(v2);
    return tr;
  }

  function reports(d) {
    var rep = d.reports;
    var counts = { open: rep.open.length, failed: rep.failed.length, decided: rep.decided.length };
    var tabs = el('div', 'vsh-tabs');
    tabs.setAttribute('role', 'tablist');
    [['open', 'Needs decision'], ['failed', 'Failed investigations'], ['decided', 'Decided']].forEach(function (t) {
      var b = btn(t[1] + ' (' + counts[t[0]] + ')', 'vsh-tab' + (S.tab === t[0] ? ' is-active' : ''), function () { S.tab = t[0]; rerender(); });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', S.tab === t[0] ? 'true' : 'false');
      tabs.appendChild(b);
    });
    var s = section('Investigator reports', 'Written when a failure pattern repeats. Read, then accept or dismiss.', tabs);
    if (S.tab === 'open') {
      if (!rep.open.length) s.appendChild(el('p', 'vsh-empty', 'No reports waiting for a decision.'));
      var stale = rep.open.filter(function (r) { return r.stale_pipeline; });
      if (stale.length) {
        var sb = el('div', 'vsh-actions');
        sb.appendChild(el('span', 'vsh-muted', stale.length + ' of these were written about the retired Vertex Gemini Live pipeline. Voice runs on Amazon Nova Sonic now.'));
        sb.appendChild(btn('Dismiss ' + stale.length + ' old-pipeline reports', 'vsh-btn-danger', function () {
          dismiss(stale.map(function (r) { return r.id; }), stale.length + ' reports written for the retired Vertex pipeline');
        }, !!S.busy.dismiss));
        s.appendChild(sb);
      }
      var grid = el('div', 'vsh-report-grid');
      rep.open.forEach(function (r) { grid.appendChild(reportCard(r)); });
      s.appendChild(grid);
    } else if (S.tab === 'failed') {
      if (!rep.failed.length) {
        s.appendChild(el('p', 'vsh-empty', 'No failed investigations.'));
      } else {
        var bar = el('div', 'vsh-actions');
        bar.appendChild(el('span', 'vsh-muted', 'These rows hold only the error that stopped the report writer. Retry to get a real report, or dismiss.'));
        bar.appendChild(btn('Dismiss all ' + rep.failed.length, 'vsh-btn-danger', function () { dismissAllFailed(rep.failed.length); }, !!S.busy.dismiss));
        s.appendChild(bar);
        s.appendChild(table([{ label: 'Class' }, { label: 'When' }, { label: 'Error' }, { label: '' }], rep.failed.map(failedRow)));
      }
    } else {
      if (!rep.decided.length) s.appendChild(el('p', 'vsh-empty', 'Nothing decided yet.'));
      else s.appendChild(table([{ label: 'Class' }, { label: 'Decision' }, { label: 'By' }, { label: 'Work' }, { label: '' }], rep.decided.map(decidedRow)));
    }
    return s;
  }

  function detections(d) {
    var s = section('Detections (7 days)', 'Sessions the detector flagged. Each one counts toward quarantine and may start an investigation.');
    if (!d.detections.length) {
      s.appendChild(el('p', 'vsh-empty', d.pipeline.detector.status === 'no_traffic' ? 'No voice traffic to judge.' : 'No failures detected in 7 days.'));
      return s;
    }
    s.appendChild(table(
      [{ label: 'When' }, { label: 'Class' }, { label: 'Session' }, { label: 'Mic in', cls: 'vsh-num' }, { label: 'Voice out', cls: 'vsh-num' }, { label: 'Turns', cls: 'vsh-num' }, { label: 'Length', cls: 'vsh-num' }],
      d.detections.map(function (x) {
        var tr = el('tr');
        tr.appendChild(td(ago(x.at), 'vsh-nowrap'));
        tr.appendChild(td(human(x.class)));
        tr.appendChild(td(x.session_id ? x.session_id.slice(0, 18) : '—', 'vsh-mono'));
        tr.appendChild(td(x.audio_in_chunks === null ? '—' : x.audio_in_chunks, 'vsh-num'));
        tr.appendChild(td(x.audio_out_chunks === null ? '—' : x.audio_out_chunks, 'vsh-num'));
        tr.appendChild(td(x.turn_count === null ? '—' : x.turn_count, 'vsh-num'));
        tr.appendChild(td(x.duration_ms === null ? '—' : Math.round(x.duration_ms / 1000) + 's', 'vsh-num'));
        return tr;
      })));
    return s;
  }

  function quarantine(d) {
    var s = section('Quarantine', 'Patterns that repeated too often. Occurrences are still recorded; no new investigation starts until released.');
    if (!d.quarantine.length) { s.appendChild(el('p', 'vsh-empty', 'Nothing quarantined.')); return s; }
    s.appendChild(table([{ label: 'Class' }, { label: 'Signature' }, { label: 'Status' }, { label: 'Why' }, { label: 'Since' }, { label: '' }],
      d.quarantine.map(function (q) {
        var tr = el('tr');
        tr.appendChild(td(human(q.class)));
        tr.appendChild(td(q.normalized_signature, 'vsh-mono'));
        tr.appendChild(td(q.status === 'probation' ? 'probation until ' + when(q.probation_until) : q.status));
        tr.appendChild(td(human(q.reason || '—')));
        tr.appendChild(td(ago(q.quarantined_at), 'vsh-nowrap'));
        var a = el('td');
        if (q.status === 'quarantined') a.appendChild(btn('Release', 'vsh-btn-ghost vsh-btn-sm', function () { release(q); }, !!S.busy['q:' + q.class + q.normalized_signature]));
        tr.appendChild(a);
        return tr;
      })));
    return s;
  }

  function perClass(d) {
    var rows = d.per_class || [];
    var s = section('By failure class', 'Occurrences per class. "Recorded" counts every detection, including ones quarantine suppressed.');
    if (!rows.length) { s.appendChild(el('p', 'vsh-empty', 'No failure classes recorded in 30 days.')); return s; }
    s.appendChild(table([{ label: 'Class' }, { label: '24h', cls: 'vsh-num' }, { label: '7d', cls: 'vsh-num' }, { label: '30d', cls: 'vsh-num' }, { label: 'Quarantine' }, { label: 'Latest report' }],
      rows.map(function (c) {
        var tr = el('tr');
        tr.appendChild(td(human(c.class)));
        tr.appendChild(td(c.dispatch_count_24h, 'vsh-num'));
        tr.appendChild(td(c.dispatch_count_7d, 'vsh-num'));
        tr.appendChild(td(c.dispatch_count_30d, 'vsh-num'));
        tr.appendChild(td(c.quarantine_status || 'active'));
        var a = el('td');
        if (c.latest_investigation_report_id) a.appendChild(btn('View', 'vsh-btn-ghost vsh-btn-sm', function () { openDrawer(c.latest_investigation_report_id); }));
        else a.textContent = '—';
        tr.appendChild(a);
        return tr;
      })));
    return s;
  }

  function liveSessions(d) {
    var lm = d.live;
    var s = section('Recent voice sessions', 'Last 20 sessions. "Mic in / voice out" compares audio chunks heard vs spoken — a very high ratio means the user talked and Vitana barely answered.');
    if (!lm) { s.appendChild(el('p', 'vsh-empty', 'Live monitor unavailable.')); return s; }
    var roll = el('div', 'vsh-chips');
    roll.appendChild(el('span', 'vsh-chip', lm.rollup_24h.total_sessions + ' real conversations in 24h'));
    roll.appendChild(el('span', 'vsh-chip' + (lm.rollup_24h.bad_pct > 30 ? ' vsh-chip-low' : ''), lm.rollup_24h.bad_count + ' unanswered (' + lm.rollup_24h.bad_pct + '%)'));
    roll.appendChild(el('span', 'vsh-chip', 'watchdog: ' + lm.watchdog_skipped_24h + ' skipped / ' + lm.watchdog_fired_any_24h + ' fired'));
    s.appendChild(roll);
    if (!lm.recent_sessions || !lm.recent_sessions.length) { s.appendChild(el('p', 'vsh-empty', 'No sessions in 24h.')); return s; }
    s.appendChild(table([{ label: 'Ended' }, { label: 'Session' }, { label: 'Mic in', cls: 'vsh-num' }, { label: 'Voice out', cls: 'vsh-num' }, { label: 'Turns', cls: 'vsh-num' }, { label: 'Length', cls: 'vsh-num' }, { label: 'Health' }],
      lm.recent_sessions.map(function (x) {
        var tr = el('tr');
        tr.appendChild(td(ago(x.ended_at), 'vsh-nowrap'));
        tr.appendChild(td(String(x.session_id).slice(0, 18), 'vsh-mono'));
        tr.appendChild(td(x.audio_in_chunks, 'vsh-num'));
        tr.appendChild(td(x.audio_out_chunks, 'vsh-num'));
        tr.appendChild(td(x.turn_count, 'vsh-num'));
        tr.appendChild(td(Math.round(x.duration_ms / 1000) + 's', 'vsh-num'));
        tr.appendChild(td({ ok: 'ok', warn: 'thin', bad: 'unanswered' }[x.health] || x.health, 'vsh-health vsh-health-' + x.health));
        return tr;
      })));
    return s;
  }

  function build() {
    var root = el('div', 'vsh');
    root.appendChild(header());
    if (!S.data) {
      if (S.error) {
        var e = el('div', 'vsh-alert vsh-alert-error');
        e.appendChild(el('strong', '', 'Could not load Voice Self-Healing'));
        e.appendChild(el('p', '', S.error));
        e.appendChild(btn('Try again', 'vsh-btn-ghost', function () { load(true); }));
        root.appendChild(e);
      } else {
        root.appendChild(el('p', 'vsh-empty', 'Loading…'));
      }
      return root;
    }
    var d = S.data;
    if (S.error) root.appendChild(el('p', 'vsh-note-warn', 'Last refresh failed (' + S.error + ') — showing data from ' + ago(d.generated_at) + '.'));
    root.appendChild(modeBar(d));
    root.appendChild(alerts(d));
    root.appendChild(pipeline(d));
    root.appendChild(reports(d));
    root.appendChild(detections(d));
    root.appendChild(quarantine(d));
    root.appendChild(perClass(d));
    root.appendChild(liveSessions(d));
    return root;
  }

  window.renderVoiceSelfHealingScreen = function () {
    S.root = build();
    if (!S.data || Date.now() - S.lastAt > 5000) {
      // Defer so the node is attached before the first re-render.
      setTimeout(function () { load(true); }, 0);
    }
    startPolling();
    return S.root;
  };
})();
