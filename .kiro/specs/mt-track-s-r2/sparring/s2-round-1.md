# Sparring round 1 — in_progress

Session: `e0495df4-f954-42e1-bfcf-d0de4e2a4ac9` · plan hash `6aa020277dfe7634033e3a42bdef7614546fb64b585f0ea2fe63c6a416ce0c76`

## Summary

The plan is well-constructed and technically sound. All verifiable premises about the existing codebase hold at the pinned commit. The scope is narrow and appropriate for a standard change class: removing a dead function, updating the test that reads it, adding a CI gate for future edge functions, and allowing the retirement workflow to undeploy the dead function's production copy. No blockers or major issues found. One minor observation about deploy-workflow interaction.

## Findings

### R1-F1 [minor]

The plan does not mention that merging lane 1 (deleting the linkedin-import folder) to main will trigger the `supabase-functions-deploy.yml` workflow via its `paths: ['supabase/functions/**']` trigger. Because the cutover gate (line 47, date June 8 2026) is in the past relative to the Oct 2026 code dates, the deploy job is skipped (frozen=true), so no failure occurs. But the plan's §7 statement 'an edge-function folder removal is not deployed by any staging workflow' could be more explicit about why — the cutover gate freeze prevents the deploy job from running, not the absence of a trigger.

- `exafyltd/vitana-v1:.github/workflows/supabase-functions-deploy.yml:15` — on:\n  push:\n    branches: [main]\n    paths:\n      - 'supabase/functions/**'
- `exafyltd/vitana-v1:.github/workflows/supabase-functions-deploy.yml:46` — CUTOVER_EPOCH="$(date -d 'TZ="Europe/Berlin" 2026-06-08 10:00:00' +%s)"\n...\necho "frozen=true" >> "$GITHUB_OUTPUT"

Suggestion: Add a sentence in §7 or §9 noting that the deploy workflow triggers on the merge but the cutover gate freezes the deploy job, so no deploy or failure occurs. This avoids confusion for the implementer.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
