-- RLS policies (idempotent: DROP POLICY IF EXISTS then CREATE, one pair per policy)
DROP POLICY IF EXISTS audit_admin_read ON public.access_audit_log;
CREATE POLICY audit_admin_read ON public.access_audit_log AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND is_platform_admin()));

DROP POLICY IF EXISTS "Users can request own deletion" ON public.account_deletion_requests;
CREATE POLICY "Users can request own deletion" ON public.account_deletion_requests AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view own deletion requests" ON public.account_deletion_requests;
CREATE POLICY "Users can view own deletion requests" ON public.account_deletion_requests AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS account_health_snapshot_staff_rw ON public.account_health_snapshot;
CREATE POLICY account_health_snapshot_staff_rw ON public.account_health_snapshot AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])))
  WITH CHECK ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS action_ledger_select_own ON public.action_ledger;
CREATE POLICY action_ledger_select_own ON public.action_ledger AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS action_ledger_service ON public.action_ledger;
CREATE POLICY action_ledger_service ON public.action_ledger AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS active_threads_tenant_user_isolation ON public.active_threads;
CREATE POLICY active_threads_tenant_user_isolation ON public.active_threads AS PERMISSIVE FOR ALL TO public
  USING (((tenant_id = COALESCE((current_setting('app.tenant_id'::text, true))::uuid, '00000000-0000-0000-0000-000000000000'::uuid)) AND (user_id = COALESCE((current_setting('app.user_id'::text, true))::uuid, '00000000-0000-0000-0000-000000000000'::uuid))));

DROP POLICY IF EXISTS admin_insights_self_read ON public.admin_insights;
CREATE POLICY admin_insights_self_read ON public.admin_insights AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id IN ( SELECT ut.tenant_id
   FROM user_tenants ut
  WHERE ((ut.user_id = auth.uid()) AND (ut.active_role = ANY (ARRAY['admin'::text, 'developer'::text, 'infra'::text]))))));

DROP POLICY IF EXISTS admin_insights_service ON public.admin_insights;
CREATE POLICY admin_insights_service ON public.admin_insights AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can manage proactive settings" ON public.admin_proactive_settings;
CREATE POLICY "Admins can manage proactive settings" ON public.admin_proactive_settings AS PERMISSIVE FOR ALL TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = 'admin'::tenant_role) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS "Anyone can view proactive settings" ON public.admin_proactive_settings;
CREATE POLICY "Anyone can view proactive settings" ON public.admin_proactive_settings AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS affiliate_program_read ON public.affiliate_program;
CREATE POLICY affiliate_program_read ON public.affiliate_program AS PERMISSIVE FOR SELECT TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text, 'developer'::text])));

DROP POLICY IF EXISTS affiliate_program_write ON public.affiliate_program;
CREATE POLICY affiliate_program_write ON public.affiliate_program AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = 'admin'::text))
  WITH CHECK ((vcaop_role() = 'admin'::text));

DROP POLICY IF EXISTS aal_select ON public.agent_audit_log;
CREATE POLICY aal_select ON public.agent_audit_log AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS aal_service ON public.agent_audit_log;
CREATE POLICY aal_service ON public.agent_audit_log AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS akb_select ON public.agent_kb_bindings;
CREATE POLICY akb_select ON public.agent_kb_bindings AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS akb_service ON public.agent_kb_bindings;
CREATE POLICY akb_service ON public.agent_kb_bindings AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS akbt_service ON public.agent_kb_bindings_tenant;
CREATE POLICY akbt_service ON public.agent_kb_bindings_tenant AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS akbt_tenant_member_select ON public.agent_kb_bindings_tenant;
CREATE POLICY akbt_tenant_member_select ON public.agent_kb_bindings_tenant AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM user_tenants ut
  WHERE ((ut.tenant_id = agent_kb_bindings_tenant.tenant_id) AND (ut.user_id = auth.uid())))));

DROP POLICY IF EXISTS agent_keys_service_role_all ON public.agent_keys;
CREATE POLICY agent_keys_service_role_all ON public.agent_keys AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS apv_select ON public.agent_persona_versions;
CREATE POLICY apv_select ON public.agent_persona_versions AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS apv_service ON public.agent_persona_versions;
CREATE POLICY apv_service ON public.agent_persona_versions AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS agent_personas_select ON public.agent_personas;
CREATE POLICY agent_personas_select ON public.agent_personas AS PERMISSIVE FOR SELECT TO authenticated
  USING ((status <> 'disabled'::text));

DROP POLICY IF EXISTS agent_personas_service ON public.agent_personas;
CREATE POLICY agent_personas_service ON public.agent_personas AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS apto_service ON public.agent_personas_tenant_overrides;
CREATE POLICY apto_service ON public.agent_personas_tenant_overrides AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS apto_tenant_member_select ON public.agent_personas_tenant_overrides;
CREATE POLICY apto_tenant_member_select ON public.agent_personas_tenant_overrides AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM user_tenants ut
  WHERE ((ut.tenant_id = agent_personas_tenant_overrides.tenant_id) AND (ut.user_id = auth.uid())))));

DROP POLICY IF EXISTS arkt_service ON public.agent_routing_keywords_tenant;
CREATE POLICY arkt_service ON public.agent_routing_keywords_tenant AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS arkt_tenant_member_select ON public.agent_routing_keywords_tenant;
CREATE POLICY arkt_tenant_member_select ON public.agent_routing_keywords_tenant AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM user_tenants ut
  WHERE ((ut.tenant_id = agent_routing_keywords_tenant.tenant_id) AND (ut.user_id = auth.uid())))));

DROP POLICY IF EXISTS aconn_service ON public.agent_third_party_connections;
CREATE POLICY aconn_service ON public.agent_third_party_connections AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS atb_select ON public.agent_tool_bindings;
CREATE POLICY atb_select ON public.agent_tool_bindings AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS atb_service ON public.agent_tool_bindings;
CREATE POLICY atb_service ON public.agent_tool_bindings AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS at_select ON public.agent_tools;
CREATE POLICY at_select ON public.agent_tools AS PERMISSIVE FOR SELECT TO authenticated
  USING ((enabled = true));

DROP POLICY IF EXISTS at_service ON public.agent_tools;
CREATE POLICY at_service ON public.agent_tools AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access to agent_voice_config_changes" ON public.agent_voice_config_changes;
CREATE POLICY "Service role full access to agent_voice_config_changes" ON public.agent_voice_config_changes AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role full access to agent_voice_configs" ON public.agent_voice_configs;
CREATE POLICY "Service role full access to agent_voice_configs" ON public.agent_voice_configs AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role full access to agents_registry" ON public.agents_registry;
CREATE POLICY "Service role full access to agents_registry" ON public.agents_registry AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS ai_assistant_credentials_select_own ON public.ai_assistant_credentials;
CREATE POLICY ai_assistant_credentials_select_own ON public.ai_assistant_credentials AS PERMISSIVE FOR SELECT TO authenticated
  USING ((connection_id IN ( SELECT uc.id
   FROM user_connections uc
  WHERE (uc.user_id = auth.uid()))));

DROP POLICY IF EXISTS ai_assistant_credentials_service ON public.ai_assistant_credentials;
CREATE POLICY ai_assistant_credentials_service ON public.ai_assistant_credentials AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS ai_consent_log_select_self ON public.ai_consent_log;
CREATE POLICY ai_consent_log_select_self ON public.ai_consent_log AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS ai_consent_log_service ON public.ai_consent_log;
CREATE POLICY ai_consent_log_service ON public.ai_consent_log AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can create their own conversations" ON public.ai_conversations;
CREATE POLICY "Users can create their own conversations" ON public.ai_conversations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can insert own conversations" ON public.ai_conversations;
CREATE POLICY "Users can insert own conversations" ON public.ai_conversations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own conversations" ON public.ai_conversations;
CREATE POLICY "Users can update their own conversations" ON public.ai_conversations AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view own conversations" ON public.ai_conversations;
CREATE POLICY "Users can view own conversations" ON public.ai_conversations AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own conversations" ON public.ai_conversations;
CREATE POLICY "Users can view their own conversations" ON public.ai_conversations AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "System can create memory" ON public.ai_memory;
CREATE POLICY "System can create memory" ON public.ai_memory AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own memory" ON public.ai_memory;
CREATE POLICY "Users can update their own memory" ON public.ai_memory AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own memory" ON public.ai_memory;
CREATE POLICY "Users can view their own memory" ON public.ai_memory AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can create messages in their conversations" ON public.ai_messages;
CREATE POLICY "Users can create messages in their conversations" ON public.ai_messages AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM ai_conversations
  WHERE ((ai_conversations.id = ai_messages.conversation_id) AND (ai_conversations.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can delete messages from their conversations" ON public.ai_messages;
CREATE POLICY "Users can delete messages from their conversations" ON public.ai_messages AS PERMISSIVE FOR DELETE TO public
  USING ((EXISTS ( SELECT 1
   FROM ai_conversations
  WHERE ((ai_conversations.id = ai_messages.conversation_id) AND (ai_conversations.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can view messages from their conversations" ON public.ai_messages;
CREATE POLICY "Users can view messages from their conversations" ON public.ai_messages AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM ai_conversations
  WHERE ((ai_conversations.id = ai_messages.conversation_id) AND (ai_conversations.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can view messages in own conversations" ON public.ai_messages;
CREATE POLICY "Users can view messages in own conversations" ON public.ai_messages AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM ai_conversations
  WHERE ((ai_conversations.id = ai_messages.conversation_id) AND (ai_conversations.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Authenticated users can read personality config" ON public.ai_personality_config;
CREATE POLICY "Authenticated users can read personality config" ON public.ai_personality_config AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Service role manages personality config" ON public.ai_personality_config;
CREATE POLICY "Service role manages personality config" ON public.ai_personality_config AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users can read config audit" ON public.ai_personality_config_audit;
CREATE POLICY "Authenticated users can read config audit" ON public.ai_personality_config_audit AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Service role manages config audit" ON public.ai_personality_config_audit;
CREATE POLICY "Service role manages config audit" ON public.ai_personality_config_audit AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS ai_provider_policies_service ON public.ai_provider_policies;
CREATE POLICY ai_provider_policies_service ON public.ai_provider_policies AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can manage recommendations" ON public.ai_recommendations;
CREATE POLICY "Admins can manage recommendations" ON public.ai_recommendations AS PERMISSIVE FOR ALL TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = ai_recommendations.tenant_id) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS "Admins can manage situation analyses" ON public.ai_situation_analyses;
CREATE POLICY "Admins can manage situation analyses" ON public.ai_situation_analyses AS PERMISSIVE FOR ALL TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = ai_situation_analyses.tenant_id) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS ai_usage_log_self_read ON public.ai_usage_log;
CREATE POLICY ai_usage_log_self_read ON public.ai_usage_log AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS celebrate_select_own ON public.analytics_celebrate_events;
CREATE POLICY celebrate_select_own ON public.analytics_celebrate_events AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS celebrate_service_role_all ON public.analytics_celebrate_events;
CREATE POLICY celebrate_service_role_all ON public.analytics_celebrate_events AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS anticipatory_guidance_insert_service ON public.anticipatory_guidance;
CREATE POLICY anticipatory_guidance_insert_service ON public.anticipatory_guidance AS PERMISSIVE FOR INSERT TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS anticipatory_guidance_select_own ON public.anticipatory_guidance;
CREATE POLICY anticipatory_guidance_select_own ON public.anticipatory_guidance AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS anticipatory_guidance_service_all ON public.anticipatory_guidance;
CREATE POLICY anticipatory_guidance_service_all ON public.anticipatory_guidance AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS anticipatory_guidance_update_own ON public.anticipatory_guidance;
CREATE POLICY anticipatory_guidance_update_own ON public.anticipatory_guidance AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Admins can manage integrations" ON public.api_integrations;
CREATE POLICY "Admins can manage integrations" ON public.api_integrations AS PERMISSIVE FOR ALL TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS "Staff can view integrations" ON public.api_integrations;
CREATE POLICY "Staff can view integrations" ON public.api_integrations AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role, 'professional'::tenant_role])) AND (m.status = 'active'::text)))));

DROP POLICY IF EXISTS "Staff can view performance metrics" ON public.api_performance_metrics;
CREATE POLICY "Staff can view performance metrics" ON public.api_performance_metrics AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "System can insert performance metrics" ON public.api_performance_metrics;
CREATE POLICY "System can insert performance metrics" ON public.api_performance_metrics AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS "Staff can view test logs" ON public.api_test_logs;
CREATE POLICY "Staff can view test logs" ON public.api_test_logs AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role, 'professional'::tenant_role])) AND (m.status = 'active'::text)))));

DROP POLICY IF EXISTS "System can insert test logs" ON public.api_test_logs;
CREATE POLICY "System can insert test logs" ON public.api_test_logs AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS "Admins and staff can view test notifications" ON public.api_test_notifications;
CREATE POLICY "Admins and staff can view test notifications" ON public.api_test_notifications AS PERMISSIVE FOR SELECT TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS "System can insert test notifications" ON public.api_test_notifications;
CREATE POLICY "System can insert test notifications" ON public.api_test_notifications AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS admin_read_all_app_users ON public.app_users;
CREATE POLICY admin_read_all_app_users ON public.app_users AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS app_users_all_service_role ON public.app_users;
CREATE POLICY app_users_all_service_role ON public.app_users AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS app_users_owner_read ON public.app_users;
CREATE POLICY app_users_owner_read ON public.app_users AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS app_users_owner_write ON public.app_users;
CREATE POLICY app_users_owner_write ON public.app_users AS PERMISSIVE FOR UPDATE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS app_users_select_own ON public.app_users;
CREATE POLICY app_users_select_own ON public.app_users AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full access to architecture_reports" ON public.architecture_reports;
CREATE POLICY "Service role full access to architecture_reports" ON public.architecture_reports AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS assistant_promises_tenant_isolation ON public.assistant_promises;
CREATE POLICY assistant_promises_tenant_isolation ON public.assistant_promises AS PERMISSIVE FOR ALL TO authenticated
  USING ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))))
  WITH CHECK ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))));

DROP POLICY IF EXISTS service_role_all ON public.assistant_speech_audit;
CREATE POLICY service_role_all ON public.assistant_speech_audit AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_members_select ON public.assistant_speech_audit;
CREATE POLICY tenant_members_select ON public.assistant_speech_audit AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = ( SELECT ((users.raw_app_meta_data ->> 'active_tenant_id'::text))::uuid AS uuid
   FROM auth.users
  WHERE (users.id = auth.uid()))));

DROP POLICY IF EXISTS "Enhanced audit access for medical data" ON public.audit_events;
CREATE POLICY "Enhanced audit access for medical data" ON public.audit_events AS PERMISSIVE FOR SELECT TO public
  USING (((user_id = auth.uid()) OR ((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (m.status = 'active'::text) AND (m.tenant_id = audit_events.tenant_id))))));

DROP POLICY IF EXISTS audit_events_select_own_or_admin ON public.audit_events;
CREATE POLICY audit_events_select_own_or_admin ON public.audit_events AS PERMISSIVE FOR SELECT TO public
  USING (((user_id = auth.uid()) OR ((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true)));

DROP POLICY IF EXISTS "Admins can view all executions" ON public.automation_executions;
CREATE POLICY "Admins can view all executions" ON public.automation_executions AS PERMISSIVE FOR SELECT TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = automation_executions.tenant_id) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS "System can insert executions" ON public.automation_executions;
CREATE POLICY "System can insert executions" ON public.automation_executions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view their own executions" ON public.automation_executions;
CREATE POLICY "Users can view their own executions" ON public.automation_executions AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage their own automation rules" ON public.automation_rules;
CREATE POLICY "Users can manage their own automation rules" ON public.automation_rules AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage their own rules" ON public.automation_rules;
CREATE POLICY "Users can manage their own rules" ON public.automation_rules AS PERMISSIVE FOR ALL TO public
  USING ((((scope = 'personal'::text) AND (auth.uid() = user_id)) OR ((scope = 'global'::text) AND ((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = 'admin'::tenant_role) AND (m.status = 'active'::text))))))))
  WITH CHECK ((((scope = 'personal'::text) AND (auth.uid() = user_id)) OR ((scope = 'global'::text) AND ((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = 'admin'::tenant_role) AND (m.status = 'active'::text))))))));

DROP POLICY IF EXISTS "Service role full access on automation_runs" ON public.automation_runs;
CREATE POLICY "Service role full access on automation_runs" ON public.automation_runs AS PERMISSIVE FOR ALL TO public
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can manage action templates" ON public.autopilot_action_templates;
CREATE POLICY "Admins can manage action templates" ON public.autopilot_action_templates AS PERMISSIVE FOR ALL TO public
  USING ((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true));

DROP POLICY IF EXISTS "Anyone can view active templates" ON public.autopilot_action_templates;
CREATE POLICY "Anyone can view active templates" ON public.autopilot_action_templates AS PERMISSIVE FOR SELECT TO public
  USING ((is_active = true));

DROP POLICY IF EXISTS "Users can create their own actions" ON public.autopilot_actions;
CREATE POLICY "Users can create their own actions" ON public.autopilot_actions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete their own actions" ON public.autopilot_actions;
CREATE POLICY "Users can delete their own actions" ON public.autopilot_actions AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own actions" ON public.autopilot_actions;
CREATE POLICY "Users can update their own actions" ON public.autopilot_actions AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own actions" ON public.autopilot_actions;
CREATE POLICY "Users can view their own actions" ON public.autopilot_actions AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS autopilot_analyzer_sources_read ON public.autopilot_analyzer_sources;
CREATE POLICY autopilot_analyzer_sources_read ON public.autopilot_analyzer_sources AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS autopilot_analyzer_sources_service_role ON public.autopilot_analyzer_sources;
CREATE POLICY autopilot_analyzer_sources_service_role ON public.autopilot_analyzer_sources AS PERMISSIVE FOR ALL TO service_role
  USING (true);

DROP POLICY IF EXISTS "Users can manage their own feedback" ON public.autopilot_feedback;
CREATE POLICY "Users can manage their own feedback" ON public.autopilot_feedback AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS autopilot_logs_service_role ON public.autopilot_logs;
CREATE POLICY autopilot_logs_service_role ON public.autopilot_logs AS PERMISSIVE FOR ALL TO public
  USING ((current_setting('role'::text, true) = 'service_role'::text));

DROP POLICY IF EXISTS autopilot_logs_tenant_isolation ON public.autopilot_logs;
CREATE POLICY autopilot_logs_tenant_isolation ON public.autopilot_logs AS PERMISSIVE FOR ALL TO public
  USING ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid));

DROP POLICY IF EXISTS autopilot_loop_state_service_role ON public.autopilot_loop_state;
CREATE POLICY autopilot_loop_state_service_role ON public.autopilot_loop_state AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS autopilot_processed_events_service_role ON public.autopilot_processed_events;
CREATE POLICY autopilot_processed_events_service_role ON public.autopilot_processed_events AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS autopilot_recommendation_runs_read ON public.autopilot_recommendation_runs;
CREATE POLICY autopilot_recommendation_runs_read ON public.autopilot_recommendation_runs AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS autopilot_recommendation_runs_service_role ON public.autopilot_recommendation_runs;
CREATE POLICY autopilot_recommendation_runs_service_role ON public.autopilot_recommendation_runs AS PERMISSIVE FOR ALL TO service_role
  USING (true);

DROP POLICY IF EXISTS autopilot_recommendations_service_role ON public.autopilot_recommendations;
CREATE POLICY autopilot_recommendations_service_role ON public.autopilot_recommendations AS PERMISSIVE FOR ALL TO service_role
  USING (true);

DROP POLICY IF EXISTS autopilot_recommendations_user_policy ON public.autopilot_recommendations;
CREATE POLICY autopilot_recommendations_user_policy ON public.autopilot_recommendations AS PERMISSIVE FOR SELECT TO public
  USING (((user_id IS NULL) OR (user_id = auth.uid())));

DROP POLICY IF EXISTS autopilot_run_state_service_role ON public.autopilot_run_state;
CREATE POLICY autopilot_run_state_service_role ON public.autopilot_run_state AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS biomarker_results_delete ON public.biomarker_results;
CREATE POLICY biomarker_results_delete ON public.biomarker_results AS PERMISSIVE FOR DELETE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS biomarker_results_insert ON public.biomarker_results;
CREATE POLICY biomarker_results_insert ON public.biomarker_results AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS biomarker_results_select ON public.biomarker_results;
CREATE POLICY biomarker_results_select ON public.biomarker_results AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS biomarker_results_update ON public.biomarker_results;
CREATE POLICY biomarker_results_update ON public.biomarker_results AS PERMISSIVE FOR UPDATE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS biometric_events_tenant_user_select ON public.biometric_events;
CREATE POLICY biometric_events_tenant_user_select ON public.biometric_events AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS biometric_trends_tenant_user_select ON public.biometric_trends;
CREATE POLICY biometric_trends_tenant_user_select ON public.biometric_trends AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS "Users can delete their own bookmarks" ON public.bookmarked_items;
CREATE POLICY "Users can delete their own bookmarks" ON public.bookmarked_items AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can insert their own bookmarks" ON public.bookmarked_items;
CREATE POLICY "Users can insert their own bookmarks" ON public.bookmarked_items AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own bookmarks" ON public.bookmarked_items;
CREATE POLICY "Users can view their own bookmarks" ON public.bookmarked_items AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS business_identity_staff_rw ON public.business_identity;
CREATE POLICY business_identity_staff_rw ON public.business_identity AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])))
  WITH CHECK ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS "Users can create packages in their tenant" ON public.business_packages;
CREATE POLICY "Users can create packages in their tenant" ON public.business_packages AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((auth.uid() = creator_id) AND (tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can delete their own packages" ON public.business_packages;
CREATE POLICY "Users can delete their own packages" ON public.business_packages AS PERMISSIVE FOR DELETE TO public
  USING (((auth.uid() = creator_id) AND (tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can update their own packages" ON public.business_packages;
CREATE POLICY "Users can update their own packages" ON public.business_packages AS PERMISSIVE FOR UPDATE TO public
  USING (((auth.uid() = creator_id) AND (tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can view packages in their tenant" ON public.business_packages;
CREATE POLICY "Users can view packages in their tenant" ON public.business_packages AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text)))) AND ((status = 'published'::text) OR (creator_id = auth.uid()))));

DROP POLICY IF EXISTS "Users can manage their own calendar events" ON public.calendar_events;
CREATE POLICY "Users can manage their own calendar events" ON public.calendar_events AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Message senders can view all responses to their messages" ON public.calendar_invite_responses;
CREATE POLICY "Message senders can view all responses to their messages" ON public.calendar_invite_responses AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM messages m
  WHERE ((m.id = calendar_invite_responses.message_id) AND (m.sender_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM global_messages gm
  WHERE ((gm.id = calendar_invite_responses.message_id) AND (gm.sender_id = auth.uid()))))));

