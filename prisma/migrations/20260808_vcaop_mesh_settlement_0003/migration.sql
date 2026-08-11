-- Commerce Mesh — settlement instructions + connector usage metering
-- (VTID-03540). Sandbox instruments only until BLK-010 legal review.
-- Additive only. Reversible via down.sql (verified up->down->up on PG16).

CREATE TABLE "settlement_instruction" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "from_account" TEXT NOT NULL,
    "to_account" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "ref" TEXT,
    "memo" TEXT,
    "receipt_id" TEXT,
    "config_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_instruction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "connector_usage_record" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "tool_or_action" TEXT NOT NULL,
    "caller_client_id" TEXT,
    "outcome" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_usage_record_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_settlement_instruction_tenant_time" ON "settlement_instruction"("tenant_id", "created_at");
CREATE INDEX "idx_settlement_instruction_status" ON "settlement_instruction"("status");
CREATE INDEX "idx_connector_usage_tenant_connector_time" ON "connector_usage_record"("tenant_id", "connector_id", "occurred_at");
