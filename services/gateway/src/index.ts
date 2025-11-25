import express from 'express';
import path from 'path';
import cors from 'cors';
import boardAdapter from "./routes/board-adapter";
import { commandhub } from "./routes/commandhub";
import { router as vtidRouter } from './routes/vtid';
import { router as tasksRouter } from "./routes/tasks";
import { router as eventsRouter } from './routes/events';
import eventsApiRouter from './routes/gateway-events-api';
import commandHubRouter from './routes/command-hub';
import { sseService } from './services/sse-service';
import { setupCors, sseHeaders } from './middleware/cors';
import governanceRouter from './routes/governance';
import operatorRouter from './routes/operator';
import oasisRouter from './routes/oasis';

const app = express();
const PORT = process.env.PORT || 8080;

// CORS setup - DEV-OASIS-0101
setupCors(app);
app.use(sseHeaders);

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Debug route
app.get('/debug/governance-ping', (_req, res) => {
  res.json({ ok: true, message: 'governance debug route reached', timestamp: new Date().toISOString() });
});

// API Routes
app.use("/api/v1/commandhub/board", boardAdapter);
app.use('/api/v1/governance', governanceRouter);
app.use('/api/v1/vtid', vtidRouter);
app.use('/api/v1/commandhub', commandhub);
app.use('/api/v1/operator', operatorRouter);
app.use('/api/v1/oasis', oasisRouter);
app.use('/api/v1/board', boardAdapter);

// Event Routes
app.use(eventsApiRouter);
app.use(eventsRouter);
app.use(sseService.router);

// Tasks Router (Root mount)
app.use("/", tasksRouter);

// --- Command Hub v4 & Dev Screens ---

const staticDir =
  process.env.NODE_ENV === "production"
    ? path.join(process.cwd(), "dist/frontend/command-hub")
    : path.join(process.cwd(), "src/frontend/command-hub");

// Serve Static Assets
app.use('/command-hub', express.static(staticDir));

// Serve SPA for all 14 Dev Modules
const serveSpa = (_req: express.Request, res: express.Response) => {
  res.sendFile(path.join(staticDir, 'index.html'));
};

const spaPaths = [
  '/overview',
  '/operator',
  '/governance',
  '/agents',
  '/workflows',
  '/oasis',
  '/infrastructure',
  '/security-dev',
  '/integrations-tools',
  '/diagnostics',
  '/models-evaluations',
  '/testing-qa',
  '/intelligence-memory-dev',
  '/dev-tools'
];

spaPaths.forEach(p => {
  app.use(p, serveSpa);
});

// Legacy Command Hub Router (if needed for API/other routes not covered above)
app.use('/command-hub', commandHubRouter);

// Start server
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log('✅ Gateway server running on port ' + PORT);
    console.log('📊 Command Hub: http://localhost:' + PORT + '/command-hub');
    console.log('🔌 SSE Stream: http://localhost:' + PORT + '/api/v1/events/stream');
    console.log('Gateway: debug /debug/governance-ping route registered');
    console.log('Gateway: governance routes mounted at /api/v1/governance');
  });
}

export default app;
