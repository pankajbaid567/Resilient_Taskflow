/**
 * Benchmark load generator (k6). One script, two modes, selected by MODE.
 *
 *   MODE=admission  constant-arrival-rate POST /api/v1/jobs for DURATION at RATE req/s
 *   MODE=enqueue    submit exactly COUNT jobs as fast as VUS virtual users can
 *
 * Environment: K6_API_URL (default http://localhost:3000), K6_API_KEY,
 * JOB_TYPE (noop | process-data), plus RATE/DURATION/PRE_VUS/MAX_VUS or
 * COUNT/VUS. See docs/benchmarking/RESULTS.md for the exact commands.
 */
import http from 'k6/http';
import { check } from 'k6';

const API = __ENV.K6_API_URL || 'http://localhost:3000';
const KEY = __ENV.K6_API_KEY;
const TYPE = __ENV.JOB_TYPE || 'noop';
const MODE = __ENV.MODE || 'admission';

if (!KEY) {
  throw new Error('K6_API_KEY is required');
}

const payloads = {
  noop: {},
  'process-data': { operation: 'transform', data: [{ id: 1, value: 1 }] },
};

export const options =
  MODE === 'enqueue'
    ? {
        scenarios: {
          enqueue: {
            executor: 'shared-iterations',
            iterations: Number(__ENV.COUNT || 20000),
            vus: Number(__ENV.VUS || 50),
            maxDuration: __ENV.MAX_DURATION || '10m',
          },
        },
      }
    : {
        scenarios: {
          admission: {
            executor: 'constant-arrival-rate',
            rate: Number(__ENV.RATE || 100),
            timeUnit: '1s',
            duration: __ENV.DURATION || '60s',
            preAllocatedVUs: Number(__ENV.PRE_VUS || 50),
            maxVUs: Number(__ENV.MAX_VUS || 500),
          },
        },
      };

const params = {
  headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
};

export default function () {
  const res = http.post(
    `${API}/api/v1/jobs`,
    JSON.stringify({ type: TYPE, payload: payloads[TYPE], queue: 'default' }),
    params
  );
  check(res, { 'status is 201': (r) => r.status === 201 });
}
