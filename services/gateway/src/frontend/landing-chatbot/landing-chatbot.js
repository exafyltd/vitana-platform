/**
 * VTID-LANDING: Landing Page Chatbot — ORB Widget for First-Time Visitors
 *
 * Self-contained chatbot widget that can be embedded on vitanalent.com.
 * Communicates with the gateway's /api/v1/landing/chat endpoint.
 *
 * Features:
 * - Floating ORB button with breathing animation
 * - Chat drawer with message history
 * - Quick-action chips for common questions
 * - Typing indicator during AI response
 * - Auto-scroll to latest message
 * - Mobile responsive
 * - Session persistence via thread_id
 */

(function () {
  'use strict';

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * API base URL — auto-detected from script source or defaults to current origin.
   * When embedding on vitanalent.com, set window.VITANA_GATEWAY_URL before loading this script.
   */
  const GATEWAY_URL = window.VITANA_GATEWAY_URL || '';

  const API_ENDPOINT = GATEWAY_URL + '/api/v1/landing/chat';

  /** Session thread ID — persisted in sessionStorage for continuity within a visit */
  const THREAD_STORAGE_KEY = 'vitana_landing_thread_id';

  /** Welcome message shown when the chat drawer opens for the first time */
  const WELCOME_MESSAGE = "Hi there! I'm the Vitana ORB, your guide to the Maxilla longevity community. I can help you learn about what we offer, how to join, and what to expect. What would you like to know?";

  /** Quick-action prompts shown below the welcome message */
  const QUICK_ACTIONS = [
    { label: 'What is Vitana?', message: 'What is Vitana and the Maxilla community?' },
    { label: 'How do I join?', message: 'How do I register and join the Maxilla community?' },
    { label: 'What features?', message: 'What features does Vitana offer its members?' },
    { label: 'Is it free?', message: 'Is it free to join Vitana?' },
  ];

  // ===========================================================================
  // State
  // ===========================================================================

  let threadId = sessionStorage.getItem(THREAD_STORAGE_KEY) || null;
  let isOpen = false;
  let isSending = false;
  let hasShownWelcome = false;

  // ===========================================================================
  // DOM Construction
  // ===========================================================================

  function buildWidget() {
    // --- ORB Trigger Button ---
    const orbBtn = document.createElement('button');
    orbBtn.id = 'orb-trigger';
    orbBtn.setAttribute('aria-label', 'Open chat with Vitana ORB');
    orbBtn.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/>
        <circle cx="8" cy="10" r="1.2"/>
        <circle cx="12" cy="10" r="1.2"/>
        <circle cx="16" cy="10" r="1.2"/>
      </svg>
      <span id="orb-badge"></span>
    `;

    // --- Chat Drawer ---
    const drawer = document.createElement('div');
    drawer.id = 'chat-drawer';
    drawer.innerHTML = `
      <div id="chat-header">
        <div id="chat-header-orb"></div>
        <div id="chat-header-text">
          <h3>Vitana ORB</h3>
          <p>Your guide to Maxilla</p>
        </div>
        <button id="chat-close-btn" aria-label="Close chat">&times;</button>
      </div>
      <div id="chat-messages"></div>
      <div id="chat-input-area">
        <input
          id="chat-input"
          type="text"
          placeholder="Ask me anything..."
          autocomplete="off"
          maxlength="2000"
        />
        <button id="chat-send-btn" aria-label="Send message" disabled>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    `;

    document.body.appendChild(orbBtn);
    document.body.appendChild(drawer);

    // --- Event Listeners ---
    orbBtn.addEventListener('click', toggleChat);
    document.getElementById('chat-close-btn').addEventListener('click', closeChat);
    document.getElementById('chat-send-btn').addEventListener('click', sendMessage);

    const input = document.getElementById('chat-input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener('input', function () {
      document.getElementById('chat-send-btn').disabled = !this.value.trim() || isSending;
    });
  }

  // ===========================================================================
  // Chat Open/Close
  // ===========================================================================

  function toggleChat() {
    if (isOpen) {
      closeChat();
    } else {
      openChat();
    }
  }

  function openChat() {
    isOpen = true;
    document.getElementById('chat-drawer').classList.add('open');
    document.getElementById('orb-trigger').classList.add('chat-open');

    // Hide notification badge
    const badge = document.getElementById('orb-badge');
    if (badge) badge.style.display = 'none';

    // Show welcome message on first open
    if (!hasShownWelcome) {
      hasShownWelcome = true;
      appendAssistantMessage(WELCOME_MESSAGE);
      appendQuickActions();
    }

    // Focus input
    setTimeout(function () {
      document.getElementById('chat-input').focus();
    }, 300);
  }

  function closeChat() {
    isOpen = false;
    document.getElementById('chat-drawer').classList.remove('open');
    document.getElementById('orb-trigger').classList.remove('chat-open');
  }

  // ===========================================================================
  // Message Rendering
  // ===========================================================================

  function appendUserMessage(text) {
    var container = document.getElementById('chat-messages');
    var msg = document.createElement('div');
    msg.className = 'chat-msg user';
    msg.textContent = text;
    container.appendChild(msg);
    scrollToBottom();
  }

  function appendAssistantMessage(text) {
    var container = document.getElementById('chat-messages');
    var msg = document.createElement('div');
    msg.className = 'chat-msg assistant';
    msg.textContent = text;
    container.appendChild(msg);
    scrollToBottom();
  }

  function appendErrorMessage(text) {
    var container = document.getElementById('chat-messages');
    var msg = document.createElement('div');
    msg.className = 'chat-msg error';
    msg.textContent = text;
    container.appendChild(msg);
    scrollToBottom();
  }

  function appendQuickActions() {
    var container = document.getElementById('chat-messages');
    var wrapper = document.createElement('div');
    wrapper.className = 'quick-actions';

    QUICK_ACTIONS.forEach(function (action) {
      var chip = document.createElement('button');
      chip.className = 'quick-action-chip';
      chip.textContent = action.label;
      chip.addEventListener('click', function () {
        // Remove quick actions after selection
        if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
        // Set input and send
        document.getElementById('chat-input').value = action.message;
        sendMessage();
      });
      wrapper.appendChild(chip);
    });

    container.appendChild(wrapper);
    scrollToBottom();
  }

  function showTypingIndicator() {
    var container = document.getElementById('chat-messages');
    var existing = document.getElementById('typing-indicator');
    if (existing) return;

    var msg = document.createElement('div');
    msg.id = 'typing-indicator';
    msg.className = 'chat-msg typing';
    msg.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    container.appendChild(msg);
    scrollToBottom();

    // Animate orb header
    document.getElementById('chat-header-orb').classList.add('thinking');
  }

  function removeTypingIndicator() {
    var indicator = document.getElementById('typing-indicator');
    if (indicator && indicator.parentNode) {
      indicator.parentNode.removeChild(indicator);
    }
    document.getElementById('chat-header-orb').classList.remove('thinking');
  }

  function scrollToBottom() {
    var container = document.getElementById('chat-messages');
    requestAnimationFrame(function () {
      container.scrollTop = container.scrollHeight;
    });
  }

  // ===========================================================================
  // Send Message
  // ===========================================================================

  function sendMessage() {
    if (isSending) return;

    var input = document.getElementById('chat-input');
    var text = input.value.trim();
    if (!text) return;

    // Clear input and disable send
    input.value = '';
    document.getElementById('chat-send-btn').disabled = true;
    isSending = true;

    // Remove any quick-action chips still visible
    var quickActionElements = document.querySelectorAll('.quick-actions');
    quickActionElements.forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });

    // Show user message
    appendUserMessage(text);

    // Show typing indicator
    showTypingIndicator();

    // Call API
    var body = { message: text };
    if (threadId) body.thread_id = threadId;

    fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { status: response.status, data: data };
        });
      })
      .then(function (result) {
        removeTypingIndicator();

        if (result.data.ok) {
          // Save thread_id for session continuity
          if (result.data.thread_id) {
            threadId = result.data.thread_id;
            sessionStorage.setItem(THREAD_STORAGE_KEY, threadId);
          }
          appendAssistantMessage(result.data.reply);
        } else if (result.data.error === 'RATE_LIMITED') {
          appendErrorMessage('You\'re chatting too fast! Please wait a moment and try again.');
        } else {
          appendErrorMessage(result.data.message || 'Something went wrong. Please try again.');
        }
      })
      .catch(function (err) {
        removeTypingIndicator();
        console.error('[VTID-LANDING] Chat error:', err);
        appendErrorMessage('Connection error. Please check your internet and try again.');
      })
      .finally(function () {
        isSending = false;
        // Re-enable send if input has text
        var currentInput = document.getElementById('chat-input');
        document.getElementById('chat-send-btn').disabled = !currentInput.value.trim();
        currentInput.focus();
      });
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  function init() {
    // Only inject if not already present
    if (document.getElementById('orb-trigger')) return;

    buildWidget();
    console.log('[VTID-LANDING] ORB chatbot widget initialized');
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
