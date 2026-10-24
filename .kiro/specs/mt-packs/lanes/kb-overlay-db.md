---
lane: kb-overlay-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: jtadic
paths:
  - supabase/migrations/20261101080000_mt_packs_knowledge_docs_tenant_id.sql
  - supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql
  - scripts/ci/migration-drift-baseline.json
  - docs/multitenancy/MIGRATION-QUEUE.md
updated: 2026-10-15T18:40Z
---
# kb-overlay-db — knowledge_docs tenant overlay column (repo vitana-platform)

Plan: `.kiro/specs/mt-packs/plan.md` (authoritative) and the `kb-overlay-db` section of `tasks.md` (D1–D3,
allowed paths, acceptance). Design + successor rules: `design.md`.

Expand-only migration `20261101080000_mt_packs_knowledge_docs_tenant_id.sql`: add nullable
`knowledge_docs.tenant_id uuid REFERENCES tenants(id)` (overlay/context; NULL = platform baseline), no backfill,
no NOT NULL; `SET lock_timeout` + retries. pgTAP spec `supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql`.
Add the not-yet-live column to `scripts/ci/migration-drift-baseline.json` and a MIGRATION-QUEUE row (NN=08 range
`20261101080000`–`085959`, after mt-tenant-admin P2/P3/C3 + moderator-tenant-scope; independent, expand-only).
This lane adds its own `docs/validation/<vtid>/` (plan-sparring.md copy, scope.json, staging-tests.json,
rollback.sql — the rollback drops the column). **The apply (RUN-MIGRATION) and the baseline removal are done by
Claude, not this lane** — a DB change is a migration file in the PR (collaboration §7a).

**pgTAP harness is owned by mt-guardrails (cross-spec dependency, reference).** The pgTAP spec is placed under
`supabase/tests/mt/**` — the directory mt-guardrails' `pgtap-isolation-suite` runner `scripts/mt/pgtap/run.*`
scans, and the one its `ci-wiring` C3 installs `pg_prove`/`pgtap` for. This lane does NOT create a runner or a
second test directory; it relies on mt-guardrails providing the harness (`pgtap-isolation-suite` for the runner,
`ci-wiring` for the CI `pg_prove` install). The `depends_on` field only takes in-spec lane ids, so this cross-spec
dependency is stated here and in `plan.md` ## Depends on rather than as a `depends_on` entry.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; PLAN-SPAR flips it to `kiro`.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, **no `apply_migration` or any Supabase/AWS write** — the migration is a
file only. Work only inside the allowed paths. Branch `kiro/mt-packs/kb-overlay-db`; PR title
`VTID-xxxxx (mt-packs/kb-overlay-db): …`; trailers `Collab-Session: <id>` / `Collab-Lane: mt-packs/kb-overlay-db`.
When the PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-packs planner. Seat `hotmail` (supabase/migrations + DB lane per the brief's lane assignment),
reviewer `jtadic` (≠ seat). DB lane kept separate from the code lanes (§4.7). Held at `owner` pending VTID.

### 2026-10-15T18:40Z · kiro-hotmail-202610151618-b437 · internal-review fix
MEDIUM-1: moved the pgTAP spec from the non-existent `supabase/migrations/tests/` to `supabase/tests/mt/` so
mt-guardrails' runner (`scripts/mt/pgtap/run.*`, `pgtap-isolation-suite`) and its CI `pg_prove` install
(`ci-wiring` C3) pick it up; stated the cross-spec dependency on mt-guardrails providing the harness. The
expand-only migration (nullable FK, no backfill, `lock_timeout`, rollback, drift baseline, NN=08 queue row) is
unchanged.
