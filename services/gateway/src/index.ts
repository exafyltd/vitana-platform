import express from 'express';
import boardAdapter from "./routes/board-adapter";
import { commandhub } from "./routes/commandhub";
import cors from 'cors';
import { vtidRouter } from './routes/vtid';
import { router as tasksRouter } from "./routes/tasks";
import eventsApiRouter from './routes/gateway-events-api';
import commandHubRouter from './routes/command-hub';
import { sseService } from './services/sse-service';
import { setupCors, sseHeaders } from './middleware/cors';

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

// Mount routes
app.use('/api/v1/vtid', vtidRouter);
app.use('/api/v1/commandhub', commandhub);
app.use("/", tasksRouter);
app.use(eventsApiRouter);
app.use('/command-hub', commandHubRouter);
app.use(sseService.router);
app.use('/api/v1/commandhub/board', boardAdapter);
app.use('/api/v1/board', boardAdapter);

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
    console.log('✅ Gateway server running on port ' + PORT);
    console.log('📊 Command Hub: http://localhost:' + PORT + '/command-hub');
    console.log('🔌 SSE Stream: http://localhost:' + PORT + '/api/v1/events/stream');
  });
}

export default app;
