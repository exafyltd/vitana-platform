// VTID-05073: Operator Console functions extracted from app.js (Phase 1 pilot).
// Mechanical move only — declarations are byte-identical to their app.js originals,
// in original app.js order. Loaded before app.js (modules.json "extracted").

/**
 * VTID-01027: Clear operator chat session (both history and conversation_id).
 * Called when user wants to start a fresh conversation.
 */
function clearOperatorChatSession() {
    try {
        localStorage.removeItem('operator_console_conversation_id');
        localStorage.removeItem('operator_console_history');
        console.log('[VTID-01027] Chat session cleared');
    } catch (e) {
        console.warn('[VTID-01027] Error clearing chat session:', e);
    }
}

/**
 * VTID-01027: Build context array for API request.
 * Takes the last N messages (up to 20) or caps by character count (12k).
 * @param {Array} history - Full chat history
 * @returns {Array} - Context array for API { role, content }
 */
function buildOperatorChatContext(history) {
    if (!history || history.length === 0) {
        return [];
    }

    var MAX_MESSAGES = 20;
    var MAX_CHARS = 12000;

    // Start from newest messages
    var context = [];
    var totalChars = 0;

    // Iterate from end (newest) to beginning (oldest)
    for (var i = history.length - 1; i >= 0 && context.length < MAX_MESSAGES; i--) {
        var msg = history[i];
        // VTID-05064: a persisted error line is console UI, not a model turn.
        if (msg.isError) continue;
        var content = msg.content || '';

        // Check if adding this message would exceed character limit
        if (totalChars + content.length > MAX_CHARS) {
            break;
        }

        context.unshift({
            role: msg.role,
            content: content
        });
        totalChars += content.length;
    }

    return context;
}

/**
 * VTID-05064: a turn finished in a thread that is no longer on screen. Its
 * entries go into THAT thread's stored history (the same storage
 * switchOperatorThread() restores from); the thread on screen is untouched.
 */
function appendToStoredOperatorThread(threadId, entries) {
    var thread = (state.operatorThreads || []).find(function (t) { return t.id === threadId; });
    if (!thread) return; // deleted while the turn ran — nothing to write back into
    var history = getOperatorThreadHistory(threadId);
    (entries || []).forEach(function (e) { if (e) history.push(e); });
    saveOperatorThreadHistory(threadId, history);
    thread.updatedAt = Date.now();
    if (thread.title === 'New conversation') thread.title = deriveOperatorThreadTitle(history);
    saveOperatorThreadsIndex(state.operatorThreads);
}

/**
 * Create a new, empty conversation thread and make it active. This is the
 * "New conversation" action clearOperatorChatSession() (VTID-01027) was
 * written for but never wired to any UI element — it now runs as part of
 * this flow (clearing the legacy single-thread keys is harmless hygiene
 * once every session is thread-aware).
 */
function startNewOperatorThread(opts) {
    var now = Date.now();
    var thread = {
        id: generateOperatorThreadId(),
        title: 'New conversation',
        conversationId: generateOperatorThreadId(),
        createdAt: now,
        updatedAt: now
    };
    // VTID-05003: Kiro is the default engine when it can serve this user.
    applyDefaultOperatorEngine(thread, opts && opts.engine);
    state.operatorThreads.unshift(thread);
    saveOperatorThreadsIndex(state.operatorThreads);

    clearOperatorChatSession();
    // VTID-04033: a new thread drops the executions the old one was following.
    closeAllOperatorExecutionFollows();

    state.operatorActiveThreadId = thread.id;
    state.operatorConversationId = thread.conversationId;
    state.operatorChatHistory = [];
    state.chatMessages = [];
    saveOperatorThreadHistory(thread.id, []);
    notifyOrbOperatorThread();
    renderApp();
    // VTID-05003: re-read the status (credits may have changed) and re-apply the default.
    if (!(opts && opts.engine)) fetchKiroStatus(true);
}

function dismissOperatorThreadId(threadId) {
    try {
        var ids = loadDismissedOperatorThreadIds().filter(function (id) { return id !== threadId; });
        ids.unshift(threadId);
        localStorage.setItem(OPERATOR_THREADS_DISMISSED_KEY, JSON.stringify(ids.slice(0, 500)));
    } catch (e) { /* no-op */ }
}

function startRenamingOperatorThread(threadId, currentTitle) {
    state.operatorRenamingThreadId = threadId;
    state.operatorRenameDraftValue = currentTitle || '';
    renderApp();
}

function cancelRenamingOperatorThread() {
    state.operatorRenamingThreadId = null;
    state.operatorRenameDraftValue = '';
    renderApp();
}

/** Commit the in-progress rename (if any). A blank/whitespace-only draft is
 * discarded rather than saved, so a thread can never end up with an empty
 * title. Guarded to be a safe no-op if called twice (Enter, then a
 * trailing blur on the same input). */
function commitRenamingOperatorThread() {
    if (state.operatorRenamingThreadId === null) return;
    var threadId = state.operatorRenamingThreadId;
    var newTitle = (state.operatorRenameDraftValue || '').trim();
    var thread = state.operatorThreads.find(function (t) { return t.id === threadId; });
    state.operatorRenamingThreadId = null;
    state.operatorRenameDraftValue = '';
    if (thread && newTitle) {
        thread.title = newTitle;
        saveOperatorThreadsIndex(state.operatorThreads);
    }
    renderApp();
}

/**
 * VTID-03960: delete a thread and its saved history permanently. Mirrors
 * this file's existing confirm() convention for destructive actions (see
 * e.g. the task-drop/rollback confirms elsewhere in this file) rather than
 * building a new custom modal for one action.
 */
function deleteOperatorThread(threadId) {
    var thread = state.operatorThreads.find(function (t) { return t.id === threadId; });
    if (!thread) return;
    if (!confirm('Delete "' + (thread.title || 'New conversation') + '"? This cannot be undone.')) return;

    state.operatorThreads = state.operatorThreads.filter(function (t) { return t.id !== threadId; });
    saveOperatorThreadsIndex(state.operatorThreads);
    try { localStorage.removeItem(operatorThreadHistoryKey(threadId)); } catch (e) { /* no-op */ }
    // VTID-04437: the server keeps its copy; never re-add it from the list.
    dismissOperatorThreadId(threadId);

    if (state.operatorActiveThreadId === threadId) {
        var next = state.operatorThreads
            .filter(function (t) { return !t.archived; })
            .slice()
            .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0];
        if (next) {
            switchOperatorThread(next.id);
        } else {
            startNewOperatorThread();
        }
    } else {
        renderApp();
    }
}

/**
 * VTID-03960: archive/unarchive a thread. Archiving hides it from the
 * default sidebar list without deleting its history — it stays reachable
 * via the "N archived" toggle at the bottom of the sidebar, so archiving
 * can never silently orphan a conversation the way a one-way hide would.
 */
function archiveOperatorThread(threadId) {
    var thread = state.operatorThreads.find(function (t) { return t.id === threadId; });
    if (!thread) return;
    thread.archived = true;
    saveOperatorThreadsIndex(state.operatorThreads);

    if (state.operatorActiveThreadId === threadId) {
        var next = state.operatorThreads
            .filter(function (t) { return !t.archived; })
            .slice()
            .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0];
        if (next) {
            switchOperatorThread(next.id);
        } else {
            startNewOperatorThread();
        }
    } else {
        renderApp();
    }
}

function unarchiveOperatorThread(threadId) {
    var thread = state.operatorThreads.find(function (t) { return t.id === threadId; });
    if (!thread) return;
    thread.archived = false;
    saveOperatorThreadsIndex(state.operatorThreads);
    renderApp();
}

/**
 * VTID-03960: "Share" copies a link that reopens this exact thread. Operator
 * threads are localStorage-only (never synced across devices/users — see
 * VTID-03822), so this genuinely only works when opened in the SAME browser
 * it was copied from; it is not a cross-user share. initOperatorChatSession()
 * and the DOMContentLoaded boot sequence both honor the ?operator_thread=
 * param this produces.
 */
function shareOperatorThread(thread) {
    var url = window.location.origin + window.location.pathname + '?operator_thread=' + encodeURIComponent(thread.id);
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
        showToast('Clipboard not available', 'error');
        return;
    }
    navigator.clipboard.writeText(url).then(function () {
        showToast('Link copied — reopens this conversation in this browser', 'success');
    }).catch(function () {
        showToast('Could not copy link', 'error');
    });
}

/**
 * VTID-03960: the "..." button + its dropdown for a sessions-sidebar row,
 * matching the Claude Code sidebar's own per-session menu. Click-outside-
 * to-close follows this file's existing version-dropdown pattern (see
 * renderHeader()'s isVersionDropdownOpen handling) — the listener is
 * registered via setTimeout(0) so it starts listening only AFTER the click
 * that opened the menu has finished propagating.
 */
function renderThreadMenuButton(thread) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-session-row-menu-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-session-row-menu-btn';
    btn.title = 'More options';
    btn.setAttribute('aria-label', 'More options for ' + (thread.title || 'New conversation'));
    btn.textContent = '⋯'; // midline horizontal ellipsis
    btn.onclick = (e) => {
        e.stopPropagation();
        state.operatorThreadMenuOpenId = state.operatorThreadMenuOpenId === thread.id ? null : thread.id;
        renderApp();
    };
    wrap.appendChild(btn);

    if (state.operatorThreadMenuOpenId === thread.id) {
        wrap.appendChild(renderThreadMenu(thread));
    }

    return wrap;
}

function renderThreadMenu(thread) {
    const menu = document.createElement('div');
    menu.className = 'chat-session-row-menu';
    menu.onclick = (e) => e.stopPropagation();

    var items = [
        { label: 'Rename', onSelect: function () { startRenamingOperatorThread(thread.id, thread.title || 'New conversation'); } },
        { label: 'Share', onSelect: function () { shareOperatorThread(thread); } },
        thread.archived
            ? { label: 'Unarchive', onSelect: function () { unarchiveOperatorThread(thread.id); } }
            : { label: 'Archive', onSelect: function () { archiveOperatorThread(thread.id); } },
        { label: 'Delete', danger: true, onSelect: function () { deleteOperatorThread(thread.id); } }
    ];

    items.forEach(function (item) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-session-row-menu-item' + (item.danger ? ' chat-session-row-menu-item--danger' : '');
        btn.textContent = item.label;
        btn.onclick = (e) => {
            e.stopPropagation();
            state.operatorThreadMenuOpenId = null;
            item.onSelect();
        };
        menu.appendChild(btn);
    });

    setTimeout(() => {
        const closeMenu = (e) => {
            const openMenu = document.querySelector('.chat-session-row-menu');
            if (openMenu && !openMenu.contains(e.target)) {
                state.operatorThreadMenuOpenId = null;
                document.removeEventListener('click', closeMenu);
                renderApp();
            }
        };
        document.addEventListener('click', closeMenu);
    }, 0);

    return menu;
}

/**
 * VTID-03949: renders a thread's title as either plain (double-click to
 * edit) or, while state.operatorRenamingThreadId matches, an inline text
 * input. Shared by the sidebar row and the chat title bar so both places
 * behave identically, per the platform owner's explicit ask.
 */
function renderEditableThreadTitle(thread, className) {
    if (state.operatorRenamingThreadId === thread.id) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = className + ' chat-session-title-input';
        input.value = state.operatorRenameDraftValue;
        input.oninput = (e) => {
            state.operatorRenameDraftValue = e.target.value;
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commitRenamingOperatorThread();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRenamingOperatorThread();
            }
        };
        input.onblur = () => {
            // VTID-03953: a blur fired while _renameBlurSuppressed is true is
            // the involuntary one caused by _renderAppCore() destroying this
            // (focused) element mid-edit, not the user leaving the field —
            // _renderAppCore() restores focus itself, so committing here
            // would incorrectly close the edit the user never asked to end.
            if (_renameBlurSuppressed) return;
            commitRenamingOperatorThread();
        };
        // Don't let a click inside the input bubble up to a sidebar row's
        // own onclick (which would switch threads mid-edit).
        input.onclick = (e) => e.stopPropagation();
        // VTID-03953: only auto-select-all on a fresh double-click open. A
        // rebuild that's restoring an already-focused input (background
        // poller mid-edit) sets _renamePreserveFocusPending and handles its
        // own precise focus/selection restore in _renderAppCore() instead.
        //
        // VTID-03966: AND only the first instance rendered THIS PASS for
        // this thread id claims the focus — this thread can render twice
        // in the same pass (sidebar row + title bar, when renaming the
        // active thread). Letting both schedule their own focus() makes
        // the second steal it from the first, firing a genuine blur that
        // commits/closes the rename before the user can type anything.
        if (!_renamePreserveFocusPending && _renameAutoFocusClaimedForThreadId !== thread.id) {
            _renameAutoFocusClaimedForThreadId = thread.id;
            // Deferred so the element is actually in the DOM before focusing.
            setTimeout(() => { input.focus(); input.select(); }, 0);
        }
        return input;
    }

    const span = document.createElement('div');
    span.className = className;
    span.textContent = thread.title || 'New conversation';
    span.title = 'Double-click to rename';
    span.ondblclick = (e) => {
        e.stopPropagation();
        startRenamingOperatorThread(thread.id, thread.title || 'New conversation');
    };
    return span;
}

/**
 * VTID-03949: Claude-Code-style sessions sidebar, replacing the old
 * <select> thread dropdown — every past conversation is listed at once
 * (most-recently-updated first) instead of hidden behind a menu that
 * covered the transcript while open. Click a row to switch to it,
 * double-click its title to rename it in place.
 */
function renderOperatorThreadRow(thread) {
    const row = document.createElement('div');
    row.className = 'chat-session-row'
        + (thread.id === state.operatorActiveThreadId ? ' chat-session-row--active' : '')
        + (thread.archived ? ' chat-session-row--archived' : '');
    row.onclick = () => switchOperatorThread(thread.id);

    const info = document.createElement('div');
    info.className = 'chat-session-row-info';
    info.appendChild(renderEditableThreadTitle(thread, 'chat-session-row-title'));

    const meta = document.createElement('div');
    meta.className = 'chat-session-row-meta';
    meta.textContent = formatRelativeTime(thread.updatedAt);
    // VTID-05064: the console's one running turn is in this thread.
    // VTID-05067: …or a Kiro run of this thread is queued or running (kiro-console.js).
    if ((state.chatSending && state.chatTurnThreadId === thread.id) || kiroThreadBusy(thread.id)) {
        const running = document.createElement('span');
        running.className = 'chat-thread-running';
        running.setAttribute('role', 'status');
        running.setAttribute('aria-label', 'Turn running');
        running.title = 'A turn is running in this thread';
        meta.appendChild(running);
    }
    // VTID-05069: run status dot from the thread's latest linked VTID (pipeline-tree.js).
    if (window.PipelineTree) meta.appendChild(window.PipelineTree.threadDot(thread.id));
    // VTID-05071: "Needs your OK" while a Kiro run of this thread waits on an approval (kiro-console.js).
    if (window.KiroConsole && window.KiroConsole.waitingBadge) meta.appendChild(window.KiroConsole.waitingBadge(thread.id));
    if (operatorThreadEngine(thread) === 'kiro') {
        const tag = document.createElement('span');
        tag.className = 'chat-engine-tag';
        tag.textContent = 'Kiro';
        meta.appendChild(tag);
    }
    info.appendChild(meta);

    row.appendChild(info);
    row.appendChild(renderThreadMenuButton(thread));

    return row;
}

function renderOperatorSessionsSidebar() {
    const sidebar = document.createElement('div');
    sidebar.className = 'chat-sessions-sidebar' + (state.operatorSessionsSidebarCollapsed ? ' chat-sessions-sidebar--collapsed' : '');

    const sidebarHeader = document.createElement('div');
    sidebarHeader.className = 'chat-sessions-sidebar-header';
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'chat-sessions-new-btn';
    newBtn.textContent = '+ New chat';
    newBtn.onclick = () => startNewOperatorThread();
    sidebarHeader.appendChild(newBtn);
    sidebar.appendChild(sidebarHeader);

    const list = document.createElement('div');
    list.className = 'chat-sessions-list';
    list.dataset.scrollRetain = 'true';
    list.dataset.scrollKey = 'operator-sessions-sidebar';

    const allThreads = state.operatorThreads || [];
    // VTID-03960: archived threads stay off the default list (never deleted,
    // never silently orphaned) — reachable via the toggle below.
    const activeThreads = allThreads.filter(function (t) { return !t.archived; });
    const archivedThreads = allThreads.filter(function (t) { return t.archived; });
    const sortByRecent = function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); };

    if (activeThreads.length === 0) {
        // VTID-04142: an explicit, plain empty state ("No conversations yet")
        // so a brand-new operator with no threads yet reads a message instead
        // of an apparently-blank session list. Also the archived-only case:
        // activeThreads is the count that matters here, and archived rows are
        // added below the empty state, so the list is never blank.
        const empty = document.createElement('div');
        empty.className = 'chat-sessions-empty';
        empty.textContent = 'No conversations yet';
        list.appendChild(empty);
    } else {
        activeThreads.slice().sort(sortByRecent).forEach(function (thread) {
            list.appendChild(renderOperatorThreadRow(thread));
        });
    }

    if (archivedThreads.length > 0) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'chat-sessions-archived-toggle';
        toggle.textContent = (state.operatorShowArchivedThreads ? 'Hide' : 'Show') + ' ' + archivedThreads.length + ' archived';
        toggle.onclick = () => {
            state.operatorShowArchivedThreads = !state.operatorShowArchivedThreads;
            renderApp();
        };
        list.appendChild(toggle);

        if (state.operatorShowArchivedThreads) {
            archivedThreads.slice().sort(sortByRecent).forEach(function (thread) {
                list.appendChild(renderOperatorThreadRow(thread));
            });
        }
    }

    sidebar.appendChild(list);
    return sidebar;
}

/**
 * VTID-0600: Generate human-readable summary from deployment data
 * Extracts meaning from VTID, service, and status
 */
function generateDeploySummary(deploy) {
    var service = deploy.service || 'unknown service';
    var vtid = deploy.vtid || '';
    var status = deploy.status || 'unknown';

    // Try to extract meaning from VTID pattern
    var meaning = '';

    if (vtid.includes('-0600')) {
        meaning = 'Operational visibility foundation';
    } else if (vtid.includes('-0500') || vtid.includes('-05')) {
        meaning = 'Core infrastructure update';
    } else if (vtid.includes('-0400') || vtid.includes('-04')) {
        meaning = 'Governance system change';
    } else if (vtid.includes('-0300') || vtid.includes('-03')) {
        meaning = 'Agent pipeline update';
    } else if (vtid.includes('-0200') || vtid.includes('-02')) {
        meaning = 'API/Integration change';
    } else if (vtid.includes('-0100') || vtid.includes('-01')) {
        meaning = 'Foundation layer update';
    }

    // Generate summary based on available data
    if (status === 'success') {
        if (meaning) {
            return 'Deployed ' + meaning + ' to ' + service;
        }
        return 'Successful deployment to ' + service;
    } else if (status === 'failure') {
        if (meaning) {
            return 'Failed: ' + meaning + ' for ' + service;
        }
        return 'Deployment failed for ' + service;
    } else {
        if (meaning) {
            return meaning + ' (' + service + ')';
        }
        return 'Update to ' + service;
    }
}

function operatorDictationSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function stopOperatorDictation() {
    if (operatorSpeechRecognition) {
        try { operatorSpeechRecognition.stop(); } catch (e) { /* already stopped/errored */ }
    }
    operatorSpeechRecognition = null;
    state.chatDictationActive = false;
}

// Starts a live SpeechRecognition session that streams transcribed text
// directly into state.chatInputValue (and the live textarea, so the user
// sees words appear as they speak) without going through renderApp() — a
// full re-render per partial result would be the exact kind of disruption
// VTID-03906 fixed elsewhere in this same popup.
function startOperatorDictation(textarea, micBtn) {
    var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor || state.chatDictationActive) return;

    var recognition = new SpeechRecognitionCtor();
    recognition.lang = (navigator.language || 'en-US');
    recognition.continuous = true;
    recognition.interimResults = true;

    var baseValue = state.chatInputValue || '';
    var baseNeedsSpace = baseValue.length > 0 && !/\s$/.test(baseValue);

    recognition.onresult = function (event) {
        var finalTranscript = '';
        var interimTranscript = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
            var transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }
        if (finalTranscript) {
            baseValue = baseValue + (baseNeedsSpace ? ' ' : '') + finalTranscript.trim() + ' ';
            baseNeedsSpace = false;
        }
        var combined = baseValue + interimTranscript;
        state.chatInputValue = combined;
        if (textarea) textarea.value = combined;
    };

    recognition.onerror = function (event) {
        console.warn('[VTID-03907] Speech recognition error:', event.error);
        stopOperatorDictation();
        if (micBtn) micBtn.classList.remove('chat-mic-btn--active');
        // VTID-03918: surface WHY dictation stopped instead of leaving the
        // user with a silently-dead mic — 'not-allowed'/'service-not-allowed'
        // (mic permission denied/blocked) and 'audio-capture' (no mic device)
        // fire asynchronously here with no other visible signal at all.
        showToast(operatorDictationErrorMessage(event.error), 'error');
    };

    recognition.onend = function () {
        operatorSpeechRecognition = null;
        state.chatDictationActive = false;
        if (micBtn) micBtn.classList.remove('chat-mic-btn--active');
    };

    // VTID-03918: recognition.start() can throw synchronously (e.g. a
    // leftover/stale recognition session in InvalidStateError). Previously
    // this call was unguarded AFTER the active class/state were already
    // set, so a thrown start() left the mic button permanently red with no
    // active recognition behind it — exactly "turns red, never listens,
    // only a second manual press clears it." Set active state only once
    // start() has actually succeeded, and clean up + inform the user if it
    // hasn't.
    try {
        recognition.start();
    } catch (e) {
        console.warn('[VTID-03907] Speech recognition failed to start:', e);
        showToast('Could not start voice dictation. Please try again.', 'error');
        return;
    }

    operatorSpeechRecognition = recognition;
    state.chatDictationActive = true;
    if (micBtn) micBtn.classList.add('chat-mic-btn--active');
}

