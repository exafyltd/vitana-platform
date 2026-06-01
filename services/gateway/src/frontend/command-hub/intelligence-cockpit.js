(function () {
  'use strict';

  // Phase 1 W3-D1 PR 5 (VTID-03247) — Intelligence Cockpit spine.
  // Single page wiring. Panel 1 (Training & dataset pipeline) is live;
  // remaining panels render placeholders pointing at the planned
  // follow-up endpoint each one will consume.
  // CSP-compliant: external script, no inline JS, DOM built via API.

  const TOKEN_KEY = 'vitana.command_hub.token';
  function authHeaders() {
    const token = (window.localStorage && window.localStorage.getItem(TOKEN_KEY)) || '';
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  const API_BASE = '/api/v1';

  async function fetchJSON(url) {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function fmtRel(iso) {
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (!isFinite(t)) return iso;
    var deltaMs = Date.now() - t;
    var mins = Math.round(deltaMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.round(mins / 60);
    if (hours < 48) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
  }

  function conclusionClass(conclusion, status) {
    if (status && status !== 'completed') return 'cockpit-pill cockpit-pill--pending';
    if (conclusion === 'success') return 'cockpit-pill cockpit-pill--ok';
    if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') {
      return 'cockpit-pill cockpit-pill--bad';
    }
    return 'cockpit-pill cockpit-pill--neutral';
  }

  function conclusionLabel(conclusion, status) {
    if (status && status !== 'completed') return status;
    return conclusion || 'unknown';
  }

  function renderTrainingPanel(payload) {
    var body = document.getElementById('panel-training-body');
    if (!body) return;
    body.innerHTML = '';

    if (!payload || !Array.isArray(payload.workflows) || payload.workflows.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'cockpit-panel__hint';
      empty.textContent = 'No workflow runs returned. Check GitHub API credentials.';
      body.appendChild(empty);
      return;
    }

    var byCat = { dataset: [], training: [], context: [] };
    payload.workflows.forEach(function (w) {
      (byCat[w.category] || (byCat[w.category] = [])).push(w);
    });

    ['dataset', 'training', 'context'].forEach(function (cat) {
      var items = byCat[cat] || [];
      if (items.length === 0) return;

      var heading = document.createElement('h3');
      heading.className = 'cockpit-panel__subhead';
      heading.textContent = cat;
      body.appendChild(heading);

      var table = document.createElement('table');
      table.className = 'cockpit-table';
      var thead = document.createElement('thead');
      var thr = document.createElement('tr');
      ['Workflow', 'Status', 'When', ''].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        thr.appendChild(th);
      });
      thead.appendChild(thr);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      items.forEach(function (w) {
        var tr = document.createElement('tr');

        var tdLabel = document.createElement('td');
        tdLabel.textContent = w.label;
        var lbl = document.createElement('div');
        lbl.className = 'cockpit-table__sub';
        lbl.textContent = w.id;
        tdLabel.appendChild(lbl);
        tr.appendChild(tdLabel);

        var tdStatus = document.createElement('td');
        var pill = document.createElement('span');
        pill.className = conclusionClass(w.conclusion, w.status);
        pill.textContent = w.error
          ? 'error'
          : conclusionLabel(w.conclusion, w.status);
        tdStatus.appendChild(pill);
        tr.appendChild(tdStatus);

        var tdWhen = document.createElement('td');
        tdWhen.textContent = fmtRel(w.created_at);
        tr.appendChild(tdWhen);

        var tdLink = document.createElement('td');
        if (w.html_url) {
          var a = document.createElement('a');
          a.href = w.html_url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'open';
          tdLink.appendChild(a);
        } else {
          tdLink.textContent = '—';
        }
        tr.appendChild(tdLink);

        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      body.appendChild(table);
    });
  }

  function renderTrainingError(err) {
    var body = document.getElementById('panel-training-body');
    if (!body) return;
    body.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'cockpit-panel__hint cockpit-panel__hint--bad';
    p.textContent = 'Failed to load: ' + (err && err.message ? err.message : err);
    body.appendChild(p);
  }

  async function refresh() {
    var meta = document.getElementById('cockpit-last-update');
    try {
      var data = await fetchJSON(API_BASE + '/admin/cockpit/training-status');
      renderTrainingPanel(data);
      if (meta) meta.textContent = 'updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      renderTrainingError(err);
      if (meta) meta.textContent = 'load failed';
    }
  }

  function init() {
    var btn = document.getElementById('cockpit-refresh');
    if (btn) btn.addEventListener('click', function () { refresh(); });
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
