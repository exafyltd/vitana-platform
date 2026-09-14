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

## Provisioning still owed by an operator (cannot be done from a Claude Code session)

1. Dedicated Postgres for ERPClaw (one DB per tenant; the spike used PG 16). Not the Vitana app DB.
2. ECR repo `vitana/erp-bridge`; ECS service `vitana-erp-bridge` on `Vitana-ECS-Cluster` (fixed `desiredCount` 1, no ALB rule — private; the gateway reaches it over the VPC via service discovery or a private ALB listener).
3. Secrets Manager: `vitana/erp-bridge/staging/bridge-token`, `vitana/erp-bridge/staging/tenants`.
4. Egress: allow `api.frankfurter.dev:443` only (for `fetch-exchange-rates`); block everything else.
5. Task role: no AWS API permissions needed; the bridge only talks to Postgres.

Until 2–3 exist, `AWS-STAGE-DEPLOY-ERP-BRIDGE.yml` fails at preflight by design.

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
