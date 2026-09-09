/**
 * Chaos Injector
 * Utility for injecting controlled failures into running system
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import Redis from 'ioredis';
import { Pool } from 'pg';

const execAsync = promisify(exec);

export interface ChaosConfig {
  duration?: number; // How long to maintain chaos (ms)
  autoRecover?: boolean; // Automatically recover after duration
}

export class ChaosInjector {
  private redis?: Redis;
  private pgPool?: Pool;

  async connect(config: {
    redisUrl?: string;
    databaseUrl?: string;
  }): Promise<void> {
    if (config.redisUrl) {
      this.redis = new Redis(config.redisUrl);
    }

    if (config.databaseUrl) {
      this.pgPool = new Pool({ connectionString: config.databaseUrl });
    }
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }

    if (this.pgPool) {
      await this.pgPool.end();
    }
  }

  /**
   * Kill a Docker container
   */
  async killContainer(
    containerName: string,
    config: ChaosConfig = {}
  ): Promise<void> {
    console.log(`[CHAOS] Killing container: ${containerName}`);

    try {
      await execAsync(`docker kill ${containerName}`);

      if (config.autoRecover) {
        setTimeout(async () => {
          console.log(`[CHAOS] Restarting container: ${containerName}`);
          await execAsync(`docker start ${containerName}`);
        }, config.duration || 10000);
      }
    } catch (error) {
      console.error(`Failed to kill container: ${error}`);
    }
  }

  /**
   * Pause a Docker container (simulates freeze)
   */
  async pauseContainer(
    containerName: string,
    config: ChaosConfig = {}
  ): Promise<void> {
    console.log(`[CHAOS] Pausing container: ${containerName}`);

    try {
      await execAsync(`docker pause ${containerName}`);

      if (config.autoRecover) {
        setTimeout(async () => {
          console.log(`[CHAOS] Unpausing container: ${containerName}`);
          await execAsync(`docker unpause ${containerName}`);
        }, config.duration || 5000);
      }
    } catch (error) {
      console.error(`Failed to pause container: ${error}`);
    }
  }

  /**
   * Restart a Docker container
   */
  async restartContainer(containerName: string): Promise<void> {
    console.log(`[CHAOS] Restarting container: ${containerName}`);

    try {
      await execAsync(`docker restart ${containerName}`);
    } catch (error) {
      console.error(`Failed to restart container: ${error}`);
    }
  }

  /**
   * Introduce network latency (requires tc command)
   */
  async addNetworkLatency(
    containerName: string,
    latencyMs: number,
    config: ChaosConfig = {}
  ): Promise<void> {
    console.log(
      `[CHAOS] Adding ${latencyMs}ms latency to: ${containerName}`
    );

    // Note: Requires container with tc (traffic control) installed
    const cmd = `docker exec ${containerName} tc qdisc add dev eth0 root netem delay ${latencyMs}ms`;

    try {
      await execAsync(cmd);

      if (config.autoRecover) {
        setTimeout(async () => {
          console.log(`[CHAOS] Removing latency from: ${containerName}`);
          await execAsync(
            `docker exec ${containerName} tc qdisc del dev eth0 root`
          );
        }, config.duration || 10000);
      }
    } catch (error) {
      console.log(
        `Latency injection requires tc in container (skipped): ${error}`
      );
    }
  }

  /**
   * Fill Redis memory (cause evictions)
   */
  async fillRedisMemory(percentFull: number = 90): Promise<void> {
    if (!this.redis) {
      throw new Error('Redis not connected');
    }

    console.log(`[CHAOS] Filling Redis memory to ${percentFull}%`);

    // Get max memory
    const info = await this.redis.info('memory');
    const maxMemory = this.parseRedisMemory(info, 'maxmemory');

    if (!maxMemory) {
      console.log('Redis maxmemory not set, skipping');
      return;
    }

    const targetBytes = (maxMemory * percentFull) / 100;
    const currentBytes = this.parseRedisMemory(info, 'used_memory') || 0;
    const bytesToAdd = targetBytes - currentBytes;

    if (bytesToAdd > 0) {
      // Add large dummy keys
      const chunkSize = 1024 * 1024; // 1MB chunks
      const chunks = Math.floor(bytesToAdd / chunkSize);

      for (let i = 0; i < chunks; i++) {
        await this.redis.set(
          `chaos:memory:${i}`,
          'x'.repeat(chunkSize),
          'EX',
          60
        );
      }
    }

    console.log(`[CHAOS] Redis memory filled`);
  }

  /**
   * Delete random Redis keys (simulate corruption)
   */
  async deleteRandomRedisKeys(count: number): Promise<void> {
    if (!this.redis) {
      throw new Error('Redis not connected');
    }

    console.log(`[CHAOS] Deleting ${count} random Redis keys`);

    const keys = await this.redis.keys('taskflow:*');
    const toDelete = keys.slice(0, count);

    if (toDelete.length > 0) {
      await this.redis.del(...toDelete);
    }

    console.log(`[CHAOS] Deleted ${toDelete.length} keys`);
  }

  /**
   * Exhaust database connections
   */
  async exhaustDatabaseConnections(poolSize: number = 10): Promise<void> {
    if (!this.pgPool) {
      throw new Error('Database not connected');
    }

    console.log(`[CHAOS] Exhausting database connection pool`);

    const clients: any[] = [];

    for (let i = 0; i < poolSize; i++) {
      const client = await this.pgPool.connect();
      clients.push(client);
    }

    console.log(`[CHAOS] ${poolSize} connections acquired (pool exhausted)`);

    // Hold for 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Release
    clients.forEach((c) => c.release());
    console.log(`[CHAOS] Connections released`);
  }

  /**
   * Inject slow query (simulates DB slowdown)
   */
  async injectSlowQuery(durationSeconds: number = 5): Promise<void> {
    if (!this.pgPool) {
      throw new Error('Database not connected');
    }

    console.log(`[CHAOS] Injecting ${durationSeconds}s slow query`);

    try {
      await this.pgPool.query(`SELECT pg_sleep(${durationSeconds})`);
    } catch (error) {
      // Query might timeout
      console.log(`Slow query completed or timed out`);
    }
  }

  /**
   * Corrupt job data (simulate data corruption)
   */
  async corruptJobData(jobId: string): Promise<void> {
    if (!this.pgPool) {
      throw new Error('Database not connected');
    }

    console.log(`[CHAOS] Corrupting job data: ${jobId}`);

    await this.pgPool.query(
      `UPDATE jobs SET payload = '{"corrupted": true}'::jsonb WHERE id = $1`,
      [jobId]
    );

    console.log(`[CHAOS] Job data corrupted`);
  }

  /**
   * Create orphaned job (job in DB but not in Redis)
   */
  async createOrphanedJob(jobId: string): Promise<void> {
    if (!this.pgPool) {
      throw new Error('Database not connected');
    }

    console.log(`[CHAOS] Creating orphaned job: ${jobId}`);

    // Insert job as QUEUED but don't enqueue to Redis
    await this.pgPool.query(
      `INSERT INTO jobs (id, queue, type, payload, status, priority, max_attempts) 
       VALUES ($1, 'default', 'test-job', '{}'::jsonb, 'QUEUED', 'NORMAL', 3)`,
      [jobId]
    );

    console.log(`[CHAOS] Orphaned job created (DB only, not in Redis)`);
  }

  /**
   * Create phantom message (message in Redis but not in DB)
   */
  async createPhantomMessage(jobId: string): Promise<void> {
    if (!this.redis) {
      throw new Error('Redis not connected');
    }

    console.log(`[CHAOS] Creating phantom message: ${jobId}`);

    await this.redis.xadd(
      'taskflow:queue:default',
      '*',
      'jobId',
      jobId,
      'queue',
      'default',
      'attempt',
      '1',
      'createdAt',
      new Date().toISOString(),
      'schemaVersion',
      '1.0'
    );

    console.log(`[CHAOS] Phantom message created (Redis only, not in DB)`);
  }

  /**
   * Simulate clock skew
   */
  async simulateClockSkew(containerName: string, offsetSeconds: number): Promise<void> {
    console.log(`[CHAOS] Simulating ${offsetSeconds}s clock skew on: ${containerName}`);
    
    // Note: This is complex to do safely in Docker
    // In real chaos testing, use proper tools like Pumba or Chaos Mesh
    console.log('[CHAOS] Clock skew simulation requires privileged container access');
  }

  private parseRedisMemory(info: string, key: string): number | null {
    const match = info.match(new RegExp(`${key}:(\\d+)`));
    return match ? parseInt(match[1], 10) : null;
  }
}

