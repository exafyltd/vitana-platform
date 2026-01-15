#!/usr/bin/env python3
"""
Registers the current Claude Operational Protocol (COP)
inside OASIS as an event so every new task records which version was loaded.
"""

import sys, os, json, requests

# Ensure Python can find the 'scripts' package when run from any directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from scripts.ai.load_claude_prompt import load_claude_prompt

# Load environment variables
# VTID-01176: Use gateway proxy for OASIS events (canonical routing)
GATEWAY_URL = os.environ.get("GATEWAY_URL", "https://vitana-gateway-86804897789.us-central1.run.app")
OASIS_URL = os.environ.get("OASIS_URL", f"{GATEWAY_URL}/api/v1/oasis/events")
OASIS_TOKEN = os.environ.get("OASIS_TOKEN")

def register_cop():
    """Send the Claude Operational Protocol (COP) as an event to OASIS."""
    if not OASIS_TOKEN:
        print("[ERROR] OASIS_TOKEN not set. Run: export OASIS_TOKEN='<your token>'")
        return

    # Load the COP text content
    text = load_claude_prompt()

    # Prepare JSON payload for /api/v1/events
    payload = {
        "type": "CLAUDE_PROTOCOL_REGISTERED",
        "data": {
            "context_name": "CLAUDE_PROTOCOL",
            "version": "v1.0",
            "content": text.strip()
        }
    }

    headers = {
        "Authorization": f"Bearer {OASIS_TOKEN}",
        "Content-Type": "application/json"
    }

    print("[INFO] Sending COP registration to OASIS /api/v1/events ...")
    try:
        response = requests.post(OASIS_URL, headers=headers, data=json.dumps(payload), timeout=15)
        print(f"[OASIS] Response Code: {response.status_code}")
        print(f"[OASIS] Response Body: {response.text}")
        if response.status_code == 200:
            print("[SUCCESS] COP successfully registered to OASIS.")
        else:
            print("[WARNING] COP registration did not return 200. Check response above.")
    except Exception as e:
        print(f"[ERROR] Failed to register COP: {e}")

if __name__ == "__main__":
    register_cop()