// VTID-03918: human-readable reason for a SpeechRecognition error code, so
// a failed dictation attempt is explained instead of silently going dark.
function operatorDictationErrorMessage(errorCode) {
    switch (errorCode) {
        case 'not-allowed':
        case 'service-not-allowed':
            return 'Voice dictation needs microphone permission. Check your browser\'s site settings and try again.';
        case 'audio-capture':
            return 'No microphone was found. Check your device and try again.';
        case 'network':
            return 'Voice dictation lost its network connection. Please try again.';
        case 'no-speech':
            return 'No speech detected. Voice dictation stopped.';
        default:
            return 'Voice dictation stopped (' + (errorCode || 'unknown error') + ').';
    }
}

function renderOperatorOverlay() {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    backdrop.onclick = (e) => {
        if (e.target === backdrop) {
            state.isOperatorOpen = false;
            // VTID-01209: Stop active executions polling when closing
            stopActiveExecutionsPolling();
            // VTID-03907: Stop any in-progress voice dictation when closing
            if (state.chatDictationActive) stopOperatorDictation();
            renderApp();
        }
    };

    const panel = document.createElement('div');
    panel.className = 'overlay-panel operator-overlay' + (state.isOperatorFullscreen ? ' operator-overlay--fullscreen' : '');

    // Header
    const header = document.createElement('div');
    header.className = 'overlay-header';

    const titleBlock = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = 'Operator Console';
    titleBlock.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'overlay-subtitle';
    subtitle.textContent = 'Live events & chat';
    titleBlock.appendChild(subtitle);

    header.appendChild(titleBlock);

    // VTID-03905: header action buttons (fullscreen / restore), between the
    // title block and the close button. Close button behavior is unchanged.
    const headerActions = document.createElement('div');
    headerActions.className = 'overlay-header-actions';

    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.className = 'overlay-fullscreen-toggle';
    fullscreenBtn.title = state.isOperatorFullscreen ? 'Restore' : 'Fullscreen';
    fullscreenBtn.setAttribute('aria-label', state.isOperatorFullscreen ? 'Restore popup size' : 'Enter fullscreen');
    fullscreenBtn.innerHTML = state.isOperatorFullscreen ? ICON_RESTORE_SVG : ICON_EXPAND_SVG;
    fullscreenBtn.onclick = () => {
        state.isOperatorFullscreen = !state.isOperatorFullscreen;
        // VTID-04110: remember the choice so it survives a page reload.
        try { localStorage.setItem('vitana.operatorFullscreen', String(state.isOperatorFullscreen)); } catch (e) { /* ignore */ }
        renderApp();
    };
    headerActions.appendChild(fullscreenBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'overlay-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Close Operator Console');
    closeBtn.onclick = () => {
        state.isOperatorOpen = false;
        // VTID-01209: Stop active executions polling when closing
        stopActiveExecutionsPolling();
        // VTID-03907: Stop any in-progress voice dictation when closing
        if (state.chatDictationActive) stopOperatorDictation();
        renderApp();
    };
    headerActions.appendChild(closeBtn);

    header.appendChild(headerActions);

    panel.appendChild(header);

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'operator-tabs';

    const tabConfigs = [
        { key: 'chat', label: 'Chat' },
        { key: 'ticker', label: 'Live Ticker' },
        { key: 'history', label: 'History' }
    ];

    tabConfigs.forEach(t => {
        const tab = document.createElement('button');
        tab.className = `operator-tab ${state.operatorActiveTab === t.key ? 'active' : ''}`;
        tab.textContent = t.label;
        tab.onclick = () => {
            state.operatorActiveTab = t.key;
            renderApp();
        };
        tabs.appendChild(tab);
    });

    panel.appendChild(tabs);

    // Tab Content
    const tabContent = document.createElement('div');
    tabContent.className = 'operator-tab-content';

    if (state.operatorActiveTab === 'chat') {
        // VTID-03949: sessions sidebar + chat column, side by side.
        const chatLayout = document.createElement('div');
        chatLayout.className = 'operator-chat-layout';
        chatLayout.appendChild(renderOperatorSessionsSidebar());
        chatLayout.appendChild(renderOperatorChat());
        tabContent.appendChild(chatLayout);
    } else if (state.operatorActiveTab === 'ticker') {
        tabContent.appendChild(renderOperatorTicker());
    } else if (state.operatorActiveTab === 'history') {
        tabContent.appendChild(renderOperatorHistory());
    }

    panel.appendChild(tabContent);
    backdrop.appendChild(panel);

    return backdrop;
}

function describeToolActivity(tr) {
    if (!tr || !tr.name) return 'Ran a tool';
    var label = TOOL_ACTIVITY_LABELS[tr.name] || ('Ran ' + tr.name);
    if (tr.response && typeof tr.response === 'object' && tr.response.vtid) {
        label += ' (' + tr.response.vtid + ')';
    }
    // VTID-04028: the streamed turn measured each tool; keep it on the line.
    if (typeof tr.duration_ms === 'number') {
        label += ' · ' + formatToolDuration(tr.duration_ms);
    }
    return label;
}

/**
 * VTID-03907: the voice-dictation mic button (Web Speech API) beside a chat textarea.
 * VTID-05067: one builder for the Operator composer and the Kiro console composer.
 */
function renderOperatorMicButton(textarea, inputContainer) {
    const micBtn = document.createElement('button');
    micBtn.type = 'button';
    var dictationSupported = operatorDictationSupported();
    micBtn.className = 'chat-mic-btn' + (state.chatDictationActive ? ' chat-mic-btn--active' : '');
    micBtn.disabled = !dictationSupported;
    micBtn.title = !dictationSupported
        ? 'Voice dictation is not supported in this browser'
        : (state.chatDictationActive ? 'Stop voice dictation' : 'Start voice dictation');
    micBtn.setAttribute('aria-label', micBtn.title);
    micBtn.innerHTML = ICON_MIC_SVG;
    micBtn.onclick = () => {
        if (!dictationSupported) return;
        if (state.chatDictationActive) {
            stopOperatorDictation();
            micBtn.classList.remove('chat-mic-btn--active');
            micBtn.title = 'Start voice dictation';
        } else {
            startOperatorDictation(textarea, micBtn);
            micBtn.title = 'Stop voice dictation';
        }
    };
    if (inputContainer) inputContainer.appendChild(micBtn);
    return micBtn;
}

function renderOperatorChat() {
    const container = document.createElement('div');
    container.className = 'chat-container';

    // VTID-03949: session title bar — a sidebar show/hide toggle, the
    // active thread's own (double-click-to-rename) title, and "+ New".
    // Replaces the VTID-03822 <select> dropdown, which covered the
    // transcript while open and only ever showed one session at a time;
    // the full session list now lives in the persistent sidebar rendered
    // alongside this container by renderOperatorOverlay() (see
    // renderOperatorSessionsSidebar()). Purely client-side (localStorage),
    // per VTID-03822's own spec: there is no backend conversation table to
    // build against, so "resuming a thread" means restoring its saved
    // history into state.chatMessages, not a server-side fetch.
    const titleBar = document.createElement('div');
    titleBar.className = 'chat-session-title-bar';

    const sidebarToggleBtn = document.createElement('button');
    sidebarToggleBtn.type = 'button';
    sidebarToggleBtn.className = 'chat-sessions-toggle-btn';
    sidebarToggleBtn.title = state.operatorSessionsSidebarCollapsed ? 'Show sessions' : 'Hide sessions';
    sidebarToggleBtn.setAttribute('aria-label', sidebarToggleBtn.title);
    sidebarToggleBtn.innerHTML = ICON_SIDEBAR_SVG;
    sidebarToggleBtn.onclick = () => {
        state.operatorSessionsSidebarCollapsed = !state.operatorSessionsSidebarCollapsed;
        renderApp();
    };
    titleBar.appendChild(sidebarToggleBtn);

    const activeThread = (state.operatorThreads || []).find(function (t) { return t.id === state.operatorActiveThreadId; });
    if (activeThread) {
        titleBar.appendChild(renderEditableThreadTitle(activeThread, 'chat-session-title-bar-text'));
    } else {
        const fallbackTitle = document.createElement('div');
        fallbackTitle.className = 'chat-session-title-bar-text';
        fallbackTitle.textContent = 'New conversation';
        titleBar.appendChild(fallbackTitle);
    }

    // VTID-04975: Operator | Kiro on an empty thread, a fixed Kiro badge after.
    fetchKiroStatus();
    const engineControl = renderOperatorEngineSwitch();
    if (engineControl) titleBar.appendChild(engineControl);

    const newThreadBtn = document.createElement('button');
    newThreadBtn.type = 'button';
    newThreadBtn.className = 'chat-new-thread-btn';
    newThreadBtn.textContent = '+ New';
    newThreadBtn.title = 'Start a new conversation';
    newThreadBtn.onclick = function () {
        startNewOperatorThread();
    };
    titleBar.appendChild(newThreadBtn);

    container.appendChild(titleBar);

    // VTID-05067: a Kiro thread's chat pane (its runs, the live run, approval cards,
    // Stop, the queue, images and the composer) belongs to kiro-console.js.
    if (activeOperatorEngine() === 'kiro' && window.KiroConsole && state.operatorActiveThreadId) {
        initKiroConsoleHost();
        container.appendChild(window.KiroConsole.renderPane(state.operatorActiveThreadId, { legacyMessages: state.chatMessages }));
        return container;
    }

    // Messages area
    const messages = document.createElement('div');
    messages.className = 'chat-messages';

    // VTID-04106: keep state.chatStickToBottom in sync with the user's own
    // manual scroll actions — same 80px threshold as the VTID-0539 anchor's
    // wasNearBottom check, so a user who scrolls up to read older history
    // stays pinned there across background re-renders, and scrolling back
    // down re-arms auto-scroll without needing to send a message first.
    messages.addEventListener('scroll', function () {
        var distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
        state.chatStickToBottom = distanceFromBottom <= 80;
    });

    if (state.chatMessages.length === 0 && activeOperatorEngine() === 'kiro') {
        messages.appendChild(renderKiroThreadPanel());
    } else if (state.chatMessages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chat-empty-state';
        empty.textContent = 'No messages yet. Start a conversation with the Operator.';
        messages.appendChild(empty);
    } else {
        // VTID-0526: Updated message rendering with new bubble styles
        state.chatMessages.forEach(msg => {
            // Determine message type: sent (user) or reply (system)
            const isSent = msg.type === 'user' || msg.type === 'sent';
            const isError = msg.isError || msg.error;

            // Create bubble element with appropriate classes
            const bubble = document.createElement('div');
            let bubbleClasses = 'message-bubble';
            if (isSent) {
                bubbleClasses += ' message-sent';
            } else {
                bubbleClasses += ' message-reply';
            }
            if (isError) {
                bubbleClasses += ' message-error';
            }
            bubble.className = bubbleClasses;
            // VTID-04309: turns spoken with the voice assistant are marked.
            if (msg.channel === 'voice' || msg.channel === 'voice_delegate') {
                bubble.classList.add('message-voice');
                const voiceTag = document.createElement('div');
                voiceTag.className = 'message-voice-tag';
                voiceTag.textContent = msg.channel === 'voice_delegate'
                    ? (isSent ? 'Handed to Operator (voice)' : 'Operator')
                    : (isSent ? 'You (voice)' : 'Vitana (voice)');
                bubble.appendChild(voiceTag);
            }
            // VTID-03822: render markdown (bold/links/lists/headings) instead of
            // plain text — replies routinely come back with markdown, which
            // rendered as a wall of literal asterisks/backticks before this.
            bubble.appendChild(renderManualMarkdown(msg.content || msg.text || ''));
            appendReplyWithKiroNotices(messages, bubble, isSent ? null : msg); // VTID-05064
            // VTID-05067: the message's images, through signed URLs fetched per view (never stored).
            if (Array.isArray(msg.media) && msg.media.length > 0 && window.KiroConsole) {
                messages.appendChild(window.KiroConsole.renderMediaThumbs(msg.media, isSent ? 'kiro-run-media' : ''));
            }

            // VTID-03822: surface which tools ran on this turn (already present
            // on the message object since sendChatMessage's response handling —
            // toolResults/meta were pushed onto chatMessages but never read by
            // this renderer).
            if (msg.toolResults && msg.toolResults.length > 0) {
                const toolActivity = document.createElement('div');
                toolActivity.className = 'chat-tool-activity';
                msg.toolResults.forEach(tr => {
                    const line = document.createElement('div');
                    line.className = 'chat-tool-activity-line';
                    line.textContent = describeToolActivity(tr);
                    toolActivity.appendChild(line);
                });
                messages.appendChild(toolActivity);
            }

            // VTID-04033: the execution(s) this turn queued, followed live.
            if (Array.isArray(msg.followExecIds) && msg.followExecIds.length > 0) {
                msg.followExecIds.forEach(function (execId) {
                    messages.appendChild(renderOperatorExecutionFollow(execId));
                });
            }

            // Show attachments if any
            if (msg.attachments && msg.attachments.length > 0) {
                const attachmentsEl = document.createElement('div');
                attachmentsEl.className = 'chat-message-attachments';
                msg.attachments.forEach(att => {
                    const chip = document.createElement('span');
                    chip.className = `attachment-chip attachment-${att.kind}`;
                    chip.textContent = att.name || att.oasis_ref;
                    attachmentsEl.appendChild(chip);
                });
                messages.appendChild(attachmentsEl);
            }

            // VTID-03947: message-meta row — a copy-to-clipboard icon plus a
            // relative timestamp ("3h ago"), Claude Code style, replacing
            // the old plain always-absolute timestamp div.
            const meta = document.createElement('div');
            // Align with the message bubble via a CSS class rather than an
            // inline style assignment, same convention as .message-sent/
            // .message-reply above.
            meta.className = 'message-meta' + (isSent ? ' message-meta--sent' : '');

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'message-copy-btn';
            copyBtn.title = 'Copy message';
            copyBtn.setAttribute('aria-label', 'Copy message');
            copyBtn.innerHTML = ICON_COPY_SVG;
            copyBtn.onclick = () => {
                var textToCopy = msg.content || msg.text || '';
                if (!textToCopy) return;
                var showCopied = function () {
                    copyBtn.innerHTML = ICON_CHECK_SVG;
                    copyBtn.classList.add('message-copy-btn--copied');
                    setTimeout(function () {
                        copyBtn.innerHTML = ICON_COPY_SVG;
                        copyBtn.classList.remove('message-copy-btn--copied');
                    }, 1500);
                };
                try {
                    var result = navigator.clipboard.writeText(textToCopy);
                    if (result && typeof result.then === 'function') {
                        result.then(showCopied).catch(function () { /* ignore */ });
                    } else {
                        showCopied();
                    }
                } catch (e) { /* clipboard API unavailable — no-op */ }
            };
            meta.appendChild(copyBtn);

            const time = document.createElement('span');
            time.className = 'timestamp';
            time.textContent = formatRelativeTime(msg.ts) || msg.timestamp || '';
            // Exact absolute time still available on hover.
            time.title = msg.timestamp || '';
            meta.appendChild(time);

            // VTID-04031: cost / model badge — provider, model, turn duration,
            // tokens and the estimated cost the gateway computed for this turn.
            if (!isSent && msg.meta && msg.meta.provider) {
                var badgeText = formatTurnCostBadge(msg.meta);
                if (badgeText) {
                    var badge = document.createElement('span');
                    badge.className = 'message-cost-badge';
                    badge.textContent = badgeText;
                    badge.title = describeTurnCost(msg.meta);
                    meta.appendChild(badge);
                }
            }
            // VTID-04984: which Kiro model answered.
            if (msg.meta && msg.meta.engine === 'kiro' && msg.meta.kiro_model) {
                var kiroBadge = document.createElement('span');
                kiroBadge.className = 'message-cost-badge';
                kiroBadge.textContent = 'Kiro \u00b7 ' + kiroModelName(msg.meta.kiro_model);
                meta.appendChild(kiroBadge);
            }
            // VTID-05003: Kiro could not serve this turn — offer the Operator, never switch silently.
            var kiroFallback = !isSent ? renderKiroFallbackAction(msg) : null;
            if (kiroFallback) meta.appendChild(kiroFallback);

            messages.appendChild(meta);
        });
    }

    // VTID-04028: while a streamed turn runs, show its tool-call transcript
    // live under the transcript (replaces the bare "Sending..." wait).
    // VTID-05064: only in the thread the turn runs in; any other thread shows
    // a one-line pointer to it instead.
    if (state.chatSending && state.operatorActiveThreadId === state.chatTurnThreadId) {
        messages.appendChild(renderOperatorLiveTranscript());
    } else if (state.chatSending && state.chatTurnThreadId) {
        messages.appendChild(renderChatTurnElsewhereBanner());
    }
    // VTID-05069: live pipeline tree of the thread's VTIDs (pipeline-tree.js).
    if (window.PipelineTree && state.operatorActiveThreadId) messages.appendChild(window.PipelineTree.renderThreadCards(state.operatorActiveThreadId));

    container.appendChild(messages);

    // Attachments preview
    if (state.chatAttachments.length > 0) {
        const attachmentsPreview = document.createElement('div');
        attachmentsPreview.className = 'chat-attachments-preview';

        state.chatAttachments.forEach((att, index) => {
            const chip = document.createElement('span');
            chip.className = `attachment-chip attachment-${att.kind}`;
            chip.innerHTML = `${att.name} <span class="attachment-remove" data-index="${index}" aria-label="Remove attachment ${att.name}">&times;</span>`;
            chip.querySelector('.attachment-remove').onclick = () => {
                state.chatAttachments.splice(index, 1);
                renderApp();
            };
            attachmentsPreview.appendChild(chip);
        });

        container.appendChild(attachmentsPreview);
    }

    // VTID-05067: pasted / dropped / picked images, shared helper with the Kiro console.
    var imageTray = window.KiroConsole && state.operatorActiveThreadId ? window.KiroConsole.imageTray(state.operatorActiveThreadId) : null;
    if (imageTray) {
        imageTray.onChange = function () { renderApp(); };
        var trayChips = imageTray.renderChips();
        trayChips.classList.add('chat-image-tray');
        container.appendChild(trayChips);
        imageTray.bindDrop(container);
    }

    // Input area
    const inputContainer = document.createElement('div');
    inputContainer.className = 'chat-input-container';

    // Attachment button with dropdown
    const attachBtn = document.createElement('div');
    attachBtn.className = 'chat-attach-btn';
    attachBtn.innerHTML = '&#128206;'; // Paperclip emoji
    attachBtn.title = 'Add attachment';

    // Attachment menu (hidden by default)
    const attachMenu = document.createElement('div');
    attachMenu.className = 'chat-attach-menu';
    attachMenu.innerHTML = `
        <div class="attach-option" data-kind="image">Image</div>
        <div class="attach-option" data-kind="video">Video</div>
        <div class="attach-option" data-kind="file">File</div>
    `;
    // Menu hidden by default via CSS .chat-attach-menu { display: none; }

    attachBtn.onclick = (e) => {
        e.stopPropagation();
        attachMenu.classList.toggle('menu-open');
    };

    // Handle attach menu clicks
    attachMenu.querySelectorAll('.attach-option').forEach(opt => {
        opt.onclick = (e) => {
            e.stopPropagation();
            const kind = opt.dataset.kind;
            attachMenu.classList.remove('menu-open');

            // Create file input
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            // VTID-05067: images go to the image tray (stored on Send through /operator/media).
            if (kind === 'image' && imageTray) {
                fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
                fileInput.multiple = true;
                fileInput.onchange = function () { imageTray.addFiles(fileInput.files); };
                fileInput.click();
                return;
            }
            if (kind === 'image') fileInput.accept = 'image/*';
            else if (kind === 'video') fileInput.accept = 'video/*';

            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    uploadOperatorFile(file, kind);
                }
            };
            fileInput.click();
        };
    });

    attachBtn.appendChild(attachMenu);
    inputContainer.appendChild(attachBtn);

    // Close menu on outside click
    document.addEventListener('click', () => {
        attachMenu.classList.remove('menu-open');
    });

    // Textarea for message
    const textarea = document.createElement('textarea');
    textarea.className = 'chat-textarea';
    textarea.placeholder = 'Type a message...';
    textarea.value = state.chatInputValue;
    textarea.rows = 2;
    // VTID-0526-D: Track typing state to prevent scroll/render interruptions
    textarea.oninput = (e) => {
        state.chatInputValue = e.target.value;
        state.chatIsTyping = true;
    };
    textarea.onkeydown = (e) => {
        state.chatIsTyping = true;
        if (e.key === 'Enter' && e.ctrlKey && state.chatInputValue.trim()) {
            e.preventDefault();
            sendChatMessage();
        }
    };
    textarea.onblur = () => {
        // Only reset typing flag when user leaves the input
        state.chatIsTyping = false;
    };
    // VTID-05067: Ctrl/Cmd+V of an image adds a chip; a text paste is unchanged.
    if (imageTray) imageTray.bindPaste(textarea);
    inputContainer.appendChild(textarea);

    // VTID-03907: Voice dictation mic button (Web Speech API)
    renderOperatorMicButton(textarea, inputContainer);

    // Send button
    const sendBtn = document.createElement('button');
    sendBtn.className = 'chat-send-btn';
    sendBtn.textContent = state.chatSending ? 'Sending...' : 'Send';
    sendBtn.disabled = state.chatSending;
    sendBtn.onclick = () => {
        if (state.chatInputValue.trim() && !state.chatSending) {
            sendChatMessage();
        }
    };
    inputContainer.appendChild(sendBtn);

    container.appendChild(inputContainer);

    return container;
}