/**
 * Chaos scenario runners
 */
export class ChaosScenarios {
  constructor(private injector: ChaosInjector) {}

  /**
   * Scenario: Rolling restarts
   */
  async rollingRestarts(
    containers: string[],
    delayBetweenMs: number = 5000
  ): Promise<void> {
    console.log('[SCENARIO] Starting rolling restarts');

    for (const container of containers) {
      await this.injector.restartContainer(container);
      await new Promise((resolve) => setTimeout(resolve, delayBetweenMs));
    }

    console.log('[SCENARIO] Rolling restarts complete');
  }

  /**
   * Scenario: Total system failure
   */
  async totalSystemFailure(containers: string[]): Promise<void> {
    console.log('[SCENARIO] Simulating total system failure');

    await Promise.all(
      containers.map((c) => this.injector.killContainer(c, { autoRecover: true, duration: 10000 }))
    );

    console.log('[SCENARIO] All containers killed (will auto-recover in 10s)');
  }

  /**
   * Scenario: Network partition
   */
  async networkPartition(containerName: string, durationMs: number = 10000): Promise<void> {
    console.log(`[SCENARIO] Simulating network partition for ${containerName}`);

    await this.injector.pauseContainer(containerName, {
      autoRecover: true,
      duration: durationMs,
    });

    console.log('[SCENARIO] Network partition complete');
  }

  /**
   * Scenario: Cascading failure
   */
  async cascadingFailure(containers: string[]): Promise<void> {
    console.log('[SCENARIO] Simulating cascading failure');

    // Kill containers one by one with increasing delay
    for (let i = 0; i < containers.length; i++) {
      await this.injector.killContainer(containers[i]);
      await new Promise((resolve) => setTimeout(resolve, i * 2000));
    }

    console.log('[SCENARIO] Cascading failure complete');
  }
}
