# Tasks — health-native (Health Hub + native app handover)

Programs: Health Hub VTID-05020 (`docs/programs/health-hub/HEALTH-HUB-PLAN.md`), native app VTID-05021
(vitana-v1 `docs/programs/native-app/NATIVE-APP-PLAN.md`). Status table: `docs/programs/health-hub/STATUS.md`.
Acceptance for every lane: its own PR checks green (incl. Lane scope), no writes to staging/production, STATUS.md
updated in the same PR, read-only `docs/validation/<VTID>/staging-tests.json` for anything that deploys.

## d9-partner-dpa
<!-- lane: d9-partner-dpa -->
- [ ] Owner applies `20261012200000_vtid_05090_partner_dpa.sql`
- [ ] `drift` green on platform #4057 → merge #4057 → merge vitana-v1 #1342
- [ ] STAGING-VERIFY passes for both → Gate 2
- [ ] PLAT-FIX change 6 (commerce-MCP link on the Terms/DPA step) as its own PR

## d10-consents
<!-- lane: d10-consents -->
- [ ] Owner applies `20261012180000_vtid_05092_health_consent_categories.sql`
- [ ] Merge platform #4100 → vitana-v1 #1377 → vitana-v1 #1383 (C3; counsel wording before the keys leave `_pending_review`)

## d10-wp3-enforcement
<!-- lane: d10-wp3-enforcement -->
- [ ] E1–E8 enforcement points exactly as in `docs/validation/VTID-05092/plan-sparring.md` §7
- [ ] Withdrawal → stop processing, quarantine release/purge as specified
- [ ] Unit/integration tests per enforcement point (E7/E8 own tests, round-1 F13); support/operator/roles regression suites green
- [ ] No spoken sentence hardcoded (NEVER rule 41) — E5 directive only

## phase1-data-core
<!-- lane: phase1-data-core -->
- [ ] After `d10-consents`: merge A2 #4105 → C1 #4107 → B2 #4109 → B3 #4111 → C2 #4110 (refresh stacked PRs from their base branch)
- [ ] Each merge: staging deploy + STAGING-VERIFY → Gate 2 (all ship dark)

## a3-erase-raw
<!-- lane: a3-erase-raw -->
- [ ] Merge vitana-v1 #1380 after A2 is merged

## v1-d5r
<!-- lane: v1-d5r -->
- [ ] After VTID-05174 is live in production and `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED=true` in prod: merge vitana-v1 #1388

## n5a-health-sync
<!-- lane: n5a-health-sync -->
- [ ] Re-vendor the Health Sync contract from C1's merge commit (contract test byte-for-byte)
- [ ] Replace the N3 auth stub and N4 flag stub with the real modules on main; delete the stubs
- [ ] Stays switched off; all NATIVE-CI gates green

## n6b-ios-voice
<!-- lane: n6b-ios-voice -->
- [ ] Xcode build + XCTest (duplex-gate vectors) on a Mac
- [ ] Real iPhone: `/dev/orb-bench` echo test, zero gate openings, fake gateway only (no live ORB on production)
- [ ] Close #1392 as superseded by #1401, or push only the remaining fixes

## Next plans to write (each its own `plan(<slug>)` PR → PLAN-SPAR → VTIDs; not lanes yet)
- Native: `native-g1-wiring`, `native-eas-builds`, Wave 2 screen ports (14 areas, NATIVE-APP-PLAN §5), Wave 3 beta/store/rollout/Appilix removal
- Health Hub: Index cutover on staging + Health Sync ingest switch-on preconditions; Phase 2 EU aggregator + D6b poller;
  Phase 4 AI recommendations (Bedrock only, user locale); Phase 5 labs & providers; STATUS.md deferred follow-ups
- Owner-only (record, do not build): G1/0T test environment, G2 push project, G3 store/signing access, 0L legal,
  CI authenticated Docker pulls (public.ecr.aws 429)
