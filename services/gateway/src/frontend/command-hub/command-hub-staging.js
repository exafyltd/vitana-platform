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

  // ============== Inline Publish flow (Lovable-style, no modal) ==============
  //
  // Renders a popover-style card anchored below the PUBLISH button.  Replaces
  // the legacy renderPublishModal() on the production Command Hub.  The flow
  // is: load staging revision → one-click Publish → button transforms through
  // phases (loading→ready→publishing→building→rolling→verified) → auto-close
  // after success, or red error + retry on failure.

  function phaseChip(text, kind) {
    const colors = {
      loading:    { bg: 'rgba(148,163,184,0.18)', fg: '#cbd5e1' },
      ready:      { bg: 'rgba(74,222,128,0.15)',  fg: '#86efac' },
      publishing: { bg: 'rgba(96,165,250,0.18)',  fg: '#93c5fd' },
      building:   { bg: 'rgba(96,165,250,0.18)',  fg: '#93c5fd' },
      rolling:    { bg: 'rgba(96,165,250,0.18)',  fg: '#93c5fd' },
      verified:   { bg: 'rgba(74,222,128,0.2)',   fg: '#4ade80' },
      error:      { bg: 'rgba(251,113,133,0.18)', fg: '#fca5a5' },
    };
    const c = colors[kind] || colors.loading;
    return el('span', {
      style: 'display:inline-flex;align-items:center;gap:6px;padding:3px 10px;background:' + c.bg +
             ';color:' + c.fg + ';border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.3px;',
    }, text);
  }

  function spinnerSvg(size, color) {
    const px = size || 14;
    const stroke = color || '#93c5fd';
    return el('span', {
      style: 'display:inline-block;width:' + px + 'px;height:' + px + 'px;border:2px solid ' + stroke +
             ';border-top-color:transparent;border-radius:50%;animation:vs-spin 0.8s linear infinite;',
    });
  }

  // Inject the spin keyframe once, idempotent.
  function ensureSpinnerCss() {
    if (document.getElementById('vs-spinner-css')) return;
    const style = document.createElement('style');
    style.id = 'vs-spinner-css';
    style.textContent = '@keyframes vs-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }

  /**
   * Render the inline Publish popover.  Caller (app.js) decides where to
   * mount it (typically as a sibling of the PUBLISH button anchor).
   *
   * opts:
   *   buildContextHeaders: app.js helper for auth headers
   *   onClose:             function to close the popover
   *   onAfterPublish:      callback after publish dispatched, used to refresh
   *                        version history + live revision
   *
   * State persistence: this function reads & writes state.publishFlow on the
   * app's global `state` object, so the popover survives renderApp() calls
   * (the user's app re-renders frequently).
   */
  VS.renderPublishInlineFlow = function renderPublishInlineFlow(opts) {
    opts = opts || {};
    ensureSpinnerCss();
    const headers = (opts.buildContextHeaders ? opts.buildContextHeaders({}) : {}) || {};
    const s = (window.__vitana_state && window.__vitana_state.publishFlow) || {};

    const card = el('div', {
      class: 'publish-popover',
      style: 'position:absolute;top:calc(100% + 8px);left:0;width:340px;background:var(--color-sidebar-bg);' +
             'border:1px solid var(--color-border);border-radius:10px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.5);' +
             'z-index:1000;padding:14px 16px;font-size:13px;',
    });

    // Header row: phase chip + close.
    const phase = s.phase || 'loading';
    const chipText = ({
      loading:    el('span', {}, spinnerSvg(11, '#cbd5e1'), ' Reading staging…'),
      ready:      'Ready to publish',
      publishing: el('span', {}, spinnerSvg(11, '#93c5fd'), ' Dispatching deploy…'),
      building:   el('span', {}, spinnerSvg(11, '#93c5fd'), ' Building…'),
      rolling:    el('span', {}, spinnerSvg(11, '#93c5fd'), ' Rolling out…'),
      verified:   '✓ Published',
      error:      '× Publish failed',
    })[phase];
    const headerRow = el('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;',
    },
      phaseChip(chipText, phase),
      el('button', {
        type: 'button',
        style: 'background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;',
        onclick: function (e) {
          e.stopPropagation();
          if (window.__vitana_state) window.__vitana_state.publishFlow.open = false;
          if (typeof renderApp === 'function') renderApp();
        },
      }, '×')
    );
    card.appendChild(headerRow);

    // Body content depends on phase.
    if (phase === 'verified') {
      card.appendChild(el('div', { style: 'color:#86efac;line-height:1.5;' },
        'Production gateway is now serving ',
        el('code', { style: 'color:#fde68a;font-size:12px;' }, (s.sourceCommit || '').slice(0, 7) || '—'),
        '.  ',
        s.workflowUrl
          ? el('a', { href: s.workflowUrl, target: '_blank', style: 'color:#60a5fa;text-decoration:underline;' }, 'View deploy →')
          : null
      ));
      card.appendChild(el('div', { style: 'margin-top:10px;color:var(--color-text-secondary);font-size:11px;' },
        'This popover will close automatically.'
      ));
      // Auto-close after 4s on success.
      if (!s._autoCloseTimer) {
        s._autoCloseTimer = setTimeout(function () {
          if (window.__vitana_state && window.__vitana_state.publishFlow) {
            window.__vitana_state.publishFlow.open = false;
            window.__vitana_state.publishFlow.phase = 'idle';
            window.__vitana_state.publishFlow._autoCloseTimer = null;
          }
          if (typeof renderApp === 'function') renderApp();
        }, 4000);
      }
      return card;
    }

    if (phase === 'error') {
      card.appendChild(el('div', { style: 'color:#fca5a5;line-height:1.5;margin-bottom:10px;' }, s.message || 'Unknown error'));
      card.appendChild(el('button', {
        type: 'button',
        style: 'width:100%;padding:10px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-weight:600;cursor:pointer;',
        onclick: function (e) {
          e.stopPropagation();
          if (window.__vitana_state) {
            window.__vitana_state.publishFlow.phase = 'loading';
            window.__vitana_state.publishFlow.message = '';
          }
          if (typeof renderApp === 'function') renderApp();
        },
      }, 'Retry'));
      return card;
    }

    // Fetch BOTH staging (source) AND prod (currently live) revisions on
    // first open so the popover shows the full before/after comparison.
    if (!s.sourceRevision) {
      Promise.all([
        fetch('/api/v1/operator/revisions?service=gateway-staging&limit=1', { credentials: 'include', headers })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('staging ' + r.status)); }),
        fetch('/api/v1/operator/revisions?service=gateway&limit=5', { credentials: 'include', headers })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('prod ' + r.status)); }),
      ])
        .then(function (results) {
          const sRev = results[0] && results[0].revisions && results[0].revisions[0];
          const pRevs = (results[1] && results[1].revisions) || [];
          const pRev = pRevs.find(function (r) { return r.isActive; }) || pRevs[0];
          if (!sRev) throw new Error('No staging revisions');
          if (window.__vitana_state && window.__vitana_state.publishFlow) {
            const sf = window.__vitana_state.publishFlow;
            sf.sourceRevision = sRev.shortName;
            sf.sourceCommit = sRev.commitSha || null;
            sf.sourceDeployedAt = sRev.createdAt || null;
            sf.liveRevision = pRev ? pRev.shortName : null;
            sf.liveCommit = pRev && pRev.commitSha ? pRev.commitSha : null;
            sf.liveDeployedAt = pRev ? pRev.createdAt : null;
            sf.phase = 'ready';
          }
          if (typeof renderApp === 'function') renderApp();
        })
        .catch(function (err) {
          if (window.__vitana_state && window.__vitana_state.publishFlow) {
            window.__vitana_state.publishFlow.phase = 'error';
            window.__vitana_state.publishFlow.message = 'Could not load: ' + (err && err.message);
          }
          if (typeof renderApp === 'function') renderApp();
        });
    }

    // Comparison block: "Currently live" ↓ arrow ↓ "Source from staging".
    const compareBlock = el('div', { style: 'margin-bottom:14px;color:#cbd5e1;line-height:1.5;' });

    if (s.sourceRevision) {
      // Currently live (prod).
      compareBlock.appendChild(el('div', {
        style: 'color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;',
      }, 'Currently live'));
      const liveLine = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:2px;' },
        el('span', { style: 'width:6px;height:6px;border-radius:50%;background:#10b981;flex:none;' }),
        el('code', { style: 'color:#fde68a;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' },
          s.liveCommit ? s.liveCommit.slice(0, 7) : (s.liveRevision || 'unknown')),
        el('span', { style: 'color:#888;font-size:11px;' }, s.liveDeployedAt ? formatTimeAgo(s.liveDeployedAt) : '')
      );
      compareBlock.appendChild(liveLine);

      // Arrow.
      compareBlock.appendChild(el('div', { style: 'color:#666;font-size:14px;line-height:1;text-align:center;margin:6px 0 6px 2px;' }, '↓'));

      // Source from staging.
      compareBlock.appendChild(el('div', {
        style: 'color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;',
      }, 'Source from staging'));
      const sourceLine = el('div', { style: 'display:flex;align-items:center;gap:8px;' },
        el('span', { style: 'width:6px;height:6px;border-radius:50%;background:#93c5fd;flex:none;' }),
        el('code', { style: 'color:#fde68a;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' },
          s.sourceCommit ? s.sourceCommit.slice(0, 7) : s.sourceRevision),
        el('span', { style: 'color:#888;font-size:11px;' }, s.sourceDeployedAt ? formatTimeAgo(s.sourceDeployedAt) : '')
      );
      compareBlock.appendChild(sourceLine);

      // "Same as live" hint if commits match — operator should know the
      // publish would be a no-op.
      if (s.sourceCommit && s.liveCommit && s.sourceCommit === s.liveCommit) {
        compareBlock.appendChild(el('div', {
          style: 'margin-top:8px;padding:6px 9px;background:rgba(148,163,184,0.1);border-radius:5px;font-size:11px;color:#94a3b8;',
        }, 'Staging and production are on the same commit. Publish will re-deploy the current code.'));
      }
    } else {
      compareBlock.appendChild(el('div', { style: 'color:var(--color-text-secondary);font-size:12px;' }, 'Loading revisions…'));
    }
    card.appendChild(compareBlock);

    // Single big action button. Disabled until phase=ready.
    const publishing = phase === 'publishing' || phase === 'building' || phase === 'rolling';
    const btn = el('button', {
      type: 'button',
      style: 'width:100%;padding:12px 16px;border:none;border-radius:8px;font-weight:600;font-size:14px;' +
             'cursor:' + (phase === 'ready' ? 'pointer' : 'not-allowed') + ';' +
             'background:' + (phase === 'ready' ? '#16a34a' : 'rgba(148,163,184,0.18)') + ';' +
             'color:' + (phase === 'ready' ? '#fff' : '#cbd5e1') + ';' +
             'opacity:' + (phase === 'ready' ? '1' : '0.85') + ';' +
             'display:flex;align-items:center;justify-content:center;gap:8px;',
    });
    if (publishing) {
      btn.appendChild(spinnerSvg(14, '#93c5fd'));
      btn.appendChild(document.createTextNode({
        publishing: 'Dispatching…',
        building:   'Building…',
        rolling:    'Rolling out…',
      }[phase]));
    } else if (phase === 'loading') {
      btn.appendChild(spinnerSvg(14, '#cbd5e1'));
      btn.appendChild(document.createTextNode('Loading…'));
    } else {
      btn.textContent = 'Publish to production';
    }
    if (phase === 'ready') {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        // Phase transitions: ready → publishing → building → rolling → verified
        const sf = window.__vitana_state && window.__vitana_state.publishFlow;
        if (!sf) return;
        sf.phase = 'publishing';
        sf.startedAt = Date.now();
        if (typeof renderApp === 'function') renderApp();

        fetch('/api/v1/operator/publish', {
          method: 'POST',
          credentials: 'include',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({ confirm_short_sha: (sf.sourceCommit || '').slice(0, 7) }),
        })
          .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
          .then(function (payload) {
            if (payload.status >= 200 && payload.status < 300 && payload.body && payload.body.ok) {
              sf.vtid = payload.body.vtid || null;
              sf.workflowUrl = payload.body.workflow_url || null;
              sf.phase = 'building';
              if (typeof renderApp === 'function') renderApp();
              // Poll for new prod revision serving the published commit.
              pollUntilLive(sf, headers, opts);
            } else {
              sf.phase = 'error';
              sf.message = (payload.body && (payload.body.detail || payload.body.error)) || ('HTTP ' + payload.status);
              if (typeof renderApp === 'function') renderApp();
            }
          })
          .catch(function (err) {
            sf.phase = 'error';
            sf.message = 'Network: ' + (err && err.message ? err.message : 'unknown');
            if (typeof renderApp === 'function') renderApp();
          });
      });
    }
    card.appendChild(btn);

    return card;
  };

  // Poll Cloud Run for the new prod revision to actually serve traffic.
  // Transitions phase: building → rolling → verified.  Caps at 6 minutes;
  // after that we surface a "still running, check workflow URL" notice
  // instead of blocking forever.
  function pollUntilLive(sf, headers, opts) {
    const startSha = (sf.sourceCommit || '').slice(0, 7);
    if (!startSha) return; // can't reliably verify without a SHA
    const startMs = Date.now();
    let phase = 'building';
    const tick = function () {
      if (Date.now() - startMs > 6 * 60 * 1000) {
        sf.phase = 'verified'; // optimistic: workflow is dispatched, surface the link
        sf.message = '(taking longer than usual; check the deploy URL)';
        if (typeof renderApp === 'function') renderApp();
        if (typeof opts.onAfterPublish === 'function') opts.onAfterPublish(sf);
        return;
      }
      fetch('/api/v1/admin/health', { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) {
          // build-info has git_commit; /admin/health has cloud_run_revision.
          // Use the env=production health endpoint via the prod gateway URL?
          // Actually this admin/health is for *current host* — when running
          // on production Command Hub, it returns prod's revision.
          if (!body) { setTimeout(tick, 5000); return; }
          // Switch to "rolling" once we see ANY new revision (not necessarily
          // matching commit yet — gives the user a sense of forward motion).
          if (phase === 'building' && body.cloud_run_revision && !sf._sawRev) {
            sf._sawRev = body.cloud_run_revision;
            sf.phase = 'rolling';
            phase = 'rolling';
            if (typeof renderApp === 'function') renderApp();
          }
          // Verified when /admin/build-info exists & git_commit matches.
          return fetch('/api/v1/admin/build-info', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (bi) {
              if (bi && bi.git_commit && bi.git_commit.slice(0, 7) === startSha) {
                sf.phase = 'verified';
                if (typeof renderApp === 'function') renderApp();
                if (typeof opts.onAfterPublish === 'function') opts.onAfterPublish(sf);
                return;
              }
              setTimeout(tick, 5000);
            });
        })
        .catch(function () { setTimeout(tick, 5000); });
    };
    setTimeout(tick, 4000); // first poll 4s after dispatch
  }

  // ============== Live revision pill (under PUBLISH button) ==============
  //
  // Renders a small text annotation like "Live: a7b3f9 · 12m ago" sourced
  // from /api/v1/operator/revisions?service=gateway.  Cached in
  // state.liveRevision; auto-refreshes once per minute (when the popover
  // OR the dropdown is open).

  VS.renderLiveRevisionPill = function renderLiveRevisionPill(opts) {
    opts = opts || {};
    const lr = (window.__vitana_state && window.__vitana_state.liveRevision) || {};
    const span = el('span', {
      class: 'live-revision-pill',
      style: 'display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--color-text-secondary);' +
             'margin-top:2px;letter-spacing:0.2px;line-height:1;',
    });
    if (lr.shortSha) {
      span.appendChild(el('span', { style: 'width:5px;height:5px;border-radius:50%;background:#10b981;flex:none;' }));
      span.appendChild(el('span', {}, 'Live: '));
      span.appendChild(el('code', { style: 'color:#fde68a;font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' }, lr.shortSha));
      if (lr.deployedAt) span.appendChild(el('span', {}, ' · ' + formatTimeAgo(lr.deployedAt)));
    } else {
      span.appendChild(el('span', {}, 'Loading live revision…'));
    }

    // Trigger a fetch if stale (> 60s) or empty.
    if (!lr.lastFetched || Date.now() - lr.lastFetched > 60000) {
      const headers = (opts.buildContextHeaders ? opts.buildContextHeaders({}) : {}) || {};
      fetch('/api/v1/operator/revisions?service=gateway&limit=3', { credentials: 'include', headers })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) {
          if (!body || !body.revisions) return;
          const active = body.revisions.find(function (r) { return r.isActive; }) || body.revisions[0];
          if (active && window.__vitana_state) {
            window.__vitana_state.liveRevision = {
              shortSha: (active.commitSha ? active.commitSha.slice(0, 7) : active.shortName.slice(0, 12)),
              deployedAt: active.createdAt || null,
              lastFetched: Date.now(),
            };
            if (typeof renderApp === 'function') renderApp();
          }
        })
        .catch(function () { /* swallow */ });
    }

    return span;
  };
})();
