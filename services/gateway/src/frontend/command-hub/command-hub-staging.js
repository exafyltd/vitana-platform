/**
 * Command Hub staging-publish + revert UI — Phase 0 staging build (P0.5).
 *
 * Loaded after app.js by index.html. Attaches helpers to window.VitanaStaging
 * so app.js can call them from inside renderPublishModal() and
 * renderVersionDropdown() without restructuring those functions.
 *
 * Exposed API:
 *   window.VitanaStaging.refreshEnv()
 *     — Re-fetch /api/v1/admin/health and cache env on window.VitanaStaging.env.
 *   window.VitanaStaging.env
 *     — 'production' | 'staging' | null (null while loading).
 *   window.VitanaStaging.renderPublishStagingCard(opts)
 *     — Returns an HTMLElement to prepend to the PUBLISH modal body when
 *       env === 'production'. opts: { onClose: fn, buildContextHeaders: fn }.
 *   window.VitanaStaging.renderRevertButton(version, opts)
 *     — Returns an HTMLElement (a small button) to append to a version row.
 *       opts: { onClose: fn, buildContextHeaders: fn, onAfterRevert: fn }.
 *
 * Hard rules followed by this module:
 *   - No inline JS in HTML; everything is built via DOM APIs.
 *   - Every endpoint call uses buildContextHeaders() supplied by app.js so the
 *     admin JWT + role headers flow through. Calling without headers would
 *     401 in production.
 *   - Type-to-confirm flow on both publish AND revert — server-side checks
 *     also enforce, but UI prevents accidental clicks first.
 */

