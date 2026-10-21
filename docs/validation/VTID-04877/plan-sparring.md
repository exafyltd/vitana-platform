# Plan sparring record — VTID-04877

- **Plan hash (sha256 of the text between the plan markers):** `5fb78584e36894d1002885734de7b4f2b3516d71f6a20d5432751c92b250615d`
- **Change class:** light
- **Partner:** independent read-only agent following `.claude/agents/plan-sparring-partner.md`. The `plan-sparring-partner` agent type was not loaded in the session yet, so the skill's documented fallback was used.
- **Rounds:** 2. Round 1: NOT CONVERGED (2 major, 5 minor). Round 2: CONVERGED (F1–F7 closed, 1 new minor, accepted).
- **Order exception (owner decision):** VTID-04877 was allocated, and the stale-while-revalidate edit was drafted (uncommitted), before the gate (VTID-04868, merged the same day) was visible to this session. The order is disclosed in the plan. The owner approved the sparred plan in session on 2026-10-04 ("Approved"), which accepts that order for this VTID.

## Round 1 findings (verbatim summary)
- F1 [major] The code was written before sparring and owner approval → ACCEPTED (disclosed; owner asked).
- F2 [major] There is no concrete staging test, only "read the CloudWatch lines" → REJECTED with a substitute. The STAGING-VERIFY runner's http tests send no credentials (scripts/ci/staging-verify/run.mjs:164-177), so an admin GET cannot run. The suite is /alive plus jest `existing` entries; the partner accepted this in round 2.
- F3 [minor] gate_ms on every return path, typed optional → ACCEPTED.
- F4 [minor] Log unaccounted_ms so the hypothesis can be proven wrong → ACCEPTED.
- F5 [minor] Generation fence for invalidate during a pending refresh → ACCEPTED.
- F6 [minor] The Risk section understates staleness (one read per task, at any time distance) → ACCEPTED.
- F7 [minor] List every getMemoryContext caller; check for deep-equal on meta → ACCEPTED (none found).

## Round 2
F1–F7 closed. F8 [minor]: a missing gate_ms or an empty stream map must not print NaN → ACCEPTED, and tested.
Verdict: **CONVERGED**.

## Final plan
<!-- plan:begin -->
**Change class:** light. 3 code files plus validation docs. No migrations, routes, auth, .github, deploy, governance or LLM-routing files.

**Scope:** services/gateway/src/services/memory-broker.ts, services/gateway/src/services/memory/recall.ts, services/gateway/test/services/memory-broker.test.ts (+ recall log test), docs/validation/VTID-04877/**.

**Already-written code (disclosed).** A stale-while-revalidate edit to `isBrokerEnabled()` already exists, uncommitted, in the working tree. It was written before the gate was seen. Nothing is committed or pushed until the owner approves this plan. If the owner says no, the edit is discarded.

**Problem (evidence).** This is the memory plan §8.4 phase 2 gate: recall() is 2–3x slower than the legacy read. The first 3 staging `[VTID-04452] orb recall` lines with VTID-04870's `stream_ms` (read-only CloudWatch, 2026-10-04):
- total 444 ms; streams 213 / 219 / 378
- total 157 ms; streams 95 / 78 / 87
- total 542 ms; streams 250 / 249 / 263

The streams run in parallel. The total exceeds the slowest stream by 66–280 ms. The only serial step before the fetchers is `isBrokerEnabled()`: a 30 s cache over `getSystemControl` (which has its own 10 s cache, then makes a PostgREST GET). Voice sessions are minutes apart, so both caches are cold on nearly every session.

**Change.**
1. `isBrokerEnabled()` becomes stale-while-revalidate.
   - The first read in a process (no known value) awaits the fetch. A failure or null means `false` (fail closed), as today.
   - After that, an expired value is returned at once and one background refresh starts. A single in-flight promise means only one refresh runs at a time.
   - `invalidateBrokerFlagCache()` bumps a generation counter. A refresh writes the cache, and clears the in-flight slot, only if its generation still matches.
2. Measure instead of assuming.
   - `MemoryPack.meta` gains an optional `gate_ms`. It is set on the disabled and success branches; the input-contract branch sets 0.
   - recall() appends `gate_ms=` and `unaccounted_ms=` (total − gate_ms − max stream_ms) to the success log line, and `gate_ms=` to the `unavailable` warn line.
   - One staging line then either confirms the gate or points elsewhere, for example event-loop lag.
3. Tests:
   - With an expired cache, a read resolves while `getSystemControl` is still pending. This test fails on the old code.
   - The background refresh updates the value for the next read.
   - Invalidating during a pending refresh, then resolving it: the next read re-fetches (generation fence).
   - `meta.gate_ms` is a number.
   - The recall log carries `gate_ms=` and `unaccounted_ms=`.
   - The existing fail-closed and cache tests stay green.

**Callers affected:** `memory/recall.ts`, `context-pack-builder.ts`, `memory-orchestrator.ts`, `agent-profile-service.ts`, `routes/memory.ts`, `routes/admin-memory-broker.ts`. They all get the SWR flag and the optional meta field. None of them, and none of their tests, deep-equals the broker's `meta`.

**Risk.**
- After a flip of `memory_broker_enabled`, each gateway task serves one read on the old value, however long after the flip that read comes.
- A transient null in a background refresh caches `false` (fail closed, as today), and the next read takes the legacy path.
- The flag is not used or documented as a time-critical kill switch; the docs only list it as "on". The broker has a legacy fallback, so this is acceptable.

**Not in scope.** The per-stream ~200 ms; tracked under VTID-04870 / task #33 and picked up once `unaccounted_ms` shows what remains. No production flag changes.

**Verification.**
- Unit tests and tsc.
- `docs/validation/VTID-04877/staging-tests.json`: `/alive` (proves the deployed build serves) plus `existing` jest entries for the SWR and log-field tests.
- The STAGING-VERIFY runner's http tests are unauthenticated by design: scripts/ci/staging-verify/run.mjs:165-171 sends only an invalid probe token. An admin GET of `/admin/memory/context` therefore cannot run there.
- Staging CloudWatch `gate_ms` / `unaccounted_ms` are supporting evidence, not the gate.
<!-- plan:end -->
