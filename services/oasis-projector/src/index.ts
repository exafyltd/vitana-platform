import express from 'express';
// VTID: DEV-OASIS-0010
const VTID = 'DEV-OASIS-0010';
const VT_LAYER = 'OASIS';
const VT_MODULE = 'PROJECTOR';

import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { logger } from './logger';
import { Projector } from './projector';
import { Database } from './database';

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/alive', (req, res) => {
  res.json({ status: 'ok', service: 'oasis-projector', timestamp: new Date().toISOString() });
});

// Ready check endpoint
app.get('/ready', async (req, res) => {
  try {
    const db = Database.getInstance();
    await db.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', database: 'connected', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Health check failed', error);
    res.status(503).json({ status: 'not ready', database: 'disconnected' });
  }
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    const db = Database.getInstance();
    const offset = await db.projection_offsets.findUnique({
      where: { projector_name: 'vtid_ledger_sync' }
    });
    
    res.json({
      projector: 'vtid_ledger_sync',
      events_processed: offset?.events_processed || 0,
      last_processed_at: offset?.last_processed_at,
      last_event_time: offset?.last_event_time,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Metrics failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function startServer() {
  try {
    // Initialize database
    const db = Database.getInstance();
    await db.$connect();
    logger.info('Database connected');

    // Start the projector
    const projector = new Projector();
    projector.start();

    // Start HTTP server
    app.listen(port, () => {
      logger.info(`Oasis Projector service started on port ${port}`);
    });

  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  const db = Database.getInstance();
  await db.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  const db = Database.getInstance();
  await db.$disconnect();
  process.exit(0);
});

startServer().catch((error) => {
  logger.error('Unhandled error during startup', error);
  process.exit(1);
});
