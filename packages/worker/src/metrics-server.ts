import { createServer, type Server } from 'node:http';

import { observabilityConfig } from '@taskflow/config';
import { createLogger } from '@taskflow/logger';
import {
  collectProcessMetrics,
  getMetrics,
  getRegistry,
} from '@taskflow/observability/dist/metrics';

const logger = createLogger({ component: 'WorkerMetricsServer' });

export interface MetricsServerOptions {
  /** Defaults to WORKER_METRICS_PORT. 0 disables the endpoint. */
  port?: number;
  /** Defaults to WORKER_METRICS_HOST (loopback). */
  host?: string;
  /** Defaults to ENABLE_METRICS. */
  enabled?: boolean;
}

export interface MetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Serve this worker process's Prometheus metrics at `GET /metrics`.
 *
 * SECURITY: the endpoint is unauthenticated (workers have no HTTP auth, and
 * Prometheus scrapes them directly). It therefore listens on loopback unless
 * told otherwise; bind a non-loopback host only on a private network that is
 * not published outside it.
 *
 * Metrics are best-effort. If the port cannot be bound (for example several
 * workers on one host share the default port), this logs a warning and
 * resolves to `null`; the worker keeps processing jobs without the endpoint.
 */
export async function startMetricsServer(
  options: MetricsServerOptions = {}
): Promise<MetricsServer | null> {
  const enabled = options.enabled ?? observabilityConfig.enableMetrics;
  const port = options.port ?? observabilityConfig.workerMetricsPort;
  const host = options.host ?? observabilityConfig.workerMetricsHost;

  if (!enabled || port === 0) {
    logger.info('Worker metrics endpoint disabled');
    return null;
  }

  collectProcessMetrics();

  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?', 1)[0];

    if (path !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not Found\n');
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, {
        Allow: 'GET',
        'Content-Type': 'text/plain',
      });
      response.end('Method Not Allowed\n');
      return;
    }

    getMetrics().then(
      (body) => {
        response.writeHead(200, { 'Content-Type': getRegistry().contentType });
        response.end(body);
      },
      (error: unknown) => {
        logger.error('Failed to render metrics', { error });
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end('Internal Server Error\n');
      }
    );
  });
  // A scraper that stalls must not hold a socket open indefinitely.
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  const bound = await new Promise<boolean>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      logger.warn(
        'Worker metrics endpoint unavailable; continuing without it',
        {
          host,
          port,
          code: error.code,
          message: error.message,
        }
      );
      resolve(false);
    });
    server.listen(port, host, () => resolve(true));
  });

  if (!bound) return null;

  const address = server.address();
  const boundPort =
    typeof address === 'object' && address ? address.port : port;
  logger.info('Worker metrics endpoint listening', { host, port: boundPort });

  return {
    port: boundPort,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Do not wait on idle keep-alive connections held by a scraper.
    server.closeAllConnections();
  });
}
