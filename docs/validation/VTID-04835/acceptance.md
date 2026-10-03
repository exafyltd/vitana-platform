# VTID-04835 — a gateway task ECS replaces ended its live voice sessions with no stop

The gateway registered no SIGTERM/SIGINT handler anywhere (`grep -rn "process.on(" services/gateway/src` on origin/main: no signal handler; `services/gateway/src/index.ts:1609` `app.listen` has no shutdown path). The container runs `CMD ["node", "dist/index.js"]` (`services/gateway/Dockerfile:76`, no init process), so node is PID 1 and the kernel ignores a default-disposition SIGTERM: on a deploy / scale-in / unhealthy replacement the task sat until SIGKILL at ECS `stopTimeout` (default 30 s — neither `AWS-STAGE-DEPLOY-GATEWAY.yml` nor `AWS-PROD-DEPLOY-GATEWAY.yml` sets it; both clone the live task definition), and every session in `liveSessions` (`routes/orb-live.ts`) ended with no `vtid.live.session.stop` and no `voice_session_facts` end. Recorded as residual in docs/validation/VTID-04785/acceptance.md.

Fix:
- `emitShutdownStopsForLiveSessions(reason='server_shutdown', timeoutMs=5000)` (`orb/live/session/live-session-controller.ts`): for every live session not yet `stopEventEmitted`, latches, emits one stop with `reason` + the usual `stopEventContext` fields, calls `recordLiveSessionEnd`, then awaits the OASIS emits and the queued facts writes (`flushVoiceSessionFactsWrites`, new in `services/voice-session-facts.ts`) bounded by `timeoutMs`. Idempotent, never throws, unref'd timer.
- `services/graceful-shutdown.ts` (new): the one SIGTERM/SIGINT handler. Runs drain hooks raced against `drainTimeoutMs`, then `server.close()`, then exits 0 once closed or after `closeGraceMs` (2 s; open WebSockets would otherwise hold `close()` until SIGKILL). A second signal is ignored. Worst case ≈ 7 s, inside the 30 s default.
- `src/index.ts`: installs it inside the `app.listen` callback with a drain hook calling `emitShutdownStopsForLiveSessions('server_shutdown', 4500)`.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: On shutdown every live session not yet reported gets exactly one `vtid.live.session.stop` with `reason:'server_shutdown'`, `transport` (`websocket`|`sse`), the live session id, metrics and surface/role/lang/provider, and one `voice_session_facts` end; the facts writes are awaited.
  TEST: services/gateway/test/vtid-04835-shutdown-drain.test.ts
AC-2: Sessions already reported by another end path are skipped; a second drain emits nothing; a socket close after the drain books nothing more (shared `stopEventEmitted` latch).
  TEST: services/gateway/test/vtid-04835-shutdown-drain.test.ts
  TEST: services/gateway/test/vtid-04834-live-session-start-stop-once.test.ts
AC-3: Bounded and never throws: a hanging emit / facts write returns `timedOut:true` at the bound; a throwing emit costs only that OASIS row (the facts end is still recorded, other sessions unaffected); an unconfigured controller is handled.
  TEST: services/gateway/test/vtid-04835-shutdown-drain.test.ts
AC-4: The SIGTERM/SIGINT handler drains, then closes the server, then exits 0 — once per process however many signals; a hanging drain hook or a `server.close()` that never calls back cannot hold shutdown past its bounds; `index.ts` installs it with the live-session drain and no other file registers a competing signal handler.
  TEST: services/gateway/test/vtid-04835-shutdown-drain.test.ts
AC-5: No voice payload change: VTID-04542 snapshots unchanged; role / support / operator regression suites and the full gateway suite green.
  TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
  TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/orb/live/session/live-session-controller.ts (`emitShutdownStopsForLiveSessions`)
- services/gateway/src/services/voice-session-facts.ts (`flushVoiceSessionFactsWrites`)
- services/gateway/src/services/graceful-shutdown.ts (new)
- services/gateway/src/index.ts (installs the handler)
- services/gateway/test/vtid-04835-shutdown-drain.test.ts (new)
- docs/validation/VTID-04835/**

No route, schema, migration, task-definition or client change. Not covered: the end-of-session memory commit (`finalizeLiveSession`) is not run on shutdown — only the stop event and the facts end, as scoped.

## OASIS

OASIS_PROOF: no new topic. `vtid.live.session.stop` gains `reason:'server_shutdown'` rows, one per live session on a task ECS stops (`transport` `websocket`|`sse`); `voice_session_facts.close_reason='server_shutdown'`. Expected on production after PUBLISH (read-only check): around each gateway deploy, sessions started on the old task have a `server_shutdown` stop instead of none. Asserted in test/vtid-04835-shutdown-drain.test.ts.
