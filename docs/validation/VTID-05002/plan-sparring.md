# Plan sparring record — VTID-05002

- Partner: `plan-sparring-partner` agent (read-only; `.claude/agents/plan-sparring-partner.md`, model `claude-opus-4-6`)
- Change class: standard · rounds: 2 · verdict: **CONVERGED**
- Final plan hash (sha256 of the text between the plan markers): `c49f753296b9e2e76170311801906c1cbad1f2a415f7132b1c57e7f4c4f163a3`
- Owner approval: 2026-10-08, in the Claude Code session ("Approve both", Gate 1, VTID-04947)

## Final plan
<!-- plan:begin -->
**Change class:** standard (gateway route/session code, a new internal forward path, tests; one infra prerequisite).

**Scope:** `services/gateway/src/orb/live/session/live-session-controller.ts` (SSE session id minted at ~L1147, `live-${randomUUID()}`), `services/gateway/src/routes/orb-live.ts` (SSE routes `GET /live/stream` ~L16501, `POST /live/stream/send` ~L16943, `/live/stream/end-turn` ~L16967, `/live/session/stop` ~L16269, and session-id minting in `/live/session/start` ~L16123), `services/gateway/src/orb/live/session/live-session-controller.ts` (send handler), a new module `services/gateway/src/orb/live/session/cross-task-forward.ts`, Jest tests, `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` + `AWS-PROD-DEPLOY-GATEWAY.yml` (flag pin), `docs/validation/<VTID>/`.

**Evidence (read-only):**
- Prod gateway `vitana-gateway-awsdr`: desiredCount 1, rolling deploy min 100 % / max 200 %, target group `vitana-tg-gateway-awsdr` round_robin, stickiness disabled, deregistration delay 300 s. So every deploy runs two registered tasks for a window.
- SSE sessions live in an in-process Map; a POST that lands on the other task gets 404 `Session not found` (orb-live.ts ~L13527-13805, ~L16553). The widget's `_handleStaleSessionInstance` (orb-widget.js ~L4487-4527) re-registers silently at most 2 times per 30 s, then shows the network-disconnect alert. With two tasks and round robin, ~half the POSTs miss, so a session started or alive in the overlap fails.
- The widget's own comment names the proper fix: a shared session store or cross-instance routing (VTID-02034b / VTID-02036 note).

**Relation to VTID-04866 (owner decision 2026-10-03: WebSocket on prod to end this split).** That decision stands; this plan does not replace it. WebSocket was rolled back on prod by VTID-04934 (0 user turns in ~190 WS sessions, 2026-10-04..07) and stays off until Plan C finds and fixes why the overlay closes during the WS start. This plan is (a) the bridge until then — prod is on SSE today, so every prod deploy currently breaks live sessions — and (b) the permanent fix for the SSE fallback path, which WS keeps by design (`_latchWsFallback`, orb-widget.js ~L1399, for networks that block the WS upgrade). If the owner prefers to wait for WS instead, this plan is not needed; that is the Gate 1 choice.

**Rejected alternatives:**
- ALB cookie stickiness: the widget calls the gateway cross-origin without credentials, and the iOS/Android app WebViews restrict cross-site cookies; unreliable.
- Re-enabling WebSocket on prod: blocked until Plan C finds the hide cause; SSE remains the fallback path either way.
- Redis-backed session registry: ElastiCache `vitana-redis-prod` exists, but `REDIS_URL` is not on the prod task definition (`vitana-gateway-awsdr:166`, read 2026-10-08). More importantly, a location registry does not remove the forward: the session is an in-process upstream connection, so the request must still reach the owning task. Redis would add a store and a dependency on top of the same forward.

