-- =============================================================================
-- VTID-04860 — The token is called VTNA, never "VTN"
-- -----------------------------------------------------------------------------
-- Owner directive (2026-10-03): the Vitana token is VTNA everywhere. The wallet
-- currency itself was renamed VTN → VTNA in vitana-v1 migration 20251010181210,
-- but the knowledge base that Vitana answers from (knowledge_docs, seeded from
-- docs/knowledge-base/** via scripts/kb-seed.sql) still says "VTN", so members
-- who ask about rewards hear the old name.
--
-- This rewrites the stored title and content of every knowledge doc that still
-- uses the bare word "VTN". content_tsv is a generated column, so search picks
-- the new text up by itself.
--
--   * Whole word only: \m…\M never touches "VTNA" or identifiers like vtn_wallets.
--   * Ticket serial numbers ("VTN-20250115-000042") are a different thing and
--     are left alone (the "-<digit>" lookahead).
--   * Idempotent: once no row matches, it is a no-op.
--
-- The repo sources were renamed in the same change; this keeps the live rows
-- in line without a full knowledge-base re-seed.
-- =============================================================================

BEGIN;

UPDATE public.knowledge_docs
SET
  title   = regexp_replace(title,   '\mVTN\M(?!-[0-9])', 'VTNA', 'g'),
  content = regexp_replace(content, '\mVTN\M(?!-[0-9])', 'VTNA', 'g')
WHERE title   ~ '\mVTN\M(?!-[0-9])'
   OR content ~ '\mVTN\M(?!-[0-9])';

COMMIT;