DROP POLICY IF EXISTS "Users can manage their own invite responses" ON public.calendar_invite_responses;
CREATE POLICY "Users can manage their own invite responses" ON public.calendar_invite_responses AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage their own audience segments" ON public.campaign_audience_segments;
CREATE POLICY "Users can manage their own audience segments" ON public.campaign_audience_segments AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage posts in their campaigns" ON public.campaign_posts;
CREATE POLICY "Users can manage posts in their campaigns" ON public.campaign_posts AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM campaigns
  WHERE ((campaigns.id = campaign_posts.campaign_id) AND (campaigns.user_id = auth.uid())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM campaigns
  WHERE ((campaigns.id = campaign_posts.campaign_id) AND (campaigns.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can insert recipients for their campaigns" ON public.campaign_recipients;
CREATE POLICY "Users can insert recipients for their campaigns" ON public.campaign_recipients AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM campaigns
  WHERE ((campaigns.id = campaign_recipients.campaign_id) AND (campaigns.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can update recipients for their campaigns" ON public.campaign_recipients;
CREATE POLICY "Users can update recipients for their campaigns" ON public.campaign_recipients AS PERMISSIVE FOR UPDATE TO public
  USING ((EXISTS ( SELECT 1
   FROM campaigns
  WHERE ((campaigns.id = campaign_recipients.campaign_id) AND (campaigns.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can view recipients for their campaigns" ON public.campaign_recipients;
CREATE POLICY "Users can view recipients for their campaigns" ON public.campaign_recipients AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM campaigns
  WHERE ((campaigns.id = campaign_recipients.campaign_id) AND (campaigns.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can manage their own campaigns" ON public.campaigns;
CREATE POLICY "Users can manage their own campaigns" ON public.campaigns AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS canonical_fact_key_review_service ON public.canonical_fact_key_review_queue;
CREATE POLICY canonical_fact_key_review_service ON public.canonical_fact_key_review_queue AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS canonical_fact_keys_select ON public.canonical_fact_keys;
CREATE POLICY canonical_fact_keys_select ON public.canonical_fact_keys AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS canonical_fact_keys_service ON public.canonical_fact_keys;
CREATE POLICY canonical_fact_keys_service ON public.canonical_fact_keys AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS capability_awareness_events_tenant_isolation ON public.capability_awareness_events;
CREATE POLICY capability_awareness_events_tenant_isolation ON public.capability_awareness_events AS PERMISSIVE FOR ALL TO authenticated
  USING ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))))
  WITH CHECK ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))));

DROP POLICY IF EXISTS cpl_owner_read ON public.capability_play_log;
CREATE POLICY cpl_owner_read ON public.capability_play_log AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS cpl_service_role ON public.capability_play_log;
CREATE POLICY cpl_service_role ON public.capability_play_log AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS capacity_overrides_insert ON public.capacity_overrides;
CREATE POLICY capacity_overrides_insert ON public.capacity_overrides AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS capacity_overrides_select ON public.capacity_overrides;
CREATE POLICY capacity_overrides_select ON public.capacity_overrides AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS capacity_overrides_update ON public.capacity_overrides;
CREATE POLICY capacity_overrides_update ON public.capacity_overrides AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS capacity_rules_select ON public.capacity_rules;
CREATE POLICY capacity_rules_select ON public.capacity_rules AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS capacity_state_insert ON public.capacity_state;
CREATE POLICY capacity_state_insert ON public.capacity_state AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS capacity_state_select ON public.capacity_state;
CREATE POLICY capacity_state_select ON public.capacity_state AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS capacity_state_update ON public.capacity_state;
CREATE POLICY capacity_state_update ON public.capacity_state AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS "Users can manage their own cart items" ON public.cart_items;
CREATE POLICY "Users can manage their own cart items" ON public.cart_items AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS cart_order_owner_rw ON public.cart_order;
CREATE POLICY cart_order_owner_rw ON public.cart_order AS PERMISSIVE FOR ALL TO public
  USING (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (user_id = vcaop_uid())))
  WITH CHECK (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (user_id = vcaop_uid())));

DROP POLICY IF EXISTS catalog_sources_service ON public.catalog_sources;
CREATE POLICY catalog_sources_service ON public.catalog_sources AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS catalog_vocabulary_select ON public.catalog_vocabulary;
CREATE POLICY catalog_vocabulary_select ON public.catalog_vocabulary AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS catalog_vocabulary_service ON public.catalog_vocabulary;
CREATE POLICY catalog_vocabulary_service ON public.catalog_vocabulary AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS catalog_vocabulary_synonyms_select ON public.catalog_vocabulary_synonyms;
CREATE POLICY catalog_vocabulary_synonyms_select ON public.catalog_vocabulary_synonyms AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS catalog_vocabulary_synonyms_service ON public.catalog_vocabulary_synonyms;
CREATE POLICY catalog_vocabulary_synonyms_service ON public.catalog_vocabulary_synonyms AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS chat_group_members_read ON public.chat_group_members;
CREATE POLICY chat_group_members_read ON public.chat_group_members AS PERMISSIVE FOR SELECT TO public
  USING (is_chat_group_member(group_id, auth.uid()));

DROP POLICY IF EXISTS chat_groups_member_read ON public.chat_groups;
CREATE POLICY chat_groups_member_read ON public.chat_groups AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM chat_group_members m
  WHERE ((m.group_id = chat_groups.id) AND (m.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can create reply links for messages they sent" ON public.chat_message_replies;
CREATE POLICY "Users can create reply links for messages they sent" ON public.chat_message_replies AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((created_by = auth.uid()));

DROP POLICY IF EXISTS "Users can view reply links for their messages" ON public.chat_message_replies;
CREATE POLICY "Users can view reply links for their messages" ON public.chat_message_replies AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM chat_messages cm
  WHERE ((cm.id = chat_message_replies.message_id) AND ((cm.sender_id = auth.uid()) OR (cm.receiver_id = auth.uid()))))));

DROP POLICY IF EXISTS "Senders can delete own chat_messages" ON public.chat_messages;
CREATE POLICY "Senders can delete own chat_messages" ON public.chat_messages AS PERMISSIVE FOR DELETE TO authenticated
  USING ((sender_id = auth.uid()));

DROP POLICY IF EXISTS "Senders can update own chat_messages" ON public.chat_messages;
CREATE POLICY "Senders can update own chat_messages" ON public.chat_messages AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((sender_id = auth.uid()))
  WITH CHECK ((sender_id = auth.uid()));

DROP POLICY IF EXISTS "Users can insert own chat_messages" ON public.chat_messages;
CREATE POLICY "Users can insert own chat_messages" ON public.chat_messages AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((sender_id = auth.uid()));

DROP POLICY IF EXISTS "Users can read own chat_messages" ON public.chat_messages;
CREATE POLICY "Users can read own chat_messages" ON public.chat_messages AS PERMISSIVE FOR SELECT TO authenticated
  USING (((sender_id = auth.uid()) OR (receiver_id = auth.uid())));

DROP POLICY IF EXISTS users_mark_received_read ON public.chat_messages;
CREATE POLICY users_mark_received_read ON public.chat_messages AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = receiver_id))
  WITH CHECK ((auth.uid() = receiver_id));

DROP POLICY IF EXISTS users_read_group_messages ON public.chat_messages;
CREATE POLICY users_read_group_messages ON public.chat_messages AS PERMISSIVE FOR SELECT TO public
  USING (((group_id IS NOT NULL) AND is_chat_group_member(group_id, auth.uid())));

DROP POLICY IF EXISTS users_read_own_messages ON public.chat_messages;
CREATE POLICY users_read_own_messages ON public.chat_messages AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = sender_id) OR (auth.uid() = receiver_id)));

DROP POLICY IF EXISTS users_send_group_messages ON public.chat_messages;
CREATE POLICY users_send_group_messages ON public.chat_messages AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((group_id IS NOT NULL) AND (auth.uid() = sender_id) AND is_chat_group_member(group_id, auth.uid())));

DROP POLICY IF EXISTS users_send_messages ON public.chat_messages;
CREATE POLICY users_send_messages ON public.chat_messages AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = sender_id));

DROP POLICY IF EXISTS "Users can create their own checkout sessions" ON public.checkout_sessions;
CREATE POLICY "Users can create their own checkout sessions" ON public.checkout_sessions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own checkout sessions" ON public.checkout_sessions;
CREATE POLICY "Users can view their own checkout sessions" ON public.checkout_sessions AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can create their own CJ orders" ON public.cj_orders;
CREATE POLICY "Users can create their own CJ orders" ON public.cj_orders AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own CJ orders" ON public.cj_orders;
CREATE POLICY "Users can view their own CJ orders" ON public.cj_orders AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Anyone can view active CJ products" ON public.cj_products;
CREATE POLICY "Anyone can view active CJ products" ON public.cj_products AS PERMISSIVE FOR SELECT TO public
  USING ((is_active = true));

DROP POLICY IF EXISTS "Only admins can view webhook logs" ON public.cj_webhook_logs;
CREATE POLICY "Only admins can view webhook logs" ON public.cj_webhook_logs AS PERMISSIVE FOR SELECT TO public
  USING ((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true));

DROP POLICY IF EXISTS commission_event_staff_rw ON public.commission_event;
CREATE POLICY commission_event_staff_rw ON public.commission_event AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])))
  WITH CHECK ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS users_respond_to_invitations ON public.community_group_invitations;
CREATE POLICY users_respond_to_invitations ON public.community_group_invitations AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = invited_user_id));

DROP POLICY IF EXISTS users_see_own_invitations ON public.community_group_invitations;
CREATE POLICY users_see_own_invitations ON public.community_group_invitations AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = invited_by) OR (auth.uid() = invited_user_id)));

DROP POLICY IF EXISTS users_send_invitations ON public.community_group_invitations;
CREATE POLICY users_send_invitations ON public.community_group_invitations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = invited_by));

DROP POLICY IF EXISTS community_groups_delete ON public.community_groups;
CREATE POLICY community_groups_delete ON public.community_groups AS PERMISSIVE FOR DELETE TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS community_groups_insert ON public.community_groups;
CREATE POLICY community_groups_insert ON public.community_groups AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS community_groups_select ON public.community_groups;
CREATE POLICY community_groups_select ON public.community_groups AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND ((is_public = true) OR (EXISTS ( SELECT 1
   FROM community_memberships cm
  WHERE ((cm.group_id = community_groups.id) AND (cm.user_id = auth.uid()) AND (cm.status = 'active'::text)))))));

DROP POLICY IF EXISTS community_groups_update ON public.community_groups;
CREATE POLICY community_groups_update ON public.community_groups AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS clc_select ON public.community_listing_categories;
CREATE POLICY clc_select ON public.community_listing_categories AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS clc_service ON public.community_listing_categories;
CREATE POLICY clc_service ON public.community_listing_categories AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS clr_insert_own ON public.community_listing_reports;
CREATE POLICY clr_insert_own ON public.community_listing_reports AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((reporter_user_id = auth.uid()));

DROP POLICY IF EXISTS clr_select_own ON public.community_listing_reports;
CREATE POLICY clr_select_own ON public.community_listing_reports AS PERMISSIVE FOR SELECT TO authenticated
  USING ((reporter_user_id = auth.uid()));

DROP POLICY IF EXISTS clr_service ON public.community_listing_reports;
CREATE POLICY clr_service ON public.community_listing_reports AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS clsb_own ON public.community_listing_seller_blocks;
CREATE POLICY clsb_own ON public.community_listing_seller_blocks AS PERMISSIVE FOR ALL TO authenticated
  USING ((viewer_user_id = auth.uid()))
  WITH CHECK ((viewer_user_id = auth.uid()));

DROP POLICY IF EXISTS clsb_service ON public.community_listing_seller_blocks;
CREATE POLICY clsb_service ON public.community_listing_seller_blocks AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS community_listings_insert_own ON public.community_listings;
CREATE POLICY community_listings_insert_own ON public.community_listings AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((seller_user_id = auth.uid()));

DROP POLICY IF EXISTS community_listings_select_own ON public.community_listings;
CREATE POLICY community_listings_select_own ON public.community_listings AS PERMISSIVE FOR SELECT TO authenticated
  USING ((seller_user_id = auth.uid()));

DROP POLICY IF EXISTS community_listings_select_public ON public.community_listings;
CREATE POLICY community_listings_select_public ON public.community_listings AS PERMISSIVE FOR SELECT TO authenticated
  USING (((status = ANY (ARRAY['active'::text, 'paused'::text, 'sold'::text])) AND (tenant_id = current_tenant_id())));

DROP POLICY IF EXISTS community_listings_service ON public.community_listings;
CREATE POLICY community_listings_service ON public.community_listings AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS community_listings_update_own ON public.community_listings;
CREATE POLICY community_listings_update_own ON public.community_listings AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((seller_user_id = auth.uid()))
  WITH CHECK ((seller_user_id = auth.uid()));

DROP POLICY IF EXISTS "Anyone can view public live streams" ON public.community_live_streams;
CREATE POLICY "Anyone can view public live streams" ON public.community_live_streams AS PERMISSIVE FOR SELECT TO public
  USING (((status = ANY (ARRAY['pending'::text, 'live'::text])) OR ((status = 'ended'::text) AND (enable_replay = true))));

DROP POLICY IF EXISTS "Users can create their own streams" ON public.community_live_streams;
CREATE POLICY "Users can create their own streams" ON public.community_live_streams AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = created_by));

DROP POLICY IF EXISTS "Users can delete their own streams" ON public.community_live_streams;
CREATE POLICY "Users can delete their own streams" ON public.community_live_streams AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = created_by));

DROP POLICY IF EXISTS "Users can update their own streams" ON public.community_live_streams;
CREATE POLICY "Users can update their own streams" ON public.community_live_streams AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = created_by));

DROP POLICY IF EXISTS community_meetups_delete ON public.community_meetups;
CREATE POLICY community_meetups_delete ON public.community_meetups AS PERMISSIVE FOR DELETE TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS community_meetups_insert ON public.community_meetups;
CREATE POLICY community_meetups_insert ON public.community_meetups AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS community_meetups_select ON public.community_meetups;
CREATE POLICY community_meetups_select ON public.community_meetups AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM community_groups g
  WHERE ((g.id = community_meetups.group_id) AND ((g.is_public = true) OR (EXISTS ( SELECT 1
           FROM community_memberships cm
          WHERE ((cm.group_id = g.id) AND (cm.user_id = auth.uid()) AND (cm.status = 'active'::text))))))))));

DROP POLICY IF EXISTS community_meetups_update ON public.community_meetups;
CREATE POLICY community_meetups_update ON public.community_meetups AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS community_memberships_delete ON public.community_memberships;
CREATE POLICY community_memberships_delete ON public.community_memberships AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS community_memberships_insert ON public.community_memberships;
CREATE POLICY community_memberships_insert ON public.community_memberships AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS community_memberships_select ON public.community_memberships;
CREATE POLICY community_memberships_select ON public.community_memberships AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS community_memberships_update ON public.community_memberships;
CREATE POLICY community_memberships_update ON public.community_memberships AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS community_recommendations_delete ON public.community_recommendations;
CREATE POLICY community_recommendations_delete ON public.community_recommendations AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS community_recommendations_insert ON public.community_recommendations;
CREATE POLICY community_recommendations_insert ON public.community_recommendations AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS community_recommendations_select ON public.community_recommendations;
CREATE POLICY community_recommendations_select ON public.community_recommendations AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS community_recommendations_update ON public.community_recommendations;
CREATE POLICY community_recommendations_update ON public.community_recommendations AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS community_search_history_self_read ON public.community_search_history;
CREATE POLICY community_search_history_self_read ON public.community_search_history AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = viewer_user_id));

DROP POLICY IF EXISTS condition_mappings_select ON public.condition_product_mappings;
CREATE POLICY condition_mappings_select ON public.condition_product_mappings AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS condition_mappings_service ON public.condition_product_mappings;
CREATE POLICY condition_mappings_service ON public.condition_product_mappings AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Recipients can update connection requests" ON public.connection_requests;
CREATE POLICY "Recipients can update connection requests" ON public.connection_requests AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = to_user_id));

DROP POLICY IF EXISTS "Users can create connection requests" ON public.connection_requests;
CREATE POLICY "Users can create connection requests" ON public.connection_requests AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = from_user_id));

DROP POLICY IF EXISTS "Users can view connection requests they sent or received" ON public.connection_requests;
CREATE POLICY "Users can view connection requests they sent or received" ON public.connection_requests AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = from_user_id) OR (auth.uid() = to_user_id)));

DROP POLICY IF EXISTS connector_registry_select ON public.connector_registry;
CREATE POLICY connector_registry_select ON public.connector_registry AS PERMISSIVE FOR SELECT TO authenticated
  USING ((enabled = true));

DROP POLICY IF EXISTS connector_registry_service ON public.connector_registry;
CREATE POLICY connector_registry_service ON public.connector_registry AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS connector_webhooks_log_service ON public.connector_webhooks_log;
CREATE POLICY connector_webhooks_log_service ON public.connector_webhooks_log AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS consents_admin_read ON public.consents;
CREATE POLICY consents_admin_read ON public.consents AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND is_platform_admin()));

DROP POLICY IF EXISTS consents_owner_read ON public.consents;
CREATE POLICY consents_owner_read ON public.consents AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS "Users can delete their own contacts" ON public.contacts;
CREATE POLICY "Users can delete their own contacts" ON public.contacts AS PERMISSIVE FOR DELETE TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can insert their own contacts" ON public.contacts;
CREATE POLICY "Users can insert their own contacts" ON public.contacts AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own contacts" ON public.contacts;
CREATE POLICY "Users can update their own contacts" ON public.contacts AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own contacts" ON public.contacts;
CREATE POLICY "Users can view their own contacts" ON public.contacts AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS content_i18n_read ON public.content_i18n;
CREATE POLICY content_i18n_read ON public.content_i18n AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS service_all ON public.content_items;
CREATE POLICY service_all ON public.content_items AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_read ON public.content_items;
CREATE POLICY tenant_read ON public.content_items AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = ( SELECT ((users.raw_app_meta_data ->> 'active_tenant_id'::text))::uuid AS uuid
   FROM auth.users
  WHERE (users.id = auth.uid()))) AND ((moderation_status = 'approved'::text) OR (submitted_by = auth.uid()))));

DROP POLICY IF EXISTS user_insert ON public.content_items;
CREATE POLICY user_insert ON public.content_items AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((tenant_id = ( SELECT ((users.raw_app_meta_data ->> 'active_tenant_id'::text))::uuid AS uuid
   FROM auth.users
  WHERE (users.id = auth.uid()))));

DROP POLICY IF EXISTS "Staff and admins can update reports" ON public.content_reports;
CREATE POLICY "Staff and admins can update reports" ON public.content_reports AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Staff and admins can view all reports" ON public.content_reports;
CREATE POLICY "Staff and admins can view all reports" ON public.content_reports AS PERMISSIVE FOR SELECT TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Users can create content reports" ON public.content_reports;
CREATE POLICY "Users can create content reports" ON public.content_reports AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = reporter_user_id));

DROP POLICY IF EXISTS "Service role full access on contextual_opportunities" ON public.contextual_opportunities;
CREATE POLICY "Service role full access on contextual_opportunities" ON public.contextual_opportunities AS PERMISSIVE FOR ALL TO public
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users manage own contextual opportunities" ON public.contextual_opportunities;
CREATE POLICY "Users manage own contextual opportunities" ON public.contextual_opportunities AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS contradiction_owner_admin_read ON public.contradiction_flags;
CREATE POLICY contradiction_owner_admin_read ON public.contradiction_flags AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND ((user_id = auth.uid()) OR is_platform_admin())));

DROP POLICY IF EXISTS conversation_messages_user_insert ON public.conversation_messages;
CREATE POLICY conversation_messages_user_insert ON public.conversation_messages AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS conversation_messages_user_select ON public.conversation_messages;
CREATE POLICY conversation_messages_user_select ON public.conversation_messages AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS credit_packs_read_active ON public.credit_packs;
CREATE POLICY credit_packs_read_active ON public.credit_packs AS PERMISSIVE FOR SELECT TO anon, authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS credit_packs_svc_full ON public.credit_packs;
CREATE POLICY credit_packs_svc_full ON public.credit_packs AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS crew_memory_select_any ON public.crew_memory;
CREATE POLICY crew_memory_select_any ON public.crew_memory AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS "Users can insert their own crewai tasks" ON public.crewai_test;
CREATE POLICY "Users can insert their own crewai tasks" ON public.crewai_test AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view crewai tasks" ON public.crewai_test;
CREATE POLICY "Users can view crewai tasks" ON public.crewai_test AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS curated_memories_insert_owner ON public.curated_memories;
CREATE POLICY curated_memories_insert_owner ON public.curated_memories AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = current_tenant_id()) AND ((user_id = auth.uid()) OR is_platform_admin())));

DROP POLICY IF EXISTS curated_memories_read ON public.curated_memories;
CREATE POLICY curated_memories_read ON public.curated_memories AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND ((user_id = auth.uid()) OR is_platform_admin() OR ((cardinality(allowed_roles) > 0) AND (current_active_role() = ANY (allowed_roles)) AND ((scope <> 'RELATIONSHIP'::memory_scope) OR (has_active_relationship('user'::text, auth.uid(), 'user'::text, user_id, 'care_relationship'::text) AND ((sensitivity = ANY (ARRAY['general'::memory_sensitivity, 'private'::memory_sensitivity])) OR has_active_consent(user_id, (sensitivity)::text, 'user'::text, (auth.uid())::text))))))));

DROP POLICY IF EXISTS curated_memories_update_owner ON public.curated_memories;
CREATE POLICY curated_memories_update_owner ON public.curated_memories AS PERMISSIVE FOR UPDATE TO public
  USING (((tenant_id = current_tenant_id()) AND ((user_id = auth.uid()) OR is_platform_admin())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND ((user_id = auth.uid()) OR is_platform_admin())));

DROP POLICY IF EXISTS d42_domain_weights_select ON public.d42_domain_weights;
CREATE POLICY d42_domain_weights_select ON public.d42_domain_weights AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) OR (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid)));

DROP POLICY IF EXISTS d42_fusion_audit_insert ON public.d42_fusion_audit;
CREATE POLICY d42_fusion_audit_insert ON public.d42_fusion_audit AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS d42_fusion_audit_select ON public.d42_fusion_audit;
CREATE POLICY d42_fusion_audit_select ON public.d42_fusion_audit AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS d42_priority_cache_delete ON public.d42_priority_cache;
CREATE POLICY d42_priority_cache_delete ON public.d42_priority_cache AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS d42_priority_cache_insert ON public.d42_priority_cache;
CREATE POLICY d42_priority_cache_insert ON public.d42_priority_cache AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS d42_priority_cache_select ON public.d42_priority_cache;
CREATE POLICY d42_priority_cache_select ON public.d42_priority_cache AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS d42_priority_cache_update ON public.d42_priority_cache;
CREATE POLICY d42_priority_cache_update ON public.d42_priority_cache AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS "Users can update their own match actions" ON public.daily_matches;
CREATE POLICY "Users can update their own match actions" ON public.daily_matches AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own daily matches" ON public.daily_matches;
CREATE POLICY "Users can view their own daily matches" ON public.daily_matches AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS daily_recompute_runs_service_policy ON public.daily_recompute_runs;
CREATE POLICY daily_recompute_runs_service_policy ON public.daily_recompute_runs AS PERMISSIVE FOR ALL TO public
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS decision_compatibility_score_tenant_read ON public.decision_compatibility_score;
CREATE POLICY decision_compatibility_score_tenant_read ON public.decision_compatibility_score AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id IS NULL) OR (tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid())))));

