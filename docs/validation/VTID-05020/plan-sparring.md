# Plan sparring record — VTID-05020 (Health Hub program)

- Plan: `docs/programs/health-hub/HEALTH-HUB-PLAN.md` (revision r7)
- Final plan sha256 (text between the plan markers): `2ab79356101f263fc60200018f1fa3e3d60fc1684d7d81d8a1199aacaf736cf9`
- Sparring session id (plan_sparring_sessions, attested tier): `f0f442e1-6f0b-4f9e-a1f5-9381a4e2a6d5`
- Verdict: **CONVERGED** (3 rounds, then 2 rounds after the owner's Aurora correction)
- **Owner approval (Gate 1, Autonomy Contract VTID-04947):** "Yes to both plans" — 2026-10-10, Claude Code session, with the recommended decisions listed in the plan §8. Binding click: Command Hub `POST /api/v1/plans/spar/f0f442e1-6f0b-4f9e-a1f5-9381a4e2a6d5/approve` (pending).

## Rounds

- Partner: plan-sparring-partner role (read-only; run as an Opus-class Agent subagent in a Claude Code session — the gateway Bedrock tier was not used)
- Change class: standard · Rounds: 3 · Verdict: CONVERGED
- Final plan sha256 (text between plan markers): 1bb0b3f1a8c7520839c777b0a3f7478362188c924d8f0910a1893c95e29ee778

## Round 1 — partner verdict NOT CONVERGED
Verified premises: D1 TRUE (and worse: authenticated SELECT/INSERT/UPDATE on user_connections), D2 TRUE, D3 TRUE, D4 PARTIAL (L425 is the password button; two switches defaultChecked), D5 TRUE, D6 PARTIAL (wearable data reaches user-health-context and commerce), D7 TRUE, D8 TRUE, D11 TRUE; second integration model omitted.
- F1 [blocker] The codebase already turns wearable data into a disease label and uses it to rank marketplace products; §3.5 builds on that module → ACCEPTED
- F2 [blocker] health_observations has no user_id/tenant_id — erasure, RLS and tenant isolation break → ACCEPTED
- F3 [major] D1 fixes the wrong layer while authenticated holds SELECT/INSERT/UPDATE on user_connections → ACCEPTED
- F4 [major] Fail-closed D2 silently breaks Vital (Svix scheme) and Terra has no replay protection → ACCEPTED
- F5 [major] Deriving health_features_daily breaks five existing writers and Index history → ACCEPTED
- F6 [major] No environment to verify write paths end to end → ACCEPTED (Phase 0T)
- F7 [major] Storage/DB placement unsized; Aurora migration ignored → ACCEPTED (deferred to Phase 1 plan)
- F8 [major] Consent withdrawal does not propagate to derived data; webhook log keeps payloads → ACCEPTED
- F9 [major] MDR boundary under-specified (events, CGM, LLM rewrite guard) → ACCEPTED
- F10 [minor] D4 reference wrong; defaultChecked switches imply consent → ACCEPTED
- F11 [minor] OAuth callback leaks raw error messages → ACCEPTED
- F12 [minor] Scope creep (public Hub API; aggregator plus six directs) → ACCEPTED

## Round 2 — partner verdict NOT CONVERGED
F1–F6, F8–F12 closed; F7 acknowledged.
- N1 [major] Commerce boundary would remove the limitations-filter medication/allergy safety filter → ACCEPTED (single hide-only carve-out, CI-tested)
- N2 [major] Output guard cannot pre-check speech-to-speech voice → ACCEPTED (guard split by channel; voice prevention + transcript audit)
- Q1 delete-history confirmation/undo → 7-day soft delete with confirmation · Q2 memory extractor → included

## Round 3 — partner verdict CONVERGED
N1, N2 closed; F7 acknowledged (mandatory Phase 1 item).
- F13 [minor] Memory exclusion cannot be scoped per category (sensitivity is binary) → ACCEPTED (Phase 1 mapping + test)
- F14 [minor] 7-day soft delete must yield to account erasure → ACCEPTED (erasure test)

## Owner correction 2026-10-10 ("We use Aurora, not Supabase") — re-opened, 2 extra rounds
- Round A — NOT CONVERGED: F15 [major] partitioned/RLS tables do not "move with the cutover" (runbook TRUNCATE_BEFORE_LOAD, restore snapshots, memory_audit_log unattached partitions) → ACCEPTED (production go-live only on Aurora; parity gate otherwise). F16 [major] Supabase Auth stays permanently (Option A, owner 2026-09-19), Storage until S3 move → ACCEPTED (0T identity = separate free-tier test Supabase project; Supabase permanent processor; proxy smoke test prerequisite).
- Round B — CONVERGED: F15, F16 closed. F17 [minor] Phase 1 depends on cutover → ACCEPTED. F18 [minor] 0T trusts only the test JWT issuer → ACCEPTED.
- Final plan sha256: 2ab79356101f263fc60200018f1fa3e3d60fc1684d7d81d8a1199aacaf736cf9
