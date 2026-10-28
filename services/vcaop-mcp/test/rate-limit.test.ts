/** Rate limiting on the MCP endpoint. */
import { makeHarness, mintToken, rpc, toolsCallBody } from './helpers';
import { RateLimiter } from '../src/rate-limit';

describe('rate limiting', () => {
  test('requests beyond the window limit get 429 with Retry-After', async () => {
    const { app } = makeHarness({
      rateLimiter: new RateLimiter({ limitPerWindow: 2, windowMs: 60_000 }),
    });
    const token = mintToken({ jti: 'jti-rl' });
    expect((await rpc(app, token, toolsCallBody('get_wallet', {}))).status).toBe(200);
    expect((await rpc(app, token, toolsCallBody('get_wallet', {}))).status).toBe(200);
    const limited = await rpc(app, token, toolsCallBody('get_wallet', {}));
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.body.error.code).toBe('rate_limited');
  });

  test('limits are per subject: a different user is not affected', async () => {
    const { app } = makeHarness({
      rateLimiter: new RateLimiter({ limitPerWindow: 1, windowMs: 60_000 }),
    });
    const a = mintToken({ sub: 'tenant-a-user-1' });
    const b = mintToken({ sub: 'tenant-a-user-2' });
    expect((await rpc(app, a, toolsCallBody('get_wallet', {}))).status).toBe(200);
    expect((await rpc(app, a, toolsCallBody('get_wallet', {}))).status).toBe(429);
    expect((await rpc(app, b, toolsCallBody('get_wallet', {}))).status).toBe(200);
  });

  test('window resets allow traffic again', () => {
    let t = 0;
    const limiter = new RateLimiter({ limitPerWindow: 1, windowMs: 100, now: () => t });
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(false);
    t = 150;
    expect(limiter.allow('k')).toBe(true);
  });
});
