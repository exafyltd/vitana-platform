/**
 * VTID-05153 — ssrfGuardedHead (services/platform-detect.ts): the catalogue
 * check's media probe. HEAD only, host checked by assertPublicHost before
 * every hop (redirects included), at most 3 redirects, one 5 s deadline, a
 * 405/501 retried once as a ranged GET, and no body ever read. Public IP
 * literals keep DNS out of the test.
 */
import { PROBE_MAX_REDIRECTS, PROBE_TIMEOUT_MS, ssrfGuardedHead } from '../src/services/platform-detect';

const PUBLIC = 'https://93.184.216.34';

function res(status: number, headers: Record<string, string> = {}) {
  const cancel = jest.fn(() => Promise.resolve());
  return { status, headers: new Headers(headers), body: { cancel } } as any;
}

describe('ssrfGuardedHead', () => {
  it('sends HEAD with no credentials and returns status + content type; the body is never read', async () => {
    const r = res(200, { 'content-type': 'image/webp' });
    const fetchFn = jest.fn(async () => r);
    const out = await ssrfGuardedHead(`${PUBLIC}/a.webp`, fetchFn as any);
    expect(out).toEqual({ status: 200, contentType: 'image/webp', finalUrl: `${PUBLIC}/a.webp` });
    const [, init] = (fetchFn.mock.calls[0] as any[]);
    expect(init.method).toBe('HEAD');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeDefined();
    const sent = Object.keys(init.headers).map((k) => k.toLowerCase());
    expect(sent).not.toContain('authorization');
    expect(sent).not.toContain('cookie');
    expect(init.credentials).toBeUndefined();
    expect(r.body.cancel).toHaveBeenCalled();
    expect(PROBE_TIMEOUT_MS).toBe(5000);
  });

  it('405 and 501 fall back to ONE GET with Range: bytes=0-0', async () => {
    for (const s of [405, 501]) {
      const fetchFn = jest.fn()
        .mockResolvedValueOnce(res(s))
        .mockResolvedValueOnce(res(206, { 'content-type': 'image/png' }));
      const out = await ssrfGuardedHead(`${PUBLIC}/a.png`, fetchFn as any);
      expect(out.status).toBe(206);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn.mock.calls[1][1]).toMatchObject({ method: 'GET', headers: expect.objectContaining({ Range: 'bytes=0-0' }) });
    }
    const twice = jest.fn().mockResolvedValue(res(405));
    expect((await ssrfGuardedHead(`${PUBLIC}/a.png`, twice as any)).status).toBe(405);
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it('a private host is refused before any request', async () => {
    const fetchFn = jest.fn();
    await expect(ssrfGuardedHead('http://127.0.0.1/a.png', fetchFn as any)).rejects.toThrow('blocked_private_address');
    await expect(ssrfGuardedHead('http://[::1]/a.png', fetchFn as any)).rejects.toThrow('blocked_private_address');
    await expect(ssrfGuardedHead('ftp://93.184.216.34/a.png', fetchFn as any)).rejects.toThrow('unsupported_protocol');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('re-checks the host on every redirect: a redirect to a private address is refused', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(res(302, { location: 'http://169.254.169.254/latest/meta-data' }));
    await expect(ssrfGuardedHead(`${PUBLIC}/a.png`, fetchFn as any)).rejects.toThrow('blocked_private_address');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('follows at most 3 redirects', async () => {
    const ok = jest.fn()
      .mockResolvedValueOnce(res(301, { location: '/b' }))
      .mockResolvedValueOnce(res(302, { location: '/c' }))
      .mockResolvedValueOnce(res(307, { location: '/d' }))
      .mockResolvedValueOnce(res(200, { 'content-type': 'image/jpeg' }));
    expect(await ssrfGuardedHead(`${PUBLIC}/a`, ok as any)).toMatchObject({ status: 200, finalUrl: `${PUBLIC}/d` });
    const tooMany = jest.fn().mockResolvedValue(res(302, { location: '/again' }));
    await expect(ssrfGuardedHead(`${PUBLIC}/a`, tooMany as any)).rejects.toThrow('too_many_redirects');
    expect(tooMany).toHaveBeenCalledTimes(PROBE_MAX_REDIRECTS + 1);
  });

  it('a timeout surfaces as an error (the caller counts it as a network failure)', async () => {
    const fetchFn = jest.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); });
    await expect(ssrfGuardedHead(`${PUBLIC}/a.png`, fetchFn as any)).rejects.toThrow('aborted');
  });
});