// ---------------------------------------------------------------------------
// VTID-04028: stream one operator turn as Server-Sent Events
// ---------------------------------------------------------------------------
// POST /api/v1/operator/chat/stream answers the SAME turn as /chat, but as
// SSE frames (turn.started, model.turn, tool.call, tool.result, reply|error,
// done). EventSource cannot POST a body, so the fetch() response body is
// read as a stream and parsed frame by frame here. Every tool.call /
// tool.result frame updates state.chatLiveTranscript and re-renders, so the
// console shows what the operator is doing while the turn runs. Resolves
// with the `reply` frame's JSON — byte-identical to /chat's body — so
// sendChatMessage() needs no second code path. Any failure to obtain a
// stream (older gateway, proxy buffering, no ReadableStream) falls back to
// /chat; a failure mid-stream does NOT re-send (the turn already ran).

function parseSseFrames(buffer) {
    // Returns { frames: [{event, data}], rest } — frames end at a blank line.
    var frames = [];
    var parts = buffer.split('\n\n');
    var rest = parts.pop();
    parts.forEach(function (block) {
        var event = 'message';
        var dataLines = [];
        block.split('\n').forEach(function (line) {
            if (line.indexOf(':') === 0) return; // comment / heartbeat
            if (line.indexOf('event:') === 0) event = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
        });
        if (dataLines.length === 0) return;
        var raw = dataLines.join('\n');
        var data;
        try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; }
        frames.push({ event: event, data: data });
    });
    return { frames: frames, rest: rest };
}

// VTID-04110: incremental update for the live tool-call transcript instead
// of the full-app renderApp() this used to call on every SSE frame. A long
// agent turn emits a tool.call/tool.result pair per tool invocation (a
// multi-step run can be a dozen or more) plus a model.turn frame per model
// call — each one used to tear down and rebuild the ENTIRE Command Hub DOM
// (sidebar, header, the whole overlay), which is what produced the visible
// flicker on every step. Mirrors the incremental-update pattern this file
// already uses for polling (VTID-01151's updateApprovalsBadge) — mutate
// only the one DOM node that actually changed.
function updateOperatorLiveTranscriptDom() {
    // VTID-05064: the turn runs in a thread that is not on screen — its frames
    // keep accumulating in state, but there is no live transcript to update
    // (and a full renderApp() per streamed frame would be wasted work).
    if (state.chatTurnThreadId && state.operatorActiveThreadId !== state.chatTurnThreadId) return;
    var existing = document.querySelector('.chat-tool-activity--live');
    if (!existing) {
        // Not mounted yet (first frame of the turn) — do one real render so
        // the container exists; every later frame in this turn takes the
        // fast, non-rebuilding path below.
        renderApp();
        return;
    }
    existing.replaceWith(renderOperatorLiveTranscript());
    var messagesEl = document.querySelector('.chat-messages');
    if (messagesEl && state.chatStickToBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }
}

function applyOperatorTurnFrame(frame) {
    // VTID-05067: Kiro turns are runs shown by kiro-console.js; kiro.* frames never reach here
    // from the console (a Kiro thread does not send through /chat/stream any more).
    if (frame.event && frame.event.indexOf('kiro.') === 0) return;
    var d = frame.data || {};
    if (frame.event === 'tool.call') {
        state.chatLiveTranscript[d.index] = {
            index: d.index, name: d.name, args: d.args, status: 'running', started_at: Date.now()
        };
        updateOperatorLiveTranscriptDom();
    } else if (frame.event === 'tool.result') {
        var entry = state.chatLiveTranscript[d.index] || { index: d.index, name: d.name };
        entry.status = d.ok ? 'ok' : 'failed';
        entry.duration_ms = d.duration_ms;
        entry.error = d.error;
        entry.excerpt = d.excerpt;
        state.chatLiveTranscript[d.index] = entry;
        updateOperatorLiveTranscriptDom();
    } else if (frame.event === 'model.turn') {
        state.chatLiveModelTurns.push(d);
        updateOperatorLiveTranscriptDom();
    }
}

async function streamOperatorTurn(payload) {
    var response = await fetch('/api/v1/operator/chat/stream', {
        method: 'POST',
        headers: buildContextHeaders({ 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }),
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        var err = new Error('Chat request failed: ' + response.status);
        err.status = response.status;
        throw err;
    }
    var ctype = response.headers.get('content-type') || '';
    if (ctype.indexOf('text/event-stream') === -1 || !response.body || !response.body.getReader) {
        var e = new Error('stream unavailable');
        e.streamUnavailable = true;
        throw e;
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var reply = null;
    var error = null;
    while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        parsed.frames.forEach(function (frame) {
            if (frame.event === 'reply') reply = frame.data;
            else if (frame.event === 'error') error = frame.data;
            else applyOperatorTurnFrame(frame);
        });
    }
    if (reply) return reply;
    if (error) {
        var failed = new Error((error.details || error.error || 'Chat request failed') + '');
        failed.status = error.status || 500;
        throw failed;
    }
    var incomplete = new Error('stream ended without a reply');
    incomplete.streamIncomplete = true;
    throw incomplete;
}

async function requestOperatorTurn(payload) {
    state.chatLiveTranscript = [];
    state.chatLiveModelTurns = [];
    // VTID-05067: Kiro write confirmations (VTID-05006) are polled by kiro-console.js while a run runs.
    try {
        return await streamOperatorTurn(payload);
    } catch (err) {
        // A 404 means a gateway without the stream route; a missing stream
        // means a proxy/browser that cannot deliver one. Both fall back to
        // the one-shot endpoint. Anything else already ran the turn.
        var canFallback = err && (err.status === 404 || err.streamUnavailable);
        if (!canFallback) throw err;
        console.warn('[VTID-04028] operator stream unavailable, falling back to /chat:', err.message);
        var response = await fetch('/api/v1/operator/chat', {
            method: 'POST',
            headers: buildContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error('Chat request failed: ' + response.status);
        }
        return await response.json();
    }
}

function formatToolDuration(ms) {
    if (typeof ms !== 'number' || !(ms >= 0)) return '';
    return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's';
}

// VTID-04031: token / cost formatting for the turn badge and the live transcript.
function formatTokenCount(n) {
    if (typeof n !== 'number' || !(n >= 0)) return '';
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
}

function formatTurnCostUsd(meta) {
    if (!meta || !meta.usage) return '';
    if (meta.cost_priced === false) return 'unpriced';
    if (typeof meta.cost_usd !== 'number') return '';
    return '$' + (meta.cost_usd < 0.01 ? meta.cost_usd.toFixed(4) : meta.cost_usd.toFixed(3));
}

function formatTurnCostBadge(meta) {
    if (!meta || !meta.provider) return '';
    var parts = [meta.provider + (meta.model ? ' \u00b7 ' + meta.model : '')];
    var dur = formatToolDuration(meta.duration_ms);
    if (dur) parts.push(dur);
    if (meta.usage && (meta.usage.input_tokens || meta.usage.output_tokens)) {
        parts.push(formatTokenCount(meta.usage.input_tokens) + '\u2191 ' + formatTokenCount(meta.usage.output_tokens) + '\u2193');
    }
    var cost = formatTurnCostUsd(meta);
    if (cost) parts.push(cost);
    return parts.join(' \u00b7 ');
}

function describeTurnCost(meta) {
    if (!meta) return '';
    var lines = ['Provider: ' + (meta.provider || '?'), 'Model: ' + (meta.model || '?')];
    if (typeof meta.duration_ms === 'number') lines.push('Turn: ' + formatToolDuration(meta.duration_ms) + (typeof meta.tool_calls === 'number' ? ' (' + meta.tool_calls + ' tool call' + (meta.tool_calls === 1 ? '' : 's') + ')' : ''));
    if (meta.usage) lines.push('Tokens: ' + (meta.usage.input_tokens || 0) + ' in / ' + (meta.usage.output_tokens || 0) + ' out' + (typeof meta.model_calls === 'number' ? ' over ' + meta.model_calls + ' model call' + (meta.model_calls === 1 ? '' : 's') : ''));
    if (meta.usage) {
        if (meta.cost_priced === false) {
            // No dollar figure is shown for an unknown model, so no estimate
            // caveat is needed — the table simply does not know the model.
            lines.push('Cost: model not in the price table');
        } else {
            lines.push('Est. cost: $' + Number(meta.cost_usd || 0).toFixed(6));
            lines.push(TURN_COST_ESTIMATE_NOTE);
        }
    }
    return lines.join('\n');
}

// The execution ids a finished turn should follow: successful results of the
// queue/approve tools that carry an execution_id, deduplicated in order.
function extractFollowedExecutionIds(toolResults) {
    var ids = [];
    (Array.isArray(toolResults) ? toolResults : []).forEach(function (tr) {
        if (!tr || !OPERATOR_EXEC_FOLLOW_TOOLS[tr.name]) return;
        var resp = tr.response;
        if (!resp || typeof resp !== 'object' || resp.ok === false) return;
        var id = typeof resp.execution_id === 'string' ? resp.execution_id.trim() : '';
        if (!id || ids.indexOf(id) !== -1) return;
        ids.push(id);
    });
    return ids;
}

// The panel under a reply for each execution that turn queued: a chip linking
// to the row on Autopilot Live, a live/terminal marker, and the last steps.
function renderOperatorExecutionFollow(execId) {
    var slot = state.operatorExecFollow[execId] || { steps: [], terminal: null };
    var panel = document.createElement('div');
    panel.className = 'chat-exec-follow' + (slot.terminal ? ' chat-exec-follow--done' : ' chat-exec-follow--live');

    var head = document.createElement('div');
    head.className = 'chat-exec-follow-head';

    var chip = document.createElement('a');
    chip.className = 'chat-exec-follow-chip';
    chip.href = '/command-hub/autopilot/live/#autopilot-live-exec-' + execId;
    chip.textContent = 'execution ' + execId.slice(0, 8);
    chip.title = 'Open this execution on Autopilot Live';
    head.appendChild(chip);

    var status = document.createElement('span');
    if (slot.terminal) {
        status.className = 'chat-exec-follow-status chat-exec-follow-status--done';
        status.textContent = OPERATOR_EXEC_TERMINAL_LABELS[slot.terminal] || String(slot.terminal).replace('dev_autopilot.execution.', '');
    } else if (slot.error) {
        status.className = 'chat-exec-follow-status chat-exec-follow-status--error';
        status.textContent = slot.error;
    } else if (slot.streamError) {
        status.className = 'chat-exec-follow-status chat-exec-follow-status--error';
        status.textContent = 'stream reconnecting…';
    } else {
        status.className = 'chat-exec-follow-status chat-exec-follow-status--live';
        status.textContent = (slot.tool === 'approved' ? 'approved' : 'queued') + ' · following';
    }
    head.appendChild(status);
    panel.appendChild(head);

    if (slot.steps.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'chat-tool-activity-line' + (slot.terminal ? '' : ' chat-tool-activity-line--running');
        empty.textContent = slot.terminal ? 'No step events were recorded.' : String.fromCodePoint(0x2026) + ' Waiting for the executor to pick it up';
        panel.appendChild(empty);
    }
    slot.steps.forEach(function (step) {
        var line = document.createElement('div');
        var st = step && step.status;
        var isErr = st === 'error' || (step && step.metadata && step.metadata.is_error);
        line.className = 'chat-tool-activity-line chat-exec-follow-line' + (isErr ? ' chat-tool-activity-line--failed' : st === 'success' ? ' chat-tool-activity-line--ok' : '');
        line.textContent = describeFollowedStep(step);
        try { line.title = new Date(step.created_at).toLocaleTimeString(); } catch (_e) { /* no title */ }
        panel.appendChild(line);
    });
    return panel;
}

// ---------------------------------------------------------------------------
// VTID-04975: Kiro engine in the Operator Console
// ---------------------------------------------------------------------------
// A thread answers either with the Operator (default) or with Kiro
// (kiro-cli over ACP, run by the gateway). The engine is picked on an empty
// thread and fixed once the first message is sent; the gateway keeps an
// existing thread's engine whatever the request says. Kiro reads and
// searches on its own; before it edits or runs anything it asks, and the ask
// shows here as an approval card. No answer in time means denied.
//
// VTID-05067: a Kiro thread's chat pane (runs, live run, approval cards, Stop,
// queue, images) is owned by kiro-console.js (window.KiroConsole). This block
// keeps the engine switch, status, model picker, key card and the host wiring.

function operatorThreadEngine(thread) {
    return thread && thread.engine === 'kiro' ? 'kiro' : 'llm';
}

function activeOperatorEngine() {
    var thread = (state.operatorThreads || []).find(function (t) { return t.id === state.operatorActiveThreadId; });
    return operatorThreadEngine(thread);
}

function canChangeOperatorEngine() {
    // VTID-05067: a Kiro thread's turns are runs (kiro-console.js), not chatMessages.
    return state.chatMessages.length === 0 && !state.chatSending && !kiroConsoleHasRuns(state.operatorActiveThreadId);
}

/** VTID-05067: the Kiro console module (kiro-console.js), when loaded. */
function kiroConsole() {
    return typeof window !== 'undefined' && window.KiroConsole ? window.KiroConsole : null;
}

function kiroConsoleHasRuns(threadId) {
    var kc = kiroConsole();
    return !!(threadId && kc && kc.hasRuns(threadId));
}

/** VTID-05067: the sidebar spinner — a Kiro run of this thread is queued or running. */
function kiroThreadBusy(threadId) {
    var kc = kiroConsole();
    return !!(threadId && kc && kc.isThreadBusy(threadId));
}

function kiroIsConnected() {
    return !!(state.kiroStatus && state.kiroStatus.enabled === true);
}

function setActiveOperatorEngine(engine) {
    var thread = (state.operatorThreads || []).find(function (t) { return t.id === state.operatorActiveThreadId; });
    if (!thread || !canChangeOperatorEngine()) return;
    if (engine === 'kiro' && !kiroIsConnected()) return;
    if (engine === 'kiro') thread.engine = 'kiro';
    else delete thread.engine;
    thread.engineChosen = true;
    saveOperatorThreadsIndex(state.operatorThreads);
    renderApp();
}

function fetchKiroStatus(force) {
    if ((_kiroStatusRequested && !force) || !state.authToken) return _kiroStatusPending || Promise.resolve();
    _kiroStatusRequested = true;
    var p = loadKiroStatus().finally(function () { if (_kiroStatusPending === p) _kiroStatusPending = null; });
    _kiroStatusPending = p;
    return p;
}

async function loadKiroStatus() {
    try {
        var res = await fetch('/api/v1/operator/kiro/status', { headers: buildContextHeaders({}) });
        state.kiroStatus = res.ok ? await res.json() : { ok: false, enabled: false, error: res.status };
    } catch (e) {
        state.kiroStatus = { ok: false, enabled: false, error: 'unreachable' };
    }
    // VTID-05003: the fresh status decides the active thread's engine while it is still empty
    // and the user has not picked one themselves.
    var active = (state.operatorThreads || []).find(function (t) { return t.id === state.operatorActiveThreadId; });
    if (active && !active.engineChosen && canChangeOperatorEngine()) {
        var before = operatorThreadEngine(active);
        applyDefaultOperatorEngine(active);
        if (operatorThreadEngine(active) !== before) saveOperatorThreadsIndex(state.operatorThreads);
    }
    renderApp();
}

async function waitForKiroDefault() {
    if (_kiroDefaultWaiting) return false;
    var active = (state.operatorThreads || []).find(function (t) { return t.id === state.operatorActiveThreadId; });
    if (!_kiroStatusPending || !active || active.engineChosen || !canChangeOperatorEngine()) return true;
    _kiroDefaultWaiting = true;
    try { await _kiroStatusPending; } catch (e) { /* status failure => default stays Operator */ }
    finally { _kiroDefaultWaiting = false; }
    return true;
}

function renderKiroStoppedEarly(msg) {
    if (!msg || !msg.meta || msg.meta.engine !== 'kiro' || !KIRO_STOPPED_EARLY_STATUSES[msg.meta.kiro_status]) return null;
    var el = document.createElement('div');
    el.className = 'kiro-stopped-early';
    el.textContent = 'Kiro stopped early: ' + (msg.meta.stop_reason || msg.meta.kiro_status);
    return el;
}

/**
 * VTID-05064: appends a transcript bubble with its Kiro notices — the
 * workspace-lost notice above the reply, the stopped-early marker under it.
 * `msg` is null for a sent (user) bubble, which never carries either.
 */
function appendReplyWithKiroNotices(messages, bubble, msg) {
    var lost = renderKiroWorkspaceLost(msg);
    if (lost) messages.appendChild(lost);
    messages.appendChild(bubble);
    var stopped = renderKiroStoppedEarly(msg);
    if (stopped) messages.appendChild(stopped);
}

/** VTID-05064: the runner lost this thread's earlier uncommitted Kiro edits. */
function renderKiroWorkspaceLost(msg) {
    if (!msg || !msg.meta || msg.meta.engine !== 'kiro' || msg.meta.kiro_workspace !== 'lost') return null;
    var el = document.createElement('div');
    el.className = 'kiro-workspace-lost';
    el.setAttribute('role', 'note');
    el.textContent = 'Earlier uncommitted Kiro edits in this thread were lost (runner restarted or retention expired).';
    return el;
}

/** VTID-05003: the gateway's default engine for new threads (Kiro while this user's Kiro Power seat can serve). */
function applyDefaultOperatorEngine(thread, forced) {
    var engine = forced || (state.kiroStatus && state.kiroStatus.default_engine === 'kiro' ? 'kiro' : 'llm');
    if (engine === 'kiro') thread.engine = 'kiro';
    else delete thread.engine;
}

function renderKiroFallbackAction(msg) {
    if (!msg || !msg.meta || msg.meta.engine !== 'kiro' || !KIRO_FALLBACK_STATUSES[msg.meta.kiro_status]) return null;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kiro-fallback-btn';
    btn.textContent = 'Continue in Operator';
    btn.title = 'Open a new Operator thread with your last message, ready to send';
    btn.onclick = function () { continueInOperator(msg); };
    return btn;
}

function continueInOperator(sourceMsg) {
    var idx = state.chatMessages.indexOf(sourceMsg);
    var last = '';
    for (var i = (idx >= 0 ? idx : state.chatMessages.length) - 1; i >= 0; i--) {
        var m = state.chatMessages[i];
        if (m && (m.type === 'user' || m.type === 'sent')) { last = m.content || ''; break; }
    }
    startNewOperatorThread({ engine: 'llm' });
    state.chatInputValue = last;
    renderApp();
}

/**
 * VTID-05067: a Kiro run ended (kiro-console.js). Its session may be new, so the
 * model list is re-read (VTID-04984), for the run's own thread.
 */
function onKiroRunFinished(threadId) {
    if (state.kiroModels && threadId) delete state.kiroModels[threadId];
}

/**
 * VTID-05067: what kiro-console.js needs from the page. Called before every
 * renderPane() (cheap: it only copies references).
 */
function initKiroConsoleHost() {
    if (!kiroConsole()) return;
    kiroConsole().init({
        fetch: function (url, init) { return fetch(url, init); },
        headers: function (extra) { return buildContextHeaders(extra || {}); },
        renderApp: function () { renderApp(); },
        activeThreadId: function () { return state.operatorActiveThreadId; },
        getDraft: function () { return state.chatInputValue || ''; },
        setDraft: function (v) { state.chatInputValue = v; state.chatIsTyping = !!v; },
        renderMarkdown: function (md) { return renderManualMarkdown(md); },
        renderEmptyPanel: function () { return renderKiroThreadPanel(); },
        renderLegacyMessage: renderKiroLegacyMessage,
        renderMic: function (textarea) { return renderOperatorMicButton(textarea, null); },
        bindMessagesScroll: function (el) {
            // VTID-04106: same stick-to-bottom tracking as the Operator transcript.
            el.addEventListener('scroll', function () {
                state.chatStickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
            });
        },
        stickToBottom: function () { return state.chatStickToBottom !== false; },
        onSent: onKiroMessageSent,
        onRunFinished: function (threadId) { onKiroRunFinished(threadId); },
        continueInOperator: function (text) {
            startNewOperatorThread({ engine: 'llm' });
            state.chatInputValue = text || '';
            renderApp();
        },
        kiroModelName: function (id) { return kiroModelName(id); },
        toast: function (m, t) { showToast(m, t || 'info'); }
    });
}

/** VTID-05067: the first Kiro message fixes the thread's engine and names the thread. */
function onKiroMessageSent(threadId, text) {
    var thread = (state.operatorThreads || []).find(function (t) { return t.id === threadId; });
    if (!thread) return;
    thread.engine = 'kiro';
    thread.engineChosen = true;
    thread.updatedAt = Date.now();
    if (!thread.title || thread.title === 'New conversation') {
        var clean = String(text || '').trim().replace(/\s+/g, ' ');
        if (clean) thread.title = clean.length > 40 ? clean.slice(0, 40) + '…' : clean;
    }
    state.chatStickToBottom = true;
    saveOperatorThreadsIndex(state.operatorThreads);
}

/**
 * VTID-05067: a turn of a Kiro thread from before its oldest listed run (stored
 * history), drawn by kiro-console.js above the runs.
 */
function renderKiroLegacyMessage(region, msg) {
    var isSent = msg.type === 'user' || msg.type === 'sent';
    var bubble = document.createElement('div');
    bubble.className = 'message-bubble ' + (isSent ? 'message-sent' : 'message-reply') + (msg.isError || msg.error ? ' message-error' : '');
    bubble.appendChild(renderManualMarkdown(msg.content || msg.text || ''));
    appendReplyWithKiroNotices(region, bubble, isSent ? null : msg);
    if (Array.isArray(msg.media) && msg.media.length > 0 && kiroConsole()) {
        region.appendChild(kiroConsole().renderMediaThumbs(msg.media, isSent ? 'kiro-run-media' : ''));
    }
    var meta = document.createElement('div');
    meta.className = 'message-meta' + (isSent ? ' message-meta--sent' : '');
    var time = document.createElement('span');
    time.className = 'timestamp';
    time.textContent = formatRelativeTime(msg.ts) || msg.timestamp || '';
    time.title = msg.timestamp || '';
    meta.appendChild(time);
    if (msg.meta && msg.meta.engine === 'kiro' && msg.meta.kiro_model) {
        var kiroBadge = document.createElement('span');
        kiroBadge.className = 'message-cost-badge';
        kiroBadge.textContent = 'Kiro \u00b7 ' + kiroModelName(msg.meta.kiro_model);
        meta.appendChild(kiroBadge);
    }
    var fallback = !isSent ? renderKiroFallbackAction(msg) : null;
    if (fallback) meta.appendChild(fallback);
    region.appendChild(meta);
}

async function endKiroSession() {
    if (!state.operatorActiveThreadId) return;
    try {
        var res = await fetch('/api/v1/operator/kiro/sessions/' + encodeURIComponent(state.operatorActiveThreadId), {
            method: 'DELETE', headers: buildContextHeaders({})
        });
        showToast(res.ok || res.status === 404 ? 'Kiro session ended' : 'Could not end the Kiro session', res.ok || res.status === 404 ? 'success' : 'error');
    } catch (e) {
        showToast('Could not end the Kiro session', 'error');
    }
}

// VTID-04984: model selection inside Kiro. The list is whatever Kiro offers
// for the thread's session; picking one switches it through Kiro. Before the
// first message there is no session, so there is nothing to list yet.
function ensureKiroModels(threadId) {
    if (!threadId || !state.authToken) return;
    state.kiroModels = state.kiroModels || {};
    if (state.kiroModels[threadId]) return;
    state.kiroModels[threadId] = { loading: true, models: [], current: null };
    fetch('/api/v1/operator/kiro/sessions/' + encodeURIComponent(threadId) + '/models', { headers: buildContextHeaders({}) })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (body) {
            state.kiroModels[threadId] = { loaded: true, models: (body && body.models) || [], current: (body && body.current_model) || null };
            renderApp();
        })
        .catch(function () { state.kiroModels[threadId] = { loaded: true, models: [], current: null }; });
}

function kiroModelName(modelId) {
    var entry = (state.kiroModels || {})[state.operatorActiveThreadId];
    var m = entry && entry.models.find(function (x) { return x.id === modelId; });
    return m ? m.name : modelId;
}

async function selectKiroModel(threadId, modelId) {
    try {
        var res = await fetch('/api/v1/operator/kiro/sessions/' + encodeURIComponent(threadId) + '/model', {
            method: 'POST',
            headers: buildContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ model_id: modelId })
        });
        var body = await res.json().catch(function () { return {}; });
        if (res.ok && body.ok) {
            state.kiroModels[threadId] = { loaded: true, models: body.models || [], current: body.current_model || modelId };
        } else {
            showToast(body.message || 'Kiro could not switch the model', 'error');
        }
    } catch (e) {
        showToast('Kiro could not switch the model', 'error');
    }
    renderApp();
}

