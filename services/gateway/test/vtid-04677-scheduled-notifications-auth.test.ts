/**
 * VTID-04677 — /api/v1/scheduled-notifications/* requires X-Gateway-Internal.
 *
 * Every POST under the router fans out notifications (often a push to every
 * member of a tenant) and accepted anonymous requests from the internet. The
 * middleware accepts only the internal token (no admin JWT path), keeps
 * GET /health open, and has a log / enforce / off rollout switch.
 */
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { load } from 'js-yaml';
import {
  requireScheduledNotificationsAuth,
  resolveScheduledNotificationsAuthMode,
  tokensMatch,
  scheduledNotificationsAuthStatus,
  internalTokenHeaders,
} from '../src/middleware/scheduled-notifications-auth';

const ROOT = join(__dirname, '../../..');
const TOKEN = 'a'.repeat(64);

function app() {
  const a = express();
  const r = express.Router();
  r.use(requireScheduledNotificationsAuth);
  r.post('/push-dispatch', (_req, res) => res.json({ ok: true, ran: true }));
  r.get('/health', (_req, res) => res.json({ ok: true, ...scheduledNotificationsAuthStatus() }));
  a.use('/api/v1/scheduled-notifications', r);
  return a;
}

const ENV_KEYS = ['GATEWAY_INTERNAL_TOKEN', 'SCHEDULED_NOTIFICATIONS_AUTH_MODE'] as const;
const saved: Record<string, string | undefined> = {};
let warn: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.GATEWAY_INTERNAL_TOKEN = TOKEN;
  delete process.env.SCHEDULED_NOTIFICATIONS_AUTH_MODE;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  warn.mockRestore();
  error.mockRestore();
});

describe('mode switch', () => {
  it('defaults to log; only exact enforce/off change it', () => {
    expect(resolveScheduledNotificationsAuthMode(undefined)).toBe('log');
    expect(resolveScheduledNotificationsAuthMode('')).toBe('log');
    expect(resolveScheduledNotificationsAuthMode('enforced')).toBe('log');
    expect(resolveScheduledNotificationsAuthMode(' ENFORCE ')).toBe('enforce');
    expect(resolveScheduledNotificationsAuthMode('off')).toBe('off');
  });
});

describe('token compare', () => {
  it('matches only an identical non-empty token', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(tokensMatch('b'.repeat(64), TOKEN)).toBe(false);
    expect(tokensMatch('', '')).toBe(false);
    expect(tokensMatch(TOKEN, '')).toBe(false);
  });
});

