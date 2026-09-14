# erp-bridge (VTID-03840)

Private, versioned, allowlisted HTTP facade over the vendored [ERPClaw](https://github.com/avansaber/erpclaw)
CLI. It is the only process that ever runs ERPClaw; the gateway is the only
caller; browsers never reach it (brief §8).

```
browser ──► gateway (/api/v1/backoffice/*, capability + maker-checker, VTID-F)
                 │  X-ERP-Bridge-Token, JSON, idempotency_key
                 ▼
            erp-bridge  ──subprocess──►  python3 scripts/db_query.py --action … (ERPClaw, GPL, hosted only)
                 │                                   │
                 └── receipts ──►  per-tenant Postgres  ◄── ERPClaw ledger (ERPCLAW_DB_URL)
```

## What it guarantees

| Property | Where |
|---|---|
| Only catalogued actions run; `post-gl-entries`, `install-module`, `migrate`, credentials, users… are unreachable | `app/catalog.py` (`CATALOG`, `NEVER_EXPOSED`) |
| No model-selected CLI flags: a param becomes `--flag` only if the spec admits it **and** the pinned tree declares it; `--db-path`, `--force`, `--company-id`, stdin/env credential flags are denied outright | `catalog.admitted_flag`, `vendor/action-flags.json` |
| `--user-confirmed` is appended by the bridge, only for ERPClaw-gated actions, only with an admitted confirmation | `runner.build_argv` |
| Commit tier needs `confirmation.granted`; High-risk needs `approval_id` + requester ≠ approver, and is never confirmable from the voice channel | `main.execute` |
| One ERPClaw database per tenant; `company_id` injected from tenant config, never from the request | `config.Tenant`, `runner.build_argv` |
| Idempotency: `(tenant, idempotency_key)` → stored receipt; duplicates replay, mismatches 409, in-flight duplicates wait on a per-key advisory lock | `app/idempotency.py` (`vitana_bridge_receipt` in the tenant DB) |
| Subprocess: no shell, fixed router path, minimal env, hard timeout, bounded output, DB URL redacted from every byte that leaves | `app/runner.py` |
| ERPClaw pinned by commit; vendored at image build with pin verification; GitHub install path disabled (`.no_autosync`, modules copied from the pinned addons tree) | `vendor/erpclaw.lock.json`, `vendor/vendor.sh`, `vendor/install_module_local.py` |
| Wave-1 module allowlist = `erpclaw-growth`, CRM domain only | `ERP_BRIDGE_MODULE_ALLOWLIST`, catalog test |

## API (v1)

| Route | Auth | Purpose |
|---|---|---|
| `GET /alive`, `GET /ready` | none | ECS health; `ready` fails without tenants/router |
| `GET /v1/catalog` | token | the allowlist, tiers, capabilities, admitted params |
| `POST /v1/execute` | token | `{tenant_id, action, params, idempotency_key, actor{user_id,channel}, confirmation{granted, approval_id, approved_by, requested_by}}` → `{ok, receipt}` |
| `GET /v1/receipts/{tenant}/{key}` | token | replay a receipt |

Receipt: `{status: executed|failed, replayed, action, command, tier, rc, duration_ms, result, stderr_tail, argv, actor, confirmation, catalog_version, erpclaw_pin}`.

## Configuration

| Var | Meaning |
|---|---|
| `ERP_BRIDGE_TOKEN` | shared secret (≥32 chars). Missing → the process refuses to start. |
| `ERP_TENANTS` | JSON `{ "<tenant_id>": {"db_url": "postgresql://…", "company_id": "<uuid>"} }` — from Secrets Manager `vitana/erp-bridge/staging/tenants` |
| `ERPCLAW_ROOT` / `ERPCLAW_HOME` | set by the Dockerfile (`/opt/erpclaw`, `/var/lib/erpclaw`) |
| `ERP_BRIDGE_MODULE_ALLOWLIST` | default `erpclaw-growth` |
| `ERP_BRIDGE_SUBPROCESS_TIMEOUT_S` | default 60 |
| `ERP_BRIDGE_ENV` | `staging` |

## Tenant bootstrap (per tenant, once)

Run from inside the container as the service user, with `ERPCLAW_DB_URL` set to that tenant's URL:

```
python3 $ERPCLAW_ROOT/scripts/db_query.py --action initialize-database          # 216 tables
python3 $ERPCLAW_ROOT/scripts/db_query.py --action migrate --user-confirmed     # foundation ledger (36)
ERPCLAW_ROOT=$ERPCLAW_ROOT python3 /app/vendor/install_module_local.py erpclaw-growth $ERPCLAW_HOME/vendored-modules/erpclaw-growth
python3 $ERPCLAW_ROOT/scripts/db_query.py --action setup-company --name … --abbr … --currency AED --country "United Arab Emirates"
python3 $ERPCLAW_ROOT/scripts/db_query.py --action seed-defaults --company-id <id>
python3 $ERPCLAW_ROOT/scripts/db_query.py --action setup-chart-of-accounts --company-id <id> --template uae_ifrs
```
Then put `<id>` into `ERP_TENANTS[...].company_id`. Bootstrap actions are deliberately **not** in the catalog.

## Provisioning (staging) — `scripts/aws/setup-erp-bridge-staging.sh`

The deploy workflow refuses to run until the AWS resources exist (its preflight), and
creating them needs admin rights no Claude Code session has (the session's IAM user is
read-only for ECR/ECS/RDS/Secrets — measured `AccessDenied` on every create call). The
script is the exact, idempotent set of calls an operator runs instead; every fact in it
(subnets, security groups, roles, RDS endpoint, VPC) was read from the live account.

```
scripts/aws/setup-erp-bridge-staging.sh provision            # dry run — prints the plan
scripts/aws/setup-erp-bridge-staging.sh provision --apply    # ECR repo, log group, the two secrets,
                                                             # SG rules, Cloud Map DNS, placeholder
                                                             # task def, ECS service (desiredCount 0)
# then let AWS-STAGE-DEPLOY-ERP-BRIDGE.yml build + roll the real image (push to main / dispatch)
scripts/aws/setup-erp-bridge-staging.sh bootstrap-tenant \
    --tenant-id <vitana tenant uuid> --db-name erpclaw_<slug> \
    --company-name "Vitanaland Trading LLC" --abbr VTL --apply
scripts/aws/setup-erp-bridge-staging.sh status
```

What the pieces are:

1. **ERPClaw Postgres** — a separate *database* per tenant on the staging RDS instance
   `vitana-postgres-staging` (never the app database), owned by a per-tenant role whose
   password lives in `vitana/erp-bridge/staging/tenant-db/<tenant>`. `bootstrap-tenant`
   runs `scripts/bootstrap_tenant.py` as a one-shot ECS task **inside the VPC** using the
   deployed bridge image: role + database DDL (the RDS master password is read by the task
   from the RDS-managed secret and never leaves the VPC), then the spike sequence —
   `initialize-database → migrate → install erpclaw-growth (vendored) → setup-company →
   setup-chart-of-accounts --template uae_ifrs → seed-defaults` — then merges the tenant
   into the `tenants` secret and scales the service to 1. Rehearsed end to end on a local
   Postgres: `docs/validation/VTID-03840/outputs/18-tenant-bootstrap-rehearsal.txt`.
2. **ECR `vitana/erp-bridge`**, **ECS `vitana-erp-bridge`** on `Vitana-ECS-Cluster` (Fargate,
   fixed desiredCount, **no ALB rule**). The gateway reaches it privately through a Cloud
   Map private DNS namespace: `http://erp-bridge.vitana.internal:8080`.
3. **Secrets Manager**: `vitana/erp-bridge/staging/bridge-token` (generated once by the
   script, never printed or rotated by it), `vitana/erp-bridge/staging/tenants` (`{}` until
   the first `bootstrap-tenant`).
4. **Gateway wiring is automatic**: `AWS-STAGE-DEPLOY-GATEWAY.yml` upserts `ERP_BRIDGE_URL`
   + `ERP_BRIDGE_TOKEN` on the gateway task definition whenever the token secret exists,
   and leaves them untouched (bridge reported `not_configured`) while it does not.
5. Egress: allow `api.frankfurter.dev:443` only (for `fetch-exchange-rates`) — still an
   operator-side network-policy item; the script does not manage NACLs/egress.
6. Task role: the bridge itself needs no AWS API permissions; the *bootstrap* task's
   execution role gets a scoped `secretsmanager:GetSecretValue` on the two secrets it reads.

Production has no twin of any of this on purpose (staging-first; the bridge is not in
`AWS-PROD-DEPLOY-*` at all).

## Local development

```
pip install -r requirements.txt
python -m pytest -q tests                      # no ERPClaw checkout needed
ERPCLAW_ROOT=/path/to/erpclaw ERP_BRIDGE_TEST_DB_URL=postgresql://… python -m pytest -q tests   # + pinned-router + PG receipt store checks
```

Spike evidence (latency, concurrency, idempotency, backup/restore, upgrade, UAE VAT, CoA loader, patches):
`docs/validation/VTID-03840/`.

## Bumping the ERPClaw pin

1. Edit `vendor/erpclaw.lock.json` (foundation + addons commits) under a new VTID.
2. `python3 vendor/extract_flags.py <root> <growth-dir> > vendor/action-flags.json`; run the tests — they fail if a catalogued action or admitted flag disappeared.
3. Re-check the four patches apply (`git apply --check`); upstream may have fixed them.
   0004 (`decimal_sum` returns `numeric`; HAVING repeats aggregates instead of aliases) is the one
   most likely to be superseded upstream — drop it the moment `general-ledger` runs clean without it.
4. Rehearse `migrate --dry-run` / `migrate --user-confirmed` on a **restored copy** of a tenant DB (see outputs/10-upgrade-rehearsal.txt), never on the live one.
