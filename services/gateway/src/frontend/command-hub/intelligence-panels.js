/**
 * VTID-01216: Operator Intelligence Screens
 *
 * UI panels for the Operator Console that provide visibility into:
 * 1. Context Pack Viewer (Memory Garden, Knowledge Hub, Web, Active VTIDs, Policies, Tool Health)
 * 2. Retrieval Trace (router decision, sources queried, latency, hit counts)
 * 3. Tool Calls Panel (tool name, args, duration, result, copy JSON)
 *
 * These panels are shown in the Operator Console to provide transparency
 * into how the unified conversation intelligence layer works.
 */

// =============================================================================
// State
// =============================================================================

const IntelligenceState = {
  isOpen: false,
  activeTab: 'memory', // 'memory', 'knowledge', 'web', 'vtids', 'policies', 'tools'
  contextPack: null,
  toolCalls: [],
  lastRetrievalTrace: null,
};

// =============================================================================
// Context Pack Viewer
// =============================================================================

/**
 * Render the Context Pack Viewer tabs
 */
function renderContextPackTabs() {
  const tabs = [
    { key: 'memory', label: 'Memory Garden', icon: '🧠' },
    { key: 'knowledge', label: 'Knowledge Hub', icon: '📚' },
    { key: 'web', label: 'Web', icon: '🌐' },
    { key: 'vtids', label: 'Active VTIDs', icon: '📋' },
    { key: 'policies', label: 'Policies', icon: '📜' },
    { key: 'tools', label: 'Tool Health', icon: '🔧' },
  ];

  return `
    <div class="intel-tabs">
      ${tabs.map(tab => `
        <button
          class="intel-tab ${IntelligenceState.activeTab === tab.key ? 'active' : ''}"
          onclick="setIntelActiveTab('${tab.key}')"
          title="${tab.label}"
        >
          <span class="tab-icon">${tab.icon}</span>
          <span class="tab-label">${tab.label}</span>
        </button>
      `).join('')}
    </div>
  `;
}

/**
 * Render Memory Garden hits
 */
