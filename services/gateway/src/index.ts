import express from 'express';
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

const app = express();
const PORT = process.env.PORT || 8080;

// CORS setup - DEV-OASIS-0101
setupCors(app);
app.use("/api/v1/commandhub/board", boardAdapter);
app.use(sseHeaders);

// Middleware
app.use("/api/v1/commandhub/board", boardAdapter);
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
app.use('/api/v1/commandhub', commandhub);
app.use('/api/v1', operatorRouter); // VTID-0509: Operator Console API
app.use("/", tasksRouter);
app.use(eventsApiRouter);
app.use(eventsRouter);
app.use(oasisTasksRouter); // OASIS Tasks API
app.use('/command-hub', commandHubRouter);
app.use(sseService.router);
app.use('/api/v1/board', boardAdapter); // Keep one canonical board adapter mount
app.use('/api/v1/board', boardAdapter); // Keep one canonical board adapter mount

// Serve Command Hub static files
const staticPath = process.env.NODE_ENV === 'production'
  ? 'dist/frontend/command-hub'
  : 'src/frontend/command-hub';
app.use('/command-hub', express.static(staticPath));

// VTID-0523: Global JSON error handlers - ensure all API errors return JSON, never HTML

// 404 handler for API routes
app.use('/api', (req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not Found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// Global error handler - catches all unhandled errors and returns JSON
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Gateway Error]', err.message || err);

  // Handle CORS errors specifically
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({
      ok: false,
      error: 'CORS Error',
      message: err.message,
      origin: req.headers.origin || 'unknown'
    });
  }

  // Handle all other errors
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    ok: false,
    error: err.message || 'Internal Server Error',
    path: req.path,
    timestamp: new Date().toISOString()
  });
});

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
// VTID-0509 build 1764361525
