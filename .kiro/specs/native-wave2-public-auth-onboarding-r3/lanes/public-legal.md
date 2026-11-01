---
lane: public-legal
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(public)/index.tsx
  - apps/mobile/app/(public)/privacy.tsx
  - apps/mobile/app/(public)/terms.tsx
  - apps/mobile/app/(public)/maxina_support.tsx
  - apps/mobile/app/(public)/i/[code].tsx
  - apps/mobile/app/(public)/apply.tsx
  - apps/mobile/app/(public)/_intro/[tenantSlug].tsx
  - apps/mobile/src/screens/public/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/parity/ledger.json
  - apps/mobile/tests/public/**
  - apps/mobile/maestro/public/**
  - src/i18n/*/publicLegalNative.json
  - docs/validation/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/extract.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
updated: 2026-11-01T17:25Z
---
# Public landing / legal / invite / apply port — the signed-out `PublicAppShell` branch (+ 2 kept-exception rows)
Plan: `.kiro/specs/native-wave2-public-auth-onboarding-r3/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: public-legal -->` (tasks 1–7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 9 ledger rows under `"lane": "public-auth"` for this lane — 7 ported +
2 kept-`exception`. Ported (all `not_started`): `PUBLIC.LANDING /`, `PUBLIC.PRIVACY /privacy`, `PUBLIC.TERMS /terms`,
`/maxina_support`, `/i/:code`, `/apply`, `/_intro/:tenantSlug`. Kept `exception` (no port): `/download`,
`/maxina/app`. Web sources `src/pages/Index.tsx` (179) via `src/pages/ShareEntry.tsx` (107) fallback (route
`src/App.tsx:819`), `src/pages/legal/PrivacyPolicy.tsx` (253, `:845`), `src/pages/legal/TermsOfUse.tsx` (208, `:846`),
`src/pages/legal/MaxinaSupport.tsx` (240, `:848`), `src/pages/InviteLanding.tsx` (17, `:877`), `src/pages/Apply.tsx`
(819, `:868`), `src/pages/IntroExperience.tsx` (528, `:819`); kept-exception `src/pages/DownloadFlyer.tsx` (233,
`:862`), `src/pages/MaxinaAppRedirect.tsx` (279, `:867`). The `/i/:code` invite link resolves through
`apps/mobile/src/linking/resolve-link.ts` → `invite` and `auth-port` `deliverInviteLink`.
**Goal.** Port the signed-out `PublicAppShell` storefront landing, Privacy, Terms, Maxina Support, the `/i/:code`
invite landing, `/apply` and `/_intro/:tenantSlug` to native on the N3 `(public)` group at 1:1 mobile-web parity —
read-only, no auth write. Leave `/download` and `/maxina/app` as web pages (`status: "exception"`, the installed
native app replaces the printed-flyer / QR redirect). Flips the 7 ported rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the landing/legal/invite/apply/intro surfaces; mobile-web parity; `@vitana/core`-only web
  bridge; the invite link resolved via the reused `resolve-link`/`auth-port` (not re-parsed); no auth write.
- `npm run typecheck`, `npm test` (landing + legal static render; `/i/:code` resolves to `invite`; apply form
  validation with no live submit; intro render), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 7 rows `native` and their routes present in
  `apps/mobile/app/`, and `/download` + `/maxina/app` left `exception` with no native route file.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 6)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 7 ported rows, leaves the 2 exception
rows untouched), `apps/mobile/src/navigation/resolve.ts` (by-entry), and the DE-first i18n shard (only this lane's
keys) are shared by row/line with the other two lanes; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no auth write, no test against production; staging specs are read-only; the native app has no
production profile.
## Log
### 2026-11-01T17:25Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan (re-plan of `native-wave2-public-auth-onboarding-r2/public-legal`, PR #4545); `paths` widened to the shared native-infra files.
