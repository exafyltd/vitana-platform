# D - Multi-tenancy architecture (session_01TMPMNGNEtPxKwmVqyfdx46)
- Created 2026-09-25, updated 2026-10-15T16:20 (idle). Branch claude/zealous-pasteur-i0czi8. Coordinator for multi-tenant/_plan.

## Goal
Multi-tenant (community provisioning) program; M0 slices (VTID-05147/05149/05150/05151) already in production; handing the next slice to Kiro.

## Done
- platform#4144 MERGED 2026-10-15 (3d41dee6, verified): .kiro/specs/multi-tenant/ (requirements, design, tasks, handoff, plan-sparring; 2 rounds converged, record 6400562e, Gate 1 yes) + lane provisioning-ui (VTID-05221, executor Kiro, seat hotmail, ready). Docs only, no deploy/Gate 2.

## State now
- Lane multi-tenant/provisioning-ui is `ready` on main awaiting Kiro IDE (seat hotmail). Owner got paste-in start prompt; whether Kiro started is unknown.
- VTID-05222 (read-only 24h signup re-check, AC-10 of 05149) still for Claude to run.

## Blocked on / needs owner
Owner pastes start prompt into Kiro IDE (hotmail, dstevanovic@hotmail.com, both repos open). Session could not message the coordinator session.

## Next steps for Kiro
1. Claim `multi-tenant/provisioning-ui`: queue.mjs session-id --agent kiro --seat hotmail; claim ... --session <id>; read .kiro/specs/multi-tenant/; branch kiro/multi-tenant/provisioning-ui in vitana-v1; PR "VTID-05221 (multi-tenant/provisioning-ui): exafy-admin New community panel" (exafy-admin panel over live provisioning API; no paths under supabase/migrations or .claude).
2. Claude-Code-only: review + merge Kiro PR, Gate 2, VTID-05222 re-check, anything production.

## Gotchas
scope.json needs collab_allow_initial for a backfilled spec. Spec rules: migration queue order and lane ranges, dark-by-default, 05147 AC-5, Lane C whitelist, production read-only. validate-pr failed on earlier commits until squashed. Stale notifications can reference pre-squash heads.
