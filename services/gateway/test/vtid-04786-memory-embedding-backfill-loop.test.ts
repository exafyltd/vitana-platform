/**
 * VTID-04786 (follow-up) — moving AP-0910 onto the heartbeat loop did not
 * make it run: staging runs that loop in shadow mode, where the backfill is
 * shadow-unsafe and never executes, and production does not run the loop at
 * all. AP-0910 now has its own loop, started by an explicit flag and never in
 * shadow mode, pinned on the production gateway only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SHADOW_UNSAFE_HANDLERS } from '../src/services/automation-shadow';
import {
  BACKFILL_INTERVAL_MS,
  resolveBackfillLoopConfig,
  runBackfillTick,
  type BackfillDeps,
} from '../src/services/memory-embedding-backfill-loop';

const MAXINA = '2e7528b8-472a-4356-88da-0280d4639cce';
const OTHER = '00000000-0000-0000-0000-000000000001';
const ON = { MEMORY_EMBEDDING_BACKFILL_LOOP_ENABLED: 'true', MEMORY_EMBEDDING_BACKFILL_TENANT_IDS: MAXINA };

describe('AP-0910 backfill loop configuration (VTID-04786)', () => {
  it('starts only on the exact flag with a tenant id, in live delivery mode', () => {
    expect(resolveBackfillLoopConfig(ON)).toEqual({ enabled: true, tenantIds: [MAXINA] });
    expect(resolveBackfillLoopConfig({ ...ON, AUTOMATIONS_DELIVERY_MODE: 'live' }).enabled).toBe(true);
    expect(resolveBackfillLoopConfig({}).enabled).toBe(false);
    expect(resolveBackfillLoopConfig({ ...ON, MEMORY_EMBEDDING_BACKFILL_LOOP_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(resolveBackfillLoopConfig({ ...ON, MEMORY_EMBEDDING_BACKFILL_TENANT_IDS: '' }).enabled).toBe(false);
    expect(resolveBackfillLoopConfig({ ...ON, MEMORY_EMBEDDING_BACKFILL_TENANT_IDS: 'maxina' }).enabled).toBe(false);
  });

  it('never starts in shadow mode, whatever the flag says (staging shares the production database)', () => {
    const cfg = resolveBackfillLoopConfig({ ...ON, AUTOMATIONS_DELIVERY_MODE: 'shadow' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.reason).toMatch(/shadow/);
    // A typo resolves to shadow too.
    expect(resolveBackfillLoopConfig({ ...ON, AUTOMATIONS_DELIVERY_MODE: 'lvie' }).enabled).toBe(false);
  });

  it('parses a comma-separated tenant list', () => {
    expect(resolveBackfillLoopConfig({ ...ON, MEMORY_EMBEDDING_BACKFILL_TENANT_IDS: `${MAXINA}, ${OTHER}` }).tenantIds)
      .toEqual([MAXINA, OTHER]);
  });

  it('documents why the heartbeat loop could not carry it: the handler is shadow-unsafe', () => {
    expect(SHADOW_UNSAFE_HANDLERS.has('runMemoryEmbeddingBackfill')).toBe(true);
  });
});

describe('AP-0910 backfill tick (VTID-04786)', () => {
  const NOW = Date.parse('2026-10-01T16:00:00Z');
  const deps = (last: Record<string, string | null>, result = { ok: true }) => {
    const execute = jest.fn(async (_t: string) => result as { ok: boolean; skipped?: boolean; error?: string });
    const d: BackfillDeps = { latestRunAt: async (t) => last[t] ?? null, execute, now: () => NOW };
    return { d, execute };
  };

  it('runs a tenant that has never run or ran longer than 30 min ago', async () => {
    const { d, execute } = deps({ [MAXINA]: '2026-07-06T23:12:07Z', [OTHER]: null });
    const r = await runBackfillTick([MAXINA, OTHER], d);
    expect(r.ran).toEqual([MAXINA, OTHER]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('skips a tenant another gateway task ran inside the interval', async () => {
    const recent = new Date(NOW - BACKFILL_INTERVAL_MS + 60_000).toISOString();
    const { d, execute } = deps({ [MAXINA]: recent });
    const r = await runBackfillTick([MAXINA], d);
    expect(r).toEqual({ ran: [], skipped: [MAXINA], failed: [] });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports a failed run and a governance skip separately', async () => {
    expect((await runBackfillTick([MAXINA], deps({}, { ok: false, error: 'x' } as any).d)).failed).toEqual([MAXINA]);
    expect((await runBackfillTick([MAXINA], deps({}, { ok: true, skipped: true } as any).d)).skipped).toEqual([MAXINA]);
  });
});

describe('AP-0910 backfill loop wiring (VTID-04786)', () => {
  const root = path.resolve(__dirname, '../../..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('the gateway starts the loop at boot', () => {
    expect(read('services/gateway/src/index.ts')).toContain('startMemoryEmbeddingBackfillLoop()');
  });

  it('production pins the loop on for Maxina; staging does not', () => {
    const prod = read('.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml');
    expect(prod).toContain('{name:"MEMORY_EMBEDDING_BACKFILL_LOOP_ENABLED", value:"true"}');
    expect(prod).toContain(`{name:"MEMORY_EMBEDDING_BACKFILL_TENANT_IDS", value:"${MAXINA}"}`);
    expect(read('.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml')).not.toContain('MEMORY_EMBEDDING_BACKFILL_LOOP_ENABLED');
  });
});
