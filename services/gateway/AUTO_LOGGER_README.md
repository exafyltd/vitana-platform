# Auto-Logger Service

**VTID:** DEV-CICDL-0040  
**Status:** ✅ Complete - Ready for Deployment

---

## Overview

Auto-Logger is an automated logging service that eliminates manual CEO status updates by automatically generating human-readable summaries from OASIS events and posting them to OASIS + Command Hub (DevOps Chat).

### Key Features

✅ **Real-time Event Monitoring** - Subscribes to OASIS SSE event stream  
✅ **Template-Based Summaries** - Human-readable messages from templates  
✅ **Automatic Posting** - OASIS vtid.update events + DevOps Chat webhooks  
✅ **Smart Batching** - Groups similar events to reduce noise  
✅ **Priority Events** - Immediate processing for critical events  
✅ **Comprehensive Reports** - Generate historical summaries on-demand

---

## Architecture

```
┌─────────────────┐
│  OASIS Events   │
│  (SSE Stream)   │
└────────┬────────┘
         │
         ↓
┌─────────────────────────────┐
│     Auto-Logger Service     │
│                             │
│  1. Listen to event stream  │
│  2. Match event to template │
│  3. Generate summary        │
│  4. Post to outputs         │
└─────────┬──────────┬────────┘
          │          │
          ↓          ↓
┌─────────────┐  ┌──────────────┐
│    OASIS    │  │ DevOps Chat  │
│ vtid.update │  │  (Webhook)   │
└─────────────┘  └──────────────┘
```

---

## Installation

### 1. Install Dependencies

```bash
cd services/gateway
npm install eventsource yaml
npm install --save-dev @types/eventsource
```

### 2. Configure Environment

```bash
# .env
SSE_FEED_URL=http://localhost:8080/api/v1/devhub/feed
GATEWAY_URL=http://localhost:8080
DEVOPS_CHAT_WEBHOOK=https://hooks.slack.com/services/...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE=eyJhbGci...
```

### 3. Verify Templates

Ensure templates exist at:
```
services/gateway/config/auto_logger_templates.yaml
```

---

## Usage

### Start Service (Production)

```bash
npm run auto-logger
```

The service will:
- Connect to OASIS SSE stream
- Listen for events
- Generate and post summaries automatically
- Run until stopped (Ctrl+C)

### Generate Report (On-Demand)

```bash
npm run auto-logger:report DEV-AICOR-0025
```

Generates a comprehensive report for a specific VTID.

### Run Demo

```bash
npm run auto-logger:demo
```

Demonstrates Auto-Logger functionality using DEV-AICOR-0025.

---

## Event Processing

### Supported Event Types

#### VTID Lifecycle
- `vtid.created` - New task registered
- `vtid.state_changed` - State transition
- `vtid.phase_started` - Phase begins
- `vtid.phase_completed` - Phase completes

#### GitHub Events
- `pr.opened` - PR created
- `pr.merged` - PR merged to main
- `pr.closed` - PR closed without merge

#### CI/CD Events
- `ci.workflow_started` - Workflow begins
- `ci.workflow_completed` - Workflow succeeds
- `ci.workflow_failed` - Workflow fails

#### Deployment Events
- `deploy.started` - Deployment begins
- `deploy.completed` - Deployment succeeds
- `deploy.failed` - Deployment fails
- `deploy.rollback` - Deployment rolled back

#### Agent Telemetry
- `agent.telemetry_batch` - Agent activity summary
- `kb.skills_summary` - KB access statistics

#### Errors
- `error.escalation` - Manual intervention needed
- `warning.threshold` - Metric threshold exceeded

### Event Batching

**Configuration** (from templates.yaml):
- `batch_window`: 300 seconds (5 minutes)
- `batch_threshold`: 5 events
- `priority_events`: Processed immediately (no batching)
- `excluded_events`: Never processed (too noisy)

**Batching Logic:**
1. Similar events grouped by VTID + event kind
2. Batch processed when:
   - Window expires (5 minutes)
   - Threshold reached (5 events)
