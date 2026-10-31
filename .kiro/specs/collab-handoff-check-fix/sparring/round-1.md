# Sparring round 1 — in_progress

Session: `f08364e1-8cd8-468e-b6ec-5df7bf0bef92` · plan hash `88c25e539983fc2b7eaa14e0d18788eded41908bd885684c72c40d3ebcd55e1e`

## Summary

The plan is thorough, well-researched, and all key premises verified against the pinned commit hold. The R1 diagnosis (ci-plan-spar counted in session-per-lane), R4 (specs missing from programmes), silent failure, and batching problems are all accurately identified. The proposed fixes are correctly scoped. I found no blockers and only one minor finding worth noting.

## Findings

### R1-F1 [minor]

Several specs listed in the R4 problem statement and to be added by the `program-registry` lane (`native-wave2-events-calendar`, `native-wave2-sharing-business`, `native-wave2-profile-settings`, `i18n-propagate-stale-write`) do not exist in `.kiro/specs/` on `main` at the pinned commit. Only `native-wave2-home-feed-news`, `desktop-spotlight-finish`, and `sparring-floor-retry` exist on main. The plan's item 5 for `native-app` correctly says "on `main` or with an open `plan(` PR" but the R4 problem statement implies all seven exist on main ("Not listed on `main`"). Adding specs proactively to programmes is harmless, but the lane builder should confirm the exact spec slugs from the open PRs — a typo in a slug name would silently not fix that PR's R4 failure (the entry would just be inert in the programme).

- `exafyltd/vitana-platform:docs/programs/native-app/program.md:7` — specs: []
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:843` — if (programs.length) {
      const idx = programIndex(programs);
      for (const slug of new Set(touched.map((p) => classifyPath(p)?.slug).filter(Boolean))) {
        if (!idx.has(`${repoName}:${slug}`)) e.push(`.kiro/specs/${slug}: not listed by any docs/programs/<id>/program.md (specs: [${repoName}:${slug}])`);
      }

Suggestion: When building the `program-registry` lane, enumerate the exact slugs from each open PR head (e.g. `git ls-tree -r --name-only <pr-head> -- .kiro/specs`) to confirm each slug name before adding it to the programme file. The test in `program-registry.test.mjs` could assert each added slug passes `SLUG_RE` and is listed exactly once.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
