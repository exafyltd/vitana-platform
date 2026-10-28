# D - Native Apps & Health data (session_01VuZPi9pvHaUverAXRC1WvU)
- Created 2026-09-25, updated 2026-10-15T19:01 (idle, review_ready). Branches: claude/health-data-integration-plan-dbxyld* (~34, both repos; incl. -kiro-handover, -d10w1, -n4gw, -platfix).

## Goal
Health Hub (health data integration, VTID-05020) and native Expo iOS/Android app (VTID-05021) programs. Last owner ask (2026-10-15 18:53): write handover so Kiro continues the full plan.

## Done
- Merged: Health Hub Phase 0 (D12, D1-D8, 05155/05156, 05173/05174), A1 health store schema (platform#4102), B1 health_sources (platform#4104); native Wave 1+1b whole stack on vitana-v1 main (#1390-#1397, #1400, #1401) and platform N4-GW #4113/#4117 (switched off).
- Handover PR exafyltd/vitana-platform#4147 MERGED 2026-10-15T19:09Z (checked via GitHub; docs only, nothing deploys): .kiro/specs/health-native/ (handoff.md, tasks.md, 8 lanes) + docs/validation/VTID-05020/scope.json.

## State now
- Open draft PRs (per handoff.md, status as of 10-14/15, not re-checked): platform #4057 (05090), #4100 (05092), #4105 A2, #4109 B2, #4111 B3, #4107 C1, #4110 C2; vitana-v1 #1342, #1377, #1383, #1380, #1388, #1398, #1392. Gateway PRs red only on `drift` (unapplied migrations); v1 PRs green.
- send_later check-in (trig_014qGXNwsq2e1CYt9qwZVuyS, ~19:51Z) is moot now that #4147 merged.
- Gateway 0b875e982 passed STAGING-VERIFY 116/116; prod deploy (Gate 2 sent 10-14) unconfirmed.

## Blocked on / needs owner
Gateway prod deploy of 0b875e982; apply migrations 20261012180000_vtid_05092_health_consent_categories.sql and 20261012200000_vtid_05090_partner_dpa.sql (RUN-MIGRATION.yml); yes/no on authenticated Docker pulls in CI (public.ecr.aws 429); program gates G1/0T isolated test env, G2 push/Firebase project, G3 App Store/Play access, 0L legal (DPIA, DPO, counsel, DPAs); counsel wording for C3.

## Next steps for Kiro
1. Claim lanes in .kiro/specs/health-native/lanes: `d10-wp3-enforcement` (VTID-05094, consent checks at 8 places) and `n5a-health-sync` (re-vendor contract after C1 #4107 merges, swap stubs) are buildable now; `n6b-ios-voice` needs a Mac/Xcode (assigned to Kiro desktop on owner account).
2. Write `plan(<slug>)` PRs (CI spars, VTIDs from CI): native-g1-wiring, native-eas-builds, 14 Wave 2 screen-port plans, Wave 3 beta/store; Health Hub B3 cutover, Phase 2/4/5, deferred follow-ups. Keep docs/programs/health-hub/STATUS.md current.
3. Claude-Code-only: merges (until PM runs), Gate 2/prod deploys, migrations, governance paths, the 5 in-flight-PR lanes (d9-partner-dpa, d10-consents, phase1-data-core, a3-erase-raw, v1-d5r). Merge order A2 -> C1 -> B2 -> B3 -> C2.

## Gotchas
Never test on prod (staging uses prod Supabase; specs read-only). Native reaches web only via @vitana/core. React 19: no global JSX. v1 i18n stamp conflicts after each main move (resolve by key, regenerate SCREEN_INVENTORY). Stacked PRs merge their base branch. Heavy Jest logging overflows STAGING-VERIFY (1 MB) - silence console. validate-pr needs VALIDATION_PROFILE etc. in PR body (VTID-05020 is terminal in ledger). Session cost ~$860.
