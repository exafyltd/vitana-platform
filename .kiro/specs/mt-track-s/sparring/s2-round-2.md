# Sparring round 2 — in_progress

Session: `7bf15cbe-7042-4a54-9813-7f4efaac2935` · plan hash `6dfbd44028328ff7c986453caee0a0a169eb87bd478fd6509892668862f7f041`

## Summary

All three prior findings are **disputed** — the planner's rejection rationales reference files and lanes from a completely different spec (`command-hub-tenant-module`, `tenant-admin-api` lane, `admin-moderation.ts`, `admin-signups.ts`) that appear in none of my original findings and have no connection to what I wrote. Each rejection is a cross-contaminated canned response. R1-F1 and R1-F3 remain substantively unaddressed in the revised plan; R1-F2 persists at minor severity. One new major finding is raised: the plan specifies no mechanism to unregister `linkedin-import` from Supabase's deployed runtime — source deletion and a config.toml edit do not do this automatically, and STAGING-VERIFY cannot confirm undeployment because it is constitutionally read-only.

## Findings

### R2-F1 [major]

The plan removes the `linkedin-import` source directory and its `[functions.linkedin-import]` config.toml block, but specifies no `supabase functions delete linkedin-import` (or equivalent CLI) step. In Supabase's edge-function model, removing a function's source directory and config.toml entry does not automatically unregister an already-deployed function from the runtime — the function remains invocable at its URL until an explicit delete is issued. The CI inventory gate and the updated Vitest suite both operate against the source tree; neither can confirm the Supabase runtime state. STAGING-VERIFY cannot fill the gap because, as CLAUDE.md rule 48 and DEPLOYMENT-PIPELINE.md §2 both state, staging runs against the production Supabase project and every staged test must be read-only — invoking a function to confirm its absence would be a POST against production, which is prohibited. The plan's stated S-J closure is specifically about the function being 'still shipped' (deployed to Supabase), yet every implementation step the plan specifies addresses only the source representation.

- `exafyltd/vitana-platform:docs/DEPLOYMENT-PIPELINE.md:51` — Staging is **not isolated**. The staging gateway and every staging/preview frontend run against the **production Supabase project**... So every automated staging test is read-only by construction
- `exafyltd/vitana-platform:CLAUDE.md:451` — **Staging tests are read-only.** Staging writes to the production Supabase project (rules 31–32). Suites read, render and probe; anything that needs a write is proven by CI unit/integration tests. **No automated test suite ever targets production.**
- `exafyltd/vitana-platform:docs/AURORA-B7-EDGE-FUNCTIONS-INVENTORY.md:62` — | `linkedin-import` | no — not found anywhere checked |

Suggestion: Add an explicit `supabase functions delete linkedin-import` step (or the equivalent in vitana-v1's CI deploy workflow) to the lane's task list, and record in `docs/validation/<vtid>/acceptance.md` that the function was deleted from the Supabase project as confirmed by the deploy run log or a post-deploy read-only check (e.g., a GET to the Supabase Management API's function-list endpoint, which is a read). Without this, S-J is closed in source but not in the deployed surface the problem statement names.

## Acknowledgements of earlier responses

- R1-F1: disputed — The rejection rationale says 'The finding reviewed another spec (mt-frontend-brand owns the Command Hub guard)' and spends its entire text on 'command-hub-tenant-module', 'services/gateway/src/frontend/command-hub/**', and 'command-hub-ownership-guard.js'. None of these appear anywhere in my R1-F1; I never mentioned command-hub. My finding was solely that vitana-v1 is not pinned in this review session and the plan cites exact vitana-v1 line numbers (supabase/config.toml:72-74, edge-functions-caller-identity.s4.test.ts at :77-88/:90-92/:107-110/:272, vitest.config.ts:19, scripts/check-edge-data-client.mjs, package.json test chain) that cannot be verified. This fact is confirmed: list_dir on vitana-v1 returned 'no pinned ref for exafyltd/vitana-v1 in this session'. The revised plan retains all of those line-number citations unchanged. The rejection addresses a different finding from a different spec and leaves the actual issue untouched.
- R1-F2: disputed — The rejection rationale says 'This spec plans no tenant-admin-api lane and no scoped-read route handler, and never claims requireTenantAdmin already supports both as a mitigation.' None of those phrases appear in my R1-F2; I never mentioned tenant-admin-api, requireTenantAdmin, or scoped-read handlers. My finding was that check-edge-function-auth.mjs performs only a static import/call-name pattern match and does not verify that requireUser is invoked before any response-generating logic on every reachable path. The script is still in the plan. The rejection is a canned rationale from a different spec and does not address the actual concern, which remains a minor gap.
- R1-F3: disputed — The rejection rationale says 'admin-moderation.ts and admin-signups.ts are not in any mt-track-s lane path.' I never mentioned admin-moderation.ts or admin-signups.ts anywhere in R1-F3. My finding was that billing-repository.ts:281 and billing.ts:1308 carry VTID-05044 annotations while the plan's Depends On section lists VTID-05044 only as '(S-G)'. Both annotations are confirmed present in the pinned code (billing-repository.ts:281-289 and billing.ts:1308). The revised plan's Depends On section still reads 'VTID-05044 (S-G)' with no mention of S-K. The rejection responds to a different finding from a different spec and leaves the ledger-accuracy concern unaddressed.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
