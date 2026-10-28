/**
 * VTID-03463 — Watcher Command Hub panel.
 *
 * Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454) Phase 4.
 *
 * External file, no inline script, no CDN — CSP rules (CLAUDE.md NEVER 24/25/30).
 * All DOM is built with createElement/textContent rather than innerHTML: the
 * strings rendered here include failure messages and lesson text distilled
 * from CI logs and LLM output, which is exactly the content you must not
 * interpolate into markup.
 */
(function () {
  'use strict';

  var statusEl = document.getElementById('w-status');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function api(path) {
    return fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok || !body || body.ok === false) {
            throw new Error((body && body.error) || ('HTTP ' + r.status));
          }
          return body.data;
        });
      });
  }

  function showError(container, err) {
    clear(container);
    // Say what actually failed. "Could not load" with no reason is the thing
    // that makes an operator guess, and guessing is what this panel exists
    // to replace.
    container.appendChild(el('div', 'w-error', 'Failed: ' + (err && err.message ? err.message : 'unknown error')));
  }

  // ---------------------------------------------------------------------
  // Observer health
  // ---------------------------------------------------------------------
  function renderHealth(data) {
    var container = document.getElementById('w-health');
    clear(container);

    var o = data.observer || {};

    // Cards go in their OWN grid container. Putting the cursor table inside
    // the same grid makes it a grid item in a minmax(150px,1fr) column, which
    // squeezes every column to one character wide and renders it unreadable.
    var cards = el('div', 'w-grid');

    // Raw var AND resolved value, side by side. BOOTSTRAP-ORB-FASTSTART-DRIFT
    // was precisely the bug where a var was set and the feature was still
    // dead, so showing only one of these would reproduce the trap.
    cards.appendChild(card('Enabled (resolved)', String(o.enabled_resolved),
      o.enabled_resolved ? 'w-ok' : 'w-warn'));
    cards.appendChild(card('Env var', o.env_var_present ? String(o.env_var_value) : '(unset)', 'w-neutral'));
    cards.appendChild(card('Running', String(o.running), o.running ? 'w-ok' : 'w-warn'));
    cards.appendChild(card('Topics observed', String(data.observed_topic_count), 'w-neutral'));
    cards.appendChild(card('Session ingest', data.session_ingest_configured ? 'configured' : 'closed',
      data.session_ingest_configured ? 'w-ok' : 'w-neutral'));
    container.appendChild(cards);

    var sources = data.sources || [];
    if (sources.length === 0) {
      container.appendChild(el('div', 'w-muted', 'No source cursors yet — the observer has not completed a tick.'));
      return;
    }

    var table = el('table', 'w-table');
    var thead = el('thead');
    var hrow = el('tr');
    ['Source', 'Cursor', 'Last run', 'Wrote', 'Error'].forEach(function (h) {
      hrow.appendChild(el('th', null, h));
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = el('tbody');
    sources.forEach(function (s) {
      var row = el('tr', s.last_error ? 'w-row-error' : null);
      row.appendChild(el('td', null, s.source));
      row.appendChild(el('td', null, s.cursor_at || '—'));
      row.appendChild(el('td', null, s.last_run_at || 'never'));
      row.appendChild(el('td', null, String(s.last_written === undefined ? '—' : s.last_written)));
      // A source that scans every tick and writes zero is the signature of a
      // broken normalizer; surfacing last_error is what keeps that from
      // looking like a quiet week.
      row.appendChild(el('td', null, s.last_error || '—'));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    var wrap = el('div', 'w-table-wrap');
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  function card(label, value, tone) {
    var c = el('div', 'w-card ' + (tone || 'w-neutral'));
    c.appendChild(el('div', 'w-card-label', label));
    c.appendChild(el('div', 'w-card-value', value));
    return c;
  }

  // ---------------------------------------------------------------------
  // Timeline
  // ---------------------------------------------------------------------
  function renderTimeline(data) {
    var container = document.getElementById('w-timeline');
    clear(container);

    if (!data.steps || data.steps.length === 0) {
      container.appendChild(el('div', 'w-muted', 'No steps recorded for that selector.'));
      return;
    }

    var list = el('ol', 'w-steps');
    data.steps.forEach(function (s) {
      var li = el('li', 'w-step w-outcome-' + (s.outcome || 'unknown'));
      var head = el('div', 'w-step-head');
      head.appendChild(el('span', 'w-step-name', s.step));
      head.appendChild(el('span', 'w-step-outcome', s.outcome));
      head.appendChild(el('span', 'w-step-actor', s.actor));
      li.appendChild(head);
      li.appendChild(el('div', 'w-step-meta', s.observed_at + ' · ' + s.source));
      var ev = s.evidence || {};
      if (ev.message) li.appendChild(el('div', 'w-step-msg', String(ev.message).slice(0, 300)));
      list.appendChild(li);
    });
    container.appendChild(list);

    if (data.truncated) {
      // Never let a capped list read as the complete history.
      container.appendChild(el('div', 'w-warn-note',
        'Result was capped — there may be more steps than shown.'));
    }
  }

  // ---------------------------------------------------------------------
  // Reminder preview
  // ---------------------------------------------------------------------
  function renderReminders(data) {
    var container = document.getElementById('w-remind');
    clear(container);

    if (!data.enabled_resolved) {
      container.appendChild(el('div', 'w-warn-note',
        'WATCHER_REMINDERS_ENABLED is not live — this block is computed but NOT injected into any prompt.'));
    }

    if (!data.reminders || data.reminders.length === 0) {
      container.appendChild(el('div', 'w-muted', 'Nothing would be injected at this stage.'));
      return;
    }

    var list = el('ul', 'w-reminders');
    data.reminders.forEach(function (r) {
      var li = el('li', 'w-reminder w-sev-' + r.severity);
      li.appendChild(el('div', 'w-reminder-text', r.text));
      li.appendChild(el('div', 'w-reminder-src', r.kind + ' · ' + r.source));
      list.appendChild(li);
    });
    container.appendChild(list);

    var budget = el('div', 'w-muted',
      data.reminders.length + ' shown · ~' + data.tokens_used + ' tokens');
    container.appendChild(budget);

    if (data.truncated && data.truncated.dropped > 0) {
      container.appendChild(el('div', 'w-warn-note',
        data.truncated.dropped + ' withheld — ' + data.truncated.reason));
    }
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function loadHealth() {
    return api('/api/v1/watcher/health')
      .then(function (data) {
        renderHealth(data);
        statusEl.textContent = data.supabase_available ? 'Connected' : 'Supabase unavailable';
      })
      .catch(function (err) {
        showError(document.getElementById('w-health'), err);
        statusEl.textContent = 'Error';
      });
  }

  function loadTimeline(value) {
    var v = (value || '').trim();
    if (!v) return Promise.resolve();
    // A VTID is a known shape; anything else is treated as a work-unit id.
    var key = /^VTID-\d+$/i.test(v) ? 'vtid' : 'work_unit_id';
    return api('/api/v1/watcher/timeline?' + key + '=' + encodeURIComponent(v))
      .then(renderTimeline)
      .catch(function (err) { showError(document.getElementById('w-timeline'), err); });
  }

  function loadReminders(stage) {
    // record_shown deliberately omitted: previewing must not move the
    // auto-mute denominator, or idle inspection would retire lessons that
    // were never actually injected anywhere.
    return api('/api/v1/watcher/remind?stage=' + encodeURIComponent(stage))
      .then(renderReminders)
      .catch(function (err) { showError(document.getElementById('w-remind'), err); });
  }

  document.getElementById('w-timeline-form').addEventListener('submit', function (e) {
    e.preventDefault();
    loadTimeline(document.getElementById('w-timeline-input').value);
  });

  document.getElementById('w-remind-form').addEventListener('submit', function (e) {
    e.preventDefault();
    loadReminders(document.getElementById('w-remind-stage').value);
  });

  loadHealth();
  loadReminders('execute');
})();
