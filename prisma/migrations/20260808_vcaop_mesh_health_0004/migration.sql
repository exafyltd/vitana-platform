-- Commerce Mesh — consent + health-attestation isolation (VTID-03541).
-- ⛔ DORMANT LAYER (BLK-009): tables authored for the independent privacy
-- review to examine; NOT to be applied to any live DB until that review
-- passes. At live-apply time these tables additionally get service_role-only
-- + dedicated RLS policies (separate storage/access policy per brief Sec. 11)
-- — they are never joined into general query paths.
-- consent_receipt is append-only: receipts must survive their grant, so the
-- FK is RESTRICT (a grant with receipts cannot be deleted — history first).
-- Additive only. Reversible via down.sql (verified up->down->up on PG16).

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
    "confidence" DOUBLE PRECISION NOT NULL,
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
CREATE INDEX "idx_insurance_quote_grant" ON "insurance_quote"("grant_id");

ALTER TABLE "consent_receipt" ADD CONSTRAINT "consent_receipt_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "consent_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "health_data_attestation" ADD CONSTRAINT "health_data_attestation_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "consent_grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "insurance_quote" ADD CONSTRAINT "insurance_quote_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "consent_grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
