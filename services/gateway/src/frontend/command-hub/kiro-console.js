/**
 * VTID-05067 — the Kiro console (Phase 2 of the sparred "Kiro on one server-side run
 * record" plan, docs/validation/VTID-05065/plan-sparring.md + the VTID-05067 addendum).
 *
 * One owner of the Kiro view in the Command Hub Operator Console. app.js keeps the
 * thread list, the engine switch, the model picker and the Operator (LLM) path, and
 * hands the chat pane of a Kiro thread to this module (window.KiroConsole.renderPane).
 *
 * A Kiro thread is shown as its server-side RUNS (GET /api/v1/operator/kiro/runs):
 *   - past runs: the message, its images, Kiro's reply, a collapsible step list (tool
 *     calls with their status, approval cards with their answer) and how the run ended
 *     (stopped early, failed, stopped, interrupted with Continue);
 *   - the current run, live from GET /runs/:id/stream?after_seq=<last seen seq>. A
 *     reload, a thread switch or a second tab just lists the runs again and reattaches
 *     from the last seq it has; a dropped stream reconnects with backoff.
 * The composer stays enabled: Send while a run runs queues the message (POST /runs →
 * queued, shown with Cancel; 409 queue_full is shown inline). Stop cancels the current
 * run (POST /runs/:id/cancel).
 *
 * Images: Ctrl/Cmd+V of an image, drag-and-drop and the paperclip add thumbnail chips
 * (remove ✕); they are uploaded on Send through POST /api/v1/operator/media and the
 * run (or the Operator chat turn, through the same helper used by app.js) carries their
 * media ids. Text paste is untouched. Images in history are shown through 1-hour
 * signed URLs fetched per view, kept in memory only (never localStorage).
 *
 * CSP: external file, no inline script or style, no CDN. Admin console text, English
 * by design (same as the other Kiro strings).
 */
