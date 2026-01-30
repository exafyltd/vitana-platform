/**
 * VTID-01218A: Voice LAB Application
 * ORB Live Operations UI
 */

const VoiceLab = (function() {
  // State
  let sessions = [];
  let currentSession = null;
  let currentTurns = [];
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

  // Drawer Functions
  async function openSession(sessionId) {
    elements.drawer.classList.remove('vlab-drawer-hidden');
    elements.drawerBody.innerHTML = '<p class="vlab-text-muted vlab-text-center">Loading session details...</p>';

    // Fetch session detail and turns in parallel
    const [session, turns] = await Promise.all([
      fetchSessionDetail(sessionId),
      fetchSessionTurns(sessionId),
    ]);

    currentSession = session;
    currentTurns = turns;

    renderSessionDrawer();
  }

  function closeDrawer() {
    elements.drawer.classList.add('vlab-drawer-hidden');
    currentSession = null;
    currentTurns = [];
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
