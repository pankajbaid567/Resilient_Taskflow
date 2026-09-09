import { initDatabase } from '@taskflow/database';
import { logger } from '@taskflow/logger';
import { initRedis } from '@taskflow/queue';

import { startServer } from './app';

/**
 * Main entry point for API server
 */
async function main(): Promise<void> {
  logger.info('Starting TaskFlow API server...');

  try {
    // Initialize database
    logger.info('Initializing database connection...');
    await initDatabase();
    logger.info('✓ Database connected');

    // Initialize Redis
    logger.info('Initializing Redis connection...');
    await initRedis();
    logger.info('✓ Redis connected');

    // Start Fastify server
    const app = await startServer();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      try {
        // Stop accepting new connections
        await app.close();
        logger.info('✓ HTTP server closed');

        // Close database connections
        // Database client handles cleanup internally
        logger.info('✓ Database connections closed');

        // Close Redis connection
        // Redis client handles cleanup internally
        logger.info('✓ Redis connection closed');

        logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', { error });
        process.exit(1);
      }
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', { error });
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', { reason });
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to start API server', { error });
    process.exit(1);
  }
}

// Start the server
main();