(function () {
  'use strict';

  const VS = (window.VitanaStaging = window.VitanaStaging || {});
  VS.env = null;
  VS.envFetchedAt = 0;

  const ENV_TTL_MS = 30_000;

  /** Refresh env-identity cache. Safe to call repeatedly; respects TTL. */
  VS.refreshEnv = async function refreshEnv(force) {
    if (!force && VS.env && Date.now() - VS.envFetchedAt < ENV_TTL_MS) return VS.env;
    try {
      const resp = await fetch('/api/v1/admin/health', { credentials: 'include' });
      if (resp.ok) {
        const body = await resp.json();
        if (body && (body.env === 'staging' || body.env === 'production')) {
          VS.env = body.env;
          VS.envFetchedAt = Date.now();
          return VS.env;
        }
      }
    } catch (err) {
      console.warn('[VitanaStaging] /admin/health unreachable:', err && err.message);
    }
    return VS.env;
  };

  // Kick off the first fetch immediately. Modal-open / dropdown-open paths
  // re-check via refreshEnv() but having a value cached on first paint avoids
  // a flash of generic content.
  VS.refreshEnv(true).catch(function () { /* swallow */ });

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'style' && typeof attrs[k] === 'string') node.style.cssText = attrs[k];
        else if (k === 'class') node.className = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    children.forEach(function (c) {
      if (c == null) return;
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    });
    return node;
  }

  function formatTimeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - Date.parse(iso);
    if (isNaN(ms) || ms < 0) return iso;
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const d = Math.floor(hr / 24);
    return d + 'd ago';
  }

  // ============== Publish staging → production card ==============

  /**
   * Render the "Promote latest staging to production" card. Returns an
   * HTMLElement to insert near the top of the existing PUBLISH modal body
   * on the PRODUCTION Command Hub. On staging Command Hub, app.js skips
   * calling this in favor of the existing dev-redeploy dropdown.
   *
   * opts:
   *   onClose:               function to close the publish modal
   *   buildContextHeaders:   app.js helper to attach auth + role headers
   *   onAfterPublish:        optional callback fired after a successful publish
   */
  VS.renderPublishStagingCard = function renderPublishStagingCard(opts) {
    opts = opts || {};
    const headers = (opts.buildContextHeaders ? opts.buildContextHeaders({}) : {}) || {};

    // Card shell.
    const card = el('div', {
      class: 'publish-staging-card',
      style: 'margin-bottom:18px;padding:14px 16px;background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.25);border-radius:10px;font-size:13px;',
    });

    const titleRow = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;' },
      el('span', { style: 'font-weight:600;color:#86efac;letter-spacing:0.3px;' }, 'Promote staging → production'),
      el('span', { class: 'publish-staging-card__status', style: 'font-size:11px;color:#888;' }, 'loading…')
    );
    card.appendChild(titleRow);

    const detail = el('div', { class: 'publish-staging-card__detail', style: 'min-height:60px;color:#cbd5e1;line-height:1.55;' }, 'Fetching gateway-staging current revision…');
    card.appendChild(detail);

    // Confirm input + button (hidden until detail loads).
    const actions = el('div', { style: 'margin-top:12px;display:none;', class: 'publish-staging-card__actions' });
    const confirmInput = el('input', {
      type: 'text',
      placeholder: 'Type the 7-char short SHA to enable',
      style: 'width:100%;padding:10px 12px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#fff;font-family:monospace;font-size:13px;margin-bottom:10px;',
    });
    const publishBtn = el('button', {
      type: 'button',
      disabled: 'disabled',
      style: 'width:100%;padding:12px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-weight:600;cursor:not-allowed;opacity:0.5;',
    }, 'Publish to Production');
    actions.appendChild(confirmInput);
    actions.appendChild(publishBtn);
    card.appendChild(actions);

    // Inline result line (success or error).
    const resultLine = el('div', {
      class: 'publish-staging-card__result',
      style: 'margin-top:10px;display:none;font-size:12px;line-height:1.5;',
    });
    card.appendChild(resultLine);

    // Load gateway-staging revisions.
    fetch('/api/v1/operator/revisions?service=gateway-staging&limit=1', { credentials: 'include', headers })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status + ' ' + r.statusText)); })
      .then(function (body) {
        const rev = body && body.revisions && body.revisions[0];
        if (!rev) throw new Error('No staging revisions returned');

        const shortSha = rev.commitSha ? rev.commitSha.slice(0, 7) : null;
        titleRow.lastChild.textContent = shortSha ? 'commit ' + shortSha : 'commit unknown';
        titleRow.lastChild.style.color = shortSha ? '#86efac' : '#fbbf24';

        detail.innerHTML = '';
        detail.appendChild(el('div', {}, 'Source: gateway-staging revision ', el('strong', {}, rev.shortName)));
        detail.appendChild(el('div', {}, 'Deployed: ', formatTimeAgo(rev.createdAt)));
        if (shortSha) detail.appendChild(el('div', {}, 'Commit: ', el('code', { style: 'color:#fde68a;' }, shortSha)));
        detail.appendChild(el('div', { style: 'margin-top:6px;color:#888;font-size:12px;' }, 'Target: gateway (production) — same image, traffic shifts after EXEC-DEPLOY completes.'));

        if (!shortSha) {
          actions.style.display = 'block';
          publishBtn.textContent = 'Cannot publish — staging revision has no GIT_COMMIT_SHA';
          publishBtn.style.background = 'rgba(251,191,36,0.2)';
          publishBtn.style.color = '#fbbf24';
          confirmInput.disabled = true;
          return;
        }

        actions.style.display = 'block';

        // Wire the type-to-confirm gate. Server enforces too but UI does
        // best-effort to keep the user honest.
        confirmInput.addEventListener('input', function () {
          const ok = confirmInput.value.trim().toLowerCase() === shortSha.toLowerCase();
          publishBtn.disabled = !ok;
          publishBtn.style.cursor = ok ? 'pointer' : 'not-allowed';
          publishBtn.style.opacity = ok ? '1' : '0.5';
        });

        publishBtn.addEventListener('click', function () {
          publishBtn.disabled = true;
          publishBtn.textContent = 'Publishing…';
          resultLine.style.display = 'block';
          resultLine.style.color = '#9ca3af';
          resultLine.textContent = 'Calling POST /api/v1/operator/publish — bake checks then EXEC-DEPLOY dispatch.';

          fetch('/api/v1/operator/publish', {
            method: 'POST',
            credentials: 'include',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
            body: JSON.stringify({ confirm_short_sha: shortSha }),
          })
            .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
            .then(function (payload) {
              if (payload.status >= 200 && payload.status < 300 && payload.body && payload.body.ok) {
                resultLine.style.color = '#86efac';
                const url = payload.body.workflow_url;
                resultLine.innerHTML = '✓ Publish dispatched. VTID ' + (payload.body.vtid || '—') + '. ';
                if (url) {
                  const a = el('a', { href: url, target: '_blank', style: 'color:#60a5fa;text-decoration:underline;' }, 'Watch EXEC-DEPLOY');
                  resultLine.appendChild(a);
                }
                publishBtn.textContent = 'Dispatched';
                publishBtn.style.background = 'rgba(74,222,128,0.2)';
                if (typeof opts.onAfterPublish === 'function') opts.onAfterPublish(payload.body);
              } else {
                resultLine.style.color = '#fca5a5';
                resultLine.textContent = 'Publish refused: ' + ((payload.body && (payload.body.detail || payload.body.error)) || ('HTTP ' + payload.status));
                publishBtn.disabled = false;
                publishBtn.textContent = 'Publish to Production';
              }
            })
            .catch(function (err) {
              resultLine.style.display = 'block';
              resultLine.style.color = '#fca5a5';
              resultLine.textContent = 'Network error: ' + (err && err.message ? err.message : 'unknown');
              publishBtn.disabled = false;
              publishBtn.textContent = 'Publish to Production';
            });
        });
      })
      .catch(function (err) {
        titleRow.lastChild.textContent = 'error';
        titleRow.lastChild.style.color = '#fca5a5';
        detail.style.color = '#fca5a5';
        detail.textContent = 'Could not load gateway-staging revisions: ' + (err && err.message ? err.message : 'unknown');
      });

    return card;
  };

  // ============== Per-version Revert button ==============

  /**
   * Render a Revert button to attach to a version-dropdown row. Only call
   * this when `version.revert_eligible === true`.
   *
   * Clicking opens a small confirmation overlay that asks the operator to
   * type the short SHA, then POSTs /api/v1/operator/revert. The dropdown
   * itself is built by app.js; this just returns the button + manages its
   * own overlay DOM.
   *
   * opts: { buildContextHeaders, onAfterRevert }
   */
  VS.renderRevertButton = function renderRevertButton(version, opts) {
    opts = opts || {};
    const headers = (opts.buildContextHeaders ? opts.buildContextHeaders({}) : {}) || {};

    const btn = el('button', {
      type: 'button',
      class: 'version-dropdown__revert-btn',
      style: 'margin-left:8px;padding:3px 8px;font-size:11px;background:rgba(251,113,133,0.15);border:1px solid rgba(251,113,133,0.4);color:#fca5a5;border-radius:4px;cursor:pointer;',
    }, 'Revert');

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openRevertOverlay(version, headers, opts);
    });

    return btn;
  };

  function openRevertOverlay(version, headers, opts) {
    // Build a self-contained modal overlay. We avoid touching app.js state
    // here so the revert flow can complete even if the dropdown is closed
    // mid-confirm.
    const overlay = el('div', {
      class: 'modal-overlay vitana-staging-revert-overlay',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;',
    });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });

    const modal = el('div', {
      class: 'modal',
      style: 'background:#0f172a;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:20px;width:90%;max-width:460px;font-size:13px;',
    });

    const cloudRev = version.cloud_run_revision || '(unknown revision)';
    const service = version.service || 'gateway';
    const commit = (version.git_commit || '').slice(0, 7);

    modal.appendChild(el('div', { style: 'font-size:16px;font-weight:600;margin-bottom:10px;color:#fca5a5;' }, 'Revert ' + service));
    modal.appendChild(el('div', { style: 'margin-bottom:6px;' }, 'Target revision: ', el('strong', {}, cloudRev)));
    modal.appendChild(el('div', { style: 'margin-bottom:6px;' }, 'Commit: ', el('code', { style: 'color:#fde68a;' }, commit || 'unknown')));
    modal.appendChild(el('div', { style: 'margin-bottom:14px;color:#cbd5e1;line-height:1.5;' },
      'Traffic on ', el('strong', {}, service), ' will move to 100% of this revision within ~30s. No re-deploy; the image already exists.'
    ));

    const input = el('input', {
      type: 'text',
      placeholder: commit ? 'Type ' + commit + ' to enable' : 'Type the short SHA to enable',
      style: 'width:100%;padding:10px 12px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#fff;font-family:monospace;font-size:13px;margin-bottom:10px;',
    });
    modal.appendChild(input);

    const result = el('div', { style: 'margin-top:6px;font-size:12px;line-height:1.5;display:none;' });
    modal.appendChild(result);

    const actions = el('div', { style: 'display:flex;gap:10px;margin-top:14px;' });

    const cancel = el('button', {
      type: 'button',
      style: 'flex:1;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#fff;border-radius:6px;cursor:pointer;',
    }, 'Cancel');
    cancel.addEventListener('click', function () { overlay.remove(); });
    actions.appendChild(cancel);

    const go = el('button', {
      type: 'button',
      disabled: 'disabled',
      style: 'flex:1;padding:10px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:not-allowed;opacity:0.5;font-weight:600;',
    }, 'Revert');
    actions.appendChild(go);

    input.addEventListener('input', function () {
      const ok = commit && input.value.trim().toLowerCase() === commit.toLowerCase();
      go.disabled = !ok;
      go.style.cursor = ok ? 'pointer' : 'not-allowed';
      go.style.opacity = ok ? '1' : '0.5';
    });

    go.addEventListener('click', function () {
      go.disabled = true;
      go.textContent = 'Reverting…';
      result.style.display = 'block';
      result.style.color = '#9ca3af';
      result.textContent = 'POST /api/v1/operator/revert — traffic shift in flight.';

      fetch('/api/v1/operator/revert', {
        method: 'POST',
        credentials: 'include',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify({ service: service, target_revision: cloudRev, confirm_short_sha: commit }),
      })
        .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
        .then(function (payload) {
          if (payload.status >= 200 && payload.status < 300 && payload.body && payload.body.ok) {
            result.style.color = '#86efac';
            result.textContent = '✓ Revert dispatched. SWV ' + (payload.body.swv_id || '—') + '. Traffic should reach 100% within 30s.';
            go.textContent = 'Done';
            if (typeof opts.onAfterRevert === 'function') opts.onAfterRevert(payload.body);
            setTimeout(function () { overlay.remove(); }, 2500);
          } else {
            result.style.color = '#fca5a5';
            result.textContent = 'Revert refused: ' + ((payload.body && (payload.body.detail || payload.body.error)) || ('HTTP ' + payload.status));
            go.disabled = false;
            go.textContent = 'Revert';
          }
        })
        .catch(function (err) {
          result.style.color = '#fca5a5';
          result.textContent = 'Network error: ' + (err && err.message ? err.message : 'unknown');
          go.disabled = false;
          go.textContent = 'Revert';
        });
    });

    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); }, 50);
  }
})();