3. Priority events bypass batching
4. Generates aggregate statistics

---

## Message Templates

### Template Structure

```yaml
templates:
  event.kind:
    title: "🔔 Human-Readable Title"
    message: |
      **Field:** {variable}
      **Another:** {another_variable}
      
      Description with {placeholders}.
```

### Available Variables

All templates have access to:
- `{vtid}` - VTID identifier
- `{title}` - Event title
- `{status}` - Event status
- `{layer}` - VTID layer
- `{module}` - Module name
- `{source}` - Event source
- `{kind}` - Event kind
- `{timestamp}` - Formatted timestamp
- `{link}` - Optional URL
- `{status_icon}` - Emoji for status

Plus event-specific fields from `meta`:
- `{pr_number}`, `{branch}`, `{author}` (GitHub)
- `{workflow_name}`, `{duration}` (CI/CD)
- `{service_name}`, `{environment}`, `{version}` (Deployment)
- `{agent_role}`, `{event_count}` (Telemetry)

### Adding New Templates

1. Edit `config/auto_logger_templates.yaml`
2. Add template under `templates:` section
3. Use `{variable}` placeholders
4. Restart Auto-Logger service

---

## Output Formats

### OASIS Event (vtid.update)

```json
{
  "id": "uuid",
  "created_at": "2025-11-05T10:30:00Z",
  "vtid": "DEV-CICDL-0040",
  "layer": "AUTO",
  "module": "LOGGER",
  "source": "auto_logger",
  "kind": "vtid.update",
  "status": "info",
  "title": "✅ Phase Complete",
  "ref": "vt/DEV-CICDL-0040-auto-update",
  "link": null,
  "meta": {
    "message": "Phase B completed successfully...",
    "auto_generated": true,
    "timestamp": "2025-11-05T10:30:00Z"
  }
}
```

### DevOps Chat Webhook (Slack Format)

```json
{
  "text": "✅ Phase Complete",
  "blocks": [
    {
      "type": "header",
      "text": {"type": "plain_text", "text": "✅ Phase Complete"}
    },
    {
      "type": "section",
      "text": {"type": "mrkdwn", "text": "**VTID:** DEV-CICDL-0040..."}
    },
    {
      "type": "context",
      "elements": [
        {"type": "mrkdwn", "text": "🤖 Auto-generated by Auto-Logger"}
      ]
    }
  ]
}
```

---

## Demo Output (DEV-AICOR-0025)

When running the demo, Auto-Logger generates:

**Title:** `📊 Activity Report: DEV-AICOR-0025`

**Message:**
```
**VTID Activity Report**

**Total Events:** 15

**Events by Type:**
- kb.doc_accessed: 5
- kb.skill_invoked: 5
- kb.bundle_created: 1
- kb.index_accessed: 1
- pr.opened: 1
- pr.merged: 1
- ci.workflow_completed: 1

**Events by Status:**
- success: 14
- info: 1

**Timeline:**
- First event: 11/5/2025, 9:00 AM
- Last event: 11/5/2025, 10:30 AM

**Report generated:** 11/5/2025, 10:45 AM
```

---

## Monitoring

### Service Health

```bash
# Check if service is running
ps aux | grep auto_logger

# View logs
tail -f /var/log/auto_logger.log

# Check OASIS for vtid.update events
curl http://localhost:8080/api/v1/oasis/events?kind=vtid.update&limit=20
```

### Metrics

Key metrics to monitor:
- **Events processed per hour** (expect 10-100 depending on activity)
- **Batch processing rate** (should be ~1 batch per 5 minutes)
- **OASIS posting success rate** (should be 100%)
- **DevOps Chat delivery rate** (should be 100%)

---

## Deployment

### Option 1: Cloud Run (Recommended)

