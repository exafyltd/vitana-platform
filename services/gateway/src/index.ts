import express from 'express';
import path from 'path';
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

// ... imports ...

// Debug route to verify this code is deployed
app.get('/debug/governance-ping', (_req, res) => {
  res.json({ ok: true, message: 'governance debug route reached', timestamp: new Date().toISOString() });
});

// Mount routes
app.use('/api/v1/governance', governanceRouter); // DEV-GOVBE-0106: Governance endpoints
app.use('/api/v1/vtid', vtidRouter);
app.use('/api/v1/commandhub', commandhub);
app.use("/", tasksRouter);
app.use(eventsApiRouter);
app.use(eventsRouter);
// Serve Command Hub static files BEFORE router (use absolute path from __dirname)
const staticPath = path.join(__dirname, 'frontend/command-hub');
app.use('/command-hub', express.static(staticPath));
app.use('/command-hub', commandHubRouter);
app.use(sseService.router);
app.use('/api/v1/board', boardAdapter); // Keep one canonical board adapter mount

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
  });
}

export default app;