describe('enforce mode', () => {
  beforeEach(() => { process.env.SCHEDULED_NOTIFICATIONS_AUTH_MODE = 'enforce'; });

  it('runs the route with the right token', async () => {
    const r = await request(app()).post('/api/v1/scheduled-notifications/push-dispatch').set('X-Gateway-Internal', TOKEN);
    expect(r.status).toBe(200);
    expect(r.body.ran).toBe(true);
  });

  it('401 without a token, 403 with a wrong one — the route never runs', async () => {
    const a = await request(app()).post('/api/v1/scheduled-notifications/push-dispatch');
    expect(a.status).toBe(401);
    expect(a.body.ran).toBeUndefined();
    const b = await request(app()).post('/api/v1/scheduled-notifications/push-dispatch').set('X-Gateway-Internal', 'wrong');
    expect(b.status).toBe(403);
    expect(b.body.ran).toBeUndefined();
  });

  it('an admin bearer token is not accepted (no JWT path)', async () => {
    const r = await request(app()).post('/api/v1/scheduled-notifications/push-dispatch').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(401);
  });

  it('503 and a loud error when the gateway has no token configured', async () => {
    delete process.env.GATEWAY_INTERNAL_TOKEN;
    const r = await request(app()).post('/api/v1/scheduled-notifications/push-dispatch').set('X-Gateway-Internal', TOKEN);
    expect(r.status).toBe(503);
    expect(error).toHaveBeenCalled();
  });

  it('GET /health stays open and reports the mode', async () => {
    const r = await request(app()).get('/api/v1/scheduled-notifications/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ auth_mode: 'enforce', internal_token_configured: true });
  });
});

describe('log mode (default)', () => {
  it('lets an anonymous call through and logs it without the header value', async () => {
    const r = await request(app()).post('/api/v1/scheduled-notifications/push-dispatch').set('X-Gateway-Internal', 'leaked-guess');
    expect(r.status).toBe(200);
    expect(r.body.ran).toBe(true);
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('would be rejected (mode=log): POST /api/v1/scheduled-notifications/push-dispatch');
    expect(line).not.toContain('leaked-guess');
    expect(line).not.toContain(TOKEN);
  });

  it('a call with the right token is not logged', async () => {
    await request(app()).post('/api/v1/scheduled-notifications/push-dispatch').set('X-Gateway-Internal', TOKEN);
    expect(warn).not.toHaveBeenCalled();
  });

  it('health reports log and whether a token is set, never the token', async () => {
    delete process.env.GATEWAY_INTERNAL_TOKEN;
    const r = await request(app()).get('/api/v1/scheduled-notifications/health');
    expect(r.body).toMatchObject({ auth_mode: 'log', internal_token_configured: false });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });
});

describe('off mode', () => {
  it('runs without any check or log line', async () => {
    process.env.SCHEDULED_NOTIFICATIONS_AUTH_MODE = 'off';
    const r = await request(app()).post('/api/v1/scheduled-notifications/push-dispatch');
    expect(r.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('internalTokenHeaders (gateway self-calls)', () => {
  it('sends the token when configured, nothing otherwise', () => {
    expect(internalTokenHeaders()).toEqual({ 'X-Gateway-Internal': TOKEN });
    delete process.env.GATEWAY_INTERNAL_TOKEN;
    expect(internalTokenHeaders()).toEqual({});
  });
});

describe('wiring (source)', () => {
  const route = readFileSync(join(__dirname, '../src/routes/scheduled-notifications.ts'), 'utf8');
  const engagement = readFileSync(join(__dirname, '../src/services/automation-handlers/engagement-events.ts'), 'utf8');

  it('the middleware is registered before the first route of the router', () => {
    const use = route.indexOf('router.use(requireScheduledNotificationsAuth)');
    const firstRoute = route.search(/router\.(post|get)\(/);
    expect(use).toBeGreaterThan(-1);
    expect(use).toBeLessThan(firstRoute);
  });

  it('no route is still marked public', () => {
    expect(route).not.toMatch(/public-route/);
    expect(route).not.toMatch(/protected by GCP IAM/);
  });

  it('/health reports the auth status', () => {
    expect(route).toContain('...scheduledNotificationsAuthStatus()');
  });

  it('every gateway self-call to these routes sends the token', () => {
    const calls = engagement.match(/fetch\(`\$\{gatewayUrl\}\/api\/v1\/scheduled-notifications\/[a-z-]+`, \{[\s\S]*?headers: \{[^}]*\}/g) || [];
    expect(calls.length).toBe(5);
    for (const c of calls) expect(c).toContain('...internalTokenHeaders()');
  });
});

describe('deploy workflows', () => {
  const PROD = readFileSync(join(ROOT, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
  const STAGE = readFileSync(join(ROOT, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
  const wf = load(PROD) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string; if?: string; env?: Record<string, string> }> }> };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps || []);
  const names = steps.map((s) => s.name || '');
  const step = steps.find((s) => s.name === 'Build task-definition (internal token)');

  it('prod wires GATEWAY_INTERNAL_TOKEN in every deploy mode, before register/roll', () => {
    expect(step).toBeDefined();
    expect(step!.if).toBeUndefined();
    const i = names.indexOf('Build task-definition (internal token)');
    expect(i).toBeLessThan(names.findIndex((n) => n.startsWith('Build task-definition (2/2')));
    expect(step!.env!.INTERNAL_TOKEN_SECRET_ARN).toMatch(
      /^arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana\/gateway\/prod\/internal-token-[A-Za-z0-9]{6}$/,
    );
  });

  it('prod step replaces any existing entry and keeps the other secrets (runs its jq)', () => {
    const filter = /jq --arg T "\$INTERNAL_TOKEN_SECRET_ARN" '([\s\S]+?)' \/tmp\/vitana-new-task-def\.json/.exec(step!.run!)![1];
    const def = { containerDefinitions: [{ secrets: [{ name: 'GATEWAY_INTERNAL_TOKEN', valueFrom: 'old' }, { name: 'SUPABASE_URL', valueFrom: 'arn:a' }] }] };
    const out = JSON.parse(execFileSync('jq', ['--arg', 'T', 'arn:new', filter], { input: JSON.stringify(def) }).toString());
    expect(out.containerDefinitions[0].secrets).toEqual([
      { name: 'SUPABASE_URL', valueFrom: 'arn:a' },
      { name: 'GATEWAY_INTERNAL_TOKEN', valueFrom: 'arn:new' },
    ]);
  });

  it('prod does not set an auth mode (stays log until enforce is approved)', () => {
    expect(PROD).not.toMatch(/SCHEDULED_NOTIFICATIONS_AUTH_MODE", value/);
  });

  it('staging pins log mode and strips the old value first', () => {
    expect(STAGE).toContain('{name:"SCHEDULED_NOTIFICATIONS_AUTH_MODE", value:"log"}');
    expect(STAGE).toContain('"LEDGER_WRITE_AUTH_MODE","SCHEDULED_NOTIFICATIONS_AUTH_MODE",');
  });

  it('staging prints the secret lookup error instead of discarding it', () => {
    const line = STAGE.split('\n').find((l) => l.includes('describe-secret --secret-id vitana/gateway/staging/internal-token'))!;
    expect(line).not.toContain('2>/dev/null');
    expect(STAGE).toContain('internal-token secret not resolved (VTID-04226/04677) - not wired: $(head -c 300 "$SEC_IT_ERR"');
  });
});

describe('scheduler Lambda scripts', () => {
  const SCRIPTS = ['push-dispatch', 'daily-feature-tip', 'whats-new'].map((n) => join(ROOT, `scripts/aws/setup-eventbridge-${n}.sh`));
  const CRON = join(ROOT, 'scripts/aws/setup-eventbridge-cron-migration.sh');

  function lambdaJs(path: string): string {
    const src = readFileSync(path, 'utf8');
    return /cat > "\$WORKDIR\/index\.js" <<'JS'\n([\s\S]*?)\nJS\n/.exec(src)![1];
  }

  it.each(SCRIPTS)('%s: valid bash, token read from the prod secret and sent as X-Gateway-Internal', (path) => {
    execFileSync('bash', ['-n', path]);
    const src = readFileSync(path, 'utf8');
    expect(src).toContain('INTERNAL_TOKEN_SECRET_ID="${GATEWAY_INTERNAL_TOKEN_SECRET_ID:-vitana/gateway/prod/internal-token}"');
    expect(src).toContain('--policy-name "read-gateway-internal-token"');
    expect(src.match(/GATEWAY_INTERNAL_TOKEN_SECRET_ID=\$INTERNAL_TOKEN_SECRET_ID\}/g)!.length).toBe(2);
    const js = lambdaJs(path);
    expect(js).toContain("GetSecretValueCommand({ SecretId: id })");
    expect(js).toContain("...(token ? { 'X-Gateway-Internal': token } : {})");
    expect(js).toContain('const token = await internalToken();');
  });

  it.each(SCRIPTS)('%s: the embedded Lambda code parses', (path) => {
    expect(() => new Function('require', 'exports', 'process', 'Buffer', lambdaJs(path))).not.toThrow();
  });

  it('cron script: notification jobs carry the prod token secret; daily-feature-tip is not duplicated', () => {
    const src = readFileSync(CRON, 'utf8');
    expect(src).not.toMatch(/"gateway-daily-feature-tip\|/);
    for (const job of ['gateway-reminders-tick', 'gateway-reminders-sweeper', 'gateway-daily-pace-notifications', 'gateway-night-push']) {
      const line = src.split('\n').find((l) => l.includes(`"${job}|`))!;
      expect(line).toContain('\\"auth\\":\\"gateway_internal\\",\\"token_secret_id\\":\\"$PROD_INTERNAL_TOKEN_SECRET_ID\\"');
    }
    expect(src).toContain('internalToken(event.token_secret_id)');
    expect(src).toContain('"arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${PROD_INTERNAL_TOKEN_SECRET_ID}-*"');
  });
});
