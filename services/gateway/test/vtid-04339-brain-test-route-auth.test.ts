/**
 * VTID-04339 — POST /api/v1/brain/test runs a full brain turn for any
 * user_id/tenant_id in the body, so it must be registered behind
 * requireAuth + requireExafyAdmin. index.ts is too heavy to boot in a unit
 * test, so this pins the registration line itself.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');

describe('POST /api/v1/brain/test registration (VTID-04339)', () => {
  it('is registered exactly once', () => {
    expect(src.match(/app\.post\(\s*'\/api\/v1\/brain\/test'/g)).toHaveLength(1);
  });

  it('is gated by requireAuth then requireExafyAdmin before the handler', () => {
    expect(src).toMatch(
      /app\.post\(\s*'\/api\/v1\/brain\/test',\s*\w+\.requireAuth,\s*\w+\.requireExafyAdmin,\s*async/,
    );
  });
});
