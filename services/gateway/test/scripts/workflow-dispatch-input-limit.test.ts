// VTID-03697 — no workflow may exceed GitHub's `workflow_dispatch` input limit.
//
// GitHub allows at most 25 inputs on a `workflow_dispatch` event. Exceeding it
// is not a soft failure or a truncated list — GitHub refuses to parse the
// workflow at all:
//
//   failed to parse workflow: you may only define up to 25 `inputs`
//   for a `workflow_dispatch` event
//
// AWS-PROD-DEPLOY-GATEWAY.yml went from 24 to 26 inputs and became completely
// undispatchable. That took production deploys offline — including the Command
// Hub PUBLISH button, which dispatches that same workflow — and nothing caught
// it, because a `workflow_dispatch`-only workflow is never exercised by a push.
// The breakage surfaces at the one moment it is most expensive: when someone
// tries to ship.
//
// This is the same failure shape as VTID-03505 (an unparseable workflow that
// ran zero jobs for 30+ runs) and VTID-03696 (a gate that could never pass).
// A mechanism that looks present and cannot run is worse than an absent one.
//
// The limit is a GitHub platform constraint, not a repo convention, so this
// asserts it across EVERY workflow rather than pinning the one file that hit
// it — the next file to approach the ceiling is the one nobody is watching.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');

const WORKFLOW_DIR = join(__dirname, '../../../../.github/workflows');

/** GitHub's hard limit. Not tunable, not a style choice. */
const MAX_DISPATCH_INPUTS = 25;

interface Counted {
  file: string;
  count: number;
}

function countDispatchInputs(): Counted[] {
  const out: Counted[] = [];
  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (!/\.ya?ml$/.test(file)) continue;
    let doc: unknown;
    try {
      doc = yaml.load(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    } catch {
      // Unparseable YAML is its own (separate) problem; skip rather than
      // masking it as an input-count failure.
      continue;
    }
    const on = (doc as Record<string, unknown>)?.on ?? (doc as Record<string, unknown>)?.[true as unknown as string];
    const dispatch = (on as Record<string, unknown>)?.workflow_dispatch as
      | { inputs?: Record<string, unknown> }
      | undefined;
    if (!dispatch || !dispatch.inputs) continue;
    out.push({ file, count: Object.keys(dispatch.inputs).length });
  }
  return out;
}

describe('workflow_dispatch input limit', () => {
  it('no workflow exceeds GitHub’s 25-input maximum', () => {
    const over = countDispatchInputs().filter((w) => w.count > MAX_DISPATCH_INPUTS);
    // Named explicitly so the failure says which file and by how much, rather
    // than just "expected 1 to be 0".
    expect(over.map((w) => `${w.file}: ${w.count} inputs`)).toEqual([]);
  });

  it('AWS-PROD-DEPLOY-GATEWAY.yml specifically stays dispatchable', () => {
    // The one that actually broke, and the one the PUBLISH button depends on.
    const gw = countDispatchInputs().find((w) => w.file === 'AWS-PROD-DEPLOY-GATEWAY.yml');
    expect(gw).toBeDefined();
    expect(gw!.count).toBeLessThanOrEqual(MAX_DISPATCH_INPUTS);
  });

  it('actually parsed some dispatch workflows — a guard that scans nothing passes forever', () => {
    const counted = countDispatchInputs();
    expect(counted.length).toBeGreaterThan(3);
  });

  it('flags a workflow that is near the ceiling, so the next addition is a decision', () => {
    // Not a failure — a visible signal. AWS-PROD-DEPLOY-GATEWAY.yml sat at 24
    // and one routine two-input change silently crossed the line.
    const near = countDispatchInputs().filter((w) => w.count >= MAX_DISPATCH_INPUTS - 2);
    if (near.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[workflow-inputs] within 2 of the ${MAX_DISPATCH_INPUTS} limit: ` +
          near.map((w) => `${w.file}=${w.count}`).join(', '),
      );
    }
    expect(near.every((w) => w.count <= MAX_DISPATCH_INPUTS)).toBe(true);
  });
});
