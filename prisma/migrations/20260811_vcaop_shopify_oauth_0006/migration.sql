-- Commerce Mesh — Shopify OAuth credential storage (VTID-03603, Track 2 of
-- the merchant-onboarding follow-up). One row per successfully-completed
-- Shopify OAuth authorization-code-grant exchange, scoped to the
-- integration_manifest it authorizes.
--
-- KNOWN GAP, FLAGGED RATHER THAN HIDDEN: access_token is stored as plain
-- text, not encrypted at rest. Acceptable while the connector is dormant
-- (SHOPIFY_CLIENT_ID/SECRET unset, so nothing can ever populate this table
-- for real) — must be revisited (column-level encryption or a secrets
-- manager reference instead of the raw token) before those env vars are
-- ever set in a real deployment.
CREATE TABLE IF NOT EXISTS "partner_oauth_credential" (
    "id" TEXT NOT NULL,
    "manifest_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "token_type" TEXT,
    "scope" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_oauth_credential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "partner_oauth_credential_manifest_fkey" FOREIGN KEY ("manifest_id")
        REFERENCES "integration_manifest"("id") ON DELETE CASCADE,
    CONSTRAINT "partner_oauth_credential_manifest_provider_unique" UNIQUE ("manifest_id", "provider")
);

CREATE INDEX IF NOT EXISTS "idx_partner_oauth_credential_manifest" ON "partner_oauth_credential"("manifest_id");
