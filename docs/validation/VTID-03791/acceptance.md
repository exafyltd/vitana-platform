# VTID-03791 — Pin FEATURE_ORB_WS_TRANSPORT_ENV=staging-only

Live verification of VTID-03779's Nova session prewarm ("warm start")
against real staging found the mechanism itself correct — a real Playwright
tap on the Command Hub test harness (WS transport forced via the widget's
own `vtorb.transport=ws` developer override) showed the full sequence:
`prewarm` sent → `prewarm_ready` ack received from the server → `start`
sent with NO intervening `connected` handshake, proving the reuse branch
(not the cold-connect fallback) executed. But on a REAL app tap with no
override, `GET /live/transport` (orb-live.ts, VTID-03471) told the browser
to use `sse`, because `FEATURE_ORB_WS_TRANSPORT_ENV` was unset
(`isFeatureLive` default is `off`) — and an SSE session never calls
`_sessionStartWs()`, so the prewarmed connection sat unclaimed until its
90s TTL expired. This VTID pins that pre-existing, unrelated flag
`staging-only` so real staging taps actually get WS and can claim the
warm connection VTID-03779 builds for them. No application code changes.

AC-1 — FEATURE_ORB_WS_TRANSPORT_ENV is pinned "staging-only" on the
staging deploy workflow, upserted (not appended alongside a stale value)

`AWS-STAGE-DEPLOY-GATEWAY.yml`'s task-def jq block strips
`FEATURE_ORB_WS_TRANSPORT_ENV` from whatever the running task definition
already carries, then re-adds it with `value:"staging-only"` — the same
strip+re-add pattern every other pinned flag in this file uses (e.g.
`FEATURE_ORB_NOVA_PREWARM_ENV`), so a stale inherited value can never
survive alongside the new one and no duplicate key is possible.

TEST: `services/gateway/test/orb/live/upstream/staging-ws-transport-flag-pinned.test.ts`
— 3/3 passing: the flag is upserted as `"staging-only"`; it appears in the
strip list before the re-add list; it is deliberately absent from
`AWS-PROD-DEPLOY-GATEWAY.yml` (promoting `ws` transport to real production
traffic is a separate, later decision).

AC-2 — Pinning this flag actually unblocks VTID-03779's reuse mechanism on
a real tap, verified live, not inferred from the code path

Real Playwright run against `preview-aws-gateway.vitanaland.com` with WS
transport forced (the state this pin makes DEFAULT for every real session
once deployed): `prewarm_ready` observed, then `start` sent immediately
with no `connected` in between — the reuse branch's literal signature.
Two same-page back-to-back sessions (WARM reused vs. COLD fired right
after) measured 1726–1845ms vs 1819ms tap-to-first-audio, both under the
3s cold-start target — the exact mechanism this pin turns on by default.

TEST: `services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts`
— re-run clean after this edit (7/7): YAML parses, every `run:` step
passes `bash -n`, no step exceeds the 20,000-char GitHub Actions limit, and
the jq program still has no apostrophe inside its single-quoted string
(VTID-03787/03788 regression class). See `commands.log` for the full
Playwright transcript (WS events + audio timings) this AC is based on.
