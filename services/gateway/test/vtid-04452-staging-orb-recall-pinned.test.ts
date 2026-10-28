// VTID-04452 — MEMORY_ORB_RECALL_ENABLED is pinned on staging.
// VTID-05007 — and, after the 72 h production shadow (VTID-04784), on prod too.
// This replaces VTID-04452's "prod does not set it" on purpose (owner, 2026-10-09).
import { readFileSync } from 'fs';
import { join } from 'path';

const wf = (n: string) => readFileSync(join(__dirname, '../../../.github/workflows', n), 'utf8');

describe('MEMORY_ORB_RECALL_ENABLED pinning', () => {
  it('staging strips it and sets exactly "true"', () => {
    const s = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(s).toContain('"MEMORY_ORB_RECALL_ENABLED",');
    expect(s).toContain('{name:"MEMORY_ORB_RECALL_ENABLED", value:"true"}');
  });

  it('prod strips both recall flags and pins recall on with the shadow still logging (VTID-05007)', () => {
    const p = wf('AWS-PROD-DEPLOY-GATEWAY.yml');
    expect(p).toContain('select(.name | IN("MEMORY_ORB_RECALL_SHADOW","MEMORY_ORB_RECALL_ENABLED") | not)');
    expect(p).toContain('{name:"MEMORY_ORB_RECALL_ENABLED", value:"true"}');
    expect(p).toContain('{name:"MEMORY_ORB_RECALL_SHADOW", value:"true"}');
  });

  it('prod pins it before the env_overrides escape hatch, so an override can switch it off', () => {
    const p = wf('AWS-PROD-DEPLOY-GATEWAY.yml');
    const pin = p.indexOf('{name:"MEMORY_ORB_RECALL_ENABLED", value:"true"}');
    const hatch = p.indexOf('VTID-03958: the generic escape hatch');
    expect(pin).toBeGreaterThan(0);
    expect(hatch).toBeGreaterThan(pin);
  });
});
