/**
 * VTID-04721 — the two scheduled workflows that failed every run.
 *
 * ALERT-PUSH-DISPATCH-HEALTH counted rows older than the 48h window
 * /push-dispatch can still send, so it could never pass. The morning check's
 * screen-load report (and SCREEN-LOAD-TIMING) sent a repo secret the staging
 * gateway does not hold, and check 4 read an in-flight deploy as drift.
 */
import * as fs from 'fs';
import * as path from 'path';

const wf = (name: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows', name), 'utf8');

describe('VTID-04721 scheduled workflow fixes', () => {
  it('push alert only judges the 48h window the dispatcher acts on', () => {
    const s = wf('ALERT-PUSH-DISPATCH-HEALTH.yml');
    expect(s).toMatch(/CUTOFF=\$\(date -u -d '48 hours ago'/);
    expect(s).toContain('"created_at=gte.$CUTOFF"');
  });

  it('push alert hint no longer points at GCP', () => {
    const s = wf('ALERT-PUSH-DISPATCH-HEALTH.yml');
    expect(s).not.toMatch(/gcloud scheduler/);
    expect(s).toContain('vitana-push-dispatch');
  });

  it('screen-load reports send the token the staging gateway checks', () => {
    for (const name of ['MORNING-SYSTEM-HEALTH-CHECK.yml', 'SCREEN-LOAD-TIMING.yml']) {
      const s = wf(name);
      expect(s).toContain('GATEWAY_SERVICE_TOKEN: ${{ secrets.SUPABASE_SERVICE_ROLE }}');
    }
  });

  it('check 4 treats a gateway commit under 25 min old as a deploy in flight', () => {
    const s = wf('MORNING-SYSTEM-HEALTH-CHECK.yml');
    expect(s).toMatch(/AGE_MIN" -lt 25/);
    expect(s).toContain('in flight');
  });
});
