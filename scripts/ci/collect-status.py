#!/usr/bin/env python3
"""
VTID-01176: Cloud Run Status Collector
Checks health of canonical Cloud Run services.
"""
import os, requests
from datetime import datetime

# Canonical Cloud Run services (VTID-01176 cleanup)
# Old 7h42a5ucbq URLs removed - those services are deprecated
GATEWAY_URL = os.environ.get('GATEWAY_URL', 'https://gateway-q74ibpv6ia-uc.a.run.app')

SERVICES = {
    'gateway': f'{GATEWAY_URL}',
    'gateway-health': f'{GATEWAY_URL}/alive',
    'oasis-api': f'{GATEWAY_URL}/api/v1/oasis/health',
}

services = []
for name, url in SERVICES.items():
    try:
        r = requests.get(f"{url}/health", timeout=5)
        services.append({'name': name, 'status': '✅ Live' if r.ok else '❌ Down'})
    except:
        services.append({'name': name, 'status': '❌ Error'})

now = datetime.utcnow().isoformat() + 'Z'
rows = ['| Service | Status |', '|---------|--------|']
for s in services:
    rows.append(f"| {s['name']} | {s['status']} |")

md = f"""# Vitana Platform - Live Status

**Updated:** {now}

## Service Health

{"".join(row + chr(10) for row in rows)}

See full details at docs/STATUS.md

This file auto-updates daily at 08:00 UTC.
"""

with open('docs/STATUS.md', 'w') as f:
    f.write(md)
print("Updated docs/STATUS.md")

webhook = os.getenv('WEBHOOK_URL', '')
if webhook:
    try:
        requests.post(webhook, json={'text': f'Vitana: {sum(1 for s in services if "✅" in s["status"])}/{len(services)} live'}, timeout=5)
        print("Posted to Chat")
    except Exception as e:
        print(f"Chat error: {e}")