function renderKiroModelSelect(threadId) {
    ensureKiroModels(threadId);
    var entry = (state.kiroModels || {})[threadId];
    if (!entry || !entry.models.length) return null;
    var select = document.createElement('select');
    select.className = 'chat-kiro-model-select';
    select.setAttribute('aria-label', 'Kiro model');
    // VTID-05067: not while a Kiro run of this thread is queued or running.
    select.disabled = !!state.chatSending || kiroThreadBusy(threadId);
    entry.models.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.description) opt.title = m.description;
        if (m.id === entry.current) opt.selected = true;
        select.appendChild(opt);
    });
    select.onchange = function () { selectKiroModel(threadId, select.value); };
    return select;
}

/** Title-bar control: Operator | Kiro on an empty thread, a fixed badge after. */
function renderOperatorEngineSwitch() {
    var engine = activeOperatorEngine();
    if (!canChangeOperatorEngine()) {
        if (engine !== 'kiro') return null;
        var fixed = document.createElement('div');
        fixed.className = 'chat-engine-fixed';
        var badge = document.createElement('span');
        badge.className = 'chat-engine-badge';
        badge.textContent = 'Kiro';
        fixed.appendChild(badge);
        // VTID-04984: Kiro's own models for this session.
        var modelSelect = renderKiroModelSelect(state.operatorActiveThreadId);
        if (modelSelect) fixed.appendChild(modelSelect);
        if (!state.chatSending && !kiroThreadBusy(state.operatorActiveThreadId)) {
            var end = document.createElement('button');
            end.type = 'button';
            end.className = 'chat-engine-end-btn';
            end.textContent = 'End session';
            end.title = 'Close this thread’s Kiro session. The next message starts a fresh one.';
            end.onclick = function () { endKiroSession(); };
            fixed.appendChild(end);
        }
        return fixed;
    }
    var group = document.createElement('div');
    group.className = 'chat-engine-switch';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Answer this thread with');
    [['llm', 'Operator'], ['kiro', 'Kiro']].forEach(function (opt) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-engine-option' + (engine === opt[0] ? ' chat-engine-option--active' : '');
        btn.textContent = opt[1];
        btn.setAttribute('aria-pressed', engine === opt[0] ? 'true' : 'false');
        if (opt[0] === 'kiro' && !kiroIsConnected()) {
            btn.disabled = true;
            btn.title = state.kiroStatus ? 'Kiro is not connected on this deployment yet' : 'Checking Kiro…';
        }
        btn.onclick = function () { setActiveOperatorEngine(opt[0]); };
        group.appendChild(btn);
    });
    return group;
}

async function fetchKiroKeyStatus(force) {
    if ((_kiroKeyRequested && !force) || !state.authToken) return;
    _kiroKeyRequested = true;
    try {
        var res = await fetch('/api/v1/operator/kiro/key', { headers: buildContextHeaders({}) });
        var body = await res.json().catch(function () { return {}; });
        state.kiroKey = res.ok && body.ok
            ? { loaded: true, linked: body.linked === true, updated_at: body.updated_at || null }
            : { loaded: true, unavailable: true };
    } catch (e) {
        state.kiroKey = { loaded: true, unavailable: true };
    }
    renderApp();
}

function kiroKeyInput() {
    if (!_kiroKeyInput) {
        _kiroKeyInput = document.createElement('input');
        _kiroKeyInput.type = 'password';
        _kiroKeyInput.className = 'kiro-key-input';
        _kiroKeyInput.autocomplete = 'off';
        _kiroKeyInput.spellcheck = false;
        _kiroKeyInput.placeholder = 'Paste your Kiro API key';
        _kiroKeyInput.setAttribute('aria-label', 'Kiro API key');
    }
    return _kiroKeyInput;
}

async function linkKiroKey() {
    var input = kiroKeyInput();
    var key = (input.value || '').trim();
    input.value = '';
    if (!key) return;
    state.kiroKey = Object.assign({}, state.kiroKey, { busy: true });
    renderApp();
    try {
        var res = await fetch('/api/v1/operator/kiro/key', {
            method: 'PUT',
            headers: buildContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ key: key })
        });
        key = '';
        var body = await res.json().catch(function () { return {}; });
        if (res.ok && body.ok) {
            state.kiroKey = { loaded: true, linked: true, updated_at: body.updated_at || null };
            showToast('Kiro API key linked', 'success');
        } else {
            state.kiroKey = Object.assign({}, state.kiroKey, { busy: false });
            showToast(body.error === 'INVALID_KEY' || body.error === 'invalid_key' ? 'That does not look like a Kiro API key' : 'Could not link the Kiro API key', 'error');
        }
    } catch (e) {
        state.kiroKey = Object.assign({}, state.kiroKey, { busy: false });
        showToast('Could not link the Kiro API key', 'error');
    }
    renderApp();
}

async function revokeKiroKey() {
    if (!confirm('Revoke your Kiro API key? Your open Kiro sessions end now.')) return;
    state.kiroKey = Object.assign({}, state.kiroKey, { busy: true });
    renderApp();
    try {
        var res = await fetch('/api/v1/operator/kiro/key', { method: 'DELETE', headers: buildContextHeaders({}) });
        if (res.ok) {
            state.kiroKey = { loaded: true, linked: false, updated_at: null };
            showToast('Kiro API key revoked', 'success');
        } else {
            state.kiroKey = Object.assign({}, state.kiroKey, { busy: false });
            showToast('Could not revoke the Kiro API key', 'error');
        }
    } catch (e) {
        state.kiroKey = Object.assign({}, state.kiroKey, { busy: false });
        showToast('Could not revoke the Kiro API key', 'error');
    }
    renderApp();
}

function kiroKeyStatusText() {
    var k = state.kiroKey;
    if (!k) return 'checking…';
    if (k.unavailable) return 'not available on this deployment';
    if (!k.linked) return 'not linked';
    // VTID-05004: an accepted key is confirmed, not offered for revocation.
    return '✓ Connected';
}

/** Link / Replace / Revoke for the signed-in user's own Kiro API key. */
function renderKiroKeyControls() {
    var k = state.kiroKey;
    if (!k || k.unavailable) return null;
    var box = document.createElement('div');
    box.className = 'kiro-key';
    if (!k.linked || k.editing) {
        var form = document.createElement('form');
        form.className = 'kiro-key-form';
        form.onsubmit = function (e) { e.preventDefault(); linkKiroKey(); };
        var input = kiroKeyInput();
        input.disabled = !!k.busy;
        form.appendChild(input);
        var link = document.createElement('button');
        link.type = 'submit';
        link.className = 'kiro-key-btn kiro-key-btn--primary';
        link.textContent = k.busy ? 'Linking…' : k.linked ? 'Replace' : 'Link';
        link.disabled = !!k.busy;
        form.appendChild(link);
        if (k.linked) {
            var cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'kiro-key-btn';
            cancel.textContent = 'Cancel';
            cancel.onclick = function () { kiroKeyInput().value = ''; state.kiroKey = Object.assign({}, k, { editing: false }); renderApp(); };
            form.appendChild(cancel);
        }
        box.appendChild(form);
        var note = document.createElement('div');
        note.className = 'kiro-key-note';
        note.textContent = 'Your own key from your Kiro account. It is stored encrypted for your account only and never shown again.';
        box.appendChild(note);
    } else if (!k.managing) {
        // VTID-05004: linked → only a quiet "Manage key"; Replace/Revoke stay one click away
        // so a leaked key can still be revoked.
        var manage = document.createElement('button');
        manage.type = 'button';
        manage.className = 'kiro-key-manage';
        manage.textContent = 'Manage key';
        manage.onclick = function () { state.kiroKey = Object.assign({}, k, { managing: true }); renderApp(); };
        box.appendChild(manage);
    } else {
        var actions = document.createElement('div');
        actions.className = 'kiro-key-actions';
        var replace = document.createElement('button');
        replace.type = 'button';
        replace.className = 'kiro-key-btn';
        replace.textContent = 'Replace';
        replace.disabled = !!k.busy;
        replace.onclick = function () { state.kiroKey = Object.assign({}, k, { editing: true }); renderApp(); };
        actions.appendChild(replace);
        var revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'kiro-key-btn kiro-key-btn--danger';
        revoke.textContent = 'Revoke';
        revoke.disabled = !!k.busy;
        revoke.onclick = function () { revokeKiroKey(); };
        actions.appendChild(revoke);
        var done = document.createElement('button');
        done.type = 'button';
        done.className = 'kiro-key-btn';
        done.textContent = 'Done';
        done.onclick = function () { state.kiroKey = Object.assign({}, k, { managing: false }); renderApp(); };
        actions.appendChild(done);
        box.appendChild(actions);
    }
    return box;
}

/** Empty state of a Kiro thread: what Kiro can do here and whether it is ready. */
function renderKiroThreadPanel() {
    fetchKiroKeyStatus();
    var panel = document.createElement('div');
    panel.className = 'kiro-panel';

    var head = document.createElement('div');
    head.className = 'kiro-panel-head';
    var title = document.createElement('div');
    title.className = 'kiro-panel-title';
    title.textContent = 'Kiro workspace';
    head.appendChild(title);
    var status = document.createElement('span');
    var connected = kiroIsConnected();
    status.className = 'kiro-panel-status ' + (connected ? 'kiro-panel-status--on' : 'kiro-panel-status--off');
    status.textContent = !state.kiroStatus ? 'Checking…' : connected ? 'Connected' : 'Not connected';
    head.appendChild(status);
    panel.appendChild(head);

    var rows = [
        ['Reads & searches', 'on its own'],
        ['Edits files, runs commands', 'asks you first — denied after 2 minutes without an answer'],
        ['Your Kiro API key', kiroKeyStatusText()]
    ];
    var list = document.createElement('dl');
    list.className = 'kiro-panel-rows';
    rows.forEach(function (r, i) {
        var dt = document.createElement('dt');
        dt.textContent = r[0];
        var dd = document.createElement('dd');
        dd.textContent = r[1];
        if (i === 2 && state.kiroKey && state.kiroKey.linked) dd.className = 'kiro-key-ok';
        list.appendChild(dt);
        list.appendChild(dd);
    });
    panel.appendChild(list);
    var keyControls = renderKiroKeyControls();
    if (keyControls) panel.appendChild(keyControls);

    var hint = document.createElement('div');
    hint.className = 'kiro-panel-hint';
    hint.textContent = connected && state.kiroKey && state.kiroKey.linked === false
        ? 'Link your Kiro API key above, then describe the change you want.'
        : connected
        ? 'Describe the change you want. Kiro streams its work below and asks before it touches anything.'
        : 'Kiro answers once it is connected for your account. Until then this thread replies “not connected”.';
    panel.appendChild(hint);
    return panel;
}

/**
 * VTID-05064: shown in place of the live transcript on any thread other than
 * the one the console's running turn belongs to. Clicking opens that thread.
 * Admin console text, English by design (same as the other Kiro strings).
 */
function renderChatTurnElsewhereBanner() {
    var turnThreadId = state.chatTurnThreadId;
    var thread = (state.operatorThreads || []).find(function (t) { return t.id === turnThreadId; });
    var title = (thread && thread.title) || 'another conversation';
    var banner = document.createElement('button');
    banner.type = 'button';
    banner.className = 'chat-turn-elsewhere';
    // An Operator (non-Kiro) thread's turn is named as such rather than as Kiro.
    var who = thread && operatorThreadEngine(thread) !== 'kiro' ? 'The Operator' : 'Kiro';
    banner.textContent = who + ' is working in “' + title + '” — open it';
    banner.title = 'Open the conversation with the running turn';
    banner.onclick = function () { switchOperatorThread(turnThreadId); };
    return banner;
}

function renderOperatorLiveTranscript() {
    var wrap = document.createElement('div');
    wrap.className = 'chat-tool-activity chat-tool-activity--live';
    state.chatLiveTranscript.forEach(function (entry) {
        if (!entry) return;
        var line = document.createElement('div');
        line.className = 'chat-tool-activity-line chat-tool-activity-line--' + (entry.status || 'running');
        var marker = entry.status === 'ok' ? String.fromCodePoint(0x2713) + ' '
            : entry.status === 'failed' ? String.fromCodePoint(0x2717) + ' '
            : String.fromCodePoint(0x2026) + ' ';
        var text = marker + describeToolActivity({ name: entry.name, response: {} });
        if (entry.status === 'running') text += ' (running)';
        else if (typeof entry.duration_ms === 'number') text += ' · ' + formatToolDuration(entry.duration_ms);
        if (entry.status === 'failed' && entry.error) text += ' — ' + entry.error;
        line.textContent = text;
        line.title = entry.args ? JSON.stringify(entry.args) : '';
        wrap.appendChild(line);
    });
    // VTID-04031: each model call as it completes — provider, model, stage,
    // duration and, when the provider reported usage, tokens + est. cost.
    state.chatLiveModelTurns.forEach(function (d) {
        if (!d) return;
        var mline = document.createElement('div');
        mline.className = 'chat-tool-activity-line chat-tool-activity-line--model';
        mline.textContent = '\u2234 ' + formatTurnCostBadge({
            provider: d.provider, model: d.model, duration_ms: d.duration_ms, usage: d.usage, cost_usd: d.cost_usd, cost_priced: d.cost_priced
        }) + (d.stage ? ' (' + d.stage + ')' : '');
        wrap.appendChild(mline);
    });
    if (state.chatLiveTranscript.length === 0 && state.chatLiveModelTurns.length === 0) {
        var thinking = document.createElement('div');
        thinking.className = 'chat-tool-activity-line chat-tool-activity-line--running';
        thinking.textContent = String.fromCodePoint(0x2026) + ' Thinking';
        wrap.appendChild(thinking);
    }
    return wrap;
}

