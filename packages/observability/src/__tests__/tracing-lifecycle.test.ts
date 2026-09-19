import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tracingMocks = vi.hoisted(() => {
  const sdk = {
    start: vi.fn(() => undefined),
    shutdown: vi.fn(() => Promise.resolve()),
  };

  return {
    autoInstrumentations: vi.fn(() => []),
    info: vi.fn(),
    nodeSdk: vi.fn(function MockNodeSdk() {
      return sdk;
    }),
    resource: vi.fn(function MockResource() {
      return {};
    }),
    sdk,
    traceExporter: vi.fn(function MockTraceExporter() {
      return {};
    }),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: tracingMocks.autoInstrumentations,
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: tracingMocks.traceExporter,
}));

vi.mock('@opentelemetry/resources', () => ({
  Resource: tracingMocks.resource,
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: tracingMocks.nodeSdk,
}));

vi.mock('@taskflow/config', () => ({
  env: {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test/v1/traces',
  },
}));

vi.mock('@taskflow/logger', () => ({
  createLogger: () => ({
    error: tracingMocks.error,
    info: tracingMocks.info,
    warn: tracingMocks.warn,
  }),
}));

import { initializeTracing, shutdownTracing } from '../tracing';

describe('tracing lifecycle', () => {
  beforeEach(() => {
    tracingMocks.autoInstrumentations.mockClear();
    tracingMocks.error.mockClear();
    tracingMocks.info.mockClear();
    tracingMocks.nodeSdk.mockClear();
    tracingMocks.resource.mockClear();
    tracingMocks.sdk.shutdown.mockReset();
    tracingMocks.sdk.shutdown.mockResolvedValue(undefined);
    tracingMocks.sdk.start.mockReset();
    tracingMocks.sdk.start.mockImplementation(() => undefined);
    tracingMocks.traceExporter.mockClear();
    tracingMocks.warn.mockClear();
  });

  afterEach(async () => {
    await shutdownTracing().catch(() => undefined);
  });

  it('does not claim ownership of process termination signals', () => {
    const sigtermListeners = process.rawListeners('SIGTERM');
    const sigintListeners = process.rawListeners('SIGINT');

    initializeTracing('test-service');

    expect(process.rawListeners('SIGTERM')).toEqual(sigtermListeners);
    expect(process.rawListeners('SIGINT')).toEqual(sigintListeners);
  });

  it('starts only one SDK instance when initialized repeatedly', () => {
    const first = initializeTracing('test-service');
    const second = initializeTracing('test-service');

    expect(second).toBe(first);
    expect(tracingMocks.nodeSdk).toHaveBeenCalledTimes(1);
    expect(tracingMocks.sdk.start).toHaveBeenCalledTimes(1);
    expect(tracingMocks.warn).toHaveBeenCalledWith(
      'Tracing already initialized'
    );
  });

  it('shares one in-flight shutdown and remains a no-op afterward', async () => {
    let finishShutdown: (() => void) | undefined;
    const pendingShutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve;
    });
    tracingMocks.sdk.shutdown.mockReturnValueOnce(pendingShutdown);
    initializeTracing('test-service');

    const first = shutdownTracing();
    const second = shutdownTracing();

    expect(second).toBe(first);
    await Promise.resolve();
    expect(tracingMocks.sdk.shutdown).toHaveBeenCalledTimes(1);

    finishShutdown?.();
    await Promise.all([first, second]);
    await shutdownTracing();

    expect(tracingMocks.sdk.shutdown).toHaveBeenCalledTimes(1);
  });

  it('rejects reinitialization until an in-flight shutdown finishes', async () => {
    let finishShutdown: (() => void) | undefined;
    const pendingShutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve;
    });
    tracingMocks.sdk.shutdown.mockReturnValueOnce(pendingShutdown);
    initializeTracing('test-service');

    const shutdown = shutdownTracing();

    expect(() => initializeTracing('replacement-service')).toThrow(
      'Cannot initialize tracing while shutdown is in progress'
    );

    finishShutdown?.();
    await shutdown;

    expect(() => initializeTracing('replacement-service')).not.toThrow();
    expect(tracingMocks.nodeSdk).toHaveBeenCalledTimes(2);
  });

  it('can start again after SDK startup or shutdown fails', async () => {
    const startupFailure = new Error('startup failed');
    tracingMocks.sdk.start.mockImplementationOnce(() => {
      throw startupFailure;
    });

    expect(() => initializeTracing('test-service')).toThrow(startupFailure);
    expect(() => initializeTracing('test-service')).not.toThrow();

    const shutdownFailure = new Error('shutdown failed');
    tracingMocks.sdk.shutdown.mockRejectedValueOnce(shutdownFailure);

    await expect(shutdownTracing()).rejects.toBe(shutdownFailure);
    expect(() => initializeTracing('replacement-service')).not.toThrow();
    expect(tracingMocks.nodeSdk).toHaveBeenCalledTimes(3);
  });
});
