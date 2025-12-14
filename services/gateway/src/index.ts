import express from 'express';
import path from 'path';
import fs from 'fs';
import boardAdapter from "./routes/board-adapter";
import { commandhub } from "./routes/commandhub";
import cors from 'cors';
import { vtidRouter } from './routes/vtid';
import { router as tasksRouter } from "./routes/tasks";
import { router as eventsRouter } from './routes/events';
import eventsApiRouter from './routes/gateway-events-api';
import commandHubRouter from './routes/command-hub';
import { sseService } from './services/sse-service';
import { setupCors, sseHeaders } from './middleware/cors';
import governanceRouter from './routes/governance';
import { oasisTasksRouter } from './routes/oasis-tasks';
import cicdRouter from './routes/cicd';
import operatorRouter from './routes/operator';  // VTID-0509 + VTID-0510: Operator Console & Version Tracking
import { router as telemetryRouter } from './routes/telemetry';  // VTID-0526-D: Telemetry with stage counters
import autopilotRouter from './routes/autopilot';  // VTID-0532: Autopilot Task Extractor & Planner Handoff
import assistantRouter from './routes/assistant';  // VTID-0150-B + VTID-0151: Assistant Core

const app = express();
const PORT = process.env.PORT || 8080;

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

// ... imports ...

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

      // Read first 5 lines of app.js to check fingerprint
      const appJsPath = path.join(staticPath, 'app.js');
      if (fs.existsSync(appJsPath)) {
        const content = fs.readFileSync(appJsPath, 'utf-8');
        appJsPreview = content.split('\n').slice(0, 5).join('\n');
      }

      // Check styles.css for fingerprint CSS
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
app.use('/api/v1/governance', governanceRouter); // DEV-GOVBE-0106: Governance endpoints
app.use('/api/v1/vtid', vtidRouter);

// VTID-0516: Autonomous Safe-Merge Layer - CICD routes
// Routes: /api/v1/github/create-pr, /api/v1/github/safe-merge
app.use('/api/v1/github', cicdRouter);
// Routes: /api/v1/deploy/service
app.use('/api/v1/deploy', cicdRouter);
// Routes: /api/v1/cicd/health
app.use('/api/v1/cicd', cicdRouter);
// VTID-0509 + VTID-0510: Operator Console & Version Tracking
// Routes: /api/v1/operator/health, /heartbeat, /history, /chat, /upload, /deployments
app.use('/api/v1/operator', operatorRouter);
// VTID-0526-D: Telemetry routes with stage counters
// Routes: /api/v1/telemetry/event, /batch, /health, /snapshot
app.use('/api/v1/telemetry', telemetryRouter);
// VTID-0532: Autopilot Task Extractor & Planner Handoff
// Routes: /api/v1/autopilot/tasks/pending-plan, /health
app.use('/api/v1/autopilot', autopilotRouter);
// VTID-0150-B + VTID-0151: Assistant Core (chat + multimodal live)
// Routes: /api/v1/assistant/chat, /live/init, /live/frame, /live/audio, /health
app.use('/api/v1/assistant', assistantRouter);
app.use('/api/v1/commandhub', commandhub);
// Board adapter for commandhub
app.use("/api/v1/commandhub/board", boardAdapter);
app.use("/", tasksRouter);
app.use(eventsApiRouter);
app.use(eventsRouter);
app.use(oasisTasksRouter); // OASIS Tasks API

// VTID-0529-C: Static files MUST be served BEFORE the router
// Otherwise, router's catch-all /* intercepts static file requests
// and next() doesn't properly reach express.static mounted at the same path.
const staticPath = path.join(__dirname, 'frontend/command-hub');
app.use('/command-hub', express.static(staticPath, {
  // Disable caching during debugging - remove in production if needed
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Command Hub router handles HTML routes and API (after static files)
app.use('/command-hub', commandHubRouter);
app.use(sseService.router);
app.use('/api/v1/board', boardAdapter); // Board adapter for v1 API

// Start server
if (process.env.NODE_ENV === 'test') {
  // Don't start server during tests
} else {
  app.listen(PORT, () => {
    console.log('✅ Gateway server running on port ' + PORT);
    console.log('📊 Command Hub: http://localhost:' + PORT + '/command-hub');
    console.log('🔌 SSE Stream: http://localhost:' + PORT + '/api/v1/events/stream');
    console.log('Gateway: debug /debug/governance-ping route registered');
    console.log('Gateway: governance routes mounted at /api/v1/governance');
    console.log('Gateway: operator routes mounted at /api/v1/operator (VTID-0510)');
  });
}

export default app;
// VTID-0524 build fix-routes-middleware-ordering
