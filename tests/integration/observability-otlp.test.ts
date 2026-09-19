import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const composeFile = path.join(__dirname, 'observability-otlp.compose.yml');
const composeArgs = [
  'compose',
  '-p',
  'taskflow-observability-it',
  '-f',
  composeFile,
];

function docker(...args: string[]): string {
  const result = spawnSync('docker', [...composeArgs, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

function emitAndShutdown(): Promise<{
  exitCode: number | null;
  output: string;
}> {
  const program = `
    const tracing = require('./packages/observability/dist/tracing.js');
    tracing.initializeTracing('taskflow-otlp-shutdown-test');
    const span = tracing.startSpan('taskflow.shutdown.export.test', { proof: 'live-collector' });
    tracing.endSpan(span);
    tracing.shutdownTracing().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program], {
      cwd: root,
      env: {
        ...process.env,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:54318/v1/traces',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer | string) => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, output }));
  });
}

beforeAll(() => {
  docker('down', '--volumes', '--remove-orphans');
  docker('up', '-d', '--wait');
}, 90_000);

afterAll(() => {
  docker('down', '--volumes', '--remove-orphans');
}, 30_000);

describe('live OTLP export lifecycle', () => {
  it('flushes a completed span to the collector during SDK shutdown', async () => {
    const result = await emitAndShutdown();
    expect(result.exitCode, result.output).toBe(0);

    const logs = docker('logs', '--no-color', 'collector');
    expect(logs).toContain('taskflow.shutdown.export.test');
    expect(logs).toContain('taskflow-otlp-shutdown-test');
    expect(logs).toContain('live-collector');
  });
});
