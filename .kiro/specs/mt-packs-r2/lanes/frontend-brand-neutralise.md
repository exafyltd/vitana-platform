---
lane: frontend-brand-neutralise
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
area: frontend
paths:
  - src/i18n/**
  - src/hooks/useOrbFrontDoor.ts
  - src/hooks/useOrbVoiceWidget.ts
  - src/lib/orbActivate.ts
  - src/whats-new/entries/**
  - i18n-source-stamps/**
  - docs/SCREEN_INVENTORY.md
updated: 2026-11-01T15:40Z
repos: [exafyltd/vitana-v1]
---
# frontend-brand-neutralise — i18n brand neutralisation + widget + What's New (repo vitana-v1)

Plan: `.kiro/specs/mt-packs-r2/plan.md` (authoritative) and the `frontend-brand-neutralise` section of `tasks.md`
(F1–F3, allowed paths, acceptance). Design + successor rules: `design.md`. **Repo vitana-v1.**

Replace user-visible brand literals with `{{brand}}` across `src/i18n/de/**` FIRST (du-form, never Sie/Ihr),
mirror to `src/i18n/en/**`; the other 9 GA locales via `scripts/translate-keys.mjs`. Keep `/maxina` routes as
aliases (no route added/removed → no nav-registry/screen-manifest/parity-ledger change). Widget passes tenant
pre-login context (host/slug): the external `window.VitanaOrb` widget is booted and configured in
`src/hooks/useOrbVoiceWidget.ts` (`orb.init(... initialContext ...)`) and its session-start entry points live in
`src/lib/orbActivate.ts` — that pair is where host/slug rides the session start; `useOrbFrontDoor` is made generic.
(There is no `src/components/orb/` directory in vitana-v1 — the ORB is the external widget script, so the lane
scopes the real boot/activation files, not a phantom component dir.) What's New entry copy
(`src/whats-new/entries/*.json`) brand-neutralised. Brand resolves to Maxina by default (golden-unchanged). Run `npm run i18n:inventory` and
commit `docs/SCREEN_INVENTORY.md`; ESLint `i18n/*` + `design/*` clean on changed files. This lane adds its own
`docs/validation/<vtid>/` (in vitana-v1).

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed paths. Branch
`kiro/mt-packs-r2/frontend-brand-neutralise`; PR title `VTID-xxxxx (mt-packs-r2/frontend-brand-neutralise): …`;
trailers `Collab-Session: <id>` / `Collab-Lane: mt-packs-r2/frontend-brand-neutralise`. When the PR is open: set
`state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:40Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-packs/frontend-brand-neutralise`. No scope change; lane follows today's §3a/§7 rules.
