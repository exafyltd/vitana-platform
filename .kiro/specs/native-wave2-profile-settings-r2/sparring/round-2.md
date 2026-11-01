# Sparring round 2 — in_progress

Session: `dffbaf66-2c23-4ad1-ae2a-520080973d18` · plan hash `745e826191a53b1f84cb45c147026bcbd58e593cf94bd0836efce44c5de42eb8`

## Summary

Round 2 review. The accepted R1-F1 (delete-account auth boundary) is properly addressed in the revised plan with decision 1a and a dedicated `delete-account` lane in `(public)`. However, the same auth-boundary issue applies to two more routes in the **profile** lane that the plan does not flag: `/u/:identifier` (PublicProfilePage, App.tsx:1493 — no AuthGuard) and `/profile/:id` (LegacyProfileRedirect, App.tsx:1482 — no AuthGuard). Both are accessible to signed-out visitors on the web, but neither is in GUEST_PATHS (guest-paths.ts:7-15), so placing their native twins under `(app)/` would cause AuthGate to redirect signed-out visitors to `/maxina`, breaking parity.

## Findings

### R2-F1 [major]

The profile lane includes `/u/:identifier` and `/profile/:id`, both of which are PUBLIC routes on the web (no AuthGuard — App.tsx:1493 and :1482 respectively). Neither path appears in the native GUEST_PATHS list (guest-paths.ts:7-15), and AuthGate (AuthGate.tsx:44-46) redirects signed-out visitors to `/maxina` for any path not in GUEST_PATHS. If the profile lane places these twins under `(app)/` (as the lane table implies — it doesn't call out any `(public)` placement), signed-out visitors will be unable to view public profiles or follow legacy profile links, breaking web parity. This is the exact same class of bug that R1-F1 identified for `/delete-account`, but the revised plan only addresses `/delete-account`.

- `exafyltd/vitana-v1:src/App.tsx:1482` — <Route path="/profile/:id" element={<LegacyProfileRedirect />} />
<Route path="/me/profile" element={
  <AuthGuard>
    <EditProfilePage />
  </AuthGuard>
} />
...
<Route path="/u/:identifier" element={<PublicProfilePage />} />
- `exafyltd/vitana-v1:apps/mobile/src/navigation/guest-paths.ts:7` — export const GUEST_PATHS: readonly string[] = [
  '/e/game/:slug',
  '/discover',
  '/discover/supplements',
  '/discover/category/:subcategory',
  '/discover/wellness-services',
  '/discover/deals-offers',
  '/commerce',
];
- `exafyltd/vitana-v1:apps/mobile/src/shell/AuthGate.tsx:44` — if (!user) {
  if (isGuestPath(pathname)) return <>{guest}</>;
  return <Redirect href={`/maxina?redirectTo=${encodeURIComponent(href)}` as never} />;

Suggestion: The plan must explicitly note that `/u/:identifier` and `/profile/:id` are public (no AuthGuard on web) and decide their native placement. Options: (a) place them in `(public)` group alongside `delete-account` (simplest parity), (b) add them to GUEST_PATHS (but that requires editing a shell file and check-shell-pins CI, expanding scope), or (c) document them as known parity gaps deferred to a later lane. If option (a), the profile lane partition (currently 5 rows → 4 files all in `(app)/`) must split, similar to how `delete-account` was split out.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The planner accepted the finding and properly addressed it by creating a dedicated `delete-account` lane in the `(public)` group with a clear rationale. Decision 1a is well-specified in the revised plan.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
