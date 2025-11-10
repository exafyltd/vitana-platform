-- VTID: DEV-AICOR-VTID-LEDGER-CLEANUP
ALTER TABLE "VtidLedger" ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT false;

UPDATE "VtidLedger" 
SET "is_test" = true
WHERE "description" IN (
  'Test Task Alpha',
  'Test Task Beta', 
  'Test Task Gamma',
  'Another Test',
  'Sample Task'
);

INSERT INTO "VtidLedger" ("vtid", "layer", "module", "description", "status", "is_test", "created_at", "updated_at")
VALUES 
  ('DEV-AGENT-0203', 'AGENT', 'CORE', 'Agent Core Implementation', 'completed', false, NOW(), NOW()),
  ('DEV-AGENT-0204', 'AGENT', 'WORKFLOW', 'Agent Workflow Automation', 'completed', false, NOW(), NOW()),
  ('DEV-CICDL-0052', 'CICDL', 'PIPELINE', 'CI/CD Pipeline Enhancement', 'completed', false, NOW(), NOW()),
  ('DEV-COMMU-0042', 'COMMU', 'GCHAT', 'Google Chat Integration', 'completed', false, NOW(), NOW()),
  ('DEV-COMMU-0049', 'COMMU', 'UI', 'Command Hub UI Improvements', 'active', false, NOW(), NOW())
ON CONFLICT ("vtid") DO UPDATE SET
  "layer" = EXCLUDED."layer",
  "module" = EXCLUDED."module",
  "description" = EXCLUDED."description",
  "status" = EXCLUDED."status",
  "is_test" = EXCLUDED."is_test",
  "updated_at" = NOW();

CREATE INDEX IF NOT EXISTS "idx_vtid_ledger_is_test" ON "VtidLedger"("is_test");
