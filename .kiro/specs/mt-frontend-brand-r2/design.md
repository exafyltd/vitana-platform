# Design — mt-frontend-brand-r2 (Amendment 1 of mt-frontend-brand)

Authoritative plan: `plan.md` (between the plan markers). Evidence of record:
`.agents/tasks/mt-frontend-brand/replan-wf_6b3e0723e1d5de5f/amendment-design.md` (local run evidence of seat hotmail).

## Route
`mt-frontend-brand` converged and was policy-approved; PLAN-SPAR treats an edit of a converged plan as `nothing_to_do`
(`plan-spar.mjs:348`) and lane `paths` cannot change in a Kiro PR (`queue.mjs:678-687`). So the two failing lanes are
re-planned under this new slug, sparred in a fresh session (session 1: `sparring/round-<n>.md`, answers in
`sparring/responses-<n>.md`), and get two new VTIDs from CI. Superseded: `mt-frontend-brand/brand-surface`
(VTID-05242), `mt-frontend-brand/theme-tokens` (VTID-05246).

## brand-surface-r2
- **Lane scope model.** `scopeCheck` (`queue.mjs:628-696`) unions every commit's files in `base...head`; trailers only
  (`commitsInRange :490-500`), no author/bot exemption. The only way to keep I18N-PROPAGATE out of the PR is to give it
  nothing to propagate: ship every active locale of the new namespace in the lane's own commits.
- **Paths** are an explicit list (no `src/i18n/*/…` glob), so a bot touch to any other namespace stays red. Not in paths
  on purpose: `i18n-source-stamps/**`, `src/i18n/en/screens.json`.
- **B1** uses the PR's `useActiveTenantSlug()` (`src/hooks/useTenantMeta.ts:68-88` on `#1485`), which resolves to
  `maxina` on `vitanaland.com` and the unmapped staging host (`useTenantMeta.test.ts:87-94`). The two CommerceJoin
  tests move from the literal to the active slug.
- **Review findings (`review-round-1.json`, head 7a8b2ab7):** 1–2 (bot files) → fresh branch, all 11 locales, drift 0;
  3 (B1) → BR4; 4 (B7) → BR5; 5 (local vitest failures) → `commands.log` as pre-existing; 6 (`App.tsx` hunk) → quoted
  in the PR body; 7 (AuthGuard i18n/RTL/Spotlight) → PR body states no new string/layout/classes, ESLint output attached.

## theme-tokens-r2
```
useTenant effect (tenant resolved)
  ├─ setProperty --brand-accent/-bg/-fg  (unchanged, hex; parity with packages/tokens + MaxinaPortal)
  └─ vars = tenantThemeVars(tenant)       ({} for maxina / null / no valid accent)
       └─ setProperty --primary, --ring [, --primary-foreground] as "H S% L%" triplets
cleanup / tenant change → removeProperty(each key of vars)
```
- Maxina never receives an inline `--primary`, so the computed value is the stylesheet's (`index.css:24` light,
  `:269` dark). No CSS source changes → built CSS byte-identical. Native tokens come from `index.css` /
  `tailwind.config.ts` only (`gen-tokens.mjs:8-11`) → no drift. A non-default tenant gets a valid
  `hsl(H S% L%)` because the override is a triplet, never a hex.
- Conservative decision: only scheme-neutral variables. `--background`/`--foreground` would break `.dark`; shadcn
  `--accent` is a hover surface, not a brand colour.

## Shared files
None. `brand-surface-r2` ∩ `theme-tokens-r2` = ∅; both are disjoint from `adminfetch-header`, `email-brand-db`,
`email-brand-code`, `cors-config`. The old overlap on `docs/SCREEN_INVENTORY.md` is gone (only brand-surface-r2 has it).

## Successor rules
After convergence the PM / exceptions seat (not this planner, not an executor) parks the two old lanes with
`parked_from` and a "superseded by mt-frontend-brand-r2/<lane>" log entry, and terminalizes VTID-05242/05246
`cancelled`. `vitana-v1#1485` is closed unmerged; its branch is kept.
