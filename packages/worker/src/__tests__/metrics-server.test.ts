import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { startMetricsServer, type MetricsServer } from '../metrics-server';
import { workerMetrics } from '../metrics';

const open: MetricsServer[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

async function start(
  options: Parameters<typeof startMetricsServer>[0] = {}
): Promise<MetricsServer> {
  const server = await startMetricsServer({
    host: '127.0.0.1',
    enabled: true,
    ...options,
  });
  if (!server) throw new Error('expected the metrics server to start');
  open.push(server);
  return server;
}

/** A currently free port (bind to 0, read it, release it). */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function call(
  port: number,
  path: string,
  method = 'GET'
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('worker metrics endpoint', () => {
  it('serves Prometheus text including job counters and process metrics', async () => {
    workerMetrics.jobSucceeded('q-endpoint', 'email', 10);
    const server = await start({ port: await freePort() });

    const response = await call(server.port, '/metrics');

    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/plain');
    expect(response.body).toContain(
      'taskflow_jobs_completed_total{queue="q-endpoint",type="email"} 1'
    );
    // Default process metrics are collected once the endpoint is enabled.
    expect(response.body).toContain('process_cpu_user_seconds_total');
    expect(response.body).toContain('nodejs_eventloop_lag_seconds');
  });

  it('answers only GET /metrics', async () => {
    const server = await start({ port: await freePort() });

    expect((await call(server.port, '/')).status).toBe(404);
    expect((await call(server.port, '/metrics/extra')).status).toBe(404);
    const post = await call(server.port, '/metrics', 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET');
  });

  it('ignores a query string on the metrics path', async () => {
    const server = await start({ port: await freePort() });

    expect((await call(server.port, '/metrics?x=1')).status).toBe(200);
  });

  it('does nothing when disabled by flag or by port 0', async () => {
    await expect(
      startMetricsServer({ enabled: false, port: 9464 })
    ).resolves.toBeNull();
    await expect(
      startMetricsServer({ enabled: true, port: 0 })
    ).resolves.toBeNull();
  });

  it('degrades to no endpoint, instead of failing the worker, when the port is taken', async () => {
    const first = await start({ port: await freePort() });

    const second = await startMetricsServer({
      enabled: true,
      host: '127.0.0.1',
      port: first.port,
    });

    expect(second).toBeNull();
    // The original listener is unaffected.
    expect((await call(first.port, '/metrics')).status).toBe(200);
  });

  it('closes promptly even while a scraper holds a keep-alive connection', async () => {
    const server = await start({ port: await freePort() });
    await call(server.port, '/metrics');

    const started = Date.now();
    await server.close();
    open.length = 0;

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
