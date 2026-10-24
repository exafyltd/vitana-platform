---
lane: theme-tokens-r2
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - src/lib/tenant-theme.ts
  - src/lib/tenant-theme.test.ts
  - src/hooks/useTenant.tsx
  - src/hooks/useTenant.theme.test.tsx
  - tests/e2e/staging/vtid-*-theme-tokens.staging.spec.ts
updated: 2026-10-22T14:00Z
---
# theme-tokens-r2 — tenant theme renders via runtime HSL overrides (repo vitana-v1)

Plan: `.kiro/specs/mt-frontend-brand-r2/plan.md` and the `theme-tokens-r2` section of `tasks.md` (TT1–TT4, allowed
paths, acceptance) are authoritative. Supersedes `mt-frontend-brand/theme-tokens` (VTID-05246). VTID: assigned by CI
after PLAN-SPAR converges; do not start before `vtid:` is set here.

Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another lane, no
merge/approve/deploy/dispatch outside §7b, no Supabase/AWS/gateway writes. Work only in the allowed paths;
`docs/validation/<vtid>/` is the lane's own. No edit of `src/index.css`, `tailwind.config.ts`,
`scripts/native/gen-tokens.mjs`, `packages/**` or the C2 golden: Maxina gets no inline override (slug guard), so its
built CSS is byte-identical. Overrides are HSL triplets, never hex. Branch `kiro/mt-frontend-brand-r2/theme-tokens-r2`;
PR title `VTID-xxxxx (mt-frontend-brand-r2/theme-tokens-r2): …`; trailers `Collab-Session` /
`Collab-Lane: mt-frontend-brand-r2/theme-tokens-r2`. Deploys (frontend): ships
`docs/validation/<vtid>/staging-tests.json`; done when STAGING-VERIFY passed on its merge commit.
Shared files: none.

## Escalation carry-over (session 2, round 3)

Sparring session 2 escalated at round 3 (`sparring/s2-round-3.md`). `plan.md` is unchanged. These are binding
acceptance criteria for this lane (they override TT1/TT2 where they conflict) and apply only if the owner approves the
plan as escalated. The full text is in `tasks.md` → "Escalation carry-over".

- **R3-F1** [major]: `tenantThemeVars` leaves `--ring` untouched for non-Maxina tenants (only `--primary` and
  `--primary-foreground` are set). The `acme` test asserts that `--primary` and `--ring` are distinct (no inline
  `--ring`; ring keeps the stylesheet value at `src/index.css:41` / `:286`).
- **R3-F2** [minor]: the theme effect returns a cleanup that calls `removeProperty` on the union of the `--brand-*` keys
  plus `--primary`, `--primary-foreground` and `--ring`. It runs before every tenant change and on unmount. Vitest:
  acme → Maxina, and acme → tenant-without-brandAccent, both clear the inline vars.

## Log
### 2026-10-22T11:20Z · kiro-hotmail-202610212135-3b9f · created → ready
Lane created with the amendment plan. Approach replaced: the `index.css` fallback chain of `theme-tokens` would render
the declared pink `--brand-accent` (`index.css:138-140`) for Maxina, feed hex into `hsl(var(--primary))` and break
`gen-tokens.mjs` (`:97-103`). Next: PLAN-SPAR; once `vtid:` is set, seat exafyltd claims it.