**Change (behind `ORB_SSE_CROSS_TASK_FORWARD_ENABLED`, exact `'true'`, default off):**
1. **Owner token in the session id.** At session start the owning task reads its own private IPv4 from the ECS task metadata endpoint (`ECS_CONTAINER_METADATA_URI_V4`, cached at boot). The session id becomes `live-<uuid>.<owner>` where `<owner>` is the IP **encrypted** with AES-256-GCM (key derived by HKDF-SHA256 from the existing `GATEWAY_INTERNAL_TOKEN`, no new secret; the GCM tag authenticates it), base64url. The client sees an opaque token; no VPC address is exposed. The owner part is appended only when the flag is on AND `ECS_CONTAINER_METADATA_URI_V4` resolves AND `GATEWAY_INTERNAL_TOKEN` is set; otherwise the id is `live-<uuid>` exactly as today (local dev and tests unchanged). Ids without an owner part keep working exactly as today. A repo grep found no code that parses or pattern-matches SSE session ids (only the mint at ~L1147 and Map lookups); the PR re-runs that grep and the existing orb-live test suites.
2. **Forward on miss.** When a task receives `GET /live/stream`, `POST /live/stream/send`, `/end-turn` or `/session/stop` for a session it does not hold, and the id carries a valid owner tag for a private address in the VPC range that is not itself, it proxies the request once to `http://<ip>:8080` with header `X-Gateway-Internal: <token>` and a hop marker; the receiving task serves it only if the token matches and the hop marker is absent from a second forward (no loops). SSE responses are streamed through (no buffering). **Drain behaviour:** forwards are task-to-task inside the VPC, not via the ALB, so a draining old task can still serve forwarded requests until it stops; when it stops its sessions end with `server_shutdown` exactly as today, and the widget starts a new session (on the new task, the only registered target). A forwarded stream therefore lives at most as long as the owner task, i.e. at most the overlap plus the 300 s deregistration delay, and only for sessions whose requests landed on the non-owner. Invalid tag, public IP, self-address or forward failure → today's 404, so the widget's existing re-register still applies.
3. **Tests:** Jest integration test with two in-process gateway instances on different ports sharing the token: session started on A, send/stream/end-turn/stop on B are served by A; forged/unsigned owner → 404 without any outbound request (SSRF guard); hop limit; flag off → byte-identical 404 behaviour.
4. **Infra prerequisite — already satisfied:** the gateway task security group `sg-0fbcf7b59b1f0d685` (shared by staging and prod) allows inbound 8080 from itself (rule `sgr-0893fcd2586a7a51a`, recorded in `docs/validation/VTID-03840/outputs/19-staging-bootstrap.txt:5`). No infra change; no workflow step.
5. **Rollout:** pin the flag `"true"` on staging; prod pin only after staging shows forwarded requests succeeding across a real staging deploy (CloudWatch `[orb-forward]` log lines, read-only).

**Staging tests (read-only):** `/alive`; a forged owner-tag session id on `POST /live/stream/send` returns 404 JSON and produces no forward (log check); smoke suite. Cross-task success is proven by the Jest integration test, since a staging probe would need to open a voice session.

**Risk:** a new internal HTTP hop inside the VPC, guarded by AES-256-GCM (encryption + authentication) and the internal token; off by default; failure mode is today's 404.
<!-- plan:end -->

## Round 1 — partner findings
**Verified premises (partner):** SSE route lines (`orb-live.ts:16501`, `:16943`, `:16967`, `:16269`, `:16123`) — TRUE; in-process `liveSessions` Map (`live-session-registry.ts:58`) with 404 on a miss (`orb-live.ts:16551`, `live-session-controller.ts:728-730`, `:2869-2871`) — TRUE; widget re-registers at most 2 times per 30 s then alerts (`orb-widget.js:4486-4521`) — TRUE; `GATEWAY_INTERNAL_TOKEN` used for internal auth (`autonomy-pulse.ts:41-42` and others) — TRUE; widget comment names the proper fix (`orb-widget.js:4483`, `:4447`, `:374`) — TRUE; security group `sg-0fbcf7b59b1f0d685` allows 8080 from itself (`docs/validation/VTID-03840/outputs/19-staging-bootstrap.txt:5`) — TRUE.

