# VTID-03842 — Gateway: BackOffice command orchestrator + approvals + audit

VTID: VTID-03842
Spec: approved (generate → validate pass → quality-check pass 95 → approve; `outputs/f-spec-*.json`).
Scope: `services/gateway/src/{constants/backoffice-commands.ts, services/backoffice/{command-policy,erp-bridge-client,entity-resolution,command-store}.ts, routes/backoffice-commands.ts, routes/backoffice-access.ts (export only), index.ts (mount)}`, `services/gateway/test/**` (4 new suites), `supabase/migrations/20260913020000_vtid_03842_erp_commands_approvals_audit.sql` (NOT applied), `DATABASE_SCHEMA.md`, `docs/validation/VTID-03842/**`.
Stacked on VTID-03834 (#3284): needs `requireErpCapability`/`resolveAccess` and `erp_capability_grants`. Staging only. No prod workflow touched.

ROUTE_MOUNT: `services/gateway/src/index.ts` — `mountRouterSync(app, '/api/v1/backoffice', backofficeCommandsRouter, { owner: 'backoffice-commands' })`, next to the VTID-03834 access router on the same prefix.
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/backoffice/commands` (POST), `/commands/:id`, `/commands` (GET), `/approvals`, `/approvals/:id/approve|reject`, `/audit`, `/policy` (GET/PUT), `/commands-catalog`.
OASIS_PROOF: `emitOasisEvent` is called from `audit()` in `routes/backoffice-commands.ts` on every real transition only (`backoffice.command.executed|failed|queued|rejected`, `backoffice.approval.approved|rejected|refused`, `backoffice.policy.updated`; vtid VTID-03842, source gateway, actor_id = caller, payload carries tenant_id/command_id/approval_id). No polling or heartbeat emits anything. Asserted by `test/routes/backoffice-commands.test.ts` "read executes on the bridge … audit + OASIS emitted" (`expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ type: 'backoffice.command.executed', vtid: 'VTID-03842' }))`, `outputs/jest-targeted.txt`). Live `oasis_events` rows cannot be shown until the routes are on staging with the bridge configured.
CURL_PROOF: not yet curl-able on staging (this branch is unmerged); mount proof by supertest against the real router — `POST /api/v1/backoffice/commands` without a token → `401 application/json {"ok":false,"error":"UNAUTHENTICATED"}` (`test/routes/backoffice-commands.test.ts` "401 without identity, JSON body (mount proof)", `outputs/jest-targeted.txt`). Once #3284 + this merge to staging: `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-aws-gateway.vitanaland.com/api/v1/backoffice/commands -H 'Content-Type: application/json' -d '{}'` must print `401 application/json…`, never `text/html`.

## Acceptance criteria

AC-1 — `POST /api/v1/backoffice/commands` accepts `{type, payload, idempotency_key, channel?, confirm?}` and returns `{command_id, tier, status: executed|awaiting_approval|rejected|failed, receipt, reason}`
TEST: `test/routes/backoffice-commands.test.ts` (18 tests) — read executes and stores the bridge receipt; unknown type / bad key → 400; mount proof 401 JSON.
CURL: `outputs/jest-targeted.txt`.

AC-2 — Typed commands come from the VTID-A mapping, one registry shared with the bridge
TEST: `test/vtid-03842-command-policy.test.ts` "registry shape" (164 unique types; every ERPClaw-gated action is Commit/High; approver only on High) and `test/vtid-03842-commands-vs-bridge-catalog.test.ts` (action/tier/capabilities/domain/company-scope byte-equal to `services/erp-bridge/app/catalog.py`; `outputs/jest-crosscheck.txt`, skips when the bridge tree is absent).

AC-3 — Entity resolution: exact match only, mirrors SKILL.md's refusal to guess
TEST: `test/vtid-03842-entity-resolution.test.ts` (5 tests: exact trimmed/case-folded match resolves; several matches → `entity_ambiguous` with candidates; near miss → `entity_not_found`; ref+id → `entity_ref_conflict`; lookup failure surfaces) and the two route tests under "entity resolution" (lookup goes through the bridge's Read action with `search`, resolved id replaces the ref, nothing is executed on ambiguity).

AC-4 — Policy check: capabilities + tiers + no self-approval, §4.3 escalations, channel ceilings, developer/infra Read ceiling
TEST: `test/vtid-03842-command-policy.test.ts` (22 tests): capability any-of; Commit needs explicit confirmation; High always queues; `kind:pay` → `finance.pay`; `tags:payroll` → `payroll.approve`; amount ≥ tenant threshold → per-domain approver; escalations stack and never downgrade; voice ≤ Draft, chat ≤ Commit; developer/infra rejected `platform_role_read_only`; requester ≠ approver for everyone incl. Exafy; approver must hold the approve-level capability (`approvals.policy` never approves); approvals only from web with an `aal2` session when the policy requires MFA.

AC-5 — Approval queue with maker-checker and minimum staffing
TEST: route tests "High-risk → approvals": queue returns 202 + `approval_id` + `approve_capability`; `no_eligible_approver` recorded when the tenant lacks a second approver (still queued); self-approve → 403; approver without MFA → `mfa_required`; from chat → `approval_requires_approvals_screen`; second admin on web with aal2 → bridge runs with `{granted, approval_id, approved_by, requested_by}`; second decision → 409; reject path stores the note and never reaches the bridge; Exafy super-admin cannot self-approve.
UI: n/a (Approvals screen is VTID-G).

AC-6 — Independent audit log + receipts, OASIS events on real transitions only
TEST: route tests assert the audit event sequence (`command.queued`, `approval.refused` ×3, `approval.approved`; `command.executed`/`command.failed`/`command.rejected`; `policy.updated`) and that `emitOasisEvent` is called with `backoffice.command.executed`. Migration makes `erp_audit_log` append-only (trigger raises on UPDATE/DELETE; UPDATE/DELETE revoked from service_role) and `erp_approvals` carries `CHECK (decided_by <> requester_id)`.

AC-7 — Idempotency keys end to end
TEST: route test "idempotency": same key + same request → replay (`replayed: true`, one bridge call); same key + different payload → 409; the same key is forwarded to the bridge, which owns the ERPClaw-side receipt (VTID-03840).

AC-8 — One policy path for web, Operator chat and ORB voice
TEST: `channel` is part of the request and the actor; route tests exercise `chat` (Commit executes with confirmation) and `voice` (Draft executes, Commit rejected `voice_not_permitted`). No second execution path exists: `runOnBridge` is the only caller of the bridge client with a confirmation.

AC-9 — Type-check and full suite
TEST: `outputs/tsc.txt` (`tsc --noEmit` exit 0); `outputs/jest-targeted.txt` (5 suites incl. the VTID-03834 access suite unchanged); `commands.log` full-suite tail.

## Not verified / owed

- Nothing here ran against staging: the gateway needs `ERP_BRIDGE_URL` + `ERP_BRIDGE_TOKEN` on its task definition (Secrets Manager, staging first) and the bridge itself needs the AWS resources listed in VTID-03840's README. Until then `POST /commands` answers `502 bridge_not_configured` (a failed, audited row — never a silent success) and ref lookups `503`.
- Migration not applied (rule 4). With the tables absent the store throws → 500 `INTERNAL_ERROR` on every command; the code path is covered by the memory store.
- `posting_date inside a closed period → rejected` (§4.3) is NOT implemented: it needs period state from ERPClaw (`validate-period-close`) and is left to the accounting screens VTID (recorded, not silently dropped).
- MFA is read from the JWT `aal` claim; staging users without MFA cannot approve High-risk until they enrol or the tenant policy sets `require_mfa_for_high=false` via `PUT /policy` (audited).
