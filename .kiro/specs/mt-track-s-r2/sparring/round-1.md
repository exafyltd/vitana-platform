# Sparring round 1 — in_progress

Session: `436ea5e3-4953-4ab1-8e26-fe87bfef419a` · plan hash `3983ad2f6f9400936ea8476f6875bcf924f698b68cb39bca82f81ed96b37bc0d`

## Summary

The plan is well-structured with careful governance analysis. However, there is a significant traceability issue: the plan claims to close "S-J" but the actual work (linkedin-import removal + CI auth gate) does not match what S-J describes in the canonical MULTI-TENANT-PLAN.md. All file-level premises about vitana-v1 cannot be directly verified (no pinned ref for that repo), but the vitana-platform premises I could check hold. The governance reasoning for the retire dispatch (owner approval as a production write, not a §7d routine dispatch) is sound.

## Findings

### R1-F1 [major]

The plan claims to close 'the one open residual, S-J' (§1), but the canonical definition of S-J in MULTI-TENANT-PLAN.md §3 (line 46) is 'all `/debug/*` routes (`/debug/intent`, `/debug/tts`, `/debug/awareness` orb-live.ts:15069 with `?user_id` + `x-service-role-key`), driven by the WS0 generated route inventory; non-private realtime broadcast channels (`system-notifications`, `user:<id>:calls`)'. The plan's actual work — removing linkedin-import and adding a CI auth gate — corresponds to S-H residual cleanup (S-H, line 44: 'edge functions trusting body `user_id` with service role: `linkedin-import`...'). Moreover, the plan's §10 explicitly defers the real S-J items: '(b) `requireAuth` on the dev-sandbox `/debug/memory` and `/debug/intent` (WS0 route inventory)'. If this plan marks S-J as CLOSED, the debug-route exposures (unauthenticated endpoints taking arbitrary user_id) lose their Track S tracking status.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:44` — S-H edge functions trusting body `user_id` with service role: `linkedin-import`, `social-media-import`, `queue-campaign-recipients`, `send-welcome-discount`.
- S-I ... 
- S-J all `/debug/*` routes (`/debug/intent`, `/debug/tts`, `/debug/awareness` `orb-live.ts:15069` with `?user_id` + `x-service-role-key`), driven by the WS0 generated route inventory; non-private realtime broadcast channels (`system-notifications`, `user:<id>:calls`).

Suggestion: Either (a) correct the label: this plan closes the S-H residual (linkedin-import removal after VTID-05049 auth-gated it), not S-J; S-J stays open and tracked, or (b) if the prior spec `mt-track-s` genuinely redefined S-J to mean the linkedin-import removal, cite the prior spec's exact redefinition so the canonical MULTI-TENANT-PLAN.md S-J items (debug routes, realtime channels) are visibly still tracked elsewhere with their own item ID. The plan must not mark any Track S security item as CLOSED when its canonical scope is still open.

### R1-F2 [minor]

All file-level premises in §2 reference vitana-v1@58c76c956 but no pin exists for that repo in this review session, making line-number claims (linkedin-import/index.ts:4,6-8; config.toml:72-73; edge-functions-caller-identity.s4.test.ts:6,77,90,107-108,272; package.json:29; SUPABASE-FUNCTIONS-RETIRE.yml:42-45) and the structural counts (65 function folders, 6 importing caller-auth, 59 LEGACY) unverifiable against the pinned code. The plan says the lane's step 1 re-checks these at the lane's base commit, which is good, but the plan itself should be verifiable at sparring time.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:1` — # Vitana Multi-Tenant Program Plan (v5.1)

**Status:** program plan, sparred...

Suggestion: If feasible, include the vitana-v1 commit in the session pin so the sparring partner can verify file-level premises directly. Otherwise, no action needed if the lane's step-1 recheck is treated as a hard gate (abort if any mismatch).

### R1-F3 [minor]

The LEGACY map in check-edge-function-auth.mjs is generated once and frozen. The plan says 'a LEGACY key with no folder also fails (the map only shrinks)' but does not specify what happens when a legacy function is later migrated to use caller-auth: should it be removed from LEGACY? Without a rule, LEGACY entries accumulate even after migration, weakening the signal. More importantly, the plan does not describe how future plans discover and update the LEGACY map — each new removal (like this linkedin-import one) must know to check whether the function was in LEGACY.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:44` — S-H edge functions trusting body `user_id` with service role: `linkedin-import`, `social-media-import`, `queue-campaign-recipients`, `send-welcome-discount`.

Suggestion: Add a comment in the LEGACY map noting that entries should be removed when the function is migrated to caller-auth (or deleted). Consider also making the gate warn (not fail) when a LEGACY-listed function already satisfies the auth requirement — this surfaces migrated functions that can be de-listed.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
