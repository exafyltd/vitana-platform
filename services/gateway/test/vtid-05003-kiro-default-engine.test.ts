/**
 * VTID-05003: Kiro is the Operator's default engine while the user's own Kiro
 * Power seat can serve; a used-up seat is reported, never silently replaced.
 */
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { setKiroBackend, runKiroTurn, closeAllKiroSessions } from '../src/services/kiro/kiro-turn';
import { getKiroCredits, setKiroCredits, resetKiroCredits, isKiroCreditError, kiroDefaultEngine } from '../src/services/kiro/credit-state';
import { kiroKeyLinked, clearKiroKeyCache } from '../src/services/kiro/remote-backend';

const U = '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
const U2 = 'bc34a5ca-6966-44f6-9507-3bed98e3e1d5';
const ENV = { KIRO_ENGINE_ENABLED: 'true' } as NodeJS.ProcessEnv;

type Script = (msg: any, send: (o: unknown) => void) => void;
function fakeChild(script: Script) {
  const out = new EventEmitter(); const proc = new EventEmitter(); let closed = false;
  return {
    get closed() { return closed; },
    stdout: out,
    stdin: { write: (l: string) => { script(JSON.parse(l), (o) => out.emit('data', `${JSON.stringify(o)}\n`)); return true; }, end: () => {} },
    kill: () => { closed = true; proc.emit('exit'); },
    on: (e: string, cb: any) => proc.on(e, cb),
  };
}
const withModels = (models: Array<{ value: string; name: string }>, promptError?: string): Script => (m, send) => {
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: {} });
  else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S', configOptions: [{ id: 'model', category: 'model', currentValue: models[0]?.value ?? null, options: models }] } });
  else if (m.method === 'session/prompt') send(promptError ? { jsonrpc: '2.0', id: m.id, error: { code: -1, message: promptError } } : { jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
};
let children: any[] = [];
function use(script: Script) { children = []; setKiroBackend({ spawn: () => { const c = fakeChild(script); children.push(c); return c as any; }, workspace: () => '/w' }); }

afterEach(() => { closeAllKiroSessions(); setKiroBackend(null); resetKiroCredits(); clearKiroKeyCache(); });

describe('default engine rule', () => {
  const base = { enabled: true, runnerConfigured: true, keyLinked: true as boolean | 'unknown', credits: 'ok' as const };
  it('is Kiro only when engine, runner, own key and credits all allow it', () => {
    expect(kiroDefaultEngine(base)).toBe('kiro');
    expect(kiroDefaultEngine({ ...base, credits: 'unknown' })).toBe('kiro');
    expect(kiroDefaultEngine({ ...base, credits: 'exhausted' })).toBe('llm');
    expect(kiroDefaultEngine({ ...base, keyLinked: false })).toBe('llm');
    expect(kiroDefaultEngine({ ...base, keyLinked: 'unknown' })).toBe('llm');
    expect(kiroDefaultEngine({ ...base, enabled: false })).toBe('llm');
    expect(kiroDefaultEngine({ ...base, runnerConfigured: false })).toBe('llm');
  });
});

describe('credit state', () => {
  it('is per user, reports changes once, and expires after an hour', () => {
    expect(getKiroCredits(U)).toBe('unknown');
    expect(setKiroCredits(U, 'exhausted', 1000)).toBe(true);
    expect(setKiroCredits(U, 'exhausted', 2000)).toBe(false);
    expect(getKiroCredits(U, 3000)).toBe('exhausted');
    expect(getKiroCredits(U2, 3000)).toBe('unknown');
    expect(getKiroCredits(U, 2000 + 60 * 60_000 + 1)).toBe('unknown'); // a repeat set refreshes the hour
    expect(getKiroCredits(null)).toBe('unknown');
  });
  it('recognises Kiro credit wording only', () => {
    expect(isKiroCreditError('Monthly credit limit reached for this subscription')).toBe(true);
    expect(isKiroCreditError('Quota exceeded')).toBe(true);
    expect(isKiroCreditError('kiro-cli exited')).toBe(false);
    expect(isKiroCreditError(undefined)).toBe(false);
  });
});

describe('a Kiro turn and the seat\'s credits', () => {
  it('an empty model list = credits used up: session closed, no_credits reply, marked once', async () => {
    use(withModels([]));
    const r = await runKiroTurn({ threadId: 't', userId: U, message: 'hi' }, ENV);
    expect(r.meta).toMatchObject({ kiro_status: 'no_credits', credit_source: 'empty_models', credits_changed: true });
    expect(r.reply).toMatch(/credits are used up/);
    expect(children[0].closed).toBe(true);
    expect(getKiroCredits(U)).toBe('exhausted');
    const again = await runKiroTurn({ threadId: 't2', userId: U, message: 'hi' }, ENV);
    expect(again.meta.credits_changed).toBe(false);
  });

  it('a model on open = ok again, and the first reply says it changed', async () => {
    setKiroCredits(U, 'exhausted');
    use(withModels([{ value: 'claude-sonnet', name: 'Claude Sonnet' }]));
    const r = await runKiroTurn({ threadId: 't', userId: U, message: 'hi' }, ENV);
    expect(r.meta).toMatchObject({ kiro_status: 'ok', credits_changed: true });
    expect(getKiroCredits(U)).toBe('ok');
    const r2 = await runKiroTurn({ threadId: 't', userId: U, message: 'again' }, ENV);
    expect(r2.meta.credits_changed).toBeUndefined();
  });

  it('a credit error from Kiro on a turn = used up; other errors leave the state alone', async () => {
    use(withModels([{ value: 'm', name: 'M' }], 'Monthly credit limit reached'));
    const r = await runKiroTurn({ threadId: 't', userId: U, message: 'hi' }, ENV);
    expect(r.meta).toMatchObject({ kiro_status: 'no_credits', credit_source: 'error', kiro_message: 'Monthly credit limit reached' });
    resetKiroCredits();
    use(withModels([{ value: 'm', name: 'M' }], 'something else broke'));
    const r2 = await runKiroTurn({ threadId: 't3', userId: U, message: 'hi' }, ENV);
    expect(r2.meta.kiro_status).toBe('error');
    expect(getKiroCredits(U)).toBe('ok'); // set by the session open, not by the failure
  });

  it('one user\'s used-up seat does not touch another\'s', async () => {
    use(withModels([]));
    await runKiroTurn({ threadId: 'a', userId: U, message: 'hi' }, ENV);
    expect(getKiroCredits(U2)).toBe('unknown');
  });
});

describe('key-linked lookup for the default engine', () => {
  const env = { KIRO_RUNNER_URL: 'http://r', KIRO_RUNNER_TOKEN: 't' } as any;
  it('asks the runner with a short timeout, caches 60 s, and is cleared on link/revoke', async () => {
    const f = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, linked: true, updated_at: null }) }));
    expect(await kiroKeyLinked(U, env, f as any, 0)).toBe(true);
    expect(await kiroKeyLinked(U, env, f as any, 59_000)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(await kiroKeyLinked(U, env, f as any, 61_000)).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    clearKiroKeyCache(U);
    await kiroKeyLinked(U, env, f as any, 62_000);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('an unreachable runner is "unknown" (=> Operator), never an error', async () => {
    const down = jest.fn(async () => { throw new Error('timeout'); });
    expect(await kiroKeyLinked(U, env, down as any)).toBe('unknown');
    expect(await kiroKeyLinked(U, {} as any)).toBe('unknown');
  });
});

