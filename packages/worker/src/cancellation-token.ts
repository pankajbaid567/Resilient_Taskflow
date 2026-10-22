/**
 * Cancellation Token
 *
 * Provides cooperative cancellation mechanism for job handlers.
 * Handlers can check if cancellation is requested and abort gracefully.
 */

/**
 * CancellationToken
 *
 * Allows job handlers to check if cancellation has been requested.
 * Handlers should periodically check `isCancellationRequested` and
 * throw `CancellationError` to abort gracefully.
 */
export class CancellationToken {
  private cancelled = false;
  private readonly callbacks: Set<() => void> = new Set();

  /**
   * Check if cancellation has been requested
   */
  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  /**
   * Throw error if cancellation has been requested
   * Convenience method for handlers
   */
  throwIfCancellationRequested(): void {
    if (this.cancelled) {
      throw new CancellationError('Job cancellation requested');
    }
  }

  /**
   * Register callback to be invoked when cancellation is requested
   * Useful for cleanup operations
   */
  onCancellationRequested(callback: () => void): () => void {
    this.callbacks.add(callback);

    // Return unsubscribe function
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * Request cancellation
   * Internal method called by worker
   */
  cancel(): void {
    if (this.cancelled) {
      return; // Already cancelled
    }

    this.cancelled = true;

    // Notify all registered callbacks
    for (const callback of this.callbacks) {
      try {
        callback();
      } catch (error) {
        // Ignore callback errors
        console.error('Error in cancellation callback:', error);
      }
    }
  }

  /**
   * Create a child token that inherits cancellation from parent
   * Useful for nested operations
   */
  createChildToken(): CancellationToken {
    const child = new CancellationToken();

    // If parent is already cancelled, cancel child immediately
    if (this.cancelled) {
      child.cancel();
    } else {
      // Link parent to child
      this.onCancellationRequested(() => child.cancel());
    }

    return child;
  }
}

/**
 * Cancellation Error
 *
 * Thrown when a job is cancelled.
 * Handlers should throw this error to indicate graceful cancellation.
 */
export class CancellationError extends Error {
  constructor(message: string = 'Operation cancelled') {
    super(message);
    this.name = 'CancellationError';
    Object.setPrototypeOf(this, CancellationError.prototype);
  }
}

/**
 * Create a new cancellation token
 */
export function createCancellationToken(): CancellationToken {
  return new CancellationToken();
}

/**
 * Helper to check cancellation in async loops
 *
 * Example:
 * for (const item of items) {
 *   await checkCancellation(token);
 *   await processItem(item);
 * }
 */
export async function checkCancellation(
  token: CancellationToken,
  delayMs: number = 0
): Promise<void> {
  token.throwIfCancellationRequested();

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    token.throwIfCancellationRequested();
  }
}
