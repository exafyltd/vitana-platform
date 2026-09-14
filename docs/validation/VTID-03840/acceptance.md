# VTID-03840 — Infra: erp-bridge service + ERPClaw foundation spike

VTID: VTID-03840
Spec: approved (gateway spec pipeline generate → validate → quality-check pass 95 → approve; `outputs/00-bootstrap.txt`).
Scope: `services/erp-bridge/**`, `.github/workflows/AWS-STAGE-DEPLOY-ERP-BRIDGE.yml`, `config/service-path-map.json`, `docs/validation/VTID-03840/**`.
Staging only. No customers. No production deploy workflow touched. No Supabase migration.

Environment used for every measurement: this session's container, PostgreSQL 16.13 (throwaway cluster on a
unix socket), ERPClaw checkout at the pinned commit 4d32db6585297a1d05a7b5927168de8c75bb7708 with the three
Vitana patches applied, erpclaw-growth 2.10.0 at 7c1b5ae5701980e97f34cf25fa5943066140f6a3. **No AWS resource
was created or touched** — the session has no AWS credentials, and the brief forbids inventing infrastructure.

## Acceptance criteria

AC-1 — `services/erp-bridge` exists: Python/FastAPI, allowlisted versioned actions, validated JSON, idempotency keys, receipts, per-tenant DB routing, no model-selected CLI flags
TEST: `services/erp-bridge/tests/test_catalog.py`, `tests/test_runner.py`, `tests/test_idempotency.py`, `tests/test_api.py` — 36 passed (`outputs/08-bridge-pytest.txt`, run with `ERPCLAW_ROOT` and `ERP_BRIDGE_TEST_DB_URL` set so the pinned-router cross-check and the Postgres receipt store both ran, 0 skipped).
CURL: `outputs/12-bridge-e2e.txt` — real uvicorn process, real ERPClaw subprocesses, real PG16: read (company_id injected), draft (CRM `add-lead`), replay (`replayed:true`, one row in DB), 409 on key reuse with a different payload, 422 on a smuggled `db_path`, 403 on `post-gl-entries`, Commit needs confirmation then `--user-confirmed` is appended by the bridge and GL posts, High-risk refuses maker==checker and voice, executes with a proper approval; receipts persisted in the tenant DB; server log has 0 occurrences of the DB URL.

AC-2 — ERPClaw vendored at the pinned commit + CRM module vendored and pinned; GitHub install-module path disabled in production; wave-1 module allowlist = CRM only
TEST: `tests/test_catalog.py::test_only_the_crm_domain_of_growth_is_allowlisted`, `::test_never_exposed_actions_are_absent` (install-module/remove-module/update-modules/sync-registry unreachable).
UI: n/a.
CURL: n/a — build-time: `outputs/13-vendor-sh-rehearsal.txt` (`vendor/vendor.sh` clones both pins, fails on SHA mismatch, applies patches, overlays `uae_ifrs.json`, writes `.no_autosync`, stages the module tree, removes `.git`; regenerated flag manifest is byte-identical to the committed `vendor/action-flags.json`). Runtime module install with no network: `outputs/11-crm-module-local-install.txt` (registry manifest integrity 29/29, 32 tables, 7 module migrations, 164 actions cached).

AC-3 — Subprocess latency distribution measured
TEST: `outputs/05-latency.txt` — n=40 reads / n=20 writes: `list-companies` p50 206 ms, p95 217 ms; `add-journal-entry` p50 176 ms; `submit-journal-entry` p50 185 ms; bare interpreter start 14 ms. Interpreter+import dominates (~190 ms floor per call).

AC-4 — Concurrent GL posting test
TEST: `outputs/06a-…BEFORE-patch0002.txt` (8/12 — `tuple concurrently updated`, a real ERPClaw-on-Postgres defect) and `outputs/06b-…AFTER-patch0002.txt` (12/12 and 24/24 parallel add+submit; 108 new GL rows = expected; debit−credit delta 0; no duplicate naming series; no orphan GL rows; every submitted JE has exactly 3 GL rows).

AC-5 — Idempotent retry test
TEST: `outputs/07-idempotent-retry-naive.txt` — ERPClaw alone: identical `add-journal-entry` twice → two drafts (no idempotency concept upstream); `submit` retry is rejected by the status guard. Bridge: `tests/test_idempotency.py` (memory + Postgres stores; 6 concurrent duplicates → exactly 1 execution, all 6 receive the same receipt; abandoned in-progress retried after staleness) and `outputs/12-bridge-e2e.txt` (live replay).

