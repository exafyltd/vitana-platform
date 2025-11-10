import express from 'express';
import cors from 'cors';
import vtidRouter from './routes/vtid';
import eventsApiRouter from './routes/gateway-events-api';
import commandHubRouter from './routes/command-hub';
import { sseService } from './services/sse-service';

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'https://lovable.dev'],
  credentials: true
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Mount routes
app.use('/api/v1/vtid', vtidRouter);
app.use(eventsApiRouter);
app.use('/command-hub', commandHubRouter);
app.use(sseService.router); // SSE endpoint

// Serve Command Hub static files (use dist in production)
const staticPath = process.env.NODE_ENV === 'production' 
  ? 'dist/frontend/command-hub' 
  : 'src/frontend/command-hub';
app.use('/command-hub', express.static(staticPath));

// Start server (skip in test mode)
if (process.env.NODE_ENV === 'test') {
  // Don't start server during tests
} else {
  app.listen(PORT, () => {
    console.log('✅ Gateway server running on port ' + PORT);
    console.log('📊 Command Hub: http://localhost:' + PORT + '/command-hub');
    console.log('🔌 SSE Stream: http://localhost:' + PORT + '/api/v1/events/stream');
  });
}

// Export for tests
export default app;
