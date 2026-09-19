import { logger } from '@taskflow/logger';

import { db, closeConnection, testConnection } from './client';
import { queues } from './schema';

/**
 * Seed Database with Initial Data
 */
async function seedDatabase(): Promise<void> {
  try {
    logger.info('Starting database seeding...');

    // Test connection
    const connected = await testConnection();
    if (!connected) {
      throw new Error('Database connection failed');
    }

    // Create default queues
    logger.info('Creating default queues...');

    await db
      .insert(queues)
      .values([
        {
          name: 'default',
          displayName: 'Default Queue',
          description: 'Default job queue for general purpose tasks',
          priority: 5,
          maxRetryAttempts: 3,
          defaultTimeoutMs: 30000,
          isActive: true,
        },
        {
          name: 'email',
          displayName: 'Email Queue',
          description: 'Queue for email sending jobs',
          priority: 7,
          maxRetryAttempts: 5,
          defaultTimeoutMs: 60000,
          isActive: true,
        },
        {
          name: 'critical',
          displayName: 'Critical Queue',
          description: 'High-priority critical jobs',
          priority: 10,
          maxRetryAttempts: 10,
          defaultTimeoutMs: 120000,
          isActive: true,
        },
        {
          name: 'low',
          displayName: 'Low Priority Queue',
          description: 'Low-priority background jobs',
          priority: 1,
          maxRetryAttempts: 2,
          defaultTimeoutMs: 300000,
          isActive: true,
        },
      ])
      .onConflictDoNothing();

    logger.info('✓ Default queues created');

    logger.info('✓ Database seeding completed successfully');
  } catch (error) {
    logger.error('✗ Database seeding failed', { error });
    process.exit(1);
  } finally {
    await closeConnection();
  }
}

// Run seed if executed directly
if (require.main === module) {
  void seedDatabase();
}

export { seedDatabase };