AC-6 — Backup/restore proof
TEST: `outputs/09-backup-restore.txt` — `pg_dump -Fc` → fresh DB → `pg_restore`; row counts (company/account/journal_entry/gl_entry/tax_template_line/schema_migration/216 tables) and GL debit/credit sums identical; restored DB served by the ERPClaw CLI.

AC-7 — Upgrade rehearsal (pinned → next)
TEST: `outputs/10-upgrade-rehearsal.txt` + `outputs/00-upstream-tags.txt` — upstream `main` == the pin and no newer tag exists on 2026-09-13, so the rehearsal exercises the exact mechanism a bump runs: `migrate --dry-run` / `migrate --user-confirmed` on the RESTORED copy (36/36 ledger rows, second run a no-op, CLI still serves), source DB untouched (0 ledger rows). Found and fixed on the way: migration 035 needs `typing_extensions` (undeclared upstream; now pinned in `requirements.txt`). Bump procedure documented in `services/erp-bridge/README.md`.

AC-8 — Security review of subprocess + secrets
TEST: `outputs/14-security-review.md` (trust boundaries, argument-injection controls, tier gating, secret handling, six upstream findings with patches, residual risks). Backed by `tests/test_runner.py::test_smuggled_flags_and_values_are_refused` (9 cases), `::test_subprocess_env_is_minimal_and_redaction_hides_the_url`, `::test_real_subprocess_runs_with_timeout_and_json`.

AC-9 — CoA template loader accepts a non-shipped `uae_ifrs.json`
TEST: `outputs/01-coa-before.txt` (template absent → clean error) and `outputs/02-coa-uae-ifrs.txt` (file dropped into `assets/charts/` → 22 accounts created, idempotent re-run 0). Shipped as `vendor/charts/uae_ifrs.json`, overlaid by `vendor.sh`.

AC-10 — UAE VAT reverse-charge and zero-rated cases in ERPClaw tax rules
TEST: `outputs/04-uae-vat-cases.txt` — on net 1,000.00 AED: standard 5% → 50.00; zero-rated 0% → 0.00 with the VAT line present; reverse charge (5% add to RCM output + 5% deduct to RCM input) → +50.00 / −50.00, total tax 0.00, grand total 1,000.00, both legs recorded. Templates persist (`list-tax-templates`).

AC-11 — `fetch-exchange-rates` explicitly allowlisted; everything else network-free
TEST: `tests/test_catalog.py::test_tier_and_gating_are_consistent_with_the_design_gate` (Commit tier, note pins `api.frankfurter.dev`); the operator egress rule is recorded in the README.

AC-12 — Staging deploy path, no prod twin
TEST: `.github/workflows/AWS-STAGE-DEPLOY-ERP-BRIDGE.yml` — `test` job (pytest) then build/push/roll; preflight refuses any service name containing `awsdr`/`prod`, refuses to register a task def if either Secrets Manager entry is missing. `config/service-path-map.json` registers `erp-bridge`. YAML/JSON parsed (`commands.log`).
UI: n/a.

AC-13 — Postgres arithmetic on `decimal_sum()` works (report/GL/credit actions that failed on the spike)
TEST: `outputs/15-patch0004-decimal-sum-numeric.txt` — `validate-period-close`, `general-ledger`, `cash-flow`, `comparative-pl`, `check-credit-limit`, `check-overdue`, `submit-sales-invoice` all `status: ok` on the spike DB with patch 0004; an aggregate installed by 0002 (finalfunc → text) is upgraded in place on the first connection open (`prorettype` text → numeric, old finalfunc dropped); `vendor.sh` rehearsal applies all four patches and `action-flags.json` stays IDENTICAL (`outputs/16-vendor-sh-four-patches.txt`); bridge suite 34 passed / 2 skipped after the lock change; upstream SQLite suites for reports/gl/setup-lib unchanged by the patch (`outputs/17-upstream-sqlite-suites-with-0004.txt`).

## Not verified / owed

- Nothing here ran on AWS: no ECR repo, ECS service, per-tenant Postgres or Secrets Manager entries exist for the bridge yet (README "Provisioning"). The workflow will fail at preflight, loudly, until an operator creates them.
- The container image was not built here (no Docker daemon in the session); `vendor.sh` — the only non-trivial build step — was rehearsed standalone.
- Latency/concurrency numbers are container-local; ECS adds one network RTT per SQL statement to a remote Postgres.
- The "quotation → invoice line materialisation" and "credit-note submit action" contract questions left open by GOLDEN-WORKFLOWS §4 are pinned in the catalog notes (credit note = `create-credit-note` draft + `submit-sales-invoice` at High-risk); the quotation→invoice path is NOT resolved in this VTID and stays a VTID-F item.
