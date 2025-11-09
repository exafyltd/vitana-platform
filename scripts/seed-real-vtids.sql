-- Seed Real VTIDs for Production Work
-- VTID: DEV-AICOR-VTID-LEDGER-CLEANUP
-- Date: 2025-11-09

-- Insert real work VTIDs
INSERT INTO "VtidLedger" (id, vtid, task_family, task_type, description, status, tenant, is_test, created_at, updated_at) VALUES
(gen_random_uuid(), 'DEV-AICOR-0015', 'ai-core', 'ledger-cleanup', 'VTID Ledger Cleanup - Add is_test flag and filter logic', 'complete', 'vitana', false, NOW(), NOW()),
(gen_random_uuid(), 'DEV-AICOR-0016', 'ai-core', 'event-sync', 'Event to VTID Status Synchronization', 'complete', 'vitana', false, NOW(), NOW()),
(gen_random_uuid(), 'DEV-COMMU-0043', 'communication', 'live-refresh', 'Command Hub Live Event Stream (SSE)', 'complete', 'vitana', false, NOW(), NOW()),
(gen_random_uuid(), 'DEV-COMMU-0044', 'communication', 'gchat-notify', 'Google Chat VTID Event Notifications', 'complete', 'vitana', false, NOW(), NOW()),
(gen_random_uuid(), 'DEV-CICDL-0032', 'cicd', 'pipeline-hardening', 'CI/CD Pipeline Error Handling & Retry Logic', 'pending', 'vitana', false, NOW(), NOW()),
(gen_random_uuid(), 'DEV-MCPGW-0003', 'mcp', 'connector-expansion', 'Add Slack and Notion MCP Connectors', 'pending', 'vitana', false, NOW(), NOW()),
(gen_random_uuid(), 'DEV-OASIS-0008', 'oasis', 'retention-policy', 'Implement Event Retention and Archival', 'pending', 'vitana', false, NOW(), NOW())
ON CONFLICT (vtid) DO NOTHING;