DROP POLICY IF EXISTS decision_conflict_pair_tenant_read ON public.decision_conflict_pair;
CREATE POLICY decision_conflict_pair_tenant_read ON public.decision_conflict_pair AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id IS NULL) OR (tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid())))));

DROP POLICY IF EXISTS decision_policy_tenant_read ON public.decision_policy;
CREATE POLICY decision_policy_tenant_read ON public.decision_policy AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id IS NULL) OR (tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid())))));

DROP POLICY IF EXISTS default_feed_config_select ON public.default_feed_config;
CREATE POLICY default_feed_config_select ON public.default_feed_config AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS default_feed_config_service ON public.default_feed_config;
CREATE POLICY default_feed_config_service ON public.default_feed_config AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS dev_autopilot_config_service ON public.dev_autopilot_config;
CREATE POLICY dev_autopilot_config_service ON public.dev_autopilot_config AS PERMISSIVE FOR ALL TO service_role
  USING (true);

DROP POLICY IF EXISTS dev_autopilot_executions_service ON public.dev_autopilot_executions;
CREATE POLICY dev_autopilot_executions_service ON public.dev_autopilot_executions AS PERMISSIVE FOR ALL TO service_role
  USING (true);

DROP POLICY IF EXISTS dev_autopilot_outcomes_authenticated_read ON public.dev_autopilot_outcomes;
CREATE POLICY dev_autopilot_outcomes_authenticated_read ON public.dev_autopilot_outcomes AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS dev_autopilot_outcomes_service_role ON public.dev_autopilot_outcomes;
CREATE POLICY dev_autopilot_outcomes_service_role ON public.dev_autopilot_outcomes AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS dev_autopilot_plan_versions_service ON public.dev_autopilot_plan_versions;
CREATE POLICY dev_autopilot_plan_versions_service ON public.dev_autopilot_plan_versions AS PERMISSIVE FOR ALL TO service_role
  USING (true);

DROP POLICY IF EXISTS dev_autopilot_runs_service ON public.dev_autopilot_runs;
CREATE POLICY dev_autopilot_runs_service ON public.dev_autopilot_runs AS PERMISSIVE FOR ALL TO service_role
  USING (true);

DROP POLICY IF EXISTS dev_autopilot_signals_service ON public.dev_autopilot_signals;
CREATE POLICY dev_autopilot_signals_service ON public.dev_autopilot_signals AS PERMISSIVE FOR ALL TO service_role
  USING (true);

DROP POLICY IF EXISTS "Users can create their own diary entries" ON public.diary_entries;
CREATE POLICY "Users can create their own diary entries" ON public.diary_entries AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete their own diary entries" ON public.diary_entries;
CREATE POLICY "Users can delete their own diary entries" ON public.diary_entries AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own diary entries" ON public.diary_entries;
CREATE POLICY "Users can update their own diary entries" ON public.diary_entries AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own diary entries" ON public.diary_entries;
CREATE POLICY "Users can view their own diary entries" ON public.diary_entries AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS did_you_know_state_service_role_all ON public.did_you_know_state;
CREATE POLICY did_you_know_state_service_role_all ON public.did_you_know_state AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS disclosure_owner_rw ON public.disclosure;
CREATE POLICY disclosure_owner_rw ON public.disclosure AS PERMISSIVE FOR ALL TO public
  USING (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (EXISTS ( SELECT 1
   FROM cart_order c
  WHERE ((c.id = disclosure.cart_order_id) AND (c.user_id = vcaop_uid()))))))
  WITH CHECK (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (EXISTS ( SELECT 1
   FROM cart_order c
  WHERE ((c.id = disclosure.cart_order_id) AND (c.user_id = vcaop_uid()))))));

DROP POLICY IF EXISTS "Users can manage their own channels" ON public.distribution_channels;
CREATE POLICY "Users can manage their own channels" ON public.distribution_channels AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage their own posts" ON public.distribution_posts;
CREATE POLICY "Users can manage their own posts" ON public.distribution_posts AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS drift_plans_self ON public.drift_adaptation_plans;
CREATE POLICY drift_plans_self ON public.drift_adaptation_plans AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS emotional_cognitive_rules_select ON public.emotional_cognitive_rules;
CREATE POLICY emotional_cognitive_rules_select ON public.emotional_cognitive_rules AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS emotional_cognitive_signals_insert ON public.emotional_cognitive_signals;
CREATE POLICY emotional_cognitive_signals_insert ON public.emotional_cognitive_signals AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS emotional_cognitive_signals_select ON public.emotional_cognitive_signals;
CREATE POLICY emotional_cognitive_signals_select ON public.emotional_cognitive_signals AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS emotional_cognitive_signals_update ON public.emotional_cognitive_signals;
CREATE POLICY emotional_cognitive_signals_update ON public.emotional_cognitive_signals AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS relationships_user_read ON public.entity_relationships;
CREATE POLICY relationships_user_read ON public.entity_relationships AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (((subject_type = 'user'::text) AND (subject_id = auth.uid())) OR ((object_type = 'user'::text) AND (object_id = auth.uid())) OR is_platform_admin())));

DROP POLICY IF EXISTS event_attendance_insert ON public.event_attendance;
CREATE POLICY event_attendance_insert ON public.event_attendance AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS event_attendance_select ON public.event_attendance;
CREATE POLICY event_attendance_select ON public.event_attendance AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS event_attendance_service_role ON public.event_attendance;
CREATE POLICY event_attendance_service_role ON public.event_attendance AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS event_attendance_update ON public.event_attendance;
CREATE POLICY event_attendance_update ON public.event_attendance AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS "Attendees can update their own response" ON public.event_attendees;
CREATE POLICY "Attendees can update their own response" ON public.event_attendees AS PERMISSIVE FOR UPDATE TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can create attendee records" ON public.event_attendees;
CREATE POLICY "Users can create attendee records" ON public.event_attendees AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((invited_by = auth.uid()));

DROP POLICY IF EXISTS "Users can view attendees for their events" ON public.event_attendees;
CREATE POLICY "Users can view attendees for their events" ON public.event_attendees AS PERMISSIVE FOR SELECT TO public
  USING (((invited_by = auth.uid()) OR (user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM calendar_events ce
  WHERE ((ce.id = event_attendees.event_id) AND (ce.user_id = auth.uid()))))));

DROP POLICY IF EXISTS "Event creators can add co-creators" ON public.event_co_creators;
CREATE POLICY "Event creators can add co-creators" ON public.event_co_creators AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM global_community_events gce
  WHERE ((gce.id = event_co_creators.event_id) AND (gce.created_by = auth.uid())))));

DROP POLICY IF EXISTS "Event creators can remove co-creators" ON public.event_co_creators;
CREATE POLICY "Event creators can remove co-creators" ON public.event_co_creators AS PERMISSIVE FOR DELETE TO public
  USING ((EXISTS ( SELECT 1
   FROM global_community_events gce
  WHERE ((gce.id = event_co_creators.event_id) AND (gce.created_by = auth.uid())))));

DROP POLICY IF EXISTS "Users can view events they co-create" ON public.event_co_creators;
CREATE POLICY "Users can view events they co-create" ON public.event_co_creators AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS event_kinds_authenticated_select ON public.event_kinds;
CREATE POLICY event_kinds_authenticated_select ON public.event_kinds AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS event_kinds_service_role_all ON public.event_kinds;
CREATE POLICY event_kinds_service_role_all ON public.event_kinds AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "System can insert event recommendations" ON public.event_recommendations;
CREATE POLICY "System can insert event recommendations" ON public.event_recommendations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can dismiss their own event recommendations" ON public.event_recommendations;
CREATE POLICY "Users can dismiss their own event recommendations" ON public.event_recommendations AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own event recommendations" ON public.event_recommendations;
CREATE POLICY "Users can view their own event recommendations" ON public.event_recommendations AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Buyers can view their own purchases" ON public.event_ticket_purchases;
CREATE POLICY "Buyers can view their own purchases" ON public.event_ticket_purchases AS PERMISSIVE FOR SELECT TO public
  USING ((buyer_id = auth.uid()));

DROP POLICY IF EXISTS "Event organizers can view all purchases for their events" ON public.event_ticket_purchases;
CREATE POLICY "Event organizers can view all purchases for their events" ON public.event_ticket_purchases AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM global_community_events e
  WHERE ((e.id = event_ticket_purchases.event_id) AND (e.created_by = auth.uid())))));

DROP POLICY IF EXISTS "Event organizers can manage scans" ON public.event_ticket_scans;
CREATE POLICY "Event organizers can manage scans" ON public.event_ticket_scans AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM (event_ticket_purchases p
     JOIN global_community_events e ON ((e.id = p.event_id)))
  WHERE ((p.id = event_ticket_scans.ticket_purchase_id) AND (e.created_by = auth.uid())))));

DROP POLICY IF EXISTS "Anyone can view active ticket types" ON public.event_ticket_types;
CREATE POLICY "Anyone can view active ticket types" ON public.event_ticket_types AS PERMISSIVE FOR SELECT TO public
  USING ((is_active = true));

DROP POLICY IF EXISTS "Event creators can manage ticket types" ON public.event_ticket_types;
CREATE POLICY "Event creators can manage ticket types" ON public.event_ticket_types AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM global_community_events e
  WHERE ((e.id = event_ticket_types.event_id) AND (e.created_by = auth.uid())))));

DROP POLICY IF EXISTS events_authenticated_select ON public.events;
CREATE POLICY events_authenticated_select ON public.events AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS events_service_role_all ON public.events;
CREATE POLICY events_service_role_all ON public.events AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can view active exchange rates" ON public.exchange_rates;
CREATE POLICY "Anyone can view active exchange rates" ON public.exchange_rates AS PERMISSIVE FOR SELECT TO public
  USING ((is_active = true));

DROP POLICY IF EXISTS feature_announcements_select_own_tenant ON public.feature_announcements;
CREATE POLICY feature_announcements_select_own_tenant ON public.feature_announcements AS PERMISSIVE FOR SELECT TO authenticated
  USING (((is_active = true) AND (EXISTS ( SELECT 1
   FROM user_tenants ut
  WHERE ((ut.tenant_id = feature_announcements.tenant_id) AND (ut.user_id = auth.uid())))) AND ((target_user_ids IS NULL) OR (auth.uid() = ANY (target_user_ids)))));

DROP POLICY IF EXISTS feature_announcements_service_role_all ON public.feature_announcements;
CREATE POLICY feature_announcements_service_role_all ON public.feature_announcements AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS feature_entitlements_read_all ON public.feature_entitlements;
CREATE POLICY feature_entitlements_read_all ON public.feature_entitlements AS PERMISSIVE FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS feature_entitlements_svc_full ON public.feature_entitlements;
CREATE POLICY feature_entitlements_svc_full ON public.feature_entitlements AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS feature_usage_read_own ON public.feature_usage;
CREATE POLICY feature_usage_read_own ON public.feature_usage AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS feature_usage_svc_full ON public.feature_usage;
CREATE POLICY feature_usage_svc_full ON public.feature_usage AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS handoff_events_select_own ON public.feedback_handoff_events;
CREATE POLICY handoff_events_select_own ON public.feedback_handoff_events AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS handoff_events_service ON public.feedback_handoff_events;
CREATE POLICY handoff_events_service ON public.feedback_handoff_events AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS feedback_tickets_insert_own ON public.feedback_tickets;
CREATE POLICY feedback_tickets_insert_own ON public.feedback_tickets AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS feedback_tickets_select_own ON public.feedback_tickets;
CREATE POLICY feedback_tickets_select_own ON public.feedback_tickets AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS feedback_tickets_service ON public.feedback_tickets;
CREATE POLICY feedback_tickets_service ON public.feedback_tickets AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS financial_sensitivity_cache_insert ON public.financial_sensitivity_cache;
CREATE POLICY financial_sensitivity_cache_insert ON public.financial_sensitivity_cache AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS financial_sensitivity_cache_select ON public.financial_sensitivity_cache;
CREATE POLICY financial_sensitivity_cache_select ON public.financial_sensitivity_cache AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS financial_sensitivity_cache_update ON public.financial_sensitivity_cache;
CREATE POLICY financial_sensitivity_cache_update ON public.financial_sensitivity_cache AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS geo_policy_select ON public.geo_policy;
CREATE POLICY geo_policy_select ON public.geo_policy AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS geo_policy_service ON public.geo_policy;
CREATE POLICY geo_policy_service ON public.geo_policy AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Community users can create events" ON public.global_community_events;
CREATE POLICY "Community users can create events" ON public.global_community_events AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((auth.uid() = created_by) AND is_community_user()));

DROP POLICY IF EXISTS "Community users can delete events they created or co-create" ON public.global_community_events;
CREATE POLICY "Community users can delete events they created or co-create" ON public.global_community_events AS PERMISSIVE FOR DELETE TO public
  USING ((is_community_user() AND ((created_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM event_co_creators ecc
  WHERE ((ecc.event_id = global_community_events.id) AND (ecc.user_id = auth.uid())))))));

DROP POLICY IF EXISTS "Community users can update events they created or co-create" ON public.global_community_events;
CREATE POLICY "Community users can update events they created or co-create" ON public.global_community_events AS PERMISSIVE FOR UPDATE TO public
  USING ((is_community_user() AND ((created_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM event_co_creators ecc
  WHERE ((ecc.event_id = global_community_events.id) AND (ecc.user_id = auth.uid())))))));

DROP POLICY IF EXISTS "Community users can view events" ON public.global_community_events;
CREATE POLICY "Community users can view events" ON public.global_community_events AS PERMISSIVE FOR SELECT TO public
  USING (is_community_user());

DROP POLICY IF EXISTS "Event creators can manage events" ON public.global_community_events;
CREATE POLICY "Event creators can manage events" ON public.global_community_events AS PERMISSIVE FOR UPDATE TO public
  USING (((created_by = auth.uid()) AND is_community_user()));

DROP POLICY IF EXISTS "Group admins can manage members" ON public.global_community_group_members;
CREATE POLICY "Group admins can manage members" ON public.global_community_group_members AS PERMISSIVE FOR ALL TO public
  USING (is_group_admin(group_id, auth.uid()));

DROP POLICY IF EXISTS "Group members can view group membership" ON public.global_community_group_members;
CREATE POLICY "Group members can view group membership" ON public.global_community_group_members AS PERMISSIVE FOR SELECT TO public
  USING (is_group_member(group_id, auth.uid()));

DROP POLICY IF EXISTS "Users can join groups" ON public.global_community_group_members;
CREATE POLICY "Users can join groups" ON public.global_community_group_members AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Community users can create groups" ON public.global_community_groups;
CREATE POLICY "Community users can create groups" ON public.global_community_groups AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((auth.uid() = created_by) AND is_community_user()));

DROP POLICY IF EXISTS "Community users can view approved groups" ON public.global_community_groups;
CREATE POLICY "Community users can view approved groups" ON public.global_community_groups AS PERMISSIVE FOR SELECT TO authenticated
  USING (((status = 'approved'::text) AND is_community_user()));

DROP POLICY IF EXISTS "Community users can view public groups" ON public.global_community_groups;
CREATE POLICY "Community users can view public groups" ON public.global_community_groups AS PERMISSIVE FOR SELECT TO public
  USING ((is_community_user() AND (is_public OR (EXISTS ( SELECT 1
   FROM global_group_members ggm
  WHERE ((ggm.group_id = global_community_groups.id) AND (ggm.user_id = auth.uid()) AND (ggm.is_active = true)))))));

DROP POLICY IF EXISTS "Group creators can manage groups" ON public.global_community_groups;
CREATE POLICY "Group creators can manage groups" ON public.global_community_groups AS PERMISSIVE FOR UPDATE TO public
  USING (((created_by = auth.uid()) AND is_community_user()));

DROP POLICY IF EXISTS "Group creators can update their groups" ON public.global_community_groups;
CREATE POLICY "Group creators can update their groups" ON public.global_community_groups AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((created_by = auth.uid()));

DROP POLICY IF EXISTS "Staff and admins can moderate groups" ON public.global_community_groups;
CREATE POLICY "Staff and admins can moderate groups" ON public.global_community_groups AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Staff and admins can view all groups" ON public.global_community_groups;
CREATE POLICY "Staff and admins can view all groups" ON public.global_community_groups AS PERMISSIVE FOR SELECT TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Authenticated users can view minimal global profiles" ON public.global_community_profiles;
CREATE POLICY "Authenticated users can view minimal global profiles" ON public.global_community_profiles AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_visible = true));

DROP POLICY IF EXISTS "Users can manage their own global profile" ON public.global_community_profiles;
CREATE POLICY "Users can manage their own global profile" ON public.global_community_profiles AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK (((auth.uid() = user_id) AND is_community_user()));

DROP POLICY IF EXISTS "Community users can join events" ON public.global_event_participants;
CREATE POLICY "Community users can join events" ON public.global_event_participants AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((user_id = auth.uid()) AND is_community_user()));

DROP POLICY IF EXISTS "Community users can view event participants" ON public.global_event_participants;
CREATE POLICY "Community users can view event participants" ON public.global_event_participants AS PERMISSIVE FOR SELECT TO public
  USING (is_community_user());

DROP POLICY IF EXISTS "Users can leave events" ON public.global_event_participants;
CREATE POLICY "Users can leave events" ON public.global_event_participants AS PERMISSIVE FOR DELETE TO public
  USING (((user_id = auth.uid()) AND is_community_user()));

DROP POLICY IF EXISTS "Users can manage their event participation" ON public.global_event_participants;
CREATE POLICY "Users can manage their event participation" ON public.global_event_participants AS PERMISSIVE FOR UPDATE TO public
  USING (((user_id = auth.uid()) AND is_community_user()));

DROP POLICY IF EXISTS "Community users can join groups" ON public.global_group_members;
CREATE POLICY "Community users can join groups" ON public.global_group_members AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((user_id = auth.uid()) AND is_community_user()));

DROP POLICY IF EXISTS "Community users can view group members" ON public.global_group_members;
CREATE POLICY "Community users can view group members" ON public.global_group_members AS PERMISSIVE FOR SELECT TO public
  USING (is_community_user());

DROP POLICY IF EXISTS "Users can manage their own group membership" ON public.global_group_members;
CREATE POLICY "Users can manage their own group membership" ON public.global_group_members AS PERMISSIVE FOR UPDATE TO public
  USING (((user_id = auth.uid()) AND is_community_user()));

DROP POLICY IF EXISTS "Authenticated users can create threads" ON public.global_message_threads;
CREATE POLICY "Authenticated users can create threads" ON public.global_message_threads AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = created_by));

DROP POLICY IF EXISTS "Thread creators can update threads" ON public.global_message_threads;
CREATE POLICY "Thread creators can update threads" ON public.global_message_threads AS PERMISSIVE FOR UPDATE TO public
  USING (((created_by = auth.uid()) AND is_community_user()));

DROP POLICY IF EXISTS global_threads_read_by_participants ON public.global_message_threads;
CREATE POLICY global_threads_read_by_participants ON public.global_message_threads AS PERMISSIVE FOR SELECT TO public
  USING (is_participant_of_global_thread(id));

DROP POLICY IF EXISTS "Senders can delete own global_messages" ON public.global_messages;
CREATE POLICY "Senders can delete own global_messages" ON public.global_messages AS PERMISSIVE FOR DELETE TO authenticated
  USING ((sender_id = auth.uid()));

DROP POLICY IF EXISTS "Senders can update own global_messages" ON public.global_messages;
CREATE POLICY "Senders can update own global_messages" ON public.global_messages AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((sender_id = auth.uid()))
  WITH CHECK ((sender_id = auth.uid()));

DROP POLICY IF EXISTS "Thread participants can update message status fields" ON public.global_messages;
CREATE POLICY "Thread participants can update message status fields" ON public.global_messages AS PERMISSIVE FOR UPDATE TO public
  USING ((EXISTS ( SELECT 1
   FROM global_thread_participants gtp
  WHERE ((gtp.thread_id = global_messages.thread_id) AND (gtp.user_id = auth.uid()) AND (gtp.is_active = true)))));

DROP POLICY IF EXISTS "Users can create messages in their threads" ON public.global_messages;
CREATE POLICY "Users can create messages in their threads" ON public.global_messages AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((auth.uid() = sender_id) AND is_participant_of_global_thread(thread_id)));

DROP POLICY IF EXISTS "Users can update their own messages" ON public.global_messages;
CREATE POLICY "Users can update their own messages" ON public.global_messages AS PERMISSIVE FOR UPDATE TO public
  USING (((auth.uid() = sender_id) AND is_community_user()));

DROP POLICY IF EXISTS global_messages_read_by_participants ON public.global_messages;
CREATE POLICY global_messages_read_by_participants ON public.global_messages AS PERMISSIVE FOR SELECT TO public
  USING (is_participant_of_global_thread(thread_id));

DROP POLICY IF EXISTS "Thread creators can add participants" ON public.global_thread_participants;
CREATE POLICY "Thread creators can add participants" ON public.global_thread_participants AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM global_message_threads t
  WHERE ((t.id = global_thread_participants.thread_id) AND (t.created_by = auth.uid())))));

DROP POLICY IF EXISTS "Users can join threads as themselves" ON public.global_thread_participants;
CREATE POLICY "Users can join threads as themselves" ON public.global_thread_participants AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can update their own thread participation" ON public.global_thread_participants;
CREATE POLICY "Users can update their own thread participation" ON public.global_thread_participants AS PERMISSIVE FOR UPDATE TO public
  USING (((user_id = auth.uid()) AND is_community_user()));

DROP POLICY IF EXISTS "Users can view participants in their threads" ON public.global_thread_participants;
CREATE POLICY "Users can view participants in their threads" ON public.global_thread_participants AS PERMISSIVE FOR SELECT TO public
  USING (((user_id = auth.uid()) OR is_participant_of_global_thread(thread_id)));

DROP POLICY IF EXISTS "Users can manage their own typing indicators" ON public.global_typing_indicators;
CREATE POLICY "Users can manage their own typing indicators" ON public.global_typing_indicators AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view typing indicators in their threads" ON public.global_typing_indicators;
CREATE POLICY "Users can view typing indicators in their threads" ON public.global_typing_indicators AS PERMISSIVE FOR SELECT TO public
  USING (is_participant_of_global_thread(thread_id));

DROP POLICY IF EXISTS goal_plan_i18n_select_own ON public.goal_plan_i18n;
CREATE POLICY goal_plan_i18n_select_own ON public.goal_plan_i18n AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM goal_plans p
  WHERE ((p.id = goal_plan_i18n.plan_id) AND (p.user_id = auth.uid())))));

DROP POLICY IF EXISTS goal_plan_step_i18n_select_own ON public.goal_plan_step_i18n;
CREATE POLICY goal_plan_step_i18n_select_own ON public.goal_plan_step_i18n AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM goal_plan_steps s
  WHERE ((s.id = goal_plan_step_i18n.step_id) AND (s.user_id = auth.uid())))));