- **F1 [blocker]** Owner already chose WebSocket for this exact problem (VTID-04866, `docs/validation/VTID-04866/acceptance.md`; prod pin `AWS-PROD-DEPLOY-GATEWAY.yml:644`, now "off"); the plan must say why WS promotion is insufficient or blocked.
- **F2 [major]** Forwarded `GET /live/stream` doubles connections and every event takes two hops; what happens when the forwarding/owning task is the draining old task (300 s deregistration delay)?
- **F3 [major]** The owner IP is cleartext in a client-visible session id (HMAC authenticates, does not conceal); encrypt it or use an opaque token.
- **F4 [minor]** "REDIS_URL is not set on prod" vs ElastiCache `vitana-redis-prod` existing; a session-location registry might be simpler.
- **F5 [minor]** Changing the session id format could break code or tests that parse it; grep and list.
- **Q1** Is the WS promotion blocked, by what? **Q2** Bridge, permanent, or replacement? **Q3** New task proxying to an old task that then drains? **Q4** The SG rule already exists — why a workflow step?

Partner verdict round 1: NOT CONVERGED (F1 blocker; F2, F3 major).

## Planner responses (round 1)
- F1 ACCEPTED — new section "Relation to VTID-04866": the WS decision stands; WS is rolled back (VTID-04934) until Plan C's fix; this plan is the bridge for prod (on SSE today) and the permanent fix for the SSE fallback that WS keeps by design. Whether to build it or wait for WS is put to the owner at Gate 1.
- F2 ACCEPTED — drain behaviour stated: forwards go task-to-task, not via the ALB, so a draining owner still serves them until it stops; then its sessions end with `server_shutdown` as today and the widget restarts on the new task. The scenario in Q3 is therefore no worse than today. Connection doubling is bounded to sessions that landed on the non-owner, for at most overlap + 300 s.
- F3 ACCEPTED — owner address encrypted with AES-256-GCM (HKDF from `GATEWAY_INTERNAL_TOKEN`); opaque to the client.
- F4 REJECTED — verified `REDIS_URL` is absent from prod task def `vitana-gateway-awsdr:166`; and a registry does not remove the forward (the session is an in-process upstream connection), so Redis adds a dependency without removing any part of this design.
- F5 ACCEPTED — mint site `live-session-controller.ts:1147` added to scope; grep found no parser of SSE session ids; the PR re-runs the grep and the orb-live suites.
- Q1/Q2 — see F1: bridge + permanent SSE-fallback fix; not a replacement for WS.
- Q3 — see F2.
- Q4 — confirmed from your evidence: the rule exists; the workflow step is removed.


## Round 2 — partner response
**Verified premises (partner):** WS rolled back by VTID-04934 (`docs/validation/VTID-04934/acceptance.md:1-14`) — TRUE; `_latchWsFallback` keeps SSE as fallback (`orb-widget.js:1397-1403`) — TRUE; mint site `live-session-controller.ts:1147` — TRUE; SG rule exists — TRUE. Existing tests use `live-abc`/`live-1` ids without an owner part, so they are unaffected.

F1 closed; F2 closed; F3 closed; F4 acknowledged (rejection sound: `REDIS_URL` absent and a registry would not remove the forward); F5 closed.

- **F6 [minor]** Risk section still says "HMAC tag" though the design now uses AES-256-GCM.
- **F7 [minor]** Specify behaviour when `GATEWAY_INTERNAL_TOKEN` or task metadata is absent (local dev): no owner part.

Partner verdict round 2: **CONVERGED** (F6, F7 minor; folded in).

## Planner responses (round 2)
- F6 ACCEPTED — Risk line now says AES-256-GCM.
- F7 ACCEPTED — owner part only when flag on + task metadata + internal token; otherwise `live-<uuid>` as today.

