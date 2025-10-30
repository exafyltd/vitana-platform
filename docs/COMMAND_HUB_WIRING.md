# Command Hub Wiring Guide

## Environment Variables

Add to Command Hub frontend config:
```env
OPERATOR_BASE_URL=https://oasis-operator-86804897789.us-central1.run.app
SSE_URL=https://oasis-operator-86804897789.us-central1.run.app/api/v1/events/stream
```

## API Integration

### Chat Composer
```typescript
// Send message
const response = await fetch(`${OPERATOR_BASE_URL}/api/v1/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user_id: currentUser.email,
    message: userInput,
    vtid: selectedVtid || undefined
  })
});

const { vtid, reply, followups, links } = await response.json();
```

### Load Thread
```typescript
// When user clicks VTID
const thread = await fetch(
  `${OPERATOR_BASE_URL}/api/v1/chat/thread?vtid=${vtid}`
).then(r => r.json());

// Render messages
thread.items.forEach(msg => {
  renderMessage(msg.role, msg.text, msg.ts);
});
```

### Live Events (SSE)
```typescript
const eventSource = new EventSource(SSE_URL);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  appendToLiveConsole(data);
};
```

## UI Hooks

### Right Panel Chat
- Location: `components/CommandHub/ChatPanel.tsx`
- Hook: `onSendMessage` → calls `/api/v1/chat`
- Display: Show VTID badge when created

### Live Console
- Location: `components/CommandHub/LiveConsole.tsx`
- On mount: GET `/api/v1/events?limit=100`
- Subscribe: EventSource to `/api/v1/events/stream`
- Update: Append new events, no reload needed

### Event Filters
- status: info/success/warn/error
- layer: CICDL/AICOR/AGENT/GATEWAY/OASIS
- module: gateway, conductor, planner, worker, validator, operator
