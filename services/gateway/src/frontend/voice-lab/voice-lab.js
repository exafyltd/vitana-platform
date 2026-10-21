/**
 * VTID-01218A: Voice LAB Application
 * ORB Live Operations UI
 */

const VoiceLab = (function() {
  // State
  let sessions = [];
  let currentSession = null;
  let currentTurns = [];
  let currentDiagnostics = null;
  let statusFilter = 'all';

  // DOM Elements
  const elements = {
    statusFilter: null,
    refreshBtn: null,
    sessionCount: null,
    lastUpdated: null,
    sessionsTbody: null,
    drawer: null,
    drawerBody: null,
    drawerOverlay: null,
    drawerCloseBtn: null,
  };

  // Initialize
  function init() {
    // Get DOM elements
    elements.statusFilter = document.getElementById('status-filter');
    elements.refreshBtn = document.getElementById('refresh-btn');
    elements.sessionCount = document.getElementById('session-count');
    elements.lastUpdated = document.getElementById('last-updated');
    elements.sessionsTbody = document.getElementById('sessions-tbody');
    elements.drawer = document.getElementById('session-drawer');
    elements.drawerBody = document.getElementById('drawer-body');
    elements.drawerOverlay = document.getElementById('drawer-overlay');
    elements.drawerCloseBtn = document.getElementById('drawer-close-btn');

    // Bind events
    elements.statusFilter.addEventListener('change', onStatusFilterChange);
    elements.refreshBtn.addEventListener('click', refreshSessions);

    // CSP-compliant drawer close handlers
    elements.drawerOverlay.addEventListener('click', closeDrawer);
    elements.drawerCloseBtn.addEventListener('click', closeDrawer);

    // CSP-compliant event delegation for session details buttons
    elements.sessionsTbody.addEventListener('click', function(e) {
      const btn = e.target.closest('[data-session-id]');
      if (btn) {
        const sessionId = btn.getAttribute('data-session-id');
        openSession(sessionId);
      }
    });

    // Initial load
    refreshSessions();

    // Auto-refresh every 30 seconds
    setInterval(refreshSessions, 30000);
  }

  // Event Handlers
  function onStatusFilterChange(e) {
    statusFilter = e.target.value;
    refreshSessions();
  }

  // API Calls
  async function fetchSessions() {
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        limit: '50',
      });
      const response = await fetch(`/api/v1/voice-lab/live/sessions?${params}`);
      const data = await response.json();

      if (data.ok) {
        return data.sessions || [];
      } else {
        console.error('[VoiceLab] Error fetching sessions:', data.error);
        return [];
      }
    } catch (err) {
      console.error('[VoiceLab] Network error:', err);
      return [];
    }
  }

  async function fetchSessionDetail(sessionId) {
    try {
      const response = await fetch(`/api/v1/voice-lab/live/sessions/${sessionId}`);
      const data = await response.json();

      if (data.ok) {
        return data.session;
      } else {
        console.error('[VoiceLab] Error fetching session:', data.error);
        return null;
      }
    } catch (err) {
      console.error('[VoiceLab] Network error:', err);
      return null;
    }
  }

  async function fetchSessionTurns(sessionId) {
    try {
      const response = await fetch(`/api/v1/voice-lab/live/sessions/${sessionId}/turns`);
      const data = await response.json();

      if (data.ok) {
        return data.turns || [];
      } else {
        console.error('[VoiceLab] Error fetching turns:', data.error);
        return [];
      }
    } catch (err) {
      console.error('[VoiceLab] Network error:', err);
      return [];
    }
  }

  async function fetchSessionDiagnostics(sessionId) {
    try {
      var response = await fetch('/api/v1/voice-lab/live/sessions/' + sessionId + '/diagnostics');
      var data = await response.json();
      if (data.ok) {
        return data;
      } else {
        console.error('[VoiceLab] Error fetching diagnostics:', data.error);
        return null;
      }
    } catch (err) {
      console.error('[VoiceLab] Network error:', err);
      return null;
    }
  }

  // Refresh Sessions
  async function refreshSessions() {
    elements.sessionsTbody.innerHTML = '<tr class="vlab-loading-row"><td colspan="9">Loading sessions...</td></tr>';

    sessions = await fetchSessions();
    renderSessionsTable();

    elements.sessionCount.textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;
    elements.lastUpdated.textContent = `Updated ${formatTime(new Date())}`;
  }

  // Render Functions
  function renderSessionsTable() {
    if (sessions.length === 0) {
      elements.sessionsTbody.innerHTML = '<tr class="vlab-empty-row"><td colspan="9">No sessions found</td></tr>';
      return;
    }

    const rows = sessions.map(session => {
      const statusClass = session.status === 'active' ? 'vlab-badge-active' : 'vlab-badge-ended';
      const duration = session.duration_ms ? formatDuration(session.duration_ms) : '--';

      return `
        <tr>
          <td><span class="vlab-session-id">${truncateId(session.session_id)}</span></td>
          <td><span class="vlab-badge ${statusClass}">${session.status}</span></td>
          <td>${formatTime(new Date(session.started_at))}</td>
          <td>${duration}</td>
          <td>${session.turn_count}</td>
          <td>${session.audio_in_chunks}</td>
          <td>${session.audio_out_chunks}</td>
          <td>${session.interrupted_count}</td>
          <td>
            <button class="vlab-btn vlab-btn-secondary vlab-btn-sm" data-session-id="${session.session_id}">
              Details
            </button>
          </td>
        </tr>
      `;
    }).join('');

    elements.sessionsTbody.innerHTML = rows;
  }

  function renderSessionDrawer() {
    if (!currentSession) {
      elements.drawerBody.innerHTML = '<p>Session not found</p>';
      return;
    }

    const s = currentSession;
    const duration = s.duration_ms ? formatDuration(s.duration_ms) : 'Active';
    const statusClass = s.status === 'active' ? 'vlab-badge-active' : 'vlab-badge-ended';

    let html = `
      <!-- Session Info -->
      <div class="vlab-detail-section">
        <h3>Session Info</h3>
        <div class="vlab-detail-grid">
          <div class="vlab-detail-item">
            <div class="vlab-detail-label">Session ID</div>
            <div class="vlab-detail-value vlab-session-id">${s.session_id}</div>
          </div>
          <div class="vlab-detail-item">
            <div class="vlab-detail-label">Status</div>
            <div class="vlab-detail-value"><span class="vlab-badge ${statusClass}">${s.status}</span></div>
          </div>
          <div class="vlab-detail-item">
            <div class="vlab-detail-label">Started</div>
            <div class="vlab-detail-value">${formatDateTime(new Date(s.started_at))}</div>
          </div>
          <div class="vlab-detail-item">
            <div class="vlab-detail-label">Duration</div>
            <div class="vlab-detail-value">${duration}</div>
          </div>
          <div class="vlab-detail-item">
            <div class="vlab-detail-label">Language</div>
            <div class="vlab-detail-value">${s.lang || '--'}</div>
          </div>
          <div class="vlab-detail-item">
            <div class="vlab-detail-label">Transport</div>
            <div class="vlab-detail-value">${s.transport}</div>
          </div>
          ${(s.vitana_id || s.user_id) ? `
          <div class="vlab-detail-item">
            <div class="vlab-detail-label">User</div>
            <div class="vlab-detail-value" title="${s.user_id || ''}">
              ${s.vitana_id ? `<strong class="vlab-vitana-id">@${escapeHtml(s.vitana_id)}</strong>` : ''}
              ${s.vitana_id && s.user_id ? '<span class="vlab-detail-secondary"> · </span>' : ''}
              ${s.user_id ? `<span class="vlab-detail-secondary">${truncateId(s.user_id)}</span>` : ''}
            </div>
          </div>
          ` : ''}
        </div>
      </div>

      <!-- Metrics -->
      <div class="vlab-detail-section">
        <h3>Metrics</h3>
        <div class="vlab-metrics-row">
          <div class="vlab-metric-card">
            <div class="vlab-metric-value">${s.turn_count}</div>
            <div class="vlab-metric-label">Turns</div>
          </div>
          <div class="vlab-metric-card">
            <div class="vlab-metric-value">${s.audio_in_chunks}</div>
            <div class="vlab-metric-label">Audio In</div>
          </div>
          <div class="vlab-metric-card">
            <div class="vlab-metric-value">${s.audio_out_chunks}</div>
            <div class="vlab-metric-label">Audio Out</div>
          </div>
          <div class="vlab-metric-card">
            <div class="vlab-metric-value">${s.interrupted_count}</div>
            <div class="vlab-metric-label">Interrupts</div>
          </div>
        </div>
        <div class="vlab-metrics-row vlab-mt-sm">
          <div class="vlab-metric-card">
            <div class="vlab-metric-value">${s.input_rate || 16000}</div>
            <div class="vlab-metric-label">Input Rate</div>
          </div>
          <div class="vlab-metric-card">
            <div class="vlab-metric-value">${s.output_rate || 24000}</div>
            <div class="vlab-metric-label">Output Rate</div>
          </div>
          <div class="vlab-metric-card">
            <div class="vlab-metric-value">${s.video_frames || 0}</div>
            <div class="vlab-metric-label">Video Frames</div>
          </div>
          <div class="vlab-metric-card">
            <div class="vlab-metric-value">${s.error_count}</div>
            <div class="vlab-metric-label">Errors</div>
          </div>
        </div>
      </div>

      <!-- Turn Timeline -->
      <div class="vlab-detail-section">
        <h3>Turn Timeline</h3>
        <div class="vlab-timeline" id="turn-timeline">
          ${renderTurnTimeline()}
        </div>
      </div>
    `;

    // Pipeline Diagnostics section
    html += renderPipelineDiagnostics();

    // Errors section (if any)
    if (s.errors && s.errors.length > 0) {
      html += `
        <div class="vlab-detail-section">
          <h3>Errors</h3>
          <ul class="vlab-error-list">
            ${s.errors.map(err => `
              <li class="vlab-error-item">
                <div class="vlab-error-code">${err.error_code}</div>
                <div class="vlab-error-message">${err.error_message}</div>
                <div class="vlab-error-time">${formatDateTime(new Date(err.timestamp))}</div>
              </li>
            `).join('')}
          </ul>
        </div>
      `;
    }

    elements.drawerBody.innerHTML = html;
  }

  function renderTurnTimeline() {
    if (currentTurns.length === 0) {
      return '<p class="vlab-text-muted">No turns recorded</p>';
    }

    return currentTurns.map(turn => {
      const dotClass = turn.was_interrupted
        ? 'vlab-timeline-dot-interrupted'
        : (turn.ended_at ? 'vlab-timeline-dot-completed' : '');

      const turnDuration = turn.turn_ms ? `${turn.turn_ms}ms` : '--';
      const firstAudio = turn.first_audio_ms ? `${turn.first_audio_ms}ms` : '--';
      const endSource = turn.end_turn_source || 'unknown';

      return `
        <div class="vlab-timeline-item">
          <div class="vlab-timeline-dot ${dotClass}"></div>
          <div class="vlab-timeline-content">
            <div class="vlab-timeline-title">Turn ${turn.turn_number}</div>
            <div class="vlab-timeline-meta">${formatTime(new Date(turn.started_at))} - ${endSource}</div>
            <div class="vlab-timeline-metrics">
              <span>Duration: ${turnDuration}</span>
              <span>First Audio: ${firstAudio}</span>
              ${turn.playback_clear_triggered ? '<span class="vlab-text-warning">Playback Cleared</span>' : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Pipeline Diagnostics Rendering
  function renderPipelineDiagnostics() {
    if (!currentDiagnostics || !currentDiagnostics.diagnostics || currentDiagnostics.diagnostics.length === 0) {
      return '<div class="vlab-detail-section">' +
        '<h3>Pipeline Diagnostics</h3>' +
        '<p class="vlab-text-muted">No diagnostic events recorded for this session</p>' +
        '</div>';
    }

    var diags = currentDiagnostics.diagnostics;
    var analysis = currentDiagnostics.analysis;
    var html = '<div class="vlab-detail-section">';
    html += '<h3>Pipeline Diagnostics</h3>';

    // Analysis banner
    if (analysis && analysis.stall_detected) {
      html += '<div class="vlab-diag-alert vlab-diag-alert-error">' +
        '<div class="vlab-diag-alert-title">STALL DETECTED: ' + escapeHtml(analysis.stall_type || '') + '</div>' +
        '<div class="vlab-diag-alert-desc">' + escapeHtml(analysis.stall_description || '') + '</div>' +
        '</div>';
    } else if (analysis && analysis.total_events > 0) {
      html += '<div class="vlab-diag-alert vlab-diag-alert-ok">' +
        '<div class="vlab-diag-alert-title">Pipeline OK</div>' +
        '<div class="vlab-diag-alert-desc">All expected stages completed (' + analysis.total_events + ' events)</div>' +
        '</div>';
    }

    // Pipeline flow checkmarks
    if (analysis && analysis.flow) {
      var flow = analysis.flow;
      html += '<div class="vlab-diag-flow">';
      var stages = [
        { key: 'greeting_sent', label: 'Greeting' },
        { key: 'model_start_speaking', label: 'Model Speaking' },
        { key: 'turn_complete', label: 'Turn Complete' },
        { key: 'input_transcription', label: 'User Input' },
        { key: 'watchdog_fired', label: 'Watchdog Fired', isError: true },
        { key: 'upstream_ws_error', label: 'WS Error', isError: true },
        { key: 'upstream_ws_close', label: 'WS Close', isError: true },
      ];
      for (var i = 0; i < stages.length; i++) {
        var st = stages[i];
        var reached = flow[st.key];
        var cls = 'vlab-diag-stage';
        if (reached && st.isError) cls += ' vlab-diag-stage-error';
        else if (reached) cls += ' vlab-diag-stage-ok';
        else cls += ' vlab-diag-stage-missing';
        var icon = reached ? (st.isError ? '!' : '\u2713') : '\u2717';
        html += '<div class="' + cls + '">' +
          '<span class="vlab-diag-stage-icon">' + icon + '</span>' +
          '<span class="vlab-diag-stage-label">' + st.label + '</span>' +
          '</div>';
      }
      html += '</div>';
    }

    // Suspicious gaps
    if (analysis && analysis.suspicious_gaps && analysis.suspicious_gaps.length > 0) {
      html += '<div class="vlab-diag-gaps">';
      html += '<div class="vlab-diag-gaps-title">Suspicious Gaps (>5s)</div>';
      for (var g = 0; g < analysis.suspicious_gaps.length; g++) {
        var gap = analysis.suspicious_gaps[g];
        html += '<div class="vlab-diag-gap-item">' +
          escapeHtml(gap.from || '?') + ' \u2192 ' + escapeHtml(gap.to || '?') +
          ': <strong>' + (gap.gap_ms / 1000).toFixed(1) + 's</strong>' +
          '</div>';
      }
      html += '</div>';
    }

    // Event timeline
    html += '<div class="vlab-diag-timeline-title">Event Timeline (' + diags.length + ' events)</div>';
    html += '<div class="vlab-diag-timeline">';

    var firstTs = diags[0].ts;
    for (var j = 0; j < diags.length; j++) {
      var d = diags[j];
      var relMs = d.ts ? (d.ts - firstTs) : 0;
      var relLabel = '+' + (relMs / 1000).toFixed(2) + 's';
      var stageLabel = d.stage || 'unknown';

      // Determine dot color by stage type
      var dotCls = 'vlab-diag-dot';
      if (stageLabel === 'watchdog_fired' || stageLabel === 'upstream_ws_error' || stageLabel === 'audio_forward_failed' || stageLabel === 'audio_no_ws') {
        dotCls += ' vlab-diag-dot-error';
      } else if (stageLabel === 'upstream_ws_close') {
        dotCls += ' vlab-diag-dot-warn';
      } else if (stageLabel === 'turn_complete') {
        dotCls += ' vlab-diag-dot-ok';
      }

      // Build meta info
      var meta = [];
      if (d.turn_count !== undefined) meta.push('turns:' + d.turn_count);
      if (d.audio_in !== undefined) meta.push('in:' + d.audio_in);
      if (d.audio_out !== undefined) meta.push('out:' + d.audio_out);
      if (d.is_model_speaking) meta.push('speaking');
      if (d.has_watchdog) meta.push('watchdog-active');
      if (!d.has_upstream_ws) meta.push('NO-WS');
      if (!d.has_sse) meta.push('NO-SSE');
      if (d.reason) meta.push(d.reason);
      if (d.error) meta.push(d.error);
      if (d.tool_name) meta.push('tool:' + d.tool_name);

      html += '<div class="vlab-diag-event">' +
        '<div class="' + dotCls + '"></div>' +
        '<div class="vlab-diag-event-content">' +
        '<div class="vlab-diag-event-header">' +
        '<span class="vlab-diag-event-stage">' + escapeHtml(stageLabel) + '</span>' +
        '<span class="vlab-diag-event-time">' + relLabel + '</span>' +
        '</div>' +
        (meta.length > 0 ? '<div class="vlab-diag-event-meta">' + escapeHtml(meta.join(' | ')) + '</div>' : '') +
        '</div>' +
        '</div>';
    }

    html += '</div>';
    html += '</div>';
    return html;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Drawer Functions
  async function openSession(sessionId) {
    elements.drawer.classList.remove('vlab-drawer-hidden');
    elements.drawerBody.innerHTML = '<p class="vlab-text-muted vlab-text-center">Loading session details...</p>';

    // Fetch session detail, turns, and diagnostics in parallel
    var results = await Promise.all([
      fetchSessionDetail(sessionId),
      fetchSessionTurns(sessionId),
      fetchSessionDiagnostics(sessionId),
    ]);

    currentSession = results[0];
    currentTurns = results[1];
    currentDiagnostics = results[2];

    renderSessionDrawer();
  }

  function closeDrawer() {
    elements.drawer.classList.add('vlab-drawer-hidden');
    currentSession = null;
    currentTurns = [];
    currentDiagnostics = null;
  }

  // Utility Functions
  function truncateId(id) {
    if (!id) return '--';
    if (id.length <= 20) return id;
    return id.substring(0, 8) + '...' + id.substring(id.length - 8);
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return '--';

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
  }

  function formatTime(date) {
    if (!date || isNaN(date.getTime())) return '--';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatDateTime(date) {
    if (!date || isNaN(date.getTime())) return '--';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API
  return {
    openSession,
    closeDrawer,
    refreshSessions,
  };
})();
