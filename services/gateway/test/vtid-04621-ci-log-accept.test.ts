/**
 * VTID-04621: the default network path of collectCiFailureEvidence asks
 * GitHub for a job log with the REST media type. `Accept: text/plain` gets a
 * 415 (verified live 2026-09-26), so every fix-mode child saw
 * "[log unavailable]" instead of the failing test output.
 */
import { collectCiFailureEvidence, GITHUB_REST_ACCEPT } from '../src/services/dev-autopilot-ci-logs';

describe('collectCiFailureEvidence — default GitHub fetch', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('requests the job log with the REST media type and reads the redirected body as text', async () => {
    const calls: Array<{ url: string; accept: string }> = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      const accept = init?.headers?.Accept;
      calls.push({ url: String(url), accept });
      if (accept !== GITHUB_REST_ACCEPT) return new Response('unsupported', { status: 415 });
      if (String(url).includes('/check-runs')) {
        return new Response(JSON.stringify({ check_runs: [{
          name: 'Gateway (Jest, ~7.5k tests)', conclusion: 'failure',
          details_url: 'https://github.com/o/r/actions/runs/1/job/42',
        }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('FAIL test/x.test.ts\n  ● x › y\n    expected 1 received 2\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;

    const out = await collectCiFailureEvidence({ owner: 'o', repo: 'r', headSha: 'abc', failedNames: ['Gateway (Jest, ~7.5k tests)'], token: 't' });

    expect(calls.map((c) => c.accept)).toEqual([GITHUB_REST_ACCEPT, GITHUB_REST_ACCEPT]);
    expect(calls[1].url).toBe('https://api.github.com/repos/o/r/actions/jobs/42/logs');
    expect(out).toHaveLength(1);
    expect(out[0].unavailable).toBeFalsy();
    expect(out[0].excerpt).toContain('expected 1 received 2');
  });

  it('never sends text/plain as the Accept header', () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/services/dev-autopilot-ci-logs.ts'), 'utf8');
    expect(src).not.toMatch(/githubGet[^;]*'text\/plain'/);
  });
});
