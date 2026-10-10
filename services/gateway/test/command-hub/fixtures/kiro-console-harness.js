/* VTID-05067: local visual harness for kiro-console.js (Playwright screenshots).
 * Scenario by URL hash:
 *   #a  a thread with 2 past runs + a live running run with steps and an open approval card
 *   #b  a queued message (with Cancel) and a pasted-image chip row in the composer
 *   #c  an interrupted run with Continue, a refused run, and "Kiro can't see images"
 * Every gateway call is answered here; no network. */
(function () {
    'use strict';
    var THREAD = 'a5067000-0000-4000-8000-000000000001';
    var scenario = (location.hash || '#a').slice(1);
    var enc = new TextEncoder();

    function swatch(color, label) {
        var c = document.createElement('canvas');
        c.width = 160; c.height = 100;
        var g = c.getContext('2d');
        g.fillStyle = '#0f172a'; g.fillRect(0, 0, 160, 100);
        g.fillStyle = color; g.fillRect(10, 10, 140, 26);
        g.fillStyle = '#334155'; g.fillRect(10, 46, 90, 12); g.fillRect(10, 64, 120, 12);
        g.fillStyle = '#f8fafc'; g.font = '12px sans-serif'; g.fillText(label, 16, 28);
        return c.toDataURL('image/png');
    }
    var SHOT1 = swatch('#3b82f6', 'Settings');
    var SHOT2 = swatch('#f59e0b', 'Upload');

    function row(o) {
        return Object.assign({ thread_id: THREAD, user_id: 'u1', reply: null, stop_reason: null, kiro_model: null, workspace: null, error: null, attachments: null }, o);
    }
    var t0 = Date.parse('2026-10-11T08:00:00Z');
    function at(min) { return new Date(t0 + min * 60000).toISOString(); }

    var RUNS = {
        a: [
            row({ id: 'r1', status: 'completed', created_at: at(0), message: 'Why does the upload endpoint accept any file size? Here is the screen.',
                reply: 'The stub at **POST /api/v1/operator/upload** only mints an `OASIS-FILE` reference — it stores no bytes and has no size limit. I added a 5 MB limit check in my workspace; nothing is pushed yet.',
                kiro_model: 'claude-sonnet-4.5', attachments: [{ media_id: 'm1', mime_type: 'image/png' }] }),
            row({ id: 'r2', status: 'completed', created_at: at(6), message: 'Run the gateway tests for that file.', reply: 'All 42 tests in `operator-upload.test.ts` pass.', kiro_model: 'claude-sonnet-4.5' }),
            row({ id: 'r3', status: 'waiting_permission', created_at: at(12), message: 'Push the change on a branch so I can review it.' })
        ],
        b: [
            row({ id: 'r1', status: 'completed', created_at: at(0), message: 'Check the Settings page layout on mobile.', reply: 'The toggle row overflows at 390 px; the label needs `min-width: 0`.', kiro_model: 'claude-sonnet-4.5' }),
            row({ id: 'r3', status: 'running', created_at: at(8), message: 'Fix it and show me the diff.' }),
            row({ id: 'r4', status: 'queued', created_at: at(9), message: 'Then also check the Upload screen — screenshots attached.' })
        ],
        c: [
            row({ id: 'r1', status: 'refused', created_at: at(0), stop_reason: 'refusal', message: 'Delete the production database backups.', reply: 'I won\'t delete production backups. If you want to free space, I can list the oldest snapshots for you to review.' }),
            row({ id: 'r2', status: 'completed', created_at: at(4), message: 'What is wrong on this screen?', reply: 'I can only read your text: this kiro-cli version does not accept images. Describe what you see and I will look in the code.', kiro_model: 'claude-sonnet-4.5', attachments: [{ media_id: 'm2', mime_type: 'image/png' }] }),
            row({ id: 'r3', status: 'interrupted', created_at: at(9), error: 'gateway_shutdown', message: 'Refactor the media route into its own service and add tests.' })
        ]
    };

    function frame(seq, event, data) { return 'id: ' + seq + '\nevent: ' + event + '\ndata: ' + JSON.stringify(Object.assign({ seq: seq }, data)) + '\n\n'; }

    var EVENTS = {
        r1: [
            frame(1, 'run.status', { status: 'running' }),
            frame(2, 'kiro.images', { count: 1, delivery: scenario === 'c' ? 'unsupported' : 'sent', sent: scenario === 'c' ? 0 : 1 }),
            frame(3, 'kiro.tool_call', { tool_call_id: 't1', title: 'Running: @vitana/dev_read_file', kind: 'other', status: 'completed' }),
            frame(4, 'run.status', { status: 'completed' })
        ],
        r2: [
            frame(1, 'run.status', { status: 'running' }),
            frame(2, 'kiro.images', { count: 1, delivery: scenario === 'c' ? 'unsupported' : 'sent', sent: 0 }),
            frame(3, 'run.status', { status: 'completed' })
        ],
        // the live run of scenario a
        r3a: [
            frame(1, 'run.status', { status: 'running' }),
            frame(2, 'kiro.tool_call', { tool_call_id: 't1', title: 'git status', kind: 'execute', status: 'completed' }),
            frame(3, 'kiro.tool_call', { tool_call_id: 't2', title: 'Running: @vitana/dev_search_codebase', kind: 'other', status: 'completed' }),
            frame(4, 'kiro.tool_call', { tool_call_id: 't3', title: 'Edit services/gateway/src/routes/operator.ts', kind: 'edit', status: 'pending' }),
            frame(5, 'kiro.message_chunk', { text: 'The size check is in place. To push it I need your OK for the branch push:' }),
            frame(6, 'kiro.permission_request', { request_id: 'q1', tool_call_id: 't4', title: 'Running: @vitana/dev_push_kiro_branch', kind: 'other', expires_at: at(14) }),
            frame(7, 'run.status', { status: 'waiting_permission' })
        ],
        r3b: [
            frame(1, 'run.status', { status: 'running' }),
            frame(2, 'kiro.tool_call', { tool_call_id: 't1', title: 'Read src/pages/Settings.tsx', kind: 'read', status: 'completed' }),
            frame(3, 'kiro.tool_call', { tool_call_id: 't2', title: 'Edit src/pages/Settings.tsx', kind: 'edit', status: 'pending' }),
            frame(4, 'kiro.message_chunk', { text: 'Adding min-width: 0 to the label column…' })
        ],
        r3c: [
            frame(1, 'run.status', { status: 'running' }),
            frame(2, 'kiro.tool_call', { tool_call_id: 't1', title: 'Read services/gateway/src/routes/operator.ts', kind: 'read', status: 'completed' }),
            frame(3, 'kiro.message_chunk', { text: 'Moving the upload handler into services/operator-media.ts' }),
            frame(4, 'run.status', { status: 'interrupted' })
        ],
        r4: [frame(1, 'run.status', { status: 'queued' })]
    };

    function streamResponse(frames, keepOpen) {
        var body = new ReadableStream({
            start: function (ctl) {
                frames.forEach(function (f) { ctl.enqueue(enc.encode(f)); });
                if (!keepOpen) ctl.close();
            }
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    function json(status, body) { return Promise.resolve(new Response(JSON.stringify(body), { status: status, headers: { 'Content-Type': 'application/json' } })); }

    function fakeFetch(url, init) {
        var method = (init && init.method) || 'GET';
        var path = url.split('?')[0];
        if (method === 'GET' && path === '/api/v1/operator/kiro/runs') return json(200, { ok: true, runs: RUNS[scenario].slice().reverse() });
        var m = /^\/api\/v1\/operator\/kiro\/runs\/([^/]+)\/stream$/.exec(path);
        if (m) {
            var id = m[1];
            var key = id === 'r3' ? 'r3' + scenario : id;
            var live = (scenario === 'a' && id === 'r3') || (scenario === 'b' && (id === 'r3' || id === 'r4'));
            return Promise.resolve(streamResponse(EVENTS[key] || [], live));
        }
        var media = /^\/api\/v1\/operator\/media\/(.+)$/.exec(path);
        if (media) return json(200, { ok: true, media_id: media[1], url: media[1] === 'm1' ? SHOT1 : SHOT2 });
        if (path === '/api/v1/operator/kiro/confirmations') return json(200, { ok: true, pending: [] });
        return json(404, { ok: false, error: 'harness_no_route' });
    }

    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

    function frameUi() {
        var root = document.getElementById('root');
        var frameEl = el('div', 'harness-frame');
        var layout = el('div', 'operator-chat-layout');
        var side = el('div', 'chat-sessions-sidebar');
        var head = el('div', 'chat-sessions-sidebar-header');
        head.appendChild(el('button', 'chat-sessions-new-btn', '+ New chat'));
        side.appendChild(head);
        var list = el('div', 'chat-sessions-list');
        var title = scenario === 'b' ? 'Settings layout' : scenario === 'c' ? 'Media route refactor' : 'Upload size limit';
        [[title, true], ['Weekly digest copy', false], ['Partner onboarding copy', false]].forEach(function (r, i) {
            var rowEl = el('div', 'chat-session-row' + (i === 0 ? ' chat-session-row--active' : ''));
            var info = el('div', 'chat-session-row-info');
            info.appendChild(el('div', 'chat-session-row-title', r[0]));
            var meta = el('div', 'chat-session-row-meta', i === 0 ? 'just now' : (i * 2) + 'h ago');
            if (r[1] && window.KiroConsole.isThreadBusy(THREAD)) { var sp = el('span', 'chat-thread-running'); sp.setAttribute('role', 'status'); sp.setAttribute('aria-label', 'Turn running'); meta.appendChild(sp); }
            meta.appendChild(el('span', 'chat-engine-tag', 'Kiro'));
            info.appendChild(meta);
            rowEl.appendChild(info);
            list.appendChild(rowEl);
        });
        side.appendChild(list);
        layout.appendChild(side);

        var chat = el('div', 'chat-container');
        var bar = el('div', 'chat-session-title-bar');
        bar.appendChild(el('div', 'chat-session-title-bar-text', scenario === 'b' ? 'Settings layout' : scenario === 'c' ? 'Media route refactor' : 'Upload size limit'));
        var fixed = el('div', 'chat-engine-fixed');
        fixed.appendChild(el('span', 'chat-engine-badge', 'Kiro'));
        var sel = el('select', 'chat-kiro-model-select');
        sel.setAttribute('aria-label', 'Kiro model');
        var opt = el('option', '', 'Claude Sonnet 4.5');
        sel.appendChild(opt);
        fixed.appendChild(sel);
        bar.appendChild(fixed);
        bar.appendChild(el('button', 'chat-new-thread-btn', '+ New'));
        chat.appendChild(bar);
        chat.appendChild(window.KiroConsole.renderPane(THREAD, { legacyMessages: [] }));
        layout.appendChild(chat);
        frameEl.appendChild(layout);
        root.innerHTML = '';
        root.appendChild(frameEl);
    }

    var draft = scenario === 'b' ? 'Also compare with the old design.' : '';
    window.KiroConsole.init({
        fetch: fakeFetch,
        headers: function (x) { return x || {}; },
        renderApp: function () { frameUi(); },
        activeThreadId: function () { return THREAD; },
        getDraft: function () { return draft; },
        setDraft: function (v) { draft = v; },
        renderMarkdown: function (md) {
            var d = document.createElement('div');
            String(md).split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach(function (part) {
                if (/^\*\*.+\*\*$/.test(part)) d.appendChild(el('strong', '', part.slice(2, -2)));
                else if (/^`.+`$/.test(part)) d.appendChild(el('code', '', part.slice(1, -1)));
                else d.appendChild(document.createTextNode(part));
            });
            return d;
        },
        kiroModelName: function () { return 'Claude Sonnet 4.5'; },
        stickToBottom: function () { return true; }
    });
    frameUi();

    if (scenario === 'b') {
        var tray = window.KiroConsole.imageTray(THREAD);
        Promise.all([SHOT1, SHOT2].map(function (u, i) {
            return fetch(u).then(function (r) { return r.blob(); }).then(function (b) { return new File([b], i ? 'upload-old.png' : 'upload-new.png', { type: 'image/png' }); });
        })).then(function (files) { tray.addFiles(files); });
    }
    // Open the first past run's steps in scenario a (shows tool lines + an answered card).
    window.__harnessReady = new Promise(function (r) { setTimeout(r, 600); });
})();
