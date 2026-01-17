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
  // VTID-01046: Me Context Routes - role context and role switching
  const meRouter = require('./routes/me').default;
  // VTID-01047: Dev Token Mint Endpoint (Cloud-Shell Friendly)
  const devAuthRouter = require('./routes/dev-auth').default;
  // VTID-01172: Dev Access Management - exafy_admin toggle for DEV admin users
  const devAccessRouter = require('./routes/dev-access').default;
  // VTID-01081 + VTID-01103: Health Gateway (C2 ingest + C3 compute)
  const healthRouter = require('./routes/health').default;
  // VTID-01105: Memory Gateway Routes - memory write/context for ORB
  const memoryRouter = require('./routes/memory').default;
  // VTID-01099: Memory Governance Routes - visibility, lock, delete, export
  const memoryGovernanceRouter = require('./routes/memory-governance').default;
  // VTID-01096: Cross-Domain Personalization v1 - snapshot endpoint
  const personalizationSnapshotRouter = require('./routes/personalization').default;
  // VTID-01095: Daily Scheduler Routes - daily recompute pipeline
  const schedulerRouter = require('./routes/scheduler').default;
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

  // CORS setup - DEV-OASIS-0101
  setupCors(app);
  app.use(sseHeaders);

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

  // VTID-01146: Execute VTID Runner (One-Button End-to-End Pipeline)
  mountRouterSync(app, '/api/v1/execute', executeRouter, { owner: 'execute-runner' });

  // VTID-01148: Approvals API v1 — Pending Queue + Count + Approve/Reject (Gateway + OASIS-backed)
  mountRouterSync(app, '/api/v1/approvals', approvalsRouter, { owner: 'approvals-api' });

  // VTID-01163 + VTID-01183: Worker Sub-Agents + Orchestrator + Connector
  mountRouterSync(app, '/', workerOrchestratorRouter, { owner: 'worker-orchestrator' });

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

  // VTID-01180: Autopilot Recommendation Inbox API v0 + Popup Wiring (legacy - kept for backwards compatibility)
  mountRouterSync(app, '/api/v1/recommendations', recommendationInboxRouter, { owner: 'recommendation-inbox' });

  // VTID-0150-B + VTID-0151 + VTID-0538: Assistant Core + Knowledge Hub
  mountRouterSync(app, '/api/v1/assistant', assistantRouter, { owner: 'assistant' });

  // DEV-COMHU-2025-0014: ORB Multimodal v1 - Live Voice Session (Gemini API, SSE)
  mountRouterSync(app, '/api/v1/orb', orbLiveRouter, { owner: 'orb-live' });

  // VTID-01046: Me Context - role context and active role switching
  mountRouterSync(app, '/api/v1/me', meRouter, { owner: 'me-context' });

  // VTID-01047: Dev Token Mint Endpoint (dev-sandbox only)
  mountRouterSync(app, '/api/v1/dev/auth', devAuthRouter, { owner: 'dev-auth' });

  // VTID-01172: Dev Access Management - exafy_admin toggle (users, grant, revoke)
  mountRouterSync(app, '/api/v1/dev-access', devAccessRouter, { owner: 'dev-access' });

  // VTID-01157: Supabase JWT Auth Middleware + /api/v1/auth/me endpoint
  mountRouterSync(app, '/api/v1/auth', authRouter, { owner: 'auth' });

  // VTID-01081 + VTID-01103: Health Gateway (C2 ingest + C3 compute)
  mountRouterSync(app, '/api/v1/health', healthRouter, { owner: 'health' });

  // VTID-01105: Memory Gateway - write/context endpoints for ORB memory
  mountRouterSync(app, '/api/v1/memory', memoryRouter, { owner: 'memory' });
  // VTID-01099: Memory Governance - visibility, lock, delete, export endpoints
  mountRouterSync(app, '/api/v1/memory', memoryGovernanceRouter, { owner: 'memory-governance' });

  // VTID-01095: Daily Scheduler - daily recompute pipeline
  mountRouterSync(app, '/api/v1/scheduler', schedulerRouter, { owner: 'scheduler' });

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
    app.listen(PORT, async () => {
      console.log('✅ Gateway server running on port ' + PORT);
      console.log('📊 Command Hub: http://localhost:' + PORT + '/command-hub');
      console.log('🔌 SSE Stream: http://localhost:' + PORT + '/api/v1/events/stream');
      console.log('Gateway: debug /debug/governance-ping route registered');
      console.log('Gateway: governance routes mounted at /api/v1/governance');
      console.log('Gateway: operator routes mounted at /api/v1/operator (VTID-0510)');

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
    });
  }
}

export default app;
