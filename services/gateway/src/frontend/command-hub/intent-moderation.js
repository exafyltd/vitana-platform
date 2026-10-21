/* VTID-DANCE-D8: Intent Moderation page logic */
(function () {
  'use strict';

  // Reuse the standard Command Hub auth headers helper from the global app.
  function authHeaders() {
    if (typeof window.buildContextHeaders === 'function') return window.buildContextHeaders();
    return {};
  }

  function api(path, init) {
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      authHeaders(),
      (init && init.headers) || {}
    );
    return fetch(path, Object.assign({}, init, { headers })).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, body: j };
    });
  }

  function setMuted(el, msg, kind) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'muted ' + (kind || '');
  }

  // ── Disputes table ─────────────────────────────────────────────
  async function loadDisputes() {
    const tbl = document.getElementById('disputes-table');
    const empty = document.getElementById('disputes-empty');
    const r = await api('/api/v1/admin/intent-engine/disputes?status=open&limit=20');
    if (!r.ok) {
      empty.textContent = 'Could not load disputes: ' + (r.body.error || r.status);
      return;
    }
    const rows = (r.body.disputes || []);
    if (rows.length === 0) {
      empty.textContent = 'No open disputes.';
      return;
    }
    empty.hidden = true;
    tbl.hidden = false;
    const tbody = tbl.querySelector('tbody');
    tbody.innerHTML = '';
    rows.forEach((d) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + new Date(d.created_at).toLocaleString() + '</td>' +
        '<td><code>' + (d.match_id || '').slice(0, 8) + '</code></td>' +
        '<td>@' + (d.raised_by_vitana_id || '?') + '</td>' +
        '<td>' + (d.reason || '').slice(0, 80) + '</td>' +
        '<td>' + (d.status || '?') + '</td>' +
        '<td><button data-id="' + d.dispute_id + '" data-action="resolve">Resolve</button></td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('button[data-action="resolve"]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.getAttribute('data-id');
        const resolution = window.prompt('Resolution note?');
        if (!resolution) return;
        b.disabled = true;
        const rr = await api('/api/v1/admin/intent-engine/disputes/' + id + '/resolve', {
          method: 'POST',
          body: JSON.stringify({ resolution }),
        });
        if (rr.ok) loadDisputes();
        else alert('Failed: ' + (rr.body.error || rr.status));
      });
    });
  }

  // ── Force-close ────────────────────────────────────────────────
  document.getElementById('force-close-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const intentId = form.intent_id.value.trim();
    const reason = form.reason.value.trim() || 'admin force-close';
    const resultEl = document.getElementById('force-close-result');
    setMuted(resultEl, 'Working…');
    const r = await api('/api/v1/admin/intent-engine/intent/' + encodeURIComponent(intentId) + '/close', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    if (r.ok) {
      setMuted(resultEl, 'Closed: intent_id=' + intentId, 'success');
      form.reset();
    } else {
      setMuted(resultEl, 'Failed: ' + (r.body.error || r.status), 'error');
    }
  });

  // ── Recompute ──────────────────────────────────────────────────
  document.getElementById('recompute-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const intentId = form.intent_id.value.trim();
    const resultEl = document.getElementById('recompute-result');
    setMuted(resultEl, 'Recomputing…');
    const r = await api('/api/v1/admin/intent-engine/recompute', {
      method: 'POST',
      body: JSON.stringify({ intent_id: intentId }),
    });
    if (r.ok) {
      setMuted(resultEl, 'Recomputed: ' + JSON.stringify(r.body), 'success');
    } else {
      setMuted(resultEl, 'Failed: ' + (r.body.error || r.status), 'error');
    }
  });

  // ── Trust-tier flip ────────────────────────────────────────────
  document.getElementById('trust-tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const vid = form.vitana_id.value.trim().replace(/^@/, '').toLowerCase();
    const tier = form.tier.value;
    const reason = form.reason.value.trim() || null;
    const resultEl = document.getElementById('trust-tier-result');
    setMuted(resultEl, 'Applying…');
    const r = await api('/api/v1/admin/users/' + encodeURIComponent(vid) + '/trust-tier', {
      method: 'POST',
      body: JSON.stringify({ tier, reason }),
    });
    if (r.ok) {
      setMuted(resultEl, '✓ @' + vid + ' → ' + tier, 'success');
      form.reset();
    } else {
      setMuted(resultEl, 'Failed: ' + (r.body.error || r.status), 'error');
    }
  });

  // ── Stats ──────────────────────────────────────────────────────
  async function loadStats() {
    const r = await api('/api/v1/admin/intent-engine/stats');
    if (!r.ok) return;
    const s = r.body || {};
    document.getElementById('stat-intents').textContent =
      s.intents_24h != null ? s.intents_24h : (s.intents_total || '—');
    document.getElementById('stat-matches').textContent =
      s.matches_24h != null ? s.matches_24h : (s.matches_total || '—');
    document.getElementById('stat-disputes').textContent = s.disputes_open || '0';
    document.getElementById('stat-shares').textContent = s.direct_shares_24h || '—';
  }

  // Initial load.
  loadDisputes();
  loadStats();
  // Periodic refresh every 30s.
  setInterval(() => { loadDisputes(); loadStats(); }, 30_000);
})();
