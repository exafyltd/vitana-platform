/**
 * VTID-04562 — the developer Vitana's map of the whole system.
 *
 * One entry per domain the developer asks about: what it is, which gateway
 * route files own it (matched by file name, so a new route file is claimed
 * or the drift test fails), the services and tables behind it, the flags
 * that change its behaviour, and where to read more. The atlas is a map,
 * not the territory — it tells the assistant where to dig, and the deep-dive
 * tools read the real code, rows and logs.
 *
 * Drift guard: `test/vtid-04560-role-separation-regression.test.ts` checks
 * that every `src/routes/**.ts` file is claimed by at least one domain.
 */

export interface AtlasDomain {
  key: string;
  title: string;
  /** One or two sentences: what it does and how it hangs together. */
  summary: string;
  /** Route files (relative to src/routes, no extension) this domain owns. */
  routes: RegExp[];
  /** Service directories / files under services/gateway/src. */
  code: string[];
  /** Postgres tables at the centre of the domain. */
  tables: string[];
  /** Env flags that change the domain's behaviour. */
  flags: string[];
  /** Docs worth reading first. */
  docs: string[];
  /** Words a developer uses for it (for lookup). */
  aliases: string[];
}

export const DOMAIN_ATLAS: readonly AtlasDomain[] = [
  {
    key: 'voice',
    title: 'ORB voice (voice-to-voice)',
    summary:
      'Live voice sessions: Amazon Nova Sonic for most languages, the Transcribe→Bedrock→Polly/Fish cascade for languages Nova cannot speak, and the Serbian-only Vertex bridge. One session controller for WS and SSE, a greeting brain, the tool catalog and the Assistant Profile that decides which Vitana speaks.',
    routes: [/^orb-/, /^voice-/, /^live/, /^realtime-relay$/, /^conversation/, /^assistant$/, /^ai-assistants$/, /^ai-personality$/, /^ai-bridge$/, /^visual-interactive$/, /^tenant-admin\/assistant-/],
    code: ['orb/live/', 'orb/profile/', 'orb/context/', 'orb/delegation/', 'routes/orb-live.ts', 'services/conversation/', 'services/tts/'],
    tables: ['oasis_events (orb.live.*, vtid.live.*)', 'ai_personality_config', 'agent_voice_configs', 'decision_policy', 'user_session_summaries'],
    flags: ['NOVA_SONIC_GLOBAL_ENABLED', 'ORB_FULL_DUPLEX_ENABLED', 'VERTEX_SERBIAN_BRIDGE_ENABLED', 'TTS_PROVIDER', 'TTS_FISH_FALLBACK_ENABLED', 'FEATURE_ORB_SAFE_FAST_GREETING_ENV'],
    docs: ['CLAUDE.md §2c/§2e', 'docs/HANDOFF-voice-quality.md', 'docs/CONVERSATION_FLOW_ARCHITECTURE.md'],
    aliases: ['orb', 'voice', 'nova', 'nova sonic', 'polly', 'fish', 'cascade', 'greeting', 'barge-in', 'vertex bridge', 'serbian'],
  },
  {
    key: 'autopilot',
    title: 'Dev Autopilot and self-healing',
    summary:
      'Scanners and impact rules produce findings; the planner writes plans; auto-approve or a human approves; the executor (an ECS task running the agent loop) opens a PR, holds it for approval, and the CI/deploy/verification watchers merge, deploy and verify. Self-healing turns failures into fix-mode children.',
    routes: [/^dev-autopilot$/, /^autopilot/, /^autonomy-/, /^self-healing$/, /^triage-agent$/, /^architecture-investigator$/, /^supervisor-summary/, /^approvals$/, /^execute$/, /^specs$/, /^tasks$/, /^routine/],
    code: ['services/dev-autopilot-*.ts', 'services/autopilot-agent/', 'services/self-healing-*.ts', 'services/architecture-investigator.ts', 'services/dev-autopilot-supervisor.ts'],
    tables: ['autopilot_recommendations', 'dev_autopilot_plan_versions', 'dev_autopilot_executions', 'dev_autopilot_runs', 'dev_autopilot_config', 'dev_autopilot_outcomes', 'self_healing_log', 'architecture_reports'],
    flags: ['DEV_AUTOPILOT_EXECUTOR_ENABLED', 'DEV_AUTOPILOT_WATCHER_LIVE', 'DEV_AUTOPILOT_USE_JOB', 'DEV_AUTOPILOT_JOB_CLOUD', 'DEV_AUTOPILOT_PR_APPROVAL_REQUIRED', 'AGENT_MAX_TURNS'],
    docs: ['docs/OPERATOR-AGENT-BUILD-PLAN.md', 'docs/OPERATOR-CONSOLE-E2E-RECOVERY-2026-09-21.md', 'docs/AGENT-REGISTRY.md'],
    aliases: ['autopilot', 'dev autopilot', 'executor', 'findings', 'self-healing', 'self heal', 'watcher', 'fix mode', 'planner'],
  },
  {
    key: 'agents',
    title: 'Agents, orchestrator and the Operator Console',
    summary:
      'The Operator Console (text + voice) with its tool loop, bootstrap pack, threads and turn memory; the orchestrator\'s agent-as-tool specialists and delegation jobs; the worker-runner execution plane and its claim allowlist; the agent registry and dev_agent_memory.',
    routes: [/^operator$/, /^orchestrator$/, /^worker-orchestrator$/, /^agents-registry$/, /^pillar-agents/, /^dev-memory$/, /^jev-decisions$/, /^board-adapter$/, /^admin\/ai-integrations/],
    code: ['services/gemini-operator.ts', 'services/operator-*.ts', 'orb/delegation/', 'services/dev-agent-memory.ts', 'services/llm-stage-tool-loop.ts', 'services/jev/'],
    tables: ['operator_threads', 'operator_messages', 'dev_agent_memory', 'agent_runs', 'agents_registry', 'vtid_ledger'],
    flags: ['OPERATOR_EXECUTION_ONRAMP_ENABLED', 'OPERATOR_BOOTSTRAP_PACK_ENABLED', 'OPERATOR_THREADS_ENABLED', 'OPERATOR_TURN_MEMORY_ENABLED', 'ORCHESTRATOR_DELEGATION_PERSIST_ENABLED', 'JEV_DECISIONS_ENABLED'],
    docs: ['docs/AGENT-REGISTRY.md', 'docs/ORCHESTRATOR-REDESIGN-PLAN.md', 'docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md'],
    aliases: ['agents', 'operator', 'operator console', 'orchestrator', 'delegation', 'worker', 'specialist', 'memory of agents', 'jev'],
  },
  {
    key: 'oasis',
    title: 'OASIS, VTIDs and governance',
    summary:
      'OASIS is the single source of truth: vtid_ledger for task state, oasis_events for every state transition and decision. Governance gates (kill switches, allocator, approvals) and the observability routes read from it.',
    routes: [/^oasis-/, /^vtid/, /^governance/, /^events$/, /^gateway-events-api$/, /^telemetry$/, /^rum-beacon$/, /^diag$/, /^watcher/, /^ops-/, /^test-contracts/, /^testing$/, /^screen-load-health/, /^auto-logger-health-route$/, /^aws-sns-alerts$/, /^scheduler$/, /^scheduled-notifications/, /^tenant-admin\/audit-log/],
    code: ['services/oasis-*.ts', 'services/vtid-*.ts', 'services/governance-*.ts', 'services/system-controls-service.ts'],
    tables: ['vtid_ledger', 'oasis_events', 'system_controls', 'governance_rules'],
    flags: ['VTID_ALLOCATOR_ENABLED', 'AUTOPILOT_LOOP_ENABLED', 'EXECUTION_DISARMED'],
    docs: ['CLAUDE.md §4-§6', 'docs/VTID_SYSTEM.md', 'docs/OASIS-LEDGER-INTEGRITY.md'],
    aliases: ['oasis', 'vtid', 'ledger', 'events', 'governance', 'telemetry'],
  },
  {
    key: 'deploy',
    title: 'Deploys, CI/CD and the Command Hub',
    summary:
      'Merging to main deploys staging (ECS vitana-gateway); production moves only through PUBLISH or an approved pinned dispatch. The Command Hub is the developer surface served by the gateway, with its own ownership guard and cache-busting.',
    routes: [/^cicd$/, /^command-hub/, /^commandhub$/, /^devhub$/, /^dev-access$/, /^dev-auth/, /^canary-target$/, /^domain-routing$/],
    code: ['frontend/command-hub/', 'services/github-service.ts', 'services/aws-ecs-*.ts', '.github/workflows/AWS-*.yml'],
    tables: ['oasis_events (deploy.*, staging.deploy.*)'],
    flags: ['PUBLISH_TARGET_CLOUD', 'FRONTEND_DEPLOY_TOKEN', 'GITHUB_SAFE_MERGE_TOKEN'],
    docs: ['CLAUDE.md §1b, §15, §16', 'docs/STAGING.md', 'docs/AWS-PRODUCTION-BUILD-LOG.md'],
    aliases: ['deploy', 'ci', 'cicd', 'publish', 'staging', 'production', 'command hub', 'ecs', 'workflow'],
  },
  {
    key: 'llm',
    title: 'LLM routing',
    summary:
      'Every model call goes through the router: a stage (planner, worker, validator, operator, memory, triage, classifier, vision) resolves to a provider/model pair and a fallback from the active llm_routing_policy. Claude always runs on Bedrock; Google is never a fallback.',
    routes: [/^llm/],
    code: ['services/llm-router.ts', 'providers/bedrock.ts', 'constants/llm-defaults.ts'],
    tables: ['llm_routing_policy', 'llm_allowed_models', 'llm_allowed_providers', 'oasis_events (llm.call.*)'],
    flags: ['BEDROCK_ROLE_ARN', 'AWS_BEDROCK_REGION', 'DEEPSEEK_API_KEY'],
    docs: ['CLAUDE.md §2b'],
    aliases: ['llm', 'model', 'routing', 'bedrock', 'deepseek', 'provider', 'fallback'],
  },
  {
    key: 'memory',
    title: 'Memory and intelligence',
    summary:
      'The member brain: memory_items and memory_facts (write_fact), the relationship graph, Cognee extraction after sessions, the retrieval router and the context pack, plus the awareness engines (signals, situational, emotional, life stage, forecasting).',
    routes: [/^memory/, /^semantic-memory$/, /^relationships/, /^personalization/, /^signal-detection$/, /^situational-awareness$/, /^social-context$/, /^emotional-cognitive/, /^life-stage-awareness/, /^longitudinal-adaptation/, /^predictive-forecasting$/, /^positive-trajectory-reinforcement$/, /^overload-detection$/, /^repair-patterns$/, /^risk-mitigation$/, /^opportunity-surfacing/, /^environmental-mobility-context$/, /^awareness-config/, /^taste-alignment/, /^social-alignment$/, /^goal-planner$/, /^capabilities/, /^boundary-consent$/, /^consent-actions/, /^user-limitations/, /^tenant-admin\/(insights|knowledge)/],
    code: ['services/cognee-extractor-client.ts', 'services/retrieval-router.ts', 'services/context-pack-builder.ts', 'services/orb-memory-bridge.ts'],
    tables: ['memory_items', 'memory_facts', 'memory_garden_config', 'relationship_nodes', 'relationship_edges', 'user_session_summaries'],
    flags: [],
    docs: ['CLAUDE.md §14', 'docs/MEMORY-SYSTEM-PLAN.md'],
    aliases: ['memory', 'memory garden', 'knowledge graph', 'facts', 'cognee', 'retrieval', 'context pack', 'relationships'],
  },
  {
    key: 'community',
    title: 'Community and social',
    summary:
      'Members, groups, chat, posts and media, matchmaking and intents, presence, celebrations and notifications, and the community Autopilot engine (AP automations registry, recommendation inbox). Every member-facing list must exclude test/service accounts (service_bot_accounts, notification_test_actors).',
    routes: [/^community/, /^chat/, /^social-connect/, /^matchmaking/, /^match-feedback/, /^intent/, /^intents/, /^celebrations/, /^creators$/, /^news-feed/, /^media-hub/, /^presence/, /^public-profile-og/, /^users-/, /^topics/, /^notifications/, /^tenant-admin\/(community-admin|content-moderation|invitations)/, /^admin-moderation$/, /^automations/, /^recommendation-inbox/],
    code: ['services/connect-people-*.ts', 'services/welcome-chat-service.ts', 'lib/excluded-test-service-accounts.ts'],
    tables: ['profiles', 'user_tenants', 'automation_runs', 'chat_messages', 'chat_group_members', 'profile_posts', 'user_notifications', 'daily_matches', 'service_bot_accounts'],
    flags: [],
    docs: ['CLAUDE.md Part 1 rules 43-45'],
    aliases: ['community', 'members', 'chat', 'groups', 'posts', 'matchmaking', 'notifications', 'intents'],
  },
  {
    key: 'support',
    title: 'Customer support',
    summary:
      'Member tickets from the app, from Vitana by voice (report_to_specialist) and from the conversation with Devon; triage, the spec drafter, auto-dispatch to Dev Autopilot and the completion reconciler. Guarded by the support regression suite.',
    routes: [/^feedback/, /^tenant-specialists/, /^specialists-/, /^email-intake$/],
    code: ['services/feedback-*.ts', 'orb/live/tools/'],
    tables: ['feedback_tickets', 'user_feedback_reports'],
    flags: ['FEEDBACK_AUTO_DISPATCH_ENABLED', 'ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED'],
    docs: ['docs/CUSTOMER-SUPPORT-REBUILD-BRIEF.md', 'CLAUDE.md rules 42c/42d'],
    aliases: ['support', 'tickets', 'devon', 'feedback', 'bug report'],
  },
  {
    key: 'health',
    title: 'Health, longevity and My Journey',
    summary:
      'The Vitana Index and pillars, lab reports and biomarkers, wearables, diary and reminders, calendar, and the guided My Journey with its checklist, topics and teacher mode.',
    routes: [/^health/, /^longevity/, /^vitana-index/, /^wearables/, /^diary/, /^reminders/, /^journey-/, /^guided-journey$/, /^my-journey$/, /^patient-health-results$/, /^fhir-/, /^calendar/, /^availability-readiness$/, /^locations/, /^partner-health-consent$/, /^tenant-admin\/health-index/],
    code: ['services/guided-journey/', 'services/vitana-index*.ts', 'orb/teacher/'],
    tables: ['vitana_index_scores', 'lab_reports', 'biomarker_results', 'journey_checklist_translations', 'diary_entries', 'reminders'],
    flags: ['NARRATION_AUDIO_CACHE'],
    docs: ['docs/SPEC-journey-conversation-v2.md'],
    aliases: ['health', 'vitana index', 'longevity', 'journey', 'my journey', 'wearables', 'lab', 'diary', 'reminders'],
  },
  {
    key: 'commerce',
    title: 'Commerce and Discover',
    summary:
      'Discover feed and search, merchants and products, affiliate sync (Awin, Shopify), click attribution, the universal cart and shopping agent, VCAOP, VAEA (the Business Hub referral assistant), and self-service partner onboarding.',
    routes: [/^offers/, /^shop-/, /^shopify-/, /^shopping-agent/, /^universal-cart/, /^discover-/, /^vcaop/, /^partner-/, /^awin-sync/, /^catalog-ingest/, /^click-redirect/, /^internal-marketplace-sync$/, /^cover-images$/, /^integrations/, /^connected-apps$/, /^connector-webhooks/, /^admin-marketplace/, /^admin-community-marketplace$/, /^admin-partner-health$/, /^community-marketplace$/, /^vaea/],
    code: ['services/commerce/', 'services/partner-*.ts'],
    tables: ['merchants', 'products', 'partner_organizations', 'partner_registry', 'affiliate_clicks'],
    flags: ['PARTNER_INVITE_EMAIL_ENABLED', 'PARTNER_TERMS_VERSION', 'ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED'],
    docs: ['CLAUDE.md §13c', 'docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md', 'docs/MERCHANT_ONBOARDING_RUNBOOK.md'],
    aliases: ['commerce', 'discover', 'shop', 'merchants', 'products', 'partners', 'affiliate', 'awin', 'shopify'],
  },
  {
    key: 'payments',
    title: 'Wallet, billing and payments',
    summary: 'Wallet balances and transfers, subscriptions and billing, Stripe webhooks and Stripe Connect.',
    routes: [/^wallet/, /^billing/, /^payments-/, /^stripe-/, /^financial-monetization$/],
    code: ['services/wallet*.ts', 'services/stripe*.ts'],
    tables: ['wallet_accounts', 'wallet_transactions', 'subscriptions'],
    flags: [],
    docs: [],
    aliases: ['wallet', 'billing', 'payments', 'stripe', 'subscription'],
  },
  {
    key: 'admin',
    title: 'Admin, tenants, roles and auth',
    summary:
      'Platform and tenant administration: users, tenants, roles (role_preferences and user_active_roles stay in step since VTID-04561), signups, i18n ops, navigator catalog, notifications admin, auth and the member profile endpoints.',
    routes: [/^admin-/, /^tenant-admin\//, /^role-admin/, /^me/, /^auth/, /^user-/, /^landing-route/, /^profile-prefs/, /^product-analytics/, /^analytics-celebrate/, /^storage-bridge$/, /^specialists-admin$/, /^journey-checklist-admin$/],
    code: ['routes/admin-*.ts', 'routes/tenant-admin/', 'orb/profile/role-registry.ts', 'constants/vitana-roles.ts', 'i18n/'],
    tables: ['app_users', 'user_tenants', 'tenants', 'role_preferences', 'user_active_roles', 'nav_catalog', 'nav_catalog_i18n', 'supported_locales'],
    flags: [],
    docs: ['CLAUDE.md §13b', 'docs/DB-CONTENT-I18N.md'],
    aliases: ['admin', 'tenants', 'roles', 'users', 'auth', 'signup', 'i18n', 'navigator'],
  },
  {
    key: 'backoffice',
    title: 'BackOffice (ERP/CRM)',
    summary:
      'ERPClaw behind a private bridge: typed commands with policy tiers (read, draft, commit, high), maker-checker approvals, receipts and an independent audit; the browser only ever talks to the gateway.',
    routes: [/^backoffice-/],
    code: ['services/erp-*.ts', '../erp-bridge/'],
    tables: ['erp_commands', 'erp_approvals', 'erp_audit', 'erp_capability_grants'],
    flags: [],
    docs: ['docs/backoffice/GOLDEN-WORKFLOWS.md'],
    aliases: ['backoffice', 'erp', 'crm', 'erpclaw'],
  },
  {
    key: 'infra',
    title: 'Infrastructure and data platform',
    summary:
      'AWS eu-central-1 only (ECS cluster Vitana-ECS-Cluster, Aurora, ElastiCache, ALB), the Supabase project still serving most reads/writes, the Aurora migration in progress, and the codebase index in S3.',
    routes: [/^admin-aurora-memory-health$/, /^admin-staging/, /^admin-health$/],
    code: ['services/aws-*.ts', 'services/codeintel-index.ts', 'lib/'],
    tables: ['(Supabase inmkhvwdcuyhnxkgfvsb)', '(Aurora vitana-aurora-prod)'],
    flags: ['AURORA_DATABASE_URL', 'DB_I18N_TARGET'],
    docs: ['CLAUDE.md §1b, §3', 'docs/AURORA-MIGRATION-STATUS-2026-09-10.md', 'docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md'],
    aliases: ['infra', 'aws', 'ecs', 'aurora', 'supabase', 'database', 'redis', 'alb'],
  },
];

/** The domains that claim a route file (path relative to src/routes, no `.ts`). */
export function domainsForRoute(routeFile: string): AtlasDomain[] {
  const name = routeFile.replace(/\.ts$/, '');
  return DOMAIN_ATLAS.filter((d) => d.routes.some((r) => r.test(name)));
}

/** Best domain for a free-text question or key, or null. */
export function findDomain(query: string): AtlasDomain | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = DOMAIN_ATLAS.find((d) => d.key === q);
  if (exact) return exact;
  let best: { d: AtlasDomain; score: number } | null = null;
  for (const d of DOMAIN_ATLAS) {
    let score = 0;
    for (const a of d.aliases) if (q.includes(a)) score += a.length;
    if (q.includes(d.title.toLowerCase())) score += 20;
    if (score > 0 && (!best || score > best.score)) best = { d, score };
  }
  return best ? best.d : null;
}

/** Compact index for the prompt: one line per domain. */
export function renderAtlasIndex(): string {
  const lines = DOMAIN_ATLAS.map((d) => `- ${d.key}: ${d.title} — ${d.summary.split('. ')[0].replace(/\.$/, '')}.`);
  return [
    'DOMAIN ATLAS (where each part of Vitanaland lives; ask dev_domain_atlas for a domain\'s routes, tables, flags and docs):',
    ...lines,
  ].join('\n');
}

/** Full detail for one domain. */
export function renderAtlasDomain(d: AtlasDomain): string {
  return [
    `${d.title} [${d.key}]`,
    d.summary,
    `Code: ${d.code.join(', ') || '—'}`,
    `Tables: ${d.tables.join(', ') || '—'}`,
    `Flags: ${d.flags.join(', ') || '—'}`,
    `Docs: ${d.docs.join(', ') || '—'}`,
  ].join('\n');
}
