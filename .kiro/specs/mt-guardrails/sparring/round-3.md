# Sparring round 3 — escalated

Session: `496d49e4-e3b5-4421-86d0-edaa18ddb659` · plan hash `5991f78d7f450fd100e986ac68b2c38c3bd86836b3a17b8795660e187aee2e95`

## Summary

The revision genuinely addresses all prior findings: R1-F1 (schema scope / INSERT-not-CREATE / regenerate enforcement), R1-F2 (glob paths), R1-F3 (PGHOST guard) are all folded into the lane specs, and both R2 findings are resolved with concrete artifacts — a "Pinned versions" table (grounded in the audit doc's supabase-postgres-17.4.1.074) and a fully-specified report-gate.mjs contract that is no longer self-referential. The plan is now substantially implementable. Three new issues remain: (1) the entire isolation-suite CI path rests on running the heavyweight supabase/postgres image as a bare GitHub Actions service container with the postgres:16 healthcheck shape, with no prior art in the repo and no spike/adapter step — the load-bearing feasibility question is unproven; (2) lane 1 asserts "no production access of any kind" while simultaneously requiring a "production schema dump", a wording contradiction that could confuse the executor about whether the read-only pg_dump is sanctioned; (3) the chosen pin is the exact version the plan's own cited evidence flags as "vulnerable_postgres_version … with patches outstanding", which is fine for a throwaway local stack but should be recorded, since the digest re-push guard offers no protection against an upstream vulnerability.

## Findings

### R3-F1 [major]

Lane 6 (ci-wiring) runs the isolation suite in CI by spinning up `supabase/postgres:17.4.1.074` as a GitHub Actions `service:` container and installing `pg_prove` on the runner. Every existing `SQL-*.yml` workflow uses the bare `postgres:16` image with a `--health-cmd pg_isready` service shape; there is zero prior art for the heavyweight, composition-aware `supabase/postgres` image as a GH Actions service, and the plan's lane 6 says the isolation workflow reuses 'the identical install mechanism' — i.e. the `postgres:16` service-container spec (pg_isready healthcheck, POSTGRES_PASSWORD, 5432:5432) with only the image tag swapped. The `supabase/postgres` image's entrypoint runs the full Supabase migration set and needs a different health/config contract than the bare postgres image's `pg_isready`. Whether it boots cleanly as a GH Actions service (or needs init SQL mounted, env vars, or its published healthcheck) is unproven and is the single load-bearing mechanism for the entire isolation suite's CI path. The plan contains no spike/adapter step and no evidence this works.

- `exafyltd/vitana-platform:.github/workflows/SQL-TENANT-FOUNDATION.yml:32` — services:
        postgres:
          image: postgres:16
          env:
            POSTGRES_PASSWORD: postgres
          ports: ['5432:5432']
          options: >-
            --health-cmd pg_isready
            --health-interval 5s
            --health-timeout 5s
            --health-retries 10
- `exafyltd/vitana-platform:.github/workflows/SQL-MEMORY-SENSITIVITY.yml:21` — services:
        postgres:
          image: postgres:16
          env:
            POSTGRES_PASSWORD: postgres
          ports: ['5432:5432']
          options: >-
            --health-cmd pg_isready
- `exafyltd/vitana-platform:.github/workflows/SQL-HEALTH-STORE.yml:24` — services:
        postgres:
          image: postgres:16
          env:
            POSTGRES_PASSWORD: postgres
          ports: ['5432:5432']
          options: >-
            --health-cmd pg_isready

Suggestion: Add a lane 6 spike/adapter item: prove `supabase/postgres:17.4.1.074` boots as a GH Actions `service:` container and record the exact healthcheck/env contract it requires (it is not `pg_isready` on a bare postgres; it likely needs its own healthcheck and may need the Supabase migrations to run before `pg_prove` can connect). Until that spike lands, the workflow-shaped test cannot assert the service shape. Do not silently skip the smoke test if the digest check cannot run.

### R3-F2 [minor]

Lane 1's spec states both 'Schema from a production *schema* dump (structure only, never data)' and 'No production access of any kind'. A `pg_dump --schema=public --schema-only` executed against the production Supabase database is a production read. As written the two requirements contradict, leaving the executor ambiguous about whether the dump (which must run `pg_dump` against a live production endpoint to capture real schema) is sanctioned. The regenerate script's `pg_dump` target is necessarily production; only the *runtime* local stack / CI is production-free.

- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:53` — A WS0 DB-lint hard gate counts bare policies … checked read-only against live before the final migration

Suggestion: Re-word lane 1: the `pg_dump --schema=public --schema-only` is a single, explicit, manual, read-only step performed once by a seated engineer on a workstation (never by CI, never by the local stack at runtime), and it is the only sanctioned production connection in the spec. State plainly that 'no production access' applies to the local stack and all CI workflows, and record the dump as a read-only rule-48-compatible action.

### R3-F3 [minor]

The 'Pinned versions' table pin `supabase/postgres:17.4.1.074`, justified as 'the version production reports', is the exact version the plan's own cited source flags as vulnerable. The audit doc labels it 'vulnerable_postgres_version … with patches outstanding. Upgrade via project settings'. Pinning the throwaway local stack to a known-vulnerable version for prod parity is defensible, but the plan presents this value as a determinism guard without recording the vulnerability caveat. The recorded index digest guards against a re-push of the same tag but offers no protection against an upstream vulnerability in the pinned version.

- `exafyltd/vitana-platform:docs/SUPABASE-SECURITY-ADVISOR-AUDIT-2026-08-28.md:58` — - **`vulnerable_postgres_version`**: currently `supabase-postgres-17.4.1.074`
    with patches outstanding. Upgrade via project settings (causes a brief
    restart — schedule it, don't run it blind).

Suggestion: Add a one-line note to the Pinned versions table: '17.4.1.074 is the version the audit doc flags as vulnerable (patches outstanding); it is pinned only for production-parity determinism of the throwaway local stack, which holds no real data and reaches no live endpoint. The digest guard does not cover upstream vulnerabilities; a bump table change is the upgrade path.'

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Addressed. The 'Pinned versions' table now supplies concrete literal strings (image tag + digest, apt version, OS) that both lanes copy verbatim, and the image tag is grounded in the audit doc's supabase-postgres-17.4.1.074 rather than the floating postgres:16 tag used by prior art.
- R2-F2: acknowledged — Addressed. The report-gate.mjs contract is now fully specified (id + continue-on-error + --outcome with the correct outcome-vs-conclusion semantics, --expect regex, five covered cases in report-gate.test.mjs, and a workflow-shape test). It is no longer self-referential — the helper reads a committed config.json and the tests exercise the helper against temp config files.
