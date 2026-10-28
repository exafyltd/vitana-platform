# VTID-04860 — the token is VTNA, never "VTN"

Owner directive 2026-10-03. The wallet currency was renamed VTN -> VTNA in
October 2025 (vitana-v1 migration 20251010181210); the old name survived in
member-facing text and in the knowledge base Vitana answers from.

AC-1 No member- or Vitana-readable source in this repo uses the bare word "VTN" (gateway src, openclaw-bridge, knowledge base sources, kb seed, docs, second-brain wiki).
TEST: services/gateway/test/vtid-04860-vtna-token-name.test.ts
Evidence: outputs/guard-test.txt (3 passed); commands.log (mutation check: a re-introduced "VTN" makes it fail).

AC-2 The diary-streak push tells members "+N VTNA credited".
TEST: services/gateway/test/vtid-04860-vtna-token-name.test.ts

AC-3 The live knowledge base is renamed by a migration that is whole-word only, leaves ticket serials ("VTN-<digit>") and identifiers (vtn_*) untouched, is idempotent and non-destructive.
TEST: services/gateway/test/vtid-04860-vtna-token-name.test.ts
Migration: supabase/migrations/20261003120000_vtid_04860_knowledge_docs_vtna_name.sql (applied at the production step; staging shares the production database).

AC-4 Nothing else changes behaviour: the suites covering every touched gateway file still pass.
TEST: services/gateway/test (18 suites touching diary-streak-celebrator, automation-registry, wallet-payments, worker-orchestrator-service)
Evidence: outputs/related-suites.txt (338 passed).

Out of scope on purpose: applied migrations, recorded validation output, and
machine identifiers members never see (vtn_* tables/RPCs, payments-wallet-vtn,
the vitana-vtn-wallet skill id, the 03-credits-cash-and-vtn.md path used as a
knowledge-doc key).
