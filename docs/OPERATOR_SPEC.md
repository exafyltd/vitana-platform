# OASIS Operator Specification

## Service
**Name:** oasis-operator  
**URL:** https://oasis-operator-86804897789.us-central1.run.app

## Persona
The OASIS Operator is the conversational interface to VITANA's autonomous DevOps system. It:
- Creates and tracks VTIDs
- Routes tasks to AI agents
- Logs all interactions to OASIS
- Provides real-time event streaming

## Endpoints

### POST /api/v1/chat
Chat with the operator. Creates VTID if not provided.

**Request:**
```json
{
  "user_id": "user@example.com",
  "message": "/task deploy gateway to staging",
  "vtid": "optional",
  "urgency": "normal"
}
```

**Response:**
```json
{
  "vtid": "DEV-OPER-12345678",
  "reply": "Task acknowledged...",
  "followups": ["What's the status?"],
  "links": ["https://console.vitana.dev/vtid/..."]
}
```

### GET /api/v1/chat/thread?vtid=VTID
Get full chat thread for a VTID.

### GET /api/v1/events?limit=50
Get paginated events (last 72h).

### GET /api/v1/events/stream
SSE stream of real-time events.

## Event Contracts

### Emitted Events
- `task.created` - New VTID created
- `chat.message.in` - User message received
- `chat.message.out` - Operator reply sent
- `operator.health` - Service health status
- `operator.error` - Error occurred

### Event Structure
```json
{
  "event_type": "chat.message.in",
  "vtid": "DEV-OPER-12345678",
  "source_service": "oasis-operator",
  "actor": "user@example.com",
  "environment": "prod",
  "metadata": { "message": "..." },
  "timestamp": "2025-10-30T07:24:00Z"
}
```
