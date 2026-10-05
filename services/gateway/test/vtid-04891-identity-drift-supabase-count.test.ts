/**
 * VTID-04891 — ALERT-APP-USERS-IDENTITY-DRIFT's Supabase step asked PostgREST
 * for app_users?select=id. app_users is keyed by user_id and has no id column,
 * so the answer was a 400 with no Content-Range, and the header grep killed
 * the step under pipefail before its own error printed. Sibling pins for the
 * same workflow: vtid-04787-self-audit-and-identity-drift.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const wf = fs.readFileSync(
  path.resolve(__dirname, '../../../.github/workflows/ALERT-APP-USERS-IDENTITY-DRIFT.yml'),
  'utf8',
);

describe('VTID-04891 identity-drift Supabase count', () => {
  it('counts app_users by user_id, never by a non-existent id column', () => {
    expect(wf).toContain('/rest/v1/app_users?select=user_id"');
    expect(wf).not.toContain('app_users?select=id"');
  });

  it('a missing Content-Range reaches the error branch instead of dying under pipefail', () => {
    expect(wf).toContain("(echo \"$HEADERS\" | grep -i '^content-range:' || true)");
    expect(wf).toContain('if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then');
    expect(wf).toContain('::error::Could not parse Content-Range from PostgREST response:');
  });

  it('leaves the threshold and the Aurora skip untouched', () => {
    expect(wf).toContain('if [ "$DIFF" -gt "$DRIFT_THRESHOLD" ]; then');
    expect(wf.match(/if: steps\.aurora\.outputs\.skip != 'true'/g)?.length).toBe(2);
  });
});
