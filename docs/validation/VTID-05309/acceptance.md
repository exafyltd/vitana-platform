# Acceptance — messenger-ux-v2 closing records (VTID-05309)

Plan: `messenger-ux-v2`. Repos: `exafyltd/vitana-v1`, `exafyltd/vitana-platform`.
Scope of this PR: closing records only (`docs/validation/VTID-05309/**`, `.kiro/specs/messenger-ux-v2/handoff.md`).
No product code, no state changes to lanes or the plan.

AC-1: All 14 lanes (VTID-05309 to VTID-05322) are recorded in timings.json with a merge time.
TEST: node -e "const t=require('./docs/validation/VTID-05309/timings.json'); if(t.lanes.length!==14||t.lanes.some(l=>!l.merged_at)) process.exit(1)" → pass
UI: n/a — closing record, no user-facing screen.

AC-2: timings.json uses schema vitana.plan-timings/v1 and lists every unknown field in sources_unavailable (no invented zeros).
TEST: node -e "const t=require('./docs/validation/VTID-05309/timings.json'); if(t.schema!=='vitana.plan-timings/v1'||t.sources_unavailable.length<1) process.exit(1)" → pass
UI: n/a — closing record, no user-facing screen.

AC-3: The community-app STAGING-VERIFY passed on the deployed main commit 5c75715e1 (run 41491021698).
CURL: gh api repos/exafyltd/vitana-platform/actions/runs/41491021698 --jq .conclusion → success
UI: n/a — evidence is the CI run, not a screen.

AC-4: All 11 messenger claim refs and the driver heartbeat ref are gone from origin.
TEST: git ls-remote --heads origin 'refs/heads/collab-claim/messenger-ux-v2/*' 'refs/heads/collab-driver/messenger-ux-v2' | wc -l → 0
UI: n/a — git refs only.

AC-5: Gate 2 is not sent by this PR. The owner decides production (PUBLISH). Nothing is deployed to production.
TEST: grep -c "Gate 2 is not sent yet" .kiro/specs/messenger-ux-v2/handoff.md → 1
UI: n/a — a decision recorded in the handoff log.

## Not verified

- No Playwright or screenshot evidence exists for the Messenger lanes. The owner's visual check on staging is the acceptance step for the look.
- Per-lane review rounds, claim times and merge conflict counts are not recorded in a structured source (see timings.json sources_unavailable).
