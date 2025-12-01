import { Database } from './database';
import { logger } from './logger';

interface OasisEventRecord {
  id: string;
<<<<<<< HEAD
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
=======
  event: string;
  service: string;
  status: string;
  metadata: unknown;
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
  createdAt: Date;
  projected: boolean;
}

export class Projector {
  private isRunning = false;
  private readonly BATCH_SIZE = 100;
  private readonly POLL_INTERVAL = 5000; // 5 seconds
  private readonly PROJECTOR_NAME = 'vtid_ledger_sync';

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Projector is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting VTID ledger sync projector');

    // Start the projection loop
    this.projectionLoop().catch((error) => {
      logger.error('Projection loop failed', error);
      this.isRunning = false;
    });
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    logger.info('Stopping projector');
  }

  private async projectionLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.processBatch();
      } catch (error) {
        logger.error('Error in projection loop', error);
      }

      // Wait before next batch
      await this.sleep(this.POLL_INTERVAL);
    }
  }

  private async processBatch(): Promise<void> {
    const db = Database.getInstance();

    // Get current offset
    const offset = await db.projectionOffset.findUnique({
      where: { projectorName: this.PROJECTOR_NAME }
    });

    // Find unprojected events
    const events = await db.oasisEvent.findMany({
      where: {
        projected: false,
        createdAt: {
          gt: offset?.lastEventTime || new Date(0)
        }
      },
      orderBy: { createdAt: 'asc' },
      take: this.BATCH_SIZE
    });

    if (events.length === 0) {
      return; // No events to process
    }

    logger.info(`Processing ${events.length} events`, {
      firstEventTime: events[0].createdAt,
      lastEventTime: events[events.length - 1].createdAt
    });

    // Process each event
    for (const event of events) {
      await this.projectEvent(event as OasisEventRecord);
    }

    // Update offset
    const lastEvent = events[events.length - 1];
<<<<<<< HEAD
    await db.projectionOffset.upsert({
      where: { projectorName: this.PROJECTOR_NAME },
      create: {
        projectorName: this.PROJECTOR_NAME,
        lastEventId: lastEvent.id,
        lastEventTime: lastEvent.createdAt,
        lastProcessedAt: new Date(),
        eventsProcessed: events.length
      },
      update: {
=======
    await db.projectionOffset.update({
      where: { projectorName: this.PROJECTOR_NAME },
      data: {
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
        lastEventId: lastEvent.id,
        lastEventTime: lastEvent.createdAt,
        lastProcessedAt: new Date(),
        eventsProcessed: {
          increment: events.length
        }
      }
    });

    logger.info(`Batch complete. Processed ${events.length} events`);
  }

  private async projectEvent(event: OasisEventRecord): Promise<void> {
    try {
      // Project the event based on its type
      switch (event.event) {
        case 'user_created':
          await this.projectUserCreated(event);
          break;
        case 'user_updated':
          await this.projectUserUpdated(event);
          break;
        case 'transaction_created':
          await this.projectTransactionCreated(event);
          break;
        default:
          logger.debug(`Unhandled event type: ${event.event}`, { eventId: event.id });
      }

      // Mark event as projected
      await Database.getInstance().oasisEvent.update({
        where: { id: event.id },
        data: { projected: true }
      });

      logger.debug(`Event projected: ${event.event}`, { eventId: event.id });

    } catch (error) {
      logger.error(`Failed to project event ${event.id}`, error);
      throw error;
    }
  }

  private async projectUserCreated(event: OasisEventRecord): Promise<void> {
    const metadata = event.metadata as Record<string, unknown> || {};
    const { userId, email, name } = metadata;
    logger.info(`Projecting user created: ${userId}`, { email, name });

    // TODO: Implement actual projection logic
  }

  private async projectUserUpdated(event: OasisEventRecord): Promise<void> {
    const metadata = event.metadata as Record<string, unknown> || {};
    const { userId, changes } = metadata;
    logger.info(`Projecting user updated: ${userId}`, { changes });

    // TODO: Implement actual projection logic
  }

  private async projectTransactionCreated(event: OasisEventRecord): Promise<void> {
    const metadata = event.metadata as Record<string, unknown> || {};
    const { transactionId, amount, currency } = metadata;
    logger.info(`Projecting transaction created: ${transactionId}`, { amount, currency });

    // TODO: Implement actual projection logic
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
