import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 200 },
    { duration: '1m', target: 1000 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests must complete below 500ms
  },
};

const BASE_URL = __ENV.ORCHESTRATOR_URL || 'http://localhost:8080';

export default function () {
  const payload = JSON.stringify({
    hub_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    batch_size: 50,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  const res = http.post(`${BASE_URL}/api/v1/dispatch/trigger`, payload, params);
  check(res, {
    'status is 200 or 202': (r) => r.status === 200 || r.status === 202,
  });

  sleep(0.1);
}
