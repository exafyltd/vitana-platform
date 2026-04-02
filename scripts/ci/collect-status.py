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
    """Check a single service health endpoint. Returns dict with full details."""
    url = f'{GATEWAY_URL}{path}'
    try:
        r = requests.get(url, timeout=8)
        result = {
            'name': name,
            'endpoint': path,
            'display': '✅ Live' if r.ok else '❌ Down',
            'status': 'live' if r.ok else 'down',
            'http_status': r.status_code,
            'response_body': r.text[:500] if not r.ok else '',
            'response_time_ms': int(r.elapsed.total_seconds() * 1000),
            'error_message': None,
        }
        return result
    except requests.exceptions.Timeout:
        return {
            'name': name, 'endpoint': path,
            'display': '⏱️ Timeout', 'status': 'timeout',
            'http_status': None, 'response_body': '',
            'response_time_ms': 8000, 'error_message': 'Connection timed out after 8s',
        }
    except Exception as e:
        return {
            'name': name, 'endpoint': path,
            'display': '❌ Error', 'status': 'down',
            'http_status': None, 'response_body': '',
            'response_time_ms': 0, 'error_message': str(e),
        }


# ── Check all services in parallel ──
results = []
with ThreadPoolExecutor(max_workers=15) as pool:
    futures = {pool.submit(check_service, name, path): name for name, path in SERVICES.items()}
    for future in as_completed(futures):
        results.append(future.result())

# Sort by original order
order = list(SERVICES.keys())
results.sort(key=lambda r: order.index(r['name']))

live_count = sum(1 for r in results if r['status'] == 'live')
total = len(results)
down_services = [r['name'] for r in results if r['status'] != 'live']

# ── Write docs/STATUS.md ──
now = datetime.utcnow().isoformat() + 'Z'
rows = ['| Service | Status | HTTP |', '|---------|--------|------|']
for r in results:
    rows.append(f'| {r["name"]} | {r["display"]} | {r["http_status"] or "—"} |')

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

# ── POST structured failure data to Gateway self-healing endpoint ──
service_token = os.getenv('SERVICE_TOKEN', '')
if down_services and service_token:
    report = {
        'timestamp': now,
        'total': total,
        'live': live_count,
        'services': [
            {
                'name': r['name'],
                'endpoint': r['endpoint'],
                'status': r['status'],
                'http_status': r['http_status'],
                'response_body': r['response_body'],
                'response_time_ms': r['response_time_ms'],
                'error_message': r['error_message'],
            }
            for r in results  # send ALL services so Gateway has the full picture
        ]
    }
    try:
        heal_resp = requests.post(
            f'{GATEWAY_URL}/api/v1/self-healing/report',
            json=report,
            headers={
                'Authorization': f'Bearer {service_token}',
                'Content-Type': 'application/json',
            },
            timeout=30,
        )
        if heal_resp.ok:
            data = heal_resp.json()
            print(f'Self-healing: {data.get("vtids_created", 0)} tasks created, {data.get("skipped", 0)} skipped')
        else:
            print(f'Self-healing POST failed: {heal_resp.status_code} {heal_resp.text[:200]}')
    except Exception as e:
        print(f'Self-healing POST error: {e}')
elif down_services and not service_token:
    print('Self-healing: SERVICE_TOKEN not set, skipping structured report')
