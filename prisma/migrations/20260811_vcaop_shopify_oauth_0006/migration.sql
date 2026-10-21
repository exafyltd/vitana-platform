-- Commerce Mesh — OAuth credential storage for hand-rolled connectors
-- (Shopify: VTID-03603, Track 2; SMART on FHIR: VTID-03605, Track 3 — same
-- merchant-onboarding follow-up). One row per successfully-completed OAuth
-- exchange, scoped to the integration_manifest it authorizes. Deliberately
-- provider-agnostic (endpoint_domain, not shop_domain) so a second
-- connector didn't need a second near-identical table.
--
-- KNOWN GAP, FLAGGED RATHER THAN HIDDEN: access_token is stored as plain
-- text, not encrypted at rest. Acceptable while both connectors stay
-- dormant (no provider has its credentials configured, so nothing can ever
-- populate this table for real) — must be revisited (column-level
-- encryption or a secrets manager reference instead of the raw token)
-- before either connector is configured in a real deployment.
CREATE TABLE IF NOT EXISTS "partner_oauth_credential" (
    "id" TEXT NOT NULL,
    "manifest_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint_domain" TEXT NOT NULL,
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
