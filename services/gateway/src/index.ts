import express from 'express';
import boardAdapter from "./routes/board-adapter";
import { commandhub } from "./routes/commandhub";
import cors from 'cors';
import { router as vtidRouter } from './routes/vtid';
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
app.use('/api/v1/operator', operatorRouter); // Task 44: Operator Console (Hotfix: Moved up)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Mount routes
import operatorRouter from './routes/operator';

// ... imports ...

// Mount routes
app.use('/api/v1/governance', governanceRouter); // DEV-GOVBE-0106: Governance endpoints
app.use('/api/v1/vtid', vtidRouter);
app.use('/api/v1/commandhub', commandhub);
app.use('/api/v1/operator', operatorRouter); // Task 44: Operator Console
app.use("/", tasksRouter);
app.use(eventsApiRouter);
app.use(eventsRouter);
app.use('/command-hub', commandHubRouter);
app.use(sseService.router);
app.use('/api/v1/board', boardAdapter); // Keep one canonical board adapter mount
app.use('/api/v1/board', boardAdapter); // Keep one canonical board adapter mount

// Serve Command Hub static files
const staticPath = process.env.NODE_ENV === 'production'
  ? 'dist/frontend/command-hub'
  : 'src/frontend/command-hub';
app.use('/command-hub', express.static(staticPath));

// Start server
if (process.env.NODE_ENV === 'test') {
  // Don't start server during tests
} else {
  app.listen(PORT, () => {
    console.log('âœ… Gateway server running on port ' + PORT);
    console.log('ðŸ“Š Command Hub: http://localhost:' + PORT + '/command-hub');
    console.log('ðŸ”Œ SSE Stream: http://localhost:' + PORT + '/api/v1/events/stream');
  });
}

export default app;
