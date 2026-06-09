-- CreateTable
CREATE TABLE "business_identity" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "registration_no" TEXT,
    "vat_eori" TEXT,
    "ein" TEXT,
    "registered_address" TEXT,
    "officer_name" TEXT,
    "officer_id_ref" TEXT,
    "license_refs" JSONB,
    "document_refs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "connector_mode" TEXT NOT NULL,
    "supports_bulk" BOOLEAN NOT NULL DEFAULT false,
    "supports_mfa" BOOLEAN NOT NULL DEFAULT false,
    "supports_rotation" BOOLEAN NOT NULL DEFAULT false,
    "jurisdiction" TEXT,
    "tos_risk_level" TEXT,
    "connector_config" JSONB,
    "policy" JSONB NOT NULL,
    "kyb_required" BOOLEAN NOT NULL DEFAULT true,
    "required_documents" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_account" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "credential_ref" TEXT,
    "mfa_seed_ref" TEXT,
    "alias_mailbox" TEXT,
    "current_agent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_job" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "connector_tier" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisioning_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_step" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "step_type" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_attempt" (
    "id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_artifact" (
    "id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT,
    "scrubbed" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_task" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "assignee" TEXT,
    "provider_id" TEXT,
    "job_id" TEXT,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "sla" TIMESTAMP(3),
    "evidence_refs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "human_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_health_snapshot" (
    "id" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "health_status" TEXT NOT NULL,
    "detail" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_health_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_program" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "commission_terms" JSONB,
    "affiliate_cashback_allowed" BOOLEAN,
    "policy" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_event" (
    "id" TEXT NOT NULL,
    "affiliate_program_id" TEXT NOT NULL,
    "sub_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "order_ref" TEXT,
    "gross_commission" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "postback_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards_ledger" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "commission_event_id" TEXT,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "state" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rewards_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_reward_link" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "member_id" TEXT,
    "consent_ref" TEXT,
    "official_api_token_ref" TEXT,
    "read_only" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_reward_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_order" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "total_amount" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_route" (
    "id" TEXT NOT NULL,
    "cart_order_id" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "checkout_connector" TEXT,
    "affiliate_program_id" TEXT,
    "sub_id" TEXT,
    "line_items" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disclosure" (
    "id" TEXT NOT NULL,
    "cart_order_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'ftc_affiliate',
    "text" TEXT NOT NULL,
    "dismissible" BOOLEAN NOT NULL DEFAULT false,
    "shown_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disclosure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_business_identity_tenant" ON "business_identity"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_provider_category" ON "provider"("category");

-- CreateIndex
CREATE INDEX "idx_provider_account_tenant_provider" ON "provider_account"("tenant_id", "provider_id");

-- CreateIndex
CREATE INDEX "idx_provider_account_status" ON "provider_account"("status");

-- CreateIndex
CREATE INDEX "idx_provisioning_job_account" ON "provisioning_job"("provider_account_id");

-- CreateIndex
CREATE INDEX "idx_provisioning_job_status" ON "provisioning_job"("status");

-- CreateIndex
CREATE INDEX "idx_job_step_job" ON "job_step"("job_id");

-- CreateIndex
CREATE INDEX "idx_job_attempt_step" ON "job_attempt"("step_id");

-- CreateIndex
CREATE INDEX "idx_job_artifact_attempt" ON "job_artifact"("attempt_id");

-- CreateIndex
CREATE INDEX "idx_human_task_tenant_status" ON "human_task"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "idx_human_task_type" ON "human_task"("type");

-- CreateIndex
CREATE INDEX "idx_account_health_account_time" ON "account_health_snapshot"("provider_account_id", "computed_at");

-- CreateIndex
CREATE INDEX "idx_affiliate_program_network" ON "affiliate_program"("network");

-- CreateIndex
CREATE INDEX "idx_commission_event_user_status" ON "commission_event"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_commission_event_subid" ON "commission_event"("sub_id");

-- CreateIndex
CREATE INDEX "idx_rewards_ledger_user_state" ON "rewards_ledger"("user_id", "state");

-- CreateIndex
CREATE INDEX "idx_user_reward_link_user" ON "user_reward_link"("user_id");

-- CreateIndex
CREATE INDEX "idx_cart_order_user_status" ON "cart_order"("user_id", "status");

-- CreateIndex
CREATE INDEX "idx_merchant_route_cart" ON "merchant_route"("cart_order_id");

-- CreateIndex
CREATE INDEX "idx_disclosure_cart" ON "disclosure"("cart_order_id");

-- AddForeignKey
ALTER TABLE "provider_account" ADD CONSTRAINT "provider_account_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_job" ADD CONSTRAINT "provisioning_job_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_step" ADD CONSTRAINT "job_step_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "provisioning_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_attempt" ADD CONSTRAINT "job_attempt_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "job_step"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_artifact" ADD CONSTRAINT "job_artifact_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "job_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_health_snapshot" ADD CONSTRAINT "account_health_snapshot_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_event" ADD CONSTRAINT "commission_event_affiliate_program_id_fkey" FOREIGN KEY ("affiliate_program_id") REFERENCES "affiliate_program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards_ledger" ADD CONSTRAINT "rewards_ledger_commission_event_id_fkey" FOREIGN KEY ("commission_event_id") REFERENCES "commission_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_route" ADD CONSTRAINT "merchant_route_cart_order_id_fkey" FOREIGN KEY ("cart_order_id") REFERENCES "cart_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disclosure" ADD CONSTRAINT "disclosure_cart_order_id_fkey" FOREIGN KEY ("cart_order_id") REFERENCES "cart_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

