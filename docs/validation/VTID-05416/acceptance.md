# VTID-05416: spotlight-card-proportion plan timings (docs only)

Plan `spotlight-card-proportion` (VTIDs VTID-05416..VTID-05420). This PR adds only the plan's measurement record
`docs/validation/VTID-05416/timings.json` (common rule 12, collaboration.md §8b). It deploys nothing.

AC-1: `timings.json` is valid JSON with `schema` = `vitana.plan-timings/v1`, lists all five plan VTIDs and one entry
per lane, and leaves a field `null` (never 0) where a source is missing.
TEST: node -e "const t=require('./docs/validation/VTID-05416/timings.json'); if(t.schema!=='vitana.plan-timings/v1'||t.vtids.length!==5||t.lanes.length!==5||t.staging_verify_ms!==null) process.exit(1)"

AC-2: every interval is derived from the recorded timestamps (GitHub `createdAt` / `mergedAt`, PLAN-SPAR policy
approval, the run's timing events), not estimated.
TEST: node -e "const t=require('./docs/validation/VTID-05416/timings.json'); const d=(a,b)=>Date.parse(b)-Date.parse(a); if(t.convergence_ms!==d(t.plan_pr_opened_at,t.converged_at)) process.exit(1); for (const l of t.lanes) if(l.build_ms!==d(l.claimed_at,l.pr_opened_at)||l.merge_ms!==d(l.accepted_at,l.merged_at)) process.exit(1)"
