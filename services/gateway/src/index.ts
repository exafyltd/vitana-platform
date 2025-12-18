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
  const { oasisTasksRouter } = require('./routes/oasis-tasks');
  const cicdRouter = require('./routes/cicd').default;
  const operatorRouter = require('./routes/operator').default;
  const { router: telemetryRouter } = require('./routes/telemetry');
  const autopilotRouter = require('./routes/autopilot').default;
  const assistantRouter = require('./routes/assistant').default;
  const orbLiveRouter = require('./routes/orb-live').default;

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

  // Mount routes
  app.use('/api/v1/governance', governanceRouter);
  app.use('/api/v1/vtid', vtidRouter);

  // VTID-0516: Autonomous Safe-Merge Layer - CICD routes
  app.use('/api/v1/github', cicdRouter);
  app.use('/api/v1/deploy', cicdRouter);
  app.use('/api/v1/cicd', cicdRouter);
  // VTID-0509 + VTID-0510: Operator Console & Version Tracking
  app.use('/api/v1/operator', operatorRouter);
  // VTID-0526-D: Telemetry routes with stage counters
  app.use('/api/v1/telemetry', telemetryRouter);
  // VTID-0532: Autopilot Task Extractor & Planner Handoff
  app.use('/api/v1/autopilot', autopilotRouter);
  // VTID-0150-B + VTID-0151 + VTID-0538: Assistant Core + Knowledge Hub
  app.use('/api/v1/assistant', assistantRouter);
  // DEV-COMHU-2025-0014: ORB Multimodal v1 - Live Voice Session (Gemini API, SSE)
  app.use('/api/v1/orb', orbLiveRouter);
  app.use('/api/v1/commandhub', commandhub);
  // Board adapter for commandhub
  app.use("/api/v1/commandhub/board", boardAdapter);
  app.use("/", tasksRouter);
  app.use(eventsApiRouter);
  app.use(eventsRouter);
  app.use(oasisTasksRouter);

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
  app.use('/command-hub', commandHubRouter);
  app.use(sseService.router);
  app.use('/api/v1/board', boardAdapter);

  // Start server
  if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
      console.log('✅ Gateway server running on port ' + PORT);
      console.log('📊 Command Hub: http://localhost:' + PORT + '/command-hub');
      console.log('🔌 SSE Stream: http://localhost:' + PORT + '/api/v1/events/stream');
      console.log('Gateway: debug /debug/governance-ping route registered');
      console.log('Gateway: governance routes mounted at /api/v1/governance');
      console.log('Gateway: operator routes mounted at /api/v1/operator (VTID-0510)');
    });
  }
}

export default app;
