(function () {
  'use strict';

  // Phase D (DEV-COMHU voice budget watch) — Voice Instruction Budget panel.
  // Reads GET /api/v1/admin/voice-budget-watch and renders a sortable table.
  // CSP-compliant: this is an external script (no inline JS), DOM built via API.

  const TOKEN_KEY = 'vitana.command_hub.token';
  function authHeaders() {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  const API_BASE = '/api/v1';

  async function fetchJSON(url, opts) {
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts && opts.headers), ...authHeaders() },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  const root = document.getElementById('vb-root');
  let rows = [];
  let sortKey = 'pct_of_cap';
  let sortDir = -1; // desc

  function severityClass(pct) {
    if (pct >= 100) return 'vb-overflow';
    if (pct >= 70) return 'vb-at-risk';
    return '';
  }

  function fmt(n) {
    return (n == null ? 0 : n).toLocaleString();
  }

  const COLUMNS = [
    { key: 'vitana_id', label: 'Vitana ID', num: false },
    { key: 'display_name', label: 'Name', num: false },
    { key: 'memory_items', label: 'Items', num: true },
    { key: 'memory_chars', label: 'Chars', num: true },
    { key: 'memory_facts', label: 'Facts', num: true },
    { key: 'pct_of_cap', label: '% of 12KB cap', num: true },
  ];

  function sortRows() {
    rows.sort(function (a, b) {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });
  }

  function render() {
    root.textContent = '';
    if (!rows.length) {
      const div = document.createElement('div');
      div.className = 'vb-empty';
      div.textContent = 'No users above the minimum threshold.';
      root.appendChild(div);
      return;
    }
    sortRows();

    const table = document.createElement('table');
    table.className = 'vb-table';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    COLUMNS.forEach(function (col) {
      const th = document.createElement('th');
      th.textContent = col.label + (sortKey === col.key ? (sortDir < 0 ? ' ▼' : ' ▲') : '');
      th.addEventListener('click', function () {
        if (sortKey === col.key) { sortDir = -sortDir; }
        else { sortKey = col.key; sortDir = col.num ? -1 : 1; }
        render();
      });
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      const tr = document.createElement('tr');
      const sev = severityClass(r.pct_of_cap);
      tr.className = 'vb-row' + (sev ? ' ' + sev : '');

      COLUMNS.forEach(function (col) {
        const td = document.createElement('td');
        if (col.num) td.className = 'vb-num';
        if (col.key === 'pct_of_cap') {
          td.appendChild(document.createTextNode((r.pct_of_cap == null ? 0 : r.pct_of_cap) + '%'));
          const bar = document.createElement('span');
          bar.className = 'vb-pct-bar' + (sev ? ' ' + sev : '');
          const widthPct = Math.max(2, Math.min(100, r.pct_of_cap));
          bar.style.width = widthPct + 'px';
          td.appendChild(bar);
        } else if (col.num) {
          td.textContent = fmt(r[col.key]);
        } else {
          td.textContent = r[col.key] == null ? '—' : String(r[col.key]);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    root.appendChild(table);
  }

  async function load() {
    root.textContent = 'Loading…';
    const minPct = document.getElementById('vb-minpct').value || '10';
    const limit = document.getElementById('vb-limit').value || '50';
    try {
      const data = await fetchJSON(
        API_BASE + '/admin/voice-budget-watch?limit=' + encodeURIComponent(limit) +
        '&min_pct=' + encodeURIComponent(minPct),
      );
      rows = (data && data.rows) || [];
      render();
    } catch (err) {
      root.textContent = '';
      const div = document.createElement('div');
      div.className = 'vb-error';
      div.textContent = 'Failed to load voice budget: ' + err.message;
      root.appendChild(div);
    }
  }

  document.getElementById('vb-refresh').addEventListener('click', load);
  load();
})();