DROP POLICY IF EXISTS goal_plan_steps_select_own ON public.goal_plan_steps;
CREATE POLICY goal_plan_steps_select_own ON public.goal_plan_steps AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS goal_plan_steps_update_own ON public.goal_plan_steps;
CREATE POLICY goal_plan_steps_update_own ON public.goal_plan_steps AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS goal_plans_select_own ON public.goal_plans;
CREATE POLICY goal_plans_select_own ON public.goal_plans AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Enable read access for auth users on catalog" ON public.governance_catalog;
CREATE POLICY "Enable read access for auth users on catalog" ON public.governance_catalog AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on catalog" ON public.governance_catalog;
CREATE POLICY "Enable write access for service role on catalog" ON public.governance_catalog AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Enable read access for auth users on categories" ON public.governance_categories;
CREATE POLICY "Enable read access for auth users on categories" ON public.governance_categories AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on categories" ON public.governance_categories;
CREATE POLICY "Enable write access for service role on categories" ON public.governance_categories AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Enable read access for auth users on enforcements" ON public.governance_enforcements;
CREATE POLICY "Enable read access for auth users on enforcements" ON public.governance_enforcements AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on enforcements" ON public.governance_enforcements;
CREATE POLICY "Enable write access for service role on enforcements" ON public.governance_enforcements AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Enable read access for auth users on evaluations" ON public.governance_evaluations;
CREATE POLICY "Enable read access for auth users on evaluations" ON public.governance_evaluations AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on evaluations" ON public.governance_evaluations;
CREATE POLICY "Enable write access for service role on evaluations" ON public.governance_evaluations AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Enable read access for auth users on proposals" ON public.governance_proposals;
CREATE POLICY "Enable read access for auth users on proposals" ON public.governance_proposals AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on proposals" ON public.governance_proposals;
CREATE POLICY "Enable write access for service role on proposals" ON public.governance_proposals AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Enable read access for auth users on rules" ON public.governance_rules;
CREATE POLICY "Enable read access for auth users on rules" ON public.governance_rules AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on rules" ON public.governance_rules;
CREATE POLICY "Enable write access for service role on rules" ON public.governance_rules AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Enable read access for auth users on violations" ON public.governance_violations;
CREATE POLICY "Enable read access for auth users on violations" ON public.governance_violations AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Enable write access for service role on violations" ON public.governance_violations;
CREATE POLICY "Enable write access for service role on violations" ON public.governance_violations AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users can create comments" ON public.group_post_comments;
CREATE POLICY "Authenticated users can create comments" ON public.group_post_comments AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Authors can delete own comments" ON public.group_post_comments;
CREATE POLICY "Authors can delete own comments" ON public.group_post_comments AS PERMISSIVE FOR DELETE TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view comments on accessible posts" ON public.group_post_comments;
CREATE POLICY "Users can view comments on accessible posts" ON public.group_post_comments AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM (group_posts gp
     JOIN global_community_groups g ON ((g.id = gp.group_id)))
  WHERE ((gp.id = group_post_comments.post_id) AND ((g.is_public = true) OR is_group_member(g.id, auth.uid()))))));

DROP POLICY IF EXISTS "Users can like posts" ON public.group_post_likes;
CREATE POLICY "Users can like posts" ON public.group_post_likes AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can unlike" ON public.group_post_likes;
CREATE POLICY "Users can unlike" ON public.group_post_likes AS PERMISSIVE FOR DELETE TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view likes" ON public.group_post_likes;
CREATE POLICY "Users can view likes" ON public.group_post_likes AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authors can delete own posts" ON public.group_posts;
CREATE POLICY "Authors can delete own posts" ON public.group_posts AS PERMISSIVE FOR DELETE TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Authors can update own posts" ON public.group_posts;
CREATE POLICY "Authors can update own posts" ON public.group_posts AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Members can create group posts" ON public.group_posts;
CREATE POLICY "Members can create group posts" ON public.group_posts AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((auth.uid() = user_id) AND is_group_member(group_id, auth.uid())));

DROP POLICY IF EXISTS "Members can view group posts" ON public.group_posts;
CREATE POLICY "Members can view group posts" ON public.group_posts AS PERMISSIVE FOR SELECT TO public
  USING ((is_group_member(group_id, auth.uid()) OR (EXISTS ( SELECT 1
   FROM global_community_groups g
  WHERE ((g.id = group_posts.group_id) AND (g.is_public = true))))));

DROP POLICY IF EXISTS "System can insert group recommendations" ON public.group_recommendations;
CREATE POLICY "System can insert group recommendations" ON public.group_recommendations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can dismiss their own group recommendations" ON public.group_recommendations;
CREATE POLICY "Users can dismiss their own group recommendations" ON public.group_recommendations AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own group recommendations" ON public.group_recommendations;
CREATE POLICY "Users can view their own group recommendations" ON public.group_recommendations AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS handle_aliases_public_read ON public.handle_aliases;
CREATE POLICY handle_aliases_public_read ON public.handle_aliases AS PERMISSIVE FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS health_features_daily_delete ON public.health_features_daily;
CREATE POLICY health_features_daily_delete ON public.health_features_daily AS PERMISSIVE FOR DELETE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS health_features_daily_insert ON public.health_features_daily;
CREATE POLICY health_features_daily_insert ON public.health_features_daily AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS health_features_daily_select ON public.health_features_daily;
CREATE POLICY health_features_daily_select ON public.health_features_daily AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS health_features_daily_update ON public.health_features_daily;
CREATE POLICY health_features_daily_update ON public.health_features_daily AS PERMISSIVE FOR UPDATE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS human_task_insert ON public.human_task;
CREATE POLICY human_task_insert ON public.human_task AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS human_task_read ON public.human_task;
CREATE POLICY human_task_read ON public.human_task AS PERMISSIVE FOR SELECT TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS human_task_update ON public.human_task;
CREATE POLICY human_task_update ON public.human_task AS PERMISSIVE FOR UPDATE TO public
  USING ((vcaop_role() = 'admin'::text))
  WITH CHECK ((vcaop_role() = 'admin'::text));

DROP POLICY IF EXISTS index_delta_obs_self ON public.index_delta_observations;
CREATE POLICY index_delta_obs_self ON public.index_delta_observations AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS index_delta_observations_tenant_user_select ON public.index_delta_observations;
CREATE POLICY index_delta_observations_tenant_user_select ON public.index_delta_observations AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS intent_disputes_raiser_read ON public.intent_disputes;
CREATE POLICY intent_disputes_raiser_read ON public.intent_disputes AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = raised_by));

DROP POLICY IF EXISTS intent_events_actor_read ON public.intent_events;
CREATE POLICY intent_events_actor_read ON public.intent_events AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = actor_user_id));

DROP POLICY IF EXISTS intent_events_owner_read ON public.intent_events;
CREATE POLICY intent_events_owner_read ON public.intent_events AS PERMISSIVE FOR SELECT TO public
  USING (((intent_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM user_intents ui
  WHERE ((ui.intent_id = intent_events.intent_id) AND (ui.requester_user_id = auth.uid()))))));

DROP POLICY IF EXISTS intent_matches_party_a_read ON public.intent_matches;
CREATE POLICY intent_matches_party_a_read ON public.intent_matches AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM user_intents ia
  WHERE ((ia.intent_id = intent_matches.intent_a_id) AND (ia.requester_user_id = auth.uid())))));

DROP POLICY IF EXISTS intent_matches_party_b_read ON public.intent_matches;
CREATE POLICY intent_matches_party_b_read ON public.intent_matches AS PERMISSIVE FOR SELECT TO public
  USING (((intent_b_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM user_intents ib
  WHERE ((ib.intent_id = intent_matches.intent_b_id) AND (ib.requester_user_id = auth.uid()))))));

DROP POLICY IF EXISTS intent_matches_archive_read ON public.intent_matches_archive;
CREATE POLICY intent_matches_archive_read ON public.intent_matches_archive AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM user_intents ia
  WHERE ((ia.intent_id = intent_matches_archive.intent_a_id) AND (ia.requester_user_id = auth.uid())))) OR ((intent_b_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM user_intents ib
  WHERE ((ib.intent_id = intent_matches_archive.intent_b_id) AND (ib.requester_user_id = auth.uid())))))));

DROP POLICY IF EXISTS "Event creators can view analytics" ON public.invite_analytics;
CREATE POLICY "Event creators can view analytics" ON public.invite_analytics AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM calendar_events ce
  WHERE ((ce.id = invite_analytics.event_id) AND (ce.user_id = auth.uid())))));

DROP POLICY IF EXISTS "System can manage analytics" ON public.invite_analytics;
CREATE POLICY "System can manage analytics" ON public.invite_analytics AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() IS NOT NULL));

DROP POLICY IF EXISTS job_artifact_staff_rw ON public.job_artifact;
CREATE POLICY job_artifact_staff_rw ON public.job_artifact AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])))
  WITH CHECK ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS job_attempt_staff_rw ON public.job_attempt;
CREATE POLICY job_attempt_staff_rw ON public.job_attempt AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])))
  WITH CHECK ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS job_step_staff_rw ON public.job_step;
CREATE POLICY job_step_staff_rw ON public.job_step AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])))
  WITH CHECK ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS journey_session_updates_self_rw ON public.journey_session_updates;
CREATE POLICY journey_session_updates_self_rw ON public.journey_session_updates AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS service_all ON public.kb_documents;
CREATE POLICY service_all ON public.kb_documents AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS knowledge_docs_authenticated_select ON public.knowledge_docs;
CREATE POLICY knowledge_docs_authenticated_select ON public.knowledge_docs AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS knowledge_docs_service_role_all ON public.knowledge_docs;
CREATE POLICY knowledge_docs_service_role_all ON public.knowledge_docs AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS lab_reports_delete ON public.lab_reports;
CREATE POLICY lab_reports_delete ON public.lab_reports AS PERMISSIVE FOR DELETE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS lab_reports_insert ON public.lab_reports;
CREATE POLICY lab_reports_insert ON public.lab_reports AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS lab_reports_select ON public.lab_reports;
CREATE POLICY lab_reports_select ON public.lab_reports AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS lab_reports_update ON public.lab_reports;
CREATE POLICY lab_reports_update ON public.lab_reports AS PERMISSIVE FOR UPDATE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS "Users can create their own orders" ON public.lab_test_orders;
CREATE POLICY "Users can create their own orders" ON public.lab_test_orders AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own orders" ON public.lab_test_orders;
CREATE POLICY "Users can update their own orders" ON public.lab_test_orders AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own orders" ON public.lab_test_orders;
CREATE POLICY "Users can view their own orders" ON public.lab_test_orders AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = user_id) OR ((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true) OR (EXISTS ( SELECT 1
   FROM memberships m1,
    profiles p
  WHERE ((m1.user_id = auth.uid()) AND (m1.role = ANY (ARRAY['professional'::tenant_role, 'staff'::tenant_role, 'admin'::tenant_role])) AND (m1.status = 'active'::text) AND (p.user_id = lab_test_orders.user_id) AND (p.tenant_id = m1.tenant_id))))));

DROP POLICY IF EXISTS "Users can view their own results" ON public.lab_test_results;
CREATE POLICY "Users can view their own results" ON public.lab_test_results AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = user_id) OR ((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true) OR (EXISTS ( SELECT 1
   FROM memberships m1,
    profiles p
  WHERE ((m1.user_id = auth.uid()) AND (m1.role = ANY (ARRAY['professional'::tenant_role, 'staff'::tenant_role, 'admin'::tenant_role])) AND (m1.status = 'active'::text) AND (p.user_id = lab_test_results.user_id) AND (p.tenant_id = m1.tenant_id))))));

DROP POLICY IF EXISTS "Lab tests are viewable by everyone" ON public.lab_tests;
CREATE POLICY "Lab tests are viewable by everyone" ON public.lab_tests AS PERMISSIVE FOR SELECT TO public
  USING ((is_active = true));

DROP POLICY IF EXISTS "Users can manage their own life compass" ON public.life_compass;
CREATE POLICY "Users can manage their own life compass" ON public.life_compass AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage their own subgoals" ON public.life_compass_subgoals;
CREATE POLICY "Users can manage their own subgoals" ON public.life_compass_subgoals AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM life_compass
  WHERE ((life_compass.id = life_compass_subgoals.compass_id) AND (life_compass.user_id = auth.uid())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM life_compass
  WHERE ((life_compass.id = life_compass_subgoals.compass_id) AND (life_compass.user_id = auth.uid())))));

DROP POLICY IF EXISTS life_stage_assessments_insert ON public.life_stage_assessments;
CREATE POLICY life_stage_assessments_insert ON public.life_stage_assessments AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS life_stage_assessments_select ON public.life_stage_assessments;
CREATE POLICY life_stage_assessments_select ON public.life_stage_assessments AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS life_stage_assessments_update ON public.life_stage_assessments;
CREATE POLICY life_stage_assessments_update ON public.life_stage_assessments AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS life_stage_goals_all ON public.life_stage_goals;
CREATE POLICY life_stage_goals_all ON public.life_stage_goals AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS life_stage_rules_select ON public.life_stage_rules;
CREATE POLICY life_stage_rules_select ON public.life_stage_rules AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS lifecycle_state_read_own ON public.lifecycle_notification_state;
CREATE POLICY lifecycle_state_read_own ON public.lifecycle_notification_state AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS lifecycle_state_svc_full ON public.lifecycle_notification_state;
CREATE POLICY lifecycle_state_svc_full ON public.lifecycle_notification_state AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS limitation_bypass_log_service ON public.limitation_bypass_log;
CREATE POLICY limitation_bypass_log_service ON public.limitation_bypass_log AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS lsh_service ON public.listing_status_history;
CREATE POLICY lsh_service ON public.listing_status_history AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS live_highlights_insert ON public.live_highlights;
CREATE POLICY live_highlights_insert ON public.live_highlights AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (created_by_user_id = current_user_id())));

DROP POLICY IF EXISTS live_highlights_select ON public.live_highlights;
CREATE POLICY live_highlights_select ON public.live_highlights AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS live_highlights_service_role ON public.live_highlights;
CREATE POLICY live_highlights_service_role ON public.live_highlights AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Prevent cross-tenant grant creation" ON public.live_room_access_grants;
CREATE POLICY "Prevent cross-tenant grant creation" ON public.live_room_access_grants AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = ( SELECT app_users.tenant_id
   FROM app_users
  WHERE (app_users.user_id = app_users.user_id))) AND (tenant_id = ( SELECT live_rooms.tenant_id
   FROM live_rooms
  WHERE (live_rooms.id = live_room_access_grants.room_id)))));

DROP POLICY IF EXISTS "Users can view own access grants" ON public.live_room_access_grants;
CREATE POLICY "Users can view own access grants" ON public.live_room_access_grants AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = ( SELECT app_users.tenant_id
   FROM app_users
  WHERE (app_users.user_id = auth.uid()))) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS admin_read_all_live_room_attendance ON public.live_room_attendance;
CREATE POLICY admin_read_all_live_room_attendance ON public.live_room_attendance AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS live_room_attendance_insert ON public.live_room_attendance;
CREATE POLICY live_room_attendance_insert ON public.live_room_attendance AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS live_room_attendance_select ON public.live_room_attendance;
CREATE POLICY live_room_attendance_select ON public.live_room_attendance AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS live_room_attendance_service_role ON public.live_room_attendance;
CREATE POLICY live_room_attendance_service_role ON public.live_room_attendance AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS live_room_attendance_update ON public.live_room_attendance;
CREATE POLICY live_room_attendance_update ON public.live_room_attendance AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS admin_read_all_live_room_sessions ON public.live_room_sessions;
CREATE POLICY admin_read_all_live_room_sessions ON public.live_room_sessions AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS sessions_select_tenant ON public.live_room_sessions;
CREATE POLICY sessions_select_tenant ON public.live_room_sessions AS PERMISSIVE FOR SELECT TO public
  USING ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))));

DROP POLICY IF EXISTS sessions_service_role ON public.live_room_sessions;
CREATE POLICY sessions_service_role ON public.live_room_sessions AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT current_setting('request.jwt.claim.role'::text, true) AS current_setting) = 'service_role'::text));

DROP POLICY IF EXISTS admin_read_all_live_rooms ON public.live_rooms;
CREATE POLICY admin_read_all_live_rooms ON public.live_rooms AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS live_rooms_insert ON public.live_rooms;
CREATE POLICY live_rooms_insert ON public.live_rooms AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS live_rooms_select ON public.live_rooms;
CREATE POLICY live_rooms_select ON public.live_rooms AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS live_rooms_service_role ON public.live_rooms;
CREATE POLICY live_rooms_service_role ON public.live_rooms AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS live_rooms_update ON public.live_rooms;
CREATE POLICY live_rooms_update ON public.live_rooms AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((tenant_id = current_tenant_id()))
  WITH CHECK ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS "Users can subscribe themselves" ON public.live_stream_subscribers;
CREATE POLICY "Users can subscribe themselves" ON public.live_stream_subscribers AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can unsubscribe themselves" ON public.live_stream_subscribers;
CREATE POLICY "Users can unsubscribe themselves" ON public.live_stream_subscribers AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own stream subscriptions" ON public.live_stream_subscribers;
CREATE POLICY "Users can view their own stream subscriptions" ON public.live_stream_subscribers AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS llm_allowed_models_read_all ON public.llm_allowed_models;
CREATE POLICY llm_allowed_models_read_all ON public.llm_allowed_models AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS llm_allowed_models_write_service ON public.llm_allowed_models;
CREATE POLICY llm_allowed_models_write_service ON public.llm_allowed_models AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS llm_allowed_providers_read_all ON public.llm_allowed_providers;
CREATE POLICY llm_allowed_providers_read_all ON public.llm_allowed_providers AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS llm_allowed_providers_write_service ON public.llm_allowed_providers;
CREATE POLICY llm_allowed_providers_write_service ON public.llm_allowed_providers AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS llm_routing_policy_read_all ON public.llm_routing_policy;
CREATE POLICY llm_routing_policy_read_all ON public.llm_routing_policy AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS llm_routing_policy_write_service ON public.llm_routing_policy;
CREATE POLICY llm_routing_policy_write_service ON public.llm_routing_policy AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS llm_routing_policy_audit_read_all ON public.llm_routing_policy_audit;
CREATE POLICY llm_routing_policy_audit_read_all ON public.llm_routing_policy_audit AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS llm_routing_policy_audit_write_service ON public.llm_routing_policy_audit;
CREATE POLICY llm_routing_policy_audit_write_service ON public.llm_routing_policy_audit AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS llm_vtid_policy_snapshot_read_all ON public.llm_vtid_policy_snapshot;
CREATE POLICY llm_vtid_policy_snapshot_read_all ON public.llm_vtid_policy_snapshot AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS llm_vtid_policy_snapshot_write_service ON public.llm_vtid_policy_snapshot;
CREATE POLICY llm_vtid_policy_snapshot_write_service ON public.llm_vtid_policy_snapshot AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS location_preferences_insert ON public.location_preferences;
CREATE POLICY location_preferences_insert ON public.location_preferences AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS location_preferences_select ON public.location_preferences;
CREATE POLICY location_preferences_select ON public.location_preferences AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS location_preferences_update ON public.location_preferences;
CREATE POLICY location_preferences_update ON public.location_preferences AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS location_visits_delete ON public.location_visits;
CREATE POLICY location_visits_delete ON public.location_visits AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS location_visits_insert ON public.location_visits;
CREATE POLICY location_visits_insert ON public.location_visits AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS location_visits_select ON public.location_visits;
CREATE POLICY location_visits_select ON public.location_visits AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS location_visits_update ON public.location_visits;
CREATE POLICY location_visits_update ON public.location_visits AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS locations_delete ON public.locations;
CREATE POLICY locations_delete ON public.locations AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (created_by = auth.uid())));

DROP POLICY IF EXISTS locations_insert ON public.locations;
CREATE POLICY locations_insert ON public.locations AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (created_by = auth.uid())));

DROP POLICY IF EXISTS locations_select ON public.locations;
CREATE POLICY locations_select ON public.locations AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND ((created_by = auth.uid()) OR (privacy_level = 'public'::text) OR ((privacy_level = 'shared'::text) AND (EXISTS ( SELECT 1
   FROM location_visits lv
  WHERE ((lv.location_id = locations.id) AND (lv.user_id = auth.uid()) AND (lv.tenant_id = current_tenant_id()))))))));

DROP POLICY IF EXISTS locations_update ON public.locations;
CREATE POLICY locations_update ON public.locations AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (created_by = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (created_by = auth.uid())));

DROP POLICY IF EXISTS marketplace_sources_config_service ON public.marketplace_sources_config;
CREATE POLICY marketplace_sources_config_service ON public.marketplace_sources_config AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can update their own match notifications" ON public.match_notifications;
CREATE POLICY "Users can update their own match notifications" ON public.match_notifications AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own match notifications" ON public.match_notifications;
CREATE POLICY "Users can view their own match notifications" ON public.match_notifications AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Authenticated users can execute MCP tools" ON public.mcp_tool_executions;
CREATE POLICY "Authenticated users can execute MCP tools" ON public.mcp_tool_executions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = executed_by));

DROP POLICY IF EXISTS "Staff can view MCP executions" ON public.mcp_tool_executions;
CREATE POLICY "Staff can view MCP executions" ON public.mcp_tool_executions AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Users can create analytics" ON public.media_analytics;
CREATE POLICY "Users can create analytics" ON public.media_analytics AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view analytics for accessible media" ON public.media_analytics;
CREATE POLICY "Users can view analytics for accessible media" ON public.media_analytics AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = media_analytics.media_id) AND ((m.user_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM memberships mb
          WHERE ((mb.user_id = auth.uid()) AND (mb.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (mb.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true))))));

DROP POLICY IF EXISTS "Anyone can view public media" ON public.media_content;
CREATE POLICY "Anyone can view public media" ON public.media_content AS PERMISSIVE FOR SELECT TO public
  USING ((is_public = true));

DROP POLICY IF EXISTS "Users can delete their own media" ON public.media_content;
CREATE POLICY "Users can delete their own media" ON public.media_content AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can insert their own media" ON public.media_content;
CREATE POLICY "Users can insert their own media" ON public.media_content AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own media" ON public.media_content;
CREATE POLICY "Users can update their own media" ON public.media_content AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own media" ON public.media_content;
CREATE POLICY "Users can view their own media" ON public.media_content AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Anyone can insert media events" ON public.media_events;
CREATE POLICY "Anyone can insert media events" ON public.media_events AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view their own events" ON public.media_events;
CREATE POLICY "Users can view their own events" ON public.media_events AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can create video comments" ON public.media_upload_comments;
CREATE POLICY "Users can create video comments" ON public.media_upload_comments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete own video comments" ON public.media_upload_comments;
CREATE POLICY "Users can delete own video comments" ON public.media_upload_comments AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update own video comments" ON public.media_upload_comments;
CREATE POLICY "Users can update own video comments" ON public.media_upload_comments AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view all video comments" ON public.media_upload_comments;
CREATE POLICY "Users can view all video comments" ON public.media_upload_comments AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS "Users can like videos" ON public.media_upload_likes;
CREATE POLICY "Users can like videos" ON public.media_upload_likes AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can unlike videos" ON public.media_upload_likes;
CREATE POLICY "Users can unlike videos" ON public.media_upload_likes AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view all video likes" ON public.media_upload_likes;
CREATE POLICY "Users can view all video likes" ON public.media_upload_likes AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS "Staff can delete media" ON public.media_uploads;
CREATE POLICY "Staff can delete media" ON public.media_uploads AS PERMISSIVE FOR DELETE TO public
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Users can create their own media" ON public.media_uploads;
CREATE POLICY "Users can create their own media" ON public.media_uploads AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can delete own media uploads" ON public.media_uploads;
CREATE POLICY "Users can delete own media uploads" ON public.media_uploads AS PERMISSIVE FOR DELETE TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can delete their own media" ON public.media_uploads;
CREATE POLICY "Users can delete their own media" ON public.media_uploads AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own media" ON public.media_uploads;
CREATE POLICY "Users can update their own media" ON public.media_uploads AS PERMISSIVE FOR UPDATE TO public
  USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Users can view approved public media" ON public.media_uploads;
