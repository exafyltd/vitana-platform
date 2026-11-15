# Tasks — strategy-execution-wave1
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/strategy-execution-wave1/<lane>`; title
`VTID-xxxxx (strategy-execution-wave1/<lane>): …`; trailers `Collab-Session`, `Collab-Lane`; author `kiro-agent[bot]`;
evidence in `docs/validation/<VTID>/` (`acceptance.md`, `commands.log`, `scope.json`).

Common acceptance for the six discovery lanes and `security-evidence`:
- Change types: Tooling/docs.
- Only the lane `paths` change; no code, schema, flag, workflow, `CLAUDE.md`, `areas.yaml` or multi-tenant spec changes.
- Every `file:line` citation resolves on the `origin/main` pinned in the doc header (checked by a grep script whose run
  is in `commands.log`).
- Every statement about a system carries one status class: Verified operational (only with a run id); Verified
  implemented, not operational; Implemented but incomplete; Designed but not implemented; Deprecated/superseded; Unknown.
- Every needed change is a "proposed follow-up" (title, files, risk, owner, gate), never presented as done.
- `node scripts/collab/preflight.mjs` and `node --test scripts/collab/*.test.mjs` pass. Deploys nothing.

<!-- lane: ch-discovery -->
## Lane `ch-discovery`
- [ ] T1 Per section/tab of `NAVIGATION_CONFIG` (`app.js:3236-3549`): render function, API routes with route file:line and
      auth middleware, data tables/RPCs, permissions, status, gaps.
- [ ] T2 Supervisory target design (13 accounts, GitLab, VTID, OASIS, tenants, Autopilot, workers, integrations) built
      from existing sources only; PUBLISH rule/code conflict stated for the owner.

**Acceptance**
- All 26 sections and every tab listed; each tab names at least one API route or says "static / placeholder" with the line.
- No new store or execution engine proposed; GitLab stays authoritative for source, MRs, reviews and CI/CD.

<!-- lane: oasis-traceability -->
## Lane `oasis-traceability`
- [ ] T1 Current trace path per item (account/session, VTID, repo/commit, start/end, lifecycle, decisions, evidence,
      verification, deployment, outcome) with file:line.
- [ ] T2 Design through existing `oasis_events`, `vtid_ledger`, trailers, GitLab webhook, PM emit seam; ledger-link
      options with compatibility; plan-sparring gate mode left unchanged.

**Acceptance**
- No parallel ledger, audit history or ID scheme; canonical format `VTID-XXXXX` (5 digits) throughout.

<!-- lane: autonomy-risks -->
## Lane `autonomy-risks`
- [ ] T1 Register of every risk in plan §2 plus any found: severity, status at HEAD, tenant/security/execution-integrity/
      financial-publishing impact, owner, dependencies, remediation, verification.
- [ ] T2 Dispatcher and worker-runner facts as found; ordering of critical risks before any autonomy activation.

**Acceptance**
- Each risk cites current file:line; no autonomy setting or level is changed or recommended for activation.

<!-- lane: delivery-capacity -->
## Lane `delivery-capacity`
- [ ] T1 Inventory of seats, sessions (lane logs, trailers, claim refs), GitHub/GitLab identities, Claude Code status.
- [ ] T2 Available capacity vs the 12 Kiro + 1 Claude Code target; proposed `CLAUDE.md` / `areas.yaml` wording for the owner.

**Acceptance**
- No account reported active without evidence; no personal e-mail address in the doc; protected files untouched.

<!-- lane: security-evidence -->
## Lane `security-evidence`
- [ ] T1 `strategy-memory-grants-check.test.mjs` first, red on base (file missing), then the SELECT-only SQL file.
- [ ] T2 Doc: what to run, by whom, where to record output; what stays blocked until then.

**Acceptance**
- The test fails on any statement keyword other than SELECT/WITH and on a missing function list; the SQL covers the four
  memory functions × `anon`, `authenticated`, `service_role`, `migrate`, plus `pg_policies` / `relrowsecurity` for the
  memory and tenant tables named in the doc. The lane never connects to a database.

<!-- lane: hm-readiness -->
## Lane `hm-readiness`
- [ ] T1 Each of the 19 Healthy Million acceptance criteria against the Maxina implementation (location, tenant-scoped or
      hardwired, status) and its prerequisites (migration queue rows, mt-* lanes).

**Acceptance**
- No tenant, pack or content created; replication start stays gated on the multi-tenant, mobile and website foundations.

<!-- lane: destination-identity -->
## Lane `destination-identity`
- [ ] T1 Current default identity (domain map, `/auth`, golden tests, native ids) with file:line; migration-aware path
      coordinated with `mt-frontend-brand-r3`.

**Acceptance**
- No identity, domain or bundle migration performed; Maxina behaviour unchanged; Vitana stays the universal companion.

<!-- lane: mental-health-label -->
## Lane `mental-health-label`
- [ ] T1 `src/i18n/pillar-mental-health-label.test.ts` first, red on `origin/main`.
- [ ] T2 Set the fifth-pillar name labels listed in plan §4.8 to "Mental Health" in each locale (de first:
      "Mentale Gesundheit"), keys unchanged; `npm run i18n:inventory`.
- [ ] T3 Read-only staging spec `tests/e2e/staging/mental-health-label.staging.spec.ts`; screenshots desktop 1400×900,
      mobile 390×844 and RTL (ar) of the Health and Vitana Index screens.

**Acceptance**
- Change types: UI.
- Only JSON values of the listed keys change; no key renamed, no code changed.
- Test, `npm test`, `npm run lint` pass; STAGING-VERIFY passes on the merge commit; screenshots show no overflow.