async function sendChatMessage() {
    if (state.chatSending) return;

    // VTID-0526-D: Reset typing flag - user is done typing, now sending
    state.chatIsTyping = false;
    // VTID-03907: Stop any in-progress voice dictation once the message is sent
    if (state.chatDictationActive) stopOperatorDictation();

    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const messageText = state.chatInputValue.trim();

    if (!messageText) return;
    // VTID-05003: a still-loading Kiro default decides this thread's engine before the first send.
    if (!(await waitForKiroDefault())) return;
    // VTID-05067: a Kiro thread sends through a run (kiro-console.js), never through /chat.
    if (activeOperatorEngine() === 'kiro' && window.KiroConsole && state.operatorActiveThreadId) {
        initKiroConsoleHost();
        window.KiroConsole.send(state.operatorActiveThreadId);
        return;
    }

    // VTID-04106: re-arm auto-scroll on every send, regardless of where the
    // user was scrolled beforehand — see the VTID-0539 anchor check in
    // _renderAppCore() and the .chat-messages scroll listener above that
    // otherwise leaves this false while reading older history.
    state.chatStickToBottom = true;

    // VTID-01041: Handle pending title capture (user is responding to "What should be the title?" prompt)
    if (state.pendingTitleVtid) {
        var titleInput = messageText.toLowerCase();
        var skipKeywords = ['skip', 'cancel', 'no', 'none', 'never mind', 'nevermind'];
        var isSkip = skipKeywords.some(function (kw) { return titleInput === kw; });

        // Add user message to UI
        state.chatMessages.push({
            type: 'user',
            content: messageText,
            timestamp: timestamp,
            ts: now.getTime()
        });

        if (isSkip) {
            // User chose to skip - keep placeholder
            state.chatMessages.push({
                type: 'system',
                content: 'Title skipped. The task will keep its placeholder title.',
                timestamp: timestamp,
                ts: now.getTime()
            });
            state.pendingTitleVtid = null;
            state.pendingTitleRetryCount = 0;
        } else if (messageText.trim() === '') {
            // Empty input - retry once, then keep placeholder
            if (state.pendingTitleRetryCount < 1) {
                state.pendingTitleRetryCount++;
                state.chatMessages.push({
                    type: 'system',
                    content: 'Please enter a title for **' + state.pendingTitleVtid + '**, or type "skip" to keep the placeholder.',
                    timestamp: timestamp,
                    ts: now.getTime()
                });
            } else {
                state.chatMessages.push({
                    type: 'system',
                    content: 'No title provided. The task will keep its placeholder title.',
                    timestamp: timestamp,
                    ts: now.getTime()
                });
                state.pendingTitleVtid = null;
                state.pendingTitleRetryCount = 0;
            }
        } else {
            // Valid title - save it
            setTaskTitleOverride(state.pendingTitleVtid, messageText.trim());
            state.chatMessages.push({
                type: 'system',
                content: String.fromCodePoint(0x2705) + ' Title updated: **' + state.pendingTitleVtid + '** — "' + messageText.trim() + '"',
                timestamp: timestamp,
                ts: now.getTime()
            });
            console.log('[VTID-01041] Title captured for', state.pendingTitleVtid, ':', messageText.trim());
            state.pendingTitleVtid = null;
            state.pendingTitleRetryCount = 0;
            // Refresh the board to show the new title
            fetchTasks();
        }

        // Clear input and re-render
        state.chatInputValue = '';
        renderApp();
        return; // Don't send to backend - this was just title capture
    }

    // VTID-05067: pasted / dropped images are stored first (POST /operator/media), then sent by id.
    var turnMedia = [];
    var llmImageTray = window.KiroConsole && state.operatorActiveThreadId ? window.KiroConsole.imageTray(state.operatorActiveThreadId) : null;
    if (llmImageTray && llmImageTray.hasImages()) {
        state.chatSending = true;
        renderApp();
        try {
            initKiroConsoleHost();
            turnMedia = await llmImageTray.upload(state.operatorActiveThreadId);
        } catch (uploadErr) {
            state.chatSending = false;
            showToast((uploadErr && uploadErr.message) || 'The images could not be uploaded', 'error');
            renderApp();
            return;
        }
    }
    var turnMediaIds = turnMedia.map(function (m) { return m.media_id; });

    // VTID-01027: Add user message to session history
    var userHistoryEntry = {
        role: 'user',
        content: messageText,
        ts: now.getTime()
    };
    // VTID-05067: media ids only (signed URLs are fetched per view, never stored).
    if (turnMediaIds.length > 0) userHistoryEntry.media = turnMediaIds;
    state.operatorChatHistory.push(userHistoryEntry);
    saveOperatorThreadHistory(state.operatorActiveThreadId, state.operatorChatHistory);
    touchActiveOperatorThread();

    // Add user message
    state.chatMessages.push({
        type: 'user',
        content: messageText,
        timestamp: timestamp,
        ts: now.getTime(),
        attachments: [...state.chatAttachments],
        media: turnMediaIds.length > 0 ? turnMediaIds : undefined
    });

    // Prepare attachments for API
    const attachments = state.chatAttachments.map(a => ({
        oasis_ref: a.oasis_ref,
        kind: a.kind
    }));
    // VTID-05067: the stored images go to the model as image blocks.
    turnMedia.forEach(function (m) { attachments.push({ oasis_ref: m.oasis_ref, kind: 'image', media_id: m.media_id }); });
    if (llmImageTray && turnMedia.length > 0) { llmImageTray.onChange = function () {}; llmImageTray.clear(); }

    // VTID-01027: Build context from history (excluding the message we just added)
    var contextHistory = state.operatorChatHistory.slice(0, -1);
    var context = buildOperatorChatContext(contextHistory);

    // Clear input and attachments
    state.chatInputValue = '';
    state.chatAttachments = [];
    state.chatSending = true;
    // VTID-05064: the reply (or error) belongs to the thread it was sent in,
    // even if another thread is on screen when it arrives.
    state.chatTurnThreadId = state.operatorActiveThreadId;
    var turnThreadId = state.chatTurnThreadId;
    renderApp();

    // VTID-0526-D: Scroll to bottom after user message (safe - typing flag is reset)
    requestAnimationFrame(function () {
        var messagesContainer = document.querySelector('.chat-messages');
        if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    });

    try {
        // VTID-01025: Route directly to operator/chat which handles both general questions
        // AND Vitana knowledge via the knowledge_search tool when appropriate
        // VTID-01027: Include conversation_id and context for session memory
        console.log('[Operator] Sending message to operator chat:', messageText);
        console.log('[VTID-01027] Sending with conversation_id:', state.operatorConversationId, 'context messages:', context.length);

        // VTID-04028: stream the turn (tool-call transcript live), falling
        // back to the one-shot /chat reply when streaming is unavailable.
        const result = await requestOperatorTurn({
            message: messageText,
            // VTID-04309: the server-side thread is the console thread. Without
            // it every request got a random thread (144 of 152 live threads
            // had exactly one turn), so rolling summaries never accrued.
            threadId: state.operatorActiveThreadId || undefined,
            // VTID-04975: picks the engine for a new thread; ignored for an existing one.
            engine: activeOperatorEngine() === 'kiro' ? 'kiro' : undefined,
            conversation_id: state.operatorConversationId,
            context: context.length > 0 ? context : undefined,
            attachments: attachments.length > 0 ? attachments : undefined
        });
        console.log('[Operator] Chat response:', result);

        // VTID-04028: carry the measured per-tool durations from the live
        // transcript onto the final message so the activity lines keep them.
        if (Array.isArray(result.toolResults) && state.chatLiveTranscript.length > 0) {
            result.toolResults.forEach(function (tr, i) {
                var entry = state.chatLiveTranscript[i];
                if (entry && entry.name === tr.name && typeof entry.duration_ms === 'number') {
                    tr.duration_ms = entry.duration_ms;
                }
            });
        }

        // VTID-0537: Use the reply from the Gemini Operator Tools Bridge
        let replyContent = result.reply || 'No response received';

        // VTID-05064: is the turn's thread still the one on screen?
        var turnOnScreen = state.operatorActiveThreadId === turnThreadId;

        // VTID-0537: Check if a task was created via tools
        const hasCreatedTask = result.createdTask && result.createdTask.vtid;

        // VTID-01041: Build enhanced content with explicit success/failure confirmation
        if (hasCreatedTask) {
            var createdVtid = result.createdTask.vtid;
            var createdTitle = result.createdTask.title || '';
            var effectiveCreatedTitle = getEffectiveTaskTitle(result.createdTask);
            var needsTitlePrompt = isPlaceholderTitle(createdTitle);

            // VTID-01041: Explicit success confirmation
            replyContent += '\n\n' + String.fromCodePoint(0x2705) + ' Task created: **' + createdVtid + '** — "' + effectiveCreatedTitle + '" (Scheduled)';

            // VTID-01019: Add task creation to Live Feed for consistency
            state.tickerEvents.unshift({
                id: Date.now(),
                timestamp: new Date().toLocaleTimeString(),
                type: 'operator',
                topic: 'operator.chat.task.created',
                content: 'Task created via chat: ' + createdVtid,
                vtid: createdVtid
            });

            // VTID-01041: If title is placeholder, prompt user for title.
            // VTID-05064: only when the reply lands on screen — otherwise the
            // next message typed in an unrelated thread would become the title.
            if (needsTitlePrompt && turnOnScreen) {
                // Store the VTID awaiting title input
                state.pendingTitleVtid = createdVtid;
                state.pendingTitleRetryCount = 0;
                replyContent += '\n\nWhat should be the title for **' + createdVtid + '**?';
            }
        }

        // VTID-01027: Add assistant response to session history.
        // VTID-04104: followExecIds must be persisted here too, not only on
        // the in-memory chatMessages entry below — operatorChatHistory is
        // what actually survives a thread switch or page reload
        // (saveOperatorThreadHistory/getOperatorThreadHistory), and without
        // this field the restore path (switchOperatorThread, the page-load
        // bootstrap) can never re-attach the live follow panel for a turn
        // that queued an execution, even though the execution itself keeps
        // running on the backend the whole time.
        var turnFollowExecIds = extractFollowedExecutionIds(result.toolResults);
        var assistantHistoryEntry = {
            role: 'assistant',
            content: replyContent,
            ts: Date.now(),
            followExecIds: turnFollowExecIds,
            kiroMeta: kiroReplyMeta(result.meta) // VTID-05003: keeps the fallback action across reloads
        };
        // VTID-05064: the reply is saved into the thread the turn was sent in
        // (turnThreadId). If the user has switched to another thread, only
        // that thread's stored history changes — never the one on screen.
        if (!turnOnScreen) {
            appendToStoredOperatorThread(turnThreadId, [assistantHistoryEntry]);
            return;
        }
        state.operatorChatHistory.push(assistantHistoryEntry);
        saveOperatorThreadHistory(turnThreadId, state.operatorChatHistory);
        touchActiveOperatorThread();

        state.chatMessages.push({
            type: 'system',
            content: replyContent,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            ts: Date.now(),
            oasis_ref: result.oasis_ref,
            threadId: result.threadId,
            createdTask: result.createdTask,
            toolResults: result.toolResults,
            meta: result.meta,
            followExecIds: turnFollowExecIds
        });

        // VTID-04033: follow every execution this turn queued or approved.
        turnFollowExecIds.forEach(function (execId) {
            var tr = (result.toolResults || []).filter(function (t) { return t && t.response && t.response.execution_id === execId; })[0];
            followOperatorExecution(execId, tr ? OPERATOR_EXEC_FOLLOW_TOOLS[tr.name] : null);
        });

    } catch (error) {
        console.error('[Operator] Chat error:', error);
        // VTID-01041: Explicit failure confirmation with emoji
        var errorContent = String.fromCodePoint(0x274C) + ' Task creation failed: ' + error.message;
        var errorTs = Date.now();
        // VTID-05064: the error is persisted into the turn's own thread, so it
        // is still there after a thread switch or reload (restored as isError;
        // buildOperatorChatContext() leaves it out of the model's context).
        var errorHistoryEntry = { role: 'assistant', content: errorContent, ts: errorTs, isError: true };
        if (state.operatorActiveThreadId === turnThreadId) {
            state.operatorChatHistory.push(errorHistoryEntry);
            saveOperatorThreadHistory(turnThreadId, state.operatorChatHistory);
            touchActiveOperatorThread();
            state.chatMessages.push({
                type: 'system',
                content: errorContent,
                timestamp: new Date(errorTs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                ts: Date.now(),
                isError: true
            });
        } else {
            appendToStoredOperatorThread(turnThreadId, [errorHistoryEntry]);
        }
    } finally {
        state.chatSending = false;
        state.chatTurnThreadId = null; // VTID-05064: the console's one running turn is over
        // VTID-05064: a reply that landed in another thread does not scroll this one.
        var finishedOnScreen = state.operatorActiveThreadId === turnThreadId;
        renderApp();

        // VTID-0526-D: Single rAF for scroll + conditional focus after message complete
        requestAnimationFrame(function () {
            // Scroll to bottom to show the reply
            var messagesContainer = document.querySelector('.chat-messages');
            if (messagesContainer && finishedOnScreen) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
            // Only re-focus if input lost focus during send
            var textarea = document.querySelector('.chat-textarea');
            if (textarea && document.activeElement !== textarea) {
                textarea.focus();
            }
        });
    }
}

function renderOperatorTicker() {
    const container = document.createElement('div');
    container.className = 'ticker-container';
    container.dataset.scrollRetain = 'true';
    container.dataset.scrollKey = 'ticker-container';

    // Heartbeat status banner
    // VTID-0526-D: Show LIVE status and stage counters as soon as telemetry loads (no heartbeat required)
    const statusBanner = document.createElement('div');
    const hasStageCounters = state.stageCounters && (state.stageCounters.PLANNER > 0 || state.stageCounters.WORKER > 0 || state.stageCounters.VALIDATOR > 0 || state.stageCounters.DEPLOY > 0 || state.lastTelemetryRefresh);
    const isLive = state.operatorHeartbeatActive || hasStageCounters;
    statusBanner.className = isLive ? 'ticker-status-banner ticker-live' : 'ticker-status-banner ticker-standby';

    // VTID-0526-D: Show stage counters immediately from telemetry, even before heartbeat snapshot
    const counters = state.stageCounters;
    const snapshot = state.operatorHeartbeatSnapshot;

    if (isLive) {
        // VTID-01210: Summary view with progress counter
        const completedCount = snapshot?.tasks?.by_status?.completed || 0;
        const totalCount = snapshot?.tasks?.total || counters.PLANNER + counters.WORKER + counters.VALIDATOR + counters.DEPLOY;
        const inProgressCount = snapshot?.tasks?.by_status?.in_progress || 0;

        statusBanner.innerHTML = `
            <div class="ticker-status-row ticker-summary-row">
                <span class="ticker-status-label">STATUS:</span>
                <span class="ticker-status-value status-live">LIVE</span>
                <span class="ticker-progress-counter">
                    <span class="ticker-progress-completed">${completedCount}</span>
                    <span class="ticker-progress-of">of</span>
                    <span class="ticker-progress-total">${totalCount}</span>
                    <span class="ticker-progress-label">tasks completed</span>
                </span>
                <span class="ticker-status-label">CICD:</span>
                <span class="ticker-status-value status-${snapshot?.cicd?.status || 'ok'}">${(snapshot?.cicd?.status || 'OK').toUpperCase()}</span>
            </div>
            <div class="ticker-status-row ticker-status-tasks">
                <span>Scheduled: ${snapshot?.tasks?.by_status?.scheduled || 0}</span>
                <span>In Progress: ${inProgressCount}</span>
                <span>Completed: ${completedCount}</span>
            </div>
            <div class="ticker-status-row ticker-stage-counters">
                <span class="stage-counter stage-planner" title="Planning stage events">
                    <span class="stage-icon">P</span>
                    <span class="stage-count">${counters.PLANNER}</span>
                </span>
                <span class="stage-counter stage-worker" title="Worker stage events">
                    <span class="stage-icon">W</span>
                    <span class="stage-count">${counters.WORKER}</span>
                </span>
                <span class="stage-counter stage-validator" title="Validator stage events">
                    <span class="stage-icon">V</span>
                    <span class="stage-count">${counters.VALIDATOR}</span>
                </span>
                <span class="stage-counter stage-deploy" title="Deploy stage events">
                    <span class="stage-icon">D</span>
                    <span class="stage-count">${counters.DEPLOY}</span>
                </span>
            </div>
        `;
    } else if (state.stageCountersLoading) {
        statusBanner.innerHTML = `
            <div class="ticker-status-row">
                <span class="ticker-status-value status-standby">LOADING</span>
                <span class="ticker-hint">Fetching telemetry...</span>
            </div>
        `;
    } else {
        statusBanner.innerHTML = `
            <div class="ticker-status-row">
                <span class="ticker-status-value status-standby">STANDBY</span>
                <span class="ticker-hint">Loading live events...</span>
            </div>
        `;
    }
    container.appendChild(statusBanner);

    // VTID-01209: Active Executions section - show in-progress tasks with pipeline status
    if (state.activeExecutions && state.activeExecutions.length > 0) {
        var activeSection = document.createElement('div');
        activeSection.className = 'ticker-active-executions';

        var activeHeader = document.createElement('div');
        activeHeader.className = 'ticker-active-header';
        activeHeader.innerHTML = '<span class="active-header-badge">' + state.activeExecutions.length + ' ACTIVE</span> Pipeline Executions';
        activeSection.appendChild(activeHeader);

        state.activeExecutions.forEach(function (execData) {
            var execCard = renderTaskExecutionStatus(execData, { variant: 'ticker-card', showRecent: false });
            activeSection.appendChild(execCard);
        });

        container.appendChild(activeSection);
    }

    // VTID-0600: Ticker filter toolbar
    var filterToolbar = document.createElement('div');
    filterToolbar.className = 'ticker-filter-toolbar';

    var collapseToggle = document.createElement('label');
    collapseToggle.className = 'ticker-collapse-toggle';
    var collapseCheckbox = document.createElement('input');
    collapseCheckbox.type = 'checkbox';
    collapseCheckbox.checked = state.tickerCollapseHeartbeat;
    collapseCheckbox.onchange = function () {
        state.tickerCollapseHeartbeat = collapseCheckbox.checked;
        renderApp();
    };
    collapseToggle.appendChild(collapseCheckbox);
    collapseToggle.appendChild(document.createTextNode(' Collapse heartbeat'));
    filterToolbar.appendChild(collapseToggle);

    var severityFilter = document.createElement('select');
    severityFilter.className = 'ticker-severity-filter';
    severityFilter.innerHTML =
        '<option value="all">All Events</option>' +
        '<option value="critical">Critical Only</option>' +
        '<option value="important">Important+</option>';
    severityFilter.value = state.tickerSeverityFilter;
    severityFilter.onchange = function () {
        state.tickerSeverityFilter = severityFilter.value;
        renderApp();
    };
    filterToolbar.appendChild(severityFilter);

    container.appendChild(filterToolbar);

    // Events list
    const eventsList = document.createElement('div');
    eventsList.className = 'ticker-events-list';
    eventsList.dataset.scrollRetain = 'true';
    eventsList.dataset.scrollKey = 'ticker-events';

    if (state.tickerEvents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ticker-empty';
        empty.textContent = state.operatorHeartbeatActive ? 'Waiting for events...' : 'Loading events...';
        eventsList.appendChild(empty);
    } else {
        // VTID-0600: Classify and sort events by severity
        var classifiedEvents = state.tickerEvents.map(function (event) {
            var eventCopy = Object.assign({}, event);
            // Determine severity from event type/content
            var type = (event.type || '').toLowerCase();
            var content = (event.content || '').toLowerCase();

            if (type === 'error' || content.includes('failed') || content.includes('blocked') || content.includes('denied')) {
                eventCopy.severity = 'critical';
            } else if (type === 'governance' || type === 'deploy' || content.includes('success') || content.includes('allowed')) {
                eventCopy.severity = 'important';
            } else if (type === 'heartbeat' || type === 'ping' || content.includes('heartbeat') || content.includes('health')) {
                eventCopy.severity = 'low';
            } else {
                eventCopy.severity = 'info';
            }
            return eventCopy;
        });

        // Filter by severity if filter is active
        if (state.tickerSeverityFilter === 'critical') {
            classifiedEvents = classifiedEvents.filter(function (e) { return e.severity === 'critical'; });
        } else if (state.tickerSeverityFilter === 'important') {
            classifiedEvents = classifiedEvents.filter(function (e) { return e.severity === 'critical' || e.severity === 'important'; });
        }

        // Sort: critical first, then important, then info, then low
        var severityOrder = { critical: 0, important: 1, info: 2, low: 3 };
        classifiedEvents.sort(function (a, b) {
            return severityOrder[a.severity] - severityOrder[b.severity];
        });

        // Group heartbeat events if collapsing is enabled
        var heartbeatEvents = [];
        var otherEvents = [];

        if (state.tickerCollapseHeartbeat) {
            classifiedEvents.forEach(function (event) {
                if (event.severity === 'low') {
                    heartbeatEvents.push(event);
                } else {
                    otherEvents.push(event);
                }
            });
        } else {
            otherEvents = classifiedEvents;
        }

        // Render other events first
        otherEvents.forEach(function (event) {
            var item = document.createElement('div');
            item.className = 'ticker-item ticker-item-' + event.severity;

            // DEV-COMHU-0202: Add status-based class for deploy events
            if (event.topic && event.topic.includes('.success')) {
                item.classList.add('ticker-item-success');
            } else if (event.topic && (event.topic.includes('.failed') || event.topic.includes('.blocked'))) {
                item.classList.add('ticker-item-error');
            }

            // Severity indicator
            var severityDot = document.createElement('span');
            severityDot.className = 'ticker-severity-dot ticker-severity-' + event.severity;
            item.appendChild(severityDot);

            var timestamp = document.createElement('div');
            timestamp.className = 'ticker-timestamp';
            timestamp.textContent = event.timestamp;
            item.appendChild(timestamp);

            // VTID-0526-D: Show task_stage badge if present
            if (event.task_stage) {
                var stageBadge = document.createElement('div');
                stageBadge.className = 'ticker-stage ticker-stage-' + event.task_stage.toLowerCase();
                stageBadge.textContent = event.task_stage.charAt(0);
                stageBadge.title = event.task_stage;
                item.appendChild(stageBadge);
            }

            // DEV-COMHU-0202: Show VTID badge for deploy/governance events
            if (event.vtid) {
                var vtidBadge = document.createElement('div');
                vtidBadge.className = 'ticker-vtid';
                vtidBadge.textContent = event.vtid;
                vtidBadge.title = 'VTID: ' + event.vtid;
                item.appendChild(vtidBadge);
            }

            // DEV-COMHU-0202: Show SWV badge if present
            if (event.swv) {
                var swvBadge = document.createElement('div');
                swvBadge.className = 'ticker-swv';
                swvBadge.textContent = event.swv;
                swvBadge.title = 'SWV: ' + event.swv;
                item.appendChild(swvBadge);
            }

            var content = document.createElement('div');
            content.className = 'ticker-content';
            content.textContent = event.content;
            item.appendChild(content);

            // DEV-COMHU-0202: Show topic for deploy events instead of generic type
            var typeLabel = event.topic && event.topic.startsWith('deploy.') ? event.topic : event.type;
            var type = document.createElement('div');
            type.className = 'ticker-type ticker-type-' + event.type;
            type.textContent = typeLabel;
            item.appendChild(type);

            eventsList.appendChild(item);
        });

        // VTID-01210: Render collapsed heartbeat section as a single indicator line
        if (state.tickerCollapseHeartbeat && heartbeatEvents.length > 0) {
            var heartbeatSection = document.createElement('div');
            heartbeatSection.className = 'ticker-heartbeat-collapsed';

            // Get last heartbeat timestamp
            var lastHeartbeat = heartbeatEvents[0]?.timestamp || 'N/A';

            var heartbeatHeader = document.createElement('div');
            heartbeatHeader.className = 'ticker-heartbeat-header';
            heartbeatHeader.innerHTML = `
                <span class="heartbeat-icon">♡</span>
                <span class="heartbeat-count">${heartbeatEvents.length} heartbeats</span>
                <span class="heartbeat-last">(last: ${lastHeartbeat})</span>
                <button class="ticker-expand-btn">Expand ▼</button>
            `;
            heartbeatHeader.onclick = function () {
                heartbeatSection.classList.toggle('expanded');
                var btn = heartbeatHeader.querySelector('.ticker-expand-btn');
                btn.textContent = heartbeatSection.classList.contains('expanded') ? 'Collapse ▲' : 'Expand ▼';
            };
            heartbeatSection.appendChild(heartbeatHeader);

            var heartbeatList = document.createElement('div');
            heartbeatList.className = 'ticker-heartbeat-list';

            heartbeatEvents.slice(0, 10).forEach(function (event) {
                var item = document.createElement('div');
                item.className = 'ticker-item ticker-item-low ticker-item-mini';
                item.innerHTML = '<span class="ticker-timestamp">' + event.timestamp + '</span> ' + event.content;
                heartbeatList.appendChild(item);
            });

            if (heartbeatEvents.length > 10) {
                var moreNote = document.createElement('div');
                moreNote.className = 'ticker-more-note';
                moreNote.textContent = '... and ' + (heartbeatEvents.length - 10) + ' more heartbeat events';
                heartbeatList.appendChild(moreNote);
            }

            heartbeatSection.appendChild(heartbeatList);
            eventsList.appendChild(heartbeatSection);
        }
    }

    container.appendChild(eventsList);

    return container;
}

/**
 * VTID-0524: Renders the operator history tab showing deployment history
 * with VTID + SWV + status + timestamp
 */
function renderOperatorHistory() {
    const container = document.createElement('div');
    container.className = 'history-container';

    // Header
    const header = document.createElement('div');
    header.className = 'history-header';

    const title = document.createElement('span');
    title.textContent = 'Deployment History';
    header.appendChild(title);

    // SPEC-01: Per-view refresh buttons removed - use global refresh icon in header

    container.appendChild(header);

    // Content
    const content = document.createElement('div');
    content.className = 'history-content';
    content.dataset.scrollRetain = 'true';
    content.dataset.scrollKey = 'operator-history';

    if (state.historyLoading) {
        content.innerHTML = '<div class="history-loading">Loading deployment history...</div>';
    } else if (state.historyError) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'history-error';
        errorDiv.textContent = 'Error: ' + state.historyError;
        content.appendChild(errorDiv);
    } else if (!state.versionHistory || state.versionHistory.length === 0) {
        content.innerHTML = '<div class="history-empty">No deployments yet. Click Refresh to load.</div>';
        // Auto-fetch on first open if empty
        if (!state.historyLoading) {
            setTimeout(async () => {
                state.historyLoading = true;
                renderApp();
                try {
                    state.versionHistory = await fetchDeploymentHistory();
                } catch (error) {
                    state.historyError = error.message;
                } finally {
                    state.historyLoading = false;
                    renderApp();
                }
            }, 100);
        }
    } else {
        // VTID-0524 + VTID-0600: Render deployment history table with human-readable meaning
        const table = document.createElement('table');
        table.className = 'history-table';

        const thead = document.createElement('thead');
        const theadTr = document.createElement('tr');

        // VTID-0600: Added 'Summary', 'Triggered By', and 'Meaning' columns
        ['VTID', 'Service', 'SWV', 'Timestamp', 'Status', 'Summary', 'Triggered By'].forEach(function (headerText) {
            const th = document.createElement('th');
            th.textContent = headerText;
            theadTr.appendChild(th);
        });
        thead.appendChild(theadTr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        state.versionHistory.forEach(function (deploy) {
            const tr = document.createElement('tr');

            // VTID column
            const vtidTd = document.createElement('td');
            vtidTd.className = 'history-vtid';
            vtidTd.textContent = deploy.vtid || '-';
            tr.appendChild(vtidTd);

            // Service column
            const serviceTd = document.createElement('td');
            serviceTd.className = 'history-service';
            serviceTd.textContent = deploy.service || '-';
            tr.appendChild(serviceTd);

            // SWV column
            const swvTd = document.createElement('td');
            swvTd.className = 'history-swv';
            swvTd.textContent = deploy.swv || '-';
            tr.appendChild(swvTd);

            // Timestamp column
            const timeTd = document.createElement('td');
            timeTd.className = 'history-time';
            timeTd.textContent = deploy.createdAt ? new Date(deploy.createdAt).toLocaleString() : '-';
            tr.appendChild(timeTd);

            // Status column with color coding
            const statusTd = document.createElement('td');
            statusTd.className = 'history-status';
            const statusBadge = document.createElement('span');
            statusBadge.className = 'history-status-badge';
            if (deploy.status === 'success') {
                statusBadge.className += ' history-status-success';
            } else if (deploy.status === 'failure') {
                statusBadge.className += ' history-status-failed';
            }
            statusBadge.textContent = deploy.status || 'unknown';
            statusTd.appendChild(statusBadge);
            tr.appendChild(statusTd);

            // VTID-0600: Event Summary column (derived from VTID and service)
            const summaryTd = document.createElement('td');
            summaryTd.className = 'history-summary';
            var summary = generateDeploySummary(deploy);
            summaryTd.textContent = summary;
            tr.appendChild(summaryTd);

            // VTID-0600: Triggered By column
            const triggeredByTd = document.createElement('td');
            triggeredByTd.className = 'history-triggered-by';
            var triggeredBy = deploy.initiator || 'user';
            var triggeredByBadge = document.createElement('span');
            triggeredByBadge.className = 'history-trigger-badge history-trigger-' + triggeredBy.toLowerCase();
            triggeredByBadge.textContent = triggeredBy === 'agent' ? 'CI/CD' : 'User';
            triggeredByTd.appendChild(triggeredByBadge);
            tr.appendChild(triggeredByTd);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        content.appendChild(table);
    }

    container.appendChild(content);
    return container;
}

/**
 * Upload file for operator chat
 */
async function uploadOperatorFile(file, kind) {
    console.log('[Operator] Uploading file:', file.name, kind);

    try {
        const response = await fetch('/api/v1/operator/upload', {
            method: 'POST',
            headers: buildContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                name: file.name,
                kind: kind,
                content_type: file.type || 'application/octet-stream'
            })
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Operator] File uploaded:', result);

        // Add to chat attachments
        state.chatAttachments.push({
            oasis_ref: result.oasis_ref,
            kind: kind,
            name: result.name
        });

        renderApp();

    } catch (error) {
        console.error('[Operator] Upload error:', error);
        alert('Failed to upload file: ' + error.message);
    }
}

// ---------------------------------------------------------------------------
// 11. fetchOperatorTaskQueue — GET /api/v1/tasks?status=pending,in_progress
// ---------------------------------------------------------------------------
async function fetchOperatorTaskQueue() {
    if (state.operatorTaskQueue.loading) return;
    state.operatorTaskQueue.loading = true;
    state.operatorTaskQueue.error = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/tasks?status=pending,in_progress,scheduled,blocked,failed&limit=50');
        if (!response.ok) throw new Error('Task queue fetch failed: ' + response.status);

        var data = await response.json();
        var items = data.data || data.tasks || (Array.isArray(data) ? data : []);
        state.operatorTaskQueue.items = items;
        state.operatorTaskQueue.fetched = true;
        state.operatorTaskQueue.error = null;
        console.log('[Supervision] Operator task queue loaded:', items.length);
    } catch (error) {
        console.error('[VTID-01240] Failed to fetch operator task queue:', error);
        state.operatorTaskQueue.error = error.message;
    } finally {
        state.operatorTaskQueue.loading = false;
        renderApp();
    }
}

// ---------------------------------------------------------------------------
// 12. renderOperatorTaskQueueView — task queue table with clickable rows
// ---------------------------------------------------------------------------
function renderOperatorTaskQueueView() {
    var container = document.createElement('div');
    container.className = 'operator-task-queue-container';

    // Auto-fetch
    if (!state.operatorTaskQueue.fetched && !state.operatorTaskQueue.loading) {
        fetchOperatorTaskQueue();
    }

    // Loading
    if (state.operatorTaskQueue.loading && state.operatorTaskQueue.items.length === 0) {
        var loading = document.createElement('div');
        loading.className = 'placeholder-content';
        loading.textContent = 'Loading task queue...';
        container.appendChild(loading);
        return container;
    }

    // Error
    if (state.operatorTaskQueue.error) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'placeholder-content error-text';
        errorDiv.textContent = 'Error: ' + state.operatorTaskQueue.error;
        container.appendChild(errorDiv);
        return container;
    }

    // Empty
    if (state.operatorTaskQueue.items.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'placeholder-content';
        emptyDiv.textContent = 'No active tasks found.';
        container.appendChild(emptyDiv);
        return container;
    }

    // Header
    var header = document.createElement('div');
    header.className = 'list-toolbar';
    var title = document.createElement('span');
    title.className = 'toolbar-title';
    title.textContent = 'Task Queue (' + state.operatorTaskQueue.items.length + ')';
    header.appendChild(title);

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-sm';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = function () {
        state.operatorTaskQueue.fetched = false;
        fetchOperatorTaskQueue();
    };
    header.appendChild(refreshBtn);
    container.appendChild(header);

    // Status filter buttons
    var filterBar = document.createElement('div');
    filterBar.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;';
    var filters = [
        { key: 'all', label: 'All' },
        { key: 'scheduled', label: 'Scheduled' },
        { key: 'in_progress', label: 'In Progress' },
        { key: 'pending', label: 'Pending' },
        { key: 'blocked', label: 'Blocked' },
        { key: 'failed', label: 'Failed' }
    ];
    filters.forEach(function (f) {
        var btn = document.createElement('button');
        btn.className = 'btn btn-sm' + (state.operatorTaskQueue.statusFilter === f.key ? ' btn-primary' : '');
        btn.textContent = f.label;
        btn.onclick = function () {
            state.operatorTaskQueue.statusFilter = f.key;
            renderApp();
        };
        filterBar.appendChild(btn);
    });
    container.appendChild(filterBar);

    // Filter items
    var displayItems = state.operatorTaskQueue.items;
    if (state.operatorTaskQueue.statusFilter !== 'all') {
        displayItems = displayItems.filter(function (task) {
            return (task.status || '').toLowerCase() === state.operatorTaskQueue.statusFilter;
        });
    }

    if (displayItems.length === 0) {
        var noMatch = document.createElement('div');
        noMatch.className = 'placeholder-content';
        noMatch.textContent = 'No tasks matching filter "' + state.operatorTaskQueue.statusFilter + '".';
        container.appendChild(noMatch);
        return container;
    }

    // Table
    var table = document.createElement('table');
    table.className = 'list-table';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    ['VTID', 'Title', 'Status', 'Spec', 'Role', 'Updated'].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    displayItems.forEach(function (task) {
        var row = document.createElement('tr');
        row.className = 'clickable-row';
        if (state.selectedTask && state.selectedTask.vtid === task.vtid) {
            row.className += ' selected';
        }
        makeClickable(row, function () {
            state.selectedTask = task;
            state.selectedTaskDetail = null;
            state.selectedTaskDetailLoading = true;
            state.executionStatus = null;
            state.executionStatusLoading = false;
            renderApp();
            fetchVtidDetail(task.vtid);
        }, { label: 'View task details: ' + (task.vtid || task.title || 'task') });
        row.style.cursor = 'pointer';

        var vtidTd = document.createElement('td');
        vtidTd.className = 'vtid-cell';
        vtidTd.textContent = task.vtid || '';
        row.appendChild(vtidTd);

        var titleTd = document.createElement('td');
        titleTd.textContent = task.title || task.vtid || '';
        row.appendChild(titleTd);

        var statusTd = document.createElement('td');
        var statusBadge = document.createElement('span');
        statusBadge.className = 'status-badge status-' + (task.status || 'pending').toLowerCase();
        statusBadge.textContent = task.status || 'pending';
        statusTd.appendChild(statusBadge);
        row.appendChild(statusTd);

        var specTd = document.createElement('td');
        var specStatus = task.spec_status || 'missing';
        var specBadge = document.createElement('span');
        specBadge.className = 'status-badge status-' + specStatus.toLowerCase();
        specBadge.textContent = specStatus;
        specTd.appendChild(specBadge);
        row.appendChild(specTd);

        var roleTd = document.createElement('td');
        var roles = task.target_roles || task.target_role || [];
        if (typeof roles === 'string') roles = [roles];
        roleTd.textContent = Array.isArray(roles) ? roles.join(', ') : '';
        row.appendChild(roleTd);

        var updatedTd = document.createElement('td');
        updatedTd.textContent = formatEventTimestamp(task.updated_at || task.created_at);
        row.appendChild(updatedTd);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    container.appendChild(table);

    return container;
}

// ---------------------------------------------------------------------------
// 13. fetchOperatorDashboard — composite fetch for supervision dashboard
// ---------------------------------------------------------------------------
async function fetchOperatorDashboard() {
    if (state.operatorDashboard.loading) return;
    state.operatorDashboard.loading = true;
    state.operatorDashboard.error = null;
    renderApp();

    try {
        var results = await Promise.allSettled([
            // VTID-04887: the admin-gated in-process route. The service-token
            // /api/v1/autopilot/pipeline/summary always answered 401 here.
            fetch('/api/v1/ops/pipeline-summary', {
                headers: buildContextHeaders({ Accept: 'application/json' })
            }).then(function (r) {
                if (!r.ok) throw new Error('Pipeline summary: ' + r.status);
                return r.json();
            }),
            fetch('/api/v1/operator/heartbeat').then(function (r) {
                if (!r.ok) throw new Error('Heartbeat: ' + r.status);
                return r.json();
            }),
            fetch('/api/v1/approvals/pending?limit=5').then(function (r) {
                if (!r.ok) throw new Error('Approvals: ' + r.status);
                return r.json();
            })
        ]);

        var pipeline = results[0].status === 'fulfilled' ? results[0].value : null;
        var heartbeat = results[1].status === 'fulfilled' ? results[1].value : null;
        var approvals = results[2].status === 'fulfilled' ? results[2].value : null;

        state.operatorDashboard.data = {
            pipeline: pipeline,
            heartbeat: heartbeat,
            approvals: approvals
        };
        state.operatorDashboard.fetched = true;
        state.operatorDashboard.error = null;
        console.log('[Supervision] Dashboard loaded');
    } catch (error) {
        console.error('[Supervision] Dashboard fetch error:', error);
        state.operatorDashboard.error = error.message;
    } finally {
        state.operatorDashboard.loading = false;
        renderApp();
    }
}

// ---------------------------------------------------------------------------
// 14. renderOperatorDashboardView — supervision dashboard landing page
// ---------------------------------------------------------------------------
function renderOperatorDashboardView() {
    var container = document.createElement('div');
    container.className = 'operator-dashboard-container';

    // Auto-fetch
    if (!state.operatorDashboard.fetched && !state.operatorDashboard.loading) {
        fetchOperatorDashboard();
    }

    // Loading
    if (state.operatorDashboard.loading && !state.operatorDashboard.data) {
        var spinnerWrap = document.createElement('div');
        spinnerWrap.className = 'attention-spinner-container';
        var spinner = document.createElement('div');
        spinner.className = 'attention-spinner';
        spinnerWrap.appendChild(spinner);
        var spinText = document.createElement('div');
        spinText.className = 'attention-spinner-text';
        spinText.textContent = 'Loading supervision dashboard\u2026';
        spinnerWrap.appendChild(spinText);
        container.appendChild(spinnerWrap);
        return container;
    }

    // Error
    if (state.operatorDashboard.error && !state.operatorDashboard.data) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'placeholder-content error-text';
        errorDiv.textContent = 'Error: ' + state.operatorDashboard.error;
        container.appendChild(errorDiv);
        return container;
    }

    var dashData = state.operatorDashboard.data || {};
    var pipeline = dashData.pipeline || {};
    var heartbeat = dashData.heartbeat || {};
    var approvals = dashData.approvals || {};

    // Header
    var header = document.createElement('div');
    header.className = 'list-toolbar';
    var titleEl = document.createElement('span');
    titleEl.className = 'toolbar-title';
    titleEl.textContent = 'Supervision Dashboard';
    header.appendChild(titleEl);

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-sm';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = function () {
        state.operatorDashboard.fetched = false;
        fetchOperatorDashboard();
    };
    header.appendChild(refreshBtn);
    container.appendChild(header);

    // ── A. Operational Readiness Strip ──
    var readinessSection = document.createElement('div');
    readinessSection.className = 'pipeline-middle-row';
    readinessSection.style.cssText = 'display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;';

    var readinessItems = [
        { label: 'Autopilot Loop', value: pipeline.loop_running, type: 'bool' },
        { label: 'Execution Armed', value: pipeline.execution_armed, type: 'bool' },
        { label: 'Workers Active', value: pipeline.workers_active, type: 'bool' },
        { label: 'Success Rate', value: pipeline.success_rate, type: 'percent' }
    ];

    readinessItems.forEach(function (item) {
        var card = document.createElement('div');
        card.style.cssText = 'background:#1e293b;border-radius:8px;padding:12px 16px;flex:1;min-width:140px;text-align:center;';

        if (item.type === 'bool') {
            var dot = document.createElement('div');
            dot.className = 'health-dot';
            dot.style.cssText = 'width:12px;height:12px;border-radius:50%;display:inline-block;margin-right:8px;background:' +
                (item.value ? '#10b981' : '#ef4444') + ';';
            card.appendChild(dot);

            var label = document.createElement('span');
            label.style.color = '#94a3b8';
            label.textContent = item.label;
            card.appendChild(label);

            var status = document.createElement('div');
            status.style.cssText = 'font-size:13px;margin-top:4px;color:' + (item.value ? '#10b981' : '#ef4444') + ';';
            status.textContent = item.value ? 'Active' : 'Inactive';
            card.appendChild(status);
        } else {
            var pctLabel = document.createElement('div');
            pctLabel.style.color = '#94a3b8';
            pctLabel.textContent = item.label;
            card.appendChild(pctLabel);

            var pctVal = document.createElement('div');
            var rate = typeof item.value === 'number' ? item.value : 0;
            pctVal.style.cssText = 'font-size:24px;font-weight:bold;color:' +
                (rate >= 80 ? '#10b981' : rate >= 50 ? '#f59e0b' : '#ef4444') + ';';
            pctVal.textContent = rate + '%';
            card.appendChild(pctVal);
        }

        readinessSection.appendChild(card);
    });

    container.appendChild(readinessSection);

    // ── B. Pipeline Funnel ──
    var funnel = pipeline.funnel || {};
    var funnelSection = document.createElement('div');
    funnelSection.className = 'pipeline-funnel';

    var funnelStages = [
        { key: 'scheduled', label: 'Scheduled', color: '#3b82f6' },
        { key: 'in_progress', label: 'In Progress', color: '#f59e0b' },
        { key: 'completed', label: 'Completed', color: '#10b981' }
    ];

    funnelStages.forEach(function (stage, idx) {
        var stageEl = document.createElement('div');
        stageEl.className = 'funnel-stage';
        stageEl.style.borderTopColor = stage.color;

        var countEl = document.createElement('div');
        countEl.className = 'funnel-count';
        countEl.textContent = String(funnel[stage.key] || 0);
        countEl.style.color = stage.color;

        var labelEl = document.createElement('div');
        labelEl.className = 'funnel-label';
        labelEl.textContent = stage.label;

        stageEl.appendChild(countEl);
        stageEl.appendChild(labelEl);
        funnelSection.appendChild(stageEl);

        if (idx < funnelStages.length - 1) {
            var arrow = document.createElement('div');
            arrow.className = 'funnel-arrow';
            arrow.textContent = '\u2192';
            funnelSection.appendChild(arrow);
        }
    });

    container.appendChild(funnelSection);

    // Sub-counts
    var subCounts = document.createElement('div');
    subCounts.className = 'funnel-sub-counts';

    var subItems = [
        { label: 'Broken', count: funnel.broken || 0, color: '#ef4444' },
        { label: 'Stuck', count: funnel.stuck || 0, color: '#f59e0b' },
        { label: 'Rejected', count: funnel.rejected || 0, color: '#6b7280' }
    ];

    subItems.forEach(function (item) {
        var badge = document.createElement('span');
        badge.className = 'funnel-sub-badge';
        badge.style.color = item.color;
        badge.style.borderColor = item.color;
        badge.textContent = item.label + ': ' + item.count;
        subCounts.appendChild(badge);
    });

    container.appendChild(subCounts);

    // ── C. Needs Your Action ──
    var actionSection = document.createElement('div');
    actionSection.style.cssText = 'display:flex;gap:12px;margin:16px 0;flex-wrap:wrap;';

    var attQueue = (pipeline.attention_queue || []);
    var approvalCount = 0;
    if (approvals.data) approvalCount = approvals.data.length;
    else if (approvals.items) approvalCount = approvals.items.length;
    else if (Array.isArray(approvals)) approvalCount = approvals.length;
    var recsCount = (pipeline.recommendations || []).length;

    var actionCards = [
        { label: 'Approvals Pending', count: approvalCount, color: '#f59e0b', tab: 'deployments' },
        { label: 'Attention Items', count: attQueue.length, color: '#ef4444', tab: 'runbook' },
        { label: 'Recommendations', count: recsCount, color: '#3b82f6', tab: 'runbook' }
    ];

    actionCards.forEach(function (card) {
        var el = document.createElement('div');
        el.style.cssText = 'background:#1e293b;border-radius:8px;padding:16px;flex:1;min-width:160px;cursor:pointer;border-left:3px solid ' + card.color + ';';
        el.onclick = function () {
            var section = NAVIGATION_CONFIG.find(function (s) { return s.section === 'operator'; });
            if (section) {
                var t = section.tabs.find(function (t) { return t.key === card.tab; });
                if (t && t.path) {
                    history.pushState(null, '', t.path);
                    renderApp();
                }
            }
        };

        var countEl = document.createElement('div');
        countEl.style.cssText = 'font-size:28px;font-weight:bold;color:' + card.color + ';';
        countEl.textContent = String(card.count);
        el.appendChild(countEl);

        var labelEl = document.createElement('div');
        labelEl.style.cssText = 'color:#94a3b8;font-size:13px;margin-top:4px;';
        labelEl.textContent = card.label;
        el.appendChild(labelEl);

        actionSection.appendChild(el);
    });

    container.appendChild(actionSection);

    // ── D. Attention Queue (top 5) ──
    var attTitle = document.createElement('div');
    attTitle.className = 'section-title';
    attTitle.textContent = attQueue.length > 0
        ? 'Attention Queue (' + attQueue.length + ')'
        : 'Attention Queue \u2014 All Clear';
    container.appendChild(attTitle);

    var severityColors = { BROKEN: '#ef4444', STUCK: '#f59e0b', BLOCKED: '#6b7280', NEW: '#3b82f6' };

    if (attQueue.length === 0) {
        var allClear = document.createElement('div');
        allClear.className = 'attention-all-clear';
        allClear.textContent = 'No tasks need immediate attention. System is running smoothly.';
        container.appendChild(allClear);
    } else {
        var displayQueue = attQueue.slice(0, 5);
        displayQueue.forEach(function (item) {
            var card = document.createElement('div');
            card.className = 'attention-item';
            card.style.borderLeftColor = severityColors[item.severity] || '#6b7280';

            var topRow = document.createElement('div');
            topRow.className = 'attention-item-top';

            var badge = document.createElement('span');
            badge.className = 'severity-badge';
            badge.style.backgroundColor = severityColors[item.severity] || '#6b7280';
            badge.textContent = item.severity;

            var vtidEl = document.createElement('span');
            vtidEl.className = 'attention-vtid';
            vtidEl.textContent = item.vtid;

            var titleSpan = document.createElement('span');
            titleSpan.className = 'attention-title';
            titleSpan.textContent = item.title || '';

            topRow.appendChild(badge);
            topRow.appendChild(vtidEl);
            topRow.appendChild(titleSpan);

            var bottomRow = document.createElement('div');
            bottomRow.className = 'attention-item-bottom';

            var reasonEl = document.createElement('span');
            reasonEl.textContent = item.reason || '';
            bottomRow.appendChild(reasonEl);

            if (item.stuck_minutes) {
                var timeEl = document.createElement('span');
                timeEl.className = 'attention-time';
                var mins = item.stuck_minutes;
                timeEl.textContent = mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm';
                bottomRow.appendChild(timeEl);
            }

            var viewBtn = document.createElement('button');
            viewBtn.className = 'btn btn-sm';
            viewBtn.textContent = 'View Task';
            viewBtn.onclick = function (e) {
                e.stopPropagation();
                state.selectedTask = {
                    vtid: item.vtid,
                    title: item.title,
                    status: item.status || 'scheduled',
                    spec_status: item.spec_status || 'missing',
                    summary: item.reason || '',
                    oasisColumn: '',
                    _attentionContext: {
                        severity: item.severity,
                        reason: item.reason,
                        stuck_minutes: item.stuck_minutes
                    }
                };
                state.selectedTaskDetail = null;
                state.selectedTaskDetailLoading = true;
                state.executionStatus = null;
                state.executionStatusLoading = false;
                renderApp();
                fetchVtidDetail(item.vtid);
            };

            card.appendChild(topRow);
            card.appendChild(bottomRow);
            card.appendChild(viewBtn);
            container.appendChild(card);
        });

        if (attQueue.length > 5) {
            var viewAll = document.createElement('div');
            viewAll.style.cssText = 'text-align:center;margin-top:8px;';
            var viewAllBtn = document.createElement('button');
            viewAllBtn.className = 'btn btn-sm';
            viewAllBtn.textContent = 'View all ' + attQueue.length + ' items in Runbook';
            viewAllBtn.onclick = function () {
                var section = NAVIGATION_CONFIG.find(function (s) { return s.section === 'operator'; });
                if (section) {
                    var t = section.tabs.find(function (t) { return t.key === 'runbook'; });
                    if (t && t.path) {
                        history.pushState(null, '', t.path);
                        renderApp();
                    }
                }
            };
            viewAll.appendChild(viewAllBtn);
            container.appendChild(viewAll);
        }
    }

    return container;
}