CREATE POLICY "Users can view approved public media" ON public.media_uploads AS PERMISSIVE FOR SELECT TO public
  USING ((((status = 'approved'::text) AND (is_public = true)) OR (user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Anyone can view comment likes" ON public.media_video_comment_likes;
CREATE POLICY "Anyone can view comment likes" ON public.media_video_comment_likes AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS "Users can like comments" ON public.media_video_comment_likes;
CREATE POLICY "Users can like comments" ON public.media_video_comment_likes AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can unlike comments" ON public.media_video_comment_likes;
CREATE POLICY "Users can unlike comments" ON public.media_video_comment_likes AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Anyone can view video comments" ON public.media_video_comments;
CREATE POLICY "Anyone can view video comments" ON public.media_video_comments AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS "Users can create video comments" ON public.media_video_comments;
CREATE POLICY "Users can create video comments" ON public.media_video_comments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete own video comments" ON public.media_video_comments;
CREATE POLICY "Users can delete own video comments" ON public.media_video_comments AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update own video comments" ON public.media_video_comments;
CREATE POLICY "Users can update own video comments" ON public.media_video_comments AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Anyone can view published videos" ON public.media_videos;
CREATE POLICY "Anyone can view published videos" ON public.media_videos AS PERMISSIVE FOR SELECT TO public
  USING ((status = 'published'::text));

DROP POLICY IF EXISTS "Users can delete their own videos" ON public.media_videos;
CREATE POLICY "Users can delete their own videos" ON public.media_videos AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can insert their own videos" ON public.media_videos;
CREATE POLICY "Users can insert their own videos" ON public.media_videos AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own videos" ON public.media_videos;
CREATE POLICY "Users can update their own videos" ON public.media_videos AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS mem_episodes_tenant_user_select ON public.mem_episodes;
CREATE POLICY mem_episodes_tenant_user_select ON public.mem_episodes AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS mem_facts_tenant_user_select ON public.mem_facts;
CREATE POLICY mem_facts_tenant_user_select ON public.mem_facts AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS mem_graph_edges_tenant_user_select ON public.mem_graph_edges;
CREATE POLICY mem_graph_edges_tenant_user_select ON public.mem_graph_edges AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS mem_turn_log_tenant_user_select ON public.mem_turn_log;
CREATE POLICY mem_turn_log_tenant_user_select ON public.mem_turn_log AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memberships_delete_new ON public.memberships;
CREATE POLICY memberships_delete_new ON public.memberships AS PERMISSIVE FOR DELETE TO public
  USING (is_exafy_admin(auth.uid()));

DROP POLICY IF EXISTS memberships_insert_new ON public.memberships;
CREATE POLICY memberships_insert_new ON public.memberships AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (is_exafy_admin(auth.uid()));

DROP POLICY IF EXISTS memberships_select_new ON public.memberships;
CREATE POLICY memberships_select_new ON public.memberships AS PERMISSIVE FOR SELECT TO public
  USING (((user_id = auth.uid()) OR is_exafy_admin(auth.uid())));

DROP POLICY IF EXISTS memberships_update_new ON public.memberships;
CREATE POLICY memberships_update_new ON public.memberships AS PERMISSIVE FOR UPDATE TO public
  USING (is_exafy_admin(auth.uid()))
  WITH CHECK (is_exafy_admin(auth.uid()));

DROP POLICY IF EXISTS memory_audit_log_service_role_all ON public.memory_audit_log;
CREATE POLICY memory_audit_log_service_role_all ON public.memory_audit_log AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS memory_categories_select ON public.memory_categories;
CREATE POLICY memory_categories_select ON public.memory_categories AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS memory_category_mapping_select ON public.memory_category_mapping;
CREATE POLICY memory_category_mapping_select ON public.memory_category_mapping AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS memory_confidence_history_insert ON public.memory_confidence_history;
CREATE POLICY memory_confidence_history_insert ON public.memory_confidence_history AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_confidence_history_select ON public.memory_confidence_history;
CREATE POLICY memory_confidence_history_select ON public.memory_confidence_history AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_confidence_reasons_select ON public.memory_confidence_reasons;
CREATE POLICY memory_confidence_reasons_select ON public.memory_confidence_reasons AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS memory_deletions_insert ON public.memory_deletions;
CREATE POLICY memory_deletions_insert ON public.memory_deletions AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_deletions_select ON public.memory_deletions;
CREATE POLICY memory_deletions_select ON public.memory_deletions AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS diary_entries_delete ON public.memory_diary_entries;
CREATE POLICY diary_entries_delete ON public.memory_diary_entries AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS diary_entries_insert ON public.memory_diary_entries;
CREATE POLICY diary_entries_insert ON public.memory_diary_entries AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS diary_entries_select ON public.memory_diary_entries;
CREATE POLICY diary_entries_select ON public.memory_diary_entries AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS diary_entries_update ON public.memory_diary_entries;
CREATE POLICY diary_entries_update ON public.memory_diary_entries AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS mem_emb_read_owner_admin ON public.memory_embeddings;
CREATE POLICY mem_emb_read_owner_admin ON public.memory_embeddings AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND ((user_id = auth.uid()) OR is_platform_admin())));

DROP POLICY IF EXISTS mem_events_insert_owner ON public.memory_events;
CREATE POLICY mem_events_insert_owner ON public.memory_events AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS mem_events_read ON public.memory_events;
CREATE POLICY mem_events_read ON public.memory_events AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND ((user_id = auth.uid()) OR is_platform_admin())));

DROP POLICY IF EXISTS memory_exports_insert ON public.memory_exports;
CREATE POLICY memory_exports_insert ON public.memory_exports AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_exports_select ON public.memory_exports;
CREATE POLICY memory_exports_select ON public.memory_exports AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_exports_update ON public.memory_exports;
CREATE POLICY memory_exports_update ON public.memory_exports AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS admin_read_all_memory_facts ON public.memory_facts;
CREATE POLICY admin_read_all_memory_facts ON public.memory_facts AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS memory_facts_tenant_user_isolation ON public.memory_facts;
CREATE POLICY memory_facts_tenant_user_isolation ON public.memory_facts AS PERMISSIVE FOR ALL TO public
  USING (((tenant_id = COALESCE((current_setting('app.tenant_id'::text, true))::uuid, '00000000-0000-0000-0000-000000000000'::uuid)) AND (user_id = COALESCE((current_setting('app.user_id'::text, true))::uuid, '00000000-0000-0000-0000-000000000000'::uuid))));

DROP POLICY IF EXISTS memory_garden_config_select ON public.memory_garden_config;
CREATE POLICY memory_garden_config_select ON public.memory_garden_config AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS garden_nodes_delete ON public.memory_garden_nodes;
CREATE POLICY garden_nodes_delete ON public.memory_garden_nodes AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS garden_nodes_insert ON public.memory_garden_nodes;
CREATE POLICY garden_nodes_insert ON public.memory_garden_nodes AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS garden_nodes_select ON public.memory_garden_nodes;
CREATE POLICY garden_nodes_select ON public.memory_garden_nodes AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS garden_nodes_update ON public.memory_garden_nodes;
CREATE POLICY garden_nodes_update ON public.memory_garden_nodes AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS admin_read_all_memory_items ON public.memory_items;
CREATE POLICY admin_read_all_memory_items ON public.memory_items AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS memory_items_delete ON public.memory_items;
CREATE POLICY memory_items_delete ON public.memory_items AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_items_insert ON public.memory_items;
CREATE POLICY memory_items_insert ON public.memory_items AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_items_select ON public.memory_items;
CREATE POLICY memory_items_select ON public.memory_items AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_items_update ON public.memory_items;
CREATE POLICY memory_items_update ON public.memory_items AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_locks_delete ON public.memory_locks;
CREATE POLICY memory_locks_delete ON public.memory_locks AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_locks_insert ON public.memory_locks;
CREATE POLICY memory_locks_insert ON public.memory_locks AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_locks_select ON public.memory_locks;
CREATE POLICY memory_locks_select ON public.memory_locks AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS node_sources_delete ON public.memory_node_sources;
CREATE POLICY node_sources_delete ON public.memory_node_sources AS PERMISSIVE FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM memory_garden_nodes n
  WHERE ((n.id = memory_node_sources.node_id) AND (n.tenant_id = current_tenant_id()) AND (n.user_id = auth.uid())))));

DROP POLICY IF EXISTS node_sources_insert ON public.memory_node_sources;
CREATE POLICY node_sources_insert ON public.memory_node_sources AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1
   FROM memory_garden_nodes n
  WHERE ((n.id = memory_node_sources.node_id) AND (n.tenant_id = current_tenant_id()) AND (n.user_id = auth.uid())))));

DROP POLICY IF EXISTS node_sources_select ON public.memory_node_sources;
CREATE POLICY node_sources_select ON public.memory_node_sources AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM memory_garden_nodes n
  WHERE ((n.id = memory_node_sources.node_id) AND (n.tenant_id = current_tenant_id()) AND (n.user_id = auth.uid())))));

DROP POLICY IF EXISTS memory_source_trust_select ON public.memory_source_trust;
CREATE POLICY memory_source_trust_select ON public.memory_source_trust AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS memory_visibility_prefs_delete ON public.memory_visibility_prefs;
CREATE POLICY memory_visibility_prefs_delete ON public.memory_visibility_prefs AS PERMISSIVE FOR DELETE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_visibility_prefs_insert ON public.memory_visibility_prefs;
CREATE POLICY memory_visibility_prefs_insert ON public.memory_visibility_prefs AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_visibility_prefs_select ON public.memory_visibility_prefs;
CREATE POLICY memory_visibility_prefs_select ON public.memory_visibility_prefs AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_visibility_prefs_update ON public.memory_visibility_prefs;
CREATE POLICY memory_visibility_prefs_update ON public.memory_visibility_prefs AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS memory_write_dlq_tenant_user_select ON public.memory_write_dlq;
CREATE POLICY memory_write_dlq_tenant_user_select ON public.memory_write_dlq AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS merchant_route_owner_rw ON public.merchant_route;
CREATE POLICY merchant_route_owner_rw ON public.merchant_route AS PERMISSIVE FOR ALL TO public
  USING (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (EXISTS ( SELECT 1
   FROM cart_order c
  WHERE ((c.id = merchant_route.cart_order_id) AND (c.user_id = vcaop_uid()))))))
  WITH CHECK (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (EXISTS ( SELECT 1
   FROM cart_order c
  WHERE ((c.id = merchant_route.cart_order_id) AND (c.user_id = vcaop_uid()))))));

DROP POLICY IF EXISTS merchants_select ON public.merchants;
CREATE POLICY merchants_select ON public.merchants AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS merchants_service ON public.merchants;
CREATE POLICY merchants_service ON public.merchants AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can create their own actions" ON public.message_actions;
CREATE POLICY "Users can create their own actions" ON public.message_actions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own actions" ON public.message_actions;
CREATE POLICY "Users can view their own actions" ON public.message_actions AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view message queue for their campaigns" ON public.message_queue;
CREATE POLICY "Users can view message queue for their campaigns" ON public.message_queue AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM campaigns
  WHERE ((campaigns.id = message_queue.campaign_id) AND (campaigns.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can create their own reactions" ON public.message_reactions;
CREATE POLICY "Users can create their own reactions" ON public.message_reactions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete their own reactions" ON public.message_reactions;
CREATE POLICY "Users can delete their own reactions" ON public.message_reactions AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view reactions for accessible messages" ON public.message_reactions;
CREATE POLICY "Users can view reactions for accessible messages" ON public.message_reactions AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM global_messages gm
  WHERE ((gm.id = message_reactions.message_id) AND is_participant_of_global_thread(gm.thread_id)))) OR (EXISTS ( SELECT 1
   FROM (messages tm
     JOIN thread_participants tp ON ((tp.thread_id = tm.thread_id)))
  WHERE ((tm.id = message_reactions.message_id) AND (tp.user_id = auth.uid()) AND (tp.is_active = true)))) OR (EXISTS ( SELECT 1
   FROM chat_messages cm
  WHERE ((cm.id = message_reactions.message_id) AND ((cm.sender_id = auth.uid()) OR (cm.receiver_id = auth.uid()) OR ((cm.group_id IS NOT NULL) AND (EXISTS ( SELECT 1
           FROM chat_group_members cgm
          WHERE ((cgm.group_id = cm.group_id) AND (cgm.user_id = auth.uid())))))))))));

DROP POLICY IF EXISTS "Admins can manage templates" ON public.message_templates;
CREATE POLICY "Admins can manage templates" ON public.message_templates AS PERMISSIVE FOR ALL TO public
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = message_templates.tenant_id) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)))
  WITH CHECK (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = message_templates.tenant_id) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Users can view templates for their tenant" ON public.message_templates;
CREATE POLICY "Users can view templates for their tenant" ON public.message_templates AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = message_templates.tenant_id) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Thread creators and admins can update threads" ON public.message_threads;
CREATE POLICY "Thread creators and admins can update threads" ON public.message_threads AS PERMISSIVE FOR UPDATE TO public
  USING (((created_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM thread_participants tp
  WHERE ((tp.thread_id = message_threads.id) AND (tp.user_id = auth.uid()) AND (tp.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Users can create threads" ON public.message_threads;
CREATE POLICY "Users can create threads" ON public.message_threads AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = created_by));

DROP POLICY IF EXISTS tenant_threads_read_by_participants ON public.message_threads;
CREATE POLICY tenant_threads_read_by_participants ON public.message_threads AS PERMISSIVE FOR SELECT TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM thread_participants tp
  WHERE ((tp.thread_id = message_threads.id) AND (tp.user_id = auth.uid()) AND (tp.is_active = true)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Thread participants can update message status fields" ON public.messages;
CREATE POLICY "Thread participants can update message status fields" ON public.messages AS PERMISSIVE FOR UPDATE TO public
  USING ((EXISTS ( SELECT 1
   FROM thread_participants tp
  WHERE ((tp.thread_id = messages.thread_id) AND (tp.user_id = auth.uid()) AND (tp.is_active = true)))));

DROP POLICY IF EXISTS "Users can create messages as sender" ON public.messages;
CREATE POLICY "Users can create messages as sender" ON public.messages AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = sender_id));

DROP POLICY IF EXISTS "Users can delete their own sent messages" ON public.messages;
CREATE POLICY "Users can delete their own sent messages" ON public.messages AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = sender_id));

DROP POLICY IF EXISTS "Users can update their own sent messages" ON public.messages;
CREATE POLICY "Users can update their own sent messages" ON public.messages AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = sender_id))
  WITH CHECK ((auth.uid() = sender_id));

DROP POLICY IF EXISTS tenant_messages_read_by_participants ON public.messages;
CREATE POLICY tenant_messages_read_by_participants ON public.messages AS PERMISSIVE FOR SELECT TO authenticated
  USING (((auth.uid() = sender_id) OR (auth.uid() = recipient_id) OR ((thread_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM thread_participants tp
  WHERE ((tp.thread_id = messages.thread_id) AND (tp.user_id = auth.uid()) AND (tp.is_active = true))))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Admins view moderation actions" ON public.moderation_actions;
CREATE POLICY "Admins view moderation actions" ON public.moderation_actions AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_community_moderator());

DROP POLICY IF EXISTS monetization_attempts_insert ON public.monetization_attempts;
CREATE POLICY monetization_attempts_insert ON public.monetization_attempts AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS monetization_attempts_select ON public.monetization_attempts;
CREATE POLICY monetization_attempts_select ON public.monetization_attempts AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS monetization_audit_insert ON public.monetization_audit;
CREATE POLICY monetization_audit_insert ON public.monetization_audit AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS monetization_audit_select ON public.monetization_audit;
CREATE POLICY monetization_audit_select ON public.monetization_audit AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS monetization_cooldowns_insert ON public.monetization_cooldowns;
CREATE POLICY monetization_cooldowns_insert ON public.monetization_cooldowns AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS monetization_cooldowns_select ON public.monetization_cooldowns;
CREATE POLICY monetization_cooldowns_select ON public.monetization_cooldowns AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS monetization_cooldowns_update ON public.monetization_cooldowns;
CREATE POLICY monetization_cooldowns_update ON public.monetization_cooldowns AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS monetization_signals_insert ON public.monetization_signals;
CREATE POLICY monetization_signals_insert ON public.monetization_signals AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS monetization_signals_select ON public.monetization_signals;
CREATE POLICY monetization_signals_select ON public.monetization_signals AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS mood_pattern_aggregates_tenant_user_select ON public.mood_pattern_aggregates;
CREATE POLICY mood_pattern_aggregates_tenant_user_select ON public.mood_pattern_aggregates AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS "Users can manage music metadata" ON public.music_metadata;
CREATE POLICY "Users can manage music metadata" ON public.music_metadata AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = music_metadata.media_id) AND (m.user_id = auth.uid())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = music_metadata.media_id) AND (m.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can view music metadata" ON public.music_metadata;
CREATE POLICY "Users can view music metadata" ON public.music_metadata AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = music_metadata.media_id) AND (((m.status = 'approved'::text) AND (m.is_public = true)) OR (m.user_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM memberships mb
          WHERE ((mb.user_id = auth.uid()) AND (mb.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (mb.status = 'active'::text)))))))));

DROP POLICY IF EXISTS admin_read_nav_catalog ON public.nav_catalog;
CREATE POLICY admin_read_nav_catalog ON public.nav_catalog AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS admin_read_nav_catalog_audit ON public.nav_catalog_audit;
CREATE POLICY admin_read_nav_catalog_audit ON public.nav_catalog_audit AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS admin_read_nav_catalog_i18n ON public.nav_catalog_i18n;
CREATE POLICY admin_read_nav_catalog_i18n ON public.nav_catalog_i18n AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS authenticated_read_active_categories ON public.notification_categories;
CREATE POLICY authenticated_read_active_categories ON public.notification_categories AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS service_role_full_access_categories ON public.notification_categories;
CREATE POLICY service_role_full_access_categories ON public.notification_categories AS PERMISSIVE FOR ALL TO public
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Staff can view all notification logs" ON public.notification_logs;
CREATE POLICY "Staff can view all notification logs" ON public.notification_logs AS PERMISSIVE FOR SELECT TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Users can view their own notification logs" ON public.notification_logs;
CREATE POLICY "Users can view their own notification logs" ON public.notification_logs AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Staff can view all notification settings" ON public.notification_settings;
CREATE POLICY "Staff can view all notification settings" ON public.notification_settings AS PERMISSIVE FOR SELECT TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text)))) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Users can manage their own notification settings" ON public.notification_settings;
CREATE POLICY "Users can manage their own notification settings" ON public.notification_settings AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own notifications" ON public.notifications;
CREATE POLICY "Users can update their own notifications" ON public.notifications AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own notifications" ON public.notifications;
CREATE POLICY "Users can view their own notifications" ON public.notifications AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Service role has full access" ON public.oasis_events;
CREATE POLICY "Service role has full access" ON public.oasis_events AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS admin_read_all_oasis_events ON public.oasis_events_v1;
CREATE POLICY admin_read_all_oasis_events ON public.oasis_events_v1 AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS p_insert_events_by_tenant ON public.oasis_events_v1;
CREATE POLICY p_insert_events_by_tenant ON public.oasis_events_v1 AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((tenant = current_tenant()));

DROP POLICY IF EXISTS p_select_events_by_tenant ON public.oasis_events_v1;
CREATE POLICY p_select_events_by_tenant ON public.oasis_events_v1 AS PERMISSIVE FOR SELECT TO public
  USING ((tenant = current_tenant()));

DROP POLICY IF EXISTS p_update_events_by_tenant ON public.oasis_events_v1;
CREATE POLICY p_update_events_by_tenant ON public.oasis_events_v1 AS PERMISSIVE FOR UPDATE TO public
  USING ((tenant = current_tenant()))
  WITH CHECK ((tenant = current_tenant()));

DROP POLICY IF EXISTS authenticated_read_oasis_spec_approvals ON public.oasis_spec_approvals;
CREATE POLICY authenticated_read_oasis_spec_approvals ON public.oasis_spec_approvals AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS service_role_oasis_spec_approvals ON public.oasis_spec_approvals;
CREATE POLICY service_role_oasis_spec_approvals ON public.oasis_spec_approvals AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on oasis_spec_quality_reports" ON public.oasis_spec_quality_reports;
CREATE POLICY "Service role full access on oasis_spec_quality_reports" ON public.oasis_spec_quality_reports AS PERMISSIVE FOR ALL TO public
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS authenticated_read_oasis_spec_validations ON public.oasis_spec_validations;
CREATE POLICY authenticated_read_oasis_spec_validations ON public.oasis_spec_validations AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS service_role_oasis_spec_validations ON public.oasis_spec_validations;
CREATE POLICY service_role_oasis_spec_validations ON public.oasis_spec_validations AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS authenticated_read_oasis_specs ON public.oasis_specs;
CREATE POLICY authenticated_read_oasis_specs ON public.oasis_specs AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS service_role_oasis_specs ON public.oasis_specs;
CREATE POLICY service_role_oasis_specs ON public.oasis_specs AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON public.oasis_tasks;
CREATE POLICY service_role_all ON public.oasis_tasks AS PERMISSIVE FOR ALL TO public
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS admin_read_all_onboarding_invitations ON public.onboarding_invitations;
CREATE POLICY admin_read_all_onboarding_invitations ON public.onboarding_invitations AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS service_role_full_access_onboarding_inv ON public.onboarding_invitations;
CREATE POLICY service_role_full_access_onboarding_inv ON public.onboarding_invitations AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS orb_session_state_owner_read ON public.orb_session_state;
CREATE POLICY orb_session_state_owner_read ON public.orb_session_state AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS orb_wake_timelines_tenant_isolation ON public.orb_wake_timelines;
CREATE POLICY orb_wake_timelines_tenant_isolation ON public.orb_wake_timelines AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id IS NULL) OR (tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid())))))
  WITH CHECK (((tenant_id IS NULL) OR (tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Creators can view redemptions of their packages" ON public.package_item_redemptions;
CREATE POLICY "Creators can view redemptions of their packages" ON public.package_item_redemptions AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM (package_purchases pp
     JOIN business_packages bp ON ((bp.id = pp.package_id)))
  WHERE ((pp.id = package_item_redemptions.purchase_id) AND (bp.creator_id = auth.uid())))) AND (tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can create redemptions in their tenant" ON public.package_item_redemptions;
CREATE POLICY "Users can create redemptions in their tenant" ON public.package_item_redemptions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((EXISTS ( SELECT 1
   FROM package_purchases pp
  WHERE ((pp.id = package_item_redemptions.purchase_id) AND (pp.buyer_id = auth.uid())))) AND (tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can manage their redemptions" ON public.package_item_redemptions;
CREATE POLICY "Users can manage their redemptions" ON public.package_item_redemptions AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM package_purchases pp
  WHERE ((pp.id = package_item_redemptions.purchase_id) AND (pp.buyer_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can view their own redemptions" ON public.package_item_redemptions;
CREATE POLICY "Users can view their own redemptions" ON public.package_item_redemptions AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM package_purchases pp
  WHERE ((pp.id = package_item_redemptions.purchase_id) AND (pp.buyer_id = auth.uid())))) AND (tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can view their redemptions" ON public.package_item_redemptions;
CREATE POLICY "Users can view their redemptions" ON public.package_item_redemptions AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM package_purchases pp
  WHERE ((pp.id = package_item_redemptions.purchase_id) AND ((pp.buyer_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM business_packages bp
          WHERE ((bp.id = pp.package_id) AND (bp.creator_id = auth.uid())))))))));

DROP POLICY IF EXISTS "Users can manage items in their packages" ON public.package_items;
CREATE POLICY "Users can manage items in their packages" ON public.package_items AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM business_packages bp
  WHERE ((bp.id = package_items.package_id) AND (bp.creator_id = auth.uid()) AND (bp.tenant_id IN ( SELECT memberships.tenant_id
           FROM memberships
          WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))))));

