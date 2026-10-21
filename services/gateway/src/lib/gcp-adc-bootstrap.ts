import fs from 'fs';
import os from 'os';
import path from 'path';

// BOOTSTRAP-AWS-VERTEX-ADC: every `new GoogleAuth()` call in this service
// (Vertex Live API in orb-live.ts, TTS, spec self-healing, cover-image
// outpaint, etc.) relies on Application Default Credentials. On Cloud Run,
// ADC resolves for free via the GCP metadata server tied to the service's
// attached service account. AWS ECS Fargate has no GCP metadata server, so
// ADC has nothing to resolve and every Vertex call fails at connect time
// with "Could not load the default credentials" — this was the root cause
// of ORB voice on AWS staging opening a session/SSE stream successfully
// (pure bookkeeping) but never producing a greeting: the Gemini Live
// upstream connection itself never established.
//
// GCP_SERVICE_ACCOUNT_JSON carries the key (raw JSON or base64-encoded JSON)
// via AWS Secrets Manager; this writes it to a local file and points
// GOOGLE_APPLICATION_CREDENTIALS at it so ADC resolves identically to Cloud
// Run. No-op when unset (GCP, or any environment where ADC already works).
const raw = process.env.GCP_SERVICE_ACCOUNT_JSON;
if (raw && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    JSON.parse(json); // fail fast on malformed key before writing/pointing ADC at it
    const keyPath = path.join(os.tmpdir(), 'gcp-service-account.json');
    fs.writeFileSync(keyPath, json, { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    console.log(`[GCP-ADC] Materialized GCP_SERVICE_ACCOUNT_JSON to ${keyPath} for ADC resolution`);
  } catch (err: any) {
    console.error('[GCP-ADC] GCP_SERVICE_ACCOUNT_JSON present but invalid — ADC will fail:', err.message);
  }
}
