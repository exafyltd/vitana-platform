#!/usr/bin/env python3
import json, os, subprocess, time, sys, urllib.request

PROJECT = os.getenv("GCP_PROJECT") or subprocess.check_output(
    ["gcloud","config","get-value","project"], text=True).strip()
REGION  = os.getenv("GCP_REGION", "us-central1")
WEBHOOK = os.getenv("DEVOPS_WEBHOOK")

WARN_MS = int(os.getenv("HEALTH_WARN_MS", "1500"))
CRIT_MS = int(os.getenv("HEALTH_CRIT_MS", "3000"))

EXPECTED_MISSING = {s.strip() for s in os.getenv("EXPECTED_MISSING_SERVICES","oasis-mcp").split(",") if s.strip()}
REMOVED_SERVICES = {s.strip() for s in os.getenv("REMOVED_SERVICES","vitana-chat-gateway").split(",") if s.strip()}

def sh(args):
    return subprocess.check_output(args, text=True).strip()

def services():
    out = sh(["gcloud","run","services","list","--region",REGION,"--format=value(metadata.name)"])
    return sorted([s for s in out.splitlines() if s])

def url_for(svc):
    try:
        return sh(["gcloud","run","services","describe",svc,"--region",REGION,"--format=value(status.url)"]).strip()
    except subprocess.CalledProcessError:
        return ""

def health(url, timeout=8):
    if not url:
        return ("NOURL", 0, None)
    start = time.time()
    code = None
    try:
        with urllib.request.urlopen(url + "/health", timeout=timeout) as r:
            code = r.status
            ok = 200 <= r.status < 300
        dur = int((time.time() - start) * 1000)
        return ("OK" if ok else "BAD", dur, code)
    except Exception:
        dur = int((time.time() - start) * 1000)
        return ("BAD", dur, code)

def line_for(svc, status, ms, http_code):
    if svc in REMOVED_SERVICES:
        return f"❌ {svc} — removed (legacy)"
    if status == "NOURL":
        return f"⚪ {svc} — not deployed" + (" (expected)" if svc in EXPECTED_MISSING else "")
    if status == "OK":
        if ms < WARN_MS:   return f"🟢 {svc} — {ms}ms"
        if ms < CRIT_MS:   return f"🟡 {svc} — {ms}ms (degraded)"
        return f"🔴 {svc} — {ms}ms (too slow)"
    # BAD
    label = f"(HTTP {http_code})" if http_code else "(health error)"
    return f"🔴 {svc} — {ms}ms {label}"

def post(text):
    req = urllib.request.Request(WEBHOOK, data=json.dumps({"text": text}).encode("utf-8"),
                                 headers={"Content-Type":"application/json"})
    urllib.request.urlopen(req).read()

def main():
    if not WEBHOOK:
        print("Missing DEVOPS_WEBHOOK", file=sys.stderr); sys.exit(1)
    svcs = services()
    lines = [f"🚦 Vitana Platform Status – {PROJECT} ({REGION})", ""]
    healthy = degraded = critical = missing = removed = 0

    for svc in svcs:
        url = url_for(svc)
        st, ms, code = health(url)
        line = line_for(svc, st, ms, code)
        lines.append(line)
        if "🟢" in line: healthy += 1
        elif "🟡" in line: degraded += 1
        elif "🔴" in line: critical += 1
        elif "⚪" in line: missing += 1
        elif "❌" in line: removed += 1

    for svc in sorted(REMOVED_SERVICES - set(svcs)):
        lines.append(f"❌ {svc} — removed (legacy)"); removed += 1
    for svc in sorted(EXPECTED_MISSING - set(svcs)):
        lines.append(f"⚪ {svc} — not deployed (expected)"); missing += 1

    lines += ["", "📊 Summary:",
              f"🟢 Healthy: {healthy}",
              f"🟡 Degraded: {degraded}",
              f"🔴 Critical: {critical}",
              f"⚪ Missing: {missing}"]
    if removed: lines.append(f"❌ Removed: {removed}")

    post("\n".join(lines))

if __name__ == "__main__":
    main()
