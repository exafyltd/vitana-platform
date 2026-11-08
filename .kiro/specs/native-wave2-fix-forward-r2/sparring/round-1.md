# Sparring round 1 — in_progress

Session: `9db34abf-4e6e-44a3-b629-3505d4fc136d` · plan hash `b0e2a857399346f7debd4f904812386a1617538d7aa92151ba352ca5594ff44a`

## Summary

I verified all major factual premises against the pinned code. The plan is thorough and well-researched: line-number references are accurate, the architectural analysis of each gap (utility bar, ORB guided topic, invite cold-start, test timeouts, connectors, analytics, AI picks) matches the code, and the proposed fixes address real issues. I found one minor data-integrity issue but no blockers or major defects.

## Findings

### R1-F1 [minor]

After the `public-entry` lane sets `PUBLIC.LANDING` status to `native` and renders `PublicLandingScreen` at `/` for signed-out users, the `native_only` `/` entry (ledger.json lines 4-8) will carry a stale and now-false reason: it says 'signed out → /maxina', 'Not a port of PUBLIC.LANDING, whose row stays not_started'. All three claims become wrong after this plan lands. Leaving both a `native_only /` entry AND `PUBLIC.LANDING / = native` is contradictory and risks misleading the parity CI check and future planners.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:4` — "native_only": [{"path": "/", "reason": "Landing redirect (app/index.tsx, VTID-05186): signed in → /home, signed out → /maxina (useSmartRouting.tsx:102-110). Not a port of PUBLIC.LANDING, whose row stays not_started (public-auth lane)."}
- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:1840` — {"key": "PUBLIC.LANDING", "web_path": "/", "kind": "screen", "source": "registry", "scope": "in", "lane": "public-auth", "status": "not_started" ...}
- `exafyltd/vitana-v1:apps/mobile/app/index.tsx:12` — export default function Landing() {
  const { user, loading } = useAuth();
  ...
  return <Redirect href={user ? '/home' : '/maxina'} />;
}

Suggestion: In the `public-entry` lane, either (a) remove the `native_only` `/` entry entirely since PUBLIC.LANDING now covers it, or (b) rewrite its reason to reflect the new behaviour (e.g. 'Expo Router root: signed in → /home redirect, signed out → PublicLandingScreen (PUBLIC.LANDING port). See PUBLIC.LANDING row.'). Option (a) is cleaner.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
