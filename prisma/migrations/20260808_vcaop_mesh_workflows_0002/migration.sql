-- Commerce Mesh — durable event workflows (VTID-03537, brief Sec. 9).
-- Additive only: 7 new tables, no existing table touched.
-- Reversible via down.sql (verified up->down->up on ephemeral Postgres 16).

-- CreateTable
CREATE TABLE "event_subscription" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "workflow_name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "normalized_event" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "source_native_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "canonical" JSONB NOT NULL,
    "dropped_fields" JSONB NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "normalized_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_version" (
    "id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run" (
    "id" TEXT NOT NULL,
    "definition_name" TEXT NOT NULL,
    "definition_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_step" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "result" JSONB,
    "error" TEXT,

    CONSTRAINT "workflow_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter_event" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "run_id" TEXT,
    "event" JSONB,
    "replayed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letter_event_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "uq_event_subscription_route" ON "event_subscription"("tenant_id", "connector_id", "event_key", "workflow_name");
CREATE INDEX "idx_event_subscription_lookup" ON "event_subscription"("connector_id", "event_key", "active");
CREATE INDEX "idx_normalized_event_correlation" ON "normalized_event"("correlation_id");
CREATE INDEX "idx_normalized_event_backlog" ON "normalized_event"("processed", "received_at");
CREATE UNIQUE INDEX "workflow_definition_name_key" ON "workflow_definition"("name");
CREATE UNIQUE INDEX "uq_workflow_version" ON "workflow_version"("definition_id", "version");
CREATE UNIQUE INDEX "workflow_run_idempotency_key_key" ON "workflow_run"("idempotency_key");
CREATE INDEX "idx_workflow_run_reconciler" ON "workflow_run"("status", "updated_at");
CREATE INDEX "idx_workflow_run_correlation" ON "workflow_run"("correlation_id");
CREATE INDEX "idx_workflow_run_tenant_status" ON "workflow_run"("tenant_id", "status");
CREATE INDEX "idx_workflow_step_run_seq" ON "workflow_step"("run_id", "sequence");
CREATE INDEX "idx_dead_letter_backlog" ON "dead_letter_event"("replayed", "created_at");

-- Foreign keys
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
