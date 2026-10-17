---
slug: mt-frontend-brand
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-17T15:32Z
---
# Handoff — mt-frontend-brand (WS7 rest, program `docs/MULTI-TENANT-PLAN.md` §6)

Planner: Kiro seat `hotmail` (session kiro-hotmail-202610151618-b437). Plan: `plan.md`
(between the plan markers), sparred by PLAN-SPAR; `requirements.md`, `design.md`, `tasks.md`
carry the detail. This is the WS7 "rest" slice after Lane C (VTID-05151) delivered the
registry/portal/`useTenant` — it wires per-tenant theme, brand surface, email/OG branding and
config-driven CORS. (The Command Hub tenant picker UI is deferred to a separate DEV-COMHU lane —
see the log below and `plan.md` Out of scope.)

Lanes (all held at `ready`, `next_actor: owner`, until PLAN-SPAR allocates each lane's VTID
and flips it to `kiro`):
- `theme-tokens` — kiro, seat exafyltd, repo vitana-v1. Make `--brand-*` render.
- `brand-surface` — kiro, seat exafyltd, repo vitana-v1. De-maxina member surfaces + meta/OG.
- `adminfetch-header` — kiro, seat exafyltd, repo vitana-v1. adminFetch tenant headers + JSDoc.
- `email-brand-db` — kiro, seat hotmail, repo vitana-v1 (DB). Tenant-keyed email branding helper.
- `email-brand-code` — kiro, seat exafyltd, repo vitana-v1. Edge fns + OG read branding by tenant.
  depends_on: `email-brand-db`.
- `cors-config` — kiro, seat jtadic, repo vitana-platform. Config-driven CORS allowlist.

Cross-spec decisions applied: none of the CROSS-SPEC-DECISIONS.md items name mt-frontend-brand;
the `platform_only_accounts` / network-groups / moderation rulings are other specs' concerns.
Migration range reserved for this spec: `20261101090000`–`20261101095959` (only `email-brand-db`
uses it; executor renumbers if a later migration exists at build time).

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → drafted
Authored the spec and seven lanes. Premises re-verified against current code (file:line in
`plan.md`/`design.md`): theme tokens set but unconsumed (`useTenant.tsx:124-133`, golden
`tenant-registry.maxina-golden.test.tsx:172-183`); adminFetch JSDoc wrong (`admin-api.ts:5-7`
vs `:33-41`); hardcoded `maxina` slug (`CommerceJoin.tsx`, `AuthGuard.tsx:271`,
`RedeemVoucher.tsx`, `RedemptionLanding.tsx`); store links (`store-links.ts:6,31,49`); email
sender/brand (`voucher-send-email`, `send-appointment-*`, `send-welcome-discount`); OG workers
(`og-share` etc.); hardcoded CORS array (`cors.ts:7-51`); Command Hub maxina labels
(`command-hub/app.js`). Pushed as PR `plan(mt-frontend-brand): …`. Two open questions for
sparring recorded in `plan.md` (platform-lane seat assignment; store-links per-tenant field
dependency on WS9). Next: PLAN-SPAR spars the PR; on convergence, policy approval allocates one
VTID per lane and flips lanes to `kiro`.

### 2026-10-16T09:30Z · kiro-hotmail-202610151618-b437 · internal review fixes (still drafted)
Applied the two blocking INTERNAL-REVIEW findings; both NITs needed no change.
- Finding 1 (HIGH): the `command-hub-picker` lane edited `services/gateway/src/frontend/
  command-hub/app.js`, which `scripts/ci/command-hub-ownership-guard.js` (PROTECTED_PATH L15,
  ALLOWED_VTID_PATTERN L1051) reserves for `DEV-COMHU-*`/allowlisted VTIDs — a fresh PLAN-SPAR
  VTID fails that guard. Took the conservative option: **removed the lane entirely** (deleted
  `lanes/command-hub-picker.md`, the CH1/CH2 task group, the lane Fix paragraph) and deferred
  the picker UI to a separate `DEV-COMHU-*` lane. Its data endpoint `GET /api/v1/admin/tenants`
  already exists (`admin-tenants.ts:76`), so no other lane is blocked. Spec is now **6 lanes**.
- Finding 2 (MEDIUM): `brand-surface`'s `useTenantMeta` had no mount file in `paths` and no
  component sets `document.title` today. Named the exact mount (one `useTenantMeta()` call in
  `AppHooksInitializer`, `src/App.tsx:469` — import + one call, no new route/JSX) and added
  `src/App.tsx` to the lane's `paths`; plan.md, tasks.md B5/B7 now name the same mount.
- Updated the open questions (dropped the command-hub seat flip; cors-config seat note stays).
Re-ran the queue.mjs validators on handoff + all 6 lanes (0 errors). Re-pushed the branch.

### 2026-10-17T14:26Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:32Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
