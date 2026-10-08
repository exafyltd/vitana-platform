/**
 * VTID-04999: kiro-runner entry point. Port 8080, health on /alive.
 * Config is env only; the token and the key prefix are required.
 */
import fs from 'fs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { KeyStore } from './key-store';
import { defaultWorkRoot, stopAllSessions } from './relay';
import { createRunnerServer } from './server';

function intEnv(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const token = process.env.KIRO_RUNNER_TOKEN ?? '';
const prefix = process.env.KIRO_KEY_SECRET_PREFIX ?? '';
if (!token || !prefix) {
  console.error('[kiro-runner] KIRO_RUNNER_TOKEN and KIRO_KEY_SECRET_PREFIX are required');
  process.exit(1);
}

const workRoot = defaultWorkRoot();
fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });

const store = new KeyStore(new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-central-1' }), prefix, process.env.KIRO_KEY_READER_ROLE_ARN || null);
const server = createRunnerServer({
  token,
  workRoot,
  maxSessions: intEnv('KIRO_RUNNER_MAX_SESSIONS', 10),
  kiroCliVersion: process.env.KIRO_CLI_VERSION ?? 'unknown',
  limits: {
    idleMs: intEnv('KIRO_RUNNER_IDLE_MS', 15 * 60_000),
    maxSessionMs: intEnv('KIRO_RUNNER_MAX_SESSION_MS', 14_400_000),
    pingMs: 30_000,
    maxLineBytes: 1024 * 1024,
    maxBufferedBytes: 8 * 1024 * 1024,
  },
}, store);

const port = intEnv('PORT', 8080);
server.listen(port, () => console.log(`[kiro-runner] listening on ${port} (kiro-cli ${process.env.KIRO_CLI_VERSION ?? 'unknown'})`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { stopAllSessions(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); });
}
