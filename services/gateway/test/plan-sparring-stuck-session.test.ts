/**
 * plan-spar-stuck-session — an unresponsive partner never leaves a session without a round for longer than the
 * CI client waits (scripts/collab/plan-spar.mjs WAIT_MS = 25 min):
 *  (1) a single partner model call that never returns ends the pass at its deadline with `deadline_exceeded`
 *      (an escalated round 1, infra + retryable), instead of hanging the request;
 *  (2) a 0-round in_progress session older than the longest pass deadline + slack (20 min) is dead, so the
 *      client's re-post gets a fresh session instead of the stuck one.
 * The review itself is unchanged: no prompt, round cap, evidence floor or convergence rule is touched.
 */
import { runPartnerPass } from '../src/services/plan-sparring/partner';
import { STALE_AFTER_MS, isDeadRoundOne } from '../src/services/plan-sparring/plan-sparring-service';

describe('plan-spar-stuck-session', () => {
  it('(1) a partner model call that never resolves ends the pass with deadline_exceeded at the deadline', async () => {
    const callLlm = jest.fn(() => new Promise<never>(() => { /* the model never answers */ }));
    const t0 = Date.now();
    const r = await runPartnerPass({
      round: 1, prompt: 'p', callLlm: callLlm as never, executeTool: (async () => ({ ok: true })) as never, deadlineMs: 200,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('deadline_exceeded');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(callLlm).toHaveBeenCalledTimes(1);
  });

  it('(1b) a code-access tool call that never resolves ends the pass with deadline_exceeded at the deadline', async () => {
    const callLlm = jest.fn(async () => ({
      ok: true, provider: 'bedrock', model: 'm', text: '', usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'CLAUDE.md' } }],
    }));
    const executeTool = jest.fn(() => new Promise<never>(() => { /* GitHub never answers */ }));
    const t0 = Date.now();
    const r = await runPartnerPass({ round: 1, prompt: 'p', callLlm: callLlm as never, executeTool: executeTool as never, deadlineMs: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('deadline_exceeded');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('(2) STALE_AFTER_MS is above the longest pass deadline (15 min) and below the CI wait (25 min)', () => {
    expect(STALE_AFTER_MS).toBeGreaterThan(15 * 60_000);
    expect(STALE_AFTER_MS).toBeLessThan(25 * 60_000);
  });

  it('(3) a 0-round in_progress session 21 min old is dead (re-run), 19 min old is not (dedup)', () => {
    const NOW = Date.parse('2026-10-27T12:00:00Z');
    const s = (min: number) => ({ verdict: 'in_progress', rounds: [], updated_at: new Date(NOW - min * 60_000).toISOString() }) as never;
    expect(isDeadRoundOne(s(21), NOW)).toBe(true);
    expect(isDeadRoundOne(s(19), NOW)).toBe(false);
  });
});
