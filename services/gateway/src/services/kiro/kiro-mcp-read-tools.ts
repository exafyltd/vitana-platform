/**
 * VTID-05005: the names of the Operator's read tools served to a Kiro session as MCP.
 *
 * VTID-05065: moved out of kiro-mcp-tools.ts (which re-exports it unchanged) so the
 * permission broker can trust these names without importing the Operator's tool
 * executor. A plain list, no behaviour.
 */
export const KIRO_MCP_READ_TOOLS = [
  // code
  'dev_search_codebase', 'dev_read_file', 'dev_repowise', 'dev_graphify', 'dev_domain_atlas',
  // dev_deep_dive is left out: it runs up to 150 s (deep-dive.ts), past the ALB's 120 s idle limit,
  // and Kiro can do the same multi-step reading with the tools above.
  // OASIS, VTID ledger, tasks
  'dev_query_oasis_events', 'discover_oasis_tasks', 'oasis_analyze_vtid', 'dev_list_tasks', 'dev_get_task_detail',
  // autopilot (read)
  'autopilot_get_status', 'autopilot_list_recent_tasks', 'autopilot_get_recommendations',
  // infrastructure
  'dev_aws_ecs_status', 'dev_ecs_tasks', 'dev_system_status', 'dev_deployment_status', 'dev_cicd_health', 'dev_lock_status',
  // data and logs (owner decision: full read access)
  'dev_run_sql_readonly', 'dev_db_query', 'dev_cloudwatch_logs',
  'knowledge_search',
  // VTID-05006: what Kiro needs to find the approvals it may act on
  'dev_list_approvals', 'dev_approval_count',
  // VTID-05060: pick up an existing VTID
  'dev_resume_vtid',
] as const;

export type KiroMcpToolName = (typeof KIRO_MCP_READ_TOOLS)[number];
