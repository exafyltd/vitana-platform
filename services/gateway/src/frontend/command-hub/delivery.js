/**
 * VTID-05547 — Command Hub → Delivery (plan agentic-delivery §3.12).
 *
 * Read-only view of GET /api/v1/delivery/summary, which reads only the VTID ledger and OASIS (VTID-01170):
 * the merge queue per project, the latest pipeline per merge request with the state of main, and the
 * releases (the staging deploy per service and the latest STAGING-VERIFY with its run link). Production stays
 * the PUBLISH button of the header; nothing here changes anything.
 *
 * Tabs (NAVIGATION_CONFIG section "delivery"): merge-queue, pipeline-runs (shown as Pipelines), releases.
 *
 * Loaded on demand by app.js (a same-origin script element, the first time a Delivery tab opens), so
 * index.html and modules.json keep their script list. At load time it only defines window.DeliveryScreen;
 * app.js calls render({ tab, headers }) from its render switch.
 * CSP: external file, no inline script, no inline style, no handler attributes, no HTML strings; every text node is
 * set through textContent and only https links are made clickable. It reuses the Command Hub's own classes.
 * Admin console text, English by design (not member-visible; no LLM text).
 */
(function (root) {
    'use strict';

    var API = '/api/v1/delivery/summary';
    var REPOS = ['vitana-platform', 'vitana-v1'];
    var STALE_MS = 30000;
    var TAB_TITLES = { 'merge-queue': 'Merge queue', 'pipeline-runs': 'Pipelines', 'releases': 'Releases' };
    var QUEUE_TEXT = {
        'queue-updating': 'Updating', 'queue-ready': 'Ready', 'queue-waiting': 'Waiting',
        'queue-blocked': 'Blocked', 'queue-paused': 'Paused'
    };
    // Colour: the Testing & QA pill family of styles.css. Measured on the table background (WCAG AA needs 4.5:1 for small
    // text): ok 5.9, bad 4.6, warn 6.7, info 6.9, neutral 4.6; secondary-colour cells 5.7; pull request links 5.8. The
    // stylesheet's status-success, status-error and status-info badges measure 4.5, 3.4 and 3.3 and are not used. A state
    // is always carried by its label as well as its colour.
    var PILL = { ok: 'tq-pill tq-pill-ok', bad: 'tq-pill tq-pill-bad', warn: 'tq-pill tq-pill-warn', info: 'tq-pill tq-pill-env', neutral: 'tq-pill tq-pill-neutral' };
    var QUEUE_CLASS = {
        'queue-updating': PILL.info, 'queue-ready': PILL.ok, 'queue-waiting': PILL.neutral,
        'queue-blocked': PILL.bad, 'queue-paused': PILL.warn
    };
    var PIPELINE_BADGE = {
        running: ['Running', PILL.info], succeeded: ['Passed', PILL.ok],
        failed: ['Failed', PILL.bad], canceled: ['Canceled', PILL.neutral]
    };
    var MAIN_BADGE = {
        green: ['Green', PILL.ok], red: ['Red', PILL.bad],
        running: ['Running', PILL.info], unknown: ['No pipeline yet', PILL.neutral]
    };
    var DEPLOY_BADGE = {
        completed: ['Deployed', PILL.ok], failed: ['Failed', PILL.bad], rolled_back: ['Rolled back', PILL.warn]
    };
    var VERIFY_BADGE = {
        passed: ['Passed', PILL.ok], failed: ['Failed', PILL.bad], superseded: ['Superseded', PILL.neutral]
    };
    // Cells, from the Command Hub's own classes: MONO is monospace, one line, secondary colour; CLIP is one line clipped
    // with an ellipsis at 200 px (the full text stays in the title attribute); AGE is one line, secondary colour.
    var MONO = 'gov-eval-timestamp';
    var CLIP = 'gov-eval-action';
    var AGE = 'event-timestamp';
    var MONO_CLIP = MONO + ' ' + CLIP;

    var st = {
        data: null, error: null, loading: false, loadedAt: 0, includeShadow: false, tab: 'merge-queue',
        getHeaders: null, el: null, doc: null, fetch: null, now: null
    };

    function h(tag, cls, text) {
        var n = (st.doc || root.document).createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    function nowMs() { return st.now ? st.now() : Date.now(); }

    // ---- formatting ------------------------------------------------------------------------------------

    function fmtDuration(s) {
        if (s === null || s === undefined || isNaN(s)) return '—';
        s = Math.round(Number(s));
        if (s < 60) return s + ' s';
        var m = Math.floor(s / 60);
        if (m < 60) return m + ' min' + (s % 60 ? ' ' + (s % 60) + ' s' : '');
        var hrs = Math.floor(m / 60);
        return hrs + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    }

    function fmtAgo(iso) {
        var t = Date.parse(iso || '');
        if (isNaN(t)) return '—';
        var s = Math.max(0, Math.round((nowMs() - t) / 1000));
        return fmtDuration(s) + ' ago';
    }

    function shortSha(sha) { return sha ? String(sha).slice(0, 12) : '—'; }

    /** Only https links are made clickable; anything else is shown as text. */
    function safeUrl(url) { return typeof url === 'string' && /^https:\/\//.test(url) ? url : null; }

    // ---- building blocks -------------------------------------------------------------------------------

    function badge(pair, fallback) {
        var p = pair || [fallback || '—', PILL.neutral];
        return h('span', p[1], p[0]);
    }

    /** A table cell with its own class and tooltip. */
    function cell(text, cls, title) {
        return { isCell: true, text: text, cls: cls || '', title: title || '' };
    }

    function note(text, role) {
        var n = h('p', 'placeholder-content', text);
        if (role) n.setAttribute('role', role);
        return n;
    }

    function link(text, url) {
        var safe = safeUrl(url);
        if (!safe) return h('span', null, text);
        var a = h('a', 'approvals-pr-link', text); // #60a5fa on the table background: 5.75:1
        a.href = safe;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        return a;
    }

    /** A named table: cells are strings or elements. */
    function table(label, columns, rows) {
        var inset = h('div', 'tq-view'); // the Command Hub's padded content block: space around the scrolling table
        var wrap = h('div', 'gov-evals-table-wrapper');
        var t = h('table', 'gov-evals-table');
        t.setAttribute('aria-label', label);
        var head = h('thead');
        var hr = h('tr');
        columns.forEach(function (c) {
            var th = h('th', null, c);
            th.setAttribute('scope', 'col');
            hr.appendChild(th);
        });
        head.appendChild(hr);
        t.appendChild(head);
        var body = h('tbody');
        rows.forEach(function (cells) {
            var tr = h('tr', 'gov-eval-row');
            cells.forEach(function (cell) {
                var td = h('td');
                var value = cell;
                if (value && value.isCell) {
                    if (value.cls) td.className = value.cls;
                    if (value.title) td.setAttribute('title', value.title);
                    value = value.text;
                }
                if (value && typeof value === 'object') td.appendChild(value);
                else td.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
                tr.appendChild(td);
            });
            body.appendChild(tr);
        });
        t.appendChild(body);
        wrap.appendChild(t);
        inset.appendChild(wrap);
        return inset;
    }

    function hostText(repo) {
        var hosts = (st.data && st.data.hosts) || {};
        return hosts[repo] === 'gitlab' ? 'GitLab' : 'GitHub';
    }

    function ledgerTitle(vtid) {
        var l = vtid && st.data && st.data.ledger && st.data.ledger[vtid];
        return l && l.title ? String(l.title) : null;
    }

    function vtidCell(vtid) { return cell(vtid, MONO); }
    function titleCell(vtid) {
        var t = ledgerTitle(vtid);
        return t ? cell(t, CLIP, t) : '—';
    }

    function sectionHeading(box, title, extra) {
        var head = h('div', 'tasks-toolbar');
        head.appendChild(h('h3', 'section-title', title));
        if (extra) head.appendChild(extra);
        box.appendChild(head);
    }

    function repoHeading(box, repo, extra) {
        sectionHeading(box, repo + ' · ' + hostText(repo), extra);
    }

    // ---- tabs ------------------------------------------------------------------------------------------

    function renderQueue(box, d) {
        REPOS.forEach(function (repo) {
            var q = (d.merge_queue || {})[repo] || { paused: false, items: [] };
            var sec = h('section', 'delivery-repo');
            sec.setAttribute('aria-label', repo + ' merge queue');
            repoHeading(sec, repo, q.paused ? badge(['Landing paused', PILL.warn]) : null);
            if (!q.items.length) {
                sec.appendChild(note(hostText(repo) === 'GitHub'
                    ? 'This repository still delivers on GitHub. Its merge queue fills after the cut.'
                    : 'Nothing is waiting to land.'));
            } else {
                sec.appendChild(table(repo + ' merge queue',
                    ['Position', 'VTID', 'Title', 'Lane', 'State', 'Waiting', 'Merge request'],
                    q.items.map(function (i) {
                        return [
                            i.position === null || i.position === undefined ? '—' : i.position,
                            vtidCell(i.vtid),
                            titleCell(i.vtid),
                            cell(i.lane_key, MONO_CLIP, i.lane_key),
                            badge([QUEUE_TEXT[i.state_label] || i.state_label, QUEUE_CLASS[i.state_label] || PILL.neutral]),
                            cell(fmtDuration(i.wait_s), AGE),
                            link('!' + i.merge_request_iid, i.url)
                        ];
                    })));
            }
            box.appendChild(sec);
        });
    }

    function renderPipelines(box, d) {
        REPOS.forEach(function (repo) {
            var p = (d.pipelines || {})[repo] || { main: { state: 'unknown' }, items: [] };
            var main = p.main || { state: 'unknown' };
            var sec = h('section', 'delivery-repo');
            sec.setAttribute('aria-label', repo + ' pipelines');
            var mainBox = h('span', null);
            mainBox.appendChild(h('span', null, 'main '));
            mainBox.appendChild(badge(MAIN_BADGE[main.state] || MAIN_BADGE.unknown));
            if (main.since) mainBox.appendChild(h('span', null, ' ' + fmtAgo(main.since)));
            repoHeading(sec, repo, mainBox);
            if (!p.items.length) {
                sec.appendChild(note(hostText(repo) === 'GitHub'
                    ? 'This repository still delivers on GitHub. Its pipelines appear after the cut.'
                    : 'No pipelines in this window.'));
            } else {
                sec.appendChild(table(repo + ' latest pipeline per merge request',
                    ['Merge request', 'Ref', 'Status', 'Waited', 'Ran', 'Failed jobs', 'VTID', 'Pipeline'],
                    p.items.map(function (i) {
                        return [
                            i.merge_request_iid === null || i.merge_request_iid === undefined ? '—' : '!' + i.merge_request_iid,
                            cell(i.ref, MONO_CLIP, i.ref),
                            badge(PIPELINE_BADGE[i.status]),
                            cell(fmtDuration(i.wait_s), AGE),
                            cell(fmtDuration(i.run_s), AGE),
                            i.jobs_failed,
                            vtidCell(i.vtid),
                            link('#' + (i.pipeline_id === null || i.pipeline_id === undefined ? '?' : i.pipeline_id), i.url)
                        ];
                    })));
            }
            box.appendChild(sec);
        });
    }

    function renderReleases(box, d) {
        var rel = d.releases || { deploys: [], verifications: [], latest_verify: null };
        var sec = h('section', 'delivery-repo');
        sec.setAttribute('aria-label', 'Staging deploys');
        sectionHeading(sec, 'Staging deploys', null);
        if (!rel.deploys.length) sec.appendChild(note('No staging deploy in this window.'));
        else {
            sec.appendChild(table('Staging deploys', ['Service', 'Commit', 'Status', 'Host', 'When'],
                rel.deploys.map(function (i) {
                    return [cell(i.service, MONO), cell(shortSha(i.commit), MONO), badge(DEPLOY_BADGE[i.status]), i.host === 'gitlab' ? 'GitLab' : 'GitHub', cell(fmtAgo(i.at), AGE)];
                })));
        }
        box.appendChild(sec);

        var ver = h('section', 'delivery-repo');
        ver.setAttribute('aria-label', 'STAGING-VERIFY');
        sectionHeading(ver, 'STAGING-VERIFY', null);
        if (!rel.verifications.length) ver.appendChild(note('No STAGING-VERIFY result in this window.'));
        else {
            ver.appendChild(table('STAGING-VERIFY results', ['Service', 'Commit', 'Outcome', 'When', 'Run'],
                rel.verifications.map(function (i) {
                    return [cell(i.service, MONO), cell(shortSha(i.commit), MONO), badge(VERIFY_BADGE[i.outcome], i.outcome), cell(fmtAgo(i.at), AGE), link('Open run', i.run_url)];
                })));
        }
        box.appendChild(ver);
        box.appendChild(note('Production stays the PUBLISH button in the header: it promotes the build that passed STAGING-VERIFY.'));
    }

    // ---- paint and load --------------------------------------------------------------------------------

    function toolbar(box) {
        var head = h('div', 'tasks-toolbar');
        head.appendChild(h('h2', 'section-title', TAB_TITLES[st.tab] || 'Delivery'));
        box.appendChild(head);
        var bar = h('div', 'tasks-toolbar');
        var shadow = h('label', 'toolbar-toggle');
        var cb = h('input');
        cb.type = 'checkbox';
        cb.checked = st.includeShadow;
        cb.addEventListener('change', function () {
            st.includeShadow = !!cb.checked;
            load();
        });
        shadow.appendChild(cb);
        shadow.appendChild(h('span', null, 'Include shadow runs'));
        bar.appendChild(shadow);
        var refresh = h('button', 'btn btn-secondary btn-sm', 'Refresh');
        refresh.type = 'button';
        refresh.addEventListener('click', function () { load(); });
        bar.appendChild(refresh);
        box.appendChild(bar);
    }

    function paint() {
        var box = st.el;
        if (!box) return;
        while (box.firstChild) box.removeChild(box.firstChild);
        toolbar(box);
        if (st.error) {
            box.appendChild(note('Could not load delivery data: ' + st.error, 'alert'));
            var retry = h('button', 'btn btn-secondary btn-sm', 'Retry');
            retry.type = 'button';
            retry.addEventListener('click', function () { load(); });
            box.appendChild(retry);
            return;
        }
        if (!st.data) {
            box.appendChild(note('Loading delivery data…', 'status'));
            return;
        }
        var d = st.data;
        if (st.loading) box.appendChild(note('Refreshing…', 'status'));
        if (st.tab === 'pipeline-runs') renderPipelines(box, d);
        else if (st.tab === 'releases') renderReleases(box, d);
        else renderQueue(box, d);
        if (d.truncated) box.appendChild(note('Only the newest events of the window were read; older ones are not shown.'));
        var refused = d.refused_merges && d.refused_merges.count;
        if (refused) box.appendChild(note(refused + ' GitHub merge' + (refused === 1 ? '' : 's') + ' refused since the cut; the last ' + fmtAgo(d.refused_merges.last_at) + '.'));
        box.appendChild(note('From the VTID ledger and OASIS · window ' + d.window_hours + ' h · ' + (d.include_shadow ? 'shadow runs included' : 'shadow runs hidden')));
    }

    function load() {
        if (st.loading) return;
        st.loading = true;
        st.error = null;
        paint();
        var headers = st.getHeaders ? st.getHeaders({}) : {};
        var url = API + (st.includeShadow ? '?include_shadow=1' : '');
        (st.fetch || function (u, i) { return root.fetch(u, i); })(url, { headers: headers })
            .then(function (r) { return r.json(); })
            .then(function (body) {
                if (body && body.ok) { st.data = body; st.error = null; st.loadedAt = nowMs(); }
                else st.error = (body && body.error) || 'Unknown error';
            })
            .catch(function (err) { st.error = (err && err.message) || String(err); })
            .then(function () { st.loading = false; paint(); });
    }

    /**
     * Returns the view's root element for one tab. opts.tab is merge-queue, pipeline-runs or releases; opts.headers(extra)
     * supplies the Command Hub auth headers (app.js buildContextHeaders); opts.doc, opts.fetch and opts.now default
     * to the browser's and exist for tests.
     */
    function render(opts) {
        opts = opts || {};
        st.getHeaders = opts.headers || null;
        st.doc = opts.doc || null;
        st.fetch = opts.fetch || null;
        st.now = opts.now || null;
        st.tab = TAB_TITLES[opts.tab] ? opts.tab : 'merge-queue';
        st.el = h('div', 'delivery-view');
        paint();
        if (!st.data || st.error || nowMs() - st.loadedAt > STALE_MS) load();
        return st.el;
    }

    function reset() {
        st.data = null; st.error = null; st.loading = false; st.loadedAt = 0; st.includeShadow = false; st.tab = 'merge-queue';
        st.el = null; st.doc = null; st.fetch = null; st.now = null; st.getHeaders = null;
    }

    root.DeliveryScreen = {
        render: render,
        reset: reset,
        TABS: Object.keys(TAB_TITLES),
        // Exposed for tests.
        _internals: { state: st, fmtDuration: fmtDuration, fmtAgo: fmtAgo, safeUrl: safeUrl, shortSha: shortSha, load: load }
    };
})(typeof window !== 'undefined' ? window : this);
