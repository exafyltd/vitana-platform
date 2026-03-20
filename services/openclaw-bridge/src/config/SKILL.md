# Vitana Autopilot - OpenClaw Skill Manifest

## Name
vitana-autopilot

## Description
Vitana platform integration for OpenClaw. Manages tenant subscriptions, live session scheduling, health report processing, and autonomous monitoring for the Vitana wellness platform.

## Available Skills

### vitana-supabase
Tenant management and audit logging.
- `create_tenant` - Create a new tenant with plan
- `update_user_plan` - Change a user's subscription plan
- `audit_usage` - Query audit logs for a tenant
- `log_audit` - Write an audit log entry

### vitana-stripe
Payment and subscription management.
- `create_subscription` - Create a Stripe subscription
- `retry_payment` - Retry a failed payment
- `check_payment_failures` - List failed payments

### vitana-daily
Live session scheduling via Daily.co.
- `schedule_room` - Schedule a new live room
- `send_reminder` - Send reminder to participants
- `list_upcoming` - List upcoming rooms

### vitana-health
Health data operations with PHI protection.
- `redact_phi` - Redact protected health information from text
- `check_phi` - Check if text contains PHI
- `summarize_report` - Summarize a health report (local LLM only)
- `check_consent` - Verify user consent for health operations

## Restrictions
- `shell` skill: DISABLED (security)
- `browser` skill: DISABLED (security)
- `file` skill: DISABLED (security)
- All health data: LOCAL LLM ONLY (Ollama)
- All operations: require valid `tenant_id` (UUID)
- All mutations: emit OASIS events for governance
