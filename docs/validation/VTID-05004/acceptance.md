# VTID-05004 - Kiro workspace card: an accepted key is confirmed, not offered for revocation

Owner request 2026-10-09 (Gate 1 yes). Sparring: `plan-sparring.md` (converged, 2 rounds). Front-end only.

VALIDATION_PROFILE: gateway_backend

OASIS_IMPACT: no (no new events; no gateway change).

## Acceptance criteria

AC-1: A linked key: the "Your Kiro API key" row reads a green "✓ Connected" (`kiro-key-ok`); no Replace/Revoke buttons; exactly one "Manage key" (`kiro-key-manage`).
  TEST: services/gateway/test/command-hub/vtid-04999-kiro-key-field.test.ts
  UI: screenshots outputs/kiro-key-a-linked-*.png (desktop 1400x900, mobile 390x844), no horizontal overflow
AC-2: "Manage key" reveals exactly Replace, Revoke and Done; Done hides them again; Replace keeps the existing replace flow.
  TEST: services/gateway/test/command-hub/vtid-04999-kiro-key-field.test.ts
  UI: screenshots outputs/kiro-key-b-manage-*.png
AC-3: Revoke is reached through Manage key and still asks first; a failed revoke keeps the manage view.
  TEST: services/gateway/test/command-hub/vtid-04999-kiro-key-field.test.ts
AC-4: Not-linked flow, the Kiro default engine and every Command Hub suite stay green; the cache-bust is bumped and every pinned staging probe follows it.
  TEST: services/gateway/test/command-hub/vtid-05003-kiro-default-engine-ui.test.ts
