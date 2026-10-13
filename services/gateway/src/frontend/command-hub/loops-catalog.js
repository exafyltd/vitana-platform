/**
 * VTID-05084 — Command Hub → Autonomy → Loops (Loop Engineering, Phase 1).
 *
 * Read-only view of GET /api/v1/autonomy/loops: the 14 loops that make
 * Vitanaland self-healing and self-improving, the one shared engine they run
 * on, and the Simplification panel (sensor coverage + known overlaps).
 * Doctrine: docs/autonomy/LOOP-ENGINEERING.md.
 *
 * A check is not a loop: sensors (Testing & QA, Routines, Service Health,
 * scheduled workflows) stay on their own screens; this screen links to them.
 *
 * Loaded before app.js (modules.json kind "module"). At load time it only
 * defines window.LoopsCatalog; app.js calls render() from its render switch.
 * CSP: external file, no inline script, no on* attributes, every text node is
 * set through textContent. Admin console text, English by design.
 */
(function (root) {
    'use strict';

    var API = '/api/v1/autonomy/loops';
    var CONTRACT = [
        ['trigger', 'Trigger'], ['goal', 'Goal (finish line)'], ['act', 'Act'], ['verifier', 'Verify'],
        ['stop', 'Stop'], ['human_gate', 'Human gate'], ['budget', 'Budget'], ['metrics', 'Metrics']
    ];
    var SENSOR_LINKS = {
        health_groups: { label: 'Service Health groups', href: null },
        routines: { label: 'Routines', href: '/command-hub/routines/catalog/' },
        workflows: { label: 'Scheduled workflows', href: '/command-hub/testing-qa/catalog/' },
        test_contracts: { label: 'Test contracts', href: '/command-hub/testing-qa/test-contracts/' }
    };
    var OVERLAP_LABELS = { open: 'Open', resolved: 'Resolved', partly_resolved: 'Partly resolved', not_a_duplicate: 'Not a duplicate' };
    var GROUPS = [['platform', 'Platform loops — the system fixes and improves itself'],
                  ['product', 'Product loops — member, supplier and creator experience improves itself']];

    var st = { data: null, error: null, loading: false, selected: null, getHeaders: null, el: null, doc: null, fetch: null };

    function h(tag, cls, text) {
        var n = (st.doc || root.document).createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    function load() {
        if (st.loading) return;
        st.loading = true;
        var headers = st.getHeaders ? st.getHeaders({}) : {};
        (st.fetch || function (u, i) { return root.fetch(u, i); })(API, { headers: headers })
            .then(function (r) { return r.json(); })
            .then(function (body) {
                if (body && body.ok) { st.data = body.data; st.error = null; }
                else st.error = (body && body.error) || 'Unknown error';
            })
            .catch(function (err) { st.error = (err && err.message) || String(err); })
            .then(function () { st.loading = false; paint(); });
    }

    function signalText(loop, signals) {
        if (!loop.run_plane) return 'No run ledger yet';
        var s = signals && signals[loop.run_plane];
        if (!s || s.state !== 'ok') return 'Run signal unavailable';
        if (!s.total) return 'No runs in 7 days';
        var parts = Object.keys(s.by_status).sort().map(function (k) { return s.by_status[k] + ' ' + k; });
        return (s.capped ? '≥' : '') + s.total + ' runs in 7 days (' + parts.join(', ') + ')';
    }

    // VTID-05148: the three L3 numbers from the latest learn-outcomes run.
    function pctText(v) {
        return (v === null || v === undefined) ? 'n/a' : (Math.round(v * 1000) / 10) + '%';
    }

    // VTID-05153: the L9 numbers from the latest supplier-catalog-check run.
    function l9MetricsText(x) {
        var st = x.by_state || {};
        var returned = st.returned_to_supplier || 0;
        return 'Ready for approval ' + pctText(x.ready_for_approval_share) +
            ' (target ' + pctText(x.ready_for_approval_target) + ')' +
            ' · Failure rate ' + pctText(x.validation_failure_rate) + ' of ' + (x.rows_checked || 0) + ' checked' +
            ' · Auto-normalized ' + (x.rows_auto_normalized || 0) +
            ' · Returned to supplier ' + returned;
    }

    function metricsText(loop, metricsLatest) {
        var m = metricsLatest && metricsLatest[loop.id];
        if (!m) return null;
        if (m.state === 'no_run_yet') return 'Metrics: no ' + m.routine + ' run yet';
        if (m.state !== 'ok') return 'Metrics unavailable';
        var x = m.metrics || {};
        if (loop.id === 'L9') return l9MetricsText(x);
        var rf = x.repeat_failure || {};
        var pr = x.pattern_reuse || {};
        var et = x.escaped_bugs_to_tests || {};
        var reuse = pr.state === 'measured' ? pctText(pr.share) + ' (' + pr.reused + '/' + pr.fixes + ')' : 'not measured';
        return 'Repeat-failure ' + pctText(rf.rate) + ' (' + (rf.repeated || 0) + '/' + (rf.fixes || 0) + ' fixes)' +
            ' · Pattern reuse ' + reuse +
            ' · Escaped bugs → tests ' + pctText(et.share) + ' (' + (et.with_tests || 0) + '/' +
            ((et.with_tests || 0) + (et.without_tests || 0)) + ', ' + (et.unknown || 0) + ' unknown)';
    }

    function sensorCount(loop) {
        var n = 0;
        Object.keys(SENSOR_LINKS).forEach(function (k) { n += (loop.sensors[k] || []).length; });
        return n;
    }

    function badge(text, kind) {
        return h('span', 'loops-badge loops-badge--' + String(kind).toLowerCase(), text);
    }

    function renderHeader(box) {
        box.appendChild(h('h2', 'loops-title', 'Loops'));
        box.appendChild(h('p', 'section-subtitle',
            'Loop engineering: few loops, one shared engine, every check owned by exactly one loop.'));
        var layers = h('div', 'loops-layers');
        [['Sensors', 'Tests, health checks, routines, alert workflows. They only say green or red, and stay on their own screens.'],
         ['Loops', 'Close the cycle: sense → act → verify with the same sensor → learn.'],
         ['Shared engine', 'One intake, one executor, one run ledger, one human inbox, shared verifiers.']]
            .forEach(function (l) {
                var c = h('div', 'loops-layer');
                c.appendChild(h('strong', null, l[0]));
                c.appendChild(h('span', null, l[1]));
                layers.appendChild(c);
            });
        box.appendChild(layers);
    }

    function renderKpis(box, d) {
        var row = h('div', 'loops-kpis');
        var t = d.totals;
        var live = d.coverage.live;
        var orphans = live.health_groups.orphans.length + live.test_contracts.orphans.length;
        [['Loops', t.loops], ['Live', t.by_status.LIVE || 0], ['Partial', t.by_status.PARTIAL || 0],
         ['Planned', t.by_status.PLANNED || 0], ['Cases folded in', t.cases], ['Orphan sensors', orphans]]
            .forEach(function (k) {
                var tile = h('div', 'loops-kpi');
                tile.appendChild(h('div', 'loops-kpi-value', k[1]));
                tile.appendChild(h('div', 'loops-kpi-label', k[0]));
                row.appendChild(tile);
            });
        box.appendChild(row);
    }

    function renderCard(loop, signals, metricsLatest) {
        var card = h('button', 'loops-card' + (st.selected === loop.id ? ' is-selected' : ''));
        card.type = 'button';
        card.setAttribute('aria-expanded', st.selected === loop.id ? 'true' : 'false');
        card.setAttribute('aria-controls', 'loops-detail');
        card.setAttribute('aria-label', loop.id + ' ' + loop.name + ', ' + loop.status + ', risk ' + loop.risk);
        card.setAttribute('data-loop', loop.id);
        var top = h('div', 'loops-card-top');
        top.appendChild(h('span', 'loops-card-id', loop.id));
        top.appendChild(h('span', 'loops-card-name', loop.name));
        top.appendChild(badge(loop.status, loop.status));
        card.appendChild(top);
        var meta = h('div', 'loops-card-meta');
        meta.appendChild(badge('Risk ' + loop.risk, loop.risk));
        meta.appendChild(badge('Autonomy ' + loop.autonomy, 'autonomy'));
        meta.appendChild(h('span', null, sensorCount(loop) + ' sensors · ' + loop.cases.length + ' cases'));
        card.appendChild(meta);
        if (loop.gap) card.appendChild(h('div', 'loops-card-gap', loop.gap));
        card.appendChild(h('div', 'loops-card-signal', signalText(loop, signals)));
        var metrics = metricsText(loop, metricsLatest);
        if (metrics) card.appendChild(h('div', 'loops-card-signal loops-card-metrics', metrics));
        card.addEventListener('click', function () {
            st.selected = st.selected === loop.id ? null : loop.id;
            paint();
        });
        return card;
    }

    function renderDetail(loop) {
        var box = h('section', 'loops-detail');
        box.id = 'loops-detail';
        box.setAttribute('aria-label', 'Loop ' + loop.id + ' details');
        box.appendChild(h('h3', null, loop.id + ' — ' + loop.name));
        var dl = h('dl', 'loops-contract');
        CONTRACT.forEach(function (f) {
            dl.appendChild(h('dt', null, f[1]));
            dl.appendChild(h('dd', null, loop[f[0]]));
        });
        if (loop.uses_shared_verifiers && loop.uses_shared_verifiers.length) {
            dl.appendChild(h('dt', null, 'Shared verifiers'));
            dl.appendChild(h('dd', null, loop.uses_shared_verifiers.join(', ')));
        }
        if (loop.existing_ref) {
            dl.appendChild(h('dt', null, 'Runs today in'));
            dl.appendChild(h('dd', 'loops-mono', loop.existing_ref.ref));
        }
        box.appendChild(dl);

        box.appendChild(h('h4', null, 'Sensors this loop owns'));
        var any = false;
        Object.keys(SENSOR_LINKS).forEach(function (k) {
            var list = loop.sensors[k] || [];
            if (!list.length) return;
            any = true;
            var row = h('div', 'loops-sensors');
            var info = SENSOR_LINKS[k];
            if (info.href) {
                var a = h('a', 'loops-sensor-link', info.label);
                a.href = info.href;
                row.appendChild(a);
            } else {
                row.appendChild(h('strong', null, info.label + ' (header Service Health)'));
            }
            row.appendChild(h('span', 'loops-mono', list.join(' · ')));
            box.appendChild(row);
        });
        if (!any) box.appendChild(h('p', 'loops-muted', 'No scheduled sensor yet — this loop is driven by events.'));

        box.appendChild(h('h4', null, 'Cases folded in'));
        var ul = h('ul', 'loops-cases');
        loop.cases.forEach(function (c) { ul.appendChild(h('li', null, c.id + ' — ' + c.title)); });
        box.appendChild(ul);
        return box;
    }

    function renderEngine(box, d) {
        box.appendChild(h('h3', 'loops-section-title', 'Shared engine — one of each'));
        var grid = h('div', 'loops-engine');
        d.catalog.components.forEach(function (c) {
            var tile = h('div', 'loops-engine-item');
            tile.appendChild(h('strong', null, c.name));
            tile.appendChild(h('span', null, c.what));
            tile.appendChild(h('span', 'loops-mono', c.existing_ref ? c.existing_ref.ref : 'planned'));
            grid.appendChild(tile);
        });
        box.appendChild(grid);
    }

    function renderSimplification(box, d) {
        var sec = h('section', 'loops-simplify');
        sec.setAttribute('aria-label', 'Simplification');
        sec.appendChild(h('h3', 'loops-section-title', 'Simplification'));
        sec.appendChild(h('p', 'loops-muted',
            'Every sensor must be owned by exactly one loop or be marked to retire. CI fails otherwise.'));
        var cov = h('div', 'loops-coverage');
        var live = d.coverage.live;
        [['Service Health groups', live.health_groups], ['Test contracts', live.test_contracts]].forEach(function (p) {
            var c = p[1];
            var line = p[0] + ': ' + c.owned + '/' + c.total + ' owned';
            if (c.orphans.length) line += ' · orphans: ' + c.orphans.join(', ');
            if (c.double_owned.length) line += ' · owned twice: ' + c.double_owned.join(', ');
            if (c.unknown.length) line += ' · unknown: ' + c.unknown.join(', ');
            cov.appendChild(h('div', null, line));
        });
        cov.appendChild(h('div', null, 'Routines: ' + d.coverage.ci_enforced.routines.owned +
            ' owned · Scheduled workflows: ' + d.coverage.ci_enforced.workflows.owned + ' owned (checked in CI)'));
        cov.appendChild(h('div', null, 'Retire candidates: ' + d.coverage.retire_candidates));
        sec.appendChild(cov);
        sec.appendChild(h('h4', null, 'Known overlaps (Simplify loop backlog)'));
        var ol = h('ol', 'loops-overlaps');
        d.catalog.overlaps.forEach(function (o) {
            var li = h('li', null);
            li.setAttribute('data-overlap', o.id);
            li.appendChild(h('strong', null, o.title));
            // VTID-05098: what the Simplify loop did with it.
            if (o.status) li.appendChild(badge(OVERLAP_LABELS[o.status] || o.status, 'overlap-' + o.status));
            li.appendChild(h('span', 'loops-mono', ' — ' + o.items.join(' · ')));
            if (o.resolution) li.appendChild(h('div', 'loops-overlap-resolution', o.resolution));
            ol.appendChild(li);
        });
        sec.appendChild(ol);
        box.appendChild(sec);
    }

    function paint() {
        var box = st.el;
        if (!box) return;
        while (box.firstChild) box.removeChild(box.firstChild);
        renderHeader(box);
        if (st.error) {
            box.appendChild(h('div', 'loops-error', 'Could not load loops: ' + st.error));
            var retry = h('button', 'task-spec-pipeline-btn', 'Retry');
            retry.type = 'button';
            retry.addEventListener('click', function () { st.error = null; load(); paint(); });
            box.appendChild(retry);
            return;
        }
        if (!st.data) {
            box.appendChild(h('div', 'loops-muted', 'Loading loops…'));
            return;
        }
        var d = st.data;
        renderKpis(box, d);
        var selected = null;
        GROUPS.forEach(function (g) {
            box.appendChild(h('h3', 'loops-section-title', g[1]));
            var grid = h('div', 'loops-grid');
            d.catalog.loops.filter(function (l) { return l.group === g[0]; }).forEach(function (l) {
                grid.appendChild(renderCard(l, d.signals, d.metrics_latest));
                if (l.id === st.selected) selected = l;
            });
            box.appendChild(grid);
            if (selected && selected.group === g[0]) box.appendChild(renderDetail(selected));
        });
        renderEngine(box, d);
        renderSimplification(box, d);
    }

    /**
     * Returns the view's root element. opts.headers(extra) supplies the
     * Command Hub auth headers (app.js buildContextHeaders); opts.doc and
     * opts.fetch default to the browser's and exist for tests.
     */
    function render(opts) {
        st.getHeaders = opts && opts.headers;
        st.doc = (opts && opts.doc) || null;
        st.fetch = (opts && opts.fetch) || null;
        st.el = h('div', 'loops-view');
        if (!st.data && !st.error) load();
        paint();
        return st.el;
    }

    function reset() {
        st.data = null; st.error = null; st.loading = false; st.selected = null; st.el = null; st.doc = null; st.fetch = null;
    }

    root.LoopsCatalog = {
        render: render,
        reset: reset,
        // Exposed for tests.
        _internals: { signalText: signalText, sensorCount: sensorCount, metricsText: metricsText, state: st }
    };
})(typeof window !== 'undefined' ? window : this);
