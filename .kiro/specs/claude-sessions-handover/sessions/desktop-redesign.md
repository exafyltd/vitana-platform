# D - Desktop redesign (session_01Sxnx4eGehRHRqqwu4YmJA6)
- Created 2026-10-12 16:24 / updated 2026-10-14 02:25 UTC; status idle (bucket completed). Branch `claude/vitanaland-desktop-redesign-kv8059` in both vitana-v1 and vitana-platform. Model claude-opus-5-5.
## Goal
Roll out the "Spotlight" desktop design contract (ScreenFrame/VCard/archetypes) across all community-app screens, phase by phase. (Inferred from PR/VTID titles; original user request not seen.)
## Done
- Merged vitana-v1 PRs (all CI-green): #1365 (Phase 4 social, VTID-05110), #1372 (Phase 2, 05108), #1374 (Phase 5 Tier B, 05111), #1375 (7.2-7.4 BackOffice/Dev/Professional/Staff, 05114/15/16), #1379 (7.5 remaining screens + 6.1 + 6.2 part 1, 05117/05112), #1386 (6.2 part 2, left/right to start/end in 173 files, 05112), #1399 (fix-forward /alkalma TenantPortal framed on phones + /e/game spec, 05117; merged as c2df019, verified merged via GitHub).
- Nothing is verified on staging, so no Gate 2 was sent. Production was 0186386 at last check; c2df019 would ship 12 commits (ours: #1374 #1375 #1379 #1386 #1399; others: VTID-05147 #1369, 05155 #1376, 05151 #1382, 05173 #1387, 05185 #1391, 2 i18n-bot commits).
## State now
- No open PRs seen. Check-in routines stopped by the session (last trigger ids seen: trig_01BPK7oe6G84jRp24Zr5LYbs, trig_01JKMQWv6YF3grGtZ1zReMY2; whether any remain armed is unknown).
- Best staging run on c2df019: 33/36 passed but 0 attributed (staging kept being redeployed by other sessions). 3 suites fail on every run, probably real: all 8 /health/* (Spotlight frame never appears in 30s); /autopilot and /business* (4 routes, fail in ~3.5s, looks like redirect/role gate); Professional/Staff placeholder pages (neither frame nor NotAuthorized in 45s). Not diagnosed: no screenshots uploaded and no test credentials in the session.
## Blocked on / needs owner
Five decisions pending: (1) ~3,340 raw colour classes with no same-in-light/dark token: accept shifts or add tokens (design-contract change needs sparring first); (2) ~360 arbitrary sizes: new size tokens or per-line exception; (3) 27 page spinners to skeletons (changes mobile loading); (4) I18N-PROPAGATE bot writes stale locale files back and reverted translations on #1399, needs own fix + VTID; (5) older open items: public profile and /me/profile, /business/sell-earn for non-resellers, /redeem, /tickets/*, /delete-account, /shop and commerce portal lack sidebar, an admin-role test account for staging.
## Next steps for Kiro
1. Read Playwright screenshots/traces of a stable STAGING-VERIFY run for the 3 failing suites and fix forward under VTID-05111 / VTID-05117 (frontend PRs; staging tests are read-only).
2. Open a plan (sparred, `plan(` PR) for the I18N-PROPAGATE stale-write bug.
3. Prepare the plans for decisions 1-3 once the owner answers.
4. Claude-Code/Project-Manager only: merge, and Gate 2 ("Staging verified, ready for production?") from the first passing run on a commit containing c2df019; any prod deploy ships the full snapshot (list all other sessions' commits).
## Gotchas/lessons
- Staging is redeployed by other sessions mid-run, so runs get "superseded" with 0 attributed tests; follow the newest commit that contains yours.
- Spotlight: phones never get Spotlight; frame only when useSpotlightEnabled() is true.
- No writes as the test user, even on staging (shared prod Supabase).
