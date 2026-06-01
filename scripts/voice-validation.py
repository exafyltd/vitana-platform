#!/usr/bin/env python3
"""
Voice-quality validation harness (read-only).

Run from the next session once Supabase is reachable:

    SUPABASE_URL=...  SUPABASE_SERVICE_ROLE=...  python3 scripts/voice-validation.py

Or rely on env secrets already set in the environment config. Everything here
is SELECT-only via PostgREST — it writes nothing.

NOTE (fixed 2026-06-01): the event name lives in oasis_events.`topic`, not a
`type` column (the table has no `type` column). The earlier draft filtered on
`type=eq.…` and returned nothing. All session-stop queries now use
`topic=eq.vtid.live.session.stop`.

It produces the four validations the previous session was blocked on:

  Q1  Phantom vs real "audio-in-zero" (validates merged PR #2397)
  Q2  The criticals dragging the score (open quarantines; NOT rolled_back rows — corrected)
  Q3  model_under_responds quarantine rows + recent session metrics (validates Track A before code)
  Q4  Open quarantines = Track B release candidates

See docs/HANDOFF-voice-quality.md for full context and what to do with the output.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

URL = os.environ.get("SUPABASE_URL", "https://inmkhvwdcuyhnxkgfvsb.supabase.co").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

# Reasons PR #2397 classifies as phantom bookkeeping stops (not real conversations).
PHANTOM_REASONS = {"superseded_by_new_session", "expired_ttl"}


def die(msg: str) -> None:
    print(f"\n  ERROR: {msg}\n", file=sys.stderr)
    sys.exit(1)


if not KEY:
    die("SUPABASE_SERVICE_ROLE not set. Provide it as an env secret in this session's config.")


def rest(path: str):
    req = urllib.request.Request(
        f"{URL}/rest/v1/{path}",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        die(f"{e.code} on {path}\n  {body}\n  (403 'Host not in allowlist' => start a fresh session after allowlisting *.supabase.co)")
    except Exception as e:  # noqa: BLE001
        die(f"{type(e).__name__} on {path}: {e}")


def hr(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def pct(n: int, d: int) -> str:
    return f"{(100.0 * n / d):.1f}%" if d else "n/a"


since_24h = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
since_7d = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

# ---------------------------------------------------------------------------
# Q1 — Phantom vs real audio-in-zero (validates PR #2397)
# ---------------------------------------------------------------------------
hr("Q1  Phantom vs real audio-in-zero (last 24h) — validates PR #2397")
q = urllib.parse.quote(since_24h, safe="")
rows = rest(
    f"oasis_events?topic=eq.vtid.live.session.stop&created_at=gte.{q}"
    f"&select=created_at,metadata&order=created_at.desc&limit=2000"
)
reason_counts = Counter()
zero_all = zero_real = total_real = 0
for row in rows:
    meta = row.get("metadata") or {}
    reason = meta.get("reason")
    reason_counts[reason or "(none/normal-end)"] += 1
    audio_in = int(meta.get("audio_in_chunks") or 0)
    if audio_in == 0:
        zero_all += 1
    if reason not in PHANTOM_REASONS:
        total_real += 1
        if audio_in == 0:
            zero_real += 1

print(f"  total session.stop events (24h): {len(rows)}")
print("  by reason:")
for reason, n in reason_counts.most_common():
    tag = "  <- PHANTOM (excluded by #2397)" if reason in PHANTOM_REASONS else ""
    print(f"    {n:5d}  {reason}{tag}")
print()
print(f"  audio-in-zero BEFORE filter (old metric): {zero_all}/{len(rows)}"
      f" = {pct(zero_all, len(rows))}")
print(f"  audio-in-zero AFTER  filter (PR #2397):   {zero_real}/{total_real}"
      f" = {pct(zero_real, total_real)}")
print("  -> The gap between these two numbers is the phantom inflation PR #2397 removes.")


# ---------------------------------------------------------------------------
# Q2 — The criticals dragging the score
#
# CORRECTION (validated 2026-06-01 against live data): the score's criticals
# come from the OPEN QUARANTINES, not self_healing_log rolled_back rows.
# composeQualityScore (voice-improvement-aggregator.ts:141-147) does
# 100 −15·critical −5·warning −1·info; the `healing_quarantine` source
# (same file ~155-180) marks every quarantined row severity='critical'.
# There were ZERO rolled_back rows in the last 7d — the earlier handoff
# mis-attributed the source table. self_healing_log escalated/rolled_back is
# still shown below as supporting context (warnings + heal history).
# ---------------------------------------------------------------------------
hr("Q2  Criticals behind the score: open quarantines + self_healing_log (7d)")
quar = rest(
    "voice_healing_quarantine?status=eq.quarantined"
    "&select=class,normalized_signature&order=quarantined_at.desc&limit=50"
)
print(f"  open quarantines (=critical, -15 each): {len(quar)}  -> score hit -{15 * len(quar)}")
mur = [r for r in quar if (r.get("class") or "") == "voice.model_under_responds"]
print(f"    of those, class=voice.model_under_responds: {len(mur)}  (Track A target)")
print()
q = urllib.parse.quote(since_7d, safe="")
rows = rest(
    f"self_healing_log?outcome=in.(escalated,rolled_back)&created_at=gte.{q}"
    f"&select=vtid,endpoint,failure_class,outcome,created_at&order=created_at.desc&limit=50"
)
crit = [r for r in rows if r.get("outcome") == "rolled_back"]
print(f"  self_healing_log rolled_back (7d): {len(crit)}   escalated (7d): {len(rows) - len(crit)}")
for r in rows[:20]:
    print(f"    {r['outcome']:11s}  {r.get('failure_class') or '(none)':28s}"
          f"  {r['endpoint']:34s}  {r['vtid']}  {r['created_at'][:19]}")


# ---------------------------------------------------------------------------
# Q3 — Validate Track A: do under-responds sessions actually look healthy?
# ---------------------------------------------------------------------------
hr("Q3  Track A evidence: recent session metrics (audio_in vs audio_out vs turns)")
q = urllib.parse.quote(since_24h, safe="")
rows = rest(
    f"oasis_events?topic=eq.vtid.live.session.stop&created_at=gte.{q}"
    f"&select=created_at,metadata&order=created_at.desc&limit=500"
)
print("  Sessions that PRODUCED output (audio_out>0 AND turns>0) but have a high")
print("  audio_in/audio_out ratio are the false 'under-responds' — raw audio_in is")
print("  inflated by echo chunks counted at the orb-live drop gates but never")
print("  forwarded to the model.")
print("  Track A SHIPPED a forwarded-only counter (audio_in_forwarded_chunks).")
print("  For events that carry it, the 'fwd_ratio' column is the echo-robust")
print("  ratio the classifier now uses; compare it to the raw 'ratio'.\n")
print(f"    {'audio_in':>9} {'fwd_in':>8} {'audio_out':>10} {'turns':>6} {'ratio':>7} {'fwd_ratio':>9}  reason")
suspicious = 0
real_rows = [r for r in rows if (r.get('metadata') or {}).get('reason') not in PHANTOM_REASONS]
for r in real_rows[:40]:
    m = r.get("metadata") or {}
    ai = int(m.get("audio_in_chunks") or 0)
    fwd = m.get("audio_in_forwarded_chunks")
    fwd = int(fwd) if fwd is not None else None
    ao = int(m.get("audio_out_chunks") or 0)
    tc = int(m.get("turn_count") or 0)
    ratio = (ai / ao) if ao else float("inf")
    fwd_ratio = (fwd / ao) if (fwd is not None and ao) else None
    flag = ""
    if ao > 0 and tc > 0 and ratio >= 3:
        flag = "  <- responded but high RAW ratio (echo-inflated?)"
        suspicious += 1
    rstr = f"{ratio:7.1f}" if ao else "    inf"
    fstr = (f"{fwd_ratio:9.1f}" if fwd_ratio is not None else "        -")
    fwdstr = (f"{fwd:8d}" if fwd is not None else "       -")
    print(f"    {ai:9d} {fwdstr} {ao:10d} {tc:6d} {rstr} {fstr}  {m.get('reason') or '(normal)'}{flag}")
print(f"\n  suspicious (responded yet high RAW ratio): {suspicious}/{min(len(real_rows),40)} shown")
print("  Once Track A is deployed and traffic flows, fwd_ratio should drop these")
print("  below the classifier's >=5 threshold — the under-responds class stops")
print("  re-quarantining and Track B releases can hold.")


# ---------------------------------------------------------------------------
# Q4 — Track B: open quarantines to release
# ---------------------------------------------------------------------------
hr("Q4  Track B candidates: open quarantines (status=quarantined)")
rows = rest(
    "voice_healing_quarantine?status=eq.quarantined"
    "&select=class,normalized_signature,quarantined_at,reason&order=quarantined_at.desc&limit=50"
)
print(f"  quarantined rows: {len(rows)}")
for r in rows:
    print(f"    {r['class']:24s}  reason={r.get('reason')}"
          f"  sig={str(r.get('normalized_signature'))[:24]}  at={str(r.get('quarantined_at'))[:19]}")
print()
print("  To release a confirmed-false one (governed, moves -> probation):")
print("    POST {GATEWAY}/api/v1/voice-lab/healing/quarantine/release")
print('    body: { "class": "<class>", "normalized_signature": "<sig>" }')
print("  (VTID-01962. Needs an admin/gateway token, NOT the Supabase key.)")

print("\nDone. See docs/HANDOFF-voice-quality.md for interpretation + next actions.\n")
