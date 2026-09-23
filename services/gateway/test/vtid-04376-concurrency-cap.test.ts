/**
 * VTID-04376: the concurrency cap counts agents that are actually running;
 * PRs waiting on CI / merge / deploy / verification are bounded separately
 * (tail cap), so a slow post-merge tail no longer starves the claim tick.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  countPipelineStatuses,
  pipelineSlots,
  resolveTailCap,
  DEFAULT_TAIL_CAP,
  POST_MERGE_TAIL_STATUSES,
} from '../src/services/dev-autopilot-pipeline-guards';

const rows = (spec: Record<string, number>) =>
  Object.entries(spec).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })));

describe('countPipelineStatuses', () => {
  it('splits cooling, running and the post-merge tail', () => {
    expect(countPipelineStatuses(rows({ cooling: 2, running: 1, ci: 3, merging: 1, deploying: 1, verifying: 2 })))
      .toEqual({ cooling: 2, running: 1, tail: 7 });
  });
  it('ignores statuses outside the pipeline and tolerates null', () => {
    expect(countPipelineStatuses(rows({ awaiting_approval: 4, completed: 9, failed: 2 }))).toEqual({ cooling: 0, running: 0, tail: 0 });
    expect(countPipelineStatuses(null)).toEqual({ cooling: 0, running: 0, tail: 0 });
  });
  it('the tail is exactly ci/merging/deploying/verifying', () => {
    expect([...POST_MERGE_TAIL_STATUSES]).toEqual(['ci', 'merging', 'deploying', 'verifying']);
  });
});

describe('pipelineSlots', () => {
  it('a full post-merge tail below the tail cap no longer blocks claiming', () => {
    // Before VTID-04376 the cap of 2 counted these 5 tail rows: 0 slots.
    expect(pipelineSlots('claim', { cooling: 3, running: 0, tail: 5 }, 2, 8)).toBe(2);
  });
  it('claim counts only running agents; approve also counts the cooling queue', () => {
    const c = { cooling: 1, running: 1, tail: 0 };
    expect(pipelineSlots('claim', c, 3, 8)).toBe(2);
    expect(pipelineSlots('approve', c, 3, 8)).toBe(1);
  });
  it('the tail cap bounds both ticks', () => {
    expect(pipelineSlots('claim', { cooling: 0, running: 0, tail: 7 }, 5, 8)).toBe(1);
    expect(pipelineSlots('approve', { cooling: 0, running: 0, tail: 8 }, 5, 8)).toBe(0);
  });
  it('never negative', () => {
    expect(pipelineSlots('approve', { cooling: 4, running: 3, tail: 12 }, 2, 8)).toBe(0);
  });
});

describe('resolveTailCap', () => {
  it('defaults, accepts a positive integer, rejects garbage', () => {
    expect(resolveTailCap({})).toBe(DEFAULT_TAIL_CAP);
    expect(resolveTailCap({ DEV_AUTOPILOT_TAIL_CAP: '12' })).toBe(12);
    expect(resolveTailCap({ DEV_AUTOPILOT_TAIL_CAP: '0' })).toBe(DEFAULT_TAIL_CAP);
    expect(resolveTailCap({ DEV_AUTOPILOT_TAIL_CAP: 'lots' })).toBe(DEFAULT_TAIL_CAP);
  });
});

describe('wiring', () => {
  const exec = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
  const sup = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-supervisor.ts'), 'utf8');
  it('the claim tick and auto-approve both size themselves with pipelineSlots', () => {
    expect(exec).toMatch(/pipelineSlots\('claim', pipeline, cfg\.concurrency_cap, resolveTailCap\(\)\)/);
    expect(exec).toMatch(/pipelineSlots\('approve', await countPipeline\(s\), cfg\.concurrency_cap, resolveTailCap\(\)\)/);
    expect(exec).not.toMatch(/countRunningExecutions/);
  });
  it('the supervisor reports the same number the claim tick uses', () => {
    expect(sup).toMatch(/pipelineSlots\('claim', countPipelineStatuses\(execRows\)/);
  });
});
