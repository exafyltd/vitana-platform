# AWS region migration impact (session_0187ECt9eM76yNDYKbzW5p6D)
- Created 2026-10-11T12:19, updated 12:30 (idle). Branch claude/amazing-thompson-3643ik. Advisory only, no repo changes.
## Goal
Owner asked how much moving AWS from Europe to US (needed for Kiro Web) would affect the whole project, then asked for a step-by-step guide for the recommendation.
## Done
- Impact analysis: recommendation is to leave the platform in eu-central-1 and add a Kiro profile in us-east-1 (Kiro Web is us-east-1 only; profile region may differ from IAM Identity Center region; one profile per account per region).
- 15-step guide delivered (ask AWS support, ask compliance, create US profile, enable Settings > Kiro Settings > Cloud Sessions, connect GitHub at app.kiro.dev/settings/agent, lock down Sandbox secrets/internet access, check kiro-runner untouched).
- No PRs, VTIDs, migrations or deploys.
## State now
- Nothing open. Docs-based findings only; whether a second profile in another region is allowed was NOT confirmed in Kiro docs.
## Blocked on / needs owner
- Owner/AWS admin: AWS support confirmation (second us-east-1 profile alongside Frankfurt; double billing), compliance OK for code processing in the US, then console steps; GitHub org owner must install the Kiro Agent app on exafyltd.
## Next steps for Kiro
1. Nothing to build. If the owner wants a decision record in the repo, plan it (docs-only change, needs sparring + VTID).
2. Do not put production secrets in Kiro Web sandbox env; keep it away from vitanaland.com, gateway, Supabase hosts.
3. All console/AWS/GitHub-admin steps are owner actions.
## Gotchas
- kiro-runner reads Kiro keys from Secrets Manager in eu-central-1 (services/kiro-runner/src/index.ts:39); keep the Frankfurt profile.
- Kiro docs fetched via a summarizing WebFetch; treat details as unverified.
