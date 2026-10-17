# Internal review — mt-tenant-admin (spec 07, WS4 rest)

Reviewer: independent internal adversarial pass, fresh context. Scope judged: `plan.md`, `requirements.md`,
`design.md`, `tasks.md`, `handoff.md`, `lanes/*.md`. Premises re-verified read-only against current code at
`c:\Users\dstev\vitana-platform-1` and `c:\Users\dstev\vitana-v1`. Planning-only — no build/test suite to run; the
decisive mechanical check is the `queue.mjs` validator run below.

## Method
- Ran `scripts/collab/queue.mjs` exports `parseFrontMatter` + `validatePlan` on `handoff.md` and `validateLane` on all
  five lane files (with the real `laneIds` set). **0 errors across all six files.**
- Verified every load-bearing `file:line` premise in `plan.md` §Problem and `design.md` §What exists against current
  source.
- Confirmed the CROSS-SPEC rulings named for this spec (C3 ordering, O2 deactivate/archive ownership, O4 moderation
  ownership, S-G defence-in-depth split, provisioning-core-DONE) are applied here and are consistent with the sibling
  spec that co-owns them (mt-community-isolation).
- Confirmed the two prior-round HIGH/MEDIUM findings recorded in `handoff.md` (accept-route-already-exists;
  S-G-already-enforced) are genuinely fixed in the current spec text, not merely annotated.

## Verdict driver
Zero HIGH and zero MEDIUM findings → **APPROVED**. Every premise the plan rests on was re-verified in current code;
the cross-spec rulings are applied correctly and match the co-owning spec; the lane structure, path scoping, DB/code
split, migration ordering, dark-by-default posture and standing rules are all sound. The one open item is the
planner's own non-blocking "Open questions for sparring" entry.

---

## Verified assumptions (checked read-only in current code)

- **Invitation-accept gateway route exists, is mounted, and is hardened (VTID-05044) — and the spec now says so.**
  `services/gateway/src/routes/tenant-admin/invitations.ts` exports `acceptRouter` with
  `acceptRouter.post('/accept/:token', requireAuth, …)` (`:186`). Mounted at `/api/v1/admin/invitations`:
  `index.ts:501` destructures `acceptRouter`, `:1429` `mountRouterSync(app, '/api/v1/admin/invitations', …)`. It
  enforces email-confirmed + email-match → 403 `EMAIL_UNVERIFIED`/`EMAIL_MISMATCH` (`:208-233`), role-allowlist
  re-check incl. super-admin-only refusal → 409 `INVITATION_ROLES_INVALID` (`:237-268`), expiry → 410 `EXPIRED`
  (`:200`), atomic claim-before-grant → 409 `ALREADY_USED` (`:289-299`), grants only validated roles via
  `upsertUserPermittedRole` (`:312-319`). The spec's Problem #1, R1, design and both relevant lanes now describe this
  route as DONE and scope this spec to the **frontend accept page only** (lane `tenant-admin-pages`), creating no new
  gateway accept route. `admin-invitations.ts` does **not** exist anywhere in the tree (`file_search` empty), and the
  `tenant-admin-api` lane `paths` no longer lists it. Correct.

- **`provision_tenant()` first-admin invitation + `accept_path`.** `20261014000500_vtid_05150_provision_tenant.sql`
  mints/reuses a `tenant_invitations` row with `ARRAY['admin']` (`:212-222` region confirmed). `admin-tenants.ts:371`
  returns `accept_path:/admin/invitations/accept/<token>`, matching the route path and the frontend route the page
  lane mounts. Correct.

