-- Commerce Mesh — Connector Factory persistence (VTID-03535, ADR-002/003).
-- Additive only: 8 new tables, no existing table touched.
-- Manifests store secret REFERENCES only (validated in application code
-- before any row is written). Reversible via down.sql (verified up->down->up
-- on ephemeral Postgres 16).

-- CreateTable
CREATE TABLE "partner_tenant" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "jurisdiction" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_manifest" (
    "id" TEXT NOT NULL,
    "partner_tenant_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "connection_type" TEXT NOT NULL,
    "risk_level" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_manifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_version" (
    "id" TEXT NOT NULL,
    "manifest_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "document_hash" TEXT NOT NULL,
    "certification_status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_capability" (
    "id" TEXT NOT NULL,
    "manifest_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schema_source" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schema_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schema_mapping" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "source_schema" TEXT NOT NULL,
    "source_field" TEXT NOT NULL,
    "canonical_entity" TEXT NOT NULL,
    "canonical_field" TEXT NOT NULL,
    "transform" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "decided_by" TEXT NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schema_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapping_decision" (
    "id" TEXT NOT NULL,
    "mapping_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mapping_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_certification" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "test_results" JSONB NOT NULL,
    "pending_mappings" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "certified_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_certification_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "idx_partner_tenant_tenant" ON "partner_tenant"("tenant_id");
CREATE INDEX "idx_partner_tenant_status" ON "partner_tenant"("status");
CREATE UNIQUE INDEX "uq_integration_manifest_partner_connector" ON "integration_manifest"("partner_tenant_id", "connector_id");
CREATE INDEX "idx_integration_manifest_status" ON "integration_manifest"("status");
CREATE UNIQUE INDEX "uq_integration_version_manifest_version" ON "integration_version"("manifest_id", "version");
CREATE INDEX "idx_integration_version_cert_status" ON "integration_version"("certification_status");
CREATE INDEX "idx_partner_capability_manifest" ON "partner_capability"("manifest_id");
CREATE INDEX "idx_schema_source_version" ON "schema_source"("version_id");
CREATE INDEX "idx_schema_mapping_version" ON "schema_mapping"("version_id");
CREATE INDEX "idx_schema_mapping_review_queue" ON "schema_mapping"("sensitive", "confidence");
CREATE INDEX "idx_mapping_decision_mapping" ON "mapping_decision"("mapping_id");
CREATE INDEX "idx_connector_certification_version_time" ON "connector_certification"("version_id", "created_at");

-- Foreign keys
ALTER TABLE "integration_manifest" ADD CONSTRAINT "integration_manifest_partner_tenant_id_fkey" FOREIGN KEY ("partner_tenant_id") REFERENCES "partner_tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration_version" ADD CONSTRAINT "integration_version_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "integration_manifest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partner_capability" ADD CONSTRAINT "partner_capability_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "integration_manifest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "schema_source" ADD CONSTRAINT "schema_source_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "integration_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "schema_mapping" ADD CONSTRAINT "schema_mapping_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "integration_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mapping_decision" ADD CONSTRAINT "mapping_decision_mapping_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "schema_mapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connector_certification" ADD CONSTRAINT "connector_certification_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "integration_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