(function (root) {
    'use strict';

    var document = root.document;
    var RUNS_API = '/api/v1/operator/kiro/runs';
    var MEDIA_API = '/api/v1/operator/media';
    var ACTIVE = { queued: true, running: true, waiting_permission: true };
    var TOOL_STATUS = { completed: 'ok', failed: 'failed' };
    var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    var LIMITS = {
        imageBytes: 5 * 1024 * 1024,
        imagesPerMessage: 4,
        reconnectBaseMs: 1000,
        reconnectMaxMs: 15000,
        listRefreshMs: 10000,
        confirmPollMs: 2000,
        renderDelayMs: 40,
        mediaUrlTtlMs: 50 * 60 * 1000
    };
    // What "Continue" sends after an interrupted run (the developer's own short message to Kiro).
    var CONTINUE_MESSAGE = 'Continue where you left off.';
    var FALLBACK_ERRORS = { no_credits: true, not_connected: true };

    // ---------------------------------------------------------------------
    // Host (app.js) — everything the module needs from the page, injectable for tests
    // ---------------------------------------------------------------------
    var host = {
        fetch: function (url, init) { return root.fetch(url, init); },
        headers: function (extra) { return extra || {}; },
        renderApp: function () {},
        activeThreadId: function () { return null; },
        getDraft: function () { return ''; },
        setDraft: function () {},
        renderMarkdown: null,
        renderEmptyPanel: null,
        renderLegacyMessage: null,
        renderMic: null,
        bindMessagesScroll: null,
        stickToBottom: function () { return true; },
        onSent: function () {},
        onRunFinished: function () {},
        continueInOperator: null,
        kiroModelName: function (id) { return id; },
        toast: function () {},
        now: function () { return Date.now(); },
        setTimeout: function (fn, ms) { return root.setTimeout(fn, ms); },
        clearTimeout: function (t) { root.clearTimeout(t); },
        createObjectURL: function (file) { return root.URL && root.URL.createObjectURL ? root.URL.createObjectURL(file) : ''; },
        revokeObjectURL: function (url) { if (url && root.URL && root.URL.revokeObjectURL) root.URL.revokeObjectURL(url); }
    };

    function init(api) {
        Object.keys(api || {}).forEach(function (k) { host[k] = api[k]; });
    }

    // ---------------------------------------------------------------------
    // Small DOM helpers
    // ---------------------------------------------------------------------
    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined && text !== null) e.textContent = String(text);
        return e;
    }

    function button(className, text, onClick, label) {
        var b = el('button', className, text);
        b.type = 'button';
        if (label) b.setAttribute('aria-label', label);
        b.onclick = onClick;
        return b;
    }

    function replaceNode(oldNode, newNode) {
        if (!oldNode || !oldNode.parentNode) return false;
        oldNode.parentNode.replaceChild(newNode, oldNode);
        return true;
    }

    function isTerminal(status) {
        return typeof status === 'string' && !ACTIVE[status];
    }

    // ---------------------------------------------------------------------
    // SSE parsing (fetch body; EventSource cannot send the Authorization header)
    // ---------------------------------------------------------------------
    function parseSse(buffer) {
        var frames = [];
        var parts = buffer.split('\n\n');
        var rest = parts.pop();
        parts.forEach(function (block) {
            var f = { id: null, event: 'message', data: null };
            var dataLines = [];
            block.split('\n').forEach(function (line) {
                if (line.indexOf(':') === 0) return; // heartbeat / comment
                if (line.indexOf('id:') === 0) f.id = Number(line.slice(3).trim());
                else if (line.indexOf('event:') === 0) f.event = line.slice(6).trim();
                else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
            });
            if (dataLines.length === 0) return;
            try { f.data = JSON.parse(dataLines.join('\n')); } catch (e) { f.data = { raw: dataLines.join('\n') }; }
            frames.push(f);
        });
        return { frames: frames, rest: rest };
    }

    // ---------------------------------------------------------------------
    // A run's events folded into what the view shows (pure)
    // ---------------------------------------------------------------------
    function foldRun(events) {
        var v = { text: '', steps: [], status: null, stopReason: null, error: null, images: null };
        var tools = {};
        var perms = {};
        (events || []).forEach(function (ev) {
            var d = ev.data || {};
            switch (ev.type) {
                case 'kiro.message_chunk':
                    v.text += d.text || '';
                    break;
                case 'kiro.tool_call': {
                    var step = { kind: 'tool', id: d.tool_call_id, title: d.title || d.kind || 'Tool', toolKind: d.kind, status: TOOL_STATUS[d.status] || 'running' };
                    if (d.tool_call_id) tools[d.tool_call_id] = step;
                    v.steps.push(step);
                    break;
                }
                case 'kiro.tool_update': {
                    var t = tools[d.tool_call_id];
                    if (t) {
                        t.status = TOOL_STATUS[d.status] || t.status;
                        if (d.title) t.title = d.title;
                    }
                    break;
                }
                case 'kiro.permission_request': {
                    var p = { kind: 'permission', id: d.request_id, title: d.title || 'A tool', permKind: d.kind, expires_at: d.expires_at, answer: null };
                    perms[d.request_id] = p;
                    v.steps.push(p);
                    break;
                }
                case 'kiro.permission_answer': {
                    var q = perms[d.request_id];
                    if (q) q.answer = d.allow ? 'allowed' : (d.by === 'timeout' ? 'expired' : 'denied');
                    break;
                }
                case 'kiro.images':
                    v.images = { count: d.count || 0, delivery: d.delivery, sent: d.sent || 0 };
                    break;
                case 'kiro.turn_end':
                    if (d.stop_reason) v.stopReason = d.stop_reason;
                    break;
                case 'run.status':
                    v.status = d.status || v.status;
                    if (d.stop_reason) v.stopReason = d.stop_reason;
                    if (d.error) v.error = d.error;
                    break;
                default:
                    break;
            }
        });
        return v;
    }

    // ---------------------------------------------------------------------
    // State: threads → runs
    // ---------------------------------------------------------------------
    var threads = {};

    function threadState(threadId) {
        if (!threads[threadId]) {
            threads[threadId] = {
                id: threadId, loaded: false, loading: null, error: null, notice: null, sending: false,
                runs: [], byId: {}, confirmations: [], confirmTimer: null, listTimer: null,
                renderTimer: null, wasBusy: false, mounted: { runs: null, extras: null, messages: null }
            };
        }
        return threads[threadId];
    }

    function runStatus(r) {
        var folded = r.view ? r.view.status : null;
        if (folded && (isTerminal(folded) || !isTerminal(r.row.status))) return folded;
        return r.row.status;
    }

    function upsertRun(t, row) {
        var r = t.byId[row.id];
        if (!r) {
            r = { row: row, events: [], lastSeq: 0, eventsLoaded: false, loadingEvents: false, follow: null, answers: {}, expanded: false, reconnecting: false, view: null };
            t.byId[row.id] = r;
            t.runs.push(r);
            t.runs.sort(function (a, b) { return String(a.row.created_at || '').localeCompare(String(b.row.created_at || '')); });
        } else {
            var keepTerminal = isTerminal(runStatus(r)) && !isTerminal(row.status);
            var merged = Object.assign({}, r.row, row);
            if (keepTerminal) merged.status = runStatus(r);
            r.row = merged;
        }
        r.view = foldRun(r.events);
        return r;
    }

    function activeRun(t) {
        for (var i = t.runs.length - 1; i >= 0; i--) {
            var s = runStatus(t.runs[i]);
            if (s === 'running' || s === 'waiting_permission') return t.runs[i];
        }
        return null;
    }

    function isThreadBusy(threadId) {
        var t = threads[threadId];
        if (!t) return false;
        return t.runs.some(function (r) { return !!ACTIVE[runStatus(r)]; });
    }

    function hasRuns(threadId) {
        var t = threads[threadId];
        return !!(t && t.runs.length > 0);
    }

    // ---------------------------------------------------------------------
    // Loading the thread's runs
    // ---------------------------------------------------------------------
    function loadThread(threadId) {
        var t = threadState(threadId);
        if (t.loading) return t.loading;
        t.loading = host.fetch(RUNS_API + '?thread_id=' + encodeURIComponent(threadId), { headers: host.headers({}) })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (body) {
                    if (!res.ok) {
                        t.error = res.status === 503 ? 'Kiro runs are unavailable right now.' : 'Could not load Kiro runs (' + res.status + ').';
                        return;
                    }
                    t.error = null;
                    (body.runs || []).forEach(function (row) { upsertRun(t, row); });
                });
            })
            .catch(function () { t.error = 'Could not reach the gateway for Kiro runs.'; })
            .then(function () {
                t.loaded = true;
                t.loading = null;
                t.runs.forEach(function (r) {
                    if (ACTIVE[runStatus(r)]) follow(t, r);
                    // Images (and how Kiro took them) show without opening the steps.
                    else if (r.row.attachments && r.row.attachments.length && !r.eventsLoaded) loadEvents(t, r);
                });
                scheduleListRefresh(t);
                updateConfirmationPoll(t);
                refresh(t);
            });
        return t.loading;
    }

    function scheduleListRefresh(t) {
        if (t.listTimer) { host.clearTimeout(t.listTimer); t.listTimer = null; }
        if (!isThreadBusy(t.id) || host.activeThreadId() !== t.id) return;
        t.listTimer = host.setTimeout(function () { t.listTimer = null; loadThread(t.id); }, LIMITS.listRefreshMs);
    }

    function reloadRun(t, r) {
        return host.fetch(RUNS_API + '/' + encodeURIComponent(r.row.id), { headers: host.headers({}) })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (body) { if (body && body.run) upsertRun(t, body.run); })
            .catch(function () { /* the next list refresh catches up */ });
    }

    // ---------------------------------------------------------------------
    // Following a run: replay after the last seen seq, then live; reconnect with backoff
    // ---------------------------------------------------------------------
    function applyFrame(t, r, frame) {
        var seq = typeof frame.id === 'number' && !isNaN(frame.id) ? frame.id : (frame.data && frame.data.seq);
        var data = frame.data || {};
        if (frame.event === 'error') return;
        if (typeof seq === 'number' && seq <= r.lastSeq) {
            // The server's "ended without a stored terminal event" frame reuses the last seq.
            if (frame.event === 'run.status' && isTerminal(data.status)) r.row = Object.assign({}, r.row, { status: data.status });
            return;
        }
        if (typeof seq === 'number') r.lastSeq = seq;
        r.events.push({ seq: seq, type: frame.event, data: data });
        if (frame.event === 'run.status' && data.status) r.row = Object.assign({}, r.row, { status: data.status });
        r.view = foldRun(r.events);
    }

    function readStream(t, r, res, onFrame) {
        if (!res.body || !res.body.getReader) return Promise.reject(new Error('no stream'));
        var reader = res.body.getReader();
        var decoder = new root.TextDecoder();
        var buffer = '';
        function pump() {
            return reader.read().then(function (chunk) {
                if (chunk.done) return;
                buffer += decoder.decode(chunk.value, { stream: true });
                var parsed = parseSse(buffer);
                buffer = parsed.rest;
                parsed.frames.forEach(onFrame);
                return pump();
            });
        }
        return pump();
    }

    function follow(t, r) {
        if (r.follow || isTerminal(runStatus(r))) return;
        var f = r.follow = { attempt: 0, timer: null, abort: null, stopped: false };
        function done() {
            f.stopped = true;
            r.follow = null;
            r.reconnecting = false;
            r.eventsLoaded = true;
            reloadRun(t, r).then(function () {
                host.onRunFinished(t.id, r.row);
                updateConfirmationPoll(t);
                refresh(t);
                loadThread(t.id);
            });
        }
        function retry() {
            if (f.stopped) return;
            r.reconnecting = true;
            refresh(t);
            var delay = Math.min(LIMITS.reconnectMaxMs, LIMITS.reconnectBaseMs * Math.pow(2, f.attempt));
            f.attempt += 1;
            f.timer = host.setTimeout(function () { f.timer = null; connect(); }, delay);
        }
        function connect() {
            if (f.stopped) return;
            var ctl = root.AbortController ? new root.AbortController() : null;
            f.abort = ctl;
            var url = RUNS_API + '/' + encodeURIComponent(r.row.id) + '/stream?after_seq=' + r.lastSeq;
            host.fetch(url, { headers: host.headers({ Accept: 'text/event-stream' }), signal: ctl ? ctl.signal : undefined })
                .then(function (res) {
                    if (res.status === 400 || res.status === 403 || res.status === 404) {
                        f.stopped = true;
                        r.follow = null;
                        r.reconnecting = false;
                        refresh(t);
                        return 'gone';
                    }
                    if (!res.ok) throw new Error('stream ' + res.status);
                    return readStream(t, r, res, function (frame) {
                        f.attempt = 0;
                        if (r.reconnecting) r.reconnecting = false;
                        applyFrame(t, r, frame);
                        if (frame.event === 'kiro.permission_request' || frame.event === 'run.status') updateConfirmationPoll(t);
                        scheduleRender(t);
                    });
                })
                .then(function (outcome) {
                    if (outcome === 'gone' || f.stopped) return;
                    if (isTerminal(runStatus(r))) done();
                    else retry();
                })
                .catch(function () { if (!f.stopped) retry(); });
        }
        connect();
    }

    function stopFollowing(r) {
        if (!r.follow) return;
        r.follow.stopped = true;
        if (r.follow.timer) host.clearTimeout(r.follow.timer);
        if (r.follow.abort) { try { r.follow.abort.abort(); } catch (e) { /* ignore */ } }
        r.follow = null;
    }

    /** A finished run's steps, replayed once from the store (on opening the step list). */
    function loadEvents(t, r) {
        if (r.eventsLoaded || r.loadingEvents || r.follow) return;
        r.loadingEvents = true;
        refresh(t);
        var url = RUNS_API + '/' + encodeURIComponent(r.row.id) + '/stream?after_seq=' + r.lastSeq;
        host.fetch(url, { headers: host.headers({ Accept: 'text/event-stream' }) })
            .then(function (res) {
                if (!res.ok) throw new Error('replay ' + res.status);
                return readStream(t, r, res, function (frame) { applyFrame(t, r, frame); });
            })
            .then(function () { r.eventsLoaded = true; })
            .catch(function () { r.eventsError = true; })
            .then(function () { r.loadingEvents = false; refresh(t); });
    }

    // ---------------------------------------------------------------------
    // Actions: send, cancel, stop, continue, answer
    // ---------------------------------------------------------------------
    function startRun(threadId, message, mediaIds) {
        var t = threadState(threadId);
        return host.fetch(RUNS_API, {
            method: 'POST',
            headers: host.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ thread_id: threadId, message: message, engine: 'kiro', attachments: mediaIds || [] })
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
                if (res.status === 202 && body.run_id) {
                    var row = {
                        id: body.run_id, thread_id: threadId, status: body.status || 'running', message: message,
                        created_at: new Date(host.now()).toISOString(),
                        attachments: (mediaIds || []).map(function (id) { return { media_id: id }; })
                    };
                    var r = upsertRun(t, row);
                    t.loaded = true;
                    follow(t, r);
                    scheduleListRefresh(t);
                    updateConfirmationPoll(t);
                    return { ok: true, run: r };
                }
                if (res.status === 409 && body.error === 'queue_full') return { ok: false, notice: 'Two messages are already waiting for Kiro. Cancel one, or wait until one starts.' };
                if (res.status === 409 && body.error === 'thread_not_kiro') return { ok: false, notice: 'This thread is answered by the Operator, not Kiro.' };
                if (res.status === 400 && (body.error === 'too_many_attachments' || body.error === 'invalid_attachment')) return { ok: false, notice: 'Those images could not be attached (at most ' + LIMITS.imagesPerMessage + ', your own uploads only).' };
                if (res.status === 503) return { ok: false, notice: 'Kiro runs are unavailable right now — try again shortly.' };
                return { ok: false, notice: 'Kiro could not take the message (' + res.status + ').' };
            });
        }).catch(function () { return { ok: false, notice: 'Could not reach the gateway — the message was not sent.' }; });
    }

    function send(threadId) {
        var t = threadState(threadId);
        var text = String(host.getDraft() || '').trim();
        if (!text || t.sending) return Promise.resolve(false);
        var tray = imageTray(threadId);
        t.sending = true;
        t.notice = null;
        refresh(t);
        return tray.upload(threadId).then(function (uploaded) {
            return startRun(threadId, text, uploaded.map(function (m) { return m.media_id; }));
        }, function (err) {
            return { ok: false, notice: err && err.message ? err.message : 'The images could not be uploaded.' };
        }).then(function (result) {
            t.sending = false;
            if (result.ok) {
                host.setDraft('');
                tray.clear();
                host.onSent(threadId, text);
            } else {
                t.notice = result.notice;
            }
            refresh(t, true);
            return result.ok;
        });
    }

    function cancelRun(threadId, runId) {
        var t = threadState(threadId);
        var r = t.byId[runId];
        if (!r) return Promise.resolve(false);
        r.cancelling = true;
        refresh(t);
        return host.fetch(RUNS_API + '/' + encodeURIComponent(runId) + '/cancel', { method: 'POST', headers: host.headers({}) })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (body) {
                    if (res.ok && body.status === 'cancelled') {
                        r.row = Object.assign({}, r.row, { status: 'cancelled' });
                        stopFollowing(r);
                    } else if (!res.ok) {
                        r.cancelling = false;
                        if (res.status === 409) reloadRun(t, r).then(function () { refresh(t); });
                    }
                    return res.ok;
                });
            })
            .catch(function () { r.cancelling = false; return false; })
            .then(function (ok) { refresh(t, true); return ok; });
    }

    function stop(threadId) {
        var t = threadState(threadId);
        var r = activeRun(t);
        return r ? cancelRun(threadId, r.row.id) : Promise.resolve(false);
    }

    function continueRun(threadId) {
        var t = threadState(threadId);
        if (t.sending) return Promise.resolve(false);
        t.sending = true;
        t.notice = null;
        refresh(t);
        return startRun(threadId, CONTINUE_MESSAGE, []).then(function (result) {
            t.sending = false;
            if (!result.ok) t.notice = result.notice;
            refresh(t, true);
            return result.ok;
        });
    }

    function answerPermission(threadId, runId, requestId, allow) {
        var t = threadState(threadId);
        var r = t.byId[runId];
        if (!r || r.answers[requestId]) return Promise.resolve();
        r.answers[requestId] = 'sending';
        refresh(t);
        return host.fetch('/api/v1/operator/kiro/permissions/' + encodeURIComponent(requestId), {
            method: 'POST',
            headers: host.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ allow: allow })
        }).then(function (res) {
            r.answers[requestId] = res.ok ? (allow ? 'allowed' : 'denied') : (res.status === 404 ? 'expired' : 'error');
        }).catch(function () {
            r.answers[requestId] = 'error';
        }).then(function () { refresh(t); });
    }

    // VTID-05006: a Kiro write (PR, merge, autopilot, approval, branch push) waits for the
    // signed-in user's Allow in the database; polled only while a run of this thread runs.
    function updateConfirmationPoll(t) {
        var want = !!activeRun(t);
        if (want && !t.confirmTimer) {
            var tick = function () {
                host.fetch('/api/v1/operator/kiro/confirmations?thread_id=' + encodeURIComponent(t.id), { headers: host.headers({}) })
                    .then(function (res) { return res.ok ? res.json() : null; })
                    .then(function (body) {
                        if (!body || !Array.isArray(body.pending)) return;
                        var changed = false;
                        body.pending.forEach(function (c) {
                            if (t.confirmations.some(function (x) { return x.id === c.id; })) return;
                            t.confirmations.push({ id: c.id, title: c.summary || c.tool, kind: 'make a change' + (c.vtid ? ' (' + c.vtid + ')' : ''), answer: null });
                            changed = true;
                        });
                        if (changed) scheduleRender(t);
                    })
                    .catch(function () { /* the next tick retries */ })
                    .then(function () {
                        if (t.confirmTimer) t.confirmTimer = host.setTimeout(tick, LIMITS.confirmPollMs);
                    });
            };
            t.confirmTimer = host.setTimeout(tick, 0);
        } else if (!want && t.confirmTimer) {
            host.clearTimeout(t.confirmTimer);
            t.confirmTimer = null;
        }
    }

    function answerConfirmation(threadId, confirmationId, allow) {
        var t = threadState(threadId);
        var c = t.confirmations.find(function (x) { return x.id === confirmationId; });
        if (!c || c.answer) return Promise.resolve();
        c.answer = 'sending';
        refresh(t);
        return host.fetch('/api/v1/operator/kiro/confirmations/' + encodeURIComponent(confirmationId), {
            method: 'POST',
            headers: host.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ decision: allow ? 'allow' : 'deny' })
        }).then(function (res) {
            c.answer = res.ok ? (allow ? 'allowed' : 'denied') : (res.status === 409 ? 'expired' : 'error');
        }).catch(function () { c.answer = 'error'; }).then(function () { refresh(t); });
    }

    // ---------------------------------------------------------------------
    // Images: one shared helper for the Kiro composer and app.js's Operator composer
    // ---------------------------------------------------------------------
    var trays = {};

    function imageTray(key) {
        if (trays[key]) return trays[key];
        var tray = {
            key: key,
            items: [],
            error: null,
            onChange: null,
            addFiles: function (files) {
                var list = Array.prototype.slice.call(files || []);
                var refused = [];
                list.forEach(function (file) {
                    if (!file) return;
                    if (IMAGE_TYPES.indexOf(String(file.type || '').toLowerCase()) === -1) { refused.push((file.name || 'file') + ' is not a PNG, JPEG, WebP or GIF image'); return; }
                    if (file.size > LIMITS.imageBytes) { refused.push((file.name || 'image') + ' is larger than 5 MB'); return; }
                    if (tray.items.length >= LIMITS.imagesPerMessage) { refused.push('At most ' + LIMITS.imagesPerMessage + ' images per message'); return; }
                    tray.items.push({ id: 'img-' + host.now() + '-' + Math.random().toString(36).slice(2, 8), file: file, url: host.createObjectURL(file), name: file.name || 'pasted image' });
                });
                tray.error = refused.length ? refused[0] : null;
                tray.changed();
                return refused;
            },
            remove: function (id) {
                tray.items = tray.items.filter(function (it) {
                    if (it.id === id) { host.revokeObjectURL(it.url); return false; }
                    return true;
                });
                tray.error = null;
                tray.changed();
            },
            clear: function () {
                tray.items.forEach(function (it) { host.revokeObjectURL(it.url); });
                tray.items = [];
                tray.error = null;
                tray.changed();
            },
            changed: function () {
                if (typeof tray.onChange === 'function') tray.onChange(tray);
                else host.renderApp();
            },
            /** Upload every chip; resolves [{ media_id, oasis_ref, url, mime_type }] in order, rejects on the first failure. */
            upload: function (threadId) {
                var out = [];
                var chain = Promise.resolve();
                tray.items.forEach(function (it) {
                    chain = chain.then(function () {
                        if (it.uploaded) { out.push(it.uploaded); return; }
                        return host.fetch(MEDIA_API + '?thread_id=' + encodeURIComponent(threadId), {
                            method: 'POST',
                            headers: host.headers({ 'Content-Type': it.file.type }),
                            body: it.file
                        }).then(function (res) {
                            return res.json().catch(function () { return {}; }).then(function (body) {
                                if (!res.ok || !body.media_id) {
                                    var why = body.error === 'too_large' ? 'is larger than 5 MB'
                                        : body.error === 'unsupported_type' || body.error === 'type_mismatch' ? 'is not a PNG, JPEG, WebP or GIF image'
                                        : 'could not be uploaded (' + res.status + ')';
                                    throw new Error((it.name || 'An image') + ' ' + why + '.');
                                }
                                it.uploaded = { media_id: body.media_id, oasis_ref: body.oasis_ref, url: body.url, mime_type: body.mime_type };
                                if (body.url) mediaUrls[body.media_id] = { url: body.url, at: host.now() };
                                out.push(it.uploaded);
                            });
                        });
                    });
                });
                return chain.then(function () { return out; });
            },
            hasImages: function () { return tray.items.length > 0; },
            /** Ctrl/Cmd+V of an image adds a chip; a text paste is left to the textarea. */
            bindPaste: function (textarea) {
                textarea.addEventListener('paste', function (e) {
                    var data = e.clipboardData;
                    if (!data) return;
                    var files = [];
                    Array.prototype.slice.call(data.items || []).forEach(function (item) {
                        if (item && item.kind === 'file' && /^image\//.test(item.type || '')) {
                            var f = item.getAsFile && item.getAsFile();
                            if (f) files.push(f);
                        }
                    });
                    if (files.length === 0 && data.files && data.files.length) {
                        Array.prototype.slice.call(data.files).forEach(function (f) { if (/^image\//.test(f.type || '')) files.push(f); });
                    }
                    if (files.length === 0) return; // text paste: unchanged
                    e.preventDefault();
                    tray.addFiles(files);
                });
            },
            /** Dropping image files on the pane adds chips. */
            bindDrop: function (target) {
                var hasFiles = function (e) {
                    var types = e.dataTransfer && e.dataTransfer.types;
                    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
                };
                target.addEventListener('dragover', function (e) {
                    if (!hasFiles(e)) return;
                    e.preventDefault();
                    if (target.classList) target.classList.add('kiro-drop-active');
                });
                target.addEventListener('dragleave', function () { if (target.classList) target.classList.remove('kiro-drop-active'); });
                target.addEventListener('drop', function (e) {
                    if (target.classList) target.classList.remove('kiro-drop-active');
                    if (!hasFiles(e)) return;
                    e.preventDefault();
                    tray.addFiles(e.dataTransfer.files);
                });
            },
            /** Paperclip: pick images from disk. */
            renderAttachButton: function () {
                var wrap = el('span', 'kiro-attach');
                var input = el('input', 'kiro-attach-input');
                input.type = 'file';
                input.accept = IMAGE_TYPES.join(',');
                input.multiple = true;
                input.setAttribute('aria-hidden', 'true');
                input.tabIndex = -1;
                input.onchange = function () { tray.addFiles(input.files); input.value = ''; };
                var b = button('kiro-attach-btn', '', function () { input.click(); }, 'Attach images');
                b.title = 'Attach images (or paste / drop them)';
                b.appendChild(el('span', 'kiro-attach-icon', '📎'));
                wrap.appendChild(b);
                wrap.appendChild(input);
                return wrap;
            },
            /** Thumbnail chips with a remove ✕ each, plus the last refusal (if any). */
            renderChips: function () {
                var box = el('div', 'kiro-image-tray');
                if (tray.items.length) {
                    var list = el('ul', 'kiro-image-chips');
                    list.setAttribute('aria-label', 'Images to send');
                    tray.items.forEach(function (it, i) {
                        var li = el('li', 'kiro-image-chip');
                        var img = el('img', 'kiro-image-chip-thumb');
                        img.src = it.url;
                        img.alt = 'Image ' + (i + 1) + ': ' + it.name;
                        li.appendChild(img);
                        li.appendChild(button('kiro-image-chip-remove', '✕', function () { tray.remove(it.id); }, 'Remove image ' + (i + 1)));
                        list.appendChild(li);
                    });
                    box.appendChild(list);
                }
                if (tray.error) {
                    var err = el('div', 'kiro-image-error', tray.error);
                    err.setAttribute('role', 'alert');
                    box.appendChild(err);
                }
                return box;
            }
        };
        trays[key] = tray;
        return tray;
    }

    // Signed URLs for images in history: per view, memory only.
    var mediaUrls = {};

    function mediaUrl(mediaId) {
        var hit = mediaUrls[mediaId];
        if (hit && hit.url && host.now() - hit.at < LIMITS.mediaUrlTtlMs) return Promise.resolve(hit.url);
        if (hit && hit.pending) return hit.pending;
        var pending = host.fetch(MEDIA_API + '/' + encodeURIComponent(mediaId), { headers: host.headers({}) })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (body) {
                if (body && body.url) { mediaUrls[mediaId] = { url: body.url, at: host.now() }; return body.url; }
                delete mediaUrls[mediaId];
                return null;
            })
            .catch(function () { delete mediaUrls[mediaId]; return null; });
        mediaUrls[mediaId] = { pending: pending, at: 0 };
        return pending;
    }

    /** Thumbnails for media ids (a message's images), each opening the full image. */
    function renderMediaThumbs(mediaIds, extraClass) {
        var box = el('div', 'kiro-media-thumbs' + (extraClass ? ' ' + extraClass : ''));
        (mediaIds || []).forEach(function (id, i) {
            var a = el('a', 'kiro-media-thumb');
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.setAttribute('aria-label', 'Open attached image ' + (i + 1));
            var img = el('img', 'kiro-media-thumb-img');
            img.alt = 'Attached image ' + (i + 1);
            a.appendChild(img);
            box.appendChild(a);
            mediaUrl(id).then(function (url) {
                if (url) { img.src = url; a.href = url; } else { a.classList && a.classList.add('kiro-media-thumb--missing'); img.alt = 'Attached image ' + (i + 1) + ' (unavailable)'; }
            });
        });
        return box;
    }

    // ---------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------
    var ANSWER_TEXT = { sending: 'Sending…', allowed: 'Allowed', denied: 'Denied', expired: 'Expired — denied', error: 'Could not send — Kiro will deny it' };
    var KIND_TEXT = { other: 'use a tool', execute: 'run a command', fetch: 'fetch', think: 'think', switch_mode: 'switch mode' };
    var ANSWER_CLASS = { allowed: 'kiro-approval--allowed', denied: 'kiro-approval--denied', expired: 'kiro-approval--expired', error: 'kiro-approval--error' };

    function renderApproval(opts) {
        var card = el('div', 'kiro-approval' + (opts.write ? ' kiro-approval--write' : '') + (ANSWER_CLASS[opts.answer] ? ' ' + ANSWER_CLASS[opts.answer] : ''));
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', opts.write ? 'Kiro asks to make a change' : 'Kiro asks for permission');
        // ACP kinds read as verbs; Kiro's MCP tools arrive as kind "other".
        var kind = KIND_TEXT[opts.kind] || opts.kind;
        card.appendChild(el('div', 'kiro-approval-text', 'Kiro wants to ' + (kind ? kind + ': ' : '') + opts.title));
        if (!opts.answer && opts.onAnswer) {
            var actions = el('div', 'kiro-approval-actions');
            actions.appendChild(button('kiro-approval-btn kiro-approval-btn--allow', 'Allow', function () { opts.onAnswer(true); }));
            actions.appendChild(button('kiro-approval-btn', 'Deny', function () { opts.onAnswer(false); }));
            card.appendChild(actions);
        } else {
            card.appendChild(el('div', 'kiro-approval-result', ANSWER_TEXT[opts.answer] || (opts.answer ? opts.answer : 'Not answered')));
        }
        return card;
    }

    function renderToolLine(step) {
        var marker = step.status === 'ok' ? '✓ ' : step.status === 'failed' ? '✗ ' : '… ';
        return el('li', 'chat-tool-activity-line chat-tool-activity-line--' + step.status + ' kiro-step', marker + step.title + (step.status === 'running' ? ' (running)' : ''));
    }

    function renderReply(text, live) {
        var bubble = el('div', 'message-bubble message-reply kiro-run-reply' + (live ? ' kiro-run-reply--live' : ''));
        if (!live && typeof host.renderMarkdown === 'function') bubble.appendChild(host.renderMarkdown(text));
        else bubble.textContent = text;
        return bubble;
    }

    function renderEndMarker(t, r, status, isNewest) {
        var row = r.row;
        var view = r.view || {};
        var stopReason = row.stop_reason || view.stopReason;
        if (status === 'refused' || status === 'incomplete') {
            return el('div', 'kiro-stopped-early', 'Kiro stopped early: ' + (stopReason || status));
        }
        if (status === 'failed') {
            var err = String(row.error || view.error || 'unknown error');
            var box = el('div', 'kiro-run-marker kiro-run-marker--failed');
            box.appendChild(el('span', 'kiro-run-marker-text', 'Kiro could not finish: ' + err));
            var code = err.split(':')[0];
            if (FALLBACK_ERRORS[code] && typeof host.continueInOperator === 'function') {
                var fb = button('kiro-fallback-btn', 'Continue in Operator', function () { host.continueInOperator(row.message || ''); });
                fb.title = 'Open a new Operator thread with this message, ready to send';
                box.appendChild(fb);
            }
            return box;
        }
        if (status === 'cancelled') return el('div', 'kiro-run-marker kiro-run-marker--cancelled', 'Stopped');
        if (status === 'interrupted') {
            var m = el('div', 'kiro-run-marker kiro-run-marker--interrupted');
            m.appendChild(el('span', 'kiro-run-marker-text', row.error === 'gateway_task_lost' || row.error === 'gateway_shutdown'
                ? 'Interrupted — the gateway restarted while Kiro was working.'
                : 'Interrupted before Kiro finished.'));
            if (isNewest) {
                var c = button('kiro-continue-btn', 'Continue', function () { continueRun(t.id); });
                c.title = 'Start a new run in this thread; Kiro gets the thread history back';
                c.disabled = !!t.sending;
                m.appendChild(c);
            }
            return m;
        }
        return null;
    }

    function renderRun(t, r, isNewest) {
        var status = runStatus(r);
        var view = r.view || foldRun(r.events);
        var row = r.row;
        var active = !!ACTIVE[status];
        var wrap = el('div', 'kiro-run kiro-run--' + status);
        wrap.setAttribute('data-run-id', row.id);

        // The developer's message and its images.
        var msg = el('div', 'message-bubble message-sent kiro-run-message');
        msg.textContent = row.message || '';
        wrap.appendChild(msg);
        var mediaIds = (row.attachments || []).map(function (a) { return a && a.media_id; }).filter(Boolean);
        if (mediaIds.length) wrap.appendChild(renderMediaThumbs(mediaIds, 'kiro-run-media'));
        if (view.images && view.images.delivery === 'unsupported') {
            var note = el('div', 'kiro-images-note', 'Kiro can’t see images in this version');
            note.setAttribute('role', 'note');
            wrap.appendChild(note);
        } else if (view.images && view.images.delivery === 'unreadable') {
            wrap.appendChild(el('div', 'kiro-images-note', (view.images.count - view.images.sent) + ' image(s) could not be read for Kiro'));
        }

        if (status === 'queued') {
            var q = el('div', 'kiro-queued');
            q.setAttribute('role', 'status');
            q.appendChild(el('span', 'kiro-queued-label', 'Queued — starts when the current run ends'));
            var cancel = button('kiro-queued-cancel', r.cancelling ? 'Cancelling…' : 'Cancel', function () { cancelRun(t.id, row.id); }, 'Cancel this queued message');
            cancel.disabled = !!r.cancelling;
            q.appendChild(cancel);
            wrap.appendChild(q);
            return wrap;
        }

        // Earlier uncommitted edits were lost (VTID-05064), above the reply.
        if (row.workspace && row.workspace.kiro_workspace === 'lost') {
            var lost = el('div', 'kiro-workspace-lost', 'Earlier uncommitted Kiro edits in this thread were lost (runner restarted or retention expired).');
            lost.setAttribute('role', 'note');
            wrap.appendChild(lost);
        }

        // Steps: tool calls and answered approval cards, collapsible.
        var answered = view.steps.filter(function (s) { return s.kind === 'tool' || s.answer || !active; });
        var open = view.steps.filter(function (s) { return s.kind === 'permission' && !s.answer && active; });
        var details = el('details', 'kiro-run-steps');
        if (active || r.expanded) details.open = true;
        var summaryText = r.loadingEvents ? 'Loading steps…'
            : r.eventsError ? 'Steps could not be loaded'
            : (r.eventsLoaded || active) ? (answered.length === 1 ? '1 step' : answered.length + ' steps')
            : 'Show steps';
        details.appendChild(el('summary', 'kiro-run-steps-summary', summaryText));
        var list = el('ul', 'kiro-run-steps-list');
        answered.forEach(function (s) {
            if (s.kind === 'tool') list.appendChild(renderToolLine(s));
            else {
                var li = el('li', 'kiro-step kiro-step--permission');
                li.appendChild(renderApproval({ title: s.title, kind: s.permKind, answer: s.answer || r.answers[s.id] || (active ? null : 'expired') }));
                list.appendChild(li);
            }
        });
        details.appendChild(list);
        details.addEventListener('toggle', function () {
            r.expanded = !!details.open;
            if (details.open && !r.eventsLoaded && !active) loadEvents(t, r);
        });
        if (answered.length > 0 || !r.eventsLoaded || active) wrap.appendChild(details);

        // Kiro's words: live text while running, the stored reply afterwards.
        var replyText = active ? view.text : (row.reply || view.text);
        if (replyText) wrap.appendChild(renderReply(replyText, active));

        // What Kiro is waiting on the developer for, right above Stop.
        open.forEach(function (s) {
            wrap.appendChild(renderApproval({
                title: s.title, kind: s.permKind, answer: r.answers[s.id] || null,
                onAnswer: function (allow) { answerPermission(t.id, row.id, s.id, allow); }
            }));
        });
        if (active) {
            t.confirmations.forEach(function (c) {
                wrap.appendChild(renderApproval({
                    title: c.title, kind: c.kind, write: true, answer: c.answer,
                    onAnswer: function (allow) { answerConfirmation(t.id, c.id, allow); }
                }));
            });
            if (!replyText && view.steps.length === 0) {
                wrap.appendChild(el('div', 'chat-tool-activity-line chat-tool-activity-line--running kiro-working', '… Kiro is working'));
            }
            var bar = el('div', 'kiro-run-live-bar');
            if (r.reconnecting) {
                var rc = el('span', 'kiro-reconnecting', 'Reconnecting…');
                rc.setAttribute('role', 'status');
                bar.appendChild(rc);
            }
            var stopBtn = button('kiro-stop-btn', r.cancelling ? 'Stopping…' : 'Stop', function () { cancelRun(t.id, row.id); });
            stopBtn.title = 'Stop Kiro’s current run';
            stopBtn.disabled = !!r.cancelling;
            bar.appendChild(stopBtn);
            wrap.appendChild(bar);
        }

        var marker = renderEndMarker(t, r, status, isNewest);
        if (marker) wrap.appendChild(marker);
        if (status === 'completed' && row.kiro_model) {
            var meta = el('div', 'message-meta kiro-run-meta');
            meta.appendChild(el('span', 'message-cost-badge', 'Kiro · ' + host.kiroModelName(row.kiro_model)));
            wrap.appendChild(meta);
        }
        return wrap;
    }

    function renderRunsRegion(t, legacyMessages) {
        var region = el('div', 'kiro-console-runs');
        region.setAttribute('data-thread-id', t.id);
        region.setAttribute('aria-live', 'polite');
        // Turns from before this thread's oldest listed run (pre-run history, or beyond the 20 listed).
        var oldest = t.runs.length ? Date.parse(t.runs[0].row.created_at || '') : NaN;
        var legacy = (legacyMessages || []).filter(function (m) {
            if (!t.runs.length) return true;
            return typeof m.ts === 'number' && !isNaN(oldest) && m.ts < oldest;
        });
        if (legacy.length && typeof host.renderLegacyMessage === 'function') {
            legacy.forEach(function (m) { host.renderLegacyMessage(region, m); });
        }
        if (t.error) {
            var e = el('div', 'kiro-console-error', t.error);
            e.setAttribute('role', 'alert');
            region.appendChild(e);
        }
        if (!t.loaded && !t.runs.length && !legacy.length) {
            region.appendChild(el('div', 'chat-tool-activity-line chat-tool-activity-line--running', '… Loading Kiro runs'));
        } else if (!t.runs.length && !legacy.length && !t.error && typeof host.renderEmptyPanel === 'function') {
            region.appendChild(host.renderEmptyPanel());
        }
        t.runs.forEach(function (r, i) { region.appendChild(renderRun(t, r, i === t.runs.length - 1)); });
        return region;
    }

    function renderComposerExtras(t) {
        var box = el('div', 'kiro-composer-extras');
        if (t.notice) {
            var n = el('div', 'kiro-composer-notice', t.notice);
            n.setAttribute('role', 'alert');
            box.appendChild(n);
        }
        box.appendChild(imageTray(t.id).renderChips());
        return box;
    }

    function renderComposer(t) {
        var wrap = el('div', 'kiro-composer');
        var extras = renderComposerExtras(t);
        t.mounted.extras = extras;
        wrap.appendChild(extras);

        var tray = imageTray(t.id);
        tray.onChange = function () { refresh(t); };
        var row = el('div', 'chat-input-container kiro-composer-input');
        row.appendChild(tray.renderAttachButton());
        var textarea = el('textarea', 'chat-textarea kiro-composer-textarea');
        textarea.placeholder = isThreadBusy(t.id) ? 'Message Kiro — it waits in the queue (paste or drop images)' : 'Message Kiro… (paste or drop images)';
        textarea.setAttribute('aria-label', 'Message to Kiro');
        textarea.rows = 2;
        textarea.value = host.getDraft() || '';
        textarea.oninput = function () { host.setDraft(textarea.value); };
        textarea.onkeydown = function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && String(textarea.value).trim()) {
                e.preventDefault();
                host.setDraft(textarea.value);
                send(t.id);
            }
        };
        tray.bindPaste(textarea);
        row.appendChild(textarea);
        if (typeof host.renderMic === 'function') {
            var mic = host.renderMic(textarea);
            if (mic) row.appendChild(mic);
        }
        var sendBtn = button('chat-send-btn kiro-send-btn', t.sending ? 'Sending…' : 'Send', function () {
            host.setDraft(textarea.value);
            send(t.id);
        });
        sendBtn.disabled = !!t.sending;
        if (isThreadBusy(t.id)) sendBtn.title = 'Kiro is working — this message waits in the queue';
        row.appendChild(sendBtn);
        wrap.appendChild(row);
        return wrap;
    }

    /**
     * The chat pane of a Kiro thread: runs (and any earlier turns) + composer. Rebuilt on
     * every renderApp(); live updates replace only the runs region and the composer extras.
     */
    function renderPane(threadId, opts) {
        var t = threadState(threadId);
        opts = opts || {};
        if (!t.loaded && !t.loading) loadThread(threadId);
        else scheduleListRefresh(t);
        t.legacy = opts.legacyMessages || [];
        var pane = el('div', 'kiro-console');
        pane.setAttribute('data-thread-id', threadId);
        var messages = el('div', 'chat-messages kiro-console-messages');
        if (typeof host.bindMessagesScroll === 'function') host.bindMessagesScroll(messages);
        var runs = renderRunsRegion(t, t.legacy);
        t.mounted.runs = runs;
        t.mounted.messages = messages;
        messages.appendChild(runs);
        pane.appendChild(messages);
        pane.appendChild(renderComposer(t));
        imageTray(threadId).bindDrop(pane);
        t.wasBusy = isThreadBusy(threadId);
        return pane;
    }

    function scheduleRender(t) {
        if (t.renderTimer) return;
        t.renderTimer = host.setTimeout(function () { t.renderTimer = null; refresh(t); }, LIMITS.renderDelayMs);
    }

    /** Replace the mounted runs region and composer extras in place (no full-app render). */
    function refresh(t, forceApp) {
        var busy = isThreadBusy(t.id);
        var busyChanged = busy !== t.wasBusy;
        t.wasBusy = busy;
        if (forceApp || busyChanged) {
            // Sidebar spinner, engine badge and Send title depend on it: one full render.
            host.renderApp();
            return;
        }
        if (host.activeThreadId() !== t.id) return;
        var stick = host.stickToBottom();
        if (t.mounted.runs && t.mounted.runs.parentNode) {
            var fresh = renderRunsRegion(t, t.legacy);
            if (replaceNode(t.mounted.runs, fresh)) t.mounted.runs = fresh;
        }
        if (t.mounted.extras && t.mounted.extras.parentNode) {
            var ex = renderComposerExtras(t);
            if (replaceNode(t.mounted.extras, ex)) t.mounted.extras = ex;
        }
        var m = t.mounted.messages;
        if (m && stick) m.scrollTop = m.scrollHeight;
    }

    /** Sign-out: stop every stream and timer and drop all state. */
    function reset() {
        Object.keys(threads).forEach(function (id) {
            var t = threads[id];
            t.runs.forEach(stopFollowing);
            if (t.listTimer) host.clearTimeout(t.listTimer);
            if (t.confirmTimer) host.clearTimeout(t.confirmTimer);
            if (t.renderTimer) host.clearTimeout(t.renderTimer);
        });
        Object.keys(trays).forEach(function (k) { trays[k].items.forEach(function (it) { host.revokeObjectURL(it.url); }); });
        threads = {};
        trays = {};
        mediaUrls = {};
    }

    root.KiroConsole = {
        init: init,
        renderPane: renderPane,
        loadThread: loadThread,
        send: send,
        stop: stop,
        cancelRun: cancelRun,
        continueRun: continueRun,
        answerPermission: answerPermission,
        isThreadBusy: isThreadBusy,
        hasRuns: hasRuns,
        imageTray: imageTray,
        renderMediaThumbs: renderMediaThumbs,
        reset: reset,
        // Exposed for tests and the visual harness.
        _internals: { foldRun: foldRun, parseSse: parseSse, threadState: threadState, LIMITS: LIMITS, CONTINUE_MESSAGE: CONTINUE_MESSAGE }
    };
})(typeof window !== 'undefined' ? window : this);
