#!/usr/bin/env python3
"""
VTID-01176: Cloud Run Status Collector
Checks health of ALL canonical Cloud Run gateway services.
Posts summary to Google Chat Command HUB space.
"""
import os, requests, json
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

GATEWAY_URL = os.environ.get('GATEWAY_URL', 'https://gateway-q74ibpv6ia-uc.a.run.app')

# All gateway health endpoints organised by domain
SERVICES = {
    # ── Core Infrastructure ──
    'Gateway':                  '/health',
    'Gateway Alive':            '/alive',
    'Auth':                     '/api/v1/auth/health',
    'CI/CD':                    '/api/v1/cicd/health',
    'Execute Runner':           '/api/v1/execute/health',
    'Operator':                 '/api/v1/operator/health',
    'Operator Deployments':     '/api/v1/operator/deployments/health',
    'Telemetry':                '/api/v1/telemetry/health',
    'Events':                   '/events/health',
    'Command Hub UI':           '/command-hub/health',

    # ── AI & Conversation ──
    'Assistant':                '/api/v1/assistant/health',
    'Knowledge Hub':            '/api/v1/assistant/knowledge/health',
    'ORB Live':                 '/api/v1/orb/health',
    'Voice Lab':                '/api/v1/voice-lab/health',
    'Conversation Intelligence':'/api/v1/conversation/health',
    'Conversation Tools':       '/api/v1/conversation/tool-health',

    # ── Autopilot ──
    'Autopilot':                '/api/v1/autopilot/health',
    'Autopilot Pipeline':       '/api/v1/autopilot/pipeline/health',
    'Autopilot Prompts':        '/api/v1/autopilot/prompts/health',
    'Autopilot Recommendations':'/api/v1/autopilot/recommendations/health',
    'Automations':              '/api/v1/automations/health',
    'Recommendation Inbox':     '/api/v1/recommendations/health',

    # ── Memory & Data ──
    'Memory':                   '/api/v1/memory/health',
    'Semantic Memory':          '/api/v1/memory/semantic/health',
    'Diary':                    '/api/v1/diary/health',

    # ── Health & Wellness Domain ──
    'Health Capacity':          '/api/v1/capacity/health',

    # ── Scheduling & Notifications ──
    'Scheduler':                '/api/v1/scheduler/health',
    'Scheduled Notifications':  '/api/v1/scheduled-notifications/health',
    'Email Intake':             '/api/v1/intake/email/health',

    # ── Community & Social ──
    'Community':                '/api/v1/community/health',
    'Relationships':            '/api/v1/relationships/health',
    'Matchmaking':              '/api/v1/match/health',
    'Personalization':          '/api/v1/personalization/health',
    'Live Rooms':               '/api/v1/live/health',
    'Social Context':           '/api/v1/social/health',
    'Social Connect':           '/api/v1/social-accounts/health',
    'Social Alignment':         '/api/v1/alignment/health',

    # ── Content & Routing ──
    'Topics':                   '/api/v1/topics/health',
    'Domain Routing':           '/api/v1/routing/health',
    'Locations':                '/api/v1/locations/health',
    'Offers':                   '/api/v1/offers/health',

    # ── Feedback ──
    'Feedback Correction':      '/api/v1/feedback/health',
    'Voice Feedback':           '/api/v1/voice-feedback/health',

    # ── Contextual Engines (D-Series) ──
    'Situational Awareness':    '/api/v1/situational/health',
    'Availability & Readiness': '/api/v1/availability/health',
    'Environmental Mobility':   '/api/v1/context/mobility/health',
    'User Preferences':         '/api/v1/user-preferences/health',
    'Taste Alignment':          '/api/v1/taste-alignment/health',
    'Overload Detection':       '/api/v1/overload/health',
    'Risk Mitigation':          '/api/v1/mitigation/health',
    'Opportunity Surfacing':    '/api/v1/opportunities/health',

    # ── Observability ──
    'Visual Interactive':       '/api/v1/visual/health',
    'VTID Terminalize':         '/api/v1/oasis/vtid/terminalize/health',
    'VTID':                     '/api/v1/vtid/health',
}


def check_service(name, path):
    """Check a single service health endpoint. Returns (name, status, http_code)."""
    url = f'{GATEWAY_URL}{path}'
    try:
        r = requests.get(url, timeout=8)
        if r.ok:
            return (name, '✅ Live', r.status_code)
        else:
            return (name, '❌ Down', r.status_code)
    except requests.exceptions.Timeout:
        return (name, '⏱️ Timeout', 0)
    except Exception:
        return (name, '❌ Error', 0)


# ── Check all services in parallel ──
results = []
with ThreadPoolExecutor(max_workers=15) as pool:
    futures = {pool.submit(check_service, name, path): name for name, path in SERVICES.items()}
    for future in as_completed(futures):
        results.append(future.result())

# Sort by original order
order = list(SERVICES.keys())
results.sort(key=lambda r: order.index(r[0]))

live_count = sum(1 for r in results if '✅' in r[1])
total = len(results)
down_services = [r[0] for r in results if '✅' not in r[1]]

# ── Write docs/STATUS.md ──
now = datetime.utcnow().isoformat() + 'Z'
rows = ['| Service | Status | HTTP |', '|---------|--------|------|']
for name, status, code in results:
    rows.append(f'| {name} | {status} | {code or "—"} |')

md = f"""# Vitana Platform — Live Status

**Updated:** {now}
**Summary:** {live_count}/{total} services live

## Service Health

{chr(10).join(rows)}

{"" if not down_services else "### ⚠️ Down Services" + chr(10) + chr(10).join(f"- {s}" for s in down_services) + chr(10)}

---
This file auto-updates daily at 08:00 UTC via `DAILY-STATUS-UPDATE.yml`.
"""

with open('docs/STATUS.md', 'w') as f:
    f.write(md)
print(f'Updated docs/STATUS.md — {live_count}/{total} live')

# ── Post to Google Chat ──
webhook = os.getenv('WEBHOOK_URL', '')
if webhook:
    # Build a rich message with summary + any down services
    summary = f'*Vitana: {live_count}/{total} live*'
    if down_services:
        down_list = ', '.join(down_services[:10])
        if len(down_services) > 10:
            down_list += f' (+{len(down_services) - 10} more)'
        text = f'{summary}\n⚠️ Down: {down_list}'
    else:
        text = f'{summary}\n✅ All systems operational'

    try:
        requests.post(webhook, json={'text': text}, timeout=10)
        print('Posted to Chat')
    except Exception as e:
        print(f'Chat error: {e}')
