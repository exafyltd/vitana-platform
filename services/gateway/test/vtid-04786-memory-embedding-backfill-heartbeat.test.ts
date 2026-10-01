/**
 * VTID-04786 — AP-0910 (memory embedding backfill) had not run since
 * 2026-07-06: its only trigger was the GCP Cloud Scheduler and the EventBridge
 * replacement for the memory block was never applied. Memory health (morning
 * check 21) read 4% embedding coverage. The heartbeat-loop entry below
 * deduplicates across gateway tasks; the loop that actually runs it on
 * production is pinned in vtid-04786-memory-embedding-backfill-loop.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getAutomation, getHeartbeatAutomations } from '../src/services/automation-registry';
import * as repo from '../src/services/automation-executor-repository';
import { runHeartbeatCycle } from '../src/services/automation-executor';

const TENANT = '00000000-0000-0000-0000-000000000001';

describe('AP-0910 runs from the heartbeat loop (VTID-04786)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is a heartbeat job every 30 min, deduplicated across gateway tasks', () => {
    const def = getAutomation('AP-0910')!;
    expect(def.triggerType).toBe('heartbeat');
    expect(def.triggerConfig).toEqual({ intervalMinutes: 30, dedupeAcrossInstances: true });
    expect(getHeartbeatAutomations().map((d) => d.id)).toContain('AP-0910');
  });

  it('skips when another gateway task already ran it inside the interval', async () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const history = jest.spyOn(repo, 'fetchAutomationRunHistory').mockImplementation(
      (async (_sb: unknown, _t: string, id?: string) => ({
        data: id === 'AP-0910' ? [{ automation_id: 'AP-0910', started_at: recent }] : [],
        error: null,
      })) as any,
    );
    // Only AP-0910 is under test: every other heartbeat job is treated as
    // already run this interval by the in-memory clock.
    const only = getHeartbeatAutomations().filter((d) => d.id === 'AP-0910');
    jest.spyOn(require('../src/services/automation-registry'), 'getHeartbeatAutomations').mockReturnValue(only);

    const result = await runHeartbeatCycle(TENANT);
    expect(history).toHaveBeenCalledWith(expect.anything(), TENANT, 'AP-0910', 1);
    expect(result.skipped).toContain('AP-0910');
    expect(result.executed).not.toContain('AP-0910');
  });

  it('the guard runs before the job executes, and only for opted-in jobs', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/automation-executor.ts'), 'utf8');
    const guard = src.indexOf('def.triggerConfig?.dedupeAcrossInstances');
    const exec = src.indexOf("executeAutomation(def.id, tenantId, 'heartbeat', 'heartbeat-loop')");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(exec);
  });

  it('drains 200 rows per store per run', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/services/automation-handlers/memory-intelligence.ts'), 'utf8');
    expect(src).toContain('const EMBED_BACKFILL_BATCH = 200;');
  });
});
