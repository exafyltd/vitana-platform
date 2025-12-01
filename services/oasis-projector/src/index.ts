import express from 'express';
<<<<<<< HEAD
// VTID: DEV-OASIS-0010, VTID-0521, VTID-0522
const VTID = 'DEV-OASIS-0010';
const VTID_LEDGER_WRITER = 'VTID-0521';
const VTID_LEDGER_FIX = 'VTID-0522'; // Fix for auto-ledger writer mapping & status
=======
// VTID: DEV-OASIS-0010, VTID-0521
const VTID = 'DEV-OASIS-0010';
const VTID_LEDGER_WRITER = 'VTID-0521';
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
const VT_LAYER = 'OASIS';
const VT_MODULE = 'PROJECTOR';

import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { logger } from './logger';
import { Projector } from './projector';
import { LedgerWriter } from './ledger-writer';
import { Database } from './database';

// VTID-0522: Type for OasisEvent status endpoint response mapping
interface OasisEventStatusRecord {
  id: string;
  status: string;
  notes: string | null;
  metadata: unknown;
  createdAt: Date;
}

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

    // Get both projector offsets
    const [syncOffset, writerOffset] = await Promise.all([
      db.projectionOffset.findUnique({
        where: { projectorName: 'vtid_ledger_sync' }
      }),
      db.projectionOffset.findUnique({
        where: { projectorName: 'vtid_ledger_writer' }
      })
    ]);

    res.json({
      projectors: {
        vtid_ledger_sync: {
          events_processed: syncOffset?.eventsProcessed || 0,
          last_processed_at: syncOffset?.lastProcessedAt,
          last_event_time: syncOffset?.lastEventTime,
        },
        vtid_ledger_writer: {
          events_processed: writerOffset?.eventsProcessed || 0,
          last_processed_at: writerOffset?.lastProcessedAt,
          last_event_time: writerOffset?.lastEventTime,
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Metrics failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// VTID-0521: Internal sync endpoint for manual ledger sync
let ledgerWriter: LedgerWriter | null = null;

<<<<<<< HEAD
// VTID-0522: Manual sync endpoint (updated response format)
=======
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
app.post('/internal/oasis/ledger/sync', async (req, res) => {
  try {
    if (!ledgerWriter) {
      ledgerWriter = new LedgerWriter();
    }

    logger.info('Manual ledger sync triggered');
    const result = await ledgerWriter.syncNow();

<<<<<<< HEAD
    // VTID-0522: Response format matches specification
    res.json({
      ok: true,
      vtid: VTID_LEDGER_WRITER,
      // Top-level "synced" field as per spec
      synced: result.processed,
      // Extended details
      details: {
=======
    res.json({
      ok: true,
      vtid: VTID_LEDGER_WRITER,
      result: {
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
        processed: result.processed,
        updated: result.updated,
        created: result.created,
        errors: result.errors,
<<<<<<< HEAD
        last_event_id: result.lastEventId || null,
        last_event_time: result.lastEventTime?.toISOString() || null,
=======
        last_event_id: result.lastEventId,
        last_event_time: result.lastEventTime?.toISOString(),
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Manual ledger sync failed', error);
    res.status(500).json({
      ok: false,
      vtid: VTID_LEDGER_WRITER,
      error: 'Ledger sync failed',
      detail: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

<<<<<<< HEAD
// VTID-0522: Get ledger writer status (updated response format)
app.get('/internal/oasis/ledger/status', async (req, res) => {
  try {
    const db = Database.getInstance();

    // Get projection offset
=======
// VTID-0521: Get ledger writer status
app.get('/internal/oasis/ledger/status', async (req, res) => {
  try {
    const db = Database.getInstance();
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
    const offset = await db.projectionOffset.findUnique({
      where: { projectorName: 'vtid_ledger_writer' }
    });

<<<<<<< HEAD
    // Count pending events (events that haven't been processed yet)
    const lastEventTime = offset?.lastEventTime || new Date(0);
    const pendingCount = await db.oasisEvent.count({
      where: {
        createdAt: {
          gt: lastEventTime
        }
      }
    });

=======
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
    // Get recent ledger_sync events
    const recentSyncs = await db.oasisEvent.findMany({
      where: {
        event: 'ledger_sync',
        service: 'oasis-projector'
      },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

<<<<<<< HEAD
    // VTID-0522: Response format matches specification
    res.json({
      ok: true,
      vtid: VTID_LEDGER_WRITER,
      // Top-level fields as per VTID-0522 spec
      last_event_id: offset?.lastEventId || null,
      last_event_at: offset?.lastEventTime?.toISOString() || null,
      processed_events: offset?.eventsProcessed || 0,
      pending: pendingCount,
      // Extended status info
      status: {
        running: ledgerWriter !== null,
        last_processed_at: offset?.lastProcessedAt?.toISOString() || null,
      },
      recent_syncs: recentSyncs.map((s: OasisEventStatusRecord) => ({
=======
    res.json({
      ok: true,
      vtid: VTID_LEDGER_WRITER,
      status: {
        running: ledgerWriter !== null,
        events_processed: offset?.eventsProcessed || 0,
        last_processed_at: offset?.lastProcessedAt,
        last_event_id: offset?.lastEventId,
        last_event_time: offset?.lastEventTime,
      },
      recent_syncs: recentSyncs.map((s: { id: string; status: string; notes: string | null; metadata: unknown; createdAt: Date }) => ({
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
        id: s.id,
        status: s.status,
        notes: s.notes,
        metadata: s.metadata,
        created_at: s.createdAt
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Ledger status failed', error);
    res.status(500).json({
      ok: false,
      vtid: VTID_LEDGER_WRITER,
<<<<<<< HEAD
      error: 'Failed to get ledger status',
      detail: error instanceof Error ? error.message : 'Unknown error'
=======
      error: 'Failed to get ledger status'
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
    });
  }
});

async function startServer() {
  try {
    // Initialize database
    const db = Database.getInstance();
    await db.$connect();
    logger.info('Database connected');

    // Start the projector (DEV-OASIS-0010)
    const projector = new Projector();
    projector.start();

    // Start the ledger writer (VTID-0521)
    ledgerWriter = new LedgerWriter();
    ledgerWriter.start();
    logger.info('VTID Ledger Writer started (VTID-0521)');

    // Start HTTP server
    app.listen(port, () => {
      logger.info(`Oasis Projector service started on port ${port}`);
      logger.info(`  - DEV-OASIS-0010: Event Projector`);
      logger.info(`  - VTID-0521: Ledger Writer`);
    });

  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  if (ledgerWriter) {
    await ledgerWriter.stop();
  }
  const db = Database.getInstance();
  await db.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  if (ledgerWriter) {
    await ledgerWriter.stop();
  }
  const db = Database.getInstance();
  await db.$disconnect();
  process.exit(0);
});

startServer().catch((error) => {
  logger.error('Unhandled error during startup', error);
  process.exit(1);
});
