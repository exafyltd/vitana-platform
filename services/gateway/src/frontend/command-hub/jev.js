(function () {
  'use strict';

  // VTID-04754 — Jev decisions card. Reads GET /api/v1/jev/admin/stats
  // (exafy_admin): calls and cost since boot, persisted month spend per
  // tenant x plane, and shadow-gate agreement per gate.
  // CSP-compliant: external script; every node is built with createElement + textContent.

  var TOKEN_KEY = 'vitana.command_hub.token';
  function authHeaders() {
    var token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  var root = document.getElementById('jev-root');
  var daysInput = document.getElementById('jev-days');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function usd(n) {
    var v = Number(n || 0);
    return '$' + (v < 0.01 && v > 0 ? v.toFixed(6) : v.toFixed(2));
  }

  function num(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function pct(n) {
    return n === null || n === undefined ? '—' : (Number(n) * 100).toFixed(1) + '%';
  }

  function tile(label, value) {
    var t = el('div', 'jev-tile');
    t.appendChild(el('div', 'jev-tile-label', label));
    t.appendChild(el('div', 'jev-tile-value', value));
    return t;
  }

  function table(columns, rows, emptyText) {
    if (!rows || !rows.length) return el('p', 'jev-empty', emptyText);
    var wrap = el('div', 'jev-scroll');
    var t = el('table', 'jev-table');
    var head = el('tr');
    columns.forEach(function (c) { head.appendChild(el('th', c.num ? 'num' : '', c.label)); });
    var thead = el('thead');
    thead.appendChild(head);
    t.appendChild(thead);
    var body = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      columns.forEach(function (c) {
        var td = el('td', c.num ? 'num' : '', c.fmt ? c.fmt(r[c.key], r) : r[c.key]);
        if (c.cls) td.className += ' ' + c.cls(r);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    t.appendChild(body);
    wrap.appendChild(t);
    return wrap;
  }

  function section(title, content) {
    var s = el('section', 'jev-section');
    s.appendChild(el('h2', '', title));
    s.appendChild(content);
    return s;
  }

  function bucketRows(map) {
    return Object.keys(map || {}).sort().map(function (k) {
      var b = map[k];
      return { key: k, calls: b.calls, decided: b.decided, abstained: b.abstained, fallback: b.fallback, failed: b.failed, input_tokens: b.input_tokens, cost_usd: b.cost_usd };
    });
  }

  var BUCKET_COLUMNS = [
    { key: 'key', label: 'Name' },
    { key: 'calls', label: 'Calls', num: true, fmt: num },
    { key: 'decided', label: 'Decided', num: true, fmt: num },
    { key: 'abstained', label: 'Abstained', num: true, fmt: num },
    { key: 'fallback', label: 'Fallback', num: true, fmt: num },
    { key: 'failed', label: 'Failed', num: true, fmt: num },
    { key: 'input_tokens', label: 'Tokens', num: true, fmt: num },
    { key: 'cost_usd', label: 'Cost', num: true, fmt: usd },
  ];

  function render(d) {
    root.textContent = '';
    var monthTotal = (d.spend_month || []).reduce(function (a, r) { return a + Number(r.cost_usd || 0); }, 0);
    var tiles = el('div', 'jev-tiles');
    tiles.appendChild(tile('Configured', d.configured ? 'yes (' + d.model + ')' : 'no'));
    tiles.appendChild(tile('Member plane', d.community_enabled ? 'ON' : 'off'));
    tiles.appendChild(tile('Calls since boot (this task)', num(d.total && d.total.calls)));
    tiles.appendChild(tile('Cost since boot (this task)', usd(d.total && d.total.cost_usd)));
    tiles.appendChild(tile('Spend ' + (d.month || '').slice(0, 7) + ' (all tasks)', usd(monthTotal)));
    root.appendChild(tiles);

    if (d.errors && d.errors.length) {
      root.appendChild(el('p', 'jev-error', 'Partial data: ' + d.errors.join('; ')));
    }

    var modes = Object.keys(d.gate_modes || {}).sort().map(function (k) { return { name: k, mode: d.gate_modes[k] }; });
    var gates = (d.shadow_gates || []).map(function (g) {
      var envName = 'JEV_' + String(g.gate).toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_MODE';
      var live = (d.gate_modes || {})[envName];
      return Object.assign({}, g, { live_mode: live || 'off' });
    });
    root.appendChild(section('Shadow gates (last ' + d.shadow_days + ' days)', table([
      { key: 'gate', label: 'Gate' },
      { key: 'live_mode', label: 'Mode now', cls: function (r) { return r.live_mode === 'enforce' ? 'jev-mode-enforce' : ''; } },
      { key: 'calls', label: 'Calls', num: true, fmt: num },
      { key: 'decided', label: 'Decided', num: true, fmt: num },
      { key: 'with_outcome', label: 'With outcome', num: true, fmt: num },
      { key: 'agreement_rate', label: 'Agreement', num: true, fmt: pct },
      { key: 'cost_usd', label: 'Cost', num: true, fmt: usd },
    ], gates, 'No gate has run in shadow or enforce mode yet.')));

    root.appendChild(section('Gate switches on this task', table([
      { key: 'name', label: 'Env var' },
      { key: 'mode', label: 'Value' },
    ], modes, 'No JEV_<GATE>_MODE is set — every gate is off.')));

    root.appendChild(section('Spend this month by tenant and plane', table([
      { key: 'tenant_id', label: 'Tenant' },
      { key: 'plane', label: 'Plane' },
      { key: 'calls', label: 'Calls', num: true, fmt: num },
      { key: 'input_tokens', label: 'Tokens', num: true, fmt: num },
      { key: 'cost_usd', label: 'Cost', num: true, fmt: usd },
    ], d.spend_month, 'No spend recorded this month.')));

    root.appendChild(section('By decision (since boot, this task)', table(BUCKET_COLUMNS, bucketRows(d.by_decision), 'No calls yet.')));
    root.appendChild(section('By plane (since boot, this task)', table(BUCKET_COLUMNS, bucketRows(d.by_plane), 'No calls yet.')));
    root.appendChild(section('By role (since boot, this task)', table(BUCKET_COLUMNS, bucketRows(d.by_role), 'No calls yet.')));
  }

  function load() {
    var days = Math.max(1, Math.min(Number(daysInput.value) || 14, 90));
    root.textContent = 'Loading…';
    fetch('/api/v1/jev/admin/stats?days=' + days, { headers: authHeaders() })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) throw new Error('Super admin sign-in required (HTTP ' + res.status + ').');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) { render(body.data || {}); })
      .catch(function (err) {
        root.textContent = '';
        root.appendChild(el('p', 'jev-error', 'Could not load Jev stats: ' + err.message));
      });
  }

  document.getElementById('jev-refresh').addEventListener('click', load);
  load();
})();
