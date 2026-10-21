# VTID-03840 — security review: subprocess + secrets (erp-bridge)

Scope: `services/erp-bridge` as shipped in this VTID, and the ERPClaw CLI it
hosts (pinned 4d32db65…, GPL-3.0, hosted only).

## 1. Trust boundary

| Boundary | Control | Evidence |
|---|---|---|
| Browser → bridge | none exists: no ALB rule, no public DNS; only the gateway holds `ERP_BRIDGE_TOKEN` | README "Provisioning"; workflow registers no listener |
| Gateway → bridge | shared token (`X-ERP-Bridge-Token`, constant-time compare), JSON schema (pydantic, bounded sizes), tenant must be configured | `app/main.py`; `tests/test_api.py::test_v1_refuses_without_token`, `test_unknown_tenant_is_404` |
| Bridge → ERPClaw | subprocess, no shell, fixed interpreter + router path + cwd, minimal env (8 vars), hard timeout, bounded capture | `app/runner.py`; `tests/test_runner.py::test_subprocess_env_is_minimal_and_redaction_hides_the_url`, `test_real_subprocess_runs_with_timeout_and_json` |
| ERPClaw → Postgres | one DB per tenant via `ERPCLAW_DB_URL`; the bridge process itself only opens the same tenant DB for receipts | `app/config.py`, `app/idempotency.py` |
| ERPClaw → internet | none, except `fetch-exchange-rates` → `api.frankfurter.dev` (explicitly allowlisted, egress must be pinned to that host by the operator) | `catalog.FX_API_HOST`, README §Provisioning 4 |
| Image build → GitHub | `vendor.sh` clones the two pinned commits and fails on any SHA mismatch; `.git` removed; `git` purged from the image | `vendor/vendor.sh`, `Dockerfile`; outputs/13-vendor-sh-rehearsal.txt |

## 2. Argument injection (the actual risk with a CLI)

- argv is `[python, router, --action, <name>, (--company-id <tenant cfg>), (--flag value)*, (--user-confirmed)]`. Nothing else, ever.
- A param is admitted only if the catalog spec allows the name **and** the pinned manifest (`vendor/action-flags.json`, generated from the vendored trees) declares the flag for that domain script. Unknown → 422 before anything runs.
- `DENY_FLAGS` (db path/url, action, force/confirm/dry-run, stdin/env credential sources, csv/file paths, company) are refused even where a domain declares them.
- Values: scalars or JSON documents only; a value starting with `-` is refused (argparse would read it as a flag); NUL refused; booleans only for `store_true` switches.
- `--user-confirmed` is never a payload field; the bridge appends it iff the action is in ERPClaw's `DANGEROUS_ACTIONS` **and** the request carries an admitted confirmation. Tests: `test_user_confirmed_only_for_gated_actions_and_only_when_confirmed`, `test_smuggled_flags_and_values_are_refused` (9 cases).
- The pinned `DANGEROUS_ACTIONS` copy is cross-checked against the vendored router when `ERPCLAW_ROOT` is set (`test_dangerous_set_matches_the_vendored_router_when_available`, run with the checkout in commands.log).

## 3. Tier gating inside the bridge (defense in depth; the gateway does the real policy in VTID-F)

- Read/Draft: run on a valid token.
- Commit: `confirmation.granted` required, else 403 `confirmation_required`.
- High-risk: additionally `approval_id`, `approved_by`, `requested_by`; requester ≠ approver (409-style 403 `maker_checker_violation`); `actor.channel == voice` refused. Tests: `test_high_risk_needs_maker_checker_and_never_voice`; live: outputs/12-bridge-e2e.txt.
- `NEVER_EXPOSED` (raw GL posting, install/remove modules, migrate, schema, credentials, users, backups, demo data) is asserted disjoint from the catalog at import time and by test.

## 4. Secrets

- `ERP_BRIDGE_TOKEN`, `ERP_TENANTS` arrive as ECS `secrets` (Secrets Manager ARNs), never as plain env in the task def; the workflow refuses to register a task def if either secret is missing.
- The DB URL is never logged (log line carries action/tenant/tier/rc/ms only), never returned (`/v1/catalog` body asserted free of `postgresql://`), and redacted from stdout/stderr/JSON before storage (URL, netloc, password, hostname). Test: `test_real_subprocess_runs_with_timeout_and_json` (a router that echoes `ERPCLAW_DB_URL` comes back `<redacted>`).
- ERPClaw's own credential store (`set-credential`, `migrate-credentials`, passphrase flags) is unreachable through the bridge.
- Receipts store the redacted result only.

## 5. Findings in the pinned ERPClaw (all patched in `vendor/patches/`, all reproduced in outputs/)

1. **PG URL shadowed by SQLite default** — every module `main()` passes `DEFAULT_DB_PATH` (a file path) into `get_connection()`, so `ERPCLAW_DB_URL` never won under `ERPCLAW_DB_DIALECT=postgresql` ("invalid dsn"). Patch 0001.
2. **`decimal_sum` aggregate created on every connection** → `tuple concurrently updated` under concurrency (4/12 failures). Patch 0002 (existence fast-path + advisory lock). 12/12 and 24/24 after.
3. **Module-action lookup is SQLite-only** (`sqlite3.connect(DB_PATH)`) → every CRM action "Unknown action" on Postgres. Patch 0003.
4. `typing_extensions` is required by migration 035 but not declared upstream → pinned in requirements.txt.
5. **No idempotency key anywhere in ERPClaw** → naive retry double-creates drafts. Owned by the bridge (§6 of the design gate).
6. `install-module` / registry autosync reach GitHub at runtime → disabled (`.no_autosync`, local install from the pinned addons tree, actions on `NEVER_EXPOSED`).

## 6. Residual risks / not done here

- **Process isolation**: subprocess runs as the same non-root user as the service. A seccomp/rootless sandbox per invocation is a later hardening step; the flag/env controls above are the compensating control now.
- **Egress**: enforced by the operator's network policy, not by code. Until pinned, `fetch-exchange-rates` should stay out of `ERP_TENANTS`-enabled tenants' policy (gateway side).
- **Resource limits**: timeout + output cap only; no CPU/memory cgroup per subprocess. ECS task limits bound the container.
- **Token rotation**: single shared token; rotate via Secrets Manager + redeploy. mTLS between gateway and bridge is a follow-up.
- **Receipts retention**: no TTL yet (index on `created_at` is there for a future sweep).
- **Not verified on AWS**: no ECS/ECR/Postgres exists for this service yet; everything above was exercised locally (container-local PG16, real subprocesses).