DROP POLICY IF EXISTS "Users can manage items of their packages" ON public.package_items;
CREATE POLICY "Users can manage items of their packages" ON public.package_items AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM business_packages bp
  WHERE ((bp.id = package_items.package_id) AND (bp.creator_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can view items in their tenant packages" ON public.package_items;
CREATE POLICY "Users can view items in their tenant packages" ON public.package_items AS PERMISSIVE FOR SELECT TO public
  USING ((tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text)))));

DROP POLICY IF EXISTS "Users can view items of visible packages" ON public.package_items;
CREATE POLICY "Users can view items of visible packages" ON public.package_items AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM business_packages bp
  WHERE ((bp.id = package_items.package_id) AND ((bp.status = 'published'::text) OR (bp.creator_id = auth.uid()))))));

DROP POLICY IF EXISTS "Creators can view purchases of their packages" ON public.package_purchases;
CREATE POLICY "Creators can view purchases of their packages" ON public.package_purchases AS PERMISSIVE FOR SELECT TO public
  USING (((EXISTS ( SELECT 1
   FROM business_packages bp
  WHERE ((bp.id = package_purchases.package_id) AND (bp.creator_id = auth.uid())))) AND (tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can create purchases in their tenant" ON public.package_purchases;
CREATE POLICY "Users can create purchases in their tenant" ON public.package_purchases AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((auth.uid() = buyer_id) AND (tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can view their own purchases" ON public.package_purchases;
CREATE POLICY "Users can view their own purchases" ON public.package_purchases AS PERMISSIVE FOR SELECT TO public
  USING (((buyer_id = auth.uid()) AND (tenant_id IN ( SELECT memberships.tenant_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::text))))));

DROP POLICY IF EXISTS "Admins can manage assignments" ON public.patient_provider_assignments;
CREATE POLICY "Admins can manage assignments" ON public.patient_provider_assignments AS PERMISSIVE FOR ALL TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = patient_provider_assignments.tenant_id) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS "Providers can view their assignments" ON public.patient_provider_assignments;
CREATE POLICY "Providers can view their assignments" ON public.patient_provider_assignments AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = provider_id) OR (auth.uid() = patient_id) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Admins can manage pattern discoveries" ON public.pattern_discoveries;
CREATE POLICY "Admins can manage pattern discoveries" ON public.pattern_discoveries AS PERMISSIVE FOR ALL TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = pattern_discoveries.tenant_id) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS paywall_events_read_own ON public.paywall_events;
CREATE POLICY paywall_events_read_own ON public.paywall_events AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS paywall_events_svc_full ON public.paywall_events;
CREATE POLICY paywall_events_svc_full ON public.paywall_events AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS pending_actions_select_own ON public.pending_connector_actions;
CREATE POLICY pending_actions_select_own ON public.pending_connector_actions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS pending_actions_service ON public.pending_connector_actions;
CREATE POLICY pending_actions_service ON public.pending_connector_actions AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS pending_actions_update_own ON public.pending_connector_actions;
CREATE POLICY pending_actions_update_own ON public.pending_connector_actions AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can insert own logs" ON public.plan_adherence_logs;
CREATE POLICY "Users can insert own logs" ON public.plan_adherence_logs AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view own logs" ON public.plan_adherence_logs;
CREATE POLICY "Users can view own logs" ON public.plan_adherence_logs AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete their own favorites" ON public.podcast_favorites;
CREATE POLICY "Users can delete their own favorites" ON public.podcast_favorites AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can insert their own favorites" ON public.podcast_favorites;
CREATE POLICY "Users can insert their own favorites" ON public.podcast_favorites AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own favorites" ON public.podcast_favorites;
CREATE POLICY "Users can view their own favorites" ON public.podcast_favorites AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage metadata for their media" ON public.podcast_metadata;
CREATE POLICY "Users can manage metadata for their media" ON public.podcast_metadata AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = podcast_metadata.media_id) AND (m.user_id = auth.uid())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = podcast_metadata.media_id) AND (m.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can view metadata for accessible media" ON public.podcast_metadata;
CREATE POLICY "Users can view metadata for accessible media" ON public.podcast_metadata AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = podcast_metadata.media_id) AND (((m.status = 'approved'::text) AND (m.is_public = true)) OR (m.user_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM memberships mb
          WHERE ((mb.user_id = auth.uid()) AND (mb.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (mb.status = 'active'::text)))))))));

DROP POLICY IF EXISTS "Users can create own subscriptions" ON public.podcast_show_subscriptions;
CREATE POLICY "Users can create own subscriptions" ON public.podcast_show_subscriptions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete own subscriptions" ON public.podcast_show_subscriptions;
CREATE POLICY "Users can delete own subscriptions" ON public.podcast_show_subscriptions AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view own subscriptions" ON public.podcast_show_subscriptions;
CREATE POLICY "Users can view own subscriptions" ON public.podcast_show_subscriptions AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS policy_render_block_tenant_read ON public.policy_render_block;
CREATE POLICY policy_render_block_tenant_read ON public.policy_render_block AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id IS NULL) OR (tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can insert their own post analytics" ON public.post_analytics;
CREATE POLICY "Users can insert their own post analytics" ON public.post_analytics AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own post analytics" ON public.post_analytics;
CREATE POLICY "Users can update their own post analytics" ON public.post_analytics AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own post analytics" ON public.post_analytics;
CREATE POLICY "Users can view their own post analytics" ON public.post_analytics AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "System can manage context cache" ON public.proactive_context_cache;
CREATE POLICY "System can manage context cache" ON public.proactive_context_cache AS PERMISSIVE FOR ALL TO public
  USING (true);

DROP POLICY IF EXISTS "Users can view their own context cache" ON public.proactive_context_cache;
CREATE POLICY "Users can view their own context cache" ON public.proactive_context_cache AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can create engagement records" ON public.proactive_engagement;
CREATE POLICY "Users can create engagement records" ON public.proactive_engagement AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own engagement" ON public.proactive_engagement;
CREATE POLICY "Users can view their own engagement" ON public.proactive_engagement AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS processed_stripe_events_svc_full ON public.processed_stripe_events;
CREATE POLICY processed_stripe_events_svc_full ON public.processed_stripe_events AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "service role can manage product analytics rollups" ON public.product_analytics_daily_rollups;
CREATE POLICY "service role can manage product analytics rollups" ON public.product_analytics_daily_rollups AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "service role can manage product analytics events" ON public.product_analytics_events;
CREATE POLICY "service role can manage product analytics events" ON public.product_analytics_events AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS product_clicks_select_own ON public.product_clicks;
CREATE POLICY product_clicks_select_own ON public.product_clicks AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id IS NULL) OR (user_id = auth.uid())));

DROP POLICY IF EXISTS product_clicks_service ON public.product_clicks;
CREATE POLICY product_clicks_service ON public.product_clicks AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS product_orders_select_own ON public.product_orders;
CREATE POLICY product_orders_select_own ON public.product_orders AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS product_orders_service ON public.product_orders;
CREATE POLICY product_orders_service ON public.product_orders AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS product_outcomes_insert_own ON public.product_outcomes;
CREATE POLICY product_outcomes_insert_own ON public.product_outcomes AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS product_outcomes_select_own ON public.product_outcomes;
CREATE POLICY product_outcomes_select_own ON public.product_outcomes AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS product_outcomes_service ON public.product_outcomes;
CREATE POLICY product_outcomes_service ON public.product_outcomes AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS product_recommendations_owner_insert ON public.product_recommendations;
CREATE POLICY product_recommendations_owner_insert ON public.product_recommendations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS product_recommendations_owner_select ON public.product_recommendations;
CREATE POLICY product_recommendations_owner_select ON public.product_recommendations AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS product_recommendations_service_role ON public.product_recommendations;
CREATE POLICY product_recommendations_service_role ON public.product_recommendations AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS products_service ON public.products;
CREATE POLICY products_service ON public.products AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS products_catalog_insert ON public.products_catalog;
CREATE POLICY products_catalog_insert ON public.products_catalog AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS products_catalog_select ON public.products_catalog;
CREATE POLICY products_catalog_select ON public.products_catalog AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS "Users can delete own gallery photos" ON public.profile_gallery;
CREATE POLICY "Users can delete own gallery photos" ON public.profile_gallery AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update own gallery photos" ON public.profile_gallery;
CREATE POLICY "Users can update own gallery photos" ON public.profile_gallery AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can upload own gallery photos" ON public.profile_gallery;
CREATE POLICY "Users can upload own gallery photos" ON public.profile_gallery AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view own gallery photos" ON public.profile_gallery;
CREATE POLICY "Users can view own gallery photos" ON public.profile_gallery AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view public gallery photos" ON public.profile_gallery;
CREATE POLICY "Users can view public gallery photos" ON public.profile_gallery AS PERMISSIVE FOR SELECT TO public
  USING ((is_public = true));

DROP POLICY IF EXISTS "Users can create own milestones" ON public.profile_milestones;
CREATE POLICY "Users can create own milestones" ON public.profile_milestones AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete own milestones" ON public.profile_milestones;
CREATE POLICY "Users can delete own milestones" ON public.profile_milestones AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update own milestones" ON public.profile_milestones;
CREATE POLICY "Users can update own milestones" ON public.profile_milestones AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view own milestones" ON public.profile_milestones;
CREATE POLICY "Users can view own milestones" ON public.profile_milestones AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view public milestones" ON public.profile_milestones;
CREATE POLICY "Users can view public milestones" ON public.profile_milestones AS PERMISSIVE FOR SELECT TO public
  USING ((is_public = true));

DROP POLICY IF EXISTS "Users can create comments" ON public.profile_post_comments;
CREATE POLICY "Users can create comments" ON public.profile_post_comments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete own comments" ON public.profile_post_comments;
CREATE POLICY "Users can delete own comments" ON public.profile_post_comments AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update own comments" ON public.profile_post_comments;
CREATE POLICY "Users can update own comments" ON public.profile_post_comments AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view all comments" ON public.profile_post_comments;
CREATE POLICY "Users can view all comments" ON public.profile_post_comments AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS "Users can like posts" ON public.profile_post_likes;
CREATE POLICY "Users can like posts" ON public.profile_post_likes AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can unlike posts" ON public.profile_post_likes;
CREATE POLICY "Users can unlike posts" ON public.profile_post_likes AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view all likes" ON public.profile_post_likes;
CREATE POLICY "Users can view all likes" ON public.profile_post_likes AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS "Moderators can view all posts" ON public.profile_posts;
CREATE POLICY "Moderators can view all posts" ON public.profile_posts AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_community_moderator());

DROP POLICY IF EXISTS "Public posts are viewable by everyone" ON public.profile_posts;
CREATE POLICY "Public posts are viewable by everyone" ON public.profile_posts AS PERMISSIVE FOR SELECT TO public
  USING ((is_public = true));

DROP POLICY IF EXISTS "Users can create their own posts" ON public.profile_posts;
CREATE POLICY "Users can create their own posts" ON public.profile_posts AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete their own posts" ON public.profile_posts;
CREATE POLICY "Users can delete their own posts" ON public.profile_posts AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own posts" ON public.profile_posts;
CREATE POLICY "Users can update their own posts" ON public.profile_posts AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own posts" ON public.profile_posts;
CREATE POLICY "Users can view their own posts" ON public.profile_posts AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users manage own privacy settings" ON public.profile_privacy_settings;
CREATE POLICY "Users manage own privacy settings" ON public.profile_privacy_settings AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Admins can manage all profiles" ON public.profiles;
CREATE POLICY "Admins can manage all profiles" ON public.profiles AS PERMISSIVE FOR ALL TO public
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true))
  WITH CHECK (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true));

DROP POLICY IF EXISTS "Authenticated users can view profiles" ON public.profiles;
CREATE POLICY "Authenticated users can view profiles" ON public.profiles AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Strict medical data access via assignments" ON public.profiles;
CREATE POLICY "Strict medical data access via assignments" ON public.profiles AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = user_id) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM patient_provider_assignments ppa
  WHERE ((ppa.patient_id = profiles.user_id) AND (ppa.provider_id = auth.uid()) AND (ppa.status = 'active'::text) AND ((ppa.expires_at IS NULL) OR (ppa.expires_at > now()))))) OR (EXISTS ( SELECT 1
   FROM (memberships m1
     JOIN memberships m2 ON ((m1.tenant_id = m2.tenant_id)))
  WHERE ((m1.user_id = auth.uid()) AND (m1.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (m1.status = 'active'::text) AND (m2.user_id = profiles.user_id) AND (m2.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can create their own profile" ON public.profiles;
CREATE POLICY "Users can create their own profile" ON public.profiles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile" ON public.profiles AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;
CREATE POLICY "Users can view their own profile" ON public.profiles AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = user_id) OR ((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true) OR (EXISTS ( SELECT 1
   FROM memberships m1,
    memberships m2
  WHERE ((m1.user_id = auth.uid()) AND (m1.role = ANY (ARRAY['professional'::tenant_role, 'staff'::tenant_role, 'admin'::tenant_role])) AND (m1.status = 'active'::text) AND (m2.user_id = profiles.user_id) AND (m1.tenant_id = m2.tenant_id))))));

DROP POLICY IF EXISTS "Authenticated read access" ON public.projection_offsets;
CREATE POLICY "Authenticated read access" ON public.projection_offsets AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Service role full access" ON public.projection_offsets;
CREATE POLICY "Service role full access" ON public.projection_offsets AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS provider_read ON public.provider;
CREATE POLICY provider_read ON public.provider AS PERMISSIVE FOR SELECT TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text, 'developer'::text])));

DROP POLICY IF EXISTS provider_write ON public.provider;
CREATE POLICY provider_write ON public.provider AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = 'admin'::text))
  WITH CHECK ((vcaop_role() = 'admin'::text));

DROP POLICY IF EXISTS provider_account_staff_rw ON public.provider_account;
CREATE POLICY provider_account_staff_rw ON public.provider_account AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])))
  WITH CHECK ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS "Users can manage their own appointments" ON public.provider_appointments;
CREATE POLICY "Users can manage their own appointments" ON public.provider_appointments AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage their own provider notes" ON public.provider_notes;
CREATE POLICY "Users can manage their own provider notes" ON public.provider_notes AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS provisioning_job_staff_rw ON public.provisioning_job;
CREATE POLICY provisioning_job_staff_rw ON public.provisioning_job AS PERMISSIVE FOR ALL TO public
  USING ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])))
  WITH CHECK ((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])));

DROP POLICY IF EXISTS "Users can manage their own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can manage their own push subscriptions" ON public.push_subscriptions AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS recommendation_commissions_owner_select ON public.recommendation_commissions;
CREATE POLICY recommendation_commissions_owner_select ON public.recommendation_commissions AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = recommender_user_id));

DROP POLICY IF EXISTS recommendation_commissions_service_role ON public.recommendation_commissions;
CREATE POLICY recommendation_commissions_service_role ON public.recommendation_commissions AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Admins can view deployments" ON public.recommendation_deployments;
CREATE POLICY "Admins can view deployments" ON public.recommendation_deployments AS PERMISSIVE FOR SELECT TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM (ai_recommendations r
     JOIN memberships m ON ((m.tenant_id = r.tenant_id)))
  WHERE ((r.id = recommendation_deployments.recommendation_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS "System can manage deployments" ON public.recommendation_deployments;
CREATE POLICY "System can manage deployments" ON public.recommendation_deployments AS PERMISSIVE FOR ALL TO public
  USING (true);

DROP POLICY IF EXISTS recommendations_delete ON public.recommendations;
CREATE POLICY recommendations_delete ON public.recommendations AS PERMISSIVE FOR DELETE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS recommendations_insert ON public.recommendations;
CREATE POLICY recommendations_insert ON public.recommendations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS recommendations_select ON public.recommendations;
CREATE POLICY recommendations_select ON public.recommendations AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS recommendations_update ON public.recommendations;
CREATE POLICY recommendations_update ON public.recommendations AS PERMISSIVE FOR UPDATE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS redemption_codes_svc_full ON public.redemption_codes;
CREATE POLICY redemption_codes_svc_full ON public.redemption_codes AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS redemption_redemptions_read_own ON public.redemption_redemptions;
CREATE POLICY redemption_redemptions_read_own ON public.redemption_redemptions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS redemption_redemptions_svc_full ON public.redemption_redemptions;
CREATE POLICY redemption_redemptions_svc_full ON public.redemption_redemptions AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manage referrals" ON public.referrals;
CREATE POLICY "Service role manage referrals" ON public.referrals AS PERMISSIVE FOR ALL TO public
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own referrals" ON public.referrals;
CREATE POLICY "Users read own referrals" ON public.referrals AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = referrer_id) OR (auth.uid() = referred_id)));

DROP POLICY IF EXISTS relationship_dates_tenant_user_select ON public.relationship_dates;
CREATE POLICY relationship_dates_tenant_user_select ON public.relationship_dates AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS admin_read_all_relationship_edges ON public.relationship_edges;
CREATE POLICY admin_read_all_relationship_edges ON public.relationship_edges AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS relationship_edges_select ON public.relationship_edges;
CREATE POLICY relationship_edges_select ON public.relationship_edges AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS relationship_edges_service_role ON public.relationship_edges;
CREATE POLICY relationship_edges_service_role ON public.relationship_edges AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS relationship_health_context_tenant_user_select ON public.relationship_health_context;
CREATE POLICY relationship_health_context_tenant_user_select ON public.relationship_health_context AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS admin_read_all_relationship_nodes ON public.relationship_nodes;
CREATE POLICY admin_read_all_relationship_nodes ON public.relationship_nodes AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS relationship_nodes_service_role ON public.relationship_nodes;
CREATE POLICY relationship_nodes_service_role ON public.relationship_nodes AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS reminders_owner_delete ON public.reminders;
CREATE POLICY reminders_owner_delete ON public.reminders AS PERMISSIVE FOR DELETE TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS reminders_owner_insert ON public.reminders;
CREATE POLICY reminders_owner_insert ON public.reminders AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS reminders_owner_select ON public.reminders;
CREATE POLICY reminders_owner_select ON public.reminders AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS reminders_owner_update ON public.reminders;
CREATE POLICY reminders_owner_update ON public.reminders AS PERMISSIVE FOR UPDATE TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS admin_view_attributions ON public.reseller_attributions;
CREATE POLICY admin_view_attributions ON public.reseller_attributions AS PERMISSIVE FOR SELECT TO authenticated
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM (reseller_profiles rp
     JOIN memberships m ON ((m.tenant_id = rp.tenant_id)))
  WHERE ((rp.id = reseller_attributions.reseller_id) AND (m.user_id = auth.uid()) AND (m.role = 'admin'::tenant_role) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS reseller_read_own_attributions ON public.reseller_attributions;
CREATE POLICY reseller_read_own_attributions ON public.reseller_attributions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM reseller_profiles rp
  WHERE ((rp.id = reseller_attributions.reseller_id) AND (rp.user_id = auth.uid())))));

DROP POLICY IF EXISTS system_insert_attributions ON public.reseller_attributions;
CREATE POLICY system_insert_attributions ON public.reseller_attributions AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Resellers can view their own payouts" ON public.reseller_payouts;
CREATE POLICY "Resellers can view their own payouts" ON public.reseller_payouts AS PERMISSIVE FOR SELECT TO public
  USING ((reseller_profile_id IN ( SELECT reseller_profiles.id
   FROM reseller_profiles
  WHERE (reseller_profiles.user_id = auth.uid()))));

DROP POLICY IF EXISTS "Service role can manage payouts" ON public.reseller_payouts;
CREATE POLICY "Service role can manage payouts" ON public.reseller_payouts AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can request their own payouts" ON public.reseller_payouts;
CREATE POLICY "Users can request their own payouts" ON public.reseller_payouts AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((reseller_profile_id IN ( SELECT reseller_profiles.id
   FROM reseller_profiles
  WHERE (reseller_profiles.user_id = auth.uid()))));

DROP POLICY IF EXISTS admin_manage_resellers ON public.reseller_profiles;
CREATE POLICY admin_manage_resellers ON public.reseller_profiles AS PERMISSIVE FOR ALL TO authenticated
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = reseller_profiles.tenant_id) AND (m.role = 'admin'::tenant_role) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS reseller_read_own_profile ON public.reseller_profiles;
CREATE POLICY reseller_read_own_profile ON public.reseller_profiles AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS retrieval_traces_admin_read ON public.retrieval_traces;
CREATE POLICY retrieval_traces_admin_read ON public.retrieval_traces AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND is_platform_admin()));

DROP POLICY IF EXISTS retrieval_traces_owner_read ON public.retrieval_traces;
CREATE POLICY retrieval_traces_owner_read ON public.retrieval_traces AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (actor_user_id = auth.uid())));

DROP POLICY IF EXISTS rewards_ledger_owner_rw ON public.rewards_ledger;
CREATE POLICY rewards_ledger_owner_rw ON public.rewards_ledger AS PERMISSIVE FOR ALL TO public
  USING (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (user_id = vcaop_uid())))
  WITH CHECK (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (user_id = vcaop_uid())));

DROP POLICY IF EXISTS rp_delete_self ON public.role_preferences;
CREATE POLICY rp_delete_self ON public.role_preferences AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS rp_select_self ON public.role_preferences;
CREATE POLICY rp_select_self ON public.role_preferences AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS rp_update_self ON public.role_preferences;
CREATE POLICY rp_update_self ON public.role_preferences AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS rp_upsert_self ON public.role_preferences;
CREATE POLICY rp_upsert_self ON public.role_preferences AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS role_sessions_admin_read ON public.role_sessions;
CREATE POLICY role_sessions_admin_read ON public.role_sessions AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND is_platform_admin()));

