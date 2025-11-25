import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

export class Database {
  private static instance: PrismaClient;

  public static getInstance(): PrismaClient {
    if (!Database.instance) {
      Database.instance = new PrismaClient({
        log: process.env.NODE_ENV === 'development' 
          ? ['query', 'error', 'warn'] 
          : ['error']
      });

      // Handle connection errors
      Database.instance.$connect().catch((error) => {
        logger.error('Database connection failed', error);
        throw error;
      });
    }

    return Database.instance;
  }
}
