import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 500 },
    { duration: '1m', target: 5000 }, // 5,000+ events/sec
    { duration: '30s', target: 0 },
  ],
};

const BASE_URL = __ENV.INGESTION_URL || 'http://localhost:8001';

export default function () {
  const payload = JSON.stringify({
    courier_id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    latitude: 1.3521,
    longitude: 103.8198,
    speed_mps: 12.4,
    heading_deg: 180.0,
    recorded_at: new Date().toISOString(),
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  const res = http.post(`${BASE_URL}/telemetry`, payload, params);
  check(res, {
    'status is 202 or 200': (r) => r.status === 202 || r.status === 200,
  });
}
