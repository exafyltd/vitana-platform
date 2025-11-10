#!/usr/bin/env python3
import json, os, requests, time

OASIS_URL = "https://oasis-operator-86804897789.us-central1.run.app/api/v1/events"
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
