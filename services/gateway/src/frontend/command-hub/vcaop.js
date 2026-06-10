/**
 * VCAOP Ops — Vitanaland Commerce admin screen (Command Hub).
 * Talks to /api/v1/vcaop/* with the Command Hub session token
 * (vitana.authToken in localStorage). No inline JS — CSP-compliant.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function getAuthToken() {
    return (
      localStorage.getItem('vitana.authToken') ||
      localStorage.getItem('vitana.access_token') ||
      ''
    );
  }

  function toast(msg, isError) {
    var el = $('vc-toast');
    el.textContent = msg;
    el.classList.add('vc-show');
    el.style.borderColor = isError ? '#f87171' : 'rgba(255,255,255,0.2)';
    setTimeout(function () { el.classList.remove('vc-show'); }, 3500);
  }

  function api(path, opts) {
    opts = opts || {};
    var token = getAuthToken();
    return fetch('/api/v1/vcaop' + path, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function badge(status) {
    var cls = 'vc-badge';
    if (status === 'pending' || status === 'open') cls += ' vc-badge-' + (status === 'open' ? 'open' : 'pending');
    else if (status === 'confirmed' || status === 'completed') cls += ' vc-badge-confirmed';
    else if (status === 'reversed') cls += ' vc-badge-reversed';
    return '<span class="' + cls + '">' + esc(status) + '</span>';
  }

  function table(headers, rows) {
    var h = '<table class="vc-table"><thead><tr>';
    headers.forEach(function (x) { h += '<th>' + esc(x) + '</th>'; });
    h += '</tr></thead><tbody>';
    rows.forEach(function (cells) {
      h += '<tr>';
      cells.forEach(function (c) { h += '<td>' + c + '</td>'; });
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }

  function updateAuthState() {
    $('vc-auth-state').textContent = getAuthToken() ? 'token present' : 'no token — paste one below';
  }

  // ---- Loaders -------------------------------------------------------------

  function loadProviders() {
    var cat = $('vc-prov-cat').value;
    return api('/providers' + (cat ? '?category=' + encodeURIComponent(cat) : '')).then(function (j) {
      $('kpi-providers').textContent = j.data.length;
      $('vc-providers').innerHTML = table(
        ['id', 'name', 'category', 'connector', 'KYB'],
        j.data.map(function (p) {
          return [esc(p.id), esc(p.name), esc(p.category), esc(p.connector_mode), p.kyb_required ? 'yes' : 'no'];
        })
      );
    });
  }

  function loadPrograms() {
    return api('/affiliate-programs').then(function (j) {
      $('kpi-programs').textContent = j.data.length;
      $('vc-programs').innerHTML = table(
        ['id', 'network', 'source', 'cashback'],
        j.data.map(function (p) {
          return [esc(p.id), esc(p.network), esc(p.source),
            p.affiliate_cashback_allowed === true ? 'yes' : p.affiliate_cashback_allowed === false ? 'no' : 'review'];
        })
      );
    });
  }

  function loadInbox() {
    return api('/onboarding/inbox').then(function (j) {
      $('kpi-tasks').textContent = j.data.length;
      if (j.data.length === 0) {
        $('vc-inbox').innerHTML = '<p class="ch-muted">Inbox empty — nothing awaiting a human.</p>';
        return;
      }
      $('vc-inbox').innerHTML = table(
        ['type', 'provider', 'status', 'created', 'action'],
        j.data.map(function (t) {
          var action = t.type === 'KYB'
            ? '<span class="ch-muted">KYB — needs staff+admin approval flow</span>'
            : '<button class="vc-btn vc-btn-sm vc-complete" data-id="' + esc(t.id) + '">Mark completed</button>';
          return [badge(t.type), esc(t.provider_id || '—'), badge(t.status), esc((t.created_at || '').slice(0, 16)), action];
        })
      );
    });
  }

  function loadCommissions() {
    var status = $('vc-comm-status').value;
    return api('/commissions' + (status ? '?status=' + encodeURIComponent(status) : '')).then(function (j) {
      if (status === 'pending') $('kpi-pending').textContent = j.data.length;
      if (j.data.length === 0) {
        $('vc-commissions').innerHTML = '<p class="ch-muted">No commissions for this filter.</p>';
        return;
      }
      $('vc-commissions').innerHTML = table(
        ['merchant', 'user', 'gross', 'status', 'created', 'action'],
        j.data.map(function (c) {
          var action = c.status === 'pending'
            ? '<button class="vc-btn vc-btn-sm vc-confirm" data-id="' + esc(c.id) + '">Confirm</button> ' +
              '<button class="vc-btn vc-btn-sm vc-reverse" data-id="' + esc(c.id) + '">Reverse</button>'
            : c.status === 'confirmed'
              ? '<button class="vc-btn vc-btn-sm vc-reverse" data-id="' + esc(c.id) + '">Reverse</button>'
              : '—';
          return [esc(c.merchant), esc((c.user_id || '').slice(0, 8) + '…'),
            esc(c.gross_commission + ' ' + c.currency), badge(c.status), esc((c.created_at || '').slice(0, 16)), action];
        })
      );
    });
  }

  function refreshAll() {
    updateAuthState();
    Promise.all([loadProviders(), loadPrograms(), loadInbox(), loadCommissions()])
      .then(function () { toast('Loaded.'); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---- Actions -------------------------------------------------------------

  function batchOnboard(ids) {
    var body = ids && ids.length ? { providerIds: ids } : {};
    $('vc-batch-result').textContent = 'Running…';
    api('/onboarding/batch', { method: 'POST', body: body })
      .then(function (j) {
        $('vc-batch-result').textContent =
          'Queued ' + j.data.queued + ' provider(s), created ' + j.data.humanTasksCreated + ' human task(s).';
        return loadInbox();
      })
      .catch(function (e) {
        $('vc-batch-result').textContent = '';
        toast(e.message, true);
      });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    var id = t.getAttribute('data-id');
    if (t.classList.contains('vc-complete') && id) {
      api('/tasks/' + encodeURIComponent(id) + '/complete', { method: 'POST' })
        .then(function () { toast('Task completed.'); return loadInbox(); })
        .catch(function (e) { toast(e.message, true); });
    }
    if (t.classList.contains('vc-confirm') && id) {
      var ref = window.prompt('Postback reference for this confirmation (required):');
      if (!ref) return;
      api('/commissions/' + encodeURIComponent(id) + '/confirm', { method: 'POST', body: { postbackRef: ref } })
        .then(function () { toast('Commission confirmed — wallet credited.'); return loadCommissions(); })
        .catch(function (e) { toast(e.message, true); });
    }
    if (t.classList.contains('vc-reverse') && id) {
      if (!window.confirm('Reverse this commission and claw back the reward?')) return;
      api('/commissions/' + encodeURIComponent(id) + '/reverse', { method: 'POST', body: {} })
        .then(function () { toast('Commission reversed — reward clawed back.'); return loadCommissions(); })
        .catch(function (e) { toast(e.message, true); });
    }
  });

  $('vc-token-save').addEventListener('click', function () {
    var v = $('vc-token-input').value.trim();
    if (v) {
      localStorage.setItem('vitana.authToken', v);
      $('vc-token-input').value = '';
      toast('Token saved locally.');
    }
    updateAuthState();
  });
  $('vc-refresh-all').addEventListener('click', refreshAll);
  $('vc-batch-all').addEventListener('click', function () { batchOnboard([]); });
  $('vc-batch-selected').addEventListener('click', function () {
    var ids = $('vc-batch-ids').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (ids.length === 0) { toast('Enter provider ids first.', true); return; }
    batchOnboard(ids);
  });
  $('vc-prov-load').addEventListener('click', function () { loadProviders().catch(function (e) { toast(e.message, true); }); });
  $('vc-prog-load').addEventListener('click', function () { loadPrograms().catch(function (e) { toast(e.message, true); }); });
  $('vc-comm-load').addEventListener('click', function () { loadCommissions().catch(function (e) { toast(e.message, true); }); });

  updateAuthState();
  if (getAuthToken()) refreshAll();
})();