DROP POLICY IF EXISTS role_sessions_owner_read ON public.role_sessions;
CREATE POLICY role_sessions_owner_read ON public.role_sessions AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS role_sessions_owner_update ON public.role_sessions;
CREATE POLICY role_sessions_owner_update ON public.role_sessions AS PERMISSIVE FOR UPDATE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS role_sessions_owner_write ON public.role_sessions;
CREATE POLICY role_sessions_owner_write ON public.role_sessions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS safety_constraints_delete ON public.safety_constraints;
CREATE POLICY safety_constraints_delete ON public.safety_constraints AS PERMISSIVE FOR DELETE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS safety_constraints_insert ON public.safety_constraints;
CREATE POLICY safety_constraints_insert ON public.safety_constraints AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS safety_constraints_select ON public.safety_constraints;
CREATE POLICY safety_constraints_select ON public.safety_constraints AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS safety_constraints_update ON public.safety_constraints;
CREATE POLICY safety_constraints_update ON public.safety_constraints AS PERMISSIVE FOR UPDATE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS "Users can create their own scheduled posts" ON public.scheduled_posts;
CREATE POLICY "Users can create their own scheduled posts" ON public.scheduled_posts AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own scheduled posts" ON public.scheduled_posts;
CREATE POLICY "Users can update their own scheduled posts" ON public.scheduled_posts AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own scheduled posts" ON public.scheduled_posts;
CREATE POLICY "Users can view their own scheduled posts" ON public.scheduled_posts AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Admins view search audit" ON public.search_audit_log;
CREATE POLICY "Admins view search audit" ON public.search_audit_log AS PERMISSIVE FOR SELECT TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role])) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS service_role_full_access_healing_log ON public.self_healing_log;
CREATE POLICY service_role_full_access_healing_log ON public.self_healing_log AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS service_role_full_access_snapshots ON public.self_healing_snapshots;
CREATE POLICY service_role_full_access_snapshots ON public.self_healing_snapshots AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS services_catalog_insert ON public.services_catalog;
CREATE POLICY services_catalog_insert ON public.services_catalog AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS services_catalog_select ON public.services_catalog;
CREATE POLICY services_catalog_select ON public.services_catalog AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS "Service role manage sharing links" ON public.sharing_links;
CREATE POLICY "Service role manage sharing links" ON public.sharing_links AS PERMISSIVE FOR ALL TO public
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own sharing links" ON public.sharing_links;
CREATE POLICY "Users read own sharing links" ON public.sharing_links AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS shop_saved_products_delete_own ON public.shop_saved_products;
CREATE POLICY shop_saved_products_delete_own ON public.shop_saved_products AS PERMISSIVE FOR DELETE TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS shop_saved_products_insert_own ON public.shop_saved_products;
CREATE POLICY shop_saved_products_insert_own ON public.shop_saved_products AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS shop_saved_products_select_own ON public.shop_saved_products;
CREATE POLICY shop_saved_products_select_own ON public.shop_saved_products AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS shop_video_anchors_select_via_video ON public.shop_video_anchors;
CREATE POLICY shop_video_anchors_select_via_video ON public.shop_video_anchors AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM shop_videos v
  WHERE ((v.id = shop_video_anchors.video_id) AND (v.status = 'active'::text) AND (v.moderation_status = 'approved'::text)))));

DROP POLICY IF EXISTS shop_videos_select_live ON public.shop_videos;
CREATE POLICY shop_videos_select_live ON public.shop_videos AS PERMISSIVE FOR SELECT TO authenticated
  USING (((status = 'active'::text) AND (moderation_status = 'approved'::text)));

DROP POLICY IF EXISTS admin_read_all_signup_attempts ON public.signup_attempts;
CREATE POLICY admin_read_all_signup_attempts ON public.signup_attempts AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS service_role_full_access_signup_attempts ON public.signup_attempts;
CREATE POLICY service_role_full_access_signup_attempts ON public.signup_attempts AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access" ON public.skills_mcp;
CREATE POLICY "Service role full access" ON public.skills_mcp AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS social_connections_service ON public.social_connections;
CREATE POLICY social_connections_service ON public.social_connections AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS social_connections_user_policy ON public.social_connections;
CREATE POLICY social_connections_user_policy ON public.social_connections AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS social_share_log_service ON public.social_share_log;
CREATE POLICY social_share_log_service ON public.social_share_log AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS social_share_log_user_policy ON public.social_share_log;
CREATE POLICY social_share_log_user_policy ON public.social_share_log AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS social_share_prefs_service ON public.social_share_prefs;
CREATE POLICY social_share_prefs_service ON public.social_share_prefs AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS social_share_prefs_user_policy ON public.social_share_prefs;
CREATE POLICY social_share_prefs_user_policy ON public.social_share_prefs AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS p_software_versions_delete ON public.software_versions;
CREATE POLICY p_software_versions_delete ON public.software_versions AS PERMISSIVE FOR DELETE TO public
  USING (false);

DROP POLICY IF EXISTS p_software_versions_insert ON public.software_versions;
CREATE POLICY p_software_versions_insert ON public.software_versions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((current_setting('request.jwt.claim.role'::text, true) = 'service_role'::text) OR (current_setting('role'::text, true) = 'service_role'::text) OR (auth.role() = 'service_role'::text)));

DROP POLICY IF EXISTS p_software_versions_select ON public.software_versions;
CREATE POLICY p_software_versions_select ON public.software_versions AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS p_software_versions_update ON public.software_versions;
CREATE POLICY p_software_versions_update ON public.software_versions AS PERMISSIVE FOR UPDATE TO public
  USING (false);

DROP POLICY IF EXISTS "Stream hosts can insert recordings" ON public.stream_recordings;
CREATE POLICY "Stream hosts can insert recordings" ON public.stream_recordings AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM community_live_streams cls
  WHERE ((cls.id = stream_recordings.stream_id) AND (cls.created_by = auth.uid())))));

DROP POLICY IF EXISTS "Users can view recordings of accessible streams" ON public.stream_recordings;
CREATE POLICY "Users can view recordings of accessible streams" ON public.stream_recordings AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM community_live_streams cls
  WHERE ((cls.id = stream_recordings.stream_id) AND ((cls.access_level = 'public'::text) OR (cls.created_by = auth.uid()) OR ((auth.uid())::text = ANY (cls.co_hosts)))))));

DROP POLICY IF EXISTS subscription_plan_prices_read_all ON public.subscription_plan_prices;
CREATE POLICY subscription_plan_prices_read_all ON public.subscription_plan_prices AS PERMISSIVE FOR SELECT TO anon, authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS subscription_plan_prices_svc_full ON public.subscription_plan_prices;
CREATE POLICY subscription_plan_prices_svc_full ON public.subscription_plan_prices AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS subscription_plans_read_all ON public.subscription_plans;
CREATE POLICY subscription_plans_read_all ON public.subscription_plans AS PERMISSIVE FOR SELECT TO anon, authenticated
  USING ((is_active = true));

DROP POLICY IF EXISTS subscription_plans_svc_full ON public.subscription_plans;
CREATE POLICY subscription_plans_svc_full ON public.subscription_plans AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can view active supplements" ON public.supplements;
CREATE POLICY "Anyone can view active supplements" ON public.supplements AS PERMISSIVE FOR SELECT TO public
  USING ((is_active = true));

DROP POLICY IF EXISTS supported_locales_read ON public.supported_locales;
CREATE POLICY supported_locales_read ON public.supported_locales AS PERMISSIVE FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS system_capabilities_authenticated_read ON public.system_capabilities;
CREATE POLICY system_capabilities_authenticated_read ON public.system_capabilities AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS service_role_full_access_config ON public.system_config;
CREATE POLICY service_role_full_access_config ON public.system_config AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS authenticated_read_system_control_audit ON public.system_control_audit;
CREATE POLICY authenticated_read_system_control_audit ON public.system_control_audit AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS service_role_system_control_audit ON public.system_control_audit;
CREATE POLICY service_role_system_control_audit ON public.system_control_audit AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS admin_read_all_system_controls ON public.system_controls;
CREATE POLICY admin_read_all_system_controls ON public.system_controls AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS authenticated_read_system_controls ON public.system_controls;
CREATE POLICY authenticated_read_system_controls ON public.system_controls AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS service_role_system_controls ON public.system_controls;
CREATE POLICY service_role_system_controls ON public.system_controls AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS teacher_capability_refresh_schedule_owner_read ON public.teacher_capability_refresh_schedule;
CREATE POLICY teacher_capability_refresh_schedule_owner_read ON public.teacher_capability_refresh_schedule AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can manage their own templates" ON public.templates;
CREATE POLICY "Users can manage their own templates" ON public.templates AS PERMISSIVE FOR ALL TO public
  USING (((auth.uid() = user_id) OR (is_public = true)))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS service_all ON public.tenant_admin_audit_log;
CREATE POLICY service_all ON public.tenant_admin_audit_log AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_all ON public.tenant_assistant_config;
CREATE POLICY service_all ON public.tenant_assistant_config AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_full_access_bindings ON public.tenant_autopilot_bindings;
CREATE POLICY service_full_access_bindings ON public.tenant_autopilot_bindings AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_read_bindings ON public.tenant_autopilot_bindings;
CREATE POLICY tenant_read_bindings ON public.tenant_autopilot_bindings AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))));

DROP POLICY IF EXISTS service_full_access_runs ON public.tenant_autopilot_runs;
CREATE POLICY service_full_access_runs ON public.tenant_autopilot_runs AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_read_runs ON public.tenant_autopilot_runs;
CREATE POLICY tenant_read_runs ON public.tenant_autopilot_runs AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))));

DROP POLICY IF EXISTS service_full_access_settings ON public.tenant_autopilot_settings;
CREATE POLICY service_full_access_settings ON public.tenant_autopilot_settings AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_read_settings ON public.tenant_autopilot_settings;
CREATE POLICY tenant_read_settings ON public.tenant_autopilot_settings AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))));

DROP POLICY IF EXISTS tenant_catalog_overrides_select ON public.tenant_catalog_overrides;
CREATE POLICY tenant_catalog_overrides_select ON public.tenant_catalog_overrides AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS tenant_catalog_overrides_service ON public.tenant_catalog_overrides;
CREATE POLICY tenant_catalog_overrides_service ON public.tenant_catalog_overrides AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON public.tenant_health_index_daily;
CREATE POLICY service_role_all ON public.tenant_health_index_daily AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_all ON public.tenant_invitations;
CREATE POLICY service_all ON public.tenant_invitations AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_all ON public.tenant_kb_baseline_optouts;
CREATE POLICY service_all ON public.tenant_kb_baseline_optouts AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_kpi_current_self_read ON public.tenant_kpi_current;
CREATE POLICY tenant_kpi_current_self_read ON public.tenant_kpi_current AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id IN ( SELECT ut.tenant_id
   FROM user_tenants ut
  WHERE ((ut.user_id = auth.uid()) AND (ut.active_role = ANY (ARRAY['admin'::text, 'developer'::text, 'infra'::text]))))));

DROP POLICY IF EXISTS tenant_kpi_current_service ON public.tenant_kpi_current;
CREATE POLICY tenant_kpi_current_service ON public.tenant_kpi_current AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_kpi_daily_self_read ON public.tenant_kpi_daily;
CREATE POLICY tenant_kpi_daily_self_read ON public.tenant_kpi_daily AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id IN ( SELECT ut.tenant_id
   FROM user_tenants ut
  WHERE ((ut.user_id = auth.uid()) AND (ut.active_role = ANY (ARRAY['admin'::text, 'developer'::text, 'infra'::text]))))));

DROP POLICY IF EXISTS tenant_kpi_daily_service ON public.tenant_kpi_daily;
CREATE POLICY tenant_kpi_daily_service ON public.tenant_kpi_daily AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS service_all ON public.tenant_settings;
CREATE POLICY service_all ON public.tenant_settings AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tenants_all_service_role ON public.tenants;
CREATE POLICY tenants_all_service_role ON public.tenants AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tenants_cud_exafy_only ON public.tenants;
CREATE POLICY tenants_cud_exafy_only ON public.tenants AS PERMISSIVE FOR ALL TO public
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true))
  WITH CHECK (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true));

DROP POLICY IF EXISTS tenants_read ON public.tenants;
CREATE POLICY tenants_read ON public.tenants AS PERMISSIVE FOR SELECT TO public
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS tenants_select_any_member ON public.tenants;
CREATE POLICY tenants_select_any_member ON public.tenants AS PERMISSIVE FOR SELECT TO public
  USING ((((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.tenant_id = tenants.tenant_id) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS tenants_select_authenticated ON public.tenants;
CREATE POLICY tenants_select_authenticated ON public.tenants AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS anon_can_apply ON public.test_user_applications;
CREATE POLICY anon_can_apply ON public.test_user_applications AS PERMISSIVE FOR INSERT TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can join threads as themselves" ON public.thread_participants;
CREATE POLICY "Users can join threads as themselves" ON public.thread_participants AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can update their own participation" ON public.thread_participants;
CREATE POLICY "Users can update their own participation" ON public.thread_participants AS PERMISSIVE FOR UPDATE TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can view thread participants" ON public.thread_participants;
CREATE POLICY "Users can view thread participants" ON public.thread_participants AS PERMISSIVE FOR SELECT TO public
  USING (((user_id = auth.uid()) OR (COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true)));

DROP POLICY IF EXISTS "Users can manage their own thread presence" ON public.thread_presence;
CREATE POLICY "Users can manage their own thread presence" ON public.thread_presence AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS thread_summaries_tenant_user_isolation ON public.thread_summaries;
CREATE POLICY thread_summaries_tenant_user_isolation ON public.thread_summaries AS PERMISSIVE FOR ALL TO public
  USING (((tenant_id = COALESCE((current_setting('app.tenant_id'::text, true))::uuid, '00000000-0000-0000-0000-000000000000'::uuid)) AND (user_id = COALESCE((current_setting('app.user_id'::text, true))::uuid, '00000000-0000-0000-0000-000000000000'::uuid))));

DROP POLICY IF EXISTS "Users can manage their own typing indicators" ON public.typing_indicators;
CREATE POLICY "Users can manage their own typing indicators" ON public.typing_indicators AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view typing indicators in their tenant threads" ON public.typing_indicators;
CREATE POLICY "Users can view typing indicators in their tenant threads" ON public.typing_indicators AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM thread_participants
  WHERE ((thread_participants.thread_id = typing_indicators.thread_id) AND (thread_participants.user_id = auth.uid()) AND (thread_participants.is_active = true)))));

DROP POLICY IF EXISTS universal_cart_events_select_via_cart ON public.universal_cart_events;
CREATE POLICY universal_cart_events_select_via_cart ON public.universal_cart_events AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM universal_carts c
  WHERE ((c.id = universal_cart_events.cart_id) AND (c.user_id = auth.uid())))));

DROP POLICY IF EXISTS universal_cart_items_delete_via_cart ON public.universal_cart_items;
CREATE POLICY universal_cart_items_delete_via_cart ON public.universal_cart_items AS PERMISSIVE FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM universal_carts c
  WHERE ((c.id = universal_cart_items.cart_id) AND (c.user_id = auth.uid())))));

DROP POLICY IF EXISTS universal_cart_items_insert_via_cart ON public.universal_cart_items;
CREATE POLICY universal_cart_items_insert_via_cart ON public.universal_cart_items AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1
   FROM universal_carts c
  WHERE ((c.id = universal_cart_items.cart_id) AND (c.user_id = auth.uid())))));

DROP POLICY IF EXISTS universal_cart_items_select_via_cart ON public.universal_cart_items;
CREATE POLICY universal_cart_items_select_via_cart ON public.universal_cart_items AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM universal_carts c
  WHERE ((c.id = universal_cart_items.cart_id) AND (c.user_id = auth.uid())))));

DROP POLICY IF EXISTS universal_cart_items_update_via_cart ON public.universal_cart_items;
CREATE POLICY universal_cart_items_update_via_cart ON public.universal_cart_items AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM universal_carts c
  WHERE ((c.id = universal_cart_items.cart_id) AND (c.user_id = auth.uid())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM universal_carts c
  WHERE ((c.id = universal_cart_items.cart_id) AND (c.user_id = auth.uid())))));

DROP POLICY IF EXISTS universal_carts_delete_own ON public.universal_carts;
CREATE POLICY universal_carts_delete_own ON public.universal_carts AS PERMISSIVE FOR DELETE TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS universal_carts_insert_own ON public.universal_carts;
CREATE POLICY universal_carts_insert_own ON public.universal_carts AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS universal_carts_select_own ON public.universal_carts;
CREATE POLICY universal_carts_select_own ON public.universal_carts AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS universal_carts_update_own ON public.universal_carts;
CREATE POLICY universal_carts_update_own ON public.universal_carts AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS usage_outcomes_insert ON public.usage_outcomes;
CREATE POLICY usage_outcomes_insert ON public.usage_outcomes AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS usage_outcomes_select ON public.usage_outcomes;
CREATE POLICY usage_outcomes_select ON public.usage_outcomes AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS user_action_permissions_select_own ON public.user_action_permissions;
CREATE POLICY user_action_permissions_select_own ON public.user_action_permissions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_action_permissions_service ON public.user_action_permissions;
CREATE POLICY user_action_permissions_service ON public.user_action_permissions AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS user_action_permissions_update_own ON public.user_action_permissions;
CREATE POLICY user_action_permissions_update_own ON public.user_action_permissions AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_active_days_self_read ON public.user_active_days;
CREATE POLICY user_active_days_self_read ON public.user_active_days AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_active_role_self_rw ON public.user_active_role;
CREATE POLICY user_active_role_self_rw ON public.user_active_role AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_active_roles_insert ON public.user_active_roles;
CREATE POLICY user_active_roles_insert ON public.user_active_roles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_active_roles_select ON public.user_active_roles;
CREATE POLICY user_active_roles_select ON public.user_active_roles AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_active_roles_update ON public.user_active_roles;
CREATE POLICY user_active_roles_update ON public.user_active_roles AS PERMISSIVE FOR UPDATE TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can delete their own activity logs" ON public.user_activity_log;
CREATE POLICY "Users can delete their own activity logs" ON public.user_activity_log AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can insert their own activity logs" ON public.user_activity_log;
CREATE POLICY "Users can insert their own activity logs" ON public.user_activity_log AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own activity logs" ON public.user_activity_log;
CREATE POLICY "Users can view their own activity logs" ON public.user_activity_log AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own archived logs" ON public.user_activity_log_archive;
CREATE POLICY "Users can view their own archived logs" ON public.user_activity_log_archive AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage their own API keys" ON public.user_api_keys;
CREATE POLICY "Users can manage their own API keys" ON public.user_api_keys AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_assistant_state_tenant_isolation ON public.user_assistant_state;
CREATE POLICY user_assistant_state_tenant_isolation ON public.user_assistant_state AS PERMISSIVE FOR ALL TO authenticated
  USING ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))))
  WITH CHECK ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))));

DROP POLICY IF EXISTS "Users manage own blocked authors" ON public.user_blocked_authors;
CREATE POLICY "Users manage own blocked authors" ON public.user_blocked_authors AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_capability_awareness_tenant_isolation ON public.user_capability_awareness;
CREATE POLICY user_capability_awareness_tenant_isolation ON public.user_capability_awareness AS PERMISSIVE FOR ALL TO authenticated
  USING ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))))
  WITH CHECK ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))));

DROP POLICY IF EXISTS ucp_owner_access ON public.user_capability_preferences;
CREATE POLICY ucp_owner_access ON public.user_capability_preferences AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS ucp_service_role ON public.user_capability_preferences;
CREATE POLICY ucp_service_role ON public.user_capability_preferences AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS users_manage_own_category_prefs ON public.user_category_preferences;
CREATE POLICY users_manage_own_category_prefs ON public.user_category_preferences AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_connections_insert_own ON public.user_connections;
CREATE POLICY user_connections_insert_own ON public.user_connections AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_connections_select_own ON public.user_connections;
CREATE POLICY user_connections_select_own ON public.user_connections AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_connections_service ON public.user_connections;
CREATE POLICY user_connections_service ON public.user_connections AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS user_connections_update_own ON public.user_connections;
CREATE POLICY user_connections_update_own ON public.user_connections AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_consents_service_role ON public.user_consents;
CREATE POLICY user_consents_service_role ON public.user_consents AS PERMISSIVE FOR ALL TO public
  USING ((current_setting('role'::text, true) = 'service_role'::text));

DROP POLICY IF EXISTS user_consents_tenant_isolation ON public.user_consents;
CREATE POLICY user_consents_tenant_isolation ON public.user_consents AS PERMISSIVE FOR ALL TO public
  USING ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid));

DROP POLICY IF EXISTS "System can manage cache" ON public.user_context_cache;
CREATE POLICY "System can manage cache" ON public.user_context_cache AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own cache" ON public.user_context_cache;
CREATE POLICY "Users can view their own cache" ON public.user_context_cache AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_device_session_log_tenant_user_select ON public.user_device_session_log;
CREATE POLICY user_device_session_log_tenant_user_select ON public.user_device_session_log AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS users_manage_own_tokens ON public.user_device_tokens;
CREATE POLICY users_manage_own_tokens ON public.user_device_tokens AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Service role can manage discount codes" ON public.user_discount_codes;
CREATE POLICY "Service role can manage discount codes" ON public.user_discount_codes AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Users can read their own discount codes" ON public.user_discount_codes;
CREATE POLICY "Users can read their own discount codes" ON public.user_discount_codes AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_feature_introductions_self_rw ON public.user_feature_introductions;
CREATE POLICY user_feature_introductions_self_rw ON public.user_feature_introductions AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_feedback_reports_insert_own ON public.user_feedback_reports;
CREATE POLICY user_feedback_reports_insert_own ON public.user_feedback_reports AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_feedback_reports_select_own ON public.user_feedback_reports;
CREATE POLICY user_feedback_reports_select_own ON public.user_feedback_reports AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_feedback_reports_service_role ON public.user_feedback_reports;
CREATE POLICY user_feedback_reports_service_role ON public.user_feedback_reports AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Users can follow others" ON public.user_follows;
CREATE POLICY "Users can follow others" ON public.user_follows AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((auth.uid() = follower_id) AND (follower_id <> following_id)));

DROP POLICY IF EXISTS "Users can unfollow" ON public.user_follows;
CREATE POLICY "Users can unfollow" ON public.user_follows AS PERMISSIVE FOR DELETE TO authenticated
  USING ((auth.uid() = follower_id));

DROP POLICY IF EXISTS "Users can view follow relationships" ON public.user_follows;
CREATE POLICY "Users can view follow relationships" ON public.user_follows AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = follower_id) OR (auth.uid() = following_id) OR true));

