import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;

// =============================================================================
// DEV-COMHU-2025-0013: ULTRA-EARLY BOOT BRANCH FOR vitana-dev-gateway
// =============================================================================
// If running on vitana-dev-gateway, act as a minimal redirector ONLY.
// This avoids importing heavy routes (assistant, orb-live) that require
// GOOGLE_GEMINI_API_KEY and other env vars not configured on this service.
// =============================================================================

const CANONICAL_GATEWAY_URL = 'https://gateway-q74ibpv6ia-uc.a.run.app';

if (process.env.K_SERVICE === 'vitana-dev-gateway') {
  // Health/alive endpoints for Cloud Run
  app.get('/alive', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'vitana-dev-gateway',
      mode: 'redirector',
      timestamp: new Date().toISOString()
    });
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      service: 'vitana-dev-gateway',
      mode: 'redirector',
      timestamp: new Date().toISOString()
    });
  });

  // Redirect /command-hub/* to canonical gateway
  app.use('/command-hub', (req, res) => {
    const redirectUrl = CANONICAL_GATEWAY_URL + req.originalUrl;
    res.redirect(302, redirectUrl);
  });

  // Catch-all: 404 for everything else
  app.use((_req, res) => {
    res.status(404).send('vitana-dev-gateway redirector - use canonical gateway for API calls');
  });

  // Start server and EXIT - do NOT proceed to import heavy routes
  app.listen(PORT, () => {
    console.log('✅ vitana-dev-gateway REDIRECTOR running on port ' + PORT);
    console.log('📌 Mode: Minimal redirector (no API routes loaded)');
    console.log('🔀 Redirecting /command-hub/* → ' + CANONICAL_GATEWAY_URL);
  });
} else {
  // =============================================================================
  // MAIN GATEWAY: Full API with all routes
  // =============================================================================
  // Only import heavy routes here to avoid loading them on vitana-dev-gateway

  // VTID-01063: Route Guard for duplicate route detection
  const { mountRouterSync, logStartupSummary } = require('./governance/route-guard');

  // Lazy imports - only loaded for main gateway
  const boardAdapter = require('./routes/board-adapter').default;
  const { commandhub } = require('./routes/commandhub');
  const { vtidRouter } = require('./routes/vtid');
  const { router: tasksRouter } = require('./routes/tasks');
  const { router: eventsRouter } = require('./routes/events');
  const eventsApiRouter = require('./routes/gateway-events-api').default;
  const commandHubRouter = require('./routes/command-hub').default;
  const { sseService } = require('./services/sse-service');
  const { setupCors, sseHeaders } = require('./middleware/cors');
  const governanceRouter = require('./routes/governance').default;
  // VTID-01181: Governance Controls v1 - System Arming Panel
  const governanceControlsRouter = require('./routes/governance-controls').default;
  const { oasisTasksRouter } = require('./routes/oasis-tasks');
  const { oasisVtidLedgerRouter } = require('./routes/oasis-vtid-ledger');
  const cicdRouter = require('./routes/cicd').default;
  const operatorRouter = require('./routes/operator').default;
  const { router: telemetryRouter } = require('./routes/telemetry');
  const autopilotRouter = require('./routes/autopilot').default;
  // VTID-01089: Autopilot Matchmaking Prompts (One-Tap Consent + Rate Limits + Opt-out)
  const autopilotPromptsRouter = require('./routes/autopilot-prompts').default;
  const assistantRouter = require('./routes/assistant').default;
  const orbLiveRouter = require('./routes/orb-live').default;
  // VTID-01222: WebSocket server initialization for ORB Live API
  const { initializeOrbWebSocket } = require('./routes/orb-live');
  // VTID-01218A: Voice LAB - ORB Live Observability API
  const voiceLabRouter = require('./routes/voice-lab').default;
  // AI Personality Configuration API
  const aiPersonalityRouter = require('./routes/ai-personality').default;
  // VTID-01216: Unified Conversation Intelligence Layer (ORB + Operator shared brain)
  const conversationRouter = require('./routes/conversation').default;
  // VTID-01046: Me Context Routes - role context and role switching
  const meRouter = require('./routes/me').default;
  // VTID-01047: Dev Token Mint Endpoint (Cloud-Shell Friendly)
  const devAuthRouter = require('./routes/dev-auth').default;
  // VTID-01172: Dev Access Management - exafy_admin toggle for DEV admin users
  const devAccessRouter = require('./routes/dev-access').default;
  // VTID-01230: Role Admission Management - grant/revoke/list permitted roles
  const roleAdminRouter = require('./routes/role-admin').default;
  // VTID-01081 + VTID-01103: Health Gateway (C2 ingest + C3 compute)
  const healthRouter = require('./routes/health').default;
  // VTID-01105: Memory Gateway Routes - memory write/context for ORB
  const memoryRouter = require('./routes/memory').default;
  // VTID-01099: Memory Governance Routes - visibility, lock, delete, export
  const memoryGovernanceRouter = require('./routes/memory-governance').default;
  // VTID-01184: Supabase Semantic Memory Routes - pgvector search + embeddings
  const semanticMemoryRouter = require('./routes/semantic-memory').default;
  // VTID-01096: Cross-Domain Personalization v1 - snapshot endpoint
  const personalizationSnapshotRouter = require('./routes/personalization').default;
  // VTID-01095: Daily Scheduler Routes - daily recompute pipeline
  const schedulerRouter = require('./routes/scheduler').default;
  // Scheduled notification webhook endpoints (Cloud Scheduler triggers)
  const scheduledNotificationsRouter = require('./routes/scheduled-notifications').default;
  // VTID-01093: Unified Interest Topics Layer - topic registry + user profile
  const topicsRouter = require('./routes/topics').default;
  // VTID-01092: Services + Products as Relationship Memory
  const offersRouter = require('./routes/offers').default;
  // VTID-01091: Locations Memory (Places + Habits + Meetups) + Discovery
  const locationsRouter = require('./routes/locations').default;
  const { discoveryRouter, locationPrefsRouter } = require('./routes/locations');
  // VTID-01088: Matchmaking Engine v1 - People <-> People/Groups/Events/Services/Products/Locations/Live Rooms
  const matchmakingRouter = require('./routes/matchmaking').default;
  // VTID-01083: Longevity Signal Layer - diary/memory to health signals bridge
  const longevityRouter = require('./routes/longevity').default;
  // VTID-01120: D28 Emotional & Cognitive Signal Interpretation Engine
  const emotionalCognitiveRouter = require('./routes/emotional-cognitive').default;
  // VTID-01084: Community Personalization v1 - longevity-focused groups/meetups
  const communityRouter = require('./routes/community').default;
  // VTID-01087: Relationship Graph Memory Routes
  const relationshipsRouter = require('./routes/relationships').default;
  // VTID-01090: Live Rooms + Events as Relationship Nodes
  const liveRouter = require('./routes/live').default;
  const { communityMeetupRouter } = require('./routes/live');
  // VTID-01094: Match Quality Feedback Loop
  const matchFeedbackRouter = require('./routes/match-feedback').default;
  const { personalizationRouter } = require('./routes/match-feedback');
  // VTID-01121: User Feedback, Correction & Trust Repair Engine
  const feedbackCorrectionRouter = require('./routes/feedback-correction').default;
  // VTID-01097: Diary Templates Gateway - guided diary templates
  const diaryRouter = require('./routes/diary').default;
  // VTID-01114: Domain & Topic Routing Engine (D22) - intelligence traffic control
  const domainRoutingRouter = require('./routes/domain-routing').default;
  // VTID-01119: User Preference & Constraint Modeling Engine
  const userPreferencesRouter = require('./routes/user-preferences').default;
  // VTID-01126: D32 Situational Awareness Engine - situation understanding layer
  const situationalAwarenessRouter = require('./routes/situational-awareness').default;
  // VTID-01127: D33 Availability, Time-Window & Readiness Engine
  const availabilityReadinessRouter = require('./routes/availability-readiness').default;
  // VTID-01128: D34 Environmental, Location & Mobility Context Engine
  const environmentalMobilityRouter = require('./routes/environmental-mobility-context').default;
  // VTID-01129: D35 Social Context, Relationship Weighting & Proximity Engine
  const socialContextRouter = require('./routes/social-context').default;
  // VTID-01130: D36 Financial Sensitivity, Monetization Readiness & Value Perception Engine
  const financialMonetizationRouter = require('./routes/financial-monetization').default;
  // VTID-01122: D37 Health State, Energy & Capacity Awareness Engine
  const healthCapacityRouter = require('./routes/health-capacity').default;
  // VTID-01133: D39 Taste, Aesthetic & Lifestyle Alignment Engine
  const tasteAlignmentRouter = require('./routes/taste-alignment').default;
  // VTID-01135: D41 Ethical Boundaries, Personal Limits & Consent Sensitivity Engine
  const boundaryConsentRouter = require('./routes/boundary-consent').default;
  // VTID-01137: D43 Longitudinal Adaptation, Drift Detection & Personal Evolution Engine
  const longitudinalAdaptationRouter = require('./routes/longitudinal-adaptation').default;
  // VTID-01138: D44 Proactive Signal Detection & Early Intervention Engine
  const signalDetectionRouter = require('./routes/signal-detection').default;
  // VTID-01139: D45 Predictive Risk Windows & Opportunity Forecasting Engine
  const predictiveForecastingRouter = require('./routes/predictive-forecasting').default;
  // VTID-01144: D50 Positive Trajectory Reinforcement & Momentum Engine
  const positiveTrajectoryReinforcementRouter = require('./routes/positive-trajectory-reinforcement').default;
  // VTID-01124: D40 Life Stage, Goals & Trajectory Awareness Engine
  const lifeStageAwarenessRouter = require('./routes/life-stage-awareness').default;
  // VTID-01141: D47 Proactive Social & Community Alignment Engine
  const socialAlignmentRouter = require('./routes/social-alignment').default;
  // VTID-01142: D48 Context-Aware Opportunity & Experience Surfacing Engine
  const opportunitySurfacingRouter = require('./routes/opportunity-surfacing').default;
  // VTID-01143: D49 Proactive Health & Lifestyle Risk Mitigation Layer
  const riskMitigationRouter = require('./routes/risk-mitigation').default;
  // VTID-01145: D51 Predictive Fatigue, Burnout & Overload Detection Engine
  const overloadDetectionRouter = require('./routes/overload-detection').default;
  // VTID-01146: Execute VTID Runner (One-Button End-to-End Pipeline)
  const { router: executeRouter } = require('./routes/execute');
  // VTID-01163 + VTID-01183: Worker Sub-Agents + Orchestrator + Connector
  const { workerOrchestratorRouter } = require('./routes/worker-orchestrator');
  // Agents Registry — single source of truth for every LLM-powered workload
  const { agentsRegistryRouter, bootstrapEmbeddedAgents } = require('./routes/agents-registry');
  // Incident Triage Agent — Claude Managed Agents proxy for Voice Lab investigations
  const { triageAgentRouter } = require('./routes/triage-agent');
  // VTID-01148: Approvals API v1 — Pending Queue + Count + Approve/Reject
  const approvalsRouter = require('./routes/approvals').default;
  // VTID-01169: Deploy → Ledger Terminalization (terminalize endpoint + repair job)
  const vtidTerminalizeRouter = require('./routes/vtid-terminalize').default;
  // VTID-01157: Supabase JWT Auth Middleware + /api/v1/auth/me endpoint
  const authRouter = require('./routes/auth').default;
  // VTID-01180: Autopilot Recommendation Inbox API v0 + Popup Wiring (legacy)
  const recommendationInboxRouter = require('./routes/recommendation-inbox').default;
  // VTID-01180: Autopilot Recommendations API v1 (correct implementation)
  const autopilotRecommendationsRouter = require('./routes/autopilot-recommendations').default;
  // VTID-01250: Social Connect (AP-1305/AP-1306)
  const socialConnectRouter = require('./routes/social-connect').default;
  // Intelligent Calendar — Phase 1: Backend Calendar API
  const calendarRouter = require('./routes/calendar').default;
  // VTID-01188: Unified "Generate Spec" Pipeline Routes
  const { specsRouter } = require('./routes/specs');
  // Email Intake — Receives emails from Cloudflare Email Worker, creates tasks
  const { emailIntakeRouter } = require('./routes/email-intake');
  // VTID-01208: LLM Routing Policy & Telemetry API
  const llmRouter = require('./routes/llm').default;
  // VTID-01223: Interactive Visual Testing API
  const visualInteractiveRouter = require('./routes/visual-interactive').default;
  // VTID-01231: Stripe Connect Express Backend
  const creatorsRouter = require('./routes/creators').default;
  const stripeConnectWebhookRouter = require('./routes/stripe-connect-webhook').default;
  // Notification System — FCM push + in-app notification history
  const notificationsRouter = require('./routes/notifications').default;
  // Chat — User-to-user direct messaging
  const chatRouter = require('./routes/chat').default;
  // Admin: Signup Funnel Tracking & Outreach
  const adminSignupsRouter = require('./routes/admin-signups').default;
  // Admin: Notification Compose & Tracking
  const adminNotificationsRouter = require('./routes/admin-notifications').default;
  // Admin: Notification Category Management (CRUD + Test)
  const adminNotificationCategoriesRouter = require('./routes/admin-notification-categories').default;
  // User: Notification Category Preferences (toggle categories on/off)
  const userCategoryPreferencesRouter = require('./routes/user-category-preferences').default;
  // Admin: User Management & Role Distribution
  const adminUsersRouter = require('./routes/admin-users').default;
  // Admin: Tenant Management
  const adminTenantsRouter = require('./routes/admin-tenants').default;
  // Admin: Content Moderation
  const adminModerationRouter = require('./routes/admin-moderation').default;
  // Batch 1.B1: Tenant Invitations — create, list, revoke, accept
  const tenantInvitationsRouter = require('./routes/tenant-admin/invitations').default;
  const { acceptRouter: invitationAcceptRouter } = require('./routes/tenant-admin/invitations');
  // Batch 1.B2: Tenant Assistant Config — per-tenant AI personality overrides
  const tenantAssistantConfigRouter = require('./routes/tenant-admin/assistant-config').default;
  // Batch 1.B2: Tenant Knowledge Base — per-tenant KB docs, opt-outs, search
  const tenantKnowledgeRouter = require('./routes/tenant-admin/knowledge').default;
  // Overview Dashboard — KPI summary, at-risk, activity, alerts
  const tenantOverviewRouter = require('./routes/tenant-admin/overview').default;
  // Settings — tenant profile, branding, feature flags, integrations
  const tenantSettingsRouter = require('./routes/tenant-admin/settings').default;
  // Audit & Compliance — admin action audit log, access log
  const tenantAuditRouter = require('./routes/tenant-admin/audit-log').default;
  // Content Moderation — review queue for user-submitted content
  const contentModerationRouter = require('./routes/tenant-admin/content-moderation').default;
  // Community Admin — admin-scoped reads of meetups, groups, live rooms, creators
  const communityAdminRouter = require('./routes/tenant-admin/community-admin').default;
  // VTID-NAV-02: Admin Navigator — DB-backed catalog CRUD, simulate, coverage, telemetry
  const adminNavigatorRouter = require('./routes/admin-navigator').default;
  // VTID-AP-ADMIN: Tenant-scoped Autopilot admin — settings, bindings, runs, recommendations
  const adminAutopilotRouter = require('./routes/admin-autopilot').default;
  // VTID-NAV-02: Navigator catalog DB cache warmer (runs at boot)
  const { warmNavCatalogCache } = require('./lib/nav-catalog-db');
  // Voice Feedback — Test user bug reports & UX improvement suggestions
  const voiceFeedbackRouter = require('./routes/voice-feedback').default;
  // VTID-01250: Autopilot Automations Engine — AP-XXXX registry, executor, wallet, sharing
  const automationsRouter = require('./routes/automations').default;
  // Self-Healing System — Autonomous detection, diagnosis, fix, and verification pipeline
  const selfHealingRouter = require('./routes/self-healing').default;

  // CORS setup - DEV-OASIS-0101
  setupCors(app);
  app.use(sseHeaders);

  // VTID-01230: Raw body parser for Stripe webhooks (MUST come BEFORE express.json())
  app.use('/api/v1/stripe/webhook', express.raw({ type: 'application/json' }));

  // Middleware - IMPORTANT: JSON body parser must come before route handlers
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // Alive endpoint for deployment validation
  app.get('/alive', (req, res) => {
    res.json({ status: 'ok', service: 'gateway', timestamp: new Date().toISOString() });
  });

  // Debug route to verify this code is deployed
  app.get('/debug/governance-ping', (_req, res) => {
    res.json({ ok: true, message: 'governance debug route reached', timestamp: new Date().toISOString() });
  });

  // VTID-0524: Diagnostic endpoint to verify deployed code version
  app.get('/debug/vtid-0524', (_req, res) => {
    res.json({
      ok: true,
      vtid: 'VTID-0524',
      description: 'Operator History & Versions Rewire - VTID/SWV Source of Truth',
      build: 'vtid-0524-fix-routes-' + Date.now(),
      fixes: [
        'Removed duplicate operatorRouter mount at /api/v1 (was causing route conflicts)',
        'Moved boardAdapter mount after express.json() (body parsing fix)',
        'Removed duplicate boardAdapter mounts',
        'Cleaned up middleware ordering'
      ],
      timestamp: new Date().toISOString(),
      env: {
        hasSupabaseUrl: !!process.env.SUPABASE_URL,
        hasSupabaseKey: !!process.env.SUPABASE_SERVICE_ROLE,
        hasGitHubToken: !!process.env.GITHUB_SAFE_MERGE_TOKEN,
        nodeEnv: process.env.NODE_ENV || 'development'
      }
    });
  });

  // VTID-0600: Debug route to verify FIX deployment
  app.get('/debug/vtid-0600-check', (_req, res) => {
    res.json({
      ok: true,
      vtid: 'VTID-0600',
      status: 'FIX_DEPLOYED',
      timestamp: new Date().toISOString()
    });
  });

  // VTID-0538-D: Diagnostic endpoint to verify Knowledge Hub routes are deployed
  app.get('/debug/vtid-0538-routes', (_req, res) => {
    const assistantRoutes: string[] = [];
    try {
      const assistantStack = (assistantRouter as any).stack || [];
      assistantStack.forEach((layer: any) => {
        if (layer.route) {
          const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
          assistantRoutes.push(`${methods} ${layer.route.path}`);
        }
      });
    } catch (e: any) {
      // Fallback - just report what we know
    }

    const hasKnowledgeHealthRoute = assistantRoutes.some(r => r.includes('/knowledge/health'));
    const hasKnowledgeSearchRoute = assistantRoutes.some(r => r.includes('/knowledge/search'));

    let buildInfo: string | null = null;
    try {
      const buildInfoPath = path.join(__dirname, '..', 'BUILD_INFO');
      if (fs.existsSync(buildInfoPath)) {
        buildInfo = fs.readFileSync(buildInfoPath, 'utf-8').trim();
      }
    } catch (e) {
      // Ignore
    }

    res.json({
      ok: hasKnowledgeHealthRoute && hasKnowledgeSearchRoute,
      vtid: 'VTID-0538-D',
      description: 'Knowledge Hub Routes Verification',
      verification: {
        hasKnowledgeHealthRoute,
        hasKnowledgeSearchRoute,
        totalAssistantRoutes: assistantRoutes.length,
        assistantRoutes
      },
      buildInfo,
      buildCommit: process.env.BUILD_COMMIT || null,
      timestamp: new Date().toISOString()
    });
  });

  // VTID-0529-C: Diagnostic endpoint to verify Command Hub bundle at runtime
  app.get('/debug/vtid-0529', (_req, res) => {
    const staticPath = path.join(__dirname, 'frontend/command-hub');
    let files: string[] = [];
    let appJsPreview = '';
    let stylesPreview = '';
    let error = '';

    try {
      if (fs.existsSync(staticPath)) {
        files = fs.readdirSync(staticPath);

        const appJsPath = path.join(staticPath, 'app.js');
        if (fs.existsSync(appJsPath)) {
          const content = fs.readFileSync(appJsPath, 'utf-8');
          appJsPreview = content.split('\n').slice(0, 5).join('\n');
        }

        const stylesPath = path.join(staticPath, 'styles.css');
        if (fs.existsSync(stylesPath)) {
          const content = fs.readFileSync(stylesPath, 'utf-8');
          const lines = content.split('\n');
          const idx = lines.findIndex(l => l.includes('VTID-0529'));
          if (idx >= 0) {
            stylesPreview = lines.slice(idx, idx + 3).join('\n');
          } else {
            stylesPreview = 'VTID-0529 fingerprint CSS NOT FOUND';
          }
        }
      } else {
        error = 'Static path does not exist!';
      }
    } catch (e: any) {
      error = e.message;
    }

    res.json({
      ok: !error,
      vtid: 'VTID-0529-C',
      description: 'Command Hub Bundle Verification',
      runtime: {
        __dirname,
        staticPath,
        staticPathExists: fs.existsSync(staticPath),
        files,
        appJsPreview,
        stylesPreview
      },
      error: error || undefined,
      timestamp: new Date().toISOString()
    });
  });

  // =============================================================================
  // VTID-01063: Mount routes with Route Guard protection
  // Platform invariant: One endpoint = one authoritative handler
  // =============================================================================

  // Core API routes
  mountRouterSync(app, '/api/v1/governance', governanceRouter, { owner: 'governance' });
  // VTID-01181: Governance Controls v1 - System Arming Panel (arm/disarm without redeploy)
  mountRouterSync(app, '/api/v1/governance/controls', governanceControlsRouter, { owner: 'governance-controls' });
  mountRouterSync(app, '/api/v1/vtid', vtidRouter, { owner: 'vtid' });

  // VTID-0516: Autonomous Safe-Merge Layer - CICD routes
  // Note: Same router mounted at multiple paths is allowed (different effective routes)
  mountRouterSync(app, '/api/v1/github', cicdRouter, { owner: 'cicd-github' });
  mountRouterSync(app, '/api/v1/deploy', cicdRouter, { owner: 'cicd-deploy' });
  mountRouterSync(app, '/api/v1/cicd', cicdRouter, { owner: 'cicd' });

  // Testing & QA — E2E test execution, run history, test cycles
  const testingRouter = require('./routes/testing').default;
  mountRouterSync(app, '/api/v1/testing', testingRouter, { owner: 'testing-qa' });

  // VTID-01146: Execute VTID Runner (One-Button End-to-End Pipeline)
  mountRouterSync(app, '/api/v1/execute', executeRouter, { owner: 'execute-runner' });

  // VTID-01188: Unified "Generate Spec" Pipeline (generate/validate/approve/get)
  mountRouterSync(app, '/api/v1/specs', specsRouter, { owner: 'specs-pipeline' });

  // VTID-01148: Approvals API v1 — Pending Queue + Count + Approve/Reject (Gateway + OASIS-backed)
  mountRouterSync(app, '/api/v1/approvals', approvalsRouter, { owner: 'approvals-api' });

  // Email Intake — Receives emails from Cloudflare Email Worker, creates scheduled tasks
  mountRouterSync(app, '/api/v1/intake', emailIntakeRouter, { owner: 'email-intake' });

  // VTID-01208: LLM Routing Policy & Telemetry API
  mountRouterSync(app, '/api/v1/llm', llmRouter, { owner: 'llm-routing-telemetry' });

  // VTID-01223: Interactive Visual Testing API
  mountRouterSync(app, '/api/v1/visual', visualInteractiveRouter, { owner: 'visual-interactive-testing' });

  // VTID-01163 + VTID-01183: Worker Sub-Agents + Orchestrator + Connector
  mountRouterSync(app, '/', workerOrchestratorRouter, { owner: 'worker-orchestrator' });

  // Agents Registry — replaces the hardcoded subagents array with a real, queryable registry
  mountRouterSync(app, '/', agentsRegistryRouter, { owner: 'agents-registry' });

  // Incident Triage Agent — Claude Managed Agents proxy for Voice Lab
  mountRouterSync(app, '/api/v1/agents/triage', triageAgentRouter, { owner: 'triage-agent' });

  // VTID-0509 + VTID-0510: Operator Console & Version Tracking
  mountRouterSync(app, '/api/v1/operator', operatorRouter, { owner: 'operator' });

  // VTID-0526-D: Telemetry routes with stage counters
  mountRouterSync(app, '/api/v1/telemetry', telemetryRouter, { owner: 'telemetry' });

  // VTID-0532: Autopilot Task Extractor & Planner Handoff
  mountRouterSync(app, '/api/v1/autopilot', autopilotRouter, { owner: 'autopilot' });

  // VTID-01089: Autopilot Matchmaking Prompts (prefs, prompts/today, prompts/generate, prompts/:id/action)
  mountRouterSync(app, '/api/v1/autopilot', autopilotPromptsRouter, { owner: 'autopilot-prompts' });

  // VTID-01180: Autopilot Recommendations API v1 (correct implementation with activate endpoint)
  mountRouterSync(app, '/api/v1/autopilot/recommendations', autopilotRecommendationsRouter, { owner: 'autopilot-recommendations' });

  // VTID-01250: Social Connect — OAuth, profile enrichment, auto-share (AP-1305/AP-1306)
  mountRouterSync(app, '/api/v1/social-accounts', socialConnectRouter, { owner: 'social-connect' });

  // VTID-01180: Autopilot Recommendation Inbox API v0 + Popup Wiring (legacy - kept for backwards compatibility)
  mountRouterSync(app, '/api/v1/recommendations', recommendationInboxRouter, { owner: 'recommendation-inbox' });

  // Intelligent Calendar — role-aware calendar API (Phase 1)
  mountRouterSync(app, '/api/v1/calendar', calendarRouter, { owner: 'calendar' });

  // VTID-0150-B + VTID-0151 + VTID-0538: Assistant Core + Knowledge Hub
  mountRouterSync(app, '/api/v1/assistant', assistantRouter, { owner: 'assistant' });

  // DEV-COMHU-2025-0014: ORB Multimodal v1 - Live Voice Session (Gemini API, SSE)
  mountRouterSync(app, '/api/v1/orb', orbLiveRouter, { owner: 'orb-live' });

  // VTID-01218A: Voice LAB - ORB Live Observability API
  mountRouterSync(app, '/api/v1/voice-lab', voiceLabRouter, { owner: 'voice-lab' });

  // AI Personality Configuration API
  mountRouterSync(app, '/api/v1/ai-personality', aiPersonalityRouter, { owner: 'ai-personality' });

  // VTID-01216: Unified Conversation Intelligence Layer (ORB + Operator shared brain)
  mountRouterSync(app, '/api/v1/conversation', conversationRouter, { owner: 'conversation-intelligence' });

  // VITANA-BRAIN: Temporary test endpoint for brain integration testing (Phase 1)
  app.post('/api/v1/brain/test', async (req, res) => {
    try {
      const { processBrainTurn } = require('./services/vitana-brain');
      const { message, user_id, tenant_id, role, channel } = req.body;
      if (!message || !user_id || !tenant_id) {
        return res.status(400).json({ ok: false, error: 'message, user_id, tenant_id required' });
      }
      const result = await processBrainTurn({
        channel: channel || 'orb',
        tenant_id,
        user_id,
        role: role || 'community',
        message,
      });
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // VTID-01046: Me Context - role context and active role switching
  mountRouterSync(app, '/api/v1/me', meRouter, { owner: 'me-context' });

  // VTID-01047: Dev Token Mint Endpoint (dev-sandbox only)
  mountRouterSync(app, '/api/v1/dev/auth', devAuthRouter, { owner: 'dev-auth' });

  // VTID-01172: Dev Access Management - exafy_admin toggle (users, grant, revoke)
  mountRouterSync(app, '/api/v1/dev-access', devAccessRouter, { owner: 'dev-access' });

  // VTID-01230: Role Admission Management - grant/revoke/list permitted roles
  mountRouterSync(app, '/api/v1/roles', roleAdminRouter, { owner: 'role-admin' });

  // VTID-01157: Supabase JWT Auth Middleware + /api/v1/auth/me endpoint
  mountRouterSync(app, '/api/v1/auth', authRouter, { owner: 'auth' });

  // VTID-01081 + VTID-01103: Health Gateway (C2 ingest + C3 compute)
  mountRouterSync(app, '/api/v1/health', healthRouter, { owner: 'health' });

  // VTID-01105: Memory Gateway - write/context endpoints for ORB memory
  mountRouterSync(app, '/api/v1/memory', memoryRouter, { owner: 'memory' });
  // VTID-01099: Memory Governance - visibility, lock, delete, export endpoints
  mountRouterSync(app, '/api/v1/memory', memoryGovernanceRouter, { owner: 'memory-governance' });
  // VTID-01184: Supabase Semantic Memory - pgvector similarity search + embedding pipeline
  mountRouterSync(app, '/api/v1/memory', semanticMemoryRouter, { owner: 'semantic-memory' });

  // VTID-01095: Daily Scheduler - daily recompute pipeline
  mountRouterSync(app, '/api/v1/scheduler', schedulerRouter, { owner: 'scheduler' });
  // Scheduled notification webhooks (Cloud Scheduler triggers)
  mountRouterSync(app, '/api/v1/scheduled-notifications', scheduledNotificationsRouter, { owner: 'scheduled-notifications' });

  // VTID-01093: Unified Interest Topics Layer - topic registry + user profile
  mountRouterSync(app, '/api/v1/topics', topicsRouter, { owner: 'topics' });

  // VTID-01092: Services + Products as Relationship Memory (catalog + offers)
  mountRouterSync(app, '/api/v1', offersRouter, { owner: 'offers' });

  // VTID-01091: Locations Memory + Discovery + Preferences
  mountRouterSync(app, '/api/v1/locations', locationsRouter, { owner: 'locations' });
  mountRouterSync(app, '/api/v1/discover', discoveryRouter, { owner: 'discovery' });
  mountRouterSync(app, '/api/v1/location', locationPrefsRouter, { owner: 'location-prefs' });

  // VTID-01088: Matchmaking Engine v1 - deterministic matching for longevity community
  mountRouterSync(app, '/api/v1/match', matchmakingRouter, { owner: 'matchmaking' });

  // VTID-01094: Match Quality Feedback Loop - feedback on matches (mounted after matchmaking for /:id/feedback)
  mountRouterSync(app, '/api/v1/match', matchFeedbackRouter, { owner: 'match-feedback' });
  mountRouterSync(app, '/api/v1/personalization', personalizationRouter, { owner: 'personalization-changes' });

  // VTID-01096: Cross-Domain Personalization v1 (snapshot endpoint)
  mountRouterSync(app, '/api/v1/personalization', personalizationSnapshotRouter, { owner: 'personalization-snapshot' });

  // VTID-01121: User Feedback, Correction & Trust Repair Engine
  mountRouterSync(app, '/api/v1/feedback', feedbackCorrectionRouter, { owner: 'feedback-correction' });

  // Voice Feedback — Test user bug reports & UX improvement suggestions
  mountRouterSync(app, '/api/v1/voice-feedback', voiceFeedbackRouter, { owner: 'voice-feedback' });

  // VTID-01083: Longevity Signal Layer - diary/memory to health signals bridge
  mountRouterSync(app, '/api/v1/longevity', longevityRouter, { owner: 'longevity' });

  // VTID-01120: D28 Emotional & Cognitive Signal Interpretation Engine
  mountRouterSync(app, '/api/v1/signals', emotionalCognitiveRouter, { owner: 'emotional-cognitive' });

  // VTID-01084: Community Personalization v1 - groups, meetups, recommendations
  mountRouterSync(app, '/api/v1/community', communityRouter, { owner: 'community' });

  // VTID-01087: Relationship Graph Memory - matchmaking spine
  mountRouterSync(app, '/api/v1/relationships', relationshipsRouter, { owner: 'relationships' });

  // VTID-01129: D35 Social Context, Relationship Weighting & Proximity Engine
  mountRouterSync(app, '/api/v1/social', socialContextRouter, { owner: 'social-context' });

  // VTID-01090: Live Rooms + Events as Relationship Nodes
  mountRouterSync(app, '/api/v1/live', liveRouter, { owner: 'live' });

  // VTID-01231: Stripe Connect Express Backend
  mountRouterSync(app, '/api/v1/creators', creatorsRouter, { owner: 'creators' });
  mountRouterSync(app, '/api/v1/stripe', stripeConnectWebhookRouter, { owner: 'stripe-connect-webhook' });

  // Notification System — FCM push notifications + in-app history
  mountRouterSync(app, '/api/v1/notifications', notificationsRouter, { owner: 'notifications' });

  // Chat — User-to-user direct messaging
  mountRouterSync(app, '/api/v1/chat', chatRouter, { owner: 'chat' });

  // Admin: Signup Funnel Tracking & Outreach
  mountRouterSync(app, '/api/v1/admin/signups', adminSignupsRouter, { owner: 'admin-signups' });

  // Admin: Notification Compose & Tracking
  mountRouterSync(app, '/api/v1/admin/notifications', adminNotificationsRouter, { owner: 'admin-notifications' });

  // Admin: Notification Category Management
  mountRouterSync(app, '/api/v1/admin/notification-categories', adminNotificationCategoriesRouter, { owner: 'admin-notification-categories' });

  // User: Notification Category Preferences
  mountRouterSync(app, '/api/v1/notifications/category-preferences', userCategoryPreferencesRouter, { owner: 'user-category-preferences' });

  // Admin: User Management & Role Distribution
  mountRouterSync(app, '/api/v1/admin/users', adminUsersRouter, { owner: 'admin-users' });

  // Admin: Tenant Management
  mountRouterSync(app, '/api/v1/admin/tenants', adminTenantsRouter, { owner: 'admin-tenants' });

  // Admin: Content Moderation
  mountRouterSync(app, '/api/v1/admin/moderation', adminModerationRouter, { owner: 'admin-moderation' });

  // Batch 1.B1: Tenant Invitations — per-tenant invite/accept flow
  mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/invitations', tenantInvitationsRouter, { owner: 'tenant-invitations' });
  mountRouterSync(app, '/api/v1/admin/invitations', invitationAcceptRouter, { owner: 'invitation-accept' });
  // Batch 1.B2: Tenant Assistant Config — per-tenant AI personality overrides
  mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/assistant', tenantAssistantConfigRouter, { owner: 'tenant-assistant-config' });
  // Batch 1.B2: Tenant Knowledge Base — per-tenant KB docs, search, opt-outs
  mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/kb', tenantKnowledgeRouter, { owner: 'tenant-knowledge' });
  // Overview Dashboard — KPI summary, at-risk, activity, alerts
  mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/overview', tenantOverviewRouter, { owner: 'tenant-overview' });
  // Settings — tenant profile, branding, feature flags
  mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/settings', tenantSettingsRouter, { owner: 'tenant-settings' });
  // Audit & Compliance — admin action audit log
  mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/audit', tenantAuditRouter, { owner: 'tenant-audit' });
  // Content Moderation — review queue for user-submitted content
  mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/content', contentModerationRouter, { owner: 'content-moderation' });
  // Community Admin — admin-scoped reads of community data
  mountRouterSync(app, '/api/v1/admin/tenants/:tenantId/community', communityAdminRouter, { owner: 'community-admin' });

  // VTID-NAV-02: Admin Navigator — catalog/simulate/coverage/telemetry
  mountRouterSync(app, '/api/v1/admin/navigator', adminNavigatorRouter, { owner: 'admin-navigator' });

  // VTID-AP-ADMIN: Autopilot admin — settings, bindings, catalog, runs, recommendations
  mountRouterSync(app, '/api/v1/admin/autopilot', adminAutopilotRouter, { owner: 'admin-autopilot' });

  // VTID-01250: Autopilot Automations Engine — AP-XXXX registry, executor, wallet, sharing
  mountRouterSync(app, '/api/v1/automations', automationsRouter, { owner: 'automations' });

  // Self-Healing System — Autonomous detection, diagnosis, fix, and verification
  mountRouterSync(app, '/api/v1/self-healing', selfHealingRouter, { owner: 'self-healing' });

  // VTID-01097: Diary Templates - guided diary templates for memory quality
  mountRouterSync(app, '/api/v1/diary', diaryRouter, { owner: 'diary' });

  // VTID-01114: Domain & Topic Routing Engine (D22) - intelligence traffic control layer
  mountRouterSync(app, '/api/v1/routing', domainRoutingRouter, { owner: 'domain-routing' });

  // VTID-01119: User Preference & Constraint Modeling Engine
  mountRouterSync(app, '/api/v1/user-preferences', userPreferencesRouter, { owner: 'user-preferences' });

  // VTID-01126: D32 Situational Awareness Engine - situation understanding layer
  mountRouterSync(app, '/api/v1/situational', situationalAwarenessRouter, { owner: 'situational-awareness' });

  // VTID-01127: D33 Availability, Time-Window & Readiness Engine
  mountRouterSync(app, '/api/v1/availability', availabilityReadinessRouter, { owner: 'availability-readiness' });

  // VTID-01128: D34 Environmental, Location & Mobility Context Engine
  mountRouterSync(app, '/api/v1/context/mobility', environmentalMobilityRouter, { owner: 'environmental-mobility' });

  // VTID-01130: D36 Financial Sensitivity, Monetization Readiness & Value Perception Engine
  mountRouterSync(app, '/api/v1/monetization', financialMonetizationRouter, { owner: 'financial-monetization' });

  // VTID-01122: D37 Health State, Energy & Capacity Awareness Engine
  mountRouterSync(app, '/api/v1/capacity', healthCapacityRouter, { owner: 'health-capacity' });

  // VTID-01133: D39 Taste, Aesthetic & Lifestyle Alignment Engine
  mountRouterSync(app, '/api/v1/taste-alignment', tasteAlignmentRouter, { owner: 'taste-alignment' });

  // VTID-01135: D41 Ethical Boundaries, Personal Limits & Consent Sensitivity Engine
  mountRouterSync(app, '/api/v1/boundaries', boundaryConsentRouter, { owner: 'boundary-consent' });

  // VTID-01137: D43 Longitudinal Adaptation, Drift Detection & Personal Evolution Engine
  mountRouterSync(app, '/api/v1/longitudinal', longitudinalAdaptationRouter, { owner: 'longitudinal-adaptation' });

  // VTID-01138: D44 Proactive Signal Detection & Early Intervention Engine
  mountRouterSync(app, '/api/v1/predictive-signals', signalDetectionRouter, { owner: 'signal-detection' });

  // VTID-01139: D45 Predictive Risk Windows & Opportunity Forecasting Engine
  mountRouterSync(app, '/api/v1/forecast', predictiveForecastingRouter, { owner: 'predictive-forecasting' });

  // VTID-01144: D50 Positive Trajectory Reinforcement & Momentum Engine
  mountRouterSync(app, '/api/v1/reinforcement', positiveTrajectoryReinforcementRouter, { owner: 'positive-trajectory-reinforcement' });

  // VTID-01124: D40 Life Stage, Goals & Trajectory Awareness Engine
  mountRouterSync(app, '/api/v1/life-stage', lifeStageAwarenessRouter, { owner: 'life-stage-awareness' });

  // VTID-01141: D47 Proactive Social & Community Alignment Engine
  mountRouterSync(app, '/api/v1/alignment', socialAlignmentRouter, { owner: 'social-alignment' });

  // VTID-01142: D48 Context-Aware Opportunity & Experience Surfacing Engine
  mountRouterSync(app, '/api/v1/opportunities', opportunitySurfacingRouter, { owner: 'opportunity-surfacing' });

  // VTID-01143: D49 Proactive Health & Lifestyle Risk Mitigation Layer
  mountRouterSync(app, '/api/v1/mitigation', riskMitigationRouter, { owner: 'risk-mitigation' });

  // VTID-01145: D51 Predictive Fatigue, Burnout & Overload Detection Engine
  mountRouterSync(app, '/api/v1/overload', overloadDetectionRouter, { owner: 'overload-detection' });

  // VTID-01063: commandhub router (note: /board route REMOVED, use board-adapter)
  mountRouterSync(app, '/api/v1/commandhub', commandhub, { owner: 'commandhub' });

  // VTID-01058: Board adapter - SINGLE SOURCE OF TRUTH for board data
  mountRouterSync(app, '/api/v1/commandhub/board', boardAdapter, { owner: 'board-adapter' });

  // Tasks router (root path)
  mountRouterSync(app, '/', tasksRouter, { owner: 'tasks' });

  // Event routers (these define their own paths internally)
  mountRouterSync(app, '/', eventsApiRouter, { owner: 'events-api' });
  mountRouterSync(app, '/', eventsRouter, { owner: 'events' });
  mountRouterSync(app, '/', oasisTasksRouter, { owner: 'oasis-tasks' });

  // VTID-01020: VTID Ledger JSON endpoint
  mountRouterSync(app, '/', oasisVtidLedgerRouter, { owner: 'oasis-vtid-ledger' });

  // VTID-01169: Deploy → Ledger Terminalization (terminalize endpoint + repair job)
  mountRouterSync(app, '/', vtidTerminalizeRouter, { owner: 'vtid-terminalize' });

  // VTID-0529-C: Static files MUST be served BEFORE the router
  const staticPath = path.join(__dirname, 'frontend/command-hub');
  app.use('/command-hub', express.static(staticPath, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }));

  // Command Hub router handles HTML routes and API (after static files)
  mountRouterSync(app, '/command-hub', commandHubRouter, { owner: 'command-hub-ui' });

  // VTID-01218A: Voice LAB static files
  const voiceLabStaticPath = path.join(__dirname, 'frontend/voice-lab');
  app.use('/voice-lab', express.static(voiceLabStaticPath, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }));

  // VTID-01063: SSE service router NOT mounted - duplicate of /api/v1/events/stream in events.ts
  // The sseService.broadcast() method is still available for real-time push (used by auto-logger)
  // but the canonical SSE endpoint is the database-polling route in events.ts
  // sseService.router is intentionally NOT mounted to avoid duplicate route

  // VTID-01058: Board adapter also available at /api/v1/board for backward compat
  mountRouterSync(app, '/api/v1/board', boardAdapter, { owner: 'board-adapter-legacy' });

  // VTID-01063: Log route guard summary
  logStartupSummary();

  // Start server
  if (process.env.NODE_ENV !== 'test') {
    // VTID-01222: Capture HTTP server instance for WebSocket attachment
    const server = app.listen(PORT, async () => {
      console.log('✅ Gateway server running on port ' + PORT);
      console.log('📊 Command Hub: http://localhost:' + PORT + '/command-hub');
      console.log('🔌 SSE Stream: http://localhost:' + PORT + '/api/v1/events/stream');
      console.log('Gateway: debug /debug/governance-ping route registered');
      console.log('Gateway: governance routes mounted at /api/v1/governance');
      console.log('Gateway: operator routes mounted at /api/v1/operator (VTID-0510)');

      // VTID-01222: Initialize ORB WebSocket server for Live API
      try {
        initializeOrbWebSocket(server);
        console.log('🔊 ORB WebSocket server initialized at /api/v1/orb/live/ws (VTID-01222)');
      } catch (error) {
        console.warn('⚠️ ORB WebSocket server initialization failed (non-fatal):', error);
      }

      // VTID-01178: Initialize autopilot controller (ensure VTIDs exist in ledger)
      try {
        const { initializeAutopilotController } = require('./services/autopilot-controller');
        await initializeAutopilotController();
        console.log('🤖 Autopilot controller initialized (VTID-01178)');
      } catch (error) {
        console.warn('⚠️ Autopilot controller initialization failed (non-fatal):', error);
      }

      // VTID-01179: Initialize autopilot event loop (if enabled)
      try {
        const { initializeEventLoop } = require('./services/autopilot-event-loop');
        await initializeEventLoop();
        const loopEnabled = process.env.AUTOPILOT_LOOP_ENABLED === 'true';
        if (loopEnabled) {
          console.log('🔄 Autopilot event loop started (VTID-01179)');
        } else {
          console.log('⏸️ Autopilot event loop disabled (VTID-01179) - set AUTOPILOT_LOOP_ENABLED=true to enable');
        }
      } catch (error) {
        console.warn('⚠️ Autopilot event loop initialization failed (non-fatal):', error);
      }

      // VTID-01250: Initialize Autopilot Automations Engine
      try {
        const { registerAllAutomationHandlers } = require('./services/automation-handlers');
        registerAllAutomationHandlers();
        const { getRegistrySummary } = require('./services/automation-registry');
        const summary = getRegistrySummary();
        console.log(`🔧 Automations engine initialized: ${summary.total} automations (${summary.executable} executable, ${summary.planned} planned)`);
      } catch (error) {
        console.warn('⚠️ Automations engine initialization failed (non-fatal):', error);
      }

      // VTID-01250: Start Heartbeat Loop for autopilot automations
      try {
        const heartbeatEnabled = process.env.AUTOPILOT_HEARTBEAT_ENABLED === 'true';
        const heartbeatTenantId = process.env.DEFAULT_TENANT_ID;
        if (heartbeatEnabled && heartbeatTenantId) {
          const { runHeartbeatCycle } = require('./services/automation-executor');
          const HEARTBEAT_INTERVAL_MS = parseInt(process.env.AUTOPILOT_HEARTBEAT_INTERVAL_MS || '60000', 10);
          let heartbeatRunning = false;
          setInterval(async () => {
            if (heartbeatRunning) return; // skip if previous cycle still running
            heartbeatRunning = true;
            try {
              const result = await runHeartbeatCycle(heartbeatTenantId);
              if (result.executed.length > 0 || result.failed.length > 0) {
                console.log(`[Heartbeat] executed=${result.executed.length} skipped=${result.skipped.length} failed=${result.failed.length}`);
              }
            } catch (err: any) {
              console.warn('[Heartbeat] Cycle error:', err.message || err);
            } finally {
              heartbeatRunning = false;
            }
          }, HEARTBEAT_INTERVAL_MS);
          console.log(`💓 Autopilot heartbeat loop started (interval: ${HEARTBEAT_INTERVAL_MS}ms, tenant: ${heartbeatTenantId.slice(0, 8)}…)`);
        } else {
          console.log('⏸️ Autopilot heartbeat loop disabled — set AUTOPILOT_HEARTBEAT_ENABLED=true and DEFAULT_TENANT_ID to enable');
        }
      } catch (error) {
        console.warn('⚠️ Autopilot heartbeat loop initialization failed (non-fatal):', error);
      }

      // VTID-01185: Initialize recommendation scheduler (autonomous self-improvement)
      try {
        const { startScheduler } = require('./services/recommendation-engine/scheduler');
        const schedulerEnabled = process.env.RECOMMENDATION_SCHEDULER_ENABLED !== 'false';
        if (schedulerEnabled) {
          startScheduler({
            enabled: true,
            basePath: process.env.VITANA_BASE_PATH || '/workspace/vitana-platform',
          });
          console.log('🧠 Recommendation scheduler started (VTID-01185)');
        } else {
          console.log('⏸️ Recommendation scheduler disabled (VTID-01185)');
        }
      } catch (error) {
        console.warn('⚠️ Recommendation scheduler initialization failed (non-fatal):', error);
      }

      // VTID-01185: Initialize autonomous self-improvement engine
      try {
        const { initializeAutonomousEngine } = require('./services/recommendation-engine/autonomous-engine');
        await initializeAutonomousEngine();
        console.log('🔄 Autonomous self-improvement engine initialized (VTID-01185)');
      } catch (error) {
        console.warn('⚠️ Autonomous engine initialization failed (non-fatal):', error);
      }

      // Self-Healing Reconciler: safety net for orphaned pending rows
      try {
        const reconcilerEnabled = process.env.SELF_HEALING_RECONCILER_ENABLED !== 'false';
        if (reconcilerEnabled) {
          const { startReconciler } = require('./services/self-healing-reconciler');
          startReconciler();
        } else {
          console.log('⏸️ Self-healing reconciler disabled (SELF_HEALING_RECONCILER_ENABLED=false)');
        }
      } catch (error) {
        console.warn('⚠️ Self-healing reconciler initialization failed (non-fatal):', error);
      }

      // AI Personality: Pre-warm config cache from Supabase
      try {
        const { warmPersonalityCache } = require('./services/ai-personality-service');
        await warmPersonalityCache();
        console.log('🧠 AI Personality config cache pre-warmed');
      } catch (error) {
        console.warn('⚠️ AI Personality cache warm failed (non-fatal, using defaults):', error);
      }

      // VTID-NAV-02: Pre-warm Navigator catalog DB cache + start periodic refresh
      try {
        warmNavCatalogCache();
        console.log('🧭 Navigator catalog DB cache warming (VTID-NAV-02)');

        // VTID-NAV-SEMANTIC: Pre-compute embedding vectors for semantic search.
        // Non-blocking — runs in the background, keyword scorer is the fallback
        // until embeddings are ready.
        const { warmCatalogEmbeddings } = require('./lib/navigation-catalog');
        warmCatalogEmbeddings()
          .then(() => console.log('🧠 Navigator semantic embeddings warmed'))
          .catch((err: any) => console.warn('⚠️ Semantic embedding warm failed (non-fatal):', err.message));
      } catch (error) {
        console.warn('⚠️ Navigator catalog cache warm failed (non-fatal, using static fallback):', error);
      }

      // Agents Registry: bootstrap Tier 2 (embedded) agents — they live in this
      // process so if the gateway is up, they are up. Marks each as healthy.
      try {
        await bootstrapEmbeddedAgents();
        console.log('📒 Agents registry: embedded agents bootstrapped');
      } catch (error) {
        console.warn('⚠️ Agents registry bootstrap failed (non-fatal):', error);
      }
    });
  }
}

export default app;
