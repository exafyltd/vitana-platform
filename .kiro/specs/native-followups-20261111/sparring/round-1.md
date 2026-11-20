# Sparring round 1 — in_progress

Session: `5002801c-2e70-428d-94e7-fd81b8aee31b` · plan hash `accf47a8566d2ce51adf2f562cd9c396ae9f00842f273427ce09e1dcce83b65b`

## Summary

I verified premises against the vitana-platform codebase (the pinned repo). The gateway-side contract premises hold. However, I found a significant path-ownership collision between this plan's `partner-orgs-path` lane and the existing shell-fixes lane (VTID-05647), which the plan incorrectly claims has no overlap.

## Findings

### R1-F1 [blocker]

The plan asserts 'None of the three files of this lane. No overlap.' with PR #1645 / VTID-05647. This is false. The shell-fixes lane spec at `.kiro/specs/native-shell-fixes-r2/lanes/shell-fixes.md` explicitly claims both `apps/mobile/src/identity/useMyPartnerOrgs.ts` (line 13) and `apps/mobile/tests/identity.test.tsx` (line 21) in its `paths:` list. The shell-fixes plan.md (lines 29-30, 55-56, 77-79) specifically plans to fix `useMyPartnerOrgs.ts:23` (the doubled path) and update `tests/identity.test.tsx:149` (the fixture key) — the exact same two-of-three edits this plan's `partner-orgs-path` lane proposes. The plan checked overlap only against PR #1645's current diff, not against the shell-fixes lane's declared file ownership. Two active lanes editing the same files with no coordination mechanism is a governance collision.

- `exafyltd/vitana-platform:.kiro/specs/native-shell-fixes-r2/lanes/shell-fixes.md:12` — paths:
  - apps/mobile/src/identity/useMyPartnerOrgs.ts
  - apps/mobile/src/identity/GuidedModeProvider.tsx
  - apps/mobile/src/shell/AuthGate.tsx
  - apps/mobile/src/navigation/resolve.ts
  ...
  - apps/mobile/tests/identity.test.tsx
  - apps/mobile/tests/shell-fixes/**
- `exafyltd/vitana-platform:.kiro/specs/native-shell-fixes-r2/plan.md:29` — **Bug 1.** `apps/mobile/src/identity/useMyPartnerOrgs.ts:23` calls `gatewayGet('/api/v1/partner-orgs/mine')`, so the request goes to `<origin>/api/v1/api/v1/partner-orgs/mine`, answers 404, and business modes never appear.
- `exafyltd/vitana-platform:.kiro/specs/native-shell-fixes-r2/plan.md:55` — **Fixes 1 and 2:** pass `'/partner-orgs/mine'` and `'/journey/state'`. No change to `createGatewayFetch` or `gatewayApiUrl`; the core contract is right and other callers rely on it.
- `exafyltd/vitana-platform:.kiro/specs/native-shell-fixes-r2/plan.md:77` — **The existing fixture is corrected, not deleted.** `apps/mobile/tests/identity.test.tsx:149` changes its key to `'/partner-orgs/mine'` (quality-checks "a move or rename greps every test"). That file is in the lane's `paths` for this one line.

Suggestion: The plan must explicitly coordinate with the shell-fixes lane (VTID-05647). Options: (a) Move the `useMyPartnerOrgs.ts:23` fix and the `tests/identity.test.tsx:149` key edit into PR #1645 (as the owner instruction 'in the same change' may intend), adding `tests/shell.test.tsx` to the shell-fixes lane paths and dropping the separate `partner-orgs-path` lane entirely; or (b) Keep `partner-orgs-path` as a separate lane but explicitly remove `useMyPartnerOrgs.ts` and `tests/identity.test.tsx` from the shell-fixes lane's `paths:` in the same plan revision, with a `depends_on` or ordering note so the two PRs don't collide; or (c) Supersede the shell-fixes lane for those files with a documented handoff. Whichever option, the plan must not assert 'No overlap' when two lanes claim the same files.

### R1-F2 [minor]

The plan's `partner-orgs-path` lane does not list `tests/professional/bottom-tabs.test.tsx` or `tests/staff/chrome.test.tsx` in its paths, yet declares that both must stay green after the fix. Since the plan is aware these tests use the old doubled key and relies on a specific fallback behavior (data === undefined → EMPTY), the lane should explicitly run these as part of its verification and mention them in its test plan, not just in the measured-state narrative.

- `exafyltd/vitana-platform:.kiro/specs/native-shell-fixes-r2/plan.md:34` — **Why tests did not catch it.** The shared fake gateway (`apps/mobile/tests/helpers/providers.tsx:24-31`) replaces the whole `GatewayFetch` and matches the path argument, before any prefixing. `apps/mobile/tests/identity.test.tsx:149` keys its fixture on `'/api/v1/partner-orgs/mine'`, so it encodes the bug and turns red once bug 1 is fixed.

Suggestion: In the lane's verification step, explicitly list `tests/professional/bottom-tabs.test.tsx` and `tests/staff/chrome.test.tsx` as must-pass tests and confirm in the PR that both remain green after the path fix.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
