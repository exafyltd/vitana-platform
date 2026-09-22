# VTID-04263 — Acceptance

AC-1: ALERT-PUSH-DISPATCH-HEALTH.yml and ALERT-APP-USERS-IDENTITY-DRIFT.yml
are covered by the Morning Health Check self-audit, so a repeat of this
class of silent failure surfaces in the daily report.
TEST: `grep -c 'ALERT-PUSH-DISPATCH-HEALTH.yml\|ALERT-APP-USERS-IDENTITY-DRIFT.yml' .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` returns 2
CURL: n/a — static workflow content, no live endpoint for this AC
UI: n/a

AC-2: `orb.session.audio_ready.acked` OASIS events carry a `reason` when
the write fails, so ALERT-ORB-SESSION-STATE-HEALTH.yml (and this
workflow's own check 16) can diagnose a future `acks_failed_24h > 0`
instead of only alarming on it.
TEST: `grep -n "reason: r.reason" services/gateway/src/routes/orb-live.ts` matches the `orb.session.audio_ready.acked` emitOasisEvent call
CURL: n/a — requires a real authenticated ORB session to trigger a write
failure; the next real `ok:false` ack after this deploys is the live signal
UI: n/a

AC-3: AWS-STAGING-VALIDATION.yml can no longer be manually dispatched
with its defaults and silently snapshot a permanently-dead GCP host.
TEST: `grep -A1 "gcp_gateway_url:\|gcp_frontend_url:" .github/workflows/AWS-STAGING-VALIDATION.yml | grep "default: ''"` returns both inputs
CURL: n/a — dispatch-only workflow, not scheduled
UI: n/a

AC-4: No regression to the gateway's TypeScript build or the two edited
workflow files' YAML validity.
TEST: `cd services/gateway && npx tsc --noEmit -p .` exits 0
TEST: `cd services/gateway && npm run build` exits 0
CURL: n/a
UI: n/a

---

OASIS_PROOF: AC-2 changes the payload of the existing `orb.session.audio_ready.acked`
OASIS event topic (`services/gateway/src/routes/orb-live.ts`, `emitOasisEvent` call) —
adds `reason` (the pre-existing `writeOrbSessionState()` return value, previously
computed but discarded before emission), does not add, remove, or rename any topic.
No new OASIS event type is introduced; `ALERT-ORB-SESSION-STATE-HEALTH.yml`'s own RPC
(`ci_orb_session_state_health`) reads `oasis_events` aggregates only (counts), not this
new field directly, so this is additive-only and cannot change that check's PASS/FAIL
verdict — only whether a future FAIL includes a reason. Verified via direct read-only
query against project `inmkhvwdcuyhnxkgfvsb`: `select pg_get_functiondef(oid) from
pg_proc where proname='ci_orb_session_state_health'` confirms the RPC only counts rows
by topic and a `metadata->>'ok'` filter, never reads `reason`.
