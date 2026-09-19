import { JobHandler } from '@taskflow/types';

/**
 * Job Handler Registry
 *
 * Maps job types to handler functions.
 * Workers use this to look up and execute jobs.
 */
export class HandlerRegistry {
  private handlers: Map<string, JobHandler>;

  constructor() {
    this.handlers = new Map();
  }

  /**
   * Register a job handler
   */
  register(jobType: string, handler: JobHandler): void {
    if (this.handlers.has(jobType)) {
      throw new Error(`Handler already registered for job type: ${jobType}`);
    }

    this.handlers.set(jobType, handler);
  }

  /**
   * Register multiple handlers at once
   */
  registerMany(handlers: Record<string, JobHandler>): void {
    for (const [jobType, handler] of Object.entries(handlers)) {
      this.register(jobType, handler);
    }
  }

  /**
   * Get handler for job type
   */
  get(jobType: string): JobHandler | undefined {
    return this.handlers.get(jobType);
  }

  /**
   * Check if handler exists
   */
  has(jobType: string): boolean {
    return this.handlers.has(jobType);
  }

  /**
   * Unregister a handler
   */
  unregister(jobType: string): boolean {
    return this.handlers.delete(jobType);
  }

  /**
   * Get all registered job types
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Clear all handlers
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Get handler count
   */
  size(): number {
    return this.handlers.size;
  }
}

/**
 * Create a new handler registry
 */
export function createHandlerRegistry(): HandlerRegistry {
  return new HandlerRegistry();
}
