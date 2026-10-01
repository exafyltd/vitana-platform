// VTID-04452 — MEMORY_ORB_RECALL_ENABLED is pinned on staging only.
import { readFileSync } from 'fs';
import { join } from 'path';

const wf = (n: string) => readFileSync(join(__dirname, '../../../.github/workflows', n), 'utf8');

describe('MEMORY_ORB_RECALL_ENABLED pinning', () => {
  it('staging strips it and sets exactly "true"', () => {
    const s = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(s).toContain('"MEMORY_ORB_RECALL_ENABLED",');
    expect(s).toContain('{name:"MEMORY_ORB_RECALL_ENABLED", value:"true"}');
  });
  it('prod does not set it', () => {
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml')).not.toContain('MEMORY_ORB_RECALL_ENABLED');
  });
});
