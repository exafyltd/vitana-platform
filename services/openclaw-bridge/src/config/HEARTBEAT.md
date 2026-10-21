# Vitana Autopilot - Heartbeat Tasks

Every 15 minutes, check the following for ALL active tenants:

## 1. Payment Health
- Query `stripe_subscriptions` for `status IN ('past_due', 'unpaid')`
- For each failure: call `vitana-stripe.retry_payment`
- Log results to `autopilot_logs`

## 2. Upcoming Sessions
- Query `live_rooms` for rooms starting within 60 minutes
- For rooms within 15 minutes: call `vitana-daily.send_reminder`
- Skip rooms where reminders were already sent

## 3. Health Reports
- Query `health_reports` for `status = 'pending_summary'`
- For each: call `vitana-health.summarize_report` (uses LOCAL LLM only)
- Update status to `summarized` after completion

## 4. Governance Check
- Before ANY action: verify `EXECUTION_DISARMED` is false
- If disarmed: log heartbeat skip and exit cycle
- All actions emit OASIS events for audit trail

## Constraints
- Max 10 reports per heartbeat cycle (prevent overload)
- Max 50 payment retries per cycle
- All health data processed via Ollama (never external LLM)
- Respect tenant consent flags before health operations