- **`requireTenantAdmin` is the scoping mechanism; no `getTenantId(req)` helper.** `middleware/require-tenant-admin.ts`
  bypasses exafy-admin at Step 2 (`if (req.identity.exafy_admin) { next(); return; }`), resolves
  `req.params.tenantId || req.identity.tenant_id`, rejects cross-tenant mismatch, requires `active_role='admin'` +
  permitted admin role, and attaches `(req as any).targetTenantId = targetTenantId`. The spec scopes reads by
  `req.targetTenantId` (caller's own = `req.identity.tenant_id`) and explicitly instructs the executor NOT to call a
  non-existent `getTenantId(req)`. Correct — the prior W1 finding is fully resolved.

- **`/admin/init-events` is a vitana-v1 frontend page, not a gateway route.** `vitana-v1/src/pages/admin/InitEvents.tsx`
  is a static dev helper: it shows a SQL script, `window.open`s the Supabase dashboard, calls no gateway endpoint. It
  appears in the gateway route-inventory fixture `e2e/fixtures/routes.ts` under `ADMIN_ROUTES` (`:193`), not
  `PUBLIC_ROUTES`. The guard is correctly placed in the `tenant-admin-pages` lane (its `src/App.tsx` is in `paths`);
  the `tenant-admin-api` lane only updates the fixture entry it owns (`e2e/fixtures/routes.ts` in its `paths`); no
  gateway `admin-init-events.ts` is created. Correct — the prior W2 finding is fully resolved.

- **Switch-target exclusion / readiness premises.** `admin-tenants.ts` already excludes `is_active !== false` and
  `is_platform !== true` from the "others" switch-target set (line 253 region confirmed). `GET /:id/readiness` exists
  at `admin-tenants.ts:536`. The deactivate/archive and readiness-extension work builds on these correctly.

- **Command Hub module pattern.** `modules.json` lists `loops-catalog.js` as `kind:"module"` loaded before `app.js`
  (which is `kind:"app"`). `loops-catalog.js` defines `window.LoopsCatalog = { render, … }` and its header documents
  the exact pattern the spec prescribes ("defines `window.LoopsCatalog`; app.js calls render() from its render switch
  … CSP: external file, no inline script, every text node via textContent"). The `command-hub-tenant-module` lane's
  design (new `tenant-admin.js` → `window.TenantAdmin.render()`, one app.js case line, CSP via `textContent`) matches
  this live pattern. Correct.

- **Moderation route files + `content_reports` forward-looking.** `admin-moderation.ts`, `admin-signups.ts`,
  `admin-community-marketplace.ts`, `admin-tenants-repository.ts` all exist. `admin-moderation.ts`'s `/reports` is
  today a placeholder returning `[]` ("no `content_reports` table yet"); the P2/P3 migrations in this spec's
  `tenant-admin-moderation-db` lane create the moderation DB objects and the `070600` moderator-tenant-scope predicate
  layers on top. `admin-moderation-repository.ts` is listed in the api lane `paths` as a file the lane will
  create/edit — the spec does not falsely assert it already exists (design "What exists" cites only the files that
  do). Consistent and not a false premise.

- **CROSS-SPEC C3 migration ordering — applied and consistent with the co-owner.** This spec keeps P2 `20261101070100`,
  P3 `20261101070150`, deactivate `070300`, archive `070350`, moderator-tenant-scope `070600`; it reserves C3
  `20261101070160` for mt-community-isolation and never creates it. mt-community-isolation independently pins its
  `platform_only_accounts` view to `20261101070160` ("do not renumber") and states the identical P2 → P3 → C3 →
  moderator-tenant-scope order. No collision with the DONE `20261014*` range. Both specs' handoff logs record the
  reservation. Correct.

- **CROSS-SPEC O2 (deactivate/archive) — owned end to end here.** `tenant-lifecycle-db` owns `deactivate_tenant`/
  `archive_tenant` + the closing switch RPC (deactivated member resolves to the default tenant, never a lockout);
  `tenant-admin-api` owns the gateway posture and tests. handoff log records mt-m3 only references it. The
  member→default resolution default is the conservative reading of §4 and is pinned by pgTAP (L3). Correct.

- **CROSS-SPEC O4 (moderation) — owned here via P2/P3 + moderator-tenant-scope.** No `moderation-tenant-db` lane
  exists or is referenced except as an explicit negation ("no `moderation-tenant-db` lane"), matching the ruling
  "remove every stale reference". The co-owner (mt-community-isolation) states it owns `content_reports` `tenant_id` +
  base RLS at `060*` while this spec's moderator-tenant-scope at `070600` layers policies on top — a clean, stated,
  non-overlapping split. Correct.

- **S-G ownership — reframed as defence-in-depth.** The spec now states the accept route already enforces email-match
  + role-allowlist (VTID-05044) at the application layer, mt-track-s adds a SECOND auth-layer line of defence, and
  this spec adds no enforcement at either layer — only the accept-page UX. This is consistent across `plan.md`
  (Problem #1 / Out of scope / Depends on), `requirements.md` (R1 preamble / Program position / Not in this slice),
  `design.md` and `lanes/tenant-admin-pages.md`. The prior MEDIUM finding is fully resolved.

- **Lane structure / scoping / standing rules.** DB lanes (`tenant-admin-moderation-db`, `tenant-lifecycle-db`) are
  separate from code lanes per §4.7; two gateway code lanes + one vitana-v1 lane; no governance-path lane, so no
  `executor: claude` lane is needed (none of the `paths` touch `.github`/`.claude`/`.kiro/steering`/`scripts/collab`/
  etc. — the validator's governance check passes). Every lane has `executor: kiro`, `next_actor: owner` (held for
  PLAN-SPAR VTID allocation), `seat` ≠ `reviewer_seat`, `depends_on` referencing only this spec's lanes, and `paths`
  covering its tasks' files including tests (`docs/validation/<vtid>/` correctly omitted per collaboration §2 and noted
  in each lane body). `tasks.md` "Allowed paths" match each lane's `paths`. Dark-by-default via `MT_RESOLUTION_V2` +
  `tenant_settings.feature_flags.mt.*`, with the single named exafy-admin-only Command Hub exception. Standing rules
  present and correct: 31/31b/48 (never test production, staging read-only with non-GET guard), 43–45, 42c/42e,
  i18n DE-first du-form + RTL, Spotlight contract, nav registry / screen manifest / parity ledger on the new App.tsx
  route, no What's New entry (admin-only). Migrations expand/contract with rollback + pre/post checks + MIGRATION-QUEUE
  rows + drift-baseline discipline, applied later by Claude via RUN-MIGRATION.

### queue.mjs validator output (decisive mechanical check)
```
handoff.md: OK
lanes/tenant-admin-moderation-db.md: OK
lanes/tenant-lifecycle-db.md: OK
lanes/tenant-admin-api.md: OK
lanes/command-hub-tenant-module.md: OK
lanes/tenant-admin-pages.md: OK
TOTAL ERRORS: 0
```

## Unverified / wrong assumptions
- None found. Every load-bearing premise was confirmed against current source. The two previously-wrong premises
  (accept route must be created; S-G enforcement is unbuilt) have been corrected in the spec and were re-confirmed
  corrected today.

## Findings
None at HIGH or MEDIUM. No NIT findings raised.

## Open questions for sparring (non-blocking)
- The deactivated-tenant gateway posture — return 410 `TENANT_DEACTIVATED` vs. silently resolve the member to their
  default tenant — is already raised by the planner under `## Open questions for sparring` in `plan.md` and is
  cross-spec with mt-m3's offboarding runbook. The plan's proposed default (member sessions resolve to default, no
  lockout; exafy-admin reads of the deactivated tenant still work for archival) is a reasonable conservative reading.
  Not scored.
