-- Commerce Mesh — consent + health-attestation isolation (VTID-03541).
-- ⛔ BLK-009 GATED: apply only after the independent privacy review passes.
-- Revised 2026-08-09 (VTID-03547) per that review's F9 finding: the
-- append-only and isolation controls now live IN this reviewed artifact,
-- not in a comment promising them later.
--  - RLS is ENABLED with no policies on all four tables → only service_role
--    (which bypasses RLS) can touch them; they are never joined into
--    general query paths.
--  - consent_receipt is append-only BY TRIGGER: any UPDATE or DELETE raises.
--    Receipts must survive their grant, so the grant FK is RESTRICT — a
--    grant with receipts cannot be deleted (history first).
-- Additive only. Reversible via down.sql (verified up->down->up on PG16) —
-- but see down.sql's header: receipts MUST be exported before any rollback.

CREATE TABLE "consent_grant" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "grantee" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "permitted_claims" JSONB NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "reward_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "retention_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_grant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "consent_receipt" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "accessor" TEXT NOT NULL DEFAULT 'unknown',
    "detail" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_receipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "health_data_attestation" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "met" BOOLEAN NOT NULL,
    "confidence_band" TEXT NOT NULL,
    "issuer" TEXT NOT NULL DEFAULT 'Vitanaland',
    "raw_data_disclosed" BOOLEAN NOT NULL DEFAULT false,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "health_data_attestation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "insurance_quote" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "insurer" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "premium_minor" BIGINT NOT NULL,
    "discount_bps" INTEGER NOT NULL,
    "based_on_claims" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "selected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_quote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_consent_grant_user_status" ON "consent_grant"("user_id", "status");
CREATE INDEX "idx_consent_grant_grantee_status" ON "consent_grant"("grantee", "status");
CREATE INDEX "idx_consent_receipt_grant_time" ON "consent_receipt"("grant_id", "at");
CREATE INDEX "idx_health_attestation_grant" ON "health_data_attestation"("grant_id");
-- F6 (idempotent issuance): one attestation per (grant, claim, period).
CREATE UNIQUE INDEX "uq_health_attestation_grant_claim_period" ON "health_data_attestation"("grant_id", "claim", "period");
CREATE INDEX "idx_insurance_quote_grant" ON "insurance_quote"("grant_id");

ALTER TABLE "consent_receipt" ADD CONSTRAINT "consent_receipt_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "consent_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "health_data_attestation" ADD CONSTRAINT "health_data_attestation_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "consent_grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "insurance_quote" ADD CONSTRAINT "insurance_quote_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "consent_grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- F9: append-only is a CONTROL, not a comment — receipts can never be
-- rewritten or removed, by anyone, service_role included.
CREATE OR REPLACE FUNCTION _consent_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consent_receipt is append-only (BLK-009): % refused', TG_OP;
END;
$$;

CREATE TRIGGER trg_consent_receipt_immutable
  BEFORE UPDATE OR DELETE ON "consent_receipt"
  FOR EACH ROW EXECUTE FUNCTION _consent_receipt_immutable();

-- F9: service_role-only isolation — RLS enabled, zero policies. These tables
-- are reached exclusively through the health layer's own gates.
-- N5 (re-review): FORCE so the table OWNER is bound too — isolation must not
-- rest on connection-role discipline.
ALTER TABLE "consent_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_grant" FORCE ROW LEVEL SECURITY;
ALTER TABLE "consent_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_receipt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "health_data_attestation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "health_data_attestation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "insurance_quote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "insurance_quote" FORCE ROW LEVEL SECURITY;
