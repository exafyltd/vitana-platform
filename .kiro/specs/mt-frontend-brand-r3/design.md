# Design — mt-frontend-brand-r3 (re-plan of mt-frontend-brand-r2) (Amendment 1 of mt-frontend-brand)

Authoritative plan: `plan.md` (between the plan markers). Evidence of record:
`.agents/tasks/mt-frontend-brand/replan-wf_6b3e0723e1d5de5f/amendment-design.md` (local run evidence of seat hotmail).

## Route
`mt-frontend-brand` converged and was policy-approved; PLAN-SPAR treats an edit of a converged plan as `nothing_to_do`
(`plan-spar.mjs:348`) and lane `paths` cannot change in a Kiro PR (`queue.mjs:679-688`). So the two failing lanes are
re-planned under this new slug, sparred in a fresh session, and get two new VTIDs from CI. Session 1 escalated with
`evidence_floor_not_met`: no `spar_refs` was declared, so the partner could not read vitana-v1. Session 2 (files
`sparring/s2-round-<n>.md`, answers in `sparring/s2-responses-<n>.md`) reads vitana-v1 at
`58c76c9566dc035fe506a304e42c8700a110bcb5` via `handoff.md` `spar_refs`. Every vitana-v1 `file:line` here is at that SHA. Superseded: `mt-frontend-brand/brand-surface`
(VTID-05242), `mt-frontend-brand/theme-tokens` (VTID-05246).

## brand-surface-r3
- **Lane scope model.** `scopeCheck` (`queue.mjs:628-696`) unions every commit's files in `base...head`; trailers only
  (`commitsInRange :490-500`), no author/bot exemption. The only way to keep I18N-PROPAGATE out of the PR is to give it
  nothing to propagate: ship every active locale of the new namespace in the lane's own commits.
- **Paths** are an explicit list (no `src/i18n/*/…` glob), so a bot touch to any other namespace stays red. Not in paths
  on purpose: `i18n-source-stamps/**`, `src/i18n/en/screens.json`.
- **New keys are "never stamped", not drift** (`scripts/i18n-stamp-source.mjs:289,293,335-342`), so shipping all
  11 locales without a stamp file keeps `--check-all` and I18N-PROPAGATE's COUNT (`:86-88`) at 0 (s2 R1-F4).
- **BR0 precondition:** I18N-PROPAGATE counts repo-wide drift (`I18N-PROPAGATE.yml:86-116`). If main itself drifts,
  no lane can keep the bot out, so the lane checks main first and stops (park the lane (`next_actor: owner`)) instead of pushing.
- **B1** uses `useActiveTenantSlug()`, new in this lane (`src/hooks/useTenantMeta.ts` does not exist at the pinned
  SHA; the code is reused from `#1485`, PR evidence). It is `useTenant().tenant?.slug ?? 'maxina'`, with no localStorage
  step. An anonymous signup has no tenant (`src/hooks/useTenant.tsx:53-54`) and posts `maxina`, exactly today's literal.
- **B2:** the stored slug is used only by the pure `activeTenantSlug()` in AuthGuard's OAuth retry
  (`src/components/AuthGuard.tsx:267,271`), and only if the registry lists it (`findBySlug`, as at
  `useTenant.tsx:62`). It never reaches `signUp` metadata (s2 R1-F3). Call site (s2 R2-F2): one
  `retrySlug = activeTenantSlug({ tenantSlug: null, candidates: [readStoredTenantSlug('tenant_slug')], registry:
  currentRegistrySync() })`, written to localStorage at `:267` and used in `redirectTo` at `:271`. The two CommerceJoin tests (`oauth-first.test.ts:29`, `routing.test.ts:53-55`) move from the
  literal to the active slug.
- **Mount:** one `useTenantMeta()` call in `AppHooksInitializer` (`src/App.tsx:469`, rendered at `:772`).
- **Review findings (`review-round-1.json`, head 7a8b2ab7):** 1–2 (bot files) → fresh branch, all 11 locales, drift 0;
  3 (B1) → BR4; 4 (B7) → BR5; 5 (local vitest failures) → `commands.log` as pre-existing; 6 (`App.tsx` hunk) → quoted
  in the PR body; 7 (AuthGuard i18n/RTL/Spotlight) → PR body states no new string/layout/classes, ESLint output attached.

## theme-tokens-r3
```
useTenant effect (tenant resolved)
  ├─ setProperty --brand-accent/-bg/-fg  (unchanged, hex; parity with packages/tokens + MaxinaPortal)
  └─ vars = tenantThemeVars(tenant)       ({} for maxina / null / no valid accent)
       └─ setProperty --primary, --ring [, --primary-foreground] as "H S% L%" triplets
cleanup / tenant change → removeProperty(each key of vars)
```
- Maxina never receives an inline `--primary`, so the computed value is the stylesheet's (`index.css:24` light,
  `:269` dark; `--ring` `:41` / `:286`). The pink `--brand-accent` (`index.css:138`, `:385`) is never read. No CSS source changes → built CSS byte-identical. Native tokens come from `index.css` /
  `tailwind.config.ts` only (`gen-tokens.mjs:8-11`) → no drift. A non-default tenant gets a valid
  `hsl(H S% L%)` because the override is a triplet, never a hex.
- Conservative decision: only scheme-neutral variables. `--background`/`--foreground` would break `.dark`; shadcn
  `--accent` is a hover surface, not a brand colour.

## Shared files
None. `brand-surface-r3` ∩ `theme-tokens-r3` = ∅; both are disjoint from `adminfetch-header`, `email-brand-db`,
`email-brand-code`, `cors-config`. The old overlap on `docs/SCREEN_INVENTORY.md` is gone (only brand-surface-r3 has it).

## Successor rules
After convergence the PM / exceptions seat (not this planner, not an executor) parks the two old lanes with
`parked_from` and a "superseded by mt-frontend-brand-r3/<lane>" log entry, and terminalizes VTID-05242/05246
`cancelled`. `vitana-v1#1485` is closed unmerged; its branch is kept.
