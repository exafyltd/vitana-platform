// Vitana Dev Frontend Spec v2 Implementation - Task 3
// AUTODEPLOY-TRIGGER: 2025-12-20T14:00:00Z

// VTID-0539: Operator Console Chat Experience Improvements
// DEV-COMHU-2025-0012: Task Management v1 - Persisted Specs + Lifecycle + Approvals
// DEV-COMHU-2025-0013: UX fixes - fingerprint style, textarea stability, dismiss toast
// DEV-COMHU-2025-0015: Fix Task Board UX + VTID labels + OASIS events formatting
// VTID-01002: Global Scroll Retention Guard - polling uses incremental updates, not renderApp()
// VTID-01003: Fix Create Task modal (input reset), add Task Spec field, drawer metadata order + timestamp format
// VTID-01010: Target Role as Mandatory Task Contract
// VTID-01016: OASIS Event Authority - Deterministic Stage/Status Derivation
// VTID-01017: Scheduled Column Hard Eligibility + Remove Archive UI
// VTID-01019: Operator Console UI Binding to OASIS Truth - No optimistic UI
// VTID-01022: Command Hub Governance - Human Task Only Filter
// VTID-01027: Operator Console Session Memory - client-side context + conversation_id
// VTID-01028: Task Board Rendering Fix - Restore Visibility & Authority
// VTID-01111: Filter allocator shell entries from Command Hub board
// VTID-01151: Command Hub Approvals UI — Badge Counter + Live Pending List + Approve/Reject
// VTID-01174: Agents Control Plane v2 — Pipelines (Runs + Traces from VTID Ledger + OASIS Events)
console.log('🔥 COMMAND HUB BUNDLE: VTID-01174 LIVE 🔥');

// ===========================================================================
// VTID-01010: Target Role Constants (canonical)
// ===========================================================================
const TARGET_ROLES = ['DEV', 'COM', 'ADM', 'PRO', 'ERP', 'PAT', 'INFRA'];
const TARGET_ROLE_LABELS = {
    'DEV': 'Vitana Developer',
    'COM': 'Community',
    'ADM': 'Admin',
    'PRO': 'Professional',
    'ERP': 'Staff',
    'PAT': 'Patient',
    'INFRA': 'Infrastructure'
};

// ===========================================================================
// VTID-01049: Me Context State (Authoritative Role from Gateway)
// ===========================================================================
const MeState = {
    loaded: false,
    me: null // { user_id, email, tenant_id, roles[], active_role }
};

// VTID-01049: Valid view roles for POST /api/v1/me/active-role
const VALID_VIEW_ROLES = ['community', 'patient', 'professional', 'staff', 'admin', 'developer'];

// VTID-01186: Role-to-default-screen mapping (matching vitana-v1 navigation)
// When user switches role, they are redirected to their role-specific home screen
const ROLE_DEFAULT_SCREENS = {
    'community': { section: 'overview', tab: 'system-overview' },
    'patient': { section: 'overview', tab: 'system-overview' },
    'professional': { section: 'overview', tab: 'system-overview' },
    'staff': { section: 'operator', tab: 'task-queue' },
    'admin': { section: 'admin', tab: 'users' },
    'developer': { section: 'command-hub', tab: 'tasks' }
};

/**
 * VTID-01186: Navigate to role-specific default screen
 * Called after role switch to redirect user to appropriate screen
 */
function navigateToRoleDefaultScreen(role) {
    var lowerRole = (role || 'community').toLowerCase();
    var defaultScreen = ROLE_DEFAULT_SCREENS[lowerRole] || ROLE_DEFAULT_SCREENS['community'];

    // Find the section config
    var section = NAVIGATION_CONFIG.find(function(s) { return s.section === defaultScreen.section; });
    if (!section) {
        console.warn('[VTID-01186] Section not found for role:', lowerRole);
        return;
    }

    // Find the tab within the section
    var tab = section.tabs.find(function(t) { return t.key === defaultScreen.tab; });
    if (!tab) {
        tab = section.tabs[0]; // Fallback to first tab
    }

    // Update state
    state.currentModuleKey = defaultScreen.section;
    state.currentTab = tab ? tab.key : '';

    // Update URL
    if (tab) {
        history.pushState(null, '', tab.path);
    } else {
        history.pushState(null, '', section.basePath);
    }

    console.log('[VTID-01186] Navigated to role default screen:', lowerRole, '->', defaultScreen.section + '/' + (tab ? tab.key : ''));
}

/**
 * VTID-01049: Fetch Me Context from Gateway
 * Called on app boot to load authoritative role from server.
 * @returns {Promise<{ok: boolean, me?: object, error?: string}>}
 */
async function fetchMeContext() {
    try {
        var response = await fetch('/api/v1/me');
        if (response.status === 401) {
            // Not signed in - keep UI usable
            MeState.loaded = true;
            MeState.me = null;
            return { ok: false, error: 'Not signed in' };
        }
        if (!response.ok) {
            // 404/500 - show toast but don't break UI
            MeState.loaded = true;
            return { ok: false, error: 'Role context unavailable (Gateway /me)' };
        }
        var data = await response.json();
        if (data.ok && data.me) {
            MeState.loaded = true;
            MeState.me = data.me;
            // Sync viewRole with authoritative active_role
            if (data.me.active_role) {
                // Capitalize first letter for display
                var displayRole = data.me.active_role.charAt(0).toUpperCase() + data.me.active_role.slice(1);
                state.viewRole = displayRole;
                localStorage.setItem('vitana.viewRole', displayRole);
            }
            return { ok: true, me: data.me };
        }
        MeState.loaded = true;
        return { ok: false, error: 'Invalid response from /me' };
    } catch (err) {
        console.error('[VTID-01049] fetchMeContext error:', err);
        MeState.loaded = true;
        return { ok: false, error: 'Network error loading role context' };
    }
}

/**
 * VTID-01049: Set Active Role via Gateway API
 * Called when user changes role in Profile dropdown.
 * @param {string} role - Role to set (lowercase: community, patient, professional, staff, admin, developer)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function setActiveRole(role) {
    var lowerRole = role.toLowerCase();

    // Validate role client-side
    if (VALID_VIEW_ROLES.indexOf(lowerRole) === -1) {
        return { ok: false, error: 'Invalid role: ' + role };
    }

    try {
        var response = await fetch('/api/v1/me/active-role', {
            method: 'POST',
            headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ role: lowerRole })
        });

        if (response.status === 401) {
            return { ok: false, error: 'Not signed in.', code: 'UNAUTHENTICATED' };
        }
        if (response.status === 403) {
            return { ok: false, error: "You don't have access to that role.", code: 'FORBIDDEN' };
        }
        if (response.status === 400) {
            var errData = await response.json().catch(function() { return {}; });
            return { ok: false, error: errData.message || 'Invalid role', code: 'INVALID_ROLE' };
        }
        if (!response.ok) {
            return { ok: false, error: 'Failed to set role' };
        }

        var data = await response.json();
        if (data.ok) {
            // Update MeState with new active_role
            if (MeState.me) {
                MeState.me.active_role = lowerRole;
            }
            return { ok: true };
        }
        return { ok: false, error: data.message || 'Failed to set role' };
    } catch (err) {
        console.error('[VTID-01049] setActiveRole error:', err);
        return { ok: false, error: 'Network error setting role' };
    }
}

/**
 * VTID-01049: Add Vitana context headers to fetch requests
 * Adds X-Vitana-Active-Role, X-Vitana-Tenant, X-Vitana-User if MeState.me exists.
 * @param {Object} headers - Existing headers object
 * @returns {Object} Headers with Vitana context added
 */
function withVitanaContextHeaders(headers) {
    var h = Object.assign({}, headers || {});
    if (MeState.me) {
        if (MeState.me.active_role) {
            h['X-Vitana-Active-Role'] = MeState.me.active_role;
        }
        if (MeState.me.tenant_id) {
            h['X-Vitana-Tenant'] = MeState.me.tenant_id;
        }
        if (MeState.me.user_id) {
            h['X-Vitana-User'] = MeState.me.user_id;
        }
    }
    return h;
}

// ===========================================================================
// VTID-01016: OASIS Event Authority - Deterministic Stage/Status Derivation
// ===========================================================================
/**
 * Derives display Stage/Status from OASIS event-authority data.
 * Maps backend projection values to deterministic display values.
 * "Moving" is eliminated - replaced with scheduled/in_progress/success/failed.
 *
 * Precedence (highest → lowest):
 * 1. Terminal lifecycle completed (success/failed) → Done / success|failed
 * 2. Deploy success/fail → Deploy / success|failed
 * 3. Validator success/fail → Validator / in_progress|failed
 * 4. Worker success/fail → Worker / in_progress|failed
 * 5. Planner success/fail → Planner / in_progress|failed
 * 6. Lifecycle started → Queued / in_progress
 * 7. Else → Scheduled / scheduled
 *
 * @param {Object} item - VTID projection item from API
 * @returns {Object} { stage: string, status: string }
 */
function deriveVtidStageStatus(item) {
    // Priority 1: Terminal states have highest precedence (OASIS authority)
    if (item.is_terminal === true) {
        return {
            stage: 'Done',
            status: item.terminal_outcome === 'success' ? 'success' : 'failed'
        };
    }

    var backendStatus = (item.status || '').toLowerCase();
    var backendStage = item.current_stage || 'Planner';

    // Priority 2: Check for explicit Done status
    if (backendStatus === 'done') {
        return { stage: 'Done', status: 'success' };
    }

    // Priority 3: Check for Failed/Blocked status
    if (backendStatus === 'failed' || backendStatus === 'blocked') {
        return { stage: backendStage, status: 'failed' };
    }

    // Priority 4: Map "Moving" and other non-terminal statuses
    // Stage determines display, status becomes 'in_progress' for active work
    switch (backendStage) {
        case 'Done':
            return { stage: 'Done', status: 'success' };
        case 'Deploy':
            return { stage: 'Deploy', status: 'in_progress' };
        case 'Validator':
            return { stage: 'Validator', status: 'in_progress' };
        case 'Worker':
            return { stage: 'Worker', status: 'in_progress' };
        case 'Planner':
            // Planner stage with Moving → lifecycle started, queued for work
            return { stage: 'Queued', status: 'in_progress' };
        default:
            // Unknown stage → default to Scheduled
            return { stage: 'Scheduled', status: 'scheduled' };
    }
}

// --- DEV-COMHU-2025-0012: LocalStorage Helpers for Task Management v1 ---

/**
 * DEV-COMHU-2025-0012: Get task spec from localStorage.
 * Key: vitana.taskSpec.<VTID>
 */
function getTaskSpec(vtid) {
    if (!vtid) return '';
    try {
        return localStorage.getItem('vitana.taskSpec.' + vtid) || '';
    } catch (e) {
        console.warn('[DEV-COMHU-2025-0012] localStorage read error:', e);
        return '';
    }
}

/**
 * DEV-COMHU-2025-0012: Save task spec to localStorage.
 */
function saveTaskSpec(vtid, spec) {
    if (!vtid) return false;
    try {
        localStorage.setItem('vitana.taskSpec.' + vtid, spec);
        return true;
    } catch (e) {
        console.warn('[DEV-COMHU-2025-0012] localStorage write error:', e);
        return false;
    }
}

/**
 * DEV-COMHU-2025-0012: Get task status override from localStorage.
 * Key: vitana.taskStatusOverride.<VTID>
 */
function getTaskStatusOverride(vtid) {
    if (!vtid) return null;
    try {
        return localStorage.getItem('vitana.taskStatusOverride.' + vtid);
    } catch (e) {
        console.warn('[DEV-COMHU-2025-0012] localStorage read error:', e);
        return null;
    }
}

/**
 * DEV-COMHU-2025-0012: Save task status override to localStorage.
 */
function setTaskStatusOverride(vtid, status) {
    if (!vtid) return false;
    try {
        localStorage.setItem('vitana.taskStatusOverride.' + vtid, status);
        return true;
    } catch (e) {
        console.warn('[DEV-COMHU-2025-0012] localStorage write error:', e);
        return false;
    }
}

/**
 * VTID-01006: Clear task status override from localStorage.
 * Called when OASIS indicates terminal state - local overrides are no longer valid.
 */
function clearTaskStatusOverride(vtid) {
    if (!vtid) return false;
    try {
        localStorage.removeItem('vitana.taskStatusOverride.' + vtid);
        return true;
    } catch (e) {
        console.warn('[VTID-01006] localStorage clear error:', e);
        return false;
    }
}

/**
 * VTID-01041: Get task title override from localStorage.
 * Key: vitana.taskTitleOverride.<VTID>
 */
function getTaskTitleOverride(vtid) {
    if (!vtid) return null;
    try {
        return localStorage.getItem('vitana.taskTitleOverride.' + vtid);
    } catch (e) {
        console.warn('[VTID-01041] localStorage read error:', e);
        return null;
    }
}

/**
 * VTID-01041: Save task title override to localStorage.
 */
function setTaskTitleOverride(vtid, title) {
    if (!vtid) return false;
    try {
        localStorage.setItem('vitana.taskTitleOverride.' + vtid, title);
        return true;
    } catch (e) {
        console.warn('[VTID-01041] localStorage write error:', e);
        return false;
    }
}

/**
 * VTID-01041: Get effective task title.
 * Priority: localStorage override > server title > fallback
 */
function getEffectiveTaskTitle(task) {
    if (!task || !task.vtid) return 'Allocated - Pending Title';
    var override = getTaskTitleOverride(task.vtid);
    if (override) return override;
    if (task.title && task.title !== 'Pending Title' && task.title !== 'Allocated - Pending Title') {
        return task.title;
    }
    return 'Allocated - Pending Title';
}

/**
 * VTID-01041: Check if a task title is a placeholder.
 */
function isPlaceholderTitle(title) {
    if (!title) return true;
    var lowerTitle = title.toLowerCase();
    return lowerTitle === 'pending title' ||
           lowerTitle === 'allocated - pending title' ||
           lowerTitle === '' ||
           lowerTitle === 'untitled';
}

/**
 * DEV-COMHU-2025-0012: Check if an approval is dismissed (localStorage suppression).
 * Key: vitana.approvalsDismissed.<repo>#<pr>
 */
function isApprovalDismissed(repo, prNumber) {
    if (!repo || !prNumber) return false;
    try {
        return localStorage.getItem('vitana.approvalsDismissed.' + repo + '#' + prNumber) === 'true';
    } catch (e) {
        return false;
    }
}

/**
 * DEV-COMHU-2025-0012: Dismiss an approval (store in localStorage).
 */
function dismissApproval(repo, prNumber) {
    if (!repo || !prNumber) return false;
    try {
        localStorage.setItem('vitana.approvalsDismissed.' + repo + '#' + prNumber, 'true');
        return true;
    } catch (e) {
        return false;
    }
}

// --- VTID-01027: Operator Console Session Memory LocalStorage Helpers ---

/**
 * VTID-01027: Get or create a stable conversation_id for operator chat.
 * Stored in localStorage under 'operator_console_conversation_id'.
 * Returns a UUID that persists across page refreshes.
 */
function getOperatorConversationId() {
    var key = 'operator_console_conversation_id';
    try {
        var existing = localStorage.getItem(key);
        if (existing) {
            return existing;
        }
        // Generate new UUID v4
        var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0;
            var v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem(key, uuid);
        console.log('[VTID-01027] Created new conversation_id:', uuid);
        return uuid;
    } catch (e) {
        console.warn('[VTID-01027] localStorage error for conversation_id:', e);
        // Fallback to session-only UUID
        return 'session-' + Date.now();
    }
}

/**
 * VTID-01027: Get operator chat history from localStorage.
 * Returns array of { role: 'user'|'assistant', content: string, ts: number }
 */
function getOperatorChatHistory() {
    var key = 'operator_console_history';
    try {
        var stored = localStorage.getItem(key);
        if (stored) {
            var parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                return parsed;
            }
        }
    } catch (e) {
        console.warn('[VTID-01027] Error reading chat history:', e);
    }
    return [];
}

/**
 * VTID-01027: Save operator chat history to localStorage.
 * @param {Array} history - Array of { role, content, ts } objects
 */
function saveOperatorChatHistory(history) {
    var key = 'operator_console_history';
    try {
        localStorage.setItem(key, JSON.stringify(history));
    } catch (e) {
        console.warn('[VTID-01027] Error saving chat history:', e);
    }
}

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
 * VTID-01027: Initialize operator chat session.
 * Loads conversation_id and chat history from localStorage.
 * Restores chatMessages for UI rendering from persisted history.
 */
function initOperatorChatSession() {
    // Get or create conversation_id
    state.operatorConversationId = getOperatorConversationId();

    // Load persisted chat history
    var history = getOperatorChatHistory();
    state.operatorChatHistory = history;

    // Convert history to chatMessages format for UI rendering
    if (history.length > 0 && state.chatMessages.length === 0) {
        state.chatMessages = history.map(function(msg) {
            return {
                type: msg.role === 'user' ? 'user' : 'system',
                content: msg.content,
                timestamp: new Date(msg.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
            };
        });
        console.log('[VTID-01027] Restored', history.length, 'messages from history');
    }
}

// ===========================================================================
// VTID-01049: Me Context API - Authoritative Role + Identity
// ===========================================================================

/**
 * VTID-01049: Build headers with role context for API requests.
 * Attaches these headers to requests that send auth:
 *   - Authorization: Bearer <token>
 *   - X-Vitana-Active-Role: <active_role>
 *   - X-Vitana-Tenant: <tenant_id>
 *   - X-Vitana-User: <user_id>
 *
 * This is the stepping stone for memory keying in Operator/ORB.
 *
 * @param {Object} additionalHeaders - Extra headers to merge
 * @returns {Object} Headers object with context headers added
 */
function buildContextHeaders(additionalHeaders) {
    var headers = additionalHeaders || {};

    // Add auth token if available
    if (state.authToken) {
        headers['Authorization'] = 'Bearer ' + state.authToken;
    }

    // Add role context headers if me context is loaded
    if (state.meContext) {
        if (state.meContext.active_role) {
            headers['X-Vitana-Active-Role'] = state.meContext.active_role;
        }
        if (state.meContext.tenant_id) {
            headers['X-Vitana-Tenant'] = state.meContext.tenant_id;
        }
        if (state.meContext.user_id) {
            headers['X-Vitana-User'] = state.meContext.user_id;
        }
    }

    return headers;
}

/**
 * VTID-01049: Fetch me context from Gateway API.
 * Calls GET /api/v1/me to get authoritative identity + role context.
 *
 * @param {boolean} silentRefresh - If true, don't update loading state
 * @returns {Promise<Object|null>} The me context object or null on error
 */
async function fetchMeContext(silentRefresh) {
    if (!state.authToken) {
        console.log('[VTID-01049] No auth token, skipping me context fetch');
        return null;
    }

    if (!silentRefresh) {
        state.meContextLoading = true;
        state.meContextError = null;
    }

    try {
        var response = await fetch('/api/v1/me', {
            method: 'GET',
            headers: buildContextHeaders()
        });

        var data = await response.json();

        if (!response.ok || !data.ok) {
            var errorMsg = data.error || 'Failed to fetch me context';
            console.error('[VTID-01049] fetchMeContext error:', errorMsg);

            if (response.status === 401) {
                // Clear invalid auth token
                state.authToken = null;
                localStorage.removeItem('vitana.authToken');
                // VTID-01109: Clear ORB conversation on logout/auth failure
                orbClearConversationState();
            }

            state.meContextError = errorMsg;
            state.meContextLoading = false;
            return null;
        }

        console.log('[VTID-01049] fetchMeContext success:', data.me);
        state.meContext = data.me;
        state.meContextLoading = false;
        state.meContextError = null;

        // VTID-01049: Sync viewRole with authoritative active_role
        if (data.me.active_role) {
            // Capitalize first letter to match UI format (e.g., 'developer' -> 'Developer')
            var capitalizedRole = data.me.active_role.charAt(0).toUpperCase() + data.me.active_role.slice(1);
            state.viewRole = capitalizedRole;
            localStorage.setItem('vitana.viewRole', capitalizedRole);
        }

        return data.me;
    } catch (err) {
        console.error('[VTID-01049] fetchMeContext exception:', err);
        state.meContextError = err.message || 'Network error';
        state.meContextLoading = false;
        return null;
    }
}

/**
 * VTID-01049: Set active role via Gateway API.
 * Calls POST /api/v1/me/active-role to persist role change server-side.
 *
 * @param {string} role - The role to set (lowercase: developer, admin, etc.)
 * @returns {Promise<Object|null>} The updated me context or null on error
 */
async function setActiveRole(role) {
    if (!state.authToken) {
        console.error('[VTID-01049] No auth token, cannot set active role');
        showToast('Not authenticated', 'error');
        return null;
    }

    // Normalize role to lowercase for API
    var normalizedRole = (role || '').toLowerCase();
    var validRoles = ['community', 'patient', 'professional', 'staff', 'admin', 'developer'];

    if (!validRoles.includes(normalizedRole)) {
        console.error('[VTID-01049] Invalid role:', role);
        showToast('Invalid role: ' + role, 'error');
        return null;
    }

    try {
        var response = await fetch('/api/v1/me/active-role', {
            method: 'POST',
            headers: buildContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ role: normalizedRole })
        });

        var data = await response.json();

        if (!response.ok || !data.ok) {
            var errorMsg = data.error || 'Failed to set active role';
            console.error('[VTID-01049] setActiveRole error:', errorMsg);

            // Show appropriate toast based on error type
            if (response.status === 401) {
                showToast('Session expired. Please log in again.', 'error');
                state.authToken = null;
                localStorage.removeItem('vitana.authToken');
                // VTID-01109: Clear ORB conversation on logout/auth failure
                orbClearConversationState();
            } else if (response.status === 403) {
                showToast('You do not have permission to use this role.', 'error');
            } else if (data.error === 'INVALID_ROLE') {
                showToast('Invalid role: ' + role, 'error');
            } else {
                showToast('Failed to switch role: ' + errorMsg, 'error');
            }

            return null;
        }

        console.log('[VTID-01049] setActiveRole success:', data.me);
        state.meContext = data.me;

        // Update viewRole to match (capitalized for UI)
        if (data.me.active_role) {
            var capitalizedRole = data.me.active_role.charAt(0).toUpperCase() + data.me.active_role.slice(1);
            state.viewRole = capitalizedRole;
            localStorage.setItem('vitana.viewRole', capitalizedRole);
        }

        showToast('Switched to ' + state.viewRole + ' role', 'success');
        return data.me;
    } catch (err) {
        console.error('[VTID-01049] setActiveRole exception:', err);
        showToast('Network error switching role', 'error');
        return null;
    }
}

/**
 * VTID-01049: Initialize me context on app boot.
 * Fetches me context from Gateway if auth token is available.
 */
async function initMeContext() {
    if (state.authToken) {
        console.log('[VTID-01049] Auth token found, fetching me context...');
        await fetchMeContext();
        renderApp();
    } else {
        console.log('[VTID-01049] No auth token, me context not available');
    }
}

// ===========================================================================
// VTID-01171: Auth Identity from /api/v1/auth/me
// ===========================================================================

/**
 * VTID-01171: Fetch authenticated user identity from /api/v1/auth/me
 * Returns identity (user_id, email, tenant_id, exafy_admin), profile, memberships.
 * Updates state.user with real name/avatar for profile capsule display.
 *
 * VTID-01196: Now accepts fallbackEmail to preserve user info if API fails.
 *
 * @param {string} [fallbackEmail] - Email to use if API call fails
 * @returns {Promise<Object|null>} The auth identity or null on error
 */
async function fetchAuthMe(fallbackEmail) {
    // VTID-01196: Use stored login email as fallback
    var emailFallback = fallbackEmail || state.loginUserEmail || '';

    if (!state.authToken) {
        console.log('[VTID-01171] No auth token, skipping auth/me fetch');
        // Set fallback user for unauthenticated state
        state.user = {
            name: 'Guest',
            role: 'User',
            avatar: '?'
        };
        return null;
    }

    state.authIdentityLoading = true;
    state.authIdentityError = null;

    try {
        var response = await fetch('/api/v1/auth/me', {
            method: 'GET',
            headers: buildContextHeaders()
        });

        var data = await response.json();

        if (!response.ok || !data.ok) {
            var errorMsg = data.error || 'Failed to fetch auth identity';
            console.error('[VTID-01171] fetchAuthMe error:', errorMsg);

            // VTID-01196: NEVER clear token on /auth/me failure
            // Token should only be cleared on explicit logout
            // The /auth/me endpoint may fail due to server-side JWT issues, but the token is still valid

            state.authIdentityError = errorMsg;
            state.authIdentityLoading = false;

            // VTID-01196: Set fallback user - use stored email or extract from token if possible
            var storedEmail = emailFallback || state.loginUserEmail || localStorage.getItem('vitana.userEmail') || '';
            var fallbackName = storedEmail ? storedEmail.split('@')[0] : 'User';
            var fallbackInitials = generateInitials(storedEmail || 'User');
            state.user = {
                name: fallbackName,
                role: state.viewRole || 'User',
                avatar: fallbackInitials,
                email: storedEmail || null,
                avatarUrl: null
            };
            console.warn('[VTID-01196] fetchAuthMe failed, using fallback. Token preserved.');
            return null;
        }

        console.log('[VTID-01171] fetchAuthMe success:', data.identity);
        state.authIdentity = data;
        state.authIdentityLoading = false;
        state.authIdentityError = null;

        // VTID-01171: Update state.user with real identity data
        var identity = data.identity || {};
        var profile = data.profile || {};
        var email = identity.email || '';
        var displayName = profile.display_name || '';

        // Determine display name: prefer profile.display_name, then email username, then email
        var name = displayName || (email ? email.split('@')[0] : 'User');

        // Generate initials for avatar
        var initials = generateInitials(displayName || email || 'User');

        // Determine role label
        var roleLabel = 'User';
        if (identity.exafy_admin) {
            roleLabel = 'Admin';
        } else if (data.memberships && data.memberships.length > 0) {
            // Use first membership role, capitalize
            var firstRole = data.memberships[0].role || 'user';
            roleLabel = firstRole.charAt(0).toUpperCase() + firstRole.slice(1);
        }

        state.user = {
            name: name,
            role: roleLabel,
            avatar: initials,
            email: email,
            avatarUrl: profile.avatar_url || null
        };

        return data;
    } catch (err) {
        console.error('[VTID-01171] fetchAuthMe exception:', err);
        state.authIdentityError = err.message || 'Network error';
        state.authIdentityLoading = false;

        // VTID-01196: Set fallback user - use stored email, token preserved
        var storedEmail = emailFallback || state.loginUserEmail || localStorage.getItem('vitana.userEmail') || '';
        var fallbackName = storedEmail ? storedEmail.split('@')[0] : 'User';
        var fallbackInitials = generateInitials(storedEmail || 'User');
        state.user = {
            name: fallbackName,
            role: state.viewRole || 'User',
            avatar: fallbackInitials,
            email: storedEmail || null,
            avatarUrl: null
        };
        console.warn('[VTID-01196] fetchAuthMe exception, using fallback. Token preserved.');
        return null;
    }
}

/**
 * VTID-01171: Generate initials from name or email.
 * @param {string} input - Name or email to generate initials from
 * @returns {string} 1-2 character initials
 */
function generateInitials(input) {
    if (!input) return '?';

    // If it's an email, use username part
    if (input.includes('@')) {
        input = input.split('@')[0];
    }

    // Split by space, dot, underscore, or hyphen
    var parts = input.split(/[\s._-]+/).filter(function(p) { return p.length > 0; });

    if (parts.length === 0) return '?';
    if (parts.length === 1) {
        // Single word: use first 2 characters
        return parts[0].substring(0, 2).toUpperCase();
    }

    // Multiple parts: use first letter of first two parts
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
}

// ===========================================================================
// VTID-01186: Dev Login (Email/Password) via Gateway /api/v1/auth/login
// ===========================================================================

/**
 * VTID-01186: Login with email and password via Gateway.
 * Calls POST /api/v1/auth/login and stores the access_token.
 *
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<Object>} Result object { ok, error, message }
 */
async function doLogin(email, password) {
    state.loginLoading = true;
    state.loginError = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password })
        });

        var data = await response.json();

        if (!response.ok || !data.ok) {
            var errorMsg = data.message || data.error || 'Login failed';
            console.error('[VTID-01186] doLogin error:', errorMsg);
            state.loginError = errorMsg;
            state.loginLoading = false;
            renderApp();
            return { ok: false, error: data.error, message: errorMsg };
        }

        console.log('[VTID-01186] doLogin success, user_id=', data.user?.id, 'email=', data.user?.email || email);

        // Store the access token
        state.authToken = data.access_token;
        localStorage.setItem('vitana.authToken', data.access_token);

        // Store refresh token for later use
        if (data.refresh_token) {
            localStorage.setItem('vitana.refreshToken', data.refresh_token);
        }

        // VTID-01196: Store login email as fallback for profile display
        // This ensures we can show user info even if /auth/me fails
        // Store in both state and localStorage for persistence across page refresh
        var loginEmail = data.user?.email || email;
        state.loginUserEmail = loginEmail;
        localStorage.setItem('vitana.userEmail', loginEmail);

        state.loginLoading = false;
        state.loginError = null;

        // Clear login form state
        state.loginEmail = '';
        state.loginPassword = '';

        // VTID-01186: Clear page error states to trigger data refetch after login
        // This ensures pages re-fetch data with the new auth token
        state.adminDevUsersError = null;
        state.adminDevUsers = [];
        state.meContextError = null;
        state.authIdentityError = null;
        state.tasksError = null;
        state.governanceRulesError = null;

        // VTID-01196: Set user state from login response immediately
        // Use profile data if available (includes avatar_url from app_users)
        var loginProfile = data.profile || {};
        var displayName = loginProfile.display_name || (loginEmail ? loginEmail.split('@')[0] : 'User');
        var avatarUrl = loginProfile.avatar_url || null;
        var initialInitials = generateInitials(loginProfile.display_name || loginEmail || 'User');

        state.user = {
            name: displayName,
            role: state.viewRole || 'User',
            avatar: initialInitials,
            email: loginEmail,
            avatarUrl: avatarUrl
        };
        console.log('[VTID-01196] User state from login:', { name: displayName, avatarUrl: avatarUrl ? 'yes' : 'no' });
        renderApp(); // Show immediate feedback

        // Fetch full identity (will update with avatar_url if available)
        await fetchAuthMe(loginEmail);

        // Also fetch me context to update MeState
        await fetchMeContext();

        // Close profile modal and refresh
        state.showProfileModal = false;
        showToast('Logged in successfully', 'success');
        renderApp();

        return { ok: true };
    } catch (err) {
        console.error('[VTID-01186] doLogin exception:', err);
        state.loginError = err.message || 'Network error';
        state.loginLoading = false;
        renderApp();
        return { ok: false, error: 'NETWORK_ERROR', message: err.message };
    }
}

/**
 * VTID-01186: Logout - clears auth state.
 */
function doLogout() {
    // Clear auth state
    state.authToken = null;
    state.authIdentity = null;
    state.meContext = null;
    state.loginUserEmail = null; // VTID-01196: Clear login email fallback
    MeState.loaded = false;
    MeState.me = null;
    localStorage.removeItem('vitana.authToken');
    localStorage.removeItem('vitana.refreshToken');
    localStorage.removeItem('vitana.viewRole');
    localStorage.removeItem('vitana.userEmail');

    // Clear ORB conversation on logout
    if (typeof orbClearConversationState === 'function') {
        orbClearConversationState();
    }

    // Reset user to guest
    state.user = {
        name: 'Guest',
        role: 'User',
        avatar: '?'
    };
    state.viewRole = 'User';
    state.showProfileModal = false;

    showToast('Logged out successfully', 'info');
    renderApp();
}

// ===========================================================================
// VTID-01017: Scheduled Column Hard Eligibility Filter
// VTID-01028: Relaxed to prevent hiding human-created tasks
// VTID-01111: Re-added shell entry filter for allocator placeholders
// ===========================================================================

/**
 * VTID-01017: Check if a task is eligible to appear in Scheduled column.
 * VTID-01028: RELAXED - Task Board must never hide human-created tasks.
 * VTID-01111: Re-added filter for allocator shell entries (safety net).
 *
 * Governance Rules (VTID-01028):
 * - "Scheduled column is creation-authoritative"
 * - "No heuristics that can zero out the board"
 * - "If data exists → it must render"
 *
 * Exception (VTID-01111):
 * - Allocator shell entries (status='allocated', title='Allocated - Pending Title')
 *   are NOT human-created tasks - they are placeholders awaiting real task data.
 *   These MUST be filtered out to prevent phantom cards.
 *
 * The backend (board-adapter.ts) now filters these out, but this is a safety net.
 *
 * Requirements:
 *   A) Only classic VTIDs: must match pattern ^VTID-\d{4,5}$
 *      (isHumanTask already checks this before this function is called)
 *   B) VTID-01111: Reject allocator shell entries (status='allocated')
 *   C) RELAXED: Title can be short/empty - task still renders with VTID
 *      Exception: 'Allocated - Pending Title' is rejected (shell entry marker)
 */
function isEligibleScheduled(task) {
    if (!task) return false;

    // Rule A: Only classic VTIDs (VTID-NNNN or VTID-NNNNN format)
    // Note: This is redundant with isHumanTask check but kept for safety
    // VTID-01028: Updated to support 5-digit VTIDs (e.g., VTID-01028, VTID-01029)
    var vtid = (task.vtid || '');
    var classicVtidPattern = /^VTID-\d{4,5}$/;
    if (!classicVtidPattern.test(vtid)) {
        return false;
    }

    // VTID-01150: REMOVED Rule B - allocated tasks should now appear in SCHEDULED
    // The backend (board-adapter.ts) properly maps allocated→SCHEDULED.
    // Users need to see allocated tasks so they can trigger execution.
    // var status = (task.status || '').toLowerCase();
    // if (status === 'allocated') {
    //     return false;
    // }

    // VTID-01150: REMOVED Rule C - allocated tasks should now appear in SCHEDULED
    // Even with placeholder titles, users need to see them to trigger execution.
    // var title = (task.title || '').trim();
    // if (title === 'Allocated - Pending Title') {
    //     return false;
    // }
    var title = (task.title || '').trim();

    // VTID-01028 diagnostic logging for visibility
    if (!title) {
        console.log('[VTID-01028] Task ' + vtid + ' has empty title - will render with VTID');
    }

    // Task is eligible
    return true;
}

// ===========================================================================
// VTID-01022: Command Hub Governance - Human Task Only Filter
// ===========================================================================

/**
 * VTID-01022: Check if a task is a human task (NOT a system/CI/CD artifact).
 * Human tasks have IDs matching the pattern: ^VTID-\d{4}$
 *
 * FORBIDDEN task prefixes (system artifacts):
 *   - DEV-*
 *   - DEV-CICDL-*
 *   - DEV-COMHU-*
 *   - AUTODEPLOY-*
 *   - OASIS-CMD-*
 *   - Any other non-VTID prefix
 *
 * This is a HARD governance filter - non-human tasks NEVER appear on the board.
 */
function isHumanTask(task) {
    if (!task) return false;
    var vtid = (task.vtid || '');
    // Canonical human task pattern: VTID-NNNN or VTID-NNNNN (4-5 digits)
    // VTID-01028: Updated to support 5-digit VTIDs (e.g., VTID-01028, VTID-01029)
    var humanTaskPattern = /^VTID-\d{4,5}$/;
    return humanTaskPattern.test(vtid);
}

// ===========================================================================
// VTID-01055: Deleted/Voided Task Filter (Client-Side Safety Net)
// ===========================================================================

/**
 * VTID-01055: Check if a task should be rendered (not deleted/voided/cancelled).
 * This is a client-side safety net to suppress cards that are known invalid
 * even if the backend board endpoint returns them.
 *
 * A task is NOT renderable if:
 *   - status === "deleted", "voided", or "cancelled"
 *   - deleted_at is set (non-null/non-empty)
 *   - metadata.deleted === true
 *   - is_terminal === true AND column is not COMPLETED (misplaced terminal task)
 *
 * @param {Object} task - The task object from API
 * @returns {boolean} - true if task should be rendered, false if suppressed
 */
function isTaskRenderable(task) {
    if (!task) return false;

    var vtid = task.vtid || '';
    var status = (task.status || '').toLowerCase();
    var oasisColumn = (task.oasisColumn || '').toUpperCase();

    // Rule 1: status === "deleted", "voided", or "cancelled" → never render
    if (status === 'deleted' || status === 'voided' || status === 'cancelled') {
        console.log('[VTID-01055] Suppressing deleted/voided/cancelled task:', vtid, 'status=' + status);
        return false;
    }

    // Rule 2: deleted_at is set → never render
    if (task.deleted_at) {
        console.log('[VTID-01055] Suppressing task with deleted_at:', vtid);
        return false;
    }

    // Rule 3: metadata.deleted or metadata.cancelled === true → never render
    if (task.metadata && (task.metadata.deleted === true || task.metadata.cancelled === true)) {
        console.log('[VTID-01055] Suppressing task with metadata.deleted/cancelled:', vtid);
        return false;
    }

    // Rule 4: is_terminal but not in COMPLETED column → misplaced, suppress
    if (task.is_terminal === true && oasisColumn !== 'COMPLETED' && oasisColumn !== '') {
        console.log('[VTID-01055] Suppressing misplaced terminal task:', vtid, 'column=' + oasisColumn);
        return false;
    }

    return true;
}


/**
 * VTID-01010: Get target roles from task metadata.
 * Returns array of role strings or empty array if none set.
 */
function getTaskTargetRoles(task) {
    if (!task) return [];
    // Check metadata.target_roles (authoritative storage)
    if (task.metadata && Array.isArray(task.metadata.target_roles)) {
        return task.metadata.target_roles;
    }
    // Check direct target_roles property (API response)
    if (Array.isArray(task.target_roles)) {
        return task.target_roles;
    }
    return [];
}

// --- VTID-01002: Global Scroll Retention Guard ---
// Preserves scroll positions across re-renders. Polling uses incremental updates, not renderApp().
// Primary discovery: data-scroll-retain="true" attribute. Fallback: legacy selector list.

/**
 * Scroll positions Map keyed by route + containerId.
 * Format: Map<routeKey, Map<containerKey, scrollTop>>
 */
var scrollPositions = new Map();

/**
 * VTID-01002: Fallback selector list for containers not yet marked with data-scroll-retain.
 * Primary mechanism is attribute discovery; this list exists for backwards compatibility.
 */
var SCROLLABLE_SELECTORS_FALLBACK = [
    '.column-content',
    '.drawer-content',
    '.overlay-content',
    '.oasis-events-content',
    '.command-hub-events-content',
    '.vtids-content',
    '.history-content',
    '.ticker-events-list',
    '.ticker-container',
    '.gov-history-drawer-content',
    '.governance-content',
    '.tasks-container',
    '.ledger-list-pane',
    '.approvals-list',
    '.version-dropdown__list',
    '.split-pane-content'
];

/**
 * Throttle helper for scroll listeners.
 * @param {Function} fn - Function to throttle
 * @param {number} wait - Throttle interval in ms
 * @returns {Function} Throttled function
 */
function throttle(fn, wait) {
    var lastTime = 0;
    return function() {
        var now = Date.now();
        if (now - lastTime >= wait) {
            lastTime = now;
            fn.apply(this, arguments);
        }
    };
}

/**
 * Gets the current route key for scroll position storage.
 * @returns {string} Route key combining module and tab
 */
function getScrollRouteKey() {
    return (state.currentModuleKey || 'unknown') + '/' + (state.currentTab || 'unknown');
}

/**
 * VTID-01002: Gets a unique key for a scroll container.
 * Uses data-scroll-key if available, otherwise falls back to id or generated key.
 * @param {HTMLElement} container - The scroll container
 * @param {number} index - Index among similar containers
 * @returns {string} Unique container key
 */
function getContainerKey(container, index) {
    if (container.dataset.scrollKey) {
        return container.dataset.scrollKey;
    }
    if (container.id) {
        return '#' + container.id;
    }
    // Fallback: use className + index
    var className = container.className.split(' ')[0] || 'container';
    return '.' + className + '[' + index + ']';
}

/**
 * VTID-01002: Discovers all scrollable containers via data-scroll-retain attribute.
 * Falls back to legacy selector list for containers not yet marked.
 * @returns {HTMLElement[]} Array of scrollable containers
 */
function discoverScrollContainers() {
    var containers = [];
    var seen = new Set();

    // Primary: discover via data-scroll-retain attribute
    var attributed = document.querySelectorAll('[data-scroll-retain="true"]');
    attributed.forEach(function(el) {
        if (!seen.has(el)) {
            seen.add(el);
            containers.push(el);
        }
    });

    // Fallback: legacy selector list for unmarked containers
    SCROLLABLE_SELECTORS_FALLBACK.forEach(function(selector) {
        var elements = document.querySelectorAll(selector);
        elements.forEach(function(el) {
            if (!seen.has(el)) {
                seen.add(el);
                containers.push(el);
            }
        });
    });

    return containers;
}

/**
 * Saves scroll position for a specific container.
 * Called on scroll events (throttled).
 * @param {string} key - Container key
 * @param {number} scrollTop - Current scroll position
 */
function saveScrollPosition(key, scrollTop) {
    var routeKey = getScrollRouteKey();
    if (!scrollPositions.has(routeKey)) {
        scrollPositions.set(routeKey, new Map());
    }
    scrollPositions.get(routeKey).set(key, scrollTop);
}

/**
 * VTID-01002: Captures scroll positions for all scrollable containers before DOM destruction.
 * Called at the start of renderApp().
 * @returns {Map<string, number>} Map of containerKey to scrollTop
 */
function captureAllScrollPositions() {
    var positions = new Map();
    var routeKey = getScrollRouteKey();

    var containers = discoverScrollContainers();
    containers.forEach(function(container, index) {
        var key = getContainerKey(container, index);
        if (container.scrollTop > 0) {
            positions.set(key, container.scrollTop);
        }
    });

    // Save to persistent storage for tab-switching
    if (!scrollPositions.has(routeKey)) {
        scrollPositions.set(routeKey, new Map());
    }
    positions.forEach(function(value, key) {
        scrollPositions.get(routeKey).set(key, value);
    });

    return positions;
}

/**
 * VTID-01002: Restores scroll positions for all scrollable containers after DOM rebuild.
 * Uses requestAnimationFrame to ensure DOM is ready.
 * @param {Map<string, number>} positions - Captured positions from captureAllScrollPositions
 */
function restoreAllScrollPositions(positions) {
    if (!positions || positions.size === 0) return;

    requestAnimationFrame(function() {
        var containers = discoverScrollContainers();
        containers.forEach(function(container, index) {
            var key = getContainerKey(container, index);
            if (positions.has(key)) {
                container.scrollTop = positions.get(key);
            }
        });
    });
}

/**
 * Restores scroll positions from persistent storage for a route (for tab switching).
 * @param {string} routeKey - Route key to restore from
 */
function restoreScrollPositionsForRoute(routeKey) {
    var positions = scrollPositions.get(routeKey);
    if (positions) {
        restoreAllScrollPositions(positions);
    }
}

/**
 * VTID-01002: Attaches throttled scroll listeners to all scrollable containers.
 * Called after renderApp() to set up tracking.
 */
function attachScrollListeners() {
    var containers = discoverScrollContainers();
    containers.forEach(function(container, index) {
        // Skip if already has listener (marker attribute)
        if (container.dataset.scrollTracked) return;
        container.dataset.scrollTracked = 'true';

        var key = getContainerKey(container, index);

        container.addEventListener('scroll', throttle(function() {
            saveScrollPosition(key, container.scrollTop);
        }, 100), { passive: true });
    });
}

/**
 * VTID-01002: Refreshes only the active view's data region without full DOM rebuild.
 * Called by polling handlers instead of renderApp() to preserve scroll positions.
 */
function refreshActiveViewData() {
    var moduleKey = state.currentModuleKey;
    var tab = state.currentTab;

    // Determine which view is active and refresh only its data region
    if (moduleKey === 'oasis' && tab === 'events') {
        refreshOasisEventsContent();
    } else if (moduleKey === 'command-hub' && tab === 'events') {
        refreshCommandHubEventsContent();
    } else if (moduleKey === 'command-hub' && tab === 'vtids') {
        refreshVtidsContent();
    } else if (moduleKey === 'oasis' && tab === 'vtid-ledger') {
        refreshVtidLedgerContent();
    } else if (state.isOperatorOpen) {
        // Operator console overlays - refresh ticker/counters
        refreshOperatorContent();
    }
    // For other views or when specific view not active, skip refresh to avoid unnecessary work
}

/**
 * SPEC-01: Global Refresh - Triggers full data reload for the active screen.
 * Called by the global refresh button (⟳) in the header.
 * Returns a promise that resolves when refresh is complete.
 */
async function triggerGlobalRefresh() {
    var moduleKey = state.currentModuleKey;
    var tab = state.currentTab;

    console.log('[SPEC-01] Global refresh triggered for:', moduleKey, tab);

    // Comprehensive refresh based on current view
    try {
        if (moduleKey === 'command-hub') {
            if (tab === 'tasks') {
                await fetchTasks();
            } else if (tab === 'events') {
                await fetchCommandHubEvents();
            } else if (tab === 'vtids') {
                state.vtidProjection.fetched = false;
                await fetchVtidProjection();
            } else if (tab === 'approvals') {
                // VTID-01154: SPEC-02 uses GitHub feed
                state.approvals.feedFetched = false;
                await fetchGitHubFeed();
            }
        } else if (moduleKey === 'oasis') {
            if (tab === 'events') {
                await fetchOasisEvents(state.oasisEvents.filters);
            } else if (tab === 'vtid-ledger') {
                state.vtidProjection.fetched = false;
                await fetchVtidProjection();
            } else if (tab === 'entities') {
                state.oasisEntities.fetched = false;
                await fetchOasisEntities();
            } else if (tab === 'streams') {
                state.oasisStreams.fetched = false;
                await fetchOasisStreams();
            } else if (tab === 'command-log') {
                state.oasisCommandLog.fetched = false;
                await fetchOasisCommandLog();
            }
        } else if (moduleKey === 'governance') {
            if (tab === 'rules') {
                await fetchGovernanceRules();
            } else if (tab === 'evaluations') {
                await fetchGovernanceEvaluations();
            } else if (tab === 'history') {
                state.historyPage = 1;
                state.historyLoading = true;
                await fetchHistory();
            } else if (tab === 'violations') {
                state.governanceViolations.fetched = false;
                await fetchGovernanceViolations();
            } else if (tab === 'proposals') {
                state.governanceProposals.fetched = false;
                await fetchGovernanceProposals();
            } else if (tab === 'categories') {
                state.governanceCategories.fetched = false;
                await fetchGovernanceCategories();
            }
        } else if (moduleKey === 'operator') {
            if (tab === 'task-queue' || tab === 'task-details') {
                await fetchOperatorTasks();
            } else if (tab === 'execution-logs') {
                await fetchOperatorLogs();
            } else if (tab === 'pipelines') {
                state.operatorPipelines.fetched = false;
                await fetchOperatorPipelines();
            }
        } else if (moduleKey === 'memory-garden') {
            state.memoryGarden.loading = true;
            await fetchMemoryGardenProgress();
        } else if (moduleKey === 'agents') {
            state.agents.fetched = false;
            await fetchAgents();
        } else if (moduleKey === 'test-runs') {
            state.testRuns.fetched = false;
            await fetchTestRuns();
        } else if (moduleKey === 'deployments') {
            state.deployments.fetched = false;
            await fetchDeployments();
        } else if (moduleKey === 'uxhub') {
            await fetchUxHubData();
        }

        // Re-render to show updated data
        renderApp();
    } catch (error) {
        console.error('[SPEC-01] Global refresh error:', error);
    }
}

/**
 * VTID-01002: Incremental refresh for OASIS events content.
 * Updates table body only, keeps scroll container stable.
 */
function refreshOasisEventsContent() {
    var content = document.querySelector('.oasis-events-content');
    if (!content) return;

    var tbody = content.querySelector('tbody');
    if (tbody && state.oasisEvents.items) {
        // Update table rows without replacing container
        updateOasisEventsTableBody(tbody, state.oasisEvents.items);
    }
}

/**
 * VTID-01002: Incremental refresh for Command Hub events content.
 */
function refreshCommandHubEventsContent() {
    var content = document.querySelector('.command-hub-events-content');
    if (!content) return;

    var tbody = content.querySelector('tbody');
    if (tbody && state.commandHubEvents.items) {
        updateCommandHubEventsTableBody(tbody, state.commandHubEvents.items);
    }
}

/**
 * VTID-01002: Incremental refresh for VTIDs list content.
 * VTID-01030: FIXED - Use vtidProjection (not vtidsList) to match renderVtidsView
 */
function refreshVtidsContent() {
    var content = document.querySelector('.vtids-content');
    if (!content) return;

    // VTID-01030: Use vtidProjection.items (same as renderVtidsView), NOT vtidsList.items
    var tbody = content.querySelector('tbody');
    if (tbody && state.vtidProjection.items && state.vtidProjection.items.length > 0) {
        // Only refresh if we have data - don't wipe with empty array
        updateVtidsTableBodyFromProjection(tbody, state.vtidProjection.items);
    }
}

/**
 * VTID-01002: Incremental refresh for VTID Ledger content.
 */
function refreshVtidLedgerContent() {
    var listPane = document.querySelector('.ledger-list-pane');
    if (!listPane) return;

    var list = listPane.querySelector('.ledger-vtid-list');
    if (list && state.vtidLedger.items) {
        updateVtidLedgerList(list, state.vtidLedger.items);
    }
}

/**
 * VTID-01002: Incremental refresh for Operator console content (ticker, counters).
 */
function refreshOperatorContent() {
    // Update stage counters display
    var counterElements = document.querySelectorAll('.stage-counter-value');
    if (counterElements.length >= 4 && state.stageCounters) {
        var stages = ['PLANNER', 'WORKER', 'VALIDATOR', 'DEPLOY'];
        stages.forEach(function(stage, i) {
            if (counterElements[i]) {
                counterElements[i].textContent = state.stageCounters[stage] || 0;
            }
        });
    }

    // Update ticker events if visible
    var tickerList = document.querySelector('.ticker-events-list');
    if (tickerList && state.tickerEvents) {
        updateTickerEventsList(tickerList, state.tickerEvents);
    }
}

/**
 * VTID-01002: Updates OASIS events table body incrementally.
 */
function updateOasisEventsTableBody(tbody, items) {
    // Clear and rebuild rows (but NOT the parent container)
    while (tbody.firstChild) {
        tbody.removeChild(tbody.firstChild);
    }

    var filtered = filterOasisEvents(items);
    filtered.forEach(function(event) {
        var row = createOasisEventRow(event);
        tbody.appendChild(row);
    });
}

/**
 * VTID-01002: Updates Command Hub events table body incrementally.
 */
function updateCommandHubEventsTableBody(tbody, items) {
    while (tbody.firstChild) {
        tbody.removeChild(tbody.firstChild);
    }

    var filtered = filterCommandHubEvents(items);
    filtered.forEach(function(event) {
        var row = createCommandHubEventRow(event);
        tbody.appendChild(row);
    });
}

/**
 * VTID-01002: Updates VTIDs table body incrementally.
 */
function updateVtidsTableBody(tbody, items) {
    while (tbody.firstChild) {
        tbody.removeChild(tbody.firstChild);
    }

    items.forEach(function(vtid) {
        var row = createVtidRow(vtid);
        tbody.appendChild(row);
    });
}

/**
 * VTID-01030: Updates VTIDs projection table body incrementally.
 * Uses same row format as renderVtidProjectionTable (5 columns: VTID, Title, Stage, Status, Attention)
 */
function updateVtidsTableBodyFromProjection(tbody, items) {
    if (!tbody || !items) return;

    while (tbody.firstChild) {
        tbody.removeChild(tbody.firstChild);
    }

    items.forEach(function(item) {
        try {
            if (!item) return;

            var row = document.createElement('tr');
            row.className = 'vtid-row vtid-projection-row';

            // VTID column
            var vtidCell = document.createElement('td');
            vtidCell.className = 'vtid-cell';
            vtidCell.textContent = item.vtid || '—';
            row.appendChild(vtidCell);

            // Title column
            var titleCell = document.createElement('td');
            titleCell.className = 'vtid-title-cell';
            titleCell.textContent = item.title || '—';
            row.appendChild(titleCell);

            // Derive Stage/Status
            var derived = deriveVtidStageStatus(item) || { stage: 'Scheduled', status: 'scheduled' };

            // Stage column
            var stageCell = document.createElement('td');
            var stageBadge = document.createElement('span');
            var stageVal = (derived.stage || 'scheduled').toLowerCase();
            stageBadge.className = 'vtid-stage-badge vtid-stage-' + stageVal;
            stageBadge.textContent = derived.stage || 'Scheduled';
            stageCell.appendChild(stageBadge);
            row.appendChild(stageCell);

            // Status column
            var statusCell = document.createElement('td');
            var statusBadge = document.createElement('span');
            var statusVal = (derived.status || 'scheduled').toLowerCase();
            statusBadge.className = 'vtid-status-badge vtid-status-' + statusVal;
            statusBadge.textContent = derived.status || 'scheduled';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // Attention column
            var attentionCell = document.createElement('td');
            var attentionBadge = document.createElement('span');
            var attentionVal = item.attention_required || 'AUTO';
            attentionBadge.className = 'vtid-attention-badge vtid-attention-' + attentionVal.toLowerCase();
            attentionBadge.textContent = attentionVal === 'HUMAN' ? '⚠️ HUMAN' : 'AUTO';
            attentionCell.appendChild(attentionBadge);
            row.appendChild(attentionCell);

            tbody.appendChild(row);
        } catch (err) {
            console.error('[VTID-01030] Failed to update VTID row:', item && item.vtid, err);
        }
    });
}

/**
 * VTID-01002: Updates VTID Ledger list incrementally.
 */
function updateVtidLedgerList(list, items) {
    while (list.firstChild) {
        list.removeChild(list.firstChild);
    }

    items.forEach(function(item) {
        var el = createVtidLedgerItem(item);
        list.appendChild(el);
    });
}

/**
 * VTID-01002: Updates ticker events list incrementally.
 */
function updateTickerEventsList(list, events) {
    while (list.firstChild) {
        list.removeChild(list.firstChild);
    }

    events.forEach(function(event) {
        var item = createTickerEventItem(event);
        list.appendChild(item);
    });
}

/**
 * VTID-01002: Filters OASIS events based on current filter state.
 * @param {Array} items - Raw event items
 * @returns {Array} Filtered items
 */
function filterOasisEvents(items) {
    if (!items) return [];
    var filters = state.oasisEvents.filters || {};
    return items.filter(function(event) {
        if (filters.topic && !(event.topic || '').toLowerCase().includes(filters.topic.toLowerCase())) {
            return false;
        }
        if (filters.service && event.service !== filters.service) {
            return false;
        }
        if (filters.status && event.status !== filters.status) {
            return false;
        }
        return true;
    });
}

/**
 * VTID-01002: Filters Command Hub events based on current filter state.
 * @param {Array} items - Raw event items
 * @returns {Array} Filtered items
 */
function filterCommandHubEvents(items) {
    if (!items) return [];
    var filters = state.commandHubEvents.filters || {};
    return items.filter(function(event) {
        if (filters.topic && !(event.topic || '').toLowerCase().includes(filters.topic.toLowerCase())) {
            return false;
        }
        if (filters.service && event.service !== filters.service) {
            return false;
        }
        if (filters.status && event.status !== filters.status) {
            return false;
        }
        return true;
    });
}

/**
 * VTID-01002: Creates an OASIS event table row element.
 * Uses the same structure as renderOasisEventsView for consistency.
 * @param {Object} event - Event data
 * @returns {HTMLElement} Table row element
 */
function createOasisEventRow(event) {
    var row = document.createElement('tr');
    row.className = 'oasis-event-row';
    var severity = getEventSeverity(event);
    row.dataset.severity = severity;
    row.onclick = function() {
        state.oasisEvents.selectedEvent = event;
        renderApp();
    };

    // Severity indicator
    var severityCell = document.createElement('td');
    var severityDot = document.createElement('span');
    severityDot.className = 'severity-dot severity-' + severity;
    severityCell.appendChild(severityDot);
    row.appendChild(severityCell);

    // Timestamp
    var tsCell = document.createElement('td');
    tsCell.className = 'event-timestamp';
    tsCell.textContent = formatEventTimestamp(event.created_at);
    row.appendChild(tsCell);

    // Topic
    var topicCell = document.createElement('td');
    topicCell.className = 'event-topic';
    topicCell.textContent = event.topic || '-';
    row.appendChild(topicCell);

    // VTID
    var vtidCell = document.createElement('td');
    vtidCell.className = 'event-vtid';
    vtidCell.textContent = event.vtid || '-';
    row.appendChild(vtidCell);

    // Service
    var serviceCell = document.createElement('td');
    serviceCell.className = 'event-service';
    serviceCell.textContent = event.service || '-';
    row.appendChild(serviceCell);

    // Status
    var statusCell = document.createElement('td');
    var statusBadge = document.createElement('span');
    statusBadge.className = 'status-badge status-' + (event.status || 'info');
    statusBadge.textContent = event.status || '-';
    statusCell.appendChild(statusBadge);
    row.appendChild(statusCell);

    // Message
    var msgCell = document.createElement('td');
    msgCell.className = 'event-message';
    msgCell.textContent = (event.message || '').substring(0, 60) + ((event.message || '').length > 60 ? '...' : '');
    row.appendChild(msgCell);

    return row;
}

/**
 * VTID-01002: Creates a Command Hub event table row element.
 * @param {Object} event - Event data
 * @returns {HTMLElement} Table row element
 */
function createCommandHubEventRow(event) {
    var row = document.createElement('tr');
    row.className = 'command-hub-event-row';
    row.onclick = function() {
        state.commandHubEvents.selectedEvent = event;
        renderApp();
    };

    // Timestamp
    var tsCell = document.createElement('td');
    tsCell.textContent = formatEventTimestamp(event.created_at);
    row.appendChild(tsCell);

    // Topic
    var topicCell = document.createElement('td');
    topicCell.textContent = event.topic || '-';
    row.appendChild(topicCell);

    // VTID
    var vtidCell = document.createElement('td');
    vtidCell.textContent = event.vtid || '-';
    row.appendChild(vtidCell);

    // Service
    var serviceCell = document.createElement('td');
    serviceCell.textContent = event.service || '-';
    row.appendChild(serviceCell);

    // Status
    var statusCell = document.createElement('td');
    var statusBadge = document.createElement('span');
    statusBadge.className = 'status-badge status-' + (event.status || 'info');
    statusBadge.textContent = event.status || '-';
    statusCell.appendChild(statusBadge);
    row.appendChild(statusCell);

    // Message
    var msgCell = document.createElement('td');
    msgCell.textContent = (event.message || '').substring(0, 50) + ((event.message || '').length > 50 ? '...' : '');
    row.appendChild(msgCell);

    return row;
}

/**
 * VTID-01002: Creates a VTID list table row element.
 * @param {Object} vtid - VTID data
 * @returns {HTMLElement} Table row element
 */
function createVtidRow(vtid) {
    var row = document.createElement('tr');
    row.className = 'vtid-row';

    // VTID
    var vtidCell = document.createElement('td');
    vtidCell.textContent = vtid.vtid || '-';
    row.appendChild(vtidCell);

    // Title
    var titleCell = document.createElement('td');
    titleCell.textContent = vtid.title || '-';
    row.appendChild(titleCell);

    // Status
    var statusCell = document.createElement('td');
    var statusBadge = document.createElement('span');
    statusBadge.className = 'status-badge status-' + (vtid.status || 'pending');
    statusBadge.textContent = vtid.status || 'pending';
    statusCell.appendChild(statusBadge);
    row.appendChild(statusCell);

    return row;
}

/**
 * VTID-01002: Creates a VTID Ledger list item element.
 * @param {Object} item - Ledger item data
 * @returns {HTMLElement} List item element
 */
function createVtidLedgerItem(item) {
    var el = document.createElement('div');
    el.className = 'ledger-vtid-item';
    if (state.vtidLedger.selectedVtid === item.vtid) {
        el.classList.add('selected');
    }
    el.onclick = function() {
        state.vtidLedger.selectedVtid = item.vtid;
        fetchVtidDetail(item.vtid);
        renderApp();
    };

    var vtidLabel = document.createElement('span');
    vtidLabel.className = 'ledger-vtid-label';
    vtidLabel.textContent = item.vtid || '-';
    el.appendChild(vtidLabel);

    var statusBadge = document.createElement('span');
    statusBadge.className = 'ledger-vtid-status status-' + (item.status || 'pending');
    statusBadge.textContent = item.status || 'pending';
    el.appendChild(statusBadge);

    return el;
}

/**
 * VTID-01002: Creates a ticker event item element.
 * @param {Object} event - Ticker event data
 * @returns {HTMLElement} Ticker item element
 */
function createTickerEventItem(event) {
    var item = document.createElement('div');
    item.className = 'ticker-event-item ticker-event-' + (event.type || 'info');

    var timestamp = document.createElement('span');
    timestamp.className = 'ticker-timestamp';
    timestamp.textContent = event.timestamp || '';
    item.appendChild(timestamp);

    var content = document.createElement('span');
    content.className = 'ticker-content';
    content.textContent = event.content || '';
    item.appendChild(content);

    if (event.task_stage) {
        var stage = document.createElement('span');
        stage.className = 'ticker-stage ticker-stage-' + event.task_stage.toLowerCase();
        stage.textContent = event.task_stage.charAt(0);  // VTID-01210: Use single char to match renderOperatorTicker
        stage.title = event.task_stage;  // Full text on hover
        item.appendChild(stage);
    }

    return item;
}

// --- Configs ---

const NAVIGATION_CONFIG = [
    {
        "section": "overview",
        "basePath": "/command-hub/overview/",
        "tabs": [
            { "key": "system-overview", "path": "/command-hub/overview/system-overview/" },
            { "key": "live-metrics", "path": "/command-hub/overview/live-metrics/" },
            { "key": "recent-events", "path": "/command-hub/overview/recent-events/" },
            { "key": "errors-violations", "path": "/command-hub/overview/errors-violations/" },
            { "key": "release-feed", "path": "/command-hub/overview/release-feed/" }
        ]
    },
    {
        "section": "admin",
        "basePath": "/command-hub/admin/",
        "tabs": [
            { "key": "users", "path": "/command-hub/admin/users/" },
            { "key": "permissions", "path": "/command-hub/admin/permissions/" },
            { "key": "tenants", "path": "/command-hub/admin/tenants/" },
            { "key": "content-moderation", "path": "/command-hub/admin/content-moderation/" },
            { "key": "identity-access", "path": "/command-hub/admin/identity-access/" },
            { "key": "analytics", "path": "/command-hub/admin/analytics/" }
        ]
    },
    {
        "section": "operator",
        "basePath": "/command-hub/operator/",
        "tabs": [
            { "key": "task-queue", "path": "/command-hub/operator/task-queue/" },
            { "key": "task-details", "path": "/command-hub/operator/task-details/" },
            { "key": "execution-logs", "path": "/command-hub/operator/execution-logs/" },
            { "key": "pipelines", "path": "/command-hub/operator/pipelines/" },
            { "key": "runbook", "path": "/command-hub/operator/runbook/" }
        ]
    },
    {
        "section": "command-hub",
        "basePath": "/command-hub/",
        "tabs": [
            { "key": "tasks", "path": "/command-hub/tasks/" },
            { "key": "live-console", "path": "/command-hub/live-console/" },
            { "key": "events", "path": "/command-hub/events/" },
            { "key": "vtids", "path": "/command-hub/vtids/" },
            { "key": "approvals", "path": "/command-hub/approvals/" }
        ]
    },
    {
        "section": "governance",
        "basePath": "/command-hub/governance/",
        "tabs": [
            { "key": "rules", "path": "/command-hub/governance/rules/" },
            { "key": "categories", "path": "/command-hub/governance/categories/" },
            { "key": "evaluations", "path": "/command-hub/governance/evaluations/" },
            { "key": "violations", "path": "/command-hub/governance/violations/" },
            { "key": "history", "path": "/command-hub/governance/history/" },
            { "key": "proposals", "path": "/command-hub/governance/proposals/" },
            { "key": "controls", "path": "/command-hub/governance/controls/" }
        ]
    },
    {
        "section": "agents",
        "basePath": "/command-hub/agents/",
        "tabs": [
            { "key": "registered-agents", "path": "/command-hub/agents/registered-agents/" },
            { "key": "skills", "path": "/command-hub/agents/skills/" },
            { "key": "pipelines", "path": "/command-hub/agents/pipelines/" },
            { "key": "memory", "path": "/command-hub/agents/memory/" },
            { "key": "telemetry", "path": "/command-hub/agents/telemetry/" }
        ]
    },
    {
        "section": "workflows",
        "basePath": "/command-hub/workflows/",
        "tabs": [
            { "key": "workflow-list", "path": "/command-hub/workflows/workflow-list/" },
            { "key": "triggers", "path": "/command-hub/workflows/triggers/" },
            { "key": "actions", "path": "/command-hub/workflows/actions/" },
            { "key": "schedules", "path": "/command-hub/workflows/schedules/" },
            { "key": "history", "path": "/command-hub/workflows/history/" }
        ]
    },
    {
        "section": "oasis",
        "basePath": "/command-hub/oasis/",
        "tabs": [
            { "key": "events", "path": "/command-hub/oasis/events/" },
            { "key": "vtid-ledger", "path": "/command-hub/oasis/vtid-ledger/" },
            { "key": "entities", "path": "/command-hub/oasis/entities/" },
            { "key": "streams", "path": "/command-hub/oasis/streams/" },
            { "key": "command-log", "path": "/command-hub/oasis/command-log/" }
        ]
    },
    {
        "section": "databases",
        "basePath": "/command-hub/databases/",
        "tabs": [
            { "key": "supabase", "path": "/command-hub/databases/supabase/" },
            { "key": "vectors", "path": "/command-hub/databases/vectors/" },
            { "key": "cache", "path": "/command-hub/databases/cache/" },
            { "key": "analytics", "path": "/command-hub/databases/analytics/" },
            { "key": "clusters", "path": "/command-hub/databases/clusters/" }
        ]
    },
    {
        "section": "infrastructure",
        "basePath": "/command-hub/infrastructure/",
        "tabs": [
            { "key": "services", "path": "/command-hub/infrastructure/services/" },
            { "key": "health", "path": "/command-hub/infrastructure/health/" },
            { "key": "deployments", "path": "/command-hub/infrastructure/deployments/" },
            { "key": "logs", "path": "/command-hub/infrastructure/logs/" },
            { "key": "config", "path": "/command-hub/infrastructure/config/" }
        ]
    },
    {
        "section": "security-dev",
        "basePath": "/command-hub/security-dev/",
        "tabs": [
            { "key": "policies", "path": "/command-hub/security-dev/policies/" },
            { "key": "roles", "path": "/command-hub/security-dev/roles/" },
            { "key": "keys-secrets", "path": "/command-hub/security-dev/keys-secrets/" },
            { "key": "audit-log", "path": "/command-hub/security-dev/audit-log/" },
            { "key": "rls-access", "path": "/command-hub/security-dev/rls-access/" }
        ]
    },
    {
        "section": "integrations-tools",
        "basePath": "/command-hub/integrations-tools/",
        "tabs": [
            { "key": "mcp-connectors", "path": "/command-hub/integrations-tools/mcp-connectors/" },
            { "key": "llm-providers", "path": "/command-hub/integrations-tools/llm-providers/" },
            { "key": "apis", "path": "/command-hub/integrations-tools/apis/" },
            { "key": "tools", "path": "/command-hub/integrations-tools/tools/" },
            { "key": "service-mesh", "path": "/command-hub/integrations-tools/service-mesh/" }
        ]
    },
    {
        "section": "diagnostics",
        "basePath": "/command-hub/diagnostics/",
        "tabs": [
            { "key": "health-checks", "path": "/command-hub/diagnostics/health-checks/" },
            { "key": "latency", "path": "/command-hub/diagnostics/latency/" },
            { "key": "errors", "path": "/command-hub/diagnostics/errors/" },
            { "key": "sse", "path": "/command-hub/diagnostics/sse/" },
            { "key": "debug-panel", "path": "/command-hub/diagnostics/debug-panel/" }
        ]
    },
    {
        "section": "models-evaluations",
        "basePath": "/command-hub/models-evaluations/",
        "tabs": [
            { "key": "models", "path": "/command-hub/models-evaluations/models/" },
            { "key": "evaluations", "path": "/command-hub/models-evaluations/evaluations/" },
            { "key": "benchmarks", "path": "/command-hub/models-evaluations/benchmarks/" },
            { "key": "routing", "path": "/command-hub/models-evaluations/routing/" },
            { "key": "playground", "path": "/command-hub/models-evaluations/playground/" }
        ]
    },
    {
        "section": "testing-qa",
        "basePath": "/command-hub/testing-qa/",
        "tabs": [
            { "key": "unit-tests", "path": "/command-hub/testing-qa/unit-tests/" },
            { "key": "integration-tests", "path": "/command-hub/testing-qa/integration-tests/" },
            { "key": "validator-tests", "path": "/command-hub/testing-qa/validator-tests/" },
            { "key": "e2e", "path": "/command-hub/testing-qa/e2e/" },
            { "key": "ci-reports", "path": "/command-hub/testing-qa/ci-reports/" }
        ]
    },
    {
        "section": "intelligence-memory-dev",
        "basePath": "/command-hub/intelligence-memory-dev/",
        "tabs": [
            { "key": "memory-vault", "path": "/command-hub/intelligence-memory-dev/memory-vault/" },
            { "key": "knowledge-graph", "path": "/command-hub/intelligence-memory-dev/knowledge-graph/" },
            { "key": "embeddings", "path": "/command-hub/intelligence-memory-dev/embeddings/" },
            { "key": "recall", "path": "/command-hub/intelligence-memory-dev/recall/" },
            { "key": "inspector", "path": "/command-hub/intelligence-memory-dev/inspector/" }
        ]
    },
    {
        "section": "docs",
        "basePath": "/command-hub/docs/",
        "tabs": [
            { "key": "screens", "path": "/command-hub/docs/screens/" },
            { "key": "api-inventory", "path": "/command-hub/docs/api-inventory/" },
            { "key": "database-schemas", "path": "/command-hub/docs/database-schemas/" },
            { "key": "architecture", "path": "/command-hub/docs/architecture/" },
            { "key": "workforce", "path": "/command-hub/docs/workforce/" }
        ]
    }
];

const SECTION_LABELS = {
    'overview': 'Overview',
    'admin': 'Admin',
    'operator': 'Operator',
    'command-hub': 'Command Hub',
    'governance': 'Governance',
    'agents': 'Agents',
    'workflows': 'Workflows',
    'oasis': 'OASIS',
    'databases': 'Databases',
    'infrastructure': 'Infrastructure',
    'security-dev': 'Security (Dev)',
    'integrations-tools': 'Integrations & Tools',
    'diagnostics': 'Diagnostics',
    'models-evaluations': 'Models & Evaluations',
    'testing-qa': 'Testing & QA',
    'intelligence-memory-dev': 'Intelligence & Memory (Dev)',
    'docs': 'Docs'
};

const splitScreenCombos = [
    { id: 'operatorLogs+commandHubTasks', label: 'Operator Logs + Tasks', left: { module: 'operator', tab: 'execution-logs' }, right: { module: 'command-hub', tab: 'tasks' } },
    { id: 'commandHubTasks+commandHubDetail', label: 'Tasks + Live Console', left: { module: 'command-hub', tab: 'tasks' }, right: { module: 'command-hub', tab: 'live-console' } },
    { id: 'oasisEvents+commandHubHistory', label: 'OASIS Events + History', left: { module: 'oasis', tab: 'events' }, right: { module: 'governance', tab: 'history' } },
    { id: 'governanceEvaluations+commandHubTasks', label: 'Gov Evals + Tasks', left: { module: 'governance', tab: 'evaluations' }, right: { module: 'command-hub', tab: 'tasks' } },
    { id: 'agentsActivity+operatorLogs', label: 'Agents + Operator', left: { module: 'agents', tab: 'pipelines' }, right: { module: 'operator', tab: 'execution-logs' } },
    { id: 'testingRuns+commandHubTasks', label: 'Test Runs + Tasks', left: { module: 'testing-qa', tab: 'e2e' }, right: { module: 'command-hub', tab: 'tasks' } }
];

// --- State ---

// VTID-01055: Track VTIDs from last API response for ghost card detection
var lastApiVtids = new Set();
var isManualRefresh = false;

const state = {
    currentModuleKey: 'command-hub', // Will be overwritten by router
    currentTab: 'tasks', // Will be overwritten by router
    sidebarCollapsed: false,

    // Tasks
    tasks: [],
    tasksLoading: false,
    tasksError: null,
    selectedTask: null,
    // VTID-0527: VTID detail with stageTimeline from API
    selectedTaskDetail: null,
    selectedTaskDetailLoading: false,
    // VTID-01209: Real-time execution status for pipeline tracking
    executionStatus: null,
    executionStatusLoading: false,
    executionStatusPollInterval: null,
    // VTID-01209: Active in-progress VTIDs for ticker views
    activeExecutions: [],
    activeExecutionsPollInterval: null,
    taskSearchQuery: '',
    taskDateFilter: '',
    // VTID-01079: Board metadata for "Load More" completed tasks
    boardMeta: null,
    // DEV-COMHU-2025-0013: Drawer spec state for stable textarea editing
    drawerSpecVtid: null,   // Which task's spec is being edited
    drawerSpecText: '',     // Live text during editing (not persisted until Save)
    // DEV-COMHU-2025-0015: Guard against re-render while editing spec textarea
    drawerSpecEditing: false,

    // Split Screen
    isSplitScreen: false,
    activeSplitScreenId: null,
    leftPane: null,
    rightPane: null,

    // Modals
    showProfileModal: false,
    showTaskModal: false,
    // VTID-01003: Modal draft state for stable input editing (prevents reset on re-render)
    modalDraftTitle: '',
    modalDraftStatus: 'Scheduled',
    modalDraftSpec: '',
    modalDraftEditing: false, // Guard against re-render while editing
    // VTID-01010: Target Role state for task creation and filtering
    modalDraftTargetRoles: [], // Array of selected role strings
    taskRoleFilter: 'ALL', // 'ALL' or one of TARGET_ROLES

    // SPEC-01: Global Refresh State
    globalRefreshLoading: false,

    // Global Overlays (VTID-0508 / VTID-0509)
    isHeartbeatOpen: false,
    isOperatorOpen: false,
    operatorActiveTab: 'ticker', // 'chat', 'ticker', 'history'

    // VTID-0509: Operator Console State
    operatorHeartbeatActive: false,
    operatorSseSource: null,
    operatorHeartbeatSnapshot: null,

    // Operator Chat State
    chatMessages: [],
    chatInputValue: '',
    chatAttachments: [], // Array of { oasis_ref, kind, name }
    chatSending: false,
    chatIsTyping: false, // VTID-0526-D: Guard against scroll/render during typing
    // VTID-01027: Session Memory State
    operatorChatHistory: [], // Array of { role: 'user'|'assistant', content, ts }
    operatorConversationId: null, // UUID for conversation continuity

    // VTID-01041: Pending title capture state for ORB task creation
    pendingTitleVtid: null, // VTID awaiting title input from user
    pendingTitleRetryCount: 0, // Number of retry prompts sent

    // Operator Ticker State
    tickerEvents: [],

    // VTID-01019: Pending Operator Actions (OASIS ACK Binding)
    // Tracks actions awaiting OASIS confirmation - UI shows Loading until confirmed
    pendingOperatorActions: [],
    // Structure: { id, type, vtid, startedAt, timeoutMs, description }
    // Types: 'deploy', 'approval', 'chat'

    // VTID-0526-D: Stage Counters State (4-stage model)
    stageCounters: {
        PLANNER: 0,
        WORKER: 0,
        VALIDATOR: 0,
        DEPLOY: 0
    },
    stageCountersLoading: false,
    telemetrySnapshotError: null,
    lastTelemetryRefresh: null,
    telemetryAutoRefreshEnabled: true,

    // VTID-0527: Raw telemetry events for task stage computation
    telemetryEvents: [],

    // DEV-COMHU-0202: Global events state for VTID correlation
    events: [],

    // Operator History State
    historyEvents: [],
    historyLoading: false,
    historyError: null,

    // User (fallback values - will be replaced by authIdentity when available)
    user: {
        name: 'Loading...',
        role: 'User',
        avatar: '...'
    },

    // VTID-01014: View Role (persisted in localStorage)
    viewRole: localStorage.getItem('vitana.viewRole') || 'Admin',

    // VTID-01049: Authoritative Me Context from Gateway API
    // This is the single source of truth for user identity and role
    meContext: null, // { user_id, email, tenant_id, roles, active_role, active_role_source, ts }
    meContextLoading: false,
    meContextError: null,
    // Auth token for API calls (set via dev-auth or Supabase session)
    authToken: localStorage.getItem('vitana.authToken') || null,

    // VTID-01171: Auth Identity from /api/v1/auth/me
    // Contains user identity (email, user_id), profile (display_name, avatar_url), memberships
    authIdentity: null,
    authIdentityLoading: false,
    authIdentityError: null,

    // VTID-01186: Login Form State
    loginEmail: '',
    loginPassword: '',
    loginLoading: false,
    loginError: null,
    // VTID-01196: Store login email as fallback for profile display
    loginUserEmail: null,

    // Docs / Screen Inventory
    screenInventory: null,
    screenInventoryLoading: false,
    screenInventoryError: null,
    selectedRole: 'DEVELOPER',

    // Version History (VTID-0517)
    isVersionDropdownOpen: false,
    versionHistory: [],
    selectedVersionId: null,

    // Publish Modal (VTID-0517)
    showPublishModal: false,

    // VTID-01180: Autopilot Recommendations Modal
    showAutopilotRecommendationsModal: false,
    autopilotRecommendations: [],
    autopilotRecommendationsLoading: false,
    autopilotRecommendationsError: null,
    autopilotRecommendationsCount: 0,

    // VTID-0407: Governance Blocked Modal
    showGovernanceBlockedModal: false,
    governanceBlockedData: null, // { level, violations, service, vtid }

    // VTID-01194: Execution Approval Confirmation Modal
    // "IN_PROGRESS = Explicit Human Approval to Execute"
    showExecutionApprovalModal: false,
    executionApprovalVtid: null,
    executionApprovalReason: '',
    executionApprovalLoading: false,

    // Toast Notifications (VTID-0517)
    toasts: [],

    // CI/CD Health (VTID-0520)
    cicdHealth: null,
    cicdHealthLoading: false,
    cicdHealthError: null,
    cicdHealthTooltipOpen: false,

    // Governance Rules (VTID-0401, VTID-0405)
    governanceRules: [],
    governanceRulesLoading: false,
    governanceRulesError: null,
    governanceRulesSearchQuery: '',
    governanceRulesLevelFilter: '',
    governanceRulesCategoryFilter: '',
    governanceRulesSourceFilter: '',
    governanceRulesSortColumn: 'id',
    governanceRulesSortDirection: 'asc',
    selectedGovernanceRule: null,

    // VTID-01172: Admin Dev Users (exafy_admin toggle)
    adminDevUsers: [],
    adminDevUsersLoading: false,
    adminDevUsersError: null,
    adminDevUsersSearchQuery: '',
    adminDevUsersGrantEmail: '',
    adminDevUsersGrantLoading: false,
    adminDevUsersGrantError: null,

    // VTID-01195: Admin Screens v1 State
    // Users screen state
    adminUsersSearchQuery: '',
    adminUsersSelectedId: null,
    // Permissions screen state
    adminPermissionsSearchQuery: '',
    adminPermissionsSelectedKey: null,
    // Tenants screen state
    adminTenantsSearchQuery: '',
    adminTenantsSelectedId: null,
    // Content Moderation screen state
    adminModerationTypeFilter: '',
    adminModerationStatusFilter: '',
    adminModerationSelectedId: null,
    // Identity Access screen state (no selection needed - static panels)

    // VTID-0406: Governance Evaluations (OASIS Integration)
    governanceEvaluations: [],
    governanceEvaluationsLoading: false,
    governanceEvaluationsError: null,
    governanceEvaluationsResultFilter: '',
    governanceEvaluationsFetched: false,

    // VTID-0408: Governance History (Event Timeline)
    governanceHistory: {
        items: [],
        loading: false,
        error: null,
        filters: {
            type: 'all',
            level: 'all',
            actor: 'all',
            range: '7d'
        },
        pagination: {
            limit: 50,
            offset: 0,
            hasMore: false
        },
        selectedEvent: null,
        fetched: false
    },

    // VTID-0409: Governance Categories (Read-Only V1)
    governanceCategories: {
        items: [],
        loading: false,
        error: null,
        selectedCategoryId: null,
        fetched: false
    },

    // VTID-01181: Governance Controls (System Controls)
    governanceControls: {
        items: [],
        loading: false,
        error: null,
        fetched: false,
        // Modal state for enable/disable
        showEnableModal: false,
        showDisableModal: false,
        selectedControlKey: null,
        enableReason: '',
        enableDuration: 60, // minutes
        disableReason: '',
        actionLoading: false,
        actionError: null,
        // History drawer state
        showHistoryDrawer: false,
        historyItems: [],
        historyLoading: false,
        historyError: null
    },

    // VTID-0150-A: ORB UI State (Global Assistant Overlay)
    // VTID-0150-B: Added sessionId for Assistant Core integration
    // DEV-COMHU-2025-0014: Added live voice session state
    // VTID-0135: Added voice conversation state with Web Speech APIs
    orb: {
        overlayVisible: false,
        chatDrawerOpen: false,
        micActive: false,
        cameraActive: false,
        screenShareActive: false,
        // VTID-01069-D: Media stream handles for camera/screen
        cameraStream: null,
        screenStream: null,
        isThinking: false,
        sessionId: null, // VTID-0150-B: Tracks Assistant Core session
        chatMessages: [
            // Initial assistant greeting
            { id: 1, role: 'assistant', content: 'Hello! I\'m your Vitana assistant. How can I help you today?', timestamp: new Date().toISOString() }
        ],
        chatInputValue: '',
        // DEV-COMHU-2025-0014: Live voice session state (legacy audio streaming)
        liveSessionId: null,
        liveConnected: false,
        liveTranscript: [],
        liveMuted: false,
        liveError: null,
        liveAudioStream: null,
        liveAudioContext: null,
        liveAudioProcessor: null,
        liveEventSource: null,
        // VTID-0135: Voice conversation state (Web Speech APIs)
        voiceState: 'IDLE', // IDLE | LISTENING | THINKING | SPEAKING | MUTED
        conversationId: null,
        orbSessionId: null,
        speechRecognition: null,
        speechSynthesisUtterance: null,
        interimTranscript: '',
        voiceError: null,
        // VTID-01037: TTS/STT feedback loop prevention state
        speaking: false,           // true while TTS is actively speaking
        ignoreSTTUntil: 0,         // timestamp (ms) - ignore STT results until this time
        lastTTSText: '',           // last TTS text for echo similarity filtering
        transcriptNearBottom: true, // track if user was near bottom for scroll anchoring
        // VTID-01044: Flag to prevent auto-restart when aborting for TTS
        abortedForTTS: false,      // true when recognition aborted to start TTS
        // VTID-01038: TTS voice selection state
        ttsVoices: [],
        ttsSelectedVoiceUri: null,
        ttsVoicesLoaded: false,
        // VTID-01042: Unified Language selector state
        orbLang: 'en-US', // Single source of truth for STT + TTS language
        orbLangWarning: null, // Warning message for voice fallback
        // VTID-01066: ORB Conversation Stream v1 state
        thinkingPlaceholderId: null, // ID of thinking placeholder message
        speakingMessageId: null,     // ID of currently speaking message
        speakingDurationClass: null, // speak-dur-1..4 class for progress animation
        // VTID-01067: ORB Presence Layer state
        speakingBeatTimer: null, // Interval for speaking pulse beat
        microStatusText: '', // Current micro-status message
        microStatusTimer: null, // Auto-clear timer for micro-status
        micShimmerActive: false, // Whether mic shimmer is active
        // VTID-01155: Gemini Live Multimodal Session state
        geminiLiveSessionId: null,    // Current Gemini Live session ID
        geminiLiveActive: false,      // Whether Live session is active
        geminiLiveEventSource: null,  // SSE EventSource for Live stream
        geminiLiveAudioContext: null, // AudioContext for PCM playback
        geminiLiveAudioQueue: [],     // Queue of audio chunks to play
        geminiLiveFrameInterval: null, // Interval for capturing video frames
        geminiLiveAudioStream: null,  // MediaStream for audio capture
        geminiLiveAudioProcessor: null, // ScriptProcessorNode for audio
        geminiTtsAudio: null          // Current Gemini-TTS Audio element for barge-in
    },

    // VTID-0600: Operational Visibility Foundation State
    oasisEvents: {
        items: [],
        loading: false,
        error: null,
        fetched: false,
        selectedEvent: null,
        filters: {
            topic: '',
            service: '',
            status: ''
        },
        autoRefreshEnabled: false, // VTID-01189: Disabled - use global refresh only
        autoRefreshInterval: null,
        // VTID-01189: Pagination state for infinite scroll
        pagination: {
            limit: 50,
            offset: 0,
            hasMore: true
        },
        // VTID-01039: ORB Session Transcript State
        orbTranscript: null,
        orbTranscriptLoading: false,
        orbTranscriptError: null
    },

    // VTID-0600: Command Hub Events (Curated Operational View)
    commandHubEvents: {
        items: [],
        loading: false,
        error: null,
        fetched: false,
        filters: {
            topic: '',
            service: '',
            status: ''
        }
    },

    // VTID-0600: VTIDs Lifecycle Overview
    vtidsList: {
        items: [],
        loading: false,
        error: null,
        fetched: false,
        selectedVtid: null
    },

    // DEV-COMHU-2025-0008: VTID Ledger from authoritative API
    vtidLedger: {
        items: [],
        loading: false,
        error: null,
        fetched: false
    },

    // VTID-01001: VTID Projection for decision-grade visibility
    vtidProjection: {
        items: [],
        loading: false,
        error: null,
        fetched: false,
        // VTID-01189: Pagination state for infinite scroll
        pagination: {
            limit: 50,
            offset: 0,
            hasMore: true
        }
    },

    // VTID-0600: Approvals UI Scaffolding
    // VTID-01151: Added pending_count for badge counter
    // VTID-01154: Added GitHub feed state
    approvals: {
        items: [],
        loading: false,
        error: null,
        fetched: false,
        pending_count: 0,
        countFetched: false,
        // VTID-01154: GitHub-authoritative feed
        feedItems: [],
        feedLoading: false,
        feedError: null,
        feedFetched: false
    },

    // VTID-0600: Ticker Severity Prioritization
    tickerCollapseHeartbeat: true,
    tickerSeverityFilter: 'all', // 'all', 'critical', 'important', 'info'

    // VTID-01086: Memory Garden State
    memoryGarden: {
        progress: null,        // { totals, categories }
        loading: false,
        error: null,
        fetched: false,
        longevity: null,       // Longevity panel data
        longevityLoading: false,
        longevityError: null,
        showDiaryModal: false  // Diary entry modal state
    },

    // Intelligence & Memory DEV: Knowledge Graph, Embeddings, Recall, Inspector
    intelligence: {
        // Knowledge Graph
        knowledgeGraph: {
            nodes: [],
            edges: [],
            stats: null,
            loading: false,
            loadingMore: false,
            error: null,
            fetched: false,
            selectedNode: null,
            filterType: 'all',   // 'all', 'entity', 'concept', 'memory'
            searchQuery: '',
            // Pagination
            offset: 0,
            limit: 50,
            hasMore: true
        },
        // Embeddings
        embeddings: {
            collections: [],
            stats: null,
            loading: false,
            error: null,
            fetched: false,
            selectedCollection: null,
            searchQuery: '',
            searchResults: [],
            searchLoading: false,
            // Pagination for search results
            searchOffset: 0,
            searchLimit: 20,
            searchHasMore: false
        },
        // Recall
        recall: {
            testQuery: '',
            results: [],
            loading: false,
            loadingMore: false,
            error: null,
            history: [],
            selectedResult: null,
            filters: {
                source: 'all',
                minScore: 0
            },
            // Pagination
            offset: 0,
            limit: 20,
            hasMore: true
        },
        // Inspector
        inspector: {
            sessions: [],
            selectedSession: null,
            loading: false,
            loadingMore: false,
            error: null,
            fetched: false,
            filters: {
                surface: 'all',    // 'all', 'operator', 'orb', 'api'
                status: 'all',     // 'all', 'success', 'error', 'pending'
                dateRange: '24h'   // '1h', '24h', '7d', '30d'
            },
            expandedTools: {},     // Track expanded tool calls
            // Pagination
            offset: 0,
            limit: 25,
            hasMore: true
        }
    },

    // VTID-01173: Agents Control Plane v1 - Worker Orchestrator Registry
    agentsRegistry: {
        // API response data
        orchestratorHealth: null,
        subagents: null,
        skills: null,
        // Loading states
        loading: false,
        fetched: false,
        // API call timing (ms)
        timing: {
            orchestratorHealth: null,
            subagents: null,
            skills: null
        },
        // API status codes
        status: {
            orchestratorHealth: null,
            subagents: null,
            skills: null
        },
        // Error state
        errors: {
            orchestratorHealth: null,
            subagents: null,
            skills: null
        },
        // Raw JSON debug toggle states
        showRawHealth: false,
        showRawSubagents: false,
        showRawSkills: false
    },

    // VTID-01174: Agents Control Plane v2 - Pipelines (Runs + Traces)
    agentsPipelines: {
        // Filter state
        activeFilter: 'all', // 'active' | 'recent' | 'failed' | 'all'
        timeWindow: '48h',   // '1h' | '24h' | '48h' | '7d'
        // Data
        items: [],           // VTID ledger items with stage timelines
        eventsCache: {},     // VTID -> events array (for trace expansion)
        // UI state
        expandedVtids: {},   // VTID -> boolean (expanded trace view)
        loading: false,
        fetched: false,
        // VTID-01211: Pagination state for Load More
        pagination: {
            limit: 50,
            offset: 0,
            hasMore: true
        },
        // API timing/status
        timing: {
            ledger: null,
            events: null
        },
        status: {
            ledger: null,
            events: null
        },
        errors: {
            ledger: null,
            events: null
        },
        // Debug
        showRawLedger: false
    },

    // VTID-01208: LLM Telemetry + Model Provenance + Runtime Routing Control
    agentsTelemetry: {
        // Routing Policy
        policy: null,
        providers: [],
        models: [],
        recommended: null,
        policyLoading: false,
        policyFetched: false,
        policyError: null,
        // Telemetry events
        events: [],
        eventsLoading: false,
        eventsFetched: false,
        eventsError: null,
        // VTID-01211: Pagination state for Load More
        pagination: {
            limit: 50,
            offset: 0,
            hasMore: true
        },
        // Filters
        filters: {
            vtid: '',
            stage: '',
            provider: '',
            model: '',
            service: '',
            status: '',
            timeWindow: '1h'
        },
        // UI state
        activeTab: 'telemetry', // 'telemetry' | 'routing'
        showAuditLog: false,
        auditRecords: [],
        auditLoading: false,
        // Edit state
        editingPolicy: null,
        saveInProgress: false,
        saveError: null
    }
};

// --- VTID-0527: Task Stage Timeline Model ---

/**
 * VTID-0527: Task execution stages in order.
 * This defines the 4-stage pipeline: PLANNER → WORKER → VALIDATOR → DEPLOY
 */
const TASK_STAGES = ['PLANNER', 'WORKER', 'VALIDATOR', 'DEPLOY'];

/**
 * VTID-0527: Stage display labels (short form for pills)
 */
const STAGE_LABELS = {
    PLANNER: 'PL',
    WORKER: 'WO',
    VALIDATOR: 'VA',
    DEPLOY: 'DE'
};

/**
 * VTID-0527: Derive task stage state from telemetry events.
 * Computes which stages are completed, current, and pending for a task.
 *
 * @param {Object} task - Task object with vtid
 * @param {Array} events - Telemetry events array
 * @returns {Object} Stage state object
 */
function deriveTaskStageState(task, events) {
    // Filter events relevant to this task by vtid
    const relevantEvents = events.filter(function(ev) {
        return ev.vtid === task.vtid;
    });

    // Build stage info
    const byStage = {};
    TASK_STAGES.forEach(function(stage) {
        const stageEvents = relevantEvents.filter(function(ev) {
            return ev.task_stage === stage;
        });
        byStage[stage] = {
            reached: stageEvents.length > 0,
            latestEvent: stageEvents.length > 0 ? stageEvents.reduce(function(a, b) {
                return new Date(a.created_at) > new Date(b.created_at) ? a : b;
            }) : null,
            eventCount: stageEvents.length
        };
    });

    // Determine current stage (highest reached stage)
    let currentStage = null;
    for (var i = TASK_STAGES.length - 1; i >= 0; i--) {
        if (byStage[TASK_STAGES[i]].reached) {
            currentStage = TASK_STAGES[i];
            break;
        }
    }

    // Build completed/pending lists
    const completed = [];
    const pending = [];
    let reachedCurrent = false;

    TASK_STAGES.forEach(function(stage) {
        if (byStage[stage].reached) {
            if (stage === currentStage) {
                reachedCurrent = true;
            } else if (!reachedCurrent) {
                completed.push(stage);
            }
        } else {
            pending.push(stage);
        }
    });

    return {
        currentStage: currentStage,
        completed: completed,
        pending: pending,
        byStage: byStage,
        hasAnyStage: currentStage !== null
    };
}

/**
 * VTID-0527: Format timestamp for stage detail display
 */
function formatStageTimestamp(isoString) {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// --- VTID-0600: Operational Visibility Foundation ---

/**
 * VTID-0600: Event Severity Levels
 * Used for prioritizing and color-coding events in ticker and views.
 */
const EVENT_SEVERITY = {
    CRITICAL: 'critical',   // deploy failed, governance denied
    IMPORTANT: 'important', // deploy success, governance allowed
    INFO: 'info',           // autopilot events, general operations
    LOW: 'low'              // heartbeat, pings, routine checks
};

/**
 * VTID-0600: Severity color mapping (CSP compliant hex values)
 */
const SEVERITY_COLORS = {
    critical: '#ff4d4f',
    important: '#f7b731',
    info: '#2ecc71',
    low: '#95a5a6'
};

/**
 * VTID-0600: Determine event severity based on topic and status
 * @param {Object} event - OASIS event object
 * @returns {string} Severity level (critical, important, info, low)
 */
function getEventSeverity(event) {
    const topic = (event.topic || '').toLowerCase();
    const status = (event.status || '').toLowerCase();

    // Critical: failures, denials, blocked events
    if (status === 'error' || status === 'fail' || status === 'blocked') {
        return EVENT_SEVERITY.CRITICAL;
    }
    if (topic.includes('.failed') || topic.includes('.blocked') || topic.includes('.denied')) {
        return EVENT_SEVERITY.CRITICAL;
    }
    if (topic.includes('governance') && status === 'deny') {
        return EVENT_SEVERITY.CRITICAL;
    }

    // Important: successes, approvals, deployments
    if (topic.includes('deploy') && (status === 'success' || topic.includes('.success'))) {
        return EVENT_SEVERITY.IMPORTANT;
    }
    if (topic.includes('governance') && (status === 'allow' || status === 'success')) {
        return EVENT_SEVERITY.IMPORTANT;
    }
    if (topic.includes('.success') || topic.includes('.approved')) {
        return EVENT_SEVERITY.IMPORTANT;
    }

    // Low: heartbeat, ping, routine checks
    if (topic.includes('heartbeat') || topic.includes('ping') || topic.includes('health')) {
        return EVENT_SEVERITY.LOW;
    }

    // Default: info level
    return EVENT_SEVERITY.INFO;
}

/**
 * VTID-0600: Format event timestamp for display
 */
function formatEventTimestamp(isoString) {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/**
 * VTID-0600: Fetch OASIS events from the API
 * VTID-01189: Added pagination support for infinite scroll
 * @param {Object} filters - Optional filters (topic, service, status)
 * @param {boolean} append - If true, append to existing items (Load More)
 */
async function fetchOasisEvents(filters, append) {
    console.log('[VTID-0600] Fetching OASIS events...', append ? '(append)' : '(fresh)');

    if (state.oasisEvents.loading) return;
    if (append && !state.oasisEvents.pagination.hasMore) return;

    state.oasisEvents.loading = true;
    renderApp();

    try {
        var pagination = state.oasisEvents.pagination;
        var offset = append ? pagination.offset : 0;

        var queryParams = 'limit=' + pagination.limit + '&offset=' + offset;
        if (filters) {
            if (filters.topic) queryParams += '&topic=like.*' + encodeURIComponent(filters.topic) + '*';
            if (filters.service) queryParams += '&service=eq.' + encodeURIComponent(filters.service);
            if (filters.status) queryParams += '&status=eq.' + encodeURIComponent(filters.status);
        }

        const response = await fetch('/api/v1/oasis/events?' + queryParams);
        if (!response.ok) {
            throw new Error('OASIS events fetch failed: ' + response.status);
        }

        const data = await response.json();
        var items = Array.isArray(data) ? data : (data.data || []);
        console.log('[VTID-0600] OASIS events loaded:', items.length);

        if (append) {
            state.oasisEvents.items = state.oasisEvents.items.concat(items);
        } else {
            state.oasisEvents.items = items;
        }

        // VTID-01189: Update pagination state
        state.oasisEvents.pagination = {
            limit: pagination.limit,
            offset: offset + items.length,
            hasMore: data.pagination ? data.pagination.has_more : items.length === pagination.limit
        };

        state.oasisEvents.error = null;
        state.oasisEvents.fetched = true;
    } catch (error) {
        console.error('[VTID-0600] Failed to fetch OASIS events:', error);
        state.oasisEvents.error = error.message;
        if (!append) {
            state.oasisEvents.items = [];
        }
    } finally {
        state.oasisEvents.loading = false;
        renderApp();
    }
}

/**
 * VTID-01189: Load more OASIS events (infinite scroll)
 */
function loadMoreOasisEvents() {
    fetchOasisEvents(state.oasisEvents.filters, true);
}

/**
 * VTID-01189: Handle OASIS filter change - reset pagination and fetch fresh
 */
function handleOasisFilterChange() {
    state.oasisEvents.pagination.offset = 0;
    state.oasisEvents.pagination.hasMore = true;
    fetchOasisEvents(state.oasisEvents.filters, false);
}

/**
 * VTID-0600: Start auto-refresh for OASIS events (5 second interval)
 * VTID-01002: Uses silentRefresh to avoid full DOM rebuild during polling
 */
function startOasisEventsAutoRefresh() {
    if (state.oasisEvents.autoRefreshInterval) {
        clearInterval(state.oasisEvents.autoRefreshInterval);
    }
    state.oasisEvents.autoRefreshEnabled = true;
    state.oasisEvents.autoRefreshInterval = setInterval(function() {
        if (state.oasisEvents.autoRefreshEnabled) {
            // VTID-01002: Use silentRefresh=true to preserve scroll positions
            fetchOasisEvents(state.oasisEvents.filters, true);
        }
    }, 5000);
    console.log('[VTID-0600] OASIS events auto-refresh started (5s interval, scroll-safe)');
}

/**
 * VTID-0600: Stop auto-refresh for OASIS events
 */
function stopOasisEventsAutoRefresh() {
    if (state.oasisEvents.autoRefreshInterval) {
        clearInterval(state.oasisEvents.autoRefreshInterval);
        state.oasisEvents.autoRefreshInterval = null;
    }
    state.oasisEvents.autoRefreshEnabled = false;
    console.log('[VTID-0600] OASIS events auto-refresh stopped');
}

/**
 * VTID-0600: Fetch Command Hub Events (filtered operational events)
 * Only fetches events relevant to supervision: deploy.*, governance.*, cicd.*, autopilot.*
 */
async function fetchCommandHubEvents() {
    console.log('[VTID-0600] Fetching Command Hub events...');
    state.commandHubEvents.loading = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/oasis/events?limit=100');
        if (!response.ok) {
            throw new Error('Command Hub events fetch failed: ' + response.status);
        }

        const data = await response.json();
        var allEvents = Array.isArray(data) ? data : [];

        // Filter to operational events only
        var operationalTopics = ['deploy', 'governance', 'cicd', 'autopilot', 'operator'];
        var filteredEvents = allEvents.filter(function(event) {
            var topic = (event.topic || '').toLowerCase();
            return operationalTopics.some(function(prefix) {
                return topic.startsWith(prefix);
            });
        });

        // Apply additional filters from state
        if (state.commandHubEvents.filters.topic) {
            var topicFilter = state.commandHubEvents.filters.topic.toLowerCase();
            filteredEvents = filteredEvents.filter(function(e) {
                return (e.topic || '').toLowerCase().includes(topicFilter);
            });
        }
        if (state.commandHubEvents.filters.service) {
            filteredEvents = filteredEvents.filter(function(e) {
                return e.service === state.commandHubEvents.filters.service;
            });
        }
        if (state.commandHubEvents.filters.status) {
            filteredEvents = filteredEvents.filter(function(e) {
                return e.status === state.commandHubEvents.filters.status;
            });
        }

        console.log('[VTID-0600] Command Hub events filtered:', filteredEvents.length);
        state.commandHubEvents.items = filteredEvents;
        state.commandHubEvents.error = null;
        state.commandHubEvents.fetched = true;
    } catch (error) {
        console.error('[VTID-0600] Failed to fetch Command Hub events:', error);
        state.commandHubEvents.error = error.message;
        state.commandHubEvents.items = [];
    } finally {
        state.commandHubEvents.loading = false;
        renderApp();
    }
}

/**
 * VTID-0600: Fetch VTIDs list from OASIS events
 * Groups events by VTID to show lifecycle overview
 */
async function fetchVtidsList() {
    console.log('[VTID-0600] Fetching VTIDs list...');
    state.vtidsList.loading = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/oasis/events?limit=200');
        if (!response.ok) {
            throw new Error('VTIDs list fetch failed: ' + response.status);
        }

        const data = await response.json();
        var events = Array.isArray(data) ? data : [];

        // Group events by VTID
        var vtidMap = {};
        events.forEach(function(event) {
            if (!event.vtid) return;

            if (!vtidMap[event.vtid]) {
                vtidMap[event.vtid] = {
                    vtid: event.vtid,
                    layer: extractLayer(event.vtid),
                    status: 'PL', // default to PLANNER
                    events: [],
                    latestEvent: null,
                    services: new Set()
                };
            }

            vtidMap[event.vtid].events.push(event);
            if (event.service) {
                vtidMap[event.vtid].services.add(event.service);
            }

            // Update latest event
            if (!vtidMap[event.vtid].latestEvent ||
                new Date(event.created_at) > new Date(vtidMap[event.vtid].latestEvent.created_at)) {
                vtidMap[event.vtid].latestEvent = event;
            }

            // Determine status from event topic/stage
            var topic = (event.topic || '').toLowerCase();
            var stage = (event.task_stage || '').toUpperCase();
            if (stage === 'DEPLOY' || topic.includes('deploy')) {
                vtidMap[event.vtid].status = 'DE';
            } else if (stage === 'VALIDATOR' || topic.includes('validat')) {
                if (vtidMap[event.vtid].status !== 'DE') {
                    vtidMap[event.vtid].status = 'VA';
                }
            } else if (stage === 'WORKER' || topic.includes('work')) {
                if (vtidMap[event.vtid].status !== 'DE' && vtidMap[event.vtid].status !== 'VA') {
                    vtidMap[event.vtid].status = 'WO';
                }
            }
        });

        // Convert to array and sort by latest event
        var vtidList = Object.values(vtidMap);
        vtidList.forEach(function(v) {
            v.services = Array.from(v.services);
        });
        vtidList.sort(function(a, b) {
            var aTime = a.latestEvent ? new Date(a.latestEvent.created_at) : new Date(0);
            var bTime = b.latestEvent ? new Date(b.latestEvent.created_at) : new Date(0);
            return bTime - aTime;
        });

        console.log('[VTID-0600] VTIDs list generated:', vtidList.length);
        state.vtidsList.items = vtidList;
        state.vtidsList.error = null;
        state.vtidsList.fetched = true;
    } catch (error) {
        console.error('[VTID-0600] Failed to fetch VTIDs list:', error);
        state.vtidsList.error = error.message;
        state.vtidsList.items = [];
    } finally {
        state.vtidsList.loading = false;
        renderApp();
    }
}

/**
 * VTID-0600: Extract layer from VTID (DEV, CICD, GOV, ADM, etc.)
 */
function extractLayer(vtid) {
    if (!vtid) return 'UNK';
    var parts = vtid.split('-');
    if (parts.length >= 2) {
        // Check for known prefixes
        var prefix = parts[0].toUpperCase();
        if (prefix === 'VTID' && parts.length >= 2) {
            // Try to infer from number range
            var num = parseInt(parts[1], 10);
            if (num >= 100 && num < 200) return 'GOV';
            if (num >= 200 && num < 300) return 'DEV';
            if (num >= 400 && num < 500) return 'GOV';
            if (num >= 500 && num < 600) return 'DEV';
            if (num >= 600 && num < 700) return 'ADM';
            return 'DEV';
        }
        return prefix;
    }
    return 'UNK';
}

/**
 * DEV-COMHU-2025-0008: Fetch VTIDs from authoritative ledger API.
 * Uses GET /api/v1/vtid/list - the canonical source of truth for VTIDs.
 * Shows ledger-only VTIDs (0 events) immediately in UI.
 */
const VTID_LEDGER_LIMIT = 50;

async function fetchVtidLedger() {
    console.log('[DEV-COMHU-2025-0008] Fetching VTID ledger...');
    state.vtidLedger.loading = true;
    state.vtidLedger.error = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/vtid/list?limit=' + VTID_LEDGER_LIMIT);
        if (!response.ok) {
            throw new Error('VTID ledger fetch failed: ' + response.status);
        }

        var data = await response.json();

        // VTID-01001: Handle all response formats including { ok: true, data: [...] }
        var items = [];
        if (Array.isArray(data)) {
            items = data;
        } else if (data && Array.isArray(data.data)) {
            // Standard API format: { ok: true, count: N, data: [...] }
            items = data.data;
        } else if (data && Array.isArray(data.items)) {
            items = data.items;
        } else if (data && Array.isArray(data.vtids)) {
            items = data.vtids;
        } else {
            console.warn('[DEV-COMHU-2025-0008] Unexpected response format:', data);
            items = [];
        }

        console.log('[DEV-COMHU-2025-0008] VTID ledger loaded:', items.length, 'VTIDs');
        state.vtidLedger.items = items;
        state.vtidLedger.error = null;
        state.vtidLedger.fetched = true;
    } catch (error) {
        console.error('[DEV-COMHU-2025-0008] Failed to fetch VTID ledger:', error);
        state.vtidLedger.error = error.message;
        state.vtidLedger.items = [];
    } finally {
        state.vtidLedger.loading = false;
        renderApp();
    }
}

/**
 * VTID-01001: Fetch VTID projection for decision-grade visibility.
 * Uses GET /api/v1/vtid/projection - returns computed projection with:
 * - vtid, title, current_stage, status, attention_required, last_update, last_decision
 */
const VTID_PROJECTION_LIMIT = 50;

/**
 * VTID-01001: Fetch VTID projection
 * VTID-01189: Added pagination support for infinite scroll
 * @param {boolean} append - If true, append to existing items (Load More)
 */
async function fetchVtidProjection(append) {
    console.log('[VTID-01001] Fetching VTID projection...', append ? '(append)' : '(fresh)');

    if (state.vtidProjection.loading) return;
    if (append && !state.vtidProjection.pagination.hasMore) return;

    state.vtidProjection.loading = true;
    state.vtidProjection.error = null;
    renderApp();

    try {
        var pagination = state.vtidProjection.pagination;
        var offset = append ? pagination.offset : 0;

        var response = await fetch('/api/v1/vtid/projection?limit=' + pagination.limit + '&offset=' + offset);
        if (!response.ok) {
            throw new Error('VTID projection fetch failed: ' + response.status);
        }

        var data = await response.json();

        // Handle response format: { ok: true, count: N, data: [...] }
        var items = [];
        if (Array.isArray(data)) {
            items = data;
        } else if (data && Array.isArray(data.data)) {
            items = data.data;
        } else if (data && Array.isArray(data.items)) {
            items = data.items;
        } else {
            console.warn('[VTID-01001] Unexpected response format:', data);
            items = [];
        }

        console.log('[VTID-01001] VTID projection loaded:', items.length, 'VTIDs');

        if (append) {
            state.vtidProjection.items = state.vtidProjection.items.concat(items);
        } else {
            state.vtidProjection.items = items;
        }

        // VTID-01189: Update pagination state
        state.vtidProjection.pagination = {
            limit: pagination.limit,
            offset: offset + items.length,
            hasMore: data.pagination ? data.pagination.has_more : items.length === pagination.limit
        };

        state.vtidProjection.error = null;
        state.vtidProjection.fetched = true;
    } catch (error) {
        console.error('[VTID-01001] Failed to fetch VTID projection:', error);
        state.vtidProjection.error = error.message;
        // VTID-01030: Preserve last known good data on refresh failure
        // Do NOT wipe state.vtidProjection.items - keep existing data visible
        console.warn('[VTID-01030] Keeping', state.vtidProjection.items.length, 'cached VTIDs visible after fetch error');
    } finally {
        state.vtidProjection.loading = false;
        renderApp();
    }
}

/**
 * VTID-01189: Load more VTIDs (infinite scroll)
 */
function loadMoreVtidProjection() {
    fetchVtidProjection(true);
}

/**
 * VTID-01151: Incremental badge update - avoids full renderApp() during polling
 */
function updateApprovalsBadge() {
    var badge = document.querySelector('.approvals-badge');
    if (badge) {
        var count = state.approvals.pending_count;
        if (count > 0) {
            badge.textContent = count;
            badge.style.display = 'inline-flex';
        } else {
            badge.style.display = 'none';
        }
    }
}

// VTID-01151: Polling interval for approvals badge
var approvalsBadgePollingInterval = null;

/**
 * VTID-01151: Start polling for approvals (every 20s)
 * Uses silent refresh to update badge without full page re-render
 */
function startApprovalsBadgePolling() {
    if (approvalsBadgePollingInterval) return;
    console.log('[VTID-01151] Starting approvals polling (20s interval)');
    approvalsBadgePollingInterval = setInterval(function() {
        fetchApprovals(true); // silent=true for badge-only update
    }, 20000);
}

/**
 * VTID-01151: Stop polling for approvals
 */
function stopApprovalsBadgePolling() {
    if (approvalsBadgePollingInterval) {
        clearInterval(approvalsBadgePollingInterval);
        approvalsBadgePollingInterval = null;
        console.log('[VTID-01151] Stopped approvals polling');
    }
}

/**
 * VTID-0601: Fetch approvals from API
 * VTID-01151: Uses /api/v1/cicd/approvals, updates both items and count
 * @param {boolean} silent - If true, only update badge (no full renderApp)
 */
async function fetchApprovals(silent) {
    console.log('[VTID-01151] Fetching approvals...', silent ? '(silent)' : '');

    if (!silent) {
        state.approvals.loading = true;
        state.approvals.error = null;
        renderApp();
    }

    try {
        var response = await fetch('/api/v1/cicd/approvals', {
            headers: withVitanaContextHeaders({})
        });
        var data = await response.json();

        if (data.ok) {
            state.approvals.items = data.approvals || [];
            state.approvals.pending_count = state.approvals.items.length;
            state.approvals.error = null;
            console.log('[VTID-01151] Approvals loaded:', state.approvals.items.length, 'items');
        } else {
            if (!silent) {
                state.approvals.items = [];
                state.approvals.error = data.error || 'Failed to fetch approvals';
            }
            console.error('[VTID-01151] Approvals fetch error:', data.error);
        }
    } catch (err) {
        if (!silent) {
            state.approvals.items = [];
            state.approvals.error = err.message || 'Network error';
        }
        console.error('[VTID-01151] Approvals fetch exception:', err);
    }

    state.approvals.loading = false;
    state.approvals.fetched = true;

    if (silent) {
        updateApprovalsBadge();
    } else {
        renderApp();
    }
}

/**
 * VTID-0601: Approve an approval item (merge + optional deploy)
 * VTID-01019: Uses OASIS ACK binding - no optimistic UI
 * VTID-01151: Uses /api/v1/cicd/approvals/:id/approve
 */
async function approveApprovalItem(approvalId) {
    console.log('[VTID-01151] Approving item:', approvalId);
    state.approvals.loading = true;
    renderApp();

    try {
        var response = await fetch('/api/v1/cicd/approvals/' + approvalId + '/approve', {
            method: 'POST',
            headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' })
        });
        var data = await response.json();

        if (data.ok) {
            // ===========================================================
            // VTID-01019: OASIS ACK Binding - No optimistic success UI
            // Register pending action and wait for OASIS confirmation
            // ===========================================================
            var vtid = data.vtid || ('VTID-APPROVE-' + approvalId);
            var prTitle = data.pr_title || ('PR #' + (data.pr_number || approvalId));

            registerPendingAction({
                id: data.event_id || 'approve-' + approvalId,
                type: 'approval',
                vtid: vtid,
                description: 'Approve ' + prTitle + (data.deploy ? ' + deploy' : '')
            });

            // VTID-01019: Show LOADING toast instead of SUCCESS
            showToast('Approval submitted - awaiting confirmation...', 'info');

            // Add to ticker with "requested" status
            state.tickerEvents.unshift({
                id: Date.now(),
                timestamp: new Date().toLocaleTimeString(),
                type: 'cicd',
                topic: 'cicd.approval.requested',
                content: 'Approval requested: ' + prTitle + ' - awaiting OASIS confirmation',
                vtid: vtid
            });

            // VTID-01151: Refresh approvals list (also updates count)
            state.approvals.fetched = false;
            await fetchApprovals();
        } else {
            // VTID-01019: Immediate backend failure
            showToast('Approval failed: ' + (data.error || 'Unknown error'), 'error');
            state.approvals.loading = false;
            renderApp();
        }
    } catch (err) {
        // VTID-01019: Immediate network/backend error
        showToast('Approval failed: ' + err.message, 'error');
        state.approvals.loading = false;
        renderApp();
    }
}

/**
 * VTID-0601: Deny/reject an approval item
 * VTID-01151: Uses /api/v1/cicd/approvals/:id/deny
 */
async function denyApprovalItem(approvalId, reason) {
    console.log('[VTID-01151] Denying item:', approvalId);
    state.approvals.loading = true;
    renderApp();

    try {
        var response = await fetch('/api/v1/cicd/approvals/' + approvalId + '/deny', {
            method: 'POST',
            headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ reason: reason || 'Denied by user' })
        });
        var data = await response.json();

        if (data.ok) {
            showToast('Approval denied.', 'info');
            // VTID-01151: Refresh approvals list (also updates count)
            state.approvals.fetched = false;
            await fetchApprovals();
        } else {
            showToast('Rejection failed: ' + (data.error || 'Unknown error'), 'error');
            state.approvals.loading = false;
            renderApp();
        }
    } catch (err) {
        showToast('Rejection failed: ' + err.message, 'error');
        state.approvals.loading = false;
        renderApp();
    }
}

/**
 * VTID-01154: Fetch GitHub-authoritative feed
 * Pulls live PR data directly from GitHub via /api/v1/approvals/feed
 */
async function fetchGitHubFeed() {
    console.log('[VTID-01154] Fetching GitHub feed...');
    state.approvals.feedLoading = true;
    state.approvals.feedError = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/approvals/feed?limit=50', {
            headers: withVitanaContextHeaders({})
        });
        var data = await response.json();

        if (data.ok !== false) {
            state.approvals.feedItems = data.items || [];
            state.approvals.feedError = null;
            console.log('[VTID-01154] GitHub feed loaded:', state.approvals.feedItems.length, 'PRs');
        } else {
            state.approvals.feedItems = [];
            state.approvals.feedError = data.error || 'Failed to fetch GitHub feed';
            console.error('[VTID-01154] GitHub feed error:', state.approvals.feedError);
        }
    } catch (err) {
        state.approvals.feedItems = [];
        state.approvals.feedError = err.message || 'Network error';
        console.error('[VTID-01154] GitHub feed exception:', err);
    }

    state.approvals.feedLoading = false;
    state.approvals.feedFetched = true;
    renderApp();
}

/**
 * VTID-01168: Approve → Safe Merge → Auto-Deploy
 *
 * Calls POST /api/v1/cicd/autonomous-pr-merge with:
 * {
 *   "vtid": "VTID-####",
 *   "pr_number": 380,
 *   "merge_method": "squash",
 *   "automerge": true
 * }
 *
 * VTID is REQUIRED - approval is blocked if VTID is missing or invalid.
 */
async function approveFeedItem(prNumber, branch, vtid) {
    console.log('[VTID-01168] Approving PR #' + prNumber + ' from feed (vtid: ' + vtid + ')');

    // VTID-01168: Block approval if VTID is missing
    if (!vtid || vtid === 'UNKNOWN') {
        showToast('Approval blocked: VTID is required for merge', 'error');
        return;
    }

    state.approvals.feedLoading = true;
    renderApp();

    try {
        // VTID-01168: Call new autonomous-pr-merge endpoint
        var response = await fetch('/api/v1/cicd/autonomous-pr-merge', {
            method: 'POST',
            headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                vtid: vtid,
                pr_number: prNumber,
                merge_method: 'squash',
                automerge: true
            })
        });
        var data = await response.json();

        if (data.ok) {
            // VTID-01168: Show state transition in toast
            var stateMsg = data.state === 'DEPLOYING'
                ? 'PR #' + prNumber + ' merged → deploying ' + (data.deploy?.service || 'service')
                : 'PR #' + prNumber + ' merged successfully';
            showToast(stateMsg, 'success');

            // Add to ticker with MERGED/DEPLOYING state
            state.tickerEvents.unshift({
                id: Date.now(),
                timestamp: new Date().toLocaleTimeString(),
                type: 'cicd',
                topic: data.state === 'DEPLOYING' ? 'cicd.deploy.started' : 'cicd.merge.success',
                content: stateMsg,
                vtid: vtid
            });

            // Refresh the feed
            state.approvals.feedFetched = false;
            await fetchGitHubFeed();
        } else {
            // VTID-01168: Show detailed error with reason
            var errorMsg = data.error || 'Unknown error';
            if (data.reason === 'vtid_missing') {
                errorMsg = 'VTID validation failed - approval blocked';
            } else if (data.reason === 'ci_not_passed') {
                errorMsg = 'CI checks must pass before merge';
            }
            showToast('Approval failed: ' + errorMsg, 'error');
            state.approvals.feedLoading = false;
            renderApp();
        }
    } catch (err) {
        showToast('Approval failed: ' + err.message, 'error');
        state.approvals.feedLoading = false;
        renderApp();
    }
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

// --- Version History Data Model (VTID-0517 + VTID-0524) ---

/**
 * Version status constants for deployment entries.
 * @enum {string}
 */
const VersionStatus = {
    SUCCESS: 'success',
    FAILURE: 'failure',
    LIVE: 'live',
    DRAFT: 'draft',
    UNPUBLISHED: 'unpublished',
    UNKNOWN: 'unknown'
};

/**
 * VTID-0524: Fetches deployment history from the canonical API endpoint.
 * Returns deployment entries with VTID + SWV correlation.
 *
 * VTID-0525-B: Fixed to handle plain array response from API.
 * The API returns a plain array, not {ok: true, deployments: [...]}
 *
 * @returns {Promise<Array<{id: string, vtid: string|null, swv: string, label: string, status: string, createdAt: string, service: string, environment: string, commit: string}>>}
 */
async function fetchDeploymentHistory() {
    console.log('[VTID-0524] Fetching deployment history...');

    try {
        const response = await fetch('/api/v1/operator/deployments?limit=50');
        if (!response.ok) {
            throw new Error('Deployment history fetch failed: ' + response.status);
        }

        const data = await response.json();
        console.log('[VTID-0524] Deployment history loaded:', data);

        // VTID-0525-B: Handle both plain array and wrapped response formats
        // API returns plain array: [{swv_id, service, ...}, ...]
        // Previously expected: {ok: true, deployments: [...]}
        var deployments = [];
        if (Array.isArray(data)) {
            // Plain array response (current API format)
            deployments = data;
        } else if (data && Array.isArray(data.deployments)) {
            // Wrapped response format (legacy)
            deployments = data.deployments;
        } else if (data && Array.isArray(data.details)) {
            // Alternative wrapped format
            deployments = data.details;
        } else {
            console.warn('[VTID-0524] Unexpected response format:', data);
            return [];
        }

        if (deployments.length === 0) {
            console.log('[VTID-0524] No deployments found');
            return [];
        }

        // Map API response to version history format
        // API returns: swv_id, service, git_commit, status, initiator, deploy_type, environment, created_at
        return deployments.map(function(d, index) {
            return {
                id: 'deploy-' + (d.swv_id || d.swv || index),
                vtid: d.vtid || null,
                swv: d.swv_id || d.swv || 'unknown',
                label: d.service + ' ' + (d.swv_id || d.swv || ''),
                status: d.status || VersionStatus.UNKNOWN,
                createdAt: d.created_at,
                service: d.service,
                environment: d.environment,
                commit: d.git_commit || d.commit
            };
        });
    } catch (error) {
        console.error('[VTID-0524] Failed to fetch deployment history:', error);
        return [];
    }
}

/**
 * Loads version history entries.
 * VTID-0524: Now returns cached version history or empty array.
 * Use fetchDeploymentHistory() to refresh from API.
 *
 * @returns {Array}
 */
function loadVersionHistory() {
    // Return current state (populated by fetchDeploymentHistory)
    return state.versionHistory || [];
}

/**
 * Formats an ISO timestamp into a human-readable string.
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {string} Formatted date string (e.g., "Nov 28, 8:14 AM")
 */
function formatVersionTimestamp(isoString) {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
    }) + ', ' + date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

// --- Toast Notification System (VTID-0517) ---

let toastIdCounter = 0;

/**
 * Shows a toast notification.
 * @param {string} message - The message to display
 * @param {string} type - Toast type: 'info', 'success', 'error'
 * @param {number} duration - Duration in milliseconds (default: 4000)
 */
function showToast(message, type = 'info', duration = 4000) {
    const id = ++toastIdCounter;
    state.toasts.push({ id, message, type });
    renderApp();

    // Auto-dismiss after duration
    setTimeout(() => {
        state.toasts = state.toasts.filter(t => t.id !== id);
        renderApp();
    }, duration);
}

// --- DOM Elements & Rendering ---

function renderApp() {
    const root = document.getElementById('root');

    // VTID-0526-E: Save chat textarea focus state before destroying DOM
    var chatTextarea = document.querySelector('.chat-textarea');
    var savedChatFocus = null;
    if (chatTextarea && document.activeElement === chatTextarea) {
        savedChatFocus = {
            value: chatTextarea.value,
            selectionStart: chatTextarea.selectionStart,
            selectionEnd: chatTextarea.selectionEnd
        };
    }

    // DEV-COMHU-2025-0015: Save task spec textarea focus state before destroying DOM
    var specTextarea = document.querySelector('.task-spec-textarea');
    var savedSpecFocus = null;
    if (specTextarea && document.activeElement === specTextarea) {
        savedSpecFocus = {
            value: specTextarea.value,
            selectionStart: specTextarea.selectionStart,
            selectionEnd: specTextarea.selectionEnd
        };
    }

    // VTID-0539: Save chat scroll position for scroll anchoring
    var messagesContainer = document.querySelector('.chat-messages');
    var savedChatScroll = null;
    if (messagesContainer) {
        var scrollTop = messagesContainer.scrollTop;
        var scrollHeight = messagesContainer.scrollHeight;
        var clientHeight = messagesContainer.clientHeight;
        var distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        savedChatScroll = {
            scrollTop: scrollTop,
            wasNearBottom: distanceFromBottom <= 80, // Within 80px of bottom
            previousScrollHeight: scrollHeight
        };
    }

    // VTID-01002: Capture all scroll positions before DOM destruction
    var savedScrollPositions = captureAllScrollPositions();

    root.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'app-container';

    container.appendChild(renderSidebar());

    const mainContent = document.createElement('div');
    mainContent.className = 'main-content';

    mainContent.appendChild(renderHeader());

    if (state.isSplitScreen) {
        mainContent.appendChild(renderSplitScreen());
    } else {
        mainContent.appendChild(renderMainContent());
    }

    container.appendChild(mainContent);
    root.appendChild(container);

    // Drawer
    root.appendChild(renderTaskDrawer());

    // VTID-0401: Governance Rule Detail Drawer
    root.appendChild(renderGovernanceRuleDetailDrawer());

    // VTID-0600: OASIS Event Detail Drawer
    root.appendChild(renderOasisEventDrawer());

    // VTID-01189: VTID Ledger Detail Drawer
    root.appendChild(renderOasisVtidLedgerDrawer());

    // Modals
    if (state.showProfileModal) root.appendChild(renderProfileModal());
    if (state.showTaskModal) root.appendChild(renderTaskModal());

    // Global Overlays (VTID-0508)
    if (state.isHeartbeatOpen) root.appendChild(renderHeartbeatOverlay());
    if (state.isOperatorOpen) root.appendChild(renderOperatorOverlay());

    // Publish Modal (VTID-0517)
    if (state.showPublishModal) root.appendChild(renderPublishModal());

    // VTID-0407: Governance Blocked Modal
    if (state.showGovernanceBlockedModal) root.appendChild(renderGovernanceBlockedModal());

    // VTID-01194: Execution Approval Confirmation Modal
    if (state.showExecutionApprovalModal) root.appendChild(renderExecutionApprovalModal());

    // VTID-01180: Autopilot Recommendations Modal
    if (state.showAutopilotRecommendationsModal) root.appendChild(renderAutopilotRecommendationsModal());

    // Toast Notifications (VTID-0517)
    if (state.toasts.length > 0) root.appendChild(renderToastContainer());

    // VTID-0529-B: Hard bundle fingerprint - banner at top, footer at bottom-right
    root.appendChild(renderBundleFingerprintBanner());
    root.appendChild(renderBundleFingerprintFooter());

    // VTID-0150-A: ORB UI & Interaction Shell (Global Assistant Overlay)
    // Note: ORB idle is now rendered inside sidebar footer via renderOrbIdleElement()
    root.appendChild(renderOrbOverlay());
    root.appendChild(renderOrbChatDrawer());

    // VTID-01037: Setup scroll listener for transcript after overlay is rendered
    // VTID-01064: Enhanced transcript auto-follow - scroll to bottom after render
    if (state.orb.overlayVisible) {
        requestAnimationFrame(function() {
            var transcriptContainer = document.querySelector('.orb-live-transcript');
            if (transcriptContainer) {
                // VTID-01064: Always scroll to bottom first if auto-follow is enabled
                // This ensures new container starts at bottom, not top
                if (state.orb.transcriptNearBottom) {
                    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
                }
                // Setup scroll listener AFTER initial scroll
                setupTranscriptScrollListener();
            }
        });
    }

    // VTID-0526-E: Restore chat textarea focus after render
    if (savedChatFocus) {
        requestAnimationFrame(function() {
            var newTextarea = document.querySelector('.chat-textarea');
            if (newTextarea) {
                newTextarea.focus();
                // Restore cursor position
                newTextarea.setSelectionRange(savedChatFocus.selectionStart, savedChatFocus.selectionEnd);
            }
        });
    }

    // DEV-COMHU-2025-0015: Restore task spec textarea focus after render
    if (savedSpecFocus) {
        requestAnimationFrame(function() {
            var newSpecTextarea = document.querySelector('.task-spec-textarea');
            if (newSpecTextarea) {
                newSpecTextarea.focus();
                // Restore cursor position
                newSpecTextarea.setSelectionRange(savedSpecFocus.selectionStart, savedSpecFocus.selectionEnd);
            }
        });
    }

    // VTID-0539: Scroll anchoring - preserve scroll position or scroll to bottom based on user's position
    // Only auto-scroll if user was near bottom; otherwise preserve their scroll position
    if (state.isOperatorOpen && state.operatorActiveTab === 'chat' && !savedChatFocus) {
        requestAnimationFrame(function() {
            var newMessagesContainer = document.querySelector('.chat-messages');
            if (newMessagesContainer && savedChatScroll) {
                if (savedChatScroll.wasNearBottom) {
                    // User was at/near bottom - scroll to show new messages
                    newMessagesContainer.scrollTop = newMessagesContainer.scrollHeight;
                } else {
                    // User had scrolled up - preserve their position relative to content
                    // Adjust for any new content added at bottom
                    var newScrollHeight = newMessagesContainer.scrollHeight;
                    var heightDiff = newScrollHeight - savedChatScroll.previousScrollHeight;
                    // Keep the same scrollTop (content added below their view)
                    newMessagesContainer.scrollTop = savedChatScroll.scrollTop;
                }
            } else if (newMessagesContainer) {
                // No previous scroll state (first render) - scroll to bottom
                newMessagesContainer.scrollTop = newMessagesContainer.scrollHeight;
            }
        });
    }

    // VTID-01002: Restore scroll positions after DOM rebuild and attach listeners
    restoreAllScrollPositions(savedScrollPositions);
    attachScrollListeners();
}

function renderSidebar() {
    const sidebar = document.createElement('div');
    sidebar.className = `sidebar ${state.sidebarCollapsed ? 'collapsed' : ''}`;

    // Brand + Collapse Toggle (VTID-01014: collapse button in header)
    const brand = document.createElement('div');
    brand.className = 'sidebar-brand';

    if (!state.sidebarCollapsed) {
        const brandTitle = document.createElement('span');
        brandTitle.className = 'brand-title';
        brandTitle.textContent = 'VITANA DEV';
        brand.appendChild(brandTitle);
    }

    // Collapse button in header
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'collapse-btn';
    collapseBtn.innerHTML = state.sidebarCollapsed ? '&#x276F;' : '&#x276E;';
    collapseBtn.title = state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
    collapseBtn.onclick = (e) => {
        e.stopPropagation();
        state.sidebarCollapsed = !state.sidebarCollapsed;
        renderApp();
    };
    brand.appendChild(collapseBtn);

    sidebar.appendChild(brand);

    // Modules
    const navSection = document.createElement('div');
    navSection.className = 'nav-section';

    NAVIGATION_CONFIG.forEach(mod => {
        const label = SECTION_LABELS[mod.section] || mod.section;
        const item = document.createElement('div');
        item.className = `nav-item ${state.currentModuleKey === mod.section ? 'active' : ''}`;
        item.dataset.module = label; // For Operator accent
        item.textContent = state.sidebarCollapsed ? label.substring(0, 2) : label;
        item.title = label;
        item.onclick = () => handleModuleClick(mod.section);
        navSection.appendChild(item);
    });

    sidebar.appendChild(navSection);

    // Sidebar Footer: Profile + ORB (VTID-0150-A)
    const sidebarFooter = document.createElement('div');
    sidebarFooter.className = 'sidebar-footer';

    // Profile capsule (VTID-0508)
    const profile = document.createElement('div');
    profile.className = 'sidebar-profile';
    profile.onclick = () => {
        state.showProfileModal = true;
        renderApp();
    };

    const avatar = document.createElement('div');
    avatar.className = 'sidebar-profile-avatar';
    // VTID-01186: Show avatar image if available, otherwise show initials
    if (state.user.avatarUrl) {
        avatar.style.backgroundImage = 'url(' + state.user.avatarUrl + ')';
        avatar.style.backgroundSize = 'cover';
        avatar.style.backgroundPosition = 'center';
        avatar.textContent = '';
    } else {
        avatar.textContent = state.user.avatar || '?';
    }
    profile.appendChild(avatar);

    if (!state.sidebarCollapsed) {
        const info = document.createElement('div');
        info.className = 'sidebar-profile-info';

        const name = document.createElement('div');
        name.className = 'sidebar-profile-name';
        name.textContent = state.user.name;
        info.appendChild(name);

        const role = document.createElement('div');
        role.className = 'sidebar-profile-role';
        role.textContent = state.viewRole; // VTID-01014: Use viewRole
        info.appendChild(role);

        profile.appendChild(info);
    }

    sidebarFooter.appendChild(profile);

    // ORB container (centered) - VTID-0150-A
    const orbContainer = document.createElement('div');
    orbContainer.className = 'sidebar-orb-container';
    orbContainer.appendChild(renderOrbIdleElement());
    sidebarFooter.appendChild(orbContainer);

    sidebar.appendChild(sidebarFooter);

    // VTID-01014: Old toggle removed - collapse button now in header

    return sidebar;
}

/**
 * VTID-0150-A: Creates the ORB idle element for the sidebar footer
 * VTID-0135: Updated to use Web Speech APIs for voice conversation
 * @returns {HTMLElement}
 */
function renderOrbIdleElement() {
    var orb = document.createElement('div');
    orb.className = 'orb-idle orb-idle-pulse' + (state.orb.overlayVisible ? ' orb-hidden' : '');
    orb.setAttribute('role', 'button');
    orb.setAttribute('aria-label', 'Open Vitana Assistant');
    orb.setAttribute('tabindex', '0');

    // VTID-0135: Click handler - Starts voice conversation session
    // VTID-01109: Restore conversation state from localStorage if available
    orb.addEventListener('click', function() {
        console.log('[ORB] Opening overlay...');
        state.orb.overlayVisible = true;
        state.orb.liveError = null;
        state.orb.voiceError = null;
        state.orb.voiceState = 'IDLE';

        // VTID-01109: Restore conversation from localStorage instead of resetting
        var restored = orbRestoreConversationState();
        if (!restored) {
            // Only reset transcript if no conversation to restore
            state.orb.liveTranscript = [];
            console.log('[VTID-01109] No previous conversation to restore, starting fresh');
        }

        // VTID-01064: Reset auto-follow to enabled when opening ORB
        state.orb.transcriptNearBottom = true;
        renderApp();
        // VTID-0135: Start voice conversation with Web Speech APIs
        orbVoiceStart();
    });

    // VTID-0135: Keyboard accessibility
    // VTID-01109: Restore conversation state from localStorage if available
    orb.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            state.orb.overlayVisible = true;
            state.orb.liveError = null;
            state.orb.voiceError = null;
            state.orb.voiceState = 'IDLE';

            // VTID-01109: Restore conversation from localStorage instead of resetting
            var restored = orbRestoreConversationState();
            if (!restored) {
                state.orb.liveTranscript = [];
            }

            // VTID-01064: Reset auto-follow to enabled when opening ORB
            state.orb.transcriptNearBottom = true;
            renderApp();
            orbVoiceStart();
        }
    });

    return orb;
}

function renderHeader() {
    const header = document.createElement('div');
    header.className = 'header-toolbar';

    // --- SPEC-01: Global Top Navigation Standard ---
    // LEFT (from left → right): AUTOPILOT | OPERATOR | ⏱ (History) | Publish
    // RIGHT (from right → left): ⟳ (Refresh - rightmost) | LIVE

    // --- Left Section: Autopilot, Operator, History, Publish (all neutral) ---
    const left = document.createElement('div');
    left.className = 'header-toolbar-left';

    // 1. Autopilot pill (neutral styling, uppercase) - leftmost
    // VTID-01180: Opens Autopilot Recommendations popup
    const autopilotBtn = document.createElement('button');
    autopilotBtn.className = 'header-pill header-pill--neutral';
    autopilotBtn.textContent = 'AUTOPILOT';
    // VTID-01180: Add badge if there are new recommendations
    if (state.autopilotRecommendationsCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'header-pill-badge';
        badge.textContent = state.autopilotRecommendationsCount > 99 ? '99+' : state.autopilotRecommendationsCount;
        autopilotBtn.appendChild(badge);
    }
    autopilotBtn.onclick = async () => {
        state.showAutopilotRecommendationsModal = true;
        state.autopilotRecommendationsLoading = true;
        state.autopilotRecommendationsError = null;
        renderApp();

        // VTID-01180: Fetch recommendations from API
        try {
            const response = await fetch('/api/v1/autopilot/recommendations?status=new&limit=20', {
                headers: withVitanaContextHeaders({})
            });
            if (!response.ok) {
                throw new Error('Failed to fetch recommendations');
            }
            const data = await response.json();
            if (data.ok) {
                state.autopilotRecommendations = data.recommendations || [];
            } else {
                state.autopilotRecommendationsError = data.error || 'Unknown error';
            }
        } catch (err) {
            console.error('[VTID-01180] Fetch recommendations error:', err);
            state.autopilotRecommendationsError = err.message;
        }
        state.autopilotRecommendationsLoading = false;
        renderApp();
    };
    left.appendChild(autopilotBtn);

    // 2. Operator pill (neutral styling - SPEC-01: same as Autopilot)
    const operatorBtn = document.createElement('button');
    operatorBtn.className = 'header-pill header-pill--neutral';
    operatorBtn.textContent = 'OPERATOR';
    operatorBtn.onclick = () => {
        state.operatorActiveTab = 'chat';
        state.isOperatorOpen = true;

        // VTID-01027: Initialize session memory on operator open
        initOperatorChatSession();

        renderApp();

        // VTID-0526-B: Auto-start live ticker when opening Operator Console
        // This ensures events are streaming without requiring Heartbeat button click
        startOperatorLiveTicker();
    };
    left.appendChild(operatorBtn);

    // 3. History icon button (⏱) - neutral color
    const versionBtn = document.createElement('button');
    versionBtn.className = 'header-icon-button';
    versionBtn.title = 'History';
    // Clock icon using Unicode character (CSP compliant)
    versionBtn.innerHTML = '<span class="header-icon-button__icon">&#128337;</span>';
    versionBtn.onclick = async (e) => {
        e.stopPropagation();
        state.isVersionDropdownOpen = !state.isVersionDropdownOpen;
        if (state.isVersionDropdownOpen) {
            // VTID-0524: Fetch version history from API when opening
            renderApp(); // Show dropdown immediately
            try {
                state.versionHistory = await fetchDeploymentHistory();
                renderApp();
            } catch (error) {
                console.error('[VTID-0524] Failed to fetch version history:', error);
            }
        } else {
            renderApp();
        }
    };
    left.appendChild(versionBtn);

    // Version History Dropdown (rendered within left for positioning)
    if (state.isVersionDropdownOpen) {
        left.appendChild(renderVersionDropdown());
    }

    // 4. Publish pill (neutral styling - SPEC-01: same palette as Autopilot)
    const publishBtn = document.createElement('button');
    publishBtn.className = 'header-pill header-pill--neutral';
    publishBtn.textContent = 'PUBLISH';
    publishBtn.onclick = async () => {
        state.showPublishModal = true;
        renderApp(); // Show modal immediately with loading state

        // Fetch version history if not already loaded
        if (!state.versionHistory || state.versionHistory.length === 0) {
            try {
                console.log('[VTID-0523-B] Fetching version history for publish modal');
                state.versionHistory = await fetchDeploymentHistory();
                renderApp(); // Re-render with loaded versions
            } catch (error) {
                console.error('[VTID-0523-B] Failed to fetch version history:', error);
            }
        }
    };
    left.appendChild(publishBtn);

    header.appendChild(left);

    // --- Center Section: Empty (flex spacer) ---
    const center = document.createElement('div');
    center.className = 'header-toolbar-center';
    header.appendChild(center);

    // --- Right Section: LIVE | Refresh (rightmost) ---
    const right = document.createElement('div');
    right.className = 'header-toolbar-right';

    // LIVE/OFFLINE pill with CI/CD dropdown (restored from pre-0010)
    const hasStageCounters = state.stageCounters && (state.stageCounters.PLANNER > 0 || state.stageCounters.WORKER > 0 || state.stageCounters.VALIDATOR > 0 || state.stageCounters.DEPLOY > 0 || state.lastTelemetryRefresh);
    const isLive = state.operatorHeartbeatActive || hasStageCounters;

    // CI/CD Health Indicator container (holds pill + dropdown)
    const cicdHealthIndicator = document.createElement('div');
    cicdHealthIndicator.className = 'cicd-health-indicator';

    // VTID-0541 D4: Determine health status with proper distinction
    const healthStatus = state.cicdHealth?.status;
    const isFullyHealthy = state.cicdHealth && state.cicdHealth.ok === true && healthStatus === 'ok';
    const isGovernanceLimited = healthStatus === 'ok_governance_limited';
    const isDegraded = healthStatus === 'degraded' || (state.cicdHealth && state.cicdHealth.ok === false);

    // LIVE/OFFLINE status pill (clickable to show CI/CD dropdown)
    const statusPill = document.createElement('button');
    if (isLive) {
        statusPill.className = 'header-pill header-pill--live';
        statusPill.innerHTML = '<span class="header-pill__dot"></span>LIVE';
    } else {
        statusPill.className = 'header-pill header-pill--offline';
        statusPill.innerHTML = '<span class="header-pill__dot"></span>OFFLINE';
    }
    statusPill.onclick = (e) => {
        e.stopPropagation();
        state.cicdHealthTooltipOpen = !state.cicdHealthTooltipOpen;
        renderApp();
    };
    cicdHealthIndicator.appendChild(statusPill);

    // CI/CD Health Tooltip/Dropdown (restored from pre-0010)
    if (state.cicdHealthTooltipOpen) {
        const tooltip = document.createElement('div');
        tooltip.className = 'cicd-health-tooltip';

        // Header - VTID-0541 D4: Show proper status distinction
        const tooltipHeader = document.createElement('div');
        tooltipHeader.className = 'cicd-health-tooltip__header';
        if (isDegraded) {
            tooltipHeader.innerHTML = '<span class="cicd-health-tooltip__status cicd-health-tooltip__status--error">&#9829; CI/CD Degraded</span>';
        } else if (isGovernanceLimited) {
            tooltipHeader.innerHTML = '<span class="cicd-health-tooltip__status cicd-health-tooltip__status--warning">&#9829; CI/CD OK (Governance Limited)</span>';
        } else if (isFullyHealthy) {
            tooltipHeader.innerHTML = '<span class="cicd-health-tooltip__status cicd-health-tooltip__status--healthy">&#9829; CI/CD Healthy</span>';
        } else {
            tooltipHeader.innerHTML = '<span class="cicd-health-tooltip__status">&#9829; CI/CD Status</span>';
        }
        tooltip.appendChild(tooltipHeader);

        // Status details
        if (state.cicdHealth) {
            const details = document.createElement('div');
            details.className = 'cicd-health-tooltip__details';

            // Status line
            const statusLine = document.createElement('div');
            statusLine.className = 'cicd-health-tooltip__row';
            statusLine.innerHTML = '<span class="cicd-health-tooltip__label">Status:</span>' +
                '<span class="cicd-health-tooltip__value">' + (state.cicdHealth.status || 'unknown') + '</span>';
            details.appendChild(statusLine);

            // Capabilities
            if (state.cicdHealth.capabilities) {
                const capsHeader = document.createElement('div');
                capsHeader.className = 'cicd-health-tooltip__caps-header';
                capsHeader.textContent = 'Capabilities';
                details.appendChild(capsHeader);

                for (const [key, value] of Object.entries(state.cicdHealth.capabilities)) {
                    const capRow = document.createElement('div');
                    capRow.className = 'cicd-health-tooltip__row';
                    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                    capRow.innerHTML = '<span class="cicd-health-tooltip__label">' + label + ':</span>' +
                        '<span class="cicd-health-tooltip__value cicd-health-tooltip__value--' + (value ? 'yes' : 'no') + '">' +
                        (value ? 'Yes' : 'No') + '</span>';
                    details.appendChild(capRow);
                }
            }

            tooltip.appendChild(details);
        } else if (state.cicdHealthError) {
            const errorDetails = document.createElement('div');
            errorDetails.className = 'cicd-health-tooltip__error';
            errorDetails.textContent = 'Error: ' + state.cicdHealthError;
            tooltip.appendChild(errorDetails);
        } else {
            const loadingDetails = document.createElement('div');
            loadingDetails.className = 'cicd-health-tooltip__loading';
            loadingDetails.textContent = 'Loading...';
            tooltip.appendChild(loadingDetails);
        }

        // Last updated timestamp
        const footer = document.createElement('div');
        footer.className = 'cicd-health-tooltip__footer';
        footer.textContent = 'Updated: ' + new Date().toLocaleTimeString();
        tooltip.appendChild(footer);

        cicdHealthIndicator.appendChild(tooltip);

        // Click-outside handler for CI/CD tooltip
        setTimeout(() => {
            const closeTooltip = (e) => {
                const tooltipEl = document.querySelector('.cicd-health-tooltip');
                const pillEl = document.querySelector('.header-pill--live, .header-pill--offline');
                if (tooltipEl && !tooltipEl.contains(e.target) && pillEl && !pillEl.contains(e.target)) {
                    state.cicdHealthTooltipOpen = false;
                    document.removeEventListener('click', closeTooltip);
                    renderApp();
                }
            };
            document.addEventListener('click', closeTooltip);
        }, 0);
    }

    right.appendChild(cicdHealthIndicator);

    // SPEC-01: Global Refresh icon (⟳) - rightmost element
    // Refresh is icon only, triggers full data reload for the active screen
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'header-icon-button header-icon-button--refresh';
    refreshBtn.title = 'Refresh';
    refreshBtn.innerHTML = '<span class="header-icon-button__icon">&#8635;</span>';
    if (state.globalRefreshLoading) {
        refreshBtn.classList.add('header-icon-button--loading');
        refreshBtn.disabled = true;
    }
    refreshBtn.onclick = async () => {
        // SPEC-01: Triggers full data reload for the active screen
        state.globalRefreshLoading = true;
        renderApp();

        try {
            await triggerGlobalRefresh();
        } finally {
            state.globalRefreshLoading = false;
            renderApp();
        }
    };
    right.appendChild(refreshBtn);

    header.appendChild(right);

    // Add click-outside handler for version dropdown
    if (state.isVersionDropdownOpen) {
        setTimeout(() => {
            const closeDropdown = (e) => {
                const dropdown = document.querySelector('.version-dropdown');
                const iconBtn = document.querySelector('.header-icon-button');
                if (dropdown && !dropdown.contains(e.target) && !iconBtn.contains(e.target)) {
                    state.isVersionDropdownOpen = false;
                    document.removeEventListener('click', closeDropdown);
                    renderApp();
                }
            };
            document.addEventListener('click', closeDropdown);
        }, 0);
    }

    return header;
}

// --- Version History Dropdown (VTID-0517 + VTID-0524) ---

/**
 * VTID-0524: Renders version history dropdown with deployments from API
 * - Most recent on top
 * - Shows SWV label
 * - Hover/tooltip shows VTID + timestamp
 */
function renderVersionDropdown() {
    const dropdown = document.createElement('div');
    dropdown.className = 'version-dropdown';

    // Header
    const dropdownHeader = document.createElement('div');
    dropdownHeader.className = 'version-dropdown__title';
    dropdownHeader.textContent = 'Versions';
    dropdown.appendChild(dropdownHeader);

    // List container
    const list = document.createElement('div');
    list.className = 'version-dropdown__list';

    // Show loading state if no data yet
    if (!state.versionHistory || state.versionHistory.length === 0) {
        const emptyItem = document.createElement('div');
        emptyItem.className = 'version-dropdown__item version-dropdown__item--empty';
        emptyItem.textContent = 'Loading deployments...';
        list.appendChild(emptyItem);
    } else {
        // VTID-0524: Render deployments (already sorted by created_at DESC from API)
        state.versionHistory.forEach(function(version) {
            const item = document.createElement('div');
            item.className = 'version-dropdown__item';
            if (state.selectedVersionId === version.id) {
                item.className += ' version-dropdown__item--selected';
            }

            // VTID-0524: Build tooltip with VTID + timestamp
            const tooltipParts = [];
            if (version.vtid) {
                tooltipParts.push(version.vtid);
            }
            if (version.createdAt) {
                tooltipParts.push(new Date(version.createdAt).toLocaleString());
            }
            if (version.commit) {
                tooltipParts.push('Commit: ' + version.commit);
            }
            item.title = tooltipParts.join(' | ');

            // Primary label: SWV + service
            const label = document.createElement('div');
            label.className = 'version-dropdown__item-label';
            label.textContent = version.swv + ' – ' + (version.service || 'unknown');
            item.appendChild(label);

            // Meta line: timestamp + status badge
            const meta = document.createElement('div');
            meta.className = 'version-dropdown__item-meta';

            const timestamp = document.createElement('span');
            timestamp.className = 'version-dropdown__item-timestamp';
            timestamp.textContent = version.createdAt ? formatVersionTimestamp(version.createdAt) : '';
            meta.appendChild(timestamp);

            if (version.status) {
                const badge = document.createElement('span');
                // VTID-0524: Map status to badge classes
                let badgeClass = 'version-dropdown__item-badge';
                if (version.status === 'success') {
                    badgeClass += ' version-dropdown__item-badge--success';
                } else if (version.status === 'failure') {
                    badgeClass += ' version-dropdown__item-badge--failure';
                } else {
                    badgeClass += ' version-dropdown__item-badge--' + version.status;
                }
                badge.className = badgeClass;
                badge.textContent = version.status.charAt(0).toUpperCase() + version.status.slice(1);
                meta.appendChild(badge);
            }

            item.appendChild(meta);

            // Click handler
            item.onclick = function(e) {
                e.stopPropagation();
                state.selectedVersionId = version.id;
                const displayName = version.swv || version.vtid || version.label;
                showToast('Version ' + displayName + ' selected. Restore/publish flow will be implemented in a later step.', 'info');
                state.isVersionDropdownOpen = false;
                renderApp();
            };

            list.appendChild(item);
        });
    }

    dropdown.appendChild(list);
    return dropdown;
}

function renderMainContent() {
    const content = document.createElement('div');
    content.className = 'content-area';

    // Tabs
    const currentSection = NAVIGATION_CONFIG.find(s => s.section === state.currentModuleKey);
    const tabs = currentSection ? currentSection.tabs : [];

    if (tabs.length > 0) {
        const subNav = document.createElement('div');
        subNav.className = 'sub-nav';

        tabs.forEach(tab => {
            const tabEl = document.createElement('div');
            tabEl.className = `sub-nav-tab ${state.currentTab === tab.key ? 'active' : ''}`;
            tabEl.textContent = formatTabLabel(tab.key);

            // VTID-01151: Add badge counter to Approvals tab
            if (tab.key === 'approvals') {
                const badge = document.createElement('span');
                badge.className = 'approvals-badge';
                const count = state.approvals.pending_count;
                badge.textContent = count;
                badge.style.display = count > 0 ? 'inline-flex' : 'none';
                tabEl.appendChild(badge);
            }

            tabEl.onclick = () => handleTabClick(tab.key);
            subNav.appendChild(tabEl);
        });

        content.appendChild(subNav);
    }

    // Module Content
    const moduleContent = document.createElement('div');
    moduleContent.className = 'module-content-wrapper';

    moduleContent.appendChild(renderModuleContent(state.currentModuleKey, state.currentTab));

    content.appendChild(moduleContent);

    return content;
}

function renderSplitScreen() {
    const split = document.createElement('div');
    split.className = 'split-screen';

    const left = document.createElement('div');
    left.className = 'split-panel-left';
    // Header for pane
    const leftHeader = document.createElement('div');
    leftHeader.className = 'split-pane-header';
    leftHeader.textContent = `${SECTION_LABELS[state.leftPane.module] || state.leftPane.module} > ${formatTabLabel(state.leftPane.tab)}`;
    left.appendChild(leftHeader);

    const leftContent = document.createElement('div');
    leftContent.className = 'split-pane-content';
    leftContent.appendChild(renderModuleContent(state.leftPane.module, state.leftPane.tab));
    left.appendChild(leftContent);

    split.appendChild(left);

    const divider = document.createElement('div');
    divider.className = 'split-divider';
    split.appendChild(divider);

    const right = document.createElement('div');
    right.className = 'split-panel-right';
    // Header for pane
    const rightHeader = document.createElement('div');
    rightHeader.className = 'split-pane-header';
    rightHeader.textContent = `${SECTION_LABELS[state.rightPane.module] || state.rightPane.module} > ${formatTabLabel(state.rightPane.tab)}`;
    right.appendChild(rightHeader);

    const rightContent = document.createElement('div');
    rightContent.className = 'split-pane-content';
    rightContent.appendChild(renderModuleContent(state.rightPane.module, state.rightPane.tab));
    right.appendChild(rightContent);

    split.appendChild(right);

    return split;
}

function renderModuleContent(moduleKey, tab) {
    const container = document.createElement('div');
    container.className = 'content-container';

    if (moduleKey === 'command-hub' && tab === 'tasks') {
        container.appendChild(renderTasksView());
    } else if (moduleKey === 'command-hub' && tab === 'events') {
        // VTID-0600: Command Hub Events (curated operational view)
        container.appendChild(renderCommandHubEventsView());
    } else if (moduleKey === 'command-hub' && tab === 'vtids') {
        // VTID-0600: VTIDs Lifecycle Overview
        container.appendChild(renderVtidsView());
    } else if (moduleKey === 'command-hub' && tab === 'approvals') {
        // VTID-0600: Approvals UI Scaffolding
        container.appendChild(renderApprovalsView());
    } else if (moduleKey === 'oasis' && tab === 'events') {
        // VTID-0600: OASIS Events View
        container.appendChild(renderOasisEventsView());
    } else if (moduleKey === 'oasis' && tab === 'vtid-ledger') {
        // DEV-COMHU-2025-0008: OASIS VTID Ledger View
        container.appendChild(renderOasisVtidLedgerView());
    } else if (moduleKey === 'docs' && tab === 'screens') {
        container.appendChild(renderDocsScreensView());
    } else if (moduleKey === 'governance' && tab === 'rules') {
        // VTID-0401: Governance Rules catalog view
        container.appendChild(renderGovernanceRulesView());
    } else if (moduleKey === 'governance' && tab === 'evaluations') {
        // VTID-0406: Governance Evaluations viewer (OASIS integration)
        container.appendChild(renderGovernanceEvaluationsView());
    } else if (moduleKey === 'governance' && tab === 'history') {
        // VTID-0408: Governance History timeline view
        container.appendChild(renderGovernanceHistoryView());
    } else if (moduleKey === 'governance' && tab === 'categories') {
        // VTID-0409: Governance Categories (Read-Only V1)
        container.appendChild(renderGovernanceCategoriesView());
    } else if (moduleKey === 'governance' && tab === 'controls') {
        // VTID-01181: Governance Controls (System Arming Panel)
        container.appendChild(renderGovernanceControlsView());
    } else if (moduleKey === 'intelligence-memory-dev' && tab === 'memory-vault') {
        // VTID-01086: Memory Garden UI Deepening
        container.appendChild(renderMemoryGardenView());
    } else if (moduleKey === 'intelligence-memory-dev' && tab === 'knowledge-graph') {
        // Intelligence & Memory: Knowledge Graph visualization
        container.appendChild(renderKnowledgeGraphView());
    } else if (moduleKey === 'intelligence-memory-dev' && tab === 'embeddings') {
        // Intelligence & Memory: Embeddings management
        container.appendChild(renderEmbeddingsView());
    } else if (moduleKey === 'intelligence-memory-dev' && tab === 'recall') {
        // Intelligence & Memory: Recall testing and debugging
        container.appendChild(renderRecallView());
    } else if (moduleKey === 'intelligence-memory-dev' && tab === 'inspector') {
        // Intelligence & Memory: AI Inspector for debugging
        container.appendChild(renderInspectorView());
    } else if (moduleKey === 'admin' && tab === 'users') {
        // VTID-01195: Admin Users v1 - Split layout with user list + detail
        container.appendChild(renderAdminUsersView());
    } else if (moduleKey === 'admin' && tab === 'permissions') {
        // VTID-01195: Admin Permissions v1 - Permission keys + scope
        container.appendChild(renderAdminPermissionsView());
    } else if (moduleKey === 'admin' && tab === 'tenants') {
        // VTID-01195: Admin Tenants v1 - Tenant list + plan/limits
        container.appendChild(renderAdminTenantsView());
    } else if (moduleKey === 'admin' && tab === 'content-moderation') {
        // VTID-01195: Admin Content Moderation v1 - Report queue + actions
        container.appendChild(renderAdminContentModerationView());
    } else if (moduleKey === 'admin' && tab === 'identity-access') {
        // VTID-01195: Admin Identity Access v1 - Auth status + access logs
        container.appendChild(renderAdminIdentityAccessView());
    } else if (moduleKey === 'agents' && tab === 'registered-agents') {
        // VTID-01173: Agents Control Plane v1 - Registered Agents (Worker Orchestrator)
        container.appendChild(renderRegisteredAgentsView());
    } else if (moduleKey === 'agents' && tab === 'skills') {
        // VTID-01173: Agents Control Plane v1 - Skills Registry
        container.appendChild(renderAgentsSkillsView());
    } else if (moduleKey === 'agents' && tab === 'pipelines') {
        // VTID-01174: Agents Control Plane v2 - Pipelines (Runs + Traces)
        container.appendChild(renderAgentsPipelinesView());
    } else if (moduleKey === 'agents' && tab === 'telemetry') {
        // VTID-01208: LLM Telemetry + Model Provenance + Runtime Routing Control
        container.appendChild(renderAgentsTelemetryView());
    } else {
        // Placeholder for other modules
        const placeholder = document.createElement('div');
        placeholder.className = 'placeholder-content';

        if (moduleKey === 'command-hub' && tab === 'live-console') {
            placeholder.innerHTML = '<div class="placeholder-panel">Live Console placeholder</div>';
        } else {
            const sectionLabel = SECTION_LABELS[moduleKey] || moduleKey;
            const tabLabel = formatTabLabel(tab);
            placeholder.textContent = `${sectionLabel} > ${tabLabel || 'Overview'}`;
        }
        container.appendChild(placeholder);
    }
    return container;
}

function renderTasksView() {
    const container = document.createElement('div');
    container.className = 'tasks-container';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'tasks-toolbar';

    const search = document.createElement('input');
    search.className = 'search-field';
    search.placeholder = 'Search tasks...';
    search.value = state.taskSearchQuery;
    search.oninput = (e) => {
        state.taskSearchQuery = e.target.value;
        renderApp();
    };
    toolbar.appendChild(search);

    // VTID-01045: Calendar icon button for date filter (replaces visible date input)
    const dateFilterContainer = document.createElement('div');
    dateFilterContainer.className = 'date-filter-btn-container';

    // Hidden date input (for native picker)
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'date-hidden-input';
    dateInput.value = state.taskDateFilter;
    dateInput.onchange = (e) => {
        state.taskDateFilter = e.target.value;
        renderApp();
    };
    dateFilterContainer.appendChild(dateInput);

    // Calendar icon button
    const dateIconBtn = document.createElement('button');
    dateIconBtn.className = 'date-filter-icon-btn' + (state.taskDateFilter ? ' date-filter-active' : '');
    dateIconBtn.title = state.taskDateFilter ? 'Filter: ' + state.taskDateFilter : 'Filter by date';
    dateIconBtn.setAttribute('aria-label', 'Open date picker');
    // Calendar SVG icon (CSP-compliant, no inline styles)
    dateIconBtn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/></svg>';
    dateIconBtn.onclick = () => {
        // Try showPicker() first (modern browsers), fallback to click()
        if (typeof dateInput.showPicker === 'function') {
            dateInput.showPicker();
        } else {
            dateInput.click();
        }
    };
    dateFilterContainer.appendChild(dateIconBtn);

    // Show date indicator and clear button when date is set
    if (state.taskDateFilter) {
        const dateIndicator = document.createElement('span');
        dateIndicator.className = 'date-filter-indicator';
        dateIndicator.textContent = state.taskDateFilter;
        dateFilterContainer.appendChild(dateIndicator);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'date-filter-clear-btn';
        clearBtn.title = 'Clear date filter';
        clearBtn.setAttribute('aria-label', 'Clear date filter');
        clearBtn.textContent = '\u00D7'; // × symbol
        clearBtn.onclick = (e) => {
            e.stopPropagation();
            state.taskDateFilter = '';
            renderApp();
        };
        dateFilterContainer.appendChild(clearBtn);
    }

    toolbar.appendChild(dateFilterContainer);

    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    const newBtn = document.createElement('button');
    newBtn.className = 'btn btn-primary';
    newBtn.textContent = '+ New Task';
    newBtn.onclick = () => {
        state.showTaskModal = true;
        renderApp();
    };
    toolbar.appendChild(newBtn);

    // SPEC-01: Per-view refresh buttons removed - use global refresh icon in header

    container.appendChild(toolbar);

    // Golden Task Board
    const board = document.createElement('div');
    board.className = 'task-board';

    if (state.tasksLoading) {
        board.innerHTML = '<div class="placeholder-content">Loading tasks...</div>';
        container.appendChild(board);
        return container;
    }

    if (state.tasksError) {
        board.innerHTML = `<div class="placeholder-content error-text">Error: ${state.tasksError}</div>`;
        container.appendChild(board);
        return container;
    }

    const columns = ['Scheduled', 'In Progress', 'Completed'];

    columns.forEach(colName => {
        const col = document.createElement('div');
        col.className = 'task-column';

        const header = document.createElement('div');
        header.className = 'column-header';
        // VTID-01017: Simple header text for all columns (archived UI removed)
        header.textContent = colName;
        col.appendChild(header);

        const content = document.createElement('div');
        content.className = 'column-content';
        // VTID-01002: Mark as scroll-retaining container
        content.dataset.scrollRetain = 'true';
        content.dataset.scrollKey = 'tasks-' + colName.toLowerCase().replace(/\s+/g, '-');

        // Filter tasks
        // VTID-01022: Human task filter FIRST - exclude ALL system/CI/CD artifacts
        // VTID-01028: Diagnostic logging for board visibility
        // This helps trace filtering issues - log once per render
        if (colName === 'Scheduled' && !state._boardDiagLogged) {
            console.log('[VTID-01028] Board render diagnostic:', {
                totalTasks: state.tasks.length,
                humanTasks: state.tasks.filter(t => isHumanTask(t)).length,
                sampleStatuses: state.tasks.slice(0, 5).map(t => ({ vtid: t.vtid, status: t.status, oasisColumn: t.oasisColumn }))
            });
            state._boardDiagLogged = true;
            // Reset after 5 seconds to allow re-logging on next render cycle
            setTimeout(() => { state._boardDiagLogged = false; }, 5000);
        }

        // VTID-01005: Use OASIS-derived column for task placement (single source of truth)
        const colTasks = state.tasks.filter(t => {
            // VTID-01022: Hard governance filter - ONLY human tasks (VTID-NNNN) appear on board
            // Excludes: DEV-*, DEV-CICDL-*, DEV-COMHU-*, AUTODEPLOY-*, OASIS-CMD-*, etc.
            if (!isHumanTask(t)) return false;

            // VTID-01055: Suppress deleted/voided tasks (client-side safety net)
            if (!isTaskRenderable(t)) return false;

            // VTID-01005: Use OASIS-derived column as authoritative source
            if (mapStatusToColumnWithOverride(t.vtid, t.status, t.oasisColumn) !== colName) return false;

            // VTID-01017/01028: For Scheduled column, apply eligibility filter (now relaxed)
            if (colName === 'Scheduled') {
                if (!isEligibleScheduled(t)) return false;
            }

            // Search query
            // VTID-01030: Null-safe search - handle missing title/vtid
            if (state.taskSearchQuery) {
                const q = state.taskSearchQuery.toLowerCase();
                const title = (t.title || '').toLowerCase();
                const vtid = (t.vtid || '').toLowerCase();
                if (!title.includes(q) && !vtid.includes(q)) return false;
            }

            // Date filter (assuming createdAt exists and is YYYY-MM-DD compatible or ISO)
            if (state.taskDateFilter && t.createdAt) {
                if (!t.createdAt.startsWith(state.taskDateFilter)) return false;
            }

            // VTID-01010: Role filter
            if (state.taskRoleFilter && state.taskRoleFilter !== 'ALL') {
                const taskRoles = getTaskTargetRoles(t);
                if (!taskRoles || !taskRoles.includes(state.taskRoleFilter)) return false;
            }

            return true;
        });

        // VTID-01055: Ghost card detection - check if any rendered task is NOT in API response
        colTasks.forEach(task => {
            // VTID-01055: Detect ghost cards (tasks not in last API response)
            if (lastApiVtids.size > 0 && task.vtid && !lastApiVtids.has(task.vtid)) {
                console.error('[VTID-01055] GHOST-CARD-DETECTED vtid=' + task.vtid + ' column=' + colName + ' (not in API response)');
            }
        });

        // VTID-01030: Try/catch per-task to prevent one bad row from crashing board
        colTasks.forEach(task => {
            try {
                content.appendChild(createTaskCard(task));
            } catch (err) {
                console.error('[VTID-01030] Failed to render task card:', task.vtid, err);
                // Skip this task but continue rendering others
            }
        });

        col.appendChild(content);
        board.appendChild(col);
    });

    // VTID-01055: Log API vs DOM card count for ghost detection (on manual refresh)
    if (isManualRefresh || state._logGhostCheck) {
        var domCards = board.querySelectorAll('.task-card');
        var domVtids = Array.from(domCards).map(function(card) {
            // Try to find VTID from card content
            var vtidLine = card.querySelector('.task-card-vtid');
            return vtidLine ? vtidLine.textContent.trim() : null;
        }).filter(Boolean);
        console.log('[VTID-01055] DOM cards: ' + domVtids.length + ', API VTIDs: ' + lastApiVtids.size);
        state._logGhostCheck = false;
    }

    container.appendChild(board);

    return container;
}

/**
 * DEV-COMHU-2025-0012: Enhanced task card with richer design.
 * Matches VTID-0540 style: Title (larger) + VTID line (blue) + Status pill + Stage badges.
 * GOLDEN-MARKER: Base class 'task-card' preserved for VTID-0302 fingerprint check.
 */
function createTaskCard(task) {
    // VTID-01030: Null-safe task handling
    if (!task) {
        console.warn('[VTID-01030] createTaskCard called with null/undefined task');
        var emptyCard = document.createElement('div');
        emptyCard.className = 'task-card task-card-error';
        return emptyCard;
    }

    // VTID-01005: Use OASIS-derived column for task placement (single source of truth)
    // VTID-01030: Null-safe fallback to 'Scheduled' if mapping fails
    var columnStatus = mapStatusToColumnWithOverride(task.vtid, task.status, task.oasisColumn) || 'Scheduled';

    const card = document.createElement('div');
    // VTID-0302: Golden fingerprint requires 'task-card' class pattern
    card.className = 'task-card';
    card.classList.add('task-card-enhanced');
    card.dataset.status = columnStatus.toLowerCase().replace(' ', '-');
    // VTID-01005: Add terminal state data attributes for styling
    if (task.is_terminal) {
        card.dataset.terminal = 'true';
        card.dataset.outcome = task.terminal_outcome || '';
    }
    card.onclick = () => {
        state.selectedTask = task;
        state.selectedTaskDetail = null;
        state.selectedTaskDetailLoading = true;
        state.executionStatus = null;
        state.executionStatusLoading = false;
        renderApp();
        // VTID-0527: Fetch full VTID detail with stageTimeline
        fetchVtidDetail(task.vtid);
        // VTID-01209: Start execution status polling for in-progress tasks
        var col = mapStatusToColumnWithOverride(task.vtid, task.status, task.oasisColumn);
        if (col === 'In Progress') {
            startExecutionStatusPolling(task.vtid);
        }
    };

    // VTID-01005: Title (larger, prominent)
    // VTID-01041: Use effective title (localStorage override > server > fallback)
    const title = document.createElement('div');
    title.className = 'task-card-title';
    var effectiveTitle = getEffectiveTaskTitle(task);
    title.textContent = effectiveTitle;
    // VTID-01041: Mark placeholder titles for styling
    if (isPlaceholderTitle(effectiveTitle)) {
        title.classList.add('task-card-title-placeholder');
    }
    // VTID-01041: Make title editable for Scheduled column tasks
    if (columnStatus === 'Scheduled') {
        title.classList.add('task-card-title-editable');
        title.onclick = function(e) {
            e.stopPropagation();
            startInlineTitleEdit(title, task);
        };
    }
    card.appendChild(title);

    // VTID-01005: VTID line (blue label)
    const vtidLine = document.createElement('div');
    vtidLine.className = 'task-card-vtid-line';
    const vtidLabel = document.createElement('span');
    vtidLabel.className = 'task-card-vtid-label';
    vtidLabel.textContent = task.vtid;
    vtidLine.appendChild(vtidLabel);
    card.appendChild(vtidLine);

    // VTID-01005: Status pill row (OASIS-derived status)
    const statusRow = document.createElement('div');
    statusRow.className = 'task-card-status-row';

    const statusPill = document.createElement('span');
    statusPill.className = 'task-card-status-pill task-card-status-pill-' + columnStatus.toLowerCase().replace(' ', '-');
    // VTID-01005: Show OASIS-derived status (uppercase for terminal states)
    var statusText = task.status ? task.status.toUpperCase() : columnStatus.toUpperCase();
    // Add terminal outcome indicator
    if (task.is_terminal && task.terminal_outcome === 'failed') {
        statusPill.classList.add('task-card-status-pill-failed');
        statusText = 'FAILED';
    } else if (task.is_terminal && task.terminal_outcome === 'success') {
        statusPill.classList.add('task-card-status-pill-success');
        statusText = 'SUCCESS';
    }
    statusPill.textContent = statusText;
    statusRow.appendChild(statusPill);

    // VTID-01010: Target Role badge(s)
    const targetRoles = getTaskTargetRoles(task);
    if (targetRoles && targetRoles.length > 0) {
        const roleBadge = document.createElement('span');
        roleBadge.className = 'task-card-role-badge';
        if (targetRoles.length === 1) {
            roleBadge.textContent = targetRoles[0];
            roleBadge.classList.add('task-card-role-badge-' + targetRoles[0].toLowerCase());
        } else {
            // Show first role + count for multiple
            roleBadge.textContent = targetRoles[0] + '+' + (targetRoles.length - 1);
            roleBadge.classList.add('task-card-role-badge-multi');
        }
        roleBadge.title = 'Target: ' + targetRoles.join(', ');
        statusRow.appendChild(roleBadge);
    } else {
        // VTID-01010: Show UNKNOWN for tasks without roles
        const unknownBadge = document.createElement('span');
        unknownBadge.className = 'task-card-role-badge task-card-role-badge-unknown';
        unknownBadge.textContent = 'UNKNOWN';
        unknownBadge.title = 'No target role set';
        statusRow.appendChild(unknownBadge);
    }

    card.appendChild(statusRow);

    // VTID-01188: Spec status row
    if (columnStatus === 'Scheduled') {
        const specRow = document.createElement('div');
        specRow.className = 'task-card-spec-row';

        const specStatus = task.spec_status || 'missing';
        const specPill = document.createElement('span');
        specPill.className = 'task-card-spec-pill task-card-spec-pill-' + specStatus.toLowerCase();

        // Display-friendly spec status text
        var specStatusText = {
            'missing': 'SPEC MISSING',
            'generating': 'GENERATING',
            'draft': 'DRAFT',
            'validating': 'VALIDATING',
            'validated': 'VALIDATED',
            'rejected': 'REJECTED',
            'approved': 'APPROVED'
        }[specStatus] || specStatus.toUpperCase();
        specPill.textContent = specStatusText;
        specRow.appendChild(specPill);

        card.appendChild(specRow);
    }

    // DEV-COMHU-2025-0012: Stage badges row (PL / WO / VA / DE)
    const stageTimeline = createTaskStageTimeline(task);
    card.appendChild(stageTimeline);

    return card;
}

/**
 * VTID-01041: Start inline title editing for a task card.
 * Creates an input element to replace the title text.
 */
function startInlineTitleEdit(titleElement, task) {
    if (!titleElement || !task || !task.vtid) return;

    // Prevent multiple edit sessions
    if (titleElement.querySelector('.task-card-title-input')) return;

    var currentTitle = getEffectiveTaskTitle(task);
    var isPlaceholder = isPlaceholderTitle(currentTitle);

    // Create input element
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-card-title-input';
    input.value = isPlaceholder ? '' : currentTitle;
    input.placeholder = 'Enter task title...';

    // Save original text for cancel
    var originalText = titleElement.textContent;

    // Clear title and add input
    titleElement.textContent = '';
    titleElement.appendChild(input);
    input.focus();
    input.select();

    // Handle save
    function saveTitle() {
        var newTitle = input.value.trim();
        if (newTitle && newTitle !== originalText) {
            setTaskTitleOverride(task.vtid, newTitle);
            console.log('[VTID-01041] Title saved for', task.vtid, ':', newTitle);
        }
        // Re-render to update both card and drawer
        renderApp();
    }

    // Handle cancel
    function cancelEdit() {
        titleElement.textContent = originalText;
    }

    // Event handlers
    input.onkeydown = function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveTitle();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    };

    input.onblur = function() {
        // Small delay to allow click events to fire first
        setTimeout(function() {
            if (input.parentNode === titleElement) {
                saveTitle();
            }
        }, 100);
    };

    // Prevent card click from triggering
    input.onclick = function(e) {
        e.stopPropagation();
    };
}

/**
 * VTID-01041: Start inline title editing in the drawer panel.
 * Creates an input element to replace the title text.
 */
function startDrawerTitleEdit(titleValueElement, task) {
    if (!titleValueElement || !task || !task.vtid) return;

    // Prevent multiple edit sessions
    if (titleValueElement.querySelector('.drawer-title-input')) return;

    var currentTitle = getEffectiveTaskTitle(task);
    var isPlaceholder = isPlaceholderTitle(currentTitle);

    // Create input element
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'drawer-title-input';
    input.value = isPlaceholder ? '' : currentTitle;
    input.placeholder = 'Enter task title...';

    // Save original text for cancel
    var originalText = titleValueElement.textContent;

    // Clear value and add input
    titleValueElement.textContent = '';
    titleValueElement.appendChild(input);
    input.focus();
    input.select();

    // Handle save
    function saveTitle() {
        var newTitle = input.value.trim();
        if (newTitle && newTitle !== originalText) {
            setTaskTitleOverride(task.vtid, newTitle);
            console.log('[VTID-01041] Drawer title saved for', task.vtid, ':', newTitle);
        }
        // Re-render to update both card and drawer
        renderApp();
    }

    // Handle cancel
    function cancelEdit() {
        titleValueElement.textContent = originalText;
    }

    // Event handlers
    input.onkeydown = function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveTitle();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    };

    input.onblur = function() {
        // Small delay to allow click events to fire first
        setTimeout(function() {
            if (input.parentNode === titleValueElement) {
                saveTitle();
            }
        }, 100);
    };

    // Prevent row click from triggering
    input.onclick = function(e) {
        e.stopPropagation();
    };
}

/**
 * VTID-0527: Create stage timeline pills for a task card.
 * Shows PLANNER → WORKER → VALIDATOR → DEPLOY progression.
 */
function createTaskStageTimeline(task) {
    const timeline = document.createElement('div');
    timeline.className = 'task-stage-timeline';

    // Get stage state from telemetry events
    const stageState = deriveTaskStageState(task, state.telemetryEvents);

    TASK_STAGES.forEach(function(stage) {
        const pill = document.createElement('span');
        const stageInfo = stageState.byStage[stage];
        const isCompleted = stageInfo && stageInfo.reached;
        const isCurrent = stageState.currentStage === stage;

        // Build class list
        const classes = ['task-stage-pill', 'task-stage-pill-' + stage.toLowerCase()];
        if (isCompleted) {
            classes.push('task-stage-pill-completed');
        }
        if (isCurrent) {
            classes.push('task-stage-pill-current');
        }
        if (!isCompleted && !isCurrent) {
            classes.push('task-stage-pill-pending');
        }
        pill.className = classes.join(' ');

        // Use short label
        pill.textContent = STAGE_LABELS[stage];
        pill.title = stage + (isCompleted ? ' (completed)' : isCurrent ? ' (current)' : ' (pending)');

        timeline.appendChild(pill);
    });

    return timeline;
}

/**
 * DEV-COMHU-2025-0012: Task drawer with editable spec, lifecycle buttons.
 * DEV-COMHU-2025-0013: Stable textarea editing (load once, edit locally, save explicitly).
 */
function renderTaskDrawer() {
    const drawer = document.createElement('div');
    drawer.className = `task-drawer ${state.selectedTask ? 'open' : ''}`;

    if (!state.selectedTask) return drawer;

    const vtid = state.selectedTask.vtid;
    const task = state.selectedTask;

    // VTID-01006: Determine drawer mode based on task lifecycle state
    // OASIS-derived terminal state is AUTHORITATIVE - oasisColumn is the source of truth
    const isTerminal = task.is_terminal === true;
    const terminalOutcome = task.terminal_outcome; // 'success' | 'failed' | null
    const taskStatus = (task.status || '').toLowerCase();
    // VTID-01006 FIX: oasisColumn from API is the SINGLE SOURCE OF TRUTH
    const oasisColumn = (task.oasisColumn || '').toUpperCase();
    const isOasisTerminal = oasisColumn === 'COMPLETED';

    // VTID-01006: When OASIS says terminal, LOCAL OVERRIDES ARE INVALID
    // Clear any stale local override that conflicts with OASIS authority
    if (isOasisTerminal) {
        const localOverride = getTaskStatusOverride(vtid);
        if (localOverride) {
            console.log('[VTID-01006] Clearing stale local override for terminal task:', vtid);
            clearTaskStatusOverride(vtid);
        }
    }

    // VTID-01006: Task is FINAL if ANY of these conditions are true:
    // 1. oasisColumn is COMPLETED (AUTHORITATIVE - highest priority)
    // 2. is_terminal flag from API
    // 3. status indicates completion
    const isFinalMode = isOasisTerminal ||
        isTerminal ||
        taskStatus === 'completed' ||
        taskStatus === 'failed' ||
        taskStatus === 'cancelled';

    // VTID-01006: Determine if task failed (for styling)
    const isFailedTask = terminalOutcome === 'failed' || taskStatus === 'failed';

    // VTID-01006: Check OASIS authority for completed tasks
    const vtidEvents = getEventsForVtid(vtid);
    const hasOasisEvents = vtidEvents && vtidEvents.length > 0;
    const hasOasisCompletionEvent = vtidEvents.some(function(e) {
        const topic = (e.topic || '').toLowerCase();
        return topic === 'vtid.lifecycle.completed' ||
               topic === 'vtid.lifecycle.failed' ||
               topic === 'deploy.gateway.success' ||
               topic === 'deploy.gateway.failed' ||
               topic === 'cicd.deploy.service.succeeded' ||
               topic === 'cicd.github.safe_merge.executed';
    });

    // VTID-01006: Inconsistent state detection
    const isInconsistentState = (taskStatus === 'completed' || taskStatus === 'failed') &&
                                !isTerminal && !hasOasisCompletionEvent;

    // DEV-COMHU-2025-0013: Initialize drawer spec state when opening for a new task
    if (state.drawerSpecVtid !== vtid) {
        state.drawerSpecVtid = vtid;
        state.drawerSpecText = getTaskSpec(vtid);
    }

    const header = document.createElement('div');
    header.className = 'drawer-header';

    // VTID-01041: Show VTID as the main heading
    const vtidHeading = document.createElement('h2');
    vtidHeading.className = 'drawer-title-text';
    vtidHeading.textContent = vtid;
    header.appendChild(vtidHeading);

    // VTID-01041: Editable title row (below VTID heading)
    var columnStatus = mapStatusToColumnWithOverride(vtid, task.status, task.oasisColumn) || 'Scheduled';
    var isScheduled = columnStatus === 'Scheduled';
    var drawerEffectiveTitle = getEffectiveTaskTitle(task);

    const titleRow = document.createElement('div');
    titleRow.className = 'drawer-title-row';
    if (isPlaceholderTitle(drawerEffectiveTitle)) {
        titleRow.classList.add('drawer-title-placeholder');
    }
    if (isScheduled && !isFinalMode) {
        titleRow.classList.add('drawer-title-editable');
    }

    const titleLabel = document.createElement('span');
    titleLabel.className = 'drawer-title-label';
    titleLabel.textContent = 'Title: ';
    titleRow.appendChild(titleLabel);

    const titleValue = document.createElement('span');
    titleValue.className = 'drawer-title-value';
    titleValue.textContent = drawerEffectiveTitle;
    titleRow.appendChild(titleValue);

    // VTID-01041: Make title clickable for editing (Scheduled tasks only)
    if (isScheduled && !isFinalMode) {
        titleRow.onclick = function(e) {
            e.stopPropagation();
            startDrawerTitleEdit(titleValue, task);
        };
    }
    header.appendChild(titleRow);

    // VTID-01010: Add target role badge(s) to drawer header
    const drawerTargetRoles = getTaskTargetRoles(task);
    if (drawerTargetRoles && drawerTargetRoles.length > 0) {
        drawerTargetRoles.forEach(function(role) {
            const roleBadge = document.createElement('span');
            roleBadge.className = 'drawer-role-badge drawer-role-badge-' + role.toLowerCase();
            roleBadge.textContent = role;
            roleBadge.title = TARGET_ROLE_LABELS[role] || role;
            header.appendChild(roleBadge);
        });
    } else {
        // VTID-01010: Show UNKNOWN badge for tasks without roles
        const unknownBadge = document.createElement('span');
        unknownBadge.className = 'drawer-role-badge drawer-role-badge-unknown';
        unknownBadge.textContent = 'UNKNOWN';
        unknownBadge.title = 'No target role set';
        header.appendChild(unknownBadge);
    }

    // VTID-01006: Add mode indicator badge
    if (isFinalMode) {
        const modeBadge = document.createElement('span');
        modeBadge.className = 'drawer-mode-badge';
        if (isFailedTask) {
            modeBadge.classList.add('drawer-mode-failed');
            modeBadge.textContent = 'FAILED';
        } else if (taskStatus === 'cancelled') {
            modeBadge.classList.add('drawer-mode-failed');
            modeBadge.textContent = 'CANCELLED';
        } else {
            modeBadge.classList.add('drawer-mode-final');
            modeBadge.textContent = 'FINALIZED';
        }
        header.appendChild(modeBadge);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        state.selectedTask = null;
        state.selectedTaskDetail = null;
        state.selectedTaskDetailLoading = false;
        // VTID-01209: Stop execution status polling and clear state
        stopExecutionStatusPolling();
        state.executionStatus = null;
        state.executionStatusLoading = false;
        // DEV-COMHU-2025-0013: Clear drawer spec state on close
        state.drawerSpecVtid = null;
        state.drawerSpecText = '';
        renderApp();
    };
    header.appendChild(closeBtn);

    drawer.appendChild(header);

    const content = document.createElement('div');
    content.className = 'drawer-content';

    // VTID-01006: Add final mode class for styling
    if (isFinalMode) {
        content.classList.add('drawer-content-final');
    }

    // VTID-01009: Show OASIS-derived status as authoritative (no "local override" label)
    // Priority: OASIS column > localStorage > API status
    // Note: oasisColumn is already declared above at line 3001 (uppercased)
    var statusDisplay;
    if (oasisColumn === 'IN_PROGRESS') {
        // OASIS confirms in_progress via lifecycle.started event - authoritative
        statusDisplay = 'in_progress';
        // Clear any stale local override now that OASIS is authoritative
        clearTaskStatusOverride(vtid);
    } else if (oasisColumn === 'COMPLETED') {
        // OASIS confirms completed via lifecycle.completed/failed - authoritative
        statusDisplay = state.selectedTask.status || 'completed';
        clearTaskStatusOverride(vtid);
    } else {
        // No OASIS lifecycle event - use effective status
        var effectiveStatus = getEffectiveStatus(vtid, state.selectedTask.status);
        statusDisplay = effectiveStatus;
        var isLocalOverride = getTaskStatusOverride(vtid) !== null;
        if (isLocalOverride) {
            statusDisplay = effectiveStatus + ' (local override)';
        }
    }

    const summary = document.createElement('p');
    summary.className = 'task-summary-text';
    summary.textContent = state.selectedTask.summary;
    content.appendChild(summary);

    // VTID-01003: Format timestamp as "YYYY-MM-DD at HH:MM" (no seconds, no timezone)
    var createdDisplay = 'N/A';
    if (state.selectedTask.createdAt) {
        try {
            var dt = new Date(state.selectedTask.createdAt);
            if (!isNaN(dt.getTime())) {
                var yyyy = dt.getFullYear();
                var mm = String(dt.getMonth() + 1).padStart(2, '0');
                var dd = String(dt.getDate()).padStart(2, '0');
                var hh = String(dt.getHours()).padStart(2, '0');
                var mi = String(dt.getMinutes()).padStart(2, '0');
                createdDisplay = yyyy + '-' + mm + '-' + dd + ' at ' + hh + ':' + mi;
            } else {
                createdDisplay = state.selectedTask.createdAt;
            }
        } catch (e) {
            createdDisplay = state.selectedTask.createdAt;
        }
    }

    // VTID-01003: Drawer metadata - show Created first, then Status. Remove Title row (already shown in summary)
    const details = document.createElement('div');
    details.className = 'task-details-block';
    details.innerHTML = '<p><strong>Created:</strong> ' + createdDisplay + '</p>' +
        '<p><strong>Status:</strong> ' + statusDisplay + '</p>';
    content.appendChild(details);

    // VTID-01006: Inconsistent state warning (completed without OASIS authority)
    if (isInconsistentState) {
        var inconsistentWarning = document.createElement('div');
        inconsistentWarning.className = 'task-inconsistent-state-warning';
        inconsistentWarning.innerHTML = '<strong>Inconsistent state:</strong> Task marked as ' +
            taskStatus + ' without OASIS authority. ' +
            'No completion lifecycle event found in OASIS events.';
        content.appendChild(inconsistentWarning);
    }

    // VTID-01006: Finalization banner for completed/failed/cancelled tasks
    if (isFinalMode && !isInconsistentState) {
        var finalizationBanner = document.createElement('div');
        finalizationBanner.className = 'task-finalization-banner';
        if (isFailedTask) {
            finalizationBanner.innerHTML = '<strong>This task has failed.</strong> ' +
                'The spec is locked and cannot be modified. Any changes require a NEW VTID.';
            finalizationBanner.classList.add('task-finalization-banner-failed');
        } else if (taskStatus === 'cancelled') {
            finalizationBanner.innerHTML = '<strong>This task was cancelled.</strong> ' +
                'The spec is locked and cannot be modified. Any changes require a NEW VTID.';
            finalizationBanner.classList.add('task-finalization-banner-cancelled');
        } else {
            finalizationBanner.innerHTML = '<strong>This task is finalized.</strong> ' +
                'The spec is locked and cannot be modified. Any changes require a NEW VTID.';
        }
        content.appendChild(finalizationBanner);
    }

    // VTID-01188: Spec Pipeline Section (Generate/Validate/Approve)
    // Only show for Scheduled tasks that are not finalized
    var currentColumn = mapStatusToColumnWithOverride(vtid, state.selectedTask.status, state.selectedTask.oasisColumn);
    if (currentColumn === 'Scheduled' && !isFinalMode) {
        var specPipelineSection = document.createElement('div');
        specPipelineSection.className = 'task-spec-pipeline-section';

        var specPipelineHeader = document.createElement('div');
        specPipelineHeader.className = 'task-spec-pipeline-header';

        var specPipelineTitle = document.createElement('span');
        specPipelineTitle.className = 'task-spec-pipeline-title';
        specPipelineTitle.textContent = 'Spec Pipeline';
        specPipelineHeader.appendChild(specPipelineTitle);

        // Spec status pill
        // VTID-01188: Prefer fresh data from selectedTaskDetail, fallback to selectedTask
        var specStatus = (state.selectedTaskDetail && state.selectedTaskDetail.spec_status)
            ? state.selectedTaskDetail.spec_status
            : (state.selectedTask.spec_status || 'missing');
        var specPipelineStatus = document.createElement('div');
        specPipelineStatus.className = 'task-spec-pipeline-status';

        var specStatusPill = document.createElement('span');
        specStatusPill.className = 'task-card-spec-pill task-card-spec-pill-' + specStatus.toLowerCase();
        var specStatusLabels = {
            'missing': 'SPEC MISSING',
            'generating': 'GENERATING...',
            'draft': 'DRAFT',
            'validating': 'VALIDATING...',
            'validated': 'VALIDATED',
            'rejected': 'REJECTED',
            'approved': 'APPROVED'
        };
        specStatusPill.textContent = specStatusLabels[specStatus] || specStatus.toUpperCase();
        specPipelineStatus.appendChild(specStatusPill);
        specPipelineHeader.appendChild(specPipelineStatus);

        specPipelineSection.appendChild(specPipelineHeader);

        // Action buttons row
        var specPipelineActions = document.createElement('div');
        specPipelineActions.className = 'task-spec-pipeline-actions';

        // Generate Spec button (visible when missing or rejected)
        if (specStatus === 'missing' || specStatus === 'rejected') {
            var generateBtn = document.createElement('button');
            generateBtn.className = 'task-spec-pipeline-btn task-spec-pipeline-btn-generate';
            generateBtn.textContent = 'Generate Spec';
            generateBtn.title = 'Generate spec from task description';
            generateBtn.onclick = async function() {
                generateBtn.disabled = true;
                generateBtn.textContent = 'Generating...';
                try {
                    var seedNotes = state.drawerSpecText || state.selectedTask.summary || state.selectedTask.title || '';
                    var response = await fetch('/api/v1/specs/' + vtid + '/generate', {
                        method: 'POST',
                        headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ seed_notes: seedNotes, source: 'commandhub' })
                    });
                    var result = await response.json();
                    if (result.ok) {
                        showToast('Spec generated for ' + vtid, 'success');
                        // Refresh task detail
                        await fetchVtidDetail(vtid);
                        await fetchTasks();
                    } else {
                        showToast('Generate failed: ' + (result.message || result.error || 'Unknown error'), 'error');
                        generateBtn.disabled = false;
                        generateBtn.textContent = 'Generate Spec';
                    }
                } catch (e) {
                    console.error('[VTID-01188] Generate spec error:', e);
                    showToast('Generate failed: Network error', 'error');
                    generateBtn.disabled = false;
                    generateBtn.textContent = 'Generate Spec';
                }
            };
            specPipelineActions.appendChild(generateBtn);
        }

        // Validate button (visible when draft)
        if (specStatus === 'draft') {
            var validateBtn = document.createElement('button');
            validateBtn.className = 'task-spec-pipeline-btn task-spec-pipeline-btn-validate';
            validateBtn.textContent = 'Validate';
            validateBtn.title = 'Validate spec against governance rules';
            validateBtn.onclick = async function() {
                validateBtn.disabled = true;
                validateBtn.textContent = 'Validating...';
                try {
                    var response = await fetch('/api/v1/specs/' + vtid + '/validate', {
                        method: 'POST',
                        headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' })
                    });
                    var result = await response.json();
                    if (result.ok) {
                        if (result.result === 'pass') {
                            showToast('Spec validated for ' + vtid, 'success');
                        } else {
                            showToast('Validation failed: ' + (result.message || 'Check report'), 'warning');
                        }
                        await fetchVtidDetail(vtid);
                        await fetchTasks();
                    } else {
                        showToast('Validation error: ' + (result.message || result.error || 'Unknown error'), 'error');
                        validateBtn.disabled = false;
                        validateBtn.textContent = 'Validate';
                    }
                } catch (e) {
                    console.error('[VTID-01188] Validate spec error:', e);
                    showToast('Validation failed: Network error', 'error');
                    validateBtn.disabled = false;
                    validateBtn.textContent = 'Validate';
                }
            };
            specPipelineActions.appendChild(validateBtn);
        }

        // Approve button (visible when validated)
        if (specStatus === 'validated') {
            var approveBtn = document.createElement('button');
            approveBtn.className = 'task-spec-pipeline-btn task-spec-pipeline-btn-approve';
            approveBtn.textContent = 'Approve Spec';
            approveBtn.title = 'Approve spec for activation';
            approveBtn.onclick = async function() {
                approveBtn.disabled = true;
                approveBtn.textContent = 'Approving...';
                try {
                    var userId = MeState.me?.user_id || MeState.me?.email || 'unknown';
                    var userRole = MeState.me?.active_role || 'operator';
                    var response = await fetch('/api/v1/specs/' + vtid + '/approve', {
                        method: 'POST',
                        headers: withVitanaContextHeaders({
                            'Content-Type': 'application/json',
                            'x-user-id': userId,
                            'x-user-role': userRole
                        })
                    });
                    var result = await response.json();
                    if (result.ok) {
                        showToast('Spec approved for ' + vtid + ' - Activate is now enabled', 'success');
                        await fetchVtidDetail(vtid);
                        await fetchTasks();
                    } else {
                        showToast('Approval failed: ' + (result.message || result.error || 'Unknown error'), 'error');
                        approveBtn.disabled = false;
                        approveBtn.textContent = 'Approve Spec';
                    }
                } catch (e) {
                    console.error('[VTID-01188] Approve spec error:', e);
                    showToast('Approval failed: Network error', 'error');
                    approveBtn.disabled = false;
                    approveBtn.textContent = 'Approve Spec';
                }
            };
            specPipelineActions.appendChild(approveBtn);
        }

        // View Spec button (visible when draft, validated, or approved)
        if (specStatus === 'draft' || specStatus === 'validated' || specStatus === 'approved') {
            var viewBtn = document.createElement('button');
            viewBtn.className = 'task-spec-pipeline-btn task-spec-pipeline-btn-view';
            viewBtn.textContent = 'View Spec';
            viewBtn.title = 'View generated spec';
            viewBtn.onclick = async function() {
                viewBtn.disabled = true;
                viewBtn.textContent = 'Loading...';
                try {
                    var response = await fetch('/api/v1/specs/' + vtid, {
                        headers: withVitanaContextHeaders({})
                    });
                    var result = await response.json();
                    if (result.ok && result.spec) {
                        // Show spec in a viewer
                        var existingViewer = specPipelineSection.querySelector('.task-spec-viewer');
                        if (existingViewer) {
                            existingViewer.remove();
                        }
                        var viewer = document.createElement('div');
                        viewer.className = 'task-spec-viewer';
                        var viewerContent = document.createElement('pre');
                        viewerContent.className = 'task-spec-viewer-content';
                        viewerContent.textContent = result.spec.spec_markdown || 'No spec content';
                        viewer.appendChild(viewerContent);
                        specPipelineSection.appendChild(viewer);
                        viewBtn.textContent = 'Hide Spec';
                        viewBtn.onclick = function() {
                            viewer.remove();
                            viewBtn.textContent = 'View Spec';
                            viewBtn.onclick = arguments.callee;
                        };
                    } else {
                        showToast('Could not load spec: ' + (result.error || 'Unknown error'), 'error');
                    }
                    viewBtn.disabled = false;
                } catch (e) {
                    console.error('[VTID-01188] View spec error:', e);
                    showToast('Could not load spec: Network error', 'error');
                    viewBtn.disabled = false;
                    viewBtn.textContent = 'View Spec';
                }
            };
            specPipelineActions.appendChild(viewBtn);
        }

        specPipelineSection.appendChild(specPipelineActions);

        // Show last error if rejected
        if (specStatus === 'rejected' && state.selectedTask.spec_last_error) {
            var errorDiv = document.createElement('div');
            errorDiv.className = 'task-spec-validation-error';
            errorDiv.textContent = 'Validation Error: ' + state.selectedTask.spec_last_error;
            specPipelineSection.appendChild(errorDiv);
        }

        content.appendChild(specPipelineSection);
    }

    // DEV-COMHU-2025-0012: Task Spec Editor Section
    // VTID-01006: Enforce editability based on lifecycle state
    var specSection = document.createElement('div');
    specSection.className = 'task-spec-section';
    if (isFinalMode) {
        specSection.classList.add('task-spec-section-locked');
    }

    var specHeading = document.createElement('h3');
    specHeading.className = 'task-spec-heading';
    // VTID-01006: Update heading based on mode
    specHeading.textContent = isFinalMode ? 'Task Spec (read-only)' : 'Task Spec (editable)';
    specSection.appendChild(specHeading);

    var specTextarea = document.createElement('textarea');
    specTextarea.className = 'task-spec-textarea';
    // VTID-01006: Lock textarea in final mode
    if (isFinalMode) {
        specTextarea.classList.add('task-spec-textarea-locked');
        specTextarea.readOnly = true;
        specTextarea.placeholder = 'Task spec is locked (finalized task)';
    } else {
        specTextarea.placeholder = 'Enter task specification here...';
    }
    // DEV-COMHU-2025-0013: Use stable state value (not localStorage on every render)
    specTextarea.value = state.drawerSpecText;
    specTextarea.id = 'task-spec-editor-' + vtid.replace(/[^a-zA-Z0-9]/g, '-');

    // VTID-01006: Only attach editing handlers in active mode
    if (!isFinalMode) {
        // DEV-COMHU-2025-0015: Track editing state to prevent re-render interruptions
        specTextarea.onfocus = function() {
            state.drawerSpecEditing = true;
        };
        // DEV-COMHU-2025-0013: Update state on input without re-rendering (stable typing)
        specTextarea.oninput = function(e) {
            state.drawerSpecText = e.target.value;
            state.drawerSpecEditing = true;
        };
        specTextarea.onblur = function() {
            // Reset editing flag when user leaves the input
            state.drawerSpecEditing = false;
        };
    }
    specSection.appendChild(specTextarea);

    // VTID-01006: Only show action buttons in active mode
    if (!isFinalMode) {
        // DEV-COMHU-2025-0012: Spec action buttons
        var specActions = document.createElement('div');
        specActions.className = 'task-spec-actions';

        var saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary task-spec-btn';
        saveBtn.textContent = 'Save';
        saveBtn.onclick = function() {
            // DEV-COMHU-2025-0013: Save from stable state, not DOM query
            // DEV-COMHU-2025-0015: Show correct VTID in toast message
            if (saveTaskSpec(vtid, state.drawerSpecText)) {
                showToast('Saved task ' + vtid, 'success');
            } else {
                showToast('Failed to save spec for ' + vtid, 'error');
            }
        };
        specActions.appendChild(saveBtn);

        var resetBtn = document.createElement('button');
        resetBtn.className = 'btn task-spec-btn';
        resetBtn.textContent = 'Reset';
        resetBtn.onclick = function() {
            // DEV-COMHU-2025-0013: Reset from localStorage and update stable state
            state.drawerSpecText = getTaskSpec(vtid);
            var textarea = document.getElementById('task-spec-editor-' + vtid.replace(/[^a-zA-Z0-9]/g, '-'));
            if (textarea) {
                textarea.value = state.drawerSpecText;
            }
            showToast('Spec reset to last saved', 'info');
        };
        specActions.appendChild(resetBtn);

        // VTID-01009: Activate button (Scheduled → In Progress)
        // VTID-01188: Gate activation on spec approval status
        // Emits authoritative OASIS lifecycle.started event
        var currentColumn = mapStatusToColumnWithOverride(vtid, state.selectedTask.status, state.selectedTask.oasisColumn);
        if (currentColumn === 'Scheduled') {
            var activateBtn = document.createElement('button');
            activateBtn.className = 'btn btn-success task-spec-btn task-activate-btn';

            // VTID-01188: Check spec approval status - disable if not approved
            // VTID-01194: Use selectedTaskDetail.spec_status first (updated after approval), then fall back
            var taskSpecStatus = (state.selectedTaskDetail && state.selectedTaskDetail.spec_status)
                ? state.selectedTaskDetail.spec_status
                : (state.selectedTask.spec_status || 'missing');
            var isSpecApproved = taskSpecStatus === 'approved';

            if (!isSpecApproved) {
                activateBtn.disabled = true;
                activateBtn.title = 'Spec must be approved before activation (current: ' + taskSpecStatus + ')';
                activateBtn.classList.add('btn-disabled');
                activateBtn.textContent = 'Activate (Spec Required)';
            } else {
                activateBtn.textContent = 'Activate';
                activateBtn.title = 'Move task from Scheduled to In Progress';
            }

            activateBtn.onclick = async function() {
                // VTID-01188: Double-check spec approval on click (in case state is stale)
                if (!isSpecApproved) {
                    showToast('Cannot activate: spec must be approved first', 'warning');
                    return;
                }
                // VTID-01194: Show confirmation modal instead of direct activation
                // "Moving this task to In Progress will immediately start autonomous execution."
                state.executionApprovalVtid = vtid;
                state.executionApprovalReason = '';
                state.showExecutionApprovalModal = true;
                renderApp();
            };
            specActions.appendChild(activateBtn);

            // VTID-01052: Delete button (Scheduled tasks only)
            // Soft deletes the task, voids the VTID, logs OASIS event
            var deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger task-spec-btn task-delete-btn';
            deleteBtn.textContent = 'Delete';
            deleteBtn.title = 'Delete scheduled task (voids VTID permanently)';
            deleteBtn.onclick = async function() {
                // VTID-01052: Confirm before deletion - this action is irreversible
                var confirmMsg = 'Delete scheduled task ' + vtid + '?\n\n' +
                    'This will:\n' +
                    '• Remove the task from the Scheduled column\n' +
                    '• Void the VTID permanently (cannot be reused)\n' +
                    '• Log the deletion in OASIS\n\n' +
                    'This action cannot be undone.';

                if (!confirm(confirmMsg)) {
                    return;
                }

                deleteBtn.disabled = true;
                deleteBtn.textContent = 'Deleting...';
                try {
                    var response = await fetch('/api/v1/oasis/tasks/' + vtid, {
                        method: 'DELETE',
                        headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' })
                    });
                    var result = await response.json();
                    if (result.ok) {
                        // VTID-01052: Clear local storage spec for this task
                        localStorage.removeItem('vitana.taskSpec.' + vtid);
                        clearTaskStatusOverride(vtid);
                        showToast('Task deleted: ' + vtid, 'success');
                        // Close drawer and refresh
                        state.selectedTask = null;
                        state.selectedTaskDetail = null;
                        state.drawerSpecVtid = null;
                        state.drawerSpecText = '';
                        state.drawerSpecEditing = false;
                        await fetchTasks();
                    } else {
                        // VTID-01052: Handle errors (e.g., INVALID_STATE for non-scheduled tasks)
                        var errorMsg = result.message || result.error || 'Unknown error';
                        showToast('Delete failed: ' + errorMsg, 'error');
                        deleteBtn.disabled = false;
                        deleteBtn.textContent = 'Delete';
                    }
                } catch (e) {
                    console.error('[VTID-01052] Delete failed:', e);
                    showToast('Delete failed: Network error', 'error');
                    deleteBtn.disabled = false;
                    deleteBtn.textContent = 'Delete';
                }
            };
            specActions.appendChild(deleteBtn);
        }

        specSection.appendChild(specActions);

        // DEV-COMHU-2025-0012: Local persistence banner
        var localBanner = document.createElement('div');
        localBanner.className = 'task-spec-local-banner';
        localBanner.textContent = 'Persistence: localStorage (DEV-COMHU-2025-0012)';
        specSection.appendChild(localBanner);
    }

    content.appendChild(specSection);

    // VTID-01209: Add real-time execution status for in-progress tasks
    var execStatusColumn = mapStatusToColumnWithOverride(vtid, task.status, task.oasisColumn);
    if (execStatusColumn === 'In Progress') {
        var executionStatusSection = renderTaskExecutionStatus(state.executionStatus, { variant: 'drawer' });
        content.appendChild(executionStatusSection);
    }

    // VTID-0527: Add detailed stage timeline view
    const stageDetail = renderTaskStageDetail(state.selectedTask);
    content.appendChild(stageDetail);

    // DEV-COMHU-0202: Add VTID event history section
    const eventHistory = renderTaskEventHistory(state.selectedTask.vtid);
    content.appendChild(eventHistory);

    drawer.appendChild(content);

    return drawer;
}

/**
 * DEV-COMHU-0202: Get events for a specific VTID from global events state.
 */
function getEventsForVtid(vtid) {
    if (!vtid) return [];
    return (state.events || []).filter(function(e) {
        return e.vtid === vtid;
    });
}

/**
 * DEV-COMHU-0202: Render event history for a VTID in the task drawer.
 * DEV-COMHU-2025-0015: Improved formatting with structured detail view.
 * Shows last deploy, governance, and other events for correlation.
 */
function renderTaskEventHistory(vtid) {
    const container = document.createElement('div');
    container.className = 'task-event-history';

    const heading = document.createElement('h3');
    heading.className = 'task-event-history-heading';
    heading.textContent = 'OASIS Event Tracking';
    container.appendChild(heading);

    const events = getEventsForVtid(vtid);

    // DEV-COMHU-2025-0015: Filter out noise events (internal/debug)
    var filteredEvents = events.filter(function(e) {
        // Skip internal system events and noise
        if (!e.topic) return false;
        if (e.topic.startsWith('internal.')) return false;
        if (e.topic.startsWith('debug.')) return false;
        return true;
    });

    if (!filteredEvents || filteredEvents.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'task-event-history-empty';
        emptyDiv.textContent = 'No tracked events for ' + vtid;
        container.appendChild(emptyDiv);
        return container;
    }

    const list = document.createElement('div');
    list.className = 'task-event-history-list';

    // Show last 5 events, sorted by timestamp (newest first)
    var sortedEvents = filteredEvents.slice().sort(function(a, b) {
        var dateA = a.createdAt || a.created_at || '';
        var dateB = b.createdAt || b.created_at || '';
        if (!dateA || !dateB) return 0;
        return new Date(dateB) - new Date(dateA);
    });

    sortedEvents.slice(0, 5).forEach(function(event, index) {
        const item = document.createElement('div');
        item.className = 'task-event-history-item';
        item.dataset.eventIndex = index;

        // DEV-COMHU-2025-0015: Status-based styling
        var status = event.status || '';
        if (status === 'success' || (event.topic && event.topic.includes('.success'))) {
            item.classList.add('task-event-history-item-success');
        } else if (status === 'error' || (event.topic && (event.topic.includes('.failed') || event.topic.includes('.blocked')))) {
            item.classList.add('task-event-history-item-error');
        } else if (status === 'warning') {
            item.classList.add('task-event-history-item-warning');
        }

        // DEV-COMHU-2025-0015: Header row with timestamp, type, vtid
        const headerRow = document.createElement('div');
        headerRow.className = 'task-event-history-header';

        // Timestamp (clear format)
        var eventDate = event.createdAt || event.created_at;
        var timestamp = eventDate ? new Date(eventDate).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }) : '';
        const timeSpan = document.createElement('span');
        timeSpan.className = 'task-event-history-time';
        timeSpan.textContent = timestamp;
        headerRow.appendChild(timeSpan);

        // Type/Topic (abbreviated)
        const topicSpan = document.createElement('span');
        topicSpan.className = 'task-event-history-topic';
        var topicText = event.topic || 'event';
        // Shorten long topics
        if (topicText.length > 25) {
            topicText = topicText.split('.').slice(-2).join('.');
        }
        topicSpan.textContent = topicText;
        headerRow.appendChild(topicSpan);

        // Status badge
        if (status) {
            const statusBadge = document.createElement('span');
            statusBadge.className = 'task-event-history-status task-event-status-' + status;
            statusBadge.textContent = status;
            headerRow.appendChild(statusBadge);
        }

        item.appendChild(headerRow);

        // Short message
        if (event.message) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'task-event-history-message';
            var msgText = event.message;
            if (msgText.length > 80) {
                msgText = msgText.substring(0, 77) + '...';
            }
            msgDiv.textContent = msgText;
            item.appendChild(msgDiv);
        }

        // DEV-COMHU-2025-0015: Expandable detail view (click to toggle)
        const detailDiv = document.createElement('div');
        detailDiv.className = 'task-event-history-detail';
        detailDiv.style.display = 'none';

        // Build structured key/value pairs
        var detailFields = [
            { label: 'Event ID', value: event.id },
            { label: 'VTID', value: event.vtid },
            { label: 'Topic', value: event.topic },
            { label: 'Status', value: event.status },
            { label: 'Service', value: event.service },
            { label: 'Role', value: event.role },
            { label: 'Model', value: event.model },
            { label: 'SWV', value: event.swv },
            { label: 'Full Message', value: event.message }
        ];

        detailFields.forEach(function(field) {
            if (field.value) {
                const row = document.createElement('div');
                row.className = 'task-event-detail-row';
                row.innerHTML = '<span class="task-event-detail-label">' + field.label + ':</span>' +
                    '<span class="task-event-detail-value">' + field.value + '</span>';
                detailDiv.appendChild(row);
            }
        });

        // Metadata JSON if present
        if (event.metadata && Object.keys(event.metadata).length > 0) {
            const metaRow = document.createElement('div');
            metaRow.className = 'task-event-detail-row task-event-detail-meta';
            const metaLabel = document.createElement('div');
            metaLabel.className = 'task-event-detail-label';
            metaLabel.textContent = 'Metadata:';
            metaRow.appendChild(metaLabel);
            const metaPre = document.createElement('pre');
            metaPre.className = 'task-event-detail-json';
            metaPre.textContent = JSON.stringify(event.metadata, null, 2);
            metaRow.appendChild(metaPre);
            detailDiv.appendChild(metaRow);
        }

        item.appendChild(detailDiv);

        // Click handler to expand/collapse
        item.onclick = function() {
            var detail = this.querySelector('.task-event-history-detail');
            if (detail) {
                var isOpen = detail.style.display !== 'none';
                detail.style.display = isOpen ? 'none' : 'block';
                this.classList.toggle('task-event-history-item-expanded', !isOpen);
            }
        };
        item.style.cursor = 'pointer';

        list.appendChild(item);
    });

    container.appendChild(list);
    return container;
}

/**
 * VTID-01209: Render real-time task execution status component.
 * Shows "Step X of N" progress for in-progress tasks with live updates.
 * Can be embedded in Task Drawer, Operator Ticker, and Command Hub Ticker.
 *
 * @param {Object} executionData - Data from /api/v1/vtid/:vtid/execution-status
 * @param {Object} options - Rendering options
 * @param {string} options.variant - 'drawer' | 'ticker-inline' | 'ticker-card'
 * @param {boolean} options.showRecent - Whether to show recent events (default: true)
 * @returns {HTMLElement}
 */
function renderTaskExecutionStatus(executionData, options) {
    options = options || {};
    var variant = options.variant || 'drawer';
    var showRecent = options.showRecent !== false;

    var container = document.createElement('div');
    container.className = 'task-execution-status task-execution-status-' + variant;

    if (!executionData) {
        container.innerHTML = '<div class="execution-status-loading">Loading execution status...</div>';
        return container;
    }

    // Header with LIVE badge
    var header = document.createElement('div');
    header.className = 'execution-status-header';

    if (executionData.isActive) {
        var liveBadge = document.createElement('span');
        liveBadge.className = 'execution-status-live-badge';
        liveBadge.innerHTML = '<span class="live-dot"></span> LIVE';
        header.appendChild(liveBadge);
    }

    var vtidLabel = document.createElement('span');
    vtidLabel.className = 'execution-status-vtid';
    vtidLabel.textContent = executionData.vtid;
    header.appendChild(vtidLabel);

    var statusBadge = document.createElement('span');
    statusBadge.className = 'execution-status-badge execution-status-badge-' + executionData.status;
    statusBadge.textContent = executionData.status.replace(/_/g, ' ');
    header.appendChild(statusBadge);

    container.appendChild(header);

    // Progress section
    var progressSection = document.createElement('div');
    progressSection.className = 'execution-status-progress';

    // Step counter
    var stepCounter = document.createElement('div');
    stepCounter.className = 'execution-step-counter';

    var currentStep = executionData.currentStep || 0;
    var totalSteps = executionData.totalSteps || 0;
    var progressPercent = totalSteps > 0 ? Math.round((currentStep / Math.max(totalSteps, 1)) * 100) : 0;

    // For in-progress, we show an estimated progress (assume more steps to come)
    if (executionData.isActive && totalSteps > 0) {
        // Active tasks: show actual count but estimate total based on stage
        var stageMultiplier = { 'PLANNER': 4, 'WORKER': 2.5, 'VALIDATOR': 1.5, 'DEPLOY': 1.2 };
        var mult = stageMultiplier[executionData.currentStage] || 2;
        var estimatedTotal = Math.max(totalSteps, Math.ceil(totalSteps * mult));
        progressPercent = Math.min(Math.round((currentStep / estimatedTotal) * 100), 95);
    }

    stepCounter.innerHTML = '<span class="step-current">Step ' + currentStep + '</span>' +
        '<span class="step-separator"> of </span>' +
        '<span class="step-total">' + (executionData.isActive ? '~' + totalSteps + '+' : totalSteps) + '</span>';
    progressSection.appendChild(stepCounter);

    // Progress bar
    var progressBar = document.createElement('div');
    progressBar.className = 'execution-progress-bar';
    if (executionData.isActive) {
        progressBar.classList.add('execution-progress-bar-active');
    }

    var progressFill = document.createElement('div');
    progressFill.className = 'execution-progress-fill';
    progressFill.style.width = progressPercent + '%';

    var progressText = document.createElement('span');
    progressText.className = 'execution-progress-text';
    progressText.textContent = progressPercent + '%';

    progressBar.appendChild(progressFill);
    progressBar.appendChild(progressText);
    progressSection.appendChild(progressBar);

    container.appendChild(progressSection);

    // Current step info
    var currentSection = document.createElement('div');
    currentSection.className = 'execution-current-step';

    var currentLabel = document.createElement('div');
    currentLabel.className = 'execution-current-label';
    currentLabel.textContent = 'Current:';
    currentSection.appendChild(currentLabel);

    var currentName = document.createElement('div');
    currentName.className = 'execution-current-name';
    currentName.textContent = executionData.currentStepName || 'Processing...';
    currentSection.appendChild(currentName);

    // Stage and elapsed time
    var metaRow = document.createElement('div');
    metaRow.className = 'execution-meta-row';

    var stageBadge = document.createElement('span');
    stageBadge.className = 'execution-stage-badge execution-stage-' + (executionData.currentStage || 'unknown').toLowerCase();
    stageBadge.textContent = executionData.currentStage || 'UNKNOWN';
    metaRow.appendChild(stageBadge);

    if (executionData.elapsedMs > 0) {
        var elapsedSpan = document.createElement('span');
        elapsedSpan.className = 'execution-elapsed';
        elapsedSpan.innerHTML = '&#9201; ' + formatElapsedTime(executionData.elapsedMs);
        metaRow.appendChild(elapsedSpan);
    }

    currentSection.appendChild(metaRow);
    container.appendChild(currentSection);

    // Recent events (if enabled and available)
    if (showRecent && executionData.recentEvents && executionData.recentEvents.length > 0) {
        var recentSection = document.createElement('div');
        recentSection.className = 'execution-recent-events';

        var recentLabel = document.createElement('div');
        recentLabel.className = 'execution-recent-label';
        recentLabel.textContent = 'Recent:';
        recentSection.appendChild(recentLabel);

        var recentList = document.createElement('div');
        recentList.className = 'execution-recent-list';

        executionData.recentEvents.slice(0, 3).forEach(function(ev, idx) {
            var eventRow = document.createElement('div');
            eventRow.className = 'execution-recent-item';
            if (idx === 0) eventRow.classList.add('execution-recent-item-latest');

            var statusIcon = document.createElement('span');
            statusIcon.className = 'execution-recent-icon';
            if (ev.status === 'success' || ev.status === 'completed') {
                statusIcon.textContent = '✓';
                statusIcon.classList.add('icon-success');
            } else if (ev.status === 'error' || ev.status === 'failure') {
                statusIcon.textContent = '✗';
                statusIcon.classList.add('icon-error');
            } else {
                statusIcon.textContent = '•';
                statusIcon.classList.add('icon-info');
            }
            eventRow.appendChild(statusIcon);

            var eventName = document.createElement('span');
            eventName.className = 'execution-recent-name';
            eventName.textContent = ev.name;
            eventRow.appendChild(eventName);

            var eventTime = document.createElement('span');
            eventTime.className = 'execution-recent-time';
            eventTime.textContent = formatRelativeTime(ev.timestamp);
            eventRow.appendChild(eventTime);

            recentList.appendChild(eventRow);
        });

        recentSection.appendChild(recentList);
        container.appendChild(recentSection);
    }

    // Last updated timestamp
    if (executionData.lastUpdated) {
        var lastUpdated = document.createElement('div');
        lastUpdated.className = 'execution-last-updated';
        lastUpdated.textContent = 'Updated: ' + formatRelativeTime(executionData.lastUpdated);
        container.appendChild(lastUpdated);
    }

    return container;
}

/**
 * VTID-01209: Format elapsed time in human-readable format.
 * @param {number} ms - Elapsed milliseconds
 * @returns {string}
 */
function formatElapsedTime(ms) {
    if (ms < 1000) return 'just now';
    var seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + 's elapsed';
    var minutes = Math.floor(seconds / 60);
    var secs = seconds % 60;
    if (minutes < 60) return minutes + 'm ' + secs + 's elapsed';
    var hours = Math.floor(minutes / 60);
    var mins = minutes % 60;
    return hours + 'h ' + mins + 'm elapsed';
}

/**
 * VTID-01209: Format timestamp as relative time.
 * @param {string} timestamp - ISO timestamp
 * @returns {string}
 */
function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    var diff = Date.now() - new Date(timestamp).getTime();
    if (diff < 0) return 'just now';
    var seconds = Math.floor(diff / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
}

/**
 * VTID-0527: Render detailed stage timeline for selected task.
 * VTID-01006: OASIS is the ONLY authority for execution stages.
 * Shows vertical list of stages with timestamps and messages.
 * Uses API stageTimeline exclusively - NO client-side inference allowed.
 */
function renderTaskStageDetail(task) {
    const container = document.createElement('div');
    container.className = 'task-stage-detail';

    // VTID-01006: Check task terminal state for stage validation
    const isTerminal = task.is_terminal === true;
    const taskStatus = (task.status || '').toLowerCase();
    const isCompleted = taskStatus === 'completed' || (isTerminal && task.terminal_outcome === 'success');

    const heading = document.createElement('h3');
    heading.className = 'task-stage-detail-heading';
    heading.textContent = 'Execution Stages';
    // VTID-01006: Indicate if stages are locked for completed tasks
    if (isCompleted) {
        heading.textContent = 'Execution Stages (locked)';
    }
    container.appendChild(heading);

    // VTID-0527: Show loading state
    if (state.selectedTaskDetailLoading) {
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'task-stage-detail-loading';
        loadingDiv.textContent = 'Loading stage timeline from OASIS...';
        container.appendChild(loadingDiv);
        return container;
    }

    // VTID-01006: Use ONLY API stageTimeline (OASIS authority)
    // NO client-side fallback - stages MUST come from OASIS
    const apiTimeline = state.selectedTaskDetail && state.selectedTaskDetail.stageTimeline;

    // VTID-01006: Validate completed tasks have all stages DONE
    if (isCompleted && apiTimeline) {
        const pendingStages = apiTimeline.filter(function(e) {
            return e.status === 'PENDING' || e.status === 'RUNNING';
        });
        if (pendingStages.length > 0) {
            const warningDiv = document.createElement('div');
            warningDiv.className = 'task-stage-inconsistent-warning';
            warningDiv.innerHTML = '<strong>Stage inconsistency:</strong> Task is completed but ' +
                pendingStages.length + ' stage(s) are not marked as DONE in OASIS. ' +
                'Stages: ' + pendingStages.map(function(s) { return s.stage; }).join(', ');
            container.appendChild(warningDiv);
        }
    }

    const list = document.createElement('ul');
    list.className = 'task-stage-detail-list';
    // VTID-01006: Add locked class for completed tasks
    if (isCompleted) {
        list.classList.add('task-stage-detail-list-locked');
    }

    TASK_STAGES.forEach(function(stage) {
        // VTID-01006: Get stage info ONLY from API timeline (OASIS authority)
        const apiEntry = apiTimeline ? apiTimeline.find(function(e) { return e.stage === stage; }) : null;

        // VTID-01006: Determine status from OASIS API only
        // VTID-0530: API now returns SUCCESS instead of COMPLETED
        var stageStatus, startedAt, completedAt, errorAt;
        if (apiEntry) {
            stageStatus = apiEntry.status; // 'PENDING', 'RUNNING', 'SUCCESS', 'ERROR' (or legacy 'COMPLETED')
            startedAt = apiEntry.startedAt;
            completedAt = apiEntry.completedAt;
            errorAt = apiEntry.errorAt;
        } else {
            // VTID-01006: No fallback - if no API data, show PENDING (awaiting OASIS)
            stageStatus = 'PENDING';
            startedAt = null;
            completedAt = null;
            errorAt = null;
        }

        // VTID-01006: For completed tasks, force all stages to SUCCESS (OASIS authority)
        // This handles the case where OASIS hasn't synced all stage events yet
        if (isCompleted && stageStatus === 'PENDING') {
            stageStatus = 'SUCCESS';
            // Add marker that this was inferred from terminal state
        }

        const item = document.createElement('li');
        // VTID-0530: Handle both SUCCESS and legacy COMPLETED
        const isSuccess = stageStatus === 'SUCCESS' || stageStatus === 'COMPLETED';
        const statusClass = stageStatus === 'ERROR' ? 'task-stage-detail-item-error' :
                           isSuccess ? 'task-stage-detail-item-completed task-stage-detail-item-success' :
                           stageStatus === 'RUNNING' ? 'task-stage-detail-item-current' :
                           'task-stage-detail-item-pending';
        item.className = 'task-stage-detail-item ' + statusClass;

        // Header row with stage name and status
        const headerRow = document.createElement('div');
        headerRow.className = 'task-stage-detail-header';

        const stageName = document.createElement('span');
        stageName.className = 'task-stage-detail-stage task-stage-detail-stage-' + stage.toLowerCase();
        stageName.textContent = stage;
        headerRow.appendChild(stageName);

        const statusLabel = document.createElement('span');
        statusLabel.className = 'task-stage-detail-status';
        if (stageStatus === 'ERROR') {
            statusLabel.textContent = 'Error';
            statusLabel.classList.add('task-stage-detail-status-error');
        } else if (isSuccess) {
            // VTID-0530: Show "Success" for SUCCESS status (and legacy COMPLETED)
            statusLabel.textContent = 'Success';
            statusLabel.classList.add('task-stage-detail-status-completed');
            statusLabel.classList.add('task-stage-detail-status-success');
        } else if (stageStatus === 'RUNNING') {
            statusLabel.textContent = 'Running';
            statusLabel.classList.add('task-stage-detail-status-current');
        } else {
            statusLabel.textContent = 'Pending';
            statusLabel.classList.add('task-stage-detail-status-pending');
        }
        headerRow.appendChild(statusLabel);

        item.appendChild(headerRow);

        // Meta row with timestamps
        if (startedAt || completedAt || errorAt) {
            const metaRow = document.createElement('div');
            metaRow.className = 'task-stage-detail-meta';

            if (startedAt) {
                const startTime = document.createElement('span');
                startTime.className = 'task-stage-detail-time';
                startTime.textContent = 'Started: ' + formatStageTimestamp(startedAt);
                metaRow.appendChild(startTime);
            }

            if (completedAt) {
                const endTime = document.createElement('span');
                endTime.className = 'task-stage-detail-time task-stage-detail-time-completed';
                endTime.textContent = 'Completed: ' + formatStageTimestamp(completedAt);
                metaRow.appendChild(endTime);
            }

            if (errorAt) {
                const errTime = document.createElement('span');
                errTime.className = 'task-stage-detail-time task-stage-detail-time-error';
                errTime.textContent = 'Error: ' + formatStageTimestamp(errorAt);
                metaRow.appendChild(errTime);
            }

            item.appendChild(metaRow);
        }

        list.appendChild(item);
    });

    container.appendChild(list);

    // VTID-0527: Add vtid-stage-timeline view below the detail list
    const timelineView = renderVtidStageTimeline();
    if (timelineView) {
        container.appendChild(timelineView);
    }

    return container;
}

/**
 * VTID-0527: Render the vtid-stage-timeline visual component.
 * VTID-0530: Updated to handle SUCCESS status.
 * Shows a compact visual timeline with markers and timestamps.
 */
function renderVtidStageTimeline() {
    const apiTimeline = state.selectedTaskDetail && state.selectedTaskDetail.stageTimeline;
    if (!apiTimeline || apiTimeline.length === 0) {
        return null;
    }

    const container = document.createElement('div');
    container.className = 'vtid-stage-timeline';

    apiTimeline.forEach(function(entry) {
        const item = document.createElement('div');
        item.className = 'vtid-stage-timeline-item';

        // Marker
        // VTID-0530: Normalize SUCCESS/COMPLETED to 'success' for CSS class
        var markerStatus = entry.status.toLowerCase();
        if (markerStatus === 'completed') {
            markerStatus = 'success';
        }
        const marker = document.createElement('div');
        marker.className = 'vtid-stage-timeline-item-marker vtid-stage-timeline-item-marker--' + markerStatus;
        item.appendChild(marker);

        // Main content
        const main = document.createElement('div');
        main.className = 'vtid-stage-timeline-item-main';

        const title = document.createElement('div');
        title.className = 'vtid-stage-timeline-item-title';
        title.textContent = entry.stage;
        main.appendChild(title);

        // Timestamp meta
        // VTID-0530: Show "Success" for SUCCESS/COMPLETED status
        var metaText = entry.status;
        var isSuccess = entry.status === 'SUCCESS' || entry.status === 'COMPLETED';
        if (entry.completedAt) {
            metaText = 'Success ' + formatStageTimestamp(entry.completedAt);
        } else if (entry.errorAt) {
            metaText = 'Error ' + formatStageTimestamp(entry.errorAt);
        } else if (entry.startedAt) {
            metaText = (isSuccess ? 'Success' : 'Started') + ' ' + formatStageTimestamp(entry.startedAt);
        } else if (isSuccess) {
            metaText = 'Success';
        }

        const meta = document.createElement('div');
        meta.className = 'vtid-stage-timeline-item-meta';
        meta.textContent = metaText;
        main.appendChild(meta);

        item.appendChild(main);
        container.appendChild(item);
    });

    return container;
}

function renderProfileModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            state.showProfileModal = false;
            state.loginError = null; // Clear any login errors on close
            renderApp();
        }
    };

    const modal = document.createElement('div');
    modal.className = 'modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.textContent = state.authToken ? 'Profile' : 'Login';
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';

    // VTID-01186: Show login form if not authenticated
    if (!state.authToken) {
        // Login form
        const loginForm = document.createElement('div');
        loginForm.className = 'login-form';

        // Email input
        const emailGroup = document.createElement('div');
        emailGroup.className = 'form-group';
        emailGroup.style.marginBottom = '12px';

        const emailLabel = document.createElement('label');
        emailLabel.textContent = 'Email';
        emailLabel.setAttribute('for', 'login-email');
        emailLabel.style.display = 'block';
        emailLabel.style.marginBottom = '4px';
        emailLabel.style.fontWeight = '500';
        emailGroup.appendChild(emailLabel);

        const emailInput = document.createElement('input');
        emailInput.type = 'email';
        emailInput.id = 'login-email';
        emailInput.className = 'form-control';
        emailInput.placeholder = 'Enter your email';
        emailInput.value = state.loginEmail || '';
        emailInput.style.width = '100%';
        emailInput.style.padding = '8px 12px';
        emailInput.style.border = '1px solid var(--border-color, #ccc)';
        emailInput.style.borderRadius = '4px';
        emailInput.style.boxSizing = 'border-box';
        emailInput.disabled = state.loginLoading;
        emailInput.oninput = function(e) {
            state.loginEmail = e.target.value;
        };
        emailGroup.appendChild(emailInput);
        loginForm.appendChild(emailGroup);

        // Password input with visibility toggle
        const passwordGroup = document.createElement('div');
        passwordGroup.className = 'form-group';
        passwordGroup.style.marginBottom = '16px';

        const passwordLabel = document.createElement('label');
        passwordLabel.textContent = 'Password';
        passwordLabel.setAttribute('for', 'login-password');
        passwordLabel.style.display = 'block';
        passwordLabel.style.marginBottom = '4px';
        passwordLabel.style.fontWeight = '500';
        passwordGroup.appendChild(passwordLabel);

        // Password input wrapper for eye icon
        const passwordWrapper = document.createElement('div');
        passwordWrapper.style.position = 'relative';
        passwordWrapper.style.width = '100%';

        const passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.id = 'login-password';
        passwordInput.className = 'form-control';
        passwordInput.placeholder = 'Enter your password';
        passwordInput.value = state.loginPassword || '';
        passwordInput.style.width = '100%';
        passwordInput.style.padding = '8px 40px 8px 12px';
        passwordInput.style.border = '1px solid var(--border-color, #ccc)';
        passwordInput.style.borderRadius = '4px';
        passwordInput.style.boxSizing = 'border-box';
        passwordInput.disabled = state.loginLoading;
        passwordInput.oninput = function(e) {
            state.loginPassword = e.target.value;
        };
        // Allow login on Enter key
        passwordInput.onkeydown = function(e) {
            if (e.key === 'Enter' && !state.loginLoading) {
                doLogin(state.loginEmail, state.loginPassword);
            }
        };
        passwordWrapper.appendChild(passwordInput);

        // Eye icon toggle button
        const eyeToggle = document.createElement('button');
        eyeToggle.type = 'button';
        eyeToggle.className = 'password-toggle';
        eyeToggle.style.position = 'absolute';
        eyeToggle.style.right = '8px';
        eyeToggle.style.top = '50%';
        eyeToggle.style.transform = 'translateY(-50%)';
        eyeToggle.style.background = 'none';
        eyeToggle.style.border = 'none';
        eyeToggle.style.cursor = 'pointer';
        eyeToggle.style.padding = '4px';
        eyeToggle.style.color = 'var(--text-secondary, #888)';
        eyeToggle.style.fontSize = '1.1rem';
        eyeToggle.innerHTML = '&#128065;'; // Eye icon (👁)
        eyeToggle.title = 'Show password';
        eyeToggle.onclick = function() {
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                eyeToggle.innerHTML = '&#128064;'; // Eyes icon (👀)
                eyeToggle.title = 'Hide password';
            } else {
                passwordInput.type = 'password';
                eyeToggle.innerHTML = '&#128065;'; // Eye icon (👁)
                eyeToggle.title = 'Show password';
            }
        };
        passwordWrapper.appendChild(eyeToggle);

        passwordGroup.appendChild(passwordWrapper);
        loginForm.appendChild(passwordGroup);

        // Error message
        if (state.loginError) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'login-error';
            errorDiv.textContent = state.loginError;
            errorDiv.style.color = 'var(--danger-text, #dc3545)';
            errorDiv.style.backgroundColor = 'var(--danger-bg-light, #f8d7da)';
            errorDiv.style.padding = '8px 12px';
            errorDiv.style.borderRadius = '4px';
            errorDiv.style.marginBottom = '12px';
            errorDiv.style.fontSize = '0.875rem';
            loginForm.appendChild(errorDiv);
        }

        // Login button
        const loginBtn = document.createElement('button');
        loginBtn.className = 'btn btn-primary';
        loginBtn.textContent = state.loginLoading ? 'Logging in...' : 'Login';
        loginBtn.style.width = '100%';
        loginBtn.style.padding = '10px';
        loginBtn.style.backgroundColor = 'var(--primary-color, #4a90d9)';
        loginBtn.style.color = '#fff';
        loginBtn.style.border = 'none';
        loginBtn.style.borderRadius = '4px';
        loginBtn.style.cursor = state.loginLoading ? 'not-allowed' : 'pointer';
        loginBtn.style.fontWeight = '500';
        loginBtn.disabled = state.loginLoading;
        loginBtn.onclick = function() {
            if (!state.loginLoading) {
                doLogin(state.loginEmail, state.loginPassword);
            }
        };
        loginForm.appendChild(loginBtn);

        body.appendChild(loginForm);
        modal.appendChild(body);

        // Footer with close button only
        const footer = document.createElement('div');
        footer.className = 'modal-footer';
        footer.style.display = 'flex';
        footer.style.justifyContent = 'flex-end';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn';
        closeBtn.textContent = 'Cancel';
        closeBtn.onclick = () => {
            state.showProfileModal = false;
            state.loginError = null;
            renderApp();
        };
        footer.appendChild(closeBtn);

        modal.appendChild(footer);
        overlay.appendChild(modal);
        return overlay;
    }

    // VTID-01171: Show avatar (initials or image) - AUTHENTICATED USER
    const avatar = document.createElement('div');
    avatar.className = 'profile-avatar-large';
    if (state.user.avatarUrl) {
        avatar.style.backgroundImage = 'url(' + state.user.avatarUrl + ')';
        avatar.style.backgroundSize = 'cover';
        avatar.style.backgroundPosition = 'center';
        avatar.textContent = '';
    } else {
        avatar.textContent = state.user.avatar || '?';
    }
    body.appendChild(avatar);

    // VTID-01171: Show name
    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = state.user.name || 'User';
    body.appendChild(name);

    // VTID-01171: Show email if available (centered under name)
    if (state.user.email) {
        const emailEl = document.createElement('div');
        emailEl.className = 'profile-email';
        emailEl.textContent = state.user.email;
        emailEl.style.color = 'var(--text-secondary, #666)';
        emailEl.style.fontSize = '0.875rem';
        emailEl.style.marginBottom = '8px';
        emailEl.style.textAlign = 'center';
        body.appendChild(emailEl);
    }

    // VTID-01171: Show role badge
    const badge = document.createElement('div');
    badge.className = 'profile-role-badge';
    // Use authIdentity > MeState > viewRole fallback chain
    if (state.authIdentity && state.authIdentity.identity) {
        if (state.authIdentity.identity.exafy_admin) {
            badge.textContent = 'Admin';
        } else if (state.authIdentity.memberships && state.authIdentity.memberships.length > 0) {
            var role = state.authIdentity.memberships[0].role || 'user';
            badge.textContent = role.charAt(0).toUpperCase() + role.slice(1);
        } else {
            badge.textContent = 'User';
        }
    } else if (state.authIdentityLoading) {
        badge.textContent = 'Loading...';
    } else if (MeState.me && MeState.me.active_role) {
        badge.textContent = MeState.me.active_role.charAt(0).toUpperCase() + MeState.me.active_role.slice(1);
    } else if (!MeState.loaded) {
        badge.textContent = 'Loading...';
    } else if (MeState.loaded && !MeState.me) {
        badge.textContent = 'Not signed in';
    } else {
        badge.textContent = state.viewRole; // Fallback
    }
    body.appendChild(badge);

    // VTID-01186: Edit Profile link (matching vitana-v1 design)
    const editProfileLink = document.createElement('div');
    editProfileLink.className = 'profile-edit-link';
    editProfileLink.style.display = 'flex';
    editProfileLink.style.alignItems = 'center';
    editProfileLink.style.justifyContent = 'center';
    editProfileLink.style.gap = '6px';
    editProfileLink.style.marginTop = '12px';
    editProfileLink.style.marginBottom = '16px';
    editProfileLink.style.color = 'var(--color-text-secondary, #888)';
    editProfileLink.style.cursor = 'pointer';
    editProfileLink.style.fontSize = '0.9rem';
    editProfileLink.innerHTML = '<span style="font-size: 1rem;">&#9998;</span> Edit Profile';
    editProfileLink.onclick = function() {
        showToast('Edit Profile coming soon', 'info');
    };
    body.appendChild(editProfileLink);

    // VTID-01171: Show active tenant if available
    if (state.authIdentity && state.authIdentity.identity && state.authIdentity.identity.tenant_id) {
        const tenantEl = document.createElement('div');
        tenantEl.className = 'profile-tenant';
        tenantEl.textContent = 'Tenant: ' + state.authIdentity.identity.tenant_id.substring(0, 8) + '...';
        tenantEl.style.color = 'var(--text-secondary, #666)';
        tenantEl.style.fontSize = '0.75rem';
        tenantEl.style.marginTop = '4px';
        body.appendChild(tenantEl);
    }

    // VTID-01014 + VTID-01171: Role Switcher
    // Populate from memberships if available, otherwise use default list
    var VIEW_ROLES = ['Community', 'Patient', 'Professional', 'Staff', 'Admin', 'Developer'];
    if (state.authIdentity && state.authIdentity.memberships && state.authIdentity.memberships.length > 0) {
        // Use roles from memberships
        VIEW_ROLES = state.authIdentity.memberships.map(function(m) {
            var role = m.role || 'user';
            return role.charAt(0).toUpperCase() + role.slice(1);
        });
        // Ensure uniqueness
        VIEW_ROLES = VIEW_ROLES.filter(function(r, i, arr) { return arr.indexOf(r) === i; });
        // Add Admin if exafy_admin and not already in list
        if (state.authIdentity.identity && state.authIdentity.identity.exafy_admin && VIEW_ROLES.indexOf('Admin') === -1) {
            VIEW_ROLES.unshift('Admin');
        }
    } else if (state.authIdentity && state.authIdentity.identity && state.authIdentity.identity.exafy_admin) {
        // exafy_admin with no memberships - show Admin
        VIEW_ROLES = ['Admin'];
    }

    // VTID-01196: Single dropdown for role selection (removed duplicate list)
    const roleSwitcher = document.createElement('div');
    roleSwitcher.className = 'profile-role-switcher';
    roleSwitcher.style.marginTop = '16px';

    const roleSelect = document.createElement('select');
    roleSelect.className = 'profile-role-select';
    roleSelect.id = 'profile-role-select';
    roleSelect.style.width = '100%';
    roleSelect.style.maxWidth = 'none';

    VIEW_ROLES.forEach(r => {
        const option = document.createElement('option');
        option.value = r;
        option.textContent = r;
        if (r === state.viewRole) option.selected = true;
        roleSelect.appendChild(option);
    });

    // VTID-01049: Wire dropdown to POST /api/v1/me/active-role
    roleSelect.onchange = async (e) => {
        const newRole = e.target.value;
        const previousRole = state.viewRole;

        // Optimistically update UI
        state.viewRole = newRole;
        renderApp();

        // Call API to persist role
        var result = await setActiveRole(newRole);
        if (result.ok) {
            // Success - update localStorage and show toast
            localStorage.setItem('vitana.viewRole', newRole);
            showToast('Role set to ' + newRole, 'success');
            // VTID-01186: Navigate to role-specific default screen
            state.showProfileModal = false;
            navigateToRoleDefaultScreen(newRole);
            renderApp();
        } else {
            // Failure - revert to previous role
            state.viewRole = previousRole;
            if (MeState.me) {
                MeState.me.active_role = previousRole.toLowerCase();
            }
            renderApp();
            showToast(result.error || 'Failed to change role', 'error');
        }
    };

    roleSwitcher.appendChild(roleSelect);
    body.appendChild(roleSwitcher);

    modal.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.display = 'flex';
    footer.style.flexDirection = 'column';
    footer.style.gap = '12px';

    // VTID-01186: Sign Out button (full-width, matching vitana-v1 design)
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn';
    logoutBtn.style.width = '100%';
    logoutBtn.style.padding = '12px 16px';
    logoutBtn.style.display = 'flex';
    logoutBtn.style.alignItems = 'center';
    logoutBtn.style.justifyContent = 'center';
    logoutBtn.style.gap = '8px';
    logoutBtn.style.backgroundColor = 'transparent';
    logoutBtn.style.border = '1px solid var(--color-border, #444)';
    logoutBtn.style.color = 'var(--color-text-primary, #fff)';
    logoutBtn.style.borderRadius = '6px';
    logoutBtn.style.cursor = 'pointer';
    logoutBtn.style.transition = 'all 0.15s';
    logoutBtn.innerHTML = '<span style="font-size: 1.1rem;">&#x2192;</span> Sign Out';
    logoutBtn.onmouseenter = function() {
        logoutBtn.style.backgroundColor = 'rgba(220, 53, 69, 0.1)';
        logoutBtn.style.borderColor = 'var(--danger-bg, #dc3545)';
        logoutBtn.style.color = 'var(--danger-bg, #dc3545)';
    };
    logoutBtn.onmouseleave = function() {
        logoutBtn.style.backgroundColor = 'transparent';
        logoutBtn.style.borderColor = 'var(--color-border, #444)';
        logoutBtn.style.color = 'var(--color-text-primary, #fff)';
    };
    logoutBtn.onclick = () => {
        doLogout();
    };
    footer.appendChild(logoutBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Cancel';
    closeBtn.style.width = '100%';
    closeBtn.style.padding = '10px 16px';
    closeBtn.onclick = () => {
        state.showProfileModal = false;
        renderApp();
    };
    footer.appendChild(closeBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);

    return overlay;
}

function renderTaskModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            // VTID-01003: Clear draft state when closing modal
            state.showTaskModal = false;
            state.modalDraftTitle = '';
            state.modalDraftStatus = 'Scheduled';
            state.modalDraftSpec = '';
            state.modalDraftEditing = false;
            // VTID-01010: Clear target roles state
            state.modalDraftTargetRoles = [];
            renderApp();
        }
    };

    const modal = document.createElement('div');
    modal.className = 'modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.textContent = 'Create New Task';
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';

    // VTID-01003: Title input with controlled state
    const titleGroup = document.createElement('div');
    titleGroup.className = 'form-group';
    const titleLabel = document.createElement('label');
    titleLabel.textContent = 'Task Title';
    titleGroup.appendChild(titleLabel);
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'form-control';
    titleInput.placeholder = 'Enter title';
    titleInput.value = state.modalDraftTitle;
    titleInput.onfocus = function() {
        state.modalDraftEditing = true;
    };
    titleInput.oninput = function(e) {
        state.modalDraftTitle = e.target.value;
        state.modalDraftEditing = true;
    };
    titleInput.onblur = function() {
        state.modalDraftEditing = false;
    };
    titleGroup.appendChild(titleInput);
    body.appendChild(titleGroup);

    // VTID-01012: VTID + Status in one row
    const vtidStatusRow = document.createElement('div');
    vtidStatusRow.className = 'form-row';

    // VTID-0542: VTID is now auto-generated via allocator, show read-only preview
    const vtidGroup = document.createElement('div');
    vtidGroup.className = 'form-group form-group-half';
    const vtidLabel = document.createElement('label');
    vtidLabel.textContent = 'VTID';
    vtidGroup.appendChild(vtidLabel);
    const vtidInput = document.createElement('input');
    vtidInput.type = 'text';
    vtidInput.className = 'form-control';
    vtidInput.placeholder = 'Auto-generated';
    vtidInput.readOnly = true;
    vtidInput.disabled = true;
    vtidGroup.appendChild(vtidInput);
    vtidStatusRow.appendChild(vtidGroup);

    // VTID-01003: Status select with controlled state
    const statusGroup = document.createElement('div');
    statusGroup.className = 'form-group form-group-half';
    const statusLabel = document.createElement('label');
    statusLabel.textContent = 'Status';
    statusGroup.appendChild(statusLabel);
    const statusSelect = document.createElement('select');
    statusSelect.className = 'form-control';
    statusSelect.innerHTML = '<option value="Scheduled">Scheduled</option><option value="In Progress">In Progress</option><option value="Completed">Completed</option>';
    statusSelect.value = state.modalDraftStatus;
    statusSelect.onchange = function(e) {
        state.modalDraftStatus = e.target.value;
    };
    statusGroup.appendChild(statusSelect);
    vtidStatusRow.appendChild(statusGroup);

    body.appendChild(vtidStatusRow);

    // VTID-01010: Target Role multi-select (required)
    const roleGroup = document.createElement('div');
    roleGroup.className = 'form-group';
    const roleLabel = document.createElement('label');
    roleLabel.textContent = 'Target Role (required)';
    roleGroup.appendChild(roleLabel);

    const roleContainer = document.createElement('div');
    roleContainer.className = 'target-role-selector';

    // Create checkbox for each role
    TARGET_ROLES.forEach(function(role) {
        const roleOption = document.createElement('label');
        roleOption.className = 'target-role-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = role;
        checkbox.checked = state.modalDraftTargetRoles.includes(role);
        checkbox.onchange = function(e) {
            if (e.target.checked) {
                // VTID-01010: INFRA is exclusive - clear others if INFRA selected
                if (role === 'INFRA') {
                    state.modalDraftTargetRoles = ['INFRA'];
                } else {
                    // Clear INFRA if another role is selected
                    state.modalDraftTargetRoles = state.modalDraftTargetRoles.filter(function(r) { return r !== 'INFRA'; });
                    if (!state.modalDraftTargetRoles.includes(role)) {
                        state.modalDraftTargetRoles.push(role);
                    }
                }
            } else {
                state.modalDraftTargetRoles = state.modalDraftTargetRoles.filter(function(r) { return r !== role; });
            }
            // Re-render to update checkbox states
            renderApp();
        };

        const labelText = document.createElement('span');
        labelText.className = 'target-role-label';
        labelText.textContent = role;
        labelText.title = TARGET_ROLE_LABELS[role] || role;

        roleOption.appendChild(checkbox);
        roleOption.appendChild(labelText);
        roleContainer.appendChild(roleOption);
    });

    roleGroup.appendChild(roleContainer);

    // Validation hint
    const roleHint = document.createElement('div');
    roleHint.className = 'form-note';
    if (state.modalDraftTargetRoles.length === 0) {
        roleHint.textContent = 'Select at least one target role';
        roleHint.classList.add('form-note-error');
    } else if (state.modalDraftTargetRoles.includes('INFRA')) {
        roleHint.textContent = 'INFRA: Backend/CICD/MCP/API with no UI scope';
    } else {
        roleHint.textContent = 'Selected: ' + state.modalDraftTargetRoles.join(', ');
    }
    roleGroup.appendChild(roleHint);
    body.appendChild(roleGroup);

    // VTID-01003: Task Spec textarea with controlled state (same pattern as drawer)
    const specGroup = document.createElement('div');
    specGroup.className = 'form-group';
    const specLabel = document.createElement('label');
    specLabel.textContent = 'Task Spec (editable)';
    specGroup.appendChild(specLabel);
    const specTextarea = document.createElement('textarea');
    specTextarea.className = 'form-control task-spec-modal-textarea';
    specTextarea.placeholder = 'Enter task specification here...';
    specTextarea.rows = 4;
    specTextarea.value = state.modalDraftSpec;
    specTextarea.onfocus = function() {
        state.modalDraftEditing = true;
    };
    specTextarea.oninput = function(e) {
        state.modalDraftSpec = e.target.value;
        state.modalDraftEditing = true;
    };
    specTextarea.onblur = function() {
        state.modalDraftEditing = false;
    };
    specGroup.appendChild(specTextarea);
    body.appendChild(specGroup);

    modal.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
        // VTID-01003: Clear draft state when canceling
        state.showTaskModal = false;
        state.modalDraftTitle = '';
        state.modalDraftStatus = 'Scheduled';
        state.modalDraftSpec = '';
        state.modalDraftEditing = false;
        // VTID-01010: Clear target roles state
        state.modalDraftTargetRoles = [];
        renderApp();
    };
    footer.appendChild(cancelBtn);

    const createBtn = document.createElement('button');
    createBtn.className = 'btn btn-primary';
    createBtn.textContent = 'Create';
    createBtn.onclick = async () => {
        // VTID-01003: Use controlled state values instead of DOM queries
        const title = state.modalDraftTitle.trim();
        const status = state.modalDraftStatus; // "Scheduled", "In Progress", "Completed"
        const spec = state.modalDraftSpec;
        // VTID-01010: Get target roles from state
        const targetRoles = state.modalDraftTargetRoles;

        // Basic validation
        if (!title) {
            alert('Title is required');
            return;
        }

        // VTID-01010: Target role validation (required)
        if (!targetRoles || targetRoles.length === 0) {
            alert('At least one target role is required');
            return;
        }

        // Map UI status to backend status
        let backendStatus = 'pending'; // Default
        if (status === 'In Progress') {
            backendStatus = 'in_progress';
        } else if (status === 'Completed') {
            backendStatus = 'complete';
        } else if (status === 'Scheduled') {
            backendStatus = 'pending';
        }

        try {
            // Disable button to prevent double-submit
            createBtn.disabled = true;
            createBtn.textContent = 'Allocating VTID...';

            // VTID-0542: Step 1 - Call the global allocator to get a VTID
            const allocResponse = await fetch('/api/v1/vtid/allocate', {
                method: 'POST',
                headers: withVitanaContextHeaders({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({
                    source: 'command-hub',
                    layer: 'DEV',
                    module: 'COMHU'
                })
            });

            if (!allocResponse.ok) {
                const errorData = await allocResponse.json();
                if (errorData.error === 'allocator_disabled') {
                    alert('VTID Allocator is not active yet. Contact administrator to enable VTID_ALLOCATOR_ENABLED.');
                } else {
                    alert(`Error allocating VTID: ${errorData.message || errorData.error || 'Unknown error'}`);
                }
                createBtn.disabled = false;
                createBtn.textContent = 'Create';
                return;
            }

            const allocResult = await allocResponse.json();
            if (!allocResult.ok || !allocResult.vtid) {
                alert('Failed to allocate VTID. Please try again.');
                createBtn.disabled = false;
                createBtn.textContent = 'Create';
                return;
            }

            const vtid = allocResult.vtid;
            console.log('[VTID-0542] Allocated VTID:', vtid, 'num:', allocResult.num);

            // VTID-01003: Update the VTID input to show allocated value (query from modal)
            var vtidDisplayInput = modal.querySelector('input[placeholder="Auto-generated"]');
            if (vtidDisplayInput) {
                vtidDisplayInput.value = vtid;
            }

            createBtn.textContent = 'Creating task...';

            // VTID-01010: Step 2 - Update the allocated task shell with title/status/target_roles
            const updatePayload = {
                title: title,
                status: backendStatus,
                // VTID-01010: Store target_roles in metadata
                metadata: {
                    target_roles: targetRoles
                }
            };

            const updateResponse = await fetch('/api/v1/oasis/tasks/' + encodeURIComponent(vtid), {
                method: 'PATCH',
                headers: withVitanaContextHeaders({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify(updatePayload)
            });

            if (!updateResponse.ok) {
                // Even if update fails, the task shell exists
                console.warn('[VTID-01010] Task update failed, but VTID allocated:', vtid);
            } else {
                console.log('[VTID-01010] Task updated with target_roles:', targetRoles.join(','));
            }

            // VTID-01010: Build TARGET_ROLE_CONTRACT line for spec
            const roleContract = 'TARGET_ROLE_CONTRACT: [' + targetRoles.join(',') + ']';

            // VTID-01003: Save the task spec to localStorage if provided
            // VTID-01010: Prepend TARGET_ROLE_CONTRACT to spec
            var fullSpec = roleContract + '\n\n' + (spec || '');
            saveTaskSpec(vtid, fullSpec);
            console.log('[VTID-01010] Task spec saved with TARGET_ROLE_CONTRACT for:', vtid);

            // Success! Close modal and refresh task list
            state.showTaskModal = false;
            // VTID-01003: Clear draft state after successful creation
            state.modalDraftTitle = '';
            state.modalDraftStatus = 'Scheduled';
            state.modalDraftSpec = '';
            state.modalDraftEditing = false;
            // VTID-01010: Clear target roles state
            state.modalDraftTargetRoles = [];
            fetchTasks(); // Refresh the task board
            renderApp();

            // Show success message with allocated VTID
            console.log('[VTID-0542] Task created successfully:', vtid);

        } catch (error) {
            console.error('Failed to create task:', error);
            alert(`Failed to create task: ${error.message}`);
            createBtn.disabled = false;
            createBtn.textContent = 'Create';
        }
    };
    footer.appendChild(createBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);

    return overlay;
}

// --- Logic ---

function handleModuleClick(sectionKey) {
    const section = NAVIGATION_CONFIG.find(s => s.section === sectionKey);
    if (!section) return;

    // VTID-01002: Capture scroll positions BEFORE changing route state
    captureAllScrollPositions();

    state.currentModuleKey = sectionKey;
    // Default to first tab
    const firstTab = section.tabs[0];
    state.currentTab = firstTab ? firstTab.key : '';

    // Update URL
    if (firstTab) {
        history.pushState(null, '', firstTab.path);
    } else {
        history.pushState(null, '', section.basePath);
    }

    state.isSplitScreen = false; // Reset split screen on module change
    state.activeSplitScreenId = null;
    // VTID-0406: Close drawers when navigating between modules
    state.selectedTask = null;
    state.selectedTaskDetail = null;
    state.selectedTaskDetailLoading = false;
    state.selectedGovernanceRule = null;
    renderApp();

    // VTID-01002: Restore scroll positions for new route from persistent storage
    restoreScrollPositionsForRoute(getScrollRouteKey());
}

function handleTabClick(tabKey) {
    const section = NAVIGATION_CONFIG.find(s => s.section === state.currentModuleKey);
    if (!section) return;

    const tab = section.tabs.find(t => t.key === tabKey);
    if (!tab) return;

    // VTID-01002: Capture scroll positions BEFORE changing route state
    captureAllScrollPositions();

    state.currentTab = tabKey;

    // Update URL
    history.pushState(null, '', tab.path);

    // VTID-01151: Force refresh approvals when navigating to Approvals tab
    if (tabKey === 'approvals') {
        state.approvals.fetched = false;
    }

    renderApp();

    // VTID-01002: Restore scroll positions for new route from persistent storage
    restoreScrollPositionsForRoute(getScrollRouteKey());
}

// Router Logic

function getRouteFromPath(pathname) {
    // DEV-COMHU-2025-0009: Normalize path - ensure trailing slash for consistent matching
    var normalizedPath = pathname;
    if (normalizedPath && !normalizedPath.endsWith('/')) {
        normalizedPath = normalizedPath + '/';
    }

    // 1. Try to find exact tab match (with normalized path)
    for (const section of NAVIGATION_CONFIG) {
        for (const tab of section.tabs) {
            if (normalizedPath === tab.path) {
                return { section: section.section, tab: tab.key };
            }
        }
    }

    // 2. Try to find section base path match
    for (const section of NAVIGATION_CONFIG) {
        if (normalizedPath === section.basePath) {
            // Default to first tab
            const firstTab = section.tabs[0];
            return { section: section.section, tab: firstTab ? firstTab.key : '' };
        }
    }

    // 3. Fallback
    return { section: 'command-hub', tab: 'tasks' };
}

function formatTabLabel(key) {
    if (!key) return '';
    // DEV-COMHU-2025-0010: Special case handling for VTID labels
    if (key === 'vtid-ledger') return 'VTID Ledger';
    if (key === 'vtids') return 'VTID´s';
    return key.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

window.onpopstate = () => {
    // VTID-01002: Capture scroll positions BEFORE changing route state
    captureAllScrollPositions();

    const route = getRouteFromPath(window.location.pathname);
    state.currentModuleKey = route.section;
    state.currentTab = route.tab;
    renderApp();

    // VTID-01002: Restore scroll positions for new route from persistent storage
    restoreScrollPositionsForRoute(getScrollRouteKey());
};

function handleSplitScreenToggle(comboId) {
    if (!comboId) {
        state.isSplitScreen = false;
        state.activeSplitScreenId = null;
        state.leftPane = null;
        state.rightPane = null;
    } else {
        const combo = splitScreenCombos.find(c => c.id === comboId);
        if (combo) {
            state.isSplitScreen = true;
            state.activeSplitScreenId = combo.id;
            state.leftPane = combo.left;
            state.rightPane = combo.right;
        }
    }
    renderApp();
}

/**
 * DEV-COMHU-2025-0011: Status → Column mapping for VTID Ledger data.
 * DEV-COMHU-2025-0012: Added local override support via localStorage.
 * Maps VTID status values to the 3-column board layout.
 */
function mapStatusToColumn(status) {
    var s = String(status || '').trim().toLowerCase();

    // Scheduled column: scheduled, pending, created, registered
    if (['scheduled', 'pending', 'created', 'registered'].includes(s)) return 'Scheduled';

    // In Progress column: in_progress, executing, running
    if (['in_progress', 'executing', 'running'].includes(s)) return 'In Progress';

    // Completed column: deployed, completed, success, failed, blocked, cancelled
    if (['deployed', 'completed', 'success', 'failed', 'blocked', 'cancelled'].includes(s)) return 'Completed';

    // Fallback: unknown status → Scheduled (status label remains visible on card)
    return 'Scheduled';
}

/**
 * DEV-COMHU-2025-0012: Get effective status for a task (check local overrides first).
 * Returns the local override if set, otherwise the API status.
 */
function getEffectiveStatus(vtid, apiStatus) {
    var localOverride = getTaskStatusOverride(vtid);
    if (localOverride) {
        return localOverride;
    }
    return apiStatus;
}

/**
 * VTID-01005: Map status to column with OASIS-derived column as authoritative source.
 * Priority: OASIS column > local override > status-based mapping
 * Used for column filtering in the task board.
 */
function mapStatusToColumnWithOverride(vtid, apiStatus, oasisColumn) {
    // VTID-01005: OASIS-derived column takes precedence (single source of truth)
    if (oasisColumn) {
        // Normalize OASIS column names to UI column names
        if (oasisColumn === 'COMPLETED') return 'Completed';
        if (oasisColumn === 'IN_PROGRESS') return 'In Progress';
        if (oasisColumn === 'SCHEDULED') return 'Scheduled';
    }
    // Fallback to local override or status-based mapping
    var effectiveStatus = getEffectiveStatus(vtid, apiStatus);
    return mapStatusToColumn(effectiveStatus);
}

/**
 * VTID-01005: Fetch tasks from OASIS-derived Command Hub Board API.
 * Uses /api/v1/commandhub/board which derives column placement from OASIS events.
 * OASIS is the SINGLE SOURCE OF TRUTH for task completion.
 */
async function fetchTasks() {
    state.tasksLoading = true;
    renderApp();

    try {
        // VTID-01079: Use OASIS-derived board endpoint
        // limit param only affects COMPLETED column (SCHEDULED/IN_PROGRESS are unlimited)
        var response = await fetch('/api/v1/commandhub/board?limit=50');
        if (!response.ok) throw new Error('Command Hub board fetch failed: ' + response.status);

        var json = await response.json();

        // Handle both array and wrapped response formats
        var items = [];
        var boardMeta = null;
        if (Array.isArray(json)) {
            items = json;
        } else if (json && Array.isArray(json.items)) {
            items = json.items;
            boardMeta = json.meta || null;
        } else if (json && Array.isArray(json.data)) {
            items = json.data;
        } else {
            console.warn('[VTID-01005] Unexpected response format:', json);
            items = [];
        }

        // VTID-01079: Store board metadata for "Load More" functionality
        state.boardMeta = boardMeta;

        // VTID-01055: Reconcile by VTID to eliminate ghost cards
        // Build a Map keyed by VTID (latest entry wins; overwrites duplicates)
        var byVtid = new Map();
        items.forEach(function(item) {
            if (!item.vtid) return; // Skip items without VTID
            var task = {
                id: item.vtid,
                title: item.title || item.vtid,
                // VTID-01005: Use OASIS-derived status and column
                status: item.status,
                vtid: item.vtid,
                // VTID-01005: Preserve OASIS-derived column for board placement
                oasisColumn: item.column,
                is_terminal: item.is_terminal,
                terminal_outcome: item.terminal_outcome,
                task_family: item.task_family,
                layer: item.layer,
                module: item.task_module,
                summary: item.description || '',
                createdAt: item.updated_at || item.created_at,
                // VTID-01055: Capture deleted/metadata for client-side filtering
                deleted_at: item.deleted_at,
                metadata: item.metadata
            };
            byVtid.set(item.vtid, task);
        });

        // VTID-01055: Rebuild state.tasks from deduplicated Map (deterministic reconciliation)
        // CRITICAL: This is the ONLY assignment to state.tasks - complete overwrite, no merge
        state.tasks = Array.from(byVtid.values());
        state.tasksError = null;

        // VTID-01055: Track which VTIDs came from API for ghost detection
        lastApiVtids = new Set(byVtid.keys());

        // VTID-01055: Count tasks per column for debug logging (manual refresh only)
        if (isManualRefresh) {
            var scheduled = 0, inProgress = 0, completed = 0;
            state.tasks.forEach(function(t) {
                var col = (t.oasisColumn || '').toUpperCase();
                if (col === 'COMPLETED') {
                    completed++;
                } else if (col === 'IN_PROGRESS') {
                    inProgress++;
                } else {
                    scheduled++;
                }
            });
            console.log('[VTID-01055] Board reconcile: total=' + state.tasks.length + ' scheduled=' + scheduled + ' in_progress=' + inProgress + ' completed=' + completed);

            isManualRefresh = false;
        }
    } catch (error) {
        console.error('[VTID-01005] Failed to fetch tasks from Command Hub board:', error);
        state.tasksError = error.message;
        // VTID-01030: Preserve last known good data on refresh failure
        // Do NOT wipe state.tasks - keep existing data visible
        console.warn('[VTID-01030] Keeping', state.tasks.length, 'cached tasks visible after fetch error');
    } finally {
        state.tasksLoading = false;
        renderApp();
    }
}

/**
 * VTID-0527: Fetch VTID detail with stageTimeline from API.
 * Called when a task card is clicked to load detailed stage timeline.
 */
async function fetchVtidDetail(vtid) {
    console.log('[VTID-0527] Fetching VTID detail:', vtid);
    state.selectedTaskDetailLoading = true;

    try {
        const response = await fetch('/api/v1/vtid/' + encodeURIComponent(vtid));
        if (!response.ok) {
            throw new Error('VTID detail fetch failed: ' + response.status);
        }

        const result = await response.json();
        console.log('[VTID-0527] VTID detail loaded:', result);

        if (result.ok && result.data) {
            state.selectedTaskDetail = result.data;
        }
    } catch (error) {
        console.error('[VTID-0527] Failed to fetch VTID detail:', error);
        // Continue without detail - not critical, fallback to client-side computation
    } finally {
        state.selectedTaskDetailLoading = false;
        renderApp();
    }
}

/**
 * VTID-01209: Fetch real-time execution status for a specific VTID.
 * Called by polling mechanism when viewing in-progress tasks.
 */
async function fetchExecutionStatus(vtid) {
    console.log('[VTID-01209] Fetching execution status:', vtid);

    try {
        const response = await fetch('/api/v1/vtid/' + encodeURIComponent(vtid) + '/execution-status');
        if (!response.ok) {
            throw new Error('Execution status fetch failed: ' + response.status);
        }

        const result = await response.json();
        console.log('[VTID-01209] Execution status loaded:', result);

        if (result.ok && result.data) {
            state.executionStatus = result.data;
            renderApp();
        }
    } catch (error) {
        console.error('[VTID-01209] Failed to fetch execution status:', error);
    }
}

/**
 * VTID-01209: Start polling for execution status of the selected task.
 * Only polls if task is in active status (in_progress, running, etc.)
 */
function startExecutionStatusPolling(vtid) {
    // Clear any existing polling
    stopExecutionStatusPolling();

    console.log('[VTID-01209] Starting execution status polling for:', vtid);

    // Initial fetch
    fetchExecutionStatus(vtid);

    // Poll every 5 seconds
    state.executionStatusPollInterval = setInterval(function() {
        // Stop polling if drawer is closed or different task selected
        if (!state.selectedTask || state.selectedTask.vtid !== vtid) {
            stopExecutionStatusPolling();
            return;
        }

        // Stop polling if task is no longer active
        if (state.executionStatus && !state.executionStatus.isActive) {
            console.log('[VTID-01209] Task no longer active, stopping polling');
            stopExecutionStatusPolling();
            return;
        }

        fetchExecutionStatus(vtid);
    }, 5000);
}

/**
 * VTID-01209: Stop polling for execution status.
 */
function stopExecutionStatusPolling() {
    if (state.executionStatusPollInterval) {
        console.log('[VTID-01209] Stopping execution status polling');
        clearInterval(state.executionStatusPollInterval);
        state.executionStatusPollInterval = null;
    }
}

/**
 * VTID-01209: Fetch active executions for ticker views.
 * Returns all in-progress tasks with their execution status.
 */
async function fetchActiveExecutions() {
    console.log('[VTID-01209] Fetching active executions');

    try {
        // First get in-progress tasks
        const tasksResponse = await fetch('/api/v1/commandhub/board?limit=50');
        if (!tasksResponse.ok) {
            throw new Error('Tasks fetch failed: ' + tasksResponse.status);
        }

        const tasksResult = await tasksResponse.json();
        if (!tasksResult.ok) return;

        // Filter to in-progress only
        const inProgressTasks = (tasksResult.data || []).filter(function(task) {
            var col = (task.oasisColumn || task.column || '').toUpperCase();
            return col === 'IN_PROGRESS';
        });

        if (inProgressTasks.length === 0) {
            state.activeExecutions = [];
            return;
        }

        // Fetch execution status for each in-progress task
        var activeExecutions = [];
        for (var i = 0; i < inProgressTasks.length; i++) {
            var task = inProgressTasks[i];
            try {
                var response = await fetch('/api/v1/vtid/' + encodeURIComponent(task.vtid) + '/execution-status');
                if (response.ok) {
                    var result = await response.json();
                    if (result.ok && result.data) {
                        activeExecutions.push(result.data);
                    }
                }
            } catch (e) {
                console.warn('[VTID-01209] Failed to fetch execution status for', task.vtid, e);
            }
        }

        state.activeExecutions = activeExecutions;
        console.log('[VTID-01209] Active executions loaded:', activeExecutions.length);
    } catch (error) {
        console.error('[VTID-01209] Failed to fetch active executions:', error);
    }
}

/**
 * VTID-01209: Start polling for active executions (for ticker views).
 */
function startActiveExecutionsPolling() {
    stopActiveExecutionsPolling();

    console.log('[VTID-01209] Starting active executions polling');

    // Initial fetch
    fetchActiveExecutions();

    // Poll every 10 seconds
    state.activeExecutionsPollInterval = setInterval(function() {
        fetchActiveExecutions();
    }, 10000);
}

/**
 * VTID-01209: Stop polling for active executions.
 */
function stopActiveExecutionsPolling() {
    if (state.activeExecutionsPollInterval) {
        console.log('[VTID-01209] Stopping active executions polling');
        clearInterval(state.activeExecutionsPollInterval);
        state.activeExecutionsPollInterval = null;
    }
}

async function fetchScreenInventory() {
    state.screenInventoryLoading = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/oasis/specs/dev-screen-inventory');
        if (!response.ok) throw new Error('Network response was not ok');

        const json = await response.json();
        if (json.ok && json.data) {
            state.screenInventory = json.data;
            state.screenInventoryError = null;
        } else {
            throw new Error(json.error || 'Failed to load screen inventory');
        }
    } catch (error) {
        console.error('Failed to fetch screen inventory:', error);
        state.screenInventoryError = error.message;
        state.screenInventory = null;
    } finally {
        state.screenInventoryLoading = false;
        renderApp();
    }
}

// --- Governance Rules (VTID-0401) ---

/**
 * VTID-0401: Fetches governance rules from the catalog API endpoint.
 * Populates state.governanceRules with the catalog data.
 */
async function fetchGovernanceRules() {
    state.governanceRulesLoading = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/governance/rules');
        if (!response.ok) throw new Error('Network response was not ok: ' + response.status);

        const json = await response.json();
        if (json.ok && json.data) {
            state.governanceRules = json.data;
            state.governanceRulesError = null;
            console.log('[VTID-0401] Governance rules loaded:', json.count, 'rules');
        } else {
            throw new Error(json.error || 'Failed to load governance rules');
        }
    } catch (error) {
        console.error('[VTID-0401] Failed to fetch governance rules:', error);
        state.governanceRulesError = error.message;
        state.governanceRules = [];
    } finally {
        state.governanceRulesLoading = false;
        renderApp();
    }
}

// --- Admin Dev Users (VTID-01172) ---

/**
 * VTID-01172: Fetches dev users (exafy_admin=true) from the dev-access API.
 * Optionally filters by email query.
 */
async function fetchAdminDevUsers() {
    state.adminDevUsersLoading = true;
    state.adminDevUsersError = null;
    renderApp();

    try {
        var query = state.adminDevUsersSearchQuery || '';
        var url = '/api/v1/dev-access/users';
        if (query.trim()) {
            url += '?query=' + encodeURIComponent(query.trim());
        }

        var response = await fetch(url, {
            method: 'GET',
            headers: buildContextHeaders()
        });

        var json = await response.json();

        if (!response.ok || !json.ok) {
            var errorMsg = json.error || json.message || 'Failed to fetch dev users';
            if (response.status === 401) {
                throw new Error('Unauthenticated - please log in');
            } else if (response.status === 403) {
                throw new Error('Access denied - requires exafy_admin');
            }
            throw new Error(errorMsg);
        }

        state.adminDevUsers = json.users || [];
        console.log('[VTID-01172] Dev users loaded:', state.adminDevUsers.length);
    } catch (error) {
        console.error('[VTID-01172] Failed to fetch dev users:', error);
        state.adminDevUsersError = error.message;
        state.adminDevUsers = [];
    } finally {
        state.adminDevUsersLoading = false;
        renderApp();
    }
}

/**
 * VTID-01172: Grants dev access (exafy_admin=true) to a user by email.
 */
async function grantDevAccess(email) {
    if (!email || !email.trim()) {
        showToast('Please enter an email address', 'error');
        return;
    }

    state.adminDevUsersGrantLoading = true;
    state.adminDevUsersGrantError = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/dev-access/grant', {
            method: 'POST',
            headers: buildContextHeaders(),
            body: JSON.stringify({ email: email.trim() })
        });

        var json = await response.json();

        if (!response.ok || !json.ok) {
            var errorMsg = json.error || json.message || 'Failed to grant dev access';
            if (response.status === 401) {
                throw new Error('Unauthenticated - please log in');
            } else if (response.status === 403) {
                throw new Error('Access denied - requires exafy_admin');
            } else if (response.status === 404) {
                throw new Error('User not found: ' + email);
            }
            throw new Error(errorMsg);
        }

        showToast('Dev access granted to ' + email, 'success');
        state.adminDevUsersGrantEmail = '';
        // Refresh user list
        await fetchAdminDevUsers();
    } catch (error) {
        console.error('[VTID-01172] Failed to grant dev access:', error);
        state.adminDevUsersGrantError = error.message;
        showToast(error.message, 'error');
    } finally {
        state.adminDevUsersGrantLoading = false;
        renderApp();
    }
}

/**
 * VTID-01172: Revokes dev access (exafy_admin=false) from a user by email.
 */
async function revokeDevAccess(email) {
    if (!email || !email.trim()) {
        showToast('Invalid email', 'error');
        return;
    }

    // Confirm revocation
    if (!confirm('Revoke dev access from ' + email + '?')) {
        return;
    }

    try {
        var response = await fetch('/api/v1/dev-access/revoke', {
            method: 'POST',
            headers: buildContextHeaders(),
            body: JSON.stringify({ email: email.trim() })
        });

        var json = await response.json();

        if (!response.ok || !json.ok) {
            var errorMsg = json.error || json.message || 'Failed to revoke dev access';
            if (response.status === 400 && json.error === 'SELF_REVOKE_FORBIDDEN') {
                throw new Error('Cannot revoke your own dev access');
            }
            throw new Error(errorMsg);
        }

        showToast('Dev access revoked from ' + email, 'success');
        // Refresh user list
        await fetchAdminDevUsers();
    } catch (error) {
        console.error('[VTID-01172] Failed to revoke dev access:', error);
        showToast(error.message, 'error');
    }
}

/**
 * VTID-01172: Renders the Admin > Users (Dev Access) view.
 */
function renderAdminDevUsersView() {
    var container = document.createElement('div');
    container.className = 'admin-dev-users-container';

    // Auto-fetch dev users if not loaded and not currently loading
    if (state.adminDevUsers.length === 0 && !state.adminDevUsersLoading && !state.adminDevUsersError) {
        fetchAdminDevUsers();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'admin-dev-users-header';
    header.innerHTML = '<h2>Dev Users</h2><p class="admin-dev-users-subtitle">Manage exafy_admin access for development and onboarding</p>';
    container.appendChild(header);

    // Toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'admin-dev-users-toolbar';

    // Search input
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search-field admin-dev-users-search';
    searchInput.placeholder = 'Search by email...';
    searchInput.value = state.adminDevUsersSearchQuery;
    searchInput.oninput = function(e) {
        state.adminDevUsersSearchQuery = e.target.value;
    };
    searchInput.onkeypress = function(e) {
        if (e.key === 'Enter') {
            fetchAdminDevUsers();
        }
    };
    toolbar.appendChild(searchInput);

    // Search button
    var searchBtn = document.createElement('button');
    searchBtn.className = 'btn btn-secondary';
    searchBtn.textContent = 'Search';
    searchBtn.onclick = function() {
        fetchAdminDevUsers();
    };
    toolbar.appendChild(searchBtn);

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // Grant access section
    var grantInput = document.createElement('input');
    grantInput.type = 'email';
    grantInput.className = 'form-control admin-dev-users-grant-input';
    grantInput.placeholder = 'Enter email to grant access...';
    grantInput.value = state.adminDevUsersGrantEmail;
    grantInput.oninput = function(e) {
        state.adminDevUsersGrantEmail = e.target.value;
    };
    grantInput.onkeypress = function(e) {
        if (e.key === 'Enter') {
            grantDevAccess(state.adminDevUsersGrantEmail);
        }
    };
    toolbar.appendChild(grantInput);

    var grantBtn = document.createElement('button');
    grantBtn.className = 'btn btn-primary';
    grantBtn.textContent = state.adminDevUsersGrantLoading ? 'Granting...' : 'Grant Dev Access';
    grantBtn.disabled = state.adminDevUsersGrantLoading;
    grantBtn.onclick = function() {
        grantDevAccess(state.adminDevUsersGrantEmail);
    };
    toolbar.appendChild(grantBtn);

    container.appendChild(toolbar);

    // User count
    var countLabel = document.createElement('div');
    countLabel.className = 'admin-dev-users-count';
    if (state.adminDevUsersLoading) {
        countLabel.textContent = 'Loading...';
    } else if (state.adminDevUsersError) {
        countLabel.textContent = 'Error: ' + state.adminDevUsersError;
        countLabel.className += ' error-text';
    } else {
        countLabel.textContent = state.adminDevUsers.length + ' dev user' + (state.adminDevUsers.length !== 1 ? 's' : '');
    }
    container.appendChild(countLabel);

    // Content area
    var content = document.createElement('div');
    content.className = 'admin-dev-users-content';

    if (state.adminDevUsersLoading) {
        content.innerHTML = '<div class="admin-dev-users-loading">Loading dev users...</div>';
    } else if (state.adminDevUsersError) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'admin-dev-users-error';
        errorDiv.textContent = state.adminDevUsersError;

        var retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-secondary';
        retryBtn.textContent = 'Retry';
        retryBtn.onclick = function() {
            state.adminDevUsersError = null;
            fetchAdminDevUsers();
        };
        errorDiv.appendChild(document.createElement('br'));
        errorDiv.appendChild(retryBtn);
        content.appendChild(errorDiv);
    } else if (state.adminDevUsers.length === 0) {
        content.innerHTML = '<div class="admin-dev-users-empty">No dev users found. Grant access to a user above.</div>';
    } else {
        // Render user table
        var table = document.createElement('table');
        table.className = 'admin-dev-users-table';

        // Header
        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        ['Email', 'User ID', 'Status', 'Updated', 'Actions'].forEach(function(h) {
            var th = document.createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        var tbody = document.createElement('tbody');
        state.adminDevUsers.forEach(function(user) {
            var row = document.createElement('tr');

            // Email
            var emailCell = document.createElement('td');
            emailCell.className = 'admin-dev-users-email';
            emailCell.textContent = user.email || '-';
            row.appendChild(emailCell);

            // User ID
            var idCell = document.createElement('td');
            idCell.className = 'admin-dev-users-id';
            idCell.textContent = user.user_id ? user.user_id.substring(0, 8) + '...' : '-';
            idCell.title = user.user_id || '';
            row.appendChild(idCell);

            // Status
            var statusCell = document.createElement('td');
            var statusBadge = document.createElement('span');
            statusBadge.className = 'admin-dev-users-status-badge status-active';
            statusBadge.textContent = 'exafy_admin';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // Updated
            var updatedCell = document.createElement('td');
            updatedCell.className = 'admin-dev-users-updated';
            if (user.updated_at) {
                var date = new Date(user.updated_at);
                updatedCell.textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
            } else {
                updatedCell.textContent = '-';
            }
            row.appendChild(updatedCell);

            // Actions
            var actionsCell = document.createElement('td');
            var revokeBtn = document.createElement('button');
            revokeBtn.className = 'btn btn-danger btn-sm';
            revokeBtn.textContent = 'Revoke';
            revokeBtn.onclick = function() {
                revokeDevAccess(user.email);
            };
            actionsCell.appendChild(revokeBtn);
            row.appendChild(actionsCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        content.appendChild(table);
    }

    container.appendChild(content);

    return container;
}

// ===========================================================================
// VTID-01195: Command Hub Admin Screens v1
// ===========================================================================

/**
 * VTID-01195: Placeholder user data for Admin Users screen
 * This is static mock data - data source not wired in v1
 */
var adminUsersMockData = [
    { id: '1', email: 'admin@vitana.io', role: 'Admin', tenant: 'Vitana Core', status: 'Active' },
    { id: '2', email: 'dev@vitana.io', role: 'Developer', tenant: 'Vitana Core', status: 'Active' },
    { id: '3', email: 'user@tenant1.com', role: 'User', tenant: 'Tenant Alpha', status: 'Active' },
    { id: '4', email: 'support@vitana.io', role: 'Support', tenant: 'Vitana Core', status: 'Inactive' }
];

/**
 * VTID-01195: Admin Users View - Split layout with user list + detail panel
 * v1 skeleton - data source not wired
 */
function renderAdminUsersView() {
    var container = document.createElement('div');
    container.className = 'admin-screen-container admin-users-container';

    // Header
    var header = document.createElement('div');
    header.className = 'admin-screen-header';
    header.innerHTML = '<h2>Users</h2><p class="admin-screen-subtitle">Manage user accounts, roles, and tenant assignments</p>';
    container.appendChild(header);

    // Not-wired banner
    var banner = document.createElement('div');
    banner.className = 'admin-not-wired-banner';
    banner.innerHTML = '<span class="admin-not-wired-icon">&#9888;</span> Data source not connected yet — showing placeholder data';
    container.appendChild(banner);

    // Split layout
    var splitLayout = document.createElement('div');
    splitLayout.className = 'admin-split-layout';

    // Left panel: search + list
    var leftPanel = document.createElement('div');
    leftPanel.className = 'admin-split-left';

    // Search input
    var searchWrapper = document.createElement('div');
    searchWrapper.className = 'admin-search-wrapper';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search-field admin-search-input';
    searchInput.placeholder = 'Search by email...';
    searchInput.value = state.adminUsersSearchQuery;
    searchInput.oninput = function(e) {
        state.adminUsersSearchQuery = e.target.value;
        renderApp();
    };
    searchWrapper.appendChild(searchInput);
    leftPanel.appendChild(searchWrapper);

    // User list table
    var listContainer = document.createElement('div');
    listContainer.className = 'admin-list-container';

    var table = document.createElement('table');
    table.className = 'admin-list-table';

    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Email</th><th>Role</th><th>Tenant</th><th>Status</th></tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var filteredUsers = adminUsersMockData.filter(function(u) {
        if (!state.adminUsersSearchQuery) return true;
        return u.email.toLowerCase().includes(state.adminUsersSearchQuery.toLowerCase());
    });

    filteredUsers.forEach(function(user) {
        var row = document.createElement('tr');
        row.className = 'admin-list-row clickable-row';
        if (state.adminUsersSelectedId === user.id) {
            row.classList.add('selected');
        }
        row.onclick = function() {
            state.adminUsersSelectedId = user.id;
            renderApp();
        };

        row.innerHTML = '<td class="admin-cell-email">' + user.email + '</td>' +
            '<td><span class="admin-role-badge admin-role-' + user.role.toLowerCase() + '">' + user.role + '</span></td>' +
            '<td>' + user.tenant + '</td>' +
            '<td><span class="admin-status-badge admin-status-' + user.status.toLowerCase() + '">' + user.status + '</span></td>';

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    listContainer.appendChild(table);
    leftPanel.appendChild(listContainer);
    splitLayout.appendChild(leftPanel);

    // Right panel: detail view
    var rightPanel = document.createElement('div');
    rightPanel.className = 'admin-split-right';

    if (state.adminUsersSelectedId) {
        var selectedUser = adminUsersMockData.find(function(u) { return u.id === state.adminUsersSelectedId; });
        if (selectedUser) {
            rightPanel.innerHTML = '<div class="admin-detail-panel">' +
                '<div class="admin-detail-header">' +
                '<h3>' + selectedUser.email + '</h3>' +
                '<button class="admin-detail-close-btn" onclick="state.adminUsersSelectedId = null; renderApp();">&times;</button>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>User Summary</h4>' +
                '<div class="admin-detail-grid">' +
                '<div class="admin-detail-field"><span class="admin-detail-label">User ID:</span><span class="admin-detail-value">' + selectedUser.id + '</span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Email:</span><span class="admin-detail-value">' + selectedUser.email + '</span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Status:</span><span class="admin-status-badge admin-status-' + selectedUser.status.toLowerCase() + '">' + selectedUser.status + '</span></div>' +
                '</div>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Role & Access</h4>' +
                '<div class="admin-badges-row"><span class="admin-role-badge admin-role-' + selectedUser.role.toLowerCase() + '">' + selectedUser.role + '</span></div>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Tenant Assignment</h4>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Primary Tenant:</span><span class="admin-detail-value">' + selectedUser.tenant + '</span></div>' +
                '</div>' +
                '<div class="admin-detail-actions">' +
                '<button class="btn btn-secondary" disabled>Edit User</button>' +
                '<button class="btn btn-danger" disabled>Deactivate</button>' +
                '</div>' +
                '</div>';
        }
    } else {
        rightPanel.innerHTML = '<div class="admin-detail-empty"><span class="admin-detail-empty-icon">&#128100;</span><p>Select a user from the list to view details</p></div>';
    }
    splitLayout.appendChild(rightPanel);
    container.appendChild(splitLayout);

    return container;
}

/**
 * VTID-01195: Placeholder permission data for Admin Permissions screen
 */
var adminPermissionsMockData = [
    { key: 'admin.users.read', description: 'Read user accounts', scope: 'Global' },
    { key: 'admin.users.write', description: 'Create and edit user accounts', scope: 'Global' },
    { key: 'admin.tenants.manage', description: 'Manage tenant settings', scope: 'Tenant' },
    { key: 'tasks.create', description: 'Create new tasks', scope: 'Tenant' },
    { key: 'tasks.approve', description: 'Approve task execution', scope: 'Tenant' },
    { key: 'governance.rules.edit', description: 'Edit governance rules', scope: 'Global' }
];

/**
 * VTID-01195: Admin Permissions View - Permission keys + scope
 */
function renderAdminPermissionsView() {
    var container = document.createElement('div');
    container.className = 'admin-screen-container admin-permissions-container';

    // Header
    var header = document.createElement('div');
    header.className = 'admin-screen-header';
    header.innerHTML = '<h2>Permissions</h2><p class="admin-screen-subtitle">View and manage permission keys and their scopes</p>';
    container.appendChild(header);

    // Not-wired banner
    var banner = document.createElement('div');
    banner.className = 'admin-not-wired-banner';
    banner.innerHTML = '<span class="admin-not-wired-icon">&#9888;</span> Data source not connected yet — showing placeholder data';
    container.appendChild(banner);

    // Split layout
    var splitLayout = document.createElement('div');
    splitLayout.className = 'admin-split-layout';

    // Left panel
    var leftPanel = document.createElement('div');
    leftPanel.className = 'admin-split-left';

    // Search
    var searchWrapper = document.createElement('div');
    searchWrapper.className = 'admin-search-wrapper';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search-field admin-search-input';
    searchInput.placeholder = 'Search permission key...';
    searchInput.value = state.adminPermissionsSearchQuery;
    searchInput.oninput = function(e) {
        state.adminPermissionsSearchQuery = e.target.value;
        renderApp();
    };
    searchWrapper.appendChild(searchInput);
    leftPanel.appendChild(searchWrapper);

    // Permissions list
    var listContainer = document.createElement('div');
    listContainer.className = 'admin-list-container';

    var table = document.createElement('table');
    table.className = 'admin-list-table';

    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Key</th><th>Description</th><th>Scope</th></tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var filteredPerms = adminPermissionsMockData.filter(function(p) {
        if (!state.adminPermissionsSearchQuery) return true;
        return p.key.toLowerCase().includes(state.adminPermissionsSearchQuery.toLowerCase()) ||
               p.description.toLowerCase().includes(state.adminPermissionsSearchQuery.toLowerCase());
    });

    filteredPerms.forEach(function(perm) {
        var row = document.createElement('tr');
        row.className = 'admin-list-row clickable-row';
        if (state.adminPermissionsSelectedKey === perm.key) {
            row.classList.add('selected');
        }
        row.onclick = function() {
            state.adminPermissionsSelectedKey = perm.key;
            renderApp();
        };

        row.innerHTML = '<td class="admin-cell-key"><code>' + perm.key + '</code></td>' +
            '<td>' + perm.description + '</td>' +
            '<td><span class="admin-scope-badge admin-scope-' + perm.scope.toLowerCase() + '">' + perm.scope + '</span></td>';

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    listContainer.appendChild(table);
    leftPanel.appendChild(listContainer);
    splitLayout.appendChild(leftPanel);

    // Right panel
    var rightPanel = document.createElement('div');
    rightPanel.className = 'admin-split-right';

    if (state.adminPermissionsSelectedKey) {
        var selectedPerm = adminPermissionsMockData.find(function(p) { return p.key === state.adminPermissionsSelectedKey; });
        if (selectedPerm) {
            rightPanel.innerHTML = '<div class="admin-detail-panel">' +
                '<div class="admin-detail-header">' +
                '<h3><code>' + selectedPerm.key + '</code></h3>' +
                '<button class="admin-detail-close-btn" onclick="state.adminPermissionsSelectedKey = null; renderApp();">&times;</button>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Permission Details</h4>' +
                '<div class="admin-detail-grid">' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Key:</span><span class="admin-detail-value"><code>' + selectedPerm.key + '</code></span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Description:</span><span class="admin-detail-value">' + selectedPerm.description + '</span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Scope:</span><span class="admin-scope-badge admin-scope-' + selectedPerm.scope.toLowerCase() + '">' + selectedPerm.scope + '</span></div>' +
                '</div>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Roles with this Permission</h4>' +
                '<div class="admin-placeholder-list">' +
                '<div class="admin-placeholder-item"><span class="admin-role-badge admin-role-admin">Admin</span></div>' +
                '<div class="admin-placeholder-item"><span class="admin-role-badge admin-role-developer">Developer</span></div>' +
                '</div>' +
                '<p class="admin-detail-note">Role assignments are placeholder data</p>' +
                '</div>' +
                '</div>';
        }
    } else {
        rightPanel.innerHTML = '<div class="admin-detail-empty"><span class="admin-detail-empty-icon">&#128273;</span><p>Select a permission from the list to view details</p></div>';
    }
    splitLayout.appendChild(rightPanel);
    container.appendChild(splitLayout);

    return container;
}

/**
 * VTID-01195: Placeholder tenant data for Admin Tenants screen
 */
var adminTenantsMockData = [
    { id: 't1', name: 'Vitana Core', plan: 'Enterprise', status: 'Active' },
    { id: 't2', name: 'Tenant Alpha', plan: 'Professional', status: 'Active' },
    { id: 't3', name: 'Tenant Beta', plan: 'Starter', status: 'Trial' },
    { id: 't4', name: 'Demo Tenant', plan: 'Free', status: 'Inactive' }
];

/**
 * VTID-01195: Admin Tenants View - Tenant list + plan/limits
 */
function renderAdminTenantsView() {
    var container = document.createElement('div');
    container.className = 'admin-screen-container admin-tenants-container';

    // Header
    var header = document.createElement('div');
    header.className = 'admin-screen-header';
    header.innerHTML = '<h2>Tenants</h2><p class="admin-screen-subtitle">View and manage tenant organizations and their plans</p>';
    container.appendChild(header);

    // Not-wired banner
    var banner = document.createElement('div');
    banner.className = 'admin-not-wired-banner';
    banner.innerHTML = '<span class="admin-not-wired-icon">&#9888;</span> Data source not connected yet — showing placeholder data';
    container.appendChild(banner);

    // Split layout
    var splitLayout = document.createElement('div');
    splitLayout.className = 'admin-split-layout';

    // Left panel
    var leftPanel = document.createElement('div');
    leftPanel.className = 'admin-split-left';

    // Search
    var searchWrapper = document.createElement('div');
    searchWrapper.className = 'admin-search-wrapper';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search-field admin-search-input';
    searchInput.placeholder = 'Search tenant...';
    searchInput.value = state.adminTenantsSearchQuery;
    searchInput.oninput = function(e) {
        state.adminTenantsSearchQuery = e.target.value;
        renderApp();
    };
    searchWrapper.appendChild(searchInput);
    leftPanel.appendChild(searchWrapper);

    // Tenants list
    var listContainer = document.createElement('div');
    listContainer.className = 'admin-list-container';

    var table = document.createElement('table');
    table.className = 'admin-list-table';

    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Tenant</th><th>Plan</th><th>Status</th></tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var filteredTenants = adminTenantsMockData.filter(function(t) {
        if (!state.adminTenantsSearchQuery) return true;
        return t.name.toLowerCase().includes(state.adminTenantsSearchQuery.toLowerCase());
    });

    filteredTenants.forEach(function(tenant) {
        var row = document.createElement('tr');
        row.className = 'admin-list-row clickable-row';
        if (state.adminTenantsSelectedId === tenant.id) {
            row.classList.add('selected');
        }
        row.onclick = function() {
            state.adminTenantsSelectedId = tenant.id;
            renderApp();
        };

        row.innerHTML = '<td class="admin-cell-tenant">' + tenant.name + '</td>' +
            '<td><span class="admin-plan-badge admin-plan-' + tenant.plan.toLowerCase() + '">' + tenant.plan + '</span></td>' +
            '<td><span class="admin-status-badge admin-status-' + tenant.status.toLowerCase() + '">' + tenant.status + '</span></td>';

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    listContainer.appendChild(table);
    leftPanel.appendChild(listContainer);
    splitLayout.appendChild(leftPanel);

    // Right panel
    var rightPanel = document.createElement('div');
    rightPanel.className = 'admin-split-right';

    if (state.adminTenantsSelectedId) {
        var selectedTenant = adminTenantsMockData.find(function(t) { return t.id === state.adminTenantsSelectedId; });
        if (selectedTenant) {
            rightPanel.innerHTML = '<div class="admin-detail-panel">' +
                '<div class="admin-detail-header">' +
                '<h3>' + selectedTenant.name + '</h3>' +
                '<button class="admin-detail-close-btn" onclick="state.adminTenantsSelectedId = null; renderApp();">&times;</button>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Tenant Details</h4>' +
                '<div class="admin-detail-grid">' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Tenant ID:</span><span class="admin-detail-value">' + selectedTenant.id + '</span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Name:</span><span class="admin-detail-value">' + selectedTenant.name + '</span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Plan:</span><span class="admin-plan-badge admin-plan-' + selectedTenant.plan.toLowerCase() + '">' + selectedTenant.plan + '</span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Status:</span><span class="admin-status-badge admin-status-' + selectedTenant.status.toLowerCase() + '">' + selectedTenant.status + '</span></div>' +
                '</div>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Limits & Quotas</h4>' +
                '<div class="admin-limits-grid">' +
                '<div class="admin-limit-item"><span class="admin-limit-label">Users</span><span class="admin-limit-value">—</span></div>' +
                '<div class="admin-limit-item"><span class="admin-limit-label">Storage</span><span class="admin-limit-value">—</span></div>' +
                '<div class="admin-limit-item"><span class="admin-limit-label">API Calls/mo</span><span class="admin-limit-value">—</span></div>' +
                '<div class="admin-limit-item"><span class="admin-limit-label">Tasks/day</span><span class="admin-limit-value">—</span></div>' +
                '</div>' +
                '<p class="admin-detail-note">Limits data not available yet</p>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Feature Flags</h4>' +
                '<div class="admin-flags-list">' +
                '<div class="admin-flag-item"><span class="admin-flag-name">advanced_analytics</span><span class="admin-flag-value admin-flag-unknown">—</span></div>' +
                '<div class="admin-flag-item"><span class="admin-flag-name">custom_workflows</span><span class="admin-flag-value admin-flag-unknown">—</span></div>' +
                '<div class="admin-flag-item"><span class="admin-flag-name">api_access</span><span class="admin-flag-value admin-flag-unknown">—</span></div>' +
                '</div>' +
                '<p class="admin-detail-note">Feature flags data not available yet</p>' +
                '</div>' +
                '</div>';
        }
    } else {
        rightPanel.innerHTML = '<div class="admin-detail-empty"><span class="admin-detail-empty-icon">&#127970;</span><p>Select a tenant from the list to view details</p></div>';
    }
    splitLayout.appendChild(rightPanel);
    container.appendChild(splitLayout);

    return container;
}

/**
 * VTID-01195: Placeholder moderation report data
 */
var adminModerationMockData = [
    { id: 'r1', type: 'Spam', status: 'Pending', reporter: 'user@example.com', reportedAt: '2025-01-15T10:30:00Z' },
    { id: 'r2', type: 'Abuse', status: 'Pending', reporter: 'admin@vitana.io', reportedAt: '2025-01-14T15:45:00Z' },
    { id: 'r3', type: 'Inappropriate', status: 'Reviewed', reporter: 'support@vitana.io', reportedAt: '2025-01-13T09:00:00Z' },
    { id: 'r4', type: 'Other', status: 'Resolved', reporter: 'user2@example.com', reportedAt: '2025-01-12T14:20:00Z' }
];

/**
 * VTID-01195: Admin Content Moderation View - Report queue + actions
 */
function renderAdminContentModerationView() {
    var container = document.createElement('div');
    container.className = 'admin-screen-container admin-moderation-container';

    // Header
    var header = document.createElement('div');
    header.className = 'admin-screen-header';
    header.innerHTML = '<h2>Content Moderation</h2><p class="admin-screen-subtitle">Review and manage content moderation reports</p>';
    container.appendChild(header);

    // Not-wired banner
    var banner = document.createElement('div');
    banner.className = 'admin-not-wired-banner';
    banner.innerHTML = '<span class="admin-not-wired-icon">&#9888;</span> Data source not connected yet — showing placeholder data';
    container.appendChild(banner);

    // Filters row
    var filtersRow = document.createElement('div');
    filtersRow.className = 'admin-filters-row';

    // Type filter
    var typeFilter = document.createElement('select');
    typeFilter.className = 'admin-filter-select';
    typeFilter.innerHTML = '<option value="">All Types</option><option value="Spam">Spam</option><option value="Abuse">Abuse</option><option value="Inappropriate">Inappropriate</option><option value="Other">Other</option>';
    typeFilter.value = state.adminModerationTypeFilter;
    typeFilter.onchange = function(e) {
        state.adminModerationTypeFilter = e.target.value;
        renderApp();
    };
    filtersRow.appendChild(typeFilter);

    // Status filter
    var statusFilter = document.createElement('select');
    statusFilter.className = 'admin-filter-select';
    statusFilter.innerHTML = '<option value="">All Statuses</option><option value="Pending">Pending</option><option value="Reviewed">Reviewed</option><option value="Resolved">Resolved</option>';
    statusFilter.value = state.adminModerationStatusFilter;
    statusFilter.onchange = function(e) {
        state.adminModerationStatusFilter = e.target.value;
        renderApp();
    };
    filtersRow.appendChild(statusFilter);

    container.appendChild(filtersRow);

    // Split layout
    var splitLayout = document.createElement('div');
    splitLayout.className = 'admin-split-layout';

    // Left panel - report list
    var leftPanel = document.createElement('div');
    leftPanel.className = 'admin-split-left';

    var listContainer = document.createElement('div');
    listContainer.className = 'admin-list-container admin-moderation-list';

    var filteredReports = adminModerationMockData.filter(function(r) {
        if (state.adminModerationTypeFilter && r.type !== state.adminModerationTypeFilter) return false;
        if (state.adminModerationStatusFilter && r.status !== state.adminModerationStatusFilter) return false;
        return true;
    });

    filteredReports.forEach(function(report) {
        var card = document.createElement('div');
        card.className = 'admin-report-card clickable-row';
        if (state.adminModerationSelectedId === report.id) {
            card.classList.add('selected');
        }
        card.onclick = function() {
            state.adminModerationSelectedId = report.id;
            renderApp();
        };

        var reportDate = new Date(report.reportedAt);
        card.innerHTML = '<div class="admin-report-card-header">' +
            '<span class="admin-type-badge admin-type-' + report.type.toLowerCase() + '">' + report.type + '</span>' +
            '<span class="admin-status-badge admin-status-' + report.status.toLowerCase() + '">' + report.status + '</span>' +
            '</div>' +
            '<div class="admin-report-card-body">' +
            '<div class="admin-report-meta">Report #' + report.id + '</div>' +
            '<div class="admin-report-meta">By: ' + report.reporter + '</div>' +
            '<div class="admin-report-meta">' + reportDate.toLocaleDateString() + '</div>' +
            '</div>';

        listContainer.appendChild(card);
    });

    if (filteredReports.length === 0) {
        listContainer.innerHTML = '<div class="admin-empty-list">No reports match the selected filters</div>';
    }

    leftPanel.appendChild(listContainer);
    splitLayout.appendChild(leftPanel);

    // Right panel - report detail
    var rightPanel = document.createElement('div');
    rightPanel.className = 'admin-split-right';

    if (state.adminModerationSelectedId) {
        var selectedReport = adminModerationMockData.find(function(r) { return r.id === state.adminModerationSelectedId; });
        if (selectedReport) {
            var reportDate = new Date(selectedReport.reportedAt);
            rightPanel.innerHTML = '<div class="admin-detail-panel">' +
                '<div class="admin-detail-header">' +
                '<h3>Report #' + selectedReport.id + '</h3>' +
                '<button class="admin-detail-close-btn" onclick="state.adminModerationSelectedId = null; renderApp();">&times;</button>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Report Details</h4>' +
                '<div class="admin-detail-grid">' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Type:</span><span class="admin-type-badge admin-type-' + selectedReport.type.toLowerCase() + '">' + selectedReport.type + '</span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Status:</span><span class="admin-status-badge admin-status-' + selectedReport.status.toLowerCase() + '">' + selectedReport.status + '</span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Reporter:</span><span class="admin-detail-value">' + selectedReport.reporter + '</span></div>' +
                '<div class="admin-detail-field"><span class="admin-detail-label">Reported At:</span><span class="admin-detail-value">' + reportDate.toLocaleString() + '</span></div>' +
                '</div>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Content</h4>' +
                '<div class="admin-content-preview">' +
                '<p class="admin-placeholder-text">Content preview not available — data source not wired</p>' +
                '</div>' +
                '</div>' +
                '<div class="admin-detail-section">' +
                '<h4>Moderation Notes</h4>' +
                '<textarea class="admin-notes-textarea" placeholder="Add moderation notes..." disabled></textarea>' +
                '</div>' +
                '<div class="admin-detail-actions">' +
                '<button class="btn btn-primary" disabled>Approve</button>' +
                '<button class="btn btn-danger" disabled>Remove Content</button>' +
                '<button class="btn btn-secondary" disabled>Dismiss Report</button>' +
                '</div>' +
                '</div>';
        }
    } else {
        rightPanel.innerHTML = '<div class="admin-detail-empty"><span class="admin-detail-empty-icon">&#128221;</span><p>Select a report from the list to view details</p></div>';
    }
    splitLayout.appendChild(rightPanel);
    container.appendChild(splitLayout);

    return container;
}

/**
 * VTID-01195: Admin Identity Access View - Auth status + role switching + access logs
 */
function renderAdminIdentityAccessView() {
    var container = document.createElement('div');
    container.className = 'admin-screen-container admin-identity-container';

    // Header
    var header = document.createElement('div');
    header.className = 'admin-screen-header';
    header.innerHTML = '<h2>Identity & Access</h2><p class="admin-screen-subtitle">Authentication status, role switching rules, and access audit logs</p>';
    container.appendChild(header);

    // Not-wired banner
    var banner = document.createElement('div');
    banner.className = 'admin-not-wired-banner';
    banner.innerHTML = '<span class="admin-not-wired-icon">&#9888;</span> Data source not connected yet — showing placeholder data';
    container.appendChild(banner);

    // Panels container
    var panelsContainer = document.createElement('div');
    panelsContainer.className = 'admin-panels-container';

    // Authentication Status Panel
    var authPanel = document.createElement('div');
    authPanel.className = 'admin-panel';
    authPanel.innerHTML = '<div class="admin-panel-header">' +
        '<h3>Authentication Status</h3>' +
        '</div>' +
        '<div class="admin-panel-body">' +
        '<div class="admin-auth-status">' +
        '<div class="admin-auth-item">' +
        '<span class="admin-auth-label">Auth Provider:</span>' +
        '<span class="admin-auth-value">Supabase</span>' +
        '</div>' +
        '<div class="admin-auth-item">' +
        '<span class="admin-auth-label">Session Status:</span>' +
        '<span class="admin-auth-value admin-auth-status-active">Active</span>' +
        '</div>' +
        '<div class="admin-auth-item">' +
        '<span class="admin-auth-label">MFA Enabled:</span>' +
        '<span class="admin-auth-value">—</span>' +
        '</div>' +
        '<div class="admin-auth-item">' +
        '<span class="admin-auth-label">Last Login:</span>' +
        '<span class="admin-auth-value">—</span>' +
        '</div>' +
        '<div class="admin-auth-item">' +
        '<span class="admin-auth-label">Session Expiry:</span>' +
        '<span class="admin-auth-value">—</span>' +
        '</div>' +
        '</div>' +
        '<p class="admin-detail-note">Session details will be populated when auth is fully wired</p>' +
        '</div>';
    panelsContainer.appendChild(authPanel);

    // Role Switching Rules Panel
    var rolePanel = document.createElement('div');
    rolePanel.className = 'admin-panel';
    rolePanel.innerHTML = '<div class="admin-panel-header">' +
        '<h3>Role Switching Rules</h3>' +
        '</div>' +
        '<div class="admin-panel-body">' +
        '<div class="admin-rules-list">' +
        '<div class="admin-rule-item">' +
        '<span class="admin-rule-icon">&#10003;</span>' +
        '<span class="admin-rule-text">Users can switch between their assigned roles</span>' +
        '</div>' +
        '<div class="admin-rule-item">' +
        '<span class="admin-rule-icon">&#10003;</span>' +
        '<span class="admin-rule-text">Role changes are logged to the audit trail</span>' +
        '</div>' +
        '<div class="admin-rule-item">' +
        '<span class="admin-rule-icon">&#10003;</span>' +
        '<span class="admin-rule-text">Admin role requires elevated permissions</span>' +
        '</div>' +
        '<div class="admin-rule-item">' +
        '<span class="admin-rule-icon">&#10003;</span>' +
        '<span class="admin-rule-text">Developer role grants access to Command Hub</span>' +
        '</div>' +
        '<div class="admin-rule-item">' +
        '<span class="admin-rule-icon">&#10003;</span>' +
        '<span class="admin-rule-text">Role context persists across sessions (localStorage)</span>' +
        '</div>' +
        '</div>' +
        '</div>';
    panelsContainer.appendChild(rolePanel);

    // Access Logs Panel
    var logsPanel = document.createElement('div');
    logsPanel.className = 'admin-panel admin-panel-full';
    logsPanel.innerHTML = '<div class="admin-panel-header">' +
        '<h3>Access Logs</h3>' +
        '<button class="btn btn-secondary btn-sm" disabled>Export</button>' +
        '</div>' +
        '<div class="admin-panel-body">' +
        '<table class="admin-logs-table">' +
        '<thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>Resource</th><th>Result</th></tr></thead>' +
        '<tbody>' +
        '<tr class="admin-log-row">' +
        '<td class="admin-log-ts">—</td>' +
        '<td class="admin-log-user">—</td>' +
        '<td class="admin-log-action">—</td>' +
        '<td class="admin-log-resource">—</td>' +
        '<td class="admin-log-result">—</td>' +
        '</tr>' +
        '</tbody>' +
        '</table>' +
        '<div class="admin-logs-empty">' +
        '<p>Access logs will be displayed when data source is connected</p>' +
        '</div>' +
        '</div>';
    panelsContainer.appendChild(logsPanel);

    container.appendChild(panelsContainer);

    return container;
}

// ===========================================================================
// VTID-01173: Agents Control Plane v1 - Worker Orchestrator Registry
// ===========================================================================

/**
 * VTID-01173: Fetch data from Worker Orchestrator APIs
 * Calls all 3 endpoints in parallel and records timing
 */
async function fetchAgentsRegistry() {
    if (state.agentsRegistry.loading) return;

    state.agentsRegistry.loading = true;
    state.agentsRegistry.errors = { orchestratorHealth: null, subagents: null, skills: null };
    renderApp();

    var endpoints = [
        { key: 'orchestratorHealth', url: '/api/v1/worker/orchestrator/health' },
        { key: 'subagents', url: '/api/v1/worker/subagents' },
        { key: 'skills', url: '/api/v1/worker/skills' }
    ];

    var results = await Promise.all(endpoints.map(async function(ep) {
        var startTime = Date.now();
        try {
            var response = await fetch(ep.url, {
                headers: withVitanaContextHeaders({})
            });
            var elapsed = Date.now() - startTime;
            var data = null;
            var errorText = null;

            if (response.ok) {
                data = await response.json();
            } else {
                errorText = await response.text().catch(function() { return 'Unknown error'; });
            }

            return {
                key: ep.key,
                status: response.status,
                timing: elapsed,
                data: data,
                error: response.ok ? null : { status: response.status, text: errorText.substring(0, 500) }
            };
        } catch (e) {
            var elapsed = Date.now() - startTime;
            return {
                key: ep.key,
                status: 0,
                timing: elapsed,
                data: null,
                error: { status: 0, text: e.message }
            };
        }
    }));

    // Process results
    results.forEach(function(r) {
        state.agentsRegistry[r.key] = r.data;
        state.agentsRegistry.timing[r.key] = r.timing;
        state.agentsRegistry.status[r.key] = r.status;
        state.agentsRegistry.errors[r.key] = r.error;
    });

    state.agentsRegistry.loading = false;
    state.agentsRegistry.fetched = true;
    renderApp();
}

/**
 * VTID-01173: Render the API Status Strip
 * Shows status of each endpoint with timing
 */
function renderAgentsApiStatusStrip() {
    var strip = document.createElement('div');
    strip.className = 'agents-api-status-strip';

    var endpoints = [
        { key: 'orchestratorHealth', label: 'Orchestrator Health' },
        { key: 'subagents', label: 'Subagents' },
        { key: 'skills', label: 'Skills' }
    ];

    endpoints.forEach(function(ep) {
        var status = state.agentsRegistry.status[ep.key];
        var timing = state.agentsRegistry.timing[ep.key];
        var error = state.agentsRegistry.errors[ep.key];

        var item = document.createElement('div');
        item.className = 'agents-api-status-item';

        var icon = document.createElement('span');
        icon.className = 'agents-api-status-icon';
        if (status === 200) {
            icon.textContent = '\u2705';
            item.classList.add('agents-api-status-ok');
        } else if (status === null) {
            icon.textContent = '\u23F3';
            item.classList.add('agents-api-status-pending');
        } else {
            icon.textContent = '\u274C';
            item.classList.add('agents-api-status-error');
        }
        item.appendChild(icon);

        var label = document.createElement('span');
        label.className = 'agents-api-status-label';
        label.textContent = ep.label + ': ';
        item.appendChild(label);

        var statusText = document.createElement('span');
        statusText.className = 'agents-api-status-value';
        if (status === null) {
            statusText.textContent = 'pending';
        } else {
            statusText.textContent = status + (timing !== null ? ' (' + timing + 'ms)' : '');
        }
        item.appendChild(statusText);

        strip.appendChild(item);
    });

    return strip;
}

/**
 * VTID-01173: Render error panel for failed API calls
 */
function renderAgentsErrorPanel() {
    var errors = state.agentsRegistry.errors;
    var hasErrors = errors.orchestratorHealth || errors.subagents || errors.skills;

    if (!hasErrors) return null;

    var panel = document.createElement('div');
    panel.className = 'agents-error-panel';

    var heading = document.createElement('h4');
    heading.textContent = 'API Errors';
    panel.appendChild(heading);

    ['orchestratorHealth', 'subagents', 'skills'].forEach(function(key) {
        var err = errors[key];
        if (!err) return;

        var item = document.createElement('div');
        item.className = 'agents-error-item';

        var endpoint = document.createElement('strong');
        endpoint.textContent = key + ': ';
        item.appendChild(endpoint);

        var statusSpan = document.createElement('span');
        statusSpan.textContent = 'HTTP ' + err.status;
        item.appendChild(statusSpan);

        if (err.text) {
            var textPre = document.createElement('pre');
            textPre.className = 'agents-error-text';
            textPre.textContent = err.text;
            item.appendChild(textPre);
        }

        panel.appendChild(item);
    });

    return panel;
}

/**
 * VTID-01173: Render Orchestrator Summary Card
 */
function renderOrchestratorSummaryCard() {
    var health = state.agentsRegistry.orchestratorHealth;

    var card = document.createElement('div');
    card.className = 'agents-card agents-orchestrator-card';

    var heading = document.createElement('h3');
    heading.textContent = 'Orchestrator Summary';
    card.appendChild(heading);

    if (!health) {
        var empty = document.createElement('p');
        empty.className = 'agents-card-empty';
        empty.textContent = 'No data available';
        card.appendChild(empty);
        return card;
    }

    // Service info
    var infoGrid = document.createElement('div');
    infoGrid.className = 'agents-info-grid';

    var fields = [
        { label: 'Service', value: health.service || 'N/A' },
        { label: 'Version', value: health.version || 'N/A' },
        { label: 'VTID', value: health.vtid || 'N/A' },
        { label: 'Timestamp', value: health.timestamp ? new Date(health.timestamp).toLocaleString() : 'N/A' }
    ];

    fields.forEach(function(f) {
        var row = document.createElement('div');
        row.className = 'agents-info-row';
        row.innerHTML = '<span class="agents-info-label">' + f.label + ':</span><span class="agents-info-value">' + escapeHtml(f.value) + '</span>';
        infoGrid.appendChild(row);
    });

    card.appendChild(infoGrid);

    // Subagents summary
    if (health.subagents && health.subagents.length > 0) {
        var subagentsSection = document.createElement('div');
        subagentsSection.className = 'agents-orchestrator-subagents';

        var subHeading = document.createElement('h4');
        subHeading.textContent = 'Registered Subagents (' + health.subagents.length + ')';
        subagentsSection.appendChild(subHeading);

        var subList = document.createElement('div');
        subList.className = 'agents-subagent-badges';

        health.subagents.forEach(function(sub) {
            var badge = document.createElement('span');
            badge.className = 'agents-subagent-badge';
            var statusClass = (sub.status || '').toLowerCase() === 'active' ? 'badge-success' : 'badge-secondary';
            badge.classList.add(statusClass);
            badge.textContent = sub.id + ' (' + (sub.domain || 'default') + ')';
            subList.appendChild(badge);
        });

        subagentsSection.appendChild(subList);
        card.appendChild(subagentsSection);
    }

    // Endpoints summary
    if (health.endpoints) {
        var endpointsSection = document.createElement('div');
        endpointsSection.className = 'agents-orchestrator-endpoints';

        var epHeading = document.createElement('h4');
        epHeading.textContent = 'Endpoint Keys';
        endpointsSection.appendChild(epHeading);

        var epList = document.createElement('div');
        epList.className = 'agents-endpoint-list';

        Object.keys(health.endpoints).forEach(function(key) {
            var epItem = document.createElement('span');
            epItem.className = 'agents-endpoint-item';
            epItem.textContent = key;
            epList.appendChild(epItem);
        });

        endpointsSection.appendChild(epList);
        card.appendChild(endpointsSection);
    }

    return card;
}

/**
 * VTID-01173: Render Subagents Table
 */
function renderSubagentsTable() {
    var subagents = state.agentsRegistry.subagents;

    var section = document.createElement('div');
    section.className = 'agents-section agents-subagents-section';

    var heading = document.createElement('h3');
    heading.textContent = 'Subagents';
    section.appendChild(heading);

    if (!subagents || !subagents.subagents || subagents.subagents.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'agents-section-empty';
        empty.textContent = 'No subagents registered';
        section.appendChild(empty);
        return section;
    }

    var table = document.createElement('table');
    table.className = 'agents-table agents-subagents-table';

    // Header
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    ['ID', 'Domain', 'Allowed Paths', 'Guardrails', 'Default Budget'].forEach(function(h) {
        var th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    var tbody = document.createElement('tbody');
    subagents.subagents.forEach(function(sub) {
        var row = document.createElement('tr');

        // ID
        var idCell = document.createElement('td');
        idCell.className = 'agents-table-id';
        idCell.textContent = sub.id || 'N/A';
        row.appendChild(idCell);

        // Domain
        var domainCell = document.createElement('td');
        domainCell.textContent = sub.domain || 'default';
        row.appendChild(domainCell);

        // Allowed Paths
        var pathsCell = document.createElement('td');
        pathsCell.className = 'agents-table-paths';
        if (sub.allowed_paths && sub.allowed_paths.length > 0) {
            var pathsList = document.createElement('ul');
            pathsList.className = 'agents-list-compact';
            sub.allowed_paths.forEach(function(p) {
                var li = document.createElement('li');
                li.textContent = p;
                pathsList.appendChild(li);
            });
            pathsCell.appendChild(pathsList);
        } else {
            pathsCell.textContent = '-';
        }
        row.appendChild(pathsCell);

        // Guardrails
        var guardrailsCell = document.createElement('td');
        guardrailsCell.className = 'agents-table-guardrails';
        if (sub.guardrails && sub.guardrails.length > 0) {
            var guardList = document.createElement('ul');
            guardList.className = 'agents-list-compact';
            sub.guardrails.forEach(function(g) {
                var li = document.createElement('li');
                li.textContent = g;
                guardList.appendChild(li);
            });
            guardrailsCell.appendChild(guardList);
        } else {
            guardrailsCell.textContent = '-';
        }
        row.appendChild(guardrailsCell);

        // Default Budget
        var budgetCell = document.createElement('td');
        if (sub.default_budget) {
            budgetCell.innerHTML = 'Files: ' + (sub.default_budget.max_files || 'N/A') + '<br>Dirs: ' + (sub.default_budget.max_directories || 'N/A');
        } else {
            budgetCell.textContent = '-';
        }
        row.appendChild(budgetCell);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    section.appendChild(table);

    return section;
}

/**
 * VTID-01173: Render Skills Table
 */
function renderSkillsTable() {
    var skillsData = state.agentsRegistry.skills;

    var section = document.createElement('div');
    section.className = 'agents-section agents-skills-section';

    var heading = document.createElement('h3');
    heading.textContent = 'Skills Registry';
    section.appendChild(heading);

    if (!skillsData || !skillsData.skills || skillsData.skills.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'agents-section-empty';
        empty.textContent = 'No skills registered';
        section.appendChild(empty);
        return section;
    }

    var table = document.createElement('table');
    table.className = 'agents-table agents-skills-table';

    // Header
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    ['Skill ID', 'Name', 'Domain', 'Rule ID'].forEach(function(h) {
        var th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    var tbody = document.createElement('tbody');
    skillsData.skills.forEach(function(skill) {
        var row = document.createElement('tr');

        // Skill ID
        var idCell = document.createElement('td');
        idCell.className = 'agents-table-id';
        idCell.textContent = skill.skill_id || skill.id || 'N/A';
        row.appendChild(idCell);

        // Name
        var nameCell = document.createElement('td');
        nameCell.textContent = skill.name || 'N/A';
        row.appendChild(nameCell);

        // Domain
        var domainCell = document.createElement('td');
        domainCell.textContent = skill.domain || 'default';
        row.appendChild(domainCell);

        // Rule ID
        var ruleCell = document.createElement('td');
        ruleCell.textContent = skill.rule_id || '-';
        row.appendChild(ruleCell);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    section.appendChild(table);

    // Preflight Chains Summary
    if (skillsData.preflight_chains) {
        var chainsSection = document.createElement('div');
        chainsSection.className = 'agents-preflight-chains';

        var chainsHeading = document.createElement('h4');
        chainsHeading.textContent = 'Preflight Chains';
        chainsSection.appendChild(chainsHeading);

        var chains = skillsData.preflight_chains;
        ['frontend', 'backend', 'memory'].forEach(function(chainType) {
            if (chains[chainType] && chains[chainType].length > 0) {
                var chainDiv = document.createElement('div');
                chainDiv.className = 'agents-chain-row';

                var chainLabel = document.createElement('strong');
                chainLabel.textContent = chainType + ': ';
                chainDiv.appendChild(chainLabel);

                var chainValue = document.createElement('span');
                chainValue.textContent = chains[chainType].join(' \u2192 ');
                chainDiv.appendChild(chainValue);

                chainsSection.appendChild(chainDiv);
            }
        });

        section.appendChild(chainsSection);
    }

    return section;
}

/**
 * VTID-01173: Render Raw JSON Debug Section
 */
function renderRawJsonDebug(key, label) {
    var data = state.agentsRegistry[key];
    var showKey = 'showRaw' + key.charAt(0).toUpperCase() + key.slice(1);
    var isExpanded = state.agentsRegistry[showKey];

    var section = document.createElement('div');
    section.className = 'agents-raw-json-section';

    var toggle = document.createElement('button');
    toggle.className = 'agents-raw-json-toggle';
    toggle.textContent = (isExpanded ? '\u25BC' : '\u25B6') + ' Show raw JSON: ' + label;
    toggle.onclick = function() {
        state.agentsRegistry[showKey] = !state.agentsRegistry[showKey];
        renderApp();
    };
    section.appendChild(toggle);

    if (isExpanded && data) {
        var pre = document.createElement('pre');
        pre.className = 'agents-raw-json-content';
        pre.textContent = JSON.stringify(data, null, 2);
        section.appendChild(pre);
    }

    return section;
}

/**
 * VTID-01173: Render VTID Fingerprints Section
 */
function renderVtidFingerprints() {
    var health = state.agentsRegistry.orchestratorHealth;
    var skills = state.agentsRegistry.skills;

    var section = document.createElement('div');
    section.className = 'agents-fingerprints-section';

    var heading = document.createElement('h4');
    heading.textContent = 'VTID Fingerprints';
    section.appendChild(heading);

    var grid = document.createElement('div');
    grid.className = 'agents-fingerprints-grid';

    // Worker Orchestrator VTID
    var orchVtid = document.createElement('div');
    orchVtid.className = 'agents-fingerprint-item';
    orchVtid.innerHTML = '<span class="agents-fingerprint-label">Worker Orchestrator VTID:</span><span class="agents-fingerprint-value">' + escapeHtml(health && health.vtid ? health.vtid : 'N/A') + '</span>';
    grid.appendChild(orchVtid);

    // Skills Registry VTID
    var skillsVtid = document.createElement('div');
    skillsVtid.className = 'agents-fingerprint-item';
    skillsVtid.innerHTML = '<span class="agents-fingerprint-label">Skills Registry VTID:</span><span class="agents-fingerprint-value">' + escapeHtml(skills && skills.vtid ? skills.vtid : 'N/A') + '</span>';
    grid.appendChild(skillsVtid);

    section.appendChild(grid);

    return section;
}

/**
 * VTID-01173: HTML escape helper
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * VTID-01173: Render the Registered Agents View
 * Main entry point for /command-hub/agents/registered-agents/
 */
function renderRegisteredAgentsView() {
    var container = document.createElement('div');
    container.className = 'agents-registry-container';

    // Auto-fetch if not loaded
    if (!state.agentsRegistry.fetched && !state.agentsRegistry.loading) {
        fetchAgentsRegistry();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'agents-registry-header';

    var title = document.createElement('h2');
    title.textContent = 'Registered Agents';
    header.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'agents-registry-subtitle';
    subtitle.textContent = 'Worker Orchestrator APIs - VTID-01173';
    header.appendChild(subtitle);

    // Refresh button
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-secondary agents-refresh-btn';
    refreshBtn.textContent = state.agentsRegistry.loading ? 'Loading...' : 'Refresh';
    refreshBtn.disabled = state.agentsRegistry.loading;
    refreshBtn.onclick = function() {
        state.agentsRegistry.fetched = false;
        fetchAgentsRegistry();
    };
    header.appendChild(refreshBtn);

    container.appendChild(header);

    // API Status Strip
    container.appendChild(renderAgentsApiStatusStrip());

    // Error panel (if any errors)
    var errorPanel = renderAgentsErrorPanel();
    if (errorPanel) {
        container.appendChild(errorPanel);
    }

    // Loading state
    if (state.agentsRegistry.loading) {
        var loadingDiv = document.createElement('div');
        loadingDiv.className = 'agents-loading';
        loadingDiv.textContent = 'Loading Worker Orchestrator data...';
        container.appendChild(loadingDiv);
        return container;
    }

    // VTID Fingerprints
    container.appendChild(renderVtidFingerprints());

    // Orchestrator Summary Card
    container.appendChild(renderOrchestratorSummaryCard());

    // Subagents Table
    container.appendChild(renderSubagentsTable());

    // Skills Table
    container.appendChild(renderSkillsTable());

    // Raw JSON Debug sections
    var debugSection = document.createElement('div');
    debugSection.className = 'agents-debug-section';

    var debugHeading = document.createElement('h3');
    debugHeading.textContent = 'Debug Data';
    debugSection.appendChild(debugHeading);

    debugSection.appendChild(renderRawJsonDebug('orchestratorHealth', 'Orchestrator Health'));
    debugSection.appendChild(renderRawJsonDebug('subagents', 'Subagents'));
    debugSection.appendChild(renderRawJsonDebug('skills', 'Skills'));

    container.appendChild(debugSection);

    return container;
}

/**
 * VTID-01173: Render the Agents Skills View
 * Placeholder for /command-hub/agents/skills/ tab
 */
function renderAgentsSkillsView() {
    var container = document.createElement('div');
    container.className = 'agents-skills-view-container';

    // Auto-fetch if not loaded
    if (!state.agentsRegistry.fetched && !state.agentsRegistry.loading) {
        fetchAgentsRegistry();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'agents-registry-header';

    var title = document.createElement('h2');
    title.textContent = 'Skills Registry';
    header.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'agents-registry-subtitle';
    subtitle.textContent = 'Worker Orchestrator Skills - VTID-01173';
    header.appendChild(subtitle);

    container.appendChild(header);

    // API Status Strip
    container.appendChild(renderAgentsApiStatusStrip());

    // Loading state
    if (state.agentsRegistry.loading) {
        var loadingDiv = document.createElement('div');
        loadingDiv.className = 'agents-loading';
        loadingDiv.textContent = 'Loading Skills data...';
        container.appendChild(loadingDiv);
        return container;
    }

    // Skills Table
    container.appendChild(renderSkillsTable());

    // Raw JSON Debug
    container.appendChild(renderRawJsonDebug('skills', 'Skills'));

    return container;
}

// ===========================================================================
// VTID-01174: Agents Control Plane v2 - Pipelines (Runs + Traces)
// ===========================================================================

/**
 * VTID-01174: Fetch pipelines data from VTID Ledger API
 * VTID-01211: Added pagination support for Load More
 * @param {boolean} append - If true, append to existing items (Load More)
 */
async function fetchPipelinesData(append) {
    if (state.agentsPipelines.loading) return;
    if (append && !state.agentsPipelines.pagination.hasMore) return;

    state.agentsPipelines.loading = true;
    if (!append) {
        state.agentsPipelines.errors = { ledger: null, events: null };
    }
    renderApp();

    var pagination = state.agentsPipelines.pagination;
    var offset = append ? pagination.offset : 0;
    var ledgerStart = Date.now();
    try {
        var response = await fetch('/api/v1/oasis/vtid-ledger?limit=' + pagination.limit + '&offset=' + offset, {
            headers: withVitanaContextHeaders({})
        });
        var ledgerElapsed = Date.now() - ledgerStart;
        state.agentsPipelines.timing.ledger = ledgerElapsed;
        state.agentsPipelines.status.ledger = response.status;

        if (!response.ok) {
            var errorText = await response.text();
            console.error('[VTID-01174] Ledger fetch failed:', response.status, errorText);
            state.agentsPipelines.errors.ledger = { status: response.status, message: errorText };
            if (!append) state.agentsPipelines.items = [];
        } else {
            var data = await response.json();
            if (data.ok && Array.isArray(data.data)) {
                var newItems = data.data;
                if (append) {
                    state.agentsPipelines.items = state.agentsPipelines.items.concat(newItems);
                } else {
                    state.agentsPipelines.items = newItems;
                }
                // VTID-01211: Update pagination state
                state.agentsPipelines.pagination = {
                    limit: pagination.limit,
                    offset: offset + newItems.length,
                    hasMore: data.pagination ? data.pagination.has_more : newItems.length === pagination.limit
                };
                console.log('[VTID-01174] Fetched', newItems.length, 'pipelines, hasMore:', state.agentsPipelines.pagination.hasMore);
            } else {
                if (!append) state.agentsPipelines.items = [];
                state.agentsPipelines.errors.ledger = { status: response.status, message: 'Invalid response format' };
            }
        }
    } catch (err) {
        console.error('[VTID-01174] Ledger fetch error:', err);
        state.agentsPipelines.timing.ledger = Date.now() - ledgerStart;
        state.agentsPipelines.status.ledger = 0;
        state.agentsPipelines.errors.ledger = { status: 0, message: err.message };
        if (!append) state.agentsPipelines.items = [];
    }

    state.agentsPipelines.loading = false;
    state.agentsPipelines.fetched = true;
    renderApp();
}

/**
 * VTID-01211: Load more pipelines (pagination)
 */
function loadMorePipelines() {
    fetchPipelinesData(true);
}

/**
 * VTID-01174: Fetch trace events for a specific VTID
 * Uses GET /api/v1/events?vtid=VTID-XXXX&limit=200
 */
async function fetchVtidTraceEvents(vtid) {
    if (!vtid) return;

    // Already cached?
    if (state.agentsPipelines.eventsCache[vtid]) {
        return state.agentsPipelines.eventsCache[vtid];
    }

    try {
        var response = await fetch('/api/v1/events?vtid=' + encodeURIComponent(vtid) + '&limit=200', {
            headers: withVitanaContextHeaders({})
        });
        if (response.ok) {
            var data = await response.json();
            var events = (data.ok && Array.isArray(data.data)) ? data.data : (Array.isArray(data) ? data : []);
            state.agentsPipelines.eventsCache[vtid] = events;
            console.log('[VTID-01174] Fetched', events.length, 'events for', vtid);
            renderApp();
            return events;
        } else {
            console.warn('[VTID-01174] Failed to fetch events for', vtid, response.status);
            state.agentsPipelines.eventsCache[vtid] = [];
            return [];
        }
    } catch (err) {
        console.error('[VTID-01174] Events fetch error for', vtid, err);
        state.agentsPipelines.eventsCache[vtid] = [];
        return [];
    }
}

/**
 * VTID-01174: Toggle VTID trace expansion
 */
function togglePipelineExpand(vtid) {
    var wasExpanded = state.agentsPipelines.expandedVtids[vtid];
    state.agentsPipelines.expandedVtids[vtid] = !wasExpanded;

    // Fetch events if expanding and not cached
    if (!wasExpanded && !state.agentsPipelines.eventsCache[vtid]) {
        fetchVtidTraceEvents(vtid);
    }

    renderApp();
}

/**
 * VTID-01174: Get time window in hours
 */
function getTimeWindowHours(tw) {
    var map = { '1h': 1, '24h': 24, '48h': 48, '7d': 168 };
    return map[tw] || 48;
}

/**
 * VTID-01174: Filter pipelines based on active filter and time window
 */
function getFilteredPipelines() {
    var items = state.agentsPipelines.items || [];
    var filter = state.agentsPipelines.activeFilter;
    var hours = getTimeWindowHours(state.agentsPipelines.timeWindow);
    var cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Time window filter
    items = items.filter(function(item) {
        var itemDate = new Date(item.updated_at || item.created_at);
        return itemDate >= cutoff;
    });

    // Status filter
    if (filter === 'active') {
        // Active: scheduled, allocated, in_progress
        items = items.filter(function(item) {
            var s = (item.status || '').toLowerCase();
            return s === 'scheduled' || s === 'allocated' || s === 'in_progress' || s === 'queued' || s === 'running';
        });
    } else if (filter === 'recent') {
        // Recent: completed successfully (done, complete, deployed, merged)
        items = items.filter(function(item) {
            var s = (item.status || '').toLowerCase();
            return s === 'done' || s === 'complete' || s === 'deployed' || s === 'merged' || s === 'closed';
        });
    } else if (filter === 'failed') {
        // Failed: error, failed, blocked
        items = items.filter(function(item) {
            var s = (item.status || '').toLowerCase();
            return s === 'failed' || s === 'error' || s === 'blocked';
        });
    }
    // 'all' - no additional filter

    return items;
}

/**
 * VTID-01174: Derive pipeline status class
 */
function getPipelineStatusClass(status) {
    var s = (status || '').toLowerCase();
    if (s === 'in_progress' || s === 'running' || s === 'queued') return 'pipeline-status-active';
    if (s === 'scheduled' || s === 'allocated') return 'pipeline-status-scheduled';
    if (s === 'done' || s === 'complete' || s === 'deployed' || s === 'merged' || s === 'closed') return 'pipeline-status-success';
    if (s === 'failed' || s === 'error' || s === 'blocked') return 'pipeline-status-failed';
    return 'pipeline-status-pending';
}

/**
 * VTID-01174: Get stage status from stageTimeline
 */
function getStageStatus(stageTimeline, stageName) {
    if (!stageTimeline || !Array.isArray(stageTimeline)) return 'pending';
    var entry = stageTimeline.find(function(s) { return s.stage === stageName; });
    return entry ? (entry.status || 'pending') : 'pending';
}

/**
 * VTID-01174: Render the Pipelines API Status Strip
 */
function renderPipelinesApiStatusStrip() {
    var strip = document.createElement('div');
    strip.className = 'agents-api-status-strip';

    var endpoints = [
        { key: 'ledger', label: 'VTID Ledger', url: '/api/v1/oasis/vtid-ledger' }
    ];

    endpoints.forEach(function(ep) {
        var status = state.agentsPipelines.status[ep.key];
        var timing = state.agentsPipelines.timing[ep.key];
        var error = state.agentsPipelines.errors[ep.key];

        var item = document.createElement('div');
        item.className = 'agents-api-status-item';

        var isOk = status >= 200 && status < 300;
        var isPending = status === null;

        if (isPending) {
            item.classList.add('agents-api-status-pending');
        } else if (isOk) {
            item.classList.add('agents-api-status-ok');
        } else {
            item.classList.add('agents-api-status-error');
        }

        var icon = document.createElement('span');
        icon.className = 'agents-api-status-icon';
        icon.textContent = isPending ? '⏳' : (isOk ? '✓' : '✗');
        item.appendChild(icon);

        var label = document.createElement('span');
        label.className = 'agents-api-status-label';
        label.textContent = ep.label + ':';
        item.appendChild(label);

        var value = document.createElement('span');
        value.className = 'agents-api-status-value';
        if (isPending) {
            value.textContent = '...';
        } else {
            value.textContent = status + (timing !== null ? ' (' + timing + 'ms)' : '');
        }
        item.appendChild(value);

        strip.appendChild(item);
    });

    return strip;
}

/**
 * VTID-01174: Render error panel for pipelines
 */
function renderPipelinesErrorPanel() {
    var errors = state.agentsPipelines.errors;
    var hasErrors = errors.ledger || errors.events;

    if (!hasErrors) return null;

    var panel = document.createElement('div');
    panel.className = 'agents-error-panel';

    var heading = document.createElement('h4');
    heading.textContent = 'API Errors';
    panel.appendChild(heading);

    if (errors.ledger) {
        var ledgerErr = document.createElement('div');
        ledgerErr.className = 'agents-error-item';

        var ledgerLabel = document.createElement('strong');
        ledgerLabel.textContent = 'VTID Ledger: ';
        ledgerErr.appendChild(ledgerLabel);

        var ledgerStatus = document.createElement('span');
        ledgerStatus.textContent = 'HTTP ' + (errors.ledger.status || 'Error');
        ledgerErr.appendChild(ledgerStatus);

        if (errors.ledger.message) {
            var ledgerMsg = document.createElement('pre');
            ledgerMsg.className = 'agents-error-text';
            ledgerMsg.textContent = errors.ledger.message;
            ledgerErr.appendChild(ledgerMsg);
        }
        panel.appendChild(ledgerErr);
    }

    return panel;
}

/**
 * VTID-01174: Render stage ribbon (P | W | V | D)
 */
function renderPipelineStageRibbon(stageTimeline) {
    var ribbon = document.createElement('div');
    ribbon.className = 'pipeline-stage-ribbon';

    var stages = [
        { name: 'PLANNER', label: 'P' },
        { name: 'WORKER', label: 'W' },
        { name: 'VALIDATOR', label: 'V' },
        { name: 'DEPLOY', label: 'D' }
    ];

    stages.forEach(function(stageInfo) {
        var status = getStageStatus(stageTimeline, stageInfo.name);
        var pill = document.createElement('span');
        pill.className = 'pipeline-stage-pill pipeline-stage-pill-' + stageInfo.name.toLowerCase();

        // Add status class
        if (status === 'success' || status === 'completed') {
            pill.classList.add('pipeline-stage-completed');
        } else if (status === 'in_progress' || status === 'active' || status === 'running') {
            pill.classList.add('pipeline-stage-active');
        } else if (status === 'error' || status === 'failed') {
            pill.classList.add('pipeline-stage-failed');
        } else {
            pill.classList.add('pipeline-stage-pending');
        }

        pill.textContent = stageInfo.label;
        pill.title = stageInfo.name + ': ' + status;
        ribbon.appendChild(pill);
    });

    return ribbon;
}

/**
 * VTID-01174: Render a single pipeline row
 */
function renderPipelineRow(item) {
    var row = document.createElement('div');
    row.className = 'pipeline-row';

    var isExpanded = state.agentsPipelines.expandedVtids[item.vtid];
    if (isExpanded) {
        row.classList.add('pipeline-row-expanded');
    }

    // Main row content
    var mainRow = document.createElement('div');
    mainRow.className = 'pipeline-row-main';
    mainRow.onclick = function() {
        togglePipelineExpand(item.vtid);
    };

    // Expand icon
    var expandIcon = document.createElement('span');
    expandIcon.className = 'pipeline-expand-icon';
    expandIcon.textContent = isExpanded ? '▼' : '▶';
    mainRow.appendChild(expandIcon);

    // VTID
    var vtidSpan = document.createElement('span');
    vtidSpan.className = 'pipeline-vtid';
    vtidSpan.textContent = item.vtid;
    mainRow.appendChild(vtidSpan);

    // Status badge
    var statusBadge = document.createElement('span');
    statusBadge.className = 'pipeline-status-badge ' + getPipelineStatusClass(item.status);
    statusBadge.textContent = item.status || 'unknown';
    mainRow.appendChild(statusBadge);

    // Title
    var titleSpan = document.createElement('span');
    titleSpan.className = 'pipeline-title';
    titleSpan.textContent = item.title || 'Untitled';
    titleSpan.title = item.title || '';
    mainRow.appendChild(titleSpan);

    // Stage ribbon
    mainRow.appendChild(renderPipelineStageRibbon(item.stageTimeline));

    // Timestamp
    var timeSpan = document.createElement('span');
    timeSpan.className = 'pipeline-timestamp';
    var ts = item.updated_at || item.created_at;
    if (ts) {
        var d = new Date(ts);
        timeSpan.textContent = d.toLocaleString();
        timeSpan.title = ts;
    }
    mainRow.appendChild(timeSpan);

    row.appendChild(mainRow);

    // Expanded trace view
    if (isExpanded) {
        row.appendChild(renderPipelineTraceView(item));
    }

    return row;
}

/**
 * VTID-01174: Render trace view for expanded pipeline
 */
function renderPipelineTraceView(item) {
    var trace = document.createElement('div');
    trace.className = 'pipeline-trace-view';

    // Header
    var header = document.createElement('div');
    header.className = 'pipeline-trace-header';
    header.textContent = 'OASIS Event Trace for ' + item.vtid;
    trace.appendChild(header);

    // Check cache
    var events = state.agentsPipelines.eventsCache[item.vtid];

    if (!events) {
        var loading = document.createElement('div');
        loading.className = 'pipeline-trace-loading';
        loading.textContent = 'Loading trace events...';
        trace.appendChild(loading);
        return trace;
    }

    if (events.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'pipeline-trace-empty';
        empty.textContent = 'No OASIS events found for this VTID.';
        trace.appendChild(empty);
        return trace;
    }

    // Timeline
    var timeline = document.createElement('div');
    timeline.className = 'pipeline-trace-timeline';

    // Sort events by created_at ascending (oldest first)
    var sortedEvents = events.slice().sort(function(a, b) {
        return new Date(a.created_at) - new Date(b.created_at);
    });

    sortedEvents.forEach(function(ev) {
        var eventRow = document.createElement('div');
        eventRow.className = 'pipeline-trace-event';

        // Status indicator
        var statusDot = document.createElement('span');
        statusDot.className = 'pipeline-trace-dot';
        var evStatus = (ev.status || '').toLowerCase();
        if (evStatus === 'success') {
            statusDot.classList.add('pipeline-trace-dot-success');
        } else if (evStatus === 'error' || evStatus === 'fail' || evStatus === 'failure') {
            statusDot.classList.add('pipeline-trace-dot-error');
        } else if (evStatus === 'warning') {
            statusDot.classList.add('pipeline-trace-dot-warning');
        } else {
            statusDot.classList.add('pipeline-trace-dot-info');
        }
        eventRow.appendChild(statusDot);

        // Timestamp
        var tsSpan = document.createElement('span');
        tsSpan.className = 'pipeline-trace-ts';
        if (ev.created_at) {
            var evDate = new Date(ev.created_at);
            tsSpan.textContent = evDate.toLocaleTimeString();
            tsSpan.title = ev.created_at;
        }
        eventRow.appendChild(tsSpan);

        // Type/Topic
        var typeSpan = document.createElement('span');
        typeSpan.className = 'pipeline-trace-type';
        typeSpan.textContent = ev.type || ev.topic || 'event';
        eventRow.appendChild(typeSpan);

        // Message
        var msgSpan = document.createElement('span');
        msgSpan.className = 'pipeline-trace-message';
        msgSpan.textContent = ev.message || '';
        msgSpan.title = ev.message || '';
        eventRow.appendChild(msgSpan);

        // Source
        var srcSpan = document.createElement('span');
        srcSpan.className = 'pipeline-trace-source';
        srcSpan.textContent = ev.source || '';
        eventRow.appendChild(srcSpan);

        timeline.appendChild(eventRow);
    });

    trace.appendChild(timeline);

    // Event count
    var countDiv = document.createElement('div');
    countDiv.className = 'pipeline-trace-count';
    countDiv.textContent = events.length + ' event' + (events.length !== 1 ? 's' : '');
    trace.appendChild(countDiv);

    return trace;
}

/**
 * VTID-01174: Render the Agents Pipelines View
 * Main entry point for /command-hub/agents/pipelines/
 */
function renderAgentsPipelinesView() {
    var container = document.createElement('div');
    container.className = 'pipelines-container';

    // Auto-fetch if not loaded
    if (!state.agentsPipelines.fetched && !state.agentsPipelines.loading) {
        fetchPipelinesData();
        // VTID-01209: Also fetch active executions for live pipeline status
        fetchActiveExecutions();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'pipelines-header';

    var title = document.createElement('h2');
    title.textContent = 'Pipeline Runs';
    header.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'pipelines-subtitle';
    subtitle.textContent = 'VTID Ledger + OASIS Events Trace - VTID-01174';
    header.appendChild(subtitle);

    // Refresh button
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-secondary pipelines-refresh-btn';
    refreshBtn.textContent = state.agentsPipelines.loading ? 'Loading...' : 'Refresh';
    refreshBtn.disabled = state.agentsPipelines.loading;
    refreshBtn.onclick = function() {
        state.agentsPipelines.fetched = false;
        state.agentsPipelines.eventsCache = {}; // Clear events cache
        // VTID-01211: Reset pagination on refresh
        state.agentsPipelines.pagination.offset = 0;
        state.agentsPipelines.pagination.hasMore = true;
        fetchPipelinesData();
        // VTID-01209: Also refresh active executions
        fetchActiveExecutions();
    };
    header.appendChild(refreshBtn);

    container.appendChild(header);

    // Controls bar: Filter pills + Time window
    var controlsBar = document.createElement('div');
    controlsBar.className = 'pipelines-controls';

    // Filter pills
    var filterGroup = document.createElement('div');
    filterGroup.className = 'pipelines-filter-pills';

    var filters = [
        { key: 'active', label: 'Active' },
        { key: 'recent', label: 'Recent' },
        { key: 'failed', label: 'Failed' },
        { key: 'all', label: 'All' }
    ];

    filters.forEach(function(f) {
        var pill = document.createElement('button');
        pill.className = 'pipelines-filter-pill';
        if (state.agentsPipelines.activeFilter === f.key) {
            pill.classList.add('pipelines-filter-pill-active');
        }
        pill.textContent = f.label;
        pill.onclick = function() {
            state.agentsPipelines.activeFilter = f.key;
            renderApp();
        };
        filterGroup.appendChild(pill);
    });

    controlsBar.appendChild(filterGroup);

    // Time window selector
    var timeGroup = document.createElement('div');
    timeGroup.className = 'pipelines-time-selector';

    var timeLabel = document.createElement('span');
    timeLabel.className = 'pipelines-time-label';
    timeLabel.textContent = 'Window:';
    timeGroup.appendChild(timeLabel);

    var timeWindows = ['1h', '24h', '48h', '7d'];
    timeWindows.forEach(function(tw) {
        var btn = document.createElement('button');
        btn.className = 'pipelines-time-btn';
        if (state.agentsPipelines.timeWindow === tw) {
            btn.classList.add('pipelines-time-btn-active');
        }
        btn.textContent = tw;
        btn.onclick = function() {
            state.agentsPipelines.timeWindow = tw;
            renderApp();
        };
        timeGroup.appendChild(btn);
    });

    controlsBar.appendChild(timeGroup);
    container.appendChild(controlsBar);

    // API Status Strip
    container.appendChild(renderPipelinesApiStatusStrip());

    // VTID-01209: Active Executions - real-time pipeline status for in-progress VTIDs
    if (state.activeExecutions && state.activeExecutions.length > 0) {
        var activeSection = document.createElement('div');
        activeSection.className = 'pipelines-active-executions';

        var activeHeader = document.createElement('div');
        activeHeader.className = 'pipelines-active-header';
        activeHeader.innerHTML = '<span class="live-indicator"><span class="live-dot"></span> LIVE</span> ' +
            state.activeExecutions.length + ' Active Pipeline' + (state.activeExecutions.length > 1 ? 's' : '');
        activeSection.appendChild(activeHeader);

        var activeGrid = document.createElement('div');
        activeGrid.className = 'pipelines-active-grid';

        state.activeExecutions.forEach(function(execData) {
            var execCard = renderTaskExecutionStatus(execData, { variant: 'ticker-card', showRecent: true });
            activeGrid.appendChild(execCard);
        });

        activeSection.appendChild(activeGrid);
        container.appendChild(activeSection);
    }

    // Error panel (if any errors)
    var errorPanel = renderPipelinesErrorPanel();
    if (errorPanel) {
        container.appendChild(errorPanel);
    }

    // Loading state
    if (state.agentsPipelines.loading) {
        var loadingDiv = document.createElement('div');
        loadingDiv.className = 'pipelines-loading';
        loadingDiv.textContent = 'Loading pipeline data from VTID Ledger...';
        container.appendChild(loadingDiv);
        return container;
    }

    // Filtered items
    var filteredItems = getFilteredPipelines();

    // Stats bar
    var statsBar = document.createElement('div');
    statsBar.className = 'pipelines-stats';
    var totalItems = state.agentsPipelines.items.length;
    var activeCount = state.agentsPipelines.items.filter(function(i) {
        var s = (i.status || '').toLowerCase();
        return s === 'scheduled' || s === 'allocated' || s === 'in_progress' || s === 'queued' || s === 'running';
    }).length;
    var failedCount = state.agentsPipelines.items.filter(function(i) {
        var s = (i.status || '').toLowerCase();
        return s === 'failed' || s === 'error' || s === 'blocked';
    }).length;
    statsBar.innerHTML = '<span class="pipelines-stat">Total: <strong>' + totalItems + '</strong></span>' +
        '<span class="pipelines-stat pipelines-stat-active">Active: <strong>' + activeCount + '</strong></span>' +
        '<span class="pipelines-stat pipelines-stat-failed">Failed: <strong>' + failedCount + '</strong></span>' +
        '<span class="pipelines-stat">Showing: <strong>' + filteredItems.length + '</strong></span>';
    container.appendChild(statsBar);

    // Pipelines list
    var list = document.createElement('div');
    list.className = 'pipelines-list';

    if (filteredItems.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'pipelines-empty';
        emptyDiv.textContent = 'No pipelines match the current filter.';
        list.appendChild(emptyDiv);
    } else {
        filteredItems.forEach(function(item) {
            list.appendChild(renderPipelineRow(item));
        });

        // VTID-01211: Load More button
        if (state.agentsPipelines.pagination.hasMore || state.agentsPipelines.loading) {
            var loadMoreContainer = document.createElement('div');
            loadMoreContainer.className = 'load-more-container';

            var loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'load-more-btn' + (state.agentsPipelines.loading ? ' loading' : '');
            loadMoreBtn.disabled = state.agentsPipelines.loading;
            loadMoreBtn.textContent = state.agentsPipelines.loading ? 'Loading...' : 'Load More';
            loadMoreBtn.onclick = function() {
                loadMorePipelines();
            };

            loadMoreContainer.appendChild(loadMoreBtn);
            list.appendChild(loadMoreContainer);
        }
    }

    container.appendChild(list);

    // Debug: Raw JSON toggle
    var debugSection = document.createElement('div');
    debugSection.className = 'pipelines-debug-section';

    var debugToggle = document.createElement('button');
    debugToggle.className = 'btn btn-sm btn-ghost';
    debugToggle.textContent = state.agentsPipelines.showRawLedger ? 'Hide Raw JSON' : 'Show Raw JSON';
    debugToggle.onclick = function() {
        state.agentsPipelines.showRawLedger = !state.agentsPipelines.showRawLedger;
        renderApp();
    };
    debugSection.appendChild(debugToggle);

    if (state.agentsPipelines.showRawLedger) {
        var rawJson = document.createElement('pre');
        rawJson.className = 'pipelines-raw-json';
        rawJson.textContent = JSON.stringify(state.agentsPipelines.items.slice(0, 10), null, 2);
        debugSection.appendChild(rawJson);
    }

    container.appendChild(debugSection);

    return container;
}

// ===========================================================================
// VTID-01208: LLM Telemetry + Model Provenance + Runtime Routing Control
// ===========================================================================

/**
 * VTID-01208: Fetch LLM routing policy from API
 */
async function fetchLLMRoutingPolicy() {
    if (state.agentsTelemetry.policyLoading) return;

    state.agentsTelemetry.policyLoading = true;
    state.agentsTelemetry.policyError = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/llm/routing-policy', {
            headers: withVitanaContextHeaders({})
        });

        if (!response.ok) {
            var errorText = await response.text();
            console.error('[VTID-01208] Policy fetch failed:', response.status, errorText);
            state.agentsTelemetry.policyError = 'Failed to load routing policy: ' + response.status;
        } else {
            var data = await response.json();
            if (data.ok && data.data) {
                state.agentsTelemetry.policy = data.data.policy;
                state.agentsTelemetry.providers = data.data.providers || [];
                state.agentsTelemetry.models = data.data.models || [];
                state.agentsTelemetry.recommended = data.data.recommended;
                console.log('[VTID-01208] Policy loaded:', data.data.policy ? 'v' + data.data.policy.version : 'none');
            } else {
                state.agentsTelemetry.policyError = data.error || 'Invalid response format';
            }
        }
    } catch (err) {
        console.error('[VTID-01208] Policy fetch error:', err);
        state.agentsTelemetry.policyError = 'Network error: ' + err.message;
    }

    state.agentsTelemetry.policyLoading = false;
    state.agentsTelemetry.policyFetched = true;
    renderApp();
}

/**
 * VTID-01208: Fetch LLM telemetry events from API
 * VTID-01211: Added pagination support for Load More
 * @param {boolean} append - If true, append to existing events (Load More)
 */
async function fetchLLMTelemetryEvents(append) {
    if (state.agentsTelemetry.eventsLoading) return;
    if (append && !state.agentsTelemetry.pagination.hasMore) return;

    state.agentsTelemetry.eventsLoading = true;
    state.agentsTelemetry.eventsError = null;
    renderApp();

    try {
        var filters = state.agentsTelemetry.filters;
        var pagination = state.agentsTelemetry.pagination;
        var offset = append ? pagination.offset : 0;
        var params = new URLSearchParams();

        if (filters.vtid) params.append('vtid', filters.vtid);
        if (filters.stage) params.append('stage', filters.stage);
        if (filters.provider) params.append('provider', filters.provider);
        if (filters.model) params.append('model', filters.model);
        if (filters.service) params.append('service', filters.service);
        if (filters.status) params.append('status', filters.status);
        params.append('limit', pagination.limit.toString());
        params.append('offset', offset.toString());

        // Time window
        var hoursMap = { '15m': 0.25, '1h': 1, '24h': 24, '7d': 168 };
        var hours = hoursMap[filters.timeWindow] || 1;
        var since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        params.append('since', since);

        var response = await fetch('/api/v1/llm/telemetry?' + params.toString(), {
            headers: withVitanaContextHeaders({})
        });

        if (!response.ok) {
            var errorText = await response.text();
            console.error('[VTID-01208] Telemetry fetch failed:', response.status, errorText);
            state.agentsTelemetry.eventsError = 'Failed to load telemetry: ' + response.status;
            if (!append) state.agentsTelemetry.events = [];
        } else {
            var data = await response.json();
            if (data.ok && data.data && Array.isArray(data.data.events)) {
                var newEvents = data.data.events;
                if (append) {
                    state.agentsTelemetry.events = state.agentsTelemetry.events.concat(newEvents);
                } else {
                    state.agentsTelemetry.events = newEvents;
                }
                // VTID-01211: Update pagination state
                state.agentsTelemetry.pagination = {
                    limit: pagination.limit,
                    offset: offset + newEvents.length,
                    hasMore: data.pagination ? data.pagination.has_more : newEvents.length === pagination.limit
                };
                console.log('[VTID-01208] Telemetry loaded:', newEvents.length, 'events, hasMore:', state.agentsTelemetry.pagination.hasMore);
            } else {
                if (!append) state.agentsTelemetry.events = [];
                state.agentsTelemetry.eventsError = data.error || 'Invalid response format';
            }
        }
    } catch (err) {
        console.error('[VTID-01208] Telemetry fetch error:', err);
        state.agentsTelemetry.eventsError = 'Network error: ' + err.message;
        if (!append) state.agentsTelemetry.events = [];
    }

    state.agentsTelemetry.eventsLoading = false;
    state.agentsTelemetry.eventsFetched = true;
    renderApp();
}

/**
 * VTID-01211: Load more telemetry events (pagination)
 */
function loadMoreTelemetryEvents() {
    fetchLLMTelemetryEvents(true);
}

/**
 * VTID-01208: Render the Agents Telemetry view
 */
function renderAgentsTelemetryView() {
    var container = document.createElement('div');
    container.className = 'telemetry-container';

    // Auto-fetch if not loaded
    if (!state.agentsTelemetry.policyFetched && !state.agentsTelemetry.policyLoading) {
        fetchLLMRoutingPolicy();
    }
    if (!state.agentsTelemetry.eventsFetched && !state.agentsTelemetry.eventsLoading) {
        fetchLLMTelemetryEvents();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'telemetry-header';

    var title = document.createElement('h2');
    title.textContent = 'LLM Telemetry & Routing';
    header.appendChild(title);

    // Tab buttons
    var tabBar = document.createElement('div');
    tabBar.className = 'telemetry-tab-bar';

    var tabs = [
        { key: 'telemetry', label: 'Telemetry Stream' },
        { key: 'routing', label: 'Routing Policy' }
    ];

    tabs.forEach(function(t) {
        var btn = document.createElement('button');
        btn.className = 'telemetry-tab-btn' + (state.agentsTelemetry.activeTab === t.key ? ' active' : '');
        btn.textContent = t.label;
        btn.onclick = function() {
            state.agentsTelemetry.activeTab = t.key;
            renderApp();
        };
        tabBar.appendChild(btn);
    });

    header.appendChild(tabBar);
    container.appendChild(header);

    // Render active tab content
    if (state.agentsTelemetry.activeTab === 'routing') {
        container.appendChild(renderTelemetryRoutingPanel());
    } else {
        container.appendChild(renderTelemetryStreamPanel());
    }

    return container;
}

/**
 * VTID-01208: Render the Telemetry Stream panel
 */
function renderTelemetryStreamPanel() {
    var panel = document.createElement('div');
    panel.className = 'telemetry-stream-panel';

    // Filters bar
    var filtersBar = document.createElement('div');
    filtersBar.className = 'telemetry-filters-bar';

    // VTID filter
    var vtidInput = document.createElement('input');
    vtidInput.type = 'text';
    vtidInput.className = 'telemetry-filter-input';
    vtidInput.placeholder = 'Filter by VTID...';
    vtidInput.value = state.agentsTelemetry.filters.vtid;
    vtidInput.onchange = function(e) {
        state.agentsTelemetry.filters.vtid = e.target.value;
        state.agentsTelemetry.eventsFetched = false;
        state.agentsTelemetry.pagination.offset = 0;
        state.agentsTelemetry.pagination.hasMore = true;
        fetchLLMTelemetryEvents();
    };
    filtersBar.appendChild(vtidInput);

    // Stage filter
    var stageSelect = document.createElement('select');
    stageSelect.className = 'telemetry-filter-select';
    stageSelect.innerHTML = '<option value="">All Stages</option>' +
        '<option value="planner">Planner</option>' +
        '<option value="worker">Worker</option>' +
        '<option value="validator">Validator</option>' +
        '<option value="operator">Operator</option>' +
        '<option value="memory">Memory</option>';
    stageSelect.value = state.agentsTelemetry.filters.stage;
    stageSelect.onchange = function(e) {
        state.agentsTelemetry.filters.stage = e.target.value;
        state.agentsTelemetry.eventsFetched = false;
        state.agentsTelemetry.pagination.offset = 0;
        state.agentsTelemetry.pagination.hasMore = true;
        fetchLLMTelemetryEvents();
    };
    filtersBar.appendChild(stageSelect);

    // Provider filter
    var providerSelect = document.createElement('select');
    providerSelect.className = 'telemetry-filter-select';
    providerSelect.innerHTML = '<option value="">All Providers</option>' +
        '<option value="anthropic">Anthropic</option>' +
        '<option value="vertex">Vertex AI</option>' +
        '<option value="openai">OpenAI</option>';
    providerSelect.value = state.agentsTelemetry.filters.provider;
    providerSelect.onchange = function(e) {
        state.agentsTelemetry.filters.provider = e.target.value;
        state.agentsTelemetry.eventsFetched = false;
        state.agentsTelemetry.pagination.offset = 0;
        state.agentsTelemetry.pagination.hasMore = true;
        fetchLLMTelemetryEvents();
    };
    filtersBar.appendChild(providerSelect);

    // Time window
    var timeSelect = document.createElement('select');
    timeSelect.className = 'telemetry-filter-select';
    timeSelect.innerHTML = '<option value="15m">Last 15m</option>' +
        '<option value="1h">Last 1h</option>' +
        '<option value="24h">Last 24h</option>' +
        '<option value="7d">Last 7d</option>';
    timeSelect.value = state.agentsTelemetry.filters.timeWindow;
    timeSelect.onchange = function(e) {
        state.agentsTelemetry.filters.timeWindow = e.target.value;
        state.agentsTelemetry.eventsFetched = false;
        state.agentsTelemetry.pagination.offset = 0;
        state.agentsTelemetry.pagination.hasMore = true;
        fetchLLMTelemetryEvents();
    };
    filtersBar.appendChild(timeSelect);

    // Refresh button
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-secondary';
    refreshBtn.textContent = state.agentsTelemetry.eventsLoading ? 'Loading...' : 'Refresh';
    refreshBtn.disabled = state.agentsTelemetry.eventsLoading;
    refreshBtn.onclick = function() {
        state.agentsTelemetry.eventsFetched = false;
        state.agentsTelemetry.pagination.offset = 0;
        state.agentsTelemetry.pagination.hasMore = true;
        fetchLLMTelemetryEvents();
    };
    filtersBar.appendChild(refreshBtn);

    panel.appendChild(filtersBar);

    // Error message
    if (state.agentsTelemetry.eventsError) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'telemetry-error';
        errorDiv.textContent = state.agentsTelemetry.eventsError;
        panel.appendChild(errorDiv);
    }

    // Loading state
    if (state.agentsTelemetry.eventsLoading) {
        var loadingDiv = document.createElement('div');
        loadingDiv.className = 'telemetry-loading';
        loadingDiv.textContent = 'Loading telemetry events...';
        panel.appendChild(loadingDiv);
        return panel;
    }

    // Events table
    var table = document.createElement('table');
    table.className = 'telemetry-table';

    var thead = document.createElement('thead');
    thead.innerHTML = '<tr>' +
        '<th>Time</th>' +
        '<th>Source</th>' +
        '<th>VTID</th>' +
        '<th>Stage</th>' +
        '<th>Provider</th>' +
        '<th>Model</th>' +
        '<th>Latency</th>' +
        '<th>Tokens</th>' +
        '<th>Cost</th>' +
        '<th>Fallback</th>' +
        '<th>Status</th>' +
        '</tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var events = state.agentsTelemetry.events || [];

    if (events.length === 0) {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="11" class="telemetry-empty">No telemetry events found for the selected filters.</td>';
        tbody.appendChild(emptyRow);
    } else {
        events.forEach(function(ev) {
            var row = document.createElement('tr');
            row.className = ev.error_code ? 'telemetry-row-error' : 'telemetry-row-ok';

            var time = ev.created_at ? new Date(ev.created_at).toLocaleTimeString() : '-';
            // VTID-01208: Determine source from service field
            var source = 'Unknown';
            var sourceClass = 'unknown';
            if (ev.service === 'orb-assistant') {
                source = 'ORB';
                sourceClass = 'orb';
            } else if (ev.service === 'gemini-operator' || ev.service === 'operator') {
                source = 'Operator';
                sourceClass = 'operator';
            } else if (ev.service) {
                source = ev.service;
            }
            var vtid = ev.vtid || '-';
            var stage = ev.stage || '-';
            var provider = ev.provider || '-';
            var model = ev.model ? ev.model.replace('claude-3-5-sonnet-20241022', 'claude-3.5-sonnet').replace('gemini-1.5-', 'gem-1.5-') : '-';
            var latency = ev.latency_ms ? ev.latency_ms + 'ms' : '-';
            var tokens = (ev.input_tokens || 0) + '/' + (ev.output_tokens || 0);
            var cost = ev.cost_estimate_usd ? '$' + ev.cost_estimate_usd.toFixed(4) : '-';
            var fallback = ev.fallback_used ? 'Y' : 'N';
            var status = ev.error_code ? 'Error' : 'OK';

            row.innerHTML = '<td>' + time + '</td>' +
                '<td><span class="telemetry-source-badge telemetry-source-' + sourceClass + '">' + source + '</span></td>' +
                '<td class="telemetry-vtid">' + vtid + '</td>' +
                '<td><span class="telemetry-stage-badge telemetry-stage-' + stage + '">' + stage + '</span></td>' +
                '<td>' + provider + '</td>' +
                '<td class="telemetry-model">' + model + '</td>' +
                '<td>' + latency + '</td>' +
                '<td>' + tokens + '</td>' +
                '<td>' + cost + '</td>' +
                '<td class="telemetry-fallback-' + (ev.fallback_used ? 'yes' : 'no') + '">' + fallback + '</td>' +
                '<td class="telemetry-status-' + (ev.error_code ? 'error' : 'ok') + '">' + status + '</td>';

            tbody.appendChild(row);
        });
    }

    table.appendChild(tbody);
    panel.appendChild(table);

    // Stats
    var stats = document.createElement('div');
    stats.className = 'telemetry-stats';
    stats.textContent = 'Showing ' + events.length + ' events';
    panel.appendChild(stats);

    // VTID-01211: Load More button
    if (state.agentsTelemetry.pagination.hasMore || state.agentsTelemetry.eventsLoading) {
        var loadMoreContainer = document.createElement('div');
        loadMoreContainer.className = 'load-more-container';

        var loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more-btn' + (state.agentsTelemetry.eventsLoading ? ' loading' : '');
        loadMoreBtn.disabled = state.agentsTelemetry.eventsLoading;
        loadMoreBtn.textContent = state.agentsTelemetry.eventsLoading ? 'Loading...' : 'Load More';
        loadMoreBtn.onclick = function() {
            loadMoreTelemetryEvents();
        };

        loadMoreContainer.appendChild(loadMoreBtn);
        panel.appendChild(loadMoreContainer);
    }

    return panel;
}

/**
 * VTID-01208: Render the Routing Policy panel
 */
function renderTelemetryRoutingPanel() {
    var panel = document.createElement('div');
    panel.className = 'telemetry-routing-panel';

    // Error message
    if (state.agentsTelemetry.policyError) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'telemetry-error';
        errorDiv.textContent = state.agentsTelemetry.policyError;
        panel.appendChild(errorDiv);
    }

    // Loading state
    if (state.agentsTelemetry.policyLoading) {
        var loadingDiv = document.createElement('div');
        loadingDiv.className = 'telemetry-loading';
        loadingDiv.textContent = 'Loading routing policy...';
        panel.appendChild(loadingDiv);
        return panel;
    }

    var policy = state.agentsTelemetry.policy;
    var recommended = state.agentsTelemetry.recommended;

    // Policy info
    var infoDiv = document.createElement('div');
    infoDiv.className = 'routing-policy-info';
    if (policy) {
        infoDiv.innerHTML = '<strong>Active Policy:</strong> v' + policy.version + ' (' + (policy.environment || 'DEV') + ')' +
            '<br><small>Activated: ' + (policy.activated_at ? new Date(policy.activated_at).toLocaleString() : 'N/A') + '</small>';
    } else {
        infoDiv.innerHTML = '<strong>No active policy</strong> - using safe defaults';
    }
    panel.appendChild(infoDiv);

    // Policy table
    var table = document.createElement('table');
    table.className = 'routing-policy-table';

    var thead = document.createElement('thead');
    thead.innerHTML = '<tr>' +
        '<th>Stage</th>' +
        '<th>Primary Provider</th>' +
        '<th>Primary Model</th>' +
        '<th>Fallback Provider</th>' +
        '<th>Fallback Model</th>' +
        '</tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var stages = ['planner', 'worker', 'validator', 'operator', 'memory'];
    var policyData = policy ? policy.policy : recommended;

    stages.forEach(function(stage) {
        var config = policyData ? policyData[stage] : null;
        var recConfig = recommended ? recommended[stage] : null;
        var row = document.createElement('tr');

        var stageName = stage.charAt(0).toUpperCase() + stage.slice(1);
        var primaryProvider = config ? config.primary_provider : '-';
        var primaryModel = config ? config.primary_model : '-';
        var fallbackProvider = config ? config.fallback_provider : '-';
        var fallbackModel = config ? config.fallback_model : '-';

        // Check if non-recommended
        var primaryNonRec = recConfig && config && (config.primary_provider !== recConfig.primary_provider || config.primary_model !== recConfig.primary_model);
        var fallbackNonRec = recConfig && config && (config.fallback_provider !== recConfig.fallback_provider || config.fallback_model !== recConfig.fallback_model);

        row.innerHTML = '<td><strong>' + stageName + '</strong></td>' +
            '<td>' + primaryProvider + '</td>' +
            '<td class="' + (primaryNonRec ? 'routing-non-recommended' : '') + '">' + formatModelName(primaryModel) + '</td>' +
            '<td>' + fallbackProvider + '</td>' +
            '<td class="' + (fallbackNonRec ? 'routing-non-recommended' : '') + '">' + formatModelName(fallbackModel) + '</td>';

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    panel.appendChild(table);

    // Action buttons
    var actions = document.createElement('div');
    actions.className = 'routing-policy-actions';

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-secondary';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = function() {
        state.agentsTelemetry.policyFetched = false;
        fetchLLMRoutingPolicy();
    };
    actions.appendChild(refreshBtn);

    panel.appendChild(actions);

    // Recommended defaults
    if (recommended) {
        var recSection = document.createElement('div');
        recSection.className = 'routing-recommended-section';

        var recTitle = document.createElement('h4');
        recTitle.textContent = 'Safe Defaults (Recommended)';
        recSection.appendChild(recTitle);

        var recPre = document.createElement('pre');
        recPre.className = 'routing-recommended-json';
        recPre.textContent = JSON.stringify(recommended, null, 2);
        recSection.appendChild(recPre);

        panel.appendChild(recSection);
    }

    return panel;
}

/**
 * VTID-01208: Format model name for display
 */
function formatModelName(model) {
    if (!model) return '-';
    return model
        .replace('claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet')
        .replace('claude-3-opus-20240229', 'Claude 3 Opus')
        .replace('gemini-2.5-pro', 'Gemini 2.5 Pro')
        .replace('gemini-1.5-pro', 'Gemini 1.5 Pro')
        .replace('gemini-1.5-flash', 'Gemini 1.5 Flash');
}

/**
 * VTID-0401: Sorts governance rules by the specified column.
 */
function sortGovernanceRules(column) {
    if (state.governanceRulesSortColumn === column) {
        // Toggle direction
        state.governanceRulesSortDirection = state.governanceRulesSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        state.governanceRulesSortColumn = column;
        state.governanceRulesSortDirection = 'asc';
    }
    renderApp();
}

/**
 * VTID-0401: Returns sorted and filtered governance rules.
 */
function getFilteredGovernanceRules() {
    let rules = [...state.governanceRules];

    // Apply search filter (VTID-0405: extended to include description)
    if (state.governanceRulesSearchQuery) {
        const query = state.governanceRulesSearchQuery.toLowerCase();
        rules = rules.filter(r =>
            r.id.toLowerCase().includes(query) ||
            r.title.toLowerCase().includes(query) ||
            (r.description && r.description.toLowerCase().includes(query))
        );
    }

    // Apply level filter
    if (state.governanceRulesLevelFilter) {
        rules = rules.filter(r => r.level === state.governanceRulesLevelFilter);
    }

    // Apply category filter
    if (state.governanceRulesCategoryFilter) {
        rules = rules.filter(r => r.domain === state.governanceRulesCategoryFilter);
    }

    // VTID-0405: Apply source filter (SYSTEM/CATALOG)
    if (state.governanceRulesSourceFilter) {
        rules = rules.filter(r => r.source === state.governanceRulesSourceFilter);
    }

    // Apply sorting
    const col = state.governanceRulesSortColumn;
    const dir = state.governanceRulesSortDirection === 'asc' ? 1 : -1;

    rules.sort((a, b) => {
        let aVal = a[col] || '';
        let bVal = b[col] || '';
        if (typeof aVal === 'string') aVal = aVal.toLowerCase();
        if (typeof bVal === 'string') bVal = bVal.toLowerCase();
        if (aVal < bVal) return -1 * dir;
        if (aVal > bVal) return 1 * dir;
        return 0;
    });

    return rules;
}

/**
 * VTID-0401: Renders the Governance Rules catalog view.
 */
function renderGovernanceRulesView() {
    const container = document.createElement('div');
    container.className = 'governance-rules-container';

    // Auto-fetch governance rules if not loaded and not currently loading
    if (state.governanceRules.length === 0 && !state.governanceRulesLoading && !state.governanceRulesError) {
        fetchGovernanceRules();
    }

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'governance-rules-toolbar';

    // Search input
    const search = document.createElement('input');
    search.className = 'search-field governance-rules-search';
    search.placeholder = 'Search rules by ID or title...';
    search.value = state.governanceRulesSearchQuery;
    search.oninput = (e) => {
        state.governanceRulesSearchQuery = e.target.value;
        renderApp();
    };
    toolbar.appendChild(search);

    // Level filter - static options per VTID-0401-B spec
    const levelSelect = document.createElement('select');
    levelSelect.className = 'form-control governance-filter-select';
    levelSelect.setAttribute('autocomplete', 'off');
    levelSelect.setAttribute('data-lpignore', 'true'); // LastPass ignore
    levelSelect.name = 'governance-level-filter-' + Date.now(); // Unique name prevents autofill
    levelSelect.innerHTML = '<option value="">All Levels</option>' +
        '<option value="L1">L1 (Critical)</option>' +
        '<option value="L2">L2 (Standard)</option>' +
        '<option value="L3">L3 (Structural)</option>' +
        '<option value="L4">L4 (Autonomy / Agents)</option>';
    // Set value based on state - empty string means "All Levels"
    levelSelect.value = state.governanceRulesLevelFilter || '';
    levelSelect.onchange = (e) => {
        state.governanceRulesLevelFilter = e.target.value;
        renderApp();
    };
    toolbar.appendChild(levelSelect);

    // Category/Domain filter - static options per VTID-0401-B spec
    // Using 6 canonical categories from specs/governance/rules.json
    const categorySelect = document.createElement('select');
    categorySelect.className = 'form-control governance-filter-select';
    categorySelect.setAttribute('autocomplete', 'off');
    categorySelect.setAttribute('data-lpignore', 'true'); // LastPass ignore
    categorySelect.name = 'governance-category-filter-' + Date.now(); // Unique name prevents autofill
    categorySelect.innerHTML = '<option value="">All Categories</option>' +
        '<option value="MIGRATION">Migration Governance</option>' +
        '<option value="FRONTEND">Frontend Governance</option>' +
        '<option value="CICD">CI/CD Governance</option>' +
        '<option value="DB">Database Governance</option>' +
        '<option value="AGENT">Agent Governance</option>' +
        '<option value="API">API Governance</option>';
    // Set value based on state - empty string means "All Categories"
    categorySelect.value = state.governanceRulesCategoryFilter || '';
    categorySelect.onchange = (e) => {
        state.governanceRulesCategoryFilter = e.target.value;
        renderApp();
    };
    toolbar.appendChild(categorySelect);

    // VTID-0405: Source/Family filter (SYSTEM vs CATALOG)
    const sourceSelect = document.createElement('select');
    sourceSelect.className = 'form-control governance-filter-select';
    sourceSelect.setAttribute('autocomplete', 'off');
    sourceSelect.setAttribute('data-lpignore', 'true');
    sourceSelect.name = 'governance-source-filter-' + Date.now();
    sourceSelect.innerHTML = '<option value="">All Sources</option>' +
        '<option value="SYSTEM">System Rules</option>' +
        '<option value="CATALOG">Catalog Rules</option>';
    sourceSelect.value = state.governanceRulesSourceFilter || '';
    sourceSelect.onchange = (e) => {
        state.governanceRulesSourceFilter = e.target.value;
        renderApp();
    };
    toolbar.appendChild(sourceSelect);

    // Spacer
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // Rule count
    const filteredRules = getFilteredGovernanceRules();
    const countLabel = document.createElement('span');
    countLabel.className = 'governance-rules-count';
    countLabel.textContent = filteredRules.length + ' of ' + state.governanceRules.length + ' rules';
    toolbar.appendChild(countLabel);

    // SPEC-01: Per-view refresh buttons removed - use global refresh icon in header

    container.appendChild(toolbar);

    // Loading state
    if (state.governanceRulesLoading) {
        const loading = document.createElement('div');
        loading.className = 'governance-rules-loading';
        loading.innerHTML = '<div class="skeleton-table">' +
            '<div class="skeleton-row"></div>'.repeat(10) +
            '</div>';
        container.appendChild(loading);
        return container;
    }

    // Error state
    if (state.governanceRulesError) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'governance-rules-error';
        errorDiv.innerHTML = '<span class="error-icon">⚠</span> Error loading rules: ' + state.governanceRulesError;
        container.appendChild(errorDiv);
        return container;
    }

    // Table
    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'governance-rules-table-wrapper';

    const table = document.createElement('table');
    table.className = 'governance-rules-table';

    // Table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const columns = [
        { key: 'id', label: 'Rule ID', sortable: true },
        { key: 'level', label: 'Level', sortable: true },
        { key: 'domain', label: 'Domain', sortable: true },
        { key: 'title', label: 'Title', sortable: true },
        { key: 'status', label: 'Status', sortable: true },
        { key: 'vtids', label: 'VTIDs', sortable: false },
        { key: 'updated_at', label: 'Updated', sortable: true }
    ];

    columns.forEach(col => {
        const th = document.createElement('th');
        th.className = col.sortable ? 'sortable' : '';
        if (col.sortable) {
            th.onclick = () => sortGovernanceRules(col.key);
            const sortIndicator = state.governanceRulesSortColumn === col.key
                ? (state.governanceRulesSortDirection === 'asc' ? ' ↑' : ' ↓')
                : '';
            th.textContent = col.label + sortIndicator;
        } else {
            th.textContent = col.label;
        }
        headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = document.createElement('tbody');

    filteredRules.forEach(rule => {
        const row = document.createElement('tr');
        row.className = 'governance-rule-row';
        row.onclick = () => {
            state.selectedGovernanceRule = rule;
            renderApp();
        };

        // Rule ID
        const idCell = document.createElement('td');
        idCell.className = 'rule-id-cell';
        idCell.textContent = rule.id;
        row.appendChild(idCell);

        // Level with badge
        const levelCell = document.createElement('td');
        const levelBadge = document.createElement('span');
        levelBadge.className = 'level-badge level-' + rule.level.toLowerCase();
        levelBadge.textContent = rule.level;
        levelCell.appendChild(levelBadge);
        row.appendChild(levelCell);

        // Domain
        const domainCell = document.createElement('td');
        domainCell.className = 'domain-cell';
        domainCell.textContent = rule.domain;
        row.appendChild(domainCell);

        // Title
        const titleCell = document.createElement('td');
        titleCell.className = 'title-cell';
        titleCell.textContent = rule.title;
        row.appendChild(titleCell);

        // Status with badge
        const statusCell = document.createElement('td');
        const statusBadge = document.createElement('span');
        statusBadge.className = 'status-badge status-' + rule.status.toLowerCase();
        statusBadge.textContent = rule.status.charAt(0).toUpperCase() + rule.status.slice(1);
        statusCell.appendChild(statusBadge);
        row.appendChild(statusCell);

        // VTIDs
        const vtidsCell = document.createElement('td');
        vtidsCell.className = 'vtids-cell';
        if (rule.vtids && rule.vtids.length > 0) {
            vtidsCell.innerHTML = rule.vtids.slice(0, 2).map(v =>
                '<span class="vtid-chip">' + v + '</span>'
            ).join('');
            if (rule.vtids.length > 2) {
                vtidsCell.innerHTML += '<span class="vtid-more">+' + (rule.vtids.length - 2) + '</span>';
            }
        } else {
            vtidsCell.textContent = '-';
        }
        row.appendChild(vtidsCell);

        // Updated
        const updatedCell = document.createElement('td');
        updatedCell.className = 'updated-cell';
        updatedCell.textContent = formatRelativeDate(rule.updated_at);
        row.appendChild(updatedCell);

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    container.appendChild(tableWrapper);

    return container;
}

/**
 * VTID-0401: Renders the rule detail sheet/drawer.
 */
function renderGovernanceRuleDetailDrawer() {
    const drawer = document.createElement('div');
    drawer.className = 'governance-rule-drawer ' + (state.selectedGovernanceRule ? 'open' : '');

    if (!state.selectedGovernanceRule) return drawer;

    const rule = state.selectedGovernanceRule;

    // Header
    const header = document.createElement('div');
    header.className = 'drawer-header';

    const title = document.createElement('h2');
    title.className = 'drawer-title-text';
    title.textContent = rule.id;
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        state.selectedGovernanceRule = null;
        renderApp();
    };
    header.appendChild(closeBtn);

    drawer.appendChild(header);

    // Content
    const content = document.createElement('div');
    content.className = 'drawer-content';

    // Rule metadata
    const metaSection = document.createElement('div');
    metaSection.className = 'rule-detail-meta';

    const levelBadge = document.createElement('span');
    levelBadge.className = 'level-badge level-' + rule.level.toLowerCase();
    levelBadge.textContent = rule.level;
    metaSection.appendChild(levelBadge);

    const statusBadge = document.createElement('span');
    statusBadge.className = 'status-badge status-' + rule.status.toLowerCase();
    statusBadge.textContent = rule.status.charAt(0).toUpperCase() + rule.status.slice(1);
    metaSection.appendChild(statusBadge);

    const domainBadge = document.createElement('span');
    domainBadge.className = 'domain-badge';
    domainBadge.textContent = rule.domain;
    metaSection.appendChild(domainBadge);

    content.appendChild(metaSection);

    // Title
    const titleSection = document.createElement('div');
    titleSection.className = 'rule-detail-section';
    titleSection.innerHTML = '<h3>Title</h3><p>' + escapeHtml(rule.title) + '</p>';
    content.appendChild(titleSection);

    // Description
    const descSection = document.createElement('div');
    descSection.className = 'rule-detail-section';
    descSection.innerHTML = '<h3>Description</h3><p>' + escapeHtml(rule.description) + '</p>';
    content.appendChild(descSection);

    // Category
    const categorySection = document.createElement('div');
    categorySection.className = 'rule-detail-section';
    categorySection.innerHTML = '<h3>Category</h3><p>' + escapeHtml(rule.category) + '</p>';
    content.appendChild(categorySection);

    // VTID-0405: Source/Family (SYSTEM vs CATALOG)
    const sourceSection = document.createElement('div');
    sourceSection.className = 'rule-detail-section';
    const sourceValue = rule.source || 'CATALOG';
    const sourceLabel = sourceValue === 'SYSTEM' ? 'System Rule' : 'Catalog Rule';
    sourceSection.innerHTML = '<h3>Source</h3><p><span class="source-badge source-' + sourceValue.toLowerCase() + '">' + sourceLabel + '</span></p>';
    content.appendChild(sourceSection);

    // VTID-0405: Enforcement Semantics based on level
    const enforcementSemanticsSection = document.createElement('div');
    enforcementSemanticsSection.className = 'rule-detail-section';
    let enforcementSemantics = '';
    let enforcementClass = '';
    switch (rule.level) {
        case 'L1':
            enforcementSemantics = 'Hard block — always denies. This rule cannot be bypassed and will block any violating action.';
            enforcementClass = 'enforcement-hard';
            break;
        case 'L2':
            enforcementSemantics = 'Soft block — denies unless override (future). This rule blocks by default but may support authorized overrides.';
            enforcementClass = 'enforcement-soft';
            break;
        case 'L3':
            enforcementSemantics = 'Informational — not blocking. This rule logs violations but does not prevent actions.';
            enforcementClass = 'enforcement-info';
            break;
        case 'L4':
            enforcementSemantics = 'Informational — not blocking. Advisory rule for agent autonomy guidance.';
            enforcementClass = 'enforcement-info';
            break;
        default:
            enforcementSemantics = 'Unknown enforcement level.';
            enforcementClass = 'enforcement-info';
    }
    enforcementSemanticsSection.innerHTML = '<h3>Enforcement Semantics</h3><div class="enforcement-semantics ' + enforcementClass + '">' + enforcementSemantics + '</div>';
    content.appendChild(enforcementSemanticsSection);

    // VTIDs
    if (rule.vtids && rule.vtids.length > 0) {
        const vtidsSection = document.createElement('div');
        vtidsSection.className = 'rule-detail-section';
        vtidsSection.innerHTML = '<h3>Linked VTIDs</h3><div class="vtid-chips">' +
            rule.vtids.map(v => '<span class="vtid-chip">' + escapeHtml(v) + '</span>').join('') +
            '</div>';
        content.appendChild(vtidsSection);
    }

    // Sources
    if (rule.sources && rule.sources.length > 0) {
        const sourcesSection = document.createElement('div');
        sourcesSection.className = 'rule-detail-section';
        sourcesSection.innerHTML = '<h3>Sources</h3><ul class="sources-list">' +
            rule.sources.map(s => '<li><code>' + escapeHtml(s) + '</code></li>').join('') +
            '</ul>';
        content.appendChild(sourcesSection);
    }

    // Enforcement
    if (rule.enforcement && rule.enforcement.length > 0) {
        const enforcementSection = document.createElement('div');
        enforcementSection.className = 'rule-detail-section';
        enforcementSection.innerHTML = '<h3>Enforcement</h3><div class="enforcement-chips">' +
            rule.enforcement.map(e => '<span class="enforcement-chip">' + escapeHtml(e) + '</span>').join('') +
            '</div>';
        content.appendChild(enforcementSection);
    }

    // VTID-0405: Created At
    const createdSection = document.createElement('div');
    createdSection.className = 'rule-detail-section';
    createdSection.innerHTML = '<h3>Created</h3><p>' + formatRelativeDate(rule.created_at) + '</p>';
    content.appendChild(createdSection);

    // Updated
    const updatedSection = document.createElement('div');
    updatedSection.className = 'rule-detail-section';
    updatedSection.innerHTML = '<h3>Last Updated</h3><p>' + formatRelativeDate(rule.updated_at) + '</p>';
    content.appendChild(updatedSection);

    drawer.appendChild(content);

    return drawer;
}

/**
 * Helper: Format relative date.
 */
function formatRelativeDate(dateStr) {
    if (!dateStr) return '-';
    try {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return diffDays + ' days ago';
        if (diffDays < 30) return Math.floor(diffDays / 7) + ' weeks ago';
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
        return dateStr;
    }
}

/**
 * Helper: Escape HTML to prevent XSS.
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- VTID-0406: Governance Evaluations Viewer (OASIS Integration) ---

/**
 * VTID-0406: Fetches governance evaluation events from OASIS.
 * Populates state.governanceEvaluations with the evaluation data.
 */
async function fetchGovernanceEvaluations() {
    state.governanceEvaluationsLoading = true;
    state.governanceEvaluationsFetched = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/governance/evaluations');
        const json = await response.json();

        if (json.ok && json.data) {
            state.governanceEvaluations = json.data;
            state.governanceEvaluationsError = null;
            console.log('[VTID-0406] Governance evaluations loaded:', json.count, 'evaluations');
        } else {
            throw new Error(json.error || 'Failed to load governance evaluations');
        }
    } catch (error) {
        console.error('[VTID-0406] Failed to fetch governance evaluations:', error);
        state.governanceEvaluationsError = error.message;
        state.governanceEvaluations = [];
    }
    state.governanceEvaluationsLoading = false;
    renderApp();
}

/**
 * VTID-0406: Returns filtered governance evaluations based on result filter.
 */
function getFilteredGovernanceEvaluations() {
    var evals = state.governanceEvaluations.slice();

    // Filter by result (allow/deny)
    if (state.governanceEvaluationsResultFilter) {
        var isAllow = state.governanceEvaluationsResultFilter === 'allow';
        evals = evals.filter(function(ev) { return ev.allow === isAllow; });
    }

    return evals;
}

/**
 * VTID-0406: Renders the Governance Evaluations viewer.
 */
function renderGovernanceEvaluationsView() {
    var container = document.createElement('div');
    container.className = 'gov-evals-container';

    // Auto-fetch evaluations if not yet fetched and not currently loading
    if (!state.governanceEvaluationsFetched && !state.governanceEvaluationsLoading) {
        fetchGovernanceEvaluations();
    }

    // Toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'gov-evals-toolbar';

    // Result filter
    var resultSelect = document.createElement('select');
    resultSelect.className = 'form-control governance-filter-select';
    resultSelect.autocomplete = 'off';
    resultSelect.name = 'gov-evals-result-filter-' + Date.now();
    resultSelect.innerHTML =
        '<option value="">All Results</option>' +
        '<option value="allow">Allow</option>' +
        '<option value="deny">Deny</option>';
    resultSelect.value = state.governanceEvaluationsResultFilter || '';
    resultSelect.onchange = function(e) {
        state.governanceEvaluationsResultFilter = e.target.value;
        renderApp();
    };
    toolbar.appendChild(resultSelect);

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // Count label
    var filteredEvals = getFilteredGovernanceEvaluations();
    var countLabel = document.createElement('span');
    countLabel.className = 'gov-evals-count';
    countLabel.textContent = filteredEvals.length + ' of ' + state.governanceEvaluations.length + ' evaluations';
    toolbar.appendChild(countLabel);

    // Refresh button
    // SPEC-01: Per-view refresh buttons removed - use global refresh icon in header

    container.appendChild(toolbar);

    // Loading state
    if (state.governanceEvaluationsLoading) {
        var loading = document.createElement('div');
        loading.className = 'gov-evals-loading';
        loading.innerHTML = '<div class="skeleton-table">' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '</div>';
        container.appendChild(loading);
        return container;
    }

    // Error state
    if (state.governanceEvaluationsError) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'gov-evals-error';
        errorDiv.innerHTML = '<span class="error-icon">⚠</span> Error loading evaluations: ' + state.governanceEvaluationsError;
        container.appendChild(errorDiv);
        return container;
    }

    // Empty state
    if (filteredEvals.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'gov-evals-empty';
        emptyDiv.innerHTML = '<p>No governance evaluations found.</p>' +
            '<p class="gov-evals-empty-hint">Evaluations will appear here when the GovernanceEvaluator processes requests.</p>';
        container.appendChild(emptyDiv);
        return container;
    }

    // Table wrapper
    var tableWrapper = document.createElement('div');
    tableWrapper.className = 'gov-evals-table-wrapper';

    // Table
    var table = document.createElement('table');
    table.className = 'gov-evals-table';

    // Table header
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['Timestamp', 'Action', 'Service', 'Env', 'Result', 'Violated Rules'];
    headers.forEach(function(headerText) {
        var th = document.createElement('th');
        th.textContent = headerText;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    var tbody = document.createElement('tbody');
    filteredEvals.forEach(function(evalItem) {
        var row = document.createElement('tr');
        row.className = 'gov-eval-row';

        // Timestamp
        var timestampTd = document.createElement('td');
        timestampTd.className = 'gov-eval-timestamp';
        timestampTd.textContent = formatEvalTimestamp(evalItem.created_at);
        row.appendChild(timestampTd);

        // Action
        var actionTd = document.createElement('td');
        actionTd.className = 'gov-eval-action';
        actionTd.textContent = evalItem.action;
        row.appendChild(actionTd);

        // Service
        var serviceTd = document.createElement('td');
        serviceTd.className = 'gov-eval-service';
        serviceTd.textContent = evalItem.service;
        row.appendChild(serviceTd);

        // Environment
        var envTd = document.createElement('td');
        envTd.className = 'gov-eval-env';
        envTd.textContent = evalItem.environment;
        row.appendChild(envTd);

        // Result (Allow/Deny)
        var resultTd = document.createElement('td');
        var resultBadge = document.createElement('span');
        resultBadge.className = evalItem.allow ? 'gov-eval-allow' : 'gov-eval-deny';
        resultBadge.textContent = evalItem.allow ? 'Allow' : 'Deny';
        resultTd.appendChild(resultBadge);
        row.appendChild(resultTd);

        // Violated Rules (chips)
        var rulesTd = document.createElement('td');
        rulesTd.className = 'gov-eval-rules';
        if (evalItem.violated_rules && evalItem.violated_rules.length > 0) {
            evalItem.violated_rules.forEach(function(rule) {
                var chip = document.createElement('span');
                chip.className = 'gov-rule-chip gov-rule-chip-' + rule.level.toLowerCase();
                chip.innerHTML = '<span class="gov-rule-chip-id">' + escapeHtml(rule.rule_id) + '</span>' +
                    '<span class="gov-rule-chip-level">' + rule.level + '</span>';
                chip.title = rule.domain + ' - ' + rule.level;
                // VTID-0406: Click chip to open Rule Detail Drawer from VTID-0405
                chip.onclick = function(e) {
                    e.stopPropagation();
                    openRuleDetailByCode(rule.rule_id);
                };
                rulesTd.appendChild(chip);
            });
        } else {
            rulesTd.innerHTML = '<span class="gov-eval-no-violations">—</span>';
        }
        row.appendChild(rulesTd);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    container.appendChild(tableWrapper);

    return container;
}

/**
 * VTID-0406: Format timestamp for evaluation display.
 */
function formatEvalTimestamp(dateStr) {
    if (!dateStr) return '-';
    try {
        var date = new Date(dateStr);
        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch (e) {
        return dateStr;
    }
}

/**
 * VTID-0406: Opens the Rule Detail Drawer for a specific rule code.
 * Links to VTID-0405 Rule Detail Drawer functionality.
 */
function openRuleDetailByCode(ruleCode) {
    // Find the rule in the loaded governance rules
    var rule = state.governanceRules.find(function(r) {
        return r.id === ruleCode;
    });

    if (rule) {
        state.selectedGovernanceRule = rule;
        renderApp();
    } else {
        // If rules aren't loaded, fetch them first then try again
        console.log('[VTID-0406] Rule not in cache, fetching rules first:', ruleCode);
        fetchGovernanceRules().then(function() {
            var foundRule = state.governanceRules.find(function(r) {
                return r.id === ruleCode;
            });
            if (foundRule) {
                state.selectedGovernanceRule = foundRule;
                renderApp();
            } else {
                console.warn('[VTID-0406] Rule not found:', ruleCode);
            }
        });
    }
}

// --- VTID-0408: Governance History Timeline ---

/**
 * VTID-0408: Fetches governance history events from OASIS.
 * Populates state.governanceHistory with the event data.
 */
async function fetchGovernanceHistory() {
    state.governanceHistory.loading = true;
    state.governanceHistory.fetched = true;
    renderApp();

    try {
        // Build query string from filters and pagination
        var params = new URLSearchParams();
        params.append('limit', state.governanceHistory.pagination.limit.toString());
        params.append('offset', state.governanceHistory.pagination.offset.toString());

        if (state.governanceHistory.filters.type !== 'all') {
            params.append('type', state.governanceHistory.filters.type);
        }
        if (state.governanceHistory.filters.level !== 'all') {
            params.append('level', state.governanceHistory.filters.level);
        }
        if (state.governanceHistory.filters.actor !== 'all') {
            params.append('actor', state.governanceHistory.filters.actor);
        }

        var response = await fetch('/api/v1/governance/history?' + params.toString());
        var json = await response.json();

        if (json.ok && json.events) {
            state.governanceHistory.items = json.events;
            state.governanceHistory.pagination.hasMore = json.pagination.has_more;
            state.governanceHistory.error = null;
            console.log('[VTID-0408] Governance history loaded:', json.events.length, 'events');
        } else {
            throw new Error(json.error || 'Failed to load governance history');
        }
    } catch (error) {
        console.warn('[VTID-0408] Governance history fetch error:', error);
        state.governanceHistory.error = error.message;
        state.governanceHistory.items = [];
    }
    state.governanceHistory.loading = false;
    renderApp();
}

/**
 * VTID-0408: Renders the Governance History viewer.
 */
function renderGovernanceHistoryView() {
    var container = document.createElement('div');
    container.className = 'gov-history-container';

    // Auto-fetch history if not yet fetched and not currently loading
    if (!state.governanceHistory.fetched && !state.governanceHistory.loading) {
        fetchGovernanceHistory();
    }

    // Toolbar with filters
    var toolbar = document.createElement('div');
    toolbar.className = 'gov-history-toolbar';

    // Event Type filter
    var typeSelect = document.createElement('select');
    typeSelect.className = 'form-control governance-filter-select';
    typeSelect.autocomplete = 'off';
    typeSelect.name = 'gov-history-type-filter-' + Date.now();
    typeSelect.innerHTML =
        '<option value="all">All Types</option>' +
        '<option value="governance.deploy.allowed">Deploy Allowed</option>' +
        '<option value="governance.deploy.blocked">Deploy Blocked</option>' +
        '<option value="governance.evaluate">Evaluate</option>' +
        '<option value="governance.rule.created">Rule Created</option>' +
        '<option value="governance.rule.updated">Rule Updated</option>';
    typeSelect.value = state.governanceHistory.filters.type;
    typeSelect.onchange = function(e) {
        state.governanceHistory.filters.type = e.target.value;
        state.governanceHistory.pagination.offset = 0;
        state.governanceHistory.fetched = false;
        fetchGovernanceHistory();
    };
    toolbar.appendChild(typeSelect);

    // Level filter
    var levelSelect = document.createElement('select');
    levelSelect.className = 'form-control governance-filter-select';
    levelSelect.autocomplete = 'off';
    levelSelect.name = 'gov-history-level-filter-' + Date.now();
    levelSelect.innerHTML =
        '<option value="all">All Levels</option>' +
        '<option value="L1">L1</option>' +
        '<option value="L2">L2</option>' +
        '<option value="L3">L3</option>' +
        '<option value="L4">L4</option>';
    levelSelect.value = state.governanceHistory.filters.level;
    levelSelect.onchange = function(e) {
        state.governanceHistory.filters.level = e.target.value;
        state.governanceHistory.pagination.offset = 0;
        state.governanceHistory.fetched = false;
        fetchGovernanceHistory();
    };
    toolbar.appendChild(levelSelect);

    // Actor filter
    var actorSelect = document.createElement('select');
    actorSelect.className = 'form-control governance-filter-select';
    actorSelect.autocomplete = 'off';
    actorSelect.name = 'gov-history-actor-filter-' + Date.now();
    actorSelect.innerHTML =
        '<option value="all">All Actors</option>' +
        '<option value="operator">Operator</option>' +
        '<option value="autopilot">Autopilot</option>' +
        '<option value="validator">Validator</option>' +
        '<option value="system">System</option>';
    actorSelect.value = state.governanceHistory.filters.actor;
    actorSelect.onchange = function(e) {
        state.governanceHistory.filters.actor = e.target.value;
        state.governanceHistory.pagination.offset = 0;
        state.governanceHistory.fetched = false;
        fetchGovernanceHistory();
    };
    toolbar.appendChild(actorSelect);

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // Count label
    var countLabel = document.createElement('span');
    countLabel.className = 'gov-history-count';
    countLabel.textContent = state.governanceHistory.items.length + ' events';
    toolbar.appendChild(countLabel);

    // Refresh button
    // SPEC-01: Per-view refresh buttons removed - use global refresh icon in header

    container.appendChild(toolbar);

    // Loading state
    if (state.governanceHistory.loading) {
        var loading = document.createElement('div');
        loading.className = 'gov-history-loading';
        loading.innerHTML = '<div class="skeleton-table">' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '</div>';
        container.appendChild(loading);
        return container;
    }

    // Error state
    if (state.governanceHistory.error) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'gov-history-error';
        errorDiv.innerHTML = '<span class="error-icon">⚠</span> Error loading history: ' + escapeHtml(state.governanceHistory.error);
        container.appendChild(errorDiv);
        return container;
    }

    // Empty state
    if (state.governanceHistory.items.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'gov-history-empty';
        emptyDiv.innerHTML = '<p>No governance history events found.</p>' +
            '<p class="gov-history-empty-hint">Events will appear here as governance actions are performed.</p>';
        container.appendChild(emptyDiv);
        return container;
    }

    // Table wrapper
    var tableWrapper = document.createElement('div');
    tableWrapper.className = 'gov-history-table-wrapper';

    // Table
    var table = document.createElement('table');
    table.className = 'gov-history-table';

    // Table header
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['Timestamp', 'Type', 'Level', 'Actor', 'Summary', ''];
    headers.forEach(function(headerText) {
        var th = document.createElement('th');
        th.textContent = headerText;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    var tbody = document.createElement('tbody');
    state.governanceHistory.items.forEach(function(event) {
        var row = document.createElement('tr');
        row.className = 'gov-history-row';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', 'View event details: ' + event.summary);

        // Timestamp
        var timestampTd = document.createElement('td');
        timestampTd.className = 'gov-history-timestamp';
        timestampTd.textContent = formatHistoryTimestamp(event.timestamp);
        row.appendChild(timestampTd);

        // Type (badge)
        var typeTd = document.createElement('td');
        var typeBadge = document.createElement('span');
        typeBadge.className = 'gov-history-type-badge ' + getHistoryTypeBadgeClass(event.type);
        typeBadge.textContent = formatHistoryType(event.type);
        typeTd.appendChild(typeBadge);
        row.appendChild(typeTd);

        // Level
        var levelTd = document.createElement('td');
        if (event.level) {
            var levelBadge = document.createElement('span');
            levelBadge.className = 'level-badge level-' + event.level.toLowerCase();
            levelBadge.textContent = event.level;
            levelTd.appendChild(levelBadge);
        } else {
            levelTd.innerHTML = '<span class="gov-history-no-level">—</span>';
        }
        row.appendChild(levelTd);

        // Actor
        var actorTd = document.createElement('td');
        actorTd.className = 'gov-history-actor';
        var actorBadge = document.createElement('span');
        actorBadge.className = 'gov-history-actor-badge gov-history-actor-' + event.actor;
        actorBadge.textContent = capitalizeFirst(event.actor);
        actorTd.appendChild(actorBadge);
        row.appendChild(actorTd);

        // Summary
        var summaryTd = document.createElement('td');
        summaryTd.className = 'gov-history-summary';
        summaryTd.textContent = event.summary;
        row.appendChild(summaryTd);

        // Details chevron
        var detailsTd = document.createElement('td');
        detailsTd.className = 'gov-history-details-cell';
        var chevron = document.createElement('span');
        chevron.className = 'gov-history-chevron';
        chevron.textContent = '›';
        detailsTd.appendChild(chevron);
        row.appendChild(detailsTd);

        // Click handler to open drawer
        row.onclick = function() {
            state.governanceHistory.selectedEvent = event;
            renderApp();
        };
        row.onkeydown = function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                state.governanceHistory.selectedEvent = event;
                renderApp();
            }
        };

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    container.appendChild(tableWrapper);

    // Load more button
    if (state.governanceHistory.pagination.hasMore) {
        var loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'btn gov-history-load-more';
        loadMoreBtn.textContent = 'Load More';
        loadMoreBtn.onclick = function() {
            state.governanceHistory.pagination.offset += state.governanceHistory.pagination.limit;
            fetchGovernanceHistory();
        };
        container.appendChild(loadMoreBtn);
    }

    // History Event Drawer
    if (state.governanceHistory.selectedEvent) {
        container.appendChild(renderGovernanceHistoryDrawer(state.governanceHistory.selectedEvent));
    }

    return container;
}

/**
 * VTID-0408: Renders the History Event Drawer.
 */
function renderGovernanceHistoryDrawer(event) {
    var drawer = document.createElement('div');
    drawer.className = 'gov-history-drawer open';

    // Header
    var header = document.createElement('div');
    header.className = 'gov-history-drawer-header';

    var title = document.createElement('h2');
    title.className = 'gov-history-drawer-title';
    title.textContent = formatHistoryType(event.type);
    header.appendChild(title);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.onclick = function() {
        state.governanceHistory.selectedEvent = null;
        renderApp();
    };
    header.appendChild(closeBtn);

    drawer.appendChild(header);

    // Drawer content
    var content = document.createElement('div');
    content.className = 'gov-history-drawer-content';

    // Timestamp
    var timestampSection = document.createElement('div');
    timestampSection.className = 'gov-history-drawer-section';
    timestampSection.innerHTML = '<h3>Timestamp</h3><p>' + formatHistoryTimestamp(event.timestamp) + '</p>';
    content.appendChild(timestampSection);

    // Meta badges (level, actor)
    var metaSection = document.createElement('div');
    metaSection.className = 'gov-history-drawer-meta';

    if (event.level) {
        var levelBadge = document.createElement('span');
        levelBadge.className = 'level-badge level-' + event.level.toLowerCase();
        levelBadge.textContent = event.level;
        metaSection.appendChild(levelBadge);
    }

    var actorBadge = document.createElement('span');
    actorBadge.className = 'gov-history-actor-badge gov-history-actor-' + event.actor;
    actorBadge.textContent = capitalizeFirst(event.actor);
    metaSection.appendChild(actorBadge);

    var typeBadge = document.createElement('span');
    typeBadge.className = 'gov-history-type-badge ' + getHistoryTypeBadgeClass(event.type);
    typeBadge.textContent = formatHistoryType(event.type);
    metaSection.appendChild(typeBadge);

    content.appendChild(metaSection);

    // Summary
    var summarySection = document.createElement('div');
    summarySection.className = 'gov-history-drawer-section';
    summarySection.innerHTML = '<h3>Summary</h3><p>' + escapeHtml(event.summary) + '</p>';
    content.appendChild(summarySection);

    // Rule IDs as chips (if present in details)
    if (event.details && event.details.violations && event.details.violations.length > 0) {
        var rulesSection = document.createElement('div');
        rulesSection.className = 'gov-history-drawer-section';
        rulesSection.innerHTML = '<h3>Violated Rules</h3>';

        var rulesContainer = document.createElement('div');
        rulesContainer.className = 'gov-history-rules-chips';

        event.details.violations.forEach(function(violation) {
            var chip = document.createElement('span');
            chip.className = 'gov-rule-chip gov-rule-chip-' + (violation.level || 'l2').toLowerCase();
            chip.innerHTML = '<span class="gov-rule-chip-id">' + escapeHtml(violation.rule_id) + '</span>' +
                '<span class="gov-rule-chip-level">' + (violation.level || 'L2') + '</span>';
            chip.title = violation.message || 'Click to view rule details';
            chip.onclick = function(e) {
                e.stopPropagation();
                openRuleDetailByCode(violation.rule_id);
            };
            rulesContainer.appendChild(chip);
        });

        rulesSection.appendChild(rulesContainer);
        content.appendChild(rulesSection);
    }

    // Service / VTID info
    if (event.details && (event.details.service || event.details.vtid)) {
        var contextSection = document.createElement('div');
        contextSection.className = 'gov-history-drawer-section';
        contextSection.innerHTML = '<h3>Context</h3>';

        var contextList = document.createElement('div');
        contextList.className = 'gov-history-context-list';

        if (event.details.vtid) {
            var vtidItem = document.createElement('div');
            vtidItem.className = 'gov-history-context-item';
            vtidItem.innerHTML = '<span class="label">VTID:</span><span class="value">' + escapeHtml(event.details.vtid) + '</span>';
            contextList.appendChild(vtidItem);
        }
        if (event.details.service) {
            var serviceItem = document.createElement('div');
            serviceItem.className = 'gov-history-context-item';
            serviceItem.innerHTML = '<span class="label">Service:</span><span class="value">' + escapeHtml(event.details.service) + '</span>';
            contextList.appendChild(serviceItem);
        }

        contextSection.appendChild(contextList);
        content.appendChild(contextSection);
    }

    // Raw JSON details
    var jsonSection = document.createElement('div');
    jsonSection.className = 'gov-history-drawer-section gov-history-json-section';
    jsonSection.innerHTML = '<h3>Raw Details</h3>';

    var jsonPre = document.createElement('pre');
    jsonPre.className = 'gov-history-json';
    jsonPre.textContent = JSON.stringify(event.details || {}, null, 2);
    jsonSection.appendChild(jsonPre);
    content.appendChild(jsonSection);

    drawer.appendChild(content);

    return drawer;
}

// --- VTID-0409: Governance Categories (Read-Only V1) ---

/**
 * VTID-0409: Fetches governance categories from the API.
 * Populates state.governanceCategories with category data including rules.
 */
async function fetchGovernanceCategories() {
    state.governanceCategories.loading = true;
    state.governanceCategories.fetched = true;
    state.governanceCategories.error = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/governance/categories');
        var json = await response.json();

        if (json.ok && json.categories) {
            state.governanceCategories.items = json.categories;

            // Auto-select first category if none selected
            if (!state.governanceCategories.selectedCategoryId && json.categories.length > 0) {
                state.governanceCategories.selectedCategoryId = json.categories[0].id;
            }

            console.log('[VTID-0409] Governance categories loaded:', json.categories.length, 'categories');
        } else {
            throw new Error(json.error || 'Failed to load governance categories');
        }
    } catch (error) {
        console.warn('[VTID-0409] Governance categories fetch error:', error);
        state.governanceCategories.error = error.message;
        state.governanceCategories.items = [];
    }

    state.governanceCategories.loading = false;
    renderApp();
}

/**
 * VTID-0409: Renders the Governance Categories view.
 * Two-column layout: left = category list, right = rules table for selected category.
 */
function renderGovernanceCategoriesView() {
    var container = document.createElement('div');
    container.className = 'gov-categories-container';

    // Auto-fetch categories if not yet fetched and not currently loading
    if (!state.governanceCategories.fetched && !state.governanceCategories.loading) {
        fetchGovernanceCategories();
    }

    // Loading state
    if (state.governanceCategories.loading) {
        var loading = document.createElement('div');
        loading.className = 'gov-categories-loading';
        loading.innerHTML = '<div class="skeleton-table">' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '</div>';
        container.appendChild(loading);
        return container;
    }

    // Error state
    if (state.governanceCategories.error) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'gov-categories-error';
        errorDiv.innerHTML = '<span class="error-icon">⚠</span> Error loading categories: ' + escapeHtml(state.governanceCategories.error);
        container.appendChild(errorDiv);
        return container;
    }

    // Empty state
    if (state.governanceCategories.items.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'gov-categories-empty';
        emptyDiv.innerHTML = '<p>No governance categories found.</p>' +
            '<p class="gov-categories-empty-hint">Categories will appear here as governance rules are added.</p>';
        container.appendChild(emptyDiv);
        return container;
    }

    // Two-column layout
    var layout = document.createElement('div');
    layout.className = 'gov-categories-layout';

    // Left column: category list
    var leftColumn = document.createElement('div');
    leftColumn.className = 'gov-categories-list';

    var selectedId = state.governanceCategories.selectedCategoryId;
    var selectedCategory = state.governanceCategories.items.find(function(c) {
        return c.id === selectedId;
    }) || state.governanceCategories.items[0];

    state.governanceCategories.items.forEach(function(cat) {
        var catBtn = document.createElement('button');
        catBtn.className = 'gov-category-item' + (cat.id === selectedCategory.id ? ' selected' : '');
        catBtn.setAttribute('role', 'option');
        catBtn.setAttribute('aria-selected', cat.id === selectedCategory.id ? 'true' : 'false');

        var labelDiv = document.createElement('div');
        labelDiv.className = 'gov-category-label';
        labelDiv.textContent = cat.label;
        catBtn.appendChild(labelDiv);

        var metaDiv = document.createElement('div');
        metaDiv.className = 'gov-category-meta';

        var countSpan = document.createElement('span');
        countSpan.className = 'gov-category-count';
        countSpan.textContent = cat.rule_count + ' rule' + (cat.rule_count !== 1 ? 's' : '');
        metaDiv.appendChild(countSpan);

        var levelsSpan = document.createElement('span');
        levelsSpan.className = 'gov-category-levels';
        levelsSpan.innerHTML =
            '<span class="lvl lvl-L1" title="L1 Critical">' + cat.levels.L1 + '</span>' +
            '<span class="lvl lvl-L2" title="L2 High">' + cat.levels.L2 + '</span>' +
            '<span class="lvl lvl-L3" title="L3 Medium">' + cat.levels.L3 + '</span>' +
            '<span class="lvl lvl-L4" title="L4 Low">' + cat.levels.L4 + '</span>';
        metaDiv.appendChild(levelsSpan);

        catBtn.appendChild(metaDiv);

        catBtn.onclick = function() {
            state.governanceCategories.selectedCategoryId = cat.id;
            renderApp();
        };

        leftColumn.appendChild(catBtn);
    });

    layout.appendChild(leftColumn);

    // Right column: rules table for selected category
    var rightColumn = document.createElement('div');
    rightColumn.className = 'gov-category-rules';

    // Category header
    var catHeader = document.createElement('div');
    catHeader.className = 'gov-category-header';

    var catTitle = document.createElement('h3');
    catTitle.className = 'gov-category-title';
    catTitle.textContent = selectedCategory.label;
    catHeader.appendChild(catTitle);

    var catCount = document.createElement('span');
    catCount.className = 'gov-category-rule-count';
    catCount.textContent = selectedCategory.rule_count + ' rule' + (selectedCategory.rule_count !== 1 ? 's' : '');
    catHeader.appendChild(catCount);

    rightColumn.appendChild(catHeader);

    // Rules table
    if (selectedCategory.rules && selectedCategory.rules.length > 0) {
        var tableWrapper = document.createElement('div');
        tableWrapper.className = 'gov-category-table-wrapper';

        var table = document.createElement('table');
        table.className = 'gov-category-rules-table';

        // Table header
        var thead = document.createElement('thead');
        thead.innerHTML =
            '<tr>' +
            '<th>Rule ID</th>' +
            '<th>Title</th>' +
            '<th>Level</th>' +
            '<th>Source</th>' +
            '<th></th>' +
            '</tr>';
        table.appendChild(thead);

        // Table body
        var tbody = document.createElement('tbody');
        selectedCategory.rules.forEach(function(rule) {
            var row = document.createElement('tr');
            row.className = 'gov-category-rule-row';
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-label', 'View rule details: ' + rule.rule_id);

            // Rule ID
            var idCell = document.createElement('td');
            idCell.className = 'gov-rule-id';
            idCell.textContent = rule.rule_id;
            row.appendChild(idCell);

            // Title
            var titleCell = document.createElement('td');
            titleCell.className = 'gov-rule-title';
            titleCell.textContent = rule.title;
            row.appendChild(titleCell);

            // Level badge
            var levelCell = document.createElement('td');
            levelCell.className = 'gov-rule-level-cell';
            var levelBadge = document.createElement('span');
            levelBadge.className = 'gov-rule-level lvl-' + rule.level;
            levelBadge.textContent = rule.level;
            levelCell.appendChild(levelBadge);
            row.appendChild(levelCell);

            // Source badge
            var sourceCell = document.createElement('td');
            sourceCell.className = 'gov-rule-source-cell';
            var sourceBadge = document.createElement('span');
            sourceBadge.className = 'gov-rule-source source-' + rule.source.toLowerCase();
            sourceBadge.textContent = rule.source;
            sourceCell.appendChild(sourceBadge);
            row.appendChild(sourceCell);

            // Chevron
            var chevronCell = document.createElement('td');
            chevronCell.className = 'gov-rule-chevron';
            chevronCell.innerHTML = '›';
            row.appendChild(chevronCell);

            // Click handler to open rule drawer
            row.onclick = function() {
                openRuleDetailByCode(rule.rule_id);
            };
            row.onkeydown = function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openRuleDetailByCode(rule.rule_id);
                }
            };

            tbody.appendChild(row);
        });

        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        rightColumn.appendChild(tableWrapper);
    } else {
        var noRules = document.createElement('div');
        noRules.className = 'gov-categories-empty';
        noRules.innerHTML = '<p>No rules in this category.</p>';
        rightColumn.appendChild(noRules);
    }

    layout.appendChild(rightColumn);
    container.appendChild(layout);

    return container;
}

// =============================================================================
// VTID-01181: Governance Controls - System Arming Panel
// =============================================================================

/**
 * VTID-01181: Fetch governance controls from API.
 */
async function fetchGovernanceControls() {
    state.governanceControls.loading = true;
    state.governanceControls.error = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/governance/controls', {
            method: 'GET',
            headers: buildContextHeaders()
        });

        var json = await response.json();

        if (!response.ok || !json.ok) {
            throw new Error(json.error || json.message || 'Failed to fetch controls');
        }

        state.governanceControls.items = json.data || [];
        state.governanceControls.fetched = true;
        console.log('[VTID-01181] Governance controls loaded:', state.governanceControls.items.length);
    } catch (error) {
        console.error('[VTID-01181] Failed to fetch governance controls:', error);
        state.governanceControls.error = error.message;
        state.governanceControls.items = [];
    } finally {
        state.governanceControls.loading = false;
        renderApp();
    }
}

/**
 * VTID-01181: Fetch audit history for a specific control.
 */
async function fetchControlHistory(key) {
    state.governanceControls.historyLoading = true;
    state.governanceControls.historyError = null;
    state.governanceControls.historyItems = [];
    renderApp();

    try {
        var response = await fetch('/api/v1/governance/controls/' + encodeURIComponent(key) + '/history?limit=50', {
            method: 'GET',
            headers: buildContextHeaders()
        });

        var json = await response.json();

        if (!response.ok || !json.ok) {
            throw new Error(json.error || json.message || 'Failed to fetch history');
        }

        state.governanceControls.historyItems = json.data || [];
        console.log('[VTID-01181] Control history loaded:', state.governanceControls.historyItems.length, 'entries');
    } catch (error) {
        console.error('[VTID-01181] Failed to fetch control history:', error);
        state.governanceControls.historyError = error.message;
    } finally {
        state.governanceControls.historyLoading = false;
        renderApp();
    }
}

/**
 * VTID-01181: Enable a system control.
 */
async function enableControl(key, reason, durationMinutes) {
    state.governanceControls.actionLoading = true;
    state.governanceControls.actionError = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/governance/controls/' + encodeURIComponent(key), {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, buildContextHeaders()),
            body: JSON.stringify({
                enabled: true,
                reason: reason,
                duration_minutes: durationMinutes
            })
        });

        var json = await response.json();

        if (!response.ok || !json.ok) {
            throw new Error(json.error || json.message || 'Failed to enable control');
        }

        showToast('Control enabled: ' + key, 'success');
        state.governanceControls.showEnableModal = false;
        state.governanceControls.enableReason = '';
        state.governanceControls.enableDuration = 60;
        state.governanceControls.fetched = false; // Force re-fetch
        fetchGovernanceControls();
    } catch (error) {
        console.error('[VTID-01181] Failed to enable control:', error);
        state.governanceControls.actionError = error.message;
        showToast('Failed to enable control: ' + error.message, 'error');
    } finally {
        state.governanceControls.actionLoading = false;
        renderApp();
    }
}

/**
 * VTID-01181: Disable a system control.
 */
async function disableControl(key, reason) {
    state.governanceControls.actionLoading = true;
    state.governanceControls.actionError = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/governance/controls/' + encodeURIComponent(key), {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, buildContextHeaders()),
            body: JSON.stringify({
                enabled: false,
                reason: reason
            })
        });

        var json = await response.json();

        if (!response.ok || !json.ok) {
            throw new Error(json.error || json.message || 'Failed to disable control');
        }

        showToast('Control disabled: ' + key, 'success');
        state.governanceControls.showDisableModal = false;
        state.governanceControls.disableReason = '';
        state.governanceControls.fetched = false; // Force re-fetch
        fetchGovernanceControls();
    } catch (error) {
        console.error('[VTID-01181] Failed to disable control:', error);
        state.governanceControls.actionError = error.message;
        showToast('Failed to disable control: ' + error.message, 'error');
    } finally {
        state.governanceControls.actionLoading = false;
        renderApp();
    }
}

/**
 * VTID-01181: Format control key for display.
 */
function formatControlKey(key) {
    var keyMap = {
        'vtid_allocator_enabled': 'VTID Allocator'
    };
    return keyMap[key] || key.replace(/_/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });
}

/**
 * VTID-01181: Calculate time remaining until expiry.
 */
function getTimeRemaining(expiresAt) {
    if (!expiresAt) return null;
    var now = new Date();
    var expiry = new Date(expiresAt);
    var diffMs = expiry - now;
    if (diffMs <= 0) return 'Expired';
    var minutes = Math.floor(diffMs / 60000);
    var hours = Math.floor(minutes / 60);
    if (hours > 0) {
        return hours + 'h ' + (minutes % 60) + 'm remaining';
    }
    return minutes + 'm remaining';
}

/**
 * VTID-01181: Renders the Governance Controls view (System Controls).
 */
function renderGovernanceControlsView() {
    var container = document.createElement('div');
    container.className = 'gov-controls-container';

    // Auto-fetch controls if not yet fetched and not currently loading
    if (!state.governanceControls.fetched && !state.governanceControls.loading) {
        fetchGovernanceControls();
    }

    // Header section
    var header = document.createElement('div');
    header.className = 'gov-controls-header';

    var headerTitle = document.createElement('h2');
    headerTitle.className = 'gov-controls-title';
    headerTitle.textContent = 'System Controls';
    header.appendChild(headerTitle);

    var headerDesc = document.createElement('p');
    headerDesc.className = 'gov-controls-desc';
    headerDesc.textContent = 'Enable or disable high-risk system capabilities without redeploys. All changes are audited.';
    header.appendChild(headerDesc);

    container.appendChild(header);

    // Loading state
    if (state.governanceControls.loading) {
        var loading = document.createElement('div');
        loading.className = 'gov-controls-loading';
        loading.innerHTML = '<div class="skeleton-table">' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '</div>';
        container.appendChild(loading);
        return container;
    }

    // Error state
    if (state.governanceControls.error) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'gov-controls-error';
        errorDiv.innerHTML = '<span class="error-icon">!</span> Error loading controls: ' + escapeHtml(state.governanceControls.error);
        container.appendChild(errorDiv);
        return container;
    }

    // Empty state
    if (state.governanceControls.items.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'gov-controls-empty';
        emptyDiv.innerHTML = '<p>No system controls configured.</p>' +
            '<p class="gov-controls-empty-hint">Controls will appear here as they are added to the system.</p>';
        container.appendChild(emptyDiv);
        return container;
    }

    // Controls cards
    var cardsContainer = document.createElement('div');
    cardsContainer.className = 'gov-controls-cards';

    state.governanceControls.items.forEach(function(control) {
        var card = renderControlCard(control);
        cardsContainer.appendChild(card);
    });

    container.appendChild(cardsContainer);

    // Enable modal
    if (state.governanceControls.showEnableModal) {
        container.appendChild(renderEnableModal());
    }

    // Disable modal
    if (state.governanceControls.showDisableModal) {
        container.appendChild(renderDisableModal());
    }

    // History drawer
    if (state.governanceControls.showHistoryDrawer) {
        container.appendChild(renderControlHistoryDrawer());
    }

    return container;
}

/**
 * VTID-01181: Render a single control card.
 */
function renderControlCard(control) {
    var card = document.createElement('div');
    card.className = 'gov-control-card';

    // Check if expired
    var isExpired = control.expires_at && new Date(control.expires_at) <= new Date();
    var effectiveEnabled = control.enabled && !isExpired;

    // Card header
    var cardHeader = document.createElement('div');
    cardHeader.className = 'gov-control-card-header';

    var controlTitle = document.createElement('h3');
    controlTitle.className = 'gov-control-title';
    controlTitle.textContent = formatControlKey(control.key);
    cardHeader.appendChild(controlTitle);

    // Status pill
    var statusPill = document.createElement('span');
    statusPill.className = 'gov-control-status ' + (effectiveEnabled ? 'status-enabled' : 'status-disabled');
    statusPill.textContent = effectiveEnabled ? 'ENABLED' : 'DISABLED';
    cardHeader.appendChild(statusPill);

    card.appendChild(cardHeader);

    // Card body
    var cardBody = document.createElement('div');
    cardBody.className = 'gov-control-card-body';

    // Expiry info (if enabled and has expiry)
    if (effectiveEnabled && control.expires_at) {
        var expiryDiv = document.createElement('div');
        expiryDiv.className = 'gov-control-expiry';
        var timeRemaining = getTimeRemaining(control.expires_at);
        expiryDiv.innerHTML = '<span class="expiry-icon">&#9200;</span> ' + escapeHtml(timeRemaining);
        cardBody.appendChild(expiryDiv);
    }

    // Reason (if present)
    if (control.reason) {
        var reasonDiv = document.createElement('div');
        reasonDiv.className = 'gov-control-reason';
        reasonDiv.innerHTML = '<strong>Reason:</strong> ' + escapeHtml(control.reason);
        cardBody.appendChild(reasonDiv);
    }

    // Last updated info
    if (control.updated_by || control.updated_at) {
        var updatedDiv = document.createElement('div');
        updatedDiv.className = 'gov-control-updated';
        var updatedText = 'Last updated';
        if (control.updated_by) {
            updatedText += ' by ' + escapeHtml(control.updated_by);
        }
        if (control.updated_at) {
            updatedText += ' at ' + formatHistoryTimestamp(control.updated_at);
        }
        updatedDiv.textContent = updatedText;
        cardBody.appendChild(updatedDiv);
    }

    card.appendChild(cardBody);

    // Card actions
    var cardActions = document.createElement('div');
    cardActions.className = 'gov-control-card-actions';

    // Toggle button (Enable/Disable)
    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'gov-control-toggle-btn ' + (effectiveEnabled ? 'btn-disable' : 'btn-enable');
    toggleBtn.textContent = effectiveEnabled ? 'Disable' : 'Enable';
    toggleBtn.onclick = function() {
        state.governanceControls.selectedControlKey = control.key;
        if (effectiveEnabled) {
            state.governanceControls.showDisableModal = true;
        } else {
            state.governanceControls.showEnableModal = true;
        }
        renderApp();
    };
    cardActions.appendChild(toggleBtn);

    // View history link
    var historyLink = document.createElement('button');
    historyLink.className = 'gov-control-history-link';
    historyLink.textContent = 'View history';
    historyLink.onclick = function() {
        state.governanceControls.selectedControlKey = control.key;
        state.governanceControls.showHistoryDrawer = true;
        fetchControlHistory(control.key);
    };
    cardActions.appendChild(historyLink);

    card.appendChild(cardActions);

    return card;
}

/**
 * VTID-01181: Render the Enable modal.
 */
function renderEnableModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = function(e) {
        if (e.target === overlay) {
            state.governanceControls.showEnableModal = false;
            renderApp();
        }
    };

    var modal = document.createElement('div');
    modal.className = 'gov-control-modal';

    var modalHeader = document.createElement('div');
    modalHeader.className = 'gov-control-modal-header';
    modalHeader.innerHTML = '<h3>Enable Control: ' + escapeHtml(formatControlKey(state.governanceControls.selectedControlKey)) + '</h3>';
    modal.appendChild(modalHeader);

    var modalBody = document.createElement('div');
    modalBody.className = 'gov-control-modal-body';

    // Warning message
    var warning = document.createElement('div');
    warning.className = 'gov-control-modal-warning';
    warning.innerHTML = '<span class="warning-icon">!</span> Enabling this control activates high-risk functionality. All changes are logged to the audit trail.';
    modalBody.appendChild(warning);

    // Reason input (required)
    var reasonLabel = document.createElement('label');
    reasonLabel.className = 'gov-control-modal-label';
    reasonLabel.textContent = 'Reason (required)';
    modalBody.appendChild(reasonLabel);

    var reasonInput = document.createElement('textarea');
    reasonInput.className = 'gov-control-modal-textarea';
    reasonInput.placeholder = 'Why are you enabling this control?';
    reasonInput.value = state.governanceControls.enableReason;
    reasonInput.oninput = function(e) {
        state.governanceControls.enableReason = e.target.value;
    };
    modalBody.appendChild(reasonInput);

    // Duration select (optional in dev)
    var durationLabel = document.createElement('label');
    durationLabel.className = 'gov-control-modal-label';
    durationLabel.textContent = 'Duration (optional)';
    modalBody.appendChild(durationLabel);

    var durationSelect = document.createElement('select');
    durationSelect.className = 'gov-control-modal-select';
    var durations = [
        { value: 0, label: 'No expiry (indefinite)' },
        { value: 15, label: '15 minutes' },
        { value: 60, label: '1 hour' },
        { value: 240, label: '4 hours' },
        { value: 480, label: '8 hours' },
        { value: 1440, label: '24 hours' }
    ];
    durations.forEach(function(d) {
        var opt = document.createElement('option');
        opt.value = d.value;
        opt.textContent = d.label;
        opt.selected = d.value === state.governanceControls.enableDuration;
        durationSelect.appendChild(opt);
    });
    durationSelect.onchange = function(e) {
        state.governanceControls.enableDuration = parseInt(e.target.value, 10);
    };
    modalBody.appendChild(durationSelect);

    // Error message
    if (state.governanceControls.actionError) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'gov-control-modal-error';
        errorDiv.textContent = state.governanceControls.actionError;
        modalBody.appendChild(errorDiv);
    }

    modal.appendChild(modalBody);

    // Modal footer
    var modalFooter = document.createElement('div');
    modalFooter.className = 'gov-control-modal-footer';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'gov-control-modal-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = function() {
        state.governanceControls.showEnableModal = false;
        state.governanceControls.enableReason = '';
        state.governanceControls.actionError = null;
        renderApp();
    };
    modalFooter.appendChild(cancelBtn);

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'gov-control-modal-confirm btn-enable';
    confirmBtn.textContent = state.governanceControls.actionLoading ? 'Enabling...' : 'Confirm Enable';
    confirmBtn.disabled = state.governanceControls.actionLoading || !state.governanceControls.enableReason.trim();
    confirmBtn.onclick = function() {
        if (state.governanceControls.enableReason.trim()) {
            enableControl(
                state.governanceControls.selectedControlKey,
                state.governanceControls.enableReason.trim(),
                state.governanceControls.enableDuration || null
            );
        }
    };
    modalFooter.appendChild(confirmBtn);

    modal.appendChild(modalFooter);
    overlay.appendChild(modal);

    return overlay;
}

/**
 * VTID-01181: Render the Disable modal.
 */
function renderDisableModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = function(e) {
        if (e.target === overlay) {
            state.governanceControls.showDisableModal = false;
            renderApp();
        }
    };

    var modal = document.createElement('div');
    modal.className = 'gov-control-modal';

    var modalHeader = document.createElement('div');
    modalHeader.className = 'gov-control-modal-header';
    modalHeader.innerHTML = '<h3>Disable Control: ' + escapeHtml(formatControlKey(state.governanceControls.selectedControlKey)) + '</h3>';
    modal.appendChild(modalHeader);

    var modalBody = document.createElement('div');
    modalBody.className = 'gov-control-modal-body';

    // Reason input (required)
    var reasonLabel = document.createElement('label');
    reasonLabel.className = 'gov-control-modal-label';
    reasonLabel.textContent = 'Reason (required)';
    modalBody.appendChild(reasonLabel);

    var reasonInput = document.createElement('textarea');
    reasonInput.className = 'gov-control-modal-textarea';
    reasonInput.placeholder = 'Why are you disabling this control?';
    reasonInput.value = state.governanceControls.disableReason;
    reasonInput.oninput = function(e) {
        state.governanceControls.disableReason = e.target.value;
    };
    modalBody.appendChild(reasonInput);

    // Error message
    if (state.governanceControls.actionError) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'gov-control-modal-error';
        errorDiv.textContent = state.governanceControls.actionError;
        modalBody.appendChild(errorDiv);
    }

    modal.appendChild(modalBody);

    // Modal footer
    var modalFooter = document.createElement('div');
    modalFooter.className = 'gov-control-modal-footer';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'gov-control-modal-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = function() {
        state.governanceControls.showDisableModal = false;
        state.governanceControls.disableReason = '';
        state.governanceControls.actionError = null;
        renderApp();
    };
    modalFooter.appendChild(cancelBtn);

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'gov-control-modal-confirm btn-disable';
    confirmBtn.textContent = state.governanceControls.actionLoading ? 'Disabling...' : 'Confirm Disable';
    confirmBtn.disabled = state.governanceControls.actionLoading || !state.governanceControls.disableReason.trim();
    confirmBtn.onclick = function() {
        if (state.governanceControls.disableReason.trim()) {
            disableControl(
                state.governanceControls.selectedControlKey,
                state.governanceControls.disableReason.trim()
            );
        }
    };
    modalFooter.appendChild(confirmBtn);

    modal.appendChild(modalFooter);
    overlay.appendChild(modal);

    return overlay;
}

/**
 * VTID-01181: Render the control history drawer.
 */
function renderControlHistoryDrawer() {
    var overlay = document.createElement('div');
    overlay.className = 'drawer-overlay';
    overlay.onclick = function(e) {
        if (e.target === overlay) {
            state.governanceControls.showHistoryDrawer = false;
            renderApp();
        }
    };

    var drawer = document.createElement('div');
    drawer.className = 'gov-control-history-drawer';

    // Drawer header
    var drawerHeader = document.createElement('div');
    drawerHeader.className = 'gov-control-history-header';

    var headerTitle = document.createElement('h3');
    headerTitle.textContent = 'Audit History: ' + formatControlKey(state.governanceControls.selectedControlKey);
    drawerHeader.appendChild(headerTitle);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '&#x2715;';
    closeBtn.onclick = function() {
        state.governanceControls.showHistoryDrawer = false;
        renderApp();
    };
    drawerHeader.appendChild(closeBtn);

    drawer.appendChild(drawerHeader);

    // Drawer body
    var drawerBody = document.createElement('div');
    drawerBody.className = 'gov-control-history-body';

    if (state.governanceControls.historyLoading) {
        var loading = document.createElement('div');
        loading.className = 'gov-control-history-loading';
        loading.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div>';
        drawerBody.appendChild(loading);
    } else if (state.governanceControls.historyError) {
        var error = document.createElement('div');
        error.className = 'gov-control-history-error';
        error.textContent = 'Error: ' + state.governanceControls.historyError;
        drawerBody.appendChild(error);
    } else if (state.governanceControls.historyItems.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'gov-control-history-empty';
        empty.textContent = 'No audit history available.';
        drawerBody.appendChild(empty);
    } else {
        var timeline = document.createElement('div');
        timeline.className = 'gov-control-history-timeline';

        state.governanceControls.historyItems.forEach(function(item) {
            var entry = document.createElement('div');
            entry.className = 'gov-control-history-entry';

            var entryIcon = document.createElement('div');
            entryIcon.className = 'history-entry-icon ' + (item.to_enabled ? 'icon-enabled' : 'icon-disabled');
            entryIcon.innerHTML = item.to_enabled ? '&#x2191;' : '&#x2193;';
            entry.appendChild(entryIcon);

            var entryContent = document.createElement('div');
            entryContent.className = 'history-entry-content';

            var entryAction = document.createElement('div');
            entryAction.className = 'history-entry-action';
            entryAction.textContent = item.to_enabled ? 'Enabled' : 'Disabled';
            if (item.from_enabled !== item.to_enabled) {
                entryAction.textContent += ' (was ' + (item.from_enabled ? 'Enabled' : 'Disabled') + ')';
            }
            entryContent.appendChild(entryAction);

            var entryReason = document.createElement('div');
            entryReason.className = 'history-entry-reason';
            entryReason.textContent = item.reason || 'No reason provided';
            entryContent.appendChild(entryReason);

            var entryMeta = document.createElement('div');
            entryMeta.className = 'history-entry-meta';
            var metaText = formatHistoryTimestamp(item.created_at);
            if (item.updated_by) {
                metaText += ' by ' + item.updated_by;
            }
            if (item.updated_by_role) {
                metaText += ' (' + item.updated_by_role + ')';
            }
            if (item.expires_at) {
                metaText += ' | Expires: ' + formatHistoryTimestamp(item.expires_at);
            }
            entryMeta.textContent = metaText;
            entryContent.appendChild(entryMeta);

            entry.appendChild(entryContent);
            timeline.appendChild(entry);
        });

        drawerBody.appendChild(timeline);
    }

    drawer.appendChild(drawerBody);
    overlay.appendChild(drawer);

    return overlay;
}

/**
 * VTID-0408: Format timestamp for history display.
 */
function formatHistoryTimestamp(dateStr) {
    if (!dateStr) return '-';
    try {
        var date = new Date(dateStr);
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return dateStr;
    }
}

/**
 * VTID-0408: Format event type for display.
 */
function formatHistoryType(type) {
    var typeMap = {
        'governance.deploy.blocked': 'Blocked',
        'governance.deploy.allowed': 'Allowed',
        'governance.evaluate': 'Evaluate',
        'governance.rule.created': 'Rule Created',
        'governance.rule.updated': 'Rule Updated',
        'governance.violated': 'Violation'
    };
    return typeMap[type] || type;
}

/**
 * VTID-0408: Get CSS class for type badge.
 */
function getHistoryTypeBadgeClass(type) {
    var classMap = {
        'governance.deploy.blocked': 'gov-history-type-blocked',
        'governance.deploy.allowed': 'gov-history-type-allowed',
        'governance.evaluate': 'gov-history-type-evaluate',
        'governance.rule.created': 'gov-history-type-rule',
        'governance.rule.updated': 'gov-history-type-rule',
        'governance.violated': 'gov-history-type-blocked'
    };
    return classMap[type] || 'gov-history-type-default';
}

/**
 * VTID-0408: Capitalize first letter of string.
 */
function capitalizeFirst(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// --- VTID-0600: Operational Visibility Views ---

/**
 * VTID-0600: Renders the OASIS > Events view with severity colors and drawer.
 * VTID-01189: Standardized 3-row layout with infinite scroll
 * - Row 1: Global top bar (unchanged)
 * - Row 2: Tab navigation (unchanged)
 * - Row 3: Toolbar (filters left, item count right)
 * - Content: Scrollable table with Load More
 */
function renderOasisEventsView() {
    var container = document.createElement('div');
    container.className = 'oasis-events-container';

    // VTID-01189: Auto-fetch events if not yet fetched (no auto-refresh)
    if (!state.oasisEvents.fetched && !state.oasisEvents.loading) {
        fetchOasisEvents(state.oasisEvents.filters, false);
    }

    // VTID-01189: Row 3 - Toolbar (filters left, count right)
    var toolbar = document.createElement('div');
    toolbar.className = 'list-toolbar';

    // Left: Filters
    var filtersCluster = document.createElement('div');
    filtersCluster.className = 'list-toolbar__filters';

    // Topic filter
    var topicFilter = document.createElement('select');
    topicFilter.className = 'filter-dropdown';
    topicFilter.innerHTML =
        '<option value="">All Topics</option>' +
        '<option value="deploy">Deploy</option>' +
        '<option value="governance">Governance</option>' +
        '<option value="cicd">CI/CD</option>' +
        '<option value="autopilot">Autopilot</option>' +
        '<option value="operator">Operator</option>';
    topicFilter.value = state.oasisEvents.filters.topic || '';
    topicFilter.onchange = function(e) {
        state.oasisEvents.filters.topic = e.target.value;
        handleOasisFilterChange();
    };
    filtersCluster.appendChild(topicFilter);

    // Status filter
    var statusFilter = document.createElement('select');
    statusFilter.className = 'filter-dropdown';
    statusFilter.innerHTML =
        '<option value="">All Status</option>' +
        '<option value="success">Success</option>' +
        '<option value="error">Error</option>' +
        '<option value="info">Info</option>' +
        '<option value="warning">Warning</option>';
    statusFilter.value = state.oasisEvents.filters.status || '';
    statusFilter.onchange = function(e) {
        state.oasisEvents.filters.status = e.target.value;
        handleOasisFilterChange();
    };
    filtersCluster.appendChild(statusFilter);

    toolbar.appendChild(filtersCluster);

    // Right: Item count
    var metadataCluster = document.createElement('div');
    metadataCluster.className = 'list-toolbar__metadata';
    metadataCluster.textContent = state.oasisEvents.items.length + ' events';
    toolbar.appendChild(metadataCluster);

    container.appendChild(toolbar);

    // Content area with scrollable table
    var content = document.createElement('div');
    content.className = 'list-scroll-container oasis-events-content';
    content.dataset.scrollRetain = 'true';
    content.dataset.scrollKey = 'oasis-events';

    if (state.oasisEvents.loading && state.oasisEvents.items.length === 0) {
        content.innerHTML = '<div class="placeholder-content">Loading OASIS events...</div>';
    } else if (state.oasisEvents.error) {
        content.innerHTML = '<div class="placeholder-content error-text">Error: ' + state.oasisEvents.error + '</div>';
    } else if (state.oasisEvents.items.length === 0) {
        content.innerHTML = '<div class="placeholder-content">No events found.</div>';
    } else {
        var table = document.createElement('table');
        table.className = 'list-table oasis-events-table';

        // Sticky header
        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        ['Severity', 'Timestamp', 'Topic', 'VTID', 'Service', 'Status', 'Message'].forEach(function(header) {
            var th = document.createElement('th');
            th.textContent = header;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        var tbody = document.createElement('tbody');
        state.oasisEvents.items.forEach(function(event) {
            var row = document.createElement('tr');
            row.className = 'oasis-event-row clickable-row';
            var severity = getEventSeverity(event);
            row.dataset.severity = severity;
            row.onclick = function() {
                state.oasisEvents.selectedEvent = event;
                renderApp();
            };

            // Severity indicator
            var severityCell = document.createElement('td');
            var severityDot = document.createElement('span');
            severityDot.className = 'severity-dot severity-' + severity;
            severityCell.appendChild(severityDot);
            row.appendChild(severityCell);

            // Timestamp
            var tsCell = document.createElement('td');
            tsCell.className = 'event-timestamp';
            tsCell.textContent = formatEventTimestamp(event.created_at);
            row.appendChild(tsCell);

            // Topic
            var topicCell = document.createElement('td');
            topicCell.className = 'event-topic';
            topicCell.textContent = event.topic || '-';
            row.appendChild(topicCell);

            // VTID
            var vtidCell = document.createElement('td');
            vtidCell.className = 'event-vtid';
            vtidCell.textContent = event.vtid || '-';
            row.appendChild(vtidCell);

            // Service
            var serviceCell = document.createElement('td');
            serviceCell.className = 'event-service';
            serviceCell.textContent = event.service || '-';
            row.appendChild(serviceCell);

            // Status
            var statusCell = document.createElement('td');
            var statusBadge = document.createElement('span');
            statusBadge.className = 'status-badge status-' + (event.status || 'info');
            statusBadge.textContent = event.status || '-';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // Message
            var msgCell = document.createElement('td');
            msgCell.className = 'event-message';
            msgCell.textContent = (event.message || '').substring(0, 60) + ((event.message || '').length > 60 ? '...' : '');
            row.appendChild(msgCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        content.appendChild(table);

        // VTID-01189: Load More button
        if (state.oasisEvents.pagination.hasMore || state.oasisEvents.loading) {
            var loadMoreContainer = document.createElement('div');
            loadMoreContainer.className = 'load-more-container';

            var loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'load-more-btn' + (state.oasisEvents.loading ? ' loading' : '');
            loadMoreBtn.disabled = state.oasisEvents.loading;
            loadMoreBtn.textContent = state.oasisEvents.loading ? 'Loading...' : 'Load More';
            loadMoreBtn.onclick = function() {
                loadMoreOasisEvents();
            };
            loadMoreContainer.appendChild(loadMoreBtn);
            content.appendChild(loadMoreContainer);
        }
    }

    container.appendChild(content);

    return container;
}

/**
 * VTID-01039: Fetch ORB session transcript for display
 */
function fetchOrbSessionTranscript(orbSessionId) {
    if (!orbSessionId) return;

    state.oasisEvents.orbTranscriptLoading = true;
    state.oasisEvents.orbTranscriptError = null;
    renderApp();

    fetch('/api/v1/orb/session/' + orbSessionId)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            state.oasisEvents.orbTranscriptLoading = false;
            if (data.ok) {
                state.oasisEvents.orbTranscript = data;
            } else {
                state.oasisEvents.orbTranscriptError = data.error || 'Failed to load transcript';
            }
            renderApp();
        })
        .catch(function(err) {
            state.oasisEvents.orbTranscriptLoading = false;
            state.oasisEvents.orbTranscriptError = err.message || 'Network error';
            renderApp();
        });
}

/**
 * VTID-0600: Renders the OASIS Event Detail Drawer.
 * VTID-01039: Extended to display ORB session transcripts for orb.session.summary events.
 */
function renderOasisEventDrawer() {
    var drawer = document.createElement('div');
    drawer.className = 'drawer oasis-event-drawer' + (state.oasisEvents.selectedEvent ? ' open' : '');

    if (!state.oasisEvents.selectedEvent) {
        return drawer;
    }

    var event = state.oasisEvents.selectedEvent;
    var severity = getEventSeverity(event);

    // VTID-01039: Check if this is an ORB session summary event
    var isOrbSummary = event.topic === 'orb.session.summary';
    var orbSessionId = isOrbSummary && event.metadata ? event.metadata.orb_session_id : null;

    // VTID-01039: Auto-fetch transcript when opening ORB summary event
    if (isOrbSummary && orbSessionId && !state.oasisEvents.orbTranscript && !state.oasisEvents.orbTranscriptLoading) {
        fetchOrbSessionTranscript(orbSessionId);
    }

    // Header
    var header = document.createElement('div');
    header.className = 'drawer-header';

    var title = document.createElement('h3');
    title.textContent = isOrbSummary ? 'ORB Session Transcript' : 'Event Details';
    header.appendChild(title);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = function() {
        state.oasisEvents.selectedEvent = null;
        state.oasisEvents.orbTranscript = null;
        state.oasisEvents.orbTranscriptError = null;
        renderApp();
    };
    header.appendChild(closeBtn);
    drawer.appendChild(header);

    // Content
    var content = document.createElement('div');
    content.className = 'drawer-content';

    // VTID-01039: Special rendering for ORB session summary
    if (isOrbSummary) {
        // Summary section at top
        var summarySection = document.createElement('div');
        summarySection.className = 'drawer-section orb-summary-section';

        var summaryTitle = document.createElement('h4');
        summaryTitle.textContent = 'Session Summary';
        summarySection.appendChild(summaryTitle);

        var summary = event.metadata && event.metadata.summary ? event.metadata.summary : null;

        if (summary) {
            // Title
            var titleDiv = document.createElement('div');
            titleDiv.className = 'orb-summary-title';
            titleDiv.textContent = summary.title || event.message;
            summarySection.appendChild(titleDiv);

            // Stats row
            var statsDiv = document.createElement('div');
            statsDiv.className = 'orb-summary-stats';
            var turnsCount = event.metadata.turns_count || 0;
            var durationSec = event.metadata.duration_sec || 0;
            var durationMin = Math.floor(durationSec / 60);
            var durationSecRem = durationSec % 60;
            statsDiv.textContent = turnsCount + ' turns | ' + durationMin + 'm ' + durationSecRem + 's';
            summarySection.appendChild(statsDiv);

            // Bullets
            if (summary.bullets && summary.bullets.length > 0) {
                var bulletsDiv = document.createElement('div');
                bulletsDiv.className = 'orb-summary-bullets';
                var bulletsList = document.createElement('ul');
                summary.bullets.forEach(function(bullet) {
                    var li = document.createElement('li');
                    li.textContent = bullet;
                    bulletsList.appendChild(li);
                });
                bulletsDiv.appendChild(bulletsList);
                summarySection.appendChild(bulletsDiv);
            }

            // Actions
            if (summary.actions && summary.actions.length > 0) {
                var actionsDiv = document.createElement('div');
                actionsDiv.className = 'orb-summary-actions';
                var actionsTitle = document.createElement('strong');
                actionsTitle.textContent = 'Suggested Actions:';
                actionsDiv.appendChild(actionsTitle);
                var actionsList = document.createElement('ul');
                summary.actions.forEach(function(action) {
                    var li = document.createElement('li');
                    li.textContent = action;
                    actionsList.appendChild(li);
                });
                actionsDiv.appendChild(actionsList);
                summarySection.appendChild(actionsDiv);
            }
        } else {
            var noSummary = document.createElement('p');
            noSummary.textContent = event.message || 'No summary available';
            summarySection.appendChild(noSummary);
        }

        content.appendChild(summarySection);

        // Transcript section
        var transcriptSection = document.createElement('div');
        transcriptSection.className = 'drawer-section orb-transcript-section';

        var transcriptTitle = document.createElement('h4');
        transcriptTitle.textContent = 'Conversation Transcript';
        transcriptSection.appendChild(transcriptTitle);

        if (state.oasisEvents.orbTranscriptLoading) {
            var loadingDiv = document.createElement('div');
            loadingDiv.className = 'orb-transcript-loading';
            loadingDiv.textContent = 'Loading transcript...';
            transcriptSection.appendChild(loadingDiv);
        } else if (state.oasisEvents.orbTranscriptError) {
            var errorDiv = document.createElement('div');
            errorDiv.className = 'orb-transcript-error';
            errorDiv.textContent = 'Error: ' + state.oasisEvents.orbTranscriptError;
            transcriptSection.appendChild(errorDiv);
        } else if (state.oasisEvents.orbTranscript && state.oasisEvents.orbTranscript.turns) {
            var turnsContainer = document.createElement('div');
            turnsContainer.className = 'orb-transcript-turns';

            state.oasisEvents.orbTranscript.turns.forEach(function(turn) {
                var turnDiv = document.createElement('div');
                turnDiv.className = 'orb-transcript-turn orb-transcript-turn-' + turn.role;

                var turnHeader = document.createElement('div');
                turnHeader.className = 'orb-transcript-turn-header';

                var roleSpan = document.createElement('span');
                roleSpan.className = 'orb-transcript-role';
                roleSpan.textContent = turn.role === 'user' ? 'You' : 'ORB';
                turnHeader.appendChild(roleSpan);

                var tsSpan = document.createElement('span');
                tsSpan.className = 'orb-transcript-ts';
                tsSpan.textContent = formatEventTimestamp(turn.ts);
                turnHeader.appendChild(tsSpan);

                turnDiv.appendChild(turnHeader);

                var textDiv = document.createElement('div');
                textDiv.className = 'orb-transcript-text';
                textDiv.textContent = turn.text;
                turnDiv.appendChild(textDiv);

                turnsContainer.appendChild(turnDiv);
            });

            transcriptSection.appendChild(turnsContainer);
        } else {
            var noTranscript = document.createElement('div');
            noTranscript.className = 'orb-transcript-empty';
            noTranscript.textContent = 'No transcript available';
            transcriptSection.appendChild(noTranscript);
        }

        content.appendChild(transcriptSection);

    } else {
        // Standard event rendering

        // Severity banner
        var severityBanner = document.createElement('div');
        severityBanner.className = 'severity-banner severity-banner-' + severity;
        severityBanner.textContent = severity.toUpperCase() + ' SEVERITY';
        content.appendChild(severityBanner);

        // Fields
        var fields = [
            { label: 'Event ID', value: event.id },
            { label: 'Timestamp', value: formatEventTimestamp(event.created_at) },
            { label: 'Topic', value: event.topic },
            { label: 'VTID', value: event.vtid },
            { label: 'Service', value: event.service },
            { label: 'Status', value: event.status },
            { label: 'Role', value: event.role },
            { label: 'Model', value: event.model },
            { label: 'Message', value: event.message }
        ];

        fields.forEach(function(field) {
            if (field.value) {
                var row = document.createElement('div');
                row.className = 'drawer-field';

                var label = document.createElement('div');
                label.className = 'drawer-field-label';
                label.textContent = field.label;
                row.appendChild(label);

                var value = document.createElement('div');
                value.className = 'drawer-field-value';
                value.textContent = field.value;
                row.appendChild(value);

                content.appendChild(row);
            }
        });

        // Metadata section
        if (event.metadata && Object.keys(event.metadata).length > 0) {
            var metaSection = document.createElement('div');
            metaSection.className = 'drawer-section';

            var metaTitle = document.createElement('h4');
            metaTitle.textContent = 'Metadata';
            metaSection.appendChild(metaTitle);

            var metaPre = document.createElement('pre');
            metaPre.className = 'drawer-metadata';
            metaPre.textContent = JSON.stringify(event.metadata, null, 2);
            metaSection.appendChild(metaPre);

            content.appendChild(metaSection);
        }
    }

    drawer.appendChild(content);

    return drawer;
}

/**
 * VTID-0600: Renders the Command Hub > Events view (curated operational events).
 */
function renderCommandHubEventsView() {
    var container = document.createElement('div');
    container.className = 'command-hub-events-container';

    // Auto-fetch events if not yet fetched
    if (!state.commandHubEvents.fetched && !state.commandHubEvents.loading) {
        fetchCommandHubEvents();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'command-hub-events-header';

    var title = document.createElement('h2');
    title.textContent = 'Operational Events';
    header.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'Curated events for supervisor oversight: deployments, governance decisions, CI/CD, and autopilot activity.';
    header.appendChild(subtitle);

    container.appendChild(header);

    // Filters toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'command-hub-events-toolbar';

    // Topic filter
    var topicFilter = document.createElement('select');
    topicFilter.className = 'form-control filter-select';
    topicFilter.innerHTML =
        '<option value="">All Types</option>' +
        '<option value="deploy">Deployments</option>' +
        '<option value="governance">Governance</option>' +
        '<option value="cicd">CI/CD</option>' +
        '<option value="autopilot">Autopilot</option>' +
        '<option value="operator">Operator</option>';
    topicFilter.value = state.commandHubEvents.filters.topic || '';
    topicFilter.onchange = function(e) {
        state.commandHubEvents.filters.topic = e.target.value;
        fetchCommandHubEvents();
    };
    toolbar.appendChild(topicFilter);

    // Status filter
    var statusFilter = document.createElement('select');
    statusFilter.className = 'form-control filter-select';
    statusFilter.innerHTML =
        '<option value="">All Status</option>' +
        '<option value="success">Success</option>' +
        '<option value="error">Error/Blocked</option>' +
        '<option value="info">Info</option>';
    statusFilter.value = state.commandHubEvents.filters.status || '';
    statusFilter.onchange = function(e) {
        state.commandHubEvents.filters.status = e.target.value;
        fetchCommandHubEvents();
    };
    toolbar.appendChild(statusFilter);

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // SPEC-01: Per-view refresh buttons removed - use global refresh icon in header

    container.appendChild(toolbar);

    // Events list
    var content = document.createElement('div');
    content.className = 'command-hub-events-content';
    // VTID-01002: Mark as scroll-retaining container
    content.dataset.scrollRetain = 'true';
    content.dataset.scrollKey = 'command-hub-events';

    if (state.commandHubEvents.loading) {
        content.innerHTML = '<div class="placeholder-content">Loading operational events...</div>';
    } else if (state.commandHubEvents.error) {
        content.innerHTML = '<div class="placeholder-content error-text">Error: ' + state.commandHubEvents.error + '</div>';
    } else if (state.commandHubEvents.items.length === 0) {
        content.innerHTML = '<div class="placeholder-content">No operational events found.</div>';
    } else {
        var table = document.createElement('table');
        table.className = 'command-hub-events-table';

        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        ['Priority', 'Time', 'Type', 'VTID', 'Status', 'Summary'].forEach(function(h) {
            var th = document.createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        state.commandHubEvents.items.forEach(function(event) {
            var row = document.createElement('tr');
            var severity = getEventSeverity(event);
            row.className = 'command-hub-event-row severity-row-' + severity;

            // Priority indicator
            var prioCell = document.createElement('td');
            var prioDot = document.createElement('span');
            prioDot.className = 'severity-dot severity-' + severity;
            prioCell.appendChild(prioDot);
            row.appendChild(prioCell);

            // Time
            var timeCell = document.createElement('td');
            timeCell.textContent = formatEventTimestamp(event.created_at);
            row.appendChild(timeCell);

            // Type
            var typeCell = document.createElement('td');
            var typeBadge = document.createElement('span');
            typeBadge.className = 'event-type-badge';
            typeBadge.textContent = (event.topic || '').split('.')[0];
            typeCell.appendChild(typeBadge);
            row.appendChild(typeCell);

            // VTID
            var vtidCell = document.createElement('td');
            vtidCell.textContent = event.vtid || '-';
            row.appendChild(vtidCell);

            // Status
            var statusCell = document.createElement('td');
            var statusBadge = document.createElement('span');
            statusBadge.className = 'status-badge status-' + (event.status || 'info');
            statusBadge.textContent = event.status || '-';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // Summary
            var summaryCell = document.createElement('td');
            summaryCell.textContent = event.message || '-';
            row.appendChild(summaryCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        content.appendChild(table);
    }

    container.appendChild(content);

    return container;
}

/**
 * DEV-COMHU-2025-0008: Shared VTID Ledger Table Renderer.
 * Creates a table from ledger API data with standardized columns.
 * Used by both Command Hub > VTIDs and OASIS > VTID Ledger views.
 *
 * @param {Array} items - VTID ledger items from API
 * @returns {HTMLTableElement} The rendered table
 */
function renderVtidLedgerTable(items) {
    var table = document.createElement('table');
    table.className = 'vtids-table';

    // Header row with required columns
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    ['VTID', 'Task Family', 'Module', 'Title', 'Status', 'Created', 'Last Event'].forEach(function(h) {
        var th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body rows
    var tbody = document.createElement('tbody');
    items.forEach(function(item) {
        var row = document.createElement('tr');
        row.className = 'vtid-row';

        // VTID column
        var vtidCell = document.createElement('td');
        vtidCell.className = 'vtid-cell';
        vtidCell.textContent = item.vtid || '—';
        row.appendChild(vtidCell);

        // Task Family column
        var familyCell = document.createElement('td');
        familyCell.textContent = item.task_family || '—';
        row.appendChild(familyCell);

        // Module column
        var moduleCell = document.createElement('td');
        moduleCell.textContent = item.task_module || '—';
        row.appendChild(moduleCell);

        // Title column
        var titleCell = document.createElement('td');
        titleCell.textContent = item.title || '—';
        row.appendChild(titleCell);

        // Status column
        var statusCell = document.createElement('td');
        var statusBadge = document.createElement('span');
        var statusVal = (item.status || 'unknown').toLowerCase();
        statusBadge.className = 'vtid-status-badge vtid-status-' + statusVal;
        statusBadge.textContent = item.status || 'unknown';
        statusCell.appendChild(statusBadge);
        row.appendChild(statusCell);

        // Created column
        var createdCell = document.createElement('td');
        createdCell.textContent = item.created_at ? formatEventTimestamp(item.created_at) : '—';
        row.appendChild(createdCell);

        // Last Event column (show "—" if null)
        var lastEventCell = document.createElement('td');
        lastEventCell.textContent = item.last_event_at ? formatEventTimestamp(item.last_event_at) : '—';
        row.appendChild(lastEventCell);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);

    return table;
}

/**
 * VTID-01001: Renders the Command Hub > VTIDs decision view.
 * Uses projection endpoint for derived decision-grade data.
 * Displays ONLY 5 columns: VTID, Title, Stage, Status, Attention
 */
function renderVtidProjectionTable(items) {
    // VTID-01030: Validate items array before rendering
    if (!items || !Array.isArray(items)) {
        console.error('[VTID-01030] renderVtidProjectionTable called with invalid items:', typeof items, items);
        items = [];
    }
    console.log('[VTID-01030] Rendering VTID projection table with', items.length, 'items');

    var table = document.createElement('table');
    table.className = 'vtids-table vtid-projection-table';

    // Header row with 5 decision-grade columns
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    ['VTID', 'Title', 'Stage', 'Status', 'Attention'].forEach(function(h) {
        var th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body rows
    // VTID-01030: Try/catch per-row to prevent one bad VTID from crashing table
    var tbody = document.createElement('tbody');
    items.forEach(function(item) {
        try {
            // VTID-01030: Skip null/undefined items
            if (!item) {
                console.warn('[VTID-01030] Skipping null/undefined VTID item');
                return;
            }

            var row = document.createElement('tr');
            row.className = 'vtid-row vtid-projection-row';

            // VTID column
            var vtidCell = document.createElement('td');
            vtidCell.className = 'vtid-cell';
            vtidCell.textContent = item.vtid || '—';
            row.appendChild(vtidCell);

            // Title column
            var titleCell = document.createElement('td');
            titleCell.className = 'vtid-title-cell';
            titleCell.textContent = item.title || '—';
            row.appendChild(titleCell);

            // VTID-01016: Derive Stage/Status from OASIS event authority
            // VTID-01030: Null-safe derivation with fallback defaults
            var derived = deriveVtidStageStatus(item) || { stage: 'Scheduled', status: 'scheduled' };

            // Stage column (Scheduled/Queued/Planner/Worker/Validator/Deploy/Done)
            var stageCell = document.createElement('td');
            var stageBadge = document.createElement('span');
            var stageVal = (derived.stage || 'scheduled').toLowerCase();
            stageBadge.className = 'vtid-stage-badge vtid-stage-' + stageVal;
            stageBadge.textContent = derived.stage || 'Scheduled';
            stageCell.appendChild(stageBadge);
            row.appendChild(stageCell);

            // Status column (scheduled/in_progress/success/failed)
            var statusCell = document.createElement('td');
            var statusBadge = document.createElement('span');
            var statusVal = (derived.status || 'scheduled').toLowerCase();
            statusBadge.className = 'vtid-status-badge vtid-status-' + statusVal;
            statusBadge.textContent = derived.status || 'scheduled';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // Attention column (AUTO / HUMAN)
            var attentionCell = document.createElement('td');
            var attentionBadge = document.createElement('span');
            var attentionVal = item.attention_required || 'AUTO';
            attentionBadge.className = 'vtid-attention-badge vtid-attention-' + attentionVal.toLowerCase();
            if (attentionVal === 'HUMAN') {
                attentionBadge.textContent = '⚠️ HUMAN';
            } else {
                attentionBadge.textContent = 'AUTO';
            }
            attentionCell.appendChild(attentionBadge);
            row.appendChild(attentionCell);

            tbody.appendChild(row);
        } catch (err) {
            console.error('[VTID-01030] Failed to render VTID row:', item && item.vtid, err);
            // Skip this row but continue rendering others
        }
    });
    console.log('[VTID-01030] VTID table tbody created with', tbody.children.length, 'rows');
    table.appendChild(tbody);

    return table;
}

/**
 * VTID-01001: Renders the Command Hub > VTIDs decision view.
 * Uses projection endpoint for derived decision-grade data.
 */
function renderVtidsView() {
    var container = document.createElement('div');
    container.className = 'vtids-container';

    // Auto-fetch VTIDs from projection if not yet fetched
    if (!state.vtidProjection.fetched && !state.vtidProjection.loading) {
        fetchVtidProjection();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'vtids-header';

    var title = document.createElement('h2');
    title.textContent = 'VTIDs';
    header.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'Decision-grade VTID visibility. Stage, status, and attention at a glance.';
    header.appendChild(subtitle);

    container.appendChild(header);

    // SPEC-01: Per-view refresh buttons removed - use global refresh icon in header

    // Error banner (visible error, not console-only)
    if (state.vtidProjection.error) {
        var errorBanner = document.createElement('div');
        errorBanner.className = 'vtid-ledger-error-banner';
        errorBanner.textContent = 'Error loading VTIDs: ' + state.vtidProjection.error;
        container.appendChild(errorBanner);
    }

    // Status line: "Loaded N VTIDs"
    var statusLine = document.createElement('div');
    statusLine.className = 'vtid-ledger-status-line';
    if (state.vtidProjection.loading) {
        statusLine.textContent = 'Loading VTIDs...';
    } else if (state.vtidProjection.fetched && !state.vtidProjection.error) {
        statusLine.textContent = 'Loaded ' + state.vtidProjection.items.length + ' VTIDs';
    } else if (!state.vtidProjection.fetched) {
        statusLine.textContent = 'VTIDs not yet loaded';
    }
    container.appendChild(statusLine);

    // Content
    var content = document.createElement('div');
    content.className = 'vtids-content';
    // VTID-01002: Mark as scroll-retaining container
    content.dataset.scrollRetain = 'true';
    content.dataset.scrollKey = 'vtids-list';

    if (state.vtidProjection.loading && state.vtidProjection.items.length === 0) {
        content.innerHTML = '<div class="placeholder-content">Loading VTIDs...</div>';
    } else if (state.vtidProjection.items.length === 0 && !state.vtidProjection.error) {
        content.innerHTML = '<div class="placeholder-content">No VTIDs found.</div>';
    } else if (state.vtidProjection.items.length > 0) {
        // Use projection table renderer with 5 columns
        content.appendChild(renderVtidProjectionTable(state.vtidProjection.items));

        // VTID-01211: Add Load More button
        if (state.vtidProjection.pagination.hasMore || state.vtidProjection.loading) {
            var loadMoreContainer = document.createElement('div');
            loadMoreContainer.className = 'load-more-container';

            var loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'load-more-btn' + (state.vtidProjection.loading ? ' loading' : '');
            loadMoreBtn.disabled = state.vtidProjection.loading;
            loadMoreBtn.textContent = state.vtidProjection.loading ? 'Loading...' : 'Load More';
            loadMoreBtn.onclick = function() {
                loadMoreVtidProjection();
            };

            loadMoreContainer.appendChild(loadMoreBtn);
            content.appendChild(loadMoreContainer);
        }
    }

    container.appendChild(content);

    return container;
}

/**
 * VTID-01001: Renders the OASIS > VTID Ledger analysis view.
 * Uses projection for overview list with clickable rows for drilldown.
 * Shows: lifecycle + timestamps, last events, governance decisions, provenance.
 */

// State for OASIS VTID detail drilldown
var oasisVtidDetail = {
    selectedVtid: null,
    loading: false,
    data: null,
    events: [],
    error: null
};

/**
 * VTID-01001: Fetch VTID detail and events for OASIS drilldown
 */
async function fetchOasisVtidDetail(vtid) {
    console.log('[VTID-01001] Fetching OASIS VTID detail:', vtid);
    oasisVtidDetail.selectedVtid = vtid;
    oasisVtidDetail.loading = true;
    oasisVtidDetail.error = null;
    renderApp();

    try {
        // Fetch VTID detail and events in parallel
        var [detailResp, eventsResp] = await Promise.all([
            fetch('/api/v1/vtid/' + encodeURIComponent(vtid)),
            fetch('/api/v1/events?vtid=' + encodeURIComponent(vtid) + '&limit=100')
        ]);

        if (!detailResp.ok) {
            throw new Error('VTID detail fetch failed: ' + detailResp.status);
        }

        var detailData = await detailResp.json();
        oasisVtidDetail.data = detailData.data || detailData;

        // Handle events response
        if (eventsResp.ok) {
            var eventsData = await eventsResp.json();
            oasisVtidDetail.events = Array.isArray(eventsData) ? eventsData :
                                     (eventsData.data ? eventsData.data : []);
        } else {
            oasisVtidDetail.events = [];
        }

        console.log('[VTID-01001] OASIS VTID detail loaded:', vtid, 'events:', oasisVtidDetail.events.length);
    } catch (error) {
        console.error('[VTID-01001] Failed to fetch OASIS VTID detail:', error);
        oasisVtidDetail.error = error.message;
    } finally {
        oasisVtidDetail.loading = false;
        renderApp();
    }
}

/**
 * VTID-01001: Renders clickable OASIS ledger table with drilldown
 */
function renderOasisLedgerTableWithDrilldown(items) {
    // VTID-01030: Validate items array before rendering
    if (!items || !Array.isArray(items)) {
        console.error('[VTID-01030] renderOasisLedgerTableWithDrilldown called with invalid items:', typeof items, items);
        items = [];
    }
    console.log('[VTID-01030] Rendering OASIS ledger table with', items.length, 'items');

    var table = document.createElement('table');
    table.className = 'vtids-table oasis-ledger-table';

    // Header row
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    ['VTID', 'Title', 'Stage', 'Status', 'Attention', 'Last Update'].forEach(function(h) {
        var th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body rows
    // VTID-01030: Try/catch per-row to prevent one bad VTID from crashing table
    var tbody = document.createElement('tbody');
    items.forEach(function(item) {
        try {
            // VTID-01030: Skip null/undefined items
            if (!item) {
                console.warn('[VTID-01030] Skipping null/undefined OASIS VTID item');
                return;
            }

            var row = document.createElement('tr');
            row.className = 'vtid-row oasis-vtid-row clickable-row';
            if (oasisVtidDetail.selectedVtid === item.vtid) {
                row.className += ' selected';
            }

            // Click to show drilldown
            row.onclick = function() {
                fetchOasisVtidDetail(item.vtid);
            };

            // VTID column
            var vtidCell = document.createElement('td');
            vtidCell.className = 'vtid-cell';
            vtidCell.textContent = item.vtid || '—';
            row.appendChild(vtidCell);

            // Title column
            var titleCell = document.createElement('td');
            titleCell.textContent = item.title || '—';
            row.appendChild(titleCell);

            // VTID-01016: Derive Stage/Status from OASIS event authority
            // VTID-01030: Null-safe derivation with fallback defaults
            var derived = deriveVtidStageStatus(item) || { stage: 'Scheduled', status: 'scheduled' };

            // Stage column (Scheduled/Queued/Planner/Worker/Validator/Deploy/Done)
            var stageCell = document.createElement('td');
            var stageBadge = document.createElement('span');
            var stageVal = (derived.stage || 'scheduled').toLowerCase();
            stageBadge.className = 'vtid-stage-badge vtid-stage-' + stageVal;
            stageBadge.textContent = derived.stage || 'Scheduled';
            stageCell.appendChild(stageBadge);
            row.appendChild(stageCell);

            // Status column (scheduled/in_progress/success/failed)
            var statusCell = document.createElement('td');
            var statusBadge = document.createElement('span');
            var statusVal = (derived.status || 'scheduled').toLowerCase();
            statusBadge.className = 'vtid-status-badge vtid-status-' + statusVal;
            statusBadge.textContent = derived.status || 'scheduled';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // Attention column
            var attentionCell = document.createElement('td');
            var attentionBadge = document.createElement('span');
            var attentionVal = item.attention_required || 'AUTO';
            attentionBadge.className = 'vtid-attention-badge vtid-attention-' + attentionVal.toLowerCase();
            attentionBadge.textContent = attentionVal === 'HUMAN' ? '⚠️ HUMAN' : 'AUTO';
            attentionCell.appendChild(attentionBadge);
            row.appendChild(attentionCell);

            // Last Update column
            var updateCell = document.createElement('td');
            updateCell.textContent = item.last_update ? formatEventTimestamp(item.last_update) : '—';
            row.appendChild(updateCell);

            tbody.appendChild(row);
        } catch (err) {
            console.error('[VTID-01030] Failed to render OASIS VTID row:', item && item.vtid, err);
            // Skip this row but continue rendering others
        }
    });
    console.log('[VTID-01030] OASIS ledger tbody created with', tbody.children.length, 'rows');
    table.appendChild(tbody);

    return table;
}

/**
 * VTID-01001: Renders OASIS VTID drilldown detail panel
 */
function renderOasisVtidDetailPanel() {
    var panel = document.createElement('div');
    panel.className = 'oasis-vtid-detail-panel';

    if (!oasisVtidDetail.selectedVtid) {
        panel.innerHTML = '<div class="detail-placeholder">Select a VTID from the list to view details</div>';
        return panel;
    }

    if (oasisVtidDetail.loading) {
        panel.innerHTML = '<div class="detail-loading">Loading VTID details...</div>';
        return panel;
    }

    if (oasisVtidDetail.error) {
        panel.innerHTML = '<div class="detail-error">Error: ' + oasisVtidDetail.error + '</div>';
        return panel;
    }

    var data = oasisVtidDetail.data;
    if (!data) {
        panel.innerHTML = '<div class="detail-placeholder">No data available</div>';
        return panel;
    }

    // Header with VTID
    var header = document.createElement('div');
    header.className = 'detail-header';
    header.innerHTML = '<h3>' + (data.vtid || 'Unknown VTID') + '</h3>' +
                       '<span class="detail-title">' + (data.title || data.summary || '—') + '</span>';
    panel.appendChild(header);

    // Lifecycle & Timestamps section
    var lifecycleSection = document.createElement('div');
    lifecycleSection.className = 'detail-section';
    lifecycleSection.innerHTML = '<h4>Lifecycle & Timestamps</h4>' +
        '<div class="detail-grid">' +
        '<div><strong>Status:</strong> ' + (data.status || '—') + '</div>' +
        '<div><strong>Layer:</strong> ' + (data.layer || '—') + '</div>' +
        '<div><strong>Module:</strong> ' + (data.module || '—') + '</div>' +
        '<div><strong>Created:</strong> ' + (data.created_at ? formatEventTimestamp(data.created_at) : '—') + '</div>' +
        '<div><strong>Updated:</strong> ' + (data.updated_at ? formatEventTimestamp(data.updated_at) : '—') + '</div>' +
        '</div>';
    panel.appendChild(lifecycleSection);

    // Stage Timeline section (if available)
    if (data.stageTimeline && Array.isArray(data.stageTimeline)) {
        var timelineSection = document.createElement('div');
        timelineSection.className = 'detail-section';
        timelineSection.innerHTML = '<h4>Stage Timeline</h4>';
        var timelineGrid = document.createElement('div');
        timelineGrid.className = 'stage-timeline-grid';
        data.stageTimeline.forEach(function(stage) {
            var stageItem = document.createElement('div');
            stageItem.className = 'stage-item stage-' + (stage.status || 'pending').toLowerCase();
            stageItem.innerHTML = '<span class="stage-name">' + stage.stage + '</span>' +
                                  '<span class="stage-status">' + (stage.status || 'PENDING') + '</span>';
            timelineGrid.appendChild(stageItem);
        });
        timelineSection.appendChild(timelineGrid);
        panel.appendChild(timelineSection);
    }

    // Events Timeline section
    var eventsSection = document.createElement('div');
    eventsSection.className = 'detail-section';
    eventsSection.innerHTML = '<h4>Events Timeline (' + oasisVtidDetail.events.length + ')</h4>';

    if (oasisVtidDetail.events.length === 0) {
        eventsSection.innerHTML += '<div class="no-events">No events recorded for this VTID</div>';
    } else {
        var eventsList = document.createElement('div');
        eventsList.className = 'events-list';
        oasisVtidDetail.events.slice(0, 20).forEach(function(event) {
            var eventItem = document.createElement('div');
            eventItem.className = 'event-item event-' + (event.status || 'info').toLowerCase();
            eventItem.innerHTML =
                '<div class="event-header">' +
                '<span class="event-type">' + (event.type || event.topic || 'unknown') + '</span>' +
                '<span class="event-time">' + (event.created_at ? formatEventTimestamp(event.created_at) : '—') + '</span>' +
                '</div>' +
                '<div class="event-message">' + (event.message || '—') + '</div>';
            eventsList.appendChild(eventItem);
        });
        eventsSection.appendChild(eventsList);
    }
    panel.appendChild(eventsSection);

    // Governance Decisions section (if any governance events)
    var governanceEvents = oasisVtidDetail.events.filter(function(e) {
        return (e.type || e.topic || '').toLowerCase().includes('governance') ||
               (e.message || '').toLowerCase().includes('governance');
    });
    if (governanceEvents.length > 0) {
        var governanceSection = document.createElement('div');
        governanceSection.className = 'detail-section';
        governanceSection.innerHTML = '<h4>Governance Decisions</h4>';
        var govList = document.createElement('div');
        govList.className = 'governance-list';
        governanceEvents.forEach(function(event) {
            var govItem = document.createElement('div');
            govItem.className = 'governance-item';
            govItem.innerHTML =
                '<span class="gov-status">' + (event.status || 'info') + '</span>' +
                '<span class="gov-message">' + (event.message || '—') + '</span>' +
                '<span class="gov-time">' + (event.created_at ? formatEventTimestamp(event.created_at) : '') + '</span>';
            govList.appendChild(govItem);
        });
        governanceSection.appendChild(govList);
        panel.appendChild(governanceSection);
    }

    // Provenance section
    var provenanceSection = document.createElement('div');
    provenanceSection.className = 'detail-section';
    provenanceSection.innerHTML = '<h4>Provenance</h4>' +
        '<div class="provenance-info">' +
        '<div><strong>VTID:</strong> ' + (data.vtid || '—') + '</div>' +
        '<div><strong>Source:</strong> OASIS Ledger</div>' +
        '<div><strong>Events Count:</strong> ' + oasisVtidDetail.events.length + '</div>' +
        '</div>';
    panel.appendChild(provenanceSection);

    return panel;
}

/**
 * VTID-01001: Renders the OASIS > VTID Ledger view
 * VTID-01189: Fixed to match standard list + drawer pattern (like OASIS Events)
 * - Full-width table, clicking row opens drawer
 * - Load More button at bottom
 */
function renderOasisVtidLedgerView() {
    var container = document.createElement('div');
    container.className = 'oasis-events-container vtid-ledger-view';

    // Auto-fetch VTIDs if not yet fetched
    if (!state.vtidProjection.fetched && !state.vtidProjection.loading) {
        fetchVtidProjection(false);
    }

    // Toolbar with count
    var toolbar = document.createElement('div');
    toolbar.className = 'list-toolbar';

    var filtersCluster = document.createElement('div');
    filtersCluster.className = 'list-toolbar__filters';
    toolbar.appendChild(filtersCluster);

    var metadataCluster = document.createElement('div');
    metadataCluster.className = 'list-toolbar__metadata';
    metadataCluster.textContent = state.vtidProjection.items.length + ' VTIDs';
    toolbar.appendChild(metadataCluster);

    container.appendChild(toolbar);

    // Content area
    var content = document.createElement('div');
    content.className = 'oasis-events-content';

    if (state.vtidProjection.loading && state.vtidProjection.items.length === 0) {
        content.innerHTML = '<div class="placeholder-content">Loading VTID Ledger...</div>';
    } else if (state.vtidProjection.error) {
        content.innerHTML = '<div class="error-banner">Error loading VTID Ledger: ' + state.vtidProjection.error + '</div>';
    } else if (state.vtidProjection.items.length === 0) {
        content.innerHTML = '<div class="placeholder-content">No VTIDs found in ledger.</div>';
    } else {
        // Table
        var table = document.createElement('table');
        table.className = 'oasis-events-table vtid-ledger-table';

        // Header
        var thead = document.createElement('thead');
        thead.innerHTML = '<tr>' +
            '<th>VTID</th>' +
            '<th>Title</th>' +
            '<th>Stage</th>' +
            '<th>Status</th>' +
            '<th>Attention</th>' +
            '<th>Last Update</th>' +
            '</tr>';
        table.appendChild(thead);

        // Body
        var tbody = document.createElement('tbody');
        state.vtidProjection.items.forEach(function(item) {
            var row = document.createElement('tr');
            row.className = 'vtid-ledger-row clickable-row';
            if (oasisVtidDetail.selectedVtid === item.vtid) {
                row.classList.add('selected');
            }
            row.onclick = function() {
                fetchOasisVtidDetail(item.vtid);
            };

            // VTID
            var vtidCell = document.createElement('td');
            vtidCell.className = 'vtid-cell';
            vtidCell.textContent = item.vtid || '-';
            row.appendChild(vtidCell);

            // Title
            var titleCell = document.createElement('td');
            titleCell.className = 'title-cell';
            titleCell.textContent = item.title || '-';
            row.appendChild(titleCell);

            // Stage
            var stageCell = document.createElement('td');
            var stageBadge = document.createElement('span');
            stageBadge.className = 'status-badge stage-' + (item.current_stage || 'pending').toLowerCase();
            stageBadge.textContent = item.current_stage || '-';
            stageCell.appendChild(stageBadge);
            row.appendChild(stageCell);

            // Status
            var statusCell = document.createElement('td');
            var statusBadge = document.createElement('span');
            statusBadge.className = 'status-badge status-' + (item.status || 'pending').toLowerCase();
            statusBadge.textContent = item.status || '-';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // Attention
            var attentionCell = document.createElement('td');
            attentionCell.className = 'attention-cell';
            attentionCell.textContent = item.attention_required || 'AUTO';
            row.appendChild(attentionCell);

            // Last Update
            var updateCell = document.createElement('td');
            updateCell.className = 'update-cell';
            updateCell.textContent = item.last_update ? formatEventTimestamp(item.last_update) : '-';
            row.appendChild(updateCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        content.appendChild(table);

        // Load More button
        if (state.vtidProjection.pagination.hasMore) {
            var loadMoreContainer = document.createElement('div');
            loadMoreContainer.className = 'load-more-container';

            var loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'load-more-btn' + (state.vtidProjection.loading ? ' loading' : '');
            loadMoreBtn.disabled = state.vtidProjection.loading;
            loadMoreBtn.textContent = state.vtidProjection.loading ? 'Loading...' : 'Load More';
            loadMoreBtn.onclick = function(e) {
                e.preventDefault();
                loadMoreVtidProjection();
            };
            loadMoreContainer.appendChild(loadMoreBtn);
            content.appendChild(loadMoreContainer);
        }
    }

    container.appendChild(content);
    return container;
}

/**
 * VTID-01189: Renders the VTID Ledger detail drawer (standard drawer pattern)
 */
function renderOasisVtidLedgerDrawer() {
    var drawer = document.createElement('div');
    drawer.className = 'drawer vtid-ledger-drawer' + (oasisVtidDetail.selectedVtid ? ' open' : '');

    if (!oasisVtidDetail.selectedVtid) {
        return drawer;
    }

    // Header
    var header = document.createElement('div');
    header.className = 'drawer-header';

    var title = document.createElement('h3');
    title.textContent = oasisVtidDetail.selectedVtid || 'VTID Details';
    header.appendChild(title);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = function() {
        oasisVtidDetail.selectedVtid = null;
        oasisVtidDetail.data = null;
        oasisVtidDetail.events = [];
        oasisVtidDetail.error = null;
        renderApp();
    };
    header.appendChild(closeBtn);
    drawer.appendChild(header);

    // Content
    var content = document.createElement('div');
    content.className = 'drawer-content';

    if (oasisVtidDetail.loading) {
        content.innerHTML = '<div class="drawer-loading">Loading VTID details...</div>';
    } else if (oasisVtidDetail.error) {
        content.innerHTML = '<div class="drawer-error">Error: ' + oasisVtidDetail.error + '</div>';
    } else if (oasisVtidDetail.data) {
        var data = oasisVtidDetail.data;

        // Title
        if (data.title) {
            var titleSection = document.createElement('div');
            titleSection.className = 'drawer-section';
            titleSection.innerHTML = '<div class="vtid-title">' + data.title + '</div>';
            content.appendChild(titleSection);
        }

        // Lifecycle & Timestamps
        var lifecycleSection = document.createElement('div');
        lifecycleSection.className = 'drawer-section';
        lifecycleSection.innerHTML = '<h4>Lifecycle & Timestamps</h4>' +
            '<div class="drawer-grid">' +
            '<div><strong>Status:</strong> ' + (data.status || 'pending') + '</div>' +
            '<div><strong>Layer:</strong> ' + (data.layer || 'DEV') + '</div>' +
            '<div><strong>Module:</strong> ' + (data.module || '-') + '</div>' +
            '<div><strong>Created:</strong> ' + (data.created_at ? formatEventTimestamp(data.created_at) : '-') + '</div>' +
            '<div><strong>Updated:</strong> ' + (data.updated_at ? formatEventTimestamp(data.updated_at) : '-') + '</div>' +
            '</div>';
        content.appendChild(lifecycleSection);

        // Stage Timeline
        if (data.stageTimeline && data.stageTimeline.length > 0) {
            var timelineSection = document.createElement('div');
            timelineSection.className = 'drawer-section';
            timelineSection.innerHTML = '<h4>Stage Timeline</h4>';
            var timelineDiv = document.createElement('div');
            timelineDiv.className = 'stage-timeline';
            data.stageTimeline.forEach(function(stage) {
                var stageItem = document.createElement('div');
                stageItem.className = 'stage-item stage-' + (stage.status || 'pending').toLowerCase();
                stageItem.innerHTML = '<span class="stage-name">' + stage.stage + '</span>' +
                                      '<span class="stage-status">' + (stage.status || 'PENDING') + '</span>';
                timelineDiv.appendChild(stageItem);
            });
            timelineSection.appendChild(timelineDiv);
            content.appendChild(timelineSection);
        }

        // Events
        var eventsSection = document.createElement('div');
        eventsSection.className = 'drawer-section';
        eventsSection.innerHTML = '<h4>Events Timeline (' + oasisVtidDetail.events.length + ')</h4>';

        if (oasisVtidDetail.events.length === 0) {
            eventsSection.innerHTML += '<div class="no-events">No events recorded</div>';
        } else {
            var eventsList = document.createElement('div');
            eventsList.className = 'events-list';
            oasisVtidDetail.events.slice(0, 20).forEach(function(event) {
                var eventItem = document.createElement('div');
                eventItem.className = 'event-item';
                eventItem.innerHTML = '<div class="event-topic">' + (event.topic || '-') + '</div>' +
                    '<div class="event-time">' + (event.created_at ? formatEventTimestamp(event.created_at) : '-') + '</div>' +
                    '<div class="event-message">' + (event.message || '-') + '</div>';
                eventsList.appendChild(eventItem);
            });
            eventsSection.appendChild(eventsList);
        }
        content.appendChild(eventsSection);

        // Provenance
        var provenanceSection = document.createElement('div');
        provenanceSection.className = 'drawer-section';
        provenanceSection.innerHTML = '<h4>Provenance</h4>' +
            '<div class="drawer-grid">' +
            '<div><strong>VTID:</strong> ' + (data.vtid || '-') + '</div>' +
            '<div><strong>Source:</strong> OASIS Ledger</div>' +
            '</div>';
        content.appendChild(provenanceSection);
    }

    drawer.appendChild(content);
    return drawer;
}

// =============================================================================
// VTID-01086: Memory Garden UI Deepening
// =============================================================================

/**
 * VTID-01086: Memory Garden category icons mapping
 */
const MEMORY_GARDEN_ICONS = {
    personal_identity: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
    health_wellness: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    lifestyle_routines: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/></svg>',
    network_relationships: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
    learning_knowledge: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>',
    business_projects: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg>',
    finance_assets: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>',
    location_environment: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>',
    digital_footprint: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>',
    values_aspirations: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
    autopilot_context: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6zm2 2v2h8v-2H6zm10 0v6h2V8h-2zm-10 4v2h5v-2H6z"/></svg>',
    future_plans: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1c.61 0 1.1-.49 1.1-1.1s-.49-1.1-1.1-1.1zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm2.19 12.19L6 18l3.81-8.19L18 6l-3.81 8.19z"/></svg>',
    uncategorized: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
};

/**
 * VTID-01086: Longevity messaging (deterministic, no AI)
 */
const LONGEVITY_MESSAGES = {
    sleep_declining: 'Sleep drives recovery and longevity. Poor sleep quality accelerates aging and impairs immune function.',
    sleep_stable: 'Maintaining consistent sleep patterns supports cellular repair and memory consolidation.',
    sleep_improving: 'Improved sleep quality enhances cognitive function and metabolic health.',
    stress_high: 'Stress management reduces inflammation and cortisol, protecting cardiovascular health.',
    stress_moderate: 'Moderate stress levels allow for recovery. Consider building stress resilience practices.',
    stress_low: 'Low stress levels support immune function and mental clarity.',
    movement_low: 'Daily movement improves metabolic health and reduces risk of chronic disease.',
    movement_moderate: 'Regular movement supports cardiovascular health and bone density.',
    movement_high: 'Active lifestyle correlates with increased lifespan and cognitive health.'
};

/**
 * VTID-01086: Fetch Memory Garden progress from API
 */
async function fetchMemoryGardenProgress() {
    if (state.memoryGarden.loading) return;

    state.memoryGarden.loading = true;
    state.memoryGarden.error = null;
    renderApp();

    try {
        const token = state.authToken;
        if (!token) {
            throw new Error('Not authenticated');
        }

        const response = await fetch('/api/v1/memory/garden/progress', {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to fetch progress');
        }

        const data = await response.json();

        state.memoryGarden.progress = data;
        state.memoryGarden.fetched = true;
        state.memoryGarden.loading = false;
        state.memoryGarden.error = null;

        console.log('[VTID-01086] Memory Garden progress fetched:', data.totals);
    } catch (err) {
        console.error('[VTID-01086] Error fetching progress:', err);
        state.memoryGarden.loading = false;
        state.memoryGarden.error = err.message;
    }

    renderApp();
}

/**
 * VTID-01086: Fetch longevity summary for the Longevity Focus panel
 */
async function fetchLongevitySummary() {
    if (state.memoryGarden.longevityLoading) return;

    state.memoryGarden.longevityLoading = true;
    state.memoryGarden.longevityError = null;
    renderApp();

    try {
        const token = state.authToken;
        if (!token) {
            throw new Error('Not authenticated');
        }

        // Use memory/retrieve endpoint with longevity intent (as per spec)
        const response = await fetch('/api/v1/memory/retrieve', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                intent: 'longevity',
                mode: 'summary',
                include: ['garden', 'longevity', 'community', 'diary']
            })
        });

        // If endpoint doesn't exist yet, use placeholder data
        if (response.status === 404 || response.status === 503) {
            console.warn('[VTID-01086] Longevity retrieve endpoint not available, using placeholder');
            state.memoryGarden.longevity = {
                sleep: { trend: 'stable', value: 7.2, unit: 'hrs' },
                stress: { trend: 'moderate', value: 42, unit: 'score' },
                movement: { trend: 'moderate', value: 6500, unit: 'steps' },
                recommendation: {
                    type: 'community',
                    title: 'Morning Wellness Circle',
                    description: 'Join others focused on healthy morning routines'
                }
            };
            state.memoryGarden.longevityLoading = false;
            renderApp();
            return;
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to fetch longevity data');
        }

        const data = await response.json();
        state.memoryGarden.longevity = data;
        state.memoryGarden.longevityLoading = false;
        state.memoryGarden.longevityError = null;

        console.log('[VTID-01086] Longevity summary fetched');
    } catch (err) {
        console.error('[VTID-01086] Error fetching longevity:', err);
        state.memoryGarden.longevityLoading = false;
        // Use placeholder on error
        state.memoryGarden.longevity = {
            sleep: { trend: 'stable', value: 7.2, unit: 'hrs' },
            stress: { trend: 'moderate', value: 42, unit: 'score' },
            movement: { trend: 'moderate', value: 6500, unit: 'steps' },
            recommendation: {
                type: 'community',
                title: 'Morning Wellness Circle',
                description: 'Join others focused on healthy morning routines'
            }
        };
    }

    renderApp();
}

/**
 * VTID-01086: Refresh Memory Garden (progress + longevity)
 */
async function refreshMemoryGarden() {
    // Emit UI refreshed OASIS event (via gateway)
    console.log('[VTID-01086] Refreshing Memory Garden');

    // Reset fetched flags to force refetch
    state.memoryGarden.fetched = false;
    state.memoryGarden.longevity = null;

    // Fetch both in parallel
    await Promise.all([
        fetchMemoryGardenProgress(),
        fetchLongevitySummary()
    ]);
}

/**
 * VTID-01086: Render the Memory Garden view
 */
function renderMemoryGardenView() {
    var container = document.createElement('div');
    container.className = 'memory-garden-container';

    // Auto-fetch if not yet fetched and not loading
    if (!state.memoryGarden.fetched && !state.memoryGarden.loading) {
        fetchMemoryGardenProgress();
        fetchLongevitySummary();
    }

    // Header with title and actions
    var header = document.createElement('div');
    header.className = 'memory-garden-header';

    var titleSection = document.createElement('div');
    titleSection.className = 'memory-garden-title-section';

    var title = document.createElement('h2');
    title.textContent = 'Memory Garden';
    titleSection.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    var totalMemories = state.memoryGarden.progress?.totals?.memories || 0;
    subtitle.textContent = 'Your personal memory vault • ' + totalMemories + ' memories stored';
    titleSection.appendChild(subtitle);

    header.appendChild(titleSection);

    // Quick actions
    var actions = document.createElement('div');
    actions.className = 'memory-garden-actions';

    // Add Diary Entry button
    var addDiaryBtn = document.createElement('button');
    addDiaryBtn.className = 'btn btn-primary';
    addDiaryBtn.textContent = '+ Add Diary Entry';
    addDiaryBtn.onclick = function() {
        state.memoryGarden.showDiaryModal = true;
        renderApp();
    };
    actions.appendChild(addDiaryBtn);

    // SPEC-01: Per-view refresh buttons removed - use global refresh icon in header

    header.appendChild(actions);
    container.appendChild(header);

    // Loading state
    if (state.memoryGarden.loading) {
        var loadingDiv = document.createElement('div');
        loadingDiv.className = 'memory-garden-loading';
        loadingDiv.textContent = 'Loading Memory Garden...';
        container.appendChild(loadingDiv);
        return container;
    }

    // Error state
    if (state.memoryGarden.error) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'memory-garden-error';
        errorDiv.textContent = 'Error: ' + state.memoryGarden.error;
        container.appendChild(errorDiv);
        return container;
    }

    // Main content area
    var mainContent = document.createElement('div');
    mainContent.className = 'memory-garden-main';

    // Longevity Focus Today panel (first row)
    mainContent.appendChild(renderLongevityFocusPanel());

    // Category cards grid
    var grid = document.createElement('div');
    grid.className = 'memory-garden-grid';

    var categories = state.memoryGarden.progress?.categories || {};
    var categoryOrder = [
        'personal_identity', 'health_wellness', 'lifestyle_routines', 'network_relationships',
        'learning_knowledge', 'business_projects', 'finance_assets', 'location_environment',
        'digital_footprint', 'values_aspirations', 'autopilot_context', 'future_plans', 'uncategorized'
    ];

    categoryOrder.forEach(function(key) {
        var cat = categories[key];
        if (cat) {
            grid.appendChild(renderMemoryGardenCard(key, cat));
        }
    });

    mainContent.appendChild(grid);
    container.appendChild(mainContent);

    // Diary entry modal
    if (state.memoryGarden.showDiaryModal) {
        container.appendChild(renderDiaryEntryModal());
    }

    return container;
}

/**
 * VTID-01086: Render the Longevity Focus Today panel
 */
function renderLongevityFocusPanel() {
    var panel = document.createElement('div');
    panel.className = 'longevity-focus-panel';

    var panelHeader = document.createElement('div');
    panelHeader.className = 'longevity-panel-header';

    var panelTitle = document.createElement('h3');
    panelTitle.textContent = 'Longevity Focus Today';
    panelHeader.appendChild(panelTitle);

    panel.appendChild(panelHeader);

    // Loading state
    if (state.memoryGarden.longevityLoading) {
        var loading = document.createElement('div');
        loading.className = 'longevity-loading';
        loading.textContent = 'Loading longevity data...';
        panel.appendChild(loading);
        return panel;
    }

    var data = state.memoryGarden.longevity;
    if (!data) {
        var noData = document.createElement('div');
        noData.className = 'longevity-no-data';
        noData.textContent = 'No longevity data available yet. Add health memories to get started.';
        panel.appendChild(noData);
        return panel;
    }

    // Signals container
    var signals = document.createElement('div');
    signals.className = 'longevity-signals';

    // Sleep signal
    if (data.sleep) {
        signals.appendChild(renderLongevitySignal('Sleep', data.sleep.trend, data.sleep.value, data.sleep.unit));
    }

    // Stress signal
    if (data.stress) {
        signals.appendChild(renderLongevitySignal('Stress', data.stress.trend, data.stress.value, data.stress.unit));
    }

    // Movement signal
    if (data.movement) {
        signals.appendChild(renderLongevitySignal('Movement', data.movement.trend, data.movement.value, data.movement.unit));
    }

    panel.appendChild(signals);

    // Community recommendation
    if (data.recommendation) {
        var recBox = document.createElement('div');
        recBox.className = 'longevity-recommendation';

        var recTitle = document.createElement('div');
        recTitle.className = 'rec-title';
        recTitle.textContent = 'Recommended: ' + data.recommendation.title;
        recBox.appendChild(recTitle);

        var recDesc = document.createElement('div');
        recDesc.className = 'rec-description';
        recDesc.textContent = data.recommendation.description;
        recBox.appendChild(recDesc);

        panel.appendChild(recBox);
    }

    // "Why this matters" section
    var whyMatters = document.createElement('div');
    whyMatters.className = 'longevity-why-matters';

    var whyTitle = document.createElement('div');
    whyTitle.className = 'why-title';
    whyTitle.textContent = 'Why this matters';
    whyMatters.appendChild(whyTitle);

    // Pick the most relevant message based on trends
    var message = '';
    if (data.sleep?.trend === 'declining') {
        message = LONGEVITY_MESSAGES.sleep_declining;
    } else if (data.stress?.trend === 'high') {
        message = LONGEVITY_MESSAGES.stress_high;
    } else if (data.movement?.trend === 'low') {
        message = LONGEVITY_MESSAGES.movement_low;
    } else if (data.sleep?.trend === 'improving') {
        message = LONGEVITY_MESSAGES.sleep_improving;
    } else {
        message = LONGEVITY_MESSAGES.sleep_stable;
    }

    var whyText = document.createElement('div');
    whyText.className = 'why-text';
    whyText.textContent = message;
    whyMatters.appendChild(whyText);

    panel.appendChild(whyMatters);

    return panel;
}

/**
 * VTID-01086: Render a longevity signal (sleep/stress/movement)
 */
function renderLongevitySignal(label, trend, value, unit) {
    var signal = document.createElement('div');
    signal.className = 'longevity-signal';

    var labelEl = document.createElement('div');
    labelEl.className = 'signal-label';
    labelEl.textContent = label;
    signal.appendChild(labelEl);

    var valueEl = document.createElement('div');
    valueEl.className = 'signal-value';
    valueEl.textContent = value + ' ' + unit;
    signal.appendChild(valueEl);

    var trendEl = document.createElement('div');
    trendEl.className = 'signal-trend trend-' + trend;

    var trendIcon = '';
    if (trend === 'improving' || trend === 'high') {
        trendIcon = '↑';
    } else if (trend === 'declining' || trend === 'low') {
        trendIcon = '↓';
    } else {
        trendIcon = '→';
    }
    trendEl.textContent = trendIcon + ' ' + trend;
    signal.appendChild(trendEl);

    return signal;
}

/**
 * VTID-01086: Render a Memory Garden category card
 */
function renderMemoryGardenCard(key, category) {
    var card = document.createElement('div');
    card.className = 'memory-garden-card';
    card.dataset.category = key;

    // Icon
    var iconContainer = document.createElement('div');
    iconContainer.className = 'card-icon';
    iconContainer.innerHTML = MEMORY_GARDEN_ICONS[key] || MEMORY_GARDEN_ICONS.uncategorized;
    card.appendChild(iconContainer);

    // Label
    var labelEl = document.createElement('div');
    labelEl.className = 'card-label';
    labelEl.textContent = category.label || key.replace(/_/g, ' ');
    card.appendChild(labelEl);

    // Count
    var countEl = document.createElement('div');
    countEl.className = 'card-count';
    var count = category.count || 0;
    countEl.textContent = count + ' ' + (count === 1 ? 'memory' : 'memories');
    card.appendChild(countEl);

    // Progress bar
    var progressContainer = document.createElement('div');
    progressContainer.className = 'card-progress-container';

    var progressBar = document.createElement('div');
    progressBar.className = 'card-progress-bar';

    var progressFill = document.createElement('div');
    progressFill.className = 'card-progress-fill';
    var progress = category.progress || 0;
    progressFill.style.width = (progress * 100) + '%';
    progressBar.appendChild(progressFill);
    progressContainer.appendChild(progressBar);

    var progressText = document.createElement('div');
    progressText.className = 'card-progress-text';
    progressText.textContent = Math.round(progress * 100) + '%';
    progressContainer.appendChild(progressText);

    card.appendChild(progressContainer);

    // Description (subtle)
    if (category.description) {
        var descEl = document.createElement('div');
        descEl.className = 'card-description';
        descEl.textContent = category.description;
        card.appendChild(descEl);
    }

    return card;
}

/**
 * VTID-01086: Render diary entry modal
 */
function renderDiaryEntryModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = function(e) {
        if (e.target === overlay) {
            state.memoryGarden.showDiaryModal = false;
            renderApp();
        }
    };

    var modal = document.createElement('div');
    modal.className = 'modal diary-entry-modal';

    // Header
    var header = document.createElement('div');
    header.className = 'modal-header';

    var title = document.createElement('h3');
    title.textContent = 'Add Diary Entry';
    header.appendChild(title);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close-btn';
    closeBtn.textContent = '×';
    closeBtn.onclick = function() {
        state.memoryGarden.showDiaryModal = false;
        renderApp();
    };
    header.appendChild(closeBtn);

    modal.appendChild(header);

    // Body
    var body = document.createElement('div');
    body.className = 'modal-body';

    var textarea = document.createElement('textarea');
    textarea.className = 'diary-textarea';
    textarea.placeholder = 'What would you like to remember? Share a thought, experience, or insight...';
    textarea.rows = 6;
    textarea.id = 'diary-entry-text';
    body.appendChild(textarea);

    var hint = document.createElement('div');
    hint.className = 'diary-hint';
    hint.textContent = 'Your entry will be automatically categorized and added to your Memory Garden.';
    body.appendChild(hint);

    modal.appendChild(body);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'modal-footer';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = function() {
        state.memoryGarden.showDiaryModal = false;
        renderApp();
    };
    footer.appendChild(cancelBtn);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save Entry';
    saveBtn.onclick = async function() {
        var content = document.getElementById('diary-entry-text').value.trim();
        if (!content) {
            alert('Please enter some content');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
            var response = await fetch('/api/v1/memory/write', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + state.authToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    source: 'diary',
                    content: content,
                    importance: 50
                })
            });

            if (!response.ok) {
                throw new Error('Failed to save diary entry');
            }

            // Close modal and refresh
            state.memoryGarden.showDiaryModal = false;
            state.memoryGarden.fetched = false;
            fetchMemoryGardenProgress();

            // Show toast notification
            addToast('Diary entry saved successfully', 'success');
        } catch (err) {
            console.error('[VTID-01086] Error saving diary entry:', err);
            alert('Failed to save entry: ' + err.message);
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Entry';
        }
    };
    footer.appendChild(saveBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);

    return overlay;
}

// ============================================================================
// INTELLIGENCE & MEMORY DEV SCREENS
// Vitana AI Assistant Intelligence Hub - Knowledge Graph, Embeddings, Recall, Inspector
// ============================================================================

/**
 * Intelligence & Memory: Knowledge Graph View
 * Visualizes entity relationships, concepts, and memory connections
 */
function renderKnowledgeGraphView() {
    var container = document.createElement('div');
    container.className = 'intelligence-container knowledge-graph-container';

    // Header
    var header = document.createElement('div');
    header.className = 'intelligence-header';

    var titleSection = document.createElement('div');
    titleSection.className = 'intelligence-title-section';

    var title = document.createElement('h2');
    title.textContent = 'Knowledge Graph';
    titleSection.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'Entity relationships and concept connections powering the AI Assistant';
    titleSection.appendChild(subtitle);

    header.appendChild(titleSection);
    container.appendChild(header);

    // Stats bar
    var statsBar = document.createElement('div');
    statsBar.className = 'intelligence-stats-bar';

    var stats = state.intelligence.knowledgeGraph.stats || {
        nodes: 0,
        edges: 0,
        entities: 0,
        concepts: 0,
        memories: 0
    };

    var statItems = [
        { label: 'Total Nodes', value: stats.nodes || 0, icon: 'node' },
        { label: 'Connections', value: stats.edges || 0, icon: 'edge' },
        { label: 'Entities', value: stats.entities || 0, icon: 'entity' },
        { label: 'Concepts', value: stats.concepts || 0, icon: 'concept' },
        { label: 'Memories', value: stats.memories || 0, icon: 'memory' }
    ];

    statItems.forEach(function(stat) {
        var statCard = document.createElement('div');
        statCard.className = 'stat-card';
        statCard.innerHTML = '<div class="stat-icon stat-icon-' + stat.icon + '">' + getKnowledgeGraphIcon(stat.icon) + '</div>' +
            '<div class="stat-content"><div class="stat-value">' + stat.value.toLocaleString() + '</div>' +
            '<div class="stat-label">' + stat.label + '</div></div>';
        statsBar.appendChild(statCard);
    });

    container.appendChild(statsBar);

    // Toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'intelligence-toolbar';

    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search-field';
    searchInput.placeholder = 'Search nodes...';
    searchInput.value = state.intelligence.knowledgeGraph.searchQuery;
    searchInput.oninput = function(e) {
        state.intelligence.knowledgeGraph.searchQuery = e.target.value;
        renderApp();
    };
    toolbar.appendChild(searchInput);

    var filterSelect = document.createElement('select');
    filterSelect.className = 'filter-select';
    var filterOptions = [
        { value: 'all', label: 'All Types' },
        { value: 'entity', label: 'Entities' },
        { value: 'concept', label: 'Concepts' },
        { value: 'memory', label: 'Memories' }
    ];
    filterOptions.forEach(function(opt) {
        var option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        option.selected = state.intelligence.knowledgeGraph.filterType === opt.value;
        filterSelect.appendChild(option);
    });
    filterSelect.onchange = function(e) {
        state.intelligence.knowledgeGraph.filterType = e.target.value;
        renderApp();
    };
    toolbar.appendChild(filterSelect);

    container.appendChild(toolbar);

    // Main content - split layout
    var mainContent = document.createElement('div');
    mainContent.className = 'knowledge-graph-main';

    // Left: Graph visualization placeholder
    var graphPanel = document.createElement('div');
    graphPanel.className = 'knowledge-graph-panel';

    var graphPlaceholder = document.createElement('div');
    graphPlaceholder.className = 'graph-visualization-placeholder';
    graphPlaceholder.innerHTML = '<div class="graph-placeholder-content">' +
        '<div class="graph-icon">' + getKnowledgeGraphIcon('graph') + '</div>' +
        '<div class="graph-placeholder-title">Knowledge Graph Visualization</div>' +
        '<div class="graph-placeholder-desc">Interactive graph visualization will render here.<br>Connect to vector database to populate nodes.</div>' +
        '<button class="btn btn-primary" onclick="alert(\'Knowledge graph sync coming soon\')">Sync from Vector DB</button>' +
        '</div>';
    graphPanel.appendChild(graphPlaceholder);

    mainContent.appendChild(graphPanel);

    // Right: Node detail panel
    var detailPanel = document.createElement('div');
    detailPanel.className = 'knowledge-graph-detail';

    var detailTitle = document.createElement('h3');
    detailTitle.textContent = 'Node Details';
    detailPanel.appendChild(detailTitle);

    var selectedNode = state.intelligence.knowledgeGraph.selectedNode;
    if (selectedNode) {
        var nodeDetail = document.createElement('div');
        nodeDetail.className = 'node-detail-content';
        nodeDetail.innerHTML = '<div class="node-detail-field"><span class="field-label">ID:</span> ' + selectedNode.id + '</div>' +
            '<div class="node-detail-field"><span class="field-label">Type:</span> ' + selectedNode.type + '</div>' +
            '<div class="node-detail-field"><span class="field-label">Label:</span> ' + selectedNode.label + '</div>' +
            '<div class="node-detail-field"><span class="field-label">Connections:</span> ' + (selectedNode.connections || 0) + '</div>';
        detailPanel.appendChild(nodeDetail);
    } else {
        var noSelection = document.createElement('div');
        noSelection.className = 'no-selection-message';
        noSelection.textContent = 'Select a node to view details';
        detailPanel.appendChild(noSelection);
    }

    // Recent nodes list
    var recentTitle = document.createElement('h4');
    recentTitle.textContent = 'Recent Nodes';
    recentTitle.className = 'detail-section-title';
    detailPanel.appendChild(recentTitle);

    var recentList = document.createElement('div');
    recentList.className = 'recent-nodes-list';

    // Mock recent nodes for UI scaffolding
    var mockRecentNodes = [
        { id: 'usr_001', type: 'entity', label: 'User Profile' },
        { id: 'mem_142', type: 'memory', label: 'Health Routine' },
        { id: 'con_089', type: 'concept', label: 'Sleep Quality' }
    ];

    mockRecentNodes.forEach(function(node) {
        var nodeItem = document.createElement('div');
        nodeItem.className = 'recent-node-item node-type-' + node.type;
        nodeItem.innerHTML = '<span class="node-type-badge">' + node.type.charAt(0).toUpperCase() + '</span>' +
            '<span class="node-label">' + node.label + '</span>';
        nodeItem.onclick = function() {
            state.intelligence.knowledgeGraph.selectedNode = node;
            renderApp();
        };
        recentList.appendChild(nodeItem);
    });

    detailPanel.appendChild(recentList);

    // Load More button for nodes
    if (state.intelligence.knowledgeGraph.hasMore) {
        var loadMoreContainer = document.createElement('div');
        loadMoreContainer.className = 'load-more-container';

        var loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more-btn' + (state.intelligence.knowledgeGraph.loadingMore ? ' loading' : '');
        loadMoreBtn.disabled = state.intelligence.knowledgeGraph.loadingMore;
        loadMoreBtn.textContent = state.intelligence.knowledgeGraph.loadingMore ? 'Loading...' : 'Load More Nodes';
        loadMoreBtn.onclick = function() {
            state.intelligence.knowledgeGraph.loadingMore = true;
            renderApp();
            // Mock loading more nodes
            setTimeout(function() {
                state.intelligence.knowledgeGraph.offset += state.intelligence.knowledgeGraph.limit;
                state.intelligence.knowledgeGraph.loadingMore = false;
                // In real implementation: fetch more nodes and append
                state.intelligence.knowledgeGraph.hasMore = false; // Mock: no more data
                renderApp();
            }, 800);
        };
        loadMoreContainer.appendChild(loadMoreBtn);
        detailPanel.appendChild(loadMoreContainer);
    }

    mainContent.appendChild(detailPanel);

    container.appendChild(mainContent);

    return container;
}

/**
 * Intelligence & Memory: Embeddings View
 * Manage vector collections and semantic search
 */
function renderEmbeddingsView() {
    var container = document.createElement('div');
    container.className = 'intelligence-container embeddings-container';

    // Header
    var header = document.createElement('div');
    header.className = 'intelligence-header';

    var titleSection = document.createElement('div');
    titleSection.className = 'intelligence-title-section';

    var title = document.createElement('h2');
    title.textContent = 'Embeddings';
    titleSection.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'Vector collections powering semantic search and memory retrieval';
    titleSection.appendChild(subtitle);

    header.appendChild(titleSection);

    // Actions
    var actions = document.createElement('div');
    actions.className = 'intelligence-actions';

    var syncBtn = document.createElement('button');
    syncBtn.className = 'btn btn-secondary';
    syncBtn.textContent = 'Sync Collections';
    syncBtn.onclick = function() {
        showToast('Syncing collections...', 'info');
    };
    actions.appendChild(syncBtn);

    header.appendChild(actions);
    container.appendChild(header);

    // Stats bar
    var statsBar = document.createElement('div');
    statsBar.className = 'intelligence-stats-bar';

    var embeddingStats = state.intelligence.embeddings.stats || {
        collections: 0,
        totalVectors: 0,
        dimensions: 1536,
        avgQueryTime: 0
    };

    var statItems = [
        { label: 'Collections', value: embeddingStats.collections || 3 },
        { label: 'Total Vectors', value: embeddingStats.totalVectors || 12458 },
        { label: 'Dimensions', value: embeddingStats.dimensions || 1536 },
        { label: 'Avg Query (ms)', value: embeddingStats.avgQueryTime || 45 }
    ];

    statItems.forEach(function(stat) {
        var statCard = document.createElement('div');
        statCard.className = 'stat-card';
        statCard.innerHTML = '<div class="stat-value">' + stat.value.toLocaleString() + '</div>' +
            '<div class="stat-label">' + stat.label + '</div>';
        statsBar.appendChild(statCard);
    });

    container.appendChild(statsBar);

    // Main content - Collections grid + Search panel
    var mainContent = document.createElement('div');
    mainContent.className = 'embeddings-main';

    // Left: Collections
    var collectionsPanel = document.createElement('div');
    collectionsPanel.className = 'embeddings-collections-panel';

    var collectionsTitle = document.createElement('h3');
    collectionsTitle.textContent = 'Vector Collections';
    collectionsPanel.appendChild(collectionsTitle);

    var collectionsGrid = document.createElement('div');
    collectionsGrid.className = 'collections-grid';

    // Mock collections for UI scaffolding
    var mockCollections = [
        { id: 'memories', name: 'User Memories', vectors: 8234, status: 'active', model: 'text-embedding-3-small' },
        { id: 'knowledge', name: 'Knowledge Base', vectors: 3156, status: 'active', model: 'text-embedding-3-small' },
        { id: 'conversations', name: 'Conversations', vectors: 1068, status: 'indexing', model: 'text-embedding-3-small' }
    ];

    mockCollections.forEach(function(col) {
        var colCard = document.createElement('div');
        colCard.className = 'collection-card' + (state.intelligence.embeddings.selectedCollection === col.id ? ' selected' : '');
        colCard.innerHTML = '<div class="collection-header">' +
            '<span class="collection-name">' + col.name + '</span>' +
            '<span class="collection-status status-' + col.status + '">' + col.status + '</span>' +
            '</div>' +
            '<div class="collection-stats">' +
            '<div class="collection-stat"><span class="stat-num">' + col.vectors.toLocaleString() + '</span> vectors</div>' +
            '<div class="collection-model">' + col.model + '</div>' +
            '</div>';
        colCard.onclick = function() {
            state.intelligence.embeddings.selectedCollection = col.id;
            renderApp();
        };
        collectionsGrid.appendChild(colCard);
    });

    collectionsPanel.appendChild(collectionsGrid);
    mainContent.appendChild(collectionsPanel);

    // Right: Semantic Search Test
    var searchPanel = document.createElement('div');
    searchPanel.className = 'embeddings-search-panel';

    var searchTitle = document.createElement('h3');
    searchTitle.textContent = 'Semantic Search Test';
    searchPanel.appendChild(searchTitle);

    var searchForm = document.createElement('div');
    searchForm.className = 'search-form';

    var searchInput = document.createElement('textarea');
    searchInput.className = 'search-textarea';
    searchInput.placeholder = 'Enter text to find similar vectors...';
    searchInput.rows = 3;
    searchInput.value = state.intelligence.embeddings.searchQuery;
    searchInput.oninput = function(e) {
        state.intelligence.embeddings.searchQuery = e.target.value;
    };
    searchForm.appendChild(searchInput);

    var searchBtn = document.createElement('button');
    searchBtn.className = 'btn btn-primary';
    searchBtn.textContent = state.intelligence.embeddings.searchLoading ? 'Searching...' : 'Search Vectors';
    searchBtn.disabled = state.intelligence.embeddings.searchLoading;
    searchBtn.onclick = function() {
        if (!state.intelligence.embeddings.searchQuery.trim()) {
            showToast('Enter a search query', 'warning');
            return;
        }
        // Mock search results
        state.intelligence.embeddings.searchLoading = true;
        renderApp();
        setTimeout(function() {
            state.intelligence.embeddings.searchResults = [
                { id: 'vec_001', score: 0.94, text: 'User prefers morning workouts around 6am', collection: 'memories' },
                { id: 'vec_002', score: 0.89, text: 'Sleep quality improves with consistent schedule', collection: 'knowledge' },
                { id: 'vec_003', score: 0.85, text: 'Discussed exercise routines last week', collection: 'conversations' }
            ];
            state.intelligence.embeddings.searchLoading = false;
            renderApp();
        }, 800);
    };
    searchForm.appendChild(searchBtn);

    searchPanel.appendChild(searchForm);

    // Search results
    var resultsContainer = document.createElement('div');
    resultsContainer.className = 'search-results-container';

    var results = state.intelligence.embeddings.searchResults || [];
    if (results.length > 0) {
        var resultsTitle = document.createElement('h4');
        resultsTitle.textContent = 'Results (' + results.length + ')';
        resultsContainer.appendChild(resultsTitle);

        results.forEach(function(result) {
            var resultCard = document.createElement('div');
            resultCard.className = 'search-result-card';
            resultCard.innerHTML = '<div class="result-header">' +
                '<span class="result-score">' + (result.score * 100).toFixed(0) + '% match</span>' +
                '<span class="result-collection">' + result.collection + '</span>' +
                '</div>' +
                '<div class="result-text">' + result.text + '</div>';
            resultsContainer.appendChild(resultCard);
        });

        // Load More button for search results
        if (state.intelligence.embeddings.searchHasMore) {
            var loadMoreContainer = document.createElement('div');
            loadMoreContainer.className = 'load-more-container';

            var loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'load-more-btn' + (state.intelligence.embeddings.searchLoading ? ' loading' : '');
            loadMoreBtn.disabled = state.intelligence.embeddings.searchLoading;
            loadMoreBtn.textContent = state.intelligence.embeddings.searchLoading ? 'Loading...' : 'Load More Results';
            loadMoreBtn.onclick = function() {
                state.intelligence.embeddings.searchLoading = true;
                renderApp();
                // Mock loading more results
                setTimeout(function() {
                    state.intelligence.embeddings.searchOffset += state.intelligence.embeddings.searchLimit;
                    state.intelligence.embeddings.searchLoading = false;
                    state.intelligence.embeddings.searchHasMore = false; // Mock: no more
                    renderApp();
                }, 800);
            };
            loadMoreContainer.appendChild(loadMoreBtn);
            resultsContainer.appendChild(loadMoreContainer);
        }
    } else if (!state.intelligence.embeddings.searchLoading) {
        var noResults = document.createElement('div');
        noResults.className = 'no-results-message';
        noResults.textContent = 'Enter a query to test semantic search';
        resultsContainer.appendChild(noResults);
    }

    searchPanel.appendChild(resultsContainer);
    mainContent.appendChild(searchPanel);

    container.appendChild(mainContent);

    return container;
}

/**
 * Intelligence & Memory: Recall View
 * Test and debug memory retrieval across all sources
 */
function renderRecallView() {
    var container = document.createElement('div');
    container.className = 'intelligence-container recall-container';

    // Header
    var header = document.createElement('div');
    header.className = 'intelligence-header';

    var titleSection = document.createElement('div');
    titleSection.className = 'intelligence-title-section';

    var title = document.createElement('h2');
    title.textContent = 'Recall';
    titleSection.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'Test memory retrieval and debug recall accuracy';
    titleSection.appendChild(subtitle);

    header.appendChild(titleSection);
    container.appendChild(header);

    // Main content - Query panel + Results
    var mainContent = document.createElement('div');
    mainContent.className = 'recall-main';

    // Query panel
    var queryPanel = document.createElement('div');
    queryPanel.className = 'recall-query-panel';

    var queryTitle = document.createElement('h3');
    queryTitle.textContent = 'Test Query';
    queryPanel.appendChild(queryTitle);

    var queryInput = document.createElement('textarea');
    queryInput.className = 'recall-query-input';
    queryInput.placeholder = 'Enter a natural language query to test recall...\n\nExample: "What are my exercise habits?"';
    queryInput.rows = 4;
    queryInput.value = state.intelligence.recall.testQuery;
    queryInput.oninput = function(e) {
        state.intelligence.recall.testQuery = e.target.value;
    };
    queryPanel.appendChild(queryInput);

    // Filters row
    var filtersRow = document.createElement('div');
    filtersRow.className = 'recall-filters';

    var sourceFilter = document.createElement('select');
    sourceFilter.className = 'filter-select';
    var sourceOptions = [
        { value: 'all', label: 'All Sources' },
        { value: 'memories', label: 'Memories' },
        { value: 'knowledge', label: 'Knowledge Base' },
        { value: 'conversations', label: 'Conversations' }
    ];
    sourceOptions.forEach(function(opt) {
        var option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        option.selected = state.intelligence.recall.filters.source === opt.value;
        sourceFilter.appendChild(option);
    });
    sourceFilter.onchange = function(e) {
        state.intelligence.recall.filters.source = e.target.value;
        renderApp();
    };
    filtersRow.appendChild(sourceFilter);

    var minScoreLabel = document.createElement('label');
    minScoreLabel.className = 'min-score-label';
    minScoreLabel.textContent = 'Min Score: ';
    var minScoreInput = document.createElement('input');
    minScoreInput.type = 'range';
    minScoreInput.className = 'min-score-slider';
    minScoreInput.min = '0';
    minScoreInput.max = '100';
    minScoreInput.value = state.intelligence.recall.filters.minScore;
    var minScoreValue = document.createElement('span');
    minScoreValue.className = 'min-score-value';
    minScoreValue.textContent = state.intelligence.recall.filters.minScore + '%';
    minScoreInput.oninput = function(e) {
        state.intelligence.recall.filters.minScore = parseInt(e.target.value);
        minScoreValue.textContent = e.target.value + '%';
    };
    minScoreLabel.appendChild(minScoreInput);
    minScoreLabel.appendChild(minScoreValue);
    filtersRow.appendChild(minScoreLabel);

    queryPanel.appendChild(filtersRow);

    // Run query button
    var runBtn = document.createElement('button');
    runBtn.className = 'btn btn-primary btn-lg';
    runBtn.textContent = state.intelligence.recall.loading ? 'Running Recall...' : 'Run Recall Query';
    runBtn.disabled = state.intelligence.recall.loading;
    runBtn.onclick = function() {
        if (!state.intelligence.recall.testQuery.trim()) {
            showToast('Enter a query to test', 'warning');
            return;
        }
        state.intelligence.recall.loading = true;
        renderApp();
        // Mock recall results
        setTimeout(function() {
            state.intelligence.recall.results = [
                { id: 'rec_001', source: 'memories', score: 0.92, text: 'Morning jogs at 6:30am, 3 times per week', metadata: { category: 'health_wellness', timestamp: '2024-01-15' } },
                { id: 'rec_002', source: 'memories', score: 0.88, text: 'Prefers outdoor activities over gym workouts', metadata: { category: 'lifestyle_routines', timestamp: '2024-01-10' } },
                { id: 'rec_003', source: 'knowledge', score: 0.81, text: 'Cardiovascular exercise benefits include improved heart health', metadata: { source: 'health_kb', timestamp: '2023-12-01' } },
                { id: 'rec_004', source: 'conversations', score: 0.76, text: 'Discussed starting a new workout routine', metadata: { session: 'conv_234', timestamp: '2024-01-18' } }
            ];
            state.intelligence.recall.loading = false;
            // Add to history
            state.intelligence.recall.history.unshift({
                query: state.intelligence.recall.testQuery,
                resultCount: state.intelligence.recall.results.length,
                timestamp: new Date().toISOString()
            });
            if (state.intelligence.recall.history.length > 10) {
                state.intelligence.recall.history = state.intelligence.recall.history.slice(0, 10);
            }
            renderApp();
        }, 1000);
    };
    queryPanel.appendChild(runBtn);

    mainContent.appendChild(queryPanel);

    // Results panel
    var resultsPanel = document.createElement('div');
    resultsPanel.className = 'recall-results-panel';

    var resultsTitle = document.createElement('h3');
    resultsTitle.textContent = 'Recall Results';
    resultsPanel.appendChild(resultsTitle);

    var results = state.intelligence.recall.results || [];
    if (state.intelligence.recall.loading) {
        var loadingDiv = document.createElement('div');
        loadingDiv.className = 'recall-loading';
        loadingDiv.innerHTML = '<div class="loading-spinner"></div><div>Running recall query...</div>';
        resultsPanel.appendChild(loadingDiv);
    } else if (results.length > 0) {
        var resultsList = document.createElement('div');
        resultsList.className = 'recall-results-list';

        results.forEach(function(result, idx) {
            var resultCard = document.createElement('div');
            resultCard.className = 'recall-result-card' + (state.intelligence.recall.selectedResult === result.id ? ' selected' : '');

            var scoreBar = document.createElement('div');
            scoreBar.className = 'result-score-bar';
            scoreBar.innerHTML = '<div class="score-fill" style="width: ' + (result.score * 100) + '%"></div>';

            var resultHeader = document.createElement('div');
            resultHeader.className = 'result-header';
            resultHeader.innerHTML = '<span class="result-rank">#' + (idx + 1) + '</span>' +
                '<span class="result-score-text">' + (result.score * 100).toFixed(0) + '% match</span>' +
                '<span class="result-source source-' + result.source + '">' + result.source + '</span>';

            var resultText = document.createElement('div');
            resultText.className = 'result-text';
            resultText.textContent = result.text;

            var resultMeta = document.createElement('div');
            resultMeta.className = 'result-metadata';
            if (result.metadata) {
                Object.keys(result.metadata).forEach(function(key) {
                    resultMeta.innerHTML += '<span class="meta-item"><span class="meta-key">' + key + ':</span> ' + result.metadata[key] + '</span>';
                });
            }

            resultCard.appendChild(scoreBar);
            resultCard.appendChild(resultHeader);
            resultCard.appendChild(resultText);
            resultCard.appendChild(resultMeta);

            resultCard.onclick = function() {
                state.intelligence.recall.selectedResult = result.id;
                renderApp();
            };

            resultsList.appendChild(resultCard);
        });

        resultsPanel.appendChild(resultsList);

        // Load More button for recall results
        if (state.intelligence.recall.hasMore && results.length >= state.intelligence.recall.limit) {
            var loadMoreContainer = document.createElement('div');
            loadMoreContainer.className = 'load-more-container';

            var loadMoreBtn = document.createElement('button');
            loadMoreBtn.className = 'load-more-btn' + (state.intelligence.recall.loadingMore ? ' loading' : '');
            loadMoreBtn.disabled = state.intelligence.recall.loadingMore;
            loadMoreBtn.textContent = state.intelligence.recall.loadingMore ? 'Loading...' : 'Load More Results';
            loadMoreBtn.onclick = function() {
                state.intelligence.recall.loadingMore = true;
                renderApp();
                // Mock loading more results
                setTimeout(function() {
                    state.intelligence.recall.offset += state.intelligence.recall.limit;
                    state.intelligence.recall.loadingMore = false;
                    // In real implementation: fetch more results and append
                    state.intelligence.recall.hasMore = false; // Mock: no more data
                    renderApp();
                }, 800);
            };
            loadMoreContainer.appendChild(loadMoreBtn);
            resultsPanel.appendChild(loadMoreContainer);
        }
    } else {
        var emptyState = document.createElement('div');
        emptyState.className = 'recall-empty-state';
        emptyState.innerHTML = '<div class="empty-icon">' + getKnowledgeGraphIcon('search') + '</div>' +
            '<div class="empty-title">No results yet</div>' +
            '<div class="empty-desc">Enter a query and click "Run Recall Query" to test memory retrieval</div>';
        resultsPanel.appendChild(emptyState);
    }

    mainContent.appendChild(resultsPanel);

    // History sidebar
    var historyPanel = document.createElement('div');
    historyPanel.className = 'recall-history-panel';

    var historyTitle = document.createElement('h3');
    historyTitle.textContent = 'Query History';
    historyPanel.appendChild(historyTitle);

    var history = state.intelligence.recall.history || [];
    if (history.length > 0) {
        var historyList = document.createElement('div');
        historyList.className = 'history-list';

        history.forEach(function(item) {
            var historyItem = document.createElement('div');
            historyItem.className = 'history-item';
            historyItem.innerHTML = '<div class="history-query">' + item.query.substring(0, 50) + (item.query.length > 50 ? '...' : '') + '</div>' +
                '<div class="history-meta">' + item.resultCount + ' results</div>';
            historyItem.onclick = function() {
                state.intelligence.recall.testQuery = item.query;
                renderApp();
            };
            historyList.appendChild(historyItem);
        });

        historyPanel.appendChild(historyList);
    } else {
        var noHistory = document.createElement('div');
        noHistory.className = 'no-history';
        noHistory.textContent = 'No query history yet';
        historyPanel.appendChild(noHistory);
    }

    mainContent.appendChild(historyPanel);

    container.appendChild(mainContent);

    return container;
}

/**
 * Intelligence & Memory: Inspector View
 * Debug AI sessions, tool calls, and reasoning traces
 */
function renderInspectorView() {
    var container = document.createElement('div');
    container.className = 'intelligence-container inspector-container';

    // Header
    var header = document.createElement('div');
    header.className = 'intelligence-header';

    var titleSection = document.createElement('div');
    titleSection.className = 'intelligence-title-section';

    var title = document.createElement('h2');
    title.textContent = 'Inspector';
    titleSection.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'Debug AI sessions, tool calls, and reasoning traces across all surfaces';
    titleSection.appendChild(subtitle);

    header.appendChild(titleSection);
    container.appendChild(header);

    // Filters bar
    var filtersBar = document.createElement('div');
    filtersBar.className = 'inspector-filters-bar';

    // Surface filter
    var surfaceFilter = document.createElement('select');
    surfaceFilter.className = 'filter-select';
    var surfaceOptions = [
        { value: 'all', label: 'All Surfaces' },
        { value: 'operator', label: 'Operator Console' },
        { value: 'orb', label: 'ORB' },
        { value: 'api', label: 'Direct API' }
    ];
    surfaceOptions.forEach(function(opt) {
        var option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        option.selected = state.intelligence.inspector.filters.surface === opt.value;
        surfaceFilter.appendChild(option);
    });
    surfaceFilter.onchange = function(e) {
        state.intelligence.inspector.filters.surface = e.target.value;
        renderApp();
    };
    filtersBar.appendChild(surfaceFilter);

    // Status filter
    var statusFilter = document.createElement('select');
    statusFilter.className = 'filter-select';
    var statusOptions = [
        { value: 'all', label: 'All Status' },
        { value: 'success', label: 'Success' },
        { value: 'error', label: 'Error' },
        { value: 'pending', label: 'Pending' }
    ];
    statusOptions.forEach(function(opt) {
        var option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        option.selected = state.intelligence.inspector.filters.status === opt.value;
        statusFilter.appendChild(option);
    });
    statusFilter.onchange = function(e) {
        state.intelligence.inspector.filters.status = e.target.value;
        renderApp();
    };
    filtersBar.appendChild(statusFilter);

    // Time range filter
    var timeFilter = document.createElement('select');
    timeFilter.className = 'filter-select';
    var timeOptions = [
        { value: '1h', label: 'Last Hour' },
        { value: '24h', label: 'Last 24 Hours' },
        { value: '7d', label: 'Last 7 Days' },
        { value: '30d', label: 'Last 30 Days' }
    ];
    timeOptions.forEach(function(opt) {
        var option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        option.selected = state.intelligence.inspector.filters.dateRange === opt.value;
        timeFilter.appendChild(option);
    });
    timeFilter.onchange = function(e) {
        state.intelligence.inspector.filters.dateRange = e.target.value;
        renderApp();
    };
    filtersBar.appendChild(timeFilter);

    container.appendChild(filtersBar);

    // Main content - Sessions list + Detail
    var mainContent = document.createElement('div');
    mainContent.className = 'inspector-main';

    // Sessions list
    var sessionsPanel = document.createElement('div');
    sessionsPanel.className = 'inspector-sessions-panel';

    var sessionsTitle = document.createElement('h3');
    sessionsTitle.textContent = 'AI Sessions';
    sessionsPanel.appendChild(sessionsTitle);

    // Mock sessions for UI scaffolding
    var mockSessions = [
        { id: 'sess_001', surface: 'operator', status: 'success', query: 'What is the status of VTID-01208?', toolCalls: 2, duration: 1250, timestamp: '2024-01-23T14:32:00Z' },
        { id: 'sess_002', surface: 'orb', status: 'success', query: 'Tell me about my sleep patterns', toolCalls: 3, duration: 2100, timestamp: '2024-01-23T14:28:00Z' },
        { id: 'sess_003', surface: 'operator', status: 'error', query: 'Deploy gateway to production', toolCalls: 1, duration: 450, timestamp: '2024-01-23T14:15:00Z', error: 'Governance blocked: L2 violation' },
        { id: 'sess_004', surface: 'api', status: 'success', query: 'Search knowledge base for API docs', toolCalls: 1, duration: 890, timestamp: '2024-01-23T13:55:00Z' }
    ];

    var sessionsList = document.createElement('div');
    sessionsList.className = 'sessions-list';

    mockSessions.forEach(function(session) {
        var sessionCard = document.createElement('div');
        sessionCard.className = 'session-card' + (state.intelligence.inspector.selectedSession === session.id ? ' selected' : '');

        var sessionHeader = document.createElement('div');
        sessionHeader.className = 'session-header';
        sessionHeader.innerHTML = '<span class="session-surface surface-' + session.surface + '">' + session.surface + '</span>' +
            '<span class="session-status status-' + session.status + '">' + session.status + '</span>' +
            '<span class="session-time">' + formatRelativeTime(session.timestamp) + '</span>';

        var sessionQuery = document.createElement('div');
        sessionQuery.className = 'session-query';
        sessionQuery.textContent = session.query;

        var sessionMeta = document.createElement('div');
        sessionMeta.className = 'session-meta';
        sessionMeta.innerHTML = '<span class="meta-item">' + session.toolCalls + ' tool calls</span>' +
            '<span class="meta-item">' + session.duration + 'ms</span>';

        if (session.error) {
            var errorDiv = document.createElement('div');
            errorDiv.className = 'session-error';
            errorDiv.textContent = session.error;
            sessionCard.appendChild(errorDiv);
        }

        sessionCard.appendChild(sessionHeader);
        sessionCard.appendChild(sessionQuery);
        sessionCard.appendChild(sessionMeta);

        sessionCard.onclick = function() {
            state.intelligence.inspector.selectedSession = session.id;
            renderApp();
        };

        sessionsList.appendChild(sessionCard);
    });

    sessionsPanel.appendChild(sessionsList);

    // Load More button for sessions
    if (state.intelligence.inspector.hasMore) {
        var loadMoreContainer = document.createElement('div');
        loadMoreContainer.className = 'load-more-container';

        var loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more-btn' + (state.intelligence.inspector.loadingMore ? ' loading' : '');
        loadMoreBtn.disabled = state.intelligence.inspector.loadingMore;
        loadMoreBtn.textContent = state.intelligence.inspector.loadingMore ? 'Loading...' : 'Load More Sessions';
        loadMoreBtn.onclick = function() {
            state.intelligence.inspector.loadingMore = true;
            renderApp();
            // Mock loading more sessions
            setTimeout(function() {
                state.intelligence.inspector.offset += state.intelligence.inspector.limit;
                state.intelligence.inspector.loadingMore = false;
                // In real implementation: fetch more sessions and append
                state.intelligence.inspector.hasMore = false; // Mock: no more data
                renderApp();
            }, 800);
        };
        loadMoreContainer.appendChild(loadMoreBtn);
        sessionsPanel.appendChild(loadMoreContainer);
    }

    mainContent.appendChild(sessionsPanel);

    // Detail panel
    var detailPanel = document.createElement('div');
    detailPanel.className = 'inspector-detail-panel';

    var selectedId = state.intelligence.inspector.selectedSession;
    var selectedSession = mockSessions.find(function(s) { return s.id === selectedId; });

    if (selectedSession) {
        var detailTitle = document.createElement('h3');
        detailTitle.textContent = 'Session Details';
        detailPanel.appendChild(detailTitle);

        // Session info
        var sessionInfo = document.createElement('div');
        sessionInfo.className = 'session-info';
        sessionInfo.innerHTML = '<div class="info-row"><span class="info-label">Session ID:</span> ' + selectedSession.id + '</div>' +
            '<div class="info-row"><span class="info-label">Surface:</span> ' + selectedSession.surface + '</div>' +
            '<div class="info-row"><span class="info-label">Status:</span> <span class="status-badge status-' + selectedSession.status + '">' + selectedSession.status + '</span></div>' +
            '<div class="info-row"><span class="info-label">Duration:</span> ' + selectedSession.duration + 'ms</div>' +
            '<div class="info-row"><span class="info-label">Timestamp:</span> ' + new Date(selectedSession.timestamp).toLocaleString() + '</div>';
        detailPanel.appendChild(sessionInfo);

        // Query
        var querySection = document.createElement('div');
        querySection.className = 'detail-section';
        querySection.innerHTML = '<h4>User Query</h4><div class="query-box">' + selectedSession.query + '</div>';
        detailPanel.appendChild(querySection);

        // Tool calls
        var toolsSection = document.createElement('div');
        toolsSection.className = 'detail-section';

        var toolsTitle = document.createElement('h4');
        toolsTitle.textContent = 'Tool Calls (' + selectedSession.toolCalls + ')';
        toolsSection.appendChild(toolsTitle);

        // Mock tool calls
        var mockToolCalls = [
            { name: 'autopilot_get_status', args: { vtid: 'VTID-01208' }, result: { status: 'completed', title: 'LLM Telemetry' }, duration: 320 },
            { name: 'knowledge_search', args: { query: 'VTID-01208 details' }, result: { found: true, matches: 3 }, duration: 180 }
        ];

        var toolsList = document.createElement('div');
        toolsList.className = 'tools-list';

        mockToolCalls.forEach(function(tool, idx) {
            var toolCard = document.createElement('div');
            toolCard.className = 'tool-card';

            var toolHeader = document.createElement('div');
            toolHeader.className = 'tool-header';
            toolHeader.innerHTML = '<span class="tool-name">' + tool.name + '</span>' +
                '<span class="tool-duration">' + tool.duration + 'ms</span>';

            var expanded = state.intelligence.inspector.expandedTools[selectedSession.id + '_' + idx];

            var toggleBtn = document.createElement('button');
            toggleBtn.className = 'tool-toggle-btn';
            toggleBtn.textContent = expanded ? 'Collapse' : 'Expand';
            toggleBtn.onclick = function(e) {
                e.stopPropagation();
                var key = selectedSession.id + '_' + idx;
                state.intelligence.inspector.expandedTools[key] = !state.intelligence.inspector.expandedTools[key];
                renderApp();
            };
            toolHeader.appendChild(toggleBtn);

            toolCard.appendChild(toolHeader);

            if (expanded) {
                var toolDetails = document.createElement('div');
                toolDetails.className = 'tool-details';
                toolDetails.innerHTML = '<div class="tool-args"><strong>Arguments:</strong><pre>' + JSON.stringify(tool.args, null, 2) + '</pre></div>' +
                    '<div class="tool-result"><strong>Result:</strong><pre>' + JSON.stringify(tool.result, null, 2) + '</pre></div>';
                toolCard.appendChild(toolDetails);
            }

            toolsList.appendChild(toolCard);
        });

        toolsSection.appendChild(toolsList);
        detailPanel.appendChild(toolsSection);

    } else {
        var noSelection = document.createElement('div');
        noSelection.className = 'no-selection-state';
        noSelection.innerHTML = '<div class="empty-icon">' + getKnowledgeGraphIcon('inspect') + '</div>' +
            '<div class="empty-title">Select a session</div>' +
            '<div class="empty-desc">Click on a session to view tool calls and reasoning traces</div>';
        detailPanel.appendChild(noSelection);
    }

    mainContent.appendChild(detailPanel);

    container.appendChild(mainContent);

    return container;
}

/**
 * Helper: Get SVG icons for Knowledge Graph and Intelligence screens
 */
function getKnowledgeGraphIcon(type) {
    var icons = {
        node: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>',
        edge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
        entity: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>',
        concept: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
        memory: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V6h5.17l2 2H20v10z"/></svg>',
        graph: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="12" cy="12" r="3"/><line x1="6" y1="6" x2="12" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="18" y1="6" x2="12" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="18" x2="12" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="18" y1="18" x2="12" y2="12" stroke="currentColor" stroke-width="1.5"/></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
        inspect: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>'
    };
    return icons[type] || icons.node;
}

/**
 * Helper: Format relative time
 */
function formatRelativeTime(timestamp) {
    var now = new Date();
    var then = new Date(timestamp);
    var diffMs = now - then;
    var diffMins = Math.floor(diffMs / 60000);
    var diffHours = Math.floor(diffMs / 3600000);
    var diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return diffMins + 'm ago';
    if (diffHours < 24) return diffHours + 'h ago';
    if (diffDays < 7) return diffDays + 'd ago';
    return then.toLocaleDateString();
}

/**
 * VTID-01154: GitHub-Authoritative Approvals Feed (SPEC-02)
 *
 * Table columns (only these): PR | Branch | CI | Mergeable | VTID | Action
 * Rules:
 * - No descriptive text
 * - No workflow explanations
 * - No onboarding copy
 * - No "how it works" sections
 * - Display "—" if VTID not found (never "UNKNOWN")
 * - Approve button appears only when CI = pass AND mergeable = true
 */
function renderApprovalsView() {
    var container = document.createElement('div');
    container.className = 'approvals-container';

    // Auto-fetch GitHub feed if not yet fetched
    if (!state.approvals.feedFetched && !state.approvals.feedLoading) {
        fetchGitHubFeed();
    }

    // Header - minimal, no descriptions
    var header = document.createElement('div');
    header.className = 'approvals-header';

    var title = document.createElement('h2');
    title.textContent = 'Approvals';
    header.appendChild(title);

    // SPEC-01: Per-view refresh buttons removed - use global refresh icon in header

    container.appendChild(header);

    // Error display
    if (state.approvals.feedError) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'approvals-error';
        errorDiv.textContent = 'Error: ' + state.approvals.feedError;
        container.appendChild(errorDiv);
    }

    // Get feed items
    var feedItems = state.approvals.feedItems || [];

    // Main content
    var contentSection = document.createElement('div');
    contentSection.className = 'approvals-section';

    if (state.approvals.feedLoading) {
        contentSection.innerHTML = '<div class="placeholder-content">Loading...</div>';
    } else if (feedItems.length === 0) {
        // Empty state - minimal
        var emptyState = document.createElement('div');
        emptyState.className = 'approvals-empty-state';
        emptyState.innerHTML = '<div class="approvals-empty-title">No open PRs</div>';
        contentSection.appendChild(emptyState);
    } else {
        // SPEC-02: GitHub-authoritative table
        var table = document.createElement('table');
        table.className = 'approvals-table';

        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        // SPEC-02: Only these columns
        ['PR', 'Branch', 'CI', 'Mergeable', 'VTID', 'Action'].forEach(function(h) {
            var th = document.createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');

        feedItems.forEach(function(item) {
            var row = document.createElement('tr');

            // PR number with link
            var prCell = document.createElement('td');
            var prLink = document.createElement('a');
            prLink.href = item.pr_url || '#';
            prLink.target = '_blank';
            prLink.className = 'approvals-pr-link';
            prLink.textContent = '#' + item.pr_number;
            prCell.appendChild(prLink);
            row.appendChild(prCell);

            // Branch
            var branchCell = document.createElement('td');
            branchCell.className = 'approvals-branch-cell';
            var branchText = item.branch || '';
            branchCell.textContent = branchText.length > 35 ? branchText.substring(0, 35) + '...' : branchText;
            branchCell.title = branchText;
            row.appendChild(branchCell);

            // CI Status - SPEC-02: pass | fail | running
            var ciCell = document.createElement('td');
            var ciIndicator = document.createElement('span');
            ciIndicator.className = 'approvals-status-indicator';
            if (item.ci_state === 'pass') {
                ciIndicator.innerHTML = '<span class="status-pass">✓</span> pass';
            } else if (item.ci_state === 'fail') {
                ciIndicator.innerHTML = '<span class="status-fail">✗</span> fail';
            } else if (item.ci_state === 'running') {
                ciIndicator.innerHTML = '<span class="status-pending">⋯</span> running';
            }
            ciCell.appendChild(ciIndicator);
            row.appendChild(ciCell);

            // Mergeable - SPEC-02: true | false
            var mergeableCell = document.createElement('td');
            var mergeableIndicator = document.createElement('span');
            mergeableIndicator.className = 'approvals-status-indicator';
            if (item.mergeable === true) {
                mergeableIndicator.innerHTML = '<span class="status-pass">✓</span> true';
            } else {
                mergeableIndicator.innerHTML = '<span class="status-fail">✗</span> false';
            }
            mergeableCell.appendChild(mergeableIndicator);
            row.appendChild(mergeableCell);

            // VTID - SPEC-02: Display "—" if not found (never "UNKNOWN")
            var vtidCell = document.createElement('td');
            if (item.vtid) {
                var vtidBadge = document.createElement('span');
                vtidBadge.className = 'vtid-badge';
                vtidBadge.textContent = item.vtid;
                vtidCell.appendChild(vtidBadge);
            } else {
                vtidCell.textContent = '—';
            }
            row.appendChild(vtidCell);

            // Action button
            var actionCell = document.createElement('td');
            actionCell.className = 'approvals-actions-cell';

            // VTID-01168: Approve button appears only when:
            // - CI = pass
            // - mergeable = true
            // - VTID is present (not null/undefined)
            var hasValidVtid = item.vtid && item.vtid !== 'UNKNOWN';
            var canApprove = item.ci_state === 'pass' && item.mergeable === true && hasValidVtid;

            if (canApprove) {
                var approveBtn = document.createElement('button');
                approveBtn.className = 'btn btn-success btn-sm';
                approveBtn.textContent = 'Approve';
                approveBtn.disabled = state.approvals.feedLoading;
                approveBtn.onclick = function() {
                    if (confirm('Approve PR #' + item.pr_number + '?\n\nThis will trigger a safe merge + auto-deploy.')) {
                        approveFeedItem(item.pr_number, item.branch, item.vtid);
                    }
                };
                actionCell.appendChild(approveBtn);
            } else if (!hasValidVtid && item.ci_state === 'pass' && item.mergeable === true) {
                // VTID-01168: Show "VTID Required" when only VTID is blocking approval
                var vtidRequired = document.createElement('span');
                vtidRequired.className = 'status-warning';
                vtidRequired.textContent = 'VTID Required';
                vtidRequired.title = 'Approval blocked: VTID must be in branch name or PR title';
                actionCell.appendChild(vtidRequired);
            } else {
                // No approve button when CI/mergeable conditions not met
                actionCell.textContent = '—';
            }

            row.appendChild(actionCell);
            tbody.appendChild(row);
        });

        table.appendChild(tbody);
        contentSection.appendChild(table);
    }

    container.appendChild(contentSection);

    return container;
}

function renderDocsScreensView() {
    const container = document.createElement('div');
    container.className = 'docs-container';

    // Toolbar with role filters
    const toolbar = document.createElement('div');
    toolbar.className = 'docs-toolbar';

    const label = document.createElement('span');
    label.textContent = 'Role:';
    label.className = 'docs-toolbar-label';
    toolbar.appendChild(label);

    const roles = ['DEVELOPER', 'COMMUNITY', 'PATIENT', 'STAFF', 'PROFESSIONAL', 'ADMIN', 'FULL CATALOG'];
    roles.forEach(role => {
        const btn = document.createElement('button');
        btn.className = state.selectedRole === role ? 'btn role-btn-active' : 'btn';
        btn.textContent = role;
        btn.onclick = () => {
            state.selectedRole = role;
            renderApp();
        };
        toolbar.appendChild(btn);
    });

    container.appendChild(toolbar);

    // Content area
    const content = document.createElement('div');
    content.className = 'docs-content';

    if (state.screenInventoryLoading) {
        content.innerHTML = '<div class="placeholder-content">Loading screen inventory...</div>';
    } else if (state.screenInventoryError) {
        content.innerHTML = `<div class="placeholder-content error-text">Error: ${state.screenInventoryError}</div>`;
    } else if (!state.screenInventory) {
        content.innerHTML = '<div class="placeholder-content">No screen inventory data available.</div>';
        // Try to fetch it
        fetchScreenInventory();
    } else {
        // Render screen table
        const screens = state.screenInventory.screen_inventory?.screens || [];
        const filteredScreens = screens.filter(screen => {
            if (state.selectedRole === 'FULL CATALOG') return true;
            return screen.role.toUpperCase() === state.selectedRole;
        });

        const table = document.createElement('table');
        table.className = 'docs-table';

        // Header
        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr class="docs-table-header">
                <th class="docs-table-cell">Screen ID</th>
                <th class="docs-table-cell">Module</th>
                <th class="docs-table-cell">Tab</th>
                <th class="docs-table-cell">URL Path</th>
                <th class="docs-table-cell">Role</th>
            </tr>
        `;
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        filteredScreens.forEach((screen, index) => {
            const tr = document.createElement('tr');
            if (index % 2 !== 0) tr.className = 'docs-table-row-alt';
            tr.innerHTML = `
                <td class="docs-table-cell">${screen.screen_id}</td>
                <td class="docs-table-cell">${screen.module}</td>
                <td class="docs-table-cell">${screen.tab}</td>
                <td class="docs-table-cell"><code class="docs-table-code">${screen.url_path}</code></td>
                <td class="docs-table-cell">${screen.role}</td>
            `;
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        const summary = document.createElement('div');
        summary.className = 'docs-summary';
        summary.textContent = `Showing ${filteredScreens.length} screens for ${state.selectedRole}`;
        content.appendChild(summary);

        content.appendChild(table);
    }

    container.appendChild(content);
    return container;
}

// --- Global Overlays (VTID-0508) ---

function renderHeartbeatOverlay() {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    backdrop.onclick = (e) => {
        if (e.target === backdrop) {
            state.isHeartbeatOpen = false;
            renderApp();
        }
    };

    const panel = document.createElement('div');
    panel.className = 'overlay-panel heartbeat-overlay';

    // Header
    const header = document.createElement('div');
    header.className = 'overlay-header';

    const titleBlock = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = 'Heartbeat';
    titleBlock.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'overlay-subtitle';
    subtitle.textContent = 'System status & telemetry (UI stub)';
    titleBlock.appendChild(subtitle);

    header.appendChild(titleBlock);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'overlay-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        state.isHeartbeatOpen = false;
        renderApp();
    };
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Content
    const content = document.createElement('div');
    content.className = 'overlay-content';

    // Current Status Section
    const statusSection = document.createElement('div');
    statusSection.className = 'heartbeat-section';

    const statusTitle = document.createElement('div');
    statusTitle.className = 'heartbeat-section-title';
    statusTitle.textContent = 'Current Status';
    statusSection.appendChild(statusTitle);

    const statusBox = document.createElement('div');
    statusBox.className = 'heartbeat-status';

    const statusDot = document.createElement('div');
    statusDot.className = 'heartbeat-status-dot standby';
    statusBox.appendChild(statusDot);

    const statusText = document.createElement('span');
    statusText.textContent = 'Standby';
    statusBox.appendChild(statusText);

    statusSection.appendChild(statusBox);
    content.appendChild(statusSection);

    // Metrics Section
    const metricsSection = document.createElement('div');
    metricsSection.className = 'heartbeat-section';

    const metricsTitle = document.createElement('div');
    metricsTitle.className = 'heartbeat-section-title';
    metricsTitle.textContent = 'Metrics';
    metricsSection.appendChild(metricsTitle);

    const metricsGrid = document.createElement('div');
    metricsGrid.className = 'heartbeat-metrics';

    const metrics = [
        { label: 'Last beat', value: '–' },
        { label: 'Latency', value: '–' },
        { label: 'Uptime', value: '–' },
        { label: 'Connections', value: '–' }
    ];

    metrics.forEach(m => {
        const metric = document.createElement('div');
        metric.className = 'heartbeat-metric';

        const label = document.createElement('div');
        label.className = 'heartbeat-metric-label';
        label.textContent = m.label;
        metric.appendChild(label);

        const value = document.createElement('div');
        value.className = 'heartbeat-metric-value';
        value.textContent = m.value;
        metric.appendChild(value);

        metricsGrid.appendChild(metric);
    });

    metricsSection.appendChild(metricsGrid);
    content.appendChild(metricsSection);

    // Events Section
    const eventsSection = document.createElement('div');
    eventsSection.className = 'heartbeat-section';

    const eventsTitle = document.createElement('div');
    eventsTitle.className = 'heartbeat-section-title';
    eventsTitle.textContent = 'Recent Events';
    eventsSection.appendChild(eventsTitle);

    const eventsBox = document.createElement('div');
    eventsBox.className = 'heartbeat-events';
    eventsBox.textContent = 'No telemetry yet';
    eventsSection.appendChild(eventsBox);

    content.appendChild(eventsSection);

    panel.appendChild(content);
    backdrop.appendChild(panel);

    return backdrop;
}

function renderOperatorOverlay() {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    backdrop.onclick = (e) => {
        if (e.target === backdrop) {
            state.isOperatorOpen = false;
            // VTID-01209: Stop active executions polling when closing
            stopActiveExecutionsPolling();
            renderApp();
        }
    };

    const panel = document.createElement('div');
    panel.className = 'overlay-panel operator-overlay';

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

    const closeBtn = document.createElement('button');
    closeBtn.className = 'overlay-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        state.isOperatorOpen = false;
        // VTID-01209: Stop active executions polling when closing
        stopActiveExecutionsPolling();
        renderApp();
    };
    header.appendChild(closeBtn);

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
        tabContent.appendChild(renderOperatorChat());
    } else if (state.operatorActiveTab === 'ticker') {
        tabContent.appendChild(renderOperatorTicker());
    } else if (state.operatorActiveTab === 'history') {
        tabContent.appendChild(renderOperatorHistory());
    }

    panel.appendChild(tabContent);
    backdrop.appendChild(panel);

    return backdrop;
}

function renderOperatorChat() {
    const container = document.createElement('div');
    container.className = 'chat-container';

    // Messages area
    const messages = document.createElement('div');
    messages.className = 'chat-messages';

    if (state.chatMessages.length === 0) {
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
            bubble.textContent = msg.content || msg.text;
            messages.appendChild(bubble);

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

            // Timestamp element
            const time = document.createElement('div');
            time.className = 'timestamp';
            // Align timestamp with the message bubble
            if (isSent) {
                time.style.alignSelf = 'flex-end';
            }
            time.textContent = msg.timestamp;
            messages.appendChild(time);
        });
    }

    container.appendChild(messages);

    // Attachments preview
    if (state.chatAttachments.length > 0) {
        const attachmentsPreview = document.createElement('div');
        attachmentsPreview.className = 'chat-attachments-preview';

        state.chatAttachments.forEach((att, index) => {
            const chip = document.createElement('span');
            chip.className = `attachment-chip attachment-${att.kind}`;
            chip.innerHTML = `${att.name} <span class="attachment-remove" data-index="${index}">&times;</span>`;
            chip.querySelector('.attachment-remove').onclick = () => {
                state.chatAttachments.splice(index, 1);
                renderApp();
            };
            attachmentsPreview.appendChild(chip);
        });

        container.appendChild(attachmentsPreview);
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
    inputContainer.appendChild(textarea);

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

/**
 * @deprecated VTID-0525: No longer used - all messages go through /operator/command
 * The backend parses NL and decides if it's deploy, task, or chat.
 * Kept for reference only.
 */
function isDeployCommand(message) {
    // DEPRECATED: Not used anymore - backend handles command detection
    return false;
}

/**
 * @deprecated VTID-0525: No longer used - backend auto-creates VTIDs
 * The /operator/command endpoint creates VTIDs via the deploy orchestrator.
 * Kept for reference only.
 */
function generateCommandVtid() {
    // DEPRECATED: Not used anymore - backend auto-creates VTIDs
    return null;
}

/**
 * Format command result for display
 * VTID-0525: Operator Command Hub
 * Uses the `reply` field from the backend response
 */
function formatCommandResult(result) {
    // Use the operator reply from the backend
    // The backend generates a descriptive message for all command types (deploy, task, errors)
    if (result.reply) {
        return result.reply;
    }

    // Fallback for legacy responses or errors
    if (!result.ok) {
        return `Command Error: ${result.error || 'Unknown error'}`;
    }

    return 'Command processed';
}

async function sendChatMessage() {
    if (state.chatSending) return;

    // VTID-0526-D: Reset typing flag - user is done typing, now sending
    state.chatIsTyping = false;

    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const messageText = state.chatInputValue.trim();

    if (!messageText) return;

    // VTID-01041: Handle pending title capture (user is responding to "What should be the title?" prompt)
    if (state.pendingTitleVtid) {
        var titleInput = messageText.toLowerCase();
        var skipKeywords = ['skip', 'cancel', 'no', 'none', 'never mind', 'nevermind'];
        var isSkip = skipKeywords.some(function(kw) { return titleInput === kw; });

        // Add user message to UI
        state.chatMessages.push({
            type: 'user',
            content: messageText,
            timestamp: timestamp
        });

        if (isSkip) {
            // User chose to skip - keep placeholder
            state.chatMessages.push({
                type: 'system',
                content: 'Title skipped. The task will keep its placeholder title.',
                timestamp: timestamp
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
                    timestamp: timestamp
                });
            } else {
                state.chatMessages.push({
                    type: 'system',
                    content: 'No title provided. The task will keep its placeholder title.',
                    timestamp: timestamp
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
                timestamp: timestamp
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

    // VTID-01027: Add user message to session history
    var userHistoryEntry = {
        role: 'user',
        content: messageText,
        ts: now.getTime()
    };
    state.operatorChatHistory.push(userHistoryEntry);
    saveOperatorChatHistory(state.operatorChatHistory);

    // Add user message
    state.chatMessages.push({
        type: 'user',
        content: messageText,
        timestamp: timestamp,
        attachments: [...state.chatAttachments]
    });

    // Prepare attachments for API
    const attachments = state.chatAttachments.map(a => ({
        oasis_ref: a.oasis_ref,
        kind: a.kind
    }));

    // VTID-01027: Build context from history (excluding the message we just added)
    var contextHistory = state.operatorChatHistory.slice(0, -1);
    var context = buildOperatorChatContext(contextHistory);

    // Clear input and attachments
    state.chatInputValue = '';
    state.chatAttachments = [];
    state.chatSending = true;
    renderApp();

    // VTID-0526-D: Scroll to bottom after user message (safe - typing flag is reset)
    requestAnimationFrame(function() {
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

        const response = await fetch('/api/v1/operator/chat', {
            method: 'POST',
            headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                message: messageText,
                conversation_id: state.operatorConversationId,
                context: context.length > 0 ? context : undefined,
                attachments: attachments.length > 0 ? attachments : undefined
            })
        });

        if (!response.ok) {
            throw new Error(`Chat request failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Operator] Chat response:', result);

        // VTID-0537: Use the reply from the Gemini Operator Tools Bridge
        let replyContent = result.reply || 'No response received';

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

            // VTID-01041: If title is placeholder, prompt user for title
            if (needsTitlePrompt) {
                // Store the VTID awaiting title input
                state.pendingTitleVtid = createdVtid;
                state.pendingTitleRetryCount = 0;
                replyContent += '\n\nWhat should be the title for **' + createdVtid + '**?';
            }
        }

        // VTID-01027: Add assistant response to session history
        var assistantHistoryEntry = {
            role: 'assistant',
            content: replyContent,
            ts: Date.now()
        };
        state.operatorChatHistory.push(assistantHistoryEntry);
        saveOperatorChatHistory(state.operatorChatHistory);

        state.chatMessages.push({
            type: 'system',
            content: replyContent,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            oasis_ref: result.oasis_ref,
            threadId: result.threadId,
            createdTask: result.createdTask,
            toolResults: result.toolResults,
            meta: result.meta
        });

    } catch (error) {
        console.error('[Operator] Chat error:', error);
        // VTID-01041: Explicit failure confirmation with emoji
        var errorContent = String.fromCodePoint(0x274C) + ' Task creation failed: ' + error.message;
        state.chatMessages.push({
            type: 'system',
            content: errorContent,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            isError: true
        });
    } finally {
        state.chatSending = false;
        renderApp();

        // VTID-0526-D: Single rAF for scroll + conditional focus after message complete
        requestAnimationFrame(function() {
            // Scroll to bottom to show the reply
            var messagesContainer = document.querySelector('.chat-messages');
            if (messagesContainer) {
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

        state.activeExecutions.forEach(function(execData) {
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
    collapseCheckbox.onchange = function() {
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
    severityFilter.onchange = function() {
        state.tickerSeverityFilter = severityFilter.value;
        renderApp();
    };
    filterToolbar.appendChild(severityFilter);

    container.appendChild(filterToolbar);

    // Events list
    const eventsList = document.createElement('div');
    eventsList.className = 'ticker-events-list';

    if (state.tickerEvents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ticker-empty';
        empty.textContent = state.operatorHeartbeatActive ? 'Waiting for events...' : 'Loading events...';
        eventsList.appendChild(empty);
    } else {
        // VTID-0600: Classify and sort events by severity
        var classifiedEvents = state.tickerEvents.map(function(event) {
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
            classifiedEvents = classifiedEvents.filter(function(e) { return e.severity === 'critical'; });
        } else if (state.tickerSeverityFilter === 'important') {
            classifiedEvents = classifiedEvents.filter(function(e) { return e.severity === 'critical' || e.severity === 'important'; });
        }

        // Sort: critical first, then important, then info, then low
        var severityOrder = { critical: 0, important: 1, info: 2, low: 3 };
        classifiedEvents.sort(function(a, b) {
            return severityOrder[a.severity] - severityOrder[b.severity];
        });

        // Group heartbeat events if collapsing is enabled
        var heartbeatEvents = [];
        var otherEvents = [];

        if (state.tickerCollapseHeartbeat) {
            classifiedEvents.forEach(function(event) {
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
        otherEvents.forEach(function(event) {
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
            heartbeatHeader.onclick = function() {
                heartbeatSection.classList.toggle('expanded');
                var btn = heartbeatHeader.querySelector('.ticker-expand-btn');
                btn.textContent = heartbeatSection.classList.contains('expanded') ? 'Collapse ▲' : 'Expand ▼';
            };
            heartbeatSection.appendChild(heartbeatHeader);

            var heartbeatList = document.createElement('div');
            heartbeatList.className = 'ticker-heartbeat-list';

            heartbeatEvents.slice(0, 10).forEach(function(event) {
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
        ['VTID', 'Service', 'SWV', 'Timestamp', 'Status', 'Summary', 'Triggered By'].forEach(function(headerText) {
            const th = document.createElement('th');
            th.textContent = headerText;
            theadTr.appendChild(th);
        });
        thead.appendChild(theadTr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        state.versionHistory.forEach(function(deploy) {
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

// --- Publish Modal (VTID-0517) ---

/**
 * VTID-0523-A: Get the selected version object from version history
 * Returns the full version object or null if no version selected
 */
function getSelectedVersion() {
    if (!state.selectedVersionId || !state.versionHistory) {
        return null;
    }
    return state.versionHistory.find(v => v.id === state.selectedVersionId) || null;
}

/**
 * VTID-0523-A: Get the most recent version as default selection
 * Returns the first (most recent) version from history or null
 */
function getMostRecentVersion() {
    if (!state.versionHistory || state.versionHistory.length === 0) {
        return null;
    }
    return state.versionHistory[0];
}

/**
 * VTID-0523-B: Full Publish Confirmation Sheet
 * Unified UX with inline version selection - no separate dropdown needed
 */
function renderPublishModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            console.log('[VTID-0523-B] Publish cancelled: clicked overlay');
            state.showPublishModal = false;
            renderApp();
        }
    };

    const modal = document.createElement('div');
    modal.className = 'modal publish-modal';
    modal.style.cssText = 'max-width: 520px; width: 90%;';

    // Get current selection
    const selectedVersion = getSelectedVersion();
    const hasVersions = state.versionHistory && state.versionHistory.length > 0;

    // === HEADER ===
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1);';

    const title = document.createElement('span');
    title.textContent = 'Publish to Environment';
    title.style.cssText = 'font-size: 18px; font-weight: 600;';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'background: none; border: none; color: #888; font-size: 28px; cursor: pointer; padding: 0; line-height: 1;';
    closeBtn.onclick = () => {
        console.log('[VTID-0523-B] Publish cancelled: clicked close');
        state.showPublishModal = false;
        renderApp();
    };
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // === BODY ===
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'padding: 20px;';

    // Environment Info Section
    const envSection = document.createElement('div');
    envSection.style.cssText = 'margin-bottom: 20px; padding: 14px; background: rgba(255,255,255,0.03); border-radius: 8px; font-size: 13px;';
    envSection.innerHTML = `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span style="color: #888;">Environment:</span>
            <span style="color: #4ade80; font-weight: 500;">vitana-dev (us-central1)</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span style="color: #888;">Service:</span>
            <span style="color: #fff;">gateway</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
            <span style="color: #888;">Domain:</span>
            <span style="color: #60a5fa;">gateway-*.run.app</span>
        </div>
    `;
    body.appendChild(envSection);

    // Version Selector Section
    const versionSection = document.createElement('div');
    versionSection.style.cssText = 'margin-bottom: 20px;';

    const versionLabel = document.createElement('div');
    versionLabel.style.cssText = 'color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;';
    versionLabel.textContent = 'Version to Deploy';
    versionSection.appendChild(versionLabel);

    // Custom dark-themed dropdown
    const dropdownContainer = document.createElement('div');
    dropdownContainer.style.cssText = 'position: relative;';

    const dropdownButton = document.createElement('button');
    dropdownButton.type = 'button';
    dropdownButton.style.cssText = `
        width: 100%;
        padding: 14px 16px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 8px;
        color: #fff;
        font-size: 14px;
        cursor: pointer;
        text-align: left;
        display: flex;
        justify-content: space-between;
        align-items: center;
    `;

    const buttonText = document.createElement('span');
    if (!hasVersions) {
        buttonText.textContent = 'Loading versions...';
        buttonText.style.color = '#888';
    } else if (selectedVersion) {
        const commitShort = selectedVersion.commit ? selectedVersion.commit.substring(0, 8) : 'unknown';
        buttonText.textContent = `${selectedVersion.swv} — ${selectedVersion.service} — ${commitShort}`;
        buttonText.style.color = '#4ade80';
    } else {
        buttonText.textContent = '— Select a version to deploy —';
        buttonText.style.color = '#888';
    }
    dropdownButton.appendChild(buttonText);

    const arrow = document.createElement('span');
    arrow.textContent = '▼';
    arrow.style.cssText = 'color: #888; font-size: 10px; transition: transform 0.2s;';
    dropdownButton.appendChild(arrow);

    const dropdownList = document.createElement('div');
    dropdownList.id = 'version-dropdown-list';
    dropdownList.style.cssText = `
        display: none;
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: #1e293b;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 8px;
        margin-top: 4px;
        max-height: 280px;
        overflow-y: auto;
        z-index: 1000;
        box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    `;

    if (hasVersions) {
        state.versionHistory.forEach(v => {
            const item = document.createElement('div');
            const commitShort = v.commit ? v.commit.substring(0, 8) : 'unknown';
            const statusIcon = v.status === 'success' ? '✓' : '⚠';
            const isSelected = selectedVersion && v.id === selectedVersion.id;

            item.style.cssText = `
                padding: 12px 16px;
                cursor: pointer;
                border-bottom: 1px solid rgba(255,255,255,0.05);
                color: ${isSelected ? '#4ade80' : '#fff'};
                background: ${isSelected ? 'rgba(74,222,128,0.1)' : 'transparent'};
            `;
            item.innerHTML = `
                <div style="font-weight: 500;">${v.swv} — ${v.service} ${statusIcon}</div>
                <div style="font-size: 12px; color: #888; margin-top: 4px;">Commit: ${commitShort} | ${v.vtid || 'N/A'}</div>
            `;

            item.onmouseenter = () => { item.style.background = isSelected ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.08)'; };
            item.onmouseleave = () => { item.style.background = isSelected ? 'rgba(74,222,128,0.1)' : 'transparent'; };

            item.onclick = (e) => {
                e.stopPropagation();
                state.selectedVersionId = v.id;
                renderApp();
            };

            dropdownList.appendChild(item);
        });
    }

    dropdownButton.onclick = (e) => {
        e.stopPropagation();
        const isOpen = dropdownList.style.display === 'block';
        dropdownList.style.display = isOpen ? 'none' : 'block';
        arrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
    };

    // Close dropdown when clicking outside
    overlay.addEventListener('click', (e) => {
        if (!dropdownContainer.contains(e.target)) {
            dropdownList.style.display = 'none';
            arrow.style.transform = 'rotate(0deg)';
        }
    });

    dropdownContainer.appendChild(dropdownButton);
    dropdownContainer.appendChild(dropdownList);
    versionSection.appendChild(dropdownContainer);
    body.appendChild(versionSection);

    // Version Details Panel (shows when version selected)
    if (selectedVersion) {
        const detailsPanel = document.createElement('div');
        detailsPanel.style.cssText = 'background: rgba(74, 222, 128, 0.08); border: 1px solid rgba(74, 222, 128, 0.25); border-radius: 8px; padding: 16px; margin-bottom: 16px; font-family: ui-monospace, monospace; font-size: 13px;';

        const commitFull = selectedVersion.commit || 'unknown';
        const commitShort = commitFull.length > 8 ? commitFull.substring(0, 8) : commitFull;
        const statusColor = selectedVersion.status === 'success' ? '#4ade80' : '#fbbf24';

        detailsPanel.innerHTML = `
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                <span style="color: #888;">Version:</span>
                <span style="color: #4ade80; font-weight: 600; font-size: 14px;">${selectedVersion.swv}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                <span style="color: #888;">Commit:</span>
                <span style="color: #fbbf24;" title="${commitFull}">${commitShort}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                <span style="color: #888;">VTID:</span>
                <span style="color: #60a5fa;">${selectedVersion.vtid || 'N/A'}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
                <span style="color: #888;">Build Status:</span>
                <span style="color: ${statusColor};">${(selectedVersion.status || 'unknown').charAt(0).toUpperCase() + (selectedVersion.status || 'unknown').slice(1)}</span>
            </div>
        `;
        body.appendChild(detailsPanel);

        // Warning if this is the most recent (possibly already live)
        const isLatest = state.versionHistory[0] && state.versionHistory[0].id === selectedVersion.id;
        if (isLatest) {
            const warningBox = document.createElement('div');
            warningBox.style.cssText = 'background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; color: #fbbf24;';
            warningBox.innerHTML = `<strong>Note:</strong> ${selectedVersion.swv} is the latest version. Re-deploying will trigger a fresh deployment.`;
            body.appendChild(warningBox);
        }
    } else if (hasVersions) {
        // No version selected - show instruction
        const instructionBox = document.createElement('div');
        instructionBox.style.cssText = 'background: rgba(96, 165, 250, 0.08); border: 1px solid rgba(96, 165, 250, 0.25); border-radius: 8px; padding: 20px; text-align: center; color: #60a5fa;';
        instructionBox.innerHTML = `
            <div style="font-size: 32px; margin-bottom: 10px;">☝️</div>
            <div style="font-size: 14px;">Select a version above to see details</div>
        `;
        body.appendChild(instructionBox);
    }

    // VTID-0541 D4: CI/CD Health Warning with proper distinction
    // - 'degraded': Runtime is broken - show error warning
    // - 'ok_governance_limited': Runtime OK but governance features unavailable - show info warning
    // - 'ok': All good - no warning
    if (state.cicdHealth) {
        const healthStatus = state.cicdHealth.status;
        const runtimeHealth = state.cicdHealth.health?.runtime_deploy;

        if (healthStatus === 'degraded' || runtimeHealth === 'degraded') {
            // Runtime actually broken - show red error warning
            const cicdWarning = document.createElement('div');
            cicdWarning.style.cssText = 'background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; color: #f87171;';
            cicdWarning.innerHTML = `<strong>⚠ CI/CD Degraded:</strong> Runtime deploy health is not available. Deployment may fail.`;
            body.appendChild(cicdWarning);
        } else if (healthStatus === 'ok_governance_limited') {
            // Governance limited but runtime OK - show yellow informational warning
            const govWarning = document.createElement('div');
            govWarning.style.cssText = 'background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; color: #fbbf24;';
            const note = state.cicdHealth.notes?.governance_limited || 'GitHub integration unavailable - some governance features are limited';
            govWarning.innerHTML = `<strong>ℹ Governance Limited:</strong> ${note}. Deploy will proceed normally.`;
            body.appendChild(govWarning);
        }
    }

    modal.appendChild(body);

    // === FOOTER ===
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.cssText = 'display: flex; justify-content: flex-end; gap: 12px; padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1);';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding: 12px 24px; background: rgba(255,255,255,0.1); border: none; border-radius: 6px; color: #fff; cursor: pointer;';
    cancelBtn.onclick = () => {
        console.log('[VTID-0523-B] Publish cancelled: clicked cancel button');
        state.showPublishModal = false;
        renderApp();
    };
    footer.appendChild(cancelBtn);

    const deployBtn = document.createElement('button');
    deployBtn.className = 'btn btn-primary';

    if (selectedVersion) {
        deployBtn.textContent = `Deploy ${selectedVersion.swv}`;
        deployBtn.style.cssText = 'padding: 12px 28px; background: #4ade80; border: none; border-radius: 6px; color: #000; font-weight: 600; cursor: pointer;';
    } else {
        deployBtn.textContent = 'Deploy';
        deployBtn.disabled = true;
        deployBtn.style.cssText = 'padding: 12px 28px; background: #4ade80; border: none; border-radius: 6px; color: #000; font-weight: 600; opacity: 0.4; cursor: not-allowed;';
        deployBtn.title = 'Select a version first';
    }

    deployBtn.onclick = async () => {
        if (!selectedVersion) {
            showToast('Please select a version before deploying', 'error');
            return;
        }

        console.log('[VTID-0523-B] Deploy confirmed:', selectedVersion);
        deployBtn.disabled = true;
        deployBtn.textContent = 'Deploying...';
        deployBtn.style.opacity = '0.7';

        try {
            const payload = {
                vtid: selectedVersion.vtid || ('VTID-DEPLOY-' + Date.now()),
                swv: selectedVersion.swv,
                service: selectedVersion.service || 'gateway',
                environment: 'dev',
                commit: selectedVersion.commit,
                actor: 'operator-ui'
            };

            const response = await fetch('/api/v1/operator/deploy', {
                method: 'POST',
                headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload)
            });

            const result = await response.json();

            // VTID-0407: Check for governance blocked response
            if (result.blocked === true) {
                console.log('[VTID-0407] Deploy blocked by governance:', result);
                state.showPublishModal = false;
                state.showGovernanceBlockedModal = true;
                state.governanceBlockedData = {
                    level: result.level || 'L1',
                    violations: result.violations || [],
                    service: payload.service,
                    vtid: payload.vtid,
                    swv: selectedVersion.swv
                };

                // Add to ticker with governance blocked event
                state.tickerEvents.unshift({
                    id: Date.now(),
                    timestamp: new Date().toLocaleTimeString(),
                    type: 'governance',
                    topic: 'governance.deploy.blocked',
                    content: 'governance.deploy.blocked: ' + selectedVersion.swv + ' deployment stopped',
                    vtid: payload.vtid
                });

                renderApp();
                return;
            }

            if (!result.ok) {
                throw new Error(result.error || 'Deploy failed');
            }

            console.log('[VTID-0523-B] Deploy queued:', result);

            // ===========================================================
            // VTID-01019: OASIS ACK Binding - No optimistic success UI
            // Register pending action and wait for OASIS confirmation
            // ===========================================================
            const actionVtid = payload.vtid;
            const commitShort = selectedVersion.commit ? selectedVersion.commit.substring(0, 7) : '';

            registerPendingAction({
                id: result.event_id || 'deploy-' + Date.now(),
                type: 'deploy',
                vtid: actionVtid,
                description: 'Deploy ' + selectedVersion.swv + ' (' + commitShort + ')'
            });

            // Close modal but show LOADING state (not success)
            state.showPublishModal = false;

            // VTID-01019: Show LOADING toast instead of SUCCESS
            // Success will be shown when OASIS confirms via SSE
            showToast('Deployment submitted - awaiting confirmation...', 'info');

            // Add to ticker with "requested" status (not "allowed" - that's optimistic)
            state.tickerEvents.unshift({
                id: Date.now(),
                timestamp: new Date().toLocaleTimeString(),
                type: 'deploy',
                topic: 'cicd.deploy.requested',
                content: 'Deploy requested: ' + selectedVersion.swv + ' - awaiting OASIS confirmation',
                vtid: actionVtid,
                swv: selectedVersion.swv,
                service: payload.service
            });

            renderApp();

        } catch (error) {
            console.error('[VTID-0523-B] Deploy error:', error);
            // VTID-01019: Immediate failure is shown directly (backend error, not OASIS failure)
            showToast('Deploy failed: ' + error.message, 'error');
            deployBtn.disabled = false;
            deployBtn.textContent = 'Deploy ' + selectedVersion.swv;
            deployBtn.style.opacity = '1';
        }
    };

    footer.appendChild(deployBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    return overlay;
}

// --- VTID-01180: Autopilot Recommendations Modal ---

/**
 * VTID-01180: Render the Autopilot Recommendations modal
 * Shows AI-generated recommendations with Activate/Snooze/Reject actions
 */
function renderAutopilotRecommendationsModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = function(e) {
        if (e.target === overlay) {
            state.showAutopilotRecommendationsModal = false;
            renderApp();
        }
    };

    var modal = document.createElement('div');
    modal.className = 'modal autopilot-recommendations-modal';
    modal.style.cssText = 'max-width: 700px; width: 95%; max-height: 80vh; display: flex; flex-direction: column;';

    // === HEADER ===
    var header = document.createElement('div');
    header.className = 'modal-header';
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.1)); flex-shrink: 0;';

    var titleRow = document.createElement('div');
    titleRow.style.cssText = 'display: flex; align-items: center; gap: 12px;';

    var iconSpan = document.createElement('span');
    iconSpan.style.cssText = 'font-size: 24px;';
    iconSpan.textContent = '\u{1F916}'; // Robot emoji
    titleRow.appendChild(iconSpan);

    var title = document.createElement('span');
    title.textContent = 'Autopilot Recommendations';
    title.style.cssText = 'font-size: 18px; font-weight: 600; color: var(--text-color, #fff);';
    titleRow.appendChild(title);

    header.appendChild(titleRow);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'background: none; border: none; font-size: 24px; cursor: pointer; color: var(--text-secondary, #888); padding: 4px 8px;';
    closeBtn.onclick = function() {
        state.showAutopilotRecommendationsModal = false;
        renderApp();
    };
    header.appendChild(closeBtn);

    modal.appendChild(header);

    // === BODY ===
    var body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'padding: 16px 20px; overflow-y: auto; flex: 1;';

    if (state.autopilotRecommendationsLoading) {
        var loadingDiv = document.createElement('div');
        loadingDiv.style.cssText = 'text-align: center; padding: 40px; color: var(--text-secondary, #888);';
        loadingDiv.textContent = 'Loading recommendations...';
        body.appendChild(loadingDiv);
    } else if (state.autopilotRecommendationsError) {
        var errorDiv = document.createElement('div');
        errorDiv.style.cssText = 'text-align: center; padding: 40px; color: #f87171;';
        errorDiv.textContent = 'Error: ' + state.autopilotRecommendationsError;
        body.appendChild(errorDiv);
    } else if (state.autopilotRecommendations.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.style.cssText = 'text-align: center; padding: 40px; color: var(--text-secondary, #888);';
        emptyDiv.innerHTML = '<div style="font-size: 48px; margin-bottom: 16px;">\u2705</div>';
        emptyDiv.innerHTML += '<div style="font-size: 16px;">All caught up!</div>';
        emptyDiv.innerHTML += '<div style="font-size: 14px; margin-top: 8px;">No new recommendations at this time.</div>';
        body.appendChild(emptyDiv);
    } else {
        // Render recommendations list
        state.autopilotRecommendations.forEach(function(rec) {
            var card = createRecommendationCard(rec);
            body.appendChild(card);
        });
    }

    modal.appendChild(body);

    // === FOOTER ===
    var footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.cssText = 'padding: 12px 20px; border-top: 1px solid var(--border-color, rgba(255,255,255,0.1)); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;';

    var countLabel = document.createElement('span');
    countLabel.style.cssText = 'color: var(--text-secondary, #888); font-size: 13px;';
    countLabel.textContent = state.autopilotRecommendations.length + ' recommendation' + (state.autopilotRecommendations.length !== 1 ? 's' : '');
    footer.appendChild(countLabel);

    var closeFooterBtn = document.createElement('button');
    closeFooterBtn.className = 'btn btn-secondary';
    closeFooterBtn.textContent = 'Close';
    closeFooterBtn.style.cssText = 'padding: 8px 16px;';
    closeFooterBtn.onclick = function() {
        state.showAutopilotRecommendationsModal = false;
        renderApp();
    };
    footer.appendChild(closeFooterBtn);

    modal.appendChild(footer);

    overlay.appendChild(modal);
    return overlay;
}

/**
 * VTID-01180: Create a recommendation card element
 */
function createRecommendationCard(rec) {
    var card = document.createElement('div');
    card.className = 'recommendation-card';
    card.style.cssText = 'background: var(--card-bg, rgba(255,255,255,0.05)); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); border-radius: 8px; padding: 16px; margin-bottom: 12px;';

    // Top row: Domain badge + Risk level
    var topRow = document.createElement('div');
    topRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';

    var domainBadge = document.createElement('span');
    domainBadge.className = 'domain-badge';
    domainBadge.style.cssText = 'background: var(--accent-color, #3b82f6); color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; text-transform: uppercase;';
    domainBadge.textContent = rec.domain || 'general';
    topRow.appendChild(domainBadge);

    var riskBadge = document.createElement('span');
    var riskColors = { low: '#22c55e', medium: '#eab308', high: '#f97316', critical: '#ef4444' };
    riskBadge.style.cssText = 'font-size: 11px; color: ' + (riskColors[rec.risk_level] || '#888') + ';';
    riskBadge.textContent = (rec.risk_level || 'low').toUpperCase() + ' RISK';
    topRow.appendChild(riskBadge);

    card.appendChild(topRow);

    // Title
    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size: 15px; font-weight: 600; color: var(--text-color, #fff); margin-bottom: 6px;';
    titleEl.textContent = rec.title;
    card.appendChild(titleEl);

    // Summary
    var summaryEl = document.createElement('div');
    summaryEl.style.cssText = 'font-size: 13px; color: var(--text-secondary, #aaa); margin-bottom: 12px; line-height: 1.4;';
    summaryEl.textContent = rec.summary;
    card.appendChild(summaryEl);

    // Scores row
    var scoresRow = document.createElement('div');
    scoresRow.style.cssText = 'display: flex; gap: 16px; margin-bottom: 12px;';

    var impactEl = document.createElement('span');
    impactEl.style.cssText = 'font-size: 12px; color: var(--text-secondary, #888);';
    impactEl.innerHTML = 'Impact: <strong style="color: #22c55e;">' + (rec.impact_score || 5) + '/10</strong>';
    scoresRow.appendChild(impactEl);

    var effortEl = document.createElement('span');
    effortEl.style.cssText = 'font-size: 12px; color: var(--text-secondary, #888);';
    effortEl.innerHTML = 'Effort: <strong style="color: #eab308;">' + (rec.effort_score || 5) + '/10</strong>';
    scoresRow.appendChild(effortEl);

    card.appendChild(scoresRow);

    // Action buttons
    var actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display: flex; gap: 8px;';

    // Activate button
    var activateBtn = document.createElement('button');
    activateBtn.className = 'btn btn-primary';
    activateBtn.textContent = 'Activate';
    activateBtn.style.cssText = 'padding: 6px 14px; font-size: 13px; background: #22c55e; border: none; color: white; border-radius: 4px; cursor: pointer;';
    activateBtn.onclick = async function() {
        activateBtn.disabled = true;
        activateBtn.textContent = 'Activating...';
        try {
            var response = await fetch('/api/v1/autopilot/recommendations/' + rec.id + '/activate', {
                method: 'POST',
                headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' })
            });
            var data = await response.json();
            if (data.ok) {
                showToast('Activated! VTID: ' + data.vtid, 'success');
                // Remove from list
                state.autopilotRecommendations = state.autopilotRecommendations.filter(function(r) { return r.id !== rec.id; });
                state.autopilotRecommendationsCount = Math.max(0, state.autopilotRecommendationsCount - 1);
                renderApp();
            } else {
                showToast('Activation failed: ' + (data.error || 'Unknown error'), 'error');
                activateBtn.disabled = false;
                activateBtn.textContent = 'Activate';
            }
        } catch (err) {
            showToast('Activation error: ' + err.message, 'error');
            activateBtn.disabled = false;
            activateBtn.textContent = 'Activate';
        }
    };
    actionsRow.appendChild(activateBtn);

    // Snooze button
    var snoozeBtn = document.createElement('button');
    snoozeBtn.className = 'btn btn-secondary';
    snoozeBtn.textContent = 'Snooze';
    snoozeBtn.style.cssText = 'padding: 6px 14px; font-size: 13px; background: transparent; border: 1px solid var(--border-color, rgba(255,255,255,0.2)); color: var(--text-color, #fff); border-radius: 4px; cursor: pointer;';
    snoozeBtn.onclick = async function() {
        snoozeBtn.disabled = true;
        try {
            var response = await fetch('/api/v1/autopilot/recommendations/' + rec.id + '/snooze', {
                method: 'POST',
                headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ hours: 24 })
            });
            var data = await response.json();
            if (data.ok) {
                showToast('Snoozed for 24 hours', 'info');
                state.autopilotRecommendations = state.autopilotRecommendations.filter(function(r) { return r.id !== rec.id; });
                state.autopilotRecommendationsCount = Math.max(0, state.autopilotRecommendationsCount - 1);
                renderApp();
            } else {
                showToast('Snooze failed: ' + (data.error || 'Unknown error'), 'error');
                snoozeBtn.disabled = false;
            }
        } catch (err) {
            showToast('Snooze error: ' + err.message, 'error');
            snoozeBtn.disabled = false;
        }
    };
    actionsRow.appendChild(snoozeBtn);

    // Reject button
    var rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-secondary';
    rejectBtn.textContent = 'Dismiss';
    rejectBtn.style.cssText = 'padding: 6px 14px; font-size: 13px; background: transparent; border: 1px solid var(--border-color, rgba(255,255,255,0.2)); color: var(--text-secondary, #888); border-radius: 4px; cursor: pointer;';
    rejectBtn.onclick = async function() {
        rejectBtn.disabled = true;
        try {
            var response = await fetch('/api/v1/autopilot/recommendations/' + rec.id + '/reject', {
                method: 'POST',
                headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' })
            });
            var data = await response.json();
            if (data.ok) {
                showToast('Recommendation dismissed', 'info');
                state.autopilotRecommendations = state.autopilotRecommendations.filter(function(r) { return r.id !== rec.id; });
                state.autopilotRecommendationsCount = Math.max(0, state.autopilotRecommendationsCount - 1);
                renderApp();
            } else {
                showToast('Dismiss failed: ' + (data.error || 'Unknown error'), 'error');
                rejectBtn.disabled = false;
            }
        } catch (err) {
            showToast('Dismiss error: ' + err.message, 'error');
            rejectBtn.disabled = false;
        }
    };
    actionsRow.appendChild(rejectBtn);

    card.appendChild(actionsRow);

    return card;
}

/**
 * VTID-01180: Fetch recommendation count on app boot (for badge)
 */
async function fetchAutopilotRecommendationsCount() {
    try {
        var response = await fetch('/api/v1/autopilot/recommendations/count', {
            headers: withVitanaContextHeaders({})
        });
        if (response.ok) {
            var data = await response.json();
            if (data.ok) {
                state.autopilotRecommendationsCount = data.count || 0;
                renderApp();
            }
        }
    } catch (err) {
        console.warn('[VTID-01180] Could not fetch recommendations count:', err);
    }
}

// --- VTID-0407: Governance Blocked Modal ---

/**
 * VTID-0407: Render the Governance Blocked modal
 * Shown when deployment is blocked due to L1/L2 violations
 */
function renderGovernanceBlockedModal() {
    var data = state.governanceBlockedData;
    if (!data) return null;

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = function(e) {
        if (e.target === overlay) {
            state.showGovernanceBlockedModal = false;
            state.governanceBlockedData = null;
            renderApp();
        }
    };

    var modal = document.createElement('div');
    modal.className = 'modal governance-blocked-modal';
    modal.style.cssText = 'max-width: 560px; width: 90%;';

    // === HEADER ===
    var header = document.createElement('div');
    header.className = 'modal-header governance-blocked-header';
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid rgba(239,68,68,0.3); background: rgba(239,68,68,0.08);';

    var titleRow = document.createElement('div');
    titleRow.style.cssText = 'display: flex; align-items: center; gap: 12px;';

    var iconSpan = document.createElement('span');
    iconSpan.style.cssText = 'font-size: 24px;';
    iconSpan.textContent = '\u26D4'; // No entry unicode
    titleRow.appendChild(iconSpan);

    var title = document.createElement('span');
    title.textContent = 'Deployment Blocked by Governance';
    title.style.cssText = 'font-size: 18px; font-weight: 600; color: #f87171;';
    titleRow.appendChild(title);

    header.appendChild(titleRow);

    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'background: none; border: none; color: #888; font-size: 28px; cursor: pointer; padding: 0; line-height: 1;';
    closeBtn.onclick = function() {
        state.showGovernanceBlockedModal = false;
        state.governanceBlockedData = null;
        renderApp();
    };
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // === BODY ===
    var body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'padding: 20px;';

    // Message section
    var messageSection = document.createElement('div');
    messageSection.style.cssText = 'margin-bottom: 20px; padding: 14px; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25); border-radius: 8px;';

    var messageText = document.createElement('p');
    messageText.style.cssText = 'margin: 0; color: #f8fafc; font-size: 14px; line-height: 1.5;';
    messageText.textContent = 'Your deployment was stopped because one or more ' + data.level + ' rules were violated. Please address the violations below before attempting to deploy again.';
    messageSection.appendChild(messageText);

    body.appendChild(messageSection);

    // Deploy info
    var infoSection = document.createElement('div');
    infoSection.style.cssText = 'margin-bottom: 20px; padding: 12px; background: rgba(255,255,255,0.03); border-radius: 8px; font-size: 13px;';
    infoSection.innerHTML = '<div style="display: flex; justify-content: space-between; margin-bottom: 6px;"><span style="color: #888;">Version:</span><span style="color: #4ade80;">' + (data.swv || 'N/A') + '</span></div>' +
        '<div style="display: flex; justify-content: space-between; margin-bottom: 6px;"><span style="color: #888;">Service:</span><span style="color: #fff;">' + (data.service || 'gateway') + '</span></div>' +
        '<div style="display: flex; justify-content: space-between;"><span style="color: #888;">VTID:</span><span style="color: #60a5fa;">' + (data.vtid || 'N/A') + '</span></div>';
    body.appendChild(infoSection);

    // Violations label
    var violationsLabel = document.createElement('div');
    violationsLabel.style.cssText = 'color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;';
    violationsLabel.textContent = 'Violated Rules (' + (data.violations ? data.violations.length : 0) + ')';
    body.appendChild(violationsLabel);

    // Violations list
    var violationsList = document.createElement('div');
    violationsList.style.cssText = 'display: flex; flex-direction: column; gap: 10px; max-height: 240px; overflow-y: auto;';

    if (data.violations && data.violations.length > 0) {
        data.violations.forEach(function(violation) {
            var violationCard = document.createElement('div');
            violationCard.className = 'governance-violation-card';
            violationCard.style.cssText = 'padding: 12px 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; cursor: pointer; transition: all 0.2s;';

            // Make card clickable to open rule drawer
            violationCard.onclick = function() {
                // Set selected rule and navigate to governance rules
                state.selectedGovernanceRule = {
                    id: violation.rule_id,
                    level: violation.level,
                    title: violation.message
                };
                state.showGovernanceBlockedModal = false;
                state.governanceBlockedData = null;
                // Navigate to governance rules tab
                state.currentModuleKey = 'governance';
                state.currentTab = 'rules';
                renderApp();
            };

            violationCard.onmouseenter = function() {
                violationCard.style.background = 'rgba(255,255,255,0.06)';
                violationCard.style.borderColor = 'rgba(239,68,68,0.3)';
            };
            violationCard.onmouseleave = function() {
                violationCard.style.background = 'rgba(255,255,255,0.03)';
                violationCard.style.borderColor = 'rgba(255,255,255,0.1)';
            };

            var cardHeader = document.createElement('div');
            cardHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 8px;';

            // Rule ID chip
            var ruleChip = document.createElement('span');
            ruleChip.className = 'governance-rule-chip';
            ruleChip.style.cssText = 'padding: 4px 8px; background: rgba(96,165,250,0.15); border: 1px solid rgba(96,165,250,0.3); border-radius: 4px; font-size: 12px; font-weight: 600; color: #60a5fa; font-family: ui-monospace, monospace;';
            ruleChip.textContent = violation.rule_id || 'UNKNOWN';
            cardHeader.appendChild(ruleChip);

            // Level indicator
            var levelBadge = document.createElement('span');
            var levelColor = violation.level === 'L1' ? '#ef4444' : violation.level === 'L2' ? '#f59e0b' : '#60a5fa';
            levelBadge.style.cssText = 'padding: 2px 6px; background: ' + levelColor + '22; border: 1px solid ' + levelColor + '44; border-radius: 4px; font-size: 11px; font-weight: 600; color: ' + levelColor + ';';
            levelBadge.textContent = violation.level || 'L1';
            cardHeader.appendChild(levelBadge);

            violationCard.appendChild(cardHeader);

            // Message
            var messageP = document.createElement('p');
            messageP.style.cssText = 'margin: 0; color: #94a3b8; font-size: 13px; line-height: 1.4;';
            messageP.textContent = violation.message || 'Rule violation detected';
            violationCard.appendChild(messageP);

            // Hint to click
            var hintText = document.createElement('div');
            hintText.style.cssText = 'margin-top: 8px; font-size: 11px; color: #64748b;';
            hintText.textContent = 'Click to view rule details \u2192';
            violationCard.appendChild(hintText);

            violationsList.appendChild(violationCard);
        });
    } else {
        var noViolations = document.createElement('div');
        noViolations.style.cssText = 'padding: 20px; text-align: center; color: #888;';
        noViolations.textContent = 'No violation details available';
        violationsList.appendChild(noViolations);
    }

    body.appendChild(violationsList);
    modal.appendChild(body);

    // === FOOTER ===
    var footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1);';

    var helpText = document.createElement('span');
    helpText.style.cssText = 'font-size: 12px; color: #64748b;';
    helpText.textContent = 'Contact admin to request rule exceptions';
    footer.appendChild(helpText);

    var dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.style.cssText = 'padding: 10px 20px; background: rgba(255,255,255,0.1); border: none; border-radius: 6px; color: #fff; cursor: pointer;';
    dismissBtn.onclick = function() {
        state.showGovernanceBlockedModal = false;
        state.governanceBlockedData = null;
        renderApp();
    };
    footer.appendChild(dismissBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);
    return overlay;
}

/**
 * VTID-01194: Execution Approval Confirmation Modal
 * "Moving this task to In Progress will immediately start autonomous execution."
 *
 * This modal is REQUIRED per VTID-01194 spec before moving a task to IN_PROGRESS.
 * IN_PROGRESS = Explicit Human Approval to Execute
 *
 * Features:
 * - Clear warning message about autonomous execution
 * - Optional reason field for audit trail
 * - Confirm/Cancel buttons
 */
function renderExecutionApprovalModal() {
    if (!state.showExecutionApprovalModal || !state.executionApprovalVtid) {
        return null;
    }

    var vtid = state.executionApprovalVtid;

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = function(e) {
        if (e.target === overlay && !state.executionApprovalLoading) {
            state.showExecutionApprovalModal = false;
            state.executionApprovalVtid = null;
            state.executionApprovalReason = '';
            renderApp();
        }
    };

    var modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'max-width: 480px; background: #1e293b; border: 1px solid rgba(74,222,128,0.3); box-shadow: 0 0 40px rgba(74,222,128,0.15);';

    // === HEADER ===
    var header = document.createElement('div');
    header.className = 'modal-header';
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1);';

    var titleRow = document.createElement('div');
    titleRow.style.cssText = 'display: flex; align-items: center; gap: 10px;';

    var iconSpan = document.createElement('span');
    iconSpan.style.cssText = 'font-size: 22px;';
    iconSpan.textContent = '\u26A1'; // Lightning bolt - execution
    titleRow.appendChild(iconSpan);

    var title = document.createElement('span');
    title.textContent = 'Approve Execution';
    title.style.cssText = 'font-size: 18px; font-weight: 600; color: #4ade80;';
    titleRow.appendChild(title);

    header.appendChild(titleRow);

    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'background: none; border: none; color: #888; font-size: 28px; cursor: pointer; padding: 0; line-height: 1;';
    closeBtn.disabled = state.executionApprovalLoading;
    closeBtn.onclick = function() {
        if (!state.executionApprovalLoading) {
            state.showExecutionApprovalModal = false;
            state.executionApprovalVtid = null;
            state.executionApprovalReason = '';
            renderApp();
        }
    };
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // === BODY ===
    var body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'padding: 20px;';

    // VTID badge
    var vtidBadge = document.createElement('div');
    vtidBadge.style.cssText = 'display: inline-block; padding: 6px 12px; background: rgba(96,165,250,0.15); border: 1px solid rgba(96,165,250,0.3); border-radius: 6px; font-size: 14px; font-weight: 600; color: #60a5fa; font-family: ui-monospace, monospace; margin-bottom: 16px;';
    vtidBadge.textContent = vtid;
    body.appendChild(vtidBadge);

    // Warning message section (VTID-01194 required text)
    var warningSection = document.createElement('div');
    warningSection.style.cssText = 'margin-bottom: 20px; padding: 16px; background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.25); border-radius: 8px;';

    var warningIcon = document.createElement('div');
    warningIcon.style.cssText = 'font-size: 24px; margin-bottom: 8px;';
    warningIcon.textContent = '\u26A0\uFE0F'; // Warning sign
    warningSection.appendChild(warningIcon);

    var warningTitle = document.createElement('div');
    warningTitle.style.cssText = 'font-weight: 600; color: #fbbf24; margin-bottom: 8px; font-size: 15px;';
    warningTitle.textContent = 'Autonomous Execution Warning';
    warningSection.appendChild(warningTitle);

    var warningText = document.createElement('p');
    warningText.style.cssText = 'margin: 0; color: #f8fafc; font-size: 14px; line-height: 1.6;';
    warningText.textContent = 'Moving this task to In Progress will immediately start autonomous execution. The system will begin working on this task automatically.';
    warningSection.appendChild(warningText);

    body.appendChild(warningSection);

    // What will happen section
    var whatHappensSection = document.createElement('div');
    whatHappensSection.style.cssText = 'margin-bottom: 20px; padding: 14px; background: rgba(255,255,255,0.03); border-radius: 8px;';

    var whatHappensTitle = document.createElement('div');
    whatHappensTitle.style.cssText = 'font-weight: 500; color: #94a3b8; margin-bottom: 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;';
    whatHappensTitle.textContent = 'What will happen:';
    whatHappensSection.appendChild(whatHappensTitle);

    var stepsList = document.createElement('ul');
    stepsList.style.cssText = 'margin: 0; padding-left: 18px; color: #cbd5e1; font-size: 13px; line-height: 1.8;';
    var steps = [
        'Task status changes to IN_PROGRESS',
        'Execution approval event emitted to OASIS',
        'Worker dispatched to begin autonomous work',
        'Progress tracked in Command Hub'
    ];
    steps.forEach(function(step) {
        var li = document.createElement('li');
        li.textContent = step;
        stepsList.appendChild(li);
    });
    whatHappensSection.appendChild(stepsList);

    body.appendChild(whatHappensSection);

    // Optional reason field (audit-friendly per VTID-01194)
    var reasonSection = document.createElement('div');
    reasonSection.style.cssText = 'margin-bottom: 8px;';

    var reasonLabel = document.createElement('label');
    reasonLabel.style.cssText = 'display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px;';
    reasonLabel.textContent = 'Reason (optional, for audit trail):';
    reasonSection.appendChild(reasonLabel);

    var reasonInput = document.createElement('input');
    reasonInput.type = 'text';
    reasonInput.placeholder = 'e.g., Approved after review, Testing new feature...';
    reasonInput.style.cssText = 'width: 100%; padding: 10px 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #f8fafc; font-size: 14px; box-sizing: border-box;';
    reasonInput.value = state.executionApprovalReason || '';
    reasonInput.disabled = state.executionApprovalLoading;
    reasonInput.oninput = function(e) {
        state.executionApprovalReason = e.target.value;
    };
    reasonSection.appendChild(reasonInput);

    body.appendChild(reasonSection);
    modal.appendChild(body);

    // === FOOTER ===
    var footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.cssText = 'display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1);';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding: 10px 20px; background: rgba(255,255,255,0.1); border: none; border-radius: 6px; color: #fff; cursor: pointer;';
    cancelBtn.disabled = state.executionApprovalLoading;
    cancelBtn.onclick = function() {
        if (!state.executionApprovalLoading) {
            state.showExecutionApprovalModal = false;
            state.executionApprovalVtid = null;
            state.executionApprovalReason = '';
            renderApp();
        }
    };
    footer.appendChild(cancelBtn);

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-success';
    confirmBtn.textContent = state.executionApprovalLoading ? 'Approving...' : 'Approve & Start Execution';
    confirmBtn.style.cssText = 'padding: 10px 20px; background: #22c55e; border: none; border-radius: 6px; color: #fff; cursor: pointer; font-weight: 600;';
    confirmBtn.disabled = state.executionApprovalLoading;
    confirmBtn.onclick = async function() {
        state.executionApprovalLoading = true;
        renderApp();

        try {
            // VTID-01194: Call lifecycle/start with approval_reason
            var response = await fetch('/api/v1/vtid/lifecycle/start', {
                method: 'POST',
                headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    vtid: vtid,
                    source: 'command-hub',
                    summary: vtid + ': Execution approved from Command Hub',
                    approval_reason: state.executionApprovalReason || null
                })
            });
            var result = await response.json();

            if (result.ok) {
                // Clear modal state
                state.showExecutionApprovalModal = false;
                state.executionApprovalVtid = null;
                state.executionApprovalReason = '';
                state.executionApprovalLoading = false;

                // Clear task selection and override
                clearTaskStatusOverride(vtid);
                state.selectedTask = null;
                state.selectedTaskDetail = null;
                state.drawerSpecVtid = null;
                state.drawerSpecText = '';
                state.drawerSpecEditing = false;

                // Show success toast
                showToast('Execution approved: ' + vtid + ' \u2192 Autonomous execution started', 'success');

                // Refresh tasks
                await fetchTasks();
            } else {
                state.executionApprovalLoading = false;
                showToast('Approval failed: ' + (result.error || 'Unknown error'), 'error');
                renderApp();
            }
        } catch (e) {
            console.error('[VTID-01194] Execution approval failed:', e);
            state.executionApprovalLoading = false;
            showToast('Approval failed: Network error', 'error');
            renderApp();
        }
    };
    footer.appendChild(confirmBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);
    return overlay;
}

// --- Bundle Fingerprint (VTID-0529-B) ---
// Hard fingerprint that proves which bundle is actually being served
// Banner at top + footer label at bottom-right

function renderBundleFingerprintBanner() {
    const banner = document.createElement('div');
    banner.className = 'bundle-fingerprint-banner';
    banner.textContent = 'VTID-0529-B – LIVE BUNDLE';
    return banner;
}

function renderBundleFingerprintFooter() {
    const footer = document.createElement('div');
    footer.className = 'bundle-fingerprint-footer';
    footer.textContent = 'Bundle: VTID-0529-B';
    return footer;
}

// --- Toast Notification Container (VTID-0517) ---

function renderToastContainer() {
    const container = document.createElement('div');
    container.className = 'toast-container';

    state.toasts.forEach(toast => {
        const toastEl = document.createElement('div');
        toastEl.className = 'toast toast--' + toast.type;

        const message = document.createElement('span');
        message.className = 'toast__message';
        message.textContent = toast.message;
        toastEl.appendChild(message);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast__close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = () => {
            state.toasts = state.toasts.filter(t => t.id !== toast.id);
            renderApp();
        };
        toastEl.appendChild(closeBtn);

        container.appendChild(toastEl);
    });

    return container;
}

// --- VTID-0509: Operator Console API Functions ---

/**
 * Toggle heartbeat session between Live and Standby
 */
async function toggleHeartbeatSession() {
    const newStatus = state.operatorHeartbeatActive ? 'standby' : 'live';
    console.log(`[Operator] Toggling heartbeat to: ${newStatus}`);

    try {
        const response = await fetch('/api/v1/operator/heartbeat/session', {
            method: 'POST',
            headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ status: newStatus })
        });

        if (!response.ok) {
            throw new Error(`Session update failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Operator] Session updated:', result);

        state.operatorHeartbeatActive = newStatus === 'live';

        if (state.operatorHeartbeatActive) {
            // Fetch heartbeat snapshot
            await fetchHeartbeatSnapshot();
            // Start SSE stream
            startOperatorSse();
            // Open operator console on ticker tab
            state.operatorActiveTab = 'ticker';
            state.isOperatorOpen = true;
        } else {
            // Stop SSE stream
            stopOperatorSse();
        }

        renderApp();

    } catch (error) {
        console.error('[Operator] Session toggle error:', error);
        alert('Failed to update heartbeat session: ' + error.message);
    }
}

/**
 * Fetch heartbeat snapshot from API
 */
async function fetchHeartbeatSnapshot() {
    console.log('[Operator] Fetching heartbeat snapshot...');
    try {
        const response = await fetch('/api/v1/operator/heartbeat');
        if (!response.ok) {
            throw new Error(`Heartbeat fetch failed: ${response.status}`);
        }

        const snapshot = await response.json();
        console.log('[Operator] Heartbeat snapshot:', snapshot);

        state.operatorHeartbeatSnapshot = snapshot;

        // Add snapshot events to ticker (backend returns 'recent_events', not 'events')
        // Backend returns newest first, we want newest at top (index 0)
        const events = snapshot.recent_events || snapshot.events || [];
        if (events.length > 0) {
            // Clear existing ticker events and add new ones (newest first)
            state.tickerEvents = events.map(event => ({
                id: Date.now() + Math.random(),
                timestamp: new Date(event.created_at).toLocaleTimeString(),
                type: event.type.split('.')[0] || 'info',
                content: event.summary
            }));
        }

    } catch (error) {
        console.error('[Operator] Heartbeat snapshot error:', error);
    }
}

// ===========================================================================
// VTID-01019: OASIS ACK Binding - Pending Action Management
// ===========================================================================

/**
 * VTID-01019: Action states for UI discipline
 * ONLY these states are allowed in the UI.
 */
const OPERATOR_ACTION_STATE = {
    LOADING: 'loading',
    SUCCESS: 'success',
    FAILURE: 'failure'
};

/**
 * VTID-01019: Default timeout for pending actions (30 seconds)
 */
const PENDING_ACTION_TIMEOUT_MS = 30000;

/**
 * VTID-01019: Register a new pending operator action.
 * The UI will show Loading state until OASIS confirms completion or failure.
 * @param {Object} params - Action parameters
 * @param {string} params.id - Unique action ID (usually from API response)
 * @param {string} params.type - Action type: 'deploy', 'approval', 'chat'
 * @param {string} params.vtid - Associated VTID (required for correlation)
 * @param {string} params.description - Human-readable description for UI
 * @param {number} [params.timeoutMs] - Timeout in ms (default: 30000)
 * @returns {Object} The registered pending action
 */
function registerPendingAction(params) {
    const action = {
        id: params.id || 'action-' + Date.now(),
        type: params.type,
        vtid: params.vtid,
        description: params.description,
        startedAt: new Date().toISOString(),
        timeoutMs: params.timeoutMs || PENDING_ACTION_TIMEOUT_MS,
        state: OPERATOR_ACTION_STATE.LOADING
    };

    console.log('[VTID-01019] Registered pending action:', action);
    state.pendingOperatorActions.push(action);

    // Set up timeout handler
    setTimeout(() => {
        handlePendingActionTimeout(action.id);
    }, action.timeoutMs);

    return action;
}

/**
 * VTID-01019: Handle timeout for a pending action.
 * If action still pending after timeout, mark as failed.
 */
function handlePendingActionTimeout(actionId) {
    const actionIndex = state.pendingOperatorActions.findIndex(a => a.id === actionId);
    if (actionIndex === -1) {
        // Already resolved
        return;
    }

    const action = state.pendingOperatorActions[actionIndex];
    console.warn('[VTID-01019] Pending action TIMEOUT:', action);

    // Mark as failed due to timeout
    resolvePendingAction(actionId, false, {
        error: 'Backend timeout - no OASIS confirmation received',
        event_id: null
    });
}

/**
 * VTID-01019: Resolve a pending action with success or failure.
 * @param {string} actionId - The action ID to resolve
 * @param {boolean} success - Whether the action succeeded
 * @param {Object} [details] - Additional details for failure transparency
 * @param {string} [details.event_id] - OASIS event ID (if available)
 * @param {string} [details.error] - Error message (for failures)
 */
function resolvePendingAction(actionId, success, details = {}) {
    const actionIndex = state.pendingOperatorActions.findIndex(a => a.id === actionId);
    if (actionIndex === -1) {
        console.warn('[VTID-01019] Cannot resolve unknown action:', actionId);
        return;
    }

    const action = state.pendingOperatorActions[actionIndex];
    action.state = success ? OPERATOR_ACTION_STATE.SUCCESS : OPERATOR_ACTION_STATE.FAILURE;
    action.resolvedAt = new Date().toISOString();
    action.event_id = details.event_id || null;
    action.error = details.error || null;

    console.log('[VTID-01019] Resolved pending action:', action);

    // Remove from pending list
    state.pendingOperatorActions.splice(actionIndex, 1);

    // Show appropriate toast with failure transparency
    if (success) {
        showToast(action.description + ' completed', 'success');
    } else {
        // VTID-01019: Failure transparency - show event_id and reason
        let failureMsg = action.description + ' failed';
        if (details.error) {
            failureMsg += ': ' + details.error;
        }
        if (details.event_id) {
            failureMsg += ' [Event: ' + details.event_id + ']';
        }
        showToast(failureMsg, 'error');
    }

    // Add to ticker events for Live Feed consistency
    state.tickerEvents.unshift({
        id: details.event_id || Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        type: success ? 'success' : 'error',
        topic: 'operator.action.' + (success ? 'completed' : 'failed'),
        content: action.description + (success ? ' succeeded' : ' failed'),
        vtid: action.vtid,
        event_id: details.event_id || null
    });

    renderApp();
}

/**
 * VTID-01019: Find pending action by VTID.
 * Used by SSE handler to correlate OASIS events with pending actions.
 */
function findPendingActionByVtid(vtid) {
    return state.pendingOperatorActions.find(a => a.vtid === vtid);
}

/**
 * VTID-01019: Check if there's a pending action for a given VTID.
 */
function hasPendingActionForVtid(vtid) {
    return state.pendingOperatorActions.some(a => a.vtid === vtid);
}

/**
 * VTID-01019: Get the current state of a pending action.
 * Returns null if no pending action exists for the VTID.
 */
function getPendingActionState(vtid) {
    const action = findPendingActionByVtid(vtid);
    return action ? action.state : null;
}

/**
 * Start SSE stream for operator channel
 */
function startOperatorSse() {
    if (state.operatorSseSource) {
        console.log('[Operator] SSE already connected');
        return;
    }

    console.log('[Operator] Starting SSE stream...');
    const sseUrl = '/api/v1/events/stream?channel=operator';
    const eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
        console.log('[Operator] SSE connected');
    };

    eventSource.addEventListener('connected', (e) => {
        console.log('[Operator] SSE connection confirmed:', e.data);
    });

    eventSource.addEventListener('oasis-event', (e) => {
        try {
            const event = JSON.parse(e.data);
            console.log('[Operator] SSE event:', event);

            // DEV-COMHU-0202: Normalize event for ticker with deploy event support
            const vtid = event.vtid || (event.payload && event.payload.vtid) || null;
            const swv = event.swv || (event.payload && event.payload.swv) || null;
            const topic = event.topic || event.type || 'unknown';
            const service = event.service || (event.payload && event.payload.service) || null;
            const message = event.message || (event.payload && event.payload.message) || '';

            // ===========================================================
            // VTID-01019: OASIS ACK Binding - Check for action confirmations
            // UI success ONLY after OASIS confirmation, never optimistically
            // ===========================================================
            if (vtid && hasPendingActionForVtid(vtid)) {
                const pendingAction = findPendingActionByVtid(vtid);
                console.log('[VTID-01019] Checking event for pending action:', topic, vtid);

                // Define success/failure event patterns
                const successPatterns = [
                    'cicd.deploy.service.succeeded',
                    'cicd.deploy.service.accepted',
                    'deploy.gateway.success',
                    'cicd.github.safe_merge.executed',
                    'cicd.merge.success',
                    'vtid.lifecycle.completed',
                    'operator.action.completed'
                ];
                const failurePatterns = [
                    'cicd.deploy.service.failed',
                    'cicd.deploy.service.blocked',
                    'deploy.gateway.failed',
                    'cicd.merge.failed',
                    'governance.deploy.blocked',
                    'vtid.lifecycle.failed',
                    'operator.action.failed'
                ];

                const topicLower = topic.toLowerCase();
                const isSuccess = successPatterns.some(p => topicLower === p.toLowerCase() ||
                    topicLower.includes(p.toLowerCase()));
                const isFailure = failurePatterns.some(p => topicLower === p.toLowerCase() ||
                    topicLower.includes(p.toLowerCase()));

                if (isSuccess) {
                    console.log('[VTID-01019] OASIS confirmed SUCCESS for action:', pendingAction.id);
                    resolvePendingAction(pendingAction.id, true, {
                        event_id: event.id,
                        message: message
                    });
                } else if (isFailure) {
                    console.log('[VTID-01019] OASIS confirmed FAILURE for action:', pendingAction.id);
                    resolvePendingAction(pendingAction.id, false, {
                        event_id: event.id,
                        error: message || topic.replace(/\./g, ' ')
                    });
                }
                // Note: If neither success nor failure, action remains pending
                // until timeout or another event resolves it
            }

            // Build display content with deploy event info
            let displayContent = message || topic;
            if (topic.startsWith('deploy.') && service) {
                displayContent = topic.replace('deploy.', '').replace('.', ' ').toUpperCase();
                if (message) displayContent += ': ' + message;
            }

            // Add to ticker (VTID-0526-D: include task_stage, DEV-COMHU-0202: include vtid/swv/topic)
            state.tickerEvents.unshift({
                id: event.id || Date.now(),
                timestamp: new Date(event.created_at).toLocaleTimeString(),
                type: topic.split('.')[0] || 'info',
                topic: topic,
                content: displayContent,
                vtid: vtid,
                swv: swv,
                service: service,
                status: event.status,
                task_stage: event.task_stage || (event.payload && event.payload.task_stage) || null
            });

            // DEV-COMHU-0202: Also store in global events state for VTID correlation
            state.events = state.events || [];
            state.events.unshift({
                id: event.id,
                topic: topic,
                vtid: vtid,
                swv: swv,
                service: service,
                message: message,
                status: event.status,
                createdAt: event.created_at,
                raw: event
            });
            // Cap events at 200
            if (state.events.length > 200) {
                state.events = state.events.slice(0, 200);
            }

            // VTID-0526-D: Update stage counters on new event
            if (event.task_stage && state.stageCounters[event.task_stage] !== undefined) {
                state.stageCounters[event.task_stage]++;
            }

            // Keep only last 100 ticker events
            if (state.tickerEvents.length > 100) {
                state.tickerEvents = state.tickerEvents.slice(0, 100);
            }

            // VTID-0526-E: Skip render when chat tab is active to prevent flickering
            // Only render if on ticker tab (where events are displayed) or not in operator console
            var shouldRender = !state.isOperatorOpen || state.operatorActiveTab === 'ticker';
            if (shouldRender) {
                renderApp();
            }
        } catch (err) {
            console.error('[Operator] SSE event parse error:', err);
        }
    });

    eventSource.onerror = (err) => {
        console.error('[Operator] SSE error:', err);
    };

    state.operatorSseSource = eventSource;
}

/**
 * Stop SSE stream
 */
function stopOperatorSse() {
    if (state.operatorSseSource) {
        console.log('[Operator] Stopping SSE stream...');
        state.operatorSseSource.close();
        state.operatorSseSource = null;
    }
}

/**
 * VTID-0526-D: Telemetry auto-refresh interval ID
 */
let telemetryAutoRefreshInterval = null;

/**
 * VTID-0526-D: Fetch telemetry snapshot with stage counters.
 * VTID-0527: Also populates telemetryEvents for task stage timelines.
 * VTID-01002: Added silentRefresh parameter for polling - uses incremental updates instead of renderApp()
 * @param {boolean} silentRefresh - If true, skip renderApp() and use incremental update
 */
async function fetchTelemetrySnapshot(silentRefresh) {
    console.log('[VTID-0527] Fetching telemetry snapshot...', silentRefresh ? '(silent)' : '');
    state.stageCountersLoading = true;

    try {
        // VTID-0527: Increased limit to 100 for more comprehensive task stage tracking
        const response = await fetch('/api/v1/telemetry/snapshot?limit=100&hours=48');
        if (!response.ok) {
            throw new Error(`Telemetry snapshot fetch failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[VTID-0527] Telemetry snapshot loaded:', result);

        // Update stage counters
        if (result.counters) {
            state.stageCounters = {
                PLANNER: result.counters.PLANNER || 0,
                WORKER: result.counters.WORKER || 0,
                VALIDATOR: result.counters.VALIDATOR || 0,
                DEPLOY: result.counters.DEPLOY || 0
            };
        }

        // VTID-0527: Store raw events for task stage timeline computation
        if (result.events && result.events.length > 0) {
            state.telemetryEvents = result.events.map(function(event) {
                return {
                    id: event.id,
                    created_at: event.created_at,
                    vtid: event.vtid,
                    kind: event.kind,
                    status: event.status,
                    title: event.title,
                    task_stage: event.task_stage || null,
                    source: event.source,
                    layer: event.layer
                };
            });
        }

        // Optionally merge events into ticker if not already populated via SSE
        if (result.events && result.events.length > 0 && state.tickerEvents.length === 0) {
            state.tickerEvents = result.events.slice(0, 20).map(function(event) {
                return {
                    id: event.id || Date.now() + Math.random(),
                    timestamp: new Date(event.created_at).toLocaleTimeString(),
                    type: (event.kind || '').split('.')[0] || 'info',
                    content: event.title || 'Event',
                    task_stage: event.task_stage || null
                };
            });
        }

        state.telemetrySnapshotError = null;
        state.lastTelemetryRefresh = new Date().toISOString();

    } catch (error) {
        console.error('[VTID-0527] Telemetry snapshot error:', error);
        state.telemetrySnapshotError = error.message;
    } finally {
        state.stageCountersLoading = false;
        // VTID-01002: Use incremental update for polling, full render for initial load
        if (silentRefresh) {
            refreshActiveViewData();
        } else {
            renderApp();
        }
    }
}

/**
 * VTID-0526-D: Start auto-refresh for telemetry (during active execution).
 * Polls every 3 seconds while the operator console is open.
 * VTID-01002: Uses silentRefresh to avoid full DOM rebuild during polling
 */
function startTelemetryAutoRefresh() {
    if (telemetryAutoRefreshInterval) {
        console.log('[VTID-0526-D] Auto-refresh already active');
        return;
    }

    console.log('[VTID-0526-D] Starting telemetry auto-refresh (3s interval, scroll-safe)');

    telemetryAutoRefreshInterval = setInterval(function() {
        if (state.telemetryAutoRefreshEnabled && state.isOperatorOpen) {
            // VTID-01002: Use silentRefresh=true to preserve scroll positions
            fetchTelemetrySnapshot(true);
        }
    }, 3000);
}

/**
 * VTID-0526-D: Stop auto-refresh for telemetry.
 */
function stopTelemetryAutoRefresh() {
    if (telemetryAutoRefreshInterval) {
        clearInterval(telemetryAutoRefreshInterval);
        telemetryAutoRefreshInterval = null;
        console.log('[VTID-0526-D] Telemetry auto-refresh stopped');
    }
}

/**
 * VTID-0526-B: Start Live Ticker automatically when Operator Console opens.
 * VTID-0526-D: Also loads telemetry snapshot with stage counters.
 * This function starts the heartbeat session and SSE stream without requiring
 * the user to click the Heartbeat button first.
 */
async function startOperatorLiveTicker() {
    // Skip if already active
    if (state.operatorHeartbeatActive) {
        console.log('[Operator] Live ticker already active');
        return;
    }

    console.log('[Operator] Auto-starting live ticker...');

    try {
        // Start heartbeat session
        const response = await fetch('/api/v1/operator/heartbeat/session', {
            method: 'POST',
            headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ status: 'live' })
        });

        if (!response.ok) {
            console.warn('[Operator] Failed to start heartbeat session:', response.status);
            // Don't throw - continue to try loading events anyway
        } else {
            const result = await response.json();
            console.log('[Operator] Heartbeat session started:', result);
            state.operatorHeartbeatActive = true;
        }

        // VTID-0526-D: Fetch telemetry snapshot with stage counters (parallel with heartbeat)
        fetchTelemetrySnapshot();

        // Fetch initial heartbeat snapshot (events history)
        await fetchHeartbeatSnapshot();

        // Start SSE stream for live events
        startOperatorSse();

        // VTID-0526-D: Start auto-refresh for stage counters during active execution
        startTelemetryAutoRefresh();

        // VTID-01209: Start active executions polling for ticker display
        startActiveExecutionsPolling();

        renderApp();

    } catch (error) {
        console.error('[Operator] Failed to auto-start live ticker:', error);
        // Don't alert - this is a background auto-start, not a user action
    }
}

/**
 * Fetch operator history from API
 */
async function fetchOperatorHistory() {
    console.log('[Operator] Fetching history...');
    state.historyLoading = true;
    state.historyError = null;
    renderApp();

    try {
        const response = await fetch('/api/v1/operator/history?limit=50');
        if (!response.ok) {
            throw new Error(`History fetch failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Operator] History loaded:', result);

        state.historyEvents = result.data || [];
        state.historyError = null;

    } catch (error) {
        console.error('[Operator] History error:', error);
        state.historyError = error.message;
    } finally {
        state.historyLoading = false;
        renderApp();
    }
}

/**
 * Upload file for operator chat
 */
async function uploadOperatorFile(file, kind) {
    console.log('[Operator] Uploading file:', file.name, kind);

    try {
        const response = await fetch('/api/v1/operator/upload', {
            method: 'POST',
            headers: withVitanaContextHeaders({ 'Content-Type': 'application/json' }),
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

// --- VTID-0520: CI/CD Health Indicator ---

let cicdHealthPollInterval = null;

/**
 * Fetches CI/CD health status from the backend API.
 * Updates state.cicdHealth with the response.
 * VTID-01002: Added silentRefresh parameter for polling - skips renderApp() if true
 * @param {boolean} silentRefresh - If true, skip renderApp() (CI/CD health updates header only)
 */
async function fetchCicdHealth(silentRefresh) {
    console.log('[CICD] Fetching health status...', silentRefresh ? '(silent)' : '');
    state.cicdHealthLoading = true;

    try {
        const response = await fetch('/api/v1/cicd/health');
        if (!response.ok) {
            throw new Error(`CICD health fetch failed: ${response.status}`);
        }

        const data = await response.json();
        console.log('[CICD] Health status:', data);

        state.cicdHealth = data;
        state.cicdHealthError = null;

    } catch (error) {
        console.error('[CICD] Health fetch error:', error);
        state.cicdHealthError = error.message;
        state.cicdHealth = null;
    } finally {
        state.cicdHealthLoading = false;
        // VTID-01002: For CI/CD health, update header indicator incrementally if possible
        if (silentRefresh) {
            updateCicdHealthIndicator();
        } else {
            renderApp();
        }
    }
}

/**
 * VTID-01002: Updates CI/CD health indicator in header incrementally without full render.
 */
function updateCicdHealthIndicator() {
    var indicator = document.querySelector('.cicd-health-indicator');
    if (!indicator) return;

    var health = state.cicdHealth;
    if (!health) return;

    // Update indicator class based on health status
    indicator.className = 'cicd-health-indicator';
    if (health.ok) {
        indicator.classList.add('healthy');
    } else {
        indicator.classList.add('degraded');
    }
}

/**
 * Starts polling for CI/CD health every 10 seconds.
 * VTID-01002: Uses silentRefresh to avoid full DOM rebuild during polling
 */
function startCicdHealthPolling() {
    // Fetch immediately on start (full render for initial state)
    fetchCicdHealth();

    // Clear any existing interval
    if (cicdHealthPollInterval) {
        clearInterval(cicdHealthPollInterval);
    }

    // Poll every 10 seconds with silent refresh
    cicdHealthPollInterval = setInterval(() => {
        // VTID-01002: Use silentRefresh=true to preserve scroll positions
        fetchCicdHealth(true);
    }, 10000);

    console.log('[CICD] Health polling started (10s interval, scroll-safe)');
}

/**
 * Stops CI/CD health polling.
 */
function stopCicdHealthPolling() {
    if (cicdHealthPollInterval) {
        clearInterval(cicdHealthPollInterval);
        cicdHealthPollInterval = null;
        console.log('[CICD] Health polling stopped');
    }
}

/**
 * Formats the CI/CD health data for tooltip display.
 * @param {Object} healthData - The health response object
 * @returns {string} Formatted tooltip text
 */
function formatCicdHealthTooltip(healthData) {
    if (!healthData) return 'CI/CD: Loading...';

    const statusText = healthData.ok ? 'Healthy' : 'Issues Detected';
    let tooltip = `CI/CD: ${statusText}\nStatus: ${healthData.status || 'unknown'}`;

    if (healthData.capabilities) {
        tooltip += '\n\nCapabilities:';
        for (const [key, value] of Object.entries(healthData.capabilities)) {
            const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            tooltip += `\n  ${label}: ${value ? 'Yes' : 'No'}`;
        }
    }

    return tooltip;
}

// ==========================================================================
// VTID-0150-A: ORB UI & Interaction Shell (Global Assistant Overlay)
// ==========================================================================

/**
 * VTID-0150-A: SVG Icon definitions for ORB controls (CSP-compliant)
 */
const ORB_ICONS = {
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707"/><circle cx="12" cy="12" r="4"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    cameraOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06a4 4 0 1 1-5.56-5.56"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    // VTID-01038: Speaker icon for TTS voice preview
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    // VTID-01067: Badge icons for ORB presence layer
    badgeMic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>',
    badgeMicOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/></svg>',
    badgeScreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    badgeCamera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    badgeLang: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    // VTID-01069-C: Plus icon for attachment button
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    // VTID-01069-F: Screen off icon (crossed out)
    screenOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 15V5a2 2 0 0 0-2-2H5"/><path d="M3 7v10a2 2 0 0 0 2 2h14"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
};

// VTID-0150-A: ORB Idle is now rendered via renderOrbIdleElement() inside sidebar footer

/**
 * VTID-01069: Computes the height bucket class based on line count
 * Uses discrete buckets instead of inline styles (CSP-compliant)
 * @param {number} lineCount - Approximate number of lines
 * @returns {string} - Height bucket class (input-h1 through input-h5)
 */
function getInputHeightBucket(lineCount) {
    if (lineCount <= 2) return 'input-h1';
    if (lineCount <= 5) return 'input-h2';
    if (lineCount <= 9) return 'input-h3';
    if (lineCount <= 14) return 'input-h4';
    return 'input-h5'; // 15+ lines (MAX)
}

/**
 * VTID-01069: Updates the textarea height bucket based on content
 * Must be bound to textarea input event
 * @param {HTMLTextAreaElement} textarea - The textarea element
 * @param {HTMLElement} wrapper - The wrapper element to apply bucket class to
 */
function updateInputHeightBucket(textarea, wrapper) {
    if (!textarea || !wrapper) return;

    var value = textarea.value || '';

    // Count explicit newlines
    var explicitLines = value.split('\n').length;

    // Approximate wrapped lines based on average chars per line
    // Assume ~50 chars per line for the textarea width
    var charsPerLine = 50;
    var lines = value.split('\n');
    var wrappedLineCount = 0;

    lines.forEach(function(line) {
        wrappedLineCount += Math.max(1, Math.ceil(line.length / charsPerLine));
    });

    var totalLines = Math.max(explicitLines, wrappedLineCount);
    var bucket = getInputHeightBucket(totalLines);

    // Remove old bucket classes
    wrapper.classList.remove('input-h1', 'input-h2', 'input-h3', 'input-h4', 'input-h5');

    // Add new bucket class
    wrapper.classList.add(bucket);
}

/**
 * VTID-01069: Resets textarea height bucket to minimum
 * Called after sending a message
 * @param {HTMLElement} wrapper - The wrapper element with bucket class
 */
function resetInputHeightBucket(wrapper) {
    if (!wrapper) return;
    wrapper.classList.remove('input-h1', 'input-h2', 'input-h3', 'input-h4', 'input-h5');
    wrapper.classList.add('input-h1');
}

/**
 * VTID-01069: Sends message from ORB overlay input
 * Clears input and resets height bucket
 */
function orbOverlaySendMessage() {
    var message = state.orb.chatInputValue;
    if (!message || !message.trim()) return;

    // VTID-01069-F: Add user message to liveTranscript (overlay uses this, not chatMessages)
    state.orb.liveTranscript.push({
        id: Date.now(),
        role: 'user',
        text: message.trim(),
        timestamp: new Date().toISOString()
    });

    // Clear input value
    state.orb.chatInputValue = '';

    // Render immediately to show user message
    renderApp();
    scrollOrbLiveTranscript();

    // Reset height bucket
    var wrapper = document.querySelector('.orb-textarea-wrap');
    if (wrapper) {
        resetInputHeightBucket(wrapper);
    }

    // Keep focus on textarea
    var textarea = document.querySelector('.orb-textarea');
    if (textarea) {
        textarea.focus();
    }

    // VTID-01069-F: Use orbVoiceSendText for backend call + TTS response
    orbVoiceSendText(message.trim());
}

/**
 * VTID-0150-A: Renders the ORB Overlay (full-screen mode)
 * VTID-0135: Updated with voice conversation (Web Speech APIs) and state pill
 * VTID-01069: Two-column layout with auto-growing chatbox and symmetric spacing
 * VTID-01069-C: Geometry Lock - 40/60 split, ORB 62vh, input centered
 * VTID-01069-D: Corrective patch - conversation stream, ORB 50vh, camera/screen actions
 * @returns {HTMLElement}
 */
function renderOrbOverlay() {
    var overlay = document.createElement('div');
    var overlayClasses = ['orb-overlay', 'orb-overlay-twocol'];
    if (state.orb.overlayVisible) overlayClasses.push('orb-overlay-visible');
    if (state.orb.voiceState === 'SPEAKING' || state.orb.speaking) overlayClasses.push('orb-speaking');
    overlay.className = overlayClasses.join(' ');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Vitana Assistant');

    // VTID-01069-C: Two-column layout wrapper
    var layoutWrapper = document.createElement('div');
    layoutWrapper.className = 'orb-overlay-layout';

    // ==========================================================================
    // VTID-01069-D: LEFT COLUMN (40vw) - Conversation Stream + Input (docked bottom)
    // VTID-01069-F: Chat stage wrapper for centering
    // ==========================================================================
    var leftColumn = document.createElement('div');
    leftColumn.className = 'orb-left';

    // VTID-01069-F: Chat stage wrapper - centers content with max-width
    var chatStage = document.createElement('div');
    chatStage.className = 'orb-chat-stage';

    // VTID-01069-D: Conversation stream - renders liveTranscript messages
    var chatStream = document.createElement('div');
    chatStream.className = 'orb-chat-stream';
    chatStream.id = 'orb-chat-stream';

    if (state.orb.liveTranscript.length === 0) {
        // Empty state
        var emptyState = document.createElement('div');
        emptyState.className = 'orb-chat-stream-empty';
        var emptyText = document.createElement('p');
        emptyText.className = 'orb-chat-stream-empty-text';
        emptyText.textContent = 'Start a conversation';
        emptyState.appendChild(emptyText);
        chatStream.appendChild(emptyState);
    } else {
        // Render messages from liveTranscript
        state.orb.liveTranscript.forEach(function(msg) {
            var msgEl = document.createElement('div');
            var msgClasses = ['orb-stream-msg', 'orb-stream-msg-' + msg.role];
            if (msg.isThinking) {
                msgClasses.push('orb-stream-msg-thinking');
            }
            if (state.orb.speakingMessageId === msg.id) {
                msgClasses.push('orb-stream-msg-speaking');
            }
            msgEl.className = msgClasses.join(' ');

            var bubble = document.createElement('div');
            bubble.className = 'orb-stream-bubble';
            bubble.textContent = msg.text || msg.content || '';
            msgEl.appendChild(bubble);

            if (msg.timestamp) {
                var time = document.createElement('span');
                time.className = 'orb-stream-time';
                time.textContent = formatOrbChatTime(msg.timestamp);
                msgEl.appendChild(time);
            }

            chatStream.appendChild(msgEl);
        });
    }

    // VTID-01069-F: Show interim speech recognition results (word-by-word typing effect)
    if (state.orb.interimTranscript) {
        var interimEl = document.createElement('div');
        interimEl.className = 'orb-stream-msg orb-stream-msg-user orb-stream-msg-interim';
        var interimBubble = document.createElement('div');
        interimBubble.className = 'orb-stream-bubble';
        interimBubble.textContent = state.orb.interimTranscript;
        interimEl.appendChild(interimBubble);
        chatStream.appendChild(interimEl);
    }

    // Input zone wrapper
    var inputZoneWrap = document.createElement('div');
    inputZoneWrap.className = 'orb-inputzone-wrap';

    // Input bar: [ + ] [ mic ] [ screen ] [ camera ] [ text area ] [ language ▼ ] [ send ]
    var inputBar = document.createElement('div');
    inputBar.className = 'orb-inputbar';

    // Control rail
    var inputControls = document.createElement('div');
    inputControls.className = 'orb-input-controls';

    // VTID-01069-C: Attachment button (+)
    var attachBtn = document.createElement('button');
    attachBtn.className = 'orb-input-control-btn';
    attachBtn.setAttribute('aria-label', 'Attach file');
    attachBtn.innerHTML = ORB_ICONS.plus;
    attachBtn.addEventListener('click', function() {
        // Create hidden file input and trigger click
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*,.pdf,.doc,.docx,.txt';
        fileInput.addEventListener('change', function(e) {
            if (e.target.files && e.target.files.length > 0) {
                console.log('[ORB] File selected:', e.target.files[0].name);
                // TODO: Handle file upload
            }
        });
        fileInput.click();
    });
    inputControls.appendChild(attachBtn);

    // Mic toggle
    var isMuted = state.orb.voiceState === 'MUTED';
    var micBtn = document.createElement('button');
    micBtn.className = 'orb-input-control-btn' + (!isMuted ? ' orb-input-control-active' : '');
    micBtn.setAttribute('aria-label', isMuted ? 'Unmute microphone' : 'Mute microphone');
    micBtn.innerHTML = isMuted ? ORB_ICONS.micOff : ORB_ICONS.mic;
    micBtn.addEventListener('click', function() {
        orbVoiceToggleMute();
    });
    inputControls.appendChild(micBtn);

    // VTID-01069-D: Screen share toggle - opens OS screen picker
    var screenBtn = document.createElement('button');
    screenBtn.className = 'orb-input-control-btn' + (state.orb.screenShareActive ? ' orb-input-control-active' : '');
    screenBtn.setAttribute('aria-label', state.orb.screenShareActive ? 'Stop screen share' : 'Start screen share');
    // VTID-01069-F: Use crossed icon when inactive
    screenBtn.innerHTML = state.orb.screenShareActive ? ORB_ICONS.screen : ORB_ICONS.screenOff;
    screenBtn.addEventListener('click', function() {
        orbToggleScreenShare();
    });
    inputControls.appendChild(screenBtn);

    // VTID-01069-D: Camera toggle - opens device camera
    var cameraBtn = document.createElement('button');
    cameraBtn.className = 'orb-input-control-btn' + (state.orb.cameraActive ? ' orb-input-control-active' : '');
    cameraBtn.setAttribute('aria-label', state.orb.cameraActive ? 'Turn off camera' : 'Turn on camera');
    cameraBtn.innerHTML = state.orb.cameraActive ? ORB_ICONS.camera : ORB_ICONS.cameraOff;
    cameraBtn.addEventListener('click', function() {
        orbToggleCamera();
    });
    inputControls.appendChild(cameraBtn);

    inputBar.appendChild(inputControls);

    // Textarea wrapper (for height bucket class)
    var textareaWrap = document.createElement('div');
    textareaWrap.className = 'orb-textarea-wrap input-h1';

    // Auto-growing textarea
    var textarea = document.createElement('textarea');
    textarea.className = 'orb-textarea';
    textarea.placeholder = 'Type or speak...';
    textarea.value = state.orb.chatInputValue;
    textarea.setAttribute('rows', '1');

    textarea.addEventListener('input', function(e) {
        state.orb.chatInputValue = e.target.value;
        updateInputHeightBucket(e.target, textareaWrap);
    });

    textarea.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            orbOverlaySendMessage();
        }
    });

    textareaWrap.appendChild(textarea);
    inputBar.appendChild(textareaWrap);

    // VTID-01069-C: Inline language dropdown
    var langDropdown = document.createElement('select');
    langDropdown.className = 'orb-input-lang';
    langDropdown.setAttribute('aria-label', 'Select language');

    // VTID-01155: Updated to 8 languages (added SR, RU)
    var availableLanguages = [
        { code: 'en-US', label: 'EN' },
        { code: 'de-DE', label: 'DE' },
        { code: 'fr-FR', label: 'FR' },
        { code: 'es-ES', label: 'ES' },
        { code: 'ar-AE', label: 'AR' },
        { code: 'zh-CN', label: 'ZH' },
        { code: 'sr-RS', label: 'SR' },
        { code: 'ru-RU', label: 'RU' }
    ];

    availableLanguages.forEach(function(lang) {
        var option = document.createElement('option');
        option.value = lang.code;
        option.textContent = lang.label;
        if (lang.code === state.orb.orbLang) {
            option.selected = true;
        }
        langDropdown.appendChild(option);
    });

    langDropdown.addEventListener('change', function(e) {
        orbSetLanguage(e.target.value);
    });
    inputBar.appendChild(langDropdown);

    // Send button
    var sendBtn = document.createElement('button');
    var hasText = state.orb.chatInputValue && state.orb.chatInputValue.trim();
    // VTID-01069-F: Add active class when text is entered
    sendBtn.className = 'orb-input-send' + (hasText ? ' orb-input-send-active' : '');
    sendBtn.innerHTML = ORB_ICONS.send;
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.disabled = !hasText;
    sendBtn.addEventListener('click', function() {
        orbOverlaySendMessage();
    });
    inputBar.appendChild(sendBtn);

    inputZoneWrap.appendChild(inputBar);
    chatStage.appendChild(chatStream);
    chatStage.appendChild(inputZoneWrap);

    // VTID-01069-F: Bottom safe spacer (120px desktop, 80px mobile)
    var bottomSafe = document.createElement('div');
    bottomSafe.className = 'orb-bottom-safe';
    chatStage.appendChild(bottomSafe);

    leftColumn.appendChild(chatStage);

    layoutWrapper.appendChild(leftColumn);

    // ==========================================================================
    // VTID-01069-D: RIGHT COLUMN (60vw) - ORB Only (centered, 50vh diameter)
    // ==========================================================================
    var rightColumn = document.createElement('div');
    rightColumn.className = 'orb-right';

    // ORB Shell wrapper (contains orb + aura only)
    var orbShell = document.createElement('div');
    var auraState = 'ready';
    if (state.orb.voiceError || state.orb.liveError) {
        auraState = 'error';
    } else if (state.orb.voiceState === 'THINKING' || state.orb.isThinking) {
        auraState = 'thinking';
    } else if (state.orb.voiceState === 'SPEAKING') {
        auraState = 'speaking';
    } else if (state.orb.voiceState === 'LISTENING') {
        auraState = 'listening';
    } else if (state.orb.voiceState === 'MUTED') {
        auraState = 'paused';
    } else if (state.orb.voiceState === 'IDLE') {
        auraState = 'connecting';
    }
    orbShell.className = 'orb-shell orb--' + auraState;

    // Large ORB
    var largeOrb = document.createElement('div');
    var orbClass = 'orb-large';
    if (state.orb.voiceState === 'THINKING' || state.orb.isThinking) {
        orbClass += ' orb-large-thinking';
    } else if (state.orb.voiceState === 'SPEAKING') {
        orbClass += ' orb-large-speaking';
    } else if (state.orb.voiceState === 'LISTENING') {
        orbClass += ' orb-large-listening';
    } else if (state.orb.voiceState === 'MUTED') {
        orbClass += ' orb-large-muted';
    } else {
        orbClass += ' orb-large-idle';
    }
    largeOrb.className = orbClass;
    orbShell.appendChild(largeOrb);

    rightColumn.appendChild(orbShell);
    layoutWrapper.appendChild(rightColumn);
    overlay.appendChild(layoutWrapper);

    // ==========================================================================
    // VTID-01069-C: Close button - 64px, bottom center, 24px offset
    // ==========================================================================
    var closeBtn = document.createElement('button');
    closeBtn.className = 'orb-close-btn';
    closeBtn.innerHTML = ORB_ICONS.close;
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        orbVoiceStop();
        state.orb.overlayVisible = false;
        state.orb.chatDrawerOpen = false;
        renderApp();
    });
    overlay.appendChild(closeBtn);

    // VTID-01069-F: Auto-scroll to newest messages after render
    setTimeout(function() {
        var stream = document.querySelector('.orb-chat-stream');
        if (stream) {
            stream.scrollTop = stream.scrollHeight;
        }
    }, 50);

    return overlay;
}

/**
 * VTID-0150-A: Formats timestamp for chat messages
 */
function formatOrbChatTime(isoString) {
    var date = new Date(isoString);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/**
 * VTID-0150-A: Renders the ORB Chat Drawer (right-side panel)
 * @returns {HTMLElement}
 */
function renderOrbChatDrawer() {
    var drawer = document.createElement('div');
    drawer.className = 'orb-chat-drawer' + (state.orb.chatDrawerOpen ? ' orb-chat-drawer-open' : '');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', 'Vitana Chat');

    // Header
    var header = document.createElement('div');
    header.className = 'orb-chat-header';

    var titleBlock = document.createElement('div');
    titleBlock.className = 'orb-chat-title';

    var titleOrb = document.createElement('div');
    titleOrb.className = 'orb-chat-title-orb';
    titleBlock.appendChild(titleOrb);

    var titleText = document.createElement('h2');
    titleText.className = 'orb-chat-title-text';
    titleText.textContent = 'Vitana Assistant';
    titleBlock.appendChild(titleText);

    header.appendChild(titleBlock);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'orb-chat-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Close chat');
    closeBtn.addEventListener('click', function() {
        console.log('[ORB] Closing chat drawer...');
        state.orb.chatDrawerOpen = false;
        renderApp();
    });
    header.appendChild(closeBtn);

    drawer.appendChild(header);

    // Suggestion chips placeholder
    var chipsArea = document.createElement('div');
    chipsArea.className = 'orb-suggestion-chips';
    var suggestions = ['Show my tasks', 'System status', 'Help me deploy', 'Run tests'];
    suggestions.forEach(function(suggestion) {
        var chip = document.createElement('button');
        chip.className = 'orb-suggestion-chip';
        chip.textContent = suggestion;
        chip.addEventListener('click', function() {
            // Add as user message and echo response
            orbSendMessage(suggestion);
        });
        chipsArea.appendChild(chip);
    });
    drawer.appendChild(chipsArea);

    // Messages area
    var messagesArea = document.createElement('div');
    messagesArea.className = 'orb-chat-messages';

    if (state.orb.chatMessages.length === 0) {
        // Empty state
        var emptyState = document.createElement('div');
        emptyState.className = 'orb-chat-empty';

        var emptyOrb = document.createElement('div');
        emptyOrb.className = 'orb-chat-empty-orb';
        emptyState.appendChild(emptyOrb);

        var emptyText = document.createElement('p');
        emptyText.className = 'orb-chat-empty-text';
        emptyText.textContent = 'Start a conversation';
        emptyState.appendChild(emptyText);

        var emptyHint = document.createElement('p');
        emptyHint.className = 'orb-chat-empty-hint';
        emptyHint.textContent = 'Type a message or click a suggestion above';
        emptyState.appendChild(emptyHint);

        messagesArea.appendChild(emptyState);
    } else {
        // Render messages
        state.orb.chatMessages.forEach(function(msg) {
            var msgEl = document.createElement('div');
            msgEl.className = 'orb-chat-message orb-chat-message-' + msg.role;

            var bubble = document.createElement('div');
            bubble.className = 'orb-chat-bubble';
            bubble.textContent = msg.content;
            msgEl.appendChild(bubble);

            var time = document.createElement('span');
            time.className = 'orb-chat-message-time';
            time.textContent = formatOrbChatTime(msg.timestamp);
            msgEl.appendChild(time);

            messagesArea.appendChild(msgEl);
        });
    }

    drawer.appendChild(messagesArea);

    // Input area
    var inputContainer = document.createElement('div');
    inputContainer.className = 'orb-chat-input-container';

    var input = document.createElement('textarea');
    input.className = 'orb-chat-input';
    input.placeholder = 'Type a message...';
    input.value = state.orb.chatInputValue;
    input.setAttribute('rows', '1');
    input.addEventListener('input', function(e) {
        state.orb.chatInputValue = e.target.value;
        // Auto-resize
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            orbSendMessage(state.orb.chatInputValue);
        }
    });
    inputContainer.appendChild(input);

    var sendBtn = document.createElement('button');
    sendBtn.className = 'orb-chat-send';
    sendBtn.innerHTML = ORB_ICONS.send;
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.disabled = !state.orb.chatInputValue.trim();
    sendBtn.addEventListener('click', function() {
        orbSendMessage(state.orb.chatInputValue);
    });
    inputContainer.appendChild(sendBtn);

    drawer.appendChild(inputContainer);

    return drawer;
}

// ==========================================================================
// DEV-COMHU-2025-0014: ORB Live Voice Session Functions
// ==========================================================================

/**
 * DEV-COMHU-2025-0014: Start the ORB live voice session
 * Opens mic, connects SSE, starts audio streaming
 */
async function orbLiveStart() {
    console.log('[ORB-LIVE] Starting live voice session...');

    // Reset error state
    state.orb.liveError = null;

    try {
        // 1. Start the backend session
        var startRes = await fetch('/api/v1/orb/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'start',
                tenant: 'Vitana-Dev',
                role: 'DEV',
                route: window.location.pathname,
                selectedId: '',
                response: { modalities: ['TEXT'] }
            })
        });

        var startData = await startRes.json();
        if (!startData.ok) {
            throw new Error(startData.error || 'Failed to start session');
        }

        state.orb.liveSessionId = startData.sessionId;
        console.log('[ORB-LIVE] Session created:', startData.sessionId);

        // 2. Connect to SSE stream
        var sseUrl = '/api/v1/orb/live?sessionId=' + encodeURIComponent(startData.sessionId);
        var eventSource = new EventSource(sseUrl);

        eventSource.onopen = function() {
            console.log('[ORB-LIVE] SSE connected');
            state.orb.liveConnected = true;
            renderApp();
        };

        eventSource.onmessage = function(event) {
            try {
                var msg = JSON.parse(event.data);
                console.log('[ORB-LIVE] SSE message:', msg.type);

                if (msg.type === 'ready') {
                    console.log('[ORB-LIVE] Session ready, model:', msg.meta?.model);
                } else if (msg.type === 'assistant_text') {
                    // VTID-01037: Track scroll position before adding message
                    updateTranscriptNearBottom();
                    // Add to transcript
                    state.orb.liveTranscript.push({
                        id: Date.now(),
                        role: 'assistant',
                        text: msg.text,
                        timestamp: new Date().toISOString()
                    });
                    state.orb.isThinking = false;
                    renderApp();
                    scrollOrbLiveTranscript();
                } else if (msg.type === 'error') {
                    console.error('[ORB-LIVE] Error:', msg.message);
                    state.orb.liveError = msg.message;
                    state.orb.isThinking = false;
                    renderApp();
                } else if (msg.type === 'session_ended') {
                    console.log('[ORB-LIVE] Session ended by server');
                    orbLiveCleanup();
                }
            } catch (e) {
                console.error('[ORB-LIVE] Failed to parse SSE message:', e);
            }
        };

        eventSource.onerror = function(e) {
            console.error('[ORB-LIVE] SSE error:', e);
            state.orb.liveConnected = false;
            state.orb.liveError = 'Connection lost';
            renderApp();
        };

        state.orb.liveEventSource = eventSource;

        // 3. Request microphone access
        var stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 16000
            }
        });

        state.orb.liveAudioStream = stream;
        state.orb.micActive = true;

        // 4. Setup audio processing (PCM16, 16kHz, mono)
        var audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        state.orb.liveAudioContext = audioContext;

        var source = audioContext.createMediaStreamSource(stream);
        var processor = audioContext.createScriptProcessor(640, 1, 1); // 640 samples = 40ms at 16kHz

        // Energy threshold for VAD (silence gating)
        var energyThreshold = 0.005;
        var silenceFrames = 0;
        var maxSilenceFrames = 25; // ~1 second of silence
        var isSpeaking = false;
        var audioBuffer = [];

        processor.onaudioprocess = function(e) {
            if (state.orb.liveMuted || !state.orb.liveSessionId) return;

            var inputData = e.inputBuffer.getChannelData(0);

            // Calculate energy for VAD
            var energy = 0;
            for (var i = 0; i < inputData.length; i++) {
                energy += inputData[i] * inputData[i];
            }
            energy = energy / inputData.length;

            // Voice Activity Detection
            if (energy > energyThreshold) {
                silenceFrames = 0;
                if (!isSpeaking) {
                    isSpeaking = true;
                    console.log('[ORB-LIVE] Speech detected');
                }
            } else {
                silenceFrames++;
            }

            // Only send audio when speaking (silence gating)
            if (isSpeaking) {
                // Convert Float32 to PCM16
                var pcm16 = new Int16Array(inputData.length);
                for (var j = 0; j < inputData.length; j++) {
                    var s = Math.max(-1, Math.min(1, inputData[j]));
                    pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // Accumulate audio buffer
                audioBuffer.push(pcm16);

                // Send when we have enough data (320 samples = 20ms chunks)
                if (audioBuffer.length >= 8) { // ~160ms of audio
                    var totalLength = audioBuffer.reduce(function(sum, arr) { return sum + arr.length; }, 0);
                    var combined = new Int16Array(totalLength);
                    var offset = 0;
                    for (var k = 0; k < audioBuffer.length; k++) {
                        combined.set(audioBuffer[k], offset);
                        offset += audioBuffer[k].length;
                    }

                    // Convert to base64
                    var uint8 = new Uint8Array(combined.buffer);
                    var binary = '';
                    for (var l = 0; l < uint8.length; l++) {
                        binary += String.fromCharCode(uint8[l]);
                    }
                    var base64 = btoa(binary);

                    // Send audio chunk
                    orbLiveSendAudio(base64);

                    audioBuffer = [];
                }

                // End of speech detection
                if (silenceFrames > maxSilenceFrames) {
                    isSpeaking = false;
                    console.log('[ORB-LIVE] Speech ended');

                    // Send any remaining audio
                    if (audioBuffer.length > 0) {
                        var remainingLength = audioBuffer.reduce(function(sum, arr) { return sum + arr.length; }, 0);
                        var remainingCombined = new Int16Array(remainingLength);
                        var remainingOffset = 0;
                        for (var m = 0; m < audioBuffer.length; m++) {
                            remainingCombined.set(audioBuffer[m], remainingOffset);
                            remainingOffset += audioBuffer[m].length;
                        }

                        var remainingUint8 = new Uint8Array(remainingCombined.buffer);
                        var remainingBinary = '';
                        for (var n = 0; n < remainingUint8.length; n++) {
                            remainingBinary += String.fromCharCode(remainingUint8[n]);
                        }
                        var remainingBase64 = btoa(remainingBinary);
                        orbLiveSendAudio(remainingBase64);
                        audioBuffer = [];
                    }
                }
            }
        };

        source.connect(processor);
        processor.connect(audioContext.destination);
        state.orb.liveAudioProcessor = processor;

        console.log('[ORB-LIVE] Audio capture started');
        renderApp();

    } catch (error) {
        console.error('[ORB-LIVE] Failed to start:', error);
        state.orb.liveError = error.message || 'Failed to start voice session';
        state.orb.micActive = false;
        renderApp();
    }
}

/**
 * DEV-COMHU-2025-0014: Send audio chunk to backend
 */
function orbLiveSendAudio(base64Data) {
    if (!state.orb.liveSessionId || state.orb.liveMuted) return;

    state.orb.isThinking = true;
    renderApp();

    fetch('/api/v1/orb/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'audio_chunk',
            sessionId: state.orb.liveSessionId,
            mime: 'audio/pcm;rate=16000',
            data_b64: base64Data
        })
    }).then(function(res) {
        return res.json();
    }).then(function(data) {
        if (!data.ok) {
            console.warn('[ORB-LIVE] Audio processing warning:', data.error);
        }
    }).catch(function(error) {
        console.error('[ORB-LIVE] Failed to send audio:', error);
    });
}

/**
 * DEV-COMHU-2025-0014: Toggle mute state
 */
function orbLiveToggleMute() {
    state.orb.liveMuted = !state.orb.liveMuted;
    state.orb.micActive = !state.orb.liveMuted;

    console.log('[ORB-LIVE] Mute toggled:', state.orb.liveMuted);

    // Notify backend
    if (state.orb.liveSessionId) {
        fetch('/api/v1/orb/mute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'mute',
                sessionId: state.orb.liveSessionId,
                muted: state.orb.liveMuted
            })
        }).catch(function(e) {
            console.error('[ORB-LIVE] Failed to sync mute state:', e);
        });
    }

    renderApp();
}

/**
 * DEV-COMHU-2025-0014: Stop the live voice session
 */
function orbLiveStop() {
    console.log('[ORB-LIVE] Stopping live voice session...');

    // Notify backend
    if (state.orb.liveSessionId) {
        fetch('/api/v1/orb/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'stop',
                sessionId: state.orb.liveSessionId
            })
        }).catch(function(e) {
            console.error('[ORB-LIVE] Failed to notify stop:', e);
        });
    }

    orbLiveCleanup();
}

/**
 * DEV-COMHU-2025-0014: Cleanup live session resources
 */
function orbLiveCleanup() {
    // Close SSE connection
    if (state.orb.liveEventSource) {
        state.orb.liveEventSource.close();
        state.orb.liveEventSource = null;
    }

    // Stop audio stream
    if (state.orb.liveAudioStream) {
        state.orb.liveAudioStream.getTracks().forEach(function(track) {
            track.stop();
        });
        state.orb.liveAudioStream = null;
    }

    // Close audio context
    if (state.orb.liveAudioContext) {
        state.orb.liveAudioContext.close().catch(function() {});
        state.orb.liveAudioContext = null;
    }

    state.orb.liveAudioProcessor = null;
    state.orb.liveSessionId = null;
    state.orb.liveConnected = false;
    state.orb.micActive = false;
    state.orb.liveMuted = false;

    console.log('[ORB-LIVE] Cleanup complete');
}

/**
 * DEV-COMHU-2025-0014: Scroll live transcript to bottom
 * VTID-01037: Smart scroll - only auto-scroll if user was near bottom
 * VTID-01069-D: Updated to also handle orb-chat-stream
 */
function scrollOrbLiveTranscript() {
    // Try both selectors - legacy and new VTID-01069-D stream
    var container = document.querySelector('.orb-live-transcript') || document.querySelector('.orb-chat-stream');
    if (!container) return;

    // VTID-01069-F: Always scroll to bottom for new messages
    // Use smooth scroll for better UX
    container.scrollTop = container.scrollHeight;
}

/**
 * VTID-01037: Check and update near-bottom tracking for transcript
 * VTID-01064: Fixed to handle initial scroll state correctly
 * VTID-01069-D: Updated to also handle orb-chat-stream
 * Call this before operations that might trigger scroll
 */
function updateTranscriptNearBottom() {
    var container = document.querySelector('.orb-live-transcript') || document.querySelector('.orb-chat-stream');
    if (!container) {
        state.orb.transcriptNearBottom = true;
        return;
    }

    // VTID-01064: If scrollTop is 0 and there's content, user hasn't scrolled yet
    // This means we haven't scrolled to bottom yet, NOT that user scrolled to top
    // Keep transcriptNearBottom true so next scroll-to-bottom will work
    var hasContent = container.scrollHeight > container.clientHeight;
    if (container.scrollTop === 0 && hasContent) {
        // Don't change transcriptNearBottom - keep it true for auto-scroll
        return;
    }

    // VTID-01064: Use 80px threshold as specified
    var THRESHOLD_PX = 80;
    var distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    state.orb.transcriptNearBottom = distanceFromBottom < THRESHOLD_PX;
}

/**
 * VTID-01037: Setup scroll listener for transcript container
 * VTID-01064: Enhanced to properly track user scroll intent
 * Must be called after the container is rendered
 */
function setupTranscriptScrollListener() {
    var container = document.querySelector('.orb-live-transcript');
    if (!container || container.dataset.scrollListenerAttached) return;

    var THRESHOLD_PX = 80;

    container.addEventListener('scroll', function() {
        // VTID-01064: Check if user scrolled away from bottom
        var distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;

        // If user scrolled up beyond threshold, disable auto-follow
        if (distanceFromBottom > THRESHOLD_PX) {
            state.orb.transcriptNearBottom = false;
        } else {
            // User scrolled back near bottom, re-enable auto-follow
            state.orb.transcriptNearBottom = true;
        }
    });
    container.dataset.scrollListenerAttached = 'true';
}

// ==========================================================================
// VTID-0135: ORB Voice Conversation (Web Speech APIs)
// ==========================================================================

/**
 * VTID-0135: Check if Web Speech APIs are supported
 */
function isWebSpeechSupported() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    return !!SpeechRecognition && 'speechSynthesis' in window;
}

/**
 * VTID-0135: Start voice conversation session
 * Uses Web Speech APIs for STT and TTS
 */
function orbVoiceStart() {
    console.log('[VTID-0135] Starting voice conversation...');

    // VTID-01064: Set connecting state during initialization
    setOrbState('connecting');

    // Check browser support
    if (!isWebSpeechSupported()) {
        state.orb.voiceError = 'Speech recognition not supported in this browser. Please use Chrome or Edge.';
        state.orb.voiceState = 'IDLE';
        // VTID-01064: Update ORB aura to error state
        setOrbState('error');
        renderApp();
        return;
    }

    // Reset state
    state.orb.voiceError = null;
    state.orb.liveTranscript = [];
    state.orb.interimTranscript = '';

    // Generate session ID if not exists
    if (!state.orb.orbSessionId) {
        state.orb.orbSessionId = 'orb-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }

    // Initialize Speech Recognition
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    var recognition = new SpeechRecognition();

    recognition.continuous = true;
    recognition.interimResults = true;
    // VTID-01042: Use unified language setting for STT
    recognition.lang = state.orb.orbLang;

    // VTID-0135: Track processed results to prevent re-processing on restart
    // When recognition restarts, old results may persist in event.results
    var lastProcessedResultIndex = -1;

    recognition.onstart = function() {
        console.log('[VTID-0135] Speech recognition started');
        state.orb.voiceState = 'LISTENING';
        state.orb.micActive = true;
        // Reset the processed index when recognition starts fresh
        lastProcessedResultIndex = -1;
        // VTID-01064: Update ORB aura to listening state
        setOrbState('listening');
        // VTID-01067: Update micro-status and badges
        setOrbMicroStatus('Listening...', 0); // No auto-clear while listening
        renderOrbBadges();
        renderApp();
    };

    // VTID-01067: Mic-reactive shimmer on audio/speech events
    recognition.onaudiostart = function() {
        console.log('[VTID-01067] Audio capture started');
        triggerMicShimmer();
    };

    recognition.onspeechstart = function() {
        console.log('[VTID-01067] Speech detected');
        triggerMicShimmer();
    };

    recognition.onspeechend = function() {
        console.log('[VTID-01067] Speech ended');
        // Return intensity to normal (handled by animation end)
    };

    recognition.onresult = function(event) {
        var interimTranscript = '';
        var finalTranscript = '';

        // VTID-0135 FIX: Skip already-processed results to prevent duplicate messages
        // When recognition restarts, event.resultIndex may be 0 but old results persist
        var startIndex = Math.max(event.resultIndex, lastProcessedResultIndex + 1);

        for (var i = startIndex; i < event.results.length; i++) {
            var transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
                // Mark this result as processed
                lastProcessedResultIndex = i;
            } else {
                interimTranscript += transcript;
            }
        }

        // VTID-01037: Echo filter - check if this is likely TTS echo
        var currentTranscript = finalTranscript || interimTranscript;
        var isWithinIgnoreWindow = Date.now() < state.orb.ignoreSTTUntil;
        var isSpeakingState = state.orb.speaking || state.orb.voiceState === 'SPEAKING';
        var looksLikeEcho = isLikelyEcho(currentTranscript, state.orb.lastTTSText);

        // If within ignore window and looks like echo, ignore completely
        if ((isWithinIgnoreWindow || isSpeakingState) && looksLikeEcho) {
            console.log('[VTID-01037] Ignoring likely echo:', currentTranscript.substring(0, 30));
            return; // Ignore this result entirely
        }

        // VTID-01037: Barge-in - only if NOT echo (real user speech during TTS)
        // VTID-01066: Updated to use orbStopTTS for proper interrupt handling
        if (state.orb.voiceState === 'SPEAKING' && (interimTranscript || finalTranscript)) {
            // Only trigger barge-in if this is NOT an echo
            if (!looksLikeEcho) {
                console.log('[VTID-01037] Real barge-in detected, triggering voice interrupt');
                orbStopTTS('voice_interrupt');
            } else {
                // It's echo during speaking, ignore
                console.log('[VTID-01037] Ignoring echo during TTS:', currentTranscript.substring(0, 30));
                return;
            }
        }

        state.orb.interimTranscript = interimTranscript;

        if (finalTranscript) {
            // VTID-01037: Final check - don't process if still looks like echo
            if (isSpeakingState && looksLikeEcho) {
                console.log('[VTID-01037] Ignoring final echo transcript');
                return;
            }

            console.log('[VTID-0135] Final transcript:', finalTranscript);
            state.orb.interimTranscript = '';

            // VTID-01037: Track scroll position before adding message
            updateTranscriptNearBottom();

            // VTID-01066: Add user message to transcript with voice mode
            state.orb.liveTranscript.push({
                id: Date.now(),
                role: 'user',
                text: finalTranscript.trim(),
                mode: 'voice',
                timestamp: new Date().toISOString()
            });

            renderApp();
            scrollOrbLiveTranscript();

            // Send to backend
            orbVoiceSendText(finalTranscript.trim());
        } else {
            // VTID-01069-F: Render interim transcript and scroll to show it
            renderApp();
            scrollOrbLiveTranscript();
        }
    };

    recognition.onerror = function(event) {
        console.error('[VTID-0135] Speech recognition error:', event.error);

        if (event.error === 'not-allowed') {
            state.orb.voiceError = 'Microphone access denied. Please allow microphone access and try again.';
            state.orb.voiceState = 'IDLE';
            state.orb.micActive = false;
            // VTID-01067: Update micro-status for permission error
            setOrbMicroStatus('Permission blocked');
            // VTID-01064: Update ORB aura to error state
            setOrbState('error');
        } else if (event.error === 'no-speech') {
            // No speech detected, restart if still listening
            if (state.orb.voiceState === 'LISTENING') {
                console.log('[VTID-0135] No speech detected, continuing to listen...');
            }
        } else if (event.error === 'aborted') {
            // VTID-01044: Aborted is intentional (language change, TTS start) - not an error
            console.log('[VTID-01044] Recognition aborted (intentional)');
            // Don't set voiceError - let onend handler restart if needed
        } else if (event.error === 'language-not-supported' || event.error === 'service-not-allowed') {
            // VTID-01042: Language not supported - fall back to English (US)
            console.warn('[VTID-01042] Language not supported:', state.orb.orbLang, '- falling back to English (US)');
            orbFallbackToEnglish();
        } else {
            state.orb.voiceError = 'Speech recognition error: ' + event.error;
        }

        renderApp();
    };

    recognition.onend = function() {
        console.log('[VTID-0135] Speech recognition ended');

        // VTID-01044: If aborted for TTS, don't auto-restart here
        // Let restartRecognitionAfterTTS() handle it when TTS ends
        if (state.orb.abortedForTTS) {
            console.log('[VTID-01044] Recognition ended for TTS start, will restart after TTS');
            state.orb.abortedForTTS = false; // Reset flag
            return; // Don't restart or change state - TTS flow will handle it
        }

        // Restart if not intentionally stopped and not in error state
        if (state.orb.overlayVisible && state.orb.voiceState !== 'MUTED' && !state.orb.voiceError) {
            console.log('[VTID-0135] Restarting speech recognition...');
            try {
                recognition.start();
            } catch (e) {
                console.warn('[VTID-0135] Failed to restart recognition:', e);
            }
        } else {
            state.orb.micActive = false;
            if (state.orb.voiceState === 'LISTENING') {
                state.orb.voiceState = 'IDLE';
            }
            renderApp();
        }
    };

    state.orb.speechRecognition = recognition;

    // Start listening
    try {
        recognition.start();
    } catch (e) {
        console.error('[VTID-0135] Failed to start speech recognition:', e);
        state.orb.voiceError = 'Failed to start speech recognition: ' + e.message;
        // VTID-01064: Update ORB aura to error state
        setOrbState('error');
        renderApp();
    }
}

/**
 * VTID-0135: Stop voice conversation session
 * VTID-01109: Don't clear conversationId - it persists until logout
 */
function orbVoiceStop() {
    console.log('[VTID-0135] Stopping voice conversation...');

    // Stop speech recognition
    if (state.orb.speechRecognition) {
        try {
            state.orb.speechRecognition.stop();
        } catch (e) {
            // Ignore
        }
        state.orb.speechRecognition = null;
    }

    // Cancel any ongoing TTS
    window.speechSynthesis.cancel();

    // VTID-01109: Save conversation state before stopping
    // This ensures conversation persists across overlay close/open
    orbSaveConversationState();

    // VTID-01109: Don't notify backend of session end on overlay close
    // Conversation should persist until logout. Only send end-session on actual logout.
    // The backend conversation and memory will remain available for when user reopens orb.

    // Reset transient state only - keep conversationId and orbSessionId for continuity
    state.orb.voiceState = 'IDLE';
    state.orb.micActive = false;
    state.orb.interimTranscript = '';
    // VTID-01109: Don't clear conversationId or orbSessionId - they persist until logout
    // state.orb.orbSessionId = null;  // REMOVED
    // state.orb.conversationId = null;  // REMOVED

    console.log('[VTID-0135] Voice conversation stopped (conversation preserved)');
}

/**
 * VTID-0135: Toggle mute state for voice conversation
 */
function orbVoiceToggleMute() {
    if (state.orb.voiceState === 'MUTED') {
        // Unmute - restart recognition
        console.log('[VTID-0135] Unmuting...');
        state.orb.voiceState = 'LISTENING';
        // VTID-01064: Update ORB aura to listening state
        setOrbState('listening');
        // VTID-01067: Update micro-status and badges
        setOrbMicroStatus('Listening...', 0);

        if (state.orb.speechRecognition) {
            try {
                state.orb.speechRecognition.start();
            } catch (e) {
                console.warn('[VTID-0135] Recognition already running');
            }
        } else {
            orbVoiceStart();
        }
    } else {
        // Mute - stop recognition
        console.log('[VTID-0135] Muting...');
        state.orb.voiceState = 'MUTED';
        // VTID-01064: Update ORB aura to paused state
        setOrbState('paused');
        // VTID-01067: Update micro-status
        setOrbMicroStatus('Mic muted');

        if (state.orb.speechRecognition) {
            try {
                state.orb.speechRecognition.stop();
            } catch (e) {
                // Ignore
            }
        }

        // Also cancel any ongoing TTS
        window.speechSynthesis.cancel();
        // VTID-01067: Stop speaking beat if it was running
        stopSpeakingBeat();
    }

    state.orb.micActive = state.orb.voiceState !== 'MUTED';
    // VTID-01067: Update badges after mic state change
    renderOrbBadges();
    renderApp();
}

/**
 * VTID-01155: Capture a frame from a MediaStream
 * Returns base64 JPEG data suitable for Gemini multimodal input
 * @param {MediaStream} stream - The media stream to capture from
 * @param {string} source - 'screen' or 'camera'
 * @returns {Promise<{data_b64: string, mime: string, source: string} | null>}
 */
async function orbCaptureFrame(stream, source) {
    if (!stream) return null;

    var videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return null;

    try {
        // Use ImageCapture API if available
        if (typeof ImageCapture !== 'undefined') {
            var imageCapture = new ImageCapture(videoTrack);
            var bitmap = await imageCapture.grabFrame();

            // Create canvas for resizing to 768x768 (Gemini recommendation)
            var canvas = document.createElement('canvas');
            canvas.width = 768;
            canvas.height = 768;
            var ctx = canvas.getContext('2d');

            // Scale to fit while maintaining aspect ratio
            var scale = Math.min(768 / bitmap.width, 768 / bitmap.height);
            var scaledWidth = bitmap.width * scale;
            var scaledHeight = bitmap.height * scale;
            var offsetX = (768 - scaledWidth) / 2;
            var offsetY = (768 - scaledHeight) / 2;

            // Fill black background and draw centered image
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, 768, 768);
            ctx.drawImage(bitmap, offsetX, offsetY, scaledWidth, scaledHeight);

            // Convert to JPEG base64
            var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            var base64 = dataUrl.split(',')[1];

            return {
                data_b64: base64,
                mime: 'image/jpeg',
                source: source
            };
        } else {
            // Fallback: create video element to capture frame
            return new Promise(function(resolve) {
                var video = document.createElement('video');
                video.srcObject = stream;
                video.onloadedmetadata = function() {
                    video.play();
                    setTimeout(function() {
                        var canvas = document.createElement('canvas');
                        canvas.width = 768;
                        canvas.height = 768;
                        var ctx = canvas.getContext('2d');

                        var scale = Math.min(768 / video.videoWidth, 768 / video.videoHeight);
                        var scaledWidth = video.videoWidth * scale;
                        var scaledHeight = video.videoHeight * scale;
                        var offsetX = (768 - scaledWidth) / 2;
                        var offsetY = (768 - scaledHeight) / 2;

                        ctx.fillStyle = '#000';
                        ctx.fillRect(0, 0, 768, 768);
                        ctx.drawImage(video, offsetX, offsetY, scaledWidth, scaledHeight);

                        var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                        var base64 = dataUrl.split(',')[1];

                        video.srcObject = null;
                        resolve({
                            data_b64: base64,
                            mime: 'image/jpeg',
                            source: source
                        });
                    }, 100);
                };
                video.onerror = function() {
                    resolve(null);
                };
            });
        }
    } catch (e) {
        console.warn('[VTID-01155] Frame capture failed:', e);
        return null;
    }
}

/**
 * VTID-01069-D: Toggle camera - opens device camera with getUserMedia
 * On stop: stops all tracks and clears stream handle
 */
function orbToggleCamera() {
    if (state.orb.cameraActive && state.orb.cameraStream) {
        // Stop camera
        console.log('[VTID-01069-D] Stopping camera...');
        state.orb.cameraStream.getTracks().forEach(function(track) {
            track.stop();
        });
        state.orb.cameraStream = null;
        state.orb.cameraActive = false;
        renderApp();
    } else {
        // Start camera
        console.log('[VTID-01069-D] Starting camera...');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            // Add system message about unsupported browser
            state.orb.liveTranscript.push({
                id: Date.now(),
                role: 'assistant',
                text: 'Camera is not supported in this browser.',
                timestamp: new Date().toISOString()
            });
            renderApp();
            return;
        }
        navigator.mediaDevices.getUserMedia({ video: true, audio: false })
            .then(function(stream) {
                console.log('[VTID-01069-D] Camera stream acquired');
                state.orb.cameraStream = stream;
                state.orb.cameraActive = true;
                renderApp();
            })
            .catch(function(err) {
                console.error('[VTID-01069-D] Camera error:', err);
                // Add system message about permission denial
                state.orb.liveTranscript.push({
                    id: Date.now(),
                    role: 'assistant',
                    text: 'Camera access denied or unavailable: ' + err.message,
                    timestamp: new Date().toISOString()
                });
                state.orb.cameraActive = false;
                renderApp();
            });
    }
}

/**
 * VTID-01069-D: Toggle screen share - opens OS screen picker with getDisplayMedia
 * On stop: stops all tracks and clears stream handle
 */
function orbToggleScreenShare() {
    if (state.orb.screenShareActive && state.orb.screenStream) {
        // Stop screen share
        console.log('[VTID-01069-D] Stopping screen share...');
        state.orb.screenStream.getTracks().forEach(function(track) {
            track.stop();
        });
        state.orb.screenStream = null;
        state.orb.screenShareActive = false;
        renderApp();
    } else {
        // Start screen share
        console.log('[VTID-01069-D] Starting screen share...');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            // Add system message about unsupported browser
            state.orb.liveTranscript.push({
                id: Date.now(),
                role: 'assistant',
                text: 'Screen sharing is not supported in this browser.',
                timestamp: new Date().toISOString()
            });
            renderApp();
            return;
        }
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
            .then(function(stream) {
                console.log('[VTID-01069-D] Screen share stream acquired');
                state.orb.screenStream = stream;
                state.orb.screenShareActive = true;
                // Listen for user stopping share via browser UI
                stream.getVideoTracks()[0].addEventListener('ended', function() {
                    console.log('[VTID-01069-D] Screen share ended by user');
                    state.orb.screenStream = null;
                    state.orb.screenShareActive = false;
                    renderApp();
                });
                renderApp();
            })
            .catch(function(err) {
                console.error('[VTID-01069-D] Screen share error:', err);
                // Add system message about permission denial
                state.orb.liveTranscript.push({
                    id: Date.now(),
                    role: 'assistant',
                    text: 'Screen sharing denied or unavailable: ' + err.message,
                    timestamp: new Date().toISOString()
                });
                state.orb.screenShareActive = false;
                renderApp();
            });
    }
}

// =============================================================================
// VTID-01155: Gemini Live Multimodal Session Functions
// =============================================================================

/**
 * VTID-01155: Start Gemini Live session
 * Creates session, connects SSE stream, and sets up audio capture
 */
async function geminiLiveStart() {
    if (state.orb.geminiLiveActive) {
        console.log('[VTID-01155] Live session already active');
        return;
    }

    console.log('[VTID-01155] Starting Gemini Live session...');

    try {
        // 1. Start Live session via API
        var lang = state.orb.orbLang || 'en-US';
        var response = await fetch('/api/v1/orb/live/session/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lang: lang,
                voice_style: 'friendly, calm, empathetic',
                response_modalities: ['audio', 'text']
            })
        });

        var data = await response.json();
        if (!data.ok) {
            throw new Error(data.error || 'Failed to start Live session');
        }

        state.orb.geminiLiveSessionId = data.session_id;
        state.orb.geminiLiveActive = true;

        console.log('[VTID-01155] Live session started:', data.session_id);

        // 2. Connect to SSE stream
        var eventSource = new EventSource('/api/v1/orb/live/stream?session_id=' + data.session_id);

        eventSource.onopen = function() {
            console.log('[VTID-01155] Live stream connected');
        };

        eventSource.onmessage = function(event) {
            try {
                var msg = JSON.parse(event.data);
                geminiLiveHandleMessage(msg);
            } catch (e) {
                console.warn('[VTID-01155] Failed to parse SSE message:', e);
            }
        };

        eventSource.onerror = function(err) {
            console.error('[VTID-01155] Live stream error:', err);
            if (eventSource.readyState === EventSource.CLOSED) {
                geminiLiveStop();
            }
        };

        state.orb.geminiLiveEventSource = eventSource;

        // 3. Set up audio capture (PCM 16kHz 16-bit)
        await geminiLiveStartAudioCapture();

        // 4. Start frame capture if screen/camera active
        geminiLiveStartFrameCapture();

        renderApp();

    } catch (error) {
        console.error('[VTID-01155] Failed to start Live session:', error);
        state.orb.geminiLiveActive = false;
        state.orb.geminiLiveSessionId = null;
        state.orb.liveTranscript.push({
            id: Date.now(),
            role: 'assistant',
            text: 'Failed to start Live session: ' + error.message,
            timestamp: new Date().toISOString()
        });
        renderApp();
    }
}

/**
 * VTID-01155: Stop Gemini Live session
 */
async function geminiLiveStop() {
    console.log('[VTID-01155] Stopping Gemini Live session...');

    // Stop frame capture
    if (state.orb.geminiLiveFrameInterval) {
        clearInterval(state.orb.geminiLiveFrameInterval);
        state.orb.geminiLiveFrameInterval = null;
    }

    // Stop audio capture
    if (state.orb.geminiLiveAudioStream) {
        state.orb.geminiLiveAudioStream.getTracks().forEach(function(track) {
            track.stop();
        });
        state.orb.geminiLiveAudioStream = null;
    }

    if (state.orb.geminiLiveAudioProcessor) {
        state.orb.geminiLiveAudioProcessor.disconnect();
        state.orb.geminiLiveAudioProcessor = null;
    }

    if (state.orb.geminiLiveAudioContext) {
        state.orb.geminiLiveAudioContext.close().catch(function() {});
        state.orb.geminiLiveAudioContext = null;
    }

    // Close SSE connection
    if (state.orb.geminiLiveEventSource) {
        state.orb.geminiLiveEventSource.close();
        state.orb.geminiLiveEventSource = null;
    }

    // Stop session on backend
    if (state.orb.geminiLiveSessionId) {
        try {
            await fetch('/api/v1/orb/live/session/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: state.orb.geminiLiveSessionId })
            });
        } catch (e) {
            console.warn('[VTID-01155] Failed to stop session on backend:', e);
        }
    }

    state.orb.geminiLiveSessionId = null;
    state.orb.geminiLiveActive = false;
    state.orb.geminiLiveAudioQueue = [];

    console.log('[VTID-01155] Live session stopped');
    renderApp();
}

/**
 * VTID-01155: Handle messages from Live SSE stream
 */
function geminiLiveHandleMessage(msg) {
    console.log('[VTID-01155] Live message:', msg.type);

    switch (msg.type) {
        case 'ready':
            console.log('[VTID-01155] Live stream ready:', msg.meta);
            break;

        case 'audio_out':
            // Queue audio for playback (PCM 24kHz)
            if (msg.data_b64) {
                geminiLivePlayAudio(msg.data_b64);
            }
            break;

        case 'text':
            // Display text response
            if (msg.text) {
                state.orb.liveTranscript.push({
                    id: Date.now(),
                    role: 'assistant',
                    text: msg.text,
                    timestamp: new Date().toISOString()
                });
                scrollOrbLiveTranscript();
                renderApp();
            }
            break;

        case 'interrupted':
            // Model was interrupted, flush audio queue
            state.orb.geminiLiveAudioQueue = [];
            console.log('[VTID-01155] Audio interrupted, queue flushed');
            break;

        case 'audio_ack':
        case 'video_ack':
            // Acknowledgements, no action needed
            break;

        case 'session_ended':
            console.log('[VTID-01155] Session ended by server');
            geminiLiveStop();
            break;

        default:
            console.log('[VTID-01155] Unknown message type:', msg.type);
    }
}

/**
 * VTID-01155: Start audio capture for Live session
 * Captures PCM 16kHz 16-bit audio and sends to Gateway
 */
async function geminiLiveStartAudioCapture() {
    console.log('[VTID-01155] Starting audio capture...');

    var stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 16000
        }
    });

    state.orb.geminiLiveAudioStream = stream;

    // Create AudioContext at 16kHz
    var audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    state.orb.geminiLiveAudioContext = audioContext;

    var source = audioContext.createMediaStreamSource(stream);
    // 640 samples = 40ms at 16kHz
    var processor = audioContext.createScriptProcessor(640, 1, 1);

    processor.onaudioprocess = function(e) {
        if (!state.orb.geminiLiveActive || state.orb.voiceState === 'MUTED') return;

        var inputData = e.inputBuffer.getChannelData(0);

        // Convert Float32 to Int16 PCM
        var pcmData = new Int16Array(inputData.length);
        for (var i = 0; i < inputData.length; i++) {
            var s = Math.max(-1, Math.min(1, inputData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Convert to base64
        var uint8Array = new Uint8Array(pcmData.buffer);
        var base64 = btoa(String.fromCharCode.apply(null, uint8Array));

        // Send to Gateway
        geminiLiveSendAudio(base64);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    state.orb.geminiLiveAudioProcessor = processor;

    console.log('[VTID-01155] Audio capture started');
}

/**
 * VTID-01155: Send audio chunk to Gateway
 */
function geminiLiveSendAudio(base64Data) {
    if (!state.orb.geminiLiveSessionId || !state.orb.geminiLiveActive) return;

    fetch('/api/v1/orb/live/stream/send?session_id=' + state.orb.geminiLiveSessionId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'audio',
            data_b64: base64Data,
            mime: 'audio/pcm;rate=16000'
        })
    }).catch(function(error) {
        console.warn('[VTID-01155] Failed to send audio:', error);
    });
}

/**
 * VTID-01155: Start frame capture for screen/camera
 * Captures JPEG frames at ~1 FPS, resized to 768x768
 */
function geminiLiveStartFrameCapture() {
    if (state.orb.geminiLiveFrameInterval) {
        clearInterval(state.orb.geminiLiveFrameInterval);
    }

    // Capture frames every 1 second
    state.orb.geminiLiveFrameInterval = setInterval(function() {
        if (!state.orb.geminiLiveActive) return;

        // Capture screen frame if active
        if (state.orb.screenShareActive && state.orb.screenStream) {
            geminiLiveCaptureAndSendFrame(state.orb.screenStream, 'screen');
        }

        // Capture camera frame if active
        if (state.orb.cameraActive && state.orb.cameraStream) {
            geminiLiveCaptureAndSendFrame(state.orb.cameraStream, 'camera');
        }
    }, 1000);

    console.log('[VTID-01155] Frame capture started');
}

/**
 * VTID-01155: Capture frame from stream and send to Gateway
 * Resizes to 768x768 and encodes as JPEG
 */
function geminiLiveCaptureAndSendFrame(stream, source) {
    var videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    // Create ImageCapture if available
    if (typeof ImageCapture !== 'undefined') {
        var imageCapture = new ImageCapture(videoTrack);
        imageCapture.grabFrame().then(function(bitmap) {
            // Resize to 768x768 using canvas
            var canvas = document.createElement('canvas');
            canvas.width = 768;
            canvas.height = 768;
            var ctx = canvas.getContext('2d');

            // Scale to fit
            var scale = Math.min(768 / bitmap.width, 768 / bitmap.height);
            var scaledWidth = bitmap.width * scale;
            var scaledHeight = bitmap.height * scale;
            var offsetX = (768 - scaledWidth) / 2;
            var offsetY = (768 - scaledHeight) / 2;

            // Fill black background
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, 768, 768);

            // Draw scaled image centered
            ctx.drawImage(bitmap, offsetX, offsetY, scaledWidth, scaledHeight);

            // Convert to JPEG base64
            var dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            var base64 = dataUrl.split(',')[1];

            // Send to Gateway
            geminiLiveSendFrame(base64, source);
        }).catch(function(err) {
            console.warn('[VTID-01155] Failed to grab frame:', err);
        });
    } else {
        // Fallback: use video element
        var video = document.createElement('video');
        video.srcObject = stream;
        video.onloadedmetadata = function() {
            video.play();
            var canvas = document.createElement('canvas');
            canvas.width = 768;
            canvas.height = 768;
            var ctx = canvas.getContext('2d');

            var scale = Math.min(768 / video.videoWidth, 768 / video.videoHeight);
            var scaledWidth = video.videoWidth * scale;
            var scaledHeight = video.videoHeight * scale;
            var offsetX = (768 - scaledWidth) / 2;
            var offsetY = (768 - scaledHeight) / 2;

            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, 768, 768);
            ctx.drawImage(video, offsetX, offsetY, scaledWidth, scaledHeight);

            var dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            var base64 = dataUrl.split(',')[1];
            geminiLiveSendFrame(base64, source);

            video.srcObject = null;
        };
    }
}

/**
 * VTID-01155: Send video frame to Gateway
 */
function geminiLiveSendFrame(base64Data, source) {
    if (!state.orb.geminiLiveSessionId || !state.orb.geminiLiveActive) return;

    fetch('/api/v1/orb/live/stream/send?session_id=' + state.orb.geminiLiveSessionId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'video',
            source: source,
            data_b64: base64Data,
            width: 768,
            height: 768
        })
    }).catch(function(error) {
        console.warn('[VTID-01155] Failed to send frame:', error);
    });
}

/**
 * VTID-01155: Play audio from Live session (PCM 24kHz)
 */
function geminiLivePlayAudio(base64Data) {
    // Decode base64 to ArrayBuffer
    var binaryString = atob(base64Data);
    var bytes = new Uint8Array(binaryString.length);
    for (var i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    // Create AudioContext at 24kHz if not exists
    if (!state.orb.geminiLiveAudioContext || state.orb.geminiLiveAudioContext.state === 'closed') {
        state.orb.geminiLiveAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    }

    var audioContext = state.orb.geminiLiveAudioContext;

    // Convert Int16 PCM to Float32
    var int16Array = new Int16Array(bytes.buffer);
    var floatArray = new Float32Array(int16Array.length);
    for (var j = 0; j < int16Array.length; j++) {
        floatArray[j] = int16Array[j] / 32768.0;
    }

    // Create audio buffer and play
    var audioBuffer = audioContext.createBuffer(1, floatArray.length, 24000);
    audioBuffer.copyToChannel(floatArray, 0);

    var source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start();

    console.log('[VTID-01155] Playing audio chunk');
}

/**
 * VTID-01155: Fallback TTS using Gemini-TTS endpoint
 * Used when Live session is not active
 */
async function geminiTtsFallback(text, lang) {
    if (!text) return;

    console.log('[VTID-01155] Using Gemini-TTS fallback');

    try {
        var response = await fetch('/api/v1/orb/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                lang: lang || state.orb.orbLang || 'en-US',
                voice_style: 'friendly, calm, empathetic'
            })
        });

        var data = await response.json();
        if (!data.ok) {
            console.error('[VTID-01155] TTS failed:', data.error);
            return;
        }

        // Play audio from base64
        if (data.audio_b64) {
            var audio = new Audio('data:' + (data.mime || 'audio/mp3') + ';base64,' + data.audio_b64);
            audio.play().catch(function(e) {
                console.warn('[VTID-01155] TTS playback failed:', e);
            });
        }

    } catch (error) {
        console.error('[VTID-01155] TTS error:', error);
    }
}

/**
 * VTID-0135: Send text to backend via POST /api/v1/orb/chat
 * VTID-01066: Updated to insert thinking placeholder immediately
 * VTID-01155: Updated to capture and send screen/camera frames
 */
async function orbVoiceSendText(text) {
    if (!text || !text.trim()) return;

    console.log('[VTID-0135] Sending to backend:', text);
    state.orb.voiceState = 'THINKING';
    state.orb.isThinking = true;
    // VTID-01064: Update ORB aura to thinking state
    setOrbState('thinking');
    // VTID-01067: Update micro-status
    setOrbMicroStatus('Thinking...', 0); // No auto-clear while thinking

    // VTID-01066: Insert thinking placeholder immediately
    var thinkingId = Date.now();
    state.orb.thinkingPlaceholderId = thinkingId;
    state.orb.liveTranscript.push({
        id: thinkingId,
        role: 'assistant',
        text: '',
        isThinking: true,
        timestamp: new Date().toISOString()
    });
    renderApp();
    scrollOrbLiveTranscript();

    // VTID-01155: Capture frames from active screen/camera for multimodal input
    var images = [];
    try {
        if (state.orb.screenShareActive && state.orb.screenStream) {
            var screenFrame = await orbCaptureFrame(state.orb.screenStream, 'screen');
            if (screenFrame) {
                images.push(screenFrame);
                console.log('[VTID-01155] Screen frame captured for chat');
            }
        }
        if (state.orb.cameraActive && state.orb.cameraStream) {
            var cameraFrame = await orbCaptureFrame(state.orb.cameraStream, 'camera');
            if (cameraFrame) {
                images.push(cameraFrame);
                console.log('[VTID-01155] Camera frame captured for chat');
            }
        }
    } catch (e) {
        console.warn('[VTID-01155] Frame capture error:', e);
    }

    try {
        var requestBody = {
            orb_session_id: state.orb.orbSessionId,
            conversation_id: state.orb.conversationId,
            input_text: text,
            meta: {
                mode: 'orb_voice',
                source: 'command-hub',
                vtid: null
            }
        };

        // VTID-01155: Add images if captured
        if (images.length > 0) {
            requestBody.images = images;
            console.log('[VTID-01155] Sending chat with ' + images.length + ' image(s)');
        }

        var response = await fetch('/api/v1/orb/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        var data = await response.json();

        if (data.ok) {
            console.log('[VTID-0135] Response received:', data.reply_text);

            // Update conversation ID for continuity
            if (data.conversation_id) {
                state.orb.conversationId = data.conversation_id;
            }

            // VTID-01037: Track scroll position before adding message
            updateTranscriptNearBottom();

            // VTID-01066: Replace thinking placeholder with actual response
            var responseId = Date.now();
            var placeholderIdx = state.orb.liveTranscript.findIndex(function(m) {
                return m.id === state.orb.thinkingPlaceholderId;
            });
            if (placeholderIdx !== -1) {
                state.orb.liveTranscript[placeholderIdx] = {
                    id: responseId,
                    role: 'assistant',
                    text: data.reply_text,
                    isThinking: false,
                    timestamp: new Date().toISOString(),
                    meta: data.meta
                };
            } else {
                // Fallback: add as new message
                state.orb.liveTranscript.push({
                    id: responseId,
                    role: 'assistant',
                    text: data.reply_text,
                    timestamp: new Date().toISOString(),
                    meta: data.meta
                });
            }
            state.orb.thinkingPlaceholderId = null;

            state.orb.isThinking = false;
            renderApp();
            scrollOrbLiveTranscript();

            // Speak the response using TTS
            orbVoiceSpeak(data.reply_text);

            // VTID-01109: Save conversation state after each successful response
            orbSaveConversationState();
        } else {
            console.error('[VTID-0135] Backend error:', data.error);
            // VTID-01037: Track scroll position before adding message
            updateTranscriptNearBottom();

            // VTID-01066: Replace thinking placeholder with error
            var placeholderIdx = state.orb.liveTranscript.findIndex(function(m) {
                return m.id === state.orb.thinkingPlaceholderId;
            });
            if (placeholderIdx !== -1) {
                state.orb.liveTranscript[placeholderIdx] = {
                    id: Date.now(),
                    role: 'assistant',
                    text: 'Sorry, I encountered an error: ' + (data.error || 'Unknown error'),
                    isThinking: false,
                    timestamp: new Date().toISOString()
                };
            } else {
                state.orb.liveTranscript.push({
                    id: Date.now(),
                    role: 'assistant',
                    text: 'Sorry, I encountered an error: ' + (data.error || 'Unknown error'),
                    timestamp: new Date().toISOString()
                });
            }
            state.orb.thinkingPlaceholderId = null;
            state.orb.isThinking = false;
            state.orb.voiceState = 'LISTENING';
            renderApp();
            scrollOrbLiveTranscript();
        }
    } catch (error) {
        console.error('[VTID-0135] Network error:', error);
        // VTID-01037: Track scroll position before adding message
        updateTranscriptNearBottom();

        // VTID-01066: Replace thinking placeholder with error
        var placeholderIdx = state.orb.liveTranscript.findIndex(function(m) {
            return m.id === state.orb.thinkingPlaceholderId;
        });
        if (placeholderIdx !== -1) {
            state.orb.liveTranscript[placeholderIdx] = {
                id: Date.now(),
                role: 'assistant',
                text: "Couldn't respond. Try again.",
                isThinking: false,
                timestamp: new Date().toISOString()
            };
        } else {
            state.orb.liveTranscript.push({
                id: Date.now(),
                role: 'assistant',
                text: "Couldn't respond. Try again.",
                timestamp: new Date().toISOString()
            });
        }
        state.orb.thinkingPlaceholderId = null;
        state.orb.isThinking = false;
        state.orb.voiceState = 'LISTENING';
        renderApp();
        scrollOrbLiveTranscript();
    }
}

// VTID-01038: TTS Voice Selection - localStorage key (legacy, kept for backward compat)
const ORB_TTS_VOICE_KEY = 'orb_tts_voice';

// VTID-01042: Unified Language selector - localStorage keys
const ORB_LANG_KEY = 'orb_lang';          // Single source of truth
const ORB_STT_LANG_KEY = 'orb_stt_lang';  // Kept for clarity/backward compat
const ORB_TTS_LANG_KEY = 'orb_tts_lang';  // Kept for clarity/backward compat
const ORB_TTS_VOICE_URI_KEY = 'orb_tts_voice_uri'; // Selected voice URI

// VTID-01109: ORB Conversation Persistence Keys
// Conversation state persists until logout, not just until overlay closes
const ORB_CONVERSATION_ID_KEY = 'orb_conversation_id';
const ORB_TRANSCRIPT_KEY = 'orb_transcript';
const ORB_SESSION_ID_KEY = 'orb_session_id';

/**
 * VTID-01109: Save ORB conversation state to localStorage
 * Called after each message to persist conversation across overlay close/open
 */
function orbSaveConversationState() {
    try {
        if (state.orb.conversationId) {
            localStorage.setItem(ORB_CONVERSATION_ID_KEY, state.orb.conversationId);
        }
        if (state.orb.orbSessionId) {
            localStorage.setItem(ORB_SESSION_ID_KEY, state.orb.orbSessionId);
        }
        if (state.orb.liveTranscript && state.orb.liveTranscript.length > 0) {
            // Only save last 50 messages to avoid localStorage limits
            var transcriptToSave = state.orb.liveTranscript.slice(-50);
            localStorage.setItem(ORB_TRANSCRIPT_KEY, JSON.stringify(transcriptToSave));
        }
        console.log('[VTID-01109] Conversation state saved to localStorage');
    } catch (e) {
        console.warn('[VTID-01109] Failed to save conversation state:', e);
    }
}

/**
 * VTID-01109: Restore ORB conversation state from localStorage
 * Called when opening overlay to restore previous conversation
 * @returns {boolean} true if conversation was restored
 */
function orbRestoreConversationState() {
    try {
        var savedConversationId = localStorage.getItem(ORB_CONVERSATION_ID_KEY);
        var savedSessionId = localStorage.getItem(ORB_SESSION_ID_KEY);
        var savedTranscript = localStorage.getItem(ORB_TRANSCRIPT_KEY);

        if (savedConversationId) {
            state.orb.conversationId = savedConversationId;
            state.orb.orbSessionId = savedSessionId || null;

            if (savedTranscript) {
                try {
                    state.orb.liveTranscript = JSON.parse(savedTranscript);
                } catch (e) {
                    state.orb.liveTranscript = [];
                }
            }

            console.log('[VTID-01109] Conversation restored:', savedConversationId, 'with', state.orb.liveTranscript.length, 'messages');
            return true;
        }
    } catch (e) {
        console.warn('[VTID-01109] Failed to restore conversation state:', e);
    }
    return false;
}

/**
 * VTID-01109: Clear ORB conversation state from localStorage
 * Called on logout or when user explicitly clears conversation
 */
function orbClearConversationState() {
    try {
        localStorage.removeItem(ORB_CONVERSATION_ID_KEY);
        localStorage.removeItem(ORB_SESSION_ID_KEY);
        localStorage.removeItem(ORB_TRANSCRIPT_KEY);
        state.orb.conversationId = null;
        state.orb.orbSessionId = null;
        state.orb.liveTranscript = [];
        console.log('[VTID-01109] Conversation state cleared');
    } catch (e) {
        console.warn('[VTID-01109] Failed to clear conversation state:', e);
    }
}

// VTID-01042: Supported languages list
// VTID-01155: Added Serbian (sr-RS) and Russian (ru-RU) - 8 total
const ORB_SUPPORTED_LANGUAGES = ['en-US', 'de-DE', 'fr-FR', 'es-ES', 'ar-AE', 'zh-CN', 'sr-RS', 'ru-RU'];

/**
 * VTID-01042: Score a voice for quality selection based on target language
 * Higher scores are preferred.
 * @param {SpeechSynthesisVoice} voice - The voice to score
 * @param {string} targetLang - The target language code (e.g., 'de-DE')
 */
function orbScoreVoice(voice, targetLang) {
    var score = 0;
    var nameLower = voice.name.toLowerCase();
    var langPrefix = targetLang.split('-')[0]; // e.g., 'de' from 'de-DE'

    // VTID-01042: Exact locale match (highest priority)
    if (voice.lang === targetLang) {
        score += 200;
    } else if (voice.lang.startsWith(langPrefix + '-') || voice.lang === langPrefix) {
        // Language match (e.g., voice.lang starts with 'de-')
        score += 100;
    }

    // Premium voice indicators (case-insensitive)
    if (nameLower.includes('neural')) score += 50;
    if (nameLower.includes('enhanced')) score += 40;
    if (nameLower.includes('natural')) score += 30;
    if (nameLower.includes('premium')) score += 30;

    // Deprioritize low-quality voices
    if (nameLower.includes('compact')) score -= 50;
    if (nameLower.includes('basic')) score -= 30;
    if (nameLower.includes('standard')) score -= 10;

    // Prefer local voices over remote (local tend to be more responsive)
    if (voice.localService) score += 10;

    return score;
}

/**
 * VTID-01042: Select the best voice for the given language
 * @param {string} targetLang - The target language code
 * @returns {{ voice: SpeechSynthesisVoice|null, isMatch: boolean }}
 */
function orbSelectBestVoiceForLanguage(targetLang) {
    var voices = state.orb.ttsVoices;
    if (!voices || voices.length === 0) {
        return { voice: null, isMatch: false };
    }

    var langPrefix = targetLang.split('-')[0];

    // Score all voices for this language
    var scoredVoices = voices.map(function(voice) {
        return { voice: voice, score: orbScoreVoice(voice, targetLang) };
    }).sort(function(a, b) { return b.score - a.score; });

    if (scoredVoices.length === 0) {
        return { voice: null, isMatch: false };
    }

    var bestVoice = scoredVoices[0].voice;
    // Check if best voice actually matches the target language
    var isMatch = bestVoice.lang === targetLang ||
                  bestVoice.lang.startsWith(langPrefix + '-') ||
                  bestVoice.lang === langPrefix;

    return { voice: bestVoice, isMatch: isMatch };
}

/**
 * VTID-01042: Load available TTS voices and apply language settings
 */
function orbLoadTtsVoices() {
    if (!window.speechSynthesis) {
        console.warn('[VTID-01042] speechSynthesis not available');
        return;
    }

    // VTID-01042: Migrate legacy keys and load saved language
    orbMigrateLegacyLanguageSettings();

    var loadVoices = function() {
        var voices = window.speechSynthesis.getVoices();
        if (voices.length === 0) return;

        state.orb.ttsVoices = voices;
        state.orb.ttsVoicesLoaded = true;

        console.log('[VTID-01042] Loaded', voices.length, 'TTS voices');

        // VTID-01042: Select best voice for the current language
        orbApplyLanguageVoiceSelection();
    };

    // Voices may load asynchronously in some browsers
    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
    }
}

/**
 * VTID-01042: Migrate legacy language settings to unified orb_lang
 */
function orbMigrateLegacyLanguageSettings() {
    var savedLang = localStorage.getItem(ORB_LANG_KEY);
    if (savedLang && ORB_SUPPORTED_LANGUAGES.indexOf(savedLang) !== -1) {
        // Already have valid saved language
        state.orb.orbLang = savedLang;
        console.log('[VTID-01042] Restored saved language:', savedLang);
        return;
    }

    // Check for legacy voice key to determine language
    var legacyVoiceUri = localStorage.getItem(ORB_TTS_VOICE_KEY);
    if (legacyVoiceUri) {
        // Legacy key exists but we'll just default to en-US
        console.log('[VTID-01042] Migrating from legacy voice key, defaulting to en-US');
    }

    // Default to English (US)
    state.orb.orbLang = 'en-US';
    localStorage.setItem(ORB_LANG_KEY, 'en-US');
    localStorage.setItem(ORB_STT_LANG_KEY, 'en-US');
    localStorage.setItem(ORB_TTS_LANG_KEY, 'en-US');
    console.log('[VTID-01042] Initialized default language: en-US');
}

/**
 * VTID-01042: Apply voice selection based on current language
 */
function orbApplyLanguageVoiceSelection() {
    var currentLang = state.orb.orbLang;

    // Check for previously saved voice URI for this language
    var savedVoiceUri = localStorage.getItem(ORB_TTS_VOICE_URI_KEY);
    if (savedVoiceUri) {
        var savedVoice = state.orb.ttsVoices.find(function(v) {
            return v.voiceURI === savedVoiceUri;
        });
        // Only use saved voice if it matches current language
        if (savedVoice) {
            var langPrefix = currentLang.split('-')[0];
            var voiceMatchesLang = savedVoice.lang === currentLang ||
                                   savedVoice.lang.startsWith(langPrefix + '-') ||
                                   savedVoice.lang === langPrefix;
            if (voiceMatchesLang) {
                state.orb.ttsSelectedVoiceUri = savedVoiceUri;
                state.orb.orbLangWarning = null;
                console.log('[VTID-01042] Restored saved voice for', currentLang + ':', savedVoice.name);
                return;
            }
        }
    }

    // Auto-select best voice for current language
    var result = orbSelectBestVoiceForLanguage(currentLang);
    if (result.voice) {
        state.orb.ttsSelectedVoiceUri = result.voice.voiceURI;
        localStorage.setItem(ORB_TTS_VOICE_URI_KEY, result.voice.voiceURI);

        if (result.isMatch) {
            state.orb.orbLangWarning = null;
            console.log('[VTID-01042] Auto-selected voice for', currentLang + ':', result.voice.name);
        } else {
            state.orb.orbLangWarning = 'Matching voice not available on this device; using default voice.';
            console.warn('[VTID-01042] No matching voice for', currentLang + ', using:', result.voice.name);
        }
    } else {
        state.orb.orbLangWarning = 'Matching voice not available on this device; using default voice.';
        console.warn('[VTID-01042] No voices available for', currentLang);
    }
    renderApp();
}

/**
 * VTID-01042: Set the unified language (STT + TTS together)
 * @param {string} langCode - Language code (e.g., 'de-DE')
 */
function orbSetLanguage(langCode) {
    if (ORB_SUPPORTED_LANGUAGES.indexOf(langCode) === -1) {
        console.error('[VTID-01042] Unsupported language:', langCode);
        return;
    }

    console.log('[VTID-01042] Setting language to:', langCode);

    // Update state
    state.orb.orbLang = langCode;
    state.orb.orbLangWarning = null;

    // Persist to localStorage (all keys for backward compat)
    localStorage.setItem(ORB_LANG_KEY, langCode);
    localStorage.setItem(ORB_STT_LANG_KEY, langCode);
    localStorage.setItem(ORB_TTS_LANG_KEY, langCode);

    // VTID-01044: Web Speech API doesn't support changing lang on running recognition
    // Must stop, update lang, then restart
    if (state.orb.speechRecognition) {
        var wasListening = state.orb.voiceState === 'LISTENING';
        console.log('[VTID-01042] Restarting STT with new language:', langCode);

        try {
            // Stop current recognition - this triggers onend which will restart
            state.orb.speechRecognition.abort();
        } catch (e) {
            console.warn('[VTID-01042] Could not abort recognition:', e);
        }

        // Update lang for when it restarts in onend handler
        state.orb.speechRecognition.lang = langCode;
    }

    // Select best TTS voice for this language
    orbApplyLanguageVoiceSelection();
}

/**
 * VTID-01042: Fall back to English (US) when selected language is not supported
 * Used when STT reports language-not-supported error
 */
function orbFallbackToEnglish() {
    console.log('[VTID-01042] Falling back to English (US)');

    // Show warning to user
    state.orb.orbLangWarning = 'Selected language not supported here; switched to English (US).';

    // Set language to English (US)
    state.orb.orbLang = 'en-US';

    // Persist to localStorage
    localStorage.setItem(ORB_LANG_KEY, 'en-US');
    localStorage.setItem(ORB_STT_LANG_KEY, 'en-US');
    localStorage.setItem(ORB_TTS_LANG_KEY, 'en-US');

    // Update active STT recognition
    if (state.orb.speechRecognition) {
        state.orb.speechRecognition.lang = 'en-US';
    }

    // Select best voice for English
    orbApplyLanguageVoiceSelection();
}

/**
 * VTID-01038: Get the selected TTS voice object
 */
function orbGetSelectedVoice() {
    if (!state.orb.ttsSelectedVoiceUri || state.orb.ttsVoices.length === 0) {
        return null;
    }
    return state.orb.ttsVoices.find(function(v) {
        return v.voiceURI === state.orb.ttsSelectedVoiceUri;
    }) || null;
}

/**
 * VTID-01038: Set the TTS voice and persist to localStorage
 */
function orbSetTtsVoice(voiceUri) {
    state.orb.ttsSelectedVoiceUri = voiceUri;
    localStorage.setItem(ORB_TTS_VOICE_KEY, voiceUri);
    var voice = state.orb.ttsVoices.find(function(v) { return v.voiceURI === voiceUri; });
    console.log('[VTID-01038] Voice changed to:', voice ? voice.name : voiceUri);
}

/**
 * VTID-01038: Preview the selected TTS voice
 */
function orbPreviewTtsVoice() {
    if (!window.speechSynthesis) return;

    // Cancel any ongoing speech (including previews)
    window.speechSynthesis.cancel();

    var previewText = 'Hello, I am your Vitana assistant.';
    var utterance = new SpeechSynthesisUtterance(previewText);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    var selectedVoice = orbGetSelectedVoice();
    if (selectedVoice) {
        utterance.voice = selectedVoice;
    }

    console.log('[VTID-01038] Previewing voice:', selectedVoice ? selectedVoice.name : 'default');
    window.speechSynthesis.speak(utterance);
}

/**
 * VTID-01037: Normalize text for echo comparison
 * Removes punctuation, lowercases, and trims
 */
function normalizeTextForEchoCheck(text) {
    if (!text) return '';
    return text.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
}

/**
 * VTID-01037: Check if transcript is likely an echo of TTS output
 * Returns true if it should be ignored (is echo)
 */
function isLikelyEcho(transcript, lastTTSText) {
    if (!transcript || !lastTTSText) return false;

    var normTranscript = normalizeTextForEchoCheck(transcript);
    var normTTS = normalizeTextForEchoCheck(lastTTSText);

    if (!normTranscript || !normTTS) return false;

    // Check if transcript is a substring of TTS or vice versa
    if (normTTS.indexOf(normTranscript) !== -1) return true;
    if (normTranscript.indexOf(normTTS) !== -1) return true;

    // Short transcripts that match common fillers during TTS playback
    if (normTranscript.length < 6) {
        var fillers = ['um', 'uh', 'ah', 'oh', 'hmm', 'the', 'a', 'i', 'is', 'it'];
        if (fillers.indexOf(normTranscript) !== -1) return true;
    }

    return false;
}

/**
 * VTID-01037: Restart speech recognition after TTS ends
 */
function restartRecognitionAfterTTS() {
    state.orb.speaking = false;
    // VTID-01066: Clear speaking message state
    state.orb.speakingMessageId = null;
    state.orb.speakingDurationClass = null;
    state.orb.voiceState = 'LISTENING';
    // VTID-01064: Update ORB aura to ready state after TTS ends
    setOrbState('ready');

    // Scroll to bottom after TTS ends if user was near bottom
    scrollOrbLiveTranscript();

    // Restart recognition with a small delay to avoid catching TTS tail
    setTimeout(function() {
        if (state.orb.overlayVisible && state.orb.speechRecognition &&
            state.orb.voiceState !== 'MUTED' && !state.orb.voiceError) {
            try {
                state.orb.speechRecognition.start();
                console.log('[VTID-01037] Recognition restarted after TTS');
            } catch (e) {
                console.warn('[VTID-01037] Recognition already running:', e);
            }
        }
    }, 250);

    renderApp();
}

/**
 * VTID-01066: Stop TTS playback and clear speaking state
 * VTID-01155: Updated to also cancel Gemini-TTS audio
 * @param {string} reason - 'user' | 'voice_interrupt' | 'error'
 */
function orbStopTTS(reason) {
    console.log('[VTID-01066] Stopping TTS, reason:', reason);

    // VTID-01155: Cancel Gemini-TTS audio if playing
    if (state.orb.geminiTtsAudio) {
        try {
            state.orb.geminiTtsAudio.pause();
            state.orb.geminiTtsAudio.currentTime = 0;
            state.orb.geminiTtsAudio = null;
            console.log('[VTID-01155] Gemini-TTS audio cancelled');
        } catch (e) {
            console.warn('[VTID-01155] Could not cancel Gemini-TTS audio:', e);
        }
    }

    // Cancel browser speechSynthesis
    if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
    }

    // Stop speaking beat
    stopSpeakingBeat();
    setOrbMicroStatus('');

    // Clear speaking state
    state.orb.speaking = false;
    state.orb.speakingMessageId = null;
    state.orb.speakingDurationClass = null;

    // VTID-01066: Add system message only once per interrupt (not for errors)
    if (reason === 'user' || reason === 'voice_interrupt') {
        // Check if last message is already an interrupted system message
        var lastMsg = state.orb.liveTranscript[state.orb.liveTranscript.length - 1];
        if (!lastMsg || lastMsg.role !== 'system' || lastMsg.text !== 'Interrupted.') {
            state.orb.liveTranscript.push({
                id: Date.now(),
                role: 'system',
                text: 'Interrupted.',
                timestamp: new Date().toISOString()
            });
        }
    }

    // Update voice state
    state.orb.voiceState = 'LISTENING';
    setOrbState('ready');

    // Re-render to update UI
    renderApp();

    // Restart recognition after a short delay
    setTimeout(function() {
        if (state.orb.overlayVisible && state.orb.speechRecognition &&
            state.orb.voiceState !== 'MUTED' && !state.orb.voiceError) {
            try {
                state.orb.speechRecognition.start();
                console.log('[VTID-01066] Recognition restarted after TTS stop');
            } catch (e) {
                console.warn('[VTID-01066] Recognition already running:', e);
            }
        }
    }, 250);
}

/**
 * VTID-0135: Speak text using TTS (speechSynthesis)
 * VTID-01037: Implements TTS/STT coordination to prevent feedback loop
 * VTID-01038: Updated to use selected voice
 * VTID-01066: Updated to track speaking message and duration class
 * VTID-01155: Updated to use Gemini-TTS as primary, browser TTS as fallback
 * Implements barge-in: stops speaking when user starts talking
 */
function orbVoiceSpeak(text) {
    if (!text) return;

    console.log('[VTID-0135] Speaking:', text.substring(0, 50) + '...');

    // VTID-01037: Set feedback prevention state BEFORE TTS starts
    state.orb.speaking = true;
    state.orb.ignoreSTTUntil = Date.now() + 800; // Guard against immediate echo
    state.orb.lastTTSText = text;

    // VTID-01066: Calculate duration bucket from text length
    // durationMs = clamp(lenChars * 35ms, 1200, 12000)
    var lenChars = text.length;
    var durationMs = Math.max(1200, Math.min(lenChars * 35, 12000));
    var durClass;
    if (durationMs <= 1500) {
        durClass = 'speak-dur-1'; // 1.5s
    } else if (durationMs <= 3000) {
        durClass = 'speak-dur-2'; // 3s
    } else if (durationMs <= 6000) {
        durClass = 'speak-dur-3'; // 6s
    } else {
        durClass = 'speak-dur-4'; // 10s
    }
    state.orb.speakingDurationClass = durClass;

    // VTID-01066: Find the most recent assistant message to mark as speaking
    var recentAssistantMsg = null;
    for (var i = state.orb.liveTranscript.length - 1; i >= 0; i--) {
        if (state.orb.liveTranscript[i].role === 'assistant' && !state.orb.liveTranscript[i].isThinking) {
            recentAssistantMsg = state.orb.liveTranscript[i];
            break;
        }
    }
    if (recentAssistantMsg) {
        state.orb.speakingMessageId = recentAssistantMsg.id;
        console.log('[VTID-01066] Marking message as speaking:', recentAssistantMsg.id, 'duration:', durClass);
    }

    // VTID-01037: Stop recognition cleanly before TTS to prevent self-hearing
    // VTID-01044: Set flag so onend doesn't auto-restart (restartRecognitionAfterTTS will handle it)
    if (state.orb.speechRecognition) {
        state.orb.abortedForTTS = true; // VTID-01044: Signal that this abort is for TTS
        try {
            state.orb.speechRecognition.abort();
            console.log('[VTID-01037] Recognition aborted before TTS');
        } catch (e) {
            console.warn('[VTID-01037] Could not abort recognition:', e);
            state.orb.abortedForTTS = false; // Reset if abort failed
        }
    }

    // VTID-01155: Use Gemini-TTS as primary method
    orbVoiceSpeakWithGeminiTts(text);
}

/**
 * VTID-01155: Speak text using Gemini-TTS endpoint
 * Falls back to browser speechSynthesis if Gemini-TTS fails
 */
async function orbVoiceSpeakWithGeminiTts(text) {
    var lang = state.orb.orbLang || 'en-US';
    console.log('[VTID-01155] Using Gemini-TTS for language:', lang);

    // Set speaking state
    state.orb.voiceState = 'SPEAKING';
    setOrbState('speaking');
    startSpeakingBeat();
    setOrbMicroStatus('Speaking...', 0);
    renderOrbBadges();
    renderApp();

    try {
        var response = await fetch('/api/v1/orb/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                lang: lang,
                voice_style: 'friendly, calm, empathetic'
            })
        });

        var data = await response.json();
        if (!data.ok) {
            console.warn('[VTID-01155] Gemini-TTS failed, falling back to browser:', data.error);
            orbVoiceSpeakWithBrowserTts(text);
            return;
        }

        // Play audio from base64
        if (data.audio_b64) {
            var audio = new Audio('data:' + (data.mime || 'audio/mp3') + ';base64,' + data.audio_b64);

            // Store reference for barge-in cancellation
            state.orb.geminiTtsAudio = audio;

            // VTID-01155: Safety timeout - if audio doesn't complete in 60 seconds, force end
            var geminiTtsSafetyTimeout = setTimeout(function() {
                console.warn('[VTID-01155] Gemini-TTS safety timeout - forcing end');
                if (state.orb.geminiTtsAudio === audio && state.orb.voiceState === 'SPEAKING') {
                    audio.pause();
                    state.orb.geminiTtsAudio = null;
                    orbVoiceSpeakEnded();
                }
            }, 60000);

            audio.onended = function() {
                clearTimeout(geminiTtsSafetyTimeout);
                console.log('[VTID-01155] Gemini-TTS playback ended');
                state.orb.geminiTtsAudio = null;
                orbVoiceSpeakEnded();
            };

            audio.onerror = function(e) {
                clearTimeout(geminiTtsSafetyTimeout);
                console.error('[VTID-01155] Gemini-TTS audio error:', e);
                state.orb.geminiTtsAudio = null;
                orbVoiceSpeakEnded();
            };

            audio.play().catch(function(e) {
                clearTimeout(geminiTtsSafetyTimeout);
                console.warn('[VTID-01155] Gemini-TTS playback failed, falling back to browser:', e);
                state.orb.geminiTtsAudio = null;
                orbVoiceSpeakWithBrowserTts(text);
            });
        } else {
            console.warn('[VTID-01155] No audio data, falling back to browser');
            orbVoiceSpeakWithBrowserTts(text);
        }

    } catch (error) {
        console.warn('[VTID-01155] Gemini-TTS error, falling back to browser:', error);
        orbVoiceSpeakWithBrowserTts(text);
    }
}

/**
 * VTID-01155: Fallback browser TTS using speechSynthesis
 */
function orbVoiceSpeakWithBrowserTts(text) {
    if (!window.speechSynthesis) {
        console.warn('[VTID-01155] Browser speechSynthesis not available');
        orbVoiceSpeakEnded();
        return;
    }

    console.log('[VTID-01155] Using browser speechSynthesis fallback');

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    var utterance = new SpeechSynthesisUtterance(text);
    // VTID-01042: Use unified language setting for TTS
    utterance.lang = state.orb.orbLang;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // VTID-01038: Apply selected voice
    var selectedVoice = orbGetSelectedVoice();
    if (selectedVoice) {
        utterance.voice = selectedVoice;
        console.log('[VTID-01038] Using voice:', selectedVoice.name);
    }

    utterance.onstart = function() {
        console.log('[VTID-0135] Browser TTS started');
    };

    // VTID-01155: Safety timeout - if TTS doesn't complete in 30 seconds, force end
    // This prevents the conversation from getting stuck if TTS fails silently
    var ttsSafetyTimeout = setTimeout(function() {
        console.warn('[VTID-01155] Browser TTS safety timeout - forcing end');
        if (state.orb.voiceState === 'SPEAKING') {
            window.speechSynthesis.cancel();
            orbVoiceSpeakEnded();
        }
    }, 30000);

    utterance.onerror = function(event) {
        clearTimeout(ttsSafetyTimeout);
        console.error('[VTID-0135] Browser TTS error:', event.error);
        // VTID-01155: Always call orbVoiceSpeakEnded on error to prevent blocking
        // Only skip for 'interrupted' during intentional barge-in cancellation
        if (event.error !== 'interrupted') {
            orbVoiceSpeakEnded();
        }
    };

    utterance.onend = function() {
        clearTimeout(ttsSafetyTimeout);
        console.log('[VTID-0135] Browser TTS ended');
        orbVoiceSpeakEnded();
    };

    state.orb.speechSynthesisUtterance = utterance;
    window.speechSynthesis.speak(utterance);
}

/**
 * VTID-01155: Common handler for TTS end (both Gemini and browser)
 */
function orbVoiceSpeakEnded() {
    console.log('[VTID-01155] TTS ended');

    // Stop speaking beat timer
    stopSpeakingBeat();
    setOrbMicroStatus(''); // Clear micro-status

    state.orb.speaking = false;
    state.orb.speakingMessageId = null;
    state.orb.speakingDurationClass = null;

    // VTID-01037: Restart recognition after TTS completes
    if (state.orb.overlayVisible && state.orb.voiceState === 'SPEAKING') {
        restartRecognitionAfterTTS();
    }
}

/**
 * VTID-0135: Get display label for voice state
 */
function getVoiceStateLabel(voiceState) {
    switch (voiceState) {
        case 'LISTENING': return 'LISTENING';
        case 'THINKING': return 'THINKING';
        case 'SPEAKING': return 'SPEAKING';
        case 'MUTED': return 'MUTED';
        default: return 'READY';
    }
}

/**
 * VTID-0135: Get CSS class for voice state
 */
function getVoiceStateClass(voiceState) {
    switch (voiceState) {
        case 'LISTENING': return 'orb-state-listening';
        case 'THINKING': return 'orb-state-thinking';
        case 'SPEAKING': return 'orb-state-speaking';
        case 'MUTED': return 'orb-state-muted';
        default: return 'orb-state-idle';
    }
}

/**
 * VTID-01064: Set ORB aura state
 * Single source of truth for ORB visual state.
 * Valid states: ready | listening | thinking | speaking | paused | connecting | error
 * @param {string} newState - The new ORB state
 */
function setOrbState(newState) {
    var validStates = ['ready', 'listening', 'thinking', 'speaking', 'paused', 'connecting', 'error'];
    if (validStates.indexOf(newState) === -1) {
        console.warn('[VTID-01064] Invalid ORB state:', newState);
        return;
    }

    var shell = document.querySelector('.orb-shell');
    if (!shell) {
        console.warn('[VTID-01064] ORB shell not found');
        return;
    }

    // Remove any existing orb-- class
    validStates.forEach(function(s) {
        shell.classList.remove('orb--' + s);
    });

    // Add the new state class
    shell.classList.add('orb--' + newState);
    console.log('[VTID-01064] ORB state changed to:', newState);
}

/**
 * VTID-01067: Render ORB context badges
 * Updates badge visibility via class toggles only.
 */
function renderOrbBadges() {
    var badgesContainer = document.querySelector('.orb-badges');
    if (!badgesContainer) return;

    // Get current state
    var isMuted = state.orb.voiceState === 'MUTED';
    var micActive = state.orb.micActive && !isMuted;
    var screenActive = state.orb.screenShareActive;
    var cameraActive = state.orb.cameraActive;
    var langCode = state.orb.orbLang ? state.orb.orbLang.split('-')[0].toUpperCase() : 'EN';

    // Update mic badge (always show one or the other)
    var micBadge = badgesContainer.querySelector('.orb-badge--mic');
    var micMutedBadge = badgesContainer.querySelector('.orb-badge--mic-muted');

    if (micBadge) {
        if (micActive) {
            micBadge.classList.add('orb-badge--active');
            micBadge.classList.remove('orb-badge--hidden');
        } else {
            micBadge.classList.remove('orb-badge--active');
        }
    }
    if (micMutedBadge) {
        if (isMuted || !state.orb.micActive) {
            micMutedBadge.classList.add('orb-badge--active');
            micMutedBadge.classList.remove('orb-badge--hidden');
        } else {
            micMutedBadge.classList.remove('orb-badge--active');
        }
    }

    // Update screen share badge (only show when active)
    var screenBadge = badgesContainer.querySelector('.orb-badge--screen');
    if (screenBadge) {
        if (screenActive) {
            screenBadge.classList.add('orb-badge--active');
            screenBadge.classList.remove('orb-badge--hidden');
        } else {
            screenBadge.classList.remove('orb-badge--active');
        }
    }

    // Update camera badge (only show when active)
    var cameraBadge = badgesContainer.querySelector('.orb-badge--camera');
    if (cameraBadge) {
        if (cameraActive) {
            cameraBadge.classList.add('orb-badge--active');
            cameraBadge.classList.remove('orb-badge--hidden');
        } else {
            cameraBadge.classList.remove('orb-badge--active');
        }
    }

    // Update language badge (always show)
    var langBadge = badgesContainer.querySelector('.orb-badge--lang');
    if (langBadge) {
        var langText = langBadge.querySelector('.orb-badge-text');
        if (langText) {
            langText.textContent = langCode;
        }
        langBadge.classList.add('orb-badge--active');
    }
}

/**
 * VTID-01067: Set micro-status line text
 * Auto-clears after TTL. Overwrites any existing message.
 * @param {string} text - The status text to display
 * @param {number} ttlMs - Time to live in milliseconds (default 1500)
 */
function setOrbMicroStatus(text, ttlMs) {
    if (ttlMs === undefined) ttlMs = 1500;

    // Clear any existing timer
    if (state.orb.microStatusTimer) {
        clearTimeout(state.orb.microStatusTimer);
        state.orb.microStatusTimer = null;
    }

    state.orb.microStatusText = text || '';

    var statusEl = document.querySelector('.orb-micro-status');
    if (!statusEl) return;

    if (text) {
        statusEl.textContent = text;
        statusEl.classList.add('orb-micro-status--visible');

        // Determine status color class based on current voice state
        statusEl.classList.remove('orb-micro-status--listening', 'orb-micro-status--thinking',
            'orb-micro-status--speaking', 'orb-micro-status--muted', 'orb-micro-status--error');

        if (state.orb.voiceError || state.orb.liveError) {
            statusEl.classList.add('orb-micro-status--error');
        } else if (state.orb.voiceState === 'SPEAKING') {
            statusEl.classList.add('orb-micro-status--speaking');
        } else if (state.orb.voiceState === 'THINKING') {
            statusEl.classList.add('orb-micro-status--thinking');
        } else if (state.orb.voiceState === 'MUTED') {
            statusEl.classList.add('orb-micro-status--muted');
        } else if (state.orb.voiceState === 'LISTENING') {
            statusEl.classList.add('orb-micro-status--listening');
        }

        // Set auto-clear timer
        if (ttlMs > 0) {
            state.orb.microStatusTimer = setTimeout(function() {
                state.orb.microStatusText = '';
                statusEl.classList.remove('orb-micro-status--visible');
                state.orb.microStatusTimer = null;
            }, ttlMs);
        }
    } else {
        statusEl.classList.remove('orb-micro-status--visible');
    }
}

/**
 * VTID-01067: Start speaking beat timer
 * Pulses every ~420ms while TTS is active.
 */
function startSpeakingBeat() {
    // Clear any existing timer
    stopSpeakingBeat();

    var shell = document.querySelector('.orb-shell');
    if (!shell) return;

    state.orb.speakingBeatTimer = setInterval(function() {
        shell.classList.toggle('orb-speak-beat');
    }, 420);

    console.log('[VTID-01067] Speaking beat started');
}

/**
 * VTID-01067: Stop speaking beat timer
 */
function stopSpeakingBeat() {
    if (state.orb.speakingBeatTimer) {
        clearInterval(state.orb.speakingBeatTimer);
        state.orb.speakingBeatTimer = null;
    }

    var shell = document.querySelector('.orb-shell');
    if (shell) {
        shell.classList.remove('orb-speak-beat');
    }

    console.log('[VTID-01067] Speaking beat stopped');
}

/**
 * VTID-01067: Trigger mic-reactive shimmer
 * Called on speech recognition audio events.
 */
function triggerMicShimmer() {
    var shell = document.querySelector('.orb-shell');
    if (!shell) return;

    // Add shimmer class briefly
    shell.classList.add('orb-mic-active');
    state.orb.micShimmerActive = true;

    // Remove after animation completes
    setTimeout(function() {
        shell.classList.remove('orb-mic-active');
        state.orb.micShimmerActive = false;
    }, 300);
}

/**
 * VTID-0150-B: Scrolls the ORB chat messages to the bottom
 */
function scrollOrbChatToBottom() {
    var container = document.querySelector('.orb-chat-messages');
    if (!container) return;
    container.scrollTop = container.scrollHeight;
}

/**
 * VTID-0150-B: Sends a message to the Assistant Core API
 * @param {string} text - The message to send
 * @param {Object} context - Additional context (route, selectedId)
 * @returns {Promise<Object>} - The API response
 */
async function sendOrbMessage(text, context) {
    var res = await fetch('/api/v1/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: text,
            sessionId: state.orb.sessionId || null,
            role: 'DEV',
            tenant: 'Vitana-Dev',
            route: context.route || state.currentModuleKey || '',
            selectedId: context.selectedId || ''
        })
    });
    var data = await res.json();
    if (data.sessionId && !state.orb.sessionId) {
        state.orb.sessionId = data.sessionId;
        console.log('[ORB] Session established:', data.sessionId);
    }
    return data;
}

/**
 * VTID-0150-B: Sends a message in the ORB chat (calls Assistant Core API)
 * @param {string} message - The message to send
 */
function orbSendMessage(message) {
    if (!message || !message.trim()) return;

    console.log('[ORB] Sending message:', message);

    // Add user message immediately
    state.orb.chatMessages.push({
        id: Date.now(),
        role: 'user',
        content: message.trim(),
        timestamp: new Date().toISOString()
    });

    // Clear input and show thinking state
    state.orb.chatInputValue = '';
    state.orb.isThinking = true;
    renderApp();
    scrollOrbChatToBottom();

    // Build context from current state
    var context = {
        route: state.currentModuleKey || '',
        selectedId: state.selectedTaskId || ''
    };

    // Call Assistant Core API
    sendOrbMessage(message.trim(), context)
        .then(function(data) {
            console.log('[ORB] Response received:', data.ok ? 'success' : 'error');

            // Add assistant response
            state.orb.chatMessages.push({
                id: Date.now() + 1,
                role: 'assistant',
                content: data.reply || 'I could not generate a response.',
                timestamp: new Date().toISOString(),
                meta: data.meta
            });
            state.orb.isThinking = false;
            renderApp();
            scrollOrbChatToBottom();
        })
        .catch(function(error) {
            console.error('[ORB] API error:', error);

            // Add error message
            state.orb.chatMessages.push({
                id: Date.now() + 1,
                role: 'assistant',
                content: 'I encountered an error while processing your request. Please try again.',
                timestamp: new Date().toISOString()
            });
            state.orb.isThinking = false;
            renderApp();
            scrollOrbChatToBottom();
        });
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
    console.log('App v4 starting...');
    try {
        // Init Router
        const route = getRouteFromPath(window.location.pathname);
        state.currentModuleKey = route.section;
        state.currentTab = route.tab;

        // If current path is not valid or is root, replace with calculated path
        const section = NAVIGATION_CONFIG.find(s => s.section === route.section);
        const tab = section ? section.tabs.find(t => t.key === route.tab) : null;
        if (tab && window.location.pathname !== tab.path) {
            history.replaceState(null, '', tab.path);
        }

        renderApp();

        // VTID-01049: Load Me Context (authoritative role) on boot
        fetchMeContext().then(function(result) {
            if (!result.ok && result.error) {
                // Only show toast for 404/500 errors, not for 401 (not signed in)
                if (result.error !== 'Not signed in') {
                    showToast(result.error, 'error');
                }
            }
            // Re-render to update profile badge with authoritative role
            renderApp();
        }).catch(function(err) {
            console.error('[VTID-01049] fetchMeContext failed:', err);
        });

        // VTID-01171: Fetch auth identity for profile display
        fetchAuthMe().then(function(data) {
            if (data) {
                console.log('[VTID-01171] Auth identity loaded:', data.identity?.email);
            }
            // Re-render to update profile capsule with real data
            renderApp();
        }).catch(function(err) {
            console.error('[VTID-01171] fetchAuthMe failed:', err);
        });

        fetchTasks();

        // VTID-01049: Initialize me context (authoritative role + identity)
        initMeContext();

        // VTID-01038: Load TTS voices for ORB
        orbLoadTtsVoices();

        // VTID-0527: Fetch telemetry snapshot for task stage timelines
        fetchTelemetrySnapshot();

        // VTID-0520: Start CI/CD health polling
        startCicdHealthPolling();

        // VTID-01151: Fetch initial approvals (silent) and start polling (20s)
        fetchApprovals(true);
        startApprovalsBadgePolling();

        // VTID-01180: Fetch autopilot recommendations count for badge
        fetchAutopilotRecommendationsCount();
    } catch (e) {
        console.error('Critical Render Error:', e);
        document.body.innerHTML = `<div class="critical-error"><h1>Critical Error</h1><pre>${e.stack}</pre></div>`;
    }
});