async function fetchOperatorEventStream() {
    if (state.operatorEventStream.loading) return;
    var isInitialLoad = !state.operatorEventStream.fetched;
    state.operatorEventStream.loading = true;
    state.operatorEventStream.error = null;
    if (isInitialLoad) renderApp();

    try {
        var response = await fetch('/api/v1/oasis/events?limit=100');
        if (!response.ok) throw new Error('Events fetch failed: ' + response.status);

        var data = await response.json();
        var items = data.data || data.events || (Array.isArray(data) ? data : []);
        state.operatorEventStream.items = items;
        state.operatorEventStream.fetched = true;
        state.operatorEventStream.error = null;
        console.log('[Supervision] Event stream loaded:', items.length);
    } catch (error) {
        console.error('[Supervision] Event stream fetch error:', error);
        state.operatorEventStream.error = error.message;
    } finally {
        state.operatorEventStream.loading = false;
        if (isInitialLoad) {
            renderApp();
        } else {
            refreshOperatorContent();
        }
    }
}

function startOperatorEventStreamRefresh() {
    if (_operatorEventStreamInterval) return;
    _operatorEventStreamInterval = setInterval(function () {
        fetchOperatorEventStream();
    }, 30000);
}

// ---------------------------------------------------------------------------
// 16. renderOperatorEventStreamView — OASIS event feed
// ---------------------------------------------------------------------------
function renderOperatorEventStreamView() {
    var container = document.createElement('div');
    container.className = 'operator-event-stream-container';

    // Auto-fetch + start auto-refresh
    if (!state.operatorEventStream.fetched && !state.operatorEventStream.loading) {
        fetchOperatorEventStream();
        startOperatorEventStreamRefresh();
    } else if (!_operatorEventStreamInterval) {
        startOperatorEventStreamRefresh();
    }

    // Loading
    if (state.operatorEventStream.loading && state.operatorEventStream.items.length === 0) {
        var spinnerWrap = document.createElement('div');
        spinnerWrap.className = 'attention-spinner-container';
        var spinner = document.createElement('div');
        spinner.className = 'attention-spinner';
        spinnerWrap.appendChild(spinner);
        var spinText = document.createElement('div');
        spinText.className = 'attention-spinner-text';
        spinText.textContent = 'Loading event stream\u2026';
        spinnerWrap.appendChild(spinText);
        container.appendChild(spinnerWrap);
        return container;
    }

    // Error
    if (state.operatorEventStream.error && state.operatorEventStream.items.length === 0) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'placeholder-content error-text';
        errorDiv.textContent = 'Error: ' + state.operatorEventStream.error;
        container.appendChild(errorDiv);
        return container;
    }

    // Header
    var header = document.createElement('div');
    header.className = 'list-toolbar';
    var titleEl = document.createElement('span');
    titleEl.className = 'toolbar-title';
    titleEl.textContent = 'Event Stream (' + state.operatorEventStream.items.length + ')';
    header.appendChild(titleEl);

    var autoLabel = document.createElement('span');
    autoLabel.style.cssText = 'color:#10b981;font-size:12px;margin-right:8px;';
    autoLabel.textContent = 'Auto-refresh 30s';
    header.appendChild(autoLabel);

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-sm';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = function () {
        fetchOperatorEventStream();
    };
    header.appendChild(refreshBtn);
    container.appendChild(header);

    // Domain filter buttons
    var filterBar = document.createElement('div');
    filterBar.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;';

    var domainColors = {
        'all': '#94a3b8',
        'cicd': '#3b82f6',
        'operator': '#10b981',
        'vtid': '#8b5cf6',
        'deploy': '#f59e0b',
        'governance': '#ef4444',
        'autopilot': '#06b6d4'
    };

    var domainFilters = ['all', 'cicd', 'operator', 'vtid', 'deploy', 'governance', 'autopilot'];
    domainFilters.forEach(function (d) {
        var btn = document.createElement('button');
        btn.className = 'btn btn-sm' + (state.operatorEventStream.domainFilter === d ? ' btn-primary' : '');
        btn.textContent = d === 'all' ? 'All' : d;
        if (d !== 'all') {
            btn.style.borderLeft = '3px solid ' + (domainColors[d] || '#94a3b8');
        }
        btn.onclick = function () {
            state.operatorEventStream.domainFilter = d;
            renderApp();
        };
        filterBar.appendChild(btn);
    });
    container.appendChild(filterBar);

    // Filter items by domain
    var displayItems = state.operatorEventStream.items;
    if (state.operatorEventStream.domainFilter !== 'all') {
        var filterDomain = state.operatorEventStream.domainFilter;
        displayItems = displayItems.filter(function (ev) {
            var topic = (ev.topic || ev.type || '').toLowerCase();
            return topic.startsWith(filterDomain);
        });
    }

    if (displayItems.length === 0) {
        var noMatch = document.createElement('div');
        noMatch.className = 'placeholder-content';
        noMatch.textContent = 'No events matching filter "' + state.operatorEventStream.domainFilter + '".';
        container.appendChild(noMatch);
        return container;
    }

    // Table — uses oasis-events-table CSS for consistent sizing
    var table = document.createElement('table');
    table.className = 'list-table oasis-events-table';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    ['Time', 'VTID', 'Topic', 'Status', 'Message'].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    displayItems.forEach(function (ev) {
        var row = document.createElement('tr');

        var timeTd = document.createElement('td');
        timeTd.className = 'event-timestamp';
        timeTd.textContent = formatEventTimestamp(ev.created_at || ev.timestamp);
        row.appendChild(timeTd);

        var vtidTd = document.createElement('td');
        vtidTd.className = 'event-vtid';
        if (ev.vtid) {
            var vtidLink = document.createElement('span');
            vtidLink.className = 'vtid-link';
            vtidLink.textContent = ev.vtid;
            vtidLink.onclick = function (e) {
                e.stopPropagation();
                state.selectedTask = { vtid: ev.vtid, title: '', status: 'unknown' };
                state.selectedTaskDetail = null;
                state.selectedTaskDetailLoading = true;
                renderApp();
                fetchVtidDetail(ev.vtid);
            };
            vtidTd.appendChild(vtidLink);
        } else {
            vtidTd.textContent = '-';
        }
        row.appendChild(vtidTd);

        var topicTd = document.createElement('td');
        topicTd.className = 'event-topic';
        topicTd.textContent = ev.topic || ev.type || '';
        row.appendChild(topicTd);

        var statusTd = document.createElement('td');
        var statusBadge = document.createElement('span');
        statusBadge.className = 'status-badge status-' + (ev.status || 'info').toLowerCase();
        statusBadge.textContent = ev.status || 'info';
        statusTd.appendChild(statusBadge);
        row.appendChild(statusTd);

        var msgTd = document.createElement('td');
        msgTd.className = 'event-message';
        var msgText = (ev.message || '');
        msgTd.textContent = msgText.length > 80 ? msgText.substring(0, 80) + '...' : msgText;
        row.appendChild(msgTd);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    container.appendChild(table);

    return container;
}

// ---------------------------------------------------------------------------
// 17. fetchOperatorDeployments — deployments + pending approvals
// ---------------------------------------------------------------------------
async function fetchOperatorDeployments() {
    if (state.operatorDeployments.loading) return;
    state.operatorDeployments.loading = true;
    state.operatorDeployments.error = null;
    renderApp();

    try {
        var results = await Promise.allSettled([
            fetch('/api/v1/operator/deployments?limit=20').then(function (r) {
                if (!r.ok) throw new Error('Deployments: ' + r.status);
                return r.json();
            }),
            fetch('/api/v1/approvals/pending?limit=20').then(function (r) {
                if (!r.ok) throw new Error('Approvals: ' + r.status);
                return r.json();
            })
        ]);

        var deploys = results[0].status === 'fulfilled' ? results[0].value : { data: [] };
        var approvalsData = results[1].status === 'fulfilled' ? results[1].value : { data: [] };

        state.operatorDeployments.deployments = deploys.data || deploys.deployments || (Array.isArray(deploys) ? deploys : []);
        state.operatorDeployments.approvals = approvalsData.data || approvalsData.items || (Array.isArray(approvalsData) ? approvalsData : []);
        state.operatorDeployments.fetched = true;
        state.operatorDeployments.error = null;
        console.log('[Supervision] Deployments loaded:', state.operatorDeployments.deployments.length, 'deploys,', state.operatorDeployments.approvals.length, 'approvals');
    } catch (error) {
        console.error('[Supervision] Deployments fetch error:', error);
        state.operatorDeployments.error = error.message;
    } finally {
        state.operatorDeployments.loading = false;
        renderApp();
    }
}

// ---------------------------------------------------------------------------
// 18. renderOperatorDeploymentsView — approvals + deployment history
// ---------------------------------------------------------------------------
function renderOperatorDeploymentsView() {
    var container = document.createElement('div');
    container.className = 'operator-deployments-container';

    // Auto-fetch
    if (!state.operatorDeployments.fetched && !state.operatorDeployments.loading) {
        fetchOperatorDeployments();
    }

    // Loading
    if (state.operatorDeployments.loading && state.operatorDeployments.deployments.length === 0 && state.operatorDeployments.approvals.length === 0) {
        var spinnerWrap = document.createElement('div');
        spinnerWrap.className = 'attention-spinner-container';
        var spinner = document.createElement('div');
        spinner.className = 'attention-spinner';
        spinnerWrap.appendChild(spinner);
        var spinText = document.createElement('div');
        spinText.className = 'attention-spinner-text';
        spinText.textContent = 'Loading deployments\u2026';
        spinnerWrap.appendChild(spinText);
        container.appendChild(spinnerWrap);
        return container;
    }

    // Error
    if (state.operatorDeployments.error && state.operatorDeployments.deployments.length === 0) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'placeholder-content error-text';
        errorDiv.textContent = 'Error: ' + state.operatorDeployments.error;
        container.appendChild(errorDiv);
        return container;
    }

    // Header
    var header = document.createElement('div');
    header.className = 'list-toolbar';
    var titleEl = document.createElement('span');
    titleEl.className = 'toolbar-title';
    titleEl.textContent = 'Deployments & Approvals';
    header.appendChild(titleEl);

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-sm';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = function () {
        state.operatorDeployments.fetched = false;
        fetchOperatorDeployments();
    };
    header.appendChild(refreshBtn);
    container.appendChild(header);

    // ── A. Pending Approvals ──
    var apprSection = document.createElement('div');
    var apprTitle = document.createElement('div');
    apprTitle.className = 'section-title';
    apprTitle.textContent = 'Pending Approvals (' + state.operatorDeployments.approvals.length + ')';
    apprSection.appendChild(apprTitle);

    if (state.operatorDeployments.approvals.length === 0) {
        var noAppr = document.createElement('div');
        noAppr.className = 'attention-all-clear';
        noAppr.textContent = 'No approvals pending.';
        apprSection.appendChild(noAppr);
    } else {
        state.operatorDeployments.approvals.forEach(function (appr) {
            var card = document.createElement('div');
            card.className = 'attention-item';
            card.style.borderLeftColor = '#f59e0b';

            var topRow = document.createElement('div');
            topRow.className = 'attention-item-top';

            var vtidEl = document.createElement('span');
            vtidEl.className = 'attention-vtid';
            vtidEl.textContent = appr.vtid || 'PR #' + (appr.pr_number || '?');
            topRow.appendChild(vtidEl);

            var titleSpan = document.createElement('span');
            titleSpan.className = 'attention-title';
            titleSpan.textContent = appr.pr_title || appr.title || '';
            topRow.appendChild(titleSpan);

            card.appendChild(topRow);

            var bottomRow = document.createElement('div');
            bottomRow.className = 'attention-item-bottom';

            if (appr.ci_status) {
                var ciBadge = document.createElement('span');
                ciBadge.className = 'status-badge status-' + (appr.ci_status === 'pass' ? 'success' : appr.ci_status).toLowerCase();
                ciBadge.textContent = 'CI: ' + appr.ci_status;
                bottomRow.appendChild(ciBadge);
            }

            if (appr.governance_status) {
                var govBadge = document.createElement('span');
                govBadge.className = 'status-badge status-' + (appr.governance_status === 'pass' ? 'success' : appr.governance_status).toLowerCase();
                govBadge.style.marginLeft = '6px';
                govBadge.textContent = 'Gov: ' + appr.governance_status;
                bottomRow.appendChild(govBadge);
            }

            card.appendChild(bottomRow);
            apprSection.appendChild(card);
        });
    }

    container.appendChild(apprSection);

    // ── B. Recent Deployments ──
    var deplSection = document.createElement('div');
    deplSection.style.marginTop = '20px';

    var deplTitle = document.createElement('div');
    deplTitle.className = 'section-title';
    deplTitle.textContent = 'Recent Deployments (' + state.operatorDeployments.deployments.length + ')';
    deplSection.appendChild(deplTitle);

    if (state.operatorDeployments.deployments.length === 0) {
        var noDepl = document.createElement('div');
        noDepl.className = 'placeholder-content';
        noDepl.textContent = 'No recent deployments found.';
        deplSection.appendChild(noDepl);
    } else {
        var table = document.createElement('table');
        table.className = 'list-table oasis-events-table';

        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        ['Service', 'Commit', 'Status', 'Env', 'Initiator', 'Time'].forEach(function (h) {
            var th = document.createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        state.operatorDeployments.deployments.forEach(function (d) {
            var row = document.createElement('tr');

            var svcTd = document.createElement('td');
            svcTd.textContent = d.service || '';
            row.appendChild(svcTd);

            var commitTd = document.createElement('td');
            commitTd.className = 'event-vtid';
            commitTd.textContent = (d.git_commit || '').substring(0, 7);
            row.appendChild(commitTd);

            var statusTd = document.createElement('td');
            var statusBadge = document.createElement('span');
            statusBadge.className = 'status-badge status-' + (d.status || 'pending').toLowerCase();
            statusBadge.textContent = d.status || 'pending';
            statusTd.appendChild(statusBadge);
            row.appendChild(statusTd);

            var envTd = document.createElement('td');
            envTd.textContent = d.environment || '';
            row.appendChild(envTd);

            var initTd = document.createElement('td');
            initTd.textContent = d.initiator || '';
            row.appendChild(initTd);

            var timeTd = document.createElement('td');
            timeTd.className = 'event-timestamp';
            timeTd.textContent = formatEventTimestamp(d.created_at);
            row.appendChild(timeTd);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        deplSection.appendChild(table);
    }

    container.appendChild(deplSection);

    return container;
}

// ---------------------------------------------------------------------------
// 19. fetchOperatorRunbook — attention queue + recommendations
// ---------------------------------------------------------------------------
async function fetchOperatorRunbook() {
    if (state.operatorRunbook.loading) return;
    state.operatorRunbook.loading = true;
    state.operatorRunbook.error = null;
    renderApp();

    try {
        var results = await Promise.allSettled([
            // VTID-04887: the admin-gated in-process route. The service-token
            // /api/v1/autopilot/pipeline/summary always answered 401 here.
            fetch('/api/v1/ops/pipeline-summary', {
                headers: buildContextHeaders({ Accept: 'application/json' })
            }).then(function (r) {
                if (!r.ok) throw new Error('Pipeline summary: ' + r.status);
                return r.json();
            }),
            fetch('/api/v1/autopilot/recommendations?status=new&limit=20', {
                headers: buildContextHeaders({})
            }).then(function (r) {
                if (!r.ok) throw new Error('Recommendations: ' + r.status);
                return r.json();
            })
        ]);

        var pipelineSummary = results[0].status === 'fulfilled' ? results[0].value : {};
        var recsData = results[1].status === 'fulfilled' ? results[1].value : {};

        state.operatorRunbook.attention = pipelineSummary.attention_queue || [];
        state.operatorRunbook.recommendations = recsData.data || recsData.recommendations || (Array.isArray(recsData) ? recsData : []);
        state.operatorRunbook.fetched = true;
        state.operatorRunbook.error = null;
        console.log('[Supervision] Runbook loaded:', state.operatorRunbook.attention.length, 'attention,', state.operatorRunbook.recommendations.length, 'recs');
    } catch (error) {
        console.error('[Supervision] Runbook fetch error:', error);
        state.operatorRunbook.error = error.message;
    } finally {
        state.operatorRunbook.loading = false;
        renderApp();
    }
}

// ---------------------------------------------------------------------------
// 20. renderOperatorRunbookView — attention queue + recommendations
// ---------------------------------------------------------------------------
function renderOperatorRunbookView() {
    var container = document.createElement('div');
    container.className = 'operator-runbook-container';

    // Auto-fetch
    if (!state.operatorRunbook.fetched && !state.operatorRunbook.loading) {
        fetchOperatorRunbook();
    }

    // Loading
    if (state.operatorRunbook.loading && state.operatorRunbook.attention.length === 0 && state.operatorRunbook.recommendations.length === 0) {
        var spinnerWrap = document.createElement('div');
        spinnerWrap.className = 'attention-spinner-container';
        var spinner = document.createElement('div');
        spinner.className = 'attention-spinner';
        spinnerWrap.appendChild(spinner);
        var spinText = document.createElement('div');
        spinText.className = 'attention-spinner-text';
        spinText.textContent = 'Loading runbook\u2026';
        spinnerWrap.appendChild(spinText);
        container.appendChild(spinnerWrap);
        return container;
    }

    // Error
    if (state.operatorRunbook.error && state.operatorRunbook.attention.length === 0) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'placeholder-content error-text';
        errorDiv.textContent = 'Error: ' + state.operatorRunbook.error;
        container.appendChild(errorDiv);
        return container;
    }

    // Header
    var header = document.createElement('div');
    header.className = 'list-toolbar';
    var titleEl = document.createElement('span');
    titleEl.className = 'toolbar-title';
    titleEl.textContent = 'Runbook';
    header.appendChild(titleEl);

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-sm';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = function () {
        state.operatorRunbook.fetched = false;
        fetchOperatorRunbook();
    };
    header.appendChild(refreshBtn);
    container.appendChild(header);

    // ── A. Attention Required ──
    var attQueue = state.operatorRunbook.attention;
    var attSection = document.createElement('div');

    var attTitle = document.createElement('div');
    attTitle.className = 'section-title';
    attTitle.textContent = attQueue.length > 0
        ? 'Attention Required (' + attQueue.length + ' items)'
        : 'Attention Required \u2014 All Clear';
    attSection.appendChild(attTitle);

    var severityColors = { BROKEN: '#ef4444', STUCK: '#f59e0b', BLOCKED: '#6b7280', NEW: '#3b82f6' };

    if (attQueue.length === 0) {
        var allClear = document.createElement('div');
        allClear.className = 'attention-all-clear';
        allClear.textContent = 'No tasks need immediate attention. System is running smoothly.';
        attSection.appendChild(allClear);
    } else {
        attQueue.forEach(function (item) {
            var card = document.createElement('div');
            card.className = 'attention-item';
            card.style.borderLeftColor = severityColors[item.severity] || '#6b7280';

            var topRow = document.createElement('div');
            topRow.className = 'attention-item-top';

            var badge = document.createElement('span');
            badge.className = 'severity-badge';
            badge.style.backgroundColor = severityColors[item.severity] || '#6b7280';
            badge.textContent = item.severity;

            var vtidEl = document.createElement('span');
            vtidEl.className = 'attention-vtid';
            vtidEl.textContent = item.vtid;

            var titleSpan = document.createElement('span');
            titleSpan.className = 'attention-title';
            titleSpan.textContent = item.title || '';

            topRow.appendChild(badge);
            topRow.appendChild(vtidEl);
            topRow.appendChild(titleSpan);

            var bottomRow = document.createElement('div');
            bottomRow.className = 'attention-item-bottom';

            var reasonEl = document.createElement('span');
            reasonEl.textContent = item.reason || '';
            bottomRow.appendChild(reasonEl);

            if (item.stuck_minutes) {
                var timeEl = document.createElement('span');
                timeEl.className = 'attention-time';
                var mins = item.stuck_minutes;
                timeEl.textContent = mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm';
                bottomRow.appendChild(timeEl);
            }

            var viewBtn = document.createElement('button');
            viewBtn.className = 'btn btn-sm';
            viewBtn.textContent = 'View Task';
            viewBtn.onclick = function (e) {
                e.stopPropagation();
                state.selectedTask = {
                    vtid: item.vtid,
                    title: item.title,
                    status: item.status || 'scheduled',
                    spec_status: item.spec_status || 'missing',
                    summary: item.reason || '',
                    oasisColumn: '',
                    _attentionContext: {
                        severity: item.severity,
                        reason: item.reason,
                        stuck_minutes: item.stuck_minutes
                    }
                };
                state.selectedTaskDetail = null;
                state.selectedTaskDetailLoading = true;
                state.executionStatus = null;
                state.executionStatusLoading = false;
                renderApp();
                fetchVtidDetail(item.vtid);
            };

            card.appendChild(topRow);
            card.appendChild(bottomRow);
            card.appendChild(viewBtn);
            attSection.appendChild(card);
        });
    }

    container.appendChild(attSection);

    // ── B. Recommendations ──
    var recs = state.operatorRunbook.recommendations;
    var recsSection = document.createElement('div');
    recsSection.style.marginTop = '20px';

    var recsTitle = document.createElement('div');
    recsTitle.className = 'section-title';
    recsTitle.textContent = 'Recommendations (' + recs.length + ')';
    recsSection.appendChild(recsTitle);

    if (recs.length === 0) {
        var noRecs = document.createElement('div');
        noRecs.className = 'placeholder-content';
        noRecs.textContent = 'No pending recommendations.';
        recsSection.appendChild(noRecs);
    } else {
        recs.forEach(function (rec) {
            var card = document.createElement('div');
            card.className = 'recommendation-card';

            var cardTop = document.createElement('div');
            cardTop.className = 'rec-card-top';

            var recTitle = document.createElement('span');
            recTitle.className = 'rec-card-title';
            recTitle.textContent = rec.title || '';
            cardTop.appendChild(recTitle);

            if (rec.domain) {
                var domainBadge = document.createElement('span');
                domainBadge.className = 'status-badge status-info';
                domainBadge.textContent = rec.domain;
                cardTop.appendChild(domainBadge);
            }

            card.appendChild(cardTop);

            if (rec.summary) {
                var summaryEl = document.createElement('div');
                summaryEl.style.cssText = 'color:#94a3b8;font-size:13px;margin:6px 0;';
                summaryEl.textContent = rec.summary;
                card.appendChild(summaryEl);
            }

            var cardBottom = document.createElement('div');
            cardBottom.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

            if (rec.risk_level) {
                var riskBadge = document.createElement('span');
                var riskColor = rec.risk_level === 'low' ? '#10b981' : rec.risk_level === 'high' ? '#ef4444' : '#f59e0b';
                riskBadge.style.cssText = 'font-size:12px;color:' + riskColor + ';';
                riskBadge.textContent = 'Risk: ' + rec.risk_level;
                cardBottom.appendChild(riskBadge);
            }

            if (rec.impact_score !== undefined) {
                var impactBadge = document.createElement('span');
                impactBadge.style.cssText = 'font-size:12px;color:#94a3b8;';
                impactBadge.textContent = 'Impact: ' + rec.impact_score;
                cardBottom.appendChild(impactBadge);
            }

            card.appendChild(cardBottom);
            recsSection.appendChild(card);
        });
    }

    container.appendChild(recsSection);

    return container;
}

// ─────────────────────────────────────────────────────────────────────────
// BOOTSTRAP-CMDHUB-I18N-OPS — Localization Operations view
// ─────────────────────────────────────────────────────────────────────────
// Read-only locales table + trigger buttons (translate / audit / runs).
// Data: GET /api/v1/admin/i18n-ops/locales (60s server-side cache).
// Triggers POST /api/v1/admin/i18n-ops/translate or /audit.
// Lists recent runs from GET /api/v1/admin/i18n-ops/workflow-runs.
//
// CSP-safe: no inline event handlers. All listeners attached via JS.
function renderOperatorLocalizationView() {
    var container = document.createElement('div');
    container.className = 'operator-localization-container';
    container.style.padding = '24px';

    var header = document.createElement('div');
    header.style.cssText = 'margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;';
    var titleBlock = document.createElement('div');
    var h1 = document.createElement('h1');
    h1.textContent = 'Localization Operations';
    h1.style.cssText = 'margin:0 0 6px;font-size:22px;color:var(--color-text,#fff);';
    titleBlock.appendChild(h1);
    var sub = document.createElement('div');
    sub.textContent = 'Locale catalog status, audit verdicts, and translate / audit workflow controls.';
    sub.style.cssText = 'opacity:0.7;font-size:13px;';
    titleBlock.appendChild(sub);
    header.appendChild(titleBlock);
    var refreshBtn = document.createElement('button');
    refreshBtn.textContent = '⟳ Refresh';
    refreshBtn.style.cssText = 'padding:8px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);border-radius:6px;color:#fff;cursor:pointer;font-size:13px;';
    header.appendChild(refreshBtn);
    container.appendChild(header);

    var statusEl = document.createElement('div');
    statusEl.style.cssText = 'opacity:0.65;font-size:12px;margin-bottom:14px;font-family:monospace;';
    container.appendChild(statusEl);

    var tableWrap = document.createElement('div');
    container.appendChild(tableWrap);

    var runsHeader = document.createElement('h2');
    runsHeader.textContent = 'Recent workflow runs';
    runsHeader.style.cssText = 'margin:32px 0 10px;font-size:16px;color:var(--color-text,#fff);';
    container.appendChild(runsHeader);

    var runsTabs = document.createElement('div');
    runsTabs.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
    var activeRuns = 'i18n-translate.yml';
    var workflows = [
        { key: 'i18n-translate.yml', label: 'Translate' },
        { key: 'i18n-audit-llm.yml', label: 'Audit (LLM)' },
        { key: 'i18n-check.yml', label: 'CI lint check' },
    ];
    var runsBody = document.createElement('div');
    function renderRunsTabs() {
        runsTabs.innerHTML = '';
        workflows.forEach(function (w) {
            var btn = document.createElement('button');
            btn.textContent = w.label;
            var isActive = activeRuns === w.key;
            btn.style.cssText = 'padding:6px 12px;background:' + (isActive ? 'rgba(86,168,255,0.2)' : 'rgba(255,255,255,0.04)') +
                ';border:1px solid ' + (isActive ? 'rgba(86,168,255,0.6)' : 'rgba(255,255,255,0.12)') + ';border-radius:6px;color:#fff;cursor:pointer;font-size:12px;';
            btn.addEventListener('click', function () {
                activeRuns = w.key;
                renderRunsTabs();
                fetchRuns();
            });
            runsTabs.appendChild(btn);
        });
    }
    container.appendChild(runsTabs);
    container.appendChild(runsBody);

    function setStatus(text) { statusEl.textContent = text || ''; }

    function authHeader() {
        var token = localStorage.getItem('vitana.authToken') || '';
        return token ? { Authorization: 'Bearer ' + token } : {};
    }

    function fetchLocales() {
        setStatus('Loading…');
        tableWrap.innerHTML = '';
        fetch('/api/v1/admin/i18n-ops/locales', { headers: authHeader() })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data || !data.ok) {
                    setStatus('Error: ' + (data && data.error || 'unknown'));
                    return;
                }
                setStatus('Source EN keys: ' + (data.en_total || 0) + ' · Updated ' + new Date(data.generated_at).toLocaleTimeString());
                renderTable(data.locales || []);
            })
            .catch(function (e) {
                setStatus('Network error: ' + (e && e.message || e));
            });
    }

    function renderTable(rows) {
        tableWrap.innerHTML = '';
        var table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;background:rgba(255,255,255,0.02);';
        var thead = document.createElement('thead');
        thead.innerHTML = '<tr>' +
            ['Locale', 'Status', 'Catalog', 'Audit pass', 'Last audit', 'Actions']
                .map(function (c) {
                    return '<th style="text-align:left;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.1);font-weight:600;opacity:0.85;">' + c + '</th>';
                }).join('') + '</tr>';
        table.appendChild(thead);
        var tbody = document.createElement('tbody');

        rows.forEach(function (row) {
            var tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

            // Locale
            var tdLocale = document.createElement('td');
            tdLocale.style.cssText = 'padding:10px 12px;font-family:monospace;font-weight:600;';
            tdLocale.textContent = row.code;
            tr.appendChild(tdLocale);

            // Status pill
            var tdStatus = document.createElement('td');
            tdStatus.style.padding = '10px 12px';
            var pill = document.createElement('span');
            var statusColor = row.status === 'ga' ? '#3ddc84' : row.status === 'beta' ? '#f0b400' : '#888';
            pill.style.cssText = 'padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:' + statusColor + '22;color:' + statusColor + ';border:1px solid ' + statusColor + '55;';
            pill.textContent = (row.status || 'draft').toUpperCase();
            tdStatus.appendChild(pill);
            tr.appendChild(tdStatus);

            // Catalog progress
            var tdCat = document.createElement('td');
            tdCat.style.padding = '10px 12px';
            var pct = row.completeness_pct || 0;
            var barWrap = document.createElement('div');
            barWrap.style.cssText = 'width:120px;background:rgba(255,255,255,0.08);border-radius:3px;height:6px;position:relative;';
            var bar = document.createElement('div');
            bar.style.cssText = 'width:' + pct + '%;background:' + (pct >= 90 ? '#3ddc84' : pct >= 50 ? '#56a8ff' : '#888') + ';height:100%;border-radius:3px;';
            barWrap.appendChild(bar);
            var text = document.createElement('div');
            text.style.cssText = 'font-size:11px;opacity:0.7;margin-top:3px;';
            text.textContent = (row.locale_total || 0) + ' / ' + (row.en_total || 0) + ' (' + pct + '%)';
            tdCat.appendChild(barWrap);
            tdCat.appendChild(text);
            tr.appendChild(tdCat);

            // Audit pass rate
            var tdAudit = document.createElement('td');
            tdAudit.style.padding = '10px 12px';
            if (row.audit_total > 0) {
                var rate = row.audit_pass_rate_pct;
                var auditColor = rate >= 90 ? '#3ddc84' : rate >= 70 ? '#f0b400' : '#ff8080';
                tdAudit.innerHTML = '<span style="font-weight:600;color:' + auditColor + '">' + rate + '%</span> <span style="opacity:0.6;font-size:11px">(' + row.audit_flagged + ' flagged / ' + row.audit_total + ')</span>';
            } else {
                tdAudit.innerHTML = '<span style="opacity:0.5;font-size:11px">no audit yet</span>';
            }
            tr.appendChild(tdAudit);

            // Last audit
            var tdLast = document.createElement('td');
            tdLast.style.cssText = 'padding:10px 12px;opacity:0.7;font-size:11px;';
            tdLast.textContent = row.last_audit_at ? new Date(row.last_audit_at).toLocaleString() : '—';
            tr.appendChild(tdLast);

            // Actions
            var tdActions = document.createElement('td');
            tdActions.style.cssText = 'padding:10px 12px;display:flex;gap:6px;';
            var translateBtn = makeActionBtn('Translate', '#56a8ff', function () {
                if (!confirm('Translate ' + row.code + ' via DeepSeek? This dispatches the i18n-translate.yml workflow.')) return;
                triggerTranslate(row.lang_code, 'deepseek', translateBtn);
            });
            var auditBtn = makeActionBtn('Audit', '#a87dff', function () {
                if (!confirm('Audit ' + row.code + ' via Gemini? This dispatches the i18n-audit-llm.yml workflow.')) return;
                triggerAudit(row.lang_code, 'gemini', auditBtn);
            });
            tdActions.appendChild(translateBtn);
            tdActions.appendChild(auditBtn);
            tr.appendChild(tdActions);
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        tableWrap.appendChild(table);
    }

    function makeActionBtn(label, color, onClick) {
        var btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = 'padding:5px 10px;background:' + color + '22;border:1px solid ' + color + '66;border-radius:4px;color:' + color + ';cursor:pointer;font-size:11px;font-weight:600;';
        btn.addEventListener('click', onClick);
        return btn;
    }

    function triggerTranslate(locale, provider, btn) {
        btn.textContent = '…';
        btn.disabled = true;
        fetch('/api/v1/admin/i18n-ops/translate', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
            body: JSON.stringify({ locale: locale, provider: provider }),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                btn.disabled = false;
                if (data && data.ok) {
                    btn.textContent = '✓ Dispatched';
                    setTimeout(function () { btn.textContent = 'Translate'; }, 4000);
                    if (typeof window.showToast === 'function') {
                        window.showToast('Translate dispatched for ' + locale, 'success');
                    }
                    setTimeout(fetchRuns, 1500);
                } else {
                    btn.textContent = 'Translate';
                    alert('Failed: ' + (data && (data.message || data.error) || 'unknown'));
                }
            })
            .catch(function (e) {
                btn.disabled = false;
                btn.textContent = 'Translate';
                alert('Network error: ' + (e && e.message || e));
            });
    }

    function triggerAudit(locale, provider, btn) {
        btn.textContent = '…';
        btn.disabled = true;
        fetch('/api/v1/admin/i18n-ops/audit', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
            body: JSON.stringify({ locale: locale, provider: provider }),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                btn.disabled = false;
                if (data && data.ok) {
                    btn.textContent = '✓ Dispatched';
                    setTimeout(function () { btn.textContent = 'Audit'; }, 4000);
                    if (typeof window.showToast === 'function') {
                        window.showToast('Audit dispatched for ' + locale, 'success');
                    }
                    setTimeout(fetchRuns, 1500);
                } else {
                    btn.textContent = 'Audit';
                    alert('Failed: ' + (data && (data.message || data.error) || 'unknown'));
                }
            })
            .catch(function (e) {
                btn.disabled = false;
                btn.textContent = 'Audit';
                alert('Network error: ' + (e && e.message || e));
            });
    }

    function fetchRuns() {
        runsBody.innerHTML = '<div style="opacity:0.5;font-size:12px;padding:8px;">Loading runs…</div>';
        fetch('/api/v1/admin/i18n-ops/workflow-runs?workflow=' + encodeURIComponent(activeRuns) + '&limit=10', {
            headers: authHeader(),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data || !data.ok || !data.runs || !data.runs.length) {
                    runsBody.innerHTML = '<div style="opacity:0.5;font-size:12px;padding:8px;">No recent runs.</div>';
                    return;
                }
                runsBody.innerHTML = '';
                var list = document.createElement('div');
                list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
                data.runs.forEach(function (run) {
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:6px;font-size:12px;';
                    var pillColor = run.conclusion === 'success' ? '#3ddc84' : run.conclusion === 'failure' ? '#ff8080' : run.status === 'in_progress' ? '#56a8ff' : '#888';
                    var pillText = run.status === 'completed' ? (run.conclusion || '?') : run.status;
                    row.innerHTML =
                        '<span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:' + pillColor + '22;color:' + pillColor + ';border:1px solid ' + pillColor + '55;text-transform:uppercase">' + pillText + '</span>' +
                        '<span style="font-family:monospace;opacity:0.85">#' + (run.run_number || '?') + '</span>' +
                        '<span style="flex:1;opacity:0.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (run.display_title || '').replace(/</g, '&lt;') + '</span>' +
                        '<span style="opacity:0.6">' + (run.actor_login || '?') + '</span>' +
                        '<span style="opacity:0.6">' + (run.created_at ? new Date(run.created_at).toLocaleString() : '') + '</span>';
                    if (run.html_url) {
                        var openBtn = document.createElement('a');
                        openBtn.href = run.html_url;
                        openBtn.target = '_blank';
                        openBtn.rel = 'noopener noreferrer';
                        openBtn.textContent = '↗';
                        openBtn.style.cssText = 'color:#56a8ff;text-decoration:none;font-size:14px;padding:0 4px;';
                        row.appendChild(openBtn);
                    }
                    list.appendChild(row);
                });
                runsBody.appendChild(list);
            })
            .catch(function (e) {
                runsBody.innerHTML = '<div style="opacity:0.5;font-size:12px;padding:8px;color:#ff8080">Error: ' + (e && e.message || e) + '</div>';
            });
    }

    refreshBtn.addEventListener('click', function () {
        fetchLocales();
        fetchRuns();
    });

    renderRunsTabs();
    fetchLocales();
    fetchRuns();
    return container;
}