#!/usr/bin/env python3
"""
VTID-01176: Upload tasks to OASIS via gateway proxy (canonical routing)
"""
import json, os, requests, time

# VTID-01176: Use gateway proxy for OASIS events
GATEWAY_URL = os.environ.get("GATEWAY_URL", "https://vitana-gateway-86804897789.us-central1.run.app")
OASIS_URL = os.environ.get("OASIS_URL", f"{GATEWAY_URL}/api/v1/oasis/events")
TOKEN = os.environ.get("OASIS_TOKEN")

if not TOKEN:
    raise SystemExit("❌ OASIS_TOKEN not found. Please export it before running.")

with open("oasis_tasks_batch.json", "r", encoding="utf-8") as f:
    tasks = json.load(f)

headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

print(f"🚀 Starting upload of {len(tasks)} tasks to OASIS...\n")

for i, task in enumerate(tasks, start=1):
    vtid = task["data"]["vtid"]
    print(f"[{i}/{len(tasks)}] Uploading {vtid}...", end=" ")
    r = requests.post(OASIS_URL, headers=headers, json=task)
    if r.status_code == 200:
        print("✅ success")
    else:
        print(f"❌ failed ({r.status_code}) -> {r.text}")
    time.sleep(0.3)

print("\n✅ Upload complete.")