DROP POLICY IF EXISTS user_guided_journey_state_self_rw ON public.user_guided_journey_state;
CREATE POLICY user_guided_journey_state_self_rw ON public.user_guided_journey_state AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can delete own plans" ON public.user_health_plans;
CREATE POLICY "Users can delete own plans" ON public.user_health_plans AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can insert own plans" ON public.user_health_plans;
CREATE POLICY "Users can insert own plans" ON public.user_health_plans AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update own plans" ON public.user_health_plans;
CREATE POLICY "Users can update own plans" ON public.user_health_plans AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view own plans" ON public.user_health_plans;
CREATE POLICY "Users can view own plans" ON public.user_health_plans AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users manage own hidden posts" ON public.user_hidden_posts;
CREATE POLICY "Users manage own hidden posts" ON public.user_hidden_posts AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_integrations_owner_all ON public.user_integrations;
CREATE POLICY user_integrations_owner_all ON public.user_integrations AS PERMISSIVE FOR ALL TO public
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS uicl_self_delete ON public.user_intent_cover_library;
CREATE POLICY uicl_self_delete ON public.user_intent_cover_library AS PERMISSIVE FOR DELETE TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS uicl_self_insert ON public.user_intent_cover_library;
CREATE POLICY uicl_self_insert ON public.user_intent_cover_library AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS uicl_self_read ON public.user_intent_cover_library;
CREATE POLICY uicl_self_read ON public.user_intent_cover_library AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS uicl_self_update ON public.user_intent_cover_library;
CREATE POLICY uicl_self_update ON public.user_intent_cover_library AS PERMISSIVE FOR UPDATE TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_intents_owner_all ON public.user_intents;
CREATE POLICY user_intents_owner_all ON public.user_intents AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = requester_user_id))
  WITH CHECK ((auth.uid() = requester_user_id));

DROP POLICY IF EXISTS user_intents_public_read ON public.user_intents;
CREATE POLICY user_intents_public_read ON public.user_intents AS PERMISSIVE FOR SELECT TO public
  USING (((visibility = 'public'::text) AND (status = ANY (ARRAY['open'::text, 'matched'::text, 'engaged'::text])) AND (tenant_id IN ( SELECT m.tenant_id
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS user_intents_tenant_read ON public.user_intents;
CREATE POLICY user_intents_tenant_read ON public.user_intents AS PERMISSIVE FOR SELECT TO public
  USING (((visibility = 'tenant'::text) AND (status = ANY (ARRAY['open'::text, 'matched'::text, 'engaged'::text])) AND (tenant_id IN ( SELECT m.tenant_id
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS "Users can manage their own interests" ON public.user_interests;
CREATE POLICY "Users can manage their own interests" ON public.user_interests AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "System can insert journey records" ON public.user_journey;
CREATE POLICY "System can insert journey records" ON public.user_journey AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own journey" ON public.user_journey;
CREATE POLICY "Users can update their own journey" ON public.user_journey AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own journey" ON public.user_journey;
CREATE POLICY "Users can view their own journey" ON public.user_journey AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_journey_foundation_self_rw ON public.user_journey_foundation;
CREATE POLICY user_journey_foundation_self_rw ON public.user_journey_foundation AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_journey_overrides_self_rw ON public.user_journey_overrides;
CREATE POLICY user_journey_overrides_self_rw ON public.user_journey_overrides AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_limitations_select_own ON public.user_limitations;
CREATE POLICY user_limitations_select_own ON public.user_limitations AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_limitations_service ON public.user_limitations;
CREATE POLICY user_limitations_service ON public.user_limitations AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS user_limitations_update_own ON public.user_limitations;
CREATE POLICY user_limitations_update_own ON public.user_limitations AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_limitations_upsert_own ON public.user_limitations;
CREATE POLICY user_limitations_upsert_own ON public.user_limitations AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_location_history_tenant_user_select ON public.user_location_history;
CREATE POLICY user_location_history_tenant_user_select ON public.user_location_history AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS user_location_settings_tenant_user_select ON public.user_location_settings;
CREATE POLICY user_location_settings_tenant_user_select ON public.user_location_settings AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS "Users can create their own interactions" ON public.user_match_interactions;
CREATE POLICY "Users can create their own interactions" ON public.user_match_interactions AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own interactions" ON public.user_match_interactions;
CREATE POLICY "Users can update their own interactions" ON public.user_match_interactions AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own interactions" ON public.user_match_interactions;
CREATE POLICY "Users can view their own interactions" ON public.user_match_interactions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own matches" ON public.user_matches;
CREATE POLICY "Users can update their own matches" ON public.user_matches AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((auth.uid() = user_id_1) OR (auth.uid() = user_id_2)));

DROP POLICY IF EXISTS "Users can view their own matches" ON public.user_matches;
CREATE POLICY "Users can view their own matches" ON public.user_matches AS PERMISSIVE FOR SELECT TO authenticated
  USING (((auth.uid() = user_id_1) OR (auth.uid() = user_id_2)));

DROP POLICY IF EXISTS "Users can manage their own memory metadata" ON public.user_memory_metadata;
CREATE POLICY "Users can manage their own memory metadata" ON public.user_memory_metadata AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users manage own muted authors" ON public.user_muted_authors;
CREATE POLICY "Users manage own muted authors" ON public.user_muted_authors AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS admin_read_all_notification_prefs ON public.user_notification_preferences;
CREATE POLICY admin_read_all_notification_prefs ON public.user_notification_preferences AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS users_manage_own_prefs ON public.user_notification_preferences;
CREATE POLICY users_manage_own_prefs ON public.user_notification_preferences AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS admin_read_all_user_notifications ON public.user_notifications;
CREATE POLICY admin_read_all_user_notifications ON public.user_notifications AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS users_delete_own_notifications ON public.user_notifications;
CREATE POLICY users_delete_own_notifications ON public.user_notifications AS PERMISSIVE FOR DELETE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS users_see_own_notifications ON public.user_notifications;
CREATE POLICY users_see_own_notifications ON public.user_notifications AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS users_update_own_notifications ON public.user_notifications;
CREATE POLICY users_update_own_notifications ON public.user_notifications AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_nudge_state_self_rw ON public.user_nudge_state;
CREATE POLICY user_nudge_state_self_rw ON public.user_nudge_state AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_offers_memory_insert ON public.user_offers_memory;
CREATE POLICY user_offers_memory_insert ON public.user_offers_memory AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS user_offers_memory_select ON public.user_offers_memory;
CREATE POLICY user_offers_memory_select ON public.user_offers_memory AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS user_offers_memory_update ON public.user_offers_memory;
CREATE POLICY user_offers_memory_update ON public.user_offers_memory AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS user_open_threads_tenant_isolation ON public.user_open_threads;
CREATE POLICY user_open_threads_tenant_isolation ON public.user_open_threads AS PERMISSIVE FOR ALL TO authenticated
  USING ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))))
  WITH CHECK ((tenant_id IN ( SELECT user_tenants.tenant_id
   FROM user_tenants
  WHERE (user_tenants.user_id = auth.uid()))));

DROP POLICY IF EXISTS upr_all_service_role ON public.user_permitted_roles;
CREATE POLICY upr_all_service_role ON public.user_permitted_roles AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS upr_select_own ON public.user_permitted_roles;
CREATE POLICY upr_select_own ON public.user_permitted_roles AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_personality_profile_tenant_user_select ON public.user_personality_profile;
CREATE POLICY user_personality_profile_tenant_user_select ON public.user_personality_profile AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
CREATE POLICY "Users can insert own preferences" ON public.user_preferences AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage their own preferences" ON public.user_preferences;
CREATE POLICY "Users can manage their own preferences" ON public.user_preferences AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
CREATE POLICY "Users can update own preferences" ON public.user_preferences AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
CREATE POLICY "Users can view own preferences" ON public.user_preferences AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_proactive_pause_self_rw ON public.user_proactive_pause;
CREATE POLICY user_proactive_pause_self_rw ON public.user_proactive_pause AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_proactive_touches_self_rw ON public.user_proactive_touches;
CREATE POLICY user_proactive_touches_self_rw ON public.user_proactive_touches AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_profiler_version_self_read ON public.user_profiler_version;
CREATE POLICY user_profiler_version_self_read ON public.user_profiler_version AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_reward_link_owner_rw ON public.user_reward_link;
CREATE POLICY user_reward_link_owner_rw ON public.user_reward_link AS PERMISSIVE FOR ALL TO public
  USING (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (user_id = vcaop_uid())))
  WITH CHECK (((vcaop_role() = ANY (ARRAY['staff'::text, 'admin'::text])) OR (user_id = vcaop_uid())));

DROP POLICY IF EXISTS user_roles_admin_read ON public.user_roles;
CREATE POLICY user_roles_admin_read ON public.user_roles AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND is_platform_admin()));

DROP POLICY IF EXISTS user_roles_owner_read ON public.user_roles;
CREATE POLICY user_roles_owner_read ON public.user_roles AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS user_routines_self_rw ON public.user_routines;
CREATE POLICY user_routines_self_rw ON public.user_routines AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_session_summaries_self_rw ON public.user_session_summaries;
CREATE POLICY user_session_summaries_self_rw ON public.user_session_summaries AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_subscriptions_read_own ON public.user_subscriptions;
CREATE POLICY user_subscriptions_read_own ON public.user_subscriptions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS user_subscriptions_svc_full ON public.user_subscriptions;
CREATE POLICY user_subscriptions_svc_full ON public.user_subscriptions AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can manage their own supplements" ON public.user_supplements;
CREATE POLICY "Users can manage their own supplements" ON public.user_supplements AS PERMISSIVE FOR ALL TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Admins manage suspensions" ON public.user_suspensions;
CREATE POLICY "Admins manage suspensions" ON public.user_suspensions AS PERMISSIVE FOR ALL TO authenticated
  USING (is_community_moderator())
  WITH CHECK (is_community_moderator());

DROP POLICY IF EXISTS admin_read_all_user_tenants ON public.user_tenants;
CREATE POLICY admin_read_all_user_tenants ON public.user_tenants AS PERMISSIVE FOR SELECT TO authenticated
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean IS TRUE));

DROP POLICY IF EXISTS user_tenants_all_service_role ON public.user_tenants;
CREATE POLICY user_tenants_all_service_role ON public.user_tenants AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS user_tenants_select_own ON public.user_tenants;
CREATE POLICY user_tenants_select_own ON public.user_tenants AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS user_tenants_update_own ON public.user_tenants;
CREATE POLICY user_tenants_update_own ON public.user_tenants AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can update their own wallets" ON public.user_wallets;
CREATE POLICY "Users can update their own wallets" ON public.user_wallets AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own wallets" ON public.user_wallets;
CREATE POLICY "Users can view their own wallets" ON public.user_wallets AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can insert their own interests" ON public.user_wellness_interests;
CREATE POLICY "Users can insert their own interests" ON public.user_wellness_interests AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can update their own interests" ON public.user_wellness_interests;
CREATE POLICY "Users can update their own interests" ON public.user_wellness_interests AS PERMISSIVE FOR UPDATE TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can view their own interests" ON public.user_wellness_interests;
CREATE POLICY "Users can view their own interests" ON public.user_wellness_interests AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS vaea_config_select_own ON public.vaea_config;
CREATE POLICY vaea_config_select_own ON public.vaea_config AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS vaea_config_service ON public.vaea_config;
CREATE POLICY vaea_config_service ON public.vaea_config AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS vaea_config_upsert_own ON public.vaea_config;
CREATE POLICY vaea_config_upsert_own ON public.vaea_config AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS vaea_detected_select_own ON public.vaea_detected_questions;
CREATE POLICY vaea_detected_select_own ON public.vaea_detected_questions AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS vaea_detected_service ON public.vaea_detected_questions;
CREATE POLICY vaea_detected_service ON public.vaea_detected_questions AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS vaea_channels_own ON public.vaea_listener_channels;
CREATE POLICY vaea_channels_own ON public.vaea_listener_channels AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS vaea_channels_service ON public.vaea_listener_channels;
CREATE POLICY vaea_channels_service ON public.vaea_listener_channels AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS vaea_catalog_mutate_own ON public.vaea_referral_catalog;
CREATE POLICY vaea_catalog_mutate_own ON public.vaea_referral_catalog AS PERMISSIVE FOR ALL TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS vaea_catalog_select_own ON public.vaea_referral_catalog;
CREATE POLICY vaea_catalog_select_own ON public.vaea_referral_catalog AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS vaea_catalog_service ON public.vaea_referral_catalog;
CREATE POLICY vaea_catalog_service ON public.vaea_referral_catalog AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS vaea_drafts_select_own ON public.vaea_reply_drafts;
CREATE POLICY vaea_drafts_select_own ON public.vaea_reply_drafts AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS vaea_drafts_service ON public.vaea_reply_drafts;
CREATE POLICY vaea_drafts_service ON public.vaea_reply_drafts AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS vaea_drafts_update_own ON public.vaea_reply_drafts;
CREATE POLICY vaea_drafts_update_own ON public.vaea_reply_drafts AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS value_profiles_insert ON public.value_profiles;
CREATE POLICY value_profiles_insert ON public.value_profiles AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS value_profiles_select ON public.value_profiles;
CREATE POLICY value_profiles_select ON public.value_profiles AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS value_profiles_update ON public.value_profiles;
CREATE POLICY value_profiles_update ON public.value_profiles AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())))
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS value_signals_insert ON public.value_signals;
CREATE POLICY value_signals_insert ON public.value_signals AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS value_signals_select ON public.value_signals;
CREATE POLICY value_signals_select ON public.value_signals AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS "Users can manage video metadata" ON public.video_metadata;
CREATE POLICY "Users can manage video metadata" ON public.video_metadata AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = video_metadata.media_id) AND (m.user_id = auth.uid())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = video_metadata.media_id) AND (m.user_id = auth.uid())))));

DROP POLICY IF EXISTS "Users can view video metadata" ON public.video_metadata;
CREATE POLICY "Users can view video metadata" ON public.video_metadata AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM media_uploads m
  WHERE ((m.id = video_metadata.media_id) AND (((m.status = 'approved'::text) AND (m.is_public = true)) OR (m.user_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM memberships mb
          WHERE ((mb.user_id = auth.uid()) AND (mb.role = ANY (ARRAY['staff'::tenant_role, 'admin'::tenant_role])) AND (mb.status = 'active'::text)))))))));

DROP POLICY IF EXISTS vitana_index_baseline_survey_self_rw ON public.vitana_index_baseline_survey;
CREATE POLICY vitana_index_baseline_survey_self_rw ON public.vitana_index_baseline_survey AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Anyone can view active vitana config" ON public.vitana_index_config;
CREATE POLICY "Anyone can view active vitana config" ON public.vitana_index_config AS PERMISSIVE FOR SELECT TO public
  USING ((is_active = true));

DROP POLICY IF EXISTS "Only admins can manage vitana config" ON public.vitana_index_config;
CREATE POLICY "Only admins can manage vitana config" ON public.vitana_index_config AS PERMISSIVE FOR ALL TO public
  USING (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = 'admin'::tenant_role) AND (m.status = 'active'::text))))))
  WITH CHECK (((COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean, false) = true) OR (EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.user_id = auth.uid()) AND (m.role = 'admin'::tenant_role) AND (m.status = 'active'::text))))));

DROP POLICY IF EXISTS vitana_index_scores_user_policy ON public.vitana_index_scores;
CREATE POLICY vitana_index_scores_user_policy ON public.vitana_index_scores AS PERMISSIVE FOR ALL TO public
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS vitana_idx_traj_self ON public.vitana_index_trajectory_snapshots;
CREATE POLICY vitana_idx_traj_self ON public.vitana_index_trajectory_snapshots AS PERMISSIVE FOR ALL TO public
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS vitana_index_trajectory_snapshots_tenant_user_select ON public.vitana_index_trajectory_snapshots;
CREATE POLICY vitana_index_trajectory_snapshots_tenant_user_select ON public.vitana_index_trajectory_snapshots AS PERMISSIVE FOR SELECT TO authenticated
  USING (((tenant_id = current_tenant_id()) AND (user_id = auth.uid())));

DROP POLICY IF EXISTS vitana_pillar_agent_outputs_owner_read ON public.vitana_pillar_agent_outputs;
CREATE POLICY vitana_pillar_agent_outputs_owner_read ON public.vitana_pillar_agent_outputs AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full access to voice_active_provider_changes" ON public.voice_active_provider_changes;
CREATE POLICY "Service role full access to voice_active_provider_changes" ON public.voice_active_provider_changes AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role full access to voice_canary_baselines" ON public.voice_canary_baselines;
CREATE POLICY "Service role full access to voice_canary_baselines" ON public.voice_canary_baselines AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role full access to voice_parity_drifts" ON public.voice_parity_drifts;
CREATE POLICY "Service role full access to voice_parity_drifts" ON public.voice_parity_drifts AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role full access to voice_providers" ON public.voice_providers;
CREATE POLICY "Service role full access to voice_providers" ON public.voice_providers AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Service role can manage voucher orders" ON public.voucher_orders;
CREATE POLICY "Service role can manage voucher orders" ON public.voucher_orders AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Users can view their own voucher orders" ON public.voucher_orders;
CREATE POLICY "Users can view their own voucher orders" ON public.voucher_orders AS PERMISSIVE FOR SELECT TO public
  USING (((buyer_user_id = auth.uid()) OR (buyer_email = auth.email())));

DROP POLICY IF EXISTS "Service role can manage redemptions" ON public.voucher_redemptions;
CREATE POLICY "Service role can manage redemptions" ON public.voucher_redemptions AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Staff can create redemptions" ON public.voucher_redemptions;
CREATE POLICY "Staff can create redemptions" ON public.voucher_redemptions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.tenant_id = voucher_redemptions.tenant_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role]))))));

DROP POLICY IF EXISTS "Staff can view redemptions for their tenant" ON public.voucher_redemptions;
CREATE POLICY "Staff can view redemptions for their tenant" ON public.voucher_redemptions AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM memberships m
  WHERE ((m.tenant_id = voucher_redemptions.tenant_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::tenant_role, 'staff'::tenant_role]))))));

DROP POLICY IF EXISTS "Service role can manage vouchers" ON public.vouchers;
CREATE POLICY "Service role can manage vouchers" ON public.vouchers AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Users can claim active vouchers" ON public.vouchers;
CREATE POLICY "Users can claim active vouchers" ON public.vouchers AS PERMISSIVE FOR UPDATE TO public
  USING ((status = 'active'::text))
  WITH CHECK (((redeemed_by_user_id = auth.uid()) AND (status = 'redeemed'::text)));

DROP POLICY IF EXISTS "Users can view their own vouchers through orders" ON public.vouchers;
CREATE POLICY "Users can view their own vouchers through orders" ON public.vouchers AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM voucher_orders vo
  WHERE ((vo.voucher_id = vouchers.id) AND ((vo.buyer_user_id = auth.uid()) OR (vo.buyer_email = auth.email()))))));

DROP POLICY IF EXISTS "Users can view vouchers by code for redemption" ON public.vouchers;
CREATE POLICY "Users can view vouchers by code for redemption" ON public.vouchers AS PERMISSIVE FOR SELECT TO public
  USING (((status = 'active'::text) OR (redeemed_by_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM voucher_orders vo
  WHERE ((vo.voucher_id = vouchers.id) AND (vo.buyer_user_id = auth.uid()))))));

DROP POLICY IF EXISTS vtid_ledger_service_role_all ON public.vtid_ledger;
CREATE POLICY vtid_ledger_service_role_all ON public.vtid_ledger AS PERMISSIVE FOR ALL TO service_role
  USING (true);

DROP POLICY IF EXISTS "Users read own wallet accounts" ON public.wallet_accounts;
CREATE POLICY "Users read own wallet accounts" ON public.wallet_accounts AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Service role full access to reset history" ON public.wallet_balance_resets;
CREATE POLICY "Service role full access to reset history" ON public.wallet_balance_resets AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

DROP POLICY IF EXISTS "Users can view their own reset history" ON public.wallet_balance_resets;
CREATE POLICY "Users can view their own reset history" ON public.wallet_balance_resets AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Only admins can manage wallet credits" ON public.wallet_credits;
CREATE POLICY "Only admins can manage wallet credits" ON public.wallet_credits AS PERMISSIVE FOR ALL TO public
  USING (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true))
  WITH CHECK (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true));

DROP POLICY IF EXISTS "Only system can create wallet credits" ON public.wallet_credits;
CREATE POLICY "Only system can create wallet credits" ON public.wallet_credits AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true));

DROP POLICY IF EXISTS "Users can view their own wallet credits" ON public.wallet_credits;
CREATE POLICY "Users can view their own wallet credits" ON public.wallet_credits AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = user_id) OR ((((auth.jwt() -> 'app_metadata'::text) ->> 'exafy_admin'::text))::boolean = true)));

DROP POLICY IF EXISTS "Users read own deposits" ON public.wallet_deposits;
CREATE POLICY "Users read own deposits" ON public.wallet_deposits AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users read own ledger entries" ON public.wallet_ledger_entries;
CREATE POLICY "Users read own ledger entries" ON public.wallet_ledger_entries AS PERMISSIVE FOR SELECT TO public
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can create transactions from their account" ON public.wallet_transactions;
CREATE POLICY "Users can create transactions from their account" ON public.wallet_transactions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((auth.uid() = from_user_id));

DROP POLICY IF EXISTS "Users can view their own transactions" ON public.wallet_transactions;
CREATE POLICY "Users can view their own transactions" ON public.wallet_transactions AS PERMISSIVE FOR SELECT TO public
  USING (((auth.uid() = from_user_id) OR (auth.uid() = to_user_id)));

DROP POLICY IF EXISTS wearable_daily_select_own ON public.wearable_daily_metrics;
CREATE POLICY wearable_daily_select_own ON public.wearable_daily_metrics AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS wearable_daily_service ON public.wearable_daily_metrics;
CREATE POLICY wearable_daily_service ON public.wearable_daily_metrics AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS wearable_samples_delete ON public.wearable_samples;
CREATE POLICY wearable_samples_delete ON public.wearable_samples AS PERMISSIVE FOR DELETE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS wearable_samples_insert ON public.wearable_samples;
CREATE POLICY wearable_samples_insert ON public.wearable_samples AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS wearable_samples_select ON public.wearable_samples;
CREATE POLICY wearable_samples_select ON public.wearable_samples AS PERMISSIVE FOR SELECT TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS wearable_samples_update ON public.wearable_samples;
CREATE POLICY wearable_samples_update ON public.wearable_samples AS PERMISSIVE FOR UPDATE TO public
  USING (((tenant_id = current_tenant_id()) AND (user_id = current_user_id())));

DROP POLICY IF EXISTS wearable_waitlist_insert_own ON public.wearable_waitlist;
CREATE POLICY wearable_waitlist_insert_own ON public.wearable_waitlist AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));

DROP POLICY IF EXISTS wearable_waitlist_select_own ON public.wearable_waitlist;
CREATE POLICY wearable_waitlist_select_own ON public.wearable_waitlist AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS wearable_waitlist_service ON public.wearable_waitlist;
CREATE POLICY wearable_waitlist_service ON public.wearable_waitlist AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS wearable_workouts_select_own ON public.wearable_workouts;
CREATE POLICY wearable_workouts_select_own ON public.wearable_workouts AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));

DROP POLICY IF EXISTS wearable_workouts_service ON public.wearable_workouts;
CREATE POLICY wearable_workouts_service ON public.wearable_workouts AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access to worker_registry" ON public.worker_registry;
CREATE POLICY "Service role full access to worker_registry" ON public.worker_registry AS PERMISSIVE FOR ALL TO public
  USING ((auth.role() = 'service_role'::text));

