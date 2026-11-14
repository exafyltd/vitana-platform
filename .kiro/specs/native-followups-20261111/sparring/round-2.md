# Sparring round 2 — converged

Session: `5002801c-2e70-428d-94e7-fd81b8aee31b` · plan hash `cf28654852b561905c63f5324a88271c14f3cf8add3c2e734fbd2174ca71417e`

## Summary

Both R1 findings were accepted and properly addressed in the revised plan. The overlap with shell-fixes (VTID-05647) for `useMyPartnerOrgs.ts` and `tests/identity.test.tsx` is now explicitly documented with an option (c) takeover and an ordering check (R1-F1). The must-pass test list now includes `bottom-tabs.test.tsx` and `chrome.test.tsx` (R1-F2). One new minor finding: the plan documents the shell-fixes overlap for those two files but omits the same lane's declared claim on `resolve.ts`, which both `my-groups-deeplink` and `screen-backfill` also edit. PR #1645 is missing from the Risks collision list. The conflict is additive (different arrays in the same file) so it is minor, but for consistency with the careful overlap documentation elsewhere in the plan, it should be stated.

## Findings

### R2-F1 [minor]

The plan documents the shell-fixes lane (VTID-05647) overlap for `useMyPartnerOrgs.ts` and `tests/identity.test.tsx` but does not document that the same lane also declares `apps/mobile/src/navigation/resolve.ts` in its paths (shell-fixes.md:16) and plans to add four NATIVE_ROUTES entries to it (plan.md:64-69). The revised plan's `my-groups-deeplink` (NATIVE_PATTERNS) and `screen-backfill` (NATIVE_ROUTES) both edit `resolve.ts`. PR #1645 is also absent from the Risks section's list of open PRs that collide with `resolve.ts` (#1587 … #1647).

- `exafyltd/vitana-platform:.kiro/specs/native-shell-fixes-r2/lanes/shell-fixes.md:12` — paths:
  - apps/mobile/src/identity/useMyPartnerOrgs.ts
  - apps/mobile/src/identity/GuidedModeProvider.tsx
  - apps/mobile/src/shell/AuthGate.tsx
  - apps/mobile/src/navigation/resolve.ts
  ...
- `exafyltd/vitana-platform:.kiro/specs/native-shell-fixes-r2/plan.md:64` — The lane adds the four paths `/commerce-login`, `/commerce/connect`, `/commerce/connect/privacy` and `/commerce/join` to `NATIVE_ROUTES` in `apps/mobile/src/navigation/resolve.ts` (`:42`), because `apps/mobile/tests/navigation.test.tsx:67-84` keeps that list equal to the route files on disk

Suggestion: In Measured state §2 or Decisions §1, note that the shell-fixes lane (VTID-05647) also declares `resolve.ts` in its paths and plans to add NATIVE_ROUTES entries there; the edits are to different arrays (NATIVE_PATTERNS vs NATIVE_ROUTES) and the conflict is additive. Add #1645 to the Risks collision list alongside the other open PRs.