describe('wiring (source check)', () => {
  const root = path.join(__dirname, '../../..');
  const operator = fs.readFileSync(path.join(__dirname, '../src/routes/operator.ts'), 'utf8');
  it('status is per signed-in user and returns the default engine, never the key', () => {
    const block = operator.slice(operator.indexOf("router.get('/kiro/status'"), operator.indexOf("router.post('/kiro/permissions/:requestId'"));
    expect(block).toContain('const userId = req.identity?.user_id ?? null;');
    expect(block).toContain('default_engine: kiroDefaultEngine(');
    expect(block).not.toMatch(/\bkey:/);
  });
  it('a used-up seat is logged to OASIS once per change', () => {
    expect(operator).toContain("type: 'operator.kiro.credits_exhausted'");
    expect(operator).toContain("result.meta.credits_changed === true");
    expect(fs.readFileSync(path.join(__dirname, '../src/types/cicd.ts'), 'utf8')).toContain("| 'operator.kiro.credits_exhausted'");
  });
  it('production runner deploy: dispatch-only, OIDC, promotes the staging image by tag, production names only', () => {
    const wf = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-KIRO-RUNNER.yml'), 'utf8');
    expect(wf).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(wf).not.toMatch(/\n\s*push:/);
    expect(wf).toContain('role-to-assume: ${{ secrets.AWS_PROD_ROLE_ARN }}');
    expect(wf).toContain('imageTag="staging-${{ steps.inputs.outputs.short }}"');
    expect(wf).toContain('--image-tag "prod-$SHORT"');
    expect(wf).not.toMatch(/docker build/);
    expect(wf).toContain('ECS_SERVICE: vitana-kiro-runner-awsdr');
    expect(wf).not.toContain('vitana/kiro-runner/staging');
  });
  it('environments never cross: staging gateway -> staging runner, production gateway -> production runner', () => {
    const stage = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(stage).toContain('http://kiro-runner.vitana.internal:8080');
    expect(stage).not.toContain('kiro-runner-prod');
    expect(stage).not.toContain('vitana/kiro-runner/production');
    expect(prod).toContain('http://kiro-runner-prod.vitana.internal:8080');
    expect(prod).toContain('vitana/kiro-runner/production/runner-token-*');
    expect(prod).not.toContain('kiro-runner.vitana.internal');
    expect(prod).toContain('KIRO_TOKEN_ARN: ${{ vars.KIRO_RUNNER_PROD_TOKEN_ARN }}');
  });
  it('the setup script keys every name off the environment', () => {
    const sh = fs.readFileSync(path.join(root, 'scripts/aws/setup-kiro-runner.sh'), 'utf8');
    expect(sh).toContain('SECRET_TOKEN="vitana/kiro-runner/${ENV_NAME}/runner-token"');
    expect(sh).toContain('KEY_PREFIX="vitana/kiro/${ENV_NAME}/users"');
    expect(sh).toContain('--policy-name "kiro-runner-token-${ENV_NAME}"');
    const wrapper = fs.readFileSync(path.join(root, 'scripts/aws/setup-kiro-runner-staging.sh'), 'utf8');
    expect(wrapper).toContain('setup-kiro-runner.sh" --env staging "$@"');
  });
});
