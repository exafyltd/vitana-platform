# Tasks — Native shell fixes

One lane. `design.md` and `requirements.md` in this folder are authoritative; anything outside them is a plan change
(log it in the lane file). The VTID is assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set
in `lanes/shell-fixes.md`. Do not open the PR before vitana-v1 PR #1587 (VTID-05524) has merged (plan decision 5).
All commands run from `apps/mobile/` on a branch from vitana-v1 `origin/main`; every command is offline.

<!-- lane: shell-fixes -->
## Lane `shell-fixes` · executor Kiro · seat exafyltd → reviewer_seat agent:vitana-lane-reviewer
depends_on: none in this plan; waits for vitana-v1 #1587 to merge.

- [ ] 1. Red test, partner orgs path: `tests/shell-fixes/gateway-paths.test.tsx` installs a real
  `createGatewayFetch` (origin `https://gw.test`, fake `fetchImpl` that records URLs) via `__setGatewayForTests` and
  asserts `useMyPartnerOrgs` requests exactly `https://gw.test/api/v1/partner-orgs/mine`. Run
  `npx jest tests/shell-fixes`; record the red result (URL with `/api/v1/api/v1/`) in
  `docs/validation/<VTID>/red-on-base.txt`.
- [ ] 2. Fix 1: `src/identity/useMyPartnerOrgs.ts:23` → `'/partner-orgs/mine'`; update the fixture key at
  `tests/identity.test.tsx:149` to `'/partner-orgs/mine'`. Task 1 test green.
- [ ] 3. Red test, journey state path: same file, asserts `GuidedModeProvider` requests exactly
  `https://gw.test/api/v1/journey/state`. Record red.
- [ ] 4. Fix 2: `src/identity/GuidedModeProvider.tsx:71` → `'/journey/state'`. Task 3 test green.
- [ ] 4b. Caller audit (sparring R1-F1): run `git grep -nE "gatewayGet|gatewayJson|getGateway" -- src app` and confirm that
  the only `gatewayGet` callers are `useMyPartnerOrgs.ts` and `GuidedModeProvider.tsx` (fixed above), and that no
  `getGateway()` / `gatewayJson(getGateway(), ...)` caller passes a path starting with `/api/v1` (the screens under
  `src/screens/**/data/` pass bare paths). Write the grep output and the result in `docs/validation/<VTID>/commands.log`
  and the lane log so the reviewer can check completeness. A further doubled caller found here is fixed in the same PR
  only if its file is in the lane `paths`; otherwise log it and raise it as a follow-up in the PR body.
- [ ] 5. Red test, commerce redirect: `tests/shell-fixes/auth-gate.test.tsx` (mocked `expo-router`) asserts signed
  out on `/commerce/team` → `/commerce/join?redirectTo=%2Fcommerce%2Fteam`, on `/home` → `/maxina?redirectTo=%2Fhome`,
  on `/commerce` → guest shell. Record red (the first case goes to `/maxina`).
- [ ] 6. Public commerce route mounts (after #1587 merged): create `app/(public)/commerce/join.tsx`,
  `app/(public)/commerce-login.tsx`, `app/(public)/commerce/connect/index.tsx`,
  `app/(public)/commerce/connect/privacy.tsx`, each a default-export mount of its `src/screens/business/` component
  (design §3), plus `tests/shell-fixes/commerce-routes.test.tsx` (mocked screen modules, each route renders its
  component). Add `'/commerce-login'`, `'/commerce/connect'`, `'/commerce/connect/privacy'`, `'/commerce/join'` to
  `NATIVE_ROUTES` in `src/navigation/resolve.ts`; `npx jest tests/navigation.test.tsx` green (red with the files but
  without the entries). If #1587 merged with these files present, skip the files and log it; if #1587 closed unmerged, skip this
  task and task 7's commerce branch and log the fallback (plan decision 5).
- [ ] 7. Fix 3: `src/shell/AuthGate.tsx:46` picks `/commerce/join` for paths starting with `/commerce/`, else
  `/maxina` (design §2); update the header comment at `AuthGate.tsx:3`. Task 5 test green.
- [ ] 8. Verify: `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`; write
  `docs/validation/<VTID>/` `scope.json`, `staging-tests.json` (refs only `npm run X` / `npx jest P`), `commands.log`,
  `plan-sparring.md`.
- [ ] 9. PR: branch `kiro/native-shell-fixes-r2/shell-fixes`, title
  `VTID-xxxxx (native-shell-fixes-r2/shell-fixes): fix doubled /api/v1 gateway paths and the commerce sign-in redirect`;
  trailers `Collab-Session: <kiro id>`, `Collab-Lane: native-shell-fixes-r2/shell-fixes`; lane → `in-review`. No
  merge, deploy or live write.

**Acceptance (the reviewer agent checks these):**
- Change types: UI, Integration.
- **Outcome** — a member with partner-org membership sees business modes in the role switcher on a device; the guided
  journey mode follows the member's journey state instead of falling back to `full`; a signed-out supplier who opens
  a `/commerce/…` link lands on the supplier join screen and returns to that link after signing in.
- **States** — signed out on guest path (guest shell), signed out on `/commerce/*` (join), signed out elsewhere
  (`/maxina`), signed in (unchanged role guard); gateway error keeps today's fallbacks (`[]` orgs, `full` mode).
- **Surfaces** — native `AuthGate` (`(app)/_layout.tsx`), role switcher via `useMyPartnerOrgs`, `GuidedModeProvider`,
  the four `(public)` commerce routes and their `NATIVE_ROUTES` entries. Desktop: n/a (native only).
- **Locales** — n/a: no new or changed text.
- **Accessibility** — n/a: no new control; the mounted screens are the business lane's.
- **Contract** — `GET /api/v1/partner-orgs/mine` and `GET /api/v1/journey/state` with Bearer token
  (`packages/core/src/gateway.ts:30-31`); redirect `/commerce/join?redirectTo=` as web `AuthGuard.tsx:65`, `:204`.
- **Staging proof** — not verified on staging: the native app has no staging deploy and device runtime waits for G1;
  covered by `npx jest tests/shell-fixes`.
- Each test in `tests/shell-fixes/` was red on base for the bug it fixes (`red-on-base.txt`); no other file changed
  than the lane `paths`; NATIVE-CI, PR-GATE **Collab handoff** and **Lane scope** green.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production.
