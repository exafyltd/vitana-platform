(function () {
  'use strict';

  // VTID-04933 — Supplier review (exafy_admin). Reads/writes
  // /api/v1/admin/partner-review. CSP-compliant: external script; every node
  // is built with createElement + textContent (no innerHTML with data).

  var API = '/api/v1/admin/partner-review';
  function token() {
    var t = '';
    try { t = localStorage.getItem('vitana.command_hub.token') || localStorage.getItem('vitana.authToken') || ''; } catch (e) { t = ''; }
    return t;
  }
  function headers(json) {
    var h = {};
    var t = token();
    if (t) h.Authorization = 'Bearer ' + t;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  var listRoot = document.getElementById('pr-list');
  var detailRoot = document.getElementById('pr-detail');
  var stateSel = document.getElementById('pr-state');
  var selectedId = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function badge(state) { return el('span', 'pr-badge ' + state, state); }
  function money(cents, cur) {
    if (cents === null || cents === undefined) return '—';
    return (Number(cents) / 100).toFixed(2) + ' ' + (cur || '');
  }
  function when(iso) { return iso ? String(iso).replace('T', ' ').slice(0, 16) + ' UTC' : '—'; }

  function call(method, path, body) {
    return fetch(API + path, { method: method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (j) {
          j._status = r.status;
          return j;
        });
      });
  }

  function loadList() {
    clear(listRoot);
    listRoot.appendChild(el('p', 'pr-empty', 'Loading…'));
    var q = stateSel.value ? '?state=' + encodeURIComponent(stateSel.value) : '';
    call('GET', '/' + q).then(function (j) {
      clear(listRoot);
      if (!j.ok) { listRoot.appendChild(el('div', 'pr-msg err', 'Could not load: ' + (j.error || j._status))); return; }
      var orgs = j.organizations || [];
      if (!orgs.length) { listRoot.appendChild(el('p', 'pr-empty', 'Nobody in this state.')); return; }
      orgs.forEach(function (o) {
        var card = el('div', 'pr-card' + (o.id === selectedId ? ' on' : ''));
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.appendChild(el('h3', '', o.display_name + (o.legal_name ? ' — ' + o.legal_name : '')));
        var meta = el('div', 'pr-meta');
        meta.appendChild(badge(o.lifecycle_state));
        meta.appendChild(document.createTextNode((o.partner_type || 'no type') + ' · ' + (o.country || '—') + ' · ' + o.product_count + ' offering(s)'));
        card.appendChild(meta);
        card.appendChild(el('div', 'pr-meta', o.open_steps && o.open_steps.length ? 'Open: ' + o.open_steps.join(', ') : 'All required steps done'));
        function open() { selectedId = o.id; loadDetail(o.id); Array.prototype.forEach.call(listRoot.children, function (c) { c.classList.remove('on'); }); card.classList.add('on'); }
        card.addEventListener('click', open);
        card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        listRoot.appendChild(card);
      });
    });
  }

  function section(title) {
    var s = el('section', 'pr-section');
    s.appendChild(el('h2', '', title));
    return s;
  }
  function kv(pairs) {
    var dl = el('dl', 'pr-kv');
    pairs.forEach(function (p) { dl.appendChild(el('dt', '', p[0])); dl.appendChild(el('dd', '', p[1] === null || p[1] === undefined || p[1] === '' ? '—' : p[1])); });
    return dl;
  }

  function act(path, body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    call('POST', path, body).then(function (j) {
      var msg = el('div', 'pr-msg ' + (j.ok ? 'ok' : 'err'),
        j.ok ? 'Done. ' + (j.lifecycle_state ? 'State: ' + j.lifecycle_state + '. ' : '') + (j.open_steps && j.open_steps.length ? 'Still open: ' + j.open_steps.join(', ') : '')
             : 'Refused: ' + (j.message || j.error || j._status));
      if (j.ok) { loadList(); loadDetail(selectedId, msg); } else { detailRoot.insertBefore(msg, detailRoot.firstChild); }
    });
  }

  function loadDetail(id, banner) {
    clear(detailRoot);
    detailRoot.appendChild(el('p', 'pr-empty', 'Loading…'));
    call('GET', '/' + encodeURIComponent(id)).then(function (j) {
      clear(detailRoot);
      if (banner) detailRoot.appendChild(banner);
      if (!j.ok) { detailRoot.appendChild(el('div', 'pr-msg err', 'Could not load: ' + (j.error || j._status))); return; }
      var o = j.organization;

      var head = section(o.display_name);
      var line = el('div', 'pr-meta');
      line.appendChild(badge(o.lifecycle_state));
      line.appendChild(document.createTextNode('trust level ' + o.trust_level + ' · ' + (o.partner_type || 'no type')));
      head.appendChild(line);
      head.appendChild(kv([
        ['Legal name', o.legal_name], ['Country', o.country], ['Website', o.website], ['VAT ID', o.vat_id],
        ['Organization id', o.id], ['Created', when(o.created_at)],
      ]));
      detailRoot.appendChild(head);

      var cl = section('Checklist');
      var ul = el('ul', 'pr-steps');
      ((j.checklist && j.checklist.steps) || []).forEach(function (st) {
        if (!st.required && st.status === 'not_required') return;
        var done = st.status === 'done';
        var li = el('li', done ? 'done' : (st.required ? 'open' : ''), (done ? '✓ ' : '○ ') + st.key + ' — ' + st.status + (st.required ? '' : ' (optional)'));
        ul.appendChild(li);
      });
      cl.appendChild(ul);
      var v = j.verification && j.verification.detail;
      if (v && v.method === 'admin_approval') cl.appendChild(el('p', 'pr-meta', 'Verified by admin approval ' + when(v.approved_at) + (v.note ? ' — ' + v.note : '')));
      if (v && v.review_note) cl.appendChild(el('p', 'pr-meta', 'Changes requested ' + when(v.review_note.requested_at) + ': ' + v.review_note.reason));
      detailRoot.appendChild(cl);

      var offers = section('Offerings');
      var prods = j.products || [];
      if (!prods.length) offers.appendChild(el('p', 'pr-empty', 'No offerings yet.'));
      else {
        var wrap = el('div', 'pr-scroll');
        var t = el('table', 'pr-table');
        var hr = el('tr');
        ['Title', 'Kind', 'Price', 'Listing', ''].forEach(function (h) { hr.appendChild(el('th', '', h)); });
        var thead = el('thead'); thead.appendChild(hr); t.appendChild(thead);
        var tb = el('tbody');
        prods.forEach(function (p) {
          var tr = el('tr');
          tr.appendChild(el('td', '', p.title));
          tr.appendChild(el('td', '', p.kind));
          tr.appendChild(el('td', '', money(p.price_cents, p.currency)));
          tr.appendChild(el('td', '', p.listing.replace(/_/g, ' ') + (p.admin_listing && p.admin_listing.reason ? ' — ' + p.admin_listing.reason : '')));
          var td = el('td');
          if (p.listing !== 'kept_offline') {
            var off = el('button', '', 'Keep offline');
            off.type = 'button';
            off.addEventListener('click', function () {
              var r = window.prompt('Why keep "' + p.title + '" offline? (required)');
              if (r) act('/' + encodeURIComponent(o.id) + '/products/' + encodeURIComponent(p.id) + '/keep-offline', { reason: r });
            });
            td.appendChild(off);
          }
          if (p.listing === 'kept_offline') {
            var on = el('button', '', 'Allow listing');
            on.type = 'button';
            on.addEventListener('click', function () {
              act('/' + encodeURIComponent(o.id) + '/products/' + encodeURIComponent(p.id) + '/allow-listing', {},
                'Allow "' + p.title + '" to be listed? It goes on Discover now if the supplier is live, otherwise when it goes live.');
            });
            td.appendChild(on);
          }
          tr.appendChild(td);
          tb.appendChild(tr);
        });
        t.appendChild(tb); wrap.appendChild(t); offers.appendChild(wrap);
      }
      detailRoot.appendChild(offers);

      var terms = section('Partner terms');
      var ta = j.terms_acceptances || [];
      terms.appendChild(ta.length ? kv([['Accepted', ta[0].terms_version + ' · ' + (ta[0].shown_locale || '—') + ' · ' + when(ta[0].accepted_at)]]) : el('p', 'pr-empty', 'Not accepted.'));
      detailRoot.appendChild(terms);

      if (['verifying', 'needs_action', 'exception'].indexOf(o.lifecycle_state) >= 0) {
        var dec = section('Decision');
        var box = el('div', 'pr-actions');
        var reason = el('textarea');
        reason.placeholder = 'Note (optional for approve; required to request changes or reject)';
        reason.maxLength = 1000;
        box.appendChild(reason);
        var a = el('button', 'pr-btn-approve', 'Approve (verification level 1)'); a.type = 'button';
        a.addEventListener('click', function () { act('/' + encodeURIComponent(o.id) + '/approve', { note: reason.value || undefined }, 'Approve ' + o.display_name + '? It goes live only if every required step is done.'); });
        var c = el('button', 'pr-btn-changes', 'Request changes'); c.type = 'button';
        c.addEventListener('click', function () { if (!reason.value.trim()) { reason.focus(); return; } act('/' + encodeURIComponent(o.id) + '/request-changes', { reason: reason.value }); });
        var r = el('button', 'pr-btn-reject', 'Reject'); r.type = 'button';
        r.addEventListener('click', function () { if (!reason.value.trim()) { reason.focus(); return; } act('/' + encodeURIComponent(o.id) + '/reject', { reason: reason.value }, 'Reject ' + o.display_name + '? This is final.'); });
        box.appendChild(a); box.appendChild(c); box.appendChild(r);
        dec.appendChild(box);
        detailRoot.appendChild(dec);
      }

      var ev = section('Recent events');
      var evs = j.events || [];
      if (!evs.length) ev.appendChild(el('p', 'pr-empty', 'No events.'));
      evs.forEach(function (e) { ev.appendChild(el('div', 'pr-meta', when(e.created_at) + ' · ' + e.topic + ' — ' + (e.message || ''))); });
      detailRoot.appendChild(ev);
    });
  }

  document.getElementById('pr-refresh').addEventListener('click', loadList);
  stateSel.addEventListener('change', function () { selectedId = null; clear(detailRoot); loadList(); });
  loadList();
})();