function renderMemoryHits(memoryHits) {
  if (!memoryHits || memoryHits.length === 0) {
    return '<div class="intel-empty">No memory hits for this turn</div>';
  }

  return `
    <div class="intel-list">
      ${memoryHits.map((hit, index) => `
        <div class="intel-item memory-item">
          <div class="item-header">
            <span class="item-category">${hit.category_key || 'unknown'}</span>
            <span class="item-score">${(hit.relevance_score * 100).toFixed(0)}%</span>
          </div>
          <div class="item-content">${escapeHtml(hit.content)}</div>
          <div class="item-meta">
            <span class="item-source">${hit.source || 'unknown'}</span>
            <span class="item-date">${formatDate(hit.occurred_at)}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Render Knowledge Hub hits
 */
function renderKnowledgeHits(knowledgeHits) {
  if (!knowledgeHits || knowledgeHits.length === 0) {
    return '<div class="intel-empty">No knowledge hits for this turn</div>';
  }

  return `
    <div class="intel-list">
      ${knowledgeHits.map(hit => `
        <div class="intel-item knowledge-item">
          <div class="item-header">
            <span class="item-title">${escapeHtml(hit.title)}</span>
            <span class="item-score">${(hit.relevance_score * 100).toFixed(0)}%</span>
          </div>
          <div class="item-content">${escapeHtml(hit.snippet)}</div>
          <div class="item-meta">
            <span class="item-source">${escapeHtml(hit.source_path)}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Render Web search hits
 */
function renderWebHits(webHits) {
  if (!webHits || webHits.length === 0) {
    return '<div class="intel-empty">No web search results for this turn</div>';
  }

  return `
    <div class="intel-list">
      ${webHits.map(hit => `
        <div class="intel-item web-item">
          <div class="item-header">
            <span class="item-title">${escapeHtml(hit.title)}</span>
            <span class="item-score">${(hit.relevance_score * 100).toFixed(0)}%</span>
          </div>
          <div class="item-content">${escapeHtml(hit.snippet)}</div>
          <div class="item-meta">
            <a href="${hit.url}" target="_blank" class="item-link">${escapeHtml(hit.citation)}</a>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Render Active VTIDs
 */
function renderActiveVTIDs(activeVtids) {
  if (!activeVtids || activeVtids.length === 0) {
    return '<div class="intel-empty">No active VTIDs in context</div>';
  }

  return `
    <div class="intel-list">
      ${activeVtids.map(vtid => `
        <div class="intel-item vtid-item">
          <div class="item-header">
            <span class="item-vtid">${escapeHtml(vtid.vtid)}</span>
            <span class="item-status status-${vtid.status}">${vtid.status}</span>
          </div>
          <div class="item-content">${escapeHtml(vtid.title)}</div>
          ${vtid.priority ? `<div class="item-meta">Priority: ${vtid.priority}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Render Tenant Policies
 */
function renderPolicies(policies) {
  if (!policies || policies.length === 0) {
    return '<div class="intel-empty">No policies applied</div>';
  }

  return `
    <div class="intel-list">
      ${policies.map(policy => `
        <div class="intel-item policy-item">
          <div class="item-header">
            <span class="item-policy-id">${escapeHtml(policy.policy_id)}</span>
            <span class="item-enforced">${policy.enforced ? 'Enforced' : 'Not Enforced'}</span>
          </div>
          <div class="item-content">Type: ${escapeHtml(policy.type)}</div>
          <div class="item-meta">Value: ${JSON.stringify(policy.value)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Render Tool Health
 */
function renderToolHealth(toolHealth) {
  if (!toolHealth || toolHealth.length === 0) {
    return '<div class="intel-empty">No tool health data available</div>';
  }

  return `
    <div class="intel-list">
      ${toolHealth.map(tool => `
        <div class="intel-item tool-health-item ${tool.available ? 'healthy' : 'unhealthy'}">
          <div class="item-header">
            <span class="item-tool-name">${escapeHtml(tool.name)}</span>
            <span class="item-status ${tool.available ? 'status-ok' : 'status-error'}">
              ${tool.available ? 'Available' : 'Unavailable'}
            </span>
          </div>
          ${tool.latency_ms ? `<div class="item-meta">Latency: ${tool.latency_ms}ms</div>` : ''}
          ${tool.error ? `<div class="item-error">${escapeHtml(tool.error)}</div>` : ''}
          <div class="item-meta">Last checked: ${formatDate(tool.last_checked)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Render the active tab content
 */
function renderTabContent() {
  const pack = IntelligenceState.contextPack;

  if (!pack) {
    return '<div class="intel-empty">Send a message to see context pack data</div>';
  }

  switch (IntelligenceState.activeTab) {
    case 'memory':
      return renderMemoryHits(pack.memory_hits);
    case 'knowledge':
      return renderKnowledgeHits(pack.knowledge_hits);
    case 'web':
      return renderWebHits(pack.web_hits);
    case 'vtids':
      return renderActiveVTIDs(pack.active_vtids);
    case 'policies':
      return renderPolicies(pack.tenant_policies);
    case 'tools':
      return renderToolHealth(pack.tool_health);
    default:
      return '<div class="intel-empty">Select a tab</div>';
  }
}

// =============================================================================
// Retrieval Trace Panel
// =============================================================================

/**
 * Render the Retrieval Trace panel
 */
function renderRetrievalTrace() {
  const pack = IntelligenceState.contextPack;
  const trace = pack?.retrieval_trace;

  if (!trace) {
    return '<div class="intel-empty">No retrieval trace available</div>';
  }

  const decision = trace.router_decision;

  return `
    <div class="retrieval-trace">
      <div class="trace-section">
        <div class="trace-header">Router Decision</div>
        <div class="trace-row">
          <span class="trace-label">Matched Rule:</span>
          <span class="trace-value">${escapeHtml(decision.matched_rule)}</span>
        </div>
        <div class="trace-row">
          <span class="trace-label">Rationale:</span>
          <span class="trace-value">${escapeHtml(decision.rationale)}</span>
        </div>
        <div class="trace-row">
          <span class="trace-label">Decided At:</span>
          <span class="trace-value">${formatDate(decision.decided_at)}</span>
        </div>
      </div>

      <div class="trace-section">
        <div class="trace-header">Sources Queried</div>
        <div class="trace-sources">
          ${trace.sources_queried.map(source => `
            <span class="trace-source">${source}</span>
          `).join('')}
        </div>
      </div>

      <div class="trace-section">
        <div class="trace-header">Latencies</div>
        ${Object.entries(trace.latencies).map(([source, latency]) => `
          <div class="trace-row">
            <span class="trace-label">${source}:</span>
            <span class="trace-value">${latency}ms</span>
          </div>
        `).join('')}
      </div>

      <div class="trace-section">
        <div class="trace-header">Hit Counts</div>
        ${Object.entries(trace.hit_counts).map(([source, count]) => `
          <div class="trace-row">
            <span class="trace-label">${source}:</span>
            <span class="trace-value">${count} hits</span>
          </div>
        `).join('')}
      </div>

      <div class="trace-section">
        <div class="trace-header">Token Budget</div>
        <div class="trace-row">
          <span class="trace-label">Used:</span>
          <span class="trace-value">${pack.token_budget?.used || 0} / ${pack.token_budget?.total_budget || 0}</span>
        </div>
        <div class="trace-row">
          <span class="trace-label">Remaining:</span>
          <span class="trace-value">${pack.token_budget?.remaining || 0}</span>
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// Tool Calls Panel
// =============================================================================

/**
 * Render the Tool Calls panel
 */
function renderToolCalls() {
  const toolCalls = IntelligenceState.toolCalls;

  if (!toolCalls || toolCalls.length === 0) {
    return '<div class="intel-empty">No tool calls made in this turn</div>';
  }

  return `
    <div class="tool-calls-list">
      ${toolCalls.map((call, index) => `
        <div class="tool-call-item ${call.success ? 'success' : 'error'}">
          <div class="tool-call-header">
            <span class="tool-name">${escapeHtml(call.name)}</span>
            <span class="tool-status ${call.success ? 'success' : 'error'}">
              ${call.success ? 'Success' : 'Failed'}
            </span>
            <span class="tool-duration">${call.duration_ms}ms</span>
          </div>

          <div class="tool-call-section">
            <div class="section-label">Arguments</div>
            <pre class="tool-json">${escapeHtml(JSON.stringify(call.args, null, 2))}</pre>
            <button class="copy-btn" onclick="copyToClipboard(${index}, 'args')">Copy</button>
          </div>

          <div class="tool-call-section">
            <div class="section-label">Result</div>
            <pre class="tool-json">${escapeHtml(JSON.stringify(call.result, null, 2))}</pre>
            <button class="copy-btn" onclick="copyToClipboard(${index}, 'result')">Copy</button>
          </div>

          ${call.error ? `
            <div class="tool-call-error">
              <div class="section-label">Error</div>
              <div class="error-message">${escapeHtml(call.error)}</div>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

// =============================================================================
// Main Panel
// =============================================================================

/**
 * Render the full Intelligence Panel
 */
function renderIntelligencePanel() {
  if (!IntelligenceState.isOpen) {
    return '';
  }

  return `
    <div class="intelligence-panel">
      <div class="intel-header">
        <h3>Intelligence Inspector</h3>
        <button class="intel-close-btn" onclick="toggleIntelligencePanel()">×</button>
      </div>

      <div class="intel-body">
        <div class="intel-section">
          <div class="intel-section-header">Context Pack</div>
          ${renderContextPackTabs()}
          <div class="intel-tab-content">
            ${renderTabContent()}
          </div>
        </div>

        <div class="intel-section">
          <div class="intel-section-header">Retrieval Trace</div>
          ${renderRetrievalTrace()}
        </div>

        <div class="intel-section">
          <div class="intel-section-header">Tool Calls</div>
          ${renderToolCalls()}
        </div>
      </div>
    </div>
  `;
}

/**
 * Render the Intelligence Panel toggle button
 */
function renderIntelligenceToggle() {
  const pack = IntelligenceState.contextPack;
  const hasData = pack !== null;

  return `
    <button
      class="intel-toggle-btn ${hasData ? 'has-data' : ''}"
      onclick="toggleIntelligencePanel()"
      title="Intelligence Inspector"
    >
      🔍 ${hasData ? `(${pack.memory_hits?.length || 0}/${pack.knowledge_hits?.length || 0})` : 'Intel'}
    </button>
  `;
}

// =============================================================================
// Global Functions (exposed to window)
// =============================================================================

/**
 * Toggle the Intelligence Panel open/closed
 */
function toggleIntelligencePanel() {
  IntelligenceState.isOpen = !IntelligenceState.isOpen;
  updateIntelligenceUI();
}

/**
 * Set the active tab in the Context Pack Viewer
 */
function setIntelActiveTab(tabKey) {
  IntelligenceState.activeTab = tabKey;
  updateIntelligenceUI();
}

/**
 * Update the context pack from a conversation response
 */
function updateContextPack(contextPack) {
  IntelligenceState.contextPack = contextPack;
  updateIntelligenceUI();
}

/**
 * Update tool calls from a conversation response
 */
function updateToolCalls(toolCalls) {
  IntelligenceState.toolCalls = toolCalls || [];
  updateIntelligenceUI();
}

/**
 * Copy tool call data to clipboard
 */
function copyToClipboard(callIndex, field) {
  const call = IntelligenceState.toolCalls[callIndex];
  if (!call) return;

  const data = field === 'args' ? call.args : call.result;
  const text = JSON.stringify(data, null, 2);

  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard');
  }).catch(err => {
    console.error('Failed to copy:', err);
  });
}

/**
 * Update the Intelligence Panel UI
 */
function updateIntelligenceUI() {
  // Update toggle button
  const toggleContainer = document.getElementById('intel-toggle-container');
  if (toggleContainer) {
    toggleContainer.innerHTML = renderIntelligenceToggle();
  }

  // Update panel
  const panelContainer = document.getElementById('intel-panel-container');
  if (panelContainer) {
    panelContainer.innerHTML = renderIntelligencePanel();
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

/**
 * Format a date string
 */
function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const date = new Date(dateStr);
    return date.toLocaleString();
  } catch {
    return dateStr;
  }
}

/**
 * Show a toast notification
 */
function showToast(message) {
  // Use existing toast system if available
  if (typeof window.showToast === 'function') {
    window.showToast(message);
  } else {
    console.log('[Intel Panel]', message);
  }
}

// =============================================================================
// Exports
// =============================================================================

// Expose to window for use in app.js
window.IntelligenceState = IntelligenceState;
window.toggleIntelligencePanel = toggleIntelligencePanel;
window.setIntelActiveTab = setIntelActiveTab;
window.updateContextPack = updateContextPack;
window.updateToolCalls = updateToolCalls;
window.copyToClipboard = copyToClipboard;
window.renderIntelligenceToggle = renderIntelligenceToggle;
window.renderIntelligencePanel = renderIntelligencePanel;
window.updateIntelligenceUI = updateIntelligenceUI;

console.log('[VTID-01216] Intelligence Panels loaded');
