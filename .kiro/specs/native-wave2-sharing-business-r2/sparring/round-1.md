# Sparring round 1 — in_progress

Session: `47230fc6-0040-4094-8fbb-f832197d6095` · plan hash `98a15e8ecd4af04e1248a002d5a512ec01f8d8ba23c325096729ed12bd09ca4a`

## Summary

Verified the core factual premises of the plan against the pinned commit. The 21 sharing-business ledger rows, their lane assignments, statuses, and the 8+13 partition all check out. App.tsx route line numbers, core-closure.mjs ownership guard location, parity-ledger.mjs shapeOf location, extraction-deps.mjs type-only filtering, and the html2canvas usage in InstagramShareModal are all confirmed. One substantive finding about divergent auth requirements in the two exclusion routes grouped together in the sharing lane.

## Findings

### R1-F1 [major]

The sharing lane groups `/pub/campaigns/:id` (no AuthGuard — public) and `/creator/onboarded` (wrapped in AuthGuard — authenticated) together as 'exclusion routes' without distinguishing their auth requirements. In the Expo Router file hierarchy the native app must place these in different route groups (public vs `(app)/` auth-guarded). The plan's test section calls both 'public landings', but `/creator/onboarded` is NOT public on the web — it is auth-guarded. The plan should specify which Expo Router route group each exclusion route goes in and ensure the auth model matches the web.

- `exafyltd/vitana-v1:src/App.tsx:860` — <Route path="/pub/campaigns/:id" element={<PublicCampaignLanding />} />
- `exafyltd/vitana-v1:src/App.tsx:1108` — <Route path="/creator/onboarded" element={
              <AuthGuard>
                <CreatorOnboarded />
              </AuthGuard>
            } />

Suggestion: Clarify in the sharing lane that `/pub/campaigns/:id` is a public (unauthenticated) route requiring placement outside `(app)/` (e.g., in a public route group with `PublicShell`), while `/creator/onboarded` is auth-guarded and goes inside `(app)/`. Adjust the test plan description from 'both public landings' to distinguish the two auth models, and add a test case verifying that the public campaign landing renders without a session.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
