/* VTID-01976: Intent Engine Command Hub tile (P2-C).
 *
 * Self-contained dashboard at /command-hub/intent-engine.html. Reads the
 * admin KPI route + open-disputes list. Operators can manually trigger
 * the daily recompute and the archival job from this page.
 *
 * Token: reuses the same auth scheme the rest of Command Hub uses
 * (vitana.authToken in localStorage). No inline JS — CSP-compliant.
 */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  function getAuthToken() {
    try {
      return (
        localStorage.getItem('vitana.authToken') ||
        localStorage.getItem('vitana.access_token') ||
        ''
      );
    } catch {
      return '';
    }
  }

  async function api(path, init = {}) {
    const token = getAuthToken();
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { ok: false, raw: text }; }
    return { ok: res.ok, status: res.status, data };
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  }

  function renderKpi(kpi) {
    const grid = $('#ie-kpi');
    grid.innerHTML = '';
    const cards = [
      { label: 'Posted (24h)', value: kpi.posted_24h, sub: 'new intents in last day' },
      { label: 'Posted (7d)', value: kpi.posted_7d, sub: 'last 7 days' },
      { label: 'With matches', value: kpi.intents_with_match, sub: 'have ≥1 match' },
      { label: 'Mutual interest', value: kpi.mutual_interest, sub: 'live engagements' },
      {
        label: 'Open disputes',
        value: kpi.open_disputes,
        sub: 'awaiting resolution',
        cls: kpi.open_disputes > 0 ? 'ie-card-warn' : '',
      },
      {
        label: 'Stuck open (24h)',
        value: kpi.stuck_open_24h,
        sub: 'zero matches',
        cls: kpi.stuck_open_24h > 5 ? 'ie-card-danger' : kpi.stuck_open_24h > 0 ? 'ie-card-warn' : '',
      },
    ];
    for (const c of cards) {
      const div = document.createElement('div');
      div.className = `ie-card ${c.cls || ''}`.trim();
      const lbl = document.createElement('div');
      lbl.className = 'ie-card-label';
      lbl.textContent = c.label;
      const val = document.createElement('div');
      val.className = 'ie-card-value';
      val.textContent = String(c.value ?? 0);
      const sub = document.createElement('div');
      sub.className = 'ie-card-sub';
      sub.textContent = c.sub;
      div.appendChild(lbl);
      div.appendChild(val);
      div.appendChild(sub);
      grid.appendChild(div);
    }

    // Kinds breakdown.
    const kinds = kpi.kinds_7d || {};
    const total = Object.values(kinds).reduce((a, b) => a + Number(b), 0);
    if (total > 0) {
      const wrap = document.createElement('div');
      wrap.style.gridColumn = '1 / -1';
      const lbl = document.createElement('div');
      lbl.className = 'ie-card-label';
      lbl.textContent = 'Kinds breakdown · 7d';
      wrap.appendChild(lbl);
      const pillRow = document.createElement('div');
      pillRow.className = 'ie-kinds';
      for (const [k, n] of Object.entries(kinds)) {
        const pill = document.createElement('span');
        pill.className = 'ie-kind-pill';
        pill.innerHTML = `${k} <strong>${n}</strong>`;
        pillRow.appendChild(pill);
      }
      wrap.appendChild(pillRow);
      grid.appendChild(wrap);
    }

    $('#ie-snapshot-at').textContent = `snapshot ${fmtTime(kpi.snapshot_at)}`;
  }

  function renderDisputes(disputes) {
    const root = $('#ie-disputes');
    root.innerHTML = '';
    if (!disputes || disputes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ch-muted';
      empty.style.padding = '0.75rem 0';
      empty.textContent = 'No open disputes.';
      root.appendChild(empty);
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'ie-list';
    for (const d of disputes) {
      const li = document.createElement('li');
      const head = document.createElement('div');
      const raised = document.createElement('strong');
      raised.textContent = d.raised_by_vitana_id ? `@${d.raised_by_vitana_id}` : d.raised_by;
      const arrow = document.createTextNode(' → ');
      const counter = document.createElement('strong');
      counter.textContent = d.counterparty_vitana_id ? `@${d.counterparty_vitana_id}` : '—';
      head.appendChild(raised);
      head.appendChild(arrow);
      head.appendChild(counter);
      const meta = document.createElement('div');
      meta.className = 'ie-list-meta';
      meta.textContent = `${d.reason_category} · ${d.status} · ${fmtTime(d.created_at)}`;
      const detail = document.createElement('div');
      detail.style.fontSize = '0.875rem';
      detail.style.color = '#cbd5e1';
      detail.textContent = d.reason_detail;
      li.appendChild(head);
      li.appendChild(meta);
      li.appendChild(detail);
      ul.appendChild(li);
    }
    root.appendChild(ul);
  }

  async function loadStuck(kpi) {
    // Reuse list endpoint via the existing intents data. Since we don't have a
    // dedicated /admin/stuck endpoint in P2-C, we just show the count with a
    // hint. P2-C+ can add a list endpoint.
    const root = $('#ie-stuck');
    root.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'ch-muted';
    if ((kpi.stuck_open_24h ?? 0) === 0) {
      div.textContent = 'No stuck-open intents — supply density is healthy.';
    } else {
      div.textContent = `${kpi.stuck_open_24h} intents posted >24h ago with zero matches. Inspect via the database query: SELECT intent_id, intent_kind, category, created_at FROM user_intents WHERE status='open' AND match_count=0 AND created_at < now() - interval '24 hours';`;
    }
    root.appendChild(div);
  }

  async function load() {
    const kpiRes = await api('/api/v1/admin/intent-engine/kpi');
    if (!kpiRes.ok) {
      $('#ie-kpi').innerHTML = `<div class="ie-loading">Failed to load KPI: ${kpiRes.status} ${kpiRes.data?.error || ''}</div>`;
      return;
    }
    renderKpi(kpiRes.data.kpi || {});
    await loadStuck(kpiRes.data.kpi || {});

    const disputesRes = await api('/api/v1/admin/intent-engine/disputes');
    if (disputesRes.ok) {
      renderDisputes(disputesRes.data.disputes || []);
    }
  }

  function attachActions() {
    $('#ie-recompute-daily').addEventListener('click', async () => {
      const out = $('#ie-action-output');
      out.textContent = 'Running daily recompute…';
      const res = await api('/api/v1/admin/intent-engine/recompute', { method: 'POST', body: '{}' });
      out.textContent = JSON.stringify(res.data, null, 2);
    });
    $('#ie-archive').addEventListener('click', async () => {
      const out = $('#ie-action-output');
      out.textContent = 'Archiving matches > 90d…';
      const res = await api('/api/v1/admin/intent-engine/archive', {
        method: 'POST',
        body: JSON.stringify({ older_than_days: 90, batch_size: 500 }),
      });
      out.textContent = JSON.stringify(res.data, null, 2);
      // Refresh KPI after archive.
      load();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    attachActions();
    load();
  });
})();
