(function () {
  'use strict';

  // VTID-04933 — Supplier review (exafy_admin). Reads/writes
  // /api/v1/admin/partner-review. CSP-compliant: external script; every node
  // is built with createElement + textContent; no HTML strings are injected.
  // VTID-04954: reads only the Command Hub's own token (app.js keeps it fresh;
  // this page never refreshes it), says plainly when the sign-in is missing or
  // expired, disables the buttons while an action runs and shows the outcome
  // in a status bar that stays in view.

  var API = '/api/v1/admin/partner-review';
  var HUB = '/command-hub/';
  function token() {
    var t = '';
    try { t = localStorage.getItem('vitana.authToken') || ''; } catch (e) { t = ''; }
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
  var statusRoot = document.getElementById('pr-status');
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

  // Every request goes through here, so list, detail and actions all get the
  // same sign-in handling.
  function call(method, path, body) {
    if (!token()) return Promise.resolve({ ok: false, error: 'NO_SESSION', _auth: 'missing', _status: 0 });
    return fetch(API + path, { method: method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (j) {
          j._status = r.status;
          if (r.status === 401) j._auth = 'expired';
          return j;
        });
      }, function () { return { ok: false, error: 'Network error — check your connection and press Refresh.', _status: 0 }; });
  }

  // A message node; sign-in problems carry a link to the Command Hub.
  function problem(j, prefix) {
    var box = el('div', 'pr-msg err');
    if (j._auth === 'missing') {
      box.appendChild(document.createTextNode('Sign in to the Command Hub in this browser first, then press Refresh. '));
    } else if (j._auth === 'expired') {
      box.appendChild(document.createTextNode('Your Command Hub sign-in has expired. Open the Command Hub in this browser to sign in again, then press Refresh. '));
    } else {
      box.appendChild(document.createTextNode(prefix + (j.message || j.error || j._status)));
      return box;
    }
    var a = el('a', 'pr-link', 'Open the Command Hub');
    a.href = HUB;
    box.appendChild(a);
    return box;
  }

  function showStatus(node) {
    clear(statusRoot);
    if (node) statusRoot.appendChild(node);
  }

  function loadList() {
    clear(listRoot);
    listRoot.appendChild(el('p', 'pr-empty', 'Loading…'));
    var q = stateSel.value ? '?state=' + encodeURIComponent(stateSel.value) : '';
    call('GET', '/' + q).then(function (j) {
      clear(listRoot);
      if (!j.ok) { listRoot.appendChild(problem(j, 'Could not load: ')); return; }
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

  function setButtons(disabled) {
    Array.prototype.forEach.call(detailRoot.querySelectorAll('button'), function (b) { b.disabled = disabled; });
  }

  // label: what a success means, e.g. "Approved — verification level 1."
  function act(path, body, confirmText, label) {
    if (confirmText && !window.confirm(confirmText)) return;
    setButtons(true);
    showStatus(el('div', 'pr-msg', 'Working…'));
    call('POST', path, body).then(function (j) {
      if (!j.ok) {
        setButtons(false);
        showStatus(problem(j, 'Refused: '));
        return;
      }
      var text = (label || 'Done.') + ' ' +
        (j.lifecycle_state ? 'State: ' + j.lifecycle_state + '. ' : '') +
        (j.open_steps ? (j.open_steps.length ? 'Still open: ' + j.open_steps.join(', ') + '.' : 'All required steps done.') : '');
      showStatus(el('div', 'pr-msg ok', text));
      loadList();
      loadDetail(selectedId);
      if (detailRoot.scrollIntoView) detailRoot.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  function loadDetail(id) {
    clear(detailRoot);
    detailRoot.appendChild(el('p', 'pr-empty', 'Loading…'));
    call('GET', '/' + encodeURIComponent(id)).then(function (j) {
      clear(detailRoot);
      if (!j.ok) { detailRoot.appendChild(problem(j, 'Could not load: ')); return; }
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
              if (r) act('/' + encodeURIComponent(o.id) + '/products/' + encodeURIComponent(p.id) + '/keep-offline', { reason: r }, null, 'Kept offline — "' + p.title + '" stays hidden until someone allows listing.');
            });
            td.appendChild(off);
          }
          if (p.listing === 'kept_offline') {
            var on = el('button', '', 'Allow listing');
            on.type = 'button';
            on.addEventListener('click', function () {
              act('/' + encodeURIComponent(o.id) + '/products/' + encodeURIComponent(p.id) + '/allow-listing', {},
                'Allow "' + p.title + '" to be listed? It goes on Discover now if the supplier is live, otherwise when it goes live.',
                'Listing allowed for "' + p.title + '".');
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
        a.addEventListener('click', function () { act('/' + encodeURIComponent(o.id) + '/approve', { note: reason.value || undefined }, 'Approve ' + o.display_name + '? It goes live only if every required step is done.', 'Approved — verification level 1.'); });
        var c = el('button', 'pr-btn-changes', 'Request changes'); c.type = 'button';
        c.addEventListener('click', function () { if (!reason.value.trim()) { reason.focus(); return; } act('/' + encodeURIComponent(o.id) + '/request-changes', { reason: reason.value }, null, 'Changes requested — the supplier sees your note.'); });
        var r = el('button', 'pr-btn-reject', 'Reject'); r.type = 'button';
        r.addEventListener('click', function () { if (!reason.value.trim()) { reason.focus(); return; } act('/' + encodeURIComponent(o.id) + '/reject', { reason: reason.value }, 'Reject ' + o.display_name + '? This is final.', 'Rejected.'); });
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
