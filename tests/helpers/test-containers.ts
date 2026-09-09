/**
 * Test container management utilities
 * Provides helpers for spinning up and tearing down Docker containers for testing
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ContainerConfig {
  name: string;
  image: string;
  ports: Record<string, string>;
  environment?: Record<string, string>;
  healthCheck?: () => Promise<boolean>;
  healthCheckRetries?: number;
  healthCheckDelay?: number;
}

export class TestContainer {
  private containerId?: string;

  constructor(private config: ContainerConfig) {}

  async start(): Promise<void> {
    // Check if container already exists
    const { stdout: existing } = await execAsync(
      `docker ps -a -q -f name=${this.config.name}`
    );

    if (existing.trim()) {
      // Container exists, check if running
      const { stdout: running } = await execAsync(
        `docker ps -q -f name=${this.config.name}`
      );

      if (!running.trim()) {
        // Start existing stopped container
        await execAsync(`docker start ${this.config.name}`);
      }
      this.containerId = existing.trim();
    } else {
      // Create new container
      const portMappings = Object.entries(this.config.ports)
        .map(([host, container]) => `-p ${host}:${container}`)
        .join(' ');

      const envVars = this.config.environment
        ? Object.entries(this.config.environment)
            .map(([key, value]) => `-e ${key}=${value}`)
            .join(' ')
        : '';

      const cmd = `docker run -d --name ${this.config.name} ${portMappings} ${envVars} ${this.config.image}`;
      const { stdout } = await execAsync(cmd);
      this.containerId = stdout.trim();
    }

    // Wait for container to be healthy
    if (this.config.healthCheck) {
      await this.waitForHealth();
    } else {
      // Default wait
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async stop(): Promise<void> {
    if (this.containerId) {
      try {
        await execAsync(`docker stop ${this.config.name}`);
      } catch (error) {
        // Container might already be stopped
      }
    }
  }

  async remove(): Promise<void> {
    if (this.containerId) {
      try {
        await execAsync(`docker rm -f ${this.config.name}`);
        this.containerId = undefined;
      } catch (error) {
        // Container might already be removed
      }
    }
  }

  async logs(): Promise<string> {
    if (this.containerId) {
      const { stdout } = await execAsync(`docker logs ${this.config.name}`);
      return stdout;
    }
    return '';
  }

  private async waitForHealth(): Promise<void> {
    const retries = this.config.healthCheckRetries || 30;
    const delay = this.config.healthCheckDelay || 1000;

    for (let i = 0; i < retries; i++) {
      try {
        if (this.config.healthCheck && (await this.config.healthCheck())) {
          return;
        }
      } catch (error) {
        // Health check failed, retry
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new Error(
      `Container ${this.config.name} failed to become healthy after ${retries} retries`
    );
  }
}

// Pre-configured test containers
export class TestContainers {
  private containers: Map<string, TestContainer> = new Map();

  async startPostgres(port: number = 5433): Promise<TestContainer> {
    const container = new TestContainer({
      name: 'taskflow-test-postgres',
      image: 'postgres:16-alpine',
      ports: { [port]: '5432' },
      environment: {
        POSTGRES_USER: 'testuser',
        POSTGRES_PASSWORD: 'testpass',
        POSTGRES_DB: 'taskflow_test',
      },
      healthCheck: async () => {
        try {
          const { stdout } = await execAsync(
            `docker exec taskflow-test-postgres pg_isready -U testuser`
          );
          return stdout.includes('accepting connections');
        } catch {
          return false;
        }
      },
    });

    await container.start();
    this.containers.set('postgres', container);
    return container;
  }

  async startRedis(port: number = 6380): Promise<TestContainer> {
    const container = new TestContainer({
      name: 'taskflow-test-redis',
      image: 'redis:7-alpine',
      ports: { [port]: '6379' },
      healthCheck: async () => {
        try {
          const { stdout } = await execAsync(
            `docker exec taskflow-test-redis redis-cli ping`
          );
          return stdout.trim() === 'PONG';
        } catch {
          return false;
        }
      },
    });

    await container.start();
    this.containers.set('redis', container);
    return container;
  }

  async startKafka(port: number = 9093): Promise<TestContainer> {
    const container = new TestContainer({
      name: 'taskflow-test-redpanda',
      image: 'redpandadata/redpanda:latest',
      ports: { [port]: '9092' },
      environment: {
        REDPANDA_MODE: 'dev-container',
      },
      healthCheck: async () => {
        try {
          const { stdout } = await execAsync(
            `docker exec taskflow-test-redpanda rpk cluster health`
          );
          return stdout.includes('Healthy');
        } catch {
          return false;
        }
      },
      healthCheckRetries: 60,
      healthCheckDelay: 2000,
    });

    await container.start();
    this.containers.set('kafka', container);
    return container;
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      Array.from(this.containers.values()).map((c) => c.stop())
    );
  }

  async removeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.containers.values()).map((c) => c.remove())
    );
    this.containers.clear();
  }

  get(name: string): TestContainer | undefined {
    return this.containers.get(name);
  }
}
