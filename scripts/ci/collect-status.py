#!/usr/bin/env python3
import os, requests
from datetime import datetime

SERVICES = {
    'oasis': 'https://vitana-oasis-7h42a5ucbq-uc.a.run.app',
    'planner-core': 'https://vitana-planner-7h42a5ucbq-uc.a.run.app',
    'worker-core': 'https://vitana-worker-7h42a5ucbq-uc.a.run.app',
    'validator-core': 'https://vitana-validator-7h42a5ucbq-uc.a.run.app',
    'memory-indexer': 'https://vitana-memory-7h42a5ucbq-uc.a.run.app',
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
