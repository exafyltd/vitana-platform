import { Database } from './database';
import { logger } from './logger';

interface Event {
  id: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
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
      await this.projectEvent(event);
    }

    // Update offset
    const lastEvent = events[events.length - 1];
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

  private async projectEvent(event: Event): Promise<void> {
    try {
      // Project the event based on its type
      switch (event.type) {
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
          logger.warn(`Unknown event type: ${event.type}`, { eventId: event.id });
      }

      // Mark event as projected
      await Database.getInstance().oasisEvent.update({
        where: { id: event.id },
        data: { projected: true }
      });

      logger.debug(`Event projected: ${event.type}`, { eventId: event.id });

    } catch (error) {
      logger.error(`Failed to project event ${event.id}`, error);
      throw error;
    }
  }

  private async projectUserCreated(event: Event): Promise<void> {
    const { userId, email, name } = event.payload;
    logger.info(`Projecting user created: ${userId}`, { email, name });
    
    // TODO: Implement actual projection logic
    // This could involve:
    // - Creating a user record in a read-optimized table
    // - Updating search indexes
    // - Sending notifications
    // - Updating cache
  }

  private async projectUserUpdated(event: Event): Promise<void> {
    const { userId, changes } = event.payload;
    logger.info(`Projecting user updated: ${userId}`, { changes });
    
    // TODO: Implement actual projection logic
  }

  private async projectTransactionCreated(event: Event): Promise<void> {
    const { transactionId, amount, currency } = event.payload;
    logger.info(`Projecting transaction created: ${transactionId}`, { amount, currency });
    
    // TODO: Implement actual projection logic
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