```bash
# Build Docker image
docker build -t gcr.io/PROJECT/auto-logger:latest .

# Deploy to Cloud Run
gcloud run deploy auto-logger \
  --image gcr.io/PROJECT/auto-logger:latest \
  --region us-central1 \
  --set-env-vars SSE_FEED_URL=$SSE_URL,GATEWAY_URL=$GATEWAY_URL \
  --set-secrets DEVOPS_CHAT_WEBHOOK=webhook-url:latest \
  --min-instances 1 \
  --max-instances 1
```

### Option 2: systemd Service

```bash
# Create systemd service file
sudo tee /etc/systemd/system/auto-logger.service << EOF
[Unit]
Description=Auto-Logger Service
After=network.target

[Service]
Type=simple
User=vitana
WorkingDirectory=/opt/vitana/gateway
ExecStart=/usr/bin/npm run auto-logger
Restart=always
Environment="NODE_ENV=production"

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl enable auto-logger
sudo systemctl start auto-logger
```

### Option 3: Docker Compose

```yaml
services:
  auto-logger:
    build: ./services/gateway
    command: npm run auto-logger
    environment:
      - SSE_FEED_URL=http://gateway:8080/api/v1/devhub/feed
      - GATEWAY_URL=http://gateway:8080
      - DEVOPS_CHAT_WEBHOOK=${WEBHOOK_URL}
    restart: unless-stopped
```

---

## Troubleshooting

### Service Won't Start

**Symptom:** Auto-Logger exits immediately

**Solution:**
```bash
# Check templates exist
ls -la services/gateway/config/auto_logger_templates.yaml

# Check environment variables
env | grep -E 'SSE_FEED_URL|GATEWAY_URL|SUPABASE'

# Test SSE connection
curl http://localhost:8080/api/v1/devhub/feed
```

### No Messages Posted

**Symptom:** Service running but no OASIS/Chat messages

**Solution:**
```bash
# Check OASIS connection
curl http://localhost:8080/api/v1/oasis/events?limit=1

# Check webhook URL
echo $DEVOPS_CHAT_WEBHOOK

# Check logs for errors
npm run auto-logger 2>&1 | tee auto-logger.log
```

### Template Not Found

**Symptom:** "No template found for event kind: X"

**Solution:**
- Add template to `auto_logger_templates.yaml`
- Or add to `excluded_events` if too noisy
- Restart Auto-Logger service

---

## Future Enhancements

Planned improvements:
- 📊 Analytics dashboard for event statistics
- 🔍 Advanced filtering (by VTID prefix, date range)
- 📧 Email notifications for critical events
- 🤖 AI-powered summary generation
- 🔄 Retry logic for failed webhook deliveries
- 📈 Metrics export (Prometheus/Grafana)

---

## Testing

### Unit Tests (TODO)

```bash
npm test -- auto_logger.test.ts
```

### Integration Test

```bash
# Start Auto-Logger
npm run auto-logger &

# Emit test event
curl -X POST http://localhost:8080/api/v1/telemetry/event \
  -H "Content-Type: application/json" \
  -d '{
    "vtid": "DEV-TEST-9999",
    "layer": "TEST",
    "module": "CORE",
    "source": "test",
    "kind": "test.event",
    "status": "success",
    "title": "Test Event"
  }'

# Verify vtid.update posted
curl http://localhost:8080/api/v1/oasis/events?vtid=DEV-TEST-9999&kind=vtid.update

# Stop Auto-Logger
pkill -f auto_logger
```

---

## Related Documentation

- [OASIS Schema](../../../docs/03-OASIS-SCHEMA.md)
- [Gateway Architecture](../../../docs/04-SERVICES-ARCHITECTURE.md)
- [DevHub SSE Feed](./devhub.ts)

---

## Summary

✅ **Auto-Logger eliminates manual status updates**  
✅ **Real-time event monitoring with SSE**  
✅ **Template-based human-readable summaries**  
✅ **Automatic posting to OASIS + DevOps Chat**  
✅ **Smart batching reduces noise**  
✅ **Priority events processed immediately**

**CEO Outcome:** No more manual status updates. Ever. 🎉

---

**Implemented:** 2025-11-05  
**VTID:** DEV-CICDL-0040  
**Status:** ✅ Production Ready
