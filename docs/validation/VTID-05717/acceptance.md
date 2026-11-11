# VTID-05717 acceptance (architecture-mt-alignment / mt-alignment)

Deliverable: `docs/programs/strategy-execution/multi-tenant-alignment.md` (below: "the doc").
Pins: vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`, vitana-v1 `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f`,
strategy `e5dd629d77a8e1032148e3c28688613924b6bd9c`. Acceptance source: `plan-mt-align/.kiro/specs/architecture-mt-alignment/tasks.md:6-12`
(common) and `plan-mt-align/.kiro/specs/architecture-mt-alignment/tasks.md:31-32` (lane).

## Common acceptance

- [x] AC-C1 Change types: Tooling/docs. Evidence: `scope.json` (`"kind":"docs"`); only Markdown, one `.mjs` check script,
  `commands.log` and `scope.json` are added.
- [x] AC-C2 Only the lane `paths` change; no code, schema, migration, flag, RLS, MT spec, `CLAUDE.md` or `areas.yaml`
  change. Evidence: `git status --porcelain` in `commands.log` lists only
  `docs/programs/strategy-execution/multi-tenant-alignment.md` and `docs/validation/VTID-05717/`. Lane paths:
  `plan-mt-align/.kiro/specs/architecture-mt-alignment/lanes/mt-alignment.md:13`. The lane commits are on PR #4965.
- [x] AC-C3 Every `file:line` resolves at the pins; the strategy SHA is recorded. Evidence: `check-citations.mjs` run and
  its output in `commands.log` (ok and failed counts, exit code 0); SHAs in the doc header and in `commands.log`.
- [x] AC-C4 Every statement carries one status class. Evidence: the doc's legend (VO, VI, II, DN, DS, UK) and a class
  column in every §1 table; §2 states and §5 Unknowns. "Verified operational" is used only for queue rows that carry a
  RUN-MIGRATION run id (`docs/multitenancy/MIGRATION-QUEUE.md:18-25`); the doc says these were not re-read live (§5).
- [x] AC-C5 Every needed change is a proposed follow-up (title, files, owner, gate), never presented as done. Evidence:
  doc §4, F1-F8, each with an owning MT spec and gate.

## Lane acceptance

- [x] AC-L1 18 of 18 workstreams in the table; each conflict names the MT spec and file. Evidence: doc §3, rows WS01-WS18
  from `vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:13` to
  `vitanaland-strategy/19-EXECUTION-PROGRAMME/master-task-registry.json:198`; each conflict cell cites a lane file line
  or a queue row. WS09 records "no file overlap" with the migration-order and flag constraint instead.
- [x] AC-L2 No duplicate resolver, identity, membership or authorisation model is proposed. Evidence: doc §4 preamble; F1
  routes local lookups to the existing `resolvePrimaryTenant()` (`services/gateway/src/services/tenancy/tenant-context.ts:43`);
  F2 merges two planned `healthDb` files into one; F3 aligns `canManageRoles` with the existing `requireTenantAdmin`
  check (`services/gateway/src/middleware/require-tenant-admin.ts:143`); F6 retires a second host map in favour of the
  existing `resolve_tenant(p_host, p_slug)` (`supabase/migrations/20261102140100_vtid_05507_mt_resolve_tenant_host.sql:40`).
- [x] T1 MT contracts at the pin with file:line and status class: doc §1.1-§1.10.
- [x] T2 Open MT specs and lanes with protected paths and hot files: doc §2.1 (56 lane files not done, 49 open after
  superseded ones), §2.2 open PRs, §2.3 queue rows not applied (56 of 64).
- [x] T3 18-workstream table with contracts consumed, must-not-duplicate, conflicts, and the MT-plan work stream
  mapping onto WS03: doc §3 and §3.1; follow-ups in §4.

## AC mapping (Validator Check format)
AC-1 Change types: Tooling/docs only (AC-C1).
TEST: `scope.json` `"kind":"docs"`; Lane scope check in preflight and CI.
AC-2 Only the lane `paths` change (AC-C2).
TEST: `git diff --name-only origin/main...HEAD` lists only the lane file, the doc and `docs/validation/VTID-05717/**` (Lane scope check).
AC-3 Every `file:line` resolves at the pins (AC-C3).
TEST: `node docs/validation/VTID-05717/check-citations.mjs` → ok=525 failed=0, exit 0 (`outputs/check-citations.txt`).
AC-4 Every statement carries one status class (AC-C4).
TEST: doc legend and class column in every §1 table (manual check recorded in `commands.log`).
AC-5 Every needed change is a proposed follow-up, none presented as done (AC-C5).
TEST: doc §4 F1-F8, each with owning MT spec and gate.
AC-6 18 of 18 workstreams, each conflict names the MT spec and file (AC-L1).
TEST: doc §3 rows WS01-WS18; citations covered by check-citations.mjs.
AC-7 No duplicate resolver, identity, membership or authorisation model (AC-L2).
TEST: doc §4 preamble and F1, F2, F3, F6 cite the existing contracts.

## Limits

- No live database, auth config or deployment was read; §5 of the doc lists what needs live state.
- GitHub PR state is a snapshot from 2026-11-11.
- Wave-1 findings are cited as drafts, not merged (`draft-05689/docs/programs/strategy-execution/destination-identity-strategy.md:224`,
  `draft-05690/docs/programs/strategy-execution/healthy-million-readiness.md:441`).
